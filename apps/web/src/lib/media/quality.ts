// Outgoing video quality for a full mesh.
//
// In a mesh every participant encodes and uploads a separate copy of their camera for each other
// person, so upload bandwidth (and encoder CPU) grows with the size of the call: left alone, a
// 6-person call has everyone uploading five full 720p streams. This policy keeps the total near
// UPLOAD_BUDGET_BPS by splitting it across the peers we send to, and lowers resolution and frame
// rate as each copy gets less bitrate. While presenting, the shared screen gets most of the budget
// and a higher priority than the camera, and keeps its resolution (text stays sharp, the frame
// rate gives way instead).
//
// `cameraTarget` / `screenTarget` / `encodingFor` are pure. `tuneSender` applies a target to an
// RTCRtpSender with getParameters/setParameters, one change at a time per sender, and never throws.

/** Rough total upload for video across all peers. */
export const UPLOAD_BUDGET_BPS = 3_500_000;
/** Camera with a single peer: about what browsers use for 720p by default. */
export const CAMERA_MAX_BPS = 2_500_000;
/** Camera while also sharing a screen (it's a small tile then). */
export const CAMERA_WHILE_PRESENTING_MAX_BPS = 500_000;
export const SCREEN_MAX_BPS = 2_500_000;
/** Part of the budget that goes to the screen while presenting. */
export const SCREEN_SHARE_OF_BUDGET = 0.75;
const CAMERA_MIN_BPS = 150_000;
const SCREEN_MIN_BPS = 300_000;
/** Shared screens are sent at up to 1080 lines (4K screens are scaled down). */
const SCREEN_MAX_LINES = 1080;

export type Priority = 'very-low' | 'low' | 'medium' | 'high';

export interface VideoTarget {
  /** Bits per second, per peer. */
  maxBitrate: number;
  maxFramerate: number;
  /** Most lines (the shorter side: 720 for 1280x720) to send; bigger sources are scaled down, never up. */
  maxLines: number;
  /** Relative share of the bandwidth when it runs short ("low" is the browser's default). */
  priority: Priority;
  /** Keep the resolution and drop frames under pressure (shared screens). */
  maintainResolution: boolean;
}

function clampPeers(peerCount: number): number {
  return Number.isFinite(peerCount) ? Math.max(1, Math.floor(peerCount)) : 1;
}

function cameraLinesFor(bps: number): number {
  if (bps >= 1_000_000) return 720;
  if (bps >= 500_000) return 480;
  if (bps >= 250_000) return 360;
  return 240;
}

/** Camera quality for each of `peerCount` peers (`presenting`: a screen is being shared too). */
export function cameraTarget(peerCount: number, presenting: boolean): VideoTarget {
  const n = clampPeers(peerCount);
  const budget = presenting ? UPLOAD_BUDGET_BPS * (1 - SCREEN_SHARE_OF_BUDGET) : UPLOAD_BUDGET_BPS;
  const cap = presenting ? CAMERA_WHILE_PRESENTING_MAX_BPS : CAMERA_MAX_BPS;
  const maxBitrate = Math.round(Math.max(CAMERA_MIN_BPS, Math.min(cap, budget / n)));
  return {
    maxBitrate,
    maxFramerate: maxBitrate >= 250_000 ? 30 : 15,
    maxLines: cameraLinesFor(maxBitrate),
    priority: 'low',
    maintainResolution: false,
  };
}

/** Shared-screen quality for each of `peerCount` peers (`withCamera`: the camera goes out too). */
export function screenTarget(peerCount: number, withCamera = true): VideoTarget {
  const n = clampPeers(peerCount);
  const budget = withCamera ? UPLOAD_BUDGET_BPS * SCREEN_SHARE_OF_BUDGET : UPLOAD_BUDGET_BPS;
  const maxBitrate = Math.round(Math.max(SCREEN_MIN_BPS, Math.min(SCREEN_MAX_BPS, budget / n)));
  return {
    maxBitrate,
    maxFramerate: maxBitrate >= 1_200_000 ? 30 : 15,
    maxLines: SCREEN_MAX_LINES,
    priority: 'high',
    maintainResolution: true,
  };
}

export interface SourceSize {
  width?: number;
  height?: number;
}

/** How much to scale a source down so its shorter side fits `maxLines` (1 = unchanged). */
export function scaleDownBy(source: SourceSize | undefined, maxLines: number): number {
  const sides = [source?.width, source?.height].filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
  if (sides.length === 0 || !(maxLines > 0)) return 1;
  const lines = Math.min(...sides);
  if (lines <= maxLines) return 1;
  return Math.round((lines / maxLines) * 100) / 100;
}

