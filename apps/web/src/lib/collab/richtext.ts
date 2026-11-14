// Rich text for whiteboard text boxes. Pure logic (no DOM) so it can be unit-tested.
//
// Text is stored and sent as plain text with lightweight markdown-like markers, never as HTML:
//   **bold**   _italic_   __underline__   lines starting with "- " (bullet) or "1. " (numbered)
// A backslash escapes a marker character (\* \_ \\). Everything a peer sends is untrusted, so the
// text is cleaned with `cleanText` and only ever drawn on a canvas or written as escaped XML.

export const MAX_TEXT_LENGTH = 4000;

export const FONT_STACK = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
export const LINE_HEIGHT = 1.35;

// C0 controls except \n, DEL, C1 controls, bidi embedding/override/isolate marks, zero-width
// characters and the BOM. (\t is turned into spaces first.)
// eslint-disable-next-line no-control-regex
const STRIP_RE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff\ufff9-\ufffb]/g;
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** Make untrusted text safe to store, render and export. Returns '' for non-strings. */
export function cleanText(raw: unknown, max = MAX_TEXT_LENGTH): string {
  if (typeof raw !== 'string') return '';
  let s = raw.length > max * 4 ? raw.slice(0, max * 4) : raw; // bound the work on huge inputs
  s = s
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2028\u2029]/g, '\n')
    .replace(/\t/g, '  ')
    .replace(STRIP_RE, '')
    .replace(LONE_SURROGATE_RE, '');
  if (s.length > max) {
    s = s.slice(0, max);
    // Don't leave half of a surrogate pair at the end.
    if (/[\ud800-\udbff]$/.test(s)) s = s.slice(0, -1);
  }
  return s;
}

// ── Parsing ──────────────────────────────────────────────────────────────────

export interface Run {
  text: string;
  b: boolean;
  i: boolean;
  u: boolean;
}

export type LineKind = 'p' | 'bullet' | 'number';

export interface RichLine {
  kind: LineKind;
  /** Displayed number for numbered lines (consecutive numbered lines count up). */
  num?: number;
  runs: Run[];
}

const BULLET_RE = /^\s*[-*•]\s+(.*)$/;
const NUMBER_RE = /^\s*(\d{1,4})[.)]\s+(.*)$/;
const WORD_CHAR = /[\p{L}\p{N}]/u;

function isWord(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch);
}

/** Can a single `_` at `pos` open italics? (not inside a word, followed by non-space) */
function canOpenUnderscore(s: string, pos: number): boolean {
  return !isWord(s[pos - 1]) && s[pos + 1] !== undefined && !/\s/.test(s[pos + 1]);
}

/** Can a single `_` at `pos` close italics? (preceded by non-space, not followed by a word char) */
function canCloseUnderscore(s: string, pos: number): boolean {
  return pos > 0 && !/\s/.test(s[pos - 1]) && !isWord(s[pos + 1]);
}

function hasCloser(s: string, from: number, marker: '**' | '__' | '_'): boolean {
  for (let p = from; p < s.length; p++) {
    if (s[p] === '\\') {
      p++;
      continue;
    }
    if (marker === '_') {
      if (s.startsWith('__', p)) {
        p++;
        continue;
      }
      if (s[p] === '_' && canCloseUnderscore(s, p)) return true;
    } else if (s.startsWith(marker, p)) {
      return true;
    }
  }
  return false;
}

/** Split one line into formatted runs. Unmatched markers are kept as literal text. */
export function parseInline(line: string): Run[] {
  const runs: Run[] = [];
  let b = false;
  let it = false;
  let u = false;
  let buf = '';
  const flush = () => {
    if (!buf) return;
    const last = runs[runs.length - 1];
    if (last && last.b === b && last.i === it && last.u === u) last.text += buf;
    else runs.push({ text: buf, b, i: it, u });
    buf = '';
  };
  for (let p = 0; p < line.length; ) {
    const ch = line[p];
    if (ch === '\\' && p + 1 < line.length && '*_\\'.includes(line[p + 1])) {
      buf += line[p + 1];
      p += 2;
      continue;
    }
    if (line.startsWith('**', p) && (b || hasCloser(line, p + 2, '**'))) {
      flush();
      b = !b;
      p += 2;
      continue;
    }
    if (line.startsWith('__', p) && (u || hasCloser(line, p + 2, '__'))) {
      flush();
      u = !u;
      p += 2;
      continue;
    }
    if (ch === '_' && (it ? canCloseUnderscore(line, p) : canOpenUnderscore(line, p) && hasCloser(line, p + 1, '_'))) {
      flush();
      it = !it;
      p += 1;
      continue;
    }
    buf += ch;
    p++;
  }
  flush();
  return runs;
}

