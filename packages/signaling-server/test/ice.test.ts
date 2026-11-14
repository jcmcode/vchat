import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getIceServers } from '../src/core/index.js';

test('Cloudflare TURN: drops port-53 URLs and entries left empty', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        iceServers: [
          { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
          { urls: 'turn:turn.cloudflare.com:53?transport=udp', username: 'u', credential: 'c' },
          { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' },
        ],
      }),
      { status: 201 }
    )) as typeof fetch;
  try {
    const { iceServers } = await getIceServers({ CF_TURN_KEY_ID: 'k', CF_TURN_API_TOKEN: 't' });
    assert.deepEqual(
      iceServers.map((s) => s.urls),
      [['stun:stun.cloudflare.com:3478'], ['turn:turn.cloudflare.com:3478?transport=udp']]
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('coturn REST credentials: expiring username + HMAC password', async () => {
  const { iceServers, ttl } = await getIceServers({ TURN_URLS: 'turn:a:3478', TURN_SECRET: 's', TURN_TTL_SECONDS: '60' });
  const turn = iceServers.find((s) => s.username);
  assert.ok(turn);
  const expiry = Number(turn.username!.split(':')[0]);
  assert.ok(Math.abs(expiry - (Date.now() / 1000 + 60)) < 5);
  assert.match(turn.credential!, /^[A-Za-z0-9+/]+=*$/);
  assert.equal(ttl, 60);
});

test('no TURN configured: STUN only', async () => {
  const { iceServers } = await getIceServers({});
  assert.equal(iceServers.length, 1);
  assert.ok(!iceServers[0].username);
});
