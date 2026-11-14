// Node.js signaling server (used by local dev and the Docker/VPS deployment).
//
//   GET  /api/ice-servers   -> STUN/TURN config for browsers
//   GET  /healthz           -> "ok"
//   WS   /ws?room=<id>      -> signaling (any path is accepted for WebSocket upgrades)

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  MAX_MESSAGE_SIZE,
  PONG_MESSAGE,
  RateLimiter,
  Room,
  getIceServers,
  parseClientMessage,
  type ClientMessage,
  type IceEnv,
  type Transport,
} from './core/index.js';

// --port=NNNN (used by `pnpm dev`) wins over $PORT so a PORT meant for another process can't hijack it.
const portArg = process.argv.find((a) => a.startsWith('--port='))?.slice('--port='.length);
const PORT = parseInt(portArg ?? process.env.PORT ?? '3001', 10);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const transport: Transport<WebSocket> = {
  send: (ws, data) => ws.send(data),
  isOpen: (ws) => ws.readyState === ws.OPEN,
  close: (ws, code, reason) => ws.close(code, reason),
};

const rooms = new Map<string, Room<WebSocket>>();
const connRoom = new Map<WebSocket, string>();
/** create/join calls still awaiting their password hash, per room — such rooms must not be reaped. */
const pendingEnters = new Map<string, number>();
const limiter = new RateLimiter<WebSocket>();
const alive = new WeakMap<WebSocket, boolean>();

function originAllowed(origin: string | undefined): boolean {
  return ALLOWED_ORIGINS.length === 0 || (!!origin && ALLOWED_ORIGINS.includes(origin));
}

// ── HTTP ──────────────────────────────────────────────────────────────────

/** Lets clients on another origin (desktop app, custom server setting) read /api responses. */
function setCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (origin && originAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
}

async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400' }).end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/ice-servers') {
    try {
      const body = await getIceServers(process.env as IceEnv);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    } catch (err) {
      console.error('Failed to build ICE servers:', err);
      res.writeHead(502, { 'Content-Type': 'application/json' }).end('{"error":"TURN unavailable"}');
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
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
  verifyClient: ({ origin }, done) => {
    if (originAllowed(origin)) return done(true);
    console.warn(`Rejected connection from origin: ${origin || 'unknown'}`);
    done(false, 403, 'Origin not allowed');
  },
});

function getOrCreateRoom(roomId: string): Room<WebSocket> {
  let room = rooms.get(roomId);
  if (!room) {
    room = new Room(roomId, transport, { log: console.log });
    rooms.set(roomId, room);
  }
  return room;
}

/** Forget a room once nobody is in it and no create/join for it is still in flight. */
function reapIfEmpty(roomId: string): void {
  const room = rooms.get(roomId);
  if (room && room.isEmpty() && !pendingEnters.get(roomId)) rooms.delete(roomId);
}

function leaveCurrentRoom(ws: WebSocket): void {
  const roomId = connRoom.get(ws);
  if (!roomId) return;
  connRoom.delete(ws);
  rooms.get(roomId)?.leave(ws);
  reapIfEmpty(roomId);
}

function sendError(ws: WebSocket, message: string): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'error', message }));
}

async function handleMessage(ws: WebSocket, msg: ClientMessage): Promise<void> {
  switch (msg.type) {
    case 'ping':
      ws.send(PONG_MESSAGE);
      return;
    case 'create-room':
    case 'join': {
      if (connRoom.get(ws) !== msg.roomId) leaveCurrentRoom(ws);
      const room = getOrCreateRoom(msg.roomId);
      connRoom.set(ws, msg.roomId);
      pendingEnters.set(msg.roomId, (pendingEnters.get(msg.roomId) ?? 0) + 1);
      try {
        if (msg.type === 'create-room') await room.create(ws, msg);
        else await room.join(ws, msg);
      } finally {
        const left = (pendingEnters.get(msg.roomId) ?? 1) - 1;
        if (left > 0) pendingEnters.set(msg.roomId, left);
        else pendingEnters.delete(msg.roomId);
      }
      // The socket may have closed while we were hashing, or been rejected.
      if (ws.readyState !== ws.OPEN) room.leave(ws);
      if (!room.has(ws) && connRoom.get(ws) === msg.roomId) connRoom.delete(ws);
      reapIfEmpty(msg.roomId);
      return;
    }
    case 'leave':
      leaveCurrentRoom(ws);
      return;
    default: {
      const room = rooms.get(connRoom.get(ws) ?? '');
      if (!room) return;
      if (msg.type === 'signal') room.signal(ws, msg.targetPeerId, msg.signal);
      else if (msg.type === 'admit-peer') room.admitPeer(ws, msg.peerId);
      else if (msg.type === 'deny-peer') room.denyPeer(ws, msg.peerId);
    }
  }
}

wss.on('connection', (ws) => {
  alive.set(ws, true);
  ws.on('pong', () => alive.set(ws, true));

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
    handleMessage(ws, parsed.msg).catch((err) => console.error('Handler error:', err));
  });

  ws.on('close', () => leaveCurrentRoom(ws));
  ws.on('error', () => leaveCurrentRoom(ws));
});

// Heartbeat: terminate sockets that miss a protocol-level ping.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (alive.get(ws) === false) {
      ws.terminate();
      continue;
    }
    alive.set(ws, false);
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
  if (++ticks % 12 === 0 && rooms.size > 0) {
    console.log(`[stats] ${rooms.size} room(s), ${peers} peer(s)`);
  }
}, 5_000);

server.listen(PORT, () => {
  console.log(`Signaling server listening on http://localhost:${PORT} (WebSocket on any path)`);
  if (ALLOWED_ORIGINS.length === 0) console.log('ALLOWED_ORIGIN not set — accepting any origin');
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
