import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  buildDayOptions,
  combineDateTime,
  dayKey,
  defaultStart,
  formatRange,
  formatTimeOfDay,
  isPast,
  nextHalfHour,
  timeKey,
  timeZoneName,
} from './when.js';

// Local time matters here: run in a zone with daylight saving (Node applies TZ changes at once).
process.env.TZ = 'America/New_York';

/** Intl may put a narrow no-break space before AM/PM. */
const plain = (s: string) => s.replace(/\s/g, ' ');
const local = (y: number, mo: number, d: number, h = 0, min = 0, s = 0) => new Date(y, mo - 1, d, h, min, s).getTime();

test('combineDateTime: local date + time to epoch ms; malformed or impossible dates are null', () => {
  assert.equal(combineDateTime('2026-11-17', '14:30'), Date.UTC(2026, 10, 17, 19, 30)); // EST = UTC-5
  assert.equal(combineDateTime('2026-07-01', '09:05'), Date.UTC(2026, 6, 1, 13, 5)); // EDT = UTC-4
  assert.equal(combineDateTime('2026-11-17', '14:30:00'), Date.UTC(2026, 10, 17, 19, 30)); // time input with seconds
  for (const [day, time] of [
    ['2026-02-30', '10:00'],
    ['2026-13-01', '10:00'],
    ['2026-1-01', '10:00'],
    ['', '10:00'],
    ['2026-11-17', '24:00'],
    ['2026-11-17', '9:00'],
    ['2026-11-17', ''],
  ]) {
    assert.equal(combineDateTime(day, time), null, `${day} ${time}`);
  }
  // Round trip with dayKey/timeKey.
  const ms = combineDateTime('2026-12-24', '09:05')!;
  assert.equal(dayKey(ms), '2026-12-24');
  assert.equal(timeKey(ms), '09:05');
});

test('combineDateTime: daylight saving gaps and overlaps', () => {
  // 2026-03-08: clocks jump from 02:00 EST to 03:00 EDT. 02:30 doesn't exist: it reads as 03:30.
  const gap = combineDateTime('2026-03-08', '02:30')!;
  assert.equal(gap, Date.UTC(2026, 2, 8, 7, 30));
  assert.equal(timeKey(gap), '03:30');
  assert.equal(combineDateTime('2026-03-08', '09:00'), Date.UTC(2026, 2, 8, 13, 0)); // already EDT
  // 2026-11-01: clocks go back from 02:00 EDT to 01:00 EST. 01:30 happens twice: the first one.
  assert.equal(combineDateTime('2026-11-01', '01:30'), Date.UTC(2026, 10, 1, 5, 30));
  assert.equal(combineDateTime('2026-11-01', '09:00'), Date.UTC(2026, 10, 1, 14, 0)); // EST
});

test('addDays steps by calendar day, not 24 hours, across daylight saving changes', () => {
  const sat = local(2026, 3, 7, 23, 30);
  assert.equal(addDays(sat, 0), local(2026, 3, 7));
  assert.equal(addDays(sat, 1), Date.UTC(2026, 2, 8, 5)); // midnight EST
  assert.equal(addDays(sat, 2), Date.UTC(2026, 2, 9, 4)); // midnight EDT: a 23-hour day in between
  assert.equal(dayKey(addDays(local(2026, 10, 31, 12), 1)), '2026-11-01');
  assert.equal(dayKey(addDays(local(2026, 10, 31, 12), 2)), '2026-11-02'); // 25-hour day
  assert.equal(dayKey(addDays(local(2026, 12, 31, 18), 1)), '2027-01-01');
});

test('nextHalfHour: the next :00 or :30 strictly after now', () => {
  assert.equal(nextHalfHour(local(2026, 11, 14, 14, 10)), local(2026, 11, 14, 14, 30));
  assert.equal(nextHalfHour(local(2026, 11, 14, 14, 29, 59)), local(2026, 11, 14, 14, 30));
  assert.equal(nextHalfHour(local(2026, 11, 14, 14, 30)), local(2026, 11, 14, 15, 0));
  assert.equal(nextHalfHour(local(2026, 11, 14, 14, 45)), local(2026, 11, 14, 15, 0));
  assert.equal(nextHalfHour(local(2026, 11, 14, 23, 45)), local(2026, 11, 15, 0, 0));
  // The next tick can be the second 01:00 or 01:30 on fall-back day.
  assert.equal(nextHalfHour(Date.UTC(2026, 10, 1, 5, 55)), Date.UTC(2026, 10, 1, 6));
  assert.equal(nextHalfHour(Date.UTC(2026, 10, 1, 6, 10)), Date.UTC(2026, 10, 1, 6, 30));
  // Into the spring-forward gap: 02:00 doesn't exist, so 03:00 EDT.
  assert.equal(timeKey(nextHalfHour(local(2026, 3, 8, 1, 50))), '03:00');
});

