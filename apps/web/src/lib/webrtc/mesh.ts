import type SimplePeer from 'simple-peer';
import Peer from './simple-peer.js';
import { writable, get } from 'svelte/store';
import { SignalingClient } from '../signaling/client.js';
import { localStream, screenStream, isScreenSharing, audioEnabled, videoEnabled } from '../media/manager.js';
import { fetchIceServers } from '../stores/room.js';
import { deserialize, serialize, type AnyDataMessage, type DataChannelMessage } from './data-channel.js';
import { createSpeakingDetector } from '../media/audio-analysis.js';
import { readSdpIdentity } from './e2e-proof.js';
import { nameKey, stripInvisible } from './name-key.js';
import { LatestSender } from './latest-sender.js';
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
  /**
   * Media and data flow only once this is true: the connection was verified end to end (or the
   * user explicitly allowed it, or this tab has no room key to verify with). Until then our
   * camera/mic are held back and nothing they send is shown or played.
   */
  trusted: boolean;
  /** Remote DTLS fingerprint + ICE ufrag, pinned from the first remote description. */
  pinned: { fingerprint: string; ufrag: string } | null;
  /** Tracks we want to send on each sender, applied once trusted. */
  intended: Map<RTCRtpSender, MediaStreamTrack | null>;
  /** Remote stream received before trust (not shown or played yet). */
  pendingStream: MediaStream | null;
}

export interface ChatMessage {
  id: string;
  fromPeerId: string;
  displayName: string;
  text: string;
  timestamp: number;
  isLocal: boolean;
  fileTransfer?: FileTransferEntry;
  /** Direct message: only the sender and this recipient ever see it. */
  private?: boolean;
  /** For private messages you sent: who it went to. */
  toPeerId?: string;
  toDisplayName?: string;
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
  /** Verified by the server: the address their personal invite was emailed to. */
  email?: string;
}

export const peers = writable<Map<string, PeerConnection>>(new Map());
export const chatMessages = writable<ChatMessage[]>([]);
export const connectionState = writable<'disconnected' | 'connecting' | 'connected'>('disconnected');
export const admissionState = writable<'none' | 'waiting' | 'password' | 'denied'>('none');
export const admissionDeniedReason = writable<string>('');
/** In the call: the server has sent the room's participant list (we got past any password and lobby). */
export const admitted = writable<boolean>(false);
/** While waiting: whether the host is in the call yet. */
export const hostPresent = writable<boolean>(true);
export const passwordInvalid = writable<boolean>(false);
/** Fatal problem joining the room (room missing, full, ...). */
export const roomError = writable<string>('');
export const admissionRequests = writable<AdmissionRequest[]>([]);
export const hostStatus = writable<boolean>(false);
export const typingPeers = writable<Set<string>>(new Set());
export const reactions = writable<Reaction[]>([]);
export const speakingPeers = writable<Set<string>>(new Set());
/** Remote peers currently sharing their screen. */
export const sharingPeers = writable<Set<string>>(new Set());
/** What each remote peer says about their mic/camera (for muted badges and avatars). */
export const peerMediaState = writable<Map<string, { audio: boolean; video: boolean }>>(new Map());
/** Peer id of the current host (null if nobody holds the role). */
export const hostPeerIdStore = writable<string | null>(null);
/** This participant's peer id (for collaboration features). */
export const localPeerIdStore = writable<string>('');

// ── Extension points for collaboration features ─────────────────────────────
// Whiteboard, annotations etc. register their own data-channel message types here, so they ride
// the same end-to-end encrypted peer-to-peer channel without the server ever seeing them.

type DataHandler = (fromPeerId: string, msg: AnyDataMessage) => void;
const dataHandlers = new Map<string, DataHandler>();
/** Types that may never be re-registered (the first registration wins). */
const RESERVED_TYPES = new Set(['e2e-auth']);
const connectHandlers = new Set<(peerId: string) => void>();
const channelOpenHandlers = new Set<(peerId: string, sid: string) => void>();
const createdHandlers = new Set<(peerId: string, sid: string | null) => void>();
const securityFailureHandlers = new Set<(peerId: string, reason: string) => void>();
const leaveHandlers = new Set<(peerId: string) => void>();
const roomLeaveHandlers = new Set<() => void>();
const forcedOutHandlers = new Set<() => void>();

/** Handle every incoming message whose `type` equals `type`. */
export function registerDataHandler(type: string, handler: DataHandler): void {
  if (RESERVED_TYPES.has(type) && dataHandlers.has(type)) return;
  dataHandlers.set(type, handler);
}

/**
 * Called when a connection becomes usable: open AND trusted (verified end to end). A good time to
 * send the peer current state. Nothing reaches a peer before this.
 */
export function onPeerConnected(handler: (peerId: string) => void): () => void {
  connectHandlers.add(handler);
  return () => connectHandlers.delete(handler);
}

/** Internal (verification): the data channel opened; trust not yet established. */
export function onPeerChannelOpen(handler: (peerId: string, sid: string) => void): () => void {
  channelOpenHandlers.add(handler);
  return () => channelOpenHandlers.delete(handler);
}

/** Internal (verification): a new connection object was created for a peer. */
export function onPeerCreated(handler: (peerId: string, sid: string | null) => void): () => void {
  createdHandlers.add(handler);
  return () => createdHandlers.delete(handler);
}

/** Internal (verification): a connection was refused for a security reason (e.g. bad SDP). */
export function onPeerSecurityFailure(handler: (peerId: string, reason: string) => void): () => void {
  securityFailureHandlers.add(handler);
  return () => securityFailureHandlers.delete(handler);
}

