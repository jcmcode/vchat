// Regression tests for the second security review (throttles, identity takeover, remove-peer,
// token malleability, fail-closed config, TURN credentials, names, nothing-stored metadata).
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AttemptCounter,
  CLOSE_REMOVED,
  DEFAULT_TURN_TTL,
  LoginThrottle,
  MAX_PEERS_PER_ROOM,
  PasswordThrottle,
  Room,
  WAITING_TIMEOUT_MS,
  authorizeJoin,
  authorizeSocket,
  base64UrlDecode,
  getIceServers,
  handleApi,
  hashRoomPassword,
  cleanInviteMessage,
  icsFold,
  icsText,
  ipKey,
  nameKey,
  parseClientMessage,
  resolveConfig,
  signToken,
  throttleClientId,
  verifyToken,
  type RoomMeta,
  type ServerEnv,
  type Transport,
} from '../src/core/index.js';

const SECRET = 'k'.repeat(64);
const env: ServerEnv = { SECRET_KEY: SECRET, ADMIN_PASSWORD: 'correct horse battery' };
const now = () => Math.floor(Date.now() / 1000);

class Conn {
  open = true;
  closedWith?: number;
  inbox: any[] = [];
  last(type?: string) {
    const m = type ? this.inbox.filter((x) => x.type === type) : this.inbox;
    return m[m.length - 1];
  }
}
const transport: Transport<Conn> = {
  send: (c, d) => c.inbox.push(JSON.parse(d)),
  isOpen: (c) => c.open,
  close: (c, code) => {
    c.open = false;
    c.closedWith = code;
  },
};
const HOST = { role: 'host' as const, approval: false };
const GUEST = { role: 'guest' as const, approval: false };
const GUEST_APPROVAL = { role: 'guest' as const, approval: true };
const who = (peerId: string, secret = `${peerId}-s`) => ({ peerId, displayName: peerId, secret });

// ── 1. Login throttle ─────────────────────────────────────────────────────────