test('nextHalfHour follows the local clock in zones with :45 offsets', () => {
  process.env.TZ = 'Asia/Kathmandu'; // UTC+5:45
  try {
    const now = Date.UTC(2026, 10, 14, 4, 30); // 10:15 local
    assert.equal(timeKey(now), '10:15');
    assert.equal(timeKey(nextHalfHour(now)), '10:30');
  } finally {
    process.env.TZ = 'America/New_York';
  }
});

test('defaultStart: next half hour, 9:00 tomorrow when it is late, 9:00 today in the small hours', () => {
  assert.equal(defaultStart(local(2026, 11, 14, 14, 10)), local(2026, 11, 14, 14, 30));
  assert.equal(defaultStart(local(2026, 11, 14, 20, 20)), local(2026, 11, 14, 20, 30));
  assert.equal(defaultStart(local(2026, 11, 14, 20, 40)), local(2026, 11, 15, 9, 0)); // 21:00 is late
  assert.equal(defaultStart(local(2026, 11, 14, 23, 50)), local(2026, 11, 15, 9, 0)); // past midnight
  assert.equal(defaultStart(local(2026, 11, 14, 3, 0)), local(2026, 11, 14, 9, 0));
  assert.equal(defaultStart(local(2026, 11, 14, 7, 10)), local(2026, 11, 14, 7, 30));
  assert.equal(defaultStart(local(2026, 3, 7, 22, 0)), Date.UTC(2026, 2, 8, 13, 0)); // 9:00 EDT, after the change
});

test('buildDayOptions: Today, Tomorrow, then 5 named days, stepping across DST', () => {
  const days = buildDayOptions(local(2026, 11, 14, 22, 0), 5, 'en-US'); // a Saturday
  assert.deepEqual(
    days.map((d) => d.label),
    ['Today', 'Tomorrow', 'Mon 16', 'Tue 17', 'Wed 18', 'Thu 19', 'Fri 20']
  );
  assert.equal(days[0].key, '2026-11-14');
  assert.equal(days[6].key, '2026-11-20');
  assert.equal(days[2].longLabel, 'Monday, November 16');
  const spring = buildDayOptions(local(2026, 3, 6, 23, 59), 5, 'en-US');
  assert.deepEqual(
    spring.map((d) => d.key),
    ['2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12']
  );
  assert.deepEqual(
    buildDayOptions(local(2026, 12, 30, 12), 3, 'en-GB').map((d) => d.label),
    ['Today', 'Tomorrow', 'Fri 1', 'Sat 2', 'Sun 3']
  );
});

test('time labels follow the locale (12 or 24 hours); summary shows the range and time zone', () => {
  assert.equal(plain(formatTimeOfDay('14:30', 'en-US')), '2:30 PM');
  assert.equal(plain(formatTimeOfDay('09:00', 'en-US')), '9:00 AM');
  assert.equal(formatTimeOfDay('14:30', 'en-GB'), '14:30');

  const start = local(2026, 11, 17, 14, 30);
  assert.equal(plain(formatRange(start, 60, 'en-US')), 'Tue, Nov 17 · 2:30 PM – 3:30 PM');
  assert.equal(plain(formatRange(local(2026, 11, 17, 23, 30), 90, 'en-US')), 'Tue, Nov 17 · 11:30 PM – Wed, Nov 18 1:00 AM');
  assert.equal(timeZoneName(start, 'en-US'), 'EST');
  assert.equal(timeZoneName(local(2026, 7, 1, 12), 'en-US'), 'EDT');
});

test('isPast: slots earlier today are past; later today and other days are not', () => {
  const now = local(2026, 11, 14, 14, 10);
  assert.equal(isPast('2026-11-14', '14:00', now), true);
  assert.equal(isPast('2026-11-14', '15:00', now), false);
  assert.equal(isPast('2026-11-15', '09:00', now), false);
  assert.equal(isPast('2026-11-13', '17:00', now), true);
  assert.equal(isPast('nope', '17:00', now), true);
});