export function parseRichText(text: string): RichLine[] {
  const out: RichLine[] = [];
  let nextNum: number | null = null;
  for (const raw of text.split('\n')) {
    let m = NUMBER_RE.exec(raw);
    if (m) {
      const num: number = nextNum ?? Number(m[1]);
      nextNum = num + 1;
      out.push({ kind: 'number', num, runs: parseInline(m[2]) });
      continue;
    }
    nextNum = null;
    m = BULLET_RE.exec(raw);
    if (m) out.push({ kind: 'bullet', runs: parseInline(m[1]) });
    else out.push({ kind: 'p', runs: parseInline(raw) });
  }
  return out;
}

// ── Layout (word wrap) ───────────────────────────────────────────────────────

/** Width of `text` at font size `size` (bold/italic as given), in the same units as `size`. */
export type Measure = (text: string, size: number, bold: boolean, italic: boolean) => number;

export interface Segment extends Run {
  x: number;
  width: number;
}

export interface LaidLine {
  /** Top of the line, relative to the box top. */
  y: number;
  marker?: { text: string; x: number };
  segments: Segment[];
}

export interface TextLayout {
  lines: LaidLine[];
  /** Widest line (including list indent), never more than the box width. */
  width: number;
  height: number;
}

export function fontFor(size: number, bold: boolean, italic: boolean): string {
  return `${italic ? 'italic ' : ''}${bold ? 700 : 400} ${size}px ${FONT_STACK}`;
}

/** Lay out parsed lines into a box `maxWidth` wide, wrapping at spaces (or anywhere for long words). */
export function layoutRichText(lines: RichLine[], size: number, maxWidth: number, measure: Measure): TextLayout {
  const lineH = size * LINE_HEIGHT;
  const indent = size * 1.3;
  const laid: LaidLine[] = [];
  let widest = 0;
  let y = 0;

  for (const line of lines) {
    const left = line.kind === 'p' ? 0 : indent;
    const avail = Math.max(maxWidth - left, size);
    const marker =
      line.kind === 'bullet'
        ? { text: '•', x: size * 0.35 }
        : line.kind === 'number'
          ? { text: `${line.num}.`, x: 0 }
          : undefined;

    let segs: Segment[] = [];
    let x = 0;
    let first = true;
    const pushLine = () => {
      // Drop trailing spaces so they don't count toward the width.
      while (segs.length && /^\s+$/.test(segs[segs.length - 1].text)) {
        x -= segs.pop()!.width;
      }
      laid.push({ y, ...(first && marker ? { marker } : {}), segments: segs.map((s) => ({ ...s, x: s.x + left })) });
      widest = Math.max(widest, left + Math.max(x, 0));
      y += lineH;
      segs = [];
      x = 0;
      first = false;
    };

    for (const run of line.runs) {
      // Tokens: runs of spaces or runs of non-spaces.
      for (const tok of run.text.match(/\s+|\S+/g) ?? []) {
        const isSpace = /^\s/.test(tok);
        if (isSpace && x === 0) continue; // no leading spaces on wrapped lines
        let w = measure(tok, size, run.b, run.i);
        if (!isSpace && x + w > avail && x > 0) pushLine();
        if (!isSpace && w > avail) {
          // A single word wider than the box: break it by characters.
          let piece = '';
          for (const ch of Array.from(tok)) {
            const candidate = piece + ch;
            if (x + measure(candidate, size, run.b, run.i) > avail && (piece !== '' || x > 0)) {
              if (piece) {
                const pw = measure(piece, size, run.b, run.i);
                segs.push({ ...run, text: piece, x, width: pw });
                x += pw;
              }
              pushLine();
              piece = ch;
            } else {
              piece = candidate;
            }
          }
          if (piece) {
            w = measure(piece, size, run.b, run.i);
            segs.push({ ...run, text: piece, x, width: w });
            x += w;
          }
          continue;
        }
        segs.push({ ...run, text: tok, x, width: w });
        x += w;
      }
    }
    pushLine();
  }
  return { lines: laid, width: Math.min(widest, maxWidth), height: Math.max(y, lineH) };
}

// ── Editing helpers (used by the format bar) ─────────────────────────────────

export interface Edit {
  text: string;
  selStart: number;
  selEnd: number;
}

