import type SimplePeer from 'simple-peer';
import Peer from './simple-peer.js';
import { writable, get } from 'svelte/store';
import { SignalingClient } from '../signaling/client.js';
import { localStream, screenStream, isScreenSharing } from '../media/manager.js';
import { fetchIceServers } from '../stores/room.js';
import { deserialize, serialize, type DataChannelMessage } from './data-channel.js';
import { createSpeakingDetector } from '../media/audio-analysis.js';
import {
  initFileTransfer,
  handleFileMeta,
  handleFileChunk,
  handleFileAck,
  handleFileCancel,
  sendFile as ftSendFile,
  resetFileTransfers,
  dropRecipient,
  type FileTransferEntry,
} from './file-transfer.js';

export interface PeerConnection {
  id: string;
  displayName: string;
  peer: SimplePeer.Instance;
  stream: MediaStream | null;
  /** Session id: lets both sides tell signals for this connection apart from stale ones. */
  sid: string | null;
  initiator: boolean;
  connected: boolean;
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
export const admissionState = writable<'none' | 'waiting' | 'password' | 'denied'>('none');
export const admissionDeniedReason = writable<string>('');
export const passwordInvalid = writable<boolean>(false);
/** Fatal problem joining the room (room missing, full, ...). */
export const roomError = writable<string>('');
export const admissionRequests = writable<AdmissionRequest[]>([]);
export const hostStatus = writable<boolean>(false);
export const typingPeers = writable<Set<string>>(new Set());
export const reactions = writable<Reaction[]>([]);
export const speakingPeers = writable<Set<string>>(new Set());

const FATAL_ERRORS: Record<string, string> = {
  'Room does not exist': "This room doesn't exist (or everyone has left). Check the code or create a new room.",
  'Room is full': 'This room is full (6 people max).',
  'Peer ID already in use': 'You are already in this room in another tab.',
  'Too many people waiting to join': 'Too many people are waiting to join. Try again shortly.',
};

let iceServers: RTCIceServer[] = [];

let signalingClient: SignalingClient | null = null;
let localPeerId: string = '';
let localDisplayName: string = '';
let currentRoomId: string = '';
const unsubscribers: (() => void)[] = [];
const disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
const speakingDetectorCleanups = new Map<string, () => void>();
/** Display names as reported by the signaling server (trusted over names sent peer-to-peer). */
const knownNames = new Map<string, string>();
let localSpeakingCleanup: (() => void) | null = null;

function newSid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// Chat history lives in sessionStorage: it survives a refresh or reconnect,
// but disappears when the tab is closed (nothing persists after the call).
function chatKey(roomId: string): string {
  return `vchat_chat_${roomId}`;
}

function loadChatHistory(roomId: string): void {
  try {
    const saved = sessionStorage.getItem(chatKey(roomId));
    const msgs = saved ? (JSON.parse(saved) as ChatMessage[]) : [];
    chatMessages.set(
      msgs.slice(-500).map((m, i) => ({ ...m, id: m.id || `loaded_${i}_${m.timestamp}` }))
    );
  } catch {
    chatMessages.set([]);
  }
}

function saveChatHistory(roomId: string): void {
  try {
    const msgs = get(chatMessages).map(({ fileTransfer: _ft, ...m }) => m);
    sessionStorage.setItem(chatKey(roomId), JSON.stringify(msgs.slice(-500)));
  } catch {
    // ignore (quota, private mode)
  }
}

// Data channel helpers
function sendIfConnected(pc: PeerConnection, data: string): void {
  if (!pc.connected) return;
  try {
    pc.peer.send(data);
  } catch {
    // channel closed mid-send
  }
}

function broadcastToAllPeers(data: string): void {
  for (const [, pc] of get(peers)) sendIfConnected(pc, data);
}

function sendDataToPeer(peerId: string, data: string): void {
  const pc = get(peers).get(peerId);
  if (pc) sendIfConnected(pc, data);
}

function updatePeers(): void {
  peers.update((map) => new Map(map));
}

export interface JoinOptions {
  serverUrl: string;
  roomId: string;
  peerId: string;
  secret: string;
  displayName: string;
  isCreator?: boolean;
  password?: string;
}

export async function joinRoom(opts: JoinOptions): Promise<void> {
  const { serverUrl, roomId, peerId, secret, displayName, isCreator = false, password } = opts;
  localPeerId = peerId;
  localDisplayName = displayName;
  currentRoomId = roomId;
  connectionState.set('connecting');
  admissionState.set('none');
  admissionDeniedReason.set('');
  passwordInvalid.set(false);
  roomError.set('');
  admissionRequests.set([]);
  hostStatus.set(false);
  knownNames.clear();

  loadChatHistory(roomId);
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

  iceServers = await fetchIceServers();
  if (currentRoomId !== roomId) return; // left while we were fetching

  const client = new SignalingClient(serverUrl);
  signalingClient = client;
  const on = (type: string, handler: Parameters<SignalingClient['on']>[1]) =>
    unsubscribers.push(client.on(type, handler));

  on('connected', () => connectionState.set('connected'));
  on('disconnected', () => connectionState.set('disconnected'));

  on('room-peers', (event) => {
    admissionState.set('none');
    roomError.set('');
    const existingPeers = event.peers as { id: string; displayName: string }[];
    for (const p of existingPeers) {
      knownNames.set(p.id, p.displayName);
      createPeerConnection(p.id, p.displayName, true);
    }
  });

  on('peer-joined', (event) => {
    const { peerId: newPeerId, displayName: name } = event as unknown as { peerId: string; displayName: string };
    knownNames.set(newPeerId, name);
    // The newcomer sends the offer; we wait for it.
    createPeerConnection(newPeerId, name, false);
  });

  on('peer-left', (event) => {
    const { peerId: leftPeerId } = event as unknown as { peerId: string };
    destroyPeerConnection(leftPeerId);
  });

  on('signal', (event) => {
    const { fromPeerId, signal } = event as unknown as { fromPeerId: string; signal: unknown };
    handleSignal(fromPeerId, signal);
  });

  on('host-changed', (event) => {
    const { hostPeerId } = event as unknown as { hostPeerId: string };
    hostStatus.set(hostPeerId === localPeerId);
    if (hostPeerId !== localPeerId) admissionRequests.set([]);
  });

  on('waiting-for-admission', () => admissionState.set('waiting'));
  on('admission-granted', () => admissionState.set('none'));

  on('admission-denied', (event) => {
    const { reason } = event as { reason?: string };
    admissionDeniedReason.set(reason ?? '');
    admissionState.set('denied');
  });

  on('admission-request', (event) => {
    const { peerId: reqPeerId, displayName: reqName } = event as unknown as AdmissionRequest;
    admissionRequests.update((reqs) => [
      ...reqs.filter((r) => r.peerId !== reqPeerId),
      { peerId: reqPeerId, displayName: reqName },
    ]);
  });

  on('admission-cancelled', (event) => {
    const { peerId: reqPeerId } = event as unknown as { peerId: string };
    admissionRequests.update((reqs) => reqs.filter((r) => r.peerId !== reqPeerId));
  });

  on('password-required', (event) => {
    passwordInvalid.set(!!event.invalid);
    admissionState.set('password');
  });

  on('error', (event) => {
    const message = String(event.message ?? '');
    const friendly = FATAL_ERRORS[message] ?? (message.startsWith('Invalid roomId') ? 'That room code is not valid.' : '');
    if (friendly) roomError.set(friendly);
    else console.warn('Signaling error:', message);
  });

  client.enterRoom({ roomId, peerId, displayName, secret, password, isCreator });
  client.connect();
}

export function submitRoomPassword(password: string): void {
  passwordInvalid.set(false);
  admissionState.set('none');
  signalingClient?.retryWithPassword(password);
}

export function leaveRoom(): void {
  for (const cleanup of speakingDetectorCleanups.values()) cleanup();
  speakingDetectorCleanups.clear();
  if (localSpeakingCleanup) {
    localSpeakingCleanup();
    localSpeakingCleanup = null;
  }

  if (currentRoomId) saveChatHistory(currentRoomId);
  currentRoomId = '';

  for (const timer of disconnectTimers.values()) clearTimeout(timer);
  disconnectTimers.clear();
  for (const timer of typingTimers.values()) clearTimeout(timer);
  typingTimers.clear();

  const peerMap = get(peers);
  peers.set(new Map());
  for (const [, pc] of peerMap) pc.peer.destroy();

  for (const unsub of unsubscribers) unsub();
  unsubscribers.length = 0;

  if (signalingClient) {
    signalingClient.leaveRoom();
    signalingClient.disconnect();
    signalingClient = null;
  }

  cleanupMixedAudio();
  screenShareActive = false;
  pendingTrackReplacements.clear();
  resetFileTransfers();

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
      if (typeof msg.text !== 'string' || !msg.text.trim()) break;
      chatMessages.update((msgs) => [
        ...msgs,
        {
          id: nextMsgId(),
          fromPeerId,
          // Use the server-verified name; peers can't impersonate each other in chat.
          displayName: knownNames.get(fromPeerId) ?? String(msg.displayName ?? 'Peer').slice(0, 30),
          text: msg.text.slice(0, 5000),
          timestamp: Date.now(),
          isLocal: false,
        },
      ]);
      if (currentRoomId) saveChatHistory(currentRoomId);

      // Clear typing indicator for this peer
      typingPeers.update((s) => {
        const next = new Set(s);
        next.delete(fromPeerId);
        return next;
      });
      break;
    }
    case 'typing': {
      const pid = fromPeerId;
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
      if (typeof msg.emoji !== 'string' || msg.emoji.length > 16) break;
      const id = `${Date.now()}_${Math.random()}`;
      reactions.update((r) => [
        ...r,
        {
          emoji: msg.emoji,
          fromPeerId,
          displayName: knownNames.get(fromPeerId) ?? 'Peer',
          timestamp: Date.now(),
          id,
        },
      ]);
      setTimeout(() => {
        reactions.update((r) => r.filter((x) => x.id !== id));
      }, 2500);
      break;
    }
    case 'file-meta':
      handleFileMeta({ ...msg, fromPeerId, displayName: knownNames.get(fromPeerId) ?? 'Peer' });
      break;
    case 'file-chunk':
      handleFileChunk(msg, fromPeerId);
      break;
    case 'file-ack':
      handleFileAck(msg, fromPeerId);
      break;
    case 'file-cancel':
      handleFileCancel(msg, fromPeerId);
      break;
  }
}

