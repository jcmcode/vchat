// Shared whiteboard: an infinite canvas everyone in the call can open and draw on together.
// Everything travels over the peer-to-peer data channels (end-to-end encrypted); the server never
// sees the board. Late joiners receive the current board from peers already in the call.
//
// The drawing data lives in shared WORLD coordinates (see strokes.ts). Each participant pans and
// zooms their own view; views are never synced.

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
} from '../webrtc/mesh.js';
import { measuredTextBounds } from './render.js';
import { cleanText } from './richtext.js';
import { StrokeSender, type StrokeStyle } from './stroke-sender.js';
import {
  BOX_DEFAULT_WIDTH,
  BOX_MAX_WIDTH,
  BOX_MIN_WIDTH,
  TEXT_DEFAULT_SIZE,
  TEXT_MAX_SIZE,
  TEXT_MIN_SIZE,
  MAX_VERSION,
  WORLD,
  appendToStroke,
  applyTextUpdate,
  batchStrokes,
  canAdd,
  clearBoard,
  emptyBoard,
  idAuthor,
  itemsNearWorld,
  lastStrokeBy,
  MAX_ID_LENGTH,
  mergeStroke,
  newStrokeId,
  quantizeWorld,
  removeStrokes,
  resetBoard,
  sanitizeStroke,
  sanitizeTextUpdate,
  textBoxAt,
  type Board,
  type Stroke,
  type TextUpdate,
} from './strokes.js';

export const board: Board = emptyBoard();
/** Bumped on every change so components know to redraw. */
export const boardVersion = writable(0);
export const whiteboardOpen = writable(false);
/** Someone else opened the whiteboard (shown as an invitation to open it too). */
export const whiteboardNotice = writable<{ name: string } | null>(null);
/** Short local status message (e.g. "the board is full"). */
export const boardStatus = writable('');

/** Your own pan/zoom, kept while the whiteboard is closed and reopened during a call. */
export const savedView: { cam: { x: number; y: number; zoom: number } | null } = { cam: null };

const MAX_REMOVE = 2000;
/**
 * Erasures one participant may hand us through `sync` for strokes we don't have, per call. Plenty
 * for any real board (a newcomer learns what was erased before they arrived), but it can't push
 * out the deletions everyone else made (strokes.ts remembers 20,000) so erased strokes come back.
 */
const MAX_SYNC_TOMBSTONES_PER_PEER = 2000;
const syncTombstones = new Map<string, number>();
/** A peer may ask for the whole board at most this often (each answer can be large). */
const SYNC_REQ_INTERVAL_MS = 5000;
const lastSyncReq = new Map<string, number>();

/** Text edits per peer: a small token bucket on top of the data channel's own rate limit. */
const UPDATE_BURST = 30;
const UPDATE_PER_SECOND = 15;
const updateBuckets = new Map<string, { tokens: number; at: number }>();

