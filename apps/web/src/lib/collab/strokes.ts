// Shared drawing model used by the whiteboard and screen-share annotations.
// Pure logic (no DOM, no Svelte) so it can be unit-tested and kept in sync across peers.
//
// Two coordinate spaces share this model:
// - NORMALIZED (screen-share annotations): points are normalized to the shared video (0..1 on both
//   axes) and sent quantized as integers 0..SCALE, so marks land on the same spot on every screen.
//   `width` is a fraction of the surface width.
// - WORLD (whiteboard): an unbounded canvas in integer world units (1 unit = 1 CSS pixel at 100%
//   zoom), clamped to ±WORLD_LIMIT. `width` is in world units. Each participant pans and zooms
//   their own view; the data is the same for everyone.
//
// Everything received from a peer goes through `sanitizeStroke` / `sanitizeTextUpdate` with the
// right space before touching a board, and every board enforces count/size budgets.

import { cleanText, MAX_TEXT_LENGTH } from './richtext.js';

export { MAX_TEXT_LENGTH };

export const SCALE = 10000;
/** World coordinates are clamped to ±WORLD_LIMIT (integers). */
export const WORLD_LIMIT = 1_000_000;

export type Tool = 'pen' | 'highlighter';

export interface Stroke {
  id: string;
  author: string;
  color: string;
  /** Line width (fraction of surface width in NORMALIZED space, world units in WORLD space). For text: font size. */
  width: number;
  tool: Tool;
  /** Flat list of quantized points: [x0, y0, x1, y1, ...]. */
  points: number[];
  done: boolean;
  /**
   * Text box instead of a line (WORLD space only): top-left corner at points[0..1], `width` is the
   * font size, `boxWidth` the wrap width. The text uses markdown-like markers (see richtext.ts).
   */
  text?: string;
  boxWidth?: number;
  /** Text boxes: version for last-writer-wins edits (anyone may edit a text box). */
  v?: number;
  /** Text boxes: who made the current version (tiebreak when versions are equal). */
  editor?: string;
}

export interface CoordSpace {
  name: 'normalized' | 'world';
  min: number;
  max: number;
  /** Accepted line widths (exclusive min, inclusive max); anything else becomes defaultWidth. */
  minWidth: number;
  maxWidth: number;
  defaultWidth: number;
  /** Multiply a width by this to get it in quantized coordinate units. */
  widthToUnits: number;
  allowText: boolean;
  defaultColor: string;
}

export const NORMALIZED: CoordSpace = {
  name: 'normalized',
  min: 0,
  max: SCALE,
  minWidth: 0,
  maxWidth: 0.1,
  defaultWidth: 0.004,
  widthToUnits: SCALE,
  allowText: false,
  defaultColor: '#ffffff',
};

export const WORLD: CoordSpace = {
  name: 'world',
  min: -WORLD_LIMIT,
  max: WORLD_LIMIT,
  minWidth: 0.1,
  maxWidth: 200,
  defaultWidth: 4,
  widthToUnits: 1,
  allowText: true,
  defaultColor: '#111827',
};

/** Text box limits (WORLD units). */
export const TEXT_MIN_SIZE = 6;
export const TEXT_MAX_SIZE = 400;
export const TEXT_DEFAULT_SIZE = 20;
export const BOX_MIN_WIDTH = 40;
export const BOX_MAX_WIDTH = 4000;
export const BOX_DEFAULT_WIDTH = 320;
/** Versions above this are rejected, and one update can't jump further than MAX_VERSION_JUMP. */
export const MAX_VERSION = 1_000_000_000;
export const MAX_VERSION_JUMP = 10_000;

export interface Board {
  strokes: Map<string, Stroke>;
  /** Ids that were erased/cleared — remembered so late sync messages can't resurrect them. */
  removed: Set<string>;
  /** Total points across all strokes (bounded, so a peer can't exhaust memory). */
  pointCount: number;
  /** Total characters across all text boxes (bounded too). */
  textChars: number;
}

