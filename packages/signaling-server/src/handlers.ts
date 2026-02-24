import type { WebSocket } from 'ws';
import {
  createRoom,
  getRoom,
  addPeerToRoom,
  removePeerFromRoom,
  broadcastToRoom,
  sendToPeer,
  getPeersInRoom,
  addToWaitingQueue,
  removeFromWaitingQueue,
} from './rooms.js';
import { checkRateLimit } from './rate-limit.js';

const MAX_MESSAGE_SIZE = 64 * 1024; // 64KB

interface ClientState {
  peerId: string;
  roomId: string | null;
  displayName: string;
}

// Track which client is in which room
const clientStates = new Map<WebSocket, ClientState>();

export type SignalingMessage =
  | { type: 'create-room'; roomId: string; peerId: string; displayName: string; password?: string }
  | { type: 'join'; roomId: string; peerId: string; displayName: string; password?: string }
  | { type: 'leave' }
  | { type: 'signal'; targetPeerId: string; signal: unknown }
  | { type: 'admit-peer'; peerId: string }
  | { type: 'deny-peer'; peerId: string };

async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function handleConnection(ws: WebSocket): void {
  ws.on('message', async (raw) => {
    const rawStr = raw.toString();

    if (rawStr.length > MAX_MESSAGE_SIZE) {
      ws.send(JSON.stringify({ type: 'error', message: 'Message too large' }));
      return;
    }

    // Rate limiting
    if (!checkRateLimit(ws)) {
      ws.send(JSON.stringify({ type: 'error', message: 'Rate limit exceeded' }));
      return;
    }

    let msg: SignalingMessage;
    try {
      msg = JSON.parse(rawStr);
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    switch (msg.type) {
      case 'create-room':
        await handleCreateRoom(ws, msg);
        break;
      case 'join':
        await handleJoin(ws, msg);
        break;
      case 'leave':
        handleLeave(ws);
        break;
      case 'signal':
        handleSignal(ws, msg);
        break;
      case 'admit-peer':
        handleAdmitPeer(ws, msg);
        break;
      case 'deny-peer':
        handleDenyPeer(ws, msg);
        break;
      default:
        ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
    }
  });

  ws.on('close', () => {
    handleLeave(ws);
  });

  ws.on('error', () => {
    handleLeave(ws);
  });
}

function validateRoomId(roomId: unknown): roomId is string {
  return typeof roomId === 'string' && /^[a-z0-9]{1,20}$/.test(roomId);
}

function validatePeerId(peerId: unknown): peerId is string {
  return typeof peerId === 'string' && /^[a-zA-Z0-9_-]{1,30}$/.test(peerId);
}

function validateDisplayName(rawName: unknown): string | null {
  if (typeof rawName !== 'string') return null;
  const name = rawName.trim();
  if (name.length === 0 || name.length > 30) return null;
  return name;
}

async function handleCreateRoom(
  ws: WebSocket,
  msg: { roomId: string; peerId: string; displayName: string; password?: string }
): Promise<void> {
  const { roomId, peerId, password } = msg;

  if (!validateRoomId(roomId)) {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid roomId: must be 1-20 lowercase alphanumeric characters' }));
    return;
  }
  if (!validatePeerId(peerId)) {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid peerId: must be 1-30 alphanumeric/underscore/hyphen characters' }));
    return;
  }
  const displayName = validateDisplayName(msg.displayName);
  if (!displayName) {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid displayName: must be 1-30 characters after trimming' }));
    return;
  }

  // Leave existing room if any
  handleLeave(ws);

  // Check if room already exists
  const existing = getRoom(roomId);
  if (existing) {
    ws.send(JSON.stringify({ type: 'error', message: 'Room already exists' }));
    return;
  }

  // Create room with this peer as host
  const passwordHash = password ? await hashPassword(password) : undefined;
  createRoom(roomId, peerId, passwordHash);

  // Add creator as first peer
  const added = addPeerToRoom(roomId, { id: peerId, ws, displayName });
  if (!added) {
    ws.send(JSON.stringify({ type: 'error', message: 'Failed to join room' }));
    return;
  }

  const state: ClientState = { peerId, roomId, displayName };
  clientStates.set(ws, state);

  // Confirm room creation
  ws.send(JSON.stringify({ type: 'room-created', roomId }));

  // Send empty room-peers (creator is first)
  ws.send(JSON.stringify({ type: 'room-peers', peers: [], roomId }));

  // Tell creator they are host
  ws.send(JSON.stringify({ type: 'host-changed', hostPeerId: peerId }));

  console.log(`[${roomId}] ${displayName} (${peerId}) created room`);
}

async function handleJoin(
  ws: WebSocket,
  msg: { roomId: string; peerId: string; displayName: string; password?: string }
): Promise<void> {
  const { roomId, peerId, password } = msg;

  if (!validateRoomId(roomId)) {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid roomId: must be 1-20 lowercase alphanumeric characters' }));
    return;
  }
  if (!validatePeerId(peerId)) {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid peerId: must be 1-30 alphanumeric/underscore/hyphen characters' }));
    return;
  }
  const displayName = validateDisplayName(msg.displayName);
  if (!displayName) {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid displayName: must be 1-30 characters after trimming' }));
    return;
  }

  // Leave existing room if any
  handleLeave(ws);

  const room = getRoom(roomId);
  if (!room) {
    ws.send(JSON.stringify({ type: 'error', message: 'Room does not exist. Create it first.' }));
    return;
  }

  // Check room capacity
  if (room.peers.size >= 6) {
    ws.send(JSON.stringify({ type: 'error', message: 'Room is full' }));
    return;
  }

  // Password check
  if (room.passwordHash) {
    if (!password) {
      ws.send(JSON.stringify({ type: 'password-required', roomId }));
      return;
    }
    const inputHash = await hashPassword(password);
    if (inputHash !== room.passwordHash) {
      ws.send(JSON.stringify({ type: 'password-required', roomId }));
      return;
    }
  }

  // Host admission check
  if (room.hostPeerId) {
    // Add to waiting queue, notify host
    addToWaitingQueue(roomId, { id: peerId, ws, displayName, joinedWaitingAt: Date.now() });

    // Track this client for cleanup on disconnect
    const state: ClientState = { peerId, roomId: null, displayName };
    clientStates.set(ws, state);

    ws.send(JSON.stringify({ type: 'waiting-for-admission', roomId }));
    sendToPeer(roomId, room.hostPeerId, {
      type: 'admission-request',
      peerId,
      displayName,
    });
    console.log(`[${roomId}] ${displayName} (${peerId}) waiting for admission`);
    return;
  }

  // No host (edge case) — admit directly
  admitPeerToRoom(ws, roomId, peerId, displayName);
}

function admitPeerToRoom(ws: WebSocket, roomId: string, peerId: string, displayName: string): void {
  const existingPeers = getPeersInRoom(roomId).map((p) => ({
    id: p.id,
    displayName: p.displayName,
  }));

  const added = addPeerToRoom(roomId, { id: peerId, ws, displayName });
  if (!added) {
    ws.send(JSON.stringify({ type: 'error', message: 'Room is full' }));
    return;
  }

  const state: ClientState = { peerId, roomId, displayName };
  clientStates.set(ws, state);

  const room = getRoom(roomId);

  ws.send(JSON.stringify({ type: 'room-peers', peers: existingPeers, roomId }));

  // Tell them who the host is
  if (room?.hostPeerId) {
    ws.send(JSON.stringify({ type: 'host-changed', hostPeerId: room.hostPeerId }));
  }

  broadcastToRoom(roomId, { type: 'peer-joined', peerId, displayName }, peerId);
  console.log(`[${roomId}] ${displayName} (${peerId}) joined`);
}

function handleAdmitPeer(ws: WebSocket, msg: { peerId: string }): void {
  const state = clientStates.get(ws);
  if (!state || !state.roomId) return;

  const room = getRoom(state.roomId);
  if (!room || room.hostPeerId !== state.peerId) {
    ws.send(JSON.stringify({ type: 'error', message: 'Only the host can admit peers' }));
    return;
  }

  const waiting = removeFromWaitingQueue(state.roomId, msg.peerId);
  if (!waiting) {
    ws.send(JSON.stringify({ type: 'error', message: 'Peer not in waiting queue' }));
    return;
  }

  // Notify the admitted peer
  if (waiting.ws.readyState === waiting.ws.OPEN) {
    waiting.ws.send(JSON.stringify({ type: 'admission-granted', roomId: state.roomId }));
  }

  // Actually add them to the room
  admitPeerToRoom(waiting.ws, state.roomId, waiting.id, waiting.displayName);
  console.log(`[${state.roomId}] Host admitted ${waiting.displayName} (${waiting.id})`);
}

function handleDenyPeer(ws: WebSocket, msg: { peerId: string }): void {
  const state = clientStates.get(ws);
  if (!state || !state.roomId) return;

  const room = getRoom(state.roomId);
  if (!room || room.hostPeerId !== state.peerId) {
    ws.send(JSON.stringify({ type: 'error', message: 'Only the host can deny peers' }));
    return;
  }

  const waiting = removeFromWaitingQueue(state.roomId, msg.peerId);
  if (!waiting) return;

  if (waiting.ws.readyState === waiting.ws.OPEN) {
    waiting.ws.send(JSON.stringify({
      type: 'admission-denied',
      roomId: state.roomId,
      reason: 'Denied by host',
    }));
  }
  console.log(`[${state.roomId}] Host denied ${waiting.displayName} (${waiting.id})`);
}

function handleLeave(ws: WebSocket): void {
  const state = clientStates.get(ws);
  if (!state) return;

  // If peer was in waiting queue (roomId is null when waiting)
  if (!state.roomId) {
    // Remove from any waiting queue they might be in
    clientStates.delete(ws);
    return;
  }

  const { roomId, peerId, displayName } = state;

  removePeerFromRoom(roomId, peerId);
  clientStates.delete(ws);

  broadcastToRoom(roomId, { type: 'peer-left', peerId, displayName });
  console.log(`[${roomId}] ${displayName} (${peerId}) left`);
}

function handleSignal(
  ws: WebSocket,
  msg: { targetPeerId: string; signal: unknown }
): void {
  const state = clientStates.get(ws);
  if (!state || !state.roomId) return;

  sendToPeer(state.roomId, msg.targetPeerId, {
    type: 'signal',
    fromPeerId: state.peerId,
    signal: msg.signal,
  });
}
