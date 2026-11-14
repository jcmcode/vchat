// Which remote video to show in standard (single-video) picture-in-picture. Pure, unit-tested in
// pip-target.test.ts; used by pip.ts where the Document Picture-in-Picture API isn't available.

export interface PipCandidate {
  id: string;
  /** Has a live video picture we may show: connection verified (or allowed) and camera on or sharing. */
  hasVideo: boolean;
  /** Is sharing their screen. */
  sharing: boolean;
}

/**
 * The shared screen first, then the active speaker, then whoever is shown now (so the picture
 * doesn't jump around), then the first person with video. Null when nobody has video to show.
 */
export function pickPipPeer(candidates: PipCandidate[], activeSpeaker: string | null, current: string | null): string | null {
  const withVideo = candidates.filter((c) => c.hasVideo);
  const sharer = withVideo.find((c) => c.sharing);
  if (sharer) return sharer.id;
  if (activeSpeaker && withVideo.some((c) => c.id === activeSpeaker)) return activeSpeaker;
  if (current && withVideo.some((c) => c.id === current)) return current;
  return withVideo[0]?.id ?? null;
}

/**
 * The active speaker: whoever spoke most recently. Kept while they're still speaking (someone else
 * starting doesn't steal it mid-sentence) and after they stop, until someone else speaks.
 * `speaking` may contain 'local' (ourselves), which never counts.
 */
export function nextActiveSpeaker(previous: string | null, speaking: Iterable<string>, isPresent: (id: string) => boolean): string | null {
  const now = Array.from(speaking).filter((id) => id !== 'local' && isPresent(id));
  if (previous && now.includes(previous)) return previous;
  if (now.length) return now[0];
  return previous && isPresent(previous) ? previous : null;
}
