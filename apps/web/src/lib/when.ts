// Pure helpers behind the date and time picker (WhenPicker.svelte). Everything is in the user's
// local time zone, and days are stepped by calendar date (never by adding 24 hours), so daylight
// saving changes don't shift anything.

/** What the picker edits: an optional start time (ms since the epoch) and a length in minutes. */
export interface When {
  startsAt: number | null;
  durationMinutes: number;
}

/** Quick time choices, as "HH:MM" (24-hour, local). */
export const TIME_SLOTS = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'];

/** From this hour on, the default start moves to 9:00 the next day. */
const LATE_HOUR = 21;
/** Before this hour, the default start is 9:00 the same day. */
const EARLY_HOUR = 7;
const DEFAULT_HOUR = 9;

const pad = (n: number) => String(n).padStart(2, '0');

/** A local calendar day as "YYYY-MM-DD" (the value format of <input type="date">). */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A local time of day as "HH:MM" (the value format of <input type="time">). */
export function timeKey(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseDay(day: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return [y, mo, d];
}

function parseTime(time: string): [number, number] | null {
  const m = /^(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(time);
  if (!m) return null;
  const [h, min] = [Number(m[1]), Number(m[2])];
  if (h > 23 || min > 59) return null;
  return [h, min];
}

/**
 * A local date ("YYYY-MM-DD") and time ("HH:MM") as ms since the epoch, or null if either is
 * malformed or the date doesn't exist (e.g. Feb 30). A time skipped by a daylight-saving jump
 * (e.g. 02:30 on the night clocks go forward) lands just after the jump, the way clocks read; a
 * time that happens twice (clocks going back) is the first one.
 */
export function combineDateTime(day: string, time: string): number | null {
  const d = parseDay(day);
  const t = parseTime(time);
  if (!d || !t) return null;
  const date = new Date(d[0], d[1] - 1, d[2], t[0], t[1], 0, 0);
  // Reject dates that rolled over (Feb 30 -> Mar 2).
  if (date.getFullYear() !== d[0] || date.getMonth() !== d[1] - 1 || date.getDate() !== d[2]) return null;
  return date.getTime();
}

/** Midnight (local) of the day `offset` calendar days after the day of `ms`. */
export function addDays(ms: number, offset: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset).getTime();
}

/** The next whole half hour (:00 or :30, local) strictly after `now`. */
export function nextHalfHour(now: number): number {
  const d = new Date(now);
  const minutes = d.getHours() * 60 + d.getMinutes() + 1; // strictly later, at least a minute away
  const rounded = Math.ceil(minutes / 30) * 30;
  // Built from the local date so half-hour boundaries follow the local clock (also for zones with
  // :30 or :45 offsets); the Date constructor carries 24:00 over to the next day.
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, rounded).getTime();
}

/**
 * The start time suggested when nothing is chosen yet: the next whole half hour, or 9:00 the next
 * morning if that's late in the evening (or 9:00 today in the small hours).
 */
export function defaultStart(now: number): number {
  const next = nextHalfHour(now);
  const hour = new Date(next).getHours();
  if (dayKey(next) !== dayKey(now) || hour >= LATE_HOUR) {
    return combineDateTime(dayKey(addDays(now, 1)), `${pad(DEFAULT_HOUR)}:00`)!;
  }
  if (hour < EARLY_HOUR) return combineDateTime(dayKey(now), `${pad(DEFAULT_HOUR)}:00`)!;
  return next;
}

export interface DayOption {
  /** "YYYY-MM-DD" */
  key: string;
  /** "Today", "Tomorrow", then e.g. "Mon 17". */
  label: string;
  /** Full date for screen readers, e.g. "Monday, November 17". */
  longLabel: string;
}

/** Today, tomorrow and the `extra` days after that. */
export function buildDayOptions(now: number, extra = 5, locale?: string | string[]): DayOption[] {
  const short = new Intl.DateTimeFormat(locale, { weekday: 'short' });
  const long = new Intl.DateTimeFormat(locale, { weekday: 'long', month: 'long', day: 'numeric' });
  const out: DayOption[] = [];
  for (let i = 0; i < extra + 2; i++) {
    const ms = addDays(now, i);
    const date = new Date(ms);
    out.push({
      key: dayKey(ms),
      label: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : `${short.format(date)} ${date.getDate()}`,
      longLabel: long.format(date),
    });
  }
  return out;
}

/** "HH:MM" shown in the user's 12/24-hour style, e.g. "2:30 PM" or "14:30". */
export function formatTimeOfDay(time: string, locale?: string | string[]): string {
  const t = parseTime(time);
  if (!t) return time;
  return new Date(2000, 0, 1, t[0], t[1]).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
}

/** Short name of the local time zone at that moment, e.g. "EST", "GMT+1". */
export function timeZoneName(ms: number, locale?: string | string[]): string {
  const part = new Intl.DateTimeFormat(locale, { timeZoneName: 'short' }).formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName');
  return part?.value ?? '';
}

/** "Mon, Nov 17 · 2:30 PM – 3:30 PM" (the end gets its own date if it falls on another day). */
export function formatRange(startsAt: number, durationMinutes: number, locale?: string | string[]): string {
  const end = startsAt + durationMinutes * 60_000;
  const date = new Intl.DateTimeFormat(locale, { weekday: 'short', month: 'short', day: 'numeric' });
  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' });
  const endText = dayKey(end) === dayKey(startsAt) ? time.format(end) : `${date.format(end)} ${time.format(end)}`;
  return `${date.format(startsAt)} · ${time.format(startsAt)} – ${endText}`;
}

/** Whether a quick time slot on that day has already passed. */
export function isPast(day: string, time: string, now: number): boolean {
  const ms = combineDateTime(day, time);
  return ms === null || ms < now;
}