/** The current connection to a peer, if any (verification reads its SDP/stats). */
export function getPeerConnection(peerId: string): PeerConnection | undefined {
  return get(peers).get(peerId);
}

/**
 * Open the gate for a connection (verified, or explicitly allowed by the user). Only applies if
 * `sid` still identifies the current connection — a late result never unlocks a newer one.
 */
export function trustPeer(peerId: string, sid: string): void {
  const pc = get(peers).get(peerId);
  if (!pc || pc.sid !== sid || pc.trusted || !pc.connected) return;
  pc.trusted = true;
  for (const [sender, track] of pc.intended) sender.replaceTrack(track).catch(() => {});
  const pendingTrack = pendingTrackReplacements.get(peerId);
  if (pendingTrack !== undefined) {
    pendingTrackReplacements.delete(peerId);
    replaceVideoTrack(pc, pendingTrack, get(screenStream) ?? undefined);
  }
  if (pc.pendingStream) attachRemoteStream(pc, pc.pendingStream);
  pc.pendingStream = null;
  updatePeers();
  // Tell them what we're doing right now, then let features sync state.
  if (screenShareActive) sendIfConnected(pc, serialize({ type: 'screen-state', sharing: true }));
  sendIfConnected(pc, serialize({ type: 'media-state', ...localMediaState() }));
  for (const handler of connectHandlers) handler(peerId);
}

/**
 * A peer proved (via their verification proof) which name they chose. The proof only shows they
 * hold the room key — which every invited person does — so the name is never taken at face value:
 *  - If the server's label is that same name (possibly with the " (2)" it adds to keep names
 *    unique), the label is shown. The server can't relabel people and a peer can't drop the suffix.
 *  - Otherwise the proven name is shown instead of the label.
 * Either way no two participants are ever shown names that read the same (see resolveShownNames).
 */
export function setVerifiedName(peerId: string, sid: string, name: string): void {
  const pc = get(peers).get(peerId);
  if (!pc || pc.sid !== sid) return;
  const proven = stripInvisible(name);
  const label = serverNames.get(peerId);
  // A name with nothing visible in it proves nothing: keep the server's label.
  if (!nameKey(proven) || (label !== undefined && labelMatchesName(label, proven))) claimedNames.delete(peerId);
  else claimedNames.set(peerId, proven);
  resolveShownNames();
  updatePeers();
}

const MAX_SHOWN_NAME = 30;

function sliceCodePoints(value: string, end: number): string {
  return Array.from(value).slice(0, end).join('');
}

/** `name` with a number, the way the server does it: cut to fit, then " (n)". */
function numbered(name: string, n: number): string {
  const suffix = ` (${n})`;
  return sliceCodePoints(name, MAX_SHOWN_NAME - suffix.length).trimEnd() + suffix;
}

/** Whether the server's label is `name` itself, or exactly what the server makes of it to keep names unique. */
function labelMatchesName(label: string, name: string): boolean {
  const key = nameKey(name);
  if (!key) return false;
  if (nameKey(label) === key) return true;
  const m = label.match(/ \((\d{1,2})\)$/);
  return !!m && nameKey(numbered(name, Number(m[1]))) === nameKey(label);
}

function setShownName(peerId: string, name: string): void {
  knownNames.set(peerId, name);
  const pc = get(peers).get(peerId);
  if (pc) pc.displayName = name;
}

/**
 * Decide what every participant is called. Nobody is ever shown a name that reads the same as
 * ours or as another participant's — not through a name they proved, and not through labels a
 * misbehaving server handed out twice. Server labels come first (in a well-behaved room they are
 * already unique and are shown untouched); names that were proven but don't match their label
 * come after, so the one making the unusual claim is the one that gets numbered.
 */
function resolveShownNames(): void {
  const taken = new Set<string>([nameKey(localDisplayName)]);
  const place = (id: string, name: string) => {
    let shown = name;
    for (let n = 2; taken.has(nameKey(shown)) && n < 100; n++) shown = numbered(name, n);
    taken.add(nameKey(shown));
    setShownName(id, shown);
  };
  for (const [id, label] of serverNames) if (!claimedNames.has(id)) place(id, label);
  for (const [id, name] of claimedNames) place(id, name);
}

/** Verification messages are the only thing allowed over an untrusted connection. */
export function sendVerification(peerId: string, sid: string, msg: AnyDataMessage): void {
  const pc = get(peers).get(peerId);
  if (pc && pc.sid === sid) sendIfConnected(pc, JSON.stringify(msg), true);
}

/** Called when a peer leaves the call. */
export function onPeerLeft(handler: (peerId: string) => void): () => void {
  leaveHandlers.add(handler);
  return () => leaveHandlers.delete(handler);
}

/**
 * Called when the server ends our part in the call (removed by the host, or replaced by another
 * tab). The call itself is torn down here; the page releases the camera and forgets the room.
 */
export function onForcedOut(handler: () => void): () => void {
  forcedOutHandlers.add(handler);
  return () => forcedOutHandlers.delete(handler);
}

/** Called when we leave the room (reset collaboration state). */
export function onRoomLeft(handler: () => void): () => void {
  roomLeaveHandlers.add(handler);
  return () => roomLeaveHandlers.delete(handler);
}

/** Peers whose connection failed end-to-end verification: never reconnect to them this call. */
const blockedPeers = new Set<string>();

/** Close and refuse any further connection to this peer for the rest of the call. */
export function blockPeer(peerId: string): void {
  blockedPeers.add(peerId);
  destroyPeerConnection(peerId);
}

export function sendData(peerId: string, msg: AnyDataMessage): void {
  sendDataToPeer(peerId, JSON.stringify(msg));
}

export function broadcastData(msg: AnyDataMessage): void {
  broadcastToAllPeers(JSON.stringify(msg));
}

