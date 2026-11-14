import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Room,
  authorizeJoin,
  handleApi,
  hashRoomPassword,
  resolveConfig,
  signToken,
  verifyToken,
  type ServerEnv,
  type Transport,
} from '../src/core/index.js';

const SECRET = 'x'.repeat(64);
const env: ServerEnv = { SECRET_KEY: SECRET, ADMIN_PASSWORD: 'correct horse battery' };
const ORIGIN = 'https://call.example.com';
const now = () => Math.floor(Date.now() / 1000);

// ── tokens ──────────────────────────────────────────────────────────────────

test('tokens: round-trip, tamper, expiry, wrong key', async () => {
  const t = await signToken(SECRET, { role: 'guest', room: 'abc', exp: now() + 60 });
  const ok = await verifyToken(SECRET, t);
  assert.ok(ok.ok && ok.payload.room === 'abc');

  const [body, sig] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ v: 1, role: 'host', room: 'abc', exp: now() + 60 })).toString('base64url');
  assert.deepEqual(await verifyToken(SECRET, `${forged}.${sig}`), { ok: false, reason: 'invalid' });
  assert.deepEqual(await verifyToken('y'.repeat(64), t), { ok: false, reason: 'invalid' });
  assert.deepEqual(await verifyToken(SECRET, `${body}.${sig}.x`), { ok: false, reason: 'invalid' });

  const old = await signToken(SECRET, { role: 'guest', room: 'abc', exp: now() - 1 });
  assert.deepEqual(await verifyToken(SECRET, old), { ok: false, reason: 'expired' });
});

test('config: open by default, private with owner auth, error without SECRET_KEY', () => {
  assert.equal(resolveConfig({}).mode, 'open');
  assert.deepEqual(resolveConfig(env), { mode: 'private', auth: 'password' });
  assert.ok(resolveConfig({ ADMIN_PASSWORD: 'x' }).error);
  assert.ok(resolveConfig({ ADMIN_PASSWORD: 'x'.repeat(12) }).error); // no SECRET_KEY
  assert.equal(resolveConfig({ ...env, CF_ACCESS_TEAM_DOMAIN: 't.cloudflareaccess.com', CF_ACCESS_AUD: 'a' }).auth, 'access');
});

// ── authorizeJoin ───────────────────────────────────────────────────────────

test('authorizeJoin: requires a token for the right room, checks password', async () => {
  assert.deepEqual(await authorizeJoin(env, { roomId: 'abc' }), { ok: false, error: 'Invite required' });

  const other = await signToken(SECRET, { role: 'guest', room: 'zzz', exp: now() + 60 });
  assert.deepEqual(await authorizeJoin(env, { roomId: 'abc', token: other }), { ok: false, error: 'Invalid invite', fatal: true });

  const admin = await signToken(SECRET, { role: 'admin', exp: now() + 60 });
  assert.deepEqual(await authorizeJoin(env, { roomId: 'abc', token: admin }), { ok: false, error: 'Invalid invite', fatal: true });

  const pw = await hashRoomPassword(SECRET, 'abc', 'hunter2');
  const guest = await signToken(SECRET, { role: 'guest', room: 'abc', exp: now() + 60, approval: true, pw });
  assert.deepEqual(await authorizeJoin(env, { roomId: 'abc', token: guest }), { ok: false, passwordRequired: true, invalid: false });
  assert.deepEqual(await authorizeJoin(env, { roomId: 'abc', token: guest, password: 'nope' }), {
    ok: false,
    passwordRequired: true,
    invalid: true,
  });
  const good = await authorizeJoin(env, { roomId: 'abc', token: guest, password: 'hunter2' });
  assert.ok(good.ok && good.grant.role === 'guest' && good.grant.approval);
});

// ── HTTP API ────────────────────────────────────────────────────────────────

function req(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set('Origin', ORIGIN);
  headers.set('Host', 'call.example.com');
  if (init.cookie) headers.set('Cookie', init.cookie);
  if (init.body) headers.set('Content-Type', 'application/json');
  return new Request(`${ORIGIN}${path}`, { ...init, headers });
}

