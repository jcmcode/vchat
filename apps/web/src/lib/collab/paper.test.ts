import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PAGES, PAGE_GAP, PAGE_H, PAGE_W, documentHeight, pageAt, pageTop, pagesForContent } from './paper.js';
import { buildPagesPdf } from './export.js';

test('pages: A4 proportions and stacking', () => {
  assert.ok(Math.abs(PAGE_H / PAGE_W - 297 / 210) < 0.002);
  assert.equal(pageTop(0), 0);
  assert.equal(pageTop(2), 2 * (PAGE_H + PAGE_GAP));
  assert.equal(documentHeight(1), PAGE_H);
  assert.equal(documentHeight(3), 3 * PAGE_H + 2 * PAGE_GAP);
});

test('pageAt: on a page, in the gap, beside the pages, past the last page', () => {
  assert.equal(pageAt(10, 10, 2), 0);
  assert.equal(pageAt(PAGE_W / 2, PAGE_H + PAGE_GAP / 2, 2), -1); // gap
  assert.equal(pageAt(PAGE_W / 2, pageTop(1) + 5, 2), 1);
  assert.equal(pageAt(PAGE_W / 2, pageTop(1) + 5, 1), -1); // page 2 doesn't exist yet
  assert.equal(pageAt(-1, 10, 2), -1);
  assert.equal(pageAt(PAGE_W + 1, 10, 2), -1);
  assert.equal(pageAt(10, -1, 2), -1);
});

test('pagesForContent: grows with content, never below 1 or above the cap', () => {
  assert.equal(pagesForContent(null), 1);
  assert.equal(pagesForContent({ minX: 0, minY: 0, maxX: 10, maxY: 100 }), 1);
  assert.equal(pagesForContent({ minX: 0, minY: 0, maxX: 10, maxY: pageTop(1) + 1 }), 2);
  assert.equal(pagesForContent({ minX: 0, minY: 0, maxX: 10, maxY: pageTop(4) + 1 }), 5);
  assert.equal(pagesForContent({ minX: 0, minY: 0, maxX: 10, maxY: 1e9 }), MAX_PAGES);
});

test('multi-page PDF: one A4 page per image, valid xref', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  const pdf = buildPagesPdf(
    [0, 1, 2].map(() => ({ jpeg, width: 1588, height: 2246 })),
    595,
    842
  );
  const text = new TextDecoder('latin1').decode(pdf);
  assert.match(text, /\/Count 3/);
  assert.equal(text.match(/\/MediaBox \[0 0 595 842\]/g)?.length, 3);
  const xrefStart = Number(text.match(/startxref\n(\d+)/)![1]);
  assert.equal(text.slice(xrefStart, xrefStart + 4), 'xref');
  const total = 2 + 3 * 3;
  const entries = text.slice(xrefStart).split('\n').slice(3, 3 + total);
  entries.forEach((line, i) => {
    const offset = Number(line.slice(0, 10));
    assert.ok(text.slice(offset).startsWith(`${i + 1} 0 obj`), `object ${i + 1} offset`);
  });
});