/** Limits per board: anything beyond is ignored (protects every participant's tab). */
export const MAX_STROKES = 3000;
export const MAX_TOTAL_POINTS = 200_000;
export const MAX_TOTAL_TEXT = 400_000;
/** Points per stroke (flat array length is twice this). */
export const MAX_STROKE_POINTS = 10_000;
const MAX_TOMBSTONES = 20_000;
export const MAX_ID_LENGTH = 80;
const MAX_PEER_ID_LENGTH = 40;

export function emptyBoard(): Board {
  return { strokes: new Map(), removed: new Set(), pointCount: 0, textChars: 0 };
}

export function resetBoard(board: Board): void {
  board.strokes.clear();
  board.removed.clear();
  board.pointCount = 0;
  board.textChars = 0;
}

function hasRoom(board: Board, extraPoints: number, extraText: number, newStroke: boolean): boolean {
  return (
    board.pointCount + extraPoints <= MAX_TOTAL_POINTS &&
    board.textChars + extraText <= MAX_TOTAL_TEXT &&
    (!newStroke || board.strokes.size < MAX_STROKES)
  );
}

/** Can one more item with this many points / characters be added locally? */
export function canAdd(board: Board, points = 1, chars = 0): boolean {
  return hasRoom(board, points, chars, true);
}

/** Quantize a normalized coordinate (0..1) to 0..SCALE. */
export function quantize(v: number): number {
  return Math.round(Math.min(Math.max(v, 0), 1) * SCALE);
}

/** Quantize a world coordinate to an integer within ±WORLD_LIMIT. */
export function quantizeWorld(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.round(Math.min(Math.max(v, -WORLD_LIMIT), WORLD_LIMIT));
}

export function newStrokeId(author: string): string {
  return `${author}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 7)}`;
}

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function validId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_LENGTH;
}

function validPeer(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_PEER_ID_LENGTH;
}

/**
 * The author an item id belongs to (ids are "<author>:..." — see newStrokeId), or null.
 * Tying ids to authors means nobody can claim, extend or overwrite someone else's items.
 */
export function idAuthor(id: unknown): string | null {
  if (typeof id !== 'string') return null;
  const i = id.indexOf(':');
  const author = i > 0 ? id.slice(0, i) : '';
  return validPeer(author) ? author : null;
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(Math.max(Math.round(v), min), max);
}

function version(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_VERSION ? v : 0;
}

/** Validate and clamp a stroke received from a peer. Returns null if it's malformed. */
export function sanitizeStroke(raw: unknown, author: string, space: CoordSpace = NORMALIZED): Stroke | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (!validId(s.id) || idAuthor(s.id) !== author) return null;
  if (!Array.isArray(s.points) || s.points.length % 2 !== 0 || s.points.length > MAX_STROKE_POINTS * 2) return null;
  const points: number[] = [];
  for (const p of s.points) {
    if (typeof p !== 'number' || !Number.isFinite(p)) return null;
    points.push(Math.min(Math.max(Math.round(p), space.min), space.max));
  }
  const color = typeof s.color === 'string' && COLOR_RE.test(s.color) ? s.color : space.defaultColor;

  if (s.text !== undefined) {
    if (!space.allowText || points.length !== 2) return null;
    const text = cleanText(s.text);
    if (!text.trim()) return null;
    return {
      id: s.id,
      author,
      color,
      width: clampInt(s.width, TEXT_MIN_SIZE, TEXT_MAX_SIZE, TEXT_DEFAULT_SIZE),
      tool: 'pen',
      points,
      done: true,
      text,
      boxWidth: clampInt(s.boxWidth, BOX_MIN_WIDTH, BOX_MAX_WIDTH, BOX_DEFAULT_WIDTH),
      v: version(s.v),
      editor: validPeer(s.editor) ? s.editor : author,
    };
  }
  return {
    id: s.id,
    author,
    color,
    width:
      typeof s.width === 'number' && s.width > space.minWidth && s.width <= space.maxWidth ? s.width : space.defaultWidth,
    tool: s.tool === 'highlighter' ? 'highlighter' : 'pen',
    points,
    done: s.done === true,
  };
}

