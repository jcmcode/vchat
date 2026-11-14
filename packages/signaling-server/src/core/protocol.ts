// Wire protocol shared by every signaling backend (Node server, Cloudflare Durable Object).

export const MAX_MESSAGE_SIZE = 64 * 1024; // 64KB
/** Largest `signal` payload (serialized) the server relays. SDP for a 6-person call is far smaller. */
export const MAX_SIGNAL_SIZE = 32 * 1024;
/** Display names: at most this many code points. */
export const MAX_NAME_LENGTH = 30;
export const MAX_PEERS_PER_ROOM = 6;
export const MAX_WAITING_PER_ROOM = 10;
export const WAITING_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes (guests may arrive before the host)

/** Application-level keepalive. Backends must answer PING_MESSAGE with PONG_MESSAGE. */
export const PING_MESSAGE = '{"type":"ping"}';
export const PONG_MESSAGE = '{"type":"pong"}';

interface EnterRoomFields {
  roomId: string;
  peerId: string;
  displayName: string;
  /** Room password (optional). */
  password?: string;
  /** Per-tab secret that lets a peer rejoin after a dropped connection without re-admission. */
  secret?: string;
  /** Private mode: signed invite (guest) or host token. */
  token?: string;
}

export type ClientMessage =
  | ({ type: 'create-room' } & EnterRoomFields)
  | ({ type: 'join' } & EnterRoomFields)
  | { type: 'leave' }
  | { type: 'ping' }
  | { type: 'signal'; targetPeerId: string; signal: unknown }
  | { type: 'admit-peer'; peerId: string }
  | { type: 'deny-peer'; peerId: string }
  /** Host only: remove a participant (or waiting guest) for the rest of the room's life. */
  | { type: 'remove-peer'; peerId: string }
  /** Host only: refuse every new join attempt (admitted peers can still reconnect), or allow them again. */
  | { type: 'lock-room' }
  | { type: 'unlock-room' }
  /** Host only: end the call for everyone, participants and waiting guests alike. */
  | { type: 'end-room' };

export type ParseResult = { ok: true; msg: ClientMessage } | { ok: false; error: string };

const ROOM_ID_RE = /^[a-z0-9]{1,20}$/;
const PEER_ID_RE = /^[a-zA-Z0-9_-]{1,30}$/;

export function isValidRoomId(roomId: unknown): roomId is string {
  return typeof roomId === 'string' && ROOM_ID_RE.test(roomId);
}

export function isValidPeerId(peerId: unknown): peerId is string {
  // "__proto__" would be a valid id by the pattern, but ids are used as keys of plain objects.
  return typeof peerId === 'string' && PEER_ID_RE.test(peerId) && peerId !== '__proto__';
}

/** Remove control, zero-width, bidi-override and other invisible characters (used to fake or hide names). */
export function stripInvisible(value: string): string {
  return value.replace(
    // eslint-disable-next-line no-control-regex, no-misleading-character-class
    /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu,
    ''
  );
}

/** Slice a string by code points (never splits a surrogate pair). */
export function sliceCodePoints(value: string, end: number): string {
  return Array.from(value).slice(0, end).join('');
}

export function codePointLength(value: string): number {
  let n = 0;
  for (const _ of value) n++;
  return n;
}

// A small fold for look-alike letters from other scripts (not the full Unicode confusables table).
const CONFUSABLES: Record<string, string> = {
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
  і: 'i', ї: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ӏ: 'l', ԛ: 'q', ԝ: 'w', һ: 'h', ɡ: 'g',
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ω: 'w',
  '0': 'o', '1': 'l', '|': 'l', '!': 'l', $: 's', '@': 'a',
};

/**
 * Comparison key for display names: compatibility-normalized, accents and case folded, look-alike
 * letters mapped to Latin and whitespace collapsed. "Ałex", "ALEX" and "Аlex" (Cyrillic А) all
 * compare equal to "alex", so nobody can pose as someone else in the participant list.
 */
export function nameKey(name: string): string {
  const folded = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/ł/g, 'l')
    .replace(/ø/g, 'o')
    .replace(/ß/g, 'ss');
  let out = '';
  for (const ch of folded) out += CONFUSABLES[ch] ?? ch;
  // Capital I and small l look the same in many fonts.
  return out.replace(/i/g, 'l').replace(/\s+/g, ' ').trim();
}

function cleanDisplayName(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 4 * MAX_NAME_LENGTH * 2) return null;
  // Strip invisible characters, then trim.
  const name = stripInvisible(raw).trim();
  const length = codePointLength(name);
  if (length === 0 || length > MAX_NAME_LENGTH) return null;
  return name;
}

function optionalString(value: unknown, max: number): string | undefined | null {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max) return null;
  return value;
}

export function parseClientMessage(raw: string): ParseResult {
  if (raw.length > MAX_MESSAGE_SIZE) return { ok: false, error: 'Message too large' };

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Invalid JSON' };
  }
  if (!data || typeof data !== 'object') return { ok: false, error: 'Invalid message' };
  const m = data as Record<string, unknown>;

  switch (m.type) {
    case 'create-room':
    case 'join': {
      if (!isValidRoomId(m.roomId)) {
        return { ok: false, error: 'Invalid roomId: must be 1-20 lowercase alphanumeric characters' };
      }
      if (!isValidPeerId(m.peerId)) {
        return { ok: false, error: 'Invalid peerId: must be 1-30 alphanumeric/underscore/hyphen characters' };
      }
      const displayName = cleanDisplayName(m.displayName);
      if (!displayName) {
        return { ok: false, error: 'Invalid displayName: must be 1-30 characters after trimming' };
      }
      const password = optionalString(m.password, 256);
      if (password === null) return { ok: false, error: 'Invalid password' };
      const secret = optionalString(m.secret, 128);
      if (secret === null) return { ok: false, error: 'Invalid secret' };
      const token = optionalString(m.token, 2048);
      if (token === null) return { ok: false, error: 'Invalid token' };
      return {
        ok: true,
        msg: { type: m.type, roomId: m.roomId, peerId: m.peerId, displayName, password, secret, token },
      };
    }
    case 'leave':
    case 'ping':
    case 'lock-room':
    case 'unlock-room':
    case 'end-room':
      return { ok: true, msg: { type: m.type } };
    case 'signal': {
      if (!isValidPeerId(m.targetPeerId)) return { ok: false, error: 'Invalid targetPeerId' };
      const size = JSON.stringify(m.signal ?? null).length;
      if (size > MAX_SIGNAL_SIZE) return { ok: false, error: 'Signal too large' };
      return { ok: true, msg: { type: 'signal', targetPeerId: m.targetPeerId, signal: m.signal } };
    }
    case 'admit-peer':
    case 'deny-peer':
    case 'remove-peer':
      if (!isValidPeerId(m.peerId)) return { ok: false, error: 'Invalid peerId' };
      return { ok: true, msg: { type: m.type, peerId: m.peerId } };
    default:
      return { ok: false, error: 'Unknown message type' };
  }
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
