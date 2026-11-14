// Node.js signaling server (used by local dev and the Docker/VPS deployment).
//
//   /api/*                  -> shared HTTP API (see core/api.ts): config, ICE servers, owner sign-in, invites
//   GET  /healthz           -> "ok"
//   WS   /ws?room=<id>      -> signaling (any path is accepted for WebSocket upgrades)

import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  CLOSE_INVALID_INVITE,
  MAX_MESSAGE_SIZE,
  PONG_MESSAGE,
  RateLimiter,
  Room,
  WS_PROTOCOL,
  authorizeJoin,
  authorizeSocket,
  handleApi,
  ipKey,
  isValidRoomId,
  parseClientMessage,
  resolveConfig,
  sweepApiState,
  type ClientMessage,
  type JoinGrant,
  type ServerEnv,
  type Transport,
} from './core/index.js';

const env = process.env as ServerEnv;
const DEBUG_LOGS = process.env.DEBUG_LOGS === '1';
const config = resolveConfig(env);

// --port=NNNN (used by `pnpm dev`) wins over $PORT so a PORT meant for another process can't hijack it.
const portArg = process.argv.find((a) => a.startsWith('--port='))?.slice('--port='.length);
const PORT = parseInt(portArg ?? process.env.PORT ?? '3001', 10);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase().replace(/\/+$/, ''))
  .filter(Boolean);

/** Sockets that have this much queued (a client not reading) are dropped. */
const MAX_BUFFERED_BYTES = 1024 * 1024;

const transport: Transport<WebSocket> = {
  send: (ws, data) => safeSend(ws, data),
  isOpen: (ws) => ws.readyState === ws.OPEN,
  close: (ws, code, reason) => ws.close(code, reason),
};

/** Send, unless the client has stopped reading: then drop it rather than buffer without limit. */
function safeSend(ws: WebSocket, data: string): void {
  if (ws.readyState !== ws.OPEN) return;
  if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
    ws.terminate();
    return;
  }
  ws.send(data);
}

interface SocketInfo {
  /** The room this socket was authorized for at the upgrade; it can't join any other. */
  roomId: string;
  /** Keyed hash of the client address (for room-password throttling); never the raw IP. */
  clientId: string;
}

const rooms = new Map<string, Room<WebSocket>>();
const sockets = new WeakMap<WebSocket, SocketInfo>();
/** create/join calls still awaiting their password hash, per room — such rooms must not be reaped. */
const pendingEnters = new Map<string, number>();
const limiter = new RateLimiter<WebSocket>();
/** Sockets we've pinged and not yet heard a pong from. */
const awaitingPong = new WeakSet<WebSocket>();
const missedPong = new WeakSet<WebSocket>();
/** Each socket's messages are handled one at a time (joins await hashing; no interleaving). */
const queues = new WeakMap<WebSocket, Promise<void>>();
/** Sockets that aren't in a room (never entered, or left) are closed after this long. */
const IDLE_SOCKET_MS = 5 * 60 * 1000;
const idleTimers = new WeakMap<WebSocket, ReturnType<typeof setTimeout>>();
/** Keys client hashes; random per process if there's no SECRET_KEY (open mode). */
const CLIENT_KEY = env.SECRET_KEY || randomBytes(32).toString('hex');

function clientIdFor(ip: string): string {
  return createHmac('sha256', CLIENT_KEY).update(`client:${ipKey(ip)}`).digest('base64url').slice(0, 22);
}

// Open sockets are capped per room (as on Cloudflare), per client address and in total, so one
// invite holder can't exhaust the server's memory or crowd everyone else out of a room.
const MAX_SOCKETS_PER_ROOM = 40;
const MAX_SOCKETS_PER_CLIENT = 30;
const MAX_SOCKETS_TOTAL = 5000;
const socketsPerRoom = new Map<string, number>();
const socketsPerClient = new Map<string, number>();

function bump(map: Map<string, number>, key: string, by: 1 | -1): void {
  const next = (map.get(key) ?? 0) + by;
  if (next > 0) map.set(key, next);
  else map.delete(key);
}

function armIdle(ws: WebSocket): void {
  clearIdle(ws);
  idleTimers.set(
    ws,
    setTimeout(() => {
      const info = sockets.get(ws);
      if (!info || !rooms.get(info.roomId)?.has(ws)) ws.close(4001, 'Idle');
    }, IDLE_SOCKET_MS)
  );
}

function clearIdle(ws: WebSocket): void {
  const timer = idleTimers.get(ws);
  if (timer) clearTimeout(timer);
  idleTimers.delete(ws);
}

/** ALLOWED_ORIGIN if set; otherwise only the site's own origin (like the Cloudflare Worker). */
function originAllowed(origin: string | undefined, req: IncomingMessage): boolean {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.length > 0) return ALLOWED_ORIGINS.includes(origin.toLowerCase());
  try {
    const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0].trim().toLowerCase();
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

