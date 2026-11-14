// One Durable Object per room. Uses the WebSocket Hibernation API so idle calls cost nothing:
// the object sleeps between signaling messages while browsers stay connected.
// Per-connection state lives in WebSocket attachments; room metadata lives in DO storage.

import { DurableObject } from 'cloudflare:workers';
import {
  PING_MESSAGE,
  PONG_MESSAGE,
  RateLimiter,
  Room,
  isValidRoomId,
  parseClientMessage,
  type MemberState,
  type RoomMeta,
  type Transport,
} from '@vchat/signaling-server/core';
import type { Env } from './env.ts';

interface Attachment {
  state: MemberState | null;
}

const OPEN = 1;

const transport: Transport<WebSocket> = {
  send: (ws, data) => ws.send(data),
  isOpen: (ws) => ws.readyState === OPEN,
  close: (ws, code, reason) => {
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  },
};

export class SignalingRoom extends DurableObject<Env> {
  private room: Room<WebSocket> | null = null;
  private readonly limiter = new RateLimiter<WebSocket>();
  /** Last alarm time we set (null = none); undefined = unknown, e.g. after waking from hibernation. */
  private scheduledDeadline: number | null | undefined = undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keepalive pings are answered by the runtime without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_MESSAGE, PONG_MESSAGE));
    ctx.blockConcurrencyWhile(async () => {
      const roomId = await ctx.storage.get<string>('roomId');
      if (roomId) {
        const meta = (await ctx.storage.get<RoomMeta>('meta')) ?? null;
        this.room = this.createRoom(roomId, meta);
      }
    });
  }

  private createRoom(roomId: string, meta: RoomMeta | null): Room<WebSocket> {
    const members: [WebSocket, MemberState][] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.state) members.push([ws, att.state]);
    }
    return new Room(
      roomId,
      transport,
      {
        onMemberChange: (ws, state) => {
          try {
            ws.serializeAttachment({ state } satisfies Attachment);
          } catch {
            // socket already closed — attachment is discarded anyway
          }
        },
        onMetaChange: (next) => {
          if (next) this.ctx.storage.put('meta', next);
          else this.ctx.storage.delete('meta');
        },
        log: (m) => console.log(m),
      },
      { meta: members.length > 0 ? meta : null, members }
    );
  }

  async fetch(request: Request): Promise<Response> {
    const roomId = new URL(request.url).searchParams.get('room') ?? '';
    if (!isValidRoomId(roomId)) return new Response('Invalid room', { status: 400 });

    if (!this.room) {
      await this.ctx.storage.put('roomId', roomId);
      this.room = this.createRoom(roomId, null);
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ state: null } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const room = this.room;
    if (!room) return;

    if (typeof message !== 'string') return this.sendError(ws, 'Binary messages not supported');
    if (!this.limiter.allow(ws)) return this.sendError(ws, 'Rate limit exceeded');

    const parsed = parseClientMessage(message);
    if (!parsed.ok) return this.sendError(ws, parsed.error);
    const msg = parsed.msg;

    switch (msg.type) {
      case 'ping':
        ws.send(PONG_MESSAGE);
        break;
      case 'create-room':
      case 'join':
        if (msg.roomId !== room.id) return this.sendError(ws, 'Room ID does not match connection');
        if (msg.type === 'create-room') await room.create(ws, msg);
        else await room.join(ws, msg);
        if (ws.readyState !== OPEN) room.leave(ws);
        break;
      case 'leave':
        room.leave(ws);
        break;
      case 'signal':
        room.signal(ws, msg.targetPeerId, msg.signal);
        break;
      case 'admit-peer':
        room.admitPeer(ws, msg.peerId);
        break;
      case 'deny-peer':
        room.denyPeer(ws, msg.peerId);
        break;
    }
    await this.scheduleExpiry();
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.room?.leave(ws);
    // Complete the closing handshake (required before compatibility date 2026-04-07).
    transport.close(ws, 1000, 'Closing');
    await this.scheduleExpiry();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.room?.leave(ws);
    await this.scheduleExpiry();
  }

  async alarm(): Promise<void> {
    this.scheduledDeadline = null; // a fired alarm is cleared automatically
    this.room?.expireWaiting();
    await this.scheduleExpiry();
  }

  /** Keep one alarm at the earliest waiting-room deadline. Cheap no-op when nothing changed. */
  private async scheduleExpiry(): Promise<void> {
    const deadline = this.room?.nextWaitingDeadline() ?? null;
    if (deadline === this.scheduledDeadline) return;
    if (deadline === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(deadline);
    this.scheduledDeadline = deadline;
  }

  private sendError(ws: WebSocket, message: string): void {
    if (ws.readyState === OPEN) ws.send(JSON.stringify({ type: 'error', message }));
  }
}