/** Append points to a stroke (creating it on first sight). Ignores strokes that were removed. */
export function appendToStroke(board: Board, incoming: Stroke): void {
  if (board.removed.has(incoming.id)) return;
  const existing = board.strokes.get(incoming.id);
  if (!existing) {
    if (!hasRoom(board, incoming.points.length / 2, incoming.text?.length ?? 0, true)) return;
    board.strokes.set(incoming.id, { ...incoming, points: [...incoming.points] });
    board.pointCount += incoming.points.length / 2;
    board.textChars += incoming.text?.length ?? 0;
    return;
  }
  // Text boxes are created once and then changed only through text updates.
  if (incoming.text !== undefined || existing.text !== undefined) return;
  if (existing.author !== incoming.author) return; // only the author can extend their stroke
  if (
    existing.points.length + incoming.points.length <= MAX_STROKE_POINTS * 2 &&
    hasRoom(board, incoming.points.length / 2, 0, false)
  ) {
    existing.points.push(...incoming.points);
    board.pointCount += incoming.points.length / 2;
  }
  existing.done = existing.done || incoming.done;
}

/** Is version (v, editor) newer than the item's current one? Higher version wins, then editor id. */
export function isNewer(v: number, editor: string, item: Stroke): boolean {
  const cv = item.v ?? 0;
  const ce = item.editor ?? item.author;
  return v > cv || (v === cv && editor > ce);
}

/**
 * Full item from a sync message (someone bringing us up to date).
 * - Unknown items are added (within the board limits).
 * - Text boxes take the newer version, with the same version-jump cap as live edits.
 * - An existing drawing is only ever replaced by its own author sending a longer copy (someone
 *   relaying it can't change it), and it's updated in place so a stroke being drawn stays live.
 * Returns whether anything changed.
 */
export function mergeStroke(board: Board, incoming: Stroke, fromAuthor = false): boolean {
  if (board.removed.has(incoming.id)) return false;
  if (idAuthor(incoming.id) !== incoming.author) return false;
  const existing = board.strokes.get(incoming.id);
  if (existing && existing.author !== incoming.author) return false;
  if (existing && (existing.text === undefined) !== (incoming.text === undefined)) return false;
  if (existing?.text !== undefined) {
    return applyTextUpdate(board, {
      id: incoming.id,
      v: incoming.v ?? 0,
      editor: incoming.editor ?? incoming.author,
      text: incoming.text!,
      color: incoming.color,
      size: incoming.width,
      boxWidth: incoming.boxWidth ?? BOX_DEFAULT_WIDTH,
      x: incoming.points[0],
      y: incoming.points[1],
    });
  }
  if (existing) {
    if (!fromAuthor || incoming.points.length <= existing.points.length) return false;
    const extra = (incoming.points.length - existing.points.length) / 2;
    if (!hasRoom(board, extra, 0, false)) return false;
    existing.points.splice(0, existing.points.length, ...incoming.points);
    existing.done = existing.done || incoming.done;
    board.pointCount += extra;
    return true;
  }
  const extraText = incoming.text?.length ?? 0;
  if (!hasRoom(board, incoming.points.length / 2, extraText, true)) return false;
  board.strokes.set(incoming.id, { ...incoming, points: [...incoming.points] });
  board.pointCount += incoming.points.length / 2;
  board.textChars += extraText;
  return true;
}

// ── Text box edits (anyone in the call may edit any text box) ────────────────

export interface TextUpdate {
  id: string;
  v: number;
  editor: string;
  text: string;
  color: string;
  size: number;
  boxWidth: number;
  x: number;
  y: number;
}

