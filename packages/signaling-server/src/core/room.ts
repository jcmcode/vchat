// Transport-agnostic room logic. One `Room` instance == one call.
// The Node server keeps a Map<roomId, Room>; the Cloudflare backend runs one Room per Durable Object.

import {
  MAX_PEERS_PER_ROOM,
  MAX_WAITING_PER_ROOM,
  WAITING_TIMEOUT_MS,
  sha256Hex,
} from './protocol.js';

export interface Transport<C> {
  send(conn: C, data: string): void;
  isOpen(conn: C): boolean;
  close(conn: C, code: number, reason: string): void;
}

export interface MemberState {
  peerId: string;
  displayName: string;
  status: 'peer' | 'waiting';
  /** sha256 of the client's per-tab secret ('' if none was sent). */
  secretHash: string;
  /** Set while status === 'waiting'. */
  waitingSince?: number;
}

export interface RoomMeta {
  hostPeerId: string | null;
  passwordHash: string | null;
  /** peerId -> secretHash for everyone admitted while this room has existed. */
  admitted: Record<string, string>;
  createdAt: number;
}

export interface RoomHooks<C> {
  /** Called whenever a connection's member state changes (null = removed). */
  onMemberChange?(conn: C, state: MemberState | null): void;
  /** Called whenever room metadata changes (null = room is now empty/closed). */
  onMetaChange?(meta: RoomMeta | null): void;
  log?(message: string): void;
}

export interface EnterArgs {
  peerId: string;
  displayName: string;
  password?: string;
  secret?: string;
}

function emptyMeta(): RoomMeta {
  return { hostPeerId: null, passwordHash: null, admitted: {}, createdAt: Date.now() };
}

export class Room<C> {
  readonly id: string;
  meta: RoomMeta;
  readonly members = new Map<C, MemberState>();

  constructor(
    id: string,
    private readonly transport: Transport<C>,
    private readonly hooks: RoomHooks<C> = {},
    restore?: { meta: RoomMeta | null; members: Iterable<[C, MemberState]> }
  ) {
    this.id = id;
    this.meta = restore?.meta ?? emptyMeta();
    if (restore) {
      for (const [conn, state] of restore.members) this.members.set(conn, state);
    }
  }

  // ── Queries ────────────────────────────────────────────────────────────

  /** A room "exists" while at least one admitted peer is in it. */
  exists(): boolean {
    return this.peers().length > 0;
  }

  isEmpty(): boolean {
    return this.members.size === 0;
  }

  peers(): [C, MemberState][] {
    return [...this.members].filter(([, s]) => s.status === 'peer');
  }

  waiting(): [C, MemberState][] {
    return [...this.members].filter(([, s]) => s.status === 'waiting');
  }

  has(conn: C): boolean {
    return this.members.has(conn);
  }

  nextWaitingDeadline(): number | null {
    let next: number | null = null;
    for (const [, s] of this.waiting()) {
      const deadline = (s.waitingSince ?? 0) + WAITING_TIMEOUT_MS;
      if (next === null || deadline < next) next = deadline;
    }
    return next;
  }

  // ── Commands ───────────────────────────────────────────────────────────

  async create(conn: C, args: EnterArgs): Promise<void> {
    // Hash before touching state so no other message can interleave mid-update.
    const [secretHash, passwordHash] = await Promise.all([
      sha256Hex(args.secret ?? ''),
      args.password ? sha256Hex(args.password) : Promise.resolve(null),
    ]);

    if (this.exists()) {
      this.error(conn, 'Room already exists');
      return;
    }
    this.removeQuietly(conn);

    this.meta = {
      hostPeerId: args.peerId,
      passwordHash,
      admitted: { [args.peerId]: secretHash },
      createdAt: Date.now(),
    };
    this.setMember(conn, { peerId: args.peerId, displayName: args.displayName, status: 'peer', secretHash });
    this.metaChanged();

    this.send(conn, { type: 'room-created', roomId: this.id });
    this.send(conn, { type: 'room-peers', peers: [], roomId: this.id });
    this.send(conn, { type: 'host-changed', hostPeerId: args.peerId });
    this.log(`${args.displayName} (${args.peerId}) created room`);
  }

