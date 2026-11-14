// Polls getStats() for every open peer connection and publishes a quality reading per peer.
//
// Only connections that passed the trust gate (verified, or allowed by the user) are measured.
// One shared timer, running only while at least one such connection is open and the page is visible.
// The readings stay in this tab's memory: they are never sent to the server or to other
// participants, and are dropped when a peer leaves or the call ends. The maths is in
// conn-quality.ts.

import { get, writable, type Readable } from 'svelte/store';
import { peers, onPeerLeft, onRoomLeft, type PeerConnection } from './mesh.js';
import { isScreenSharing, localStream, videoEnabled } from '../media/manager.js';
import { classify, pushLevel, readStats, smoothLevel, type ConnSample, type QualityLevel, type StatsCounters } from './conn-quality.js';

export interface PeerQuality extends ConnSample {
  /** Smoothed over the last few samples. */
  level: QualityLevel;
}

export const POLL_INTERVAL_MS = 2500;
/** A getStats() that hasn't answered by then is skipped this round. */
const STATS_TIMEOUT_MS = 2000;

const store = writable<Map<string, PeerQuality>>(new Map());
/** Connection quality per remote peer id (only open, trusted connections). */
export const connQuality: Readable<Map<string, PeerQuality>> = { subscribe: store.subscribe };

interface Tracked {
  /** The connection these counters belong to: a reconnect starts from scratch. */
  rtc: RTCPeerConnection;
  counters: StatsCounters | null;
  history: QualityLevel[];
}

const tracked = new Map<string, Tracked>();
let timer: ReturnType<typeof setInterval> | null = null;
/** Id of the poll in progress (0: none). */
let inFlight = 0;
let pollIds = 0;
/** Bumped when polling stops, so a poll still awaiting getStats() can't publish stale readings. */
let generation = 0;

function rtcOf(pc: PeerConnection): RTCPeerConnection | null {
  return (pc.peer as unknown as { _pc?: RTCPeerConnection })._pc ?? null;
}

function measurable(pc: PeerConnection): boolean {
  return pc.connected && pc.trusted;
}

/** Resolves to null if `promise` fails or takes longer than `ms`. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => (clearTimeout(t), resolve(value)),
      () => (clearTimeout(t), resolve(null))
    );
  });
}

function sendingVideo(): boolean {
  return get(isScreenSharing) || (get(videoEnabled) && !!get(localStream)?.getVideoTracks().length);
}

async function measure(pc: PeerConnection, video: boolean): Promise<[string, PeerQuality] | null> {
  const rtc = rtcOf(pc);
  if (!rtc || rtc.connectionState === 'closed') return null;
  let t = tracked.get(pc.id);
  if (!t || t.rtc !== rtc) {
    t = { rtc, counters: null, history: [] };
    tracked.set(pc.id, t);
  }
  const report = await within(rtc.getStats(), STATS_TIMEOUT_MS);
  if (!report || tracked.get(pc.id) !== t) return null; // no answer, or replaced while we waited
  const now = performance.now();
  const gap = t.counters ? now - t.counters.at : 0;
  const { sample, counters } = readStats(report.values(), t.counters, now);
  t.counters = counters;
  t.history = pushLevel(t.history, classify(sample, { sendingVideo: video }), gap);
  return [pc.id, { ...sample, level: smoothLevel(t.history) }];
}

async function poll(): Promise<void> {
  // Nobody sees the bars while the tab is hidden; the first sample after it's back starts fresh.
  if (inFlight || document.visibilityState === 'hidden') return;
  const id = ++pollIds;
  inFlight = id;
  const gen = generation;
  try {
    const open = Array.from(get(peers).values()).filter(measurable);
    const video = sendingVideo();
    const results = await Promise.all(open.map((pc) => measure(pc, video)));
    if (gen !== generation) return;
    const live = get(peers);
    for (const peerId of tracked.keys()) if (!live.has(peerId)) tracked.delete(peerId);
    store.set(new Map(results.filter((r): r is [string, PeerQuality] => !!r && !!live.get(r[0])?.trusted)));
  } finally {
    if (inFlight === id) inFlight = 0;
  }
}

function stop(): void {
  if (timer) clearInterval(timer);
  timer = null;
  generation++;
  inFlight = 0;
  tracked.clear();
  if (get(store).size) store.set(new Map());
}

function forget(peerId: string): void {
  tracked.delete(peerId);
  const current = get(store);
  if (!current.has(peerId)) return;
  const next = new Map(current);
  next.delete(peerId);
  store.set(next);
}

if (typeof window !== 'undefined') {
  // Run the timer only while there is something to measure.
  peers.subscribe((map) => {
    const anyOpen = Array.from(map.values()).some(measurable);
    if (anyOpen && !timer) {
      timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
      void poll();
    } else if (!anyOpen && timer) {
      stop();
    }
  });
  onPeerLeft(forget);
  onRoomLeft(stop);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && timer) void poll();
  });
}
