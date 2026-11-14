// Host controls: locking the room and ending the call for everyone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOSE_ENDED,
  CLOSE_LOCKED,
  ENDED_GRACE_MS,
  Room,
  normalizeMeta,
  parseClientMessage,
  type MemberState,
  type Transport,
} from '../src/core/index.js';

class Conn {
  open = true;
  closedWith: number | null = null;
  inbox: any[] = [];
  constructor(public name = '') {}
  last(type?: string) {
    const m = type ? this.inbox.filter((x) => x.type === type) : this.inbox;
    return m[m.length - 1];
  }
  types() {
    return this.inbox.map((m) => m.type);
  }
}

const transport: Transport<Conn> = {
  send: (c, d) => c.inbox.push(JSON.parse(d)),
  isOpen: (c) => c.open,
  close: (c, code) => {
    c.open = false;
    c.closedWith ??= code;
  },
};

const who = (peerId: string, extra: Record<string, string> = {}) => ({ peerId, displayName: peerId, secret: `${peerId}-s`, ...extra });
const HOST = { role: 'host' as const, approval: false };
const GUEST_OPEN = { role: 'guest' as const, approval: false };
const GUEST_APPROVAL = { role: 'guest' as const, approval: true };

async function privateRoom(id = 'priv') {
  const room = new Room<Conn>(id, transport);
  const h = new Conn('h');
  await room.enter(h, who('h'), HOST);
  return { room, h };
}

async function openRoom(id = 'open', password?: string) {
  const room = new Room<Conn>(id, transport);
  const h = new Conn('h');
  await room.create(h, who('h', password ? { password } : {}));
  return { room, h };
}

function withClock<T>(offsetMs: number, fn: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  Date.now = () => realNow() + offsetMs;
  return fn().finally(() => {
    Date.now = realNow;
  });
}

// ── Parser ────────────────────────────────────────────────────────────────────

test('parser: lock-room, unlock-room and end-room carry no fields', () => {
  for (const type of ['lock-room', 'unlock-room', 'end-room']) {
    const parsed = parseClientMessage(JSON.stringify({ type, locked: 'yes', peerId: '__proto__', extra: { a: 1 } }));
    assert.deepEqual(parsed, { ok: true, msg: { type } });
  }
  assert.equal(parseClientMessage(JSON.stringify({ type: 'end-room-now' })).ok, false);
  assert.equal(parseClientMessage(JSON.stringify({ type: 'set-lock', locked: true })).ok, false);
});

// ── Locking ───────────────────────────────────────────────────────────────────

test('lock: only the host can lock or unlock, and everyone in the call is told', async () => {
  const { room, h } = await privateRoom();
  const g = new Conn('g');
  await room.enter(g, who('g'), GUEST_OPEN);

  room.setLocked(g, true);
  assert.equal(g.last().message, 'Only the host can lock the room');
  assert.equal(room.meta.locked, false);

  room.setLocked(h, true);
  assert.equal(room.meta.locked, true);
  assert.deepEqual(h.last(), { type: 'lock-changed', locked: true });
  assert.deepEqual(g.last(), { type: 'lock-changed', locked: true });

  room.setLocked(g, false);
  assert.equal(g.last().message, 'Only the host can unlock the room');
  assert.equal(room.meta.locked, true);

  // Idempotent: locking again tells only the host (no broadcast storm from repeated clicks).
  const before = g.inbox.length;
  room.setLocked(h, true);
  assert.equal(g.inbox.length, before);
  assert.deepEqual(h.last(), { type: 'lock-changed', locked: true });

  room.setLocked(h, false);
  assert.deepEqual(g.last(), { type: 'lock-changed', locked: false });
});

test('lock: a waiting guest cannot lock the room (private mode)', async () => {
  const { room } = await privateRoom();
  const w = new Conn('w');
  await room.enter(w, who('w'), GUEST_APPROVAL);
  room.setLocked(w, true);
  assert.equal(w.last().message, 'Only the host can lock the room');
  assert.equal(room.meta.locked, false);
});

test('lock: new guests are refused even with a valid invite, and told why; the socket is closed with 4005', async () => {
  const { room, h } = await privateRoom();
  room.setLocked(h, true);

  for (const grant of [GUEST_OPEN, GUEST_APPROVAL]) {
    const n = new Conn('n');
    await room.enter(n, who(`n${grant.approval}`), grant);
    assert.deepEqual(n.last(), { type: 'error', message: 'Room is locked' });
    assert.equal(n.closedWith, CLOSE_LOCKED);
    assert.equal(room.has(n), false);
  }
  // Nobody was queued, so the host isn't bothered with requests.
  assert.equal(h.inbox.filter((m) => m.type === 'admission-request').length, 0);
  assert.equal(room.waiting().length, 0);
});