function fakeThrottle(maxKeys = 10_000) {
  let t = 1_000_000;
  const sleeps: number[] = [];
  const throttle = new LoginThrottle({
    windowMs: 15 * 60 * 1000,
    perClient: 10,
    globalSoft: 100,
    spacingMs: 2000,
    maxWaitMs: 10_000,
    maxKeys,
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { throttle, sleeps, advance: (ms: number) => (t += ms) };
}

test('login throttle: a 25k rotating-IP probe gets ~100 real checks, not a reset global counter', async () => {
  const { throttle } = fakeThrottle();
  let checks = 0;
  for (let i = 0; i < 25_000; i++) {
    const ip = `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
    if (await throttle.acquire(ip)) checks++;
  }
  // 100 immediate + the few that fit in the 10s slowdown queue.
  assert.ok(checks <= 106, `got ${checks} checks`);
  assert.ok(checks >= 100);
  assert.ok(throttle.trackedClients <= 10_000);
});

test('login throttle: global slowdown, not lockout — the owner gets in once the queue drains', async () => {
  const { throttle, sleeps, advance } = fakeThrottle();
  for (let i = 0; i < 100; i++) assert.equal(await throttle.acquire(`1.1.${i >> 8}.${i & 255}`), true);
  assert.equal(await throttle.acquire('2.2.2.2'), true); // slowed, not refused
  assert.equal(sleeps.length, 0); // first slot is immediate
  assert.equal(await throttle.acquire('2.2.2.3'), true);
  assert.deepEqual(sleeps, [2000]);
  advance(30_000);
  assert.equal(await throttle.acquire('3.3.3.3'), true); // owner, later
});

test('login throttle: per-client limit, IPv6 grouped by /64, refunds delete empty keys, sweep forgets IPs', async () => {
  const { throttle, advance } = fakeThrottle();
  for (let i = 0; i < 10; i++) assert.equal(await throttle.acquire(`2001:db8:1:2::${i.toString(16)}`), true);
  assert.equal(await throttle.acquire('2001:db8:1:2:ffff::1'), false); // same /64
  assert.equal(await throttle.acquire('2001:db8:1:3::1'), true);
  const before = throttle.trackedClients;
  await throttle.acquire('9.9.9.9');
  throttle.succeeded('9.9.9.9');
  assert.equal(throttle.trackedClients, before); // empty after refund -> deleted
  advance(16 * 60 * 1000);
  throttle.sweep();
  assert.equal(throttle.trackedClients, 0);
});

test('ipKey: IPv4, IPv6 /64, mapped IPv4, brackets and zones', () => {
  assert.equal(ipKey('1.2.3.4'), '1.2.3.4');
  assert.equal(ipKey('2001:db8:aa:bb:1:2:3:4'), '2001:db8:aa:bb::/64');
  assert.equal(ipKey('2001:DB8:aa:bb::9'), '2001:db8:aa:bb::/64');
  assert.equal(ipKey('::ffff:5.6.7.8'), '5.6.7.8');
  assert.equal(ipKey('[fe80::1%eth0]'), 'fe80:0:0:0::/64');
  assert.equal(ipKey(undefined), 'unknown');
});

test('AttemptCounter: overflow evicts stale keys first, then the oldest', () => {
  const c = new AttemptCounter(1000, 3);
  c.take('stale', 5, 0);
  c.take('a', 5, 5000);
  c.take('b', 5, 5001);
  c.take('c', 5, 5002); // overflow: 'stale' (outside the window) goes first
  assert.equal(c.count('stale', 5002), 0);
  assert.equal(c.count('a', 5002), 1);
  c.take('d', 5, 5003); // nothing stale: oldest ('a') goes
  assert.equal(c.count('a', 5003), 0);
  assert.equal(c.count('b', 5003), 1);
});

test('AttemptCounter: a refund gives back one attempt even when others remain', () => {
  const c = new AttemptCounter(60_000);
  for (let i = 0; i < 3; i++) c.take('k', 3, 1000 + i);
  assert.equal(c.take('k', 3, 1010), false);
  c.refund('k', 1011);
  assert.equal(c.count('k', 1011), 2);
  assert.equal(c.take('k', 3, 1012), true);
  c.refund('other', 1013); // nothing to refund: no-op
  assert.equal(c.count('other', 1013), 0);
});

// ── 2. peerId takeover ────────────────────────────────────────────────────────

test('peerId takeover: an admitted identity is refused to anyone with another secret, even offline', async () => {
  const room = new Room<Conn>('take', transport);
  const h = new Conn();
  await room.enter(h, who('h'), HOST);
  const g = new Conn();
  await room.enter(g, who('g'), GUEST);
  room.leave(g); // g goes offline
  const thief = new Conn();
  await room.enter(thief, who('g', 'other-secret'), GUEST);
  assert.equal(thief.last().message, 'Peer ID already in use');
  // The real g comes back fine.
  const g2 = new Conn();
  await room.enter(g2, who('g'), GUEST);
  assert.equal(g2.last('room-peers').type, 'room-peers');
});

test('peerId takeover: a guest can never step into the host identity; a host grant can reclaim any', async () => {
  const room = new Room<Conn>('take2', transport);
  const h = new Conn();
  await room.enter(h, who('h'), HOST);
  const g = new Conn();
  await room.enter(g, who('g'), GUEST);
  const fake = new Conn();
  await room.enter(fake, who('h'), GUEST); // even with the right secret
  assert.equal(fake.last().message, 'Peer ID already in use');
  assert.equal(h.open, true);

  // A guest squats on a peerId; the owner (host grant, different secret) replaces it.
  const squat = new Conn();
  await room.enter(squat, who('owner2', 'squatter'), GUEST);
  const owner = new Conn();
  await room.enter(owner, who('owner2', 'owner-secret'), HOST);
  assert.equal(squat.open, false);
  assert.equal(room.meta.admitted.owner2.r, 'host');
});

test('peerId takeover: cycling fresh peerIds never evicts the host entry', async () => {
  const room = new Room<Conn>('cycle', transport);
  const h = new Conn();
  await room.enter(h, who('h'), HOST);
  const g = new Conn();
  await room.enter(g, who('g'), GUEST);
  room.leave(h); // host away; the room stays alive because of the guest
  const attacker = new Conn();
  for (let i = 0; i < 200; i++) await room.enter(attacker, who(`x${i}`, `s${i}`), GUEST);
  assert.equal(room.meta.admitted.h?.r, 'host');
  assert.ok(Object.keys(room.meta.admitted).length <= 50);
});

// ── 3. Room-password throttle ─────────────────────────────────────────────────

test('room password: limited per room + client, other clients unaffected, per-room backstop', async () => {
  const pw = await hashRoomPassword(SECRET, 'pwroom', 'right');
  const invite = await signToken(SECRET, { role: 'guest', room: 'pwroom', exp: now() + 600, pw });
  const tryPw = (clientId: string, password = 'wrong') => authorizeJoin(env, { roomId: 'pwroom', token: invite, password }, { clientId });
  for (let i = 0; i < 10; i++) assert.deepEqual(await tryPw('A'), { ok: false, passwordRequired: true, invalid: true });
  assert.deepEqual(await tryPw('A'), { ok: false, error: 'Too many password attempts' });
  assert.equal((await tryPw('B', 'right')).ok, true);

  const t = new PasswordThrottle(60_000, 10, 200);
  for (let i = 0; i < 200; i++) assert.equal(t.take('r', `c${i}`), true);
  assert.equal(t.take('r', 'fresh'), false);
  assert.equal(t.take('other-room', 'fresh'), true);
});

test('room password: open mode is throttled the same way', async () => {
  const room = new Room<Conn>('openpw', transport);
  await room.create(new Conn(), { ...who('h'), password: 'hunter2' });
  const g = new Conn();
  for (let i = 0; i < 10; i++) await room.join(g, { ...who('g'), password: 'nope', clientId: 'C' });
  assert.equal(g.last().invalid, true);
  await room.join(g, { ...who('g'), password: 'hunter2', clientId: 'C' });
  assert.equal(g.last().message, 'Too many password attempts');
  const g2 = new Conn();
  await room.join(g2, { ...who('g2'), password: 'hunter2', clientId: 'D' });
  assert.equal(g2.last().type, 'waiting-for-admission');
});

// ── 5. Token malleability ─────────────────────────────────────────────────────

test('tokens: only strict, canonical base64url is accepted', async () => {
  const t = await signToken(SECRET, { role: 'guest', room: 'abc', exp: now() + 60 });
  const [body, sig] = t.split('.');
  assert.ok((await verifyToken(SECRET, t)).ok);
  // The last signature character carries 2 spare bits: flipping them must break the token.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const last = alphabet.indexOf(sig.at(-1)!);
  const twin = sig.slice(0, -1) + alphabet[last ^ 1];
  assert.equal((await verifyToken(SECRET, `${body}.${twin}`)).ok, false);
  assert.equal((await verifyToken(SECRET, `${body}.${sig}=`)).ok, false);
  assert.equal((await verifyToken(SECRET, `${body}.${sig.replace(/-/g, '+').replace(/_/g, '/')}`)).ok, sig === sig.replace(/[-_]/g, ''));
  assert.equal((await verifyToken(SECRET, ` ${body}.${sig}`)).ok, false);
  assert.throws(() => base64UrlDecode('ab=='));
  assert.throws(() => base64UrlDecode('ab+/'));
  assert.throws(() => base64UrlDecode('abd')); // 'abd' isn't canonical ('abc' is)
  assert.deepEqual([...base64UrlDecode('abc')], [105, 183]);
});

// ── 6/7. Config fails closed; no error text to anonymous callers ──────────────

test('config: SECRET_KEY without owner sign-in is an error; OPEN_MODE=1 opts in; empty values count as unset', () => {
  assert.equal(resolveConfig({}).mode, 'open');
  assert.ok(resolveConfig({ SECRET_KEY: SECRET }).error);
  assert.ok(resolveConfig({ SECRET_KEY: '', ADMIN_PASSWORD: '', CF_ACCESS_TEAM_DOMAIN: '', CF_ACCESS_AUD: '' }).error);
  assert.deepEqual(resolveConfig({ OPEN_MODE: '1', SECRET_KEY: SECRET }), { mode: 'open', auth: null });
  assert.deepEqual(resolveConfig({ ...env, CF_ACCESS_TEAM_DOMAIN: '', CF_ACCESS_AUD: '' }), { mode: 'private', auth: 'password' });
  assert.ok(resolveConfig({ ...env, ADMIN_PASSWORD: '' }).error); // compose's ${ADMIN_PASSWORD:-} stays closed
});

test('config: /api/config and /api/admin/session never leak error text', async () => {
  const bad: ServerEnv = { SECRET_KEY: SECRET };
  const cfg = await (await handleApi(new Request('https://x.test/api/config'), bad))!.json();
  assert.deepEqual(cfg, { mode: 'private', auth: null, misconfigured: true, emailInvites: false });
  const session = (await (await handleApi(new Request('https://x.test/api/admin/session'), bad))!.json()) as Record<string, unknown>;
  assert.equal(session.misconfigured, true);
  assert.equal(session.authenticated, false);
  assert.ok(!('error' in session));
});

// ── 9. Socket limits ──────────────────────────────────────────────────────────

test('websocket gate: expired invites only within a 24h grace; fatal join errors are flagged', async () => {
  const hdr = (t: string) => `vchat.v1, vchat.t.${t}`;
  const recent = await signToken(SECRET, { role: 'guest', room: 'abc', exp: now() - 3600 });
  const ancient = await signToken(SECRET, { role: 'guest', room: 'abc', exp: now() - 25 * 3600 });
  assert.equal(await authorizeSocket(env, 'abc', hdr(recent)), true);
  assert.equal(await authorizeSocket(env, 'abc', hdr(ancient)), false);
  assert.deepEqual(await authorizeJoin(env, { roomId: 'abc', token: recent }), { ok: false, error: 'Invite expired', fatal: true });
  assert.deepEqual(await authorizeJoin(env, { roomId: 'abc' }), { ok: false, error: 'Invite required' });
});

test('owner seat: one over the limit, and only when no host-role member is present', async () => {
  const room = new Room<Conn>('seat', transport);
  for (let i = 0; i < MAX_PEERS_PER_ROOM; i++) await room.enter(new Conn(), who(`g${i}`), GUEST);
  const h = new Conn();
  await room.enter(h, who('h'), HOST);
  assert.equal(room.peers().length, MAX_PEERS_PER_ROOM + 1);
  const h2 = new Conn();
  await room.enter(h2, who('h-other-device'), HOST);
  assert.equal(h2.last().message, 'Room is full');
});

// ── 10. Signal size ───────────────────────────────────────────────────────────

test('parser: signal payloads over 32KB are refused; remove-peer parses', () => {
  const big = parseClientMessage(JSON.stringify({ type: 'signal', targetPeerId: 'a', signal: 'x'.repeat(40_000) }));
  assert.deepEqual(big, { ok: false, error: 'Signal too large' });
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: 'remove-peer', peerId: 'p1' })), {
    ok: true,
    msg: { type: 'remove-peer', peerId: 'p1' },
  });
});

// ── 12. Remove peer and deny cooldown ─────────────────────────────────────────

test('remove-peer: removed peer is told, closed with 4002, and refused by peerId or secret', async () => {
  const room = new Room<Conn>('rm', transport);
  const h = new Conn();
  await room.enter(h, who('h'), HOST);
  const g = new Conn();
  await room.enter(g, who('g'), GUEST);
  const other = new Conn();
  await room.enter(other, who('o'), GUEST);

  room.removePeer(other, 'g');
  assert.equal(other.last().message, 'Only the host can remove peers');

  room.removePeer(h, 'g');
  assert.deepEqual(g.inbox.at(-1), { type: 'removed', roomId: 'rm', reason: 'Removed by host' });
  assert.equal(g.closedWith, CLOSE_REMOVED);
  assert.equal(room.meta.admitted.g, undefined);
  assert.equal(h.last().type, 'peer-left');

  const back = new Conn();
  await room.enter(back, who('g', 'new-secret'), GUEST); // same peerId
  assert.equal(back.last().type, 'removed');
  const back2 = new Conn();
  await room.enter(back2, who('g-new', 'g-s'), GUEST); // same secret
  assert.equal(back2.closedWith, CLOSE_REMOVED);

  room.removePeer(h, 'h');
  assert.equal(h.last().message, "You can't remove yourself");
});

test('remove-peer: a removed guest returning with a fresh identity has to be approved again', async () => {
  const OPEN_INVITE = { role: 'guest' as const, approval: false };
  const room = new Room<Conn>('rm2', transport);
  const h = new Conn();
  await room.enter(h, who('h'), HOST);
  const g = new Conn();
  await room.enter(g, who('g'), OPEN_INVITE);
  assert.equal(g.inbox.some((m) => m.type === 'room-peers'), true); // no approval needed so far

  room.removePeer(h, 'g');
  // Same person, same invite link, new tab (new peerId and secret): no longer straight in.
  const back = new Conn();
  await room.enter(back, who('g2', 'fresh'), OPEN_INVITE);
  assert.equal(back.last().type, 'waiting-for-admission');
  assert.equal(h.last().type, 'admission-request');
  assert.equal(room.meta.admitted.g2, undefined);
});

test('remove-peer: a personal (emailed) invite is barred with its holder', async () => {
  const personal = { role: 'guest' as const, approval: true, email: 'guest@example.com' };
  const room = new Room<Conn>('rm3', transport);
  const h = new Conn();
  await room.enter(h, who('h'), HOST);
  const g = new Conn();
  await room.enter(g, who('g'), personal);
  room.admitPeer(h, 'g');
  room.removePeer(h, 'g');

  const back = new Conn();
  await room.enter(back, who('g2', 'fresh'), personal);
  assert.equal(back.closedWith, CLOSE_REMOVED);
  // Someone else's invite still works (through approval).
  const other = new Conn();
  await room.enter(other, who('o'), { ...personal, email: 'other@example.com' });
  assert.equal(other.last().type, 'waiting-for-admission');
});

test('peer ids that would collide with object internals are refused', () => {
  assert.equal(parseClientMessage(JSON.stringify({ type: 'join', roomId: 'abc', peerId: '__proto__', displayName: 'x' })).ok, false);
});

test('API bodies over the limit are refused without being parsed', async () => {
  const big = new Request('https://x.test/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://x.test', Host: 'x.test' },
    body: JSON.stringify({ password: 'x'.repeat(100_000) }),
  });
  const res = await handleApi(big, { SECRET_KEY: SECRET, ADMIN_PASSWORD: 'correct horse battery' }, { clientIp: '203.0.113.77' });
  assert.equal(res?.status, 401);
});

test('API bodies are read only up to the limit, even when sent in pieces without a length', async () => {
  let pulled = 0;
  const chunk = new TextEncoder().encode('x'.repeat(1024));
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (++pulled > 1000) controller.close();
      else controller.enqueue(chunk);
    },
  });
  const req = new Request('https://x.test/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://x.test', Host: 'x.test' },
    body,
    duplex: 'half',
  } as RequestInit);
  const res = await handleApi(req, { SECRET_KEY: SECRET, ADMIN_PASSWORD: 'correct horse battery' }, { clientIp: '203.0.113.78' });
  assert.equal(res?.status, 401);
  assert.ok(pulled < 20, `read ${pulled} KB of a 1000 KB body`);
});

test('remove-peer: an emailed invite is barred even if its holder was offline when removed', async () => {
  const personal = { role: 'guest' as const, approval: false, email: 'gone@example.com' };
  const room = new Room<Conn>('rm4', transport);
  const h = new Conn();
  await room.enter(h, who('h'), HOST);
  const g = new Conn();
  await room.enter(g, who('g'), personal);
  room.leave(g); // their connection drops
  room.removePeer(h, 'g');
  const back = new Conn();
  await room.enter(back, who('g2', 'fresh'), personal);
  assert.equal(back.closedWith, CLOSE_REMOVED);
});

test('peer ids named like object internals are ordinary ids', async () => {
  const room = new Room<Conn>('rm5', transport);
  const h = new Conn();
  await room.enter(h, who('h'), HOST);
  room.removePeer(h, 'constructor');
  assert.equal(h.last().message, 'Peer not found');
  assert.equal(room.meta.removed.length, 0);
  const g = new Conn();
  await room.enter(g, who('toString'), GUEST);
  assert.equal(g.inbox.some((m) => m.type === 'room-peers'), true);
});

test('deny: a denied guest cannot knock again for 5 minutes', async () => {
  const room = new Room<Conn>('deny', transport);
  const h = new Conn();
  await room.enter(h, who('h'), HOST);
  const g = new Conn();
  await room.enter(g, who('g'), GUEST_APPROVAL);
  room.denyPeer(h, 'g');
  const requests = h.inbox.filter((m) => m.type === 'admission-request').length;
  const again = new Conn();
  await room.enter(again, who('g'), GUEST_APPROVAL);
  assert.equal(again.last().reason, 'Denied by host');
  assert.equal(h.inbox.filter((m) => m.type === 'admission-request').length, requests);
  room.meta.denied[0].u = Date.now() - 1; // cooldown over
  await room.enter(again, who('g'), GUEST_APPROVAL);
  assert.equal(again.last().type, 'waiting-for-admission');
});

// ── 13. Names ─────────────────────────────────────────────────────────────────

test('names: look-alikes collide, more invisible characters stripped, code-point slicing', async () => {
  assert.equal(nameKey('Аlex'), nameKey('alex')); // Cyrillic А
  assert.equal(nameKey('ＡＬＥＸ'), nameKey('alex')); // full-width
  assert.equal(nameKey('Álex'), nameKey('alex'));
  const room = new Room<Conn>('names2', transport);
  await room.enter(new Conn(), { peerId: 'a', displayName: 'Alex', secret: 'a' }, GUEST);
  const b = new Conn();
  await room.enter(b, { peerId: 'b', displayName: 'Аlex', secret: 'b' }, GUEST);
  assert.equal(room.members.get(b)?.displayName, 'Аlex (2)');

  const parsed = parseClientMessage(
    JSON.stringify({ type: 'join', roomId: 'r', peerId: 'p', displayName: 'Ow n͏e\u{E0041}r\u{E0100}᠋' })
  );
  assert.ok(parsed.ok && parsed.msg.type === 'join' && parsed.msg.displayName === 'Owner');

  const emoji = '😀'.repeat(30);
  assert.ok(parseClientMessage(JSON.stringify({ type: 'join', roomId: 'r', peerId: 'p', displayName: emoji })).ok);
  const c = new Conn();
  const d = new Conn();
  await room.enter(c, { peerId: 'c', displayName: emoji, secret: 'c' }, GUEST);
  await room.enter(d, { peerId: 'd', displayName: emoji, secret: 'd' }, GUEST);
  const name = room.members.get(d)!.displayName;
  assert.ok(name.endsWith(' (2)'));
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(name), 'no split surrogate pairs');
});

// ── 14. Nothing stored: meta resets when the room empties ─────────────────────

test('meta: reset when the last waiting guest times out (private-mode orphan path)', async () => {
  const changes: (RoomMeta | null)[] = [];
  const room = new Room<Conn>('orphan', transport, { onMetaChange: (m) => changes.push(m && structuredClone(m)) });
  const h = new Conn();
  await room.enter(h, who('h'), HOST);
  const g = new Conn();
  await room.enter(g, who('g'), GUEST_APPROVAL);
  room.leave(h);
  assert.ok(Object.keys(room.meta.admitted).length > 0);
  room.expireWaiting(Date.now() + WAITING_TIMEOUT_MS + 1);
  assert.equal(changes.at(-1), null);
  assert.deepEqual(Object.keys(room.meta.admitted), []);
  assert.ok(room.isEmpty());

  const room2 = new Room<Conn>('orphan2', transport, { onMetaChange: (m) => changes.push(m) });
  const h2 = new Conn();
  await room2.enter(h2, who('h'), HOST);
  const g2 = new Conn();
  await room2.enter(g2, who('g'), GUEST_APPROVAL);
  room2.leave(h2);
  room2.leave(g2); // waiting guest gives up
  assert.equal(changes.at(-1), null);
});

test('meta: open-mode password hashes are salted per room', async () => {
  const a = new Room<Conn>('salt1', transport);
  const b = new Room<Conn>('salt2', transport);
  await a.create(new Conn(), { ...who('h'), password: 'same' });
  await b.create(new Conn(), { ...who('h'), password: 'same' });
  assert.ok(a.meta.passwordSalt && b.meta.passwordSalt);
  assert.notEqual(a.meta.passwordHash, b.meta.passwordHash);
  assert.ok(JSON.stringify(a.meta).length < 16 * 1024);
});

test('meta: stays well under the 16KB attachment limit at its caps', async () => {
  const room = new Room<Conn>('big', transport);
  const h = new Conn();
  await room.enter(h, who('h'), HOST);
  const c = new Conn();
  for (let i = 0; i < 100; i++) await room.enter(c, who(`p${'x'.repeat(24)}${i}`, `secret-${i}`), GUEST);
  for (let i = 0; i < 100; i++) {
    const w = new Conn();
    await room.enter(w, who(`w${'y'.repeat(24)}${i}`, `ws-${i}`), GUEST_APPROVAL);
    if (i % 2) room.denyPeer(h, `w${'y'.repeat(24)}${i}`);
    else room.removePeer(h, `w${'y'.repeat(24)}${i}`);
  }
  assert.ok(JSON.stringify(room.meta).length < 10 * 1024, `${JSON.stringify(room.meta).length} bytes`);
});

// ── 4. TURN credentials ───────────────────────────────────────────────────────

test('TURN: unique usernames, 4h default TTL capped at the invite expiry, STUN default is Cloudflare only', async () => {
  const turnEnv = { TURN_URLS: 'turn:t:3478', TURN_SECRET: 's' };
  const a = await getIceServers(turnEnv);
  const b = await getIceServers(turnEnv);
  const ua = a.iceServers.find((s) => s.username)!.username!;
  const ub = b.iceServers.find((s) => s.username)!.username!;
  assert.notEqual(ua, ub);
  assert.match(ua, /^\d+:[A-Za-z0-9_-]+$/);
  assert.equal(a.ttl, DEFAULT_TURN_TTL);
  const capped = await getIceServers(turnEnv, { expiresAt: now() + 600 });
  assert.ok(capped.ttl! <= 600 && capped.ttl! > 590);
  assert.deepEqual(a.iceServers[0].urls, ['stun:stun.cloudflare.com:3478']);
});

test('TURN: ICE endpoint takes host/guest tokens only; coturn credentials are per client and rate limited', async () => {
  const turnEnv: ServerEnv = { ...env, TURN_URLS: 'turn:t:3478', TURN_SECRET: 's' };
  const admin = await signToken(SECRET, { role: 'admin', exp: now() + 600 });
  const ice = (token: string, clientIp = '198.51.100.1') =>
    handleApi(new Request('https://x.test/api/ice-servers', { headers: { 'X-Vchat-Token': token } }), turnEnv, { clientIp });
  const username = async (res: Response | null | undefined) =>
    ((await res!.json()) as { iceServers: { username?: string }[] }).iceServers.find((s) => s.username)?.username;
  assert.equal((await ice(admin))?.status, 401);

  // Asking again doesn't yield a fresh relay identity (the relay's per-user quota can't be reset)…
  const long = await signToken(SECRET, { role: 'guest', room: 'abc', exp: now() + 6 * 3600 });
  const first = await username(await ice(long));
  assert.ok(first);
  assert.equal(await username(await ice(long)), first);
  // …while another client, or the same client in another room, gets its own.
  assert.notEqual(await username(await ice(long, '198.51.100.2')), first);
  const other = await signToken(SECRET, { role: 'guest', room: 'xyz', exp: now() + 6 * 3600 });
  assert.notEqual((await username(await ice(other)))?.split(':')[1], first.split(':')[1]);
  // The relay never sees the room or the address.
  assert.ok(!first.includes('abc') && !first.includes('198.51'));

  // Credentials never outlive the invite.
  const invite = await signToken(SECRET, { role: 'guest', room: 'abc', exp: now() + 600 });
  const short = (await (await ice(invite))!.json()) as { ttl: number };
  assert.ok(short.ttl <= 600);

  // One client can't farm credentials.
  let limited = 0;
  for (let i = 0; i < 60; i++) if ((await ice(long, '198.51.100.9'))?.status === 429) limited++;
  assert.ok(limited >= 15 && limited < 60);
});

// ── Email sign-in and emailed invites (Resend) ────────────────────────────────

const RESEND = { RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'vchat <invites@example.com>' };
const emailEnv: ServerEnv = { SECRET_KEY: SECRET, OWNER_EMAIL: 'Owner@Example.com', ...RESEND };
const SITE = 'https://call.example.com';

function post(path: string, body: unknown, cookie?: string) {
  return new Request(`${SITE}${path}`, {
    method: 'POST',
    headers: { Origin: SITE, Host: 'call.example.com', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}

/** Stub Resend: records each payload; `fail` makes it answer 500. */
function stubResend(fail = false) {
  const calls: { url: string; auth: string | null; body: any }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), auth: new Headers(init?.headers).get('Authorization'), body: JSON.parse(String(init?.body)) });
    return new Response(fail ? '{"message":"provider detail"}' : '{"id":"x"}', { status: fail ? 500 : 200 });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = realFetch) };
}

async function requestCode(env: ServerEnv, email: string, ip: string) {
  const pending: Promise<unknown>[] = [];
  const res = await handleApi(post('/api/admin/login/code', { email }), env, { clientIp: ip, waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  return res!;
}

const codeIn = (text: string) => text.match(/\b(\d{6})\b/)![1];

test('email config: fail-closed cases, precedence, public config', async () => {
  const err = (e: ServerEnv) => resolveConfig(e).error;
  assert.ok(err({ SECRET_KEY: SECRET, OWNER_EMAIL: 'o@example.com' })); // no Resend
  assert.ok(err({ SECRET_KEY: SECRET, OWNER_EMAIL: 'o@example.com', RESEND_API_KEY: 'k' })); // half Resend
  assert.ok(err({ ...env, EMAIL_FROM: 'vchat <a@b.co>' })); // half Resend, password mode
  assert.ok(err({ ...emailEnv, OWNER_EMAIL: 'not-an-email' }));
  assert.ok(err({ ...emailEnv, EMAIL_FROM: 'vchat <nope>' }));
  assert.ok(err({ OWNER_EMAIL: 'o@example.com', ...RESEND })); // no SECRET_KEY
  assert.ok(err({ OWNER_EMAIL: '', SECRET_KEY: SECRET })); // empty owner setting: closed, not open
  assert.deepEqual(resolveConfig(emailEnv), { mode: 'private', auth: 'email' });
  assert.equal(resolveConfig({ ...emailEnv, ADMIN_PASSWORD: 'short' }).auth, 'email'); // email > password
  assert.equal(resolveConfig({ ...emailEnv, CF_ACCESS_TEAM_DOMAIN: 't.cloudflareaccess.com', CF_ACCESS_AUD: 'a' }).auth, 'access');
  assert.equal(resolveConfig({ ...emailEnv, EMAIL_FROM: 'invites@example.com' }).error, undefined);

  const cfg = async (e: ServerEnv) => (await handleApi(new Request(`${SITE}/api/config`), e))!.json();
  assert.deepEqual(await cfg(emailEnv), { mode: 'private', auth: 'email', misconfigured: false, emailInvites: true });
  assert.deepEqual(await cfg({ ...env, ...RESEND }), { mode: 'private', auth: 'password', misconfigured: false, emailInvites: true });
  assert.deepEqual(await cfg(env), { mode: 'private', auth: 'password', misconfigured: false, emailInvites: false });
  assert.deepEqual(await cfg({ SECRET_KEY: SECRET, OWNER_EMAIL: 'o@example.com' }), {
    mode: 'private',
    auth: 'email',
    misconfigured: true,
    emailInvites: false,
  });
});

test('email sign-in: code emailed to the owner, verifies once, wrong code refused', async () => {
  const resend = stubResend();
  try {
    const res = await requestCode(emailEnv, '  OWNER@example.COM ', '20.0.0.1');
    assert.equal(res.status, 200);
    const { challenge } = (await res.json()) as { challenge: string };
    assert.equal(resend.calls.length, 1);
    const call = resend.calls[0];
    assert.equal(call.url, 'https://api.resend.com/emails');
    assert.equal(call.auth, 'Bearer re_test_key');
    assert.deepEqual(Object.keys(call.body).sort(), ['from', 'html', 'subject', 'text', 'to']);
    assert.deepEqual(call.body.to, ['owner@example.com']);
    assert.equal(call.body.from, 'vchat <invites@example.com>');
    assert.equal(call.body.subject, 'Your sign-in code');
    assert.match(call.body.text, /expires in 10 minutes/);
    assert.match(call.body.text, /If you didn't ask for this, ignore this email\./);
    assert.ok(!/<img/i.test(call.body.html));
    const code = codeIn(call.body.text);
    assert.ok(call.body.html.includes(code));

    const verify = (c: string, ch = challenge) => handleApi(post('/api/admin/login/verify', { challenge: ch, code: c }), emailEnv, { clientIp: '20.0.0.2' });
    const wrong = await verify(code === '000000' ? '111111' : '000000');
    assert.equal(wrong!.status, 401);
    assert.deepEqual(await wrong!.json(), { error: 'Wrong or expired code' });

    const ok = await verify(code);
    assert.equal(ok!.status, 200);
    const cookie = ok!.headers.get('Set-Cookie')!.split(';')[0];
    const session = (await (await handleApi(new Request(`${SITE}/api/admin/session`, { headers: { Cookie: cookie } }), emailEnv))!.json()) as any;
    assert.equal(session.authenticated, true);
    assert.equal(session.email, 'owner@example.com');
    // Changing OWNER_EMAIL signs the session out.
    const moved = { ...emailEnv, OWNER_EMAIL: 'new@example.com' };
    assert.equal(((await (await handleApi(new Request(`${SITE}/api/admin/session`, { headers: { Cookie: cookie } }), moved))!.json()) as any).authenticated, false);

    assert.equal((await verify(code))!.status, 401); // single use
  } finally {
    resend.restore();
  }
});

test('email sign-in: at most 5 tries per challenge', async () => {
  const resend = stubResend();
  try {
    const { challenge } = (await (await requestCode(emailEnv, 'owner@example.com', '21.0.0.1')).json()) as { challenge: string };
    const code = codeIn(resend.calls[0].body.text);
    const bad = code === '123456' ? '654321' : '123456';
    for (let i = 0; i < 5; i++) {
      assert.equal((await handleApi(post('/api/admin/login/verify', { challenge, code: bad }), emailEnv, { clientIp: `21.0.1.${i}` }))!.status, 401);
    }
    assert.equal((await handleApi(post('/api/admin/login/verify', { challenge, code }), emailEnv, { clientIp: '21.0.2.1' }))!.status, 401);
  } finally {
    resend.restore();
  }
});

test('email sign-in: other addresses get the same answer and nothing is sent', async () => {
  const resend = stubResend();
  try {
    const res = await requestCode(emailEnv, 'stranger@example.com', '22.0.0.1');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { challenge: string };
    assert.deepEqual(Object.keys(body), ['challenge']);
    assert.equal(resend.calls.length, 0);
    const p = await verifyToken(SECRET, body.challenge);
    assert.ok(p.ok && p.payload.role === 'login' && typeof p.payload.c === 'string' && p.payload.c.length === 43);
    assert.equal((await handleApi(post('/api/admin/login/verify', { challenge: body.challenge, code: '000000' }), emailEnv, { clientIp: '22.0.0.2' }))!.status, 401);
    // 404 unless email sign-in is the method; same-origin required
    assert.equal((await handleApi(post('/api/admin/login/code', { email: 'x@y.co' }), env, { clientIp: '22.0.0.3' }))!.status, 404);
  } finally {
    resend.restore();
  }
});

test('email sign-in: per-address request cap answers the same for owner and stranger', async () => {
  const resend = stubResend();
  try {
    const statuses = async (email: string, ipBase: number) => {
      const out: number[] = [];
      for (let i = 0; i < 6; i++) out.push((await requestCode(emailEnv, email, `23.0.${ipBase}.${i}`)).status);
      return out;
    };
    const stranger = await statuses('someone@example.org', 1);
    assert.deepEqual(stranger, [200, 200, 200, 200, 200, 429]);
    const owner = (await requestCode(emailEnv, 'owner@example.com', '23.0.9.9')).status;
    // The owner already used 2 of the 5 sends in earlier tests; either way the cap holds.
    assert.ok(owner === 200 || owner === 429);
    assert.ok(resend.calls.length <= 5);
  } finally {
    resend.restore();
  }
});

test('a login challenge is useless as a session, invite, host or ICE token', async () => {
  const login = await signToken(SECRET, { role: 'login', room: 'abc', exp: now() + 600, n: 'n', c: 'c' });
  const session = (await (await handleApi(new Request(`${SITE}/api/admin/session`, { headers: { Cookie: `vchat_admin=${login}` } }), emailEnv))!.json()) as any;
  assert.equal(session.authenticated, false);
  assert.deepEqual(await authorizeJoin(emailEnv, { roomId: 'abc', token: login }), { ok: false, error: 'Invalid invite', fatal: true });
  assert.equal(await authorizeSocket(emailEnv, 'abc', `vchat.v1, vchat.t.${login}`), false);
  const ice = await handleApi(new Request(`${SITE}/api/ice-servers`, { headers: { 'X-Vchat-Token': login } }), emailEnv);
  assert.equal(ice!.status, 401);
  const invite = await handleApi(post('/api/admin/rooms/email-invite', { roomId: 'abc', inviteToken: login, email: 'g@example.com' }), emailEnv);
  assert.equal(invite!.status, 401); // not signed in either
});

test('emailed invite: per-guest code, `to` reaches the host, nothing secret in the response', async () => {
  const pwEnv: ServerEnv = { ...env, ...RESEND };
  const login = await handleApi(post('/api/admin/login', { password: 'correct horse battery' }), pwEnv, { clientIp: '24.0.0.1' });
  const cookie = login!.headers.get('Set-Cookie')!.split(';')[0];
  const created = (await (await handleApi(post('/api/admin/rooms', { label: '<b>Fam & co</b>', password: 'roompw', approval: true }, cookie), pwEnv))!.json()) as {
    roomId: string;
    inviteToken: string;
    expiresAt: number;
  };
  const key = 'A'.repeat(43);

  assert.equal((await handleApi(post('/api/admin/rooms/email-invite', { roomId: created.roomId, inviteToken: created.inviteToken, email: 'g@example.com' }), pwEnv))!.status, 401);
  const bad = await handleApi(post('/api/admin/rooms/email-invite', { roomId: created.roomId, inviteToken: created.inviteToken, email: 'nope' }, cookie), pwEnv);
  assert.equal(bad!.status, 400);
  const wrongRoom = await handleApi(post('/api/admin/rooms/email-invite', { roomId: 'zzzzzz', inviteToken: created.inviteToken, email: 'g@example.com' }, cookie), pwEnv);
  assert.equal(wrongRoom!.status, 400);

  const resend = stubResend();
  let res: Response;
  try {
    res = (await handleApi(
      post('/api/admin/rooms/email-invite', { roomId: created.roomId, inviteToken: created.inviteToken, email: ' Guest@Example.com ', key }, cookie),
      pwEnv
    ))!;
  } finally {
    resend.restore();
  }
  assert.equal(res.status, 200);
  // The older single `email` field still works.
  const out = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(out, { ok: true, sent: ['guest@example.com'], failed: [], expiresAt: created.expiresAt, warnings: [] });
  assert.equal(resend.calls.length, 1);
  assert.equal(resend.calls[0].body.attachments, undefined);

  const mail = resend.calls[0].body;
  assert.deepEqual(mail.to, ['guest@example.com']);
  assert.equal(mail.subject, "You're invited to <b>Fam & co</b>");
  assert.ok(mail.html.includes('&lt;b&gt;Fam &amp; co&lt;/b&gt;') && !mail.html.includes('<b>Fam'));
  assert.match(mail.text, /Open the link, enter the code, and the host will let you in\./);
  assert.match(mail.text, /UTC/);
  assert.ok(mail.html.includes('Join the call'));
  const code = codeIn(mail.text.split('Your code:')[1]);
  const link = mail.text.match(/https:\/\/call\.example\.com\/room\/\S+/)![0];
  assert.ok(link.startsWith(`${SITE}/room/${created.roomId}#invite=`));
  assert.ok(link.endsWith(`&k=${key}`));
  const token = link.split('#invite=')[1].split('&')[0];
  const p = await verifyToken(SECRET, token);
  assert.ok(p.ok && p.payload.to === 'guest@example.com' && p.payload.role === 'guest' && p.payload.approval);
  assert.equal(p.ok && p.payload.exp * 1000, created.expiresAt);

  // The code is this guest's password (the room password no longer works with this token).
  assert.deepEqual(await authorizeJoin(pwEnv, { roomId: created.roomId, token, password: 'roompw' }, { clientId: 'e1' }), {
    ok: false,
    passwordRequired: true,
    invalid: true,
  });
  const good = await authorizeJoin(pwEnv, { roomId: created.roomId, token, password: code }, { clientId: 'e1' });
  assert.ok(good.ok);

  // …and the host sees who it was sent to.
  const room = new Room<Conn>(created.roomId, transport);
  const h = new Conn();
  await room.enter(h, who('h'), HOST);
  const g = new Conn();
  await room.enter(g, who('g'), good.ok ? good.grant : HOST);
  assert.deepEqual(h.last('admission-request'), { type: 'admission-request', peerId: 'g', displayName: 'g', email: 'guest@example.com' });

  // A bad key is ignored rather than put in the link.
  const resend2 = stubResend();
  try {
    await handleApi(post('/api/admin/rooms/email-invite', { roomId: created.roomId, inviteToken: created.inviteToken, email: 'g2@example.com', key: 'short' }, cookie), pwEnv);
  } finally {
    resend2.restore();
  }
  assert.ok(!resend2.calls[0].body.text.includes('&k='));

  // Resend failure: reported per recipient, no provider details.
  const failing = stubResend(true);
  let failed: Response;
  try {
    failed = (await handleApi(post('/api/admin/rooms/email-invite', { roomId: created.roomId, inviteToken: created.inviteToken, email: 'g3@example.com' }, cookie), pwEnv))!;
  } finally {
    failing.restore();
  }
  assert.equal(failed.status, 200);
  const failedBody = await failed.json();
  assert.deepEqual(failedBody, { ok: true, sent: [], failed: [{ email: 'g3@example.com', reason: 'send-failed' }], expiresAt: created.expiresAt, warnings: [] });
  assert.ok(!JSON.stringify(failedBody).includes('provider detail'));

  // Not configured: 503.
  const noMail = await handleApi(post('/api/admin/rooms/email-invite', { roomId: created.roomId, inviteToken: created.inviteToken, email: 'g@example.com' }, cookie), env);
  assert.equal(noMail!.status, 503);
});

test('sign-in codes are 6 uniform digits', async () => {
  const { randomCode } = await import('../src/core/index.js');
  const counts = new Array(10).fill(0);
  for (let i = 0; i < 5000; i++) {
    const c = randomCode();
    assert.match(c, /^\d{6}$/);
    counts[Number(c[0])]++;
  }
  assert.ok(counts.every((n) => n > 350 && n < 650), counts.join());
});

// ── Emailed invites: several recipients, no passcode, calendar file ───────────

const inviteEnv: ServerEnv = { ...env, ...RESEND };

async function ownerCookie(ip: string): Promise<string> {
  const login = await handleApi(post('/api/admin/login', { password: 'correct horse battery' }), inviteEnv, { clientIp: ip });
  return login!.headers.get('Set-Cookie')!.split(';')[0];
}

async function newRoom(cookie: string, body: Record<string, unknown> = {}) {
  return (await (await handleApi(post('/api/admin/rooms', body, cookie), inviteEnv))!.json()) as {
    roomId: string;
    inviteToken: string;
    expiresAt: number;
  };
}

interface InviteResult {
  ok: true;
  sent: string[];
  failed: { email: string; reason: string }[];
  expiresAt: number;
  warnings: string[];
  error?: string;
}

async function sendInvites(cookie: string, body: Record<string, unknown>) {
  const resend = stubResend();
  let res: Response;
  try {
    res = (await handleApi(post('/api/admin/rooms/email-invite', body, cookie), inviteEnv))!;
  } finally {
    resend.restore();
  }
  return { res, status: res.status, out: (await res.json()) as InviteResult, calls: resend.calls };
}

const linkIn = (text: string) => text.match(/https:\/\/call\.example\.com\/room\/\S+/)![0];
const tokenIn = (text: string) => linkIn(text).split('#invite=')[1].split('&')[0];

function checkReq(body: unknown, origin = SITE) {
  return new Request(`${SITE}/api/invite/check`, {
    method: 'POST',
    headers: { Origin: origin, Host: 'call.example.com', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
async function check(body: unknown, clientIp = '198.51.100.30', opts: Record<string, unknown> = {}) {
  const res = (await handleApi(checkReq(body), inviteEnv, { clientIp, ...opts }))!;
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, res };
}

test('email invite: several recipients each get their own email, token and code, and never see each other', async () => {
  const cookie = await ownerCookie('25.0.0.1');
  const room = await newRoom(cookie, { label: 'Team', approval: false });
  const emails = ['A@Example.com', 'b@example.com', 'c@example.org'];
  const { status, out, calls } = await sendInvites(cookie, { roomId: room.roomId, inviteToken: room.inviteToken, emails });
  assert.equal(status, 200);
  assert.deepEqual(out, { ok: true, sent: ['a@example.com', 'b@example.com', 'c@example.org'], failed: [], expiresAt: room.expiresAt, warnings: [] });
  assert.equal(calls.length, 3);

  const tokens: string[] = [];
  const codes: string[] = [];
  for (const [i, call] of calls.entries()) {
    const me = out.sent[i];
    assert.deepEqual(call.body.to, [me]); // one recipient per email: no shared To/CC
    assert.equal(call.body.cc, undefined);
    assert.equal(call.body.bcc, undefined);
    const raw = JSON.stringify(call.body);
    for (const other of out.sent) if (other !== me) assert.ok(!raw.includes(other), 'no other recipient in the email');
    const token = tokenIn(call.body.text);
    tokens.push(token);
    const p = await verifyToken(SECRET, token);
    assert.ok(p.ok && p.payload.to === me && p.payload.approval === false && typeof p.payload.pw === 'string');
    codes.push(codeIn(call.body.text.split('Your code:')[1]));
  }
  assert.equal(new Set(tokens).size, 3);
  // Each code works with its own token only.
  assert.equal((await authorizeJoin(inviteEnv, { roomId: room.roomId, token: tokens[0], password: codes[0] }, { clientId: 'm1' })).ok, true);
  if (codes[0] !== codes[1]) {
    assert.deepEqual(await authorizeJoin(inviteEnv, { roomId: room.roomId, token: tokens[1], password: codes[0] }, { clientId: 'm1' }), {
      ok: false,
      passwordRequired: true,
      invalid: true,
    });
  }
  // Nothing secret in the response.
  const raw = JSON.stringify(out);
  for (const t of tokens) assert.ok(!raw.includes(t));
  for (const c of codes) assert.ok(!raw.includes(c));
});

test('email invite: addresses are deduplicated, invalid ones reported, more than 20 or none valid is a 400', async () => {
  const cookie = await ownerCookie('25.0.0.2');
  const room = await newRoom(cookie);
  const base = { roomId: room.roomId, inviteToken: room.inviteToken };
  const { status, out, calls } = await sendInvites(cookie, {
    ...base,
    emails: [' X@Example.com ', 'x@example.com', 'not-an-email', '', 'y@example.com', 'NOT-an-email', 42],
  });
  assert.equal(status, 200);
  assert.deepEqual(out.sent, ['x@example.com', 'y@example.com']);
  assert.deepEqual(out.failed, [
    { email: 'not-an-email', reason: 'invalid' },
    { email: '', reason: 'invalid' },
  ]);
  assert.equal(calls.length, 2);

  const none = await sendInvites(cookie, { ...base, emails: ['nope', ' '] });
  assert.equal(none.status, 400);
  assert.equal(none.calls.length, 0);
  assert.equal((await sendInvites(cookie, { ...base, emails: [] })).status, 400);
  assert.equal((await sendInvites(cookie, { ...base })).status, 400);

  const many = Array.from({ length: 21 }, (_, i) => `p${i}@example.com`);
  const tooMany = await sendInvites(cookie, { ...base, emails: many });
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.calls.length, 0);
  // 20 distinct after deduplication passes the count check (stopped here by the bad token, unsent).
  const dupes = await sendInvites(cookie, { ...base, emails: [...many.slice(0, 20), 'P0@example.com'], inviteToken: 'bad' });
  assert.equal(dupes.status, 400);
  assert.equal(dupes.out.error, 'Invalid or expired invite');
});

test('email invite: passcode:false gives a token with no code and approval forced; the guest waits for the host', async () => {
  const cookie = await ownerCookie('25.0.0.3');
  const room = await newRoom(cookie, { password: 'roompw', approval: false });
  const { status, out, calls } = await sendInvites(cookie, {
    roomId: room.roomId,
    inviteToken: room.inviteToken,
    emails: ['lobby@example.com'],
    passcode: false,
  });
  assert.equal(status, 200);
  assert.deepEqual(out.sent, ['lobby@example.com']);
  const mail = calls[0].body;
  assert.match(mail.text, /Open the link, enter your name, and the host will let you in\./);
  assert.ok(mail.html.includes('Open the link, enter your name, and the host will let you in.'));
  assert.ok(!/Your code/.test(mail.text) && !/Your code/.test(mail.html));
  assert.ok(!/\b\d{6}\b/.test(mail.text.replace(/https:\S+/g, '')), 'no code in the email');

  const token = tokenIn(mail.text);
  const p = await verifyToken(SECRET, token);
  assert.ok(p.ok);
  assert.equal(p.payload.pw, undefined); // no code, and the room password is dropped too
  assert.equal(p.payload.approval, true);
  assert.equal(p.payload.to, 'lobby@example.com');

  // Joins with no code…
  const decision = await authorizeJoin(inviteEnv, { roomId: room.roomId, token }, { clientId: 'np1' });
  assert.ok(decision.ok);
  assert.deepEqual(decision.ok && decision.grant, { role: 'guest', approval: true, label: undefined, email: 'lobby@example.com' });
  // …and lands in the waiting queue, even before the host is there.
  const r = new Room<Conn>(room.roomId, transport);
  const g = new Conn();
  await r.enter(g, who('g'), decision.ok ? decision.grant : HOST);
  assert.deepEqual(g.last(), { type: 'waiting-for-admission', roomId: room.roomId, hostPresent: false });
  const h = new Conn();
  await r.enter(h, who('h'), HOST);
  assert.equal(h.last('admission-request').email, 'lobby@example.com');
  r.admitPeer(h, 'g');
  assert.equal(g.last('room-peers').type, 'room-peers');

  // The check endpoint says no code is needed.
  assert.deepEqual((await check({ roomId: room.roomId, token, code: '' })).body, { ok: true, required: false });
});

test('ics: escaping and UTF-8-safe folding at 75 octets', () => {
  assert.equal(icsText('a\\b;c,d\ne\r\nf'), 'a\\\\b\\;c\\,d\\ne\\nf');
  assert.equal(icsFold('short'), 'short');
  const long = `SUMMARY:${'é'.repeat(40)}${'x'.repeat(30)}☕☕☕${'y'.repeat(80)}`;
  const folded = icsFold(long);
  const lines = folded.split('\r\n');
  assert.ok(lines.length > 2);
  for (const [i, line] of lines.entries()) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `line ${i} is ${Buffer.byteLength(line, 'utf8')} octets`);
    if (i > 0) assert.equal(line[0], ' ');
  }
  assert.equal(folded.replace(/\r\n /g, ''), long);
});

test('email invite: a schedule adds a When line and a valid METHOD:REQUEST invite.ics with the passcode', async () => {
  const cookie = await ownerCookie('25.0.0.4');
  const label = 'Planning, review; budget \\ next — café ☕ ünïcödé ñ';
  const room = await newRoom(cookie, { label, expiresInHours: 24 * 7 });
  const startsAt = Math.ceil((Date.now() + 2 * 24 * 3600_000) / 3600_000) * 3600_000 + 30 * 60_000;
  const key = 'B'.repeat(43);
  const { status, out, calls } = await sendInvites(cookie, {
    roomId: room.roomId,
    inviteToken: room.inviteToken,
    emails: ['cal@example.com'],
    key,
    schedule: { startsAt, durationMinutes: 90 },
  });
  assert.equal(status, 200);
  assert.deepEqual(out.warnings, []);
  assert.deepEqual(out.sent, ['cal@example.com']);

  const mail = calls[0].body;
  const d = new Date(startsAt);
  const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getUTCDay()];
  assert.ok(mail.text.includes(`When: ${weekday}, ${d.getUTCDate()} `), mail.text);
  assert.match(mail.text, /When: .+ \d{4}, \d{2}:30 UTC \(1 h 30 min\)/);
  assert.match(mail.text, /A calendar invite is attached\./);
  assert.ok(mail.html.includes('A calendar invite is attached.') && mail.html.includes('When:'));
  const code = codeIn(mail.text.split('Your code:')[1]);
  const link = linkIn(mail.text);
  assert.ok(link.endsWith(`&k=${key}`));

  assert.equal(mail.attachments.length, 1);
  const att = mail.attachments[0];
  assert.deepEqual(Object.keys(att).sort(), ['content', 'content_type', 'filename']);
  assert.equal(att.filename, 'invite.ics');
  assert.equal(att.content_type, 'text/calendar; method=REQUEST; charset=UTF-8');
  assert.match(att.content, /^[A-Za-z0-9+/]+=*$/);
  const ics = Buffer.from(att.content, 'base64').toString('utf8');
  assert.equal(Buffer.from(ics, 'utf8').toString('base64'), att.content); // decodes losslessly
  assert.ok(!ics.includes('�'), 'no character split by folding');

  // CRLF everywhere, folded lines of at most 75 octets.
  assert.ok(ics.endsWith('\r\n'));
  assert.ok(!/[^\r]\n/.test(ics) && !/\r[^\n]/.test(ics), 'only CRLF line breaks');
  const physical = ics.slice(0, -2).split('\r\n');
  for (const line of physical) assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `${Buffer.byteLength(line, 'utf8')} octets: ${line}`);
  assert.ok(physical.some((l) => l.startsWith(' ')), 'long lines are folded');

  const lines = ics.replace(/\r\n /g, '').slice(0, -2).split('\r\n');
  const prop = (name: string) => lines.find((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`));
  const iso = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  assert.deepEqual(lines.slice(0, 6), ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//vchat//invite//EN', 'CALSCALE:GREGORIAN', 'METHOD:REQUEST', 'BEGIN:VEVENT']);
  assert.deepEqual(lines.slice(-3), ['END:VALARM', 'END:VEVENT', 'END:VCALENDAR']);
  assert.equal(lines.filter((l) => l === 'BEGIN:VEVENT').length, 1);
  assert.match(prop('UID')!, /^UID:[A-Za-z0-9_-]+@call\.example\.com$/);
  assert.match(prop('DTSTAMP')!, /^DTSTAMP:\d{8}T\d{6}Z$/);
  assert.equal(prop('DTSTART'), `DTSTART:${iso(startsAt)}`);
  assert.equal(prop('DTEND'), `DTEND:${iso(startsAt + 90 * 60_000)}`);
  assert.equal(prop('SUMMARY'), 'SUMMARY:Planning\\, review\\; budget \\\\ next — café ☕ ünïcödé ñ');
  assert.equal(prop('DESCRIPTION'), `DESCRIPTION:Join: ${link}\\nPasscode: ${code}`);
  assert.equal(prop('URL'), `URL:${link}`);
  assert.equal(prop('LOCATION'), `LOCATION:${link}`);
  assert.equal(prop('ORGANIZER'), 'ORGANIZER;CN=vchat:mailto:invites@example.com');
  assert.equal(prop('ATTENDEE'), 'ATTENDEE;CN=cal@example.com;RSVP=FALSE;PARTSTAT=NEEDS-ACTION;ROLE=REQ-PARTICIPANT:mailto:cal@example.com');
  assert.ok(lines.includes('STATUS:CONFIRMED') && lines.includes('SEQUENCE:0'));
  assert.ok(lines.includes('BEGIN:VALARM') && lines.includes('ACTION:DISPLAY') && lines.includes('TRIGGER:-PT10M'));

  // The guest's own code is in the calendar file, in the description only, labelled as the passcode
  // (ignoring the link and timestamps, which hold random digits).
  const scrubbed = lines.filter((l) => !/^(UID|DTSTAMP|DTSTART|DTEND):/.test(l)).join('\n').split(link).join('');
  assert.equal(scrubbed.split(code).length, 2, 'the code appears exactly once');
  assert.ok(prop('DESCRIPTION')!.endsWith(`\\nPasscode: ${code}`));
});

test('email invite: schedule warnings (ignored when invalid, noted when the meeting outlasts the invite)', async () => {
  const cookie = await ownerCookie('25.0.0.5');
  const room = await newRoom(cookie, { expiresInHours: 2 });
  const base = { roomId: room.roomId, inviteToken: room.inviteToken };
  const day = 24 * 3600_000;
  // Two invalid schedules end to end (the bounds are covered below without sending).
  for (const schedule of [
    { startsAt: Date.now() + 401 * day, durationMinutes: 60 },
    { startsAt: Date.now() + day, durationMinutes: 30.5 },
  ]) {
    const { status, out, calls } = await sendInvites(cookie, { ...base, emails: ['w@example.com'], schedule });
    assert.equal(status, 200);
    assert.deepEqual(out.warnings, ['schedule-ignored'], JSON.stringify(schedule));
    assert.equal(calls[0].body.attachments, undefined);
    assert.ok(!/When:/.test(calls[0].body.text));
  }

  // Valid, but the invite expires in 2 hours: still sent, with a warning.
  const late = await sendInvites(cookie, { ...base, emails: ['late@example.com'], passcode: false, schedule: { startsAt: Date.now() + day, durationMinutes: 60 } });
  assert.equal(late.status, 200);
  assert.deepEqual(late.out.sent, ['late@example.com']);
  assert.deepEqual(late.out.warnings, ['meeting-ends-after-invite-expires']);
  const ics = Buffer.from(late.calls[0].body.attachments[0].content, 'base64').toString('utf8').replace(/\r\n /g, '');
  // No passcode: the description doesn't mention one, and no code is anywhere in the email or file.
  assert.match(ics, /\r\nDESCRIPTION:Join: https:\/\/call\.example\.com\/room\/[^\r]+\r\n/);
  assert.ok(!/passcode/i.test(ics));
  const description = ics.split('\r\n').find((l) => l.startsWith('DESCRIPTION:'))!;
  assert.ok(!/\b\d{6}\b/.test(description.replace(/https:\S+/g, '')));
  assert.ok(!/\b\d{6}\b/.test(late.calls[0].body.text.replace(/https:\S+/g, '')), 'no code in the email');
});

test('email invite: schedule validation bounds', async () => {
  const { isValidSchedule } = await import('../src/core/index.js');
  const t = Date.now();
  const day = 24 * 3600_000;
  assert.equal(isValidSchedule({ startsAt: t + day, durationMinutes: 60 }, t), true);
  assert.equal(isValidSchedule({ startsAt: t - day + 1000, durationMinutes: 5 }, t), true);
  assert.equal(isValidSchedule({ startsAt: t + 400 * day - 1000, durationMinutes: 1440 }, t), true);
  for (const bad of [
    { startsAt: t - 2 * day, durationMinutes: 60 },
    { startsAt: t + 401 * day, durationMinutes: 60 },
    { startsAt: t + day, durationMinutes: 4 },
    { startsAt: t + day, durationMinutes: 1441 },
    { startsAt: t + day, durationMinutes: 30.5 },
    { startsAt: String(t + day), durationMinutes: 60 },
    { startsAt: Number.NaN, durationMinutes: 60 },
    { startsAt: Infinity, durationMinutes: 60 },
    { startsAt: t + day },
    'tomorrow',
    [],
  ]) {
    assert.equal(isValidSchedule(bad, t), false, JSON.stringify(bad));
  }
});

test('invite message: cleaned (invisible characters, blank lines), trimmed and cut to 500 code points', () => {
  assert.equal(cleanInviteMessage(undefined), '');
  assert.equal(cleanInviteMessage(42), '');
  assert.equal(cleanInviteMessage('   \n\n  '), '');
  // Control, bidi-override and zero-width characters go; newlines stay (CRLF/CR become LF).
  assert.equal(cleanInviteMessage('  Hi‮ there​!\u0007\r\nLine\ttwo  \rthree '), 'Hi there!\nLine two\nthree');
  // Runs of blank lines collapse to one (whitespace-only lines count as blank).
  assert.equal(cleanInviteMessage('a\n\n\n\nb\n \n\t\n\nc\n\nd'), 'a\n\nb\n\nc\n\nd');
  // 500 code points, never splitting an emoji; longer messages are cut, not refused.
  const cut = cleanInviteMessage('😀'.repeat(600));
  assert.equal(cut, '😀'.repeat(500));
  assert.equal(cleanInviteMessage('x'.repeat(499) + ' ' + 'y'.repeat(10)), 'x'.repeat(499));
  assert.equal(cleanInviteMessage('é'.repeat(500)), 'é'.repeat(500));
});

test('email invite: the host message is in the email (escaped) and the calendar invite (RFC 5545), never logged', async () => {
  const cookie = await ownerCookie('25.0.0.6');
  const room = await newRoom(cookie, { label: 'Sync', expiresInHours: 24 * 7 });
  const startsAt = Math.ceil((Date.now() + 2 * 24 * 3600_000) / 3600_000) * 3600_000;
  const message = `  Agenda <b>&amp; "notes"</b>; budget, Q3 \\ café‮\n\n\n\nBring 'ideas' ☕  `;
  const logged: string[] = [];
  const saved = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of ['log', 'error', 'warn', 'info'] as const) {
    console[k] = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
  }
  let result: Awaited<ReturnType<typeof sendInvites>>;
  let failing: Response;
  try {
    result = await sendInvites(cookie, {
      roomId: room.roomId,
      inviteToken: room.inviteToken,
      emails: ['msg@example.com'],
      message,
      schedule: { startsAt, durationMinutes: 30 },
    });
    // A failed send logs an error: the message is not in it.
    const resend = stubResend(true);
    try {
      const body = { roomId: room.roomId, inviteToken: room.inviteToken, emails: ['f@example.com'], message };
      failing = (await handleApi(post('/api/admin/rooms/email-invite', body, cookie), inviteEnv))!;
    } finally {
      resend.restore();
    }
  } finally {
    Object.assign(console, saved);
  }
  assert.equal(result.status, 200);
  assert.equal(((await failing.json()) as InviteResult).failed[0].reason, 'send-failed');
  assert.ok(logged.length > 0);
  for (const line of logged) assert.ok(!line.includes('Agenda') && !line.includes('ideas'), line);

  const clean = `Agenda <b>&amp; "notes"</b>; budget, Q3 \\ café\n\nBring 'ideas' ☕`;
  const mail = result.calls[0].body;
  // Plain text: under the "You're invited" line, labelled, as written.
  assert.ok(mail.text.startsWith(`You're invited to Sync.\n\nMessage from the host:\n${clean}\n\nWhen: `), mail.text);
  // HTML: escaped, newlines as <br>, between the invite line and the join button.
  const html = `Agenda &lt;b&gt;&amp;amp; &quot;notes&quot;&lt;/b&gt;; budget, Q3 \\ café<br><br>Bring &#39;ideas&#39; ☕`;
  assert.ok(mail.html.includes(html), mail.html);
  assert.ok(!mail.html.includes('<b>') && !mail.html.includes('‮'));
  assert.ok(mail.html.indexOf('Message from the host:') > mail.html.indexOf("You're invited to"));
  assert.ok(mail.html.indexOf('Message from the host:') < mail.html.indexOf('Join the call'));

  // Calendar: above the Join line, RFC 5545 escaped and folded, then the passcode.
  const code = codeIn(mail.text.split('Your code:')[1]);
  const link = linkIn(mail.text);
  const ics = Buffer.from(mail.attachments[0].content, 'base64').toString('utf8');
  for (const line of ics.slice(0, -2).split('\r\n')) assert.ok(Buffer.byteLength(line, 'utf8') <= 75);
  const description = ics.replace(/\r\n /g, '').split('\r\n').find((l) => l.startsWith('DESCRIPTION:'));
  assert.equal(
    description,
    `DESCRIPTION:Agenda <b>&amp\\; "notes"</b>\\; budget\\, Q3 \\\\ café\\n\\nBring 'ideas' ☕\\n\\nJoin: ${link}\\nPasscode: ${code}`
  );
});

test('email invite: no message given, or only whitespace, means no message anywhere', async () => {
  const cookie = await ownerCookie('25.0.0.7');
  const room = await newRoom(cookie, { label: 'Plain', expiresInHours: 24 * 7 });
  const schedule = { startsAt: Date.now() + 2 * 24 * 3600_000, durationMinutes: 30 };
  for (const extra of [{}, { message: ' \n​\n ' }, { message: 42 }]) {
    const { status, calls } = await sendInvites(cookie, {
      roomId: room.roomId,
      inviteToken: room.inviteToken,
      emails: ['n@example.com'],
      passcode: false,
      schedule,
      ...extra,
    });
    assert.equal(status, 200);
    const mail = calls[0].body;
    assert.ok(!mail.text.includes('Message from the host') && !mail.html.includes('Message from the host'), JSON.stringify(extra));
    assert.ok(mail.text.startsWith("You're invited to Plain.\n\nWhen: "));
    const ics = Buffer.from(mail.attachments[0].content, 'base64').toString('utf8').replace(/\r\n /g, '');
    assert.match(ics, /\r\nDESCRIPTION:Join: https:\/\/call\.example\.com\/room\/[^\r\\]+\r\n/);
  }
});

test('invite check: right code, wrong code, no-code tokens, wrong room, expired, origin', async () => {
  const pw = await hashRoomPassword(SECRET, 'chkroom', '123456');
  const token = await signToken(SECRET, { role: 'guest', room: 'chkroom', exp: now() + 600, pw, to: 'c@example.com' });
  const right = await check({ roomId: 'chkroom', token, code: '123456' });
  assert.equal(right.status, 200);
  assert.deepEqual(right.body, { ok: true, required: true });
  const wrong = await check({ roomId: 'chkroom', token, code: '654321' });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.body, { error: 'Wrong code' });
  assert.equal((await check({ roomId: 'chkroom', token })).status, 401); // no code: required (and not counted)

  const open = await signToken(SECRET, { role: 'guest', room: 'chkroom', exp: now() + 600 });
  assert.deepEqual((await check({ roomId: 'chkroom', token: open, code: 'anything' })).body, { ok: true, required: false });

  const otherRoom = await check({ roomId: 'otherroom', token, code: '123456' });
  assert.deepEqual([otherRoom.status, otherRoom.body], [400, { error: 'Invalid invite' }]);
  const expiredToken = await signToken(SECRET, { role: 'guest', room: 'chkroom', exp: now() - 10, pw });
  const expired = await check({ roomId: 'chkroom', token: expiredToken, code: '123456' });
  assert.deepEqual([expired.status, expired.body], [400, { error: 'Invite expired' }]);
  const hostToken = await signToken(SECRET, { role: 'host', room: 'chkroom', exp: now() + 600 });
  assert.equal((await check({ roomId: 'chkroom', token: hostToken, code: '' })).status, 400);
  assert.equal((await check({ roomId: 'chkroom', token: `${token}x`, code: '123456' })).status, 400);
  assert.equal((await check({ roomId: 'Bad Room!', token, code: '123456' })).status, 400);
  const foreign = await handleApi(checkReq({ roomId: 'chkroom', token, code: '123456' }, 'https://evil.example.net'), inviteEnv);
  assert.equal(foreign!.status, 403);
  // Open mode has no invites.
  const openMode = await handleApi(checkReq({ roomId: 'chkroom', token, code: '123456' }), {});
  assert.equal(openMode!.status, 400);

  // Room passwords on ordinary invite links work too.
  const cookie = await ownerCookie('25.0.0.6');
  const room = await newRoom(cookie, { password: 'open sesame' });
  assert.deepEqual((await check({ roomId: room.roomId, token: room.inviteToken, code: 'open sesame' })).body, { ok: true, required: true });
  assert.equal((await check({ roomId: room.roomId, token: room.inviteToken, code: 'open says me' })).status, 401);
});

test('invite check: shares the join throttle (10 misses, then 429 for checks and joins alike)', async () => {
  const ip = '198.51.100.77';
  const pw = await hashRoomPassword(SECRET, 'thrroom', '424242');
  const token = await signToken(SECRET, { role: 'guest', room: 'thrroom', exp: now() + 600, pw });
  // Same client id as the Node server gives sockets from this address (and the Worker's header).
  const clientId = await throttleClientId(SECRET, ip);
  assert.equal(clientId, createHmac('sha256', SECRET).update(`client:${ipKey(ip)}`).digest('base64url').slice(0, 22));

  for (let i = 0; i < 8; i++) assert.equal((await check({ roomId: 'thrroom', token, code: '000000' }, ip)).status, 401);
  // A correct check is refunded, as on joining.
  assert.equal((await check({ roomId: 'thrroom', token, code: '424242' }, ip)).status, 200);
  // A wrong join counts against the same budget (9 used now).
  assert.deepEqual(await authorizeJoin(inviteEnv, { roomId: 'thrroom', token, password: 'nope' }, { clientId }), {
    ok: false,
    passwordRequired: true,
    invalid: true,
  });
  assert.equal((await check({ roomId: 'thrroom', token, code: '000000' }, ip)).status, 401); // 10th miss

  const limited = await check({ roomId: 'thrroom', token, code: '424242' }, ip);
  assert.equal(limited.status, 429);
  assert.deepEqual(limited.body, { error: 'Too many attempts' });
  assert.ok(Number(limited.res.headers.get('Retry-After')) > 0);
  assert.deepEqual(await authorizeJoin(inviteEnv, { roomId: 'thrroom', token, password: '424242' }, { clientId }), {
    ok: false,
    error: 'Too many password attempts',
  });
  // Other clients are unaffected.
  assert.equal((await check({ roomId: 'thrroom', token, code: '424242' }, '198.51.100.78')).status, 200);
  // A token without a code is never throttled.
  const open = await signToken(SECRET, { role: 'guest', room: 'thrroom', exp: now() + 600 });
  assert.equal((await check({ roomId: 'thrroom', token: open, code: '' }, ip)).status, 200);
});

test('invite check: a backend can run the comparison elsewhere (Cloudflare: the room Durable Object)', async () => {
  const seen: unknown[] = [];
  const checkInvite = async (input: unknown) => {
    seen.push(input);
    return new Response(JSON.stringify({ ok: true, required: true }), { headers: { 'Content-Type': 'application/json' } });
  };
  const pw = await hashRoomPassword(SECRET, 'delroom', '111111');
  const token = await signToken(SECRET, { role: 'guest', room: 'delroom', exp: now() + 600, pw });
  const open = await signToken(SECRET, { role: 'guest', room: 'delroom', exp: now() + 600 });
  assert.equal((await check({ roomId: 'delroom', token, code: '111111' }, '198.51.100.90', { checkInvite })).status, 200);
  assert.deepEqual(seen, [{ roomId: 'delroom', token, code: '111111' }]);
  // Invalid tokens and tokens without a code are answered without waking the room.
  assert.equal((await check({ roomId: 'other', token, code: '111111' }, '198.51.100.90', { checkInvite })).status, 400);
  assert.deepEqual((await check({ roomId: 'delroom', token: open, code: '' }, '198.51.100.90', { checkInvite })).body, { ok: true, required: false });
  assert.equal(seen.length, 1);
});

// Keep this last: it uses up the hourly invite cap for the rest of the file.
test('email invite: the hourly cap stops early and reports the rest as rate-limited', async () => {
  const cookie = await ownerCookie('25.0.0.9');
  const room = await newRoom(cookie);
  const batch = (n: number) => Array.from({ length: 20 }, (_, i) => `cap${n}-${i}@example.com`);
  let totalSent = 0;
  let sawLimit = false;
  for (const n of [1, 2]) {
    const emails = batch(n);
    const { status, out, calls, res } = await sendInvites(cookie, { roomId: room.roomId, inviteToken: room.inviteToken, emails });
    assert.equal(status, 200);
    assert.equal(calls.length, out.sent.length); // stopped early: nothing sent past the cap
    const limited = out.failed.filter((f) => f.reason === 'rate-limited').map((f) => f.email);
    assert.equal(out.sent.length + limited.length, 20);
    // In order: everything after the first refused address is refused too.
    assert.deepEqual([...out.sent, ...limited], emails);
    if (limited.length) {
      sawLimit = true;
      assert.ok(Number(res.headers.get('Retry-After')) > 0);
    }
    totalSent += out.sent.length;
  }
  assert.ok(sawLimit);
  assert.ok(totalSent <= 30);

  // Once at the cap, nothing is sent at all (still a 200 with per-recipient results).
  const { status, out, calls } = await sendInvites(cookie, { roomId: room.roomId, inviteToken: room.inviteToken, emails: ['after@example.com'] });
  assert.equal(status, 200);
  assert.deepEqual(out.sent, []);
  assert.deepEqual(out.failed, [{ email: 'after@example.com', reason: 'rate-limited' }]);
  assert.equal(calls.length, 0);
});
