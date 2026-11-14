// Plain-text chat transcript for "Save chat". Built entirely in the browser from the chat kept in
// memory and handed to the user as a download; nothing is uploaded. Pure and unit-tested
// (transcript.test.ts).
//
// The text comes from untrusted peers, so the transcript can't be used to hide or fake anything:
// - control, bidi, zero-width and other invisible format characters are removed (ESC too, so the
//   file is safe to `cat` in a terminal);
// - every line that continues a message is indented, so a line starting with "[" is always a real
//   entry, never one typed inside someone's message;
// - square brackets in names become parentheses, so the "[you]" and "[private]" markers can only
//   come from vchat, never from someone's chosen name.

/** The parts of a chat message the transcript uses (a `ChatMessage` from mesh.ts fits). */
export interface TranscriptMessage {
  timestamp: number;
  displayName: string;
  text: string;
  isLocal: boolean;
  private?: boolean;
  /** For private messages you sent: who to. */
  toDisplayName?: string;
}

/** The parts of a file transfer the transcript uses (a `FileTransferEntry` fits). Never contents. */
export interface TranscriptFile {
  fileName: string;
  fileSize: number;
  direction: 'send' | 'receive';
  status: 'pending' | 'transferring' | 'complete' | 'cancelled';
  displayName?: string;
  private?: boolean;
  /** For files you sent privately: who to. */
  toDisplayName?: string;
}

export interface TranscriptInput {
  /** Room name, or the room code when it has none. */
  roomName: string;
  /** Your own display name. */
  localName: string;
  savedAt: Date;
  messages: readonly TranscriptMessage[];
  files: readonly TranscriptFile[];
}

const MAX_LINE_FIELD = 200;
const MAX_SLUG = 40;

// C0 controls except tab and newline, DEL, C1 controls (including NEL), every format character
// (\p{Cf}: bidi embeddings, overrides and isolates, zero-width characters, soft hyphen, BOM, the
// tag block...) and lone surrogates. With the u flag a surrogate range only matches lone surrogates,
// because a valid pair is read as one character.
// eslint-disable-next-line no-control-regex
const STRIP = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\p{Cf}\ud800-\udfff]/gu;

/** Message text: line breaks normalized to \n, invisible and control characters removed. */
export function cleanTranscriptText(value: string): string {
  return value
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .replace(STRIP, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Room and file names: one line, whitespace collapsed, length capped. */
export function cleanTranscriptLine(value: string): string {
  const line = cleanTranscriptText(value).replace(/\s+/g, ' ');
  return Array.from(line).slice(0, MAX_LINE_FIELD).join('').trim();
}

/** A person's name: one line, and no square brackets (those mark [you] and [private]). */
function personName(value: string | undefined, fallback: string): string {
  return cleanTranscriptLine(value ?? '').replace(/\[/g, '(').replace(/\]/g, ')') || fallback;
}

const pad = (n: number) => String(n).padStart(2, '0');
const day = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const time = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

function utcOffset(d: Date): string {
  const minutes = -d.getTimezoneOffset();
  if (minutes === 0) return 'UTC';
  const abs = Math.abs(minutes);
  return `UTC${minutes > 0 ? '+' : '-'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** "340 B", "12.5 KB", "1.2 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

const FILE_STATUS: Record<TranscriptFile['status'], string> = {
  pending: 'not finished',
  transferring: 'not finished',
  complete: '',
  cancelled: 'cancelled',
};

export function formatTranscript(input: TranscriptInput): string {
  const room = cleanTranscriptLine(input.roomName) || 'Unnamed room';
  const you = `${personName(input.localName, 'You')} [you]`;

  const out: string[] = [
    'vchat chat transcript',
    `Room: ${room}`,
    `Saved: ${day(input.savedAt)} ${time(input.savedAt)} (${utcOffset(input.savedAt)})`,
    '',
    'Saved on this device from the chat kept in memory during the call. Nothing was uploaded.',
    'Your own messages are marked [you] and private messages [private]. Files are listed by',
    'name and size only. Lines that continue a message are indented.',
    '',
  ];

  let currentDay = '';
  for (const msg of input.messages) {
    const at = new Date(msg.timestamp);
    if (Number.isNaN(at.getTime())) continue;
    if (day(at) !== currentDay) {
      currentDay = day(at);
      out.push(`--- ${currentDay} ---`);
    }
    const from = msg.isLocal ? you : personName(msg.displayName, 'Someone');
    const to = msg.isLocal ? personName(msg.toDisplayName, 'someone') : you;
    const who = msg.private ? `[private] ${from} -> ${to}` : from;
    const [first = '', ...more] = cleanTranscriptText(msg.text).split('\n');
    out.push(`[${time(at)}] ${who}: ${first}`);
    for (const line of more) out.push(`    ${line}`.trimEnd());
  }
  if (input.messages.length === 0) out.push('No messages.');

  if (input.files.length > 0) {
    out.push('', 'Files (names and sizes only, never contents):');
    for (const file of input.files) {
      const sent = file.direction === 'send';
      const from = sent ? you : personName(file.displayName, 'Someone');
      const to = sent ? personName(file.toDisplayName, 'someone') : you;
      const who = file.private ? `[private] ${from} -> ${to}` : `${from} -> everyone`;
      const status = FILE_STATUS[file.status] || (sent ? 'sent' : 'received');
      const fileName = cleanTranscriptLine(file.fileName) || 'unnamed file';
      out.push(`- ${who}: ${fileName} (${formatBytes(file.fileSize)}), ${status}`);
    }
  }

  return `${out.join('\n')}\n`;
}

/**
 * A safe download name: "vchat-chat-<room>-<YYYY-MM-DD>-<HHMM>.txt". The room part keeps only
 * letters, digits and combining marks (no dots, slashes, spaces or other path characters), is
 * capped at 40 characters, and is left out when nothing is left of it.
 */
export function transcriptFileName(roomName: string, savedAt: Date): string {
  const slug = Array.from(
    cleanTranscriptLine(roomName)
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}]+/gu, '-')
      .replace(/^[-\p{M}]+/u, ''),
  )
    .slice(0, MAX_SLUG)
    .join('')
    .replace(/-+$/, '');
  const stamp = `${day(savedAt)}-${pad(savedAt.getHours())}${pad(savedAt.getMinutes())}`;
  return `vchat-chat-${slug ? `${slug}-` : ''}${stamp}.txt`;
}
