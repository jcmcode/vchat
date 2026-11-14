import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildZip, crc32 } from './zip.js';
import { buildDocumentParts, buildDocx, xmlEscape } from './docx.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

interface ReadEntry {
  name: string;
  crc: number;
  data: Uint8Array;
  localOffset: number;
}

/** Independent ZIP reader: walks the central directory and checks it against the local headers. */
function readZip(buf: Uint8Array): ReadEntry[] {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const eocd = buf.length - 22;
  assert.equal(v.getUint32(eocd, true), 0x06054b50, 'end of central directory signature');
  const count = v.getUint16(eocd + 10, true);
  assert.equal(v.getUint16(eocd + 8, true), count);
  const cdSize = v.getUint32(eocd + 12, true);
  const cdOffset = v.getUint32(eocd + 16, true);
  assert.equal(cdOffset + cdSize, eocd, 'central directory ends right before the end record');
  const out: ReadEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    assert.equal(v.getUint32(p, true), 0x02014b50, 'central header signature');
    const method = v.getUint16(p + 10, true);
    const crc = v.getUint32(p + 16, true);
    const csize = v.getUint32(p + 20, true);
    const usize = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const localOffset = v.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    assert.equal(method, 0);
    assert.equal(csize, usize);
    // Local header must agree with the central directory.
    assert.equal(v.getUint32(localOffset, true), 0x04034b50, `local header signature for ${name}`);
    assert.equal(v.getUint32(localOffset + 14, true), crc);
    assert.equal(v.getUint32(localOffset + 18, true), csize);
    const lNameLen = v.getUint16(localOffset + 26, true);
    const lExtra = v.getUint16(localOffset + 28, true);
    assert.equal(dec.decode(buf.subarray(localOffset + 30, localOffset + 30 + lNameLen)), name);
    const start = localOffset + 30 + lNameLen + lExtra;
    const data = buf.subarray(start, start + csize);
    assert.equal(crc32(data), crc, `CRC of ${name}`);
    out.push({ name, crc, data, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  assert.equal(p, eocd);
  return out;
}

/** Minimal XML well-formedness check: balanced tags, quoted attributes, known entities only. */
function assertWellFormed(xml: string): void {
  let s = xml.replace(/^<\?xml[^?]*\?>\s*/, '');
  const stack: string[] = [];
  let roots = 0;
  const textOk = (t: string) => {
    assert.ok(!/[<>]/.test(t), `stray angle bracket in text: ${t.slice(0, 40)}`);
    for (const m of t.matchAll(/&([^;]*);?/g)) {
      assert.ok(/^(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+)$/.test(m[1]) && m[0].endsWith(';'), `bad entity ${m[0]}`);
    }
  };
  while (s.length) {
    const lt = s.indexOf('<');
    if (lt === -1) {
      textOk(s);
      assert.equal(s.trim(), '', 'text after the root element');
      break;
    }
    if (lt > 0) {
      textOk(s.slice(0, lt));
      if (stack.length === 0) assert.equal(s.slice(0, lt).trim(), '', 'text outside the root element');
    }
    const gt = s.indexOf('>', lt);
    assert.ok(gt > lt, 'unterminated tag');
    const tag = s.slice(lt + 1, gt);
    s = s.slice(gt + 1);
    if (tag.startsWith('/')) {
      assert.equal(stack.pop(), tag.slice(1).trim(), 'mismatched closing tag');
      continue;
    }
    const selfClosing = tag.endsWith('/');
    const body = selfClosing ? tag.slice(0, -1) : tag;
    const m = /^([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*$/.exec(body);
    assert.ok(m, `malformed tag <${tag.slice(0, 60)}>`);
    const attrNames = [...m[2].matchAll(/([A-Za-z_][\w.:-]*)\s*=/g)].map((a) => a[1]);
    assert.equal(new Set(attrNames).size, attrNames.length, `duplicate attribute in <${m[1]}>`);
    for (const a of m[2].matchAll(/=\s*(?:"([^"]*)"|'([^']*)')/g)) textOk(a[1] ?? a[2]);
    if (stack.length === 0) roots++;
    if (!selfClosing) stack.push(m[1]);
  }
  assert.equal(stack.length, 0, 'unclosed elements');
  assert.equal(roots, 1, 'exactly one root element');
}

test('CRC-32 matches the standard check values', () => {
  assert.equal(crc32(new Uint8Array()), 0);
  assert.equal(crc32(enc.encode('123456789')), 0xcbf43926);
  assert.equal(crc32(enc.encode('The quick brown fox jumps over the lazy dog')), 0x414fa339);
});

test('ZIP writer: headers, offsets, CRCs, names and end record', () => {
  const when = new Date(2026, 10, 14, 13, 45, 30);
  const zip = buildZip(
    [
      { name: 'a.txt', data: 'hello' },
      { name: 'dir/ü.bin', data: new Uint8Array([0, 1, 2, 255]) },
      { name: 'empty', data: '' },
    ],
    when
  );
  const entries = readZip(zip);
  assert.deepEqual(entries.map((e) => e.name), ['a.txt', 'dir/ü.bin', 'empty']);
  assert.equal(entries[0].localOffset, 0);
  assert.equal(entries[1].localOffset, 30 + 5 + 5);
  assert.equal(entries[0].crc, 0x3610a686); // crc32("hello")
  assert.equal(dec.decode(entries[0].data), 'hello');
  assert.deepEqual([...entries[1].data], [0, 1, 2, 255]);
  assert.equal(entries[2].crc, 0);
  const v = new DataView(zip.buffer);
  // UTF-8 flag set, DOS date/time encoded.
  assert.equal(v.getUint16(6, true), 0x0800);
  assert.equal(v.getUint16(10, true), (13 << 11) | (45 << 5) | 15);
  assert.equal(v.getUint16(12, true), ((2026 - 1980) << 9) | (11 << 5) | 14);
});

const SAMPLE = {
  title: 'Whiteboard — 14 November 2026',
  image: { png: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]), width: 2000, height: 1000 },
  boxes: [
    { text: 'Plan **bold** & _italic_ <tag> "q" \'a\'\n- bullet __under__\n- two\n\n1. first\n2. second', color: '#111827', size: 20 },
    { text: 'Second box\n3. three\n4. four', color: '#ef4444', size: 48 },
  ],
  defaultColor: '#111827',
};

test('DOCX: package parts, relationships and content types', () => {
  const entries = readZip(buildDocx(SAMPLE));
  const names = entries.map((e) => e.name);
  assert.deepEqual(names, [
    '[Content_Types].xml',
    '_rels/.rels',
    'word/document.xml',
    'word/styles.xml',
    'word/numbering.xml',
    'word/_rels/document.xml.rels',
    'word/media/board.png',
  ]);
  for (const e of entries) if (e.name.endsWith('.xml') || e.name.endsWith('.rels')) assertWellFormed(dec.decode(e.data));
  const types = dec.decode(entries[0].data);
  assert.match(types, /Extension="png" ContentType="image\/png"/);
  assert.match(types, /PartName="\/word\/document.xml" ContentType="application\/vnd.openxmlformats-officedocument.wordprocessingml.document.main\+xml"/);
  const rels = dec.decode(entries[5].data);
  assert.match(rels, /Id="rIdImg"[^>]*Target="media\/board.png"/);
  assert.match(dec.decode(entries[2].data), /r:embed="rIdImg"/);
  assert.deepEqual([...entries[6].data], [...SAMPLE.image.png]);
});

test('DOCX: document.xml is well-formed with formatted runs, bullets and numbering', () => {
  const { documentXml, numberingXml } = buildDocumentParts(SAMPLE);
  assertWellFormed(documentXml);
  assertWellFormed(numberingXml);
  assert.match(documentXml, /<w:t xml:space="preserve">Whiteboard — 14 November 2026<\/w:t>/);
  // Escaping
  assert.match(documentXml, /&amp; /);
  assert.match(documentXml, /&lt;tag&gt; &quot;q&quot; &apos;a&apos;/);
  // Formatting runs
  assert.match(documentXml, /<w:r><w:rPr><w:b\/><w:bCs\/><w:sz w:val="26"\/><w:szCs w:val="26"\/><\/w:rPr><w:t xml:space="preserve">bold<\/w:t><\/w:r>/);
  assert.match(documentXml, /<w:i\/><w:iCs\/>[^]*?>italic</);
  assert.match(documentXml, /<w:u w:val="single"\/><\/w:rPr><w:t xml:space="preserve">under</);
  // Default color omitted, others kept
  assert.ok(!documentXml.includes('w:val="111827"'));
  assert.match(documentXml, /<w:color w:val="EF4444"\/>/);
  // Bullets use numId 1; each numbered list gets its own num restarting at its first number.
  assert.equal(documentXml.match(/<w:numId w:val="1"\/>/g)?.length, 2);
  assert.equal(documentXml.match(/<w:numId w:val="2"\/>/g)?.length, 2);
  assert.equal(documentXml.match(/<w:numId w:val="3"\/>/g)?.length, 2);
  assert.match(numberingXml, /<w:num w:numId="2"><w:abstractNumId w:val="1"\/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"\/>/);
  assert.match(numberingXml, /<w:num w:numId="3"><w:abstractNumId w:val="1"\/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="3"\/>/);
  // Image keeps the aspect ratio within the page width.
  const [, cx, cy] = documentXml.match(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/)!;
  assert.equal(Math.round(Number(cx) / Number(cy)), 2);
});

test('DOCX: hostile text cannot break out of the XML', () => {
  const evil = '</w:t></w:r><w:r><w:t>x]]><!--\u0001\u0000￾\uD800 &#0; &amp;';
  assert.equal(xmlEscape(evil).includes('<'), false);
  const { documentXml } = buildDocumentParts({ title: '<x>', boxes: [{ text: evil, color: 'bad', size: 1e9 }] });
  assertWellFormed(documentXml);
  assert.ok(!documentXml.includes('\u0001') && !documentXml.includes('￾'));
  assert.ok(!/[\uD800-\uDFFF]/.test(documentXml));
});

test('numbered lists are capped so a hostile board cannot bloat numbering.xml', () => {
  const text = Array.from({ length: 700 }, () => '1. item\nbreak').join('\n');
  const { documentXml, numberingXml } = buildDocumentParts({ title: 't', boxes: [{ text, color: '#000000', size: 20 }] });
  const nums = numberingXml.match(/<w:num w:numId=/g)?.length ?? 0;
  assert.ok(nums <= 501, `${nums} numbering entries`);
  // Every list paragraph points at a numbering entry that exists.
  const ids = new Set([...numberingXml.matchAll(/<w:num w:numId="(\d+)"/g)].map((m) => m[1]));
  for (const m of documentXml.matchAll(/<w:numId w:val="(\d+)"/g)) assert.ok(ids.has(m[1]), `numId ${m[1]} exists`);
});