test('lock: admitted peers reconnect, and are told the room is locked after room-peers', async () => {
  const { room, h } = await privateRoom();
  const g1 = new Conn('g1');
  await room.enter(g1, who('g'), GUEST_OPEN);
  room.setLocked(h, true);

  // Network drop: the guest comes back on a new socket with the same peer id and secret.
  const g2 = new Conn('g2');
  await room.enter(g2, who('g'), GUEST_OPEN);
  assert.equal(g2.closedWith, null);
  const types = g2.types();
  assert.ok(types.includes('room-peers'));
  assert.ok(types.indexOf('lock-changed') > types.indexOf('room-peers'));
  assert.deepEqual(g2.last('lock-changed'), { type: 'lock-changed', locked: true });

  // The same peer id with another secret is still a new (refused) attempt.
  const imposter = new Conn('imp');
  await room.enter(imposter, { peerId: 'g', displayName: 'g', secret: 'other' }, GUEST_OPEN);
  assert.equal(imposter.last().message, 'Peer ID already in use');
  assert.equal(room.peers().length, 2);
});

test('lock: the owner always gets in, even with a fresh identity', async () => {
  const { room, h } = await privateRoom();
  room.setLocked(h, true);
  const h2 = new Conn('h2');
  await room.enter(h2, who('owner-other-tab'), HOST);
  assert.equal(h2.closedWith, null);
  assert.ok(h2.types().includes('room-peers'));
  assert.equal(room.meta.hostPeerId, 'owner-other-tab');
});

test('lock: guests already waiting stay queued; the host can still admit or deny them', async () => {
  const { room, h } = await privateRoom();
  const a = new Conn('a');
  const b = new Conn('b');
  await room.enter(a, who('a'), GUEST_APPROVAL);
  await room.enter(b, who('b'), GUEST_APPROVAL);
  room.setLocked(h, true);
  assert.equal(room.waiting().length, 2);

  // A waiting guest whose socket blipped (the old one is still here) keeps their place.
  const a2 = new Conn('a2');
  await room.enter(a2, who('a'), GUEST_APPROVAL);
  assert.equal(a2.last().type, 'waiting-for-admission');
  assert.equal(a.closedWith, 4000);
  assert.equal(room.waiting().length, 2);

  room.admitPeer(h, 'a');
  assert.ok(a2.types().includes('room-peers'));
  assert.deepEqual(a2.last('lock-changed'), { type: 'lock-changed', locked: true });
  room.denyPeer(h, 'b');
  assert.equal(b.last().reason, 'Denied by host');
});

test('lock: a waiting guest who dropped out entirely is a new attempt and is refused', async () => {
  const { room, h } = await privateRoom();
  const w = new Conn('w');
  await room.enter(w, who('w'), GUEST_APPROVAL);
  room.setLocked(h, true);
  w.open = false;
  room.leave(w);
  const w2 = new Conn('w2');
  await room.enter(w2, who('w'), GUEST_APPROVAL);
  assert.equal(w2.last().message, 'Room is locked');
  assert.equal(w2.closedWith, CLOSE_LOCKED);
});

test('lock: stays locked when the host leaves (fail closed); only the returning owner can unlock', async () => {
  const { room, h } = await privateRoom();
  const g = new Conn('g');
  await room.enter(g, who('g'), GUEST_OPEN);
  room.setLocked(h, true);
  room.leave(h);
  assert.equal(room.meta.hostPeerId, null);
  assert.equal(room.meta.locked, true);

  room.setLocked(g, false);
  assert.equal(room.meta.locked, true);
  const late = new Conn('late');
  await room.enter(late, who('late'), GUEST_OPEN);
  assert.equal(late.last().message, 'Room is locked');

  const h2 = new Conn('h2');
  await room.enter(h2, who('h'), HOST);
  assert.equal(h2.last('lock-changed').locked, true);
  room.setLocked(h2, false);
  assert.deepEqual(g.last(), { type: 'lock-changed', locked: false });
  const later = new Conn('later');
  await room.enter(later, who('later'), GUEST_OPEN);
  assert.ok(later.types().includes('room-peers'));
});

