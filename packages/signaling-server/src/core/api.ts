// HTTP API shared by every backend, written against the standard Fetch Request/Response types
// (native on Cloudflare Workers and Node 18+).
//
//   GET  /api/config                    -> { mode, auth, misconfigured, emailInvites }   public
//   GET  /api/ice-servers               -> STUN/TURN config     open mode: public; private: invite/owner only
//   GET  /api/admin/session             -> { authenticated, ... }                        public
//   POST /api/admin/login               -> sets owner session cookie        password sign-in only
//   POST /api/admin/login/code          -> { challenge }; emails a code      email sign-in only
//   POST /api/admin/login/verify        -> sets owner session cookie        email sign-in only
//   POST /api/admin/logout
//   POST /api/admin/rooms               -> new room + invite/host links     owner only
//   POST /api/admin/rooms/email-invite  -> emails a per-guest invite + code owner only, Resend configured
//
// Modes:
//   open    — nothing configured at all (local dev), or OPEN_MODE=1; anyone can create rooms
//   private — owner signs in (Cloudflare Access, emailed code, or ADMIN_PASSWORD); guests need an
//             invite link
// Anything in between (e.g. SECRET_KEY set but no owner sign-in) is a configuration error: the
// server refuses to run open by accident.

import { verifyAccessJwt } from './access.js';
import { inviteEmail, isCode, isValidSender, loginCodeEmail, normalizeEmail, randomCode, sendEmail } from './email.js';
import { getIceServers, turnTtl, type IceEnv } from './ice.js';
import { isValidRoomId, sliceCodePoints, stripInvisible } from './protocol.js';
import { AttemptCounter, ipKey, LoginThrottle, passwordAttempts } from './throttle.js';
import {
  base64UrlEncode,
  hashRoomPassword,
  hmacBase64Url,
  safeEqual,
  signToken,
  verifyToken,
  type TokenPayload,
} from './tokens.js';

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
  /** The owner's email address: enables sign-in with an emailed code (needs Resend). */
  OWNER_EMAIL?: string;
  /** Resend API key (sending access only). With EMAIL_FROM, enables emailed invites. */
  RESEND_API_KEY?: string;
  /** Sender, e.g. `vchat <invites@example.com>` (a domain verified in Resend). */
  EMAIL_FROM?: string;
}

export type AuthMethod = 'access' | 'email' | 'password';

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
  /** The owner can email invites (private mode, no error, Resend configured). */
  emailInvites: boolean;
}

export function publicConfig(config: ServerConfig, env: ServerEnv): PublicConfig {
  return {
    mode: config.mode,
    auth: config.auth,
    misconfigured: !!config.error,
    emailInvites: config.mode === 'private' && !config.error && resendConfigured(env),
  };
}

