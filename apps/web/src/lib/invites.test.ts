import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIcs, inviteText, mailtoLink } from './invites.js';

const invite = {
  title: 'Family call; with, commas',
  link: 'https://call.example.com/room/abc#invite=TOKEN&k=KEY',
  startsAt: Date.UTC(2026, 11, 24, 18, 30),
  durationMinutes: 45,
  hasPassword: true,
};

test('calendar file is valid iCalendar with escaping and folding', () => {
  const ics = buildIcs(invite, Date.UTC(2026, 10, 14));
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.match(ics, /DTSTART:20261224T183000Z/);
  assert.match(ics, /DTEND:20261224T191500Z/);
  assert.ok(ics.includes('SUMMARY:Family call\\; with\\, commas'));
  for (const line of ics.split('\r\n')) assert.ok(new TextEncoder().encode(line).length <= 75, `line too long: ${line}`);
  // Unfolded, the link survives intact
  assert.ok(ics.replace(/\r\n /g, '').includes(invite.link));
});

test('calendar file puts the password first only when asked, otherwise says it comes separately', () => {
  const unfold = (ics: string) => ics.replace(/\r\n /g, '');
  const without = unfold(buildIcs(invite, Date.UTC(2026, 10, 14)));
  assert.ok(without.includes('sent to you separately'));
  assert.ok(!without.includes('Password:'));

  const withPw = unfold(buildIcs({ ...invite, password: 'hunter-22' }, Date.UTC(2026, 10, 14)));
  assert.ok(withPw.includes('DESCRIPTION:Password: hunter-22\\n'));
  assert.ok(!withPw.includes('sent to you separately'));
});

test('invite text and email draft include the link (with its key) and mention the password', () => {
  const text = inviteText(invite);
  assert.ok(text.includes(invite.link));
  assert.ok(text.includes('password'));
  const mail = mailtoLink(invite);
  assert.ok(mail.startsWith('mailto:?subject='));
  assert.ok(decodeURIComponent(mail).includes(invite.link));
});

test('inviteText puts the password in only when asked, otherwise says it comes separately', () => {
  const base = { title: 'Call', link: 'https://x.example/room/abc#invite=t', hasPassword: true };
  assert.match(inviteText(base), /send you the room password separately/);
  assert.doesNotMatch(inviteText(base), /Password:/);
  const withPw = inviteText({ ...base, password: 'hunter-22' });
  assert.match(withPw, /Password: hunter-22/);
  assert.doesNotMatch(withPw, /separately/);
});
