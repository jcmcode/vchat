import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room, WAITING_TIMEOUT_MS, parseClientMessage, type Transport } from '../src/core/index.js';

class FakeConn {
  open = true;
  inbox: any[] = [];
  constructor(public name: string) {}
  last(type?: string) {
    const msgs = type ? this.inbox.filter((m) => m.type === type) : this.inbox;
    return msgs[msgs.length - 1];
  }
  types() {
    return this.inbox.map((m) => m.type);
  }
}

const transport: Transport<FakeConn> = {
  send: (c, data) => c.inbox.push(JSON.parse(data)),
  isOpen: (c) => c.open,
  close: (c) => {
    c.open = false;
  },
};

const enter = (peerId: string, extra: Record<string, string> = {}) => ({
  peerId,
  displayName: peerId.toUpperCase(),
  secret: `${peerId}-secret`,
  ...extra,
});

async function roomWithHost() {
  const room = new Room<FakeConn>('abc123', transport);
  const host = new FakeConn('host');
  await room.create(host, enter('host'));
  return { room, host };
}

test('creator becomes host; second create is rejected', async () => {
  const { room, host } = await roomWithHost();
  assert.deepEqual(host.types(), ['room-created', 'room-peers', 'host-changed']);
  const other = new FakeConn('other');
  await room.create(other, enter('other'));
  assert.equal(other.last().message, 'Room already exists');
  assert.equal(room.peers().length, 1);
});

test('joining a non-existent room errors', async () => {
  const room = new Room<FakeConn>('nope', transport);
  const c = new FakeConn('c');
  await room.join(c, enter('c'));
  assert.equal(c.last().message, 'Room does not exist');
  assert.ok(room.isEmpty());
});

test('admission flow: wait, admit, peers notified', async () => {
  const { room, host } = await roomWithHost();
  const guest = new FakeConn('guest');
  await room.join(guest, enter('guest'));
  assert.equal(guest.last().type, 'waiting-for-admission');
  assert.equal(host.last().type, 'admission-request');

  room.admitPeer(host, 'guest');
  assert.ok(guest.types().includes('admission-granted'));
  assert.deepEqual(guest.last('room-peers').peers, [{ id: 'host', displayName: 'HOST' }]);
  assert.equal(host.last().type, 'peer-joined');
});

test('waiting peer that disconnects is removed and host is told (no ghost peer)', async () => {
  const { room, host } = await roomWithHost();
  const guest = new FakeConn('guest');
  await room.join(guest, enter('guest'));
  guest.open = false;
  room.leave(guest);
  assert.equal(host.last().type, 'admission-cancelled');
  room.admitPeer(host, 'guest');
  assert.equal(host.last().message, 'Peer not in waiting queue');
  assert.equal(room.peers().length, 1);
});

test('non-host cannot admit', async () => {
  const { room, host } = await roomWithHost();
  const a = new FakeConn('a');
  await room.join(a, enter('a'));
  room.admitPeer(host, 'a');
  const b = new FakeConn('b');
  await room.join(b, enter('b'));
  room.admitPeer(a, 'b');
  assert.equal(a.last().message, 'Only the host can admit peers');
});

test('password required, wrong password flagged invalid', async () => {
  const room = new Room<FakeConn>('pw', transport);
  const host = new FakeConn('host');
  await room.create(host, enter('host', { password: 'hunter2' }));
  const g = new FakeConn('g');
  await room.join(g, enter('g'));
  assert.deepEqual(g.last(), { type: 'password-required', roomId: 'pw', invalid: false });
  await room.join(g, enter('g', { password: 'nope' }));
  assert.equal(g.last().invalid, true);
  await room.join(g, enter('g', { password: 'hunter2' }));
  assert.equal(g.last().type, 'waiting-for-admission');
});

