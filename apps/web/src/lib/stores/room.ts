import { writable } from 'svelte/store';
import { nanoid } from 'nanoid';

const SIGNAL_URL_KEY = 'vchat_signal_url';
const DISPLAY_NAME_KEY = 'vchat_display_name';
const TURN_URL_KEY = 'vchat_turn_url';
const TURN_USERNAME_KEY = 'vchat_turn_username';
const TURN_CREDENTIAL_KEY = 'vchat_turn_credential';
// Per-tab identity (sessionStorage): survives a page refresh so you can rejoin without
// waiting for the host again, but is gone when the tab closes.
const PEER_ID_KEY = 'vchat_peer_id';
const PEER_SECRET_KEY = 'vchat_peer_secret';
const PENDING_PASSWORD_KEY = 'vchat_pending_password';

function session(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function local(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function sessionValue(key: string, make: () => string): string {
  const store = session();
  const existing = store?.getItem(key);
  if (existing) return existing;
  const value = make();
  store?.setItem(key, value);
  return value;
}

export const peerId = writable<string>(sessionValue(PEER_ID_KEY, () => nanoid(12)));
export const peerSecret = sessionValue(PEER_SECRET_KEY, () => nanoid(32));

// ── Signaling / API endpoints ───────────────────────────────────────────────

/** Same-origin by default: Vite proxies /ws and /api in dev; Caddy or the Worker does in prod. */
function defaultSignalBase(): string {
  if (typeof window === 'undefined') return 'ws://localhost:3001/ws';
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

export function getSignalServerUrl(): string {
  return local()?.getItem(SIGNAL_URL_KEY) || defaultSignalBase();
}

/** Only persist a custom server; clearing the field (or entering the default) resets it. */
export function setSignalServerUrl(url: string): void {
  const trimmed = url.trim();
  if (!trimmed || trimmed === defaultSignalBase()) local()?.removeItem(SIGNAL_URL_KEY);
  else local()?.setItem(SIGNAL_URL_KEY, trimmed);
}

export function signalUrlForRoom(roomId: string): string {
  const url = new URL(getSignalServerUrl());
  url.searchParams.set('room', roomId);
  return url.toString();
}

/** http(s) origin that serves /api/* — derived from the signaling URL. */
function apiBase(): string {
  const url = new URL(getSignalServerUrl());
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = url.pathname.replace(/\/ws\/?$/, '') || '/';
  url.search = '';
  return url.toString().replace(/\/$/, '');
}

// ── ICE servers (STUN/TURN) ─────────────────────────────────────────────────

const FALLBACK_STUN: RTCIceServer[] = [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
];

export interface TurnConfig {
  url: string;
  username: string;
  credential: string;
}

/** Manual TURN override from the settings panel (optional). */
export function getTurnConfig(): TurnConfig | null {
  const store = local();
  const url = store?.getItem(TURN_URL_KEY);
  if (!url) return null;
  return {
    url,
    username: store?.getItem(TURN_USERNAME_KEY) ?? '',
    credential: store?.getItem(TURN_CREDENTIAL_KEY) ?? '',
  };
}

export function setTurnConfig(url: string, username: string, credential: string): void {
  const store = local();
  if (!store) return;
  if (url.trim()) {
    store.setItem(TURN_URL_KEY, url.trim());
    store.setItem(TURN_USERNAME_KEY, username);
    store.setItem(TURN_CREDENTIAL_KEY, credential);
  } else {
    store.removeItem(TURN_URL_KEY);
    store.removeItem(TURN_USERNAME_KEY);
    store.removeItem(TURN_CREDENTIAL_KEY);
  }
}

/**
 * ICE servers for this call. Asks the server (which may hand out short-lived TURN credentials),
 * then falls back to public STUN. A manual TURN override from settings is always added.
 */
export async function fetchIceServers(): Promise<RTCIceServer[]> {
  let servers: RTCIceServer[] = FALLBACK_STUN;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`${apiBase()}/api/ice-servers`, {
      signal: controller.signal,
      credentials: 'same-origin',
    });
    clearTimeout(timer);
    if (res.ok) {
      const body = (await res.json()) as { iceServers?: RTCIceServer[] };
      if (Array.isArray(body.iceServers) && body.iceServers.length > 0) servers = body.iceServers;
    }
  } catch {
    // Server unreachable or older server without /api — STUN fallback is fine.
  }

  const manual = getTurnConfig();
  if (manual) {
    servers = [...servers, { urls: manual.url, username: manual.username, credential: manual.credential }];
  }
  return servers;
}

// ── Misc preferences ────────────────────────────────────────────────────────

export function getSavedDisplayName(): string {
  return local()?.getItem(DISPLAY_NAME_KEY) ?? '';
}

export function saveDisplayName(name: string): void {
  local()?.setItem(DISPLAY_NAME_KEY, name);
}

/** Hand the room password to the room page without putting it in the URL/history. */
export function setPendingPassword(password: string): void {
  if (password) session()?.setItem(PENDING_PASSWORD_KEY, password);
  else session()?.removeItem(PENDING_PASSWORD_KEY);
}

export function takePendingPassword(): string | undefined {
  const store = session();
  const value = store?.getItem(PENDING_PASSWORD_KEY) ?? undefined;
  store?.removeItem(PENDING_PASSWORD_KEY);
  return value || undefined;
}

/** Remember (per tab) a room's password so a refresh/reconnect can reuse it. */
export function rememberRoomPassword(roomId: string, password: string): void {
  session()?.setItem(`vchat_room_pw_${roomId}`, password);
}

export function recallRoomPassword(roomId: string): string | undefined {
  return session()?.getItem(`vchat_room_pw_${roomId}`) || undefined;
}

/** Remember (per tab) that we created this room, so a refresh can reopen it if we were alone. */
export function markRoomCreated(roomId: string): void {
  session()?.setItem(`vchat_created_${roomId}`, '1');
}

export function wasRoomCreated(roomId: string): boolean {
  return session()?.getItem(`vchat_created_${roomId}`) === '1';
}

export function generateRoomId(): string {
  // Readable room codes: 8 chars from an unambiguous lowercase alphabet.
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}
