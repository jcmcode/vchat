// Canvas rendering for strokes and text boxes (whiteboard + annotations).

import { FONT_STACK, LINE_HEIGHT, fontFor, layoutRichText, parseRichText, type TextLayout } from './richtext.js';
import { BOX_DEFAULT_WIDTH, SCALE, WORLD, strokeBounds, type Bounds, type Stroke } from './strokes.js';

export { FONT_STACK };

/** Where a normalized (0..1) drawing surface sits inside a canvas, in CSS pixels. */
export interface SurfaceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Mapping from quantized stroke coordinates to canvas pixels:
 * screenX = ox + v * sx, screenY = oy + v * sy, line width in pixels = width * ws.
 */
export interface View {
  ox: number;
  oy: number;
  sx: number;
  sy: number;
  ws: number;
}

/** View for a normalized surface (annotations): quantized 0..SCALE fills the rect. */
export function rectView(rect: SurfaceRect): View {
  return { ox: rect.x, oy: rect.y, sx: rect.width / SCALE, sy: rect.height / SCALE, ws: rect.width };
}

/** View for the world canvas: camera top-left at (camX, camY), `zoom` pixels per world unit. */
export function worldView(camX: number, camY: number, zoom: number): View {
  return { ox: -camX * zoom, oy: -camY * zoom, sx: zoom, sy: zoom, ws: zoom };
}

function toView(target: SurfaceRect | View): View {
  return 'sx' in target ? target : rectView(target);
}

/** Fit a surface of the given aspect ratio (w/h) centered inside a box (letterboxed). */
export function fitRect(boxWidth: number, boxHeight: number, aspect: number): SurfaceRect {
  if (boxWidth <= 0 || boxHeight <= 0 || !Number.isFinite(aspect) || aspect <= 0) {
    return { x: 0, y: 0, width: boxWidth, height: boxHeight };
  }
  let width = boxWidth;
  let height = boxWidth / aspect;
  if (height > boxHeight) {
    height = boxHeight;
    width = boxHeight * aspect;
  }
  return { x: (boxWidth - width) / 2, y: (boxHeight - height) / 2, width, height };
}

/** Size a canvas for crisp drawing on high-DPI screens and return its 2D context. */
export function prepareCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

// ── Text layout (cached per text box) ────────────────────────────────────────

let measureCtx: CanvasRenderingContext2D | null = null;
let lastFont = '';

function measure(text: string, size: number, bold: boolean, italic: boolean): number {
  if (!measureCtx) {
    measureCtx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
  }
  if (!measureCtx) return text.length * size * 0.55;
  const font = fontFor(size, bold, italic);
  if (font !== lastFont) {
    measureCtx.font = font;
    lastFont = font;
  }
  return measureCtx.measureText(text).width;
}

const layoutCache = new WeakMap<Stroke, { key: string; layout: TextLayout }>();

/** Word-wrapped layout of a text box, in its own (world) units. */
export function textLayout(stroke: Stroke): TextLayout {
  const text = stroke.text ?? '';
  const boxW = stroke.boxWidth ?? BOX_DEFAULT_WIDTH;
  const key = `${stroke.width}|${boxW}|${text}`;
  const cached = layoutCache.get(stroke);
  if (cached && cached.key === key) return cached.layout;
  const layout = layoutRichText(parseRichText(text), stroke.width, boxW, measure);
  layoutCache.set(stroke, { key, layout });
  return layout;
}

/** Measured bounds of a text box (world units). */
export function measuredTextBounds(stroke: Stroke): Bounds {
  const l = textLayout(stroke);
  const x = stroke.points[0];
  const y = stroke.points[1];
  return { minX: x, minY: y, maxX: x + Math.max(l.width, stroke.width), maxY: y + l.height };
}

const boundsCache = new WeakMap<Stroke, { n: number; w: number; b: Bounds }>();

/** World bounds of a whiteboard item (cached; strokes being drawn are re-measured as they grow). */
export function itemBounds(stroke: Stroke): Bounds {
  if (stroke.text !== undefined) return measuredTextBounds(stroke);
  const cached = boundsCache.get(stroke);
  if (cached && cached.n === stroke.points.length && cached.w === stroke.width) return cached.b;
  const b = strokeBounds(stroke, WORLD);
  boundsCache.set(stroke, { n: stroke.points.length, w: stroke.width, b });
  return b;
}

