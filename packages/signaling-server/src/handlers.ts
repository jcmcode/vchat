import type { WebSocket } from 'ws';
import {
  addPeerToRoom,
  removePeerFromRoom,
  broadcastToRoom,
  sendToPeer,
  getPeersInRoom,
} from './rooms.js';

const MAX_MESSAGE_SIZE = 64 * 1024; // 64KB

interface ClientState {
  peerId: string;
  roomId: string | null;
  displayName: string;
}

// Track which client is in which room
const clientStates = new Map<WebSocket, ClientState>();

export type SignalingMessage =
  | { type: 'join'; roomId: string; peerId: string; displayName: string }
  | { type: 'leave' }
  | { type: 'signal'; targetPeerId: string; signal: unknown }
  | { type: 'chat'; text: string };

export function handleConnection(ws: WebSocket): void {
  ws.on('message', (raw) => {
    const rawStr = raw.toString();

    if (rawStr.length > MAX_MESSAGE_SIZE) {
      ws.send(JSON.stringify({ type: 'error', message: 'Message too large' }));
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
      case 'join':
        handleJoin(ws, msg);
        break;
      case 'leave':
        handleLeave(ws);
        break;
      case 'signal':
        handleSignal(ws, msg);
        break;
      case 'chat':
        handleChat(ws, msg);
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

function handleJoin(
  ws: WebSocket,
  msg: { roomId: string; peerId: string; displayName: string }
): void {
  const { roomId, peerId, displayName: rawName } = msg;

  // Validate roomId: 1-20 chars, alphanumeric only
  if (typeof roomId !== 'string' || !/^[a-z0-9]{1,20}$/.test(roomId)) {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid roomId: must be 1-20 lowercase alphanumeric characters' }));
    return;
  }

  // Validate peerId: 1-30 chars, alphanumeric/underscore/hyphen
  if (typeof peerId !== 'string' || !/^[a-zA-Z0-9_-]{1,30}$/.test(peerId)) {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid peerId: must be 1-30 alphanumeric/underscore/hyphen characters' }));
    return;
  }

  // Validate displayName: 1-30 chars after trim
  if (typeof rawName !== 'string') {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid displayName: must be a string' }));
    return;
  }
  const displayName = rawName.trim();
  if (displayName.length === 0 || displayName.length > 30) {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid displayName: must be 1-30 characters after trimming' }));
    return;
  }

  // Leave existing room if any
  handleLeave(ws);

  // Get existing peers before adding this one
  const existingPeers = getPeersInRoom(roomId).map((p) => ({
    id: p.id,
    displayName: p.displayName,
  }));

  // Add peer to room (enforces MAX_PEERS_PER_ROOM)
  const added = addPeerToRoom(roomId, { id: peerId, ws, displayName });
  if (!added) {
    ws.send(JSON.stringify({ type: 'error', message: 'Room is full' }));
    return;
  }

  const state: ClientState = { peerId, roomId, displayName };
  clientStates.set(ws, state);

  // Tell the new peer about existing peers
  ws.send(
    JSON.stringify({
      type: 'room-peers',
      peers: existingPeers,
      roomId,
    })
  );

  // Tell existing peers about the new peer
  broadcastToRoom(
    roomId,
    {
      type: 'peer-joined',
      peerId,
      displayName,
    },
    peerId
  );

  console.log(`[${roomId}] ${displayName} (${peerId}) joined`);
}

function handleLeave(ws: WebSocket): void {
  const state = clientStates.get(ws);
  if (!state || !state.roomId) return;

  const { roomId, peerId, displayName } = state;

  removePeerFromRoom(roomId, peerId);
  clientStates.delete(ws);

  // Notify remaining peers
  broadcastToRoom(roomId, {
    type: 'peer-left',
    peerId,
    displayName,
  });

  console.log(`[${roomId}] ${displayName} (${peerId}) left`);
}

function handleSignal(
  ws: WebSocket,
  msg: { targetPeerId: string; signal: unknown }
): void {
  const state = clientStates.get(ws);
  if (!state || !state.roomId) return;

  // Forward the WebRTC signal to the target peer
  sendToPeer(state.roomId, msg.targetPeerId, {
    type: 'signal',
    fromPeerId: state.peerId,
    signal: msg.signal,
  });
}

function handleChat(ws: WebSocket, msg: { text: string }): void {
  const state = clientStates.get(ws);
  if (!state || !state.roomId) return;

  // Validate text: must be string, 1-2000 chars after trim
  if (typeof msg.text !== 'string') {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid chat text' }));
    return;
  }
  const text = msg.text.trim();
  if (text.length === 0 || text.length > 2000) {
    ws.send(JSON.stringify({ type: 'error', message: 'Chat text must be 1-2000 characters' }));
    return;
  }

  broadcastToRoom(
    state.roomId,
    {
      type: 'chat',
      fromPeerId: state.peerId,
      displayName: state.displayName,
      text,
      timestamp: Date.now(),
    },
    state.peerId
  );
}
