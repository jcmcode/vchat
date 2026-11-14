// In-memory abuse throttles shared by the HTTP API and rooms. Per process (Node) or per isolate /
// Durable Object (Cloudflare). Nothing here is persisted, and entries are dropped once their window
// has passed, so client addresses aren't kept around.

/**
 * Sliding-window attempt counter keyed by an opaque string (an IP prefix, room + client hash, …).
 * Keys whose window is empty are deleted; on overflow, stale keys go first, then the oldest.
 */
export class AttemptCounter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly windowMs: number,
    private readonly maxKeys = 10_000
  ) {}

  get size(): number {
    return this.hits.size;
  }

  /** Attempts by `key` still inside the window. */
  count(key: string, now = Date.now()): number {
    return this.recent(key, now).length;
  }

  /** Count an attempt; returns false (without counting) if the key is at its limit. */
  take(key: string, limit: number, now = Date.now()): boolean {
    const recent = this.recent(key, now);
    if (recent.length >= limit) return false;
    recent.push(now);
    this.hits.delete(key); // re-insert so Map order tracks the newest attempt
    this.hits.set(key, recent);
    if (this.hits.size > this.maxKeys) this.evict(now);
    return true;
  }

  /** Undo the newest attempt (e.g. it turned out to be a success). */
  refund(key: string, now = Date.now()): void {
    const recent = this.recent(key, now);
    if (recent.length === 0) return;
    recent.pop(); // `recent` is a filtered copy: store it back
    if (recent.length === 0) this.hits.delete(key);
    else this.hits.set(key, recent);
  }

  /** Drop every key whose newest attempt is outside the window. */
  sweep(now = Date.now()): void {
    for (const [key, list] of this.hits) {
      if (list.length === 0 || now - list[list.length - 1] >= this.windowMs) this.hits.delete(key);
    }
  }

  private recent(key: string, now: number): number[] {
    const list = this.hits.get(key);
    if (!list) return [];
    const recent = list.filter((t) => now - t < this.windowMs);
    if (recent.length === 0) this.hits.delete(key);
    else if (recent.length !== list.length) this.hits.set(key, recent);
    return recent;
  }

  private evict(now: number): void {
    // Stale keys first (cheap: Map order follows each key's newest attempt, so they lead).
    for (const [key, list] of this.hits) {
      if (this.hits.size <= this.maxKeys) return;
      if (list.length > 0 && now - list[list.length - 1] < this.windowMs) break;
      this.hits.delete(key);
    }
    // Then the least recently active.
    while (this.hits.size > this.maxKeys) this.hits.delete(this.hits.keys().next().value!);
  }
}

/** Expand an IPv6 address to 8 hextets (returns null if it isn't one). */
function expandIpv6(ip: string): number[] | null {
  let addr = ip;
  // Embedded IPv4 tail (e.g. ::ffff:1.2.3.4)
  const v4 = addr.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    addr = addr.slice(0, -v4[0].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

/**
 * Throttle key for a client address: IPv4 as-is, IPv6 by its /64 (one subscriber usually gets a
 * whole /64, so per-address limits would be trivial to dodge). IPv4-mapped IPv6 maps back to IPv4.
 */
export function ipKey(ip: string | undefined | null): string {
  if (!ip) return 'unknown';
  const addr = ip.trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (!addr.includes(':')) return addr;
  const groups = expandIpv6(addr);
  if (!groups) return addr.toLowerCase();
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join('.');
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(':')}::/64`;
}

export interface LoginThrottleOptions {
  windowMs: number;
  /** Attempts per client (IPv4 address or IPv6 /64) per window. */
  perClient: number;
  /** Attempts per window across all clients before the global slowdown starts. */
  globalSoft: number;
  /** Above `globalSoft`, checks are spaced at least this far apart (globally). */
  spacingMs: number;
  /** Never make a request wait longer than this; past it, answer "try again shortly". */
  maxWaitMs: number;
  maxKeys?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Owner sign-in throttle. Every client gets a small budget per window. Across all clients the first
 * `globalSoft` attempts are checked immediately; after that, checks are queued one per `spacingMs`
 * (a slowdown, not a lockout: the owner still gets in within `maxWaitMs` when the queue isn't
 * full). The global count lives in its own field, so flooding the per-client map can't reset it.
 */
export class LoginThrottle {
  private readonly perClient: AttemptCounter;
  private global: number[] = [];
  private nextSlot = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: LoginThrottleOptions) {
    this.perClient = new AttemptCounter(opts.windowMs, opts.maxKeys ?? 10_000);
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Resolves true when the attempt may be checked (after any slowdown), false if refused. */
  async acquire(ip: string | undefined): Promise<boolean> {
    const now = this.now();
    const key = ipKey(ip);
    if (!this.perClient.take(key, this.opts.perClient, now)) return false;

    this.global = this.global.filter((t) => now - t < this.opts.windowMs);
    if (this.global.length < this.opts.globalSoft) {
      this.global.push(now);
      return true;
    }
    const slot = Math.max(now, this.nextSlot);
    if (slot - now > this.opts.maxWaitMs) {
      this.perClient.refund(key, now); // never checked, so don't charge the client for it
      return false;
    }
    this.nextSlot = slot + this.opts.spacingMs;
    this.global.push(now);
    if (slot > now) await this.sleep(slot - now);
    return true;
  }

  /** A correct password: give the attempt back. */
  succeeded(ip: string | undefined): void {
    const now = this.now();
    this.perClient.refund(ipKey(ip), now);
    this.global.pop();
  }

  sweep(now = this.now()): void {
    this.perClient.sweep(now);
    this.global = this.global.filter((t) => now - t < this.opts.windowMs);
  }

  /** For tests. */
  get trackedClients(): number {
    return this.perClient.size;
  }
}

/**
 * Room-password guesses: per room + client, with a per-room backstop. Count before checking (so
 * parallel bursts can't slip through) and refund on success.
 */
export class PasswordThrottle {
  private readonly perClient: AttemptCounter;
  private readonly perRoom: AttemptCounter;

  constructor(
    windowMs: number,
    private readonly perClientLimit: number,
    private readonly perRoomLimit: number,
    maxKeys = 10_000
  ) {
    this.perClient = new AttemptCounter(windowMs, maxKeys);
    this.perRoom = new AttemptCounter(windowMs, maxKeys);
  }

  take(roomId: string, clientId: string | undefined, now = Date.now()): boolean {
    const clientKey = `${roomId}|${clientId ?? 'unknown'}`;
    if (!this.perClient.take(clientKey, this.perClientLimit, now)) return false;
    if (!this.perRoom.take(roomId, this.perRoomLimit, now)) {
      this.perClient.refund(clientKey, now);
      return false;
    }
    return true;
  }

  refund(roomId: string, clientId: string | undefined, now = Date.now()): void {
    this.perClient.refund(`${roomId}|${clientId ?? 'unknown'}`, now);
    this.perRoom.refund(roomId, now);
  }

  sweep(now = Date.now()): void {
    this.perClient.sweep(now);
    this.perRoom.sweep(now);
  }
}

export const PASSWORD_WINDOW_MS = 10 * 60 * 1000;
export const PASSWORD_MAX_PER_CLIENT = 10;
export const PASSWORD_MAX_PER_ROOM = 200;

/** Shared room-password throttle (private-mode invites and open-mode room passwords). */
export const passwordAttempts = new PasswordThrottle(PASSWORD_WINDOW_MS, PASSWORD_MAX_PER_CLIENT, PASSWORD_MAX_PER_ROOM);
