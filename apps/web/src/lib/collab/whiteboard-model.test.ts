import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOX_MAX_WIDTH,
  MAX_TEXT_LENGTH,
  MAX_TOTAL_TEXT,
  MAX_VERSION_JUMP,
  NORMALIZED,
  SCALE,
  WORLD,
  WORLD_LIMIT,
  appendToStroke,
  applyTextUpdate,
  clearBoard,
  contentBounds,
  focusBounds,
  idAuthor,
  MAX_CONTENT_SPAN,
  emptyBoard,
  itemsNearWorld,
  mergeStroke,
  quantizeWorld,
  readingOrder,
  removeStrokes,
  sanitizeStroke,
  sanitizeTextUpdate,
  textBoxAt,
  type Stroke,
  type TextUpdate,
} from './strokes.js';
import { StrokeSender } from './stroke-sender.js';

const textItem = (id: string, author: string, text: string, x = 0, y = 0, extra: Partial<Stroke> = {}): Stroke =>
  sanitizeStroke({ id, points: [x, y], text, width: 20, boxWidth: 300, color: '#111827', ...extra }, author, WORLD)!;

const upd = (id: string, editor: string, v: number, text: string, extra: Partial<TextUpdate> = {}): TextUpdate => ({
  id,
  editor,
  v,
  text,
  color: '#111827',
  size: 20,
  boxWidth: 300,
  x: 0,
  y: 0,
  ...extra,
});

test('world space: integer coordinates clamped to ±WORLD_LIMIT; widths in world units', () => {
  const s = sanitizeStroke({ id: 'x:a', points: [-5e9, 12.6, 3e9, -0.4], width: 6, tool: 'highlighter' }, 'x', WORLD)!;
  assert.deepEqual(s.points, [-WORLD_LIMIT, 13, WORLD_LIMIT, -0]);
  assert.equal(s.width, 6);
  assert.equal(s.tool, 'highlighter');
  assert.equal(s.color, WORLD.defaultColor);
  assert.equal(sanitizeStroke({ id: 'x:a', points: [0, 0], width: 5000 }, 'x', WORLD)!.width, WORLD.defaultWidth);
  assert.equal(sanitizeStroke({ id: 'x:a', points: [0, Infinity] }, 'x', WORLD), null);
  assert.equal(sanitizeStroke({ id: 'x:a', points: [0, NaN] }, 'x', WORLD), null);
  assert.equal(quantizeWorld(NaN), 0);
  assert.equal(quantizeWorld(2.5e6), WORLD_LIMIT);
});

test('normalized space (annotations) is unchanged', () => {
  const s = sanitizeStroke({ id: 'x:a', points: [-50, SCALE * 2], width: 0.01 }, 'x', NORMALIZED)!;
  assert.deepEqual(s.points, [0, SCALE]);
  assert.equal(s.width, 0.01);
  assert.equal(s.color, '#ffffff');
  // A world-sized width is invalid in normalized space.
  assert.equal(sanitizeStroke({ id: 'x:a', points: [0, 0], width: 4 }, 'x')!.width, 0.004);
});

test('stroke sender quantizes to the space it was given', () => {
  const sent: Stroke[] = [];
  const world = StrokeSender.start('w', 'me', { color: '#000000', width: 4, tool: 'pen' }, (p) => sent.push(p), quantizeWorld);
  world.add(-1234.4, 99999.6);
  world.add(-1234.4, 99999.6); // duplicate, skipped
  world.finish();
  assert.deepEqual(world.stroke.points, [-1234, 100000]);
  const norm = StrokeSender.start('n', 'me', { color: '#000000', width: 0.004, tool: 'pen' }, () => {});
  norm.add(0.5, 2);
  assert.deepEqual(norm.stroke.points, [5000, SCALE]);
  norm.cancel();
});

