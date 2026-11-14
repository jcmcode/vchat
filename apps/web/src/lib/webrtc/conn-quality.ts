// Connection quality from WebRTC statistics (getStats()).
//
// Everything here is pure (no browser APIs) and unit-tested in conn-quality.test.ts; conn-stats.ts
// does the polling. The numbers are computed and shown on this device only: they are never sent to
// the signaling server or to other participants. Candidate statistics include IP addresses; only
// the candidate *type* (relay or not) is read, and no address is kept.
//
// Some of these figures come from the other side (RTCP receiver reports: their loss and jitter),
// so a peer can make its own link look bad. Implausible values are ignored, and a single link
// is never taken as proof that *your* connection is poor (see connectionHint).

export type QualityLevel = 'good' | 'fair' | 'poor' | 'unknown';

export interface ConnSample {
  /** Round-trip time of the selected path, in milliseconds. */
  rttMs: number | null;
  /** Percentage of packets sent to us that were lost since the previous sample. */
  lossInPct: number | null;
  /** Percentage of our packets the other side reported lost since the previous sample. */
  lossOutPct: number | null;
  /** Audio jitter in milliseconds: the worse of what we receive and what they report receiving. */
  jitterMs: number | null;
  /** The browser's estimate of how fast we can send on this connection, in kbit/s (Chromium only). */
  outgoingKbps: number | null;
  /** Whether the selected path goes through a TURN relay (on either side). Null when unknown. */
  relayed: boolean | null;
  /** The largest video picture we're receiving from them. */
  recvVideo: { width: number; height: number; fps: number | null } | null;
}

/** Cumulative counters from the previous sample, to turn totals into per-interval deltas. */
export interface StatsCounters {
  /** When the sample was taken (any monotonic clock in ms, e.g. performance.now()). */
  at: number;
  /** inbound-rtp, by kind + SSRC. */
  inbound: Map<string, { received: number; lost: number }>;
  /** outbound-rtp packetsSent, by kind + SSRC. */
  outbound: Map<string, number>;
  /** remote-inbound-rtp packetsLost (as reported by the other side), by kind + SSRC. */
  remoteLost: Map<string, number>;
}

type Stat = Record<string, unknown>;

/** Below this many packets in an interval, a loss percentage means little (one packet = 5%). */
export const MIN_PACKETS_FOR_LOSS = 20;
/** Deltas spanning a longer gap (tab hidden, a stalled poll) describe the past, not now. */
export const MAX_SAMPLE_GAP_MS = 10_000;
/** Jitter above this (ms) isn't a real measurement (e.g. a forged receiver report): ignored. */
export const MAX_PLAUSIBLE_JITTER_MS = 1000;
/** Round trips above this (ms) aren't plausible on a working call: ignored. */
export const MAX_PLAUSIBLE_RTT_MS = 10_000;

/**
 * Thresholds: a metric at or below `good` is good, at or below `fair` is fair, above is poor.
 * Round trip and jitter in ms, loss in percent.
 */
export const THRESHOLDS = {
  rttMs: { good: 250, fair: 500 },
  lossPct: { good: 2, fair: 8 },
  jitterMs: { good: 30, fair: 80 },
} as const;
/** While sending video, an outgoing estimate below this (kbit/s) makes the link at best "fair". */
export const LOW_OUTGOING_KBPS = 150;

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** A jitter or round-trip value in seconds, or null if missing, negative or above `maxMs`. */
function plausibleSeconds(v: unknown, maxMs: number): number | null {
  const n = num(v);
  return n !== null && n >= 0 && n * 1000 <= maxMs ? n : null;
}

function kindOf(s: Stat): string {
  return str(s.kind) ?? str(s.mediaType) ?? '?'; // mediaType: older Chromium
}

function streamKey(s: Stat): string {
  const ssrc = num(s.ssrc);
  return `${kindOf(s)}:${ssrc ?? str(s.id) ?? '?'}`;
}

/** The candidate pair the connection is actually using. */
function selectedPair(stats: Stat[], byId: Map<string, Stat>): Stat | undefined {
  for (const s of stats) {
    if (s.type !== 'transport') continue;
    const id = str(s.selectedCandidatePairId);
    const pair = id ? byId.get(id) : undefined;
    if (pair) return pair;
  }
  const pairs = stats.filter((s) => s.type === 'candidate-pair');
  // Firefox marks the pair it uses with a non-standard `selected` flag.
  const flagged = pairs.find((s) => s.selected === true);
  if (flagged) return flagged;
  const bytes = (s: Stat) => (num(s.bytesSent) ?? 0) + (num(s.bytesReceived) ?? 0);
  return pairs
    .filter((s) => s.nominated === true && s.state === 'succeeded')
    .sort((a, b) => bytes(b) - bytes(a))[0];
}

