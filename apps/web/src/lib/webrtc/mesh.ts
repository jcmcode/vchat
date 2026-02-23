import SimplePeer from 'simple-peer';
import { writable, get } from 'svelte/store';
import { SignalingClient } from '../signaling/client.js';
import { localStream, screenStream, isScreenSharing } from '../media/manager.js';
import { getTurnConfig } from '../stores/room.js';

export interface PeerConnection {
  id: string;
  displayName: string;
  peer: SimplePeer.Instance;
  stream: MediaStream | null;
}

export interface ChatMessage {
  fromPeerId: string;
  displayName: string;
  text: string;
  timestamp: number;
  isLocal: boolean;
}

export const peers = writable<Map<string, PeerConnection>>(new Map());
export const chatMessages = writable<ChatMessage[]>([]);
export const connectionState = writable<'disconnected' | 'connecting' | 'connected'>('disconnected');

let iceServers: RTCIceServer[] = [];

let signalingClient: SignalingClient | null = null;
let localPeerId: string = '';
let localDisplayName: string = '';
let currentRoomId: string = '';
const unsubscribers: (() => void)[] = [];
const disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

function buildIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];
  const turn = getTurnConfig();
  if (turn && turn.url) {
    servers.push({ urls: turn.url, username: turn.username, credential: turn.credential });
  }
  return servers;
}

export function joinRoom(
  serverUrl: string,
  roomId: string,
  peerId: string,
  displayName: string
): void {
  localPeerId = peerId;
  localDisplayName = displayName;
  currentRoomId = roomId;
  iceServers = buildIceServers();
  connectionState.set('connecting');

  signalingClient = new SignalingClient(serverUrl);

  unsubscribers.push(
    signalingClient.on('connected', () => {
      connectionState.set('connected');
      signalingClient!.joinRoom(roomId, peerId, displayName);
    })
  );

  unsubscribers.push(
    signalingClient.on('disconnected', () => {
      connectionState.set('disconnected');
    })
  );

  unsubscribers.push(
    signalingClient.on('room-peers', (event) => {
      const existingPeers = event.peers as { id: string; displayName: string }[];
      // Initiate connections to all existing peers (we are the initiator)
      for (const p of existingPeers) {
        createPeerConnection(p.id, p.displayName, true);
      }
    })
  );

  unsubscribers.push(
    signalingClient.on('peer-joined', (event) => {
      const { peerId: newPeerId, displayName: name } = event as {
        peerId: string;
        displayName: string;
        type: string;
      };
      // New peer joins — they will initiate, we wait
      // (but we create the peer object to be ready)
      createPeerConnection(newPeerId, name, false);
    })
  );

  unsubscribers.push(
    signalingClient.on('peer-left', (event) => {
      const { peerId: leftPeerId } = event as { peerId: string; type: string };
      destroyPeerConnection(leftPeerId);
    })
  );

  unsubscribers.push(
    signalingClient.on('signal', (event) => {
      const { fromPeerId, signal } = event as {
        fromPeerId: string;
        signal: SimplePeer.SignalData;
        type: string;
      };
      const peerMap = get(peers);
      const pc = peerMap.get(fromPeerId);
      if (pc) {
        pc.peer.signal(signal);
      }
    })
  );

  unsubscribers.push(
    signalingClient.on('chat', (event) => {
      const { fromPeerId, displayName: name, text, timestamp } = event as {
        fromPeerId: string;
        displayName: string;
        text: string;
        timestamp: number;
        type: string;
      };
      chatMessages.update((msgs) => [
        ...msgs,
        { fromPeerId, displayName: name, text, timestamp, isLocal: false },
      ]);
    })
  );

  signalingClient.connect();
}

