// Polls getStats() for every open peer connection and publishes a quality reading per peer.
//
// One shared timer, running only while at least one connection is open and the page is visible.
// The readings stay in this tab's memory: they are never sent to the server or to other
// participants, and are dropped when a peer leaves or the call ends. The maths is in
// conn-quality.ts.

import { get, writable, type Readable } from 'svelte/store';
import { peers, onPeerLeft, onRoomLeft, type PeerConnection } from './mesh.js';
import { isScreenSharing, localStream, videoEnabled } from '../media/manager.js';
import { classify, readStats, smoothLevel, type ConnSample, type QualityLevel, type StatsCounters } from './conn-quality.js';

export interface PeerQuality extends ConnSample {
  /** Smoothed over the last few samples. */
  level: QualityLevel;
}

export const POLL_INTERVAL_MS = 2500;

const store = writable<Map<string, PeerQuality>>(new Map());
/** Connection quality per remote peer id (only peers whose connection is open). */
export const connQuality: Readable<Map<string, PeerQuality>> = { subscribe: store.subscribe };

interface Tracked {
  /** The connection these counters belong to: a reconnect starts from scratch. */
  rtc: RTCPeerConnection;
  counters: StatsCounters | null;
  history: QualityLevel[];
}

const tracked = new Map<string, Tracked>();
let timer: ReturnType<typeof setInterval> | null = null;
let polling = false;
/** Bumped when polling stops, so a poll still awaiting getStats() can't publish stale readings. */
let generation = 0;

function rtcOf(pc: PeerConnection): RTCPeerConnection | null {
  return (pc.peer as unknown as { _pc?: RTCPeerConnection })._pc ?? null;
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
  let report: RTCStatsReport;
  try {
    report = await rtc.getStats();
  } catch {
    return null;
  }
  if (tracked.get(pc.id) !== t) return null; // replaced while we waited
  const { sample, counters } = readStats(report.values(), t.counters, performance.now());
  t.counters = counters;
  t.history = [...t.history, classify(sample, { sendingVideo: video })].slice(-3);
  return [pc.id, { ...sample, level: smoothLevel(t.history) }];
}

async function poll(): Promise<void> {
  // Nobody sees the bars while the tab is hidden; the first sample after it's back starts fresh.
  if (polling || document.visibilityState === 'hidden') return;
  polling = true;
  const gen = generation;
  try {
    const open = Array.from(get(peers).values()).filter((pc) => pc.connected);
    const video = sendingVideo();
    const results = await Promise.all(open.map((pc) => measure(pc, video)));
    if (gen !== generation) return;
    const live = get(peers);
    for (const id of tracked.keys()) if (!live.has(id)) tracked.delete(id);
    store.set(new Map(results.filter((r): r is [string, PeerQuality] => !!r && live.has(r[0]))));
  } finally {
    polling = false;
  }
}

function stop(): void {
  if (timer) clearInterval(timer);
  timer = null;
  generation++;
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
    const anyOpen = Array.from(map.values()).some((pc) => pc.connected);
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
