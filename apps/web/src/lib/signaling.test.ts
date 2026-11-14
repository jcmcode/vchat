// The signaling client's handling of host controls: a locked room and an ended call must never
// trigger a reconnect, a re-entry, or the "room emptied, re-create it" path.
import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { LONG_OFFLINE_MS, SignalingClient, type SignalingEvent } from './signaling/client.js';

class FakeSocket {
  static readonly OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(
    public url: string,
    public protocols: string[]
  ) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  // Test helpers
  accept() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(msg: object) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  types() {
    return this.sent.map((m) => m.type);
  }
}

const intent = (extra: Record<string, unknown> = {}) => ({
  roomId: 'abc',
  peerId: 'p1',
  displayName: 'Me',
  secret: 's',
  isCreator: false,
  ...extra,
});

function start(extra: Record<string, unknown> = {}) {
  const client = new SignalingClient('wss://example.test/ws?room=abc');
  const events: SignalingEvent[] = [];
  client.on('*', (e) => events.push(e));
  client.enterRoom(intent(extra));
  client.connect();
  const ws = FakeSocket.instances.at(-1)!;
  ws.accept();
  return { client, events, ws, of: (type: string) => events.filter((e) => e.type === type) };
}

beforeEach(() => {
  FakeSocket.instances = [];
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
});
afterEach(() => {
  mock.timers.reset();
});

test('client: a short drop reconnects and re-enters on its own', () => {
  const { ws } = start();
  assert.deepEqual(ws.types(), ['join']);
  ws.receive({ type: 'room-peers', peers: [], roomId: 'abc' });
  mock.timers.tick(30_000);
  ws.drop(1006);
  mock.timers.tick(1000);
  assert.equal(FakeSocket.instances.length, 2);
  FakeSocket.instances[1].accept();
  assert.deepEqual(FakeSocket.instances[1].types(), ['join']);
});

test('client: after more than a minute out of touch it asks before going back in (camera and mic are live)', () => {
  const { client, ws, of } = start();
  ws.receive({ type: 'room-peers', peers: [], roomId: 'abc' });
  // The laptop sleeps: nothing from the server for over a minute, then the socket is found dead.
  mock.timers.tick(LONG_OFFLINE_MS + 5_000);
  ws.drop(1006);
  mock.timers.tick(1000);
  const ws2 = FakeSocket.instances[1];
  ws2.accept();
  assert.deepEqual(ws2.types(), [], 'not re-entered automatically');
  assert.equal(of('reconnect-needed').length, 1);

  // Still waiting for the user across another reconnect (e.g. the idle socket is closed).
  ws2.receive({ type: 'pong' });
  ws2.drop(4001);
  mock.timers.tick(1000);
  const ws3 = FakeSocket.instances[2];
  ws3.accept();
  assert.deepEqual(ws3.types(), []);
  assert.equal(of('reconnect-needed').length, 2);

  client.resumeAfterLongOffline();
  assert.deepEqual(ws3.types(), ['join']);
  // Back to normal afterwards: a short drop re-enters on its own again.
  ws3.receive({ type: 'room-peers', peers: [], roomId: 'abc' });
  ws3.drop(1006);
  mock.timers.tick(1000);
  FakeSocket.instances[3].accept();
  assert.deepEqual(FakeSocket.instances[3].types(), ['join']);
});

test('client: 4006 (call no longer available) is reported and never retried', () => {
  const { ws, of } = start({ token: 't' });
  ws.drop(4006);
  mock.timers.tick(60_000);
  assert.equal(FakeSocket.instances.length, 1);
  assert.deepEqual(of('error').map((e) => e.message), ['Call no longer available']);
});

test('client: room-ended stops everything — no reconnect, re-entry or re-creation, whatever close follows', () => {
  for (const code of [4004, 1006, 1000]) {
    FakeSocket.instances = [];
    const { ws, of } = start();
    ws.receive({ type: 'room-peers', peers: [], roomId: 'abc' });
    ws.receive({ type: 'room-ended', roomId: 'abc', reason: 'Ended by host' });
    ws.drop(code);
    mock.timers.tick(60_000);
    assert.equal(FakeSocket.instances.length, 1, `no reconnect after close ${code}`);
    assert.equal(of('room-ended').length, 1, 'reported once');
    assert.deepEqual(ws.types(), ['join']);
  }
});

test('client: anything the server says after room-ended is ignored (no re-create on "Room does not exist")', () => {
  const { ws, of } = start();
  ws.receive({ type: 'room-peers', peers: [], roomId: 'abc' });
  ws.receive({ type: 'room-ended', roomId: 'abc' });
  ws.receive({ type: 'error', message: 'Room does not exist' });
  ws.receive({ type: 'peer-joined', peerId: 'x', displayName: 'X' });
  assert.deepEqual(ws.types(), ['join']);
  assert.equal(of('error').length, 0);
  assert.equal(of('peer-joined').length, 0);
});

test('client: close code 4004 alone (message lost) still ends the call without reconnecting', () => {
  const { ws, of } = start();
  ws.receive({ type: 'room-peers', peers: [], roomId: 'abc' });
  ws.drop(4004);
  mock.timers.tick(60_000);
  assert.equal(FakeSocket.instances.length, 1);
  assert.equal(of('room-ended').length, 1);
});

test('client: a locked room (4005) is reported and never retried', () => {
  const { ws, of } = start({ token: 't' });
  ws.receive({ type: 'error', message: 'Room is locked' });
  ws.drop(4005);
  mock.timers.tick(60_000);
  assert.equal(FakeSocket.instances.length, 1);
  assert.ok(of('error').every((e) => e.message === 'Room is locked'));
  assert.ok(of('error').length >= 1);
});

test('client: the open-mode "room emptied, re-create it" path is unchanged for ordinary reconnects', () => {
  const { ws } = start();
  ws.receive({ type: 'room-peers', peers: [], roomId: 'abc' });
  ws.drop(1006);
  mock.timers.tick(1000);
  const ws2 = FakeSocket.instances[1];
  ws2.accept();
  ws2.receive({ type: 'error', message: 'Room does not exist' });
  assert.deepEqual(ws2.types(), ['join', 'create-room']);
});

test('client: lock, unlock and end are sent only while connected', () => {
  const { client, ws } = start();
  assert.equal(client.setRoomLocked(true), true);
  assert.equal(client.setRoomLocked(false), true);
  assert.equal(client.endRoom(), true);
  assert.deepEqual(ws.types().slice(1), ['lock-room', 'unlock-room', 'end-room']);
  ws.drop(1006);
  assert.equal(client.endRoom(), false);
  assert.equal(client.setRoomLocked(true), false);
  client.disconnect();
});
