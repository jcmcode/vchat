// Page geometry for the shared Document: A4 sheets stacked top to bottom in world coordinates.
// A4 is 210 × 297 mm; at 96 world units per inch that's 794 × 1123 (what a browser prints at 100%).

import type { Bounds } from './strokes.js';

export const PAGE_W = 794;
export const PAGE_H = 1123;
/** Space between pages on screen (not part of any page). */
export const PAGE_GAP = 32;
/** Default text margin (about 20 mm). */
export const PAGE_MARGIN = 76;
/** A document never grows past this many pages. */
export const MAX_PAGES = 50;

const STRIDE = PAGE_H + PAGE_GAP;

/** Top edge (world y) of page `i` (0-based). */
export function pageTop(i: number): number {
  return i * STRIDE;
}

/** Index of the page containing world point (x, y), or -1 when it's on the desk between/around pages. */
export function pageAt(x: number, y: number, pages: number): number {
  if (x < 0 || x > PAGE_W || y < 0) return -1;
  const i = Math.floor(y / STRIDE);
  if (i >= pages || y - pageTop(i) > PAGE_H) return -1;
  return i;
}

/** Pages needed to show content reaching down to `bounds.maxY` (at least 1). */
export function pagesForContent(bounds: Bounds | null): number {
  if (!bounds || bounds.maxY <= 0) return 1;
  return Math.min(MAX_PAGES, Math.max(1, Math.floor(bounds.maxY / STRIDE) + 1));
}

/** Total height of `pages` stacked pages (gaps included, no trailing gap). */
export function documentHeight(pages: number): number {
  return pages * STRIDE - PAGE_GAP;
}
