import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classify,
  connectionHint,
  formatKbps,
  formatMs,
  formatPct,
  pushLevel,
  readStats,
  smoothLevel,
  type ConnSample,
  type StatsCounters,
} from './conn-quality.js';

type Stat = Record<string, unknown>;

/** A Chromium-style report: transport → selected pair → candidates, plus RTP streams. */
function report(opts: {
  rtt?: number;
  localType?: string;
  remoteType?: string;
  bitrate?: number;
  inAudio?: { received: number; lost: number; jitter?: number };
  inVideo?: { received: number; lost: number; width?: number; height?: number; fps?: number; ssrc?: number };
  outAudio?: { sent: number; remoteLost: number; jitter?: number };
  extra?: Stat[];
}): Stat[] {
  const stats: Stat[] = [
    { id: 'T1', type: 'transport', selectedCandidatePairId: 'CP1' },
    {
      id: 'CP1',
      type: 'candidate-pair',
      localCandidateId: 'L1',
      remoteCandidateId: 'R1',
      state: 'succeeded',
      nominated: true,
      ...(opts.rtt !== undefined ? { currentRoundTripTime: opts.rtt } : {}),
      ...(opts.bitrate !== undefined ? { availableOutgoingBitrate: opts.bitrate } : {}),
    },
    { id: 'L1', type: 'local-candidate', candidateType: opts.localType ?? 'host', address: '192.0.2.1' },
    { id: 'R1', type: 'remote-candidate', candidateType: opts.remoteType ?? 'srflx', address: '198.51.100.7' },
  ];
  if (opts.inAudio) {
    stats.push({ id: 'IA', type: 'inbound-rtp', kind: 'audio', ssrc: 1, packetsReceived: opts.inAudio.received, packetsLost: opts.inAudio.lost, jitter: opts.inAudio.jitter });
  }
  if (opts.inVideo) {
    const v = opts.inVideo;
    stats.push({ id: 'IV', type: 'inbound-rtp', kind: 'video', ssrc: v.ssrc ?? 2, packetsReceived: v.received, packetsLost: v.lost, frameWidth: v.width, frameHeight: v.height, framesPerSecond: v.fps });
  }
  if (opts.outAudio) {
    stats.push({ id: 'OA', type: 'outbound-rtp', kind: 'audio', ssrc: 10, packetsSent: opts.outAudio.sent });
    stats.push({ id: 'RIA', type: 'remote-inbound-rtp', kind: 'audio', ssrc: 10, localId: 'OA', packetsLost: opts.outAudio.remoteLost, jitter: opts.outAudio.jitter });
  }
  return [...stats, ...(opts.extra ?? [])];
}

function sampleOf(partial: Partial<ConnSample>): ConnSample {
  return { rttMs: null, lossInPct: null, lossOutPct: null, jitterMs: null, outgoingKbps: null, relayed: null, recvVideo: null, ...partial };
}

test('reads round trip, relay, outgoing estimate and received video from the selected path', () => {
  const { sample } = readStats(
    report({ rtt: 0.084, localType: 'relay', bitrate: 2_500_000, inVideo: { received: 10, lost: 0, width: 1280, height: 720, fps: 30 } }),
    null,
    1000
  );
  assert.equal(sample.rttMs, 84);
  assert.equal(sample.relayed, true);
  assert.equal(sample.outgoingKbps, 2500);
  assert.deepEqual(sample.recvVideo, { width: 1280, height: 720, fps: 30 });
});

test('a direct path is not relayed; a relay on their side counts', () => {
  assert.equal(readStats(report({ localType: 'host', remoteType: 'srflx' }), null, 0).sample.relayed, false);
  assert.equal(readStats(report({ localType: 'prflx', remoteType: 'relay' }), null, 0).sample.relayed, true);
});