/**
 * Read one getStats() report. `prev` is what the previous call returned for the same connection
 * (or null). Counters that went backwards (a new connection or SSRC after a restart) or a sample
 * too far from the previous one give no loss figure this time; the next sample uses fresh deltas.
 */
export function readStats(
  report: Iterable<unknown>,
  prev: StatsCounters | null,
  now: number,
  maxGapMs = MAX_SAMPLE_GAP_MS
): { sample: ConnSample; counters: StatsCounters } {
  const stats: Stat[] = [];
  for (const s of report) if (s && typeof s === 'object') stats.push(s as Stat);
  const byId = new Map<string, Stat>();
  for (const s of stats) {
    const id = str(s.id);
    if (id) byId.set(id, s);
  }
  const base = prev && now > prev.at && now - prev.at <= maxGapMs ? prev : null;
  const counters: StatsCounters = { at: now, inbound: new Map(), outbound: new Map(), remoteLost: new Map() };

  // Selected path: round trip, relay, outgoing estimate.
  const pair = selectedPair(stats, byId);
  const localType = pair ? str(byId.get(str(pair.localCandidateId) ?? '')?.candidateType) : null;
  const remoteType = pair ? str(byId.get(str(pair.remoteCandidateId) ?? '')?.candidateType) : null;
  const relayed = localType || remoteType ? localType === 'relay' || remoteType === 'relay' : null;
  const bitrate = num(pair?.availableOutgoingBitrate);
  const outgoingKbps = bitrate !== null && bitrate >= 0 ? bitrate / 1000 : null;
  let rtt = plausibleSeconds(pair?.currentRoundTripTime, MAX_PLAUSIBLE_RTT_MS);
  if (rtt === null) {
    // Fallback (e.g. Firefox): the RTCP round trip measured per outgoing stream.
    const rtts = stats
      .filter((s) => s.type === 'remote-inbound-rtp')
      .map((s) => plausibleSeconds(s.roundTripTime, MAX_PLAUSIBLE_RTT_MS))
      .filter((v): v is number => v !== null);
    rtt = rtts.length ? rtts.reduce((a, b) => a + b, 0) / rtts.length : null;
  }

  // Incoming: loss from deltas, audio jitter, received video size.
  let inReceived = 0;
  let inLost = 0;
  const audioJitter: number[] = [];
  let recvVideo: ConnSample['recvVideo'] = null;
  for (const s of stats) {
    if (s.type !== 'inbound-rtp') continue;
    const kind = kindOf(s);
    const received = num(s.packetsReceived);
    const lost = num(s.packetsLost);
    if (received !== null && lost !== null) {
      const key = streamKey(s);
      counters.inbound.set(key, { received, lost });
      const p = base?.inbound.get(key);
      if (p && received >= p.received) {
        inReceived += received - p.received;
        // packetsLost can go down (late or duplicate packets); never count that as negative loss.
        inLost += Math.max(0, lost - p.lost);
      }
    }
    const jitter = plausibleSeconds(s.jitter, MAX_PLAUSIBLE_JITTER_MS);
    if (kind === 'audio' && jitter !== null) audioJitter.push(jitter);
    const width = num(s.frameWidth);
    const height = num(s.frameHeight);
    if (kind === 'video' && width && height && width > 0 && height > 0) {
      if (!recvVideo || width * height > recvVideo.width * recvVideo.height) {
        const fps = num(s.framesPerSecond);
        recvVideo = { width, height, fps: fps !== null && fps >= 0 ? fps : null };
      }
    }
  }

  // Outgoing: what the other side reports losing, against what we sent, both as deltas.
  for (const s of stats) {
    if (s.type !== 'outbound-rtp') continue;
    const sent = num(s.packetsSent);
    if (sent !== null) counters.outbound.set(streamKey(s), sent);
  }
  let outSent = 0;
  let outLost = 0;
  for (const s of stats) {
    if (s.type !== 'remote-inbound-rtp') continue;
    const jitter = plausibleSeconds(s.jitter, MAX_PLAUSIBLE_JITTER_MS);
    if (kindOf(s) === 'audio' && jitter !== null) audioJitter.push(jitter);
    const lost = num(s.packetsLost);
    if (lost === null) continue;
    const key = streamKey(s);
    counters.remoteLost.set(key, lost);
    const sent = counters.outbound.get(key);
    const pSent = base?.outbound.get(key);
    const pLost = base?.remoteLost.get(key);
    if (sent === undefined || pSent === undefined || pLost === undefined || sent < pSent) continue;
    // They can't have lost more than we sent: a report claiming so is capped (loss stays within 0..1).
    outSent += sent - pSent;
    outLost += Math.min(sent - pSent, Math.max(0, lost - pLost));
  }

  const pct = (lost: number, total: number) => Math.min(100, Math.max(0, (100 * lost) / total));
  const inTotal = inReceived + inLost;
  return {
    sample: {
      rttMs: rtt === null ? null : rtt * 1000,
      lossInPct: inTotal >= MIN_PACKETS_FOR_LOSS ? pct(inLost, inTotal) : null,
      lossOutPct: outSent >= MIN_PACKETS_FOR_LOSS ? pct(outLost, outSent) : null,
      jitterMs: audioJitter.length ? Math.max(...audioJitter) * 1000 : null,
      outgoingKbps,
      relayed,
      recvVideo,
    },
    counters,
  };
}

