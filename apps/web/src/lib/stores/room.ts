import { get, writable } from 'svelte/store';
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

/**
 * Identity for one room in this tab: a random peer id + rejoin secret. A fresh pair per room, so
 * the server can't link the rooms you join from the same tab.
 */
export const peerId = writable<string>('');
let peerSecret = '';

export function getPeerSecret(): string {
  return peerSecret;
}

/** Load (or create) this tab's identity for a room. */
export function useRoomIdentity(roomId: string): void {
  peerId.set(sessionValue(`${PEER_ID_KEY}_${roomId}`, () => nanoid(12)));
  peerSecret = sessionValue(`${PEER_SECRET_KEY}_${roomId}`, () => nanoid(32));
}

// "Duplicate tab" copies sessionStorage, which would give two tabs the same identity and make
// them kick each other off the server. Tabs answer when asked whether they own an id.
const identityChannel =
  typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('vchat_identity')
    : null;
identityChannel?.addEventListener('message', (e: MessageEvent) => {
  const mine = get(peerId);
  if (mine && e.data?.type === 'query' && e.data.peerId === mine) {
    identityChannel.postMessage({ type: 'taken', peerId: e.data.peerId });
  }
});

/** Make sure no other open tab is using this tab's peer id for the room; pick a new one if so. */
export async function ensureUniqueTabIdentity(roomId: string): Promise<void> {
  if (!identityChannel) return;
  const id = get(peerId);
  const taken = await new Promise<boolean>((resolve) => {
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === 'taken' && e.data.peerId === id) finish(true);
    };
    const finish = (result: boolean) => {
      identityChannel.removeEventListener('message', onMessage);
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish(false), 250);
    identityChannel.addEventListener('message', onMessage);
    identityChannel.postMessage({ type: 'query', peerId: id });
  });
  if (!taken) return;
  const store = session();
  const newId = nanoid(12);
  peerSecret = nanoid(32);
  store?.setItem(`${PEER_ID_KEY}_${roomId}`, newId);
  store?.setItem(`${PEER_SECRET_KEY}_${roomId}`, peerSecret);
  peerId.set(newId);
}

// ── Signaling / API endpoints ───────────────────────────────────────────────

/** Same-origin by default: Vite proxies /ws and /api in dev; Caddy or the Worker does in prod. */
function defaultSignalBase(): string {
  if (typeof window === 'undefined') return 'ws://localhost:3001/ws';
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

/**
 * The web app always talks to the server it was loaded from. (A stale custom server saved by an
 * older version would otherwise receive invite tokens and room passwords — so it's ignored and
 * removed.)
 */
export function getSignalServerUrl(): string {
  if (local()?.getItem(SIGNAL_URL_KEY)) local()?.removeItem(SIGNAL_URL_KEY);
  return defaultSignalBase();
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

/** If the server can't be asked, don't contact any third party: no STUN (direct/LAN only). */
const FALLBACK_STUN: RTCIceServer[] = [];

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
 * On private instances the invite/host token proves we're allowed to use the TURN relay.
 */
const RELAY_ONLY_KEY = 'vchat_relay_only';

/** "Hide my IP address": connect only through the TURN relay, never directly. */
export function getRelayOnly(): boolean {
  return local()?.getItem(RELAY_ONLY_KEY) === '1';
}

export function setRelayOnly(on: boolean): void {
  if (on) local()?.setItem(RELAY_ONLY_KEY, '1');
  else local()?.removeItem(RELAY_ONLY_KEY);
}

/** ICE servers for a call, and how long (seconds) any TURN credentials in them stay valid. */
/** `ok` is false when the server couldn't be asked or refused (the servers are then only the fallback). */
export async function fetchIceServers(token?: string): Promise<{ servers: RTCIceServer[]; ttl?: number; ok: boolean }> {
  let servers: RTCIceServer[] = FALLBACK_STUN;
  let ttl: number | undefined;
  let ok = false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`${apiBase()}/api/ice-servers`, {
      signal: controller.signal,
      headers: token ? { 'X-Vchat-Token': token } : {},
    });
    clearTimeout(timer);
    if (res.ok) {
      ok = true;
      const body = (await res.json()) as { iceServers?: RTCIceServer[]; ttl?: unknown };
      if (Array.isArray(body.iceServers) && body.iceServers.length > 0) servers = body.iceServers;
      if (typeof body.ttl === 'number' && Number.isFinite(body.ttl) && body.ttl > 0) ttl = body.ttl;
    }
  } catch {
    // Server unreachable or older server without /api — STUN fallback is fine.
  }

  const manual = getTurnConfig();
  if (manual) {
    servers = [...servers, { urls: manual.url, username: manual.username, credential: manual.credential }];
  }
  return { servers, ttl, ok };
}