test('no addresses are kept, only the candidate type', () => {
  const { sample, counters } = readStats(report({ rtt: 0.05, inAudio: { received: 100, lost: 0 } }), null, 0);
  const text = JSON.stringify({ sample, counters: { ...counters, inbound: [...counters.inbound], outbound: [...counters.outbound], remoteLost: [...counters.remoteLost] } });
  assert.ok(!text.includes('192.0.2.1') && !text.includes('198.51.100.7'));
});

test('missing fields give unknowns, not errors', () => {
  const { sample } = readStats([{ id: 'x', type: 'codec' }, null, 'junk', { type: 'inbound-rtp', kind: 'audio' }], null, 0);
  assert.deepEqual(sample, sampleOf({}));
  assert.equal(classify(sample), 'unknown');
  // A pair with no candidate stats: relay unknown.
  const bare = readStats([{ id: 'T', type: 'transport', selectedCandidatePairId: 'P' }, { id: 'P', type: 'candidate-pair', currentRoundTripTime: 0.1 }], null, 0);
  assert.equal(bare.sample.relayed, null);
  assert.equal(bare.sample.rttMs, 100);
});

test('packet loss comes from deltas between samples, not cumulative totals', () => {
  // A long call with lots of old loss...
  const first = readStats(report({ inAudio: { received: 100_000, lost: 20_000 } }), null, 0);
  assert.equal(first.sample.lossInPct, null, 'no previous sample: no delta yet');
  // ...but none in the last interval.
  const second = readStats(report({ inAudio: { received: 100_125, lost: 20_000 } }), first.counters, 2500);
  assert.equal(second.sample.lossInPct, 0);
  // 10 lost out of 125 + 10 expected in the next one.
  const third = readStats(report({ inAudio: { received: 100_250, lost: 20_010 } }), second.counters, 5000);
  assert.ok(Math.abs((third.sample.lossInPct ?? -1) - (100 * 10) / 135) < 1e-9);
});

test('loss is summed across audio and video streams', () => {
  const a = readStats(report({ inAudio: { received: 0, lost: 0 }, inVideo: { received: 0, lost: 0 } }), null, 0);
  const b = readStats(report({ inAudio: { received: 100, lost: 0 }, inVideo: { received: 800, lost: 100 } }), a.counters, 2500);
  assert.equal(b.sample.lossInPct, 10);
});

test('counters that go backwards (new connection / SSRC after a restart) are a fresh baseline', () => {
  const a = readStats(report({ inAudio: { received: 50_000, lost: 900 }, outAudio: { sent: 60_000, remoteLost: 500 } }), null, 0);
  const b = readStats(report({ inAudio: { received: 120, lost: 3 }, outAudio: { sent: 125, remoteLost: 1 } }), a.counters, 2500);
  assert.equal(b.sample.lossInPct, null);
  assert.equal(b.sample.lossOutPct, null);
  // The interval after that uses the new baseline.
  const c = readStats(report({ inAudio: { received: 240, lost: 3 }, outAudio: { sent: 250, remoteLost: 6 } }), b.counters, 5000);
  assert.equal(c.sample.lossInPct, 0);
  assert.equal(c.sample.lossOutPct, 4);
});

test('a stream that only appears now has no delta; a new SSRC is not compared with the old one', () => {
  const a = readStats(report({ inVideo: { received: 5000, lost: 0, ssrc: 2 } }), null, 0);
  const b = readStats(report({ inVideo: { received: 100, lost: 50, ssrc: 3 } }), a.counters, 2500);
  assert.equal(b.sample.lossInPct, null);
});

test('packetsLost going down never counts as negative loss', () => {
  const a = readStats(report({ inAudio: { received: 1000, lost: 30 } }), null, 0);
  const b = readStats(report({ inAudio: { received: 1125, lost: 25 } }), a.counters, 2500);
  assert.equal(b.sample.lossInPct, 0);
});

test('too few packets in an interval give no loss figure', () => {
  const a = readStats(report({ inAudio: { received: 1000, lost: 0 } }), null, 0);
  const b = readStats(report({ inAudio: { received: 1005, lost: 2 } }), a.counters, 2500);
  assert.equal(b.sample.lossInPct, null);
});

