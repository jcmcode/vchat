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
  | 'admission-granted'
  | 'admission-denied'
  | 'host-changed';

export interface SignalingEvent {
  type: SignalingEventType;
  [key: string]: unknown;
}

type EventHandler = (event: SignalingEvent) => void;

export class SignalingClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<EventHandler>>();
  private url: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;
  private currentRoomId: string | null = null;
  private currentPeerId: string | null = null;
  private currentDisplayName: string | null = null;
  private isCreator = false;
  private password: string | undefined = undefined;

  constructor(url: string) {
    this.url = url;
  }

  connect(): void {
    this.shouldReconnect = true;
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      this.emit({ type: 'connected' });
      // Auto-rejoin room after reconnect
      if (this.currentRoomId && this.currentPeerId && this.currentDisplayName) {
        if (this.isCreator) {
          this.send({
            type: 'create-room',
            roomId: this.currentRoomId,
            peerId: this.currentPeerId,
            displayName: this.currentDisplayName,
            ...(this.password ? { password: this.password } : {}),
          });
        } else {
          this.send({
            type: 'join',
            roomId: this.currentRoomId,
            peerId: this.currentPeerId,
            displayName: this.currentDisplayName,
            ...(this.password ? { password: this.password } : {}),
          });
        }
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        // On reconnect, if room already exists, fall back to join
        if (msg.type === 'error' && msg.message === 'Room already exists' && this.isCreator) {
          this.send({
            type: 'join',
            roomId: this.currentRoomId!,
            peerId: this.currentPeerId!,
            displayName: this.currentDisplayName!,
            ...(this.password ? { password: this.password } : {}),
          });
          return;
        }
        this.emit(msg);
      } catch {
        // ignore invalid JSON
      }
    };

    this.ws.onclose = () => {
      this.emit({ type: 'disconnected' });
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose will fire after this
    };
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    this.reconnectTimer = setTimeout(() => {
      console.log('Reconnecting to signaling server...');
      this.connect();
    }, 2000);
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  send(message: object): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  createRoom(roomId: string, peerId: string, displayName: string, password?: string): void {
    this.currentRoomId = roomId;
    this.currentPeerId = peerId;
    this.currentDisplayName = displayName;
    this.isCreator = true;
    this.password = password;
    this.send({
      type: 'create-room',
      roomId,
      peerId,
      displayName,
      ...(password ? { password } : {}),
    });
  }

  joinRoom(roomId: string, peerId: string, displayName: string, password?: string): void {
    this.currentRoomId = roomId;
    this.currentPeerId = peerId;
    this.currentDisplayName = displayName;
    this.isCreator = false;
    this.password = password;
    this.send({
      type: 'join',
      roomId,
      peerId,
      displayName,
      ...(password ? { password } : {}),
    });
  }

  admitPeer(peerId: string): void {
    this.send({ type: 'admit-peer', peerId });
  }

  denyPeer(peerId: string): void {
    this.send({ type: 'deny-peer', peerId });
  }

  leaveRoom(): void {
    this.currentRoomId = null;
    this.currentPeerId = null;
    this.currentDisplayName = null;
    this.isCreator = false;
    this.password = undefined;
    this.send({ type: 'leave' });
  }

  sendSignal(targetPeerId: string, signal: unknown): void {
    this.send({ type: 'signal', targetPeerId, signal });
  }

  on(type: string, handler: EventHandler): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);

    // Return unsubscribe function
    return () => {
      this.handlers.get(type)?.delete(handler);
    };
  }

  private emit(event: SignalingEvent): void {
    const handlers = this.handlers.get(event.type);
    if (handlers) {
      for (const handler of handlers) {
        handler(event);
      }
    }
    // Also emit to wildcard handlers
    const wildcardHandlers = this.handlers.get('*');
    if (wildcardHandlers) {
      for (const handler of wildcardHandlers) {
        handler(event);
      }
    }
  }
}