export function leaveRoom(): void {
  // Clean up disconnect timers
  for (const timer of disconnectTimers.values()) {
    clearTimeout(timer);
  }
  disconnectTimers.clear();

  // Clean up all peer connections
  const peerMap = get(peers);
  for (const [, pc] of peerMap) {
    pc.peer.destroy();
  }
  peers.set(new Map());

  // Clean up signaling
  for (const unsub of unsubscribers) {
    unsub();
  }
  unsubscribers.length = 0;

  if (signalingClient) {
    signalingClient.leaveRoom();
    signalingClient.disconnect();
    signalingClient = null;
  }

  chatMessages.set([]);
  connectionState.set('disconnected');
}

export function sendChatMessage(text: string): void {
  if (!signalingClient || !text.trim()) return;

  signalingClient.sendChat(text);
  chatMessages.update((msgs) => [
    ...msgs,
    {
      fromPeerId: localPeerId,
      displayName: localDisplayName,
      text,
      timestamp: Date.now(),
      isLocal: true,
    },
  ]);
}

// Pending track replacements to retry when peer connects
const pendingTrackReplacements = new Map<string, MediaStreamTrack | null>();
let screenShareActive = false;

function replaceVideoTrack(pc: PeerConnection, newTrack: MediaStreamTrack | null): boolean {
  try {
    const rtcPc = (pc.peer as unknown as { _pc: RTCPeerConnection })._pc;
    if (rtcPc) {
      const videoSender = rtcPc.getSenders().find((s) => s.track?.kind === 'video');
      if (videoSender) {
        videoSender.replaceTrack(newTrack);
        return true;
      }
    }
  } catch (e) {
    console.warn(`replaceVideoTrack failed for ${pc.id}, queuing retry:`, e);
  }

  // Fallback: try simple-peer's removeTrack/addTrack
  try {
    const currentStream = get(localStream);
    if (currentStream) {
      const oldVideoTrack = currentStream.getVideoTracks()[0];
      if (oldVideoTrack) {
        pc.peer.removeTrack(oldVideoTrack, currentStream);
      }
    }
    if (newTrack) {
      const stream = new MediaStream([newTrack]);
      pc.peer.addTrack(newTrack, stream);
    }
    return true;
  } catch (e) {
    console.warn(`replaceVideoTrack fallback also failed for ${pc.id}:`, e);
  }

  return false;
}

export function startSharingScreen(): void {
  const screen = get(screenStream);
  if (!screen) return;

  const screenVideoTrack = screen.getVideoTracks()[0];
  if (!screenVideoTrack) return;

  screenShareActive = true;
  pendingTrackReplacements.clear();

  const peerMap = get(peers);
  for (const [id, pc] of peerMap) {
    if (!replaceVideoTrack(pc, screenVideoTrack)) {
      // Queue for retry when peer connects
      pendingTrackReplacements.set(id, screenVideoTrack);
    }
  }
}

export function stopSharingScreen(): void {
  // Idempotency guard: don't run if already stopped
  if (!screenShareActive) return;
  screenShareActive = false;
  pendingTrackReplacements.clear();

  const camera = get(localStream);
  const cameraVideoTrack = camera?.getVideoTracks()[0] ?? null;

  const peerMap = get(peers);
  for (const [, pc] of peerMap) {
    replaceVideoTrack(pc, cameraVideoTrack);
  }
}

function getStreamForNewPeer(): MediaStream | undefined {
  // If screen sharing, build a stream with the screen video track + camera audio track
  if (get(isScreenSharing)) {
    const screen = get(screenStream);
    const camera = get(localStream);
    if (screen) {
      const combined = new MediaStream();
      // Use screen video
      for (const track of screen.getVideoTracks()) {
        combined.addTrack(track);
      }
      // Use camera audio
      if (camera) {
        for (const track of camera.getAudioTracks()) {
          combined.addTrack(track);
        }
      }
      return combined;
    }
  }
  const stream = get(localStream);
  return stream ?? undefined;
}