test('a sample long after the previous one (tab was hidden) gives no loss figure', () => {
  const a = readStats(report({ inAudio: { received: 1000, lost: 0 } }), null, 0);
  const b = readStats(report({ inAudio: { received: 60_000, lost: 6000 } }), a.counters, 600_000);
  assert.equal(b.sample.lossInPct, null);
  const c = readStats(report({ inAudio: { received: 60_125, lost: 6000 } }), b.counters, 602_500);
  assert.equal(c.sample.lossInPct, 0);
});

test('outgoing loss: what they report losing against what we sent', () => {
  const a = readStats(report({ outAudio: { sent: 1000, remoteLost: 10 } }), null, 0);
  const b = readStats(report({ outAudio: { sent: 1100, remoteLost: 15 } }), a.counters, 2500);
  assert.equal(b.sample.lossOutPct, 5);
});

test('jitter is the worst audio jitter in either direction, in ms', () => {
  const { sample } = readStats(report({ inAudio: { received: 1, lost: 0, jitter: 0.012 }, outAudio: { sent: 1, remoteLost: 0, jitter: 0.041 } }), null, 0);
  assert.equal(sample.jitterMs, 41);
  // Video jitter isn't comparable with audio thresholds and is ignored.
  const v = readStats([{ type: 'inbound-rtp', kind: 'video', ssrc: 5, jitter: 0.5, packetsReceived: 1, packetsLost: 0 }], null, 0);
  assert.equal(v.sample.jitterMs, null);
});

test('round trip falls back to RTCP measurements when the pair has none (Firefox)', () => {
  const stats: Stat[] = [
    { id: 'CP', type: 'candidate-pair', selected: true, localCandidateId: 'L', remoteCandidateId: 'R' },
    { id: 'L', type: 'local-candidate', candidateType: 'host' },
    { id: 'R', type: 'remote-candidate', candidateType: 'relay' },
    { id: 'a', type: 'remote-inbound-rtp', kind: 'audio', ssrc: 1, roundTripTime: 0.1 },
    { id: 'b', type: 'remote-inbound-rtp', kind: 'video', ssrc: 2, roundTripTime: 0.2 },
  ];
  const { sample } = readStats(stats, null, 0);
  assert.ok(Math.abs((sample.rttMs ?? 0) - 150) < 1e-9);
  assert.equal(sample.relayed, true);
});

test('without a transport, the nominated succeeded pair carrying the most data is used', () => {
  const stats: Stat[] = [
    { id: 'A', type: 'candidate-pair', nominated: true, state: 'succeeded', bytesSent: 10, bytesReceived: 10, currentRoundTripTime: 0.9, localCandidateId: 'L1' },
    { id: 'B', type: 'candidate-pair', nominated: true, state: 'succeeded', bytesSent: 9000, bytesReceived: 9000, currentRoundTripTime: 0.03, localCandidateId: 'L2' },
    { id: 'C', type: 'candidate-pair', nominated: false, state: 'in-progress', bytesSent: 1e9, currentRoundTripTime: 2 },
    { id: 'L1', type: 'local-candidate', candidateType: 'relay' },
    { id: 'L2', type: 'local-candidate', candidateType: 'host' },
  ];
  const { sample } = readStats(stats, null, 0);
  assert.equal(sample.rttMs, 30);
  assert.equal(sample.relayed, false);
});

test('received video picks the largest picture; legacy mediaType is understood', () => {
  const stats: Stat[] = [
    { type: 'inbound-rtp', mediaType: 'video', ssrc: 1, frameWidth: 320, frameHeight: 180 },
    { type: 'inbound-rtp', kind: 'video', ssrc: 2, frameWidth: 1920, frameHeight: 1080 },
    { type: 'inbound-rtp', kind: 'video', ssrc: 3, frameWidth: 0, frameHeight: 0, framesPerSecond: 30 },
  ];
  assert.deepEqual(readStats(stats, null, 0).sample.recvVideo, { width: 1920, height: 1080, fps: null });
});

