import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AttentionController,
  CHIME_MIN_INTERVAL_MS,
  FLASH_INTERVAL_MS,
  NOTIFY_MIN_INTERVAL_MS,
  WAITING_NOTIFICATION_BODY,
  WAITING_NOTIFICATION_TITLE,
  waitingTitle,
  type AttentionEnv,
} from './ui/attention.js';

/** A fake browser: a clock, a tab that can be in front or behind, a title and a timer. */
function fakeEnv() {
  const state = {
    now: 1_000_000,
    background: false,
    allowed: true,
    title: 'vchat',
    chimes: 0,
    notifications: 0,
    cleared: 0,
    timer: null as null | (() => void),
  };
  const env: AttentionEnv = {
    now: () => state.now,
    inBackground: () => state.background,
    getTitle: () => state.title,
    setTitle: (t) => {
      state.title = t;
    },
    chime: () => state.chimes++,
    notificationsAllowed: () => state.allowed,
    notify: () => state.notifications++,
    clearNotification: () => state.cleared++,
    setInterval: (fn) => {
      assert.equal(state.timer, null, 'only one flash timer at a time');
      state.timer = fn;
      return 1;
    },
    clearInterval: () => {
      state.timer = null;
    },
  };
  const tick = () => {
    state.now += FLASH_INTERVAL_MS;
    state.timer?.();
  };
  return { state, env, tick };
}

test('attention: a new request chimes; a burst chimes once; the same people again do not chime', () => {
  const { state, env } = fakeEnv();
  const a = new AttentionController(env);
  a.update(['p1']);
  assert.equal(state.chimes, 1);
  a.update(['p1', 'p2']);
  a.update(['p1', 'p2', 'p3']);
  assert.equal(state.chimes, 1, 'throttled');
  a.update(['p1', 'p2', 'p3']);
  state.now += CHIME_MIN_INTERVAL_MS;
  a.update(['p1', 'p2', 'p3']);
  assert.equal(state.chimes, 1, 'nobody new');
  a.update(['p2', 'p3', 'p4']);
  assert.equal(state.chimes, 2);
});

test('attention: nothing visible changes while the tab is in front', () => {
  const { state, env } = fakeEnv();
  const a = new AttentionController(env);
  a.update(['p1']);
  assert.equal(state.title, 'vchat');
  assert.equal(state.timer, null);
  assert.equal(state.notifications, 0);
});

test('attention: in the background the title flashes the count, and is restored on focus', () => {
  const { state, env, tick } = fakeEnv();
  state.title = 'Team call';
  state.background = true;
  const a = new AttentionController(env);
  a.update(['p1']);
  assert.equal(state.title, '(1) Waiting to join · Team call');
  tick();
  assert.equal(state.title, 'Team call');
  tick();
  assert.equal(state.title, waitingTitle(1, 'Team call'));
  a.update(['p1', 'p2']);
  assert.equal(state.title, '(2) Waiting to join · Team call', 'the count updates right away');

  state.background = false;
  a.visibilityChanged();
  assert.equal(state.title, 'Team call');
  assert.equal(state.timer, null);
  assert.ok(state.cleared > 0, 'notification closed when the tab is back in front');

  // Hidden again with people still waiting: flashing resumes.
  state.background = true;
  a.visibilityChanged();
  assert.equal(state.title, '(2) Waiting to join · Team call');
});

test('attention: the title is restored when the queue empties, and on destroy', () => {
  const { state, env, tick } = fakeEnv();
  state.background = true;
  const a = new AttentionController(env);
  a.update(['p1']);
  tick();
  tick();
  a.update([]);
  assert.equal(state.title, 'vchat');
  assert.equal(state.timer, null);

  a.update(['p2']);
  assert.notEqual(state.title, 'vchat');
  a.destroy();
  assert.equal(state.title, 'vchat');
  assert.equal(state.timer, null);
});

test('attention: a title the page sets while flashing is kept, not overwritten on restore', () => {
  const { state, env, tick } = fakeEnv();
  state.background = true;
  const a = new AttentionController(env);
  a.update(['p1']);
  state.title = 'Renamed room'; // the page changed its own title
  tick();
  assert.equal(state.title, 'Renamed room');
  tick();
  assert.equal(state.title, '(1) Waiting to join · Renamed room');
  a.update([]);
  assert.equal(state.title, 'Renamed room');
});

test('attention: notifications only in the background, only when allowed, and throttled', () => {
  const { state, env } = fakeEnv();
  const a = new AttentionController(env);
  a.update(['p1']);
  assert.equal(state.notifications, 0, 'tab in front');

  state.background = true;
  state.allowed = false;
  state.now += NOTIFY_MIN_INTERVAL_MS;
  a.update(['p1', 'p2']);
  assert.equal(state.notifications, 0, 'not opted in');

  state.allowed = true;
  a.update(['p1', 'p2', 'p3']);
  assert.equal(state.notifications, 1);
  a.update(['p1', 'p2', 'p3', 'p4']);
  assert.equal(state.notifications, 1, 'throttled');
  state.now += NOTIFY_MIN_INTERVAL_MS;
  a.update(['p1', 'p2', 'p3', 'p4', 'p5']);
  assert.equal(state.notifications, 2);
  const cleared = state.cleared;
  a.update([]);
  assert.ok(state.cleared > cleared, 'closed when nobody is waiting any more');
});

test('attention: notification text is generic (no names, emails or room names)', () => {
  assert.equal(WAITING_NOTIFICATION_TITLE, 'Someone is waiting to join your call');
  assert.equal(WAITING_NOTIFICATION_BODY, 'Go back to the call to let them in.');
});