const RANK: Record<Exclude<QualityLevel, 'unknown'>, number> = { good: 0, fair: 1, poor: 2 };

function worst(levels: Exclude<QualityLevel, 'unknown'>[]): Exclude<QualityLevel, 'unknown'> {
  return levels.reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
}

function grade(value: number | null, t: { good: number; fair: number }): Exclude<QualityLevel, 'unknown'> | null {
  if (value === null) return null;
  return value <= t.good ? 'good' : value <= t.fair ? 'fair' : 'poor';
}

/**
 * Classify one sample: the worst of round trip, packet loss (either direction) and jitter. Unknown
 * when none of them could be measured. While we send video, a very low outgoing estimate caps the
 * result at "fair" (it isn't used on its own: the estimate starts low and audio-only links rarely
 * probe for more).
 */
export function classify(sample: ConnSample, opts: { sendingVideo?: boolean } = {}): QualityLevel {
  const losses = [sample.lossInPct, sample.lossOutPct].filter((v): v is number => v !== null);
  const levels = [
    grade(sample.rttMs, THRESHOLDS.rttMs),
    grade(losses.length ? Math.max(...losses) : null, THRESHOLDS.lossPct),
    grade(sample.jitterMs, THRESHOLDS.jitterMs),
  ].filter((l): l is Exclude<QualityLevel, 'unknown'> => l !== null);
  if (!levels.length) return 'unknown';
  if (opts.sendingVideo && sample.outgoingKbps !== null && sample.outgoingKbps < LOW_OUTGOING_KBPS) levels.push('fair');
  return worst(levels);
}

/**
 * What to show, from the most recent raw levels (oldest first): the median of the last three known
 * ones, so one bad or good sample doesn't flip the bars. With two, the better one (connections
 * often look worse for a moment while they start).
 */
export function smoothLevel(history: QualityLevel[]): QualityLevel {
  const known = history.slice(-3).filter((l): l is Exclude<QualityLevel, 'unknown'> => l !== 'unknown');
  if (!known.length) return 'unknown';
  const sorted = [...known].sort((a, b) => RANK[a] - RANK[b]);
  return sorted.length === 3 ? sorted[1] : sorted[0];
}

/** Add a sample's level to a link's recent history. After a long gap, older levels are dropped. */
export function pushLevel(history: QualityLevel[], level: QualityLevel, gapMs: number, maxGapMs = MAX_SAMPLE_GAP_MS): QualityLevel[] {
  return [...(gapMs > maxGapMs ? [] : history), level].slice(-3);
}

export type ConnectionHint = { kind: 'local' } | { kind: 'peer'; peerId: string } | null;

/**
 * Which hint to show, from the levels of your (trusted) links. "Your connection is poor" only
 * when at least two links were measured and more than half are poor: one peer with a bad network
 * (or one making its link look bad) must never tell you that *your* connection is poor. With a
 * single measured link, a poor one is about that link ("Connection to <name> is poor").
 */
export function connectionHint(links: Iterable<[string, QualityLevel]>): ConnectionHint {
  const known = Array.from(links).filter(([, level]) => level !== 'unknown');
  if (known.length === 1) return known[0][1] === 'poor' ? { kind: 'peer', peerId: known[0][0] } : null;
  const poor = known.filter(([, level]) => level === 'poor').length;
  return known.length >= 2 && poor * 2 > known.length ? { kind: 'local' } : null;
}

// ── Formatting for the UI ─────────────────────────────────────────────────────

export function qualityLabel(level: QualityLevel): string {
  return { good: 'Good', fair: 'Fair', poor: 'Poor', unknown: 'Measuring…' }[level];
}

export function formatMs(ms: number | null): string {
  return ms === null ? '—' : `${Math.round(ms)} ms`;
}

export function formatPct(pct: number | null): string {
  if (pct === null) return '—';
  if (pct > 0 && pct < 0.1) return '<0.1%';
  return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}

export function formatKbps(kbps: number | null): string {
  if (kbps === null) return '—';
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbit/s` : `${Math.round(kbps)} kbit/s`;
}