test('lock: stays locked while invited guests wait for an absent owner; forgotten once the room empties', async () => {
  const { room, h } = await privateRoom();
  const w = new Conn('w');
  await room.enter(w, who('w'), GUEST_APPROVAL);
  room.setLocked(h, true);
  room.leave(h); // owner refreshing: the waiting guest stays
  assert.equal(room.meta.locked, true);
  room.leave(w);
  assert.ok(room.isEmpty());
  assert.equal(room.meta.locked, false);

  const g = new Conn('g');
  await room.enter(g, who('g'), GUEST_OPEN);
  assert.ok(g.types().includes('room-peers'));
});

test('lock: open mode — the host passes on, the lock stays; the last one out clears it', async () => {
  const { room, h } = await openRoom();
  const a = new Conn('a');
  await room.join(a, who('a'));
  room.admitPeer(h, 'a');
  room.setLocked(h, true);

  const n = new Conn('n');
  await room.join(n, who('n'));
  assert.deepEqual(n.last(), { type: 'error', message: 'Room is locked' });
  assert.equal(n.closedWith, CLOSE_LOCKED);

  room.leave(h);
  assert.equal(room.meta.hostPeerId, 'a');
  assert.equal(room.meta.locked, true);
  room.leave(a);
  assert.equal(room.meta.locked, false);
});

test('lock: open mode checks the room password first, so strangers do not learn the room is locked', async () => {
  const { room, h } = await openRoom('pwlock', 'hunter2');
  room.setLocked(h, true);
  const n = new Conn('n');
  await room.join(n, who('n'));
  assert.deepEqual(n.last(), { type: 'password-required', roomId: 'pwlock', invalid: false });
  await room.join(n, who('n', { password: 'wrong' }));
  assert.equal(n.last().invalid, true);
  assert.equal(n.open, true);
  await room.join(n, who('n', { password: 'hunter2' }));
  assert.equal(n.last().message, 'Room is locked');

  // The open-mode host reconnecting (same peer id + secret) skips the lock, as any admitted peer.
  const h2 = new Conn('h2');
  await room.join(h2, who('h'));
  assert.equal(h2.closedWith, null);
  assert.equal(h2.last('lock-changed').locked, true);
});

test('lock: survives a restore from attachments (Cloudflare hibernation); old metadata reads as unlocked', async () => {
  const { room, h } = await privateRoom('hib');
  const g = new Conn('g');
  await room.enter(g, who('g'), GUEST_OPEN);
  room.setLocked(h, true);

  // What the Durable Object keeps in each socket's attachment, serialized.
  const meta = JSON.parse(JSON.stringify(room.meta));
  const members: [Conn, MemberState][] = [...room.members].map(([c, s]) => [c, JSON.parse(JSON.stringify(s))]);
  const woken = new Room<Conn>('hib', transport, {}, { meta, members });
  assert.equal(woken.meta.locked, true);
  const n = new Conn('n');
  await woken.enter(n, who('n'), GUEST_OPEN);
  assert.equal(n.last().message, 'Room is locked');

  const { locked: _locked, ...older } = meta;
  assert.equal(normalizeMeta(older)?.locked, false);
  assert.equal(normalizeMeta({ ...older, locked: 'yes' as unknown as boolean })?.locked, false);
});

test('lock: the lock change is reported through onMetaChange (so Cloudflare copies it to every socket)', async () => {
  const seen: (boolean | undefined)[] = [];
  const room = new Room<Conn>('hooks', transport, { onMetaChange: (m) => seen.push(m?.locked) });
  const h = new Conn('h');
  await room.enter(h, who('h'), HOST);
  seen.length = 0;
  room.setLocked(h, true);
  room.setLocked(h, false);
  assert.deepEqual(seen, [true, false]);
});

// ── Ending the call ───────────────────────────────────────────────────────────

test('end: only the host can end the call', async () => {
  const { room, h } = await privateRoom();
  const g = new Conn('g');
  const w = new Conn('w');
  await room.enter(g, who('g'), GUEST_OPEN);
  await room.enter(w, who('w'), GUEST_APPROVAL);
  room.endRoom(g);
  assert.equal(g.last().message, 'Only the host can end the call');
  room.endRoom(w);
  assert.equal(w.last().message, 'Only the host can end the call');
  assert.equal(room.peers().length, 2);
  assert.equal(h.closedWith, null);

  // Open mode: a participant who isn't the host can't either.
  const open = await openRoom('openend');
  const a = new Conn('a');
  await open.room.join(a, who('a'));
  open.room.admitPeer(open.h, 'a');
  open.room.endRoom(a);
  assert.equal(a.last().message, 'Only the host can end the call');
  assert.equal(open.room.peers().length, 2);
});