test('text boxes: cleaned of control, bidi and zero-width characters; capped length', () => {
  const t = textItem('a:t', 'a', 'Hi\u0007 ‮evil‬​ there\r\nline two\tx');
  assert.equal(t.text, 'Hi evil there\nline\ntwo  x');
  assert.equal(t.v, 0);
  assert.equal(t.editor, 'a');
  const long = textItem('a:t2', 'a', 'x'.repeat(MAX_TEXT_LENGTH + 500));
  assert.equal(long.text!.length, MAX_TEXT_LENGTH);
  assert.equal(sanitizeStroke({ id: 'a:t', points: [0, 0], text: '​\u0000 ' }, 'a', WORLD), null);
  assert.equal(sanitizeStroke({ id: 'a:t', points: [0, 0, 1, 1], text: 'hi' }, 'a', WORLD), null);
  assert.equal(sanitizeStroke({ id: 'a:t', points: [0, 0], text: 42 }, 'a', WORLD)?.text, undefined);
  const big = textItem('a:t3', 'a', 'x', 0, 0, { width: 9999, boxWidth: 1e9 });
  assert.equal(big.width, 400);
  assert.equal(big.boxWidth, BOX_MAX_WIDTH);
  // Lone surrogates are dropped (they'd make exported XML invalid).
  assert.equal(textItem('a:t4', 'a', 'a\uD800b\uDC00c').text, 'abc');
});

test('text update: last writer wins by version, then editor id', () => {
  const b = emptyBoard();
  appendToStroke(b, textItem('alice:t', 'alice', 'one'));
  assert.ok(applyTextUpdate(b, upd('alice:t', 'bob', 1, 'bob v1')));
  assert.equal(b.strokes.get('alice:t')!.text, 'bob v1');
  // Same version from a lower id loses, from a higher id wins.
  assert.ok(!applyTextUpdate(b, upd('alice:t', 'aaron', 1, 'aaron v1')));
  assert.ok(applyTextUpdate(b, upd('alice:t', 'carol', 1, 'carol v1')));
  assert.equal(b.strokes.get('alice:t')!.text, 'carol v1');
  // Older versions never win.
  assert.ok(!applyTextUpdate(b, upd('alice:t', 'zed', 0, 'old')));
  assert.ok(applyTextUpdate(b, upd('alice:t', 'alice', 2, 'alice v2', { x: 50, y: -20, color: '#ef4444' })));
  const t = b.strokes.get('alice:t')!;
  assert.equal(t.author, 'alice'); // the author never changes
  assert.deepEqual(t.points, [50, -20]);
  assert.equal(t.color, '#ef4444');
  assert.equal(b.textChars, 'alice v2'.length);
});

test('text update: order-independent convergence', () => {
  const updates = [upd('alice:t', 'bob', 1, 'B'), upd('alice:t', 'carol', 1, 'C'), upd('alice:t', 'alice', 2, 'A2'), upd('alice:t', 'dave', 1, 'D')];
  const results = new Set<string>();
  for (const order of [[0, 1, 2, 3], [3, 2, 1, 0], [2, 0, 3, 1], [1, 3, 0, 2]]) {
    const b = emptyBoard();
    appendToStroke(b, textItem('alice:t', 'alice', 'start'));
    for (const i of order) applyTextUpdate(b, updates[i]);
    results.add(b.strokes.get('alice:t')!.text!);
  }
  assert.deepEqual([...results], ['A2']);
});

test('text update: tombstones win, unknown ids and strokes are ignored, jumps are bounded', () => {
  const b = emptyBoard();
  appendToStroke(b, textItem('alice:t', 'alice', 'one'));
  appendToStroke(b, sanitizeStroke({ id: 'alice:s', points: [0, 0, 5, 5] }, 'alice', WORLD)!);
  assert.ok(!applyTextUpdate(b, upd('nope', 'bob', 1, 'x')));
  assert.ok(!applyTextUpdate(b, upd('alice:s', 'bob', 1, 'x')));
  assert.equal(b.strokes.get('alice:s')!.text, undefined);
  assert.ok(!applyTextUpdate(b, upd('alice:t', 'bob', MAX_VERSION_JUMP + 5, 'jump')));
  removeStrokes(b, ['alice:t']);
  assert.ok(!applyTextUpdate(b, upd('alice:t', 'bob', 2, 'resurrect')));
  assert.equal(b.strokes.has('alice:t'), false);
  // A late sync can't bring it back either.
  mergeStroke(b, textItem('alice:t', 'alice', 'from sync', 0, 0, { v: 9 }));
  assert.equal(b.strokes.has('alice:t'), false);
});

