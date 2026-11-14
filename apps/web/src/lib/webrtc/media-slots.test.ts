import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  enableSending,
  isValidMid,
  localSlots,
  remoteSlots,
  sendingBlocked,
  type Direction,
  type TransceiverLike,
} from './media-slots.js';

function t(kind: 'audio' | 'video', mid: string | null, direction: Direction = 'sendrecv', currentDirection: Direction | null = null): TransceiverLike {
  return { mid, direction, currentDirection, receiver: { track: { kind } } };
}

/** The layout every offerer creates: audio, camera, screen (data channel is not a transceiver). */
const layout = () => [t('audio', '0'), t('video', '1'), t('video', '2')];

test('localSlots: audio, then camera = first video, screen = second video', () => {
  const ts = layout();
  const s = localSlots(ts);
  assert.equal(s.audio, ts[0]);
  assert.equal(s.camera, ts[1]);
  assert.equal(s.screen, ts[2]);
});

test('localSlots: answerer with mic+camera added first, then the rest from the offer', () => {
  // addTrack'd mic and camera are adopted by the offer's first audio and video m-sections.
  const ts = [t('audio', '0'), t('video', '1'), t('video', '2', 'recvonly')];
  assert.equal(localSlots(ts).screen, ts[2]);
  // No mic yet before the offer: still the right kinds.
  const before = [t('video', null)];
  assert.equal(localSlots(before).camera, before[0]);
  assert.equal(localSlots(before).audio, undefined);
  assert.equal(localSlots(before).screen, undefined);
});

test('localSlots skips stopped transceivers', () => {
  const ts = [t('audio', '0'), t('video', '1', 'stopped'), t('video', '2'), t('video', '3')];
  const s = localSlots(ts);
  assert.equal(s.camera, ts[2]);
  assert.equal(s.screen, ts[3]);
  const legacy = [t('audio', '0'), { ...t('video', '1'), stopped: true }, t('video', '2')];
  assert.equal(localSlots(legacy).camera, legacy[2]);
  const current = [t('audio', '0'), t('video', '1', 'sendrecv', 'stopped'), t('video', '2')];
  assert.equal(localSlots(current).camera, current[2]);
});

test('remoteSlots: no screen announced', () => {
  const ts = layout();
  const s = remoteSlots(ts, null);
  assert.equal(s.audio, ts[0]);
  assert.equal(s.camera, ts[1]);
  assert.equal(s.screen, undefined);
});

test('remoteSlots: the announced mid is the screen, the camera is the other video', () => {
  const ts = layout();
  assert.equal(remoteSlots(ts, '2').screen, ts[2]);
  assert.equal(remoteSlots(ts, '2').camera, ts[1]);
  // Whatever order the m-sections ended up in, the announced one is the screen.
  assert.equal(remoteSlots(ts, '1').screen, ts[1]);
  assert.equal(remoteSlots(ts, '1').camera, ts[2]);
});

test('remoteSlots: an announcement can only name a video transceiver of this connection', () => {
  const ts = layout();
  for (const bad of ['0', '7', '', 'x'.repeat(33), '<img src=x>', '1 2', null]) {
    const s = remoteSlots(ts, bad as string | null);
    assert.equal(s.screen, undefined, `mid ${String(bad)}`);
    assert.equal(s.camera, ts[1]);
  }
  // A stopped transceiver can't be the screen either.
  const stopped = [t('audio', '0'), t('video', '1'), t('video', '2', 'stopped')];
  assert.equal(remoteSlots(stopped, '2').screen, undefined);
});

test('isValidMid', () => {
  for (const ok of ['0', '12', 'sdparta_0', 'video-1', '{abc}', 'a.b']) assert.equal(isValidMid(ok), true, ok);
  for (const bad of ['', ' ', 'a b', 'x'.repeat(33), '<', '"', 1, null, undefined, {}, ['0']]) assert.equal(isValidMid(bad), false, String(bad));
});

test('enableSending lets the three slots send, nothing else', () => {
  const ts = [t('audio', '0', 'recvonly'), t('video', '1', 'recvonly'), t('video', '2', 'recvonly'), t('video', '3', 'recvonly')];
  const changed = enableSending(ts);
  assert.deepEqual(
    ts.map((x) => x.direction),
    ['sendrecv', 'sendrecv', 'sendrecv', 'recvonly']
  );
  assert.equal(changed.length, 3);
  assert.equal(enableSending(ts).length, 0, 'idempotent');
  const inactive = [t('audio', '0', 'inactive')];
  enableSending(inactive);
  assert.equal(inactive[0].direction, 'sendrecv');
});

test('sendingBlocked: a slot wants to send but the negotiated direction does not allow it', () => {
  assert.equal(sendingBlocked(layout()), false, 'not negotiated yet');
  assert.equal(sendingBlocked([t('audio', '0', 'sendrecv', 'sendrecv'), t('video', '1', 'sendrecv', 'sendrecv'), t('video', '2', 'sendrecv', 'sendrecv')]), false);
  assert.equal(sendingBlocked([t('audio', '0', 'sendrecv', 'sendrecv'), t('video', '1', 'sendrecv', 'recvonly')]), true);
  assert.equal(sendingBlocked([t('audio', '0', 'sendrecv', 'sendonly')]), false);
  assert.equal(sendingBlocked([t('audio', '0', 'recvonly', 'recvonly')]), false, "we didn't ask to send");
  assert.equal(sendingBlocked([t('audio', '0'), t('video', '1'), t('video', '2'), t('video', '3', 'sendrecv', 'recvonly')]), false, 'not one of our slots');
});
