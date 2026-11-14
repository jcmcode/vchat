// Stateless signed tokens (HMAC-SHA256 with the server's SECRET_KEY).
//
//   invite token  -> lets a guest into one room until it expires
//   host token    -> lets the owner into one room as host
//   admin session -> owner is signed in (cookie; password or email sign-in)
//   login challenge -> pending email sign-in: binds a nonce to the emailed code (10 minutes)
//
// Nothing about rooms or invites is stored server-side: the token *is* the permission.
// Format: base64url(JSON payload) + "." + base64url(signature)

export type TokenRole = 'host' | 'guest' | 'admin' | 'login';

export interface TokenPayload {
  v: 1;
  role: TokenRole;
  /** Unix seconds. */
  exp: number;
  /** Room id (host/guest tokens). */
  room?: string;
  /** Guests must be approved by the host. */
  approval?: boolean;
  /** Keyed hash of the room password, if the room has one (see hashRoomPassword). */
  pw?: string;
  /** Display label for the room (shown on the join screen). */
  label?: string;
  /** Admin sessions: version of the owner credential (password or email) they were issued under. */
  pv?: string;
  /** Emailed invites: the (normalized) address it was sent to. Shown to the host on admission. */
  to?: string;
  /** Login challenges: random nonce. */
  n?: string;
  /** Login challenges: HMAC of the nonce and the emailed code (random when nothing was sent). */
  c?: string;
}

const encoder = new TextEncoder();

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Strict base64url decoding: only the URL-safe alphabet, no padding, and the input must be the
 * canonical encoding of its bytes (no stray trailing bits). Tokens therefore have exactly one
 * spelling and can't be altered without breaking them. Throws on anything else.
 */
export function base64UrlDecode(input: string): Uint8Array<ArrayBuffer> {
  if (typeof input !== 'string' || !BASE64URL_RE.test(input) || input.length % 4 === 1) {
    throw new Error('Invalid base64url');
  }
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  if (base64UrlEncode(bytes) !== input) throw new Error('Non-canonical base64url');
  return bytes;
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret);
  if (!key) {
    if (keyCache.size > 16) keyCache.clear(); // only ever a handful of secrets in practice
    key = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
      'verify',
    ]);
    keyCache.set(secret, key);
  }
  return key;
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(message));
  return new Uint8Array(sig);
}

/** HMAC-SHA256(secret, message) as base64url. */
export async function hmacBase64Url(secret: string, message: string): Promise<string> {
  return base64UrlEncode(await hmac(secret, message));
}

/** Constant-time comparison of two strings. */
export function safeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < Math.max(ab.length, bb.length); i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

export async function signToken(secret: string, payload: Omit<TokenPayload, 'v'>): Promise<string> {
  const body = base64UrlEncode(encoder.encode(JSON.stringify({ v: 1, ...payload })));
  const sig = base64UrlEncode(await hmac(secret, body));
  return `${body}.${sig}`;
}

export type VerifyResult = { ok: true; payload: TokenPayload } | { ok: false; reason: 'invalid' | 'expired' };

export async function verifyToken(
  secret: string,
  token: string,
  now = Date.now(),
  /** Accept a genuine token up to this many seconds past its expiry (default 0). */
  opts: { allowExpiredSeconds?: number } = {}
): Promise<VerifyResult> {
  if (typeof token !== 'string' || token.length > 2048) return { ok: false, reason: 'invalid' };
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return { ok: false, reason: 'invalid' };
  let valid = false;
  try {
    valid = await crypto.subtle.verify('HMAC', await hmacKey(secret), base64UrlDecode(sig), encoder.encode(body));
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!valid) return { ok: false, reason: 'invalid' };
  let payload: TokenPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(body)));
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'invalid' };
  if (payload.v !== 1 || !['host', 'guest', 'admin', 'login'].includes(payload.role)) return { ok: false, reason: 'invalid' };
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return { ok: false, reason: 'invalid' };
  if (payload.exp * 1000 + (opts.allowExpiredSeconds ?? 0) * 1000 <= now) return { ok: false, reason: 'expired' };
  return { ok: true, payload };
}

/**
 * Room passwords are carried inside invite tokens as a *keyed* hash, so someone holding an invite
 * link can't brute-force the password offline without the server's secret.
 */
export async function hashRoomPassword(secret: string, roomId: string, password: string): Promise<string> {
  return base64UrlEncode(await hmac(secret, `room-password:${roomId}:${password}`)).slice(0, 32);
}