// ── HTTP ──────────────────────────────────────────────────────────────────

/** Lets clients on another origin (desktop app, custom server setting) read /api responses. */
function setCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin.toLowerCase())) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
}

async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    res
      .writeHead(204, {
        'Access-Control-Allow-Methods': 'GET',
        'Access-Control-Allow-Headers': 'X-Vchat-Token',
        'Access-Control-Max-Age': '86400',
      })
      .end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    return;
  }

  const response = await handleApi(await toFetchRequest(req), env, { clientIp: clientIp(req) });
  if (!response) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    return;
  }
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.writeHead(response.status).end(Buffer.from(await response.arrayBuffer()));
}

/** Adapt Node's request to a Fetch Request for the shared API handler. */
async function toFetchRequest(req: IncomingMessage): Promise<Request> {
  const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim();
  const url = new URL(req.url ?? '/', `${proto}://${req.headers.host ?? 'localhost'}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value !== undefined) headers.set(key, value);
  }
  let body: Buffer | undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 16 * 1024) break; // API bodies are tiny; ignore anything larger
      chunks.push(chunk as Buffer);
    }
    body = Buffer.concat(chunks);
  }
  return new Request(url, { method: req.method, headers, body: body ? new Uint8Array(body) : undefined });
}

/** The last X-Forwarded-For hop is the one added by our own reverse proxy (Caddy). */
function clientIp(req: IncomingMessage): string {
  const forwarded = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return forwarded.at(-1) ?? req.socket.remoteAddress ?? 'unknown';
}

const server = createServer((req, res) => {
  handleHttp(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500).end();
  });
});

// ── WebSocket ─────────────────────────────────────────────────────────────

const wss = new WebSocketServer({
  server,
  maxPayload: MAX_MESSAGE_SIZE,
  handleProtocols: (protocols) => (protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false),
  verifyClient: ({ origin, req }, done) => {
    if (!originAllowed(origin, req)) return done(false, 403, 'Origin not allowed');
    const roomId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('room') ?? '';
    if (!isValidRoomId(roomId)) return done(false, 400, 'Invalid room');
    if (
      wss.clients.size >= MAX_SOCKETS_TOTAL ||
      (socketsPerRoom.get(roomId) ?? 0) >= MAX_SOCKETS_PER_ROOM ||
      (socketsPerClient.get(clientIdFor(clientIp(req))) ?? 0) >= MAX_SOCKETS_PER_CLIENT
    ) {
      return done(false, 503, 'Too many connections');
    }
    // Private mode: no valid invite/host token for this room, no socket.
    authorizeSocket(env, roomId, req.headers['sec-websocket-protocol'])
      .then((ok) => (ok ? done(true) : done(false, 401, 'Invite required')))
      .catch(() => done(false, 500));
  },
});

function getOrCreateRoom(roomId: string): Room<WebSocket> {
  let room = rooms.get(roomId);
  if (!room) {
    room = new Room(roomId, transport, {
      // Re-arm the idle timer whenever a socket stops being in the room (left, denied, timed out…).
      onMemberChange: (ws, state) => (state ? clearIdle(ws) : ws.readyState === ws.OPEN && armIdle(ws)),
      // No logs by default: room codes and names are only printed with DEBUG_LOGS=1.
      log: DEBUG_LOGS ? console.log : undefined,
    });
    rooms.set(roomId, room);
  }
  return room;
}

/** Forget a room once nobody is in it and no create/join for it is still in flight. */
function reapIfEmpty(roomId: string): void {
  const room = rooms.get(roomId);
  if (room && room.isEmpty() && !pendingEnters.get(roomId)) rooms.delete(roomId);
}

function leaveRoom(ws: WebSocket): void {
  const info = sockets.get(ws);
  if (!info) return;
  rooms.get(info.roomId)?.leave(ws);
  reapIfEmpty(info.roomId);
}

function sendError(ws: WebSocket, message: string): void {
  safeSend(ws, JSON.stringify({ type: 'error', message }));
}

async function handleMessage(ws: WebSocket, msg: ClientMessage): Promise<void> {
  const info = sockets.get(ws);
  if (!info) return;
  switch (msg.type) {
    case 'ping':
      safeSend(ws, PONG_MESSAGE);
      return;
    case 'create-room':
    case 'join': {
      // A socket is authorized for one room at the upgrade and can't be used for another.
      if (msg.roomId !== info.roomId) return sendError(ws, 'Room ID does not match connection');
      // Private mode: every entry needs a valid invite or host token (checked before touching rooms).
      let grant: JoinGrant | null = null;
      if (config.mode === 'private') {
        if (msg.type === 'create-room') return sendError(ws, 'Invite required');
        const decision = await authorizeJoin(env, msg, { clientId: info.clientId });
        if (!decision.ok) {
          if ('passwordRequired' in decision) {
            safeSend(ws, JSON.stringify({ type: 'password-required', roomId: msg.roomId, invalid: decision.invalid }));
          } else {
            sendError(ws, decision.error);
            // An invalid or expired invite won't get better: hang up.
            if (decision.fatal) ws.close(CLOSE_INVALID_INVITE, decision.error);
          }
          return;
        }
        grant = decision.grant;
      }

      const room = getOrCreateRoom(msg.roomId);
      const args = { ...msg, clientId: info.clientId };
      pendingEnters.set(msg.roomId, (pendingEnters.get(msg.roomId) ?? 0) + 1);
      try {
        if (grant) await room.enter(ws, args, grant);
        else if (msg.type === 'create-room') await room.create(ws, args);
        else await room.join(ws, args);
      } finally {
        const left = (pendingEnters.get(msg.roomId) ?? 1) - 1;
        if (left > 0) pendingEnters.set(msg.roomId, left);
        else pendingEnters.delete(msg.roomId);
      }
      // The socket may have closed while we were hashing.
      if (ws.readyState !== ws.OPEN) room.leave(ws);
      reapIfEmpty(msg.roomId);
      return;
    }
    case 'leave':
      leaveRoom(ws);
      return;
    default: {
      const room = rooms.get(info.roomId);
      if (!room) return;
      if (msg.type === 'signal') room.signal(ws, msg.targetPeerId, msg.signal);
      else if (msg.type === 'admit-peer') room.admitPeer(ws, msg.peerId);
      else if (msg.type === 'deny-peer') room.denyPeer(ws, msg.peerId);
      else if (msg.type === 'remove-peer') room.removePeer(ws, msg.peerId);
      reapIfEmpty(info.roomId);
    }
  }
}

wss.on('connection', (ws, req) => {
  const roomId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('room') ?? '';
  if (!isValidRoomId(roomId)) {
    ws.close(1008, 'Invalid room');
    return;
  }
  const clientId = clientIdFor(clientIp(req));
  sockets.set(ws, { roomId, clientId });
  bump(socketsPerRoom, roomId, 1);
  bump(socketsPerClient, clientId, 1);

  // A pong only counts if we actually asked (unsolicited pongs can't keep a socket alive).
  ws.on('pong', () => {
    if (awaitingPong.has(ws)) {
      awaitingPong.delete(ws);
      missedPong.delete(ws);
    }
  });
  armIdle(ws);

  ws.on('message', (raw) => {
    if (!limiter.allow(ws)) {
      sendError(ws, 'Rate limit exceeded');
      return;
    }
    const parsed = parseClientMessage(raw.toString());
    if (!parsed.ok) {
      sendError(ws, parsed.error);
      return;
    }
    const msg = parsed.msg;
    const next = (queues.get(ws) ?? Promise.resolve())
      .then(() => handleMessage(ws, msg))
      .catch((err) => console.error('Handler error:', err instanceof Error ? err.message : 'unknown error'));
    queues.set(ws, next);
  });

  ws.on('close', () => {
    clearIdle(ws);
    leaveRoom(ws);
    bump(socketsPerRoom, roomId, -1);
    bump(socketsPerClient, clientId, -1);
  });
  ws.on('error', () => leaveRoom(ws));
});

// Heartbeat: terminate sockets that miss a protocol-level ping.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (awaitingPong.has(ws)) {
      // No answer to the last ping: one more chance, then drop it.
      if (missedPong.has(ws)) {
        ws.terminate();
        continue;
      }
      missedPong.add(ws);
    }
    awaitingPong.add(ws);
    ws.ping();
  }
}, 30_000);

// Expire people stuck in waiting rooms; log stats about once a minute.
let ticks = 0;
const housekeeping = setInterval(() => {
  let peers = 0;
  for (const [id, room] of rooms) {
    room.expireWaiting();
    reapIfEmpty(id);
    peers += room.peers().length;
  }
  sweepApiState();
  if (DEBUG_LOGS && ++ticks % 12 === 0 && rooms.size > 0) {
    console.log(`[stats] ${rooms.size} room(s), ${peers} peer(s)`);
  }
}, 5_000);

server.listen(PORT, () => {
  console.log(`Signaling server listening on http://localhost:${PORT} (WebSocket on any path)`);
  if (ALLOWED_ORIGINS.length === 0) console.log('ALLOWED_ORIGIN not set — accepting same-origin connections only');
  // Logged once here; clients only ever see { misconfigured: true }.
  if (config.error) console.error(`CONFIG ERROR: ${config.error}`);
  else if (config.mode === 'private') console.log(`Private mode: owner signs in via ${config.auth}; guests need invites`);
  else console.log('Open mode: anyone can create rooms (set ADMIN_PASSWORD + SECRET_KEY for private mode)');
});

function shutdown(): void {
  clearInterval(heartbeat);
  clearInterval(housekeeping);
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
