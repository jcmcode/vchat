// Short-lived memory of who was in a room, kept after the room's own state is gone:
//
//  - `endedCalls`: calls the host just ended, so a participant who was offline at that moment (and
//    reconnects automatically) is told the call is over instead of silently re-opening it.
//  - `lockedRooms`: rooms that emptied while locked (an owner alone whose connection blipped), so
//    the room comes back locked: only the people who were in it get back in meanwhile.
//
// Only identities are remembered: peer id + truncated hash of their tab secret, never names or
// addresses. Memory only (per process, or per isolate on Cloudflare), forgotten after the grace
// period, and capped: when full, the oldest entries are dropped first.

/** How long an ended call's identities are remembered. */
export const ENDED_GRACE_MS = 60 * 1000;
/** How long a room that emptied while locked stays locked. */
export const LOCK_GRACE_MS = 60 * 1000;
const MAX_CALLS = 5_000;
/** Bound on identities across all entries (an entry holds at most ~65: admitted + waiting). */
const MAX_IDENTITIES = 50_000;

interface Remembered {
  at: number;
  ids: Set<string>;
}

export interface EndedIdentity {
  peerId: string;
  /** Truncated sha256 of the tab secret, as stored by Room ('' if the peer sent none: skipped). */
  secretHash: string;
}

const key = (peerId: string, secretHash: string) => `${peerId}\n${secretHash}`;

export class EndedCalls {
  /** Insertion order is age order (oldest first). */
  private readonly calls = new Map<string, Remembered>();
  private identities = 0;

  constructor(
    private readonly maxCalls = MAX_CALLS,
    private readonly maxIdentities = MAX_IDENTITIES,
    private readonly ttlMs = ENDED_GRACE_MS
  ) {}

  /**
   * Remember these identities for `roomId`. Anything still remembered for the room is kept too (a
   * second call ended a moment later doesn't erase the first one's), and the clock restarts.
   */
  mark(roomId: string, who: Iterable<EndedIdentity>, now = Date.now()): void {
    const previous = this.calls.get(roomId);
    const ids = previous && now - previous.at < this.ttlMs ? new Set(previous.ids) : new Set<string>();
    this.forget(roomId);
    for (const { peerId, secretHash } of who) if (secretHash) ids.add(key(peerId, secretHash));
    if (ids.size === 0) return;
    this.calls.set(roomId, { at: now, ids });
    this.identities += ids.size;
    this.sweep(now);
    // Full: drop the oldest first, so a burst of new entries never stops new ones being remembered.
    for (const [id] of this.calls) {
      if (this.calls.size <= this.maxCalls && this.identities <= this.maxIdentities) break;
      this.forget(id);
    }
  }

  /** Is this identity (peer id + secret hash) remembered for `roomId`? */
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

  forget(roomId: string): void {
    const call = this.calls.get(roomId);
    if (!call) return;
    this.identities -= call.ids.size;
    this.calls.delete(roomId);
  }
}

/** Shared by every Room in this process (or Cloudflare isolate). */
export const endedCalls = new EndedCalls();
/** Rooms that emptied while locked (same process/isolate scope). */
export const lockedRooms = new EndedCalls(MAX_CALLS, MAX_IDENTITIES, LOCK_GRACE_MS);