function resendConfigured(env: ServerEnv): boolean {
  return isSet(env.RESEND_API_KEY) && isSet(env.EMAIL_FROM);
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
  const emailWanted = isSet(env.OWNER_EMAIL);
  const passwordWanted = isSet(env.ADMIN_PASSWORD);

  if (!accessWanted && !emailWanted && !passwordWanted) {
    // Open mode only when nothing at all is configured (local dev) or the operator opts in.
    // SECRET_KEY or an (empty) owner setting present means a private server was intended: fail
    // closed so a missing or mistyped password never makes it public.
    const untouched = [env.SECRET_KEY, env.ADMIN_PASSWORD, env.OWNER_EMAIL, env.CF_ACCESS_TEAM_DOMAIN, env.CF_ACCESS_AUD].every(
      (v) => v === undefined
    );
    if (env.OPEN_MODE === '1' || untouched) return { mode: 'open', auth: null };
    return {
      mode: 'private',
      auth: null,
      error:
        'No owner sign-in configured: set OWNER_EMAIL (+ Resend), ADMIN_PASSWORD (10+ characters) or ' +
        'CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD. To run an open server on purpose, set OPEN_MODE=1.',
    };
  }

  // Precedence when several are set: Cloudflare Access > emailed code > password.
  const auth: AuthMethod = accessWanted ? 'access' : emailWanted ? 'email' : 'password';
  const fail = (error: string): ServerConfig => ({ mode: 'private', auth, error });

  if (accessWanted && !(isSet(env.CF_ACCESS_TEAM_DOMAIN) && isSet(env.CF_ACCESS_AUD))) {
    return fail('Both CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD must be set.');
  }
  // Resend: both values or neither, and a well-formed sender.
  if (isSet(env.RESEND_API_KEY) !== isSet(env.EMAIL_FROM)) {
    return fail('Set both RESEND_API_KEY and EMAIL_FROM to send email (or neither).');
  }
  if (isSet(env.EMAIL_FROM) && !isValidSender(env.EMAIL_FROM)) {
    return fail('EMAIL_FROM must look like "you@example.com" or "Name <you@example.com>".');
  }
  if (emailWanted && !normalizeEmail(env.OWNER_EMAIL)) {
    return fail('OWNER_EMAIL is not a valid email address.');
  }
  if (auth === 'email' && !resendConfigured(env)) {
    return fail('OWNER_EMAIL needs RESEND_API_KEY and EMAIL_FROM to send sign-in codes.');
  }
  if (auth === 'password' && (env.ADMIN_PASSWORD ?? '').length < 10) {
    return fail('ADMIN_PASSWORD must be at least 10 characters.');
  }
  if (!env.SECRET_KEY || env.SECRET_KEY.length < 32) {
    return fail('SECRET_KEY must be set (at least 32 characters) when owner sign-in is enabled.');
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

const MAX_JSON_BODY_BYTES = 4096;

/** Read a request body, giving up as soon as it exceeds `max` bytes (never buffering more). */
async function readLimitedText(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get('Content-Length') ?? '');
  if (declared > max) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get('Content-Type') ?? '').includes('application/json')) return null;
  try {
    const text = await readLimitedText(request, MAX_JSON_BODY_BYTES);
    if (text === null) return null;
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

/**
 * Ties owner sessions to the current credential: changing ADMIN_PASSWORD (password sign-in) or
 * OWNER_EMAIL (email sign-in) signs everyone out, and a session from one method isn't valid in the other.
 */
async function sessionVersion(env: ServerEnv, auth: AuthMethod): Promise<string> {
  const input = auth === 'email' ? `admin-session:email:${normalizeEmail(env.OWNER_EMAIL) ?? ''}` : `admin-session:${env.ADMIN_PASSWORD ?? ''}`;
  return (await hmacBase64Url(env.SECRET_KEY!, input)).slice(0, 22);
}

async function sessionCookie(request: Request, env: ServerEnv, auth: AuthMethod): Promise<string> {
  const session = await signToken(env.SECRET_KEY!, {
    role: 'admin',
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    pv: await sessionVersion(env, auth),
  });
  return cookie(request, session, SESSION_TTL_SECONDS);
}

// ── Email sign-in and invite state (in memory, best effort, nothing persisted) ────────────────
const LOGIN_CODE_TTL_SECONDS = 10 * 60;
const CODE_WINDOW_MS = 15 * 60 * 1000;
/** Code requests per requested address per window (same for every address: no enumeration). */
const CODE_REQUESTS_PER_EMAIL = 5;
/** Sign-in codes actually emailed per window, in total (can't mailbomb the owner). */
const CODES_SENT_PER_WINDOW = 5;
const VERIFY_ATTEMPTS_PER_CHALLENGE = 5;
const INVITE_WINDOW_MS = 60 * 60 * 1000;
const INVITES_PER_WINDOW = 30;

const codeRequests = new AttemptCounter(CODE_WINDOW_MS);
let codesSent: number[] = [];
let invitesSent: number[] = [];
/** Login challenge nonce -> attempts, and whether it was already used. Dropped after expiry. */
const challengeState = new Map<string, { attempts: number; used: boolean; exp: number }>();

function underCap(list: number[], windowMs: number, max: number, now: number): { list: number[]; ok: boolean; retryAfter: number } {
  const recent = list.filter((t) => now - t < windowMs);
  const retryAfter = recent.length ? Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000)) : 1;
  return { list: recent, ok: recent.length < max, retryAfter };
}

function randomB64(bytes: number): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

function loginCodeMac(env: ServerEnv, nonce: string, code: string): Promise<string> {
  // Also bound to the owner address, so changing OWNER_EMAIL voids outstanding codes.
  return hmacBase64Url(env.SECRET_KEY!, `login-code:${nonce}:${normalizeEmail(env.OWNER_EMAIL) ?? ''}:${code}`);
}

function sweepChallenges(now: number): void {
  for (const [n, st] of challengeState) if (st.exp * 1000 <= now) challengeState.delete(n);
  while (challengeState.size > 10_000) challengeState.delete(challengeState.keys().next().value!);
}

const E2E_KEY_RE = /^[A-Za-z0-9_-]{43}$/;

