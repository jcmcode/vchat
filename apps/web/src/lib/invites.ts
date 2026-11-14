// Meeting invites without any server: a calendar file (.ics) downloaded in the browser, and an
// email drafted in the user's own mail app (mailto:). vchat never sends or stores invites.

export interface MeetingInvite {
  title: string;
  link: string;
  /** Start time (ms since epoch); omit for an unscheduled "join any time" invite. */
  startsAt?: number;
  durationMinutes?: number;
  /** Room has a password (sent separately). */
  hasPassword?: boolean;
}

/** RFC 5545 text escaping. */
function icsText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** RFC 5545 line folding: lines over 75 octets continue on the next line after a space. */
function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let current = '';
  let size = 0;
  for (const ch of line) {
    const len = new TextEncoder().encode(ch).length;
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

function icsDate(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function description(invite: MeetingInvite): string {
  return [
    `Join the video call: ${invite.link}`,
    invite.hasPassword ? 'The room password will be sent to you separately.' : '',
    'End-to-end encrypted. No account needed — just open the link in your browser.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function buildIcs(invite: MeetingInvite, now = Date.now()): string {
  const start = invite.startsAt ?? now;
  const end = start + (invite.durationMinutes ?? 60) * 60_000;
  const uid = `${crypto.getRandomValues(new Uint32Array(4)).join('-')}@vchat`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//vchat//invite//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${icsDate(now)}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsText(invite.title)}`,
    `DESCRIPTION:${icsText(description(invite))}`,
    `LOCATION:${icsText(invite.link)}`,
    `URL:${invite.link}`,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'DESCRIPTION:Video call starting',
    'TRIGGER:-PT10M',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

export function downloadIcs(invite: MeetingInvite): void {
  const blob = new Blob([buildIcs(invite)], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const safe = invite.title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 40) || 'video-call';
  a.download = `${safe}.ics`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formatWhen(invite: MeetingInvite): string {
  if (!invite.startsAt) return '';
  const start = new Date(invite.startsAt);
  const when = start.toLocaleString([], { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  return `When: ${when}${invite.durationMinutes ? ` (${invite.durationMinutes} min)` : ''}\n`;
}

/** Plain-text invite (for email, messages, or the clipboard). */
export function inviteText(invite: MeetingInvite): string {
  return [
    `You're invited to a private video call: ${invite.title}`,
    '',
    formatWhen(invite) + `Join: ${invite.link}`,
    '',
    invite.hasPassword ? "I'll send you the room password separately.\n" : '',
    'It runs in your browser — no account or app needed — and the call is end-to-end encrypted.',
  ]
    .filter((l, i, arr) => !(l === '' && arr[i - 1] === ''))
    .join('\n')
    .trim();
}

/** Opens the user's own email app with the invite drafted (vchat never sends email). */
export function mailtoLink(invite: MeetingInvite, to = ''): string {
  const subject = `Video call: ${invite.title}${invite.startsAt ? ` — ${new Date(invite.startsAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}` : ''}`;
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(inviteText(invite))}`;
}

/** Meeting lengths offered when scheduling (minutes). */
export const DURATIONS = [15, 30, 45, 60, 90, 120];

/** "45 min", "1 h", "1 h 30". */
export function durationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m}` : `${h} h`;
}

/** A time as the value of an <input type="datetime-local"> (local time, minute precision). */
export function toDatetimeLocal(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
