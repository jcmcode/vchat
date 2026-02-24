import type { WebSocket } from 'ws';

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

const MAX_TOKENS = 10;
const REFILL_RATE = 10; // tokens per second
const TOKENS_PER_MESSAGE = 1;

const buckets = new WeakMap<WebSocket, TokenBucket>();

function refillBucket(bucket: TokenBucket): void {
  const now = Date.now();
  const elapsed = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(MAX_TOKENS, bucket.tokens + elapsed * REFILL_RATE);
  bucket.lastRefill = now;
}

export function checkRateLimit(ws: WebSocket): boolean {
  let bucket = buckets.get(ws);
  if (!bucket) {
    bucket = { tokens: MAX_TOKENS, lastRefill: Date.now() };
    buckets.set(ws, bucket);
  }

  refillBucket(bucket);

  if (bucket.tokens < TOKENS_PER_MESSAGE) {
    return false;
  }

  bucket.tokens -= TOKENS_PER_MESSAGE;
  return true;
}
