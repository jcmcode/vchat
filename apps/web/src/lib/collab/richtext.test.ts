import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutRichText, parseInline, parseRichText, plainText, toggleInline, toggleList, type Measure } from './richtext.js';

const mono: Measure = (text, size) => text.length * size * 0.5;
const runs = (s: string) => parseInline(s).map((r) => `${r.b ? 'B' : ''}${r.i ? 'I' : ''}${r.u ? 'U' : ''}:${r.text}`);

test('inline markers: bold, italic, underline, combined, unmatched and escaped', () => {
  assert.deepEqual(runs('a **b** c'), [':a ', 'B:b', ': c']);
  assert.deepEqual(runs('_it_ and __un__'), ['I:it', ': and ', 'U:un']);
  assert.deepEqual(runs('**_both_**'), ['BI:both']);
  assert.deepEqual(runs('___x___'), ['IU:x']);
  assert.deepEqual(runs('2 ** 3 and snake_case_name'), [':2 ** 3 and snake_case_name']);
  assert.deepEqual(runs('**open'), [':**open']);
  assert.deepEqual(runs('\\*\\*not bold\\*\\*'), [':**not bold**']);
  assert.deepEqual(runs(''), []);
});

test('lists: bullets and numbered lines (consecutive numbers count up)', () => {
  const lines = parseRichText('Title\n- one\n* two\n1. first\n1. second\nend\n5) five');
  assert.deepEqual(
    lines.map((l) => [l.kind, l.num ?? null, l.runs.map((r) => r.text).join('')]),
    [
      ['p', null, 'Title'],
      ['bullet', null, 'one'],
      ['bullet', null, 'two'],
      ['number', 1, 'first'],
      ['number', 2, 'second'],
      ['p', null, 'end'],
      ['number', 5, 'five'],
    ]
  );
  assert.equal(plainText('- **a**\n2. b'), '• a\n2. b');
});

test('layout wraps words to the box width and breaks long words', () => {
  // size 10, mono 5 units per char; box 50 units = 10 chars
  const l = layoutRichText(parseRichText('hello world again'), 10, 50, mono);
  assert.deepEqual(l.lines.map((x) => x.segments.map((s) => s.text).join('')), ['hello', 'world', 'again']);
  assert.ok(l.width <= 50);
  assert.equal(l.height, 3 * 10 * 1.35);
  const long = layoutRichText(parseRichText('abcdefghijklmnopqrstuvwxy'), 10, 50, mono);
  assert.deepEqual(long.lines.map((x) => x.segments.map((s) => s.text).join('')), ['abcdefghij', 'klmnopqrst', 'uvwxy']);
  const list = layoutRichText(parseRichText('- item'), 10, 200, mono);
  assert.equal(list.lines[0].marker?.text, '•');
  assert.ok(list.lines[0].segments[0].x > 0); // indented
  const empty = layoutRichText(parseRichText(''), 10, 100, mono);
  assert.equal(empty.lines.length, 1);
});

test('format bar: toggling inline markers on a selection', () => {
  let e = toggleInline('make this bold', 5, 9, '**');
  assert.equal(e.text, 'make **this** bold');
  assert.equal(e.text.slice(e.selStart, e.selEnd), 'this');
  e = toggleInline(e.text, e.selStart, e.selEnd, '**');
  assert.equal(e.text, 'make this bold');
  // Selecting the markers too also unwraps.
  e = toggleInline('**x**', 0, 5, '**');
  assert.equal(e.text, 'x');
  // Whitespace stays outside the markers.
  e = toggleInline('a word b', 1, 7, '_');
  assert.equal(e.text, 'a _word_ b');
  // Empty selection inserts a pair and puts the caret inside.
  e = toggleInline('ab', 1, 1, '__');
  assert.equal(e.text, 'a____b');
  assert.equal(e.selStart, 3);
  // Italic and underline can be combined and removed independently.
  e = toggleInline('x', 0, 1, '__');
  e = toggleInline(e.text, e.selStart, e.selEnd, '_');
  assert.equal(e.text, '___x___');
  assert.deepEqual(runs(e.text), ['IU:x']);
  e = toggleInline(e.text, e.selStart, e.selEnd, '__');
  assert.equal(e.text, '_x_');
});

test('format bar: toggling bullet and numbered lists on lines', () => {
  let e = toggleList('one\ntwo\nthree', 0, 7, 'bullet');
  assert.equal(e.text, '- one\n- two\nthree');
  e = toggleList(e.text, 0, 11, 'bullet');
  assert.equal(e.text, 'one\ntwo\nthree');
  e = toggleList('a\nb', 0, 3, 'number');
  assert.equal(e.text, '1. a\n2. b');
  // Switching kinds replaces the prefix.
  e = toggleList(e.text, 0, e.text.length, 'bullet');
  assert.equal(e.text, '- a\n- b');
  // Caret only: just the current line, caret moves with the text.
  e = toggleList('x\nhello', 4, 4, 'bullet');
  assert.equal(e.text, 'x\n- hello');
  assert.equal(e.selStart, 6);
});

test('Enter continues and ends lists', async () => {
  const { continueList } = await import('./richtext.js');
  let e = continueList('- one', 5)!;
  assert.equal(e.text, '- one\n- ');
  assert.equal(e.selStart, 8);
  e = continueList(e.text, e.selStart)!;
  assert.equal(e.text, '- one\n');
  e = continueList('9. nine', 7)!;
  assert.equal(e.text, '9. nine\n10. ');
  assert.equal(continueList('plain', 5), null);
});

test('a huge unbroken word is wrapped in linear time (no per-character re-measuring)', () => {
  let calls = 0;
  let chars = 0;
  const counting: Measure = (text, size) => {
    calls++;
    chars += text.length;
    return text.length * size * 0.6;
  };
  const word = 'x'.repeat(4000) + 'y'.repeat(4000);
  const l = layoutRichText(parseRichText(word), 10, 200, counting);
  // Every character lands on some line, in order.
  assert.equal(l.lines.flatMap((line) => line.segments.map((s) => s.text)).join(''), word);
  assert.ok(l.lines.every((line) => line.segments.reduce((w, s) => w + s.width, 0) <= 200 + 1e-9));
  // The word is measured once whole and each distinct character once: not once per character.
  assert.ok(calls <= 4, `measure called ${calls} times`);
  assert.ok(chars <= word.length + 2, `measured ${chars} characters`);
});