test('API: login, create room, ICE gated by invite', async () => {
  const bad = await handleApi(req('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: 'wrong' }) }), env, {
    clientIp: '1.1.1.1',
  });
  assert.equal(bad?.status, 401);

  const res = await handleApi(
    req('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: 'correct horse battery' }) }),
    env,
    { clientIp: '2.2.2.2' }
  );
  assert.equal(res?.status, 200);
  const setCookie = res!.headers.get('Set-Cookie')!;
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Secure/);
  const cookie = setCookie.split(';')[0];

  // Not signed in -> can't create rooms; cross-site -> refused
  assert.equal((await handleApi(req('/api/admin/rooms', { method: 'POST', body: '{}' }), env))?.status, 401);
  const crossSite = new Request(`${ORIGIN}/api/admin/rooms`, {
    method: 'POST',
    headers: { Origin: 'https://evil.example', Host: 'call.example.com', Cookie: cookie, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal((await handleApi(crossSite, env))?.status, 403);

  const created = await handleApi(
    req('/api/admin/rooms', { method: 'POST', cookie, body: JSON.stringify({ label: 'Family', password: 'pw', expiresInHours: 2 }) }),
    env
  );
  assert.equal(created?.status, 200);
  const room = (await created!.json()) as { roomId: string; inviteToken: string; hostToken: string; hasPassword: boolean };
  assert.ok(room.hasPassword);
  const invite = await verifyToken(SECRET, room.inviteToken);
  assert.ok(invite.ok && invite.payload.role === 'guest' && invite.payload.label === 'Family' && invite.payload.approval);
  const host = await verifyToken(SECRET, room.hostToken);
  assert.ok(host.ok && host.payload.role === 'host' && host.payload.room === room.roomId);

  // ICE servers: refused without an invite, allowed with one or with the owner cookie
  assert.equal((await handleApi(req('/api/ice-servers'), env))?.status, 401);
  assert.equal((await handleApi(req('/api/ice-servers', { headers: { 'X-Vchat-Token': room.inviteToken } }), env))?.status, 200);
  assert.equal((await handleApi(req('/api/ice-servers', { cookie }), env))?.status, 200);

  // Open mode: ICE servers are public
  assert.equal((await handleApi(req('/api/ice-servers'), {}))?.status, 200);
});

test('API: login throttled after repeated failures', async () => {
  const attempt = () =>
    handleApi(req('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: 'x' }) }), env, { clientIp: '9.9.9.9' });
  for (let i = 0; i < 10; i++) await attempt();
  assert.equal((await attempt())?.status, 429);
});

// ── Room.enter ──────────────────────────────────────────────────────────────

class Conn {
  open = true;
  inbox: any[] = [];
  last(type?: string) {
    const m = type ? this.inbox.filter((x) => x.type === type) : this.inbox;
    return m[m.length - 1];
  }
}
const transport: Transport<Conn> = {
  send: (c, d) => c.inbox.push(JSON.parse(d)),
  isOpen: (c) => c.open,
  close: (c) => {
    c.open = false;
  },
};
const who = (peerId: string) => ({ peerId, displayName: peerId, secret: `${peerId}-s` });
const HOST = { role: 'host' as const, approval: false };
const GUEST_APPROVAL = { role: 'guest' as const, approval: true };
const GUEST_OPEN = { role: 'guest' as const, approval: false };

test('enter: guest waits for an absent host, host arriving gets the request', async () => {
  const room = new Room<Conn>('r1', transport);
  const g = new Conn();
  await room.enter(g, who('g'), GUEST_APPROVAL);
  assert.deepEqual(g.last(), { type: 'waiting-for-admission', roomId: 'r1', hostPresent: false });

  const h = new Conn();
  await room.enter(h, who('h'), HOST);
  assert.equal(room.meta.hostPeerId, 'h');
  assert.equal(h.last().type, 'admission-request');
  room.admitPeer(h, 'g');
  assert.ok(g.inbox.some((m) => m.type === 'room-peers'));
});

test('enter: guests without approval join directly but never become host', async () => {
  const room = new Room<Conn>('r2', transport);
  const a = new Conn();
  const b = new Conn();
  await room.enter(a, who('a'), GUEST_OPEN);
  await room.enter(b, who('b'), GUEST_APPROVAL); // needs approval, but no host to approve
  assert.equal(room.meta.hostPeerId, null);
  assert.equal(b.last().type, 'waiting-for-admission');
  room.admitPeer(a, 'b');
  assert.equal(a.last().message, 'Only the host can admit peers');
});

test('enter: host leaving does not hand host powers to a guest; owner returning takes them back', async () => {
  const room = new Room<Conn>('r3', transport);
  const h = new Conn();
  const g = new Conn();
  await room.enter(h, who('h'), HOST);
  await room.enter(g, who('g'), GUEST_OPEN);
  room.leave(h);
  assert.equal(room.meta.hostPeerId, null);
  assert.deepEqual(g.last(), { type: 'host-changed', hostPeerId: null });

  const h2 = new Conn();
  await room.enter(h2, who('h'), HOST);
  assert.equal(room.meta.hostPeerId, 'h');
  assert.deepEqual(g.last(), { type: 'host-changed', hostPeerId: 'h' });
});

// ── Hardening (security review) ──────────────────────────────────────────────

test('config fails closed: partial Access or short/empty password never means open mode', () => {
  assert.equal(resolveConfig({ CF_ACCESS_AUD: 'a' }).mode, 'private');
  assert.ok(resolveConfig({ CF_ACCESS_AUD: 'a' }).error);
  assert.ok(resolveConfig({ ADMIN_PASSWORD: '' }).error);
  assert.ok(resolveConfig({ ADMIN_PASSWORD: 'short', SECRET_KEY: SECRET }).error);
});

test('open mode never hands out TURN credentials unless OPEN_MODE_TURN=1', async () => {
  const openEnv = { TURN_URLS: 'turn:x:3478', TURN_SECRET: 's' };
  const res = await handleApi(req('/api/ice-servers'), openEnv);
  const body = (await res!.json()) as { iceServers: { username?: string }[] };
  assert.ok(body.iceServers.every((s) => !s.username));
  const res2 = await handleApi(req('/api/ice-servers'), { ...openEnv, OPEN_MODE_TURN: '1', STUN_URLS: 'stun:other:1' });
  const body2 = (await res2!.json()) as { iceServers: { username?: string }[] };
  assert.ok(body2.iceServers.some((s) => s.username));
});

test('changing ADMIN_PASSWORD signs existing owner sessions out', async () => {
  const res = await handleApi(
    req('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: 'correct horse battery' }) }),
    env,
    { clientIp: '7.7.7.7' }
  );
  const cookie = res!.headers.get('Set-Cookie')!.split(';')[0];
  const session = async (e: ServerEnv) => ((await (await handleApi(req('/api/admin/session', { cookie }), e))!.json()) as any).authenticated;
  assert.equal(await session(env), true);
  assert.equal(await session({ ...env, ADMIN_PASSWORD: 'a different password' }), false);
});

test('websocket gate: needs a genuine token for this room (expired is let through to explain)', async () => {
  const { authorizeSocket } = await import('../src/core/index.js');
  const good = await signToken(SECRET, { role: 'guest', room: 'abc', exp: now() + 60 });
  const expired = await signToken(SECRET, { role: 'guest', room: 'abc', exp: now() - 60 });
  const other = await signToken(SECRET, { role: 'guest', room: 'zzz', exp: now() + 60 });
  const admin = await signToken(SECRET, { role: 'admin', exp: now() + 60 });
  const hdr = (t: string) => `vchat.v1, vchat.t.${t}`;
  assert.equal(await authorizeSocket(env, 'abc', hdr(good)), true);
  assert.equal(await authorizeSocket(env, 'abc', hdr(expired)), true);
  assert.equal(await authorizeSocket(env, 'abc', hdr(other)), false);
  assert.equal(await authorizeSocket(env, 'abc', hdr(admin)), false);
  assert.equal(await authorizeSocket(env, 'abc', 'vchat.v1'), false);
  assert.equal(await authorizeSocket({}, 'abc', null), true); // open mode
});

test('owner always gets into their own room, and guests can never approve', async () => {
  const room = new Room<Conn>('full', transport);
  for (let i = 0; i < 6; i++) await room.enter(new Conn(), who(`g${i}`), GUEST_OPEN);
  const h = new Conn();
  await room.enter(h, who('h'), HOST);
  assert.equal(room.meta.hostPeerId, 'h');
  assert.equal(room.peers().length, 7);
});

test('owner refreshing does not kick guests waiting for approval', async () => {
  const room = new Room<Conn>('wait', transport);
  const h = new Conn();
  await room.enter(h, who('h'), HOST);
  const g = new Conn();
  await room.enter(g, who('g'), GUEST_APPROVAL);
  room.leave(h); // owner refreshes
  assert.deepEqual(g.last(), { type: 'waiting-for-admission', roomId: 'wait', hostPresent: false });
  const h2 = new Conn();
  await room.enter(h2, who('h'), HOST);
  assert.equal(h2.last().type, 'admission-request');
});

test('look-alike names are made unique; invisible characters are stripped', async () => {
  const room = new Room<Conn>('names', transport);
  await room.enter(new Conn(), { peerId: 'a', displayName: 'Alex', secret: 'a' }, GUEST_OPEN);
  const b = new Conn();
  await room.enter(b, { peerId: 'b', displayName: 'alex', secret: 'b' }, GUEST_OPEN);
  assert.equal(room.members.get(b)?.displayName, 'alex (2)');
  const { parseClientMessage } = await import('../src/core/index.js');
  const parsed = parseClientMessage(JSON.stringify({ type: 'join', roomId: 'r', peerId: 'p', displayName: 'Ow​ner‮' }));
  assert.ok(parsed.ok && parsed.msg.type === 'join' && parsed.msg.displayName === 'Owner');
});
