import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LatestSender } from './latest-sender.js';

function harness<T>(initialState: T, intervalMs = 500, assumed?: T) {
  let now = 1_000;
  let state = initialState;
  const sent: T[] = [];
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let ids = 0;
  const sender = new LatestSender<T>(
    {
      intervalMs,
      read: () => state,
      send: (v) => sent.push(v),
      now: () => now,
      setTimer: (fn, ms) => {
        const id = ++ids;
        timers.push({ at: now + ms, fn, id });
        return id;
      },
      clearTimer: (id) => {
        const i = timers.findIndex((t) => t.id === id);
        if (i >= 0) timers.splice(i, 1);
      },
    },
    assumed
  );
  return {
    sender,
    sent,
    timers,
    set(v: T) {
      state = v;
      sender.notify();
    },
    advance(ms: number) {
      now += ms;
      for (const t of timers.filter((t) => t.at <= now)) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
    },
  };
}

test('first change goes out at once; changes within the interval go out once, at its end, as the latest state', () => {
  const h = harness({ audio: false, video: true });
  h.set({ audio: true, video: true });
  assert.deepEqual(h.sent, [{ audio: true, video: true }]);
  // Hold-to-talk taps: off, on, off within 500ms
  h.advance(100);
  h.set({ audio: false, video: true });
  h.advance(100);
  h.set({ audio: true, video: true });
  h.advance(100);
  h.set({ audio: false, video: true });
  assert.equal(h.sent.length, 1);
  h.advance(200); // 500ms after the first send
  assert.deepEqual(h.sent, [{ audio: true, video: true }, { audio: false, video: true }]);
});

test('never more than one message per interval, and the final state always arrives', () => {
  const h = harness(false, 500);
  let v = false;
  for (let i = 0; i < 100; i++) {
    v = !v;
    h.set(v);
    h.advance(37);
  }
  h.advance(1000);
  assert.ok(h.sent.length <= Math.ceil((100 * 37 + 1000) / 500) + 1, `sent ${h.sent.length}`);
  assert.equal(h.sent.at(-1), v);
});

test('an unchanged state is not sent again, including what receivers already assume', () => {
  const h = harness(false, 300, false);
  h.set(false);
  assert.deepEqual(h.sent, []);
  h.set(true);
  h.advance(50);
  h.set(false); // back to what was sent? no: true was sent; false is new
  h.advance(300);
  assert.deepEqual(h.sent, [true, false]);
  h.advance(50);
  h.set(true);
  h.advance(10);
  h.set(false); // flipped back before the trailing send: nothing new to say
  h.advance(300);
  assert.deepEqual(h.sent, [true, false]);
});

test('cancel and reset drop a scheduled send', () => {
  const h = harness(0, 500);
  h.set(1);
  h.set(2);
  assert.equal(h.timers.length, 1);
  h.sender.cancel();
  assert.equal(h.timers.length, 0);
  h.advance(1000);
  assert.deepEqual(h.sent, [1]);
  h.set(3);
  h.set(4);
  h.sender.reset(0);
  h.advance(1000);
  assert.deepEqual(h.sent, [1, 3]);
  h.set(0); // what receivers assume after a reset
  assert.deepEqual(h.sent, [1, 3]);
});
