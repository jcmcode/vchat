import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHandMessage, RaisedHands, RateLimiter } from './hand-model.js';

test('hand messages: exactly { type: "hand", raised: boolean }', () => {
  assert.equal(parseHandMessage({ type: 'hand', raised: true }), true);
  assert.equal(parseHandMessage({ type: 'hand', raised: false }), false);
  // Wrong shapes
  for (const bad of [
    null,
    undefined,
    'hand',
    42,
    [],
    {},
    { type: 'hand' },
    { type: 'hand', raised: 'true' },
    { type: 'hand', raised: 1 },
    { type: 'hand', raised: null },
    { type: 'hands', raised: true },
    // No extra fields: nobody can name another person or smuggle text through
    { type: 'hand', raised: true, peerId: 'someone-else' },
    { type: 'hand', raised: true, name: 'Admin' },
    JSON.parse('{"type":"hand","raised":true,"__proto__":{"x":1}}'),
  ]) {
    assert.equal(parseHandMessage(bad), null, JSON.stringify(bad));
  }
});

test('rate limiter: burst, then refill per second, per key', () => {
  const rl = new RateLimiter(2, 3);
  assert.equal(rl.allow('a', 0), true);
  assert.equal(rl.allow('a', 0), true);
  assert.equal(rl.allow('a', 0), true);
  assert.equal(rl.allow('a', 0), false);
  assert.equal(rl.allow('b', 0), true); // separate bucket
  assert.equal(rl.allow('a', 400), false);
  assert.equal(rl.allow('a', 600), true); // a token back after half a second at 2/s
  // A clock going backwards never adds tokens
  assert.equal(rl.allow('a', 0), false);
  rl.forget('a');
  assert.equal(rl.allow('a', 0), true);
});

const opts = { perSecond: 5, burst: 10, toastCooldownMs: 5000, syncGraceMs: 2500 };

test('raise and lower: state changes, a notice only when a hand goes up', () => {
  const h = new RaisedHands(opts);
  assert.deepEqual(h.receive('alex', { type: 'hand', raised: true }, 10_000), { raised: true, toast: true });
  assert.equal(h.has('alex'), true);
  assert.equal(h.receive('alex', { type: 'hand', raised: true }, 10_100), null); // no change
  assert.deepEqual(h.receive('alex', { type: 'hand', raised: false }, 10_200), { raised: false, toast: false });
  assert.equal(h.has('alex'), false);
  assert.equal(h.receive('alex', { type: 'hand', raised: false }, 10_300), null); // already down
  assert.deepEqual(h.list(), []);
});

test('notices: none for the catch-up state a new connection sends, at most one per person per cooldown', () => {
  const h = new RaisedHands(opts);
  h.connected('sam', 0);
  assert.deepEqual(h.receive('sam', { type: 'hand', raised: true }, 100), { raised: true, toast: false });
  h.receive('sam', { type: 'hand', raised: false }, 3000);
  assert.deepEqual(h.receive('sam', { type: 'hand', raised: true }, 3100), { raised: true, toast: true });
  h.receive('sam', { type: 'hand', raised: false }, 3200);
  assert.deepEqual(h.receive('sam', { type: 'hand', raised: true }, 4000), { raised: true, toast: false }); // within 5s
  h.receive('sam', { type: 'hand', raised: false }, 8000);
  assert.deepEqual(h.receive('sam', { type: 'hand', raised: true }, 8200), { raised: true, toast: true });
});

test('floods are dropped per peer; malformed messages use up the allowance too', () => {
  const h = new RaisedHands(opts);
  let accepted = 0;
  for (let i = 0; i < 100; i++) {
    if (h.receive('mallory', { type: 'hand', raised: i % 2 === 0 }, 1000)) accepted++;
  }
  assert.equal(accepted, 10); // the burst
  // Others are unaffected
  assert.deepEqual(h.receive('alex', { type: 'hand', raised: true }, 1000), { raised: true, toast: true });

  const h2 = new RaisedHands(opts);
  for (let i = 0; i < 10; i++) h2.receive('mallory', { type: 'junk' }, 0);
  assert.equal(h2.receive('mallory', { type: 'hand', raised: true }, 0), null);
  assert.ok(h2.receive('mallory', { type: 'hand', raised: true }, 1000)); // refilled
});

test('leaving lowers the hand; leaving the room clears everyone', () => {
  const h = new RaisedHands(opts);
  h.receive('a', { type: 'hand', raised: true }, 0);
  h.receive('b', { type: 'hand', raised: true }, 0);
  assert.equal(h.remove('a'), true);
  assert.equal(h.remove('a'), false);
  assert.deepEqual(h.list(), ['b']);
  h.clear();
  assert.deepEqual(h.list(), []);
});
