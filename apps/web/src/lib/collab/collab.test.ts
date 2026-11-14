import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCALE,
  appendToStroke,
  batchStrokes,
  clearBoard,
  emptyBoard,
  lastStrokeBy,
  mergeStroke,
  removeStrokes,
  sanitizeStroke,
  strokesNear,
  type Stroke,
} from './strokes.js';
import { buildImagePdf } from './export.js';

const stroke = (id: string, author: string, points: number[], extra: Partial<Stroke> = {}): Stroke => ({
  id,
  author,
  color: '#ff0000',
  width: 0.004,
  tool: 'pen',
  points,
  done: false,
  ...extra,
});

test('streaming: partial strokes append; only the author can extend', () => {
  const b = emptyBoard();
  appendToStroke(b, stroke('a:1', 'a', [0, 0, 10, 10]));
  appendToStroke(b, stroke('a:1', 'a', [20, 20], { done: true }));
  appendToStroke(b, stroke('a:1', 'mallory', [9999, 9999]));
  assert.deepEqual(b.strokes.get('a:1')?.points, [0, 0, 10, 10, 20, 20]);
  assert.equal(b.strokes.get('a:1')?.done, true);
});

test('erased strokes stay erased even if a late sync or append arrives', () => {
  const b = emptyBoard();
  appendToStroke(b, stroke('a:1', 'a', [0, 0, 10, 10]));
  removeStrokes(b, ['a:1']);
  appendToStroke(b, stroke('a:1', 'a', [20, 20]));
  mergeStroke(b, stroke('a:1', 'a', [0, 0, 10, 10, 20, 20]));
  assert.equal(b.strokes.size, 0);
});

test('sync merge keeps the more complete copy', () => {
  const b = emptyBoard();
  appendToStroke(b, stroke('a:1', 'a', [0, 0]));
  // Someone relaying it can't change an existing stroke; its author can complete it (in place).
  const live = b.strokes.get('a:1');
  assert.equal(mergeStroke(b, stroke('a:1', 'a', [0, 0, 7, 7, 8, 8])), false);
  assert.equal(mergeStroke(b, stroke('a:1', 'a', [0, 0, 5, 5, 9, 9]), true), true);
  mergeStroke(b, stroke('a:1', 'a', [0, 0, 5, 5]), true);
  assert.deepEqual(b.strokes.get('a:1')?.points, [0, 0, 5, 5, 9, 9]);
  assert.equal(b.strokes.get('a:1'), live);
});

test('sanitize rejects junk and clamps values from untrusted peers', () => {
  assert.equal(sanitizeStroke(null, 'x'), null);
  assert.equal(sanitizeStroke({ id: 'x:a', points: [1, 2, 3] }, 'x'), null); // odd count
  assert.equal(sanitizeStroke({ id: 'x:a', points: ['1', 2] }, 'x'), null);
  const s = sanitizeStroke({ id: 'x:a', points: [-50, SCALE * 2], color: 'red; evil', width: 9, tool: 'laser' }, 'x')!;
  assert.deepEqual(s.points, [0, SCALE]);
  assert.equal(s.color, '#ffffff');
  assert.equal(s.width, 0.004);
  assert.equal(s.tool, 'pen');
  assert.equal(s.author, 'x');
});

test('annotations (normalized space) never accept text items', () => {
  assert.equal(sanitizeStroke({ id: 'x:t', points: [1, 2], text: 'hi' }, 'x'), null);
});

test('eraser hit test finds strokes near a point', () => {
  const b = emptyBoard();
  appendToStroke(b, stroke('a:1', 'a', [0, 5000, 10000, 5000])); // horizontal line through the middle
  appendToStroke(b, stroke('a:2', 'a', [0, 0, 1000, 0]));
  assert.deepEqual(strokesNear(b, 0.5, 0.505, 0.01), ['a:1']);
  assert.deepEqual(strokesNear(b, 0.5, 0.9, 0.01), []);
});

test('undo targets your own latest stroke; clear removes everything', () => {
  const b = emptyBoard();
  appendToStroke(b, stroke('a:1', 'a', [0, 0]));
  appendToStroke(b, stroke('b:1', 'b', [0, 0]));
  appendToStroke(b, stroke('a:2', 'a', [0, 0]));
  assert.equal(lastStrokeBy(b, 'a')?.id, 'a:2');
  assert.deepEqual(clearBoard(b).sort(), ['a:1', 'a:2', 'b:1']);
  assert.equal(b.strokes.size, 0);
  assert.equal(b.removed.size, 3);
});

test('sync batches stay under the data channel size budget', () => {
  const big = Array.from({ length: 40 }, (_, i) => stroke(`a:${i}`, 'a', Array.from({ length: 400 }, (_, j) => j)));
  const batches = batchStrokes(big, 20_000);
  assert.ok(batches.length > 1);
  assert.equal(batches.flat().length, 40);
  for (const batch of batches) assert.ok(JSON.stringify(batch).length < 20_000 + 2000);
});

test('PDF export: valid header, trailer and correct xref offsets', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  const pdf = buildImagePdf(jpeg, 1600, 1000);
  const text = new TextDecoder('latin1').decode(pdf);
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  assert.match(text, /\/MediaBox \[0 0 842 526\]/);
  const xrefStart = Number(text.match(/startxref\n(\d+)/)![1]);
  // startxref must point at the byte offset of "xref" (latin1 decoding keeps 1 char = 1 byte)
  assert.equal(text.slice(xrefStart, xrefStart + 4), 'xref');
  const entries = text.slice(xrefStart).split('\n').slice(3, 8);
  entries.forEach((line, i) => {
    const offset = Number(line.slice(0, 10));
    assert.ok(text.slice(offset).startsWith(`${i + 1} 0 obj`), `object ${i + 1} offset`);
  });
});

test('limits: a peer cannot exceed the stroke/point budget or rewrite someone else\'s stroke', async () => {
  const { MAX_STROKES } = await import('./strokes.js');
  const b = emptyBoard();
  for (let i = 0; i < MAX_STROKES + 50; i++) appendToStroke(b, stroke(`m:${i}`, 'mallory', [0, 0]));
  assert.equal(b.strokes.size, MAX_STROKES);
  assert.equal(b.pointCount, MAX_STROKES);

  const b2 = emptyBoard();
  appendToStroke(b2, stroke('a:1', 'alice', [0, 0, 1, 1]));
  mergeStroke(b2, stroke('a:1', 'mallory', [9, 9, 9, 9, 9, 9, 9, 9]));
  assert.equal(b2.strokes.get('a:1')?.author, 'alice');
  assert.deepEqual(b2.strokes.get('a:1')?.points, [0, 0, 1, 1]);
});

test('removing tracks point totals and ignores oversized ids', () => {
  const b = emptyBoard();
  appendToStroke(b, stroke('a:1', 'a', [0, 0, 1, 1, 2, 2]));
  assert.equal(b.pointCount, 3);
  removeStrokes(b, ['a:1', 'x'.repeat(500)]);
  assert.equal(b.pointCount, 0);
  assert.ok(!b.removed.has('x'.repeat(500)));
});
