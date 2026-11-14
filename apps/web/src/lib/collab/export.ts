// Export the whiteboard as PNG, PDF or DOCX, entirely in the browser (nothing is uploaded anywhere).
// The board is infinite, so exports are cropped to the content (plus padding) on a white background.

import { buildDocx } from './docx.js';
import { drawStroke, measuredTextBounds } from './render.js';
import { PAGE_H, PAGE_W, pageTop } from './paper.js';
import { WORLD, focusBounds, readingOrder, type Board, type Bounds } from './strokes.js';

/** Padding around the content, in world units. */
const EXPORT_PADDING = 48;
/** Largest side of an exported image, in pixels (stays within every browser's canvas limits). */
const MAX_EXPORT_SIDE = 4096;
/** Up to 2 pixels per world unit, so text stays crisp when zoomed in on the export. */
const MAX_EXPORT_SCALE = 2;

/** The area an export covers: content bounds plus padding (a small default area when empty). */
export function exportArea(board: Board): Bounds {
  const b = focusBounds(board, measuredTextBounds);
  if (!b) return { minX: 0, minY: 0, maxX: 800, maxY: 500 };
  return {
    minX: b.minX - EXPORT_PADDING,
    minY: b.minY - EXPORT_PADDING,
    maxX: b.maxX + EXPORT_PADDING,
    maxY: b.maxY + EXPORT_PADDING,
  };
}

/** Pixel size and scale for exporting an area of the given world size. */
export function exportScale(worldW: number, worldH: number): { scale: number; width: number; height: number } {
  const scale = Math.min(MAX_EXPORT_SCALE, MAX_EXPORT_SIDE / Math.max(worldW, worldH, 1));
  return { scale, width: Math.max(1, Math.ceil(worldW * scale)), height: Math.max(1, Math.ceil(worldH * scale)) };
}

/** Render the board's content onto a fresh canvas with a white background. */
export function renderBoard(board: Board, background = '#ffffff'): HTMLCanvasElement {
  const area = exportArea(board);
  const { scale, width, height } = exportScale(area.maxX - area.minX, area.maxY - area.minY);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
  const view = { ox: -area.minX * scale, oy: -area.minY * scale, sx: scale, sy: scale, ws: scale };
  for (const stroke of board.strokes.values()) drawStroke(ctx, stroke, view);
  return canvas;
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Export failed'))), type, quality)
  );
}

