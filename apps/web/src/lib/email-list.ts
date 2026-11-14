// Parsing a typed or pasted list of email addresses (the owner's "invite by email" field).
// The server validates every address again; this only gives quick feedback in the form.

export const MAX_RECIPIENTS = 20;

const BAD = String.raw`\s@<>(),;:"\[\]\\`;
const EMAIL_RE = new RegExp(`^[^${BAD}]+@[^${BAD}.]+(\\.[^${BAD}.]+)*\\.[^${BAD}.\\d]{2,}$`);

/** A plausible email address (one @, a dotted domain, no spaces or list punctuation). */
export function isValidEmail(value: string): boolean {
  return value.length <= 254 && EMAIL_RE.test(value);
}

/** Strip wrapping that often comes along with copied addresses. */
function clean(token: string): string {
  return token
    .trim()
    .replace(/^mailto:/i, '')
    .replace(/^[<('"[]+|[>)'"\].]+$/g, '')
    .trim();
}

/**
 * Split text into candidate addresses. Accepts comma, semicolon, space or newline separated
 * lists, and the "Name <a@example.com>" form mail apps produce (quoted names may contain commas).
 * Words without an "@" next to an address (a display name) are dropped; anything else that
 * isn't an address is kept so the form can mark it invalid. Duplicates (ignoring case) are removed.
 */
export function parseEmailList(text: string): string[] {
  // Quoted display names can hold separators ("Smith, Jo" <jo@example.com>): drop them first.
  const unquoted = text.replace(/"[^"]*"/g, ' ');
  const out: string[] = [];
  for (const segment of unquoted.split(/[,;\n\r]+/)) {
    const angle = [...segment.matchAll(/<([^<>]*)>/g)].map((m) => m[1]);
    let words: string[];
    if (angle.length > 0) {
      words = angle;
    } else {
      words = segment.split(/\s+/);
      if (words.some((w) => w.includes('@'))) words = words.filter((w) => w.includes('@'));
    }
    for (const word of words) {
      const token = clean(word);
      if (token) out.push(token);
    }
  }
  return dedupe(out);
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  return list.filter((email) => {
    const key = email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Add newly entered addresses to the current list: deduplicated, capped at `max`.
 * `dropped` counts the addresses that didn't fit.
 */
export function addRecipients(
  current: string[],
  incoming: string[],
  max = MAX_RECIPIENTS
): { list: string[]; dropped: number } {
  const merged = dedupe([...current, ...incoming]);
  return { list: merged.slice(0, max), dropped: Math.max(0, merged.length - max) };
}

/**
 * While typing: split off the addresses that are finished (followed by a separator), leaving the
 * one still being typed. A space only ends an address once it has an "@" (so "Jo Smith <…" can
 * still be typed out) and isn't inside an unclosed "<".
 */
export function splitTyped(value: string): { done: string[]; rest: string } {
  const lastSep = Math.max(value.lastIndexOf(','), value.lastIndexOf(';'), value.lastIndexOf('\n'));
  if (lastSep >= 0) {
    return { done: parseEmailList(value.slice(0, lastSep)), rest: value.slice(lastSep + 1).trimStart() };
  }
  const open = value.lastIndexOf('<') > value.lastIndexOf('>');
  if (/\s$/.test(value) && value.includes('@') && !open) {
    return { done: parseEmailList(value), rest: '' };
  }
  return { done: [], rest: value };
}
