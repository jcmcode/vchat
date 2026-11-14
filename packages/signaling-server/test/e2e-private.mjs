// End-to-end check of private mode (owner sign-in + invite links) against a running backend.
// Usage: ADMIN_PASSWORD=... node test/e2e-private.mjs http://localhost:3001
import WebSocket from 'ws';

const base = process.argv[2] ?? 'http://localhost:3001';
const password = process.env.ADMIN_PASSWORD;
if (!password) throw new Error('set ADMIN_PASSWORD to the server owner password');
const origin = new URL(base).origin;
const ok = (label) => console.log(`  ✔ ${label}`);
const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const cfg = await fetch(`${base}/api/config`).then((r) => r.json());
expect(cfg.mode === 'private' && !cfg.misconfigured, `server not in private mode: ${JSON.stringify(cfg)}`);
expect(Object.keys(cfg).sort().join() === 'auth,emailInvites,misconfigured,mode', `config leaks extra fields: ${JSON.stringify(cfg)}`);
ok(`private mode (${cfg.auth})`);

expect((await fetch(`${base}/api/ice-servers`)).status === 401, 'ICE servers should need an invite');
ok('TURN credentials refused without an invite');

const post = (path, body, cookie) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });

expect((await post('/api/admin/rooms', {})).status === 401, 'room creation should need sign-in');
const login = await post('/api/admin/login', { password });
expect(login.ok, `login failed: ${login.status}`);
const cookie = login.headers.get('set-cookie').split(';')[0];
ok('owner signed in');

const room = await (await post('/api/admin/rooms', { label: 'E2E', password: 'pw123', approval: true }, cookie)).json();
expect(room.roomId && room.inviteToken && room.hostToken, 'room creation failed');
ok(`room created: ${room.roomId}`);

expect(
  (await fetch(`${base}/api/ice-servers`, { headers: { 'X-Vchat-Token': room.inviteToken } })).ok,
  'invite should unlock ICE servers'
);
ok('invite unlocks TURN credentials');

// The invite/host token travels as a WebSocket subprotocol, checked before the socket is accepted.
function connect(token, roomId = room.roomId) {
  const protocols = token ? ['vchat.v1', `vchat.t.${token}`] : ['vchat.v1'];
  return new WebSocket(`${base.replace(/^http/, 'ws')}/ws?room=${roomId}`, protocols, { headers: { Origin: origin } });
}

function rejected(token) {
  return new Promise((resolve) => {
    const ws = connect(token);
    ws.on('open', () => {
      ws.close();
      resolve(false);
    });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode === 401));
    ws.on('error', () => resolve(true));
  });
}

function client(name, token) {
  const ws = connect(token);
  const inbox = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    const w = waiters.find((x) => x.type === m.type);
    if (w) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(m);
    } else inbox.push(m);
  });
  return {
    ws,
    closed: new Promise((r) => ws.on('close', (code) => r(code))),
    opened: new Promise((r) => ws.on('open', r)),
    send: (m) => ws.send(JSON.stringify(m)),
    wait: (type) => {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        waiters.push({ type, resolve });
        setTimeout(() => reject(new Error(`${name}: timed out waiting for ${type}`)), 5000);
      });
    },
  };
}

expect(await rejected(undefined), 'socket without invite should be refused');
expect(await rejected(room.inviteToken.slice(0, -2) + 'xx'), 'socket with forged invite should be refused');
ok('connections without a valid invite are refused before a socket exists');

