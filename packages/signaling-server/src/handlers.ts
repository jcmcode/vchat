import type { WebSocket } from 'ws';
import {
  addPeerToRoom,
  removePeerFromRoom,
  broadcastToRoom,
  sendToPeer,
  getPeersInRoom,
} from './rooms.js';

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
    let msg: SignalingMessage;
    try {
      msg = JSON.parse(raw.toString());
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
  // Leave existing room if any
  handleLeave(ws);

  const { roomId, peerId, displayName } = msg;

  const state: ClientState = { peerId, roomId, displayName };
  clientStates.set(ws, state);

  // Get existing peers before adding this one
  const existingPeers = getPeersInRoom(roomId).map((p) => ({
    id: p.id,
    displayName: p.displayName,
  }));

  // Add peer to room
  addPeerToRoom(roomId, { id: peerId, ws, displayName });

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

  broadcastToRoom(
    state.roomId,
    {
      type: 'chat',
      fromPeerId: state.peerId,
      displayName: state.displayName,
      text: msg.text,
      timestamp: Date.now(),
    },
    state.peerId
  );
}
