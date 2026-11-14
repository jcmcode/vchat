// Raised hands: the pure part (validation, rate limiting, when to show a notice). Unit-tested in
// hands.test.ts; hands.ts wires it to the data channels.
//
// Wire format: { type: 'hand', raised: boolean } and nothing else. Whose hand it is always comes
// from the connection the message arrived on, never from the message.

/** `raised` from a well-formed hand message, or null for anything else (extra fields included). */
export function parseHandMessage(msg: unknown): boolean | null {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  const m = msg as Record<string, unknown>;
  const keys = Object.keys(m);
  if (keys.length !== 2 || m.type !== 'hand' || typeof m.raised !== 'boolean') return null;
  return m.raised;
}

/** Token bucket per key (peer id): `perSecond` refill, up to `burst` at once. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly perSecond: number,
    private readonly burst: number
  ) {}

  allow(key: string, now: number): boolean {
    const b = this.buckets.get(key) ?? { tokens: this.burst, at: now };
    b.tokens = Math.min(this.burst, b.tokens + (Math.max(0, now - b.at) / 1000) * this.perSecond);
    b.at = now;
    this.buckets.set(key, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  forget(key: string): void {
    this.buckets.delete(key);
  }

  clear(): void {
    this.buckets.clear();
  }
}

export interface HandOptions {
  /** Messages accepted per peer per second (the sender coalesces to ~3/s, so honest peers never hit it). */
  perSecond: number;
  burst: number;
  /** At most one "raised their hand" notice per person per this many ms. */
  toastCooldownMs: number;
  /** State that arrives this soon after a connection opens is a catch-up, not news: no notice. */
  syncGraceMs: number;
}

export const DEFAULT_HAND_OPTIONS: HandOptions = { perSecond: 5, burst: 10, toastCooldownMs: 5000, syncGraceMs: 2500 };

export interface HandChange {
  raised: boolean;
  /** Show a brief "… raised their hand" notice. */
  toast: boolean;
}

/** Who has their hand up, from what verified peers told us. */
export class RaisedHands {
  private readonly raised = new Set<string>();
  private readonly limiter: RateLimiter;
  private readonly lastToast = new Map<string, number>();
  private readonly connectedAt = new Map<string, number>();

  constructor(private readonly opts: HandOptions = DEFAULT_HAND_OPTIONS) {
    this.limiter = new RateLimiter(opts.perSecond, opts.burst);
  }

  /** A (verified) connection to this peer just opened: they're about to send their current state. */
  connected(peerId: string, now: number): void {
    this.connectedAt.set(peerId, now);
  }

  /**
   * A message from `peerId` (the connection's id). Returns the change, or null if it was dropped
   * (over the rate limit or malformed) or changed nothing.
   */
  receive(peerId: string, msg: unknown, now: number): HandChange | null {
    if (!this.limiter.allow(peerId, now)) return null;
    const raised = parseHandMessage(msg);
    if (raised === null || this.raised.has(peerId) === raised) return null;
    if (raised) this.raised.add(peerId);
    else this.raised.delete(peerId);
    let toast = false;
    if (raised) {
      const sinceConnect = now - (this.connectedAt.get(peerId) ?? -Infinity);
      const sinceToast = now - (this.lastToast.get(peerId) ?? -Infinity);
      toast = sinceConnect >= this.opts.syncGraceMs && sinceToast >= this.opts.toastCooldownMs;
      if (toast) this.lastToast.set(peerId, now);
    }
    return { raised, toast };
  }

  /** The peer left: their hand comes down. Returns true if it was up. */
  remove(peerId: string): boolean {
    this.limiter.forget(peerId);
    this.lastToast.delete(peerId);
    this.connectedAt.delete(peerId);
    return this.raised.delete(peerId);
  }

  clear(): void {
    this.raised.clear();
    this.limiter.clear();
    this.lastToast.clear();
    this.connectedAt.clear();
  }

  has(peerId: string): boolean {
    return this.raised.has(peerId);
  }

  list(): string[] {
    return [...this.raised];
  }
}
