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
  | 'host-changed';

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
  isCreator: boolean;
  /** Set once the server has let us into the room. */
  admitted?: boolean;
}

const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 10_000;

export class SignalingClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<EventHandler>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private shouldReconnect = true;
  private intent: RoomIntent | null = null;

  constructor(private readonly url: string) {}

  connect(): void {
    this.shouldReconnect = true;
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.startKeepalive();
      this.emit({ type: 'connected' });
      // Re-enter the room after a reconnect. The server lets us straight back in thanks to our secret.
      if (this.intent) this.sendEnter(this.intent.isCreator);
    };

    ws.onmessage = (event) => {
      let msg: SignalingEvent;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'pong') {
        if (this.pongTimer) clearTimeout(this.pongTimer);
        this.pongTimer = null;
        return;
      }
      if (msg.type === 'room-peers' && this.intent) this.intent.admitted = true;
      // We were in this room but everyone left while we were disconnected — reopen it.
      if (msg.type === 'error' && msg.message === 'Room does not exist' && this.intent?.admitted) {
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

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.stopKeepalive();
      this.ws = null;
      this.emit({ type: 'disconnected' });
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

  send(message: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  private sendEnter(asCreator: boolean): void {
    if (!this.intent) return;
    const { roomId, peerId, displayName, secret, password } = this.intent;
    this.send({
      type: asCreator ? 'create-room' : 'join',
      roomId,
      peerId,
      displayName,
      secret,
      ...(password ? { password } : {}),
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
