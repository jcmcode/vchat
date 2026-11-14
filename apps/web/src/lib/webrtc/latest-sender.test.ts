import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LatestSender } from './latest-sender.js';

function harness<T>(initialState: T, intervalMs = 500, assumed?: T, latch?: (value: T, lastSent: T | undefined) => boolean) {
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
      latch,
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

type Media = { audio: boolean; video: boolean };
const micOrCameraCameOn = (s: Media, sent: Media | undefined) => (s.audio && !sent?.audio) || (s.video && !sent?.video);

test('latch: a hold-to-talk tap inside the quiet period is still announced, then the current state', () => {
  const muted = { audio: false, video: true };
  const live = { audio: true, video: true };
  const h = harness<Media>(muted, 500, undefined, micOrCameraCameOn);
  h.set(muted); // first send (receivers assume nothing yet)
  assert.deepEqual(h.sent, [muted]);
  h.advance(100);
  h.set(live); // a quick tap: on…
  h.advance(150);
  h.set(muted); // …and off again before the interval is up
  h.advance(250); // interval over: the tap must not vanish
  assert.deepEqual(h.sent, [muted, live]);
  h.advance(500); // then the current state follows
  assert.deepEqual(h.sent, [muted, live, muted]);
  h.advance(2000);
  assert.equal(h.sent.length, 3, 'nothing more to say');
});

test('latch: the tap is announced even if something else changed in the same window', () => {
  const start = { audio: false, video: true };
  const h = harness<Media>(start, 500, start, micOrCameraCameOn);
  h.set({ audio: false, video: false }); // camera off: goes out at once
  h.advance(100);
  h.set({ audio: true, video: false }); // tap on
  h.advance(100);
  h.set({ audio: false, video: false }); // tap off
  h.advance(300);
  assert.deepEqual(h.sent, [
    { audio: false, video: false },
    { audio: true, video: false },
  ]);
  h.advance(500);
  assert.deepEqual(h.sent.at(-1), { audio: false, video: false });
});

test('latch: a quick mute is not forced out (only turning something on is)', () => {
  const live = { audio: true, video: true };
  const h = harness<Media>(live, 500, undefined, micOrCameraCameOn);
  h.set(live);
  h.advance(100);
  h.set({ audio: false, video: true });
  h.advance(100);
  h.set(live);
  h.advance(1000);
  assert.deepEqual(h.sent, [live]);
});

test('latch: rapid taps never exceed one message per interval', () => {
  const h = harness<Media>({ audio: false, video: false }, 500, { audio: false, video: false }, micOrCameraCameOn);
  let on = false;
  for (let i = 0; i < 60; i++) {
    on = !on;
    h.set({ audio: on, video: false });
    h.advance(45);
  }
  h.advance(2000);
  assert.ok(h.sent.length <= Math.ceil((60 * 45 + 2000) / 500) + 1, `sent ${h.sent.length}`);
  assert.deepEqual(h.sent.at(-1), { audio: on, video: false });
});