test('classify: worst metric wins, nulls are ignored', () => {
  assert.equal(classify(sampleOf({ rttMs: 40, lossInPct: 0, jitterMs: 5 })), 'good');
  assert.equal(classify(sampleOf({ rttMs: 250 })), 'good');
  assert.equal(classify(sampleOf({ rttMs: 251 })), 'fair');
  assert.equal(classify(sampleOf({ rttMs: 501 })), 'poor');
  assert.equal(classify(sampleOf({ rttMs: 40, lossOutPct: 3 })), 'fair');
  assert.equal(classify(sampleOf({ rttMs: 40, lossInPct: 1, lossOutPct: 12 })), 'poor');
  assert.equal(classify(sampleOf({ jitterMs: 31 })), 'fair');
  assert.equal(classify(sampleOf({ jitterMs: 81, rttMs: 20 })), 'poor');
  assert.equal(classify(sampleOf({ relayed: true, recvVideo: { width: 1, height: 1, fps: 1 } })), 'unknown');
});

test('classify: a low outgoing estimate only matters while sending video, and only down to fair', () => {
  const s = sampleOf({ rttMs: 40, outgoingKbps: 90 });
  assert.equal(classify(s), 'good');
  assert.equal(classify(s, { sendingVideo: true }), 'fair');
  assert.equal(classify(sampleOf({ rttMs: 900, outgoingKbps: 90 }), { sendingVideo: true }), 'poor');
  assert.equal(classify(sampleOf({ outgoingKbps: 90 }), { sendingVideo: true }), 'unknown');
});

test('smoothing: one odd sample does not flip the result', () => {
  assert.equal(smoothLevel([]), 'unknown');
  assert.equal(smoothLevel(['unknown', 'unknown']), 'unknown');
  assert.equal(smoothLevel(['poor']), 'poor');
  assert.equal(smoothLevel(['poor', 'good']), 'good');
  assert.equal(smoothLevel(['good', 'good', 'poor']), 'good');
  assert.equal(smoothLevel(['good', 'poor', 'poor']), 'poor');
  assert.equal(smoothLevel(['poor', 'fair', 'good']), 'fair');
  assert.equal(smoothLevel(['poor', 'poor', 'poor', 'good', 'good']), 'good', 'only the last three count');
  assert.equal(smoothLevel(['poor', 'unknown', 'poor']), 'poor');
});

test('"your connection is poor" needs two or more measured links, more than half of them poor', () => {
  assert.equal(connectionHint([]), null);
  assert.equal(connectionHint([['a', 'unknown'], ['b', 'unknown']]), null);
  assert.equal(connectionHint([['a', 'poor'], ['b', 'good']]), null);
  assert.deepEqual(connectionHint([['a', 'poor'], ['b', 'poor']]), { kind: 'local' });
  assert.deepEqual(connectionHint([['a', 'poor'], ['b', 'poor'], ['c', 'good']]), { kind: 'local' });
  assert.equal(connectionHint([['a', 'poor'], ['b', 'fair'], ['c', 'good']]), null);
  assert.equal(connectionHint([['a', 'poor'], ['b', 'unknown'], ['c', 'fair']]), null);
});

test('one measured link never says *your* connection is poor: it names that link', () => {
  // 1:1 call: the other person's bad uplink (or forged reports) is about them.
  assert.deepEqual(connectionHint([['a', 'poor']]), { kind: 'peer', peerId: 'a' });
  assert.deepEqual(connectionHint([['a', 'poor'], ['b', 'unknown']]), { kind: 'peer', peerId: 'a' });
  assert.equal(connectionHint([['a', 'fair']]), null);
  assert.equal(connectionHint([['a', 'good'], ['b', 'unknown']]), null);
});

test('history: the last three levels, cleared after a long gap', () => {
  assert.deepEqual(pushLevel([], 'good', 0), ['good']);
  assert.deepEqual(pushLevel(['poor', 'poor', 'fair'], 'good', 2500), ['poor', 'fair', 'good']);
  assert.deepEqual(pushLevel(['poor', 'poor', 'poor'], 'good', 60_000), ['good'], 'stale levels from before the tab was hidden are dropped');
  assert.equal(smoothLevel(pushLevel(['poor', 'poor'], 'good', 60_000)), 'good');
});