test('text update sanitization: editor is the sender, values validated', () => {
  const u = sanitizeTextUpdate({ id: 't', v: 3, text: 'hey‏', color: '#00ff00', size: 1e6, boxWidth: 1, x: 1e12, y: -3.4, editor: 'mallory' }, 'bob')!;
  assert.equal(u.editor, 'bob');
  assert.equal(u.text, 'hey');
  assert.equal(u.size, 400);
  assert.equal(u.boxWidth, 40);
  assert.equal(u.x, WORLD_LIMIT);
  assert.equal(u.y, -3);
  assert.equal(sanitizeTextUpdate({ id: 't', v: 0, text: 'x', color: '#000000', x: 0, y: 0 }, 'bob'), null);
  assert.equal(sanitizeTextUpdate({ id: 't', v: 1.5, text: 'x', color: '#000000', x: 0, y: 0 }, 'bob'), null);
  assert.equal(sanitizeTextUpdate({ id: 't', v: 1, text: '  ', color: '#000000', x: 0, y: 0 }, 'bob'), null);
  assert.equal(sanitizeTextUpdate({ id: 't', v: 1, text: 'x', color: 'red', x: 0, y: 0 }, 'bob'), null);
  assert.equal(sanitizeTextUpdate({ id: 'x'.repeat(200), v: 1, text: 'x', color: '#000000', x: 0, y: 0 }, 'bob'), null);
  assert.equal(sanitizeTextUpdate(null, 'bob'), null);
});

test('text boxes cannot be extended with points or rewritten by a stroke with the same id', () => {
  const b = emptyBoard();
  appendToStroke(b, textItem('alice:t', 'alice', 'hello'));
  appendToStroke(b, sanitizeStroke({ id: 'alice:t', points: [1, 1, 2, 2] }, 'alice', WORLD)!);
  mergeStroke(b, sanitizeStroke({ id: 'alice:t', points: [1, 1, 2, 2, 3, 3] }, 'alice', WORLD)!);
  assert.deepEqual(b.strokes.get('alice:t')!.points, [0, 0]);
  // A sync from someone claiming another author can't take it over either.
  assert.equal(sanitizeStroke({ id: 'alice:t', points: [0, 0], text: 'pwned', v: 50 }, 'mallory', WORLD), null);
  assert.equal(mergeStroke(b, { ...textItem('alice:t', 'alice', 'pwned', 0, 0, { v: 50 }), author: 'mallory' }), false);
  assert.equal(b.strokes.get('alice:t')!.text, 'hello');
  // But a newer synced version from the real author's box is applied (LWW).
  mergeStroke(b, textItem('alice:t', 'alice', 'edited', 0, 0, { v: 4, editor: 'bob' }));
  assert.equal(b.strokes.get('alice:t')!.text, 'edited');
  assert.equal(b.strokes.get('alice:t')!.editor, 'bob');
});

test('text budget: total characters are bounded', () => {
  const b = emptyBoard();
  const n = Math.ceil(MAX_TOTAL_TEXT / MAX_TEXT_LENGTH) + 5;
  for (let i = 0; i < n; i++) appendToStroke(b, textItem(`m:t${i}`, 'm', 'x'.repeat(MAX_TEXT_LENGTH)));
  assert.ok(b.textChars <= MAX_TOTAL_TEXT);
  assert.equal(b.strokes.size, MAX_TOTAL_TEXT / MAX_TEXT_LENGTH);
  removeStrokes(b, ['m:t1']);
  assert.equal(b.textChars, MAX_TOTAL_TEXT - MAX_TEXT_LENGTH);
  // Growing a box through updates is bounded too.
  appendToStroke(b, textItem('m:small', 'm', 'x'.repeat(MAX_TEXT_LENGTH - 10)));
  appendToStroke(b, textItem('m:pad', 'm', 'x'.repeat(8)));
  assert.equal(b.textChars, MAX_TOTAL_TEXT - 2);
  assert.ok(!applyTextUpdate(b, upd('m:small', 'z', 1, 'y'.repeat(MAX_TEXT_LENGTH - 7))));
  assert.ok(applyTextUpdate(b, upd('m:small', 'z', 1, 'y'.repeat(MAX_TEXT_LENGTH - 8))));
  assert.equal(b.textChars, MAX_TOTAL_TEXT);
  clearBoard(b);
  assert.equal(b.textChars, 0);
});

