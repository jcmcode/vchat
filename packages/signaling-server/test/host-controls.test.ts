// Host controls: locking the room and ending the call for everyone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOSE_ENDED,
  CLOSE_LOCKED,
  CLOSE_UNAVAILABLE,
  ENDED_GRACE_MS,
  EndedCalls,
  LOCK_GRACE_MS,
  ROOM_CREATE_MAX_PER_CLIENT,
  Room,
  endedCalls,
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

// Ended-call and lock memories are per process and keyed by room id: give each room its own id.
let seq = 0;
const uid = (base: string) => `${base}${++seq}`;

async function privateRoom(id = uid('priv')) {
  const room = new Room<Conn>(id, transport);
  const h = new Conn('h');
  await room.enter(h, who('h'), HOST);
  return { room, h };
}

async function openRoom(id = uid('open'), password?: string) {
  const room = new Room<Conn>(id, transport);
  const h = new Conn('h');
  await room.create(h, who('h', { clientId: uid('client'), ...(password ? { password } : {}) }));
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

test('lock: stays locked while invited guests wait for an absent owner; after the room empties, for a minute', async () => {
  const { room, h } = await privateRoom();
  const w = new Conn('w');
  await room.enter(w, who('w'), GUEST_APPROVAL);
  room.setLocked(h, true);
  room.leave(h); // owner refreshing: the waiting guest stays
  assert.equal(room.meta.locked, true);
  room.leave(w);
  assert.ok(room.isEmpty());
  assert.equal(room.meta.locked, false); // the room's own state is gone…

  // …but it comes back locked: a new guest is refused while the owner is away.
  const g = new Conn('g');
  await room.enter(g, who('g'), GUEST_OPEN);
  assert.equal(g.last().message, 'Room is locked');
  assert.equal(g.closedWith, CLOSE_LOCKED);

  // After the grace period it's simply gone.
  await withClock(LOCK_GRACE_MS + 1, async () => {
    const g2 = new Conn('g2');
    await room.enter(g2, who('g2'), GUEST_OPEN);
    assert.ok(g2.types().includes('room-peers'));
    assert.equal(room.meta.locked, false);
  });
});

test('lock: an owner alone whose connection blips finds the room still locked, and is told', async () => {
  const { room, h } = await privateRoom();
  room.setLocked(h, true);
  h.open = false;
  room.leave(h); // Wi-Fi blip: the room empties
  assert.ok(room.isEmpty());

  const stranger = new Conn('s');
  await room.enter(stranger, who('s'), GUEST_OPEN);
  assert.equal(stranger.last().message, 'Room is locked');

  const h2 = new Conn('h2');
  await room.enter(h2, who('h'), HOST);
  assert.equal(room.meta.locked, true);
  const types = h2.types();
  assert.ok(types.indexOf('lock-changed') > types.indexOf('room-peers'));
  // Unlocking forgets the remembered lock too.
  room.setLocked(h2, false);
  h2.open = false;
  room.leave(h2);
  const later = new Conn('later');
  await room.enter(later, who('later'), GUEST_OPEN);
  assert.ok(later.types().includes('room-peers'));
});

test('lock: open mode — the creator re-creating an emptied locked room gets it back locked; strangers cannot', async () => {
  const { room, h } = await openRoom();
  room.setLocked(h, true);
  h.open = false;
  room.leave(h);

  const s = new Conn('s');
  await room.create(s, who('stranger', { clientId: uid('client') }));
  assert.equal(s.last().message, 'Room is locked');
  assert.ok(room.isEmpty());

  const h2 = new Conn('h2');
  await room.create(h2, who('h', { clientId: uid('client') }));
  assert.deepEqual(h2.types(), ['room-created', 'room-peers', 'lock-changed', 'host-changed']);
  assert.equal(room.meta.locked, true);
});

test('lock: ending the call does not leave the lock behind', async () => {
  const { room, h } = await privateRoom();
  const g = new Conn('g');
  await room.enter(g, who('g'), GUEST_OPEN);
  room.setLocked(h, true);
  room.endRoom(h);
  const fresh = new Conn('f');
  await room.enter(fresh, who('fresh'), GUEST_OPEN);
  assert.ok(fresh.types().includes('room-peers'));
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
  const room = new Room<Conn>('allgone', transport, { onMetaChange: (m) => metaChanges.push(m) });
  const h = new Conn('h');
  const g = new Conn('g');
  const w = new Conn('w');
  await room.enter(h, who('h'), HOST);
  await room.enter(g, who('g'), GUEST_OPEN);
  await room.enter(w, who('w'), GUEST_APPROVAL);
  room.setLocked(h, true);

  assert.equal(room.endRoom(h), true);
  for (const c of [h, g, w]) {
    assert.deepEqual(c.last(), { type: 'room-ended', roomId: 'allgone', reason: 'Ended by host' });
    assert.equal(c.closedWith, CLOSE_ENDED);
  }
  // Nobody is told someone "left": the call is simply over.
  assert.equal(g.inbox.filter((m) => m.type === 'peer-left').length, 0);
  assert.ok(room.isEmpty());
  assert.equal(room.meta.locked, false);
  assert.deepEqual(Object.keys(room.meta.admitted), []);
  assert.equal(room.meta.hostPeerId, null);
  assert.deepEqual(metaChanges.at(-1), null);
  assert.equal(endedCalls.has('allgone'), true);
  assert.equal(room.endRoom(g), false);
});

test('end: a participant who was offline is told on return; strangers just see no room (open mode)', async () => {
  const { room, h } = await openRoom('gone', 'pw');
  const a = new Conn('a');
  await room.join(a, who('a', { password: 'pw' }));
  room.admitPeer(h, 'a');
  // a's connection drops (the server notices) just before the host ends the call.
  a.open = false;
  room.leave(a);
  room.endRoom(h);

  // a's tab reconnects on its own and, finding the room empty, tries to re-create it.
  const stale = new Conn('stale');
  await room.create(stale, who('a'));
  assert.equal(stale.last().type, 'room-ended');
  assert.equal(stale.closedWith, CLOSE_ENDED);
  const stale2 = new Conn('stale2');
  await room.join(stale2, who('a'));
  assert.equal(stale2.last().type, 'room-ended');

  // Strangers learn nothing: no room, as if it never existed (and the old password is gone).
  const s = new Conn('s');
  await room.join(s, who('stranger'));
  assert.deepEqual(s.last(), { type: 'error', message: 'Room does not exist' });
  assert.equal(s.open, true);
  assert.ok(!s.types().includes('room-ended'));
  // Same peer id but another secret is not the same identity.
  const guess = new Conn('guess');
  await room.join(guess, { peerId: 'a', displayName: 'a', secret: 'guessed' });
  assert.deepEqual(guess.last(), { type: 'error', message: 'Room does not exist' });
  // Open mode: anyone may create a room, including this code, right away.
  const fresh = new Conn('fresh');
  await room.create(fresh, who('stranger'));
  assert.deepEqual(fresh.types(), ['room-created', 'room-peers', 'host-changed']);
  assert.equal(room.meta.passwordHash, null);

  // After the grace period, the old identities are forgotten too.
  await withClock(ENDED_GRACE_MS + 1, async () => {
    assert.equal(endedCalls.has('gone'), false);
  });
});

test('end: an owner device that was offline cannot quietly re-open the room; a fresh owner join can', async () => {
  const { room, h } = await privateRoom('again');
  const g = new Conn('g');
  await room.enter(g, who('g'), GUEST_OPEN);
  const laptop = new Conn('laptop');
  await room.enter(laptop, who('owner-laptop'), HOST); // the owner on a second device (takes the role)
  const h2 = new Conn('h2');
  await room.enter(h2, who('h'), HOST); // the first device takes it back
  laptop.open = false;
  room.leave(laptop); // the laptop goes offline
  assert.equal(room.endRoom(h2), true);

  // The offline owner device reconnects automatically, with its old identity: refused, even as host.
  const back = new Conn('back');
  await room.enter(back, who('owner-laptop'), HOST);
  assert.equal(back.last().type, 'room-ended');
  assert.equal(back.closedWith, CLOSE_ENDED);
  const back2 = new Conn('back2');
  await room.enter(back2, who('h'), HOST);
  assert.equal(back2.last().type, 'room-ended');
  // A guest from the ended call too.
  const g2 = new Conn('g2');
  await room.enter(g2, who('g'), GUEST_OPEN);
  assert.equal(g2.last().type, 'room-ended');
  assert.ok(room.isEmpty());

  // Opening the room again on purpose is a fresh join (the client forgot the old identity).
  const owner = new Conn('owner');
  await room.enter(owner, who('owner-fresh'), HOST);
  assert.ok(owner.types().includes('room-peers'));
  // The room is fresh: a new guest on an approval invite waits for the owner as usual.
  const w = new Conn('w');
  await room.enter(w, who('w'), GUEST_APPROVAL);
  assert.equal(w.last().type, 'waiting-for-admission');
});

test('end: after the grace period an old identity simply opens a fresh room', async () => {
  const { room, h } = await privateRoom('later');
  const g = new Conn('g');
  await room.enter(g, who('g'), GUEST_APPROVAL);
  room.endRoom(h);
  await withClock(ENDED_GRACE_MS + 1, async () => {
    const w = new Conn('w');
    await room.enter(w, who('g'), GUEST_APPROVAL);
    assert.deepEqual(w.last(), { type: 'waiting-for-admission', roomId: 'later', hostPresent: false });
  });
});

test('end: a re-join still hashing when the call ends does not bring the room back', async () => {
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
  await priv.enter(n, who('n'), GUEST_OPEN);
  const n2 = new Conn('n2');
  const pendingEnter = priv.enter(n2, who('n'), GUEST_OPEN);
  priv.endRoom(owner);
  await pendingEnter;
  assert.equal(n2.last().type, 'room-ended');
  assert.ok(priv.isEmpty());
});

test('end: one client churning through rooms is slowed down, and solo calls leave nothing to flush with', async () => {
  // One client can only create so many rooms.
  const client = uid('flooder');
  let refused: Conn | null = null;
  for (let i = 0; i <= ROOM_CREATE_MAX_PER_CLIENT; i++) {
    const c = new Conn();
    await new Room<Conn>(uid('churn'), transport).create(c, who('z', { clientId: client }));
    if (c.last().type === 'error') refused = c;
  }
  assert.deepEqual(refused?.last(), { type: 'error', message: 'Too many new rooms' });

  // Even across many clients, a call that only ever had its host in it isn't remembered.
  const before = endedCalls.size;
  for (let i = 0; i < 5_100; i++) {
    const r = new Room<Conn>(uid('solo'), transport);
    const c = new Conn();
    await r.create(c, who('z', { clientId: uid('client') }));
    r.endRoom(c);
  }
  assert.equal(endedCalls.size, before);

  const { room, h } = await openRoom('legit');
  const p = new Conn('p');
  await room.join(p, who('p'));
  room.admitPeer(h, 'p');
  room.endRoom(h);
  const straggler = new Conn('s');
  await room.create(straggler, who('p'));
  assert.equal(straggler.last().type, 'room-ended');
  assert.ok(room.isEmpty());
});

test('end: a second call ended within the minute does not erase the first one', async () => {
  const { room, h } = await openRoom();
  const b = new Conn('b');
  await room.join(b, who('b'));
  room.admitPeer(h, 'b');
  b.open = false;
  room.leave(b); // b's laptop goes to sleep
  room.endRoom(h);

  // Someone else opens the same room and ends it again (with a guest, so it's remembered too).
  const d = new Conn('d');
  await room.create(d, who('d', { clientId: uid('client') }));
  const e = new Conn('e');
  await room.join(e, who('e'));
  room.admitPeer(d, 'e');
  room.endRoom(d);

  const b2 = new Conn('b2');
  await room.join(b2, who('b'));
  assert.equal(b2.last().type, 'room-ended');
  const e2 = new Conn('e2');
  await room.join(e2, who('e'));
  assert.equal(e2.last().type, 'room-ended');
});

test('EndedCalls: marking a room again merges identities and restarts the clock', () => {
  const calls = new EndedCalls(10, 100, 1000);
  calls.mark('r', [{ peerId: 'a', secretHash: 'ha' }], 0);
  calls.mark('r', [{ peerId: 'b', secretHash: 'hb' }], 500);
  assert.equal(calls.wasIn('r', 'a', 'ha', 1400), true);
  assert.equal(calls.wasIn('r', 'b', 'hb', 1400), true);
  // An expired entry isn't merged into a new one.
  calls.mark('s', [{ peerId: 'a', secretHash: 'ha' }], 0);
  calls.mark('s', [{ peerId: 'b', secretHash: 'hb' }], 2000);
  assert.equal(calls.wasIn('s', 'a', 'ha', 2100), false);
  calls.forget('r');
  assert.equal(calls.has('r', 1400), false);
});

test('emails: room metadata keeps a keyed hash of an invite address, never the address', async () => {
  const room = new Room<Conn>(uid('mail'), transport);
  const h = new Conn('h');
  await room.enter(h, who('h'), HOST);
  const personal = { role: 'guest' as const, approval: true, email: 'someone.with.a.long.address@example.com', emailKey: 'k'.repeat(22) };
  const g = new Conn('g');
  await room.enter(g, who('g'), personal);
  // The host still sees the address while they wait.
  assert.equal(h.last('admission-request').email, personal.email);
  room.admitPeer(h, 'g');
  assert.equal(room.meta.admitted.g.e, personal.emailKey);
  assert.equal([...room.members.values()].find((s) => s.peerId === 'g')?.email, undefined);
  room.removePeer(h, 'g');
  assert.equal(room.meta.removed[0].e, personal.emailKey);
  assert.ok(!JSON.stringify(room.meta).includes('example.com'));
  // Barred by the hash: the same invite on a fresh tab is still refused.
  const back = new Conn('back');
  await room.enter(back, who('g2'), personal);
  assert.equal(back.last().type, 'removed');

  // Without a keyed hash (core used directly), a plain hash is stored instead.
  const r2 = new Room<Conn>(uid('mail'), transport);
  const h2 = new Conn('h2');
  await r2.enter(h2, who('h'), HOST);
  const g2 = new Conn('g2');
  await r2.enter(g2, who('g'), { role: 'guest', approval: false, email: 'plain@example.com' });
  assert.match(r2.meta.admitted.g.e ?? '', /^[0-9a-f]{22}$/);
});

test('emails: a Cloudflare attachment at the caps stays under 16 KiB with hashed addresses', async () => {
  const v8 = await import('node:v8');
  const pid = (i: number) => `p${i}`.padEnd(30, 'x');
  const h = 'a'.repeat(32);
  const e = 'k'.repeat(22); // what metadata now holds instead of a ~60-character address
  const admitted: Record<string, unknown> = {};
  for (let i = 0; i < 72; i++) admitted[pid(i)] = { h, r: i < 8 ? 'host' : 'guest', ...(i >= 8 ? { e } : {}) };
  const bar = (n: number, off: number) => Array.from({ length: n }, (_, i) => ({ p: pid(i + off), h, u: Date.now(), e }));
  const meta = {
    hostPeerId: pid(0),
    passwordHash: 'f'.repeat(64),
    passwordSalt: 'f'.repeat(32),
    admitted,
    removed: bar(32, 100),
    denied: bar(16, 200),
    locked: true,
    creator: { p: pid(0), h },
    createdAt: Date.now(),
  };
  const state = { peerId: pid(1), displayName: '一'.repeat(30), status: 'peer', secretHash: h, role: 'guest', emailKey: e };
  const attachment = { roomId: 'abcdefgh', state, client: 'x'.repeat(22), connectedAt: Date.now(), idleSince: Date.now(), meta, mv: 123456 };
  const size = v8.serialize(attachment).length;
  assert.ok(size < 16 * 1024, `${size} bytes`);
});

test('CLOSE_UNAVAILABLE is a distinct no-retry code', () => {
  assert.equal(CLOSE_UNAVAILABLE, 4006);
  assert.notEqual(CLOSE_UNAVAILABLE, CLOSE_ENDED);
});

test('EndedCalls: bounded by entries and identities, expires, and never stores empty secrets', () => {
  const calls = new EndedCalls(3, 5, 1000);
  calls.mark('a', [{ peerId: 'p', secretHash: 'h1' }], 0);
  calls.mark('b', [{ peerId: 'p', secretHash: 'h2' }, { peerId: 'q', secretHash: 'h3' }], 1);
  calls.mark('c', [{ peerId: 'p', secretHash: 'h4' }], 2);
  calls.mark('d', [{ peerId: 'p', secretHash: 'h5' }], 3);
  assert.equal(calls.has('a', 3), false, 'oldest evicted at the entry cap');
  calls.mark('e', [1, 2, 3].map((n) => ({ peerId: `x${n}`, secretHash: 's' })), 4);
  assert.equal(calls.has('b', 4), false, 'oldest evicted at the identity cap');
  assert.equal(calls.wasIn('e', 'x2', 's', 4), true);
  assert.equal(calls.wasIn('e', 'x2', 'other', 4), false);
  assert.equal(calls.wasIn('e', 'x2', 's', 1004), false, 'expired');
  calls.mark('f', [{ peerId: 'p', secretHash: '' }], 5);
  assert.equal(calls.has('f', 5), false);
  calls.sweep(10_000);
  assert.equal(calls.size, 0);
});

// ── Review fixes ─────────────────────────────────────────────────────────────

test('open mode: the creator gets the host role back after a blip, and the stand-in loses it', async () => {
  const { room, h } = await openRoom('blip');
  const b = new Conn('b');
  await room.join(b, who('b'));
  room.admitPeer(h, 'b');

  h.open = false;
  room.leave(h); // network blip
  assert.equal(room.meta.hostPeerId, 'b');
  // The stand-in can't remove the creator while they're away.
  room.removePeer(b, 'h');
  assert.equal(b.last().message, "The room's creator can't be removed");
  assert.ok(room.meta.admitted.h);

  const h2 = new Conn('h2');
  await room.join(h2, who('h'));
  assert.equal(room.meta.hostPeerId, 'h');
  assert.deepEqual(b.last('host-changed'), { type: 'host-changed', hostPeerId: 'h' });
  room.setLocked(b, true);
  assert.equal(b.last().message, 'Only the host can lock the room');
  room.endRoom(b);
  assert.equal(b.last().message, 'Only the host can end the call');
  assert.equal(room.peers().length, 2);
});

test('open mode: the creator identity survives a restore, and needs the right secret', async () => {
  const { room, h } = await openRoom('blip2');
  const b = new Conn('b');
  await room.join(b, who('b'));
  room.admitPeer(h, 'b');
  h.open = false;
  room.leave(h);

  const meta = JSON.parse(JSON.stringify(room.meta));
  assert.equal(meta.creator.p, 'h');
  const members: [Conn, MemberState][] = [...room.members].map(([c, s]) => [c, JSON.parse(JSON.stringify(s))]);
  const woken = new Room<Conn>('blip2', transport, {}, { meta, members });

  // Someone using the creator's peer id without the secret never gets the role, even if the
  // creator's admitted entry were gone and the stand-in let them in.
  delete woken.meta.admitted.h;
  const imp = new Conn('imp');
  await woken.join(imp, { peerId: 'h', displayName: 'h', secret: 'not-the-secret' });
  woken.admitPeer(b, 'h');
  assert.ok(imp.types().includes('room-peers'));
  assert.equal(woken.meta.hostPeerId, 'b');
  woken.leave(imp);

  woken.meta.admitted.h = { h: meta.creator.h, r: 'open' };
  const h2 = new Conn('h2');
  await woken.join(h2, who('h'));
  assert.equal(woken.meta.hostPeerId, 'h');
  assert.equal(normalizeMeta({ ...meta, creator: { p: 1 } })?.creator, null);
});

test('lock: a waiting guest re-entering with a second (no-approval) invite goes back to waiting', async () => {
  const { room, h } = await privateRoom('twoinvites');
  const w = new Conn('w');
  await room.enter(w, who('w'), GUEST_APPROVAL);
  room.setLocked(h, true);
  const w2 = new Conn('w2');
  await room.enter(w2, who('w'), GUEST_OPEN);
  assert.equal(w2.last().type, 'waiting-for-admission');
  assert.ok(!w2.types().includes('room-peers'));
  assert.equal(room.peers().length, 1);
  assert.equal(room.waiting().length, 1);
});


// ── Removal vs. signaling blips ───────────────────────────────────────────────

test('remove: peers are told the person was removed (so they cut the direct connection at once)', async () => {
  const { room, h } = await privateRoom();
  const a = new Conn('a');
  const b = new Conn('b');
  await room.enter(a, who('a'), GUEST_OPEN);
  await room.enter(b, who('b'), GUEST_OPEN);
  room.removePeer(h, 'a');
  assert.deepEqual(b.last('peer-left'), { type: 'peer-left', peerId: 'a', displayName: 'a', reason: 'removed' });
  assert.deepEqual(h.last('peer-left'), { type: 'peer-left', peerId: 'a', displayName: 'a', reason: 'removed' });
});

test('remove: an ordinary leave or socket drop carries no reason (peers may keep a working connection briefly)', async () => {
  const { room, h } = await privateRoom();
  const a = new Conn('a');
  await room.enter(a, who('a'), GUEST_OPEN);
  room.leave(a);
  assert.deepEqual(h.last('peer-left'), { type: 'peer-left', peerId: 'a', displayName: 'a' });
});

test('remove: someone removed while offline is announced too, so a connection kept through their blip is cut', async () => {
  const { room, h } = await privateRoom();
  const a = new Conn('a');
  const b = new Conn('b');
  await room.enter(a, who('a'), GUEST_OPEN);
  await room.enter(b, who('b'), GUEST_OPEN);
  room.leave(a); // their socket dropped; they're still in the admitted list
  b.inbox.length = 0;
  room.removePeer(h, 'a');
  assert.deepEqual(b.inbox, [{ type: 'peer-left', peerId: 'a', reason: 'removed' }]);
  // And they can't come back.
  const again = new Conn('a2');
  await room.enter(again, who('a'), GUEST_OPEN);
  assert.equal(again.last().type, 'removed');
});