export function timestampName(prefix: string, ext: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${prefix}-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.${ext}`;
}

export async function exportPng(board: Board, filename = timestampName('whiteboard', 'png')): Promise<void> {
  download(await toBlob(renderBoard(board), 'image/png'), filename);
}

export async function exportPdf(board: Board, filename = timestampName('whiteboard', 'pdf')): Promise<void> {
  const canvas = renderBoard(board);
  const jpeg = new Uint8Array(await (await toBlob(canvas, 'image/jpeg', 0.92)).arrayBuffer());
  download(new Blob([buildImagePdf(jpeg, canvas.width, canvas.height)], { type: 'application/pdf' }), filename);
}

/** Word document: title, a picture of the board, then every text box as editable paragraphs. */
export async function exportDocx(board: Board, filename = timestampName('whiteboard', 'docx')): Promise<void> {
  const canvas = renderBoard(board);
  const png = new Uint8Array(await (await toBlob(canvas, 'image/png')).arrayBuffer());
  const texts = readingOrder([...board.strokes.values()].filter((s) => s.text !== undefined));
  const date = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  const docx = buildDocx({
    title: `Whiteboard \u2014 ${date}`,
    image: { png, width: canvas.width, height: canvas.height },
    boxes: texts.map((s) => ({ text: s.text!, color: s.color, size: s.width })),
    defaultColor: WORLD.defaultColor,
  });
  download(
    new Blob([docx], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
    filename
  );
}

/**
 * Minimal single-page PDF containing one JPEG image filling the page.
 * The page's long side is 842pt (A4), the other side follows the image's aspect ratio.
 */
export function buildImagePdf(jpeg: Uint8Array, imgWidth: number, imgHeight: number): Uint8Array<ArrayBuffer> {
  const w = Math.max(imgWidth, 1);
  const h = Math.max(imgHeight, 1);
  const pageW = w >= h ? 842 : Math.max(1, Math.round((842 * w) / h));
  const pageH = w >= h ? Math.max(1, Math.round((842 * h) / w)) : 842;
  return buildPagesPdf([{ jpeg, width: imgWidth, height: imgHeight }], pageW, pageH);
}

export interface PdfPageImage {
  jpeg: Uint8Array;
  width: number;
  height: number;
}

/** Minimal PDF with one page (pageW × pageH points) per JPEG image, each filling its page. */
export function buildPagesPdf(images: PdfPageImage[], pageW: number, pageH: number): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (chunk: string | Uint8Array) => {
    const bytes = typeof chunk === 'string' ? enc.encode(chunk) : chunk;
    parts.push(bytes);
    length += bytes.length;
  };
  const obj = (n: number, body: string) => {
    offsets[n] = length;
    push(`${n} 0 obj\n${body}\nendobj\n`);
  };
  // Objects: 1 catalog, 2 page tree, then per page i: page (3+3i), image (4+3i), contents (5+3i).
  const pageObj = (i: number) => 3 + i * 3;
  const count = images.length;
  const total = 2 + count * 3;

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${images.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] /Count ${count} >>`);
  images.forEach((img, i) => {
    const p = pageObj(i);
    obj(p, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /XObject << /Im0 ${p + 1} 0 R >> >> /Contents ${p + 2} 0 R >>`);
    offsets[p + 1] = length;
    push(
      `${p + 1} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.jpeg.length} >>\nstream\n`
    );
    push(img.jpeg);
    push('\nendstream\nendobj\n');
    const content = `q ${pageW} 0 0 ${pageH} 0 0 cm /Im0 Do Q`;
    obj(p + 2, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });

  const xrefAt = length;
  let xref = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= total; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

// ── Document (A4 pages) ──────────────────────────────────────────────────────

/** Pixels per world unit for page exports (≈192 dpi: crisp text, sensible file size). */
const PAGE_EXPORT_SCALE = 2;

/** Render page `i` of a document on its own white canvas, cropped to the page. */
export function renderPage(board: Board, i: number, scale = PAGE_EXPORT_SCALE): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(PAGE_W * scale);
  canvas.height = Math.round(PAGE_H * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const top = pageTop(i);
  const view = { ox: 0, oy: -top * scale, sx: scale, sy: scale, ws: scale };
  for (const stroke of board.strokes.values()) drawStroke(ctx, stroke, view);
  return canvas;
}

/** The document as an A4 PDF, one PDF page per document page. */
export async function exportPaperPdf(board: Board, pages: number, filename = timestampName('document', 'pdf')): Promise<void> {
  const images: PdfPageImage[] = [];
  for (let i = 0; i < pages; i++) {
    const canvas = renderPage(board, i);
    images.push({
      jpeg: new Uint8Array(await (await toBlob(canvas, 'image/jpeg', 0.92)).arrayBuffer()),
      width: canvas.width,
      height: canvas.height,
    });
  }
  // A4 in PDF points.
  download(new Blob([buildPagesPdf(images, 595, 842)], { type: 'application/pdf' }), filename);
}

/** The document's text as editable Word paragraphs (plus a picture when there's handwriting). */
export async function exportPaperDocx(board: Board, filename = timestampName('document', 'docx')): Promise<void> {
  const items = [...board.strokes.values()];
  const texts = readingOrder(items.filter((s) => s.text !== undefined));
  const hasDrawing = items.some((s) => s.text === undefined && s.points.length >= 2);
  let image: { png: Uint8Array; width: number; height: number } | undefined;
  if (hasDrawing) {
    const canvas = renderBoard(board);
    image = { png: new Uint8Array(await (await toBlob(canvas, 'image/png')).arrayBuffer()), width: canvas.width, height: canvas.height };
  }
  const date = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  const docx = buildDocx({
    title: `Document \u2014 ${date}`,
    image,
    boxes: texts.map((s) => ({ text: s.text!, color: s.color, size: s.width })),
    defaultColor: WORLD.defaultColor,
    textHeading: null,
  });
  download(
    new Blob([docx], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
    filename
  );
}
