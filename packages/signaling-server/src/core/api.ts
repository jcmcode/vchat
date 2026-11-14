// HTTP API shared by every backend, written against the standard Fetch Request/Response types
// (native on Cloudflare Workers and Node 18+).
//
//   GET  /api/config          -> { mode, auth, misconfigured } public
//   GET  /api/ice-servers     -> STUN/TURN config             open mode: public; private: invite/owner only
//   GET  /api/admin/session   -> { authenticated, ... }       public
//   POST /api/admin/login     -> sets owner session cookie    built-in password auth only
//   POST /api/admin/logout
//   POST /api/admin/rooms     -> new room + invite/host links owner only
//
// Modes:
//   open    — nothing configured at all (local dev), or OPEN_MODE=1; anyone can create rooms
//   private — owner signs in (Cloudflare Access or ADMIN_PASSWORD); guests need an invite link
// Anything in between (e.g. SECRET_KEY set but no owner sign-in) is a configuration error: the
// server refuses to run open by accident.

import { verifyAccessJwt } from './access.js';
import { getIceServers, turnTtl, type IceEnv } from './ice.js';
import { isValidRoomId, sliceCodePoints, stripInvisible } from './protocol.js';
import { LoginThrottle, passwordAttempts } from './throttle.js';
import { hashRoomPassword, hmacBase64Url, safeEqual, signToken, verifyToken, type TokenPayload } from './tokens.js';

export interface ServerEnv extends IceEnv {
  /** Random secret (32+ chars) used to sign invites and sessions. Required in private mode. */
  SECRET_KEY?: string;
  /** Built-in owner password (any host). */
  ADMIN_PASSWORD?: string;
  /** Cloudflare Access: team domain, e.g. "myteam.cloudflareaccess.com". */
  CF_ACCESS_TEAM_DOMAIN?: string;
  /** Cloudflare Access: application audience (AUD) tag. */
  CF_ACCESS_AUD?: string;
  /** Open mode only: set to "1" to hand out TURN relay credentials to anyone (off by default). */
  OPEN_MODE_TURN?: string;
  /** Set to "1" to run an open server on purpose (anyone can create rooms). */
  OPEN_MODE?: string;
}

export type AuthMethod = 'access' | 'password';

export interface ServerConfig {
  mode: 'open' | 'private';
  auth: AuthMethod | null;
  /** Set when the server is misconfigured. Operator-facing: never sent to clients. */
  error?: string;
}

/** What anonymous callers learn about the configuration (no error details). */
export interface PublicConfig {
  mode: 'open' | 'private';
  auth: AuthMethod | null;
  misconfigured: boolean;
}

export function publicConfig(config: ServerConfig): PublicConfig {
  return { mode: config.mode, auth: config.auth, misconfigured: !!config.error };
}

export const ADMIN_COOKIE = 'vchat_admin';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_ROOM_TTL_HOURS = 30 * 24;
const DEFAULT_ROOM_TTL_HOURS = 24;
/** Expired invites still get a socket for this long, so the person is told "invite expired". */
const EXPIRED_GRACE_SECONDS = 24 * 60 * 60;

/** Empty values (e.g. `${VAR:-}` in docker-compose) count as unset. */
function isSet(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

export function resolveConfig(env: ServerEnv): ServerConfig {
  const accessWanted = isSet(env.CF_ACCESS_TEAM_DOMAIN) || isSet(env.CF_ACCESS_AUD);
  const passwordWanted = isSet(env.ADMIN_PASSWORD);

  if (!accessWanted && !passwordWanted) {
    // Open mode only when nothing at all is configured (local dev) or the operator opts in.
    // SECRET_KEY or an (empty) owner setting present means a private server was intended: fail
    // closed so a missing or mistyped password never makes it public.
    const untouched = [env.SECRET_KEY, env.ADMIN_PASSWORD, env.CF_ACCESS_TEAM_DOMAIN, env.CF_ACCESS_AUD].every(
      (v) => v === undefined
    );
    if (env.OPEN_MODE === '1' || untouched) return { mode: 'open', auth: null };
    return {
      mode: 'private',
      auth: null,
      error:
        'No owner sign-in configured: set ADMIN_PASSWORD (10+ characters) or CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD. ' +
        'To run an open server on purpose, set OPEN_MODE=1.',
    };
  }

  const auth: AuthMethod = accessWanted ? 'access' : 'password';
  if (accessWanted && !(isSet(env.CF_ACCESS_TEAM_DOMAIN) && isSet(env.CF_ACCESS_AUD))) {
    return { mode: 'private', auth, error: 'Both CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD must be set.' };
  }
  if (!accessWanted && (env.ADMIN_PASSWORD ?? '').length < 10) {
    return { mode: 'private', auth, error: 'ADMIN_PASSWORD must be at least 10 characters.' };
  }
  if (!env.SECRET_KEY || env.SECRET_KEY.length < 32) {
    return {
      mode: 'private',
      auth,
      error: 'SECRET_KEY must be set (at least 32 characters) when owner sign-in is enabled.',
    };
  }
  return { mode: 'private', auth };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(body), { ...init, headers });
}

