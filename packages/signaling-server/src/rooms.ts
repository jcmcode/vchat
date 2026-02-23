import type { WebSocket } from 'ws';

export interface Peer {
  id: string;
  ws: WebSocket;
  displayName: string;
}

export interface Room {
  id: string;
  peers: Map<string, Peer>;
  createdAt: number;
}

export const MAX_PEERS_PER_ROOM = 6;

const rooms = new Map<string, Room>();

export function createRoom(roomId: string): Room {
  const room: Room = {
    id: roomId,
    peers: new Map(),
    createdAt: Date.now(),
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
