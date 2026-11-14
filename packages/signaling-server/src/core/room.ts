// Transport-agnostic room logic. One `Room` instance == one call.
// The Node server keeps a Map<roomId, Room>; the Cloudflare backend runs one Room per Durable Object.

import {
  MAX_NAME_LENGTH,
  MAX_PEERS_PER_ROOM,
  MAX_WAITING_PER_ROOM,
  WAITING_TIMEOUT_MS,
  nameKey,
  sha256Hex,
  sliceCodePoints,
} from './protocol.js';
import { passwordAttempts } from './throttle.js';

export interface Transport<C> {
  send(conn: C, data: string): void;
  isOpen(conn: C): boolean;
  close(conn: C, code: number, reason: string): void;
}

export interface MemberState {
  peerId: string;
  displayName: string;
  status: 'peer' | 'waiting';
  /** Truncated sha256 of the client's per-tab secret (hash of '' if none was sent). */
  secretHash: string;
  /** Set while status === 'waiting'. */
  waitingSince?: number;
  /** Private mode only: invited guests can never hold host powers. Undefined in open mode. */
  role?: 'host' | 'guest';
  /** Emailed invites: the address the invite was sent to (from the signed token). */
  email?: string;
}

export interface AdmittedEntry {
  /** Secret hash the peer was admitted with. */
  h: string;
  /** Role it was admitted with ('open' in open mode). */
  r: 'host' | 'guest' | 'open';
}

export interface BarEntry {
  /** peerId */
  p: string;
  /** secret hash ('' if the peer sent no secret) */
  h: string;
  /** Unix ms when the bar lifts (absent = for the rest of the room's life). */
  u?: number;
  /** Emailed invites: the address the person's invite was sent to (barred with them). */
  e?: string;
}

export interface RoomMeta {
  hostPeerId: string | null;
  /** Open mode only: salted SHA-256 of the room password. */
  passwordHash: string | null;
  /** Per-room random salt for passwordHash. */
  passwordSalt?: string;
  /** peerId -> how they were admitted, for everyone admitted while this room has existed. */
  admitted: Record<string, AdmittedEntry>;
  /** Removed by the host: refused for the rest of the room's life. */
  removed: BarEntry[];
  /** Denied by the host while waiting: can't ask again until `u`. */
  denied: BarEntry[];
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
  /**
   * Opaque client id (IP or a keyed hash of it) for password-guess throttling. Set by the backend,
   * never taken from the client's message.
   */
  clientId?: string;
}

/** What a verified invite/host token allows (private mode). */
export interface EnterGrant {
  role: 'host' | 'guest';
  /** Guests must be approved by the host before joining. */
  approval: boolean;
  /** Emailed invites: the verified address, shown to the host in admission-request. */
  email?: string;
}

/** Remember at most this many admitted peers (for rejoin-without-approval); oldest are dropped. */
export const MAX_ADMITTED = 48;
/** …of which at most this many host-role entries (the owner's own tabs/devices). */
const MAX_HOST_ADMITTED = 8;
export const MAX_REMOVED = 32;
export const MAX_DENIED = 16;
/** A guest the host denied can't ask again for this long. */
export const DENY_COOLDOWN_MS = 5 * 60 * 1000;
/** Close code sent to a participant the host removed. Clients must not reconnect. */
export const CLOSE_REMOVED = 4002;
/** Close code for a connection replaced by the same identity elsewhere. */
export const CLOSE_REPLACED = 4000;

function emptyMeta(): RoomMeta {
  return { hostPeerId: null, passwordHash: null, admitted: {}, removed: [], denied: [], createdAt: Date.now() };
}

/** Accept metadata restored from storage written by any version. */
export function normalizeMeta(meta: Partial<RoomMeta> | null | undefined): RoomMeta | null {
  if (!meta || typeof meta !== 'object') return null;
  const admitted: Record<string, AdmittedEntry> = {};
  for (const [id, e] of Object.entries(meta.admitted ?? {})) {
    if (e && typeof e === 'object' && typeof (e as AdmittedEntry).h === 'string') admitted[id] = e as AdmittedEntry;
  }
  return {
    hostPeerId: meta.hostPeerId ?? null,
    passwordHash: meta.passwordHash ?? null,
    ...(meta.passwordSalt ? { passwordSalt: meta.passwordSalt } : {}),
    admitted,
    removed: Array.isArray(meta.removed) ? meta.removed : [],
    denied: Array.isArray(meta.denied) ? meta.denied : [],
    createdAt: meta.createdAt ?? Date.now(),
  };
}

