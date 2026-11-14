// One Durable Object per room. Uses the WebSocket Hibernation API so idle calls cost nothing:
// the object sleeps between signaling messages while browsers stay connected.
//
// Nothing is written to Durable Object storage (SQLite-backed storage keeps 30 days of
// point-in-time recovery, so anything written there would outlive the call). Instead, per-connection
// state *and* the room metadata (with a version counter) live in every connected socket's
// attachment: they survive hibernation and vanish when the last socket closes. Only alarms are
// used (for waiting-room timeouts and idle sockets); they hold no data.

import { DurableObject } from 'cloudflare:workers';
import {
  CLOSE_INVALID_INVITE,
  PING_MESSAGE,
  PONG_MESSAGE,
  RateLimiter,
  Room,
  WS_PROTOCOL,
  authorizeJoin,
  isValidRoomId,
  normalizeMeta,
  parseClientMessage,
  parseWsProtocols,
  resolveConfig,
  type MemberState,
  type RoomMeta,
  type Transport,
} from '@vchat/signaling-server/core';
import { CLIENT_HEADER, type Env } from './env.ts';

interface Attachment {
  roomId: string;
  state: MemberState | null;
  /** Keyed hash of the client's address, set by the Worker (never the raw IP). */
  client: string;
  connectedAt: number;
  /** When the socket was last not in the room (connect time, or when it left). */
  idleSince: number;
  /** Room metadata, copied onto every socket; the highest `mv` wins on wake. */
  meta: RoomMeta | null;
  mv: number;
}

const OPEN = 1;
/** More sockets than this per room are refused (6 peers + 10 waiting + reconnect slack). */
const MAX_SOCKETS_PER_ROOM = 40;
/** Sockets that aren't in the room for this long are closed. */
const IDLE_SOCKET_MS = 60 * 1000;

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

function attachment(ws: WebSocket): Attachment | null {
  try {
    return (ws.deserializeAttachment() as Attachment | null) ?? null;
  } catch {
    return null;
  }
}

