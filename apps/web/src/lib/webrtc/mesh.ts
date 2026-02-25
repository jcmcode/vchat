import SimplePeer from 'simple-peer';
import { writable, get } from 'svelte/store';
import { SignalingClient } from '../signaling/client.js';
import { localStream, screenStream, isScreenSharing } from '../media/manager.js';
import { getTurnConfig } from '../stores/room.js';
import { deserialize, serialize, type DataChannelMessage } from './data-channel.js';
import { createSpeakingDetector } from '../media/audio-analysis.js';
import {
  initFileTransfer,
  handleFileMeta,
  handleFileChunk,
  handleFileAck,
  handleFileCancel,
  sendFile as ftSendFile,
  type FileTransferEntry,
} from './file-transfer.js';

export interface PeerConnection {
  id: string;
  displayName: string;
  peer: SimplePeer.Instance;
  stream: MediaStream | null;
}

export interface ChatMessage {
  id: string;
  fromPeerId: string;
  displayName: string;
  text: string;
  timestamp: number;
  isLocal: boolean;
  fileTransfer?: FileTransferEntry;
}

let msgCounter = 0;
function nextMsgId(): string {
  return `msg_${Date.now()}_${++msgCounter}`;
}

export interface Reaction {
  emoji: string;
  fromPeerId: string;
  displayName: string;
  timestamp: number;
  id: string;
}

export interface AdmissionRequest {
  peerId: string;
  displayName: string;
}

export const peers = writable<Map<string, PeerConnection>>(new Map());
export const chatMessages = writable<ChatMessage[]>([]);
export const connectionState = writable<'disconnected' | 'connecting' | 'connected'>('disconnected');
export const admissionState = writable<'none' | 'waiting' | 'denied'>('none');
export const admissionRequests = writable<AdmissionRequest[]>([]);
export const hostStatus = writable<boolean>(false);
export const typingPeers = writable<Set<string>>(new Set());
export const reactions = writable<Reaction[]>([]);
export const speakingPeers = writable<Set<string>>(new Set());

let iceServers: RTCIceServer[] = [];

let signalingClient: SignalingClient | null = null;
let localPeerId: string = '';
let localDisplayName: string = '';
let currentRoomId: string = '';
const unsubscribers: (() => void)[] = [];
const disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
const speakingDetectorCleanups = new Map<string, () => void>();
let localSpeakingCleanup: (() => void) | null = null;

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

// Chat persistence
function loadChatHistory(roomId: string): void {
  try {
    const key = `vchat_chat_${roomId}`;
    const saved = localStorage.getItem(key);
    if (saved) {
      const msgs = (JSON.parse(saved) as ChatMessage[]).map((m, i) => ({
        ...m,
        id: m.id || `loaded_${i}_${m.timestamp}`,
      }));
      chatMessages.set(msgs.slice(-500));
    }
  } catch {
    // ignore
  }
}

function saveChatHistory(roomId: string): void {
  try {
    const key = `vchat_chat_${roomId}`;
    const msgs = get(chatMessages);
    localStorage.setItem(key, JSON.stringify(msgs.slice(-500)));
  } catch {
    // ignore
  }
}

// Data channel helpers
function broadcastToAllPeers(data: string): void {
  const peerMap = get(peers);
  for (const [, pc] of peerMap) {
    try {
      pc.peer.send(data);
    } catch {
      // peer may not be connected yet
    }
  }
}

function sendDataToPeer(peerId: string, data: string): void {
  const peerMap = get(peers);
  const pc = peerMap.get(peerId);
  if (pc) {
    try {
      pc.peer.send(data);
    } catch {
      // peer not connected
    }
  }
}