/** hashSecret(undefined): sha256('') truncated. */
const EMPTY_SECRET_HASH = 'e3b0c44298fc1c149afbf4c8996fb924';

async function hashSecret(secret: string | undefined): Promise<string> {
  return (await sha256Hex(secret ?? '')).slice(0, 32);
}

function randomSalt(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(salt: string, password: string): Promise<string> {
  return sha256Hex(`room-password:${salt}:${password}`);
}

/** What the host is told about someone waiting: `email` only for emailed invites. */
function admissionRequest(s: MemberState): object {
  return { type: 'admission-request', peerId: s.peerId, displayName: s.displayName, ...(s.email ? { email: s.email } : {}) };
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
    this.meta = normalizeMeta(restore?.meta) ?? emptyMeta();
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
    const salt = randomSalt();
    const [secretHash, passwordHash] = await Promise.all([
      hashSecret(args.secret),
      args.password ? hashPassword(salt, args.password) : Promise.resolve(null),
    ]);

    if (this.exists()) {
      this.error(conn, 'Room already exists');
      return;
    }
    this.removeQuietly(conn);

    this.meta = {
      ...emptyMeta(),
      hostPeerId: args.peerId,
      passwordHash,
      ...(passwordHash ? { passwordSalt: salt } : {}),
      admitted: { [args.peerId]: { h: secretHash, r: 'open' } },
    };
    this.setMember(conn, { peerId: args.peerId, displayName: args.displayName, status: 'peer', secretHash });
    this.metaChanged();

    this.send(conn, { type: 'room-created', roomId: this.id });
    this.send(conn, { type: 'room-peers', peers: [], roomId: this.id });
    this.send(conn, { type: 'host-changed', hostPeerId: args.peerId });
    this.log(`${args.displayName} (${args.peerId}) created room`);
  }

  async join(conn: C, args: EnterArgs): Promise<void> {
    const salt = this.meta.passwordSalt ?? '';
    const [secretHash, passwordHash] = await Promise.all([
      hashSecret(args.secret),
      args.password ? hashPassword(salt, args.password) : Promise.resolve(null),
    ]);

    if (!this.exists()) {
      this.error(conn, 'Room does not exist');
      return;
    }
    this.removeQuietly(conn);
    if (this.refuseBarred(conn, args, secretHash)) return;

    const prior = this.meta.admitted[args.peerId];
    const isReturning = !!args.secret && prior?.h === secretHash;
    if (prior && !isReturning) {
      // Someone else's identity — even if they're offline right now.
      this.error(conn, 'Peer ID already in use');
      return;
    }
    if (!this.replaceDuplicate(conn, args.peerId, secretHash, args.secret, isReturning, undefined)) return;

    if (!isReturning && this.meta.passwordHash) {
      if (!args.password) {
        this.send(conn, { type: 'password-required', roomId: this.id, invalid: false });
        return;
      }
      if (!passwordAttempts.take(this.id, args.clientId)) {
        this.error(conn, 'Too many password attempts');
        return;
      }
      // (The salt can only change if the room was re-created while we were hashing.)
      if (salt !== (this.meta.passwordSalt ?? '') || passwordHash !== this.meta.passwordHash) {
        this.send(conn, { type: 'password-required', roomId: this.id, invalid: true });
        return;
      }
      passwordAttempts.refund(this.id, args.clientId);
    }

    if (this.peers().length >= MAX_PEERS_PER_ROOM) {
      this.error(conn, 'Room is full');
      return;
    }

    const displayName = this.uniqueName(args.displayName, args.peerId);
    const host = this.currentHost();
    if (isReturning || !host) {
      this.admit(conn, { peerId: args.peerId, displayName, status: 'peer', secretHash });
      return;
    }

    if (this.waiting().length >= MAX_WAITING_PER_ROOM) {
      this.error(conn, 'Too many people waiting to join');
      return;
    }

    this.setMember(conn, {
      peerId: args.peerId,
      displayName,
      status: 'waiting',
      secretHash,
      waitingSince: Date.now(),
    });
    this.send(conn, { type: 'waiting-for-admission', roomId: this.id, hostPresent: true });
    this.send(host[0], { type: 'admission-request', peerId: args.peerId, displayName });
    this.log(`${displayName} (${args.peerId}) waiting for admission`);
  }

  /**
   * Private mode: enter with a verified invite or host token. The server has already checked the
   * token's signature, room and password. Hosts always get in (and take the host role); guests get
   * in directly unless the invite requires approval.
   */
  async enter(conn: C, args: EnterArgs, grant: EnterGrant): Promise<void> {
    const secretHash = await hashSecret(args.secret);
    this.removeQuietly(conn);
    const isHost = grant.role === 'host';
    if (!isHost && this.refuseBarred(conn, args, secretHash, grant.email)) return;

    const prior = this.meta.admitted[args.peerId];
    // A guest can never step into an identity admitted as host, even with the right secret.
    const isReturning = !!args.secret && prior?.h === secretHash && (prior.r !== 'host' || isHost);
    if (prior && !isReturning && !isHost) {
      // Someone else's identity — even if they're offline right now. (The owner may always reclaim.)
      this.error(conn, 'Peer ID already in use');
      return;
    }
    if (!this.replaceDuplicate(conn, args.peerId, secretHash, args.secret, isReturning || isHost, grant.role)) return;

    // The owner can always get into their own room, even if guests filled it: one seat over the
    // limit, and only while no host-role member is already present.
    const peers = this.peers();
    const ownerSeat = isHost && peers.length < MAX_PEERS_PER_ROOM + 1 && !peers.some(([, s]) => s.role === 'host');
    if (peers.length >= MAX_PEERS_PER_ROOM && !ownerSeat) {
      this.error(conn, 'Room is full');
      return;
    }

    const state: MemberState = {
      peerId: args.peerId,
      displayName: this.uniqueName(args.displayName, args.peerId),
      status: 'peer',
      secretHash,
      role: grant.role,
      ...(grant.role === 'guest' && grant.email ? { email: grant.email } : {}),
    };
    // Once the host has removed someone, every new guest needs approval for the rest of the call —
    // even on an invite that doesn't ask for it. A removed person still holds the invite link and can
    // come back with a fresh identity (new tab), so the bar on their old one isn't enough by itself.
    const approval = grant.approval || this.meta.removed.length > 0;
    if (isHost || isReturning || !approval) {
      this.admit(conn, state);
      return;
    }

    if (this.waiting().length >= MAX_WAITING_PER_ROOM) {
      this.error(conn, 'Too many people waiting to join');
      return;
    }
    this.setMember(conn, { ...state, status: 'waiting', waitingSince: Date.now() });
    this.send(conn, { type: 'waiting-for-admission', roomId: this.id, hostPresent: !!this.currentHost() });
    this.notifyHost(admissionRequest(state));
    this.log(`${state.displayName} (${args.peerId}) waiting for admission`);
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
    // Can't knock again for a while (stops a denied guest flooding the host with requests).
    this.bar(
      this.meta.denied,
      { p: state.peerId, h: this.barHash(state.secretHash), u: Date.now() + DENY_COOLDOWN_MS, ...(state.email ? { e: state.email } : {}) },
      MAX_DENIED
    );
    this.send(conn, { type: 'admission-denied', roomId: this.id, reason: 'Denied by host' });
    this.removeQuietly(conn);
    this.metaChanged();
    this.log(`Host denied ${state.displayName} (${state.peerId})`);
  }

  /**
   * Host only: remove a participant (or waiting guest). They're told (`removed`), their socket is
   * closed with CLOSE_REMOVED, and their peerId + secret are refused for the rest of the room's life.
   */
  removePeer(hostConn: C, peerId: string): void {
    if (!this.requireHost(hostConn, 'remove')) return;
    if (this.members.get(hostConn)?.peerId === peerId) {
      this.error(hostConn, "You can't remove yourself");
      return;
    }
    const entry = this.findByPeerId(peerId);
    const admitted = this.meta.admitted[peerId];
    if (!entry && !admitted) {
      this.error(hostConn, 'Peer not found');
      return;
    }
    if (entry?.[1].role === 'host' || admitted?.r === 'host') {
      this.error(hostConn, "The owner can't be removed");
      return;
    }
    delete this.meta.admitted[peerId];
    const removedEmail = entry?.[1].email;
    this.bar(
      this.meta.removed,
      { p: peerId, h: this.barHash(entry?.[1].secretHash ?? admitted?.h ?? ''), ...(removedEmail ? { e: removedEmail } : {}) },
      MAX_REMOVED
    );
    if (entry) {
      const [conn, state] = entry;
      this.send(conn, { type: 'removed', roomId: this.id, reason: 'Removed by host' });
      this.leave(conn);
      this.transport.close(conn, CLOSE_REMOVED, 'Removed by host');
      this.log(`Host removed ${state.displayName} (${peerId})`);
    }
    this.metaChanged();
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
      this.resetIfEmpty();
      return;
    }

    this.broadcast({ type: 'peer-left', peerId: state.peerId, displayName: state.displayName });
    this.log(`${state.displayName} (${state.peerId}) left`);

    const remaining = this.peers();
    if (remaining.length === 0) {
      const waiting = this.waiting();
      // Private mode: invited guests keep waiting (the owner may just be refreshing); they time
      // out on their own. Open mode: the last person out closes the room.
      if (waiting.some(([, w]) => w.role === 'guest')) {
        this.meta.hostPeerId = null;
        this.metaChanged();
        for (const [wConn] of waiting) this.send(wConn, { type: 'waiting-for-admission', roomId: this.id, hostPresent: false });
        return;
      }
      for (const [wConn] of waiting) {
        this.send(wConn, { type: 'admission-denied', roomId: this.id, reason: 'Room closed' });
        this.deleteMember(wConn);
      }
      this.reset();
      return;
    }

    if (this.meta.hostPeerId === state.peerId) {
      // Invited guests never inherit host powers (they could approve other guests).
      const next = remaining.find(([, s]) => s.role !== 'guest');
      this.setHost(next ? next[1].peerId : null);
    }
  }

  /** Deny anyone who has been waiting longer than WAITING_TIMEOUT_MS. */
  expireWaiting(now = Date.now()): void {
    let expired = false;
    for (const [conn, s] of this.waiting()) {
      if ((s.waitingSince ?? 0) + WAITING_TIMEOUT_MS <= now) {
        this.send(conn, { type: 'admission-denied', roomId: this.id, reason: 'Timed out waiting for host' });
        this.deleteMember(conn);
        this.notifyHost({ type: 'admission-cancelled', peerId: s.peerId });
        expired = true;
      }
    }
    if (expired) this.resetIfEmpty();
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private admit(conn: C, state: MemberState): void {
    const existingPeers = this.peers()
      .filter(([c]) => c !== conn)
      .map(([, s]) => ({ id: s.peerId, displayName: s.displayName }));

    this.setMember(conn, state);
    delete this.meta.admitted[state.peerId]; // re-insert so key order tracks recency
    this.meta.admitted[state.peerId] = { h: state.secretHash, r: state.role ?? 'open' };
    this.trimAdmitted();
    this.metaChanged();

    this.send(conn, { type: 'room-peers', peers: existingPeers, roomId: this.id });
    this.broadcast({ type: 'peer-joined', peerId: state.peerId, displayName: state.displayName }, conn);

    const host = this.currentHost();
    if (state.role === 'host' && host?.[1].peerId !== state.peerId) {
      // The owner arriving (or returning) always takes the host role.
      this.setHost(state.peerId);
    } else if (!host && state.role !== 'guest') {
      // Nobody holds the host role — the newcomer takes it (open mode).
      this.setHost(state.peerId);
    } else {
      this.send(conn, { type: 'host-changed', hostPeerId: host ? this.meta.hostPeerId : null });
    }
    this.log(`${state.displayName} (${state.peerId}) joined`);
  }

  /**
   * Bound the admitted list. Cycling through fresh peerIds must never push out the host's entry or
   * anyone currently in the room, so those are skipped; host-role entries have their own small cap.
   */
  private trimAdmitted(): void {
    const present = new Set([...this.members.values()].map((m) => m.peerId));
    const protectedId = (id: string) => present.has(id) || id === this.meta.hostPeerId;
    const ids = Object.keys(this.meta.admitted);
    let excess = ids.length - MAX_ADMITTED;
    for (const id of ids) {
      if (excess <= 0) break;
      if (this.meta.admitted[id].r === 'host' || protectedId(id)) continue;
      delete this.meta.admitted[id];
      excess--;
    }
    const hostIds = Object.keys(this.meta.admitted).filter((id) => this.meta.admitted[id].r === 'host' && !protectedId(id));
    for (const id of hostIds.slice(0, Math.max(0, hostIds.length - MAX_HOST_ADMITTED))) delete this.meta.admitted[id];
  }

  /** Secret hashes of peers who sent no secret aren't identifying, so they're never matched. */
  private barHash(secretHash: string): string {
    return secretHash === EMPTY_SECRET_HASH ? '' : secretHash;
  }

  private bar(list: BarEntry[], entry: BarEntry, max: number): void {
    const now = Date.now();
    const kept = list.filter((e) => (e.u === undefined || e.u > now) && e.p !== entry.p);
    kept.push(entry);
    list.splice(0, list.length, ...kept.slice(-max));
  }

  /**
   * Refuse a peerId/secret the host removed (for good) or denied (for a few minutes). A personal
   * (emailed) invite is barred with its holder: a new tab doesn't get them past a removal.
   */
  private refuseBarred(conn: C, args: EnterArgs, secretHash: string, email?: string): boolean {
    const now = Date.now();
    const matches = (e: BarEntry) =>
      e.p === args.peerId || (!!args.secret && e.h !== '' && e.h === secretHash) || (!!email && e.e === email);
    if (this.meta.removed.some(matches)) {
      this.send(conn, { type: 'removed', roomId: this.id, reason: 'Removed by host' });
      this.transport.close(conn, CLOSE_REMOVED, 'Removed by host');
      return true;
    }
    if (this.meta.denied.some((e) => (e.u ?? 0) > now && matches(e))) {
      this.send(conn, { type: 'admission-denied', roomId: this.id, reason: 'Denied by host' });
      return true;
    }
    return false;
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

  /**
   * Make a display name unique in the room ("Alex", "Alex (2)") so nobody can pose as someone else.
   * Names are compared after folding case, accents, compatibility forms and common look-alikes.
   */
  private uniqueName(name: string, peerId: string): string {
    const taken = new Set([...this.members.values()].filter((m) => m.peerId !== peerId).map((m) => nameKey(m.displayName)));
    if (!taken.has(nameKey(name))) return name;
    for (let n = 2; n < 100; n++) {
      const suffix = ` (${n})`;
      const candidate = sliceCodePoints(name, MAX_NAME_LENGTH - suffix.length).trimEnd() + suffix;
      if (!taken.has(nameKey(candidate))) return candidate;
    }
    return name;
  }

  /** Give (or clear) the host role, tell everyone, and hand the new host any pending requests. */
  private setHost(peerId: string | null): void {
    this.meta.hostPeerId = peerId;
    this.metaChanged();
    this.broadcast({ type: 'host-changed', hostPeerId: peerId });
    for (const [, w] of this.waiting()) {
      this.notifyHost(admissionRequest(w));
    }
  }

  /**
   * Handle a peerId that's already present on another connection. It may be replaced when
   * `allowed` (returning peer or owner) or when the live connection has the same secret; a guest
   * can never replace a host-role connection. Returns false if the newcomer was refused.
   */
  private replaceDuplicate(
    conn: C,
    peerId: string,
    secretHash: string,
    secret: string | undefined,
    allowed: boolean,
    role: 'host' | 'guest' | undefined
  ): boolean {
    const duplicate = this.findByPeerId(peerId);
    if (!duplicate) return true;
    const [oldConn, oldState] = duplicate;
    const sameSecret = !!secret && oldState.secretHash === secretHash;
    if ((!allowed && !sameSecret) || (oldState.role === 'host' && role === 'guest')) {
      this.error(conn, 'Peer ID already in use');
      return false;
    }
    this.deleteMember(oldConn);
    if (oldState.status === 'peer') {
      this.broadcast({ type: 'peer-left', peerId: oldState.peerId, displayName: oldState.displayName });
    }
    this.transport.close(oldConn, CLOSE_REPLACED, 'Replaced by new connection');
    return true;
  }

  private requireHost(conn: C, action: string): boolean {
    const state = this.members.get(conn);
    if (!state || state.status !== 'peer' || state.role === 'guest' || state.peerId !== this.meta.hostPeerId) {
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

  /** Nobody left (peers or waiting): forget everything about the room. */
  private resetIfEmpty(): void {
    if (this.members.size === 0) this.reset();
  }

  private reset(): void {
    this.meta = emptyMeta();
    this.hooks.onMetaChange?.(null);
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