  async join(conn: C, args: EnterArgs): Promise<void> {
    const [secretHash, passwordHash] = await Promise.all([
      sha256Hex(args.secret ?? ''),
      args.password ? sha256Hex(args.password) : Promise.resolve(null),
    ]);

    if (!this.exists()) {
      this.error(conn, 'Room does not exist');
      return;
    }
    this.removeQuietly(conn);

    const isReturning = !!args.secret && this.meta.admitted[args.peerId] === secretHash;

    // Same peerId already present on another connection?
    const duplicate = this.findByPeerId(args.peerId);
    if (duplicate) {
      if (!isReturning) {
        this.error(conn, 'Peer ID already in use');
        return;
      }
      // A returning peer whose old connection hasn't timed out yet — replace it without
      // closing the room or moving the host role.
      const [oldConn, oldState] = duplicate;
      this.deleteMember(oldConn);
      if (oldState.status === 'peer') {
        this.broadcast({ type: 'peer-left', peerId: oldState.peerId, displayName: oldState.displayName });
      }
      this.transport.close(oldConn, 4000, 'Replaced by new connection');
    }

    if (!isReturning && this.meta.passwordHash && passwordHash !== this.meta.passwordHash) {
      this.send(conn, { type: 'password-required', roomId: this.id, invalid: !!args.password });
      return;
    }

    if (this.peers().length >= MAX_PEERS_PER_ROOM) {
      this.error(conn, 'Room is full');
      return;
    }

    const host = this.currentHost();
    if (isReturning || !host) {
      this.admit(conn, { peerId: args.peerId, displayName: args.displayName, status: 'peer', secretHash });
      return;
    }

    if (this.waiting().length >= MAX_WAITING_PER_ROOM) {
      this.error(conn, 'Too many people waiting to join');
      return;
    }

    this.setMember(conn, {
      peerId: args.peerId,
      displayName: args.displayName,
      status: 'waiting',
      secretHash,
      waitingSince: Date.now(),
    });
    this.send(conn, { type: 'waiting-for-admission', roomId: this.id });
    this.send(host[0], { type: 'admission-request', peerId: args.peerId, displayName: args.displayName });
    this.log(`${args.displayName} (${args.peerId}) waiting for admission`);
  }

  admitPeer(hostConn: C, peerId: string): void {
    if (!this.requireHost(hostConn, 'admit')) return;
    const entry = this.findByPeerId(peerId);
    if (!entry || entry[1].status !== 'waiting') {
      this.error(hostConn, 'Peer not in waiting queue');
      return;
    }
    const [conn, state] = entry;
    if (this.peers().length >= MAX_PEERS_PER_ROOM) {
      this.send(conn, { type: 'admission-denied', roomId: this.id, reason: 'Room is full' });
      this.removeQuietly(conn);
      this.error(hostConn, 'Room is full');
      return;
    }
    this.send(conn, { type: 'admission-granted', roomId: this.id });
    this.admit(conn, { ...state, status: 'peer', waitingSince: undefined });
  }

  denyPeer(hostConn: C, peerId: string): void {
    if (!this.requireHost(hostConn, 'deny')) return;
    const entry = this.findByPeerId(peerId);
    if (!entry || entry[1].status !== 'waiting') return;
    const [conn, state] = entry;
    this.send(conn, { type: 'admission-denied', roomId: this.id, reason: 'Denied by host' });
    this.removeQuietly(conn);
    this.log(`Host denied ${state.displayName} (${state.peerId})`);
  }

  signal(conn: C, targetPeerId: string, signal: unknown): void {
    const from = this.members.get(conn);
    if (!from || from.status !== 'peer') return;
    const target = this.findByPeerId(targetPeerId);
    if (!target || target[1].status !== 'peer') return;
    this.send(target[0], { type: 'signal', fromPeerId: from.peerId, signal });
  }

  /** Remove a connection (explicit leave, socket close, or error). Safe to call repeatedly. */
  leave(conn: C): void {
    const state = this.members.get(conn);
    if (!state) return;
    this.deleteMember(conn);

    if (state.status === 'waiting') {
      this.notifyHost({ type: 'admission-cancelled', peerId: state.peerId });
      this.log(`${state.displayName} (${state.peerId}) stopped waiting`);
      return;
    }

    this.broadcast({ type: 'peer-left', peerId: state.peerId, displayName: state.displayName });
    this.log(`${state.displayName} (${state.peerId}) left`);

    const remaining = this.peers();
    if (remaining.length === 0) {
      // Last person out closes the room and turns away anyone still waiting.
      for (const [wConn] of this.waiting()) {
        this.send(wConn, { type: 'admission-denied', roomId: this.id, reason: 'Room closed' });
        this.deleteMember(wConn);
      }
      this.meta = emptyMeta();
      this.hooks.onMetaChange?.(null);
      return;
    }

    if (this.meta.hostPeerId === state.peerId) {
      const [, next] = remaining[0];
      this.meta.hostPeerId = next.peerId;
      this.metaChanged();
      this.broadcast({ type: 'host-changed', hostPeerId: next.peerId });
      for (const [, w] of this.waiting()) {
        this.notifyHost({ type: 'admission-request', peerId: w.peerId, displayName: w.displayName });
      }
    }
  }

