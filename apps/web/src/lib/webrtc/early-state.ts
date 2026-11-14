// State that arrives before we trust a connection (screen and media state, what their version
// supports, and how they show our camera).
//
// Each side opens the trust gate when *it* has checked the other's proof, so one side can be
// trusted a moment before the other. The side that's ahead sends its current state straight away
// (screen-state, media-state), and it lands while we're still checking its proof. Nothing from an
// unverified connection may be acted on, but dropping these would lose an ongoing screen share for
// good (it's only announced when it starts and when a connection is trusted). So we keep the
// latest of each, as a small validated copy, and apply them in trustPeer, through the normal
// handlers. The store belongs to one connection object, so it's gone with a new session or a block.
//
// Pure, so it's unit-testable.

import { parseView } from '../media/quality.js';
import { isValidMid } from './media-slots.js';

export type EarlyState =
  | { type: 'screen-state'; sharing: boolean; mid?: string }
  | { type: 'media-state'; audio: boolean; video: boolean }
  /** What their version supports (ice-recovery.ts). */
  | { type: 'caps'; iceRestart: boolean }
  /** How they show our camera (quality.ts parseView): copied as validated. */
  | { type: 'view'; w?: number; h?: number; fit?: 'cover' | 'contain'; full?: true };

/** A validated copy of a state message worth keeping until trust, or null for anything else. */
export function earlyState(msg: unknown): EarlyState | null {
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as Record<string, unknown>;
  if (m.type === 'screen-state') {
    const sharing = m.sharing === true;
    return sharing && isValidMid(m.mid) ? { type: 'screen-state', sharing, mid: m.mid } : { type: 'screen-state', sharing };
  }
  if (m.type === 'media-state') return { type: 'media-state', audio: m.audio !== false, video: m.video !== false };
  if (m.type === 'caps') return { type: 'caps', iceRestart: m.iceRestart === true };
  if (m.type === 'view') {
    const view = parseView(m);
    if (!view) return null;
    if (view.kind === 'full') return { type: 'view', full: true };
    if (view.kind === 'none') return { type: 'view', w: 0, h: 0 };
    return { type: 'view', w: view.w, h: view.h, fit: view.fit };
  }
  return null;
}

/** Keep `msg` if it's one of those (replacing the previous one of its type). Returns whether it was kept. */
export function holdEarlyState(store: Map<EarlyState['type'], EarlyState>, msg: unknown): boolean {
  const state = earlyState(msg);
  if (!state) return false;
  store.set(state.type, state);
  return true;
}