export function getLocalPeerId(): string {
  return localPeerId;
}

export function getLocalDisplayName(): string {
  return localDisplayName;
}

/** Server-verified display name for a peer (or "You" for ourselves). */
export function peerDisplayName(peerId: string): string {
  if (peerId === localPeerId) return localDisplayName;
  return knownNames.get(peerId) ?? get(peers).get(peerId)?.displayName ?? 'Someone';
}

const FATAL_ERRORS: Record<string, string> = {
  'Room does not exist': "This room doesn't exist (or everyone has left). Check the code or create a new room.",
  'Room is full': 'This room is full (6 people max).',
  'Peer ID already in use': 'You are already in this room in another tab.',
  'Too many people waiting to join': 'Too many people are waiting to join. Try again shortly.',
  'Invite required': 'This is a private server. You need an invite link from the owner to join.',
  'Invite expired': 'This invite link has expired. Ask the person who invited you for a new one.',
  'Invalid invite': "This invite link isn't valid. Check you copied the whole link.",
  'Server misconfigured': 'The server is not set up correctly. Tell the owner.',
  'Cannot connect': "Can't reach the call server. Check your internet connection, and that you opened the whole invite link.",
  'Too many password attempts': 'Too many wrong passwords for this room. Try again in a few minutes.',
  'Removed by host': 'The host removed you from this call.',
};

/** Plain-words version of a server error (e.g. 'Invite expired'), if it's one we know. */
export function friendlyJoinError(message: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(FATAL_ERRORS, message) ? FATAL_ERRORS[message] : undefined;
}

let iceServers: RTCIceServer[] = [];
let iceRefreshTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * TURN credentials expire (the server's `ttl`). Fetch fresh ones before then and hand them to every
 * connection, so long calls that go through the relay keep working.
 */
function scheduleIceRefresh(ttl: number | undefined, token: string | undefined, generation: number, retryInMs?: number): void {
  if (iceRefreshTimer) clearTimeout(iceRefreshTimer);
  iceRefreshTimer = null;
  if (!ttl) return;
  const delay = retryInMs ?? Math.max(30, ttl * 0.8) * 1000;
  iceRefreshTimer = setTimeout(async () => {
    const fresh = await fetchIceServers(token);
    if (generation !== joinGeneration) return;
    if (!fresh.ok) {
      // Refused or unreachable right now: keep the servers we have (replacing them with the
      // fallback would drop the relay from every connection) and try again in a minute.
      scheduleIceRefresh(ttl, token, generation, 60_000);
      return;
    }
    iceServers = fresh.servers;
    for (const pc of get(peers).values()) {
      const rtc = (pc.peer as unknown as { _pc?: RTCPeerConnection })._pc;
      try {
        rtc?.setConfiguration({ ...rtc.getConfiguration(), iceServers });
      } catch {
        // Some browsers refuse certain changes; the connection keeps its current servers.
      }
    }
    scheduleIceRefresh(fresh.ttl, token, generation);
  }, Math.min(delay, 2 ** 31 - 1));
}
/** "Hide my IP": only use the TURN relay, so other participants never learn your address. */
let relayOnly = false;

let signalingClient: SignalingClient | null = null;
let localPeerId: string = '';
let localDisplayName: string = '';
let currentRoomId: string = '';
const unsubscribers: (() => void)[] = [];
const disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
const speakingDetectorCleanups = new Map<string, () => void>();
/** Display names shown for each peer (the server's label, or a name they proved; see setVerifiedName). */
const knownNames = new Map<string, string>();
/** The label the signaling server gave each peer (unique within the room). */
const serverNames = new Map<string, string>();
/** Names peers proved that don't match the server's label; shown made unique (see setVerifiedName). */
const claimedNames = new Map<string, string>();
let localSpeakingCleanup: (() => void) | null = null;
/** Bumped by every join/leave so an in-flight joinRoom can tell it has been superseded. */
let joinGeneration = 0;

// Anything a participant sends us is untrusted. Bound size and rate per peer so a misbehaving
// participant can't freeze or crash everyone else's tab.
const MAX_DATA_MESSAGE_BYTES = 256 * 1024;
const DATA_BURST = 600;
const DATA_PER_SECOND = 300;
const dataBuckets = new Map<string, { tokens: number; at: number }>();

function allowData(peerId: string): boolean {
  const now = Date.now();
  const b = dataBuckets.get(peerId) ?? { tokens: DATA_BURST, at: now };
  b.tokens = Math.min(DATA_BURST, b.tokens + ((now - b.at) / 1000) * DATA_PER_SECOND);
  b.at = now;
  dataBuckets.set(peerId, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// Per-peer byte budget and per-type limits for chatty message types.
const BYTES_PER_SECOND = 8 * 1024 * 1024;
const byteBuckets = new Map<string, { tokens: number; at: number }>();
const TYPE_LIMITS: Record<string, number> = {
  chat: 5,
  reaction: 5,
  typing: 5,
  'screen-state': 2,
  'media-state': 2,
  'room-name': 1,
  // A few files at once is normal; a stream of announcements/cancellations is a flood.
  'file-meta': 2,
  'file-cancel': 4,
};
const typeBuckets = new Map<string, { tokens: number; at: number }>();

function take(map: Map<string, { tokens: number; at: number }>, key: string, perSecond: number, burst: number, cost = 1): boolean {
  const now = Date.now();
  const b = map.get(key) ?? { tokens: burst, at: now };
  b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * perSecond);
  b.at = now;
  map.set(key, b);
  if (b.tokens < cost) return false;
  b.tokens -= cost;
  return true;
}

function allowBytes(peerId: string, size: number): boolean {
  return take(byteBuckets, peerId, BYTES_PER_SECOND, BYTES_PER_SECOND * 2, size);
}

function allowType(peerId: string, type: string): boolean {
  const limit = TYPE_LIMITS[type];
  return limit === undefined || take(typeBuckets, `${peerId}:${type}`, limit, limit * 2);
}

/** Remote-requested renegotiations per peer per minute. */
const MAX_RENEGOTIATIONS_PER_MIN = 6;
const renegotiations = new Map<string, number[]>();

/** Strip characters that can fake or hide text in the UI (bidi overrides, zero-width…). */
export function cleanPeerText(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff]/g, '').replace(/\n{3,}/g, '\n\n');
}