// ── Server mode ─────────────────────────────────────────────────────────────

export interface ServerConfig {
  /** open: anyone can create rooms. private: the owner signs in, guests need an invite link. */
  mode: 'open' | 'private';
  auth: 'access' | 'password' | 'email' | null;
  /** The server's settings are incomplete or contradictory (details are only in its own log). */
  misconfigured?: boolean;
  /** The server can email invites itself (Resend is configured). */
  emailInvites?: boolean;
}

let configPromise: Promise<ServerConfig> | null = null;

export function fetchServerConfig(): Promise<ServerConfig> {
  configPromise ??= fetch(`${apiBase()}/api/config`)
    .then((r) => {
      if (!r.ok) throw new Error(`config ${r.status}`);
      return r.json() as Promise<ServerConfig>;
    })
    .catch(() => {
      configPromise = null; // don't remember a network blip; try again next time
      // Assume the stricter mode: the server decides anyway, and this never offers to create rooms
      // on a private server just because the request failed.
      return { mode: 'private' as const, auth: null };
    });
  return configPromise;
}

export function apiUrl(path: string): string {
  return `${apiBase()}${path}`;
}

// ── Invite / host tokens (per tab, per room) ────────────────────────────────

export function setRoomToken(roomId: string, token: string): void {
  session()?.setItem(`vchat_token_${roomId}`, token);
}

export function getRoomToken(roomId: string): string | undefined {
  return session()?.getItem(`vchat_token_${roomId}`) || undefined;
}

export interface TokenInfo {
  role?: 'host' | 'guest';
  label?: string;
  exp?: number;
  hasPassword?: boolean;
  /** Personal invite: the email address it was sent to (it then needs that person's code). */
  to?: string;
}

/** Read the public parts of a token for display. (The server verifies it; we never trust this.) */
export function readToken(token: string | undefined): TokenInfo {
  if (!token) return {};
  try {
    const body = token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(body + '='.repeat((4 - (body.length % 4)) % 4)), (c) => c.charCodeAt(0));
    const p = JSON.parse(new TextDecoder().decode(bytes));
    return { role: p.role, label: p.label, exp: p.exp, hasPassword: !!p.pw, ...(typeof p.to === 'string' ? { to: p.to } : {}) };
  } catch {
    return {};
  }
}

// Rooms the owner created from the dashboard (kept only in the owner's own browser).
const ADMIN_ROOMS_KEY = 'vchat_admin_rooms';

export interface SavedRoom {
  roomId: string;
  label: string;
  inviteToken: string;
  hostToken: string;
  /**
   * End-to-end room key (generated in this browser). It stays out of every request, with one
   * exception the owner opts into: an emailed invite that includes the key hands it to the server
   * to put in the email.
   */
  key?: string;
  /** Optional schedule, for calendar/email invites. */
  startsAt?: number;
  durationMinutes?: number;
  expiresAt: number;
  approval: boolean;
  hasPassword: boolean;
  createdAt: number;
}

export function getSavedRooms(): SavedRoom[] {
  try {
    const rooms = JSON.parse(local()?.getItem(ADMIN_ROOMS_KEY) ?? '[]') as SavedRoom[];
    return rooms.filter((r) => r.expiresAt > Date.now());
  } catch {
    return [];
  }
}

/** Forget every saved room (host links and keys) in this browser — e.g. on sign-out. */
export function clearSavedRooms(): void {
  local()?.removeItem(ADMIN_ROOMS_KEY);
}

/** Drop expired rooms from storage (not just from the list shown). */
export function pruneSavedRooms(): void {
  if (local()?.getItem(ADMIN_ROOMS_KEY) == null) return; // nothing saved: don't create the entry
  saveRooms(getSavedRooms());
}

export function saveRooms(rooms: SavedRoom[]): void {
  local()?.setItem(ADMIN_ROOMS_KEY, JSON.stringify(rooms.filter((r) => r.expiresAt > Date.now()).slice(0, 50)));
}