// Cloudflare TURN API responses are cached briefly per role:room so a token holder can't hammer the
// provider's API. coturn REST credentials are minted locally and never cached (each response gets
// its own username). Keys never contain tokens.
const ICE_CACHE_MS = 10 * 60 * 1000;
// Relay credentials per client (IPv4 address or IPv6 /64) per window. A call asks once on joining
// and again shortly before they expire; several people can share an address. Anything beyond that
// is someone farming credentials from one invite.
const ICE_REQUEST_WINDOW_MS = 10 * 60 * 1000;
const ICE_REQUESTS_PER_CLIENT = 40;
const iceRequests = new AttemptCounter(ICE_REQUEST_WINDOW_MS);
const iceCache = new Map<string, { at: number; expiresAt: number; body: { iceServers: unknown[]; ttl?: number } }>();

async function iceServersFor(key: string, env: IceEnv, expiresAt: number | undefined, userId?: string): Promise<unknown> {
  if (!(env.CF_TURN_KEY_ID && env.CF_TURN_API_TOKEN)) return getIceServers(env, { expiresAt, userId });
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
  codeRequests.sweep(now);
  iceRequests.sweep(now);
  codesSent = codesSent.filter((t) => now - t < CODE_WINDOW_MS);
  invitesSent = invitesSent.filter((t) => now - t < INVITE_WINDOW_MS);
  sweepChallenges(now);
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
  if (config.auth === 'password' || config.auth === 'email') {
    const session = getCookie(request, ADMIN_COOKIE);
    if (!session) return null;
    const result = await verifyToken(env.SECRET_KEY!, session);
    if (!result.ok || result.payload.role !== 'admin') return null;
    if (result.payload.pv !== (await sessionVersion(env, config.auth))) return null;
    return config.auth === 'email' ? { method: 'email', email: normalizeEmail(env.OWNER_EMAIL)! } : { method: 'password' };
  }
  return null;
}

export interface JoinGrant {
  role: 'host' | 'guest';
  /** Guests must wait for the host's approval. */
  approval: boolean;
  label?: string;
  /** Emailed invites: the address it was sent to (shown to the host in admission-request). */
  email?: string;
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
  const email = p.role === 'guest' ? normalizeEmail(p.to) : null;
  return {
    ok: true,
    grant: { role: p.role, approval: p.role === 'guest' && !!p.approval, label: p.label, ...(email ? { email } : {}) },
  };
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

/**
 * Who a WebSocket upgrade for `roomId` belongs to: the token's role in private mode, 'open' in open
 * mode, or null if it may not proceed.
 */
export async function socketRole(
  env: ServerEnv,
  roomId: string,
  protocolHeader: string | null | undefined
): Promise<'host' | 'guest' | 'open' | null> {
  const config = resolveConfig(env);
  if (config.mode === 'open') return 'open';
  if (config.error) return null;
  const { token } = parseWsProtocols(protocolHeader);
  if (!token) return null;
  // Recently expired but genuine invites get through here so the person sees "invite expired" when
  // joining (the socket is then closed). Long-dead ones are refused outright.
  const result = await verifyToken(env.SECRET_KEY!, token, Date.now(), { allowExpiredSeconds: EXPIRED_GRACE_SECONDS });
  if (!result.ok || result.payload.room !== roomId) return null;
  return result.payload.role === 'host' || result.payload.role === 'guest' ? result.payload.role : null;
}

/** May this WebSocket upgrade for `roomId` proceed? (Only private mode checks anything.) */
export async function authorizeSocket(env: ServerEnv, roomId: string, protocolHeader: string | null | undefined): Promise<boolean> {
  return (await socketRole(env, roomId, protocolHeader)) !== null;
}

// ── Router ─────────────────────────────────────────────────────────────────

export interface ApiOptions {
  /** Client IP for login throttling (IPv6 is grouped by /64). */
  clientIp?: string;
  /**
   * Keep background work (sending a sign-in code) alive after the response, e.g. Cloudflare's
   * ctx.waitUntil. Without it the promise just runs on (fine on Node).
   */
  waitUntil?: (promise: Promise<unknown>) => void;
}

/** Handles /api/* requests. Returns null for any other path. */
export async function handleApi(request: Request, env: ServerEnv, opts: ApiOptions = {}): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return null;
  const config = resolveConfig(env);
  const route = `${request.method} ${url.pathname}`;