test('admitted peer rejoining with same secret skips admission and replaces stale socket', async () => {
  const { room, host } = await roomWithHost();
  const g1 = new FakeConn('g1');
  await room.join(g1, enter('guest'));
  room.admitPeer(host, 'guest');

  // Network blip: new socket arrives before the old one is noticed as dead.
  const g2 = new FakeConn('g2');
  await room.join(g2, enter('guest'));
  assert.equal(g1.open, false);
  assert.equal(g2.last('room-peers').peers.length, 1);
  assert.equal(room.peers().length, 2);

  // Someone guessing the peerId without the secret is refused.
  const imposter = new FakeConn('imp');
  await room.join(imposter, { peerId: 'guest', displayName: 'X', secret: 'wrong' });
  assert.equal(imposter.last().message, 'Peer ID already in use');
});

test('solo host reconnecting keeps room, password and host role', async () => {
  const room = new Room<FakeConn>('solo', transport);
  const h1 = new FakeConn('h1');
  await room.create(h1, enter('host', { password: 'pw' }));
  const h2 = new FakeConn('h2');
  await room.join(h2, enter('host'));
  assert.equal(h2.last().type, 'host-changed');
  assert.equal(h2.last().hostPeerId, 'host');
  assert.ok(room.meta.passwordHash);
});

test('host leaving promotes next peer and re-sends pending requests', async () => {
  const { room, host } = await roomWithHost();
  const a = new FakeConn('a');
  await room.join(a, enter('a'));
  room.admitPeer(host, 'a');
  const w = new FakeConn('w');
  await room.join(w, enter('w'));
  room.leave(host);
  assert.equal(room.meta.hostPeerId, 'a');
  assert.ok(a.types().includes('host-changed'));
  assert.equal(a.last().type, 'admission-request');
});

test('last peer leaving closes room and denies waiting peers', async () => {
  const { room, host } = await roomWithHost();
  const w = new FakeConn('w');
  await room.join(w, enter('w'));
  room.leave(host);
  assert.equal(w.last().reason, 'Room closed');
  assert.ok(room.isEmpty());
});

test('waiting peers time out', async () => {
  const { room, host } = await roomWithHost();
  const w = new FakeConn('w');
  await room.join(w, enter('w'));
  room.expireWaiting(Date.now() + WAITING_TIMEOUT_MS + 1);
  assert.equal(w.last().reason, 'Timed out waiting for host');
  assert.equal(host.last().type, 'admission-cancelled');
  assert.equal(room.nextWaitingDeadline(), null);
});

test('room capacity is enforced at admission time', async () => {
  const { room, host } = await roomWithHost();
  for (let i = 0; i < 5; i++) {
    const c = new FakeConn(`p${i}`);
    await room.join(c, enter(`p${i}`));
    room.admitPeer(host, `p${i}`);
  }
  assert.equal(room.peers().length, 6);
  const late = new FakeConn('late');
  await room.join(late, enter('late'));
  assert.equal(late.last().message, 'Room is full');
});

test('signals only flow between admitted peers', async () => {
  const { room, host } = await roomWithHost();
  const w = new FakeConn('w');
  await room.join(w, enter('w'));
  room.signal(w, 'host', { sdp: 'x' });
  assert.notEqual(host.last().type, 'signal');
  room.admitPeer(host, 'w');
  room.signal(w, 'host', { sdp: 'x' });
  assert.deepEqual(host.last(), { type: 'signal', fromPeerId: 'w', signal: { sdp: 'x' } });
});

test('parser validates input', () => {
  assert.equal(parseClientMessage('nope').ok, false);
  assert.equal(parseClientMessage(JSON.stringify({ type: 'join', roomId: 'UPPER', peerId: 'a', displayName: 'x' })).ok, false);
  const ok = parseClientMessage(JSON.stringify({ type: 'join', roomId: 'abc', peerId: 'a', displayName: '  Bob\u0007 ' }));
  assert.ok(ok.ok && ok.msg.type === 'join' && ok.msg.displayName === 'Bob');
});