/**
 * The token goes after "#": browsers never send that part of a URL to any server (or in the
 * Referer header), so invites can't end up in request logs.
 */
export function inviteUrl(roomId: string, inviteToken: string, key?: string): string {
  const frag = new URLSearchParams({ invite: inviteToken, ...(key ? { k: key } : {}) });
  return `${window.location.origin}/room/${roomId}#${frag.toString()}`;
}

/** Open-mode room link (no invite token; just the end-to-end key). */
export function roomUrl(roomId: string, key?: string): string {
  return `${window.location.origin}/room/${roomId}${key ? `#k=${key}` : ''}`;
}

/** The room's end-to-end key for this tab (from the link's #k=…; a guest's browser never sends it anywhere). */
export function setRoomKey(roomId: string, key: string): void {
  session()?.setItem(`vchat_key_${roomId}`, key);
}

export function getRoomKey(roomId: string): string | undefined {
  return session()?.getItem(`vchat_key_${roomId}`) || undefined;
}

/** Extract { roomId, token } from a pasted invite link (new #invite= or older ?invite= form). */
export function parseInviteLink(link: string): { roomId: string; token: string; key?: string } | null {
  try {
    const url = new URL(link.trim(), window.location.origin);
    const match = url.pathname.match(/^\/room\/([a-z0-9]{1,20})\/?$/i);
    const frag = new URLSearchParams(url.hash.slice(1));
    const token = frag.get('invite');
    const key = frag.get('k') ?? undefined;
    return match && token ? { roomId: match[1].toLowerCase(), token, key } : null;
  } catch {
    return null;
  }
}

// ── Join hand-off from the home page (kept out of the URL so a crafted link can't
//    auto-join someone with their camera on) ───────────────────────────────────────

export interface PendingJoin {
  creator: boolean;
  mode: 'video' | 'audio' | 'chat';
  name: string;
}

export function setPendingJoin(roomId: string, join: PendingJoin): void {
  session()?.setItem(`vchat_join_${roomId}`, JSON.stringify(join));
}

/** Read (once) the choices made on the home page for this room. */
export function takePendingJoin(roomId: string): PendingJoin | null {
  const store = session();
  const raw = store?.getItem(`vchat_join_${roomId}`);
  store?.removeItem(`vchat_join_${roomId}`);
  try {
    const j = raw ? JSON.parse(raw) : null;
    if (!j) return null;
    return {
      creator: j.creator === true,
      mode: j.mode === 'audio' || j.mode === 'chat' ? j.mode : 'video',
      name: typeof j.name === 'string' ? j.name.slice(0, 30) : '',
    };
  } catch {
    return null;
  }
}

/** Leaving (or being removed): forget this call's password, invite and key in this tab. */
export function forgetRoom(roomId: string): void {
  const store = session();
  if (!store) return;
  for (const key of ['vchat_chat_', 'vchat_room_pw_', 'vchat_token_', 'vchat_key_', 'vchat_created_', 'vchat_room_name_', 'vchat_join_']) {
    store.removeItem(key + roomId);
  }
  store.removeItem(`${PEER_ID_KEY}_${roomId}`);
  store.removeItem(`${PEER_SECRET_KEY}_${roomId}`);
  store.removeItem(PENDING_PASSWORD_KEY);
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

/** Hand a chosen room name (open mode) from the home page to the room page. */
export function setPendingRoomName(roomId: string, name: string): void {
  if (name.trim()) session()?.setItem(`vchat_room_name_${roomId}`, name.trim().slice(0, 60));
}

export function takePendingRoomName(roomId: string): string | undefined {
  const store = session();
  const value = store?.getItem(`vchat_room_name_${roomId}`) ?? undefined;
  store?.removeItem(`vchat_room_name_${roomId}`);
  return value || undefined;
}

/** Remember (per tab) a room's password so a refresh/reconnect can reuse it. */
export function rememberRoomPassword(roomId: string, password: string): void {
  session()?.setItem(`vchat_room_pw_${roomId}`, password);
}

export function recallRoomPassword(roomId: string): string | undefined {
  return session()?.getItem(`vchat_room_pw_${roomId}`) || undefined;
}

export function forgetRoomPassword(roomId: string): void {
  session()?.removeItem(`vchat_room_pw_${roomId}`);
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
