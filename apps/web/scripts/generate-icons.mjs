// Draws the app icons in apps/web/static (a white video camera on the accent color) without any
// dependencies: shapes are signed-distance functions with analytic anti-aliasing, written out as
// PNGs with node:zlib. The PNGs are committed; run this again only to change them:
//
//   node apps/web/scripts/generate-icons.mjs

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const STATIC_DIR = fileURLToPath(new URL('../static/', import.meta.url));

// Accent colors from src/app.css (--accent #5b7cfa, --accent-hover #4766ef), as a soft gradient.
const TOP = [0x6a, 0x89, 0xff];
const BOTTOM = [0x47, 0x66, 0xef];

// The camera, in the 24-unit space of the "video" icon in src/lib/ui/Icon.svelte, filled.
const GLYPH_LEFT = 2;
const GLYPH_RIGHT = 21.5;
const GLYPH_CENTER = [(GLYPH_LEFT + GLYPH_RIGHT) / 2, 12];
const BODY = { cx: 8.5, cy: 12, hw: 6.5, hh: 6, r: 3 };
// The lens: a trapezoid with its corners rounded by LENS_ROUND.
const LENS = [
  [17.4, 10.9],
  [20.6, 9.0],
  [20.6, 15.0],
  [17.4, 13.1],
];
const LENS_ROUND = 0.9;

function roundedBox(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r;
}

/** Signed distance to a convex polygon given clockwise in screen coordinates (negative inside). */
function convexPolygon(px, py, points) {
  let minDist = Infinity;
  let inside = true;
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[(i + 1) % points.length];
    const ex = bx - ax;
    const ey = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey) / (ex * ex + ey * ey)));
    minDist = Math.min(minDist, Math.hypot(px - (ax + t * ex), py - (ay + t * ey)));
    if (ex * (py - ay) - ey * (px - ax) < 0) inside = false;
  }
  return inside ? -minDist : minDist;
}

function glyphDistance(gx, gy) {
  const body = roundedBox(gx, gy, BODY.cx, BODY.cy, BODY.hw, BODY.hh, BODY.r);
  const lens = convexPolygon(gx, gy, LENS) - LENS_ROUND;
  return Math.min(body, lens);
}

const coverage = (distancePx) => Math.max(0, Math.min(1, 0.5 - distancePx));

/**
 * @param size      output size in pixels
 * @param glyphWidth the camera's width as a fraction of the size
 * @param tile      true: rounded tile on a transparent background; false: full bleed, opaque
 */
function drawIcon(size, glyphWidth, tile) {
  const unit = (glyphWidth * size) / (GLYPH_RIGHT - GLYPH_LEFT); // pixels per glyph unit
  const radius = 0.2237 * size;
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const t = y / (size - 1);
    const bg = TOP.map((c, i) => c + (BOTTOM[i] - c) * t);
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const half = size / 2;
      const bgAlpha = tile ? coverage(roundedBox(px, py, half, half, half, half, radius)) : 1;
      const gx = GLYPH_CENTER[0] + (px - half) / unit;
      const gy = GLYPH_CENTER[1] + (py - half) / unit;
      const ink = coverage(glyphDistance(gx, gy) * unit);
      const o = (y * size + x) * 4;
      for (let i = 0; i < 3; i++) rgba[o + i] = Math.round(bg[i] + (255 - bg[i]) * ink);
      rgba[o + 3] = Math.round(bgAlpha * 255);
    }
  }
  return rgba;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const ICONS = [
  // Shown as-is by browsers and launchers that don't mask icons.
  { file: 'icon-192.png', size: 192, glyphWidth: 0.58, tile: true },
  { file: 'icon-512.png', size: 512, glyphWidth: 0.58, tile: true },
  // Launchers crop maskable icons to a shape; everything important stays in the central circle
  // (radius 40% of the size).
  { file: 'icon-maskable-512.png', size: 512, glyphWidth: 0.5, tile: false },
  // iOS rounds the corners itself and shows transparency as black, so this one is opaque.
  { file: 'apple-touch-icon.png', size: 180, glyphWidth: 0.56, tile: false },
];

for (const { file, size, glyphWidth, tile } of ICONS) {
  writeFileSync(`${STATIC_DIR}${file}`, png(size, drawIcon(size, glyphWidth, tile)));
  console.log(`wrote static/${file}`);
}