test('implausible jitter and round trips (e.g. forged receiver reports) are ignored', () => {
  const forged = readStats(
    report({ inAudio: { received: 1, lost: 0, jitter: 0.02 }, outAudio: { sent: 1, remoteLost: 0, jitter: 1e6 } }),
    null,
    0
  );
  assert.equal(forged.sample.jitterMs, 20);
  const allForged = readStats(report({ outAudio: { sent: 1, remoteLost: 0, jitter: 5 } }), null, 0);
  assert.equal(allForged.sample.jitterMs, null);
  assert.equal(classify(allForged.sample), 'unknown');
  // A one-second jitter is still a (terrible) measurement.
  assert.equal(readStats(report({ outAudio: { sent: 1, remoteLost: 0, jitter: 1 } }), null, 0).sample.jitterMs, 1000);
  assert.equal(readStats(report({ rtt: 1e9 }), null, 0).sample.rttMs, null);
  assert.equal(readStats(report({ rtt: -1 }), null, 0).sample.rttMs, null);
  const rtcp: Stat[] = [{ type: 'remote-inbound-rtp', kind: 'audio', ssrc: 1, roundTripTime: 1e7 }, { type: 'remote-inbound-rtp', kind: 'video', ssrc: 2, roundTripTime: 0.08 }];
  assert.equal(readStats(rtcp, null, 0).sample.rttMs, 80);
});

test('reported outgoing loss is capped at what we sent (a loss fraction within 0..1)', () => {
  const a = readStats(report({ outAudio: { sent: 1000, remoteLost: 0 } }), null, 0);
  const b = readStats(report({ outAudio: { sent: 1100, remoteLost: 1e9 } }), a.counters, 2500);
  assert.equal(b.sample.lossOutPct, 100);
  // Combined with an honest stream, the forged one can't exceed its own share.
  const stats = (sentA: number, lostA: number, sentB: number, lostB: number): Stat[] => [
    { id: 'o1', type: 'outbound-rtp', kind: 'audio', ssrc: 1, packetsSent: sentA },
    { id: 'r1', type: 'remote-inbound-rtp', kind: 'audio', ssrc: 1, packetsLost: lostA },
    { id: 'o2', type: 'outbound-rtp', kind: 'video', ssrc: 2, packetsSent: sentB },
    { id: 'r2', type: 'remote-inbound-rtp', kind: 'video', ssrc: 2, packetsLost: lostB },
  ];
  const c = readStats(stats(0, 0, 0, 0), null, 0);
  const d = readStats(stats(100, 1e9, 900, 0), c.counters, 2500);
  assert.equal(d.sample.lossOutPct, 10);
});

test('formatting', () => {
  assert.equal(formatMs(null), '—');
  assert.equal(formatMs(83.6), '84 ms');
  assert.equal(formatPct(null), '—');
  assert.equal(formatPct(0), '0.0%');
  assert.equal(formatPct(0.04), '<0.1%');
  assert.equal(formatPct(2.345), '2.3%');
  assert.equal(formatPct(42.4), '42%');
  assert.equal(formatKbps(null), '—');
  assert.equal(formatKbps(640.4), '640 kbit/s');
  assert.equal(formatKbps(2500), '2.5 Mbit/s');
});

test('the counters returned are what the next call needs', () => {
  const { counters } = readStats(report({ inAudio: { received: 7, lost: 1 }, outAudio: { sent: 9, remoteLost: 2 } }), null, 42);
  const expected: StatsCounters = {
    at: 42,
    inbound: new Map([['audio:1', { received: 7, lost: 1 }]]),
    outbound: new Map([['audio:10', 9]]),
    remoteLost: new Map([['audio:10', 2]]),
  };
  assert.deepEqual(counters, expected);
});
