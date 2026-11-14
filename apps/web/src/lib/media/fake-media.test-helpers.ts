// Test doubles for MediaStreamTrack and getUserMedia (no browser needed).

export class FakeTrack {
  enabled = true;
  readyState: 'live' | 'ended' = 'live';
  stopCount = 0;
  readonly id: string;
  private listeners = new Set<() => void>();
  private static next = 0;

  constructor(
    readonly kind: 'audio' | 'video',
    private settings: { deviceId?: string; facingMode?: string } = {}
  ) {
    this.id = `${kind}-${FakeTrack.next++}`;
  }

  stop(): void {
    this.stopCount++;
    this.readyState = 'ended';
  }

  getSettings(): { deviceId?: string; facingMode?: string } {
    return this.settings;
  }

  addEventListener(_type: string, fn: () => void): void {
    this.listeners.add(fn);
  }

  removeEventListener(_type: string, fn: () => void): void {
    this.listeners.delete(fn);
  }

  /** The device went away (unplugged, permission revoked). */
  end(): void {
    this.readyState = 'ended';
    for (const fn of this.listeners) fn();
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

export const asTrack = (t: FakeTrack) => t as unknown as MediaStreamTrack;

export function mediaError(name: string): Error {
  return Object.assign(new Error(name), { name });
}

type Responder = (constraints: MediaStreamConstraints) => FakeTrack[] | Error | Promise<FakeTrack[] | Error>;

/** A scripted getUserMedia: each call is answered by the next responder (or the default one). */
export class FakeGetUserMedia {
  calls: MediaStreamConstraints[] = [];
  private queue: Responder[] = [];

  constructor(private fallback: Responder = defaultResponder) {}

  then(responder: Responder): this {
    this.queue.push(responder);
    return this;
  }

  readonly fn = async (constraints: MediaStreamConstraints) => {
    this.calls.push(constraints);
    const responder = this.queue.shift() ?? this.fallback;
    const result = await responder(constraints);
    if (result instanceof Error) throw result;
    return { getTracks: () => result.map(asTrack) };
  };
}

export function defaultResponder(constraints: MediaStreamConstraints): FakeTrack[] {
  const tracks: FakeTrack[] = [];
  if (constraints.audio) tracks.push(new FakeTrack('audio', { deviceId: 'mic-1' }));
  if (constraints.video) tracks.push(new FakeTrack('video', { deviceId: 'cam-front', facingMode: 'user' }));
  return tracks;
}

/** A promise you resolve later (to model a slow permission prompt). */
export function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

export const flush = () => new Promise((r) => setTimeout(r, 0));
