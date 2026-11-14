// "Who is speaking" detection. One AudioContext is shared by every detector: browsers limit how
// many a page may create, and a call can have several participants.

let sharedContext: AudioContext | null = null;
let users = 0;

function acquireContext(): AudioContext {
  if (!sharedContext || sharedContext.state === 'closed') sharedContext = new AudioContext();
  sharedContext.resume().catch(() => {});
  users++;
  return sharedContext;
}

function releaseContext(): void {
  users = Math.max(0, users - 1);
  if (users === 0 && sharedContext) {
    sharedContext.close().catch(() => {});
    sharedContext = null;
  }
}

/** Speaking starts after this many loud checks in a row, and stops after this many quiet ones. */
export const SPEAKING_ON_CHECKS = 2;
export const SPEAKING_OFF_CHECKS = 6;
/** How often every detector is checked (one shared timer, not an animation loop per person). */
const SPEAKING_CHECK_MS = 75;

export interface SpeakingState {
  on: boolean;
  /** Loud checks in a row. */
  above: number;
  /** Quiet checks in a row. */
  below: number;
}

/**
 * One check of a detector, with hysteresis: the speaking ring doesn't flicker between syllables
 * (each flip repaints the tiles), and a click or a breath doesn't light it up. Returns the new state.
 */
export function nextSpeaking(state: SpeakingState, loud: boolean): boolean {
  if (loud) {
    state.above = Math.min(state.above + 1, SPEAKING_ON_CHECKS);
    state.below = 0;
  } else {
    state.below = Math.min(state.below + 1, SPEAKING_OFF_CHECKS);
    state.above = 0;
  }
  if (!state.on && state.above >= SPEAKING_ON_CHECKS) state.on = true;
  else if (state.on && state.below >= SPEAKING_OFF_CHECKS) state.on = false;
  return state.on;
}

interface Detector {
  analyser: AnalyserNode;
  samples: Float32Array<ArrayBuffer>;
  threshold: number;
  state: SpeakingState;
  onSpeaking: (isSpeaking: boolean) => void;
}

const detectors = new Set<Detector>();
let checkTimer: ReturnType<typeof setInterval> | null = null;

function checkDetectors(): void {
  for (const d of detectors) {
    d.analyser.getFloatTimeDomainData(d.samples);
    let sum = 0;
    for (let i = 0; i < d.samples.length; i++) sum += d.samples[i] * d.samples[i];
    const was = d.state.on;
    if (nextSpeaking(d.state, Math.sqrt(sum / d.samples.length) > d.threshold) !== was) d.onSpeaking(d.state.on);
  }
}

/**
 * Calls `onSpeaking(true/false)` when the stream starts or stops carrying speech. All detectors share
 * one timer, which (unlike requestAnimationFrame) keeps running while the tab is hidden, e.g. with
 * the call popped out into picture-in-picture.
 */
export function createSpeakingDetector(
  stream: MediaStream,
  onSpeaking: (isSpeaking: boolean) => void,
  threshold = 0.015
): () => void {
  const audioContext = acquireContext();
  let source: MediaStreamAudioSourceNode;
  try {
    source = audioContext.createMediaStreamSource(stream);
  } catch {
    releaseContext();
    return () => {};
  }
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048; // ~43 ms of audio per check at 48 kHz
  source.connect(analyser);

  const detector: Detector = {
    analyser,
    samples: new Float32Array(analyser.fftSize),
    threshold,
    state: { on: false, above: 0, below: 0 },
    onSpeaking,
  };
  detectors.add(detector);
  checkTimer ??= setInterval(checkDetectors, SPEAKING_CHECK_MS);

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    detectors.delete(detector);
    if (detectors.size === 0 && checkTimer) {
      clearInterval(checkTimer);
      checkTimer = null;
    }
    source.disconnect();
    analyser.disconnect();
    releaseContext();
  };
}

/**
 * How loud a block of samples is, from 0 to 1 for a level meter: the RMS in decibels, mapped so
 * -60 dBFS (near silence) is 0 and -10 dBFS (loud speech close to the mic) is 1.
 */
export function levelFromSamples(samples: ArrayLike<number>): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / samples.length);
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (db + 60) / 50));
}

/**
 * A microphone level meter (the pre-join preview). Calls `onLevel` with 0..1 about 20 times a
 * second, falling back smoothly rather than flickering. Returns a function that stops it.
 */
export function createLevelMeter(stream: MediaStream, onLevel: (level: number) => void): () => void {
  const audioContext = acquireContext();
  let source: MediaStreamAudioSourceNode;
  try {
    source = audioContext.createMediaStreamSource(stream);
  } catch {
    releaseContext();
    return () => {};
  }
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);

  const samples = new Float32Array(analyser.fftSize);
  let shown = 0;
  let lastReport = 0;
  let animFrameId = 0;
  let stopped = false;

  function tick(now: number) {
    if (stopped) return;
    analyser.getFloatTimeDomainData(samples);
    const level = levelFromSamples(samples);
    shown = level > shown ? level : shown * 0.85 + level * 0.15;
    if (now - lastReport >= 50) {
      lastReport = now;
      onLevel(shown);
    }
    animFrameId = requestAnimationFrame(tick);
  }

  animFrameId = requestAnimationFrame(tick);

  return () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(animFrameId);
    source.disconnect();
    analyser.disconnect();
    releaseContext();
  };
}

/** Browsers keep audio suspended until the page is interacted with: call from a click or key press. */
export function resumeSharedAudio(): void {
  if (sharedContext && sharedContext.state === 'suspended') sharedContext.resume().catch(() => {});
}
