// Per-connection token bucket. Generous enough for a burst of ICE candidates to 5 peers,
// strict enough to stop a client from flooding the server.

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

const MAX_TOKENS = 200;
const REFILL_PER_SECOND = 30;

export class RateLimiter<C extends object> {
  private buckets = new WeakMap<C, TokenBucket>();

  allow(conn: C, now = Date.now()): boolean {
    let bucket = this.buckets.get(conn);
    if (!bucket) {
      bucket = { tokens: MAX_TOKENS, lastRefill: now };
      this.buckets.set(conn, bucket);
    }
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(MAX_TOKENS, bucket.tokens + elapsed * REFILL_PER_SECOND);
    bucket.lastRefill = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }
}