export interface EncodingSettings {
  maxBitrate: number;
  maxFramerate: number;
  scaleResolutionDownBy: number;
  priority: Priority;
  networkPriority: Priority;
}

/** The encoding parameters for `target`, given the size of the track being sent. */
export function encodingFor(target: VideoTarget, source?: SourceSize): EncodingSettings {
  return {
    maxBitrate: target.maxBitrate,
    maxFramerate: target.maxFramerate,
    scaleResolutionDownBy: scaleDownBy(source, target.maxLines),
    priority: target.priority,
    networkPriority: target.priority,
  };
}

// ── Applying it ────────────────────────────────────────────────────────────────

type Encoding = Partial<EncodingSettings> & Record<string, unknown>;
interface SendParameters {
  encodings?: Encoding[];
  degradationPreference?: string;
  [key: string]: unknown;
}

/** The parts of RTCRtpSender used here (so it can be tested without a browser). */
export interface TunableSender {
  getParameters(): unknown;
  setParameters(parameters: never): Promise<void>;
}

function sameEncoding(current: Encoding, wanted: EncodingSettings): boolean {
  return (
    current.maxBitrate === wanted.maxBitrate &&
    current.maxFramerate === wanted.maxFramerate &&
    Math.abs((Number(current.scaleResolutionDownBy) || 1) - wanted.scaleResolutionDownBy) < 0.01 &&
    current.priority === wanted.priority &&
    current.networkPriority === wanted.networkPriority
  );
}

function readParameters(sender: TunableSender): SendParameters | null {
  try {
    const params = sender.getParameters() as SendParameters | null;
    // No encodings yet: the sender hasn't been negotiated. The caller retunes after negotiation.
    return params && Array.isArray(params.encodings) && params.encodings.length > 0 ? params : null;
  } catch {
    return null;
  }
}

/** Senders whose browser refused degradationPreference (the screen's content hint still applies). */
const noPreference = new WeakSet<TunableSender>();

/** One getParameters/setParameters round with `edit` applied. False if the browser refused it. */
async function trySet(sender: TunableSender, edit: (params: SendParameters & { encodings: Encoding[] }) => void): Promise<boolean> {
  const params = readParameters(sender);
  if (!params?.encodings) return true; // gone or not negotiated: nothing to do now
  edit(params as SendParameters & { encodings: Encoding[] });
  try {
    await sender.setParameters(params as never);
    return true;
  } catch {
    return false;
  }
}

async function applyOnce(sender: TunableSender, target: VideoTarget, source: SourceSize | undefined): Promise<void> {
  const wanted = encodingFor(target, source);
  const params = readParameters(sender);
  if (!params?.encodings) return;
  const preference = target.maintainResolution && !noPreference.has(sender) ? 'maintain-resolution' : undefined;
  if (params.encodings.every((e) => sameEncoding(e, wanted)) && (!preference || params.degradationPreference === preference)) return;

  // Same values on every encoding (there is one: no simulcast). Count and rids stay untouched.
  const all = (p: { encodings: Encoding[] }) => p.encodings.forEach((e) => Object.assign(e, wanted));
  if (preference) {
    if (await trySet(sender, (p) => (all(p), (p.degradationPreference = preference)))) return;
    noPreference.add(sender);
  }
  if (await trySet(sender, all)) return;
  // Some browsers refuse some of these fields: fall back to the widely supported ones.
  await trySet(sender, (p) =>
    p.encodings.forEach((e) => {
      e.maxBitrate = wanted.maxBitrate;
      e.scaleResolutionDownBy = wanted.scaleResolutionDownBy;
    })
  );
}

interface TuneJob {
  target: VideoTarget;
  source: SourceSize | undefined;
}
const queued = new WeakMap<TunableSender, TuneJob>();
const running = new WeakMap<TunableSender, Promise<void>>();

/**
 * Apply `target` to `sender`. Changes to one sender run one at a time (a setParameters call made
 * while another is pending would be refused); if several arrive meanwhile, only the latest is
 * applied. The returned promise settles when the sender is up to date, and never rejects.
 */
export function tuneSender(sender: TunableSender, target: VideoTarget, source?: SourceSize): Promise<void> {
  queued.set(sender, { target, source });
  const busy = running.get(sender);
  if (busy) return busy;
  const run = (async () => {
    try {
      for (let job = queued.get(sender); job; job = queued.get(sender)) {
        queued.delete(sender);
        await applyOnce(sender, job.target, job.source);
      }
    } catch {
      // applyOnce handles its own errors; nothing may escape from here.
    } finally {
      running.delete(sender);
    }
  })();
  running.set(sender, run);
  return run;
}
