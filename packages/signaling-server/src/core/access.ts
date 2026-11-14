// Verifies Cloudflare Access JWTs (the `Cf-Access-Jwt-Assertion` header Access adds to requests).
// Works on any backend sitting behind Cloudflare Access — the Worker, or Docker via Cloudflare Tunnel.
// https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/

import { base64UrlDecode } from './tokens.js';

export interface AccessConfig {
  /** e.g. "myteam.cloudflareaccess.com" */
  teamDomain: string;
  /** Application Audience (AUD) tag from the Access application's settings. */
  audience: string;
}

interface Jwk extends JsonWebKey {
  kid: string;
}

const CERTS_TTL_MS = 60 * 60 * 1000;
/** Unknown key ids can force a refresh, but at most this often (stops fetch amplification). */
const MIN_REFRESH_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
let certCache: { team: string; fetchedAt: number; keys: Map<string, CryptoKey> } | null = null;
/** One fetch at a time: concurrent requests share it instead of each hitting Cloudflare. */
let inflight: { team: string; promise: Promise<Map<string, CryptoKey>> } | null = null;
/** A failed fetch is remembered for MIN_REFRESH_MS so an outage can't trigger a fetch per request. */
let lastFailure: { team: string; at: number; error: Error } | null = null;

function normalizeTeamDomain(team: string): string {
  return team.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

async function fetchKeys(team: string): Promise<Map<string, CryptoKey>> {
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Cloudflare Access certs returned ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (jwk.kty !== 'RSA' || !jwk.kid) continue;
    try {
      keys.set(jwk.kid, await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
    } catch {
      // skip a malformed key rather than rejecting all of them
    }
  }
  return keys;
}

async function getKeys(team: string, forceRefresh = false): Promise<Map<string, CryptoKey>> {
  const now = Date.now();
  const age = certCache && certCache.team === team ? now - certCache.fetchedAt : Infinity;
  if (certCache && age < CERTS_TTL_MS && (!forceRefresh || age < MIN_REFRESH_MS)) return certCache.keys;
  if (lastFailure && lastFailure.team === team && now - lastFailure.at < MIN_REFRESH_MS) {
    // Recently failed: serve stale keys if we have them, otherwise fail fast.
    if (certCache && certCache.team === team) return certCache.keys;
    throw lastFailure.error;
  }
  if (inflight && inflight.team === team) return inflight.promise;

  const promise = fetchKeys(team).then(
    (keys) => {
      certCache = { team, fetchedAt: Date.now(), keys };
      lastFailure = null;
      return keys;
    },
    (err: unknown) => {
      lastFailure = { team, at: Date.now(), error: err instanceof Error ? err : new Error(String(err)) };
      throw lastFailure.error;
    }
  );
  inflight = { team, promise };
  try {
    return await promise;
  } finally {
    if (inflight?.promise === promise) inflight = null;
  }
}

export interface AccessIdentity {
  email?: string;
  sub?: string;
}

/** Returns the signed-in identity, or null if the JWT is missing/invalid/expired/for another app. */
export async function verifyAccessJwt(token: string | null, config: AccessConfig): Promise<AccessIdentity | null> {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  let header: { alg?: string; kid?: string };
  let payload: { aud?: string | string[]; iss?: string; exp?: number; nbf?: number; email?: string; sub?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerB64)));
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64)));
  } catch {
    return null;
  }
  if (header.alg !== 'RS256' || !header.kid) return null;

  const team = normalizeTeamDomain(config.teamDomain);
  let keys = await getKeys(team);
  if (!keys.has(header.kid)) keys = await getKeys(team, true); // keys rotate
  const key = keys.get(header.kid);
  if (!key) return null;

  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = base64UrlDecode(sigB64);
  } catch {
    return null;
  }
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, new TextEncoder().encode(`${headerB64}.${payloadB64}`));
  if (!valid) return null;

  const now = Date.now() / 1000;
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(config.audience)) return null;
  if (payload.iss !== `https://${team}`) return null;
  if (typeof payload.exp !== 'number' || payload.exp < now) return null;
  if (typeof payload.nbf === 'number' && payload.nbf > now + 60) return null;
  return { email: payload.email, sub: payload.sub };
}
