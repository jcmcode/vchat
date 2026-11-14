export type SignalingEventType =
  | 'room-peers'
  | 'peer-joined'
  | 'peer-left'
  | 'signal'
  | 'error'
  | 'connected'
  | 'disconnected'
  | 'room-created'
  | 'password-required'
  | 'waiting-for-admission'
  | 'admission-request'
  | 'admission-cancelled'
  | 'admission-granted'
  | 'admission-denied'
  | 'host-changed'
  | 'replaced'
  | 'lock-changed'
  | 'room-ended'
  | 'reconnect-needed';

export interface SignalingEvent {
  type: SignalingEventType | string;
  [key: string]: unknown;
}

type EventHandler = (event: SignalingEvent) => void;

interface RoomIntent {
  roomId: string;
  peerId: string;
  displayName: string;
  secret: string;
  password?: string;
  /** Private instances: signed invite or host token. */
  token?: string;
  isCreator: boolean;
  /** Set once the server has let us into the room. */
  admitted?: boolean;
}

/**
 * A dead connection is noticed within PING_INTERVAL_MS + PONG_TIMEOUT_MS. Pings are cheap: on
 * Cloudflare the runtime answers them without waking the room's Durable Object.
 */
const PING_INTERVAL_MS = 15_000;
/** Must match the server (core/api.ts). The token rides as a subprotocol so it never lands in URLs/logs. */
const WS_PROTOCOL = 'vchat.v1';
const WS_TOKEN_PREFIX = 'vchat.t.';
/** After this many failed connection attempts in a row, tell the user (we keep retrying). */
const FAILED_OPENS_BEFORE_ERROR = 4;
/** Close code the server uses when a newer connection with the same peer id takes over. */
const REPLACED_CLOSE_CODE = 4000;
/** The host removed us from the room. */
const REMOVED_CLOSE_CODE = 4002;
/** The invite was refused (invalid, expired, or the server is misconfigured): retrying won't help. */
const REFUSED_CLOSE_CODE = 4003;
/** The host ended the call for everyone. */
const ENDED_CLOSE_CODE = 4004;
/** The host locked the room, so this new join attempt was refused. */
const LOCKED_CLOSE_CODE = 4005;
/** The call this connection was waiting to join is no longer available (it was ended). */
const UNAVAILABLE_CLOSE_CODE = 4006;
const PONG_TIMEOUT_MS = 10_000;
/**
 * Out of touch with the server for longer than this (a sleeping laptop, a long outage), we don't
 * walk back into the call on our own: it may have ended or changed, and our camera and mic are
 * live. Matches how long the server remembers an ended call (core/ended.ts).
 */
export const LONG_OFFLINE_MS = 60_000;

