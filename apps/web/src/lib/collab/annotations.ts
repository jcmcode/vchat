// Laser pointer + drawing on top of a shared screen.
// Each screen share ("screen" = the sharer's peer id) has its own set of annotations. Viewers and
// the presenter can point and draw; everyone sees the same marks, positioned relative to the
// shared screen's content (not the window), so they line up on every display.
// Sent over the peer-to-peer data channels only.

import { get, writable } from 'svelte/store';
import {
  broadcastData,
  getLocalPeerId,
  onPeerConnected,
  onPeerLeft,
  onRoomLeft,
  peerDisplayName,
  registerDataHandler,
  sendData,
  sharingPeers,
} from '../webrtc/mesh.js';
import { isScreenSharing } from '../media/manager.js';
import { StrokeSender } from './stroke-sender.js';
import {
  appendToStroke,
  batchStrokes,
  clearBoard,
  colorFor,
  emptyBoard,
  idAuthor,
  lastStrokeBy,
  mergeStroke,
  newStrokeId,
  removeStrokes,
  sanitizeStroke,
  type Board,
  type Stroke,
} from './strokes.js';

export type AnnotationTool = 'none' | 'laser' | 'pen';

export interface Pointer {
  x: number;
  y: number;
  /** ms timestamp of the last update (pointers fade out shortly after). */
  at: number;
  color: string;
  name: string;
}

export const POINTER_TTL_MS = 1500;
/** Most marks one person can have on a screen (so nobody can use up everyone's space). */
const MAX_STROKES_PER_AUTHOR = 300;
const POINTER_INTERVAL_MS = 33;

/** screen owner peer id -> annotations on that screen */
export const screens = new Map<string, { board: Board; pointers: Map<string, Pointer> }>();
export const annotationVersion = writable(0);
export const annotationTool = writable<AnnotationTool>('none');

function screenState(screen: string) {
  let s = screens.get(screen);
  if (!s) {
    s = { board: emptyBoard(), pointers: new Map() };
    screens.set(screen, s);
  }
  return s;
}

function changed(): void {
  annotationVersion.update((v) => v + 1);
}

function validScreen(v: unknown): v is string {
  return typeof v === 'string' && /^[a-zA-Z0-9_-]{1,30}$/.test(v);
}

/** Only screens that are being shared right now can carry annotations. */
function isActiveScreen(screen: string): boolean {
  return screen === getLocalPeerId() ? get(isScreenSharing) : get(sharingPeers).has(screen);
}

function strokesBy(board: Board, author: string): number {
  let n = 0;
  for (const s of board.strokes.values()) if (s.author === author) n++;
  return n;
}

/** Only ids of marks that exist (no tombstone spam that could push out real tombstones). */
function existingIds(board: Board, ids: unknown, max: number): string[] {
  if (!Array.isArray(ids)) return [];
  return ids.slice(0, max).filter((id): id is string => typeof id === 'string' && board.strokes.has(id));
}