/** Validate a text update from a peer. The editor is always the sender, never taken from the message. */
export function sanitizeTextUpdate(raw: unknown, editor: string): TextUpdate | null {
  if (!raw || typeof raw !== 'object' || !validPeer(editor)) return null;
  const u = raw as Record<string, unknown>;
  if (!validId(u.id)) return null;
  if (typeof u.v !== 'number' || !Number.isInteger(u.v) || u.v < 1 || u.v > MAX_VERSION) return null;
  if (typeof u.color !== 'string' || !COLOR_RE.test(u.color)) return null;
  if (typeof u.x !== 'number' || typeof u.y !== 'number' || !Number.isFinite(u.x) || !Number.isFinite(u.y)) return null;
  const text = cleanText(u.text);
  if (!text.trim()) return null;
  return {
    id: u.id,
    v: u.v,
    editor,
    text,
    color: u.color,
    size: clampInt(u.size, TEXT_MIN_SIZE, TEXT_MAX_SIZE, TEXT_DEFAULT_SIZE),
    boxWidth: clampInt(u.boxWidth, BOX_MIN_WIDTH, BOX_MAX_WIDTH, BOX_DEFAULT_WIDTH),
    x: quantizeWorld(u.x),
    y: quantizeWorld(u.y),
  };
}

/**
 * Apply a text edit if it's newer than what we have (last writer wins). Erased boxes stay erased,
 * unknown ids are ignored (an update can't create items), and the author never changes.
 * `limitJump` rejects absurd version jumps from live updates.
 */
export function applyTextUpdate(board: Board, u: TextUpdate, limitJump = true): boolean {
  if (board.removed.has(u.id)) return false;
  const existing = board.strokes.get(u.id);
  if (!existing || existing.text === undefined) return false;
  if (!isNewer(u.v, u.editor, existing)) return false;
  if (limitJump && u.v > (existing.v ?? 0) + MAX_VERSION_JUMP) return false;
  const delta = u.text.length - existing.text.length;
  if (delta > 0 && !hasRoom(board, 0, delta, false)) return false;
  board.strokes.set(u.id, {
    ...existing,
    text: u.text,
    color: u.color,
    width: u.size,
    boxWidth: u.boxWidth,
    points: [u.x, u.y],
    v: u.v,
    editor: u.editor,
  });
  board.textChars += delta;
  return true;
}

export function removeStrokes(board: Board, ids: Iterable<string>): void {
  for (const id of ids) {
    if (!validId(id)) continue;
    const stroke = board.strokes.get(id);
    if (stroke) {
      board.pointCount = Math.max(0, board.pointCount - stroke.points.length / 2);
      board.textChars = Math.max(0, board.textChars - (stroke.text?.length ?? 0));
      board.strokes.delete(id);
    }
    board.removed.add(id);
    if (board.removed.size > MAX_TOMBSTONES) board.removed.delete(board.removed.values().next().value!);
  }
}

export function clearBoard(board: Board): string[] {
  const ids = [...board.strokes.keys()];
  removeStrokes(board, ids);
  return ids;
}

/** Most recent stroke by this author (for undo). Strokes keep insertion order. */
export function lastStrokeBy(board: Board, author: string): Stroke | undefined {
  let last: Stroke | undefined;
  for (const s of board.strokes.values()) if (s.author === author) last = s;
  return last;
}

// ── Geometry ─────────────────────────────────────────────────────────────────

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Bounds of a text box (in its own units). Pass a real measurement from the renderer when available. */
export type TextBoundsFn = (s: Stroke) => Bounds;

/** Rough text box bounds without a canvas: ~0.55em per character, wrapped to the box width. */
export function estimateTextBounds(s: Stroke): Bounds {
  const size = s.width;
  const boxW = s.boxWidth ?? BOX_DEFAULT_WIDTH;
  const perLine = Math.max(1, Math.floor(boxW / (size * 0.55)));
  let lines = 0;
  let widest = 0;
  for (const l of (s.text ?? '').split('\n')) {
    lines += Math.max(1, Math.ceil(l.length / perLine));
    widest = Math.max(widest, Math.min(l.length * size * 0.55, boxW));
  }
  return {
    minX: s.points[0],
    minY: s.points[1],
    maxX: s.points[0] + Math.max(widest, size),
    maxY: s.points[1] + lines * size * 1.35,
  };
}

