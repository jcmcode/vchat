// Wire protocol shared by every signaling backend (Node server, Cloudflare Durable Object).

export const MAX_MESSAGE_SIZE = 64 * 1024; // 64KB
export const MAX_PEERS_PER_ROOM = 6;
export const MAX_WAITING_PER_ROOM = 10;
export const WAITING_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

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
}

export type ClientMessage =
  | ({ type: 'create-room' } & EnterRoomFields)
  | ({ type: 'join' } & EnterRoomFields)
  | { type: 'leave' }
  | { type: 'ping' }
  | { type: 'signal'; targetPeerId: string; signal: unknown }
  | { type: 'admit-peer'; peerId: string }
  | { type: 'deny-peer'; peerId: string };

export type ParseResult = { ok: true; msg: ClientMessage } | { ok: false; error: string };

const ROOM_ID_RE = /^[a-z0-9]{1,20}$/;
const PEER_ID_RE = /^[a-zA-Z0-9_-]{1,30}$/;

export function isValidRoomId(roomId: unknown): roomId is string {
  return typeof roomId === 'string' && ROOM_ID_RE.test(roomId);
}

export function isValidPeerId(peerId: unknown): peerId is string {
  return typeof peerId === 'string' && PEER_ID_RE.test(peerId);
}

function cleanDisplayName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // Strip control characters, then trim.
  // eslint-disable-next-line no-control-regex
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (name.length === 0 || name.length > 30) return null;
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
      return {
        ok: true,
        msg: { type: m.type, roomId: m.roomId, peerId: m.peerId, displayName, password, secret },
      };
    }
    case 'leave':
    case 'ping':
      return { ok: true, msg: { type: m.type } };
    case 'signal':
      if (!isValidPeerId(m.targetPeerId)) return { ok: false, error: 'Invalid targetPeerId' };
      return { ok: true, msg: { type: 'signal', targetPeerId: m.targetPeerId, signal: m.signal } };
    case 'admit-peer':
    case 'deny-peer':
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