export class SignalingRoom extends DurableObject<Env> {
  private room: Room<WebSocket> | null = null;
  private meta: RoomMeta | null = null;
  private metaVersion = 0;
  private readonly limiter = new RateLimiter<WebSocket>();
  /** Each socket's messages are handled one at a time (joins await hashing; no interleaving). */
  private readonly queues = new Map<WebSocket, Promise<void>>();
  /** Last alarm time we set (null = none); undefined = unknown, e.g. after waking from hibernation. */
  private scheduledDeadline: number | null | undefined = undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keepalive pings are answered by the runtime without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_MESSAGE, PONG_MESSAGE));
    ctx.blockConcurrencyWhile(async () => {
      // Older versions kept room metadata in storage: wipe anything left behind.
      const leftovers = await ctx.storage.list({ limit: 1 });
      if (leftovers.size > 0) {
        await ctx.storage.deleteAll();
        this.scheduledDeadline = undefined;
      }
      // Waking from hibernation: room id and the newest metadata come from the connected sockets.
      let roomId: string | undefined;
      for (const ws of ctx.getWebSockets()) {
        const att = attachment(ws);
        if (!att) continue;
        roomId ??= att.roomId;
        if (att.mv > this.metaVersion || (att.mv === this.metaVersion && att.meta && !this.meta)) {
          this.metaVersion = att.mv;
          this.meta = normalizeMeta(att.meta);
        }
      }
      if (roomId) this.room = this.createRoom(roomId);
    });
  }

  private createRoom(roomId: string): Room<WebSocket> {
    const members: [WebSocket, MemberState][] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const att = attachment(ws);
      if (att?.state) members.push([ws, att.state]);
    }
    if (members.length === 0) this.meta = null; // nobody in the room: nothing to restore
    return new Room(
      roomId,
      transport,
      {
        onMemberChange: (ws, state) => {
          const att = attachment(ws);
          if (!att) return;
          this.persist(ws, { ...att, state, idleSince: state ? att.idleSince : Date.now() });
        },
        onMetaChange: (next) => {
          // Copy the new metadata onto every socket so whichever survives can restore it.
          this.meta = next;
          this.metaVersion++;
          for (const ws of this.ctx.getWebSockets()) {
            const att = attachment(ws);
            if (att) this.persist(ws, att);
          }
        },
        // No logs by default; set DEBUG_LOGS=1 to print room activity.
        log: this.env.DEBUG_LOGS === '1' ? (m) => console.log(m) : undefined,
      },
      { meta: members.length > 0 ? this.meta : null, members }
    );
  }

  /** Write a socket's attachment with the current room metadata. */
  private persist(ws: WebSocket, att: Attachment): void {
    try {
      ws.serializeAttachment({ ...att, meta: this.meta, mv: this.metaVersion } satisfies Attachment);
    } catch {
      // socket already closed — attachment is discarded anyway
    }
  }

  async fetch(request: Request): Promise<Response> {
    const roomId = new URL(request.url).searchParams.get('room') ?? '';
    if (!isValidRoomId(roomId)) return new Response('Invalid room', { status: 400 });
    if (this.room && this.room.id !== roomId) return new Response('Invalid room', { status: 400 });
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS_PER_ROOM) {
      return new Response('Too many connections', { status: 503 });
    }

    if (!this.room) this.room = this.createRoom(roomId);

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    const now = Date.now();
    this.persist(server, {
      roomId,
      state: null,
      client: request.headers.get(CLIENT_HEADER) ?? 'unknown',
      connectedAt: now,
      idleSince: now,
      meta: null,
      mv: 0,
    });
    await this.scheduleAlarm();
    // Echo our protocol name when the client offered it (browsers reject the socket otherwise).
    const offered = parseWsProtocols(request.headers.get('Sec-WebSocket-Protocol')).protocols;
    const headers = offered.includes(WS_PROTOCOL) ? { 'Sec-WebSocket-Protocol': WS_PROTOCOL } : undefined;
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const next = (this.queues.get(ws) ?? Promise.resolve()).then(() => this.handleMessage(ws, message));
    this.queues.set(ws, next.catch(() => {}));
    try {
      await next;
    } finally {
      if (this.queues.get(ws) === next) this.queues.delete(ws);
    }
  }

  private async handleMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
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
      case 'join': {
        if (msg.roomId !== room.id) return this.sendError(ws, 'Room ID does not match connection');
        const clientId = attachment(ws)?.client;
        const args = { ...msg, clientId };
        if (resolveConfig(this.env).mode === 'private') {
          // Private mode: every entry needs a valid invite or host token.
          if (msg.type === 'create-room') return this.sendError(ws, 'Invite required');
          const decision = await authorizeJoin(this.env, msg, { clientId });
          if (!decision.ok) {
            if ('passwordRequired' in decision) {
              ws.send(JSON.stringify({ type: 'password-required', roomId: room.id, invalid: decision.invalid }));
            } else {
              this.sendError(ws, decision.error);
              // An invalid or expired invite won't get better: hang up.
              if (decision.fatal) transport.close(ws, CLOSE_INVALID_INVITE, decision.error);
            }
            return;
          }
          await room.enter(ws, args, decision.grant);
        } else if (msg.type === 'create-room') {
          await room.create(ws, args);
        } else {
          await room.join(ws, args);
        }
        if (ws.readyState !== OPEN) room.leave(ws);
        break;
      }
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
      case 'remove-peer':
        room.removePeer(ws, msg.peerId);
        break;
      case 'lock-room':
      case 'unlock-room':
        room.setLocked(ws, msg.type === 'lock-room');
        break;
      case 'end-room':
        // Members were told and closed by the Room. Close every other socket too (never entered,
        // password prompt, denied…), so no connection is left to keep a stale object around.
        if (room.endRoom(ws)) {
          for (const other of this.ctx.getWebSockets()) if (other.readyState === OPEN) transport.close(other, 1000, 'Closing');
        }
        break;
    }
    await this.scheduleAlarm();
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.queues.delete(ws);
    this.room?.leave(ws);
    // Complete the closing handshake (required before compatibility date 2026-04-07).
    transport.close(ws, 1000, 'Closing');
    await this.scheduleAlarm();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.room?.leave(ws);
    await this.scheduleAlarm();
  }

  async alarm(): Promise<void> {
    this.scheduledDeadline = null; // a fired alarm is cleared automatically
    const now = Date.now();
    this.room?.expireWaiting(now);
    // Close sockets that have been outside the room too long (never joined, or left/denied).
    for (const ws of this.ctx.getWebSockets()) {
      const att = attachment(ws);
      if (att && !this.room?.has(ws) && now - att.idleSince >= IDLE_SOCKET_MS) transport.close(ws, 4001, 'Idle');
    }
    await this.scheduleAlarm();
  }

  /** Keep one alarm at the earliest waiting-room or idle-socket deadline. Cheap no-op when unchanged. */
  private async scheduleAlarm(): Promise<void> {
    let deadline = this.room?.nextWaitingDeadline() ?? null;
    for (const ws of this.ctx.getWebSockets()) {
      const att = attachment(ws);
      if (!att || this.room?.has(ws) || ws.readyState !== OPEN) continue;
      const idleDeadline = att.idleSince + IDLE_SOCKET_MS;
      if (deadline === null || idleDeadline < deadline) deadline = idleDeadline;
    }
    if (deadline === this.scheduledDeadline) return;
    if (deadline === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(deadline, Date.now() + 1000));
    this.scheduledDeadline = deadline;
  }

  private sendError(ws: WebSocket, message: string): void {
    if (ws.readyState === OPEN) ws.send(JSON.stringify({ type: 'error', message }));
  }
}