/** New connection sessions a peer may start per minute (stops offer floods). */
const MAX_REMOTE_SESSIONS_PER_MIN = 10;
const remoteSessionStarts = new Map<string, number[]>();

const MAX_CHAT_MESSAGES = 500;
/** Reactions are limited to the picker's set (no arbitrary floating text). */
export const REACTION_EMOJI = ['\u{1F44D}', '\u{2764}\u{FE0F}', '\u{1F602}', '\u{1F44F}', '\u{1F525}', '\u{1F4AF}'];
const ALLOWED_REACTIONS = new Set(REACTION_EMOJI);
const MAX_REACTIONS_ON_SCREEN = 30;

function newSid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The server's label for a peer: what we show until (and unless) they prove a different name.
 * Every arrival re-settles the names, so a newcomer's label can't end up reading the same as a
 * name someone already present is shown under.
 */
function noteServerName(peerId: string, name: string): void {
  serverNames.set(peerId, name);
  resolveShownNames();
  updatePeers();
}

// Data channel helpers
function sendIfConnected(pc: PeerConnection, data: string, beforeTrust = false): void {
  if (!pc.connected || (!pc.trusted && !beforeTrust)) return;
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
  /** Private instances: invite or host token. */
  token?: string;
  /** Only connect through the relay (hides your IP address from other participants). */
  relayOnly?: boolean;
}

