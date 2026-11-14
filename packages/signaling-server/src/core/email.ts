// Email sign-in codes and invite emails, sent through Resend (https://resend.com).
// Works on Node 20+ and Cloudflare Workers (fetch + WebCrypto only). Nothing is stored, and no
// address, code, token or invite message is ever logged.

import { sliceCodePoints, stripInvisible } from './protocol.js';

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;
const RESEND_URL = 'https://api.resend.com/emails';
const RESEND_TIMEOUT_MS = 10_000;
const RESEND_RETRY_MS = 1100;

/** Trimmed, lowercased address, or null if it doesn't look like one. */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) return null;
  return email;
}

/** EMAIL_FROM: `invites@example.com` or `Name <invites@example.com>`. */
export function isValidSender(value: string): boolean {
  const v = value.trim();
  const m = v.match(/^([^<>"\r\n]{1,100}?)\s*<([^<>\s]+)>$/);
  return normalizeEmail(m ? m[2] : v) !== null;
}

/**
 * Owner sign-in codes. A sign-in challenge isn't secret (anyone can ask for one for the owner's
 * address), so the code is the only secret: 8 digits keeps guessing hopeless even at the
 * throttles' ceiling, for as long as an attacker cares to try.
 */
export const LOGIN_CODE_DIGITS = 8;
/** Guest passcodes: they only work together with a personal (secret) invite link. */
export const PASSCODE_DIGITS = 6;

/** A uniformly random code of `digits` digits (rejection sampling, no modulo bias). */
export function randomCode(digits = PASSCODE_DIGITS): string {
  const range = 10 ** digits;
  const limit = Math.floor(0x1_0000_0000 / range) * range;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return String(buf[0] % range).padStart(digits, '0');
  }
}

/** Longest invite message, in code points (longer ones are cut, not refused). */
export const MAX_INVITE_MESSAGE = 500;

/**
 * The host's optional note for an invite: control, bidi and zero-width characters removed (tabs
 * become spaces), newlines kept but at most one blank line in a row, trimmed, and cut to
 * MAX_INVITE_MESSAGE code points. Returns '' for anything that isn't a string.
 */
export function cleanInviteMessage(value: unknown): string {
  if (typeof value !== 'string') return '';
  const lines = value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => stripInvisible(line.replace(/\t/g, ' ')).trimEnd());
  const joined = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return sliceCodePoints(joined, MAX_INVITE_MESSAGE).trim();
}

export function isCode(value: unknown, digits = PASSCODE_DIGITS): value is string {
  return typeof value === 'string' && value.length === digits && /^\d+$/.test(value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Header-safe single line. */
function oneLine(value: string): string {
  return value.replace(/[\r\n\t\u0000-\u001f\u007f]+/g, ' ').trim();
}

export interface EmailAttachment {
  filename: string;
  /** Base64 (standard alphabet). */
  content: string;
  content_type: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments?: EmailAttachment[];
}

function layout(body: string): string {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f6f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111"><div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:28px">${body}</div></body></html>`;
}

function codeBlock(code: string): string {
  return `<p style="font-size:32px;font-weight:700;letter-spacing:6px;font-family:ui-monospace,Menlo,Consolas,monospace;margin:16px 0">${escapeHtml(code)}</p>`;
}

export function loginCodeEmail(to: string, code: string): EmailMessage {
  return {
    to,
    subject: 'Your sign-in code',
    text: `Your vchat sign-in code is: ${code}\n\nIt expires in 10 minutes.\n\nIf you didn't ask for this, ignore this email.\n`,
    html: layout(
      `<p>Your vchat sign-in code is:</p>${codeBlock(code)}<p>It expires in 10 minutes.</p><p style="color:#666">If you didn't ask for this, ignore this email.</p>`
    ),
  };
}

/** "2026-11-14 18:30 UTC" */
export function formatUtc(unixSeconds: number): string {
  return `${new Date(unixSeconds * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "1 hour", "45 min", "1 h 30 min" */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} hour${h === 1 ? '' : 's'}`;
  return `${h} h ${m} min`;
}

/** "Saturday, 14 November 2026, 18:30 UTC (1 hour)" */
export function formatMeetingTime(startsAtMs: number, durationMinutes: number): string {
  const d = new Date(startsAtMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC (${formatDuration(durationMinutes)})`
  );
}

export interface InviteEmailOptions {
  link: string;
  /** The guest's 6-digit code; omitted for invites without a passcode (the host admits them). */
  code?: string;
  label?: string;
  /** Invite expiry, unix seconds. */
  exp: number;
  /** Scheduled meeting: shown as a "When:" line. */
  schedule?: { startsAt: number; durationMinutes: number };
  /** Calendar file to attach as invite.ics (scheduled invites). */
  ics?: string;
  /** A short note from the host, already cleaned (see cleanInviteMessage). May hold newlines. */
  message?: string;
}

/** Escaped HTML with line breaks kept as <br>. */
function htmlLines(value: string): string {
  return value.split('\n').map(escapeHtml).join('<br>');
}

export function inviteEmail(to: string, opts: InviteEmailOptions): EmailMessage {
  const what = opts.label ? oneLine(opts.label) : 'a video call';
  const expires = formatUtc(opts.exp);
  const when = opts.schedule ? formatMeetingTime(opts.schedule.startsAt, opts.schedule.durationMinutes) : null;
  const instructions = opts.code
    ? 'Open the link, enter the code, and the host will let you in.'
    : 'Open the link, enter your name, and the host will let you in.';
  const attached = opts.ics ? 'A calendar invite is attached.' : null;
  const otherBrowser = 'Want to join from a different browser? Copy the link from this email, not the address bar after it opens.';
  const message = opts.message?.trim() || null;
  const text = [
    `You're invited to ${what}.`,
    '',
    ...(message ? ['Message from the host:', message, ''] : []),
    ...(when ? [`When: ${when}`, ''] : []),
    `Join the call: ${opts.link}`,
    '',
    ...(opts.code ? [`Your code: ${opts.code}`, ''] : []),
    instructions,
    otherBrowser,
    '',
    ...(attached ? [attached, ''] : []),
    `This invite expires ${expires}.`,
    '',
  ].join('\n');
  const html = layout(
    `<p>You're invited to <strong>${escapeHtml(what)}</strong>.</p>` +
      (message
        ? `<p style="margin:0 0 4px;color:#666;font-size:14px">Message from the host:</p>` +
          `<p style="margin:0 0 16px;padding:12px 14px;background:#f3f3f3;border-radius:8px">${htmlLines(message)}</p>`
        : '') +
      (when ? `<p><strong>When:</strong> ${escapeHtml(when)}</p>` : '') +
      `<p><a href="${escapeHtml(opts.link)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">Join the call</a></p>` +
      (opts.code ? `<p>Your code:</p>${codeBlock(opts.code)}` : '') +
      `<p>${escapeHtml(instructions)}</p>` +
      `<p style="color:#666;font-size:14px">${escapeHtml(otherBrowser)}</p>` +
      (attached ? `<p>${escapeHtml(attached)}</p>` : '') +
      `<p style="color:#666">This invite expires ${escapeHtml(expires)}.</p>`
  );
  return {
    to,
    subject: oneLine(`You're invited to ${what}`),
    text,
    html,
    ...(opts.ics
      ? { attachments: [{ filename: 'invite.ics', content: base64Utf8(opts.ics), content_type: 'text/calendar; method=REQUEST; charset=UTF-8' }] }
      : {}),
  };
}

// ── Calendar invites (RFC 5545) ──────────────────────────────────────────────

/** Standard base64 of a string's UTF-8 bytes. */
export function base64Utf8(value: string): string {
  let binary = '';
  for (const b of new TextEncoder().encode(value)) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** EMAIL_FROM split into display name and address. */
export function parseSender(from: string): { name?: string; address: string } {
  const v = from.trim();
  const m = v.match(/^([^<>"\r\n]{1,100}?)\s*<([^<>\s]+)>$/);
  if (!m) return { address: normalizeEmail(v) ?? v };
  const name = oneLine(m[1]);
  return { ...(name ? { name } : {}), address: normalizeEmail(m[2]) ?? m[2] };
}

/** RFC 5545 TEXT escaping: backslash, semicolon, comma and newlines. */
export function icsText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
}

/** Parameter value (e.g. CN): quoted when it holds ":", ";" or ","; DQUOTE and controls removed. */
function icsParam(value: string): string {
  const v = oneLine(value).replace(/"/g, '');
  return /[:;,]/.test(v) ? `"${v}"` : v;
}

/** RFC 5545 folding: lines over 75 octets continue after CRLF + space, never splitting a character. */
export function icsFold(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const out: string[] = [];
  let current = '';
  let size = 0;
  for (const ch of line) {
    const len = encoder.encode(ch).length;
    // The first line holds 75 octets; continuation lines a space plus 74.
    if (size + len > (out.length === 0 ? 75 : 74)) {
      out.push(current);
      current = '';
      size = 0;
    }
    current += ch;
    size += len;
  }
  out.push(current);
  return out.join('\r\n ');
}

/** "123 456": easier to read off a calendar entry and type in. */
function spacedCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

function icsDate(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export interface CalendarInvite {
  uid: string;
  /** Times in ms since the epoch. */
  now: number;
  startsAt: number;
  durationMinutes: number;
  summary: string;
  link: string;
  /**
   * The guest's 6-digit code, if the invite has one. It goes in the description: the owner accepts
   * that calendar apps sync the event to their providers.
   */
  passcode?: string;
  /** A short note from the host, already cleaned. Shown above the join line. */
  message?: string;
  organizer: { name?: string; address: string };
  attendee: string;
}

/** A METHOD:REQUEST calendar invite for one attendee: the link, and the passcode if there is one. */
export function buildInviteIcs(inv: CalendarInvite): string {
  const message = inv.message?.trim();
  // The code comes first: the link is several hundred characters long, and calendar previews cut
  // the notes off well before anything that follows it.
  const description = [
    ...(inv.passcode ? [`Your code: ${spacedCode(inv.passcode)}`, 'Open the link below at meeting time and enter this code.', ''] : []),
    ...(message ? [message, ''] : []),
    `Join: ${inv.link}`,
  ].join('\n');
  const reminder = inv.passcode ? `Video call starting. Your code: ${spacedCode(inv.passcode)}` : 'Video call starting';
  const organizerCn = inv.organizer.name ? `;CN=${icsParam(inv.organizer.name)}` : '';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//vchat//invite//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${inv.uid}`,
    `DTSTAMP:${icsDate(inv.now)}`,
    `DTSTART:${icsDate(inv.startsAt)}`,
    `DTEND:${icsDate(inv.startsAt + inv.durationMinutes * 60_000)}`,
    `SUMMARY:${icsText(oneLine(inv.summary) || 'Video call')}`,
    `DESCRIPTION:${icsText(description)}`,
    `URL:${inv.link}`,
    `LOCATION:${icsText(inv.link)}`,
    `ORGANIZER${organizerCn}:mailto:${inv.organizer.address}`,
    `ATTENDEE;CN=${icsParam(inv.attendee)};RSVP=FALSE;PARTSTAT=NEEDS-ACTION;ROLE=REQ-PARTICIPANT:mailto:${inv.attendee}`,
    'STATUS:CONFIRMED',
    'SEQUENCE:0',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsText(reminder)}`,
    'TRIGGER:-PT10M',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

export interface ResendEnv {
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
}

/** Send one email through Resend. Throws a generic error on failure (no provider details). */
export async function sendEmail(env: ResendEnv, message: EmailMessage): Promise<void> {
  const body = JSON.stringify({
    from: env.EMAIL_FROM!.trim(),
    to: [message.to],
    subject: message.subject,
    html: message.html,
    text: message.text,
    ...(message.attachments?.length ? { attachments: message.attachments } : {}),
  });
  // Resend rate-limits each account to a few requests per second: one retry after a short pause.
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(RESEND_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
      });
    } catch {
      throw new Error('Email provider unreachable');
    }
    // Drain the body without reading it into logs.
    await res.body?.cancel().catch(() => {});
    if (res.ok) return;
    if (res.status === 429 && attempt === 0) {
      await new Promise((r) => setTimeout(r, RESEND_RETRY_MS));
      continue;
    }
    throw new Error(`Email provider returned ${res.status}`);
  }
}
