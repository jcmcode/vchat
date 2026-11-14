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
  /**
   * States that must reach receivers even if they only lasted a moment (e.g. "the mic came on"),
   * judged against the last state sent: if one is seen during the quiet period and is already over
   * when it ends, it's sent anyway, and the current state follows one interval later.
   */
  latch?: (value: T, lastSent: T | undefined) => boolean;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export class LatestSender<T> {
  private lastKey: string | undefined;
  private lastValue: T | undefined;
  private lastAt = -Infinity;
  private timer: unknown = null;
  private latched: { value: T; key: string } | null = null;
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
    if (initial !== undefined) {
      this.lastKey = this.key(initial);
      this.lastValue = initial;
    }
  }

  /** The state may have changed: send it now, or when the interval since the last send is up. */
  notify(): void {
    if (this.opts.latch && this.latched === null) {
      const seen = this.opts.read();
      const seenKey = this.key(seen);
      if (seenKey !== this.lastKey && this.opts.latch(seen, this.lastValue)) this.latched = { value: seen, key: seenKey };
    }
    if (this.timer !== null) return; // a send is already scheduled; it reads the latest state
    const now = this.now();
    const wait = this.lastAt + this.opts.intervalMs - now;
    if (wait > 0) {
      this.schedule(wait);
      return;
    }
    let value = this.opts.read();
    let key = this.key(value);
    const latched = this.latched;
    this.latched = null;
    if (latched && latched.key !== key && latched.key !== this.lastKey) {
      // A state that must be reported happened during the quiet period and is already over:
      // report it, then send the current state once the interval is up.
      value = latched.value;
      key = latched.key;
      this.schedule(this.opts.intervalMs);
    } else if (key === this.lastKey) {
      return;
    }
    this.lastKey = key;
    this.lastValue = value;
    this.lastAt = now;
    this.opts.send(value);
  }

  private schedule(ms: number): void {
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.notify();
    }, ms);
  }

  /** Drop any scheduled send. */
  cancel(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  /** Forget everything (e.g. after leaving a call). */
  reset(initial?: T): void {
    this.cancel();
    this.latched = null;
    this.lastAt = -Infinity;
    this.lastKey = initial === undefined ? undefined : this.key(initial);
    this.lastValue = initial;
  }
}
