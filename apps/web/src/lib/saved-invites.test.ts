import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withInvites, type SavedRoom } from './stores/room.js';

const room: SavedRoom = {
  roomId: 'abc',
  label: '',
  inviteToken: 't',
  hostToken: 'h',
  expiresAt: Date.now() + 3600_000,
  approval: true,
  hasPassword: false,
  createdAt: 0,
};

test('withInvites keeps the newest invite per address, newest first', () => {
  const one = withInvites(room, [{ email: 'a@x.com', token: 't1', code: '111111', sentAt: 1 }]);
  const two = withInvites(one, [
    { email: 'b@x.com', token: 't2', sentAt: 2 },
    { email: 'a@x.com', token: 't3', code: '333333', sentAt: 2 },
  ]);
  assert.deepEqual(two.invites?.map((i) => [i.email, i.token]), [['b@x.com', 't2'], ['a@x.com', 't3']]);
  assert.equal(room.invites, undefined); // the original isn't changed
});
