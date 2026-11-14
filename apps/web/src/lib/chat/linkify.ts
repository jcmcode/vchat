// Splits chat text into plain text and links, for rendering as real <a> elements (never HTML).
// Pure and unit-tested (linkify.test.ts).
//
// Only absolute http:// and https:// URLs become links: nothing else can (no javascript:, data:,
// blob:, file: or mailto:). Each candidate is parsed with the WHATWG URL parser, and the link's
// visible text is the parser's normalized href, which is plain ASCII: internationalized hostnames
// show as punycode (so a look-alike domain can't pass as the real one), and non-ASCII, invisible
// or bidi characters in the path are percent-encoded. What you read is where the link goes.

/** Longer URLs stay plain text. */
export const MAX_LINK_LENGTH = 2048;
/** URLs with a longer hostname stay plain text (the DNS limit). */
export const MAX_HOST_LENGTH = 253;

export type ChatPart =
  | { kind: 'text'; text: string }
  /**
   * `href` === `before + domain + after`. `domain` is the end of the hostname that identifies the
   * site ("example.co.uk" in "https://login.example.co.uk/x") and is shown prominently.
   */
  | { kind: 'link'; href: string; before: string; domain: string; after: string };

// A URL starts at http:// or https:// (any case) that doesn't continue an ASCII word, and runs
// until whitespace, a character that can't be in a URL (< > " `), or CJK/full-width punctuation.
const CANDIDATE =
  /(?<![A-Za-z0-9+.-])https?:\/\/[^\s<>"`\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]+/giu;

/**
 * Dropped from the end of a URL: sentence punctuation and quotes ("see https://x.com."). Not `_`,
 * `*` or `~`, which real URLs end with.
 */
const TRAILING = new Set(['.', ',', ':', ';', '!', '?', "'", '"', '\u2026']);
/** Closing brackets are dropped from the end only when unbalanced ("(https://x.com/a_(b))"). */
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/** The candidate's end after trimming trailing punctuation and unbalanced closing brackets. */
function trimEnd(candidate: string): number {
  const counts: Record<string, number> = { '(': 0, ')': 0, '[': 0, ']': 0, '{': 0, '}': 0 };
  for (const ch of candidate) if (ch in counts) counts[ch]++;
  let end = candidate.length;
  while (end > 0) {
    const ch = candidate[end - 1];
    if (TRAILING.has(ch)) {
      end--;
    } else if (ch in CLOSERS && counts[ch] > counts[CLOSERS[ch]]) {
      counts[ch]--;
      end--;
    } else {
      break;
    }
  }
  return end;
}

/** Second-level labels under a country code that are public suffixes, as in co.uk or com.au. */
const SECOND_LEVEL = new Set(['ac', 'co', 'com', 'edu', 'go', 'gob', 'gov', 'gouv', 'govt', 'ltd', 'mil', 'ne', 'net', 'nhs', 'nom', 'or', 'org', 'plc', 'sch']);

/**
 * Where the part of `hostname` that identifies the site starts: the last two labels, or the last
 * three under a suffix like co.uk. A heuristic (there's no public-suffix list here) that errs
 * towards emphasizing too little rather than an attacker's subdomain. IP addresses are whole.
 */
function domainStart(hostname: string): number {
  if (hostname.startsWith('[') || /^[\d.]+$/.test(hostname)) return 0;
  const labels = (hostname.endsWith('.') ? hostname.slice(0, -1) : hostname).split('.');
  const n = labels.length;
  const keep = n >= 3 && labels[n - 1].length === 2 && SECOND_LEVEL.has(labels[n - 2]) ? 3 : 2;
  return n <= keep ? 0 : labels.slice(0, n - keep).join('.').length + 1;
}

/** A link part for `raw`, or null if it must stay text. */
function toLink(raw: string): ChatPart | null {
  if (raw.length > MAX_LINK_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // "https://yourbank.com@evil.example" goes to evil.example but reads as the bank.
  if (url.username || url.password) return null;
  const hostname = url.hostname;
  if (!hostname || hostname.length > MAX_HOST_LENGTH) return null;
  const href = url.href;
  // The parser's output is printable ASCII; anything else means it isn't safe to show as-is.
  if (href.length > MAX_LINK_LENGTH || !/^[\x21-\x7e]+$/.test(href)) return null;
  const prefix = `${url.protocol}//`;
  if (!href.startsWith(prefix + hostname)) return null;
  const start = prefix.length + domainStart(hostname);
  const end = prefix.length + hostname.length;
  return { kind: 'link', href, before: href.slice(0, start), domain: href.slice(start, end), after: href.slice(end) };
}

/** Split `text` into text and link parts, in order. Text parts are never empty. */
export function linkify(text: string): ChatPart[] {
  const parts: ChatPart[] = [];
  let last = 0;
  for (const match of text.matchAll(CANDIDATE)) {
    const start = match.index ?? 0;
    const end = trimEnd(match[0]);
    const link = toLink(match[0].slice(0, end));
    if (!link) continue; // stays text, as part of the next text slice
    if (start > last) parts.push({ kind: 'text', text: text.slice(last, start) });
    parts.push(link);
    last = start + end;
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) });
  return parts;
}
