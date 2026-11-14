// Streams a stroke to peers while it's being drawn: points are buffered and flushed every
// FLUSH_MS so a stroke appears live on other screens without one message per mouse event.

import { MAX_STROKE_POINTS, quantize, type Stroke, type Tool } from './strokes.js';

const FLUSH_MS = 40;

export interface StrokeStyle {
  color: string;
  width: number;
  tool: Tool;
}

export class StrokeSender {
  private pending: number[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sentAny = false;

  constructor(
    readonly stroke: Stroke,
    /** Sends a partial stroke (only the new points) to peers. */
    private readonly send: (partial: Stroke) => void,
    /** Maps a coordinate to the stroke's quantized space (normalized 0..1 by default, or world). */
    private readonly quant: (v: number) => number = quantize
  ) {}

  static start(
    id: string,
    author: string,
    style: StrokeStyle,
    send: (partial: Stroke) => void,
    quant: (v: number) => number = quantize
  ): StrokeSender {
    return new StrokeSender({ id, author, ...style, points: [], done: false }, send, quant);
  }

  /** Add a point (normalized surface coordinates 0..1, or world units). Returns the quantized pair. */
  add(x: number, y: number): [number, number] {
    if (this.stroke.points.length >= MAX_STROKE_POINTS * 2) return [0, 0]; // per-stroke cap (matches receivers)
    const qx = this.quant(x);
    const qy = this.quant(y);
    const pts = this.stroke.points;
    // Skip points that haven't moved (keeps messages small).
    if (pts.length >= 2 && pts[pts.length - 2] === qx && pts[pts.length - 1] === qy) return [qx, qy];
    pts.push(qx, qy);
    this.pending.push(qx, qy);
    if (!this.timer) this.timer = setTimeout(() => this.flush(false), FLUSH_MS);
    return [qx, qy];
  }

  /** Stop without sending anything else (the caller removes the stroke). */
  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = [];
    this.stroke.done = true;
  }

  /** Has any part of this stroke been sent to peers yet? */
  get sent(): boolean {
    return this.sentAny;
  }

  finish(): void {
    this.stroke.done = true;
    this.flush(true);
  }

  private flush(done: boolean): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.pending.length === 0 && !done) return;
    if (this.pending.length === 0 && done && !this.sentAny) return; // nothing was drawn
    this.send({ ...this.stroke, points: this.pending, done });
    this.sentAny = true;
    this.pending = [];
  }
}
