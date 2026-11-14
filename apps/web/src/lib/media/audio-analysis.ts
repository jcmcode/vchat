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