/** Bounds of a stroke in quantized units, including its line width. */
export function strokeBounds(s: Stroke, space: CoordSpace = WORLD, textBounds: TextBoundsFn = estimateTextBounds): Bounds {
  if (s.text !== undefined) return textBounds(s);
  const pts = s.points;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < pts.length; i += 2) {
    if (pts[i] < minX) minX = pts[i];
    if (pts[i] > maxX) maxX = pts[i];
    if (pts[i + 1] < minY) minY = pts[i + 1];
    if (pts[i + 1] > maxY) maxY = pts[i + 1];
  }
  const pad = (s.width * space.widthToUnits * (s.tool === 'highlighter' ? 3 : 1)) / 2;
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

const boundsCache = new WeakMap<Stroke, { len: number; b: Bounds }>();

/** strokeBounds for drawings, cached until the stroke gets more points. */
function cachedDrawingBounds(s: Stroke, space: CoordSpace): Bounds {
  const c = boundsCache.get(s);
  if (c && c.len === s.points.length) return c.b;
  const b = strokeBounds(s, space);
  boundsCache.set(s, { len: s.points.length, b });
  return b;
}

/** Largest area "fit" and exports cover, in world units (one stray far-off mark can't shrink everything). */
export const MAX_CONTENT_SPAN = 20_000;

/**
 * Bounds of the content that matters: if items are spread wider than MAX_CONTENT_SPAN, keep the
 * window of that size around the median item, so a single far-away mark doesn't make "fit" and
 * exports unreadably small.
 */
export function focusBounds(board: Board, textBounds: TextBoundsFn = estimateTextBounds): Bounds | null {
  const all = contentBounds(board, textBounds);
  if (!all || (all.maxX - all.minX <= MAX_CONTENT_SPAN && all.maxY - all.minY <= MAX_CONTENT_SPAN)) return all;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const s of board.strokes.values()) {
    if (s.points.length < 2) continue;
    const b = strokeBounds(s, WORLD, textBounds);
    xs.push((b.minX + b.maxX) / 2);
    ys.push((b.minY + b.maxY) / 2);
  }
  const median = (a: number[]) => a.sort((p, q) => p - q)[Math.floor(a.length / 2)];
  const half = MAX_CONTENT_SPAN / 2;
  const cx = median(xs);
  const cy = median(ys);
  const win = { minX: cx - half, minY: cy - half, maxX: cx + half, maxY: cy + half };
  let b: Bounds | null = null;
  for (const s of board.strokes.values()) {
    if (s.points.length < 2) continue;
    const sb = strokeBounds(s, WORLD, textBounds);
    if (sb.maxX < win.minX || sb.minX > win.maxX || sb.maxY < win.minY || sb.minY > win.maxY) continue;
    if (!b) b = { ...sb };
    else {
      b.minX = Math.min(b.minX, sb.minX);
      b.minY = Math.min(b.minY, sb.minY);
      b.maxX = Math.max(b.maxX, sb.maxX);
      b.maxY = Math.max(b.maxY, sb.maxY);
    }
  }
  if (!b) return win;
  return {
    minX: Math.max(b.minX, win.minX),
    minY: Math.max(b.minY, win.minY),
    maxX: Math.min(b.maxX, win.maxX),
    maxY: Math.min(b.maxY, win.maxY),
  };
}

/** Bounds of everything on the board, or null when it's empty. */
export function contentBounds(board: Board, textBounds: TextBoundsFn = estimateTextBounds): Bounds | null {
  let b: Bounds | null = null;
  for (const s of board.strokes.values()) {
    if (s.points.length < 2) continue;
    const sb = strokeBounds(s, WORLD, textBounds);
    if (!b) b = { ...sb };
    else {
      b.minX = Math.min(b.minX, sb.minX);
      b.minY = Math.min(b.minY, sb.minY);
      b.maxX = Math.max(b.maxX, sb.maxX);
      b.maxY = Math.max(b.maxY, sb.maxY);
    }
  }
  return b;
}

function distToSegmentSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len));
  const cx = ax + t * dx - px;
  const cy = ay + t * dy - py;
  return cx * cx + cy * cy;
}

