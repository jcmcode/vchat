// Cloudflare Worker entry point: routes signaling to Durable Objects and serves the shared API.
// Static files (apps/web/build) are served directly by Workers Static Assets — security headers for
// them come from apps/web/static/_headers — so the Worker only runs for /ws, /api/* and /healthz.
//
//   WS  /ws?room=<id>  -> SignalingRoom Durable Object for that room
//   /api/*             -> shared API (core/api.ts): config, ICE servers, owner sign-in, invites
//                         (POST /api/invite/check is finished in the room's Durable Object)
//
// Owner sign-in: Cloudflare Access (CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD), an emailed code
// (OWNER_EMAIL + RESEND_API_KEY + EMAIL_FROM) or ADMIN_PASSWORD.
// Either one also requires SECRET_KEY. With nothing configured (or OPEN_MODE=1), the app runs in
// open mode; anything in between is reported as a configuration error.

import { authorizeSocket, handleApi, isValidRoomId, resolveConfig, throttleClientId } from '@vchat/signaling-server/core';
import { CLIENT_HEADER, INVITE_CHECK_PATH, type Env } from './env.ts';

export { SignalingRoom } from './room.ts';

function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGIN ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/\/+$/, ''))
    .filter(Boolean);
}

function originAllowed(request: Request, env: Env): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return false;
  const allowed = allowedOrigins(env);
  if (allowed.length > 0) return allowed.includes(origin.toLowerCase());
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

/** Cross-origin clients (e.g. the desktop app) may call the API only if listed in ALLOWED_ORIGIN. */
function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin');
  return origin && allowedOrigins(env).includes(origin.toLowerCase()) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
}

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Strict-Transport-Security': 'max-age=31536000',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
};

/** Add security headers to a response the Worker generated itself. */
function secure(response: Response): Response {
  const res = new Response(response.body, response);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
  return res;
}

function text(body: string, status: number): Response {
  return secure(new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } }));
}

/**
 * Opaque per-client id for the Durable Object's password-guess throttle: an HMAC of the client's
 * address (IPv6 grouped by /64), keyed by SECRET_KEY. The raw IP never reaches the Durable Object.
 * (Open mode has no secret; the fixed key there only keeps the id consistent across isolates.)
 */
async function clientId(request: Request, env: Env): Promise<string> {
  return throttleClientId(env.SECRET_KEY || 'vchat-open-mode', request.headers.get('CF-Connecting-IP') ?? undefined);
}

let loggedConfigError = false;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (!loggedConfigError) {
      const config = resolveConfig(env);
      if (config.error) {
        loggedConfigError = true;
        console.error(`CONFIG ERROR: ${config.error}`); // once per isolate; clients only see { misconfigured: true }
      }
    }

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return text('Expected WebSocket upgrade', 426);
      }
      if (!originAllowed(request, env)) {
        return text('Origin not allowed', 403);
      }
      const roomId = url.searchParams.get('room') ?? '';
      if (!isValidRoomId(roomId)) {
        return text('Invalid room', 400);
      }
      // Private mode: no valid invite/host token for this room, no Durable Object.
      if (!(await authorizeSocket(env, roomId, request.headers.get('Sec-WebSocket-Protocol')))) {
        return text('Invite required', 401);
      }
      // Overwrite whatever the client may have sent in our internal header.
      const headers = new Headers(request.headers);
      headers.set(CLIENT_HEADER, await clientId(request, env));
      const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
      const response = await stub.fetch(new Request(request, { headers }));
      return response.status === 101 ? response : secure(response);
    }

    if (url.pathname === '/healthz') {
      return text('ok', 200);
    }

    if (url.pathname.startsWith('/api/')) {
      const cors = corsHeaders(request, env);
      if (request.method === 'OPTIONS') {
        return secure(
          new Response(null, {
            status: 204,
            headers: { ...cors, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'X-Vchat-Token' },
          })
        );
      }
      const response = await handleApi(request, env, {
        clientIp: request.headers.get('CF-Connecting-IP') ?? undefined,
        // Sign-in code emails are sent after the response (same timing for every address).
        waitUntil: (p) => ctx.waitUntil(p),
        // Invite code checks run in the room's Durable Object, against the same guess throttle
        // (room + client id) as joining.
        checkInvite: async (input) => {
          const stub = env.ROOMS.get(env.ROOMS.idFromName(input.roomId));
          const internal = new URL(INVITE_CHECK_PATH, request.url);
          internal.searchParams.set('room', input.roomId);
          return stub.fetch(
            new Request(internal, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', [CLIENT_HEADER]: await clientId(request, env) },
              body: JSON.stringify(input),
            })
          );
        },
      });
      if (response) {
        const res = secure(response);
        for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
        return res;
      }
    }

    // Only reached if run_worker_first is widened; normally assets never hit the Worker.
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