function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie') ?? '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

function isHttps(request: Request): boolean {
  return (
    new URL(request.url).protocol === 'https:' ||
    request.headers.get('X-Forwarded-Proto')?.split(',')[0].trim() === 'https'
  );
}

function cookie(request: Request, value: string, maxAge: number): string {
  return [
    `${ADMIN_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
    ...(isHttps(request) ? ['Secure'] : []),
  ].join('; ');
}

/** State-changing requests must come from our own pages (blocks cross-site form posts / CSRF). */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return false;
  try {
    const host = request.headers.get('X-Forwarded-Host') ?? request.headers.get('Host') ?? new URL(request.url).host;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get('Content-Type') ?? '').includes('application/json')) return null;
  try {
    const text = await request.text();
    if (text.length > 4096) return null;
    const body = JSON.parse(text);
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const ROOM_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function generateRoomId(length = 10): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => ROOM_ALPHABET[b % ROOM_ALPHABET.length]).join('');
}

// Owner sign-in throttling (per process/isolate): 10 attempts per client (IPv4 address or IPv6 /64)
// per 15 minutes. Across all clients, after 100 attempts in the window further checks are spaced 2s
// apart (and refused if the queue is over 10s): a distributed guesser is slowed to a crawl, but the
// owner is never locked out for the whole window. Attempts are counted *before* the password is
// checked, so parallel bursts can't slip through, and refunded on success. (On Cloudflare this is
// per isolate — Cloudflare Access is the stronger option there.)
const loginThrottle = new LoginThrottle({
  windowMs: 15 * 60 * 1000,
  perClient: 10,
  globalSoft: 100,
  spacingMs: 2000,
  maxWaitMs: 10_000,
});

/** Ties owner sessions to the current ADMIN_PASSWORD: changing the password signs everyone out. */
async function passwordVersion(env: ServerEnv): Promise<string> {
  return (await hmacBase64Url(env.SECRET_KEY!, `admin-session:${env.ADMIN_PASSWORD ?? ''}`)).slice(0, 22);
}

// Cloudflare TURN API responses are cached briefly per role:room so a token holder can't hammer the
// provider's API. coturn REST credentials are minted locally and never cached (each response gets
// its own username). Keys never contain tokens.
const ICE_CACHE_MS = 10 * 60 * 1000;
const iceCache = new Map<string, { at: number; expiresAt: number; body: { iceServers: unknown[]; ttl?: number } }>();

async function iceServersFor(key: string, env: IceEnv, expiresAt: number | undefined): Promise<unknown> {
  if (!(env.CF_TURN_KEY_ID && env.CF_TURN_API_TOKEN)) return getIceServers(env, { expiresAt });
  const now = Date.now();
  const hit = iceCache.get(key);
  // Hand out a cached set only while it still has most of its life left.
  if (hit && now - hit.at < ICE_CACHE_MS && hit.expiresAt - now > ICE_CACHE_MS) {
    return { ...hit.body, ttl: Math.floor((hit.expiresAt - now) / 1000) };
  }
  const body = await getIceServers(env, { expiresAt, now });
  const ttl = body.ttl ?? turnTtl(env, { expiresAt, now });
  for (const [k, v] of iceCache) if (now - v.at >= ICE_CACHE_MS) iceCache.delete(k); // sweep
  iceCache.set(key, { at: now, expiresAt: now + ttl * 1000, body });
  while (iceCache.size > 1000) iceCache.delete(iceCache.keys().next().value!);
  return body;
}

/** Drop expired throttle and cache entries (the Node server calls this periodically). */
export function sweepApiState(now = Date.now()): void {
  loginThrottle.sweep(now);
  passwordAttempts.sweep(now);
  for (const [k, v] of iceCache) if (now - v.at >= ICE_CACHE_MS) iceCache.delete(k);
}

// ── Authorization ──────────────────────────────────────────────────────────

export interface AdminIdentity {
  method: AuthMethod;
  email?: string;
}

export async function getAdmin(request: Request, env: ServerEnv, config = resolveConfig(env)): Promise<AdminIdentity | null> {
  if (config.error) return null;
  if (config.auth === 'access') {
    const jwt = request.headers.get('Cf-Access-Jwt-Assertion') ?? getCookie(request, 'CF_Authorization');
    try {
      const identity = await verifyAccessJwt(jwt, { teamDomain: env.CF_ACCESS_TEAM_DOMAIN!, audience: env.CF_ACCESS_AUD! });
      return identity ? { method: 'access', email: identity.email } : null;
    } catch (err) {
      console.error('Cloudflare Access verification failed:', err);
      return null;
    }
  }
  if (config.auth === 'password') {
    const session = getCookie(request, ADMIN_COOKIE);
    if (!session) return null;
    const result = await verifyToken(env.SECRET_KEY!, session);
    if (!result.ok || result.payload.role !== 'admin') return null;
    return result.payload.pv === (await passwordVersion(env)) ? { method: 'password' } : null;
  }
  return null;
}

export interface JoinGrant {
  role: 'host' | 'guest';
  /** Guests must wait for the host's approval. */
  approval: boolean;
  label?: string;
}

export type JoinDecision =
  | { ok: true; grant: JoinGrant }
  /** fatal: the invite itself is no good — the backend closes the socket (code 4003). */
  | { ok: false; error: string; fatal?: boolean }
  | { ok: false; passwordRequired: true; invalid: boolean };

/** Close code for a socket whose invite is invalid or expired. Clients must not reconnect. */
export const CLOSE_INVALID_INVITE = 4003;

/**
 * Private mode: check the invite/host token (and room password) presented when joining.
 * `clientId` (an IP or a keyed hash of it) scopes room-password guess throttling.
 */
export async function authorizeJoin(
  env: ServerEnv,
  msg: { roomId: string; token?: string; password?: string },
  opts: { clientId?: string } = {}
): Promise<JoinDecision> {
  const config = resolveConfig(env);
  if (config.error) return { ok: false, error: 'Server misconfigured', fatal: true };
  if (!msg.token) return { ok: false, error: 'Invite required' };

  const result = await verifyToken(env.SECRET_KEY!, msg.token);
  if (!result.ok) return { ok: false, error: result.reason === 'expired' ? 'Invite expired' : 'Invalid invite', fatal: true };
  const p: TokenPayload = result.payload;
  if ((p.role !== 'host' && p.role !== 'guest') || p.room !== msg.roomId) return { ok: false, error: 'Invalid invite', fatal: true };

  if (p.role === 'guest' && p.pw) {
    if (!msg.password) return { ok: false, passwordRequired: true, invalid: false };
    // Online guessing limit per room + client, with a per-room backstop (the keyed hash already
    // prevents offline guessing).
    if (!passwordAttempts.take(msg.roomId, opts.clientId)) {
      return { ok: false, error: 'Too many password attempts' };
    }
    const attempt = await hashRoomPassword(env.SECRET_KEY!, msg.roomId, msg.password);
    if (!safeEqual(attempt, p.pw)) return { ok: false, passwordRequired: true, invalid: true };
    passwordAttempts.refund(msg.roomId, opts.clientId);
  }
  return { ok: true, grant: { role: p.role, approval: p.role === 'guest' && !!p.approval, label: p.label } };
}

// ── WebSocket gate ───────────────────────────────────────────────────────────
// Browsers send the invite/host token as a WebSocket subprotocol ("vchat.t.<token>") next to the
// protocol name "vchat.v1". Unlike a URL parameter, that never ends up in request logs. In private
// mode the token is checked before a socket (or a Cloudflare Durable Object) is ever created.

export const WS_PROTOCOL = 'vchat.v1';
export const WS_TOKEN_PREFIX = 'vchat.t.';

export function parseWsProtocols(header: string | null | undefined): { protocols: string[]; token?: string } {
  const protocols = (header ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const tokenEntry = protocols.find((p) => p.startsWith(WS_TOKEN_PREFIX));
  return { protocols, token: tokenEntry?.slice(WS_TOKEN_PREFIX.length) };
}

/** May this WebSocket upgrade for `roomId` proceed? (Only private mode checks anything.) */
export async function authorizeSocket(env: ServerEnv, roomId: string, protocolHeader: string | null | undefined): Promise<boolean> {
  const config = resolveConfig(env);
  if (config.mode === 'open') return true;
  if (config.error) return false;
  const { token } = parseWsProtocols(protocolHeader);
  if (!token) return false;
  // Recently expired but genuine invites get through here so the person sees "invite expired" when
  // joining (the socket is then closed). Long-dead ones are refused outright.
  const result = await verifyToken(env.SECRET_KEY!, token, Date.now(), { allowExpiredSeconds: EXPIRED_GRACE_SECONDS });
  return result.ok && (result.payload.role === 'host' || result.payload.role === 'guest') && result.payload.room === roomId;
}

// ── Router ─────────────────────────────────────────────────────────────────

export interface ApiOptions {
  /** Client IP for login throttling (IPv6 is grouped by /64). */
  clientIp?: string;
}

/** Handles /api/* requests. Returns null for any other path. */
export async function handleApi(request: Request, env: ServerEnv, opts: ApiOptions = {}): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return null;
  const config = resolveConfig(env);
  const route = `${request.method} ${url.pathname}`;

  switch (route) {
    case 'GET /api/config':
      return json(publicConfig(config));

    case 'GET /api/ice-servers': {
      let cacheKey = `open:${env.OPEN_MODE_TURN === '1'}`;
      let iceEnv: IceEnv = env;
      let expiresAt: number | undefined;
      if (config.mode === 'private') {
        // TURN relays cost money and can be abused: only invited guests and the owner get credentials.
        const token = request.headers.get('X-Vchat-Token');
        const verified = token && !config.error ? await verifyToken(env.SECRET_KEY!, token) : null;
        const p = verified?.ok ? verified.payload : null;
        if (p && (p.role === 'host' || p.role === 'guest') && p.room) {
          cacheKey = `${p.role}:${p.room}:${p.exp}`;
          expiresAt = p.exp; // credentials never outlive the invite
        } else if (await getAdmin(request, env, config)) {
          cacheKey = 'admin';
        } else {
          return json({ error: 'Invite required' }, { status: 401 });
        }
      } else if (env.OPEN_MODE_TURN !== '1') {
        // Open mode: anyone can reach this endpoint, so never hand out relay credentials by default.
        iceEnv = { STUN_URLS: env.STUN_URLS };
      }
      try {
        return json(await iceServersFor(cacheKey, iceEnv, expiresAt));
      } catch (err) {
        console.error('Failed to build ICE servers:', err instanceof Error ? err.message : 'unknown error');
        return json({ error: 'TURN unavailable' }, { status: 502 });
      }
    }

    case 'GET /api/admin/session': {
      const admin = await getAdmin(request, env, config);
      return json({ ...publicConfig(config), authenticated: !!admin, email: admin?.email ?? null });
    }

    case 'POST /api/admin/login': {
      if (config.auth !== 'password' || config.error) return json({ error: 'Password sign-in is not enabled' }, { status: 404 });
      if (!sameOrigin(request)) return json({ error: 'Bad origin' }, { status: 403 });
      if (!(await loginThrottle.acquire(opts.clientIp))) {
        return json({ error: 'Too many attempts. Try again later.' }, { status: 429, headers: { 'Retry-After': '60' } });
      }
      const body = await readJson(request);
      const password = typeof body?.password === 'string' ? body.password : '';
      if (!password || !safeEqual(password, env.ADMIN_PASSWORD!)) {
        await new Promise((r) => setTimeout(r, 500)); // slow down guessing
        return json({ error: 'Wrong password' }, { status: 401 });
      }
      loginThrottle.succeeded(opts.clientIp);
      const session = await signToken(env.SECRET_KEY!, {
        role: 'admin',
        exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
        pv: await passwordVersion(env),
      });
      return json({ ok: true }, { headers: { 'Set-Cookie': cookie(request, session, SESSION_TTL_SECONDS) } });
    }

    case 'POST /api/admin/logout':
      if (!sameOrigin(request)) return json({ error: 'Bad origin' }, { status: 403 });
      return json({ ok: true }, { headers: { 'Set-Cookie': cookie(request, '', 0) } });

    case 'POST /api/admin/rooms': {
      if (!sameOrigin(request)) return json({ error: 'Bad origin' }, { status: 403 });
      if (!(await getAdmin(request, env, config))) return json({ error: 'Not signed in' }, { status: 401 });
      const body = (await readJson(request)) ?? {};
      const label = typeof body.label === 'string' ? sliceCodePoints(stripInvisible(body.label).trim(), 60) : '';
      const password = typeof body.password === 'string' ? body.password.slice(0, 256) : '';
      const approval = body.approval !== false;
      const hours = Math.min(Math.max(Number(body.expiresInHours) || DEFAULT_ROOM_TTL_HOURS, 1), MAX_ROOM_TTL_HOURS);

      const roomId = typeof body.roomId === 'string' && isValidRoomId(body.roomId) ? body.roomId : generateRoomId();
      const exp = Math.floor(Date.now() / 1000) + Math.round(hours * 3600);
      const secret = env.SECRET_KEY!;
      const [inviteToken, hostToken] = await Promise.all([
        signToken(secret, {
          role: 'guest',
          room: roomId,
          exp,
          approval,
          ...(label ? { label } : {}),
          ...(password ? { pw: await hashRoomPassword(secret, roomId, password) } : {}),
        }),
        signToken(secret, { role: 'host', room: roomId, exp, ...(label ? { label } : {}) }),
      ]);
      return json({ roomId, label, inviteToken, hostToken, expiresAt: exp * 1000, approval, hasPassword: !!password });
    }

    default:
      return json({ error: 'Not found' }, { status: 404 });
  }
}