/** Ids of items passing within radius `r` of (px, py), everything in quantized units. */
function hitTest(board: Board, px: number, py: number, r: number, space: CoordSpace, textBounds: TextBoundsFn): string[] {
  const hits: string[] = [];
  for (const s of board.strokes.values()) {
    if (s.text !== undefined) {
      const b = textBounds(s);
      if (px >= b.minX - r && px <= b.maxX + r && py >= b.minY - r && py <= b.maxY + r) hits.push(s.id);
      continue;
    }
    const bb = cachedDrawingBounds(s, space);
    if (px < bb.minX - r || px > bb.maxX + r || py < bb.minY - r || py > bb.maxY + r) continue;
    const rr = r + (s.width * space.widthToUnits * (s.tool === 'highlighter' ? 3 : 1)) / 2;
    const r2 = rr * rr;
    const pts = s.points;
    if (pts.length === 2) {
      if (distToSegmentSq(px, py, pts[0], pts[1], pts[0], pts[1]) <= r2) hits.push(s.id);
      continue;
    }
    for (let i = 0; i + 3 < pts.length; i += 2) {
      if (distToSegmentSq(px, py, pts[i], pts[i + 1], pts[i + 2], pts[i + 3]) <= r2) {
        hits.push(s.id);
        break;
      }
    }
  }
  return hits;
}

/** Ids of strokes passing within `radius` of (x, y), all in normalized units (0..1). */
export function strokesNear(board: Board, x: number, y: number, radius: number): string[] {
  return hitTest(board, x * SCALE, y * SCALE, radius * SCALE, NORMALIZED, estimateTextBounds);
}

/** Ids of items within `radius` of world point (x, y). */
export function itemsNearWorld(
  board: Board,
  x: number,
  y: number,
  radius: number,
  textBounds: TextBoundsFn = estimateTextBounds
): string[] {
  return hitTest(board, x, y, radius, WORLD, textBounds);
}

/** Topmost text box containing world point (x, y), with a small margin. */
export function textBoxAt(
  board: Board,
  x: number,
  y: number,
  margin = 4,
  textBounds: TextBoundsFn = estimateTextBounds
): Stroke | undefined {
  let found: Stroke | undefined;
  for (const s of board.strokes.values()) {
    if (s.text === undefined) continue;
    const b = textBounds(s);
    if (x >= b.minX - margin && x <= b.maxX + margin && y >= b.minY - margin && y <= b.maxY + margin) found = s;
  }
  return found;
}

/**
 * Text boxes in reading order: top-to-bottom, and left-to-right for boxes that start on roughly
 * the same row.
 */
export function readingOrder(items: Stroke[]): Stroke[] {
  const sorted = [...items].sort((a, b) => a.points[1] - b.points[1] || a.points[0] - b.points[0]);
  const rows: Stroke[][] = [];
  let rowTop = -Infinity;
  let tolerance = 0;
  for (const s of sorted) {
    if (rows.length && s.points[1] - rowTop <= tolerance) {
      rows[rows.length - 1].push(s);
    } else {
      rows.push([s]);
      rowTop = s.points[1];
      tolerance = Math.max(24, s.width);
    }
  }
  return rows.flatMap((row) => row.sort((a, b) => a.points[0] - b.points[0]));
}

/** Split strokes into batches whose JSON stays under maxBytes (data channel message size). */
export function batchStrokes(strokes: Stroke[], maxBytes = 48_000): Stroke[][] {
  const batches: Stroke[][] = [];
  let current: Stroke[] = [];
  let size = 0;
  for (const s of strokes) {
    const len = JSON.stringify(s).length;
    if (current.length > 0 && size + len > maxBytes) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(s);
    size += len;
  }
  if (current.length) batches.push(current);
  return batches;
}

/** Stable per-person color, so everyone sees the same color for the same participant. */
export const PALETTE = ['#f87171', '#fb923c', '#facc15', '#4ade80', '#22d3ee', '#60a5fa', '#a78bfa', '#f472b6'];

export function colorFor(peerId: string): string {
  let h = 0;
  for (let i = 0; i < peerId.length; i++) h = (h * 31 + peerId.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
