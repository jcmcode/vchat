// Calls the host just ended, remembered briefly so a participant who was offline at that moment
// (and reconnects automatically) is told the call is over, instead of silently re-opening it.
//
// Only the identities that were in the ended call are remembered: peer id + truncated hash of
// their tab secret, never names or addresses. Anyone else entering is treated as if the room
// never existed. Memory only (per process, or per isolate on Cloudflare), forgotten after
// ENDED_GRACE_MS, and capped: when full, the oldest entries are dropped first.

/** How long an ended call's identities are remembered. */
export const ENDED_GRACE_MS = 60 * 1000;
const MAX_ENDED_CALLS = 5_000;
/** Bound on identities across all entries (an entry holds at most ~65: admitted + waiting). */
const MAX_ENDED_IDENTITIES = 50_000;

interface EndedCall {
  at: number;
  ids: Set<string>;
}

export interface EndedIdentity {
  peerId: string;
  /** Truncated sha256 of the tab secret, as stored by Room. */
  secretHash: string;
}

const key = (peerId: string, secretHash: string) => `${peerId}\n${secretHash}`;

export class EndedCalls {
  /** Insertion order is age order (oldest first). */
  private readonly calls = new Map<string, EndedCall>();
  private identities = 0;

  constructor(
    private readonly maxCalls = MAX_ENDED_CALLS,
    private readonly maxIdentities = MAX_ENDED_IDENTITIES,
    private readonly ttlMs = ENDED_GRACE_MS
  ) {}

  /** Remember who was in a call that just ended (replacing anything remembered for that room). */
  mark(roomId: string, who: Iterable<EndedIdentity>, now = Date.now()): void {
    this.forget(roomId);
    const ids = new Set<string>();
    for (const { peerId, secretHash } of who) if (secretHash) ids.add(key(peerId, secretHash));
    if (ids.size === 0) return;
    this.calls.set(roomId, { at: now, ids });
    this.identities += ids.size;
    this.sweep(now);
    // Full: drop the oldest first, so a burst of new entries never stops new calls being remembered.
    for (const [id] of this.calls) {
      if (this.calls.size <= this.maxCalls && this.identities <= this.maxIdentities) break;
      this.forget(id);
    }
  }

  /** Was this identity (peer id + secret hash) in `roomId`'s call when it ended, recently? */
  wasIn(roomId: string, peerId: string, secretHash: string, now = Date.now()): boolean {
    const call = this.calls.get(roomId);
    if (!call) return false;
    if (now - call.at >= this.ttlMs) {
      this.forget(roomId);
      return false;
    }
    return call.ids.has(key(peerId, secretHash));
  }

  /** Is anything remembered for this room right now? */
  has(roomId: string, now = Date.now()): boolean {
    const call = this.calls.get(roomId);
    return !!call && now - call.at < this.ttlMs;
  }

  /** Drop expired entries (oldest first). */
  sweep(now = Date.now()): void {
    for (const [id, call] of this.calls) {
      if (now - call.at < this.ttlMs) break;
      this.forget(id);
    }
  }

  get size(): number {
    return this.calls.size;
  }

  private forget(roomId: string): void {
    const call = this.calls.get(roomId);
    if (!call) return;
    this.identities -= call.ids.size;
    this.calls.delete(roomId);
  }
}

/** Shared by every Room in this process (or Cloudflare isolate). */
export const endedCalls = new EndedCalls();
