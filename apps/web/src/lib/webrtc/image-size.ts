// Read an image's pixel dimensions from its header, without decoding it.
// Used before showing a received image inline: a small file can claim a gigantic canvas
// ("decompression bomb") and freeze or crash the tab when the browser decodes it.

/** Largest image (in pixels) shown inline. */
export const MAX_PREVIEW_PIXELS = 16_000_000;

export function readImageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const b = bytes;
  const u16be = (i: number) => (b[i] << 8) | b[i + 1];
  const u16le = (i: number) => b[i] | (b[i + 1] << 8);
  const u24le = (i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  const u32be = (i: number) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
  const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

  // PNG: signature, then IHDR width/height.
  if (b.length >= 24 && b[0] === 0x89 && ascii(1, 3) === 'PNG' && ascii(12, 4) === 'IHDR') {
    return { width: u32be(16), height: u32be(20) };
  }
  // GIF: logical screen size (frames can't exceed it when rendered).
  if (b.length >= 10 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) {
    return { width: u16le(6), height: u16le(8) };
  }
  // JPEG: walk segments to the first start-of-frame marker.
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { width: u16be(i + 7), height: u16be(i + 5) };
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        i += 2;
        continue;
      }
      i += 2 + u16be(i + 2);
    }
    return null;
  }
  // WebP: RIFF container with a VP8 / VP8L / VP8X first chunk.
  if (b.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const kind = ascii(12, 4);
    if (kind === 'VP8X') return { width: u24le(24) + 1, height: u24le(27) + 1 };
    if (kind === 'VP8L' && b[20] === 0x2f) {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (kind === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
    }
  }
  return null;
}

/** True only if the image's header is readable and it's small enough to decode safely. */
export async function isSafeToPreview(blob: Blob): Promise<boolean> {
  try {
    const head = new Uint8Array(await blob.slice(0, 64 * 1024).arrayBuffer());
    const size = readImageSize(head);
    return !!size && size.width > 0 && size.height > 0 && size.width * size.height <= MAX_PREVIEW_PIXELS;
  } catch {
    return false;
  }
}
