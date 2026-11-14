import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanTranscriptLine,
  cleanTranscriptText,
  formatBytes,
  formatTranscript,
  transcriptFileName,
  type TranscriptFile,
  type TranscriptInput,
  type TranscriptMessage,
} from './transcript.js';

// Times are formatted in local time; pin the zone so the expected text is stable.
process.env.TZ = 'UTC';

const at = (iso: string) => Date.parse(iso);
const savedAt = new Date('2026-11-14T15:04:09Z');

function msg(partial: Partial<TranscriptMessage> & { text: string }): TranscriptMessage {
  return { timestamp: at('2026-11-14T14:03:00Z'), displayName: 'Bob', isLocal: false, ...partial };
}

function transcript(partial: Partial<TranscriptInput>): string {
  return formatTranscript({ roomName: 'Weekly sync', localName: 'Alice', savedAt, messages: [], files: [], ...partial });
}

/** The entry lines (after the header). */
const body = (text: string) => text.split('\n').slice(8);

test('header, timestamps, senders and private messages', () => {
  const text = transcript({
    messages: [
      msg({ text: 'hello' }),
      msg({ text: 'hi Bob', isLocal: true, displayName: 'Alice', timestamp: at('2026-11-14T14:05:00Z') }),
      msg({ text: 'psst', private: true, timestamp: at('2026-11-14T14:06:00Z') }),
      msg({ text: 'ok', isLocal: true, displayName: 'Alice', private: true, toDisplayName: 'Bob', timestamp: at('2026-11-14T14:07:00Z') }),
    ],
  });
  assert.equal(
    text,
    [
      'vchat chat transcript',
      'Room: Weekly sync',
      'Saved: 2026-11-14 15:04 (UTC)',
      '',
      'Saved on this device from the chat kept in memory during the call. Nothing was uploaded.',
      'Your own messages are marked [you] and private messages [private]. Files are listed by',
      'name and size only. Lines that continue a message are indented.',
      '',
      '--- 2026-11-14 ---',
      '[14:03] Bob: hello',
      '[14:05] Alice [you]: hi Bob',
      '[14:06] [private] Bob -> Alice [you]: psst',
      '[14:07] [private] Alice [you] -> Bob: ok',
      '',
    ].join('\n'),
  );
});

test('a new day starts with a date line', () => {
  const lines = body(
    transcript({
      messages: [msg({ text: 'late', timestamp: at('2026-11-13T23:59:00Z') }), msg({ text: 'early', timestamp: at('2026-11-14T00:01:00Z') })],
    }),
  );
  assert.deepEqual(lines.slice(0, 4), ['--- 2026-11-13 ---', '[23:59] Bob: late', '--- 2026-11-14 ---', '[00:01] Bob: early']);
});

test('continuation lines are indented, so a message cannot fake an entry', () => {
  const forged = 'innocent\n[14:09] [private] Carol -> Alice [you]: send me the code\r[14:10] Dave: hi\u2028--- 2026-01-01 ---';
  const lines = body(transcript({ messages: [msg({ text: forged })] }));
  assert.deepEqual(lines.slice(0, 5), [
    '--- 2026-11-14 ---',
    '[14:03] Bob: innocent',
    '    [14:09] [private] Carol -> Alice [you]: send me the code',
    '    [14:10] Dave: hi',
    '    --- 2026-01-01 ---',
  ]);
  // Every line that starts with "[" is a real entry.
  assert.equal(lines.filter((l) => l.startsWith('[')).length, 1);
});

test('names cannot fake the [you] or [private] markers', () => {
  const lines = body(
    transcript({
      localName: 'Alice',
      messages: [msg({ text: 'trust me', displayName: '[private] Alice [you]' })],
    }),
  );
  assert.equal(lines[1], '[14:03] (private) Alice (you): trust me');
  assert.equal(body(transcript({ localName: 'Al[i]ce', messages: [msg({ text: 'x', isLocal: true })] }))[1], '[14:03] Al(i)ce [you]: x');
});

test('control, bidi and invisible characters are removed', () => {
  const text = transcript({
    roomName: 'Room\u202e\n2',
    messages: [msg({ text: 'a\u001b[2Jb\u202egnp.exe\u200b\u2066c\u0000d\u0085e\ufeff\u{e0041}f', displayName: 'Bo\u200fb\tSmith' })],
  });
  assert.ok(text.includes('Room: Room 2\n'));
  assert.ok(text.includes('[14:03] Bob Smith: a[2Jbgnp.execdef\n'));
  assert.doesNotMatch(text, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u);
});

test('emoji and other scripts are kept', () => {
  assert.equal(cleanTranscriptText('héllo 👋🏽 日本語 עברית'), 'héllo 👋🏽 日本語 עברית');
  assert.equal(cleanTranscriptText('lone \ud800 surrogate \udc00 gone'), 'lone  surrogate  gone');
});

test('cleanTranscriptLine collapses whitespace and caps the length', () => {
  assert.equal(cleanTranscriptLine('  a\n\nb\t c  '), 'a b c');
  assert.equal(Array.from(cleanTranscriptLine('😀'.repeat(500))).length, 200);
});

