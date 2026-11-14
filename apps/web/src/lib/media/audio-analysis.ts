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
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.4;
  source.connect(analyser);

  const dataArray = new Float32Array(analyser.fftSize);
  let wasSpeaking = false;
  let animFrameId = 0;
  let stopped = false;

  function check() {
    if (stopped) return;
    analyser.getFloatTimeDomainData(dataArray);
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) sum += dataArray[i] * dataArray[i];
    const isSpeaking = Math.sqrt(sum / dataArray.length) > threshold;
    if (isSpeaking !== wasSpeaking) {
      wasSpeaking = isSpeaking;
      onSpeaking(isSpeaking);
    }
    animFrameId = requestAnimationFrame(check);
  }

  check();

  return () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(animFrameId);
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
