// Regression tests for the second security review (throttles, identity takeover, remove-peer,
// token malleability, fail-closed config, TURN credentials, names, nothing-stored metadata).
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
  ipKey,
  nameKey,
  parseClientMessage,
  resolveConfig,
  signToken,
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
  assert.deepEqual(cfg, { mode: 'private', auth: null, misconfigured: true });
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
  assert.deepEqual(room.meta.admitted, {});
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

test('TURN: ICE endpoint takes host/guest tokens only, and never caches coturn credentials', async () => {
  const turnEnv: ServerEnv = { ...env, TURN_URLS: 'turn:t:3478', TURN_SECRET: 's' };
  const admin = await signToken(SECRET, { role: 'admin', exp: now() + 600 });
  const ice = (token: string) =>
    handleApi(new Request('https://x.test/api/ice-servers', { headers: { 'X-Vchat-Token': token } }), turnEnv);
  assert.equal((await ice(admin))?.status, 401);
  const invite = await signToken(SECRET, { role: 'guest', room: 'abc', exp: now() + 600 });
  const first = (await (await ice(invite))!.json()) as { iceServers: { username?: string }[]; ttl: number };
  const second = (await (await ice(invite))!.json()) as { iceServers: { username?: string }[] };
  assert.notEqual(first.iceServers.find((s) => s.username)?.username, second.iceServers.find((s) => s.username)?.username);
  assert.ok(first.ttl <= 600);
});