registerDataHandler('annot', (fromPeerId, msg) => {
  if (!validScreen(msg.screen) || !isActiveScreen(msg.screen)) return;
  const state = screenState(msg.screen);
  switch (msg.op) {
    case 'pointer': {
      const x = Number(msg.x);
      const y = Number(msg.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      state.pointers.set(fromPeerId, {
        x: Math.min(Math.max(x, 0), 1),
        y: Math.min(Math.max(y, 0), 1),
        at: Date.now(),
        color: colorFor(fromPeerId),
        name: peerDisplayName(fromPeerId),
      });
      break;
    }
    case 'pointer-off':
      state.pointers.delete(fromPeerId);
      break;
    case 'stroke': {
      const stroke = sanitizeStroke(msg.stroke, fromPeerId);
      if (!stroke) return;
      const isNew = !state.board.strokes.has(stroke.id);
      if (isNew && strokesBy(state.board, fromPeerId) >= MAX_STROKES_PER_AUTHOR) return;
      appendToStroke(state.board, stroke);
      break;
    }
    case 'remove':
      removeStrokes(state.board, existingIds(state.board, msg.ids, 500));
      break;
    case 'clear':
      removeStrokes(state.board, existingIds(state.board, msg.ids, 5000));
      break;
    case 'sync':
      // Existing marks, sent only by the presenter to people who join mid-share.
      if (fromPeerId !== msg.screen) return;
      if (Array.isArray(msg.strokes)) {
        const counts = new Map<string, number>();
        for (const raw of msg.strokes.slice(0, 500)) {
          // The author is whoever the id belongs to — never what the message claims.
          const author = idAuthor((raw as { id?: unknown } | null)?.id);
          if (!author) continue;
          const n = counts.get(author) ?? strokesBy(state.board, author);
          if (n >= MAX_STROKES_PER_AUTHOR) continue;
          const stroke = sanitizeStroke(raw, author);
          if (stroke && mergeStroke(state.board, { ...stroke, done: true }, author === fromPeerId)) counts.set(author, n + 1);
        }
      }
      break;
    default:
      return;
  }
  changed();
});

// The presenter brings newcomers up to date with what's already drawn on their screen.
onPeerConnected((peerId) => {
  const me = getLocalPeerId();
  const state = screens.get(me);
  if (!state || !get(isScreenSharing) || state.board.strokes.size === 0) return;
  for (const batch of batchStrokes([...state.board.strokes.values()])) {
    sendData(peerId, { type: 'annot', screen: me, op: 'sync', strokes: batch });
  }
});

/** Annotations belong to one share session: drop them when that person stops sharing or leaves. */
export function clearScreen(screen: string): void {
  if (screens.delete(screen)) changed();
}

onPeerLeft((peerId) => {
  clearScreen(peerId);
  for (const s of screens.values()) s.pointers.delete(peerId);
  changed();
});

onRoomLeft(() => {
  screens.clear();
  annotationTool.set('none');
  changed();
});

// ── Local actions ────────────────────────────────────────────────────────────

let lastPointerSent = 0;

export function movePointer(screen: string, x: number, y: number): void {
  const me = getLocalPeerId();
  screenState(screen).pointers.set(me, { x, y, at: Date.now(), color: colorFor(me), name: 'You' });
  changed();
  const now = Date.now();
  if (now - lastPointerSent < POINTER_INTERVAL_MS) return;
  lastPointerSent = now;
  broadcastData({ type: 'annot', screen, op: 'pointer', x: Math.round(x * 10000) / 10000, y: Math.round(y * 10000) / 10000 });
}

export function hidePointer(screen: string): void {
  screens.get(screen)?.pointers.delete(getLocalPeerId());
  changed();
  broadcastData({ type: 'annot', screen, op: 'pointer-off' });
}

export function startAnnotation(screen: string): StrokeSender {
  const me = getLocalPeerId();
  const sender = StrokeSender.start(newStrokeId(me), me, { color: colorFor(me), width: 0.004, tool: 'pen' }, (partial: Stroke) =>
    broadcastData({ type: 'annot', screen, op: 'stroke', stroke: { ...partial, author: undefined } })
  );
  screenState(screen).board.strokes.set(sender.stroke.id, sender.stroke);
  return sender;
}

export function addAnnotationPoint(sender: StrokeSender, x: number, y: number): void {
  sender.add(x, y);
  changed();
}

export function finishAnnotation(screen: string, sender: StrokeSender): void {
  sender.finish();
  const board = screens.get(screen)?.board;
  // Count it only if it's still there (someone may have erased it while it was drawn).
  if (board && board.strokes.get(sender.stroke.id) === sender.stroke) {
    if (sender.stroke.points.length === 0) board.strokes.delete(sender.stroke.id);
    else board.pointCount += sender.stroke.points.length / 2;
  }
  changed();
}

export function undoAnnotation(screen: string): void {
  const state = screens.get(screen);
  const last = state && lastStrokeBy(state.board, getLocalPeerId());
  if (!state || !last) return;
  removeStrokes(state.board, [last.id]);
  broadcastData({ type: 'annot', screen, op: 'remove', ids: [last.id] });
  changed();
}

export function clearAnnotations(screen: string): void {
  const state = screens.get(screen);
  const ids = state ? clearBoard(state.board) : [];
  broadcastData({ type: 'annot', screen, op: 'clear', ids: ids.slice(0, 5000) });
  changed();
}
