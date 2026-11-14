// Minimal ZIP writer (no compression, "stored" entries), enough for .docx files.
// Pure logic, no dependencies: CRC-32, local file headers, central directory, end record.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** Standard CRC-32 (IEEE 802.3, as used by ZIP and PNG). */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array | string;
}

/** DOS date/time fields for a JS date (local time, 2-second resolution). */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Build a ZIP archive with every entry stored uncompressed. Entry names are UTF-8. */
export function buildZip(entries: ZipEntry[], when = new Date()): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime(when);
  const files = entries.map((e) => {
    const name = enc.encode(e.name);
    const data = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
    return { name, data, crc: crc32(data) };
  });

  const localSize = files.reduce((n, f) => n + 30 + f.name.length + f.data.length, 0);
  const centralSize = files.reduce((n, f) => n + 46 + f.name.length, 0);
  if (files.length > 0xffff || localSize + centralSize > 0xffffffff) throw new Error('Archive too large');
  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  let pos = 0;
  const u16 = (v: number) => {
    view.setUint16(pos, v, true);
    pos += 2;
  };
  const u32 = (v: number) => {
    view.setUint32(pos, v >>> 0, true);
    pos += 4;
  };
  const bytes = (b: Uint8Array) => {
    out.set(b, pos);
    pos += b.length;
  };

  const FLAGS = 0x0800; // bit 11: names are UTF-8
  const offsets: number[] = [];
  for (const f of files) {
    offsets.push(pos);
    u32(0x04034b50); // local file header signature
    u16(20); // version needed to extract (2.0)
    u16(FLAGS);
    u16(0); // method: stored
    u16(time);
    u16(date);
    u32(f.crc);
    u32(f.data.length); // compressed size
    u32(f.data.length); // uncompressed size
    u16(f.name.length);
    u16(0); // extra field length
    bytes(f.name);
    bytes(f.data);
  }

  const centralStart = pos;
  files.forEach((f, i) => {
    u32(0x02014b50); // central directory header signature
    u16(20); // version made by
    u16(20); // version needed
    u16(FLAGS);
    u16(0);
    u16(time);
    u16(date);
    u32(f.crc);
    u32(f.data.length);
    u32(f.data.length);
    u16(f.name.length);
    u16(0); // extra
    u16(0); // comment
    u16(0); // disk number start
    u16(0); // internal attributes
    u32(0); // external attributes
    u32(offsets[i]); // offset of local header
    bytes(f.name);
  });

  const centralLength = pos - centralStart;
  u32(0x06054b50); // end of central directory signature
  u16(0); // this disk
  u16(0); // disk with central directory
  u16(files.length);
  u16(files.length);
  u32(centralLength);
  u32(centralStart);
  u16(0); // comment length
  return out;
}