const intruder = client('intruder', room.inviteToken);
await intruder.opened;
intruder.send({ type: 'create-room', roomId: room.roomId, peerId: 'intruder', displayName: 'X' });
expect((await intruder.wait('error')).message === 'Invite required', 'create-room should be refused');
intruder.send({ type: 'join', roomId: room.roomId, peerId: 'intruder', displayName: 'X' });
expect((await intruder.wait('error')).message === 'Invite required', 'join message without invite should be refused');
ok('create-room and token-less join refused even on an invited socket');
intruder.send({ type: 'join', roomId: 'otherroom', peerId: 'intruder', displayName: 'X', token: room.inviteToken });
expect((await intruder.wait('error')).message === 'Room ID does not match connection', 'socket must stay bound to its room');
ok('a socket can only be used for the room it was authorized for');
intruder.send({ type: 'join', roomId: room.roomId, peerId: 'intruder', displayName: 'X', token: room.inviteToken.slice(0, -2) + 'xx' });
expect((await intruder.wait('error')).message === 'Invalid invite', 'forged token in join should be refused');
expect((await intruder.closed) === 4003, 'socket should be closed with 4003 after an invalid invite');
ok('invalid invite in join closes the socket (4003)');

const guest = client('guest', room.inviteToken);
await guest.opened;
guest.send({ type: 'join', roomId: room.roomId, peerId: 'guest1', displayName: 'Guest', secret: 'gs', token: room.inviteToken });
expect((await guest.wait('password-required')).invalid === false, 'expected password prompt');
guest.send({ type: 'join', roomId: room.roomId, peerId: 'guest1', displayName: 'Guest', secret: 'gs', token: room.inviteToken, password: 'pw123' });
const waiting = await guest.wait('waiting-for-admission');
expect(waiting.hostPresent === false, 'host should not be present yet');
ok('guest with invite + password waits for the (absent) host');

const host = client('host', room.hostToken);
await host.opened;
host.send({ type: 'join', roomId: room.roomId, peerId: 'owner', displayName: 'Owner', secret: 'hs', token: room.hostToken });
await host.wait('room-peers');
const hc = await host.wait('host-changed');
expect(hc.hostPeerId === 'owner', 'owner should be host');
const reqMsg = await host.wait('admission-request');
expect(reqMsg.peerId === 'guest1', 'host should get the pending request');
ok('owner joins with host link and sees the waiting guest');

host.send({ type: 'admit-peer', peerId: 'guest1' });
await guest.wait('admission-granted');
await guest.wait('room-peers');
await host.wait('peer-joined');
guest.send({ type: 'signal', targetPeerId: 'owner', signal: { sid: 's', data: { type: 'offer' } } });
expect((await host.wait('signal')).fromPeerId === 'guest1', 'signal relay failed');
ok('guest admitted; signaling flows');

const guest2 = client('guest2', room.inviteToken);
await guest2.opened;
guest2.send({ type: 'join', roomId: room.roomId, peerId: 'guest2', displayName: 'Guest', secret: 'g2', token: room.inviteToken, password: 'pw123' });
await guest2.wait('waiting-for-admission');
host.send({ type: 'admit-peer', peerId: 'guest2' });
await guest2.wait('room-peers');
const named = await host.wait('peer-joined');
expect(named.displayName === 'Guest (2)', `duplicate names should be made unique, got ${named.displayName}`);
host.send({ type: 'remove-peer', peerId: 'guest2' });
expect((await guest2.wait('removed')).reason === 'Removed by host', 'removed peer should be told');
expect((await guest2.closed) === 4002, 'removed peer should be closed with 4002');
const back = client('back', room.inviteToken);
await back.opened;
back.send({ type: 'join', roomId: room.roomId, peerId: 'guest2', displayName: 'Again', secret: 'g2', token: room.inviteToken, password: 'pw123' });
await back.wait('removed');
ok('host removes a guest (removed + 4002); they cannot come back');

const thief = client('thief', room.inviteToken);
await thief.opened;
thief.send({ type: 'join', roomId: room.roomId, peerId: 'owner', displayName: 'Owner', secret: 'hs', token: room.inviteToken, password: 'pw123' });
expect((await thief.wait('error')).message === 'Peer ID already in use', 'guest must not take over the host identity');
ok("a guest can't take over the owner's identity");

[guest, host, thief].forEach((c) => c.ws.close());
console.log(`All private-mode checks passed against ${base}`);
process.exit(0);
