import type { WebSocket } from 'ws';

export interface Peer {
  id: string;
  ws: WebSocket;
  displayName: string;
}

export interface WaitingPeer {
  id: string;
  ws: WebSocket;
  displayName: string;
  joinedWaitingAt: number;
}

export interface Room {
  id: string;
  peers: Map<string, Peer>;
  createdAt: number;
  hostPeerId: string | null;
  passwordHash: string | null;
  waitingQueue: Map<string, WaitingPeer>;
}

export const MAX_PEERS_PER_ROOM = 6;
const WAITING_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

const rooms = new Map<string, Room>();

export function createRoom(roomId: string, hostPeerId?: string, passwordHash?: string): Room {
  const room: Room = {
    id: roomId,
    peers: new Map(),
    createdAt: Date.now(),
    hostPeerId: hostPeerId ?? null,
    passwordHash: passwordHash ?? null,
    waitingQueue: new Map(),
  };
  rooms.set(roomId, room);
  return room;
}

export function getRoom(roomId: string): Room | undefined {
  return rooms.get(roomId);
}

export function getOrCreateRoom(roomId: string): Room {
  return rooms.get(roomId) ?? createRoom(roomId);
}

export function addPeerToRoom(roomId: string, peer: Peer): boolean {
  const room = getOrCreateRoom(roomId);
  if (room.peers.size >= MAX_PEERS_PER_ROOM) {
    return false;
  }
  room.peers.set(peer.id, peer);
  return true;
}

export function removePeerFromRoom(roomId: string, peerId: string): void {
  const room = rooms.get(roomId);
  if (!room) return;

  room.peers.delete(peerId);

  // Host left — promote next peer
  if (room.hostPeerId === peerId) {
    const nextPeer = room.peers.values().next().value as Peer | undefined;
    if (nextPeer) {
      room.hostPeerId = nextPeer.id;
      // Notify room about new host
      broadcastToRoom(roomId, { type: 'host-changed', hostPeerId: nextPeer.id });
      // Re-send all waiting admission requests to new host
      for (const wp of room.waitingQueue.values()) {
        sendToPeer(roomId, nextPeer.id, {
          type: 'admission-request',
          peerId: wp.id,
          displayName: wp.displayName,
        });
      }
    } else {
      room.hostPeerId = null;
      // Room empty — deny all waiting peers
      for (const wp of room.waitingQueue.values()) {
        if (wp.ws.readyState === wp.ws.OPEN) {
          wp.ws.send(JSON.stringify({
            type: 'admission-denied',
            roomId,
            reason: 'Room closed',
          }));
        }
      }
      room.waitingQueue.clear();
    }
  }

  // Clean up empty rooms
  if (room.peers.size === 0) {
    rooms.delete(roomId);
  }
}

export function getPeersInRoom(roomId: string): Peer[] {
  const room = rooms.get(roomId);
  if (!room) return [];
  return Array.from(room.peers.values());
}

export function broadcastToRoom(
  roomId: string,
  message: object,
  excludePeerId?: string
): void {
  const room = rooms.get(roomId);
  if (!room) return;

  const data = JSON.stringify(message);
  for (const [id, peer] of room.peers) {
    if (id !== excludePeerId && peer.ws.readyState === peer.ws.OPEN) {
      peer.ws.send(data);
    }
  }
}

export function sendToPeer(roomId: string, peerId: string, message: object): void {
  const room = rooms.get(roomId);
  if (!room) return;

  const peer = room.peers.get(peerId);
  if (peer && peer.ws.readyState === peer.ws.OPEN) {
    peer.ws.send(JSON.stringify(message));
  }
}

export function addToWaitingQueue(roomId: string, wp: WaitingPeer): void {
  const room = rooms.get(roomId);
  if (!room) return;
  room.waitingQueue.set(wp.id, wp);

  // Auto-deny after timeout
  setTimeout(() => {
    const r = rooms.get(roomId);
    if (!r) return;
    const waiting = r.waitingQueue.get(wp.id);
    if (waiting) {
      r.waitingQueue.delete(wp.id);
      if (waiting.ws.readyState === waiting.ws.OPEN) {
        waiting.ws.send(JSON.stringify({
          type: 'admission-denied',
          roomId,
          reason: 'Timed out waiting for host',
        }));
      }
    }
  }, WAITING_TIMEOUT_MS);
}

export function removeFromWaitingQueue(roomId: string, peerId: string): WaitingPeer | undefined {
  const room = rooms.get(roomId);
  if (!room) return undefined;
  const wp = room.waitingQueue.get(peerId);
  if (wp) {
    room.waitingQueue.delete(peerId);
  }
  return wp;
}

export function getWaitingPeers(roomId: string): WaitingPeer[] {
  const room = rooms.get(roomId);
  if (!room) return [];
  return Array.from(room.waitingQueue.values());
}

export function getRoomCount(): number {
  return rooms.size;
}

export function getTotalPeerCount(): number {
  let count = 0;
  for (const room of rooms.values()) {
    count += room.peers.size;
  }
  return count;
}