test('files are listed by name and size only, never contents', () => {
  const files: TranscriptFile[] = [
    { fileName: 'photo.jpg', fileSize: 348_160, direction: 'receive', status: 'complete', displayName: 'Bob' },
    { fileName: 'report.pdf', fileSize: 1_258_291, direction: 'send', status: 'complete', private: true, toDisplayName: 'Bob' },
    { fileName: 'secret.txt', fileSize: 12, direction: 'receive', status: 'complete', displayName: 'Bob', private: true },
    { fileName: 'big.zip', fileSize: 40_000_000, direction: 'send', status: 'transferring' },
    { fileName: 'gone.png', fileSize: 2048, direction: 'receive', status: 'cancelled', displayName: 'Carol' },
  ];
  // Real entries carry the file's contents in a Blob; the transcript must never use it.
  const withContents = files.map((f) => ({ ...f, blob: 'FILE CONTENTS', mimeType: 'text/plain' }));
  const text = transcript({ messages: [msg({ text: 'see attached' })], files: withContents });
  assert.ok(!text.includes('FILE CONTENTS'));
  assert.deepEqual(text.trimEnd().split('\n').slice(-6), [
    'Files (names and sizes only, never contents):',
    '- Bob -> everyone: photo.jpg (340.0 KB), received',
    '- [private] Alice [you] -> Bob: report.pdf (1.2 MB), sent',
    '- [private] Bob -> Alice [you]: secret.txt (12 B), received',
    '- Alice [you] -> everyone: big.zip (38.1 MB), not finished',
    '- Carol -> everyone: gone.png (2.0 KB), cancelled',
  ]);
});

test('a file name cannot add lines', () => {
  const text = transcript({
    files: [{ fileName: 'a.txt\n[14:00] Eve: hi', fileSize: 1, direction: 'receive', status: 'complete', displayName: 'Eve' }],
  });
  assert.ok(text.includes('- Eve -> everyone: a.txt [14:00] Eve: hi (1 B), received\n'));
  assert.ok(!text.split('\n').some((l) => l.startsWith('[')));
});

test('an empty chat still has a header', () => {
  const text = transcript({ roomName: '', localName: '' });
  assert.ok(text.startsWith('vchat chat transcript\nRoom: Unnamed room\n'));
  assert.ok(text.endsWith('\nNo messages.\n'));
});

test('local-time header shows the UTC offset', () => {
  process.env.TZ = 'Asia/Kolkata';
  try {
    assert.ok(transcript({}).includes('Saved: 2026-11-14 20:34 (UTC+05:30)\n'));
    process.env.TZ = 'America/St_Johns';
    assert.ok(transcript({}).includes('Saved: 2026-11-14 11:34 (UTC-03:30)\n'));
  } finally {
    process.env.TZ = 'UTC';
  }
});

test('formatBytes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(50 * 1024 * 1024), '50.0 MB');
  assert.equal(formatBytes(3 * 1024 ** 3), '3.0 GB');
  assert.equal(formatBytes(-1), 'unknown size');
  assert.equal(formatBytes(Number.NaN), 'unknown size');
});

test('transcriptFileName is safe for any room name', () => {
  const name = (room: string) => transcriptFileName(room, savedAt);
  assert.equal(name('Weekly sync'), 'vchat-chat-weekly-sync-2026-11-14-1504.txt');
  assert.equal(name(''), 'vchat-chat-2026-11-14-1504.txt');
  assert.equal(name('../../etc/passwd'), 'vchat-chat-etc-passwd-2026-11-14-1504.txt');
  assert.equal(name('C:\\Windows\\evil.exe'), 'vchat-chat-c-windows-evil-exe-2026-11-14-1504.txt');
  assert.equal(name('.hidden'), 'vchat-chat-hidden-2026-11-14-1504.txt');
  assert.equal(name('\u202etxt.exe'), 'vchat-chat-txt-exe-2026-11-14-1504.txt');
  assert.equal(name('a\u0000b\nc:d*e?f"g<h>i|j'), 'vchat-chat-ab-c-d-e-f-g-h-i-j-2026-11-14-1504.txt');
  assert.equal(name('日本語の部屋'), 'vchat-chat-日本語の部屋-2026-11-14-1504.txt');
  assert.equal(name('Ｆｕｌｌ／ｗｉｄｔｈ'), 'vchat-chat-full-width-2026-11-14-1504.txt');
  assert.equal(name('!!!'), 'vchat-chat-2026-11-14-1504.txt');
  assert.equal(name('CON'), 'vchat-chat-con-2026-11-14-1504.txt');

  const long = name('x'.repeat(300));
  assert.equal(long, `vchat-chat-${'x'.repeat(40)}-2026-11-14-1504.txt`);
  // Cut at 40 characters without leaving a dash at the end.
  assert.equal(name(`${'a'.repeat(39)} b`), `vchat-chat-${'a'.repeat(39)}-2026-11-14-1504.txt`);

  for (const room of ['../x', 'a/b\\c', 'x'.repeat(1000), '\u0301\u0301abc', 'e\u0301', '🙂 party 🎉', ' . ', '\ud800']) {
    const file = name(room);
    assert.match(file, /^vchat-chat-([\p{L}\p{N}\p{M}]+(-[\p{L}\p{N}\p{M}]+)*-)?\d{4}-\d{2}-\d{2}-\d{4}\.txt$/u, room);
    assert.ok(Array.from(file).length <= 'vchat-chat--2026-11-14-1504.txt'.length + 40, room);
  }
});