function drawText(ctx: CanvasRenderingContext2D, stroke: Stroke, view: View, alpha: number): void {
  const layout = textLayout(stroke);
  const size = stroke.width;
  const scale = view.ws;
  if (size * scale < 1.5) {
    // Too small to read: draw grey bars in place of the lines (much cheaper, same look).
    ctx.save();
    ctx.globalAlpha = alpha * 0.35;
    ctx.fillStyle = stroke.color;
    for (const line of layout.lines) {
      const last = line.segments[line.segments.length - 1];
      if (!last) continue;
      const w = last.x + last.width;
      ctx.fillRect(view.ox + stroke.points[0] * view.sx, view.oy + (stroke.points[1] + line.y + size * 0.3) * view.sy, w * scale, size * 0.6 * scale);
    }
    ctx.restore();
    return;
  }
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(view.ox + stroke.points[0] * view.sx, view.oy + stroke.points[1] * view.sy);
  ctx.scale(scale, scale);
  ctx.fillStyle = stroke.color;
  // Center each line in its line box, like CSS line-height does in the editor.
  ctx.textBaseline = 'middle';
  const mid = (size * LINE_HEIGHT) / 2;
  for (const line of layout.lines) {
    const by = line.y + mid;
    if (line.marker) {
      ctx.font = fontFor(size, false, false);
      ctx.fillText(line.marker.text, line.marker.x, by);
    }
    for (const seg of line.segments) {
      ctx.font = fontFor(size, seg.b, seg.i);
      ctx.fillText(seg.text, seg.x, by);
      if (seg.u && seg.text.trim()) {
        ctx.fillRect(seg.x, by + size * 0.45, seg.width, Math.max(size / 14, 1 / scale));
      }
    }
  }
  ctx.restore();
}

/** Draw one stroke with smoothed (quadratic) segments, or a text box. */
export function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke, target: SurfaceRect | View, alpha = 1): void {
  const pts = stroke.points;
  if (pts.length < 2) return;
  const view = toView(target);
  if (stroke.text !== undefined) {
    drawText(ctx, stroke, view, alpha);
    return;
  }
  const sx = (v: number) => view.ox + v * view.sx;
  const sy = (v: number) => view.oy + v * view.sy;
  const width = Math.max(stroke.width * view.ws, 0.75);

  ctx.save();
  ctx.globalAlpha = alpha * (stroke.tool === 'highlighter' ? 0.35 : 1);
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = stroke.tool === 'highlighter' ? width * 3 : width;

  if (pts.length === 2) {
    ctx.beginPath();
    ctx.arc(sx(pts[0]), sy(pts[1]), ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  // Screen positions, skipping points less than a pixel from the last one kept: a dense stroke
  // (or one seen zoomed out) costs about as much as it covers on screen.
  const xy: number[] = [sx(pts[0]), sy(pts[1])];
  for (let i = 2; i + 1 < pts.length; i += 2) {
    const x = sx(pts[i]);
    const y = sy(pts[i + 1]);
    const last = i + 2 >= pts.length;
    if (!last && Math.abs(x - xy[xy.length - 2]) + Math.abs(y - xy[xy.length - 1]) < 1) continue;
    xy.push(x, y);
  }
  ctx.beginPath();
  ctx.moveTo(xy[0], xy[1]);
  for (let i = 2; i + 3 < xy.length; i += 2) {
    ctx.quadraticCurveTo(xy[i], xy[i + 1], (xy[i] + xy[i + 2]) / 2, (xy[i + 1] + xy[i + 3]) / 2);
  }
  ctx.lineTo(xy[xy.length - 2], xy[xy.length - 1]);
  ctx.stroke();
  ctx.restore();
}

/** A glowing laser-pointer dot with the person's name. */
export function drawPointer(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  label: string,
  alpha: number
): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.shadowColor = color;
  ctx.shadowBlur = 16;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(x, y, 2.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.font = '600 12px ui-sans-serif, system-ui, -apple-system, sans-serif';
  const padX = 6;
  const textWidth = ctx.measureText(label).width;
  const bx = x + 12;
  const by = y + 10;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect?.(bx, by, textWidth + padX * 2, 20, 6);
  if (!ctx.roundRect) ctx.rect(bx, by, textWidth + padX * 2, 20);
  ctx.fill();
  ctx.fillStyle = '#0b0b0f';
  ctx.fillText(label, bx + padX, by + 14);
  ctx.restore();
}