function createPeerConnection(
  remotePeerId: string,
  remoteDisplayName: string,
  initiator: boolean
): void {
  // Destroy existing connection if any (e.g. on reconnect)
  const existingMap = get(peers);
  const existing = existingMap.get(remotePeerId);
  if (existing) {
    existing.peer.destroy();
  }

  const stream = getStreamForNewPeer();

  const peer = new SimplePeer({
    initiator,
    stream,
    trickle: true,
    config: { iceServers },
  });

  const pc: PeerConnection = {
    id: remotePeerId,
    displayName: remoteDisplayName,
    peer,
    stream: null,
  };

  peer.on('signal', (signal) => {
    signalingClient?.sendSignal(remotePeerId, signal);
  });

  // Retry any pending track replacements once the peer connects
  peer.on('connect', () => {
    const pendingTrack = pendingTrackReplacements.get(remotePeerId);
    if (pendingTrack !== undefined) {
      pendingTrackReplacements.delete(remotePeerId);
      replaceVideoTrack(pc, pendingTrack);
    }
  });

  peer.on('stream', (remoteStream) => {
    pc.stream = remoteStream;
    peers.update((map) => {
      const updated = new Map(map);
      updated.set(remotePeerId, { ...pc, stream: remoteStream });
      return updated;
    });
  });

  peer.on('close', () => {
    destroyPeerConnection(remotePeerId);
  });

  peer.on('error', (err) => {
    console.error(`Peer connection error with ${remoteDisplayName}:`, err.message);
    destroyPeerConnection(remotePeerId);
  });

  // ICE connection state monitoring for recovery
  try {
    const rtcPc = (peer as unknown as { _pc: RTCPeerConnection })._pc;
    if (rtcPc) {
      rtcPc.addEventListener('iceconnectionstatechange', () => {
        const state = rtcPc.iceConnectionState;

        if (state === 'connected' || state === 'completed') {
          // Connection recovered — clear any pending disconnect timer
          const timer = disconnectTimers.get(remotePeerId);
          if (timer) {
            clearTimeout(timer);
            disconnectTimers.delete(remotePeerId);
          }
        } else if (state === 'disconnected') {
          // Give it 5 seconds to recover before treating as failed
          const timer = setTimeout(() => {
            disconnectTimers.delete(remotePeerId);
            console.warn(`Peer ${remoteDisplayName} disconnected — reconnecting`);
            reconnectPeer(remotePeerId, remoteDisplayName);
          }, 5000);
          disconnectTimers.set(remotePeerId, timer);
        } else if (state === 'failed') {
          // Clear any pending timer and reconnect immediately
          const timer = disconnectTimers.get(remotePeerId);
          if (timer) {
            clearTimeout(timer);
            disconnectTimers.delete(remotePeerId);
          }
          console.warn(`Peer ${remoteDisplayName} ICE failed — reconnecting`);
          reconnectPeer(remotePeerId, remoteDisplayName);
        }
      });
    }
  } catch {
    // _pc may not be available yet; ICE monitoring is best-effort
  }

  peers.update((map) => {
    const updated = new Map(map);
    updated.set(remotePeerId, pc);
    return updated;
  });
}

function reconnectPeer(remotePeerId: string, remoteDisplayName: string): void {
  const peerMap = get(peers);
  const existing = peerMap.get(remotePeerId);
  if (existing) {
    existing.peer.destroy();
  }
  // Re-create as initiator since we detected the failure
  createPeerConnection(remotePeerId, remoteDisplayName, true);
}

function destroyPeerConnection(remotePeerId: string): void {
  const timer = disconnectTimers.get(remotePeerId);
  if (timer) {
    clearTimeout(timer);
    disconnectTimers.delete(remotePeerId);
  }

  const peerMap = get(peers);
  const pc = peerMap.get(remotePeerId);
  if (pc) {
    pc.peer.destroy();
  }
  peers.update((map) => {
    const updated = new Map(map);
    updated.delete(remotePeerId);
    return updated;
  });
}