/** Toggle an inline marker (`**`, `_` or `__`) around the selection. */
export function toggleInline(text: string, selStart: number, selEnd: number, marker: '**' | '_' | '__'): Edit {
  const m = marker.length;
  const sel = text.slice(selStart, selEnd);
  const before = text.slice(0, selStart);
  const after = text.slice(selEnd);
  // Underscores: an odd run means italic is on, a run of 2+ means underline is on.
  const cb = before.length - before.replace(/_+$/, '').length;
  const ca = after.length - after.replace(/^_+/, '').length;
  const wrappedOutside =
    marker === '**'
      ? before.endsWith('**') && after.startsWith('**')
      : marker === '_'
        ? cb % 2 === 1 && ca % 2 === 1
        : cb >= 2 && ca >= 2;
  if (wrappedOutside) {
    return { text: before.slice(0, -m) + sel + after.slice(m), selStart: selStart - m, selEnd: selEnd - m };
  }
  const sl = sel.length - sel.replace(/^_+/, '').length;
  const st = sel.length - sel.replace(/_+$/, '').length;
  const wrappedInside =
    sel.length >= m * 2 &&
    (marker === '**' ? sel.startsWith('**') && sel.endsWith('**') : marker === '_' ? sl % 2 === 1 && st % 2 === 1 : sl >= 2 && st >= 2);
  if (wrappedInside) {
    const inner = sel.slice(m, -m);
    return { text: before + inner + after, selStart, selEnd: selStart + inner.length };
  }
  // Keep surrounding whitespace outside the markers ("**word** " instead of "**word **").
  const lead = sel.match(/^\s*/)![0];
  const trail = sel.slice(lead.length).match(/\s*$/)![0];
  const core = sel.slice(lead.length, sel.length - trail.length);
  const inserted = lead + marker + core + marker + trail;
  const start = selStart + lead.length + m;
  return { text: before + inserted + after, selStart: start, selEnd: start + core.length };
}

const LIST_PREFIX_RE = /^(\s*)(?:[-*•]|\d{1,4}[.)])\s+/;

/** Toggle bullet or numbered list on every line touched by the selection. */
export function toggleList(text: string, selStart: number, selEnd: number, kind: 'bullet' | 'number'): Edit {
  const lineStart = text.lastIndexOf('\n', selStart - 1) + 1;
  let lineEnd = text.indexOf('\n', Math.max(selEnd - (selEnd > selStart && text[selEnd - 1] === '\n' ? 1 : 0), selStart));
  if (lineEnd === -1) lineEnd = text.length;
  const block = text.slice(lineStart, lineEnd).split('\n');
  const is = (l: string) => (kind === 'bullet' ? BULLET_RE.test(l) && !NUMBER_RE.test(l) : NUMBER_RE.test(l));
  const allHave = block.every(is);
  const next = block.map((l, i) => {
    const bare = l.replace(LIST_PREFIX_RE, '$1');
    if (allHave) return bare;
    return kind === 'bullet' ? `- ${bare.trimStart()}` : `${i + 1}. ${bare.trimStart()}`;
  });
  const replaced = next.join('\n');
  const out = text.slice(0, lineStart) + replaced + text.slice(lineEnd);
  const collapsed = selStart === selEnd;
  const delta = replaced.length - (lineEnd - lineStart);
  if (collapsed) {
    // Keep the caret on the same line, at the end of what changed in front of it.
    const firstDelta = next[0].length - block[0].length;
    const pos = Math.max(lineStart, selStart + firstDelta);
    return { text: out, selStart: pos, selEnd: pos };
  }
  return { text: out, selStart: lineStart, selEnd: Math.max(lineStart, selEnd + delta) };
}

/** Plain text without markers (for accessibility labels and previews). */
export function plainText(text: string): string {
  return parseRichText(text)
    .map((l) => (l.kind === 'bullet' ? '• ' : l.kind === 'number' ? `${l.num}. ` : '') + l.runs.map((r) => r.text).join(''))
    .join('\n');
}

/**
 * Enter pressed at `pos` (collapsed caret): on a list line, start the next item; on an empty list
 * item, end the list. Returns null when Enter should just insert a newline.
 */
export function continueList(text: string, pos: number): Edit | null {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  let lineEnd = text.indexOf('\n', pos);
  if (lineEnd === -1) lineEnd = text.length;
  const m = /^(\s*)([-*•]|\d{1,4}[.)])(\s+)(.*)$/.exec(text.slice(lineStart, lineEnd));
  if (!m) return null;
  const prefixLen = m[1].length + m[2].length + m[3].length;
  if (pos < lineStart + prefixLen) return null;
  if (!m[4].trim()) {
    // Empty item: remove the marker instead of adding another one.
    const out = text.slice(0, lineStart) + text.slice(lineEnd);
    return { text: out, selStart: lineStart, selEnd: lineStart };
  }
  const marker = /^\d/.test(m[2]) ? `${Number(m[2].slice(0, -1)) + 1}${m[2].slice(-1)}` : m[2];
  const insert = `\n${m[1]}${marker} `;
  const out = text.slice(0, pos) + insert + text.slice(pos);
  return { text: out, selStart: pos + insert.length, selEnd: pos + insert.length };
}
