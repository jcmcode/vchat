import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import {
  EVERYONE,
  threadOf,
  fileThreadOf,
  messagesIn,
  unreadByThread,
  privatePartners,
  unseenFileCount,
  markThreadSeen,
  markFilesSeen,
  markAllSeen,
  seenMessageIds,
  seenFileKeys,
  type ThreadMessage,
  type ThreadFile,
} from './threads.js';

const pub = (id: string, from: string, isLocal = false): ThreadMessage => ({ id, fromPeerId: from, isLocal });
const dmIn = (id: string, from: string): ThreadMessage => ({ id, fromPeerId: from, isLocal: false, private: true });
const dmOut = (id: string, to: string): ThreadMessage => ({ id, fromPeerId: 'me', isLocal: true, private: true, toPeerId: to });

test('public messages belong to everyone; private ones to the other person', () => {
  assert.equal(threadOf(pub('1', 'a')), EVERYONE);
  assert.equal(threadOf(dmIn('2', 'a')), 'a');
  assert.equal(threadOf(dmOut('3', 'b')), 'b');
});

test('files follow the same rule', () => {
  assert.equal(fileThreadOf({ key: 'k', direction: 'receive', fromPeerId: 'a' }), EVERYONE);
  assert.equal(fileThreadOf({ key: 'k', direction: 'receive', fromPeerId: 'a', private: true }), 'a');
  assert.equal(fileThreadOf({ key: 'k', direction: 'send', private: true, toPeerId: 'b' }), 'b');
});

test('a private conversation never leaks into everyone, or into another person', () => {
  const msgs = [pub('1', 'a'), dmIn('2', 'a'), dmOut('3', 'a'), dmIn('4', 'b'), pub('5', 'me', true)];
  assert.deepEqual(messagesIn(msgs, EVERYONE).map((m) => m.id), ['1', '5']);
  assert.deepEqual(messagesIn(msgs, 'a').map((m) => m.id), ['2', '3']);
  assert.deepEqual(messagesIn(msgs, 'b').map((m) => m.id), ['4']);
});

test('unread counts per conversation, ignoring your own and seen messages', () => {
  const msgs = [pub('1', 'a'), pub('2', 'b'), dmIn('3', 'a'), dmOut('4', 'a'), pub('5', 'me', true)];
  const unread = unreadByThread(msgs, new Set(['1']));
  assert.deepEqual([...unread], [[EVERYONE, 1], ['a', 1]]);
});

test('private partners are listed most recent first, once each', () => {
  const msgs = [dmIn('1', 'a'), dmIn('2', 'b'), pub('3', 'c'), dmOut('4', 'a')];
  assert.deepEqual(privatePartners(msgs), ['a', 'b']);
  const files: ThreadFile[] = [{ key: 'f', direction: 'receive', fromPeerId: 'c', private: true }];
  assert.deepEqual(privatePartners(msgs, files), ['a', 'b', 'c']);
});

test('seen state: marking a conversation leaves the others unread', () => {
  const msgs = [pub('1', 'a'), dmIn('2', 'a'), dmIn('3', 'b')];
  markAllSeen([], []);
  markThreadSeen(msgs, 'a');
  assert.deepEqual([...unreadByThread(msgs, get(seenMessageIds))], [[EVERYONE, 1], ['b', 1]]);
  const before = get(seenMessageIds);
  markThreadSeen(msgs, 'a');
  assert.equal(get(seenMessageIds), before, 'no change, no new set');
});

test('seen state: files', () => {
  const files: ThreadFile[] = [
    { key: 'r1', direction: 'receive', fromPeerId: 'a' },
    { key: 's1', direction: 'send' },
  ];
  markAllSeen([], []);
  assert.equal(unseenFileCount(files, get(seenFileKeys)), 1);
  markFilesSeen(files);
  assert.equal(unseenFileCount(files, get(seenFileKeys)), 0);
});