// Track replacement for screen sharing
const pendingTrackReplacements = new Map<string, MediaStreamTrack | null>();
let screenShareActive = false;

// Audio mixing for screen share audio + mic
let mixedAudioCtx: AudioContext | null = null;
let mixedAudioDest: MediaStreamAudioDestinationNode | null = null;

function createMixedAudioTrack(micStream: MediaStream, screen: MediaStream): MediaStreamTrack {
  mixedAudioCtx = new AudioContext();
  mixedAudioDest = mixedAudioCtx.createMediaStreamDestination();

  const micSource = mixedAudioCtx.createMediaStreamSource(micStream);
  const screenSource = mixedAudioCtx.createMediaStreamSource(screen);

  micSource.connect(mixedAudioDest);
  screenSource.connect(mixedAudioDest);

  return mixedAudioDest.stream.getAudioTracks()[0];
}

function cleanupMixedAudio(): void {
  if (mixedAudioCtx) {
    mixedAudioCtx.close();
    mixedAudioCtx = null;
    mixedAudioDest = null;
  }
}

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

  // Mix screen audio with mic so peers hear both voice and shared audio
  const screenAudioTracks = screen.getAudioTracks();
  if (screenAudioTracks.length > 0) {
    const mic = get(localStream);
    if (mic) {
      const mixedTrack = createMixedAudioTrack(mic, screen);
      replaceTrackOnAllPeers(mixedTrack, 'audio');
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

  // Revert audio to mic-only
  cleanupMixedAudio();
  const micAudioTrack = camera?.getAudioTracks()[0];
  if (micAudioTrack) {
    replaceTrackOnAllPeers(micAudioTrack, 'audio');
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
      // Use mixed audio (mic + screen) if available, otherwise mic-only
      if (mixedAudioDest) {
        for (const track of mixedAudioDest.stream.getAudioTracks()) {
          combined.addTrack(track);
        }
      } else if (camera) {
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

/** Route an incoming signal to the right connection, (re)creating it when the remote starts a new session. */
function handleSignal(fromPeerId: string, raw: unknown): void {
  const envelope = raw as { sid?: unknown; data?: SimplePeer.SignalData } | null;
  if (!envelope || typeof envelope.sid !== 'string' || !envelope.data) return;
  const { sid, data } = envelope;
  const isOffer = (data as { type?: string }).type === 'offer';
  const pc = get(peers).get(fromPeerId);

  const feed = (target: PeerConnection) => {
    try {
      target.peer.signal(data);
    } catch (err) {
      console.warn('Ignoring bad signal:', err);
    }
  };

  if (pc && pc.sid === sid) {
    feed(pc);
    return;
  }
  if (pc && pc.sid === null && !pc.initiator && isOffer) {
    pc.sid = sid; // first offer for a connection we were expecting
    feed(pc);
    return;
  }
  if (!isOffer) return; // leftover candidate/answer from a connection we've already replaced

  // The remote restarted the connection. If we restarted at the same moment ("glare"),
  // the peer with the smaller id wins and the other side yields.
  if (pc && pc.initiator && !pc.connected && localPeerId < fromPeerId) return;

  const name = pc?.displayName ?? knownNames.get(fromPeerId) ?? 'Peer';
  feed(createPeerConnection(fromPeerId, name, false, sid));
}

function createPeerConnection(
  remotePeerId: string,
  remoteDisplayName: string,
  initiator: boolean,
  sid: string | null = initiator ? newSid() : null
): PeerConnection {
  teardownPeer(remotePeerId);

  const peer = new Peer({
    initiator,
    stream: getStreamForNewPeer(),
    trickle: true,
    config: { iceServers },
  });

  const pc: PeerConnection = {
    id: remotePeerId,
    displayName: remoteDisplayName,
    peer,
    stream: null,
    sid,
    initiator,
    connected: false,
  };

  // Events from a connection we've since replaced must not touch the new one.
  const isCurrent = () => get(peers).get(remotePeerId)?.peer === peer;

  peer.on('signal', (data) => {
    if (!isCurrent() || !pc.sid) return;
    signalingClient?.sendSignal(remotePeerId, { sid: pc.sid, data });
  });

  peer.on('connect', () => {
    if (!isCurrent()) return;
    pc.connected = true;
    const pendingTrack = pendingTrackReplacements.get(remotePeerId);
    if (pendingTrack !== undefined) {
      pendingTrackReplacements.delete(remotePeerId);
      replaceVideoTrack(pc, pendingTrack);
    }
    updatePeers();
  });

  peer.on('data', (data: Uint8Array | string) => {
    if (!isCurrent()) return;
    const str = typeof data === 'string' ? data : new TextDecoder().decode(data);
    const msg = deserialize(str);
    if (msg) handleDataChannelMessage(remotePeerId, msg);
  });

  peer.on('stream', (remoteStream: MediaStream) => {
    if (!isCurrent()) return;
    pc.stream = remoteStream;
    updatePeers();

    if (remoteStream.getAudioTracks().length > 0) {
      speakingDetectorCleanups.get(remotePeerId)?.();
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
    if (isCurrent()) destroyPeerConnection(remotePeerId);
  });

  peer.on('error', (err: Error) => {
    if (!isCurrent()) return;
    console.warn(`Connection error with ${remoteDisplayName}:`, err.message);
    // Try again rather than silently dropping the person from the call.
    reconnectPeer(remotePeerId, remoteDisplayName);
  });

  // ICE connection state monitoring → automatic recovery
  const rtcPc = (peer as unknown as { _pc?: RTCPeerConnection })._pc;
  rtcPc?.addEventListener('iceconnectionstatechange', () => {
    if (!isCurrent()) return;
    const state = rtcPc.iceConnectionState;
    const clearTimer = () => {
      const timer = disconnectTimers.get(remotePeerId);
      if (timer) clearTimeout(timer);
      disconnectTimers.delete(remotePeerId);
    };

    if (state === 'connected' || state === 'completed') {
      clearTimer();
    } else if (state === 'disconnected') {
      clearTimer();
      // "disconnected" often recovers on its own; give it a few seconds first.
      disconnectTimers.set(
        remotePeerId,
        setTimeout(() => {
          disconnectTimers.delete(remotePeerId);
          if (isCurrent()) reconnectPeer(remotePeerId, remoteDisplayName);
        }, 5000)
      );
    } else if (state === 'failed') {
      clearTimer();
      reconnectPeer(remotePeerId, remoteDisplayName);
    }
  });

  peers.update((map) => new Map(map).set(remotePeerId, pc));
  return pc;
}

const reconnectAttempts = new Map<string, number[]>();

function reconnectPeer(remotePeerId: string, remoteDisplayName: string): void {
  // Back off if a connection keeps failing (e.g. no TURN and a strict NAT): max 5 tries/minute.
  const now = Date.now();
  const recent = (reconnectAttempts.get(remotePeerId) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= 5) {
    console.warn(`Giving up reconnecting to ${remoteDisplayName} for now`);
    destroyPeerConnection(remotePeerId);
    return;
  }
  reconnectAttempts.set(remotePeerId, [...recent, now]);
  console.warn(`Reconnecting to ${remoteDisplayName}`);
  createPeerConnection(remotePeerId, remoteDisplayName, true);
}

/** Stop everything attached to a peer's current connection, but keep its entry in the store. */
function teardownPeer(remotePeerId: string): void {
  const timer = disconnectTimers.get(remotePeerId);
  if (timer) clearTimeout(timer);
  disconnectTimers.delete(remotePeerId);

  speakingDetectorCleanups.get(remotePeerId)?.();
  speakingDetectorCleanups.delete(remotePeerId);

  const pc = get(peers).get(remotePeerId);
  if (pc) {
    // Detach first so the old peer's async 'close' event is recognised as stale.
    peers.update((map) => {
      const next = new Map(map);
      next.delete(remotePeerId);
      return next;
    });
    pc.peer.destroy();
  }
}

function destroyPeerConnection(remotePeerId: string): void {
  teardownPeer(remotePeerId);
  pendingTrackReplacements.delete(remotePeerId);
  dropRecipient(remotePeerId);

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
}
