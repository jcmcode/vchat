// How big each person's camera is shown here, so they can send it no bigger than that (each
// connection in a mesh has its own encoder: see quality.ts cameraForViewer). Tiles that show a
// person's camera register with the `cameraView` action; view-report.ts tells each person.
//
// The tile is measured, not the <video>: the video element is hidden while a camera is off, and the
// tile is what the picture fills when it's on. Sizes are in device pixels (a 2x screen needs twice
// the lines). A tile in a hidden tab counts as not shown; one in a Document Picture-in-Picture
// window counts while that window is open (it has its own document, which stays visible).

export type Fit = 'cover' | 'contain';

export interface CameraViewParams {
  peerId: string;
  /** How the picture fills the tile (`object-fit`). */
  fit: Fit;
  /** False while the tile shows something else (their shared screen). */
  enabled?: boolean;
}

export interface Box {
  w: number;
  h: number;
  fit: Fit;
}

/** What a peer is told: `{w, h, fit}`, or `{w: 0, h: 0}` when their camera isn't shown at all. */
export interface ViewReport {
  w: number;
  h: number;
  fit?: Fit;
}

/** Sizes are rounded up to this many device pixels, so small layout shifts don't send anything. */
export const VIEW_QUANTUM = 32;
const MAX_SIDE = 16_384;

export interface Measured extends CameraViewParams {
  w: number;
  h: number;
  visible: boolean;
}

/** The biggest shown box per person (by area). Pure. */
export function largestBoxes(entries: Iterable<Measured>): Map<string, Box> {
  const out = new Map<string, Box>();
  for (const e of entries) {
    if (e.enabled === false || !e.visible || !(e.w > 0) || !(e.h > 0)) continue;
    const best = out.get(e.peerId);
    if (!best || e.w * e.h > best.w * best.h) out.set(e.peerId, { w: e.w, h: e.h, fit: e.fit });
  }
  return out;
}

/** The report for one person: quantized, or "not shown". Pure. */
export function viewReport(box: Box | undefined): ViewReport {
  if (!box) return { w: 0, h: 0 };
  const q = (v: number) => Math.min(MAX_SIDE, Math.max(VIEW_QUANTUM, Math.ceil(v / VIEW_QUANTUM) * VIEW_QUANTUM));
  return { w: q(box.w), h: q(box.h), fit: box.fit };
}

// ── Browser side ──────────────────────────────────────────────────────────────

const registered = new Map<HTMLElement, CameraViewParams>();
/** One ResizeObserver per window (the call page, and a Document Picture-in-Picture window). */
const observers = new WeakMap<Window, ResizeObserver>();
const listeners = new Set<() => void>();
let pending = false;

/** Called (batched) whenever a registered tile appears, goes, resizes, or the page is hidden/shown. */
export function onViewsChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed(): void {
  if (pending) return;
  pending = true;
  queueMicrotask(() => {
    pending = false;
    for (const fn of listeners) fn();
  });
}

function observerFor(win: Window): ResizeObserver | null {
  let ro = observers.get(win);
  if (!ro) {
    const RO = (win as Window & { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (!RO) return null;
    ro = new RO(changed);
    observers.set(win, ro);
  }
  return ro;
}

/** Svelte action: `use:cameraView={{ peerId, fit, enabled }}` on the element a person's camera fills. */
export function cameraView(el: HTMLElement, params: CameraViewParams) {
  const win = el.ownerDocument.defaultView;
  const ro = win ? observerFor(win) : null;
  registered.set(el, params);
  ro?.observe(el);
  changed();
  return {
    update(next: CameraViewParams) {
      registered.set(el, next);
      changed();
    },
    destroy() {
      registered.delete(el);
      ro?.unobserve(el);
      changed();
    },
  };
}

/** Measure every registered tile now. */
export function measureViews(): Map<string, Box> {
  const measured: Measured[] = [];
  for (const [el, params] of registered) {
    const doc = el.ownerDocument;
    const dpr = doc.defaultView?.devicePixelRatio || 1;
    measured.push({
      ...params,
      w: el.clientWidth * dpr,
      h: el.clientHeight * dpr,
      visible: el.isConnected && doc.visibilityState !== 'hidden',
    });
  }
  return largestBoxes(measured);
}

if (typeof document !== 'undefined') document.addEventListener('visibilitychange', changed);
