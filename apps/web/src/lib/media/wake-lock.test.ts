import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWakeLock, type WakeLockEnv } from './wake-lock.js';
import { deferred, flush } from './fake-media.test-helpers.js';

class FakeSentinel {
  released = false;
  private onRelease: (() => void)[] = [];
  async release() {
    if (this.released) return;
    this.released = true;
    for (const fn of this.onRelease) fn();
  }
  addEventListener(_type: 'release', fn: () => void) {
    this.onRelease.push(fn);
  }
}

function fakeEnv(opts: { supported?: boolean; fail?: boolean } = {}) {
  const sentinels: FakeSentinel[] = [];
  const listeners = new Set<() => void>();
  let gate: Promise<void> | null = null;
  const env = {
    wakeLock:
      opts.supported === false
        ? undefined
        : {
            async request() {
              if (gate) await gate;
              if (opts.fail) throw Object.assign(new Error('nope'), { name: 'NotAllowedError' });
              const s = new FakeSentinel();
              sentinels.push(s);
              return s;
            },
          },
    document: {
      visibilityState: 'visible',
      addEventListener: (_t: 'visibilitychange', fn: () => void) => listeners.add(fn),
      removeEventListener: (_t: 'visibilitychange', fn: () => void) => listeners.delete(fn),
    },
  };
  const setVisible = (visible: boolean) => {
    env.document.visibilityState = visible ? 'visible' : 'hidden';
    // The browser drops the lock when the page is hidden.
    if (!visible) for (const s of sentinels) void s.release();
    for (const fn of listeners) fn();
  };
  return { env: env as WakeLockEnv, sentinels, listeners, setVisible, hold: (p: Promise<void>) => (gate = p) };
}

test('holds the screen on, re-acquires when the page is visible again, and lets go on disable', async () => {
  const f = fakeEnv();
  const lock = createWakeLock(() => f.env);
  await lock.enable();
  assert.equal(lock.active, true);
  assert.equal(f.sentinels.length, 1);

  f.setVisible(false);
  assert.equal(lock.active, false);
  f.setVisible(true);
  await flush();
  assert.equal(lock.active, true);
  assert.equal(f.sentinels.length, 2);

  lock.disable();
  assert.equal(lock.active, false);
  assert.ok(f.sentinels.every((s) => s.released));
  assert.equal(f.listeners.size, 0);
  f.setVisible(true); // no longer listening: nothing new is requested
  await flush();
  assert.equal(f.sentinels.length, 2);
});

test('a lock granted after leaving is released at once', async () => {
  const f = fakeEnv();
  const gate = deferred<void>();
  f.hold(gate.promise);
  const lock = createWakeLock(() => f.env);
  const enabling = lock.enable();
  lock.disable();
  gate.resolve();
  await enabling;
  assert.equal(f.sentinels.length, 1);
  assert.equal(f.sentinels[0].released, true);
  assert.equal(lock.active, false);
});

test('unsupported or refused: no errors, nothing held', async () => {
  for (const opts of [{ supported: false }, { fail: true }]) {
    const f = fakeEnv(opts);
    const lock = createWakeLock(() => f.env);
    await lock.enable();
    assert.equal(lock.active, false);
    lock.disable();
  }
  const none = createWakeLock(() => null);
  await none.enable();
  none.disable();
  assert.equal(none.active, false);
});
