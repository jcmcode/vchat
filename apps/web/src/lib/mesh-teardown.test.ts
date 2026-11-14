// Room teardown in mesh.ts: fatal errors mid-call end the call, errors don't outlive the room, and
// host controls recover after a reconnect. Runs the real mesh against a fake signaling socket.
import { test, mock, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'svelte/store';

class FakeSocket {
  static readonly OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
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

(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
globalThis.fetch = (async () => new Response(JSON.stringify({ iceServers: [{ urls: 'stun:example.test' }] }))) as typeof fetch;

const mesh = await import('./webrtc/mesh.js');
const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

async function joinAsHost() {
  await mesh.joinRoom({ serverUrl: 'ws://example.test/ws?room=abc', roomId: 'abc', peerId: 'me', secret: 's', displayName: 'Me', token: 't' });
  const ws = FakeSocket.instances.at(-1)!;
  ws.accept();
  ws.receive({ type: 'room-peers', peers: [], roomId: 'abc' });
  ws.receive({ type: 'host-changed', hostPeerId: 'me' });
  return ws;
}

let forcedOut = 0;
const stopWatching = mesh.onForcedOut(() => forcedOut++);

beforeEach(() => {
  FakeSocket.instances = [];
  forcedOut = 0;
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
});
afterEach(() => {
  mesh.leaveRoom();
  mock.timers.reset();
});

test('mesh: a fatal error after admission ends the call (not just the devices)', async () => {
  const ws = await joinAsHost();
  assert.equal(get(mesh.admitted), true);
  ws.receive({ type: 'error', message: 'Invite expired' });
  await flush();
  assert.equal(forcedOut, 1, 'forced-out handlers ran (devices, picture-in-picture, wake lock)');
  assert.equal(get(mesh.roomError), mesh.friendlyJoinError('Invite expired'));
  assert.equal(get(mesh.admitted), false);
  assert.equal(get(mesh.connectionState), 'disconnected');
  assert.equal(ws.readyState, 3, 'signaling closed: no more reconnecting');
});

test('mesh: before admission, an ordinary error is shown without tearing anything down', async () => {
  await mesh.joinRoom({ serverUrl: 'ws://example.test/ws?room=abc', roomId: 'abc', peerId: 'me', secret: 's', displayName: 'Me', token: 't' });
  const ws = FakeSocket.instances.at(-1)!;
  ws.accept();
  ws.receive({ type: 'error', message: 'Room is full' });
  await flush();
  assert.equal(forcedOut, 0);
  assert.equal(get(mesh.roomError), mesh.friendlyJoinError('Room is full'));
  // …but a refusal that won't change does end it.
  ws.receive({ type: 'error', message: 'Call no longer available' });
  await flush();
  assert.equal(forcedOut, 1);
  assert.equal(get(mesh.roomError), 'This call is no longer available.');
});

test('mesh: an error or "call ended" never outlives leaving the room', async () => {
  const ws = await joinAsHost();
  ws.receive({ type: 'room-ended', roomId: 'abc', reason: 'Ended by host' });
  await flush();
  // The forced exit keeps its message up…
  assert.equal(get(mesh.callEnded), 'host');
  assert.equal(get(mesh.roomError), 'The host ended the call.');
  // …until the user leaves ("Back to home"): nothing is left to cover the next room.
  mesh.leaveRoom();
  assert.equal(get(mesh.roomError), '');
  assert.equal(get(mesh.callEnded), null);

  mesh.roomError.set('stale');
  mesh.clearRoomError();
  assert.equal(get(mesh.roomError), '');
});

test('mesh: a host who locked the room locks it again if it came back unlocked after a reconnect', async () => {
  const ws = await joinAsHost();
  ws.receive({ type: 'lock-changed', locked: true });
  assert.equal(get(mesh.roomLocked), true);
  ws.drop(1006);
  mock.timers.tick(1000);
  const ws2 = FakeSocket.instances.at(-1)!;
  ws2.accept();
  ws2.receive({ type: 'room-peers', peers: [], roomId: 'abc' }); // no lock-changed: the lock was lost
  ws2.receive({ type: 'host-changed', hostPeerId: 'me' });
  assert.deepEqual(ws2.types(), ['join', 'lock-room']);

  // If the server still had it locked, nothing is re-sent.
  ws2.receive({ type: 'lock-changed', locked: true });
  ws2.drop(1006);
  mock.timers.tick(1000);
  const ws3 = FakeSocket.instances.at(-1)!;
  ws3.accept();
  ws3.receive({ type: 'room-peers', peers: [], roomId: 'abc' });
  ws3.receive({ type: 'lock-changed', locked: true });
  ws3.receive({ type: 'host-changed', hostPeerId: 'me' });
  assert.deepEqual(ws3.types(), ['join']);
});

test('mesh: an end request that went unanswered is forgotten', async () => {
  const ws = await joinAsHost();
  assert.equal(mesh.endCallForEveryone(), true);
  mock.timers.tick(mesh.HOST_ACTION_TIMEOUT_MS + 1);
  ws.receive({ type: 'room-ended', roomId: 'abc', reason: 'Ended by host' });
  await flush();
  assert.equal(get(mesh.callEnded), 'host', 'not "you": our request had timed out');
});

test('mesh: refusals of host actions are shown, including removing the creator', async () => {
  const ws = await joinAsHost();
  ws.receive({ type: 'error', message: "The room's creator can't be removed" });
  assert.equal(get(mesh.hostActionError), "The person who created this room can't be removed.");
  assert.equal(forcedOut, 0);
});

test('mesh: after a long time offline, the user is asked before going back in', async () => {
  const ws = await joinAsHost();
  mock.timers.tick(61_000);
  ws.drop(1006);
  mock.timers.tick(1000);
  const ws2 = FakeSocket.instances.at(-1)!;
  ws2.accept();
  assert.equal(get(mesh.reconnectPrompt), true);
  assert.deepEqual(ws2.types(), []);
  mesh.resumeConnection();
  assert.equal(get(mesh.reconnectPrompt), false);
  assert.deepEqual(ws2.types(), ['join']);
});

after(() => stopWatching());