test('world eraser hits strokes and text boxes; text box lookup', () => {
  const b = emptyBoard();
  appendToStroke(b, sanitizeStroke({ id: 'a:s', points: [-1000, 500, 1000, 500], width: 4 }, 'a', WORLD)!);
  appendToStroke(b, textItem('a:t', 'a', 'Hello world', 2000, 2000));
  assert.deepEqual(itemsNearWorld(b, 0, 505, 5), ['a:s']);
  assert.deepEqual(itemsNearWorld(b, 2010, 2010, 5), ['a:t']);
  assert.deepEqual(itemsNearWorld(b, 5000, 5000, 5), []);
  assert.equal(textBoxAt(b, 2020, 2005)?.id, 'a:t');
  assert.equal(textBoxAt(b, 0, 500), undefined);
});

test('content bounds cover strokes (with width) and text boxes', () => {
  const b = emptyBoard();
  assert.equal(contentBounds(b), null);
  appendToStroke(b, sanitizeStroke({ id: 'a:s', points: [-100, -50, 100, 50], width: 10 }, 'a', WORLD)!);
  appendToStroke(b, textItem('a:t', 'a', 'Hi', 300, 300));
  const bounds = contentBounds(b)!;
  assert.equal(bounds.minX, -105);
  assert.equal(bounds.minY, -55);
  assert.ok(bounds.maxX >= 300 && bounds.maxY > 300);
});

test('reading order: top-to-bottom, then left-to-right on the same row', () => {
  const items = [
    textItem('a:c', 'a', 'c', 0, 400),
    textItem('a:b', 'a', 'b', 500, 10), // same row as "a" (slightly lower), but to the right
    textItem('a:a', 'a', 'a', 0, 0),
    textItem('a:d', 'a', 'd', -300, 800),
  ];
  assert.deepEqual(readingOrder(items).map((s) => s.id), ['a:a', 'a:b', 'a:c', 'a:d']);
});


test('ids belong to their author: nobody can claim, extend or overwrite someone else\'s items', () => {
  assert.equal(idAuthor('alice:k1:x'), 'alice');
  assert.equal(idAuthor('nocolon'), null);
  assert.equal(idAuthor(':x'), null);
  // A peer can't send items under someone else's id.
  assert.equal(sanitizeStroke({ id: 'alice:1', points: [0, 0, 1, 1] }, 'mallory', WORLD), null);
  // A relayed sync can add an unknown item but never rewrite an existing drawing.
  const b = emptyBoard();
  appendToStroke(b, sanitizeStroke({ id: 'alice:1', points: [0, 0, 10, 10] }, 'alice', WORLD)!);
  const relayed = sanitizeStroke({ id: 'alice:1', points: [0, 0, 500, 500, 900, 900], color: '#ff0000' }, 'alice', WORLD)!;
  assert.equal(mergeStroke(b, relayed, false), false);
  assert.deepEqual(b.strokes.get('alice:1')!.points, [0, 0, 10, 10]);
  assert.ok(mergeStroke(b, sanitizeStroke({ id: 'alice:2', points: [5, 5] }, 'alice', WORLD)!, false));
  // A forged author field is refused outright.
  assert.equal(mergeStroke(b, { ...relayed, id: 'alice:3', author: 'mallory' }), false);
});

test('text edits through sync obey the same version-jump cap as live edits', () => {
  const b = emptyBoard();
  appendToStroke(b, textItem('alice:t', 'alice', 'one'));
  assert.equal(mergeStroke(b, textItem('alice:t', 'alice', 'huge', 0, 0, { v: MAX_VERSION_JUMP * 3 })), false);
  assert.equal(b.strokes.get('alice:t')!.text, 'one');
  assert.ok(mergeStroke(b, textItem('alice:t', 'alice', 'two', 0, 0, { v: 2 })));
});

test('fit/export bounds ignore a single far-away mark', () => {
  const b = emptyBoard();
  for (let i = 0; i < 5; i++) appendToStroke(b, sanitizeStroke({ id: `a:${i}`, points: [i * 100, 0, i * 100 + 50, 50] }, 'a', WORLD)!);
  appendToStroke(b, sanitizeStroke({ id: 'm:far', points: [WORLD_LIMIT, WORLD_LIMIT] }, 'm', WORLD)!);
  const all = contentBounds(b)!;
  assert.ok(all.maxX - all.minX > MAX_CONTENT_SPAN);
  const f = focusBounds(b)!;
  assert.ok(f.maxX - f.minX <= MAX_CONTENT_SPAN && f.maxY - f.minY <= MAX_CONTENT_SPAN);
  assert.ok(f.minX <= 0 && f.maxX >= 450);
});
