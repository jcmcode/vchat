import { test } from 'node:test';
import assert from 'node:assert/strict';
import { largestBoxes, viewReport, VIEW_QUANTUM, type Measured } from './view-size.js';

const tile = (over: Partial<Measured>): Measured => ({ peerId: 'a', fit: 'cover', enabled: true, w: 640, h: 360, visible: true, ...over });

test('view size: the biggest shown tile per person counts; hidden, disabled and empty ones do not', () => {
  const boxes = largestBoxes([
    tile({ w: 464, h: 290 }), // strip thumbnail
    tile({ w: 1600, h: 900, fit: 'contain' }), // on the stage
    tile({ w: 3000, h: 2000, enabled: false }), // showing their screen, not their camera
    tile({ peerId: 'b', w: 800, h: 450, visible: false }), // in a hidden tab
    tile({ peerId: 'c', w: 0, h: 0 }), // not laid out
    tile({ peerId: 'd', w: 320, h: 180 }),
  ]);
  assert.deepEqual(boxes.get('a'), { w: 1600, h: 900, fit: 'contain' });
  assert.equal(boxes.has('b'), false);
  assert.equal(boxes.has('c'), false);
  assert.deepEqual(boxes.get('d'), { w: 320, h: 180, fit: 'cover' });
});

test('view size: reports are rounded up (no churn on tiny layout shifts), and "not shown" is 0x0', () => {
  assert.deepEqual(viewReport(undefined), { w: 0, h: 0 });
  assert.deepEqual(viewReport({ w: 463.5, h: 290, fit: 'cover' }), { w: 480, h: 320, fit: 'cover' });
  assert.deepEqual(viewReport({ w: 470, h: 300, fit: 'cover' }), viewReport({ w: 463, h: 289, fit: 'cover' }));
  assert.deepEqual(viewReport({ w: 1, h: 1, fit: 'contain' }), { w: VIEW_QUANTUM, h: VIEW_QUANTUM, fit: 'contain' });
  assert.deepEqual(viewReport({ w: 1e9, h: 1e9, fit: 'cover' }), { w: 16_384, h: 16_384, fit: 'cover' });
});
