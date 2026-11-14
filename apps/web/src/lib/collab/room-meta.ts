// Room name: starts from the invite's label (or the name chosen when creating an open room) and
// can be changed by the host during the call. Shared peer-to-peer; only the host's rename counts.

import { get, writable } from 'svelte/store';
import {
  broadcastData,
  getLocalPeerId,
  hostPeerIdStore,
  onPeerConnected,
  onRoomLeft,
  registerDataHandler,
  sendData,
} from '../webrtc/mesh.js';

export const MAX_ROOM_NAME = 60;
export const roomName = writable('');
/** True once the host renamed the room in this call (so we tell newcomers). */
let renamedHere = false;

function clean(name: unknown): string {
  // eslint-disable-next-line no-control-regex
  return typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_ROOM_NAME) : '';
}

registerDataHandler('room-name', (fromPeerId, msg) => {
  if (fromPeerId !== get(hostPeerIdStore)) return; // only the host can rename
  roomName.set(clean(msg.name));
});

onPeerConnected((peerId) => {
  if (get(hostPeerIdStore) === getLocalPeerId() && (renamedHere || get(roomName))) {
    sendData(peerId, { type: 'room-name', name: get(roomName) });
  }
});

onRoomLeft(() => {
  renamedHere = false;
  roomName.set('');
});

/** Set the initial name (from the invite or room creation) without broadcasting. */
export function initRoomName(name: string | undefined): void {
  renamedHere = false;
  roomName.set(clean(name));
}

/** Host only: rename the room for everyone. */
export function renameRoom(name: string): void {
  if (get(hostPeerIdStore) !== getLocalPeerId()) return;
  renamedHere = true;
  roomName.set(clean(name));
  broadcastData({ type: 'room-name', name: get(roomName) });
}
