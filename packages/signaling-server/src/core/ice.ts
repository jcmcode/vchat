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

const DEFAULT_STUN = 'stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302';
const DEFAULT_TTL = 12 * 60 * 60; // 12h — longer than any realistic call

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

export async function getIceServers(env: IceEnv): Promise<IceResponse> {
  const ttl = Number(env.TURN_TTL_SECONDS) > 0 ? Number(env.TURN_TTL_SECONDS) : DEFAULT_TTL;

  if (env.CF_TURN_KEY_ID && env.CF_TURN_API_TOKEN) {
    // Cloudflare's response already includes its own STUN server.
    return { iceServers: await cloudflareTurn(env, ttl), ttl };
  }

  const iceServers: IceServer[] = [];
  const stun = splitList(env.STUN_URLS ?? DEFAULT_STUN);
  if (stun.length) iceServers.push({ urls: stun });

  const turnUrls = splitList(env.TURN_URLS);
  if (turnUrls.length && env.TURN_SECRET) {
    // coturn "TURN REST API" credentials: username = expiry timestamp, password = HMAC(secret, username)
    const username = `${Math.floor(Date.now() / 1000) + ttl}:vchat`;
    const credential = await hmacSha1Base64(env.TURN_SECRET, username);
    iceServers.push({ urls: turnUrls, username, credential });
    return { iceServers, ttl };
  }
  if (turnUrls.length && env.TURN_USERNAME && env.TURN_CREDENTIAL) {
    iceServers.push({ urls: turnUrls, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL });
    return { iceServers };
  }
  return { iceServers };
}