  /** Deny anyone who has been waiting longer than WAITING_TIMEOUT_MS. */
  expireWaiting(now = Date.now()): void {
    for (const [conn, s] of this.waiting()) {
      if ((s.waitingSince ?? 0) + WAITING_TIMEOUT_MS <= now) {
        this.send(conn, { type: 'admission-denied', roomId: this.id, reason: 'Timed out waiting for host' });
        this.deleteMember(conn);
        this.notifyHost({ type: 'admission-cancelled', peerId: s.peerId });
      }
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private admit(conn: C, state: MemberState): void {
    const existingPeers = this.peers()
      .filter(([c]) => c !== conn)
      .map(([, s]) => ({ id: s.peerId, displayName: s.displayName }));

    this.setMember(conn, state);
    this.meta.admitted[state.peerId] = state.secretHash;
    this.metaChanged();

    this.send(conn, { type: 'room-peers', peers: existingPeers, roomId: this.id });
    this.broadcast({ type: 'peer-joined', peerId: state.peerId, displayName: state.displayName }, conn);

    if (!this.currentHost()) {
      // Nobody holds the host role (shouldn't normally happen) — the newcomer takes it.
      this.meta.hostPeerId = state.peerId;
      this.metaChanged();
      this.broadcast({ type: 'host-changed', hostPeerId: state.peerId });
    } else {
      this.send(conn, { type: 'host-changed', hostPeerId: this.meta.hostPeerId });
    }
    this.log(`${state.displayName} (${state.peerId}) joined`);
  }

  /** Drop a connection's membership without announcing it (used before re-entering). */
  private removeQuietly(conn: C): void {
    const state = this.members.get(conn);
    if (!state) return;
    if (state.status === 'waiting') {
      this.deleteMember(conn);
      this.notifyHost({ type: 'admission-cancelled', peerId: state.peerId });
    } else {
      this.leave(conn);
    }
  }

  private requireHost(conn: C, action: string): boolean {
    const state = this.members.get(conn);
    if (!state || state.status !== 'peer' || state.peerId !== this.meta.hostPeerId) {
      this.error(conn, `Only the host can ${action} peers`);
      return false;
    }
    return true;
  }

  private currentHost(): [C, MemberState] | undefined {
    if (!this.meta.hostPeerId) return undefined;
    const host = this.findByPeerId(this.meta.hostPeerId);
    return host && host[1].status === 'peer' ? host : undefined;
  }

  private findByPeerId(peerId: string): [C, MemberState] | undefined {
    for (const entry of this.members) if (entry[1].peerId === peerId) return entry;
    return undefined;
  }

  private notifyHost(message: object): void {
    const host = this.currentHost();
    if (host) this.send(host[0], message);
  }

  private setMember(conn: C, state: MemberState): void {
    this.members.set(conn, state);
    this.hooks.onMemberChange?.(conn, state);
  }

  private deleteMember(conn: C): void {
    this.members.delete(conn);
    this.hooks.onMemberChange?.(conn, null);
  }

  private metaChanged(): void {
    this.hooks.onMetaChange?.(this.meta);
  }

  private broadcast(message: object, exclude?: C): void {
    const data = JSON.stringify(message);
    for (const [conn] of this.peers()) {
      if (conn !== exclude) this.sendRaw(conn, data);
    }
  }

  private send(conn: C, message: object): void {
    this.sendRaw(conn, JSON.stringify(message));
  }

  private sendRaw(conn: C, data: string): void {
    if (!this.transport.isOpen(conn)) return;
    try {
      this.transport.send(conn, data);
    } catch {
      // Socket closed between the check and the send — close handler will clean up.
    }
  }

  private error(conn: C, message: string): void {
    this.send(conn, { type: 'error', message });
  }

  private log(message: string): void {
    this.hooks.log?.(`[${this.id}] ${message}`);
  }
}
