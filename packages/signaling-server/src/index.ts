import { WebSocketServer, type WebSocket as WsType } from 'ws';
import { handleConnection } from './handlers.js';
import { getRoomCount, getTotalPeerCount } from './rooms.js';

const PORT = parseInt(process.env.PORT ?? '3001', 10);

const wss = new WebSocketServer({ port: PORT });

// Track liveness for heartbeat
const aliveMap = new WeakMap<WsType, boolean>();

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;

wss.on('connection', (ws, req) => {
  const origin = req.headers.origin ?? '';

  if (ALLOWED_ORIGIN && origin !== ALLOWED_ORIGIN) {
    console.warn(`Rejected connection from origin: ${origin}`);
    ws.close(1008, 'Origin not allowed');
    return;
  }

  console.log(`New connection from ${origin || 'unknown'}`);

  aliveMap.set(ws, true);
  ws.on('pong', () => {
    aliveMap.set(ws, true);
  });

  handleConnection(ws);
});

// Heartbeat: ping every 30s, terminate connections that miss 2 pings
const HEARTBEAT_INTERVAL = 30_000;
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (aliveMap.get(ws) === false) {
      // Missed a ping — terminate
      ws.terminate();
      continue;
    }
    aliveMap.set(ws, false);
    ws.ping();
  }
}, HEARTBEAT_INTERVAL);

wss.on('listening', () => {
  console.log(`Signaling server running on ws://localhost:${PORT}`);
});

// Periodic stats
setInterval(() => {
  const rooms = getRoomCount();
  const peers = getTotalPeerCount();
  if (rooms > 0) {
    console.log(`[stats] ${rooms} room(s), ${peers} peer(s)`);
  }
}, 30_000);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  clearInterval(heartbeat);
  wss.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  clearInterval(heartbeat);
  wss.close(() => process.exit(0));
});
