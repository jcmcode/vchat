// Send the latest state of something at most once per interval (trailing edge). A change during
// the quiet period goes out when it ends, so receivers that rate-limit a message type never drop
// the final state; an unchanged state isn't sent again. Pure (clock and timers injectable) and
// unit-tested in latest-sender.test.ts.

export interface LatestSenderOptions<T> {
  intervalMs: number;
  /** The state right now (read when it's actually sent). */
  read: () => T;
  send: (value: T) => void;
  /** Equality key (default: JSON). */
  key?: (value: T) => string;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export class LatestSender<T> {
  private lastKey: string | undefined;
  private lastAt = -Infinity;
  private timer: unknown = null;
  private readonly key: (value: T) => string;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;

  /** `initial`: what receivers already assume (not sent again until it changes). */
  constructor(
    private readonly opts: LatestSenderOptions<T>,
    initial?: T
  ) {
    this.key = opts.key ?? ((v) => JSON.stringify(v));
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
    if (initial !== undefined) this.lastKey = this.key(initial);
  }

  /** The state may have changed: send it now, or when the interval since the last send is up. */
  notify(): void {
    if (this.timer !== null) return; // a send is already scheduled; it reads the latest state
    const now = this.now();
    const wait = this.lastAt + this.opts.intervalMs - now;
    if (wait > 0) {
      this.timer = this.setTimer(() => {
        this.timer = null;
        this.notify();
      }, wait);
      return;
    }
    const value = this.opts.read();
    const key = this.key(value);
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.lastAt = now;
    this.opts.send(value);
  }

  /** Drop any scheduled send. */
  cancel(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  /** Forget everything (e.g. after leaving a call). */
  reset(initial?: T): void {
    this.cancel();
    this.lastAt = -Infinity;
    this.lastKey = initial === undefined ? undefined : this.key(initial);
  }
}