function allowUpdate(peerId: string): boolean {
  const now = Date.now();
  const b = updateBuckets.get(peerId) ?? { tokens: UPDATE_BURST, at: now };
  b.tokens = Math.min(UPDATE_BURST, b.tokens + ((now - b.at) / 1000) * UPDATE_PER_SECOND);
  b.at = now;
  updateBuckets.set(peerId, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

/**
 * Items accepted from one peer's sync messages: enough for a full board when someone joins, but a
 * peer can't use sync to keep re-sending (and making everyone re-layout) the whole board.
 */
const SYNC_BURST = 4000;
const SYNC_PER_SECOND = 50;
const syncBuckets = new Map<string, { tokens: number; at: number }>();

function takeSyncTokens(peerId: string, wanted: number): number {
  const now = Date.now();
  const b = syncBuckets.get(peerId) ?? { tokens: SYNC_BURST, at: now };
  b.tokens = Math.min(SYNC_BURST, b.tokens + ((now - b.at) / 1000) * SYNC_PER_SECOND);
  b.at = now;
  syncBuckets.set(peerId, b);
  const granted = Math.max(0, Math.min(Math.floor(b.tokens), wanted));
  b.tokens -= granted;
  return granted;
}

/** Only ids that are on the board (fake ids could otherwise push real ones out of the tombstones). */
function presentIds(ids: unknown, max: number): string[] {
  if (!Array.isArray(ids)) return [];
  return ids.slice(0, max).filter((id): id is string => typeof id === 'string' && board.strokes.has(id));
}

function changed(): void {
  boardVersion.update((v) => v + 1);
}

let statusTimer: ReturnType<typeof setTimeout> | null = null;
function setStatus(msg: string): void {
  boardStatus.set(msg);
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => boardStatus.set(''), 4000);
}

// ── Incoming ─────────────────────────────────────────────────────────────────

registerDataHandler('wb', (fromPeerId, msg) => {
  switch (msg.op) {
    case 'stroke': {
      const stroke = sanitizeStroke(msg.stroke, fromPeerId, WORLD);
      if (stroke) {
        // A new text box starts at version 0, made by its author.
        if (stroke.text !== undefined) Object.assign(stroke, { v: 0, editor: fromPeerId });
        appendToStroke(board, stroke);
        changed();
      }
      break;
    }
    case 'update': {
      if (!allowUpdate(fromPeerId)) break;
      const u = sanitizeTextUpdate(msg.item, fromPeerId);
      if (u && applyTextUpdate(board, u)) changed();
      break;
    }
    case 'remove': {
      const ids = presentIds(msg.ids, MAX_REMOVE);
      if (ids.length) {
        removeStrokes(board, ids);
        changed();
      }
      break;
    }
    case 'clear': {
      // Remove exactly what the sender cleared, so strokes drawn at the same moment survive
      // everywhere (instead of on some screens only).
      const ids = presentIds(msg.ids, MAX_REMOVE * 5);
      if (ids.length) {
        removeStrokes(board, ids);
        changed();
      }
      break;
    }
    case 'sync-req': {
      const now = Date.now();
      if (now - (lastSyncReq.get(fromPeerId) ?? 0) < SYNC_REQ_INTERVAL_MS) break;
      lastSyncReq.set(fromPeerId, now);
      sendSync(fromPeerId);
      break;
    }
    case 'sync': {
      const strokes = Array.isArray(msg.strokes) ? msg.strokes.slice(0, 2000) : [];
      const removed = Array.isArray(msg.removed) ? msg.removed.slice(0, MAX_REMOVE) : [];
      // Each item costs a token; whatever is over this peer's budget is ignored.
      let budget = takeSyncTokens(fromPeerId, strokes.length + Math.ceil(removed.length / 10));
      let dirty = false;
      if (removed.length && budget > 0) {
        const n = Math.min(removed.length, budget * 10);
        let used = syncTombstones.get(fromPeerId) ?? 0;
        const ids = removed.slice(0, n).filter((id: unknown): id is string => {
          if (typeof id !== 'string' || id.length > MAX_ID_LENGTH) return false;
          if (board.strokes.has(id) || board.removed.has(id)) return true; // nothing new to remember
          if (used >= MAX_SYNC_TOMBSTONES_PER_PEER) return false;
          used++;
          return true;
        });
        syncTombstones.set(fromPeerId, used);
        removeStrokes(board, ids);
        budget -= Math.ceil(n / 10);
        dirty = true;
      }
      for (const raw of strokes) {
        if (budget-- <= 0) break;
        // The author is whoever the id belongs to — never what the message claims.
        const author = idAuthor((raw as { id?: unknown } | null)?.id);
        if (!author) continue;
        const stroke = sanitizeStroke(raw, author, WORLD);
        if (stroke && mergeStroke(board, { ...stroke, done: true }, author === fromPeerId)) dirty = true;
      }
      if (dirty) changed();
      break;
    }
    case 'opened':
      if (!get(whiteboardOpen)) whiteboardNotice.set({ name: peerDisplayName(fromPeerId) });
      break;
  }
});

function sendSync(peerId: string): void {
  if (board.strokes.size === 0 && board.removed.size === 0) return;
  // Strokes still being drawn are sent as they are; the rest streams in live.
  const strokes = [...board.strokes.values()];
  const removed = [...board.removed].slice(-MAX_REMOVE);
  const batches = batchStrokes(strokes);
  if (batches.length === 0) batches.push([]);
  batches.forEach((batch, i) => sendData(peerId, { type: 'wb', op: 'sync', strokes: batch, ...(i === 0 ? { removed } : {}) }));
}

// Bring newcomers up to date even if they haven't opened the board yet.
onPeerConnected((peerId) => sendSync(peerId));

onPeerLeft((peerId) => {
  lastSyncReq.delete(peerId);
  updateBuckets.delete(peerId);
  syncBuckets.delete(peerId);
});

onRoomLeft(() => {
  resetBoard(board);
  lastSyncReq.clear();
  updateBuckets.clear();
  syncBuckets.clear();
  syncTombstones.clear();
  savedView.cam = null;
  whiteboardOpen.set(false);
  whiteboardNotice.set(null);
  changed();
});

// ── Local actions ────────────────────────────────────────────────────────────

export function openWhiteboard(): void {
  whiteboardOpen.set(true);
  whiteboardNotice.set(null);
  broadcastData({ type: 'wb', op: 'opened' });
  broadcastData({ type: 'wb', op: 'sync-req' });
}

export function closeWhiteboard(): void {
  whiteboardOpen.set(false);
}

function boardFull(): void {
  setStatus('The board is full. Erase or clear something to keep drawing.');
}

/** Start a stroke at world coordinates. Returns null when the board is full. */
export function startStroke(style: StrokeStyle): StrokeSender | null {
  if (!canAdd(board, 1)) {
    boardFull();
    return null;
  }
  const author = getLocalPeerId();
  const sender = StrokeSender.start(
    newStrokeId(author),
    author,
    style,
    (partial: Stroke) => broadcastData({ type: 'wb', op: 'stroke', stroke: { ...partial, author: undefined } }),
    quantizeWorld
  );
  board.strokes.set(sender.stroke.id, sender.stroke); // drawn locally right away
  return sender;
}

export function addPoint(sender: StrokeSender, x: number, y: number): void {
  sender.add(x, y);
  changed();
}

export function finishStroke(sender: StrokeSender): void {
  sender.finish();
  // Count it only if it's still on the board (someone may have erased it while it was drawn).
  if (board.strokes.get(sender.stroke.id) !== sender.stroke) return changed();
  if (sender.stroke.points.length === 0) board.strokes.delete(sender.stroke.id);
  else board.pointCount += sender.stroke.points.length / 2;
  changed();
}

/** Throw away a stroke that just started (e.g. a second finger turned it into a pinch). */
export function cancelStroke(sender: StrokeSender): void {
  const wasSent = sender.sent;
  sender.cancel();
  board.strokes.delete(sender.stroke.id);
  if (wasSent) {
    removeStrokes(board, [sender.stroke.id]);
    broadcastData({ type: 'wb', op: 'remove', ids: [sender.stroke.id] });
  }
  changed();
}

export interface TextFields {
  text: string;
  color: string;
  size: number;
  boxWidth: number;
  x: number;
  y: number;
}

function normalizeFields(f: TextFields): TextFields {
  const clamp = (v: number, min: number, max: number, d: number) =>
    Number.isFinite(v) ? Math.min(Math.max(Math.round(v), min), max) : d;
  return {
    text: cleanText(f.text),
    color: /^#[0-9a-fA-F]{6}$/.test(f.color) ? f.color : WORLD.defaultColor,
    size: clamp(f.size, TEXT_MIN_SIZE, TEXT_MAX_SIZE, TEXT_DEFAULT_SIZE),
    boxWidth: clamp(f.boxWidth, BOX_MIN_WIDTH, BOX_MAX_WIDTH, BOX_DEFAULT_WIDTH),
    x: quantizeWorld(f.x),
    y: quantizeWorld(f.y),
  };
}

/** Create a text box with the given id. Returns false if the text is empty or the board is full. */
export function createText(id: string, fields: TextFields): boolean {
  const f = normalizeFields(fields);
  if (!f.text.trim() || board.strokes.has(id) || board.removed.has(id)) return false;
  if (!canAdd(board, 1, f.text.length)) {
    boardFull();
    return false;
  }
  const author = getLocalPeerId();
  const item: Stroke = {
    id,
    author,
    color: f.color,
    width: f.size,
    tool: 'pen',
    points: [f.x, f.y],
    done: true,
    text: f.text,
    boxWidth: f.boxWidth,
    v: 0,
    editor: author,
  };
  appendToStroke(board, item);
  if (!board.strokes.has(id)) return false;
  broadcastData({ type: 'wb', op: 'stroke', stroke: { ...item, author: undefined, editor: undefined, v: undefined } });
  changed();
  return true;
}

/**
 * Save an edit to an existing text box (anyone's): bumps its version and broadcasts the whole
 * box state. Returns false if nothing changed, the box is gone, or the edit was rejected.
 */
export function saveText(id: string, fields: TextFields): boolean {
  const existing = board.strokes.get(id);
  if (!existing || existing.text === undefined) return false;
  const f = normalizeFields(fields);
  if (!f.text.trim()) return false;
  if (
    existing.text === f.text &&
    existing.color === f.color &&
    existing.width === f.size &&
    existing.boxWidth === f.boxWidth &&
    existing.points[0] === f.x &&
    existing.points[1] === f.y
  ) {
    return false;
  }
  if ((existing.v ?? 0) >= MAX_VERSION) {
    setStatus("This text box can't be edited any more.");
    return false;
  }
  const update: TextUpdate = { id, v: (existing.v ?? 0) + 1, editor: getLocalPeerId(), ...f };
  if (!applyTextUpdate(board, update)) {
    boardFull();
    return false;
  }
  broadcastData({ type: 'wb', op: 'update', item: { ...update, editor: undefined } });
  changed();
  return true;
}

/** Remove items (by id) for everyone. */
export function removeItems(ids: string[]): void {
  const present = ids.filter((id) => board.strokes.has(id));
  if (present.length === 0) return;
  removeStrokes(board, present);
  for (let i = 0; i < present.length; i += MAX_REMOVE) {
    broadcastData({ type: 'wb', op: 'remove', ids: present.slice(i, i + MAX_REMOVE) });
  }
  changed();
}

/** Erase any strokes or text boxes within `radius` of world point (x, y). */
export function eraseAt(x: number, y: number, radius: number): void {
  const ids = itemsNearWorld(board, x, y, radius, measuredTextBounds);
  if (ids.length === 0) return;
  removeItems(ids);
}

/** Topmost text box under a world point. */
export function textAt(x: number, y: number, margin = 4): Stroke | undefined {
  return textBoxAt(board, x, y, margin, measuredTextBounds);
}

/** Undo your own most recent stroke or text box. */
export function undoLast(): void {
  const last = lastStrokeBy(board, getLocalPeerId());
  if (!last) return;
  removeItems([last.id]);
}

export function clearAll(): void {
  const ids = clearBoard(board);
  for (let i = 0; i < ids.length; i += MAX_REMOVE * 5) {
    broadcastData({ type: 'wb', op: 'clear', ids: ids.slice(i, i + MAX_REMOVE * 5) });
  }
  changed();
}

export function hasOwnStrokes(): boolean {
  return !!lastStrokeBy(board, getLocalPeerId());
}

export function localPeerId(): string {
  return getLocalPeerId();
}