export class SignalingClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<EventHandler>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private failedOpens = 0;
  private opened = false;
  private shouldReconnect = true;
  private intent: RoomIntent | null = null;
  /** The host ended the call: this client is finished for good. */
  private ended = false;
  /** Last time we heard from the server while taking part (0 = never). */
  private lastAlive = 0;
  /** Back after a long time offline: wait for the user before re-entering (see LONG_OFFLINE_MS). */
  private held = false;

  constructor(private readonly url: string) {}

  /** After a long time offline the user chose to go back in. */
  resumeAfterLongOffline(): void {
    if (!this.held) return;
    this.held = false;
    this.lastAlive = Date.now();
    // If the socket is down right now, the next connection re-enters as usual.
    if (this.ws?.readyState === WebSocket.OPEN && this.intent) this.sendEnter(this.intent.isCreator);
  }

  private markEnded(): void {
    this.ended = true;
    this.shouldReconnect = false;
    this.intent = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  connect(): void {
    this.shouldReconnect = true;
    const token = this.intent?.token;
    const ws = new WebSocket(this.url, token ? [WS_PROTOCOL, WS_TOKEN_PREFIX + token] : [WS_PROTOCOL]);
    this.ws = ws;
    this.opened = false;

    ws.onopen = () => {
      this.opened = true;
      this.failedOpens = 0;
      this.reconnectAttempts = 0;
      this.startKeepalive();
      this.emit({ type: 'connected' });
      if (!this.intent) return;
      // Back after a long time out of touch: ask first (see LONG_OFFLINE_MS). Short blips re-enter.
      if (this.held || (this.intent.admitted && this.lastAlive > 0 && Date.now() - this.lastAlive > LONG_OFFLINE_MS)) {
        this.held = true;
        this.emit({ type: 'reconnect-needed' });
        return;
      }
      // Re-enter the room after a reconnect. The server lets us straight back in thanks to our secret.
      this.lastAlive = Date.now();
      this.sendEnter(this.intent.isCreator);
    };

    ws.onmessage = (event) => {
      let msg: SignalingEvent;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!this.held) this.lastAlive = Date.now();
      if (msg.type === 'pong') {
        if (this.pongTimer) clearTimeout(this.pongTimer);
        this.pongTimer = null;
        return;
      }
      if (this.ended) return; // nothing after the end of the call matters
      if (msg.type === 'room-peers' && this.intent) this.intent.admitted = true;
      if (msg.type === 'room-ended') {
        // The call is over for everyone. Stop right here, before the socket closes: never reconnect,
        // re-enter or re-create the room, whatever close code (if any) follows.
        this.markEnded();
      }
      // We were in this room but everyone left while we were disconnected — reopen it (open mode).
      if (msg.type === 'error' && msg.message === 'Room does not exist' && this.intent?.admitted && !this.intent.token) {
        this.intent.isCreator = true;
        this.sendEnter(true);
        return;
      }
      // Our room already exists (e.g. we reconnected after a blip) — join it instead.
      if (msg.type === 'error' && msg.message === 'Room already exists' && this.intent?.isCreator) {
        this.intent.isCreator = false;
        this.sendEnter(false);
        return;
      }
      this.emit(msg);
    };

    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.stopKeepalive();
      this.ws = null;
      this.emit({ type: 'disconnected' });
      if (!this.opened && ++this.failedOpens === FAILED_OPENS_BEFORE_ERROR) {
        this.emit({ type: 'error', message: 'Cannot connect' });
      }
      if (this.ended) return;
      if (event.code === ENDED_CLOSE_CODE) {
        // The host ended the call (and the 'room-ended' message didn't make it).
        this.markEnded();
        this.emit({ type: 'room-ended' });
        return;
      }
      if (event.code === REPLACED_CLOSE_CODE) {
        // The same identity connected from somewhere else; reconnecting would just kick it off.
        this.shouldReconnect = false;
        this.emit({ type: 'replaced' });
        return;
      }
      if (
        event.code === REMOVED_CLOSE_CODE ||
        event.code === REFUSED_CLOSE_CODE ||
        event.code === LOCKED_CLOSE_CODE ||
        event.code === UNAVAILABLE_CLOSE_CODE
      ) {
        // The server has already said why ('removed' or an error message); don't knock again.
        this.shouldReconnect = false;
        this.intent = null;
        if (event.code === REMOVED_CLOSE_CODE) this.emit({ type: 'removed' });
        if (event.code === LOCKED_CLOSE_CODE) this.emit({ type: 'error', message: 'Room is locked' });
        if (event.code === UNAVAILABLE_CLOSE_CODE) this.emit({ type: 'error', message: 'Call no longer available' });
        return;
      }
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose fires after this
    };
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      this.ws.send('{"type":"ping"}');
      if (!this.pongTimer) {
        this.pongTimer = setTimeout(() => {
          // No pong: the connection is dead even if the browser hasn't noticed yet.
          this.ws?.close();
        }, PONG_TIMEOUT_MS);
      }
    }, PING_INTERVAL_MS);
  }

  private stopKeepalive(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pingTimer = null;
    this.pongTimer = null;
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 15_000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.stopKeepalive();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  send(message: object): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  private sendEnter(asCreator: boolean): void {
    if (!this.intent) return;
    const { roomId, peerId, displayName, secret, password, token } = this.intent;
    this.send({
      type: asCreator && !token ? 'create-room' : 'join',
      roomId,
      peerId,
      displayName,
      secret,
      ...(password ? { password } : {}),
      ...(token ? { token } : {}),
    });
  }

  enterRoom(intent: RoomIntent): void {
    this.intent = { ...intent };
    this.sendEnter(intent.isCreator);
  }

  /** Retry joining with a (new) room password. */
  retryWithPassword(password: string): void {
    if (!this.intent) return;
    this.intent.password = password;
    this.intent.isCreator = false;
    this.sendEnter(false);
  }

  admitPeer(peerId: string): void {
    this.send({ type: 'admit-peer', peerId });
  }

  denyPeer(peerId: string): void {
    this.send({ type: 'deny-peer', peerId });
  }

  /** Host only: remove someone from the call (they can't rejoin with the same identity). */
  removePeer(peerId: string): void {
    this.send({ type: 'remove-peer', peerId });
  }

  /** Host only: refuse (or allow again) new join attempts. Returns false if not connected. */
  setRoomLocked(locked: boolean): boolean {
    return this.send({ type: locked ? 'lock-room' : 'unlock-room' });
  }

  /** Host only: end the call for everyone. Returns false if not connected. */
  endRoom(): boolean {
    return this.send({ type: 'end-room' });
  }

  leaveRoom(): void {
    this.intent = null;
    this.send({ type: 'leave' });
  }

  sendSignal(targetPeerId: string, signal: unknown): void {
    this.send({ type: 'signal', targetPeerId, signal });
  }

  on(type: string, handler: EventHandler): () => void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler);
    return () => {
      this.handlers.get(type)?.delete(handler);
    };
  }

  private emit(event: SignalingEvent): void {
    for (const handler of this.handlers.get(event.type) ?? []) handler(event);
    for (const handler of this.handlers.get('*') ?? []) handler(event);
  }
}