export async function joinRoom(opts: JoinOptions): Promise<void> {
  const { serverUrl, roomId, peerId, secret, displayName, isCreator = false, password, token } = opts;
  relayOnly = !!opts.relayOnly;
  const generation = ++joinGeneration;
  localPeerId = peerId;
  localPeerIdStore.set(peerId);
  localDisplayName = displayName;
  currentRoomId = roomId;
  connectionState.set('connecting');
  admissionState.set('none');
  admitted.set(false);
  admissionDeniedReason.set('');
  passwordInvalid.set(false);
  roomError.set('');
  admissionRequests.set([]);
  hostStatus.set(false);
  knownNames.clear();
  serverNames.clear();
  claimedNames.clear();

  // Chat lives only in this tab's memory: it is never written to storage, so nothing of the
  // conversation is left behind when the call ends (a page refresh starts with an empty chat).
  chatMessages.set([]);
  try {
    sessionStorage.removeItem(`vchat_chat_${roomId}`); // left by earlier versions
  } catch {
    // storage unavailable
  }
  initFileTransfer(sendDataToPeer, broadcastToAllPeers);

  const ice = await fetchIceServers(token);
  if (generation !== joinGeneration) return; // left (or re-joined) while we were fetching
  iceServers = ice.servers;
  scheduleIceRefresh(ice.ttl, token, generation);

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

  const client = new SignalingClient(serverUrl);
  signalingClient = client;
  const on = (type: string, handler: Parameters<SignalingClient['on']>[1]) =>
    unsubscribers.push(client.on(type, handler));

  on('connected', () => {
    connectionState.set('connected');
    if (get(roomError) === FATAL_ERRORS['Cannot connect']) roomError.set('');
  });
  on('disconnected', () => connectionState.set('disconnected'));
  // Removed by the host: the server sends 'removed' and then closes the connection.
  // Either way our part in the call is over: end it now (connections, chat, files, whiteboard, keys)
  // instead of leaving it all in the tab until "Back to home" is clicked.
  const forceOut = (message: string) => {
    roomError.set(message);
    // After this event has been delivered to every listener.
    queueMicrotask(() => {
      if (generation !== joinGeneration) return;
      leaveRoom();
      for (const handler of forcedOutHandlers) handler();
    });
  };
  on('removed', () => forceOut(FATAL_ERRORS['Removed by host']));
  on('replaced', () => forceOut('You joined this call from another tab or window, so this one was disconnected.'));

  on('room-peers', (event) => {
    admissionState.set('none');
    admitted.set(true);
    roomError.set('');
    const existingPeers = event.peers as { id: string; displayName: string }[];
    // After a reconnect, drop anyone who left while we were away.
    const listed = new Set(existingPeers.map((p) => p.id));
    for (const id of get(peers).keys()) if (!listed.has(id)) destroyPeerConnection(id);
    for (const p of existingPeers) {
      noteServerName(p.id, p.displayName);
      createPeerConnection(p.id, p.displayName, true);
    }
  });

  on('peer-joined', (event) => {
    const { peerId: newPeerId, displayName: name } = event as unknown as { peerId: string; displayName: string };
    noteServerName(newPeerId, name);
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
    hostPresent.set(!!hostPeerId);
    hostPeerIdStore.set(hostPeerId ?? null);
    if (hostPeerId !== localPeerId) admissionRequests.set([]);
  });

  on('waiting-for-admission', (event) => {
    hostPresent.set(event.hostPresent !== false);
    admissionState.set('waiting');
  });
  on('admission-granted', () => admissionState.set('none'));

  on('admission-denied', (event) => {
    const { reason } = event as { reason?: string };
    admissionDeniedReason.set(reason ?? '');
    admissionState.set('denied');
  });

  on('admission-request', (event) => {
    const { peerId: reqPeerId, displayName: reqName, email } = event as unknown as AdmissionRequest;
    const verifiedEmail = typeof email === 'string' && email.length <= 254 ? cleanPeerText(email) : undefined;
    admissionRequests.update((reqs) => [
      ...reqs.filter((r) => r.peerId !== reqPeerId),
      { peerId: reqPeerId, displayName: reqName, ...(verifiedEmail ? { email: verifiedEmail } : {}) },
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

  // Tell peers when we mute/unmute or turn the camera on/off. They accept 2 of these a second, so
  // send at most one per 500ms, always the latest state (quick hold-to-talk taps included).
  const mediaStateSender = new LatestSender({
    intervalMs: 500,
    read: localMediaState,
    send: (state) => broadcastToAllPeers(serialize({ type: 'media-state', ...state })),
  });
  unsubscribers.push(() => mediaStateSender.cancel());
  const publishMediaState = () => mediaStateSender.notify();
  unsubscribers.push(audioEnabled.subscribe(publishMediaState));
  unsubscribers.push(videoEnabled.subscribe(publishMediaState));
  unsubscribers.push(localStream.subscribe(publishMediaState));

  client.enterRoom({ roomId, peerId, displayName, secret, password, token, isCreator });
  client.connect();
}

function localMediaState(): { audio: boolean; video: boolean } {
  const stream = get(localStream);
  return {
    audio: !!stream?.getAudioTracks().length && get(audioEnabled),
    video: !!stream?.getVideoTracks().length && get(videoEnabled),
  };
}

export function submitRoomPassword(password: string): void {
  passwordInvalid.set(false);
  admissionState.set('none');
  signalingClient?.retryWithPassword(password);
}

export function leaveRoom(): void {
  joinGeneration++;
  if (iceRefreshTimer) clearTimeout(iceRefreshTimer);
  iceRefreshTimer = null;
  for (const cleanup of speakingDetectorCleanups.values()) cleanup();
  speakingDetectorCleanups.clear();
  if (localSpeakingCleanup) {
    localSpeakingCleanup();
    localSpeakingCleanup = null;
  }

  currentRoomId = '';

  for (const timer of disconnectTimers.values()) clearTimeout(timer);
  disconnectTimers.clear();
  for (const timer of typingTimers.values()) clearTimeout(timer);
  typingTimers.clear();
  dataBuckets.clear();
  byteBuckets.clear();
  typeBuckets.clear();
  renegotiations.clear();
  remoteSessionStarts.clear();
  blockedPeers.clear();
  reconnectAttempts.clear();
  addedScreenTracks.clear();

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
  admitted.set(false);
  admissionRequests.set([]);
  hostStatus.set(false);
  typingPeers.set(new Set());
  reactions.set([]);
  speakingPeers.set(new Set());
  sharingPeers.set(new Set());
  peerMediaState.set(new Map());
  hostPeerIdStore.set(null);
  // Nothing of the call stays in this tab's memory either.
  chatMessages.set([]);
  knownNames.clear();
  serverNames.clear();
  claimedNames.clear();
  localDisplayName = '';
  iceServers = [];
  for (const handler of roomLeaveHandlers) handler();
}

export function admitPeer(peerId: string): void {
  signalingClient?.admitPeer(peerId);
  admissionRequests.update((reqs) => reqs.filter((r) => r.peerId !== peerId));
}

/** Host only: remove someone from the call. */
export function removePeer(peerId: string): void {
  signalingClient?.removePeer(peerId);
}

export function denyPeer(peerId: string): void {
  signalingClient?.denyPeer(peerId);
  admissionRequests.update((reqs) => reqs.filter((r) => r.peerId !== peerId));
}

/**
 * Send a chat message to everyone, or privately to one participant (`toPeerId`).
 * Private messages go only over the data channel to that person — nobody else receives them.
 * Returns false if a private recipient isn't connected.
 */
export function sendChatMessage(text: string, toPeerId?: string): boolean {
  if (!text.trim()) return false;

  const msg: DataChannelMessage = {
    type: 'chat',
    text,
    fromPeerId: localPeerId,
    displayName: localDisplayName,
    timestamp: Date.now(),
    ...(toPeerId ? { private: true } : {}),
  };

  if (toPeerId) {
    const recipient = get(peers).get(toPeerId);
    if (!recipient?.connected) return false;
    sendDataToPeer(toPeerId, serialize(msg));
  } else {
    broadcastToAllPeers(serialize(msg));
  }

  chatMessages.update((msgs) => [
    ...msgs,
    {
      id: nextMsgId(),
      fromPeerId: localPeerId,
      displayName: localDisplayName,
      text,
      timestamp: Date.now(),
      isLocal: true,
      ...(toPeerId ? { private: true, toPeerId, toDisplayName: peerDisplayName(toPeerId) } : {}),
    },
  ].slice(-MAX_CHAT_MESSAGES));

  return true;
}

/** While writing a private message, only the recipient sees that you're typing. */
export function sendTypingIndicator(isTyping: boolean, toPeerId?: string): void {
  const msg: DataChannelMessage = {
    type: 'typing',
    isTyping,
    fromPeerId: localPeerId,
  };
  if (toPeerId) sendDataToPeer(toPeerId, serialize(msg));
  else broadcastToAllPeers(serialize(msg));
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

/** Send a file to everyone, or only to `toPeerId` (it goes straight to them, never via a server). */
export function sendFileToRoom(file: File, toPeerId?: string): string | null {
  // Only peers whose data channel is open will receive the file; waiting on others would stall it.
  const peerIds = Array.from(get(peers).values())
    .filter((pc) => pc.connected && (!toPeerId || pc.id === toPeerId))
    .map((pc) => pc.id);
  return ftSendFile(file, peerIds, localPeerId, localDisplayName, toPeerId ? { displayName: peerDisplayName(toPeerId) } : undefined);
}

// Typing indicator timers
const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

function handleDataChannelMessage(fromPeerId: string, anyMsg: DataChannelMessage | AnyDataMessage): void {
  const handler = dataHandlers.get(anyMsg.type);
  if (handler) {
    handler(fromPeerId, anyMsg as AnyDataMessage);
    return;
  }
  const msg = anyMsg as DataChannelMessage;
  switch (msg.type) {
    case 'media-state': {
      const next = { audio: msg.audio !== false, video: msg.video !== false };
      const prev = get(peerMediaState).get(fromPeerId);
      if (prev && prev.audio === next.audio && prev.video === next.video) break; // no change
      peerMediaState.update((m) => new Map(m).set(fromPeerId, next));
      break;
    }
    case 'screen-state': {
      const sharing = msg.sharing === true;
      if (get(sharingPeers).has(fromPeerId) === sharing) break; // no change
      sharingPeers.update((s) => {
        const next = new Set(s);
        if (sharing) next.add(fromPeerId);
        else next.delete(fromPeerId);
        return next;
      });
      break;
    }
    case 'chat': {
      if (typeof msg.text !== 'string' || !msg.text.trim()) break;
      chatMessages.update((msgs) => [
        ...msgs,
        {
          id: nextMsgId(),
          fromPeerId,
          // Use the server-verified name; peers can't impersonate each other in chat.
          displayName: knownNames.get(fromPeerId) ?? 'Peer',
          text: cleanPeerText(msg.text.slice(0, 5000)),
          timestamp: Date.now(),
          isLocal: false,
          ...(msg.private ? { private: true } : {}),
        },
      ].slice(-MAX_CHAT_MESSAGES));

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
      if (typeof msg.emoji !== 'string' || !ALLOWED_REACTIONS.has(msg.emoji)) break;
      const id = `${Date.now()}_${Math.random()}`;
      reactions.update((r) => [
        ...r.slice(-(MAX_REACTIONS_ON_SCREEN - 1)),
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
      handleFileMeta(msg, fromPeerId, knownNames.get(fromPeerId) ?? 'Peer');
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
  cleanupMixedAudio();
  mixedAudioCtx = new AudioContext();
  mixedAudioCtx.resume().catch(() => {});
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

/** Screen tracks we had to *add* (the peer had no video sender, e.g. we joined audio-only). */
const addedScreenTracks = new Map<string, { track: MediaStreamTrack; stream: MediaStream }>();

function videoSender(pc: PeerConnection): RTCRtpSender | null {
  return senderFor(pc, 'video');
}

/** Point this peer's outgoing video at `track` (camera or screen). Returns false if not possible yet. */
function replaceVideoTrack(pc: PeerConnection, newTrack: MediaStreamTrack | null, screen?: MediaStream): boolean {
  try {
    const sender = videoSender(pc);
    if (sender) {
      setSenderTrack(pc, sender, newTrack);
      return true;
    }
    // No video sender (audio-only / no camera): add the screen as a new track. It's grouped with
    // our audio stream so the other side keeps a single picture-and-sound stream for us.
    // (Only on a verified connection; otherwise it's applied when trust is established.)
    if (newTrack && screen && pc.connected && pc.trusted) {
      const stream = get(localStream) ?? screen;
      pc.peer.addTrack(newTrack, stream);
      addedScreenTracks.set(pc.id, { track: newTrack, stream });
      return true;
    }
  } catch (e) {
    console.warn(`replaceVideoTrack failed for ${pc.id}:`, e);
  }
  return false;
}

function unshareScreen(pc: PeerConnection, cameraTrack: MediaStreamTrack | null): void {
  const added = addedScreenTracks.get(pc.id);
  if (added) {
    addedScreenTracks.delete(pc.id);
    try {
      pc.peer.removeTrack(added.track, added.stream);
    } catch {
      // connection already gone
    }
    return;
  }
  replaceVideoTrack(pc, cameraTrack);
}

/** Every outgoing track change goes through here: applied now if trusted, else when trusted. */
function setSenderTrack(pc: PeerConnection, sender: RTCRtpSender, track: MediaStreamTrack | null): void {
  pc.intended.set(sender, track);
  if (pc.trusted) sender.replaceTrack(track).catch(() => {});
}

/** The sender for our outgoing audio or video on this connection (even while held back). */
function senderFor(pc: PeerConnection, kind: 'audio' | 'video'): RTCRtpSender | null {
  for (const [sender, track] of pc.intended) if (track?.kind === kind || sender.track?.kind === kind) return sender;
  const rtcPc = (pc.peer as unknown as { _pc?: RTCPeerConnection })._pc;
  const sendCapable = (d: RTCRtpTransceiverDirection | null | undefined) => d === 'sendrecv' || d === 'sendonly';
  const t = rtcPc
    ?.getTransceivers()
    .find(
      (t) =>
        t.currentDirection !== 'stopped' &&
        (t.sender.track?.kind === kind ||
          (t.receiver.track?.kind === kind && (sendCapable(t.currentDirection) || sendCapable(t.direction))))
    );
  return t?.sender ?? null;
}

export function replaceTrackOnAllPeers(newTrack: MediaStreamTrack, kind: 'audio' | 'video'): void {
  for (const [, pc] of get(peers)) {
    const sender = senderFor(pc, kind);
    if (sender) setSenderTrack(pc, sender, newTrack);
  }
}

/** Use a newly selected microphone: keeps shared-screen audio mixed in, and the speaking ring working. */
export function useNewMicTrack(track: MediaStreamTrack): void {
  const screen = get(screenStream);
  const mic = get(localStream);
  if (screenShareActive && screen?.getAudioTracks().length && mic) {
    replaceTrackOnAllPeers(createMixedAudioTrack(mic, screen), 'audio');
  } else {
    replaceTrackOnAllPeers(track, 'audio');
  }
  if (mic) {
    localSpeakingCleanup?.();
    localSpeakingCleanup = createSpeakingDetector(mic, (isSpeaking) => {
      speakingPeers.update((s) => {
        const next = new Set(s);
        if (isSpeaking) next.add('local');
        else next.delete('local');
        return next;
      });
    });
  }
}

export function startSharingScreen(): void {
  const screen = get(screenStream);
  if (!screen) return;

  const screenVideoTrack = screen.getVideoTracks()[0];
  if (!screenVideoTrack) return;

  screenShareActive = true;
  pendingTrackReplacements.clear();
  broadcastToAllPeers(serialize({ type: 'screen-state', sharing: true }));

  const peerMap = get(peers);
  for (const [id, pc] of peerMap) {
    if (!replaceVideoTrack(pc, screenVideoTrack, screen)) {
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
  broadcastToAllPeers(serialize({ type: 'screen-state', sharing: false }));

  const camera = get(localStream);
  const cameraVideoTrack = camera?.getVideoTracks()[0] ?? null;

  const peerMap = get(peers);
  for (const [, pc] of peerMap) {
    unshareScreen(pc, cameraVideoTrack);
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

/**
 * Only well-formed signals reach the WebRTC stack, and only the fields we checked. Each message is
 * exactly one of: an offer/answer, an ICE candidate, or a renegotiation request — rebuilt from
 * scratch, because simple-peer acts on every field it finds (an `sdp` riding along on a
 * "candidate" would otherwise be applied unchecked).
 *
 * Offers/answers must carry exactly one SHA-256 DTLS fingerprint with everything bundled on one
 * transport, and once pinned, the fingerprint and ICE credentials may never change (we never do
 * ICE restarts) — so a malicious server can't swap in its own certificate after the connection
 * was verified. Any other message that carries a session description (pranswer, rollback, …) is
 * treated as an attack.
 */
function checkRemoteSignal(pc: PeerConnection, data: unknown): SimplePeer.SignalData | 'drop' | 'reject' {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'drop';
  const d = data as Record<string, unknown>;
  if (d.type === 'offer' || d.type === 'answer') {
    const identity = readSdpIdentity(d.sdp);
    if (!identity) return 'reject';
    if (!pc.pinned) pc.pinned = identity;
    else if (pc.pinned.fingerprint !== identity.fingerprint || pc.pinned.ufrag !== identity.ufrag) return 'reject';
    return { type: d.type, sdp: d.sdp as string };
  }
  if (d.sdp !== undefined && d.sdp !== null) return 'reject';
  if (d.type === 'candidate') {
    const c = d.candidate as Record<string, unknown> | null | undefined;
    if (!c || typeof c !== 'object' || typeof c.candidate !== 'string' || c.candidate.length > 2048) return 'drop';
    const sdpMid = typeof c.sdpMid === 'string' && c.sdpMid.length <= 64 ? c.sdpMid : null;
    const sdpMLineIndex = typeof c.sdpMLineIndex === 'number' && Number.isInteger(c.sdpMLineIndex) && c.sdpMLineIndex >= 0 && c.sdpMLineIndex < 64 ? c.sdpMLineIndex : null;
    if (sdpMid === null && sdpMLineIndex === null) return 'drop';
    return { type: 'candidate', candidate: { candidate: c.candidate, sdpMid, sdpMLineIndex } } as SimplePeer.SignalData;
  }
  if (d.type === 'renegotiate') {
    const now = Date.now();
    const recent = (renegotiations.get(pc.id) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= MAX_RENEGOTIATIONS_PER_MIN) return 'drop';
    renegotiations.set(pc.id, [...recent, now]);
    return { type: 'renegotiate', renegotiate: true } as SimplePeer.SignalData;
  }
  return 'drop'; // e.g. transceiverRequest: never let a peer add transceivers to our connection
}

/** Route an incoming signal to the right connection, (re)creating it when the remote starts a new session. */
function handleSignal(fromPeerId: string, raw: unknown): void {
  const envelope = raw as { sid?: unknown; data?: SimplePeer.SignalData } | null;
  if (!envelope || typeof envelope.sid !== 'string' || !envelope.data) return;
  const { sid, data } = envelope;
  const isOffer = (data as { type?: string }).type === 'offer';
  const pc = get(peers).get(fromPeerId);

  const feed = (target: PeerConnection) => {
    const verdict = checkRemoteSignal(target, data);
    if (verdict === 'drop') return;
    if (verdict === 'reject') {
      // A description that could let someone sit in the middle unnoticed: refuse this connection.
      for (const handler of securityFailureHandlers) handler(fromPeerId, 'Invalid or changed encryption details');
      blockPeer(fromPeerId);
      return;
    }
    try {
      target.peer.signal(verdict);
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

  const now = Date.now();
  const starts = (remoteSessionStarts.get(fromPeerId) ?? []).filter((t) => now - t < 60_000);
  if (starts.length >= MAX_REMOTE_SESSIONS_PER_MIN) return;
  remoteSessionStarts.set(fromPeerId, [...starts, now]);

  // The remote restarted the connection. If we restarted at the same moment ("glare"),
  // the peer with the smaller id wins and the other side yields.
  if (pc && pc.initiator && !pc.connected && localPeerId < fromPeerId) return;

  const name = pc?.displayName ?? knownNames.get(fromPeerId) ?? 'Peer';
  const fresh = createPeerConnection(fromPeerId, name, false, sid);
  if (fresh) feed(fresh);
}

function createPeerConnection(
  remotePeerId: string,
  remoteDisplayName: string,
  initiator: boolean,
  sid: string | null = initiator ? newSid() : null
): PeerConnection | null {
  if (blockedPeers.has(remotePeerId)) return null;
  teardownPeer(remotePeerId);

  const peer = new Peer({
    initiator,
    stream: getStreamForNewPeer(),
    trickle: true,
    config: {
      iceServers,
      // One transport for everything, so verifying it covers all media and data.
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      ...(relayOnly ? { iceTransportPolicy: 'relay' as const } : {}),
    },
    // Without this, someone with no camera/mic (or chat-only) would offer no media sections and
    // never receive anyone else's audio/video.
    offerOptions: { offerToReceiveAudio: true, offerToReceiveVideo: true },
    // Cap incoming data-channel messages at the transport level, before the browser assembles them.
    sdpTransform: (sdp: string) =>
      /a=max-message-size:/.test(sdp)
        ? sdp.replace(/a=max-message-size:\d+/g, `a=max-message-size:${MAX_DATA_MESSAGE_BYTES}`)
        : sdp.replace(/(a=sctp-port:\d+\r?\n)/g, `$1a=max-message-size:${MAX_DATA_MESSAGE_BYTES}\r\n`),
  });

  const pc: PeerConnection = {
    id: remotePeerId,
    // What this peer is currently shown as (the label may have been numbered, or a name proven).
    displayName: knownNames.get(remotePeerId) ?? remoteDisplayName,
    peer,
    stream: null,
    sid,
    initiator,
    connected: false,
    trusted: false,
    pinned: null,
    intended: new Map(),
    pendingStream: null,
  };

  // Hold our camera/mic back until this connection is verified: remember each sender's track and
  // send nothing for now. (trustPeer puts them back.)
  const rtc = (peer as unknown as { _pc?: RTCPeerConnection })._pc;
  for (const sender of rtc?.getSenders() ?? []) {
    pc.intended.set(sender, sender.track);
    sender.replaceTrack(null).catch(() => {});
  }

  // Events from a connection we've since replaced must not touch the new one.
  const isCurrent = () => get(peers).get(remotePeerId)?.peer === peer;

  peer.on('signal', (data) => {
    if (!isCurrent() || !pc.sid) return;
    signalingClient?.sendSignal(remotePeerId, { sid: pc.sid, data });
  });

  peer.on('connect', () => {
    if (!isCurrent() || !pc.sid) return;
    pc.connected = true;
    updatePeers();
    // Verification runs now; media/data start only when it calls trustPeer().
    for (const handler of channelOpenHandlers) handler(remotePeerId, pc.sid);
  });

  peer.on('data', (data: Uint8Array | string) => {
    if (!isCurrent()) return;
    const size = typeof data === 'string' ? data.length : data.byteLength;
    if (size > MAX_DATA_MESSAGE_BYTES || !allowData(remotePeerId) || !allowBytes(remotePeerId, size)) return;
    const str = typeof data === 'string' ? data : new TextDecoder().decode(data);
    const msg = deserialize(str);
    if (!msg) return;
    // Until verified, the only thing we accept is the verification proof itself.
    if (!pc.trusted && msg.type !== 'e2e-auth') return;
    if (!allowType(remotePeerId, msg.type)) return;
    handleDataChannelMessage(remotePeerId, msg);
  });

  peer.on('stream', (remoteStream: MediaStream) => {
    if (!isCurrent()) return;
    // Don't show or play anything from an unverified connection.
    if (pc.trusted) attachRemoteStream(pc, remoteStream);
    else pc.pendingStream = remoteStream;
  });

  peer.on('close', () => {
    if (isCurrent()) destroyPeerConnection(remotePeerId);
  });

  peer.on('error', (err: Error) => {
    if (!isCurrent()) return;
    console.warn('Peer connection error:', err.message);
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
  for (const handler of createdHandlers) handler(remotePeerId, sid);
  return pc;
}

function attachRemoteStream(pc: PeerConnection, remoteStream: MediaStream): void {
  const remotePeerId = pc.id;
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
}

const reconnectAttempts = new Map<string, number[]>();

function reconnectPeer(remotePeerId: string, remoteDisplayName: string): void {
  // Back off if a connection keeps failing (e.g. no TURN and a strict NAT): max 5 tries/minute.
  const now = Date.now();
  const recent = (reconnectAttempts.get(remotePeerId) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= 5) {
    console.warn('Giving up reconnecting to a participant for now');
    destroyPeerConnection(remotePeerId);
    return;
  }
  reconnectAttempts.set(remotePeerId, [...recent, now]);
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
    // In-flight file transfers can't survive a new connection; mark them cancelled on both sides.
    dropRecipient(remotePeerId);
    addedScreenTracks.delete(remotePeerId);
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
  peerMediaState.update((m) => {
    if (!m.has(remotePeerId)) return m;
    const next = new Map(m);
    next.delete(remotePeerId);
    return next;
  });
  sharingPeers.update((s) => {
    if (!s.has(remotePeerId)) return s;
    const next = new Set(s);
    next.delete(remotePeerId);
    return next;
  });
  // Their name stays in knownNames (chat keeps its labels) but no longer takes part in naming.
  serverNames.delete(remotePeerId);
  claimedNames.delete(remotePeerId);
  for (const handler of leaveHandlers) handler(remotePeerId);

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
