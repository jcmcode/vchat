export type SignalingEventType =
  | 'room-peers'
  | 'peer-joined'
  | 'peer-left'
  | 'signal'
  | 'chat'
  | 'error'
  | 'connected'
  | 'disconnected';

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
        this.send({
          type: 'join',
          roomId: this.currentRoomId,
          peerId: this.currentPeerId,
          displayName: this.currentDisplayName,
        });
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
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

  joinRoom(roomId: string, peerId: string, displayName: string): void {
    this.currentRoomId = roomId;
    this.currentPeerId = peerId;
    this.currentDisplayName = displayName;
    this.send({ type: 'join', roomId, peerId, displayName });
  }

  leaveRoom(): void {
    this.currentRoomId = null;
    this.currentPeerId = null;
    this.currentDisplayName = null;
    this.send({ type: 'leave' });
  }

  sendSignal(targetPeerId: string, signal: unknown): void {
    this.send({ type: 'signal', targetPeerId, signal });
  }

  sendChat(text: string): void {
    this.send({ type: 'chat', text });
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