export function joinRoom(
  serverUrl: string,
  roomId: string,
  peerId: string,
  displayName: string,
  isCreator = false,
  password?: string
): void {
  localPeerId = peerId;
  localDisplayName = displayName;
  currentRoomId = roomId;
  iceServers = buildIceServers();
  connectionState.set('connecting');
  admissionState.set('none');
  admissionRequests.set([]);
  hostStatus.set(false);

  // Load chat history
  loadChatHistory(roomId);

  // Init file transfer
  initFileTransfer(sendDataToPeer, broadcastToAllPeers);

  // Attach speaking detector to local stream
  const stream = get(localStream);
  if (stream && stream.getAudioTracks().length > 0) {
    localSpeakingCleanup = createSpeakingDetector(stream, (isSpeaking) => {
      speakingPeers.update((s) => {
        const next = new Set(s);
        if (isSpeaking) next.add('local');
        else next.delete('local');
        return next;
      });
    });
  }

  signalingClient = new SignalingClient(serverUrl);

  unsubscribers.push(
    signalingClient.on('connected', () => {
      connectionState.set('connected');
      if (isCreator) {
        signalingClient!.createRoom(roomId, peerId, displayName, password);
      } else {
        signalingClient!.joinRoom(roomId, peerId, displayName, password);
      }
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

  // Host/admission handlers
  unsubscribers.push(
    signalingClient.on('host-changed', (event) => {
      const { hostPeerId } = event as { hostPeerId: string; type: string };
      hostStatus.set(hostPeerId === localPeerId);
    })
  );

  unsubscribers.push(
    signalingClient.on('waiting-for-admission', () => {
      admissionState.set('waiting');
    })
  );

  unsubscribers.push(
    signalingClient.on('admission-granted', () => {
      admissionState.set('none');
    })
  );

  unsubscribers.push(
    signalingClient.on('admission-denied', (event) => {
      const { reason } = event as { reason?: string; type: string };
      admissionState.set('denied');
      console.log('Admission denied:', reason);
    })
  );

  unsubscribers.push(
    signalingClient.on('admission-request', (event) => {
      const { peerId: reqPeerId, displayName: reqName } = event as {
        peerId: string;
        displayName: string;
        type: string;
      };
      admissionRequests.update((reqs) => [...reqs, { peerId: reqPeerId, displayName: reqName }]);
    })
  );

  unsubscribers.push(
    signalingClient.on('password-required', () => {
      // Emit as error for UI to handle
      admissionState.set('denied');
    })
  );

  signalingClient.connect();
}

export function leaveRoom(): void {
  // Clean up speaking detectors
  for (const cleanup of speakingDetectorCleanups.values()) {
    cleanup();
  }
  speakingDetectorCleanups.clear();
  if (localSpeakingCleanup) {
    localSpeakingCleanup();
    localSpeakingCleanup = null;
  }

  // Save chat before leaving
  if (currentRoomId) {
    saveChatHistory(currentRoomId);
  }

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

  // Don't clear chat messages — keep for persistence
  connectionState.set('disconnected');
  admissionState.set('none');
  admissionRequests.set([]);
  hostStatus.set(false);
  typingPeers.set(new Set());
  reactions.set([]);
  speakingPeers.set(new Set());
}

export function admitPeer(peerId: string): void {
  signalingClient?.admitPeer(peerId);
  admissionRequests.update((reqs) => reqs.filter((r) => r.peerId !== peerId));
}

export function denyPeer(peerId: string): void {
  signalingClient?.denyPeer(peerId);
  admissionRequests.update((reqs) => reqs.filter((r) => r.peerId !== peerId));
}

export function sendChatMessage(text: string): void {
  if (!text.trim()) return;

  const msg: DataChannelMessage = {
    type: 'chat',
    text,
    fromPeerId: localPeerId,
    displayName: localDisplayName,
    timestamp: Date.now(),
  };

  broadcastToAllPeers(serialize(msg));

  chatMessages.update((msgs) => [
    ...msgs,
    {
      id: nextMsgId(),
      fromPeerId: localPeerId,
      displayName: localDisplayName,
      text,
      timestamp: Date.now(),
      isLocal: true,
    },
  ]);

  if (currentRoomId) saveChatHistory(currentRoomId);
}

export function sendTypingIndicator(isTyping: boolean): void {
  const msg: DataChannelMessage = {
    type: 'typing',
    isTyping,
    fromPeerId: localPeerId,
  };
  broadcastToAllPeers(serialize(msg));
}

export function sendReaction(emoji: string): void {
  const msg: DataChannelMessage = {
    type: 'reaction',
    emoji,
    fromPeerId: localPeerId,
    displayName: localDisplayName,
    timestamp: Date.now(),
  };
  broadcastToAllPeers(serialize(msg));

  // Add locally too
  const id = `${Date.now()}_${Math.random()}`;
  reactions.update((r) => [...r, { emoji, fromPeerId: localPeerId, displayName: localDisplayName, timestamp: Date.now(), id }]);
  setTimeout(() => {
    reactions.update((r) => r.filter((x) => x.id !== id));
  }, 2500);
}

export function sendFileToRoom(file: File): string | null {
  const peerMap = get(peers);
  const peerIds = Array.from(peerMap.keys());
  return ftSendFile(file, peerIds, localPeerId, localDisplayName);
}

// Typing indicator timers
const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

function handleDataChannelMessage(fromPeerId: string, msg: DataChannelMessage): void {
  switch (msg.type) {
    case 'chat': {
      chatMessages.update((msgs) => [
        ...msgs,
        {
          id: nextMsgId(),
          fromPeerId: msg.fromPeerId,
          displayName: msg.displayName,
          text: msg.text,
          timestamp: msg.timestamp,
          isLocal: false,
        },
      ]);
      if (currentRoomId) saveChatHistory(currentRoomId);

      // Clear typing indicator for this peer
      typingPeers.update((s) => {
        const next = new Set(s);
        next.delete(msg.fromPeerId);
        return next;
      });
      break;
    }
    case 'typing': {
      const pid = msg.fromPeerId;
      if (msg.isTyping) {
        typingPeers.update((s) => new Set(s).add(pid));
        // Auto-clear after 3s
        const existing = typingTimers.get(pid);
        if (existing) clearTimeout(existing);
        typingTimers.set(pid, setTimeout(() => {
          typingPeers.update((s) => {
            const next = new Set(s);
            next.delete(pid);
            return next;
          });
          typingTimers.delete(pid);
        }, 3000));
      } else {
        typingPeers.update((s) => {
          const next = new Set(s);
          next.delete(pid);
          return next;
        });
        const existing = typingTimers.get(pid);
        if (existing) {
          clearTimeout(existing);
          typingTimers.delete(pid);
        }
      }
      break;
    }
    case 'reaction': {
      const id = `${Date.now()}_${Math.random()}`;
      reactions.update((r) => [...r, { ...msg, id }]);
      setTimeout(() => {
        reactions.update((r) => r.filter((x) => x.id !== id));
      }, 2500);
      break;
    }
    case 'file-meta':
      handleFileMeta(msg);
      break;
    case 'file-chunk':
      handleFileChunk(msg, fromPeerId);
      break;
    case 'file-ack':
      handleFileAck(msg, fromPeerId);
      break;
    case 'file-cancel':
      handleFileCancel(msg);
      break;
  }
}

// Track replacement for screen sharing
const pendingTrackReplacements = new Map<string, MediaStreamTrack | null>();
let screenShareActive = false;

function replaceVideoTrack(pc: PeerConnection, newTrack: MediaStreamTrack | null): boolean {
  try {
    const rtcPc = (pc.peer as unknown as { _pc: RTCPeerConnection })._pc;
    if (rtcPc) {
      // Use transceivers to reliably find the video sender even when track is null
      const transceiver = rtcPc.getTransceivers().find(
        (t) => t.sender.track?.kind === 'video' || t.receiver.track?.kind === 'video' || t.mid !== null && t.receiver.track === null && t.sender.track === null
      );
      const videoSender = transceiver?.sender ?? rtcPc.getSenders().find((s) => s.track?.kind === 'video');
      if (videoSender) {
        videoSender.replaceTrack(newTrack);
        return true;
      }
    }
  } catch (e) {
    console.warn(`replaceVideoTrack failed for ${pc.id}:`, e);
  }

  return false;
}

export function replaceTrackOnAllPeers(newTrack: MediaStreamTrack, kind: 'audio' | 'video'): void {
  const peerMap = get(peers);
  for (const [, pc] of peerMap) {
    try {
      const rtcPc = (pc.peer as unknown as { _pc: RTCPeerConnection })._pc;
      if (rtcPc) {
        // Use transceivers to find sender even when current track is null
        const transceiver = rtcPc.getTransceivers().find(
          (t) => t.sender.track?.kind === kind || t.receiver.track?.kind === kind
        );
        const sender = transceiver?.sender ?? rtcPc.getSenders().find((s) => s.track?.kind === kind);
        if (sender) {
          sender.replaceTrack(newTrack);
        }
      }
    } catch {
      // best effort
    }
  }
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
      pendingTrackReplacements.set(id, screenVideoTrack);
    }
  }
}

export function stopSharingScreen(): void {
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
  if (get(isScreenSharing)) {
    const screen = get(screenStream);
    const camera = get(localStream);
    if (screen) {
      const combined = new MediaStream();
      for (const track of screen.getVideoTracks()) {
        combined.addTrack(track);
      }
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

  peer.on('connect', () => {
    const pendingTrack = pendingTrackReplacements.get(remotePeerId);
    if (pendingTrack !== undefined) {
      pendingTrackReplacements.delete(remotePeerId);
      replaceVideoTrack(pc, pendingTrack);
    }
  });

  // Data channel messages
  peer.on('data', (data: Uint8Array | string) => {
    const str = typeof data === 'string' ? data : new TextDecoder().decode(data);
    const msg = deserialize(str);
    if (msg) {
      handleDataChannelMessage(remotePeerId, msg);
    }
  });

  peer.on('stream', (remoteStream) => {
    pc.stream = remoteStream;
    peers.update((map) => {
      const updated = new Map(map);
      updated.set(remotePeerId, { ...pc, stream: remoteStream });
      return updated;
    });

    // Attach speaking detector to remote stream
    if (remoteStream.getAudioTracks().length > 0) {
      // Clean up previous detector if any
      const prevCleanup = speakingDetectorCleanups.get(remotePeerId);
      if (prevCleanup) prevCleanup();

      const cleanup = createSpeakingDetector(remoteStream, (isSpeaking) => {
        speakingPeers.update((s) => {
          const next = new Set(s);
          if (isSpeaking) next.add(remotePeerId);
          else next.delete(remotePeerId);
          return next;
        });
      });
      speakingDetectorCleanups.set(remotePeerId, cleanup);
    }
  });

  peer.on('close', () => {
    destroyPeerConnection(remotePeerId);
  });

  peer.on('error', (err) => {
    console.error(`Peer connection error with ${remoteDisplayName}:`, err.message);
    destroyPeerConnection(remotePeerId);
  });

  // ICE connection state monitoring
  try {
    const rtcPc = (peer as unknown as { _pc: RTCPeerConnection })._pc;
    if (rtcPc) {
      rtcPc.addEventListener('iceconnectionstatechange', () => {
        const state = rtcPc.iceConnectionState;

        if (state === 'connected' || state === 'completed') {
          const timer = disconnectTimers.get(remotePeerId);
          if (timer) {
            clearTimeout(timer);
            disconnectTimers.delete(remotePeerId);
          }
        } else if (state === 'disconnected') {
          const timer = setTimeout(() => {
            disconnectTimers.delete(remotePeerId);
            console.warn(`Peer ${remoteDisplayName} disconnected — reconnecting`);
            reconnectPeer(remotePeerId, remoteDisplayName);
          }, 5000);
          disconnectTimers.set(remotePeerId, timer);
        } else if (state === 'failed') {
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
    // _pc may not be available yet
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
  createPeerConnection(remotePeerId, remoteDisplayName, true);
}

function destroyPeerConnection(remotePeerId: string): void {
  const timer = disconnectTimers.get(remotePeerId);
  if (timer) {
    clearTimeout(timer);
    disconnectTimers.delete(remotePeerId);
  }

  // Clean up speaking detector
  const cleanup = speakingDetectorCleanups.get(remotePeerId);
  if (cleanup) {
    cleanup();
    speakingDetectorCleanups.delete(remotePeerId);
  }

  // Clean up typing state
  typingPeers.update((s) => {
    const next = new Set(s);
    next.delete(remotePeerId);
    return next;
  });

  speakingPeers.update((s) => {
    const next = new Set(s);
    next.delete(remotePeerId);
    return next;
  });

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
