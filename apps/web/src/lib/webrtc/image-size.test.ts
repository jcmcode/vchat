import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readImageSize, MAX_PREVIEW_PIXELS } from './image-size.js';

function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}

test('reads PNG, GIF, JPEG and WebP dimensions from headers', () => {
  assert.deepEqual(readImageSize(png(640, 480)), { width: 640, height: 480 });

  assert.deepEqual(readImageSize(gif(800, 600, 800, 600)), { width: 800, height: 600 });

  // SOI, APP0 (length 16), SOF0 with height 300, width 400.
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0)];
  const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0x90, 0x03, ...new Array(9).fill(0)];
  assert.deepEqual(readImageSize(new Uint8Array([0xff, 0xd8, ...app0, ...sof0])), { width: 400, height: 300 });

  const webp = new Uint8Array(30);
  webp.set(Buffer.from('RIFF'), 0);
  webp.set(Buffer.from('WEBPVP8X'), 8);
  webp.set([0xff, 0x03, 0x00], 24); // width-1 = 1023
  webp.set([0xff, 0x01, 0x00], 27); // height-1 = 511
  assert.deepEqual(readImageSize(webp), { width: 1024, height: 512 });
});

test('a decompression bomb is detectable and garbage is rejected', () => {
  const bomb = readImageSize(png(50_000, 50_000));
  assert.ok(bomb && bomb.width * bomb.height > MAX_PREVIEW_PIXELS);
  assert.equal(readImageSize(new Uint8Array([1, 2, 3, 4])), null);
  assert.equal(readImageSize(new Uint8Array([0xff, 0xd8, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0])), null);
});

/** A minimal GIF: logical screen, a graphic-control extension, then one frame of the given size. */
function gif(screenW: number, screenH: number, frameW: number, frameH: number): Uint8Array {
  const le = (n: number) => [n & 0xff, n >> 8];
  return new Uint8Array([
    ...Buffer.from('GIF89a'), ...le(screenW), ...le(screenH), 0x00, 0x00, 0x00,
    0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x2c, 0x00, 0x00, 0x00, 0x00, ...le(frameW), ...le(frameH), 0x00,
    0x02, 0x02, 0x4c, 0x01, 0x00,
    0x3b,
  ]);
}

test('a GIF frame larger than its declared screen counts (no tiny-screen decompression bomb)', () => {
  assert.deepEqual(readImageSize(gif(1, 1, 20000, 20000)), { width: 20000, height: 20000 });
  // No frame within the bytes we read: size unknown, so it is never previewed.
  assert.equal(readImageSize(gif(800, 600, 800, 600).subarray(0, 13)), null);
});
