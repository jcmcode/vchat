// Builds the RTCIceServer list handed to browsers via GET /api/ice-servers.
// Works on Node 20+ and Cloudflare Workers (only uses fetch + WebCrypto).
//
// Supported configurations (first match wins for TURN):
//   1. Cloudflare Realtime TURN:  CF_TURN_KEY_ID + CF_TURN_API_TOKEN
//   2. coturn with REST auth:     TURN_URLS + TURN_SECRET   (coturn: use-auth-secret / static-auth-secret)
//   3. Static TURN credentials:   TURN_URLS + TURN_USERNAME + TURN_CREDENTIAL
//   4. None:                      STUN only (works for most home networks, fails behind strict NATs)

export interface IceEnv {
  STUN_URLS?: string;
  TURN_URLS?: string;
  TURN_SECRET?: string;
  TURN_USERNAME?: string;
  TURN_CREDENTIAL?: string;
  TURN_TTL_SECONDS?: string;
  CF_TURN_KEY_ID?: string;
  CF_TURN_API_TOKEN?: string;
}

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface IceResponse {
  iceServers: IceServer[];
  /** Seconds until TURN credentials expire (absent when there are none). */
  ttl?: number;
}

/** Used when STUN_URLS isn't set. Docker deployments point STUN_URLS at their own coturn instead. */
export const DEFAULT_STUN = 'stun:stun.cloudflare.com:3478';
/** TURN credential lifetime (seconds) unless TURN_TTL_SECONDS says otherwise; capped by the invite. */
export const DEFAULT_TURN_TTL = 4 * 60 * 60;
const MIN_QUOTA_WINDOW = 60;
const CLOUDFLARE_MAX_TTL = 48 * 60 * 60;

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function hmacSha1Base64(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
  let binary = '';
  for (const b of sig) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function cloudflareTurn(env: IceEnv, ttl: number): Promise<IceServer[]> {
  const res = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.CF_TURN_KEY_ID!)}/credentials/generate-ice-servers`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CF_TURN_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl }),
    }
  );
  if (!res.ok) throw new Error(`Cloudflare TURN API returned ${res.status}`);
  const body = (await res.json()) as { iceServers?: IceServer[] };
  const servers = body.iceServers ?? [];
  // Browsers block port 53; drop those URLs so ICE doesn't waste time on them. An entry left with
  // no URLs must be removed entirely — RTCPeerConnection rejects an empty `urls` list.
  return servers
    .map((s) => ({
      ...s,
      urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => !/:53(\?|$)/.test(u)),
    }))
    .filter((s) => s.urls.length > 0);
}

export interface IceOptions {
  /** Unix seconds: TURN credentials never outlive the invite/host token they were issued for. */
  expiresAt?: number;
  now?: number;
  /**
   * Stable, opaque id for whoever is asking (per room and client). With it, coturn credentials
   * keep the same username for a while, so coturn's per-user allocation quota limits each client
   * instead of resetting on every request.
   */
  userId?: string;
}


/** Credential lifetime in seconds: TURN_TTL_SECONDS (default 4h), capped at the token's expiry. */
export function turnTtl(env: IceEnv, opts: IceOptions = {}): number {
  const seconds = Math.floor(Number(env.TURN_TTL_SECONDS));
  const configured = Number.isSafeInteger(seconds) && seconds > 0 ? seconds : DEFAULT_TURN_TTL;
  const providerLimit = env.CF_TURN_KEY_ID && env.CF_TURN_API_TOKEN ? CLOUDFLARE_MAX_TTL : configured;
  const lifetime = Math.min(configured, providerLimit);
  if (opts.expiresAt === undefined) return lifetime;
  const left = Math.floor(opts.expiresAt) - Math.floor((opts.now ?? Date.now()) / 1000);
  return Math.max(0, Math.min(lifetime, left));
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_');
}

export async function getIceServers(env: IceEnv, opts: IceOptions = {}): Promise<IceResponse> {
  const ttl = turnTtl(env, opts);
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);

  if (ttl > 0 && env.CF_TURN_KEY_ID && env.CF_TURN_API_TOKEN) {
    // Cloudflare's response already includes its own STUN server.
    return { iceServers: await cloudflareTurn(env, ttl), ttl };
  }

  const iceServers: IceServer[] = [];
  const stun = splitList(env.STUN_URLS ?? DEFAULT_STUN);
  if (stun.length) iceServers.push({ urls: stun });

  if (ttl === 0) return { iceServers };
  const turnUrls = splitList(env.TURN_URLS);
  if (turnUrls.length && env.TURN_SECRET) {
    // coturn "TURN REST API" credentials: username = "<expiry>:<id>", password = HMAC(secret, username).
    // The id is per client (random when the caller is unknown), so coturn's per-user quota applies
    // per client rather than to everyone. For a known client the username must also stay the same
    // from one request to the next, or asking again would hand out a fresh allowance each time:
    //  - capped by the invite: the expiry is the invite's own, which never changes;
    //  - otherwise it's rounded down to a window of half the lifetime, so a client holds at most
    //    two or three live usernames however often it asks.
    let expiry = nowSec + ttl;
    const cappedByInvite = opts.expiresAt !== undefined && expiry >= Math.floor(opts.expiresAt);
    const window = Math.floor(ttl / 2);
    if (opts.userId && !cappedByInvite && window >= MIN_QUOTA_WINDOW) expiry = Math.floor(expiry / window) * window;
    const username = `${expiry}:${opts.userId ?? randomId()}`;
    const credential = await hmacSha1Base64(env.TURN_SECRET, username);
    iceServers.push({ urls: turnUrls, username, credential });
    return { iceServers, ttl: expiry - nowSec };
  }
  if (turnUrls.length && env.TURN_USERNAME && env.TURN_CREDENTIAL) {
    iceServers.push({ urls: turnUrls, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL });
    return { iceServers };
  }
  return { iceServers };
}
