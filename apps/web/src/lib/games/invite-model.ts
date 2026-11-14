// Game invitations you've received: someone asks you to play, and nothing starts until you accept.
// Pure, so it's unit-tested without a network (games.test.ts).

import { isRecord } from './rules.js';
import { isGameKind, type GameKind } from './session-model.js';

/** An invitation you haven't answered goes away after this long. */
export const INVITE_TTL_MS = 60_000;
/** One invitation per person at a time, and at most one a second (a newer one replaces the older). */
const MIN_GAP_MS = 1_000;
const MAX_ID = 40;

export interface Invite {
  id: string;
  kind: GameKind;
  /** Who invited you: the connection it came on, never anything in the message. */
  from: string;
  at: number;
}

export class InviteBook {
  private byPeer = new Map<string, Invite>();
  private lastAt = new Map<string, number>();

  /** An invitation from `from`, or null when it's malformed or too soon after their last one. */
  receive(from: string, raw: unknown, now: number): Invite | null {
    if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id || raw.id.length > MAX_ID || !isGameKind(raw.kind)) return null;
    const last = this.lastAt.get(from);
    if (last !== undefined && now - last < MIN_GAP_MS) return null;
    this.lastAt.set(from, now);
    const invite: Invite = { id: raw.id, kind: raw.kind, from, at: now };
    this.byPeer.set(from, invite);
    return invite;
  }

  /** They took their invitation back. Only the person who sent it can. */
  cancel(from: string, id: unknown): boolean {
    const invite = this.byPeer.get(from);
    if (!invite || invite.id !== id) return false;
    this.byPeer.delete(from);
    return true;
  }

  /** Remove and return the invitation with this id (you're answering it). */
  take(id: string): Invite | undefined {
    for (const [peer, invite] of this.byPeer) {
      if (invite.id === id) {
        this.byPeer.delete(peer);
        return invite;
      }
    }
    return undefined;
  }

  /** They left the call. */
  removePeer(peerId: string): boolean {
    this.lastAt.delete(peerId);
    return this.byPeer.delete(peerId);
  }

  /** Drop invitations nobody answered in time. Returns whether any went. */
  expire(now: number): boolean {
    let any = false;
    for (const [peer, invite] of this.byPeer) {
      if (now - invite.at >= INVITE_TTL_MS) {
        this.byPeer.delete(peer);
        any = true;
      }
    }
    return any;
  }

  /** Oldest first. */
  list(): Invite[] {
    return [...this.byPeer.values()].sort((a, b) => a.at - b.at);
  }

  clear(): void {
    this.byPeer.clear();
    this.lastAt.clear();
  }
}
