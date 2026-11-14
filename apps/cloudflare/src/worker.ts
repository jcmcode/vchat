// Cloudflare Worker entry point: serves the static web app and routes signaling to Durable Objects.
//
//   GET /api/ice-servers  -> STUN/TURN config (Cloudflare Realtime TURN if configured)
//   WS  /ws?room=<id>     -> SignalingRoom Durable Object for that room
//   *                     -> static assets from apps/web/build (SPA fallback to index.html)

import { getIceServers, isValidRoomId } from '@vchat/signaling-server/core';
import type { Env } from './env.ts';

export { SignalingRoom } from './room.ts';

const SECURITY_HEADERS: Record<string, string> = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self)',
  'Strict-Transport-Security': 'max-age=31536000',
};

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.byteLength !== bb.byteLength) return false;
  return crypto.subtle.timingSafeEqual(ab, bb);
}

function isAuthorized(request: Request, env: Env): boolean {
  if (!env.SITE_PASSWORD) return true;
  const header = request.headers.get('Authorization') ?? '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) return false;
  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    return false;
  }
  const sep = decoded.indexOf(':');
  const password = sep >= 0 ? decoded.slice(sep + 1) : '';
  return timingSafeEqual(password, env.SITE_PASSWORD);
}

function originAllowed(request: Request, env: Env): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return false;
  const allowed = (env.ALLOWED_ORIGIN ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.length > 0) return allowed.includes(origin);
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

function withHeaders(response: Response, headers: Record<string, string>): Response {
  // Responses from fetch()/ASSETS are immutable; copy before adding headers.
  const res = new Response(response.body, response);
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (!isAuthorized(request, env)) {
      return new Response('Authentication required', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="vchat", charset="UTF-8"' },
      });
    }

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }
      if (!originAllowed(request, env)) {
        return new Response('Origin not allowed', { status: 403 });
      }
      const roomId = url.searchParams.get('room') ?? '';
      if (!isValidRoomId(roomId)) {
        return new Response('Invalid room', { status: 400 });
      }
      const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
      return stub.fetch(request);
    }

    if (url.pathname === '/api/ice-servers') {
      try {
        const body = await getIceServers(env);
        return Response.json(body, { headers: { 'Cache-Control': 'no-store' } });
      } catch (err) {
        console.error('Failed to build ICE servers:', err);
        return Response.json({ error: 'TURN unavailable' }, { status: 502 });
      }
    }

    if (url.pathname === '/healthz') {
      return new Response('ok');
    }

    const asset = await env.ASSETS.fetch(request);
    return withHeaders(asset, SECURITY_HEADERS);
  },
} satisfies ExportedHandler<Env>;
