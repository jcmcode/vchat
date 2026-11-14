// "Test speaker": a short three-note chime generated with WebAudio (no audio file is loaded),
// played on the chosen speaker where the browser lets pages pick one.

export interface ToneNote {
  /** Hz */
  frequency: number;
  /** Seconds from the start. */
  start: number;
  /** Seconds. */
  duration: number;
}

/** C5, E5, G5: about one second in total. */
export const TEST_TONE: readonly ToneNote[] = [
  { frequency: 523.25, start: 0, duration: 0.2 },
  { frequency: 659.25, start: 0.24, duration: 0.2 },
  { frequency: 783.99, start: 0.48, duration: 0.45 },
];

const VOLUME = 0.25;

export function toneLength(notes: readonly ToneNote[] = TEST_TONE): number {
  return notes.reduce((end, n) => Math.max(end, n.start + n.duration), 0);
}

/** Pages can choose the speaker (setSinkId) in Chromium browsers and recent Firefox, not Safari. */
export function canChooseSpeaker(): boolean {
  return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
}

/** Play the chime on `sinkId` ('' = the default speaker). Resolves when it has finished. */
export async function playTestTone(sinkId = ''): Promise<void> {
  const context = new AudioContext();
  let element: HTMLAudioElement | null = null;
  try {
    let output: AudioNode = context.destination;
    if (sinkId && canChooseSpeaker()) {
      // Route through an <audio> element, whose output device can be chosen in more browsers.
      const destination = context.createMediaStreamDestination();
      element = new Audio();
      element.srcObject = destination.stream;
      await element.setSinkId(sinkId).catch(() => {});
      await element.play();
      output = destination;
    }
    await context.resume();
    const t0 = context.currentTime + 0.05;
    for (const note of TEST_TONE) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = note.frequency;
      // Short fade in and out, so the notes don't click.
      const start = t0 + note.start;
      const end = start + note.duration;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(VOLUME, start + 0.02);
      gain.gain.setValueAtTime(VOLUME, end - 0.06);
      gain.gain.linearRampToValueAtTime(0, end);
      oscillator.connect(gain).connect(output);
      oscillator.start(start);
      oscillator.stop(end + 0.01);
    }
    await new Promise((resolve) => setTimeout(resolve, (toneLength() + 0.2) * 1000));
  } finally {
    if (element) {
      element.pause();
      element.srcObject = null;
    }
    context.close().catch(() => {});
  }
}