  switch (route) {
    case 'GET /api/config':
      return json(publicConfig(config, env));

    case 'GET /api/ice-servers': {
      let cacheKey = `open:${env.OPEN_MODE_TURN === '1'}`;
      let iceEnv: IceEnv = env;
      let expiresAt: number | undefined;
      let userId: string | undefined;
      if (config.mode === 'private') {
        // TURN relays cost money and can be abused: only invited guests and the owner get credentials.
        const token = request.headers.get('X-Vchat-Token');
        const verified = token && !config.error ? await verifyToken(env.SECRET_KEY!, token) : null;
        const p = verified?.ok ? verified.payload : null;
        if (p && (p.role === 'host' || p.role === 'guest') && p.room) {
          cacheKey = `${p.role}:${p.room}:${p.exp}`;
          expiresAt = p.exp; // credentials never outlive the invite
          // One relay identity per room and client, so the relay's per-user quota can't be reset
          // by asking again. (A keyed hash: the relay never sees the address or the room.)
          userId = (await hmacBase64Url(env.SECRET_KEY!, `turn-user:${p.room}:${ipKey(opts.clientIp)}`)).slice(0, 16);
        } else if (await getAdmin(request, env, config)) {
          cacheKey = 'admin';
        } else {
          return json({ error: 'Invite required' }, { status: 401 });
        }
      } else if (env.OPEN_MODE_TURN !== '1') {
        // Open mode: anyone can reach this endpoint, so never hand out relay credentials by default.
        iceEnv = { STUN_URLS: env.STUN_URLS };
      }
      // Only where relay credentials are actually handed out (open mode without TURN gets STUN only).
      if (iceEnv === env && !iceRequests.take(ipKey(opts.clientIp), ICE_REQUESTS_PER_CLIENT)) {
        return json({ error: 'Too many requests. Try again later.' }, { status: 429, headers: { 'Retry-After': '60' } });
      }
      try {
        return json(await iceServersFor(cacheKey, iceEnv, expiresAt, userId));
      } catch (err) {
        console.error('Failed to build ICE servers:', err instanceof Error ? err.message : 'unknown error');
        return json({ error: 'TURN unavailable' }, { status: 502 });
      }
    }

    case 'GET /api/admin/session': {
      const admin = await getAdmin(request, env, config);
      return json({ ...publicConfig(config, env), authenticated: !!admin, email: admin?.email ?? null });
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
      return json({ ok: true }, { headers: { 'Set-Cookie': await sessionCookie(request, env, 'password') } });
    }

    case 'POST /api/admin/login/code': {
      if (config.auth !== 'email' || config.error) return json({ error: 'Email sign-in is not enabled' }, { status: 404 });
      if (!sameOrigin(request)) return json({ error: 'Bad origin' }, { status: 403 });
      if (!(await loginThrottle.acquire(opts.clientIp))) {
        return json({ error: 'Too many attempts. Try again later.' }, { status: 429, headers: { 'Retry-After': '60' } });
      }
      const body = await readJson(request);
      const email = normalizeEmail(body?.email);
      if (!email) return json({ error: 'Enter a valid email address' }, { status: 400 });
      const now = Date.now();
      const isOwner = email === normalizeEmail(env.OWNER_EMAIL);

      // Caps that answer the same way for every address, so the response never reveals which one is
      // the owner's: per requested address, and (since only the owner is ever emailed) on codes sent.
      const emailKey = (await hmacBase64Url(env.SECRET_KEY!, `code-request:${email}`)).slice(0, 22);
      const sentCap = underCap(codesSent, CODE_WINDOW_MS, CODES_SENT_PER_WINDOW, now);
      codesSent = sentCap.list;
      if (!codeRequests.take(emailKey, CODE_REQUESTS_PER_EMAIL, now) || (isOwner && !sentCap.ok)) {
        // Fixed Retry-After: a computed one could tell the owner's address apart.
        return json({ error: 'Too many codes requested. Try again later.' }, { status: 429, headers: { 'Retry-After': '300' } });
      }

      const nonce = randomB64(16);
      let mac = randomB64(32); // nothing is sent for other addresses: this challenge can never verify
      if (isOwner) {
        const code = randomCode();
        mac = await loginCodeMac(env, nonce, code);
        codesSent.push(now);
        // Sent in the background so the response takes the same time whoever asked.
        const sending = sendEmail(env, loginCodeEmail(email, code)).catch((err: unknown) =>
          console.error('Sign-in code email failed:', err instanceof Error ? err.message : 'unknown error')
        );
        opts.waitUntil?.(sending);
      }
      const challenge = await signToken(env.SECRET_KEY!, {
        role: 'login',
        exp: Math.floor(now / 1000) + LOGIN_CODE_TTL_SECONDS,
        n: nonce,
        c: mac,
      });
      return json({ challenge });
    }

    case 'POST /api/admin/login/verify': {
      if (config.auth !== 'email' || config.error) return json({ error: 'Email sign-in is not enabled' }, { status: 404 });
      if (!sameOrigin(request)) return json({ error: 'Bad origin' }, { status: 403 });
      if (!(await loginThrottle.acquire(opts.clientIp))) {
        return json({ error: 'Too many attempts. Try again later.' }, { status: 429, headers: { 'Retry-After': '60' } });
      }
      const wrong = () => json({ error: 'Wrong or expired code' }, { status: 401 });
      const body = await readJson(request);
      const challenge = typeof body?.challenge === 'string' ? body.challenge : '';
      const code = body?.code;
      const result = challenge ? await verifyToken(env.SECRET_KEY!, challenge) : null;
      const p = result?.ok ? result.payload : null;
      if (!p || p.role !== 'login' || typeof p.n !== 'string' || typeof p.c !== 'string') return wrong();

      const now = Date.now();
      sweepChallenges(now);
      const state = challengeState.get(p.n) ?? { attempts: 0, used: false, exp: p.exp };
      if (state.used || state.attempts >= VERIFY_ATTEMPTS_PER_CHALLENGE) return wrong();
      state.attempts++;
      challengeState.set(p.n, state);
      if (!isCode(code) || !safeEqual(await loginCodeMac(env, p.n, code), p.c)) return wrong();

      state.used = true; // single use (remembered until the challenge expires)
      loginThrottle.succeeded(opts.clientIp);
      return json({ ok: true }, { headers: { 'Set-Cookie': await sessionCookie(request, env, 'email') } });
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

    case 'POST /api/admin/rooms/email-invite': {
      if (!sameOrigin(request)) return json({ error: 'Bad origin' }, { status: 403 });
      if (!(await getAdmin(request, env, config))) return json({ error: 'Not signed in' }, { status: 401 });
      if (!publicConfig(config, env).emailInvites) return json({ error: 'Email is not configured on this server' }, { status: 503 });

      const body = await readJson(request);
      const email = normalizeEmail(body?.email);
      const roomId = body?.roomId;
      const inviteToken = body?.inviteToken;
      if (!body || !email || !isValidRoomId(roomId) || typeof inviteToken !== 'string') {
        return json({ error: 'Enter a valid email address' }, { status: 400 });
      }
      const key = typeof body.key === 'string' && E2E_KEY_RE.test(body.key) ? body.key : null;
      const source = await verifyToken(env.SECRET_KEY!, inviteToken);
      const p = source.ok ? source.payload : null;
      if (!p || p.role !== 'guest' || p.room !== roomId) return json({ error: 'Invalid or expired invite' }, { status: 400 });

      const now = Date.now();
      const cap = underCap(invitesSent, INVITE_WINDOW_MS, INVITES_PER_WINDOW, now);
      invitesSent = cap.list;
      if (!cap.ok) {
        return json({ error: 'Too many invites sent. Try again later.' }, { status: 429, headers: { 'Retry-After': String(cap.retryAfter) } });
      }

      // A fresh token for this person: same room, expiry, approval and label; their own code as the
      // password (replacing any room password); and who it was sent to, for the host to see.
      const code = randomCode();
      const secret = env.SECRET_KEY!;
      const token = await signToken(secret, {
        role: 'guest',
        room: roomId,
        exp: p.exp,
        approval: !!p.approval,
        ...(p.label ? { label: p.label } : {}),
        pw: await hashRoomPassword(secret, roomId, code),
        to: email,
      });
      const origin = new URL(request.headers.get('Origin')!).origin;
      const link = `${origin}/room/${roomId}#invite=${token}${key ? `&k=${key}` : ''}`;

      invitesSent.push(now);
      try {
        await sendEmail(env, inviteEmail(email, { link, code, label: p.label, exp: p.exp }));
      } catch (err) {
        invitesSent.pop();
        console.error('Invite email failed:', err instanceof Error ? err.message : 'unknown error');
        return json({ error: 'Could not send the email. Try again later.' }, { status: 502 });
      }
      return json({ ok: true, expiresAt: p.exp * 1000 });
    }

    default:
      return json({ error: 'Not found' }, { status: 404 });
  }
}