test('end: every participant and waiting guest is told, closed with 4004, and the room is forgotten', async () => {
  const metaChanges: unknown[] = [];
  const room = new Room<Conn>('priv', transport, { onMetaChange: (m) => metaChanges.push(m) });
  const h = new Conn('h');
  const g = new Conn('g');
  const w = new Conn('w');
  await room.enter(h, who('h'), HOST);
  await room.enter(g, who('g'), GUEST_OPEN);
  await room.enter(w, who('w'), GUEST_APPROVAL);
  room.setLocked(h, true);

  room.endRoom(h);
  for (const c of [h, g, w]) {
    assert.deepEqual(c.last(), { type: 'room-ended', roomId: 'priv', reason: 'Ended by host' });
    assert.equal(c.closedWith, CLOSE_ENDED);
  }
  // Nobody is told someone "left": the call is simply over.
  assert.equal(g.inbox.filter((m) => m.type === 'peer-left').length, 0);
  assert.ok(room.isEmpty());
  assert.equal(room.meta.locked, false);
  assert.deepEqual(Object.keys(room.meta.admitted), []);
  assert.equal(room.meta.hostPeerId, null);
  assert.deepEqual(metaChanges.at(-1), null);
  assert.equal(room.recentlyEnded(), true);
});

test('end: for a minute, stragglers get room-ended instead of re-opening the room (open mode)', async () => {
  const { room, h } = await openRoom('gone');
  room.endRoom(h);

  // A participant who was offline at that moment reconnects and tries to re-create the room.
  const stale = new Conn('stale');
  await room.create(stale, who('stale'));
  assert.equal(stale.last().type, 'room-ended');
  assert.equal(stale.closedWith, CLOSE_ENDED);
  const joiner = new Conn('joiner');
  await room.join(joiner, who('joiner'));
  assert.equal(joiner.last().type, 'room-ended');
  assert.ok(room.isEmpty());

  // After the grace period the code is free again (open mode: anyone may create rooms).
  await withClock(ENDED_GRACE_MS + 1, async () => {
    assert.equal(room.recentlyEnded(), false);
    const fresh = new Conn('fresh');
    await room.create(fresh, who('fresh'));
    assert.deepEqual(fresh.types(), ['room-created', 'room-peers', 'host-changed']);
  });
});

test('end: invited guests are refused during the grace period; the owner can open the room again at once', async () => {
  const { room, h } = await privateRoom('again');
  room.endRoom(h);

  const g = new Conn('g');
  await room.enter(g, who('g'), GUEST_OPEN);
  assert.equal(g.last().type, 'room-ended');
  assert.equal(g.closedWith, CLOSE_ENDED);

  const owner = new Conn('owner');
  await room.enter(owner, who('h'), HOST);
  assert.ok(owner.types().includes('room-peers'));
  assert.equal(room.recentlyEnded(), false);
  // The room is fresh: a guest on an approval invite waits for the owner as usual.
  const w = new Conn('w');
  await room.enter(w, who('w'), GUEST_APPROVAL);
  assert.equal(w.last().type, 'waiting-for-admission');
});

test('end: after the grace period an invite opens a fresh room (the guest waits for the owner)', async () => {
  const { room, h } = await privateRoom('later');
  room.endRoom(h);
  await withClock(ENDED_GRACE_MS + 1, async () => {
    const w = new Conn('w');
    await room.enter(w, who('w'), GUEST_APPROVAL);
    assert.deepEqual(w.last(), { type: 'waiting-for-admission', roomId: 'later', hostPresent: false });
  });
});

test('end: a join still hashing when the call ends does not bring the room back', async () => {
  const { room, h } = await openRoom('race');
  const g = new Conn('g');
  await room.join(g, who('g'));
  room.admitPeer(h, 'g');

  // The guest's socket dropped a moment ago; its re-join is in flight (awaiting the hash) when the host ends the call.
  const g2 = new Conn('g2');
  const pending = room.join(g2, who('g'));
  room.endRoom(h);
  await pending;
  assert.equal(g2.last().type, 'room-ended');
  assert.equal(g2.closedWith, CLOSE_ENDED);
  assert.ok(room.isEmpty());

  const { room: priv, h: owner } = await privateRoom('race2');
  const n = new Conn('n');
  const pendingEnter = priv.enter(n, who('n'), GUEST_OPEN);
  priv.endRoom(owner);
  await pendingEnter;
  assert.equal(n.last().type, 'room-ended');
  assert.ok(priv.isEmpty());
});
