export function createSpeakingDetector(
  stream: MediaStream,
  onSpeaking: (isSpeaking: boolean) => void,
  threshold = 0.015
): () => void {
  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.4;
  source.connect(analyser);

  const dataArray = new Float32Array(analyser.fftSize);
  let wasSpeaking = false;
  let animFrameId: number;

  function check() {
    analyser.getFloatTimeDomainData(dataArray);

    // Calculate RMS
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      sum += dataArray[i] * dataArray[i];
    }
    const rms = Math.sqrt(sum / dataArray.length);

    const isSpeaking = rms > threshold;
    if (isSpeaking !== wasSpeaking) {
      wasSpeaking = isSpeaking;
      onSpeaking(isSpeaking);
    }

    animFrameId = requestAnimationFrame(check);
  }

  check();

  return () => {
    cancelAnimationFrame(animFrameId);
    source.disconnect();
    audioContext.close();
  };
}
