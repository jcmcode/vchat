// Games in a call: two people play (Connect 4, chess or pool) and everyone else can watch.
// Everything travels over the peer-to-peer data channels (end-to-end encrypted); the server never
// sees a game. One game at a time per call.
//
// Only moves are sent. Each side applies them with the game's rules (session-model.ts), so a move
// that isn't legal, or isn't from the player whose turn it is, simply doesn't count.
//
// A game starts only once the other person agrees: you invite them (sent to them alone), they
// accept or decline, and on "accept" the one who invited starts the game for everyone.

import { get, writable } from 'svelte/store';
import { nanoid } from 'nanoid';
import {
  broadcastData,
  getLocalPeerId,
  getPeerConnection,
  onPeerConnected,
  onPeerLeft,
  onRoomLeft,
  peerDisplayName,
  peers,
  registerDataHandler,
  sendData,
} from '../webrtc/mesh.js';
import {
  fromSnapshot,
  isGameKind,
  newSession,
  resultOf,
  seatOf,
  shouldAdopt,
  stop,
  toSnapshot,
  tryMove,
  turnOf,
  type GameKind,
  type Session,
} from './session-model.js';
import { INVITE_TTL_MS, InviteBook, type Invite } from './invite-model.js';
import { closeWhiteboard } from '../collab/whiteboard.js';

/** The game in this call (a fresh object on every change, so components update). */
export const gameSession = writable<Session | null>(null);
/** You have the games view open. */
export const gamesOpen = writable(false);
/** Someone started a game (shown as an invitation to open it). */
export const gameNotice = writable<{ name: string; kind: GameKind; withYou: boolean } | null>(null);

/** Where the player to move is aiming right now (pool). Display only. */
export interface Aim {
  dx: number;
  dy: number;
  power: number;
  cue?: { x: number; y: number };
}
export const gameAim = writable<Aim | null>(null);

/** An invitation someone sent you, waiting for your answer. */
export interface IncomingInvite extends Invite {
  /** The name this app shows for them (never text from the message). */
  name: string;
}
export const incomingInvites = writable<IncomingInvite[]>([]);

/** The invitation you sent, and what became of it. */
export interface OutgoingInvite {
  id: string;
  kind: GameKind;
  to: string;
  name: string;
  status: 'waiting' | 'declined' | 'busy' | 'expired';
  /** Asking for another game with the same person (they move first this time). */
  rematch: boolean;
}
export const outgoingInvite = writable<OutgoingInvite | null>(null);

let current: Session | null = null;

const STATE_INTERVAL_MS = 400;
const SYNC_REQ_INTERVAL_MS = 1500;
const AIM_INTERVAL_MS = 70;
const lastState = new Map<string, number>();
const lastSyncReq = new Map<string, number>();
let lastAskedSync = 0;

const invites = new InviteBook();
const inviteTimers = new Set<ReturnType<typeof setTimeout>>();
let outgoing: (OutgoingInvite & { players: [string, string] | null }) | null = null;
let outgoingTimer: ReturnType<typeof setTimeout> | null = null;
/** How long "they said no" stays on screen. */
const ANSWER_SHOWN_MS = 8_000;

function publish(): void {
  gameSession.set(current ? { ...current } : null);
}

function present(peerId: string): boolean {
  return peerId === getLocalPeerId() || !!getPeerConnection(peerId)?.trusted;
}

/** Still going, with both players here. */
function inPlay(session: Session | null): boolean {
  return !!session && !resultOf(session) && present(session.players[0]) && present(session.players[1]);
}

function trusted(peerId: string): boolean {
  return !!getPeerConnection(peerId)?.trusted;
}

function publishInvites(): void {
  incomingInvites.set(invites.list().map((invite) => ({ ...invite, name: peerDisplayName(invite.from) })));
}

function publishOutgoing(): void {
  if (!outgoing) {
    outgoingInvite.set(null);
    return;
  }
  const { players: _players, ...shown } = outgoing;
  outgoingInvite.set(shown);
}

function clearOutgoingTimer(): void {
  if (outgoingTimer) clearTimeout(outgoingTimer);
  outgoingTimer = null;
}

/** Forget the invitation you sent (taking it back first if it's still waiting). */
function dropOutgoing(): void {
  if (outgoing?.status === 'waiting') sendData(outgoing.to, { type: 'game', op: 'invite-cancel', id: outgoing.id });
  clearOutgoingTimer();
  outgoing = null;
  publishOutgoing();
}

/** Show what became of your invitation for a few seconds. */
function answered(status: OutgoingInvite['status']): void {
  if (!outgoing) return;
  outgoing.status = status;
  clearOutgoingTimer();
  outgoingTimer = setTimeout(() => {
    outgoingTimer = null;
    if (outgoing && outgoing.status !== 'waiting') {
      outgoing = null;
      publishOutgoing();
    }
  }, ANSWER_SHOWN_MS);
  publishOutgoing();
}

/** One game at a time: once one starts, every other invitation is off. */
function dropAllInvites(): void {
  dropOutgoing();
  for (const invite of invites.list()) sendData(invite.from, { type: 'game', op: 'invite-reply', id: invite.id, accept: false, busy: true });
  invites.clear();
  publishInvites();
}

function finite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

// ── Incoming ─────────────────────────────────────────────────────────────────

registerDataHandler('game', (fromPeerId, msg) => {
  // The identity is the connection's (fromPeerId), never anything in the message.
  if (!trusted(fromPeerId)) return;
  switch (msg.op) {
    case 'state': {
      const now = Date.now();
      if (now - (lastState.get(fromPeerId) ?? 0) < STATE_INTERVAL_MS) break;
      lastState.set(fromPeerId, now);
      const incoming = fromSnapshot(msg.game);
      // Only its players speak for a game, and both must be people who are actually here.
      if (!incoming || seatOf(incoming, fromPeerId) < 0) break;
      if (!present(incoming.players[0]) || !present(incoming.players[1])) break;
      const isNew = current?.id !== incoming.id;
      if (isNew && resultOf(incoming)) break; // someone else's finished game: nothing to show
      if (!shouldAdopt(current, incoming, inPlay(current))) break;
      current = incoming;
      gameAim.set(null);
      publish();
      if (isNew) dropAllInvites();
      if (isNew && !get(gamesOpen)) {
        const withYou = seatOf(incoming, getLocalPeerId()) >= 0;
        gameNotice.set({ name: peerDisplayName(fromPeerId), kind: incoming.kind, withYou });
      }
      break;
    }
    case 'move': {
      if (!current || msg.id !== current.id) break;
      const outcome = tryMove(current, fromPeerId, msg.n, msg.move);
      if (outcome === 'applied') {
        gameAim.set(null);
        publish();
      } else if (outcome === 'gap') {
        // We missed something: ask that player for the whole game.
        const now = Date.now();
        if (now - lastAskedSync < SYNC_REQ_INTERVAL_MS) break;
        lastAskedSync = now;
        sendData(fromPeerId, { type: 'game', op: 'sync-req' });
      }
      break;
    }
    case 'stop': {
      if (!current || msg.id !== current.id) break;
      if (msg.reason !== 'resign' && msg.reason !== 'abandon') break;
      // Calling a game off without a result only counts once the other player has gone.
      if (msg.reason === 'abandon' && inPlay(current)) break;
      if (stop(current, fromPeerId, msg.reason)) {
        gameAim.set(null);
        publish();
      }
      break;
    }
    case 'sync-req': {
      const now = Date.now();
      if (now - (lastSyncReq.get(fromPeerId) ?? 0) < SYNC_REQ_INTERVAL_MS) break;
      lastSyncReq.set(fromPeerId, now);
      sendState(fromPeerId);
      break;
    }
    case 'invite': {
      const invite = invites.receive(fromPeerId, msg, Date.now());
      if (!invite) break;
      if (inPlay(current)) {
        invites.take(invite.id);
        sendData(fromPeerId, { type: 'game', op: 'invite-reply', id: invite.id, accept: false, busy: true });
        break;
      }
      const timer = setTimeout(() => {
        inviteTimers.delete(timer);
        if (invites.expire(Date.now())) publishInvites();
      }, INVITE_TTL_MS + 50);
      inviteTimers.add(timer);
      publishInvites();
      break;
    }
    case 'invite-cancel': {
      if (invites.cancel(fromPeerId, msg.id)) publishInvites();
      break;
    }
    case 'invite-reply': {
      // Only the person you invited answers your invitation, and only while it's waiting.
      if (!outgoing || outgoing.status !== 'waiting' || msg.id !== outgoing.id || fromPeerId !== outgoing.to) break;
      if (msg.accept !== true) {
        answered(msg.busy === true ? 'busy' : 'declined');
        break;
      }
      const { kind, to, players, id } = outgoing;
      clearOutgoingTimer();
      outgoing = null;
      publishOutgoing();
      if (inPlay(current) || !trusted(to)) {
        sendData(to, { type: 'game', op: 'invite-cancel', id });
        break;
      }
      const me = getLocalPeerId();
      begin(kind, players ?? (Math.random() < 0.5 ? [me, to] : [to, me]));
      openGames();
      break;
    }
    case 'aim': {
      if (!current || msg.id !== current.id || resultOf(current)) break;
      if (seatOf(current, fromPeerId) !== turnOf(current)) break;
      if (msg.off === true) {
        gameAim.set(null);
        break;
      }
      if (!finite(msg.dx) || !finite(msg.dy) || !finite(msg.power)) break;
      const aim: Aim = { dx: msg.dx, dy: msg.dy, power: Math.min(1, Math.max(0, msg.power)) };
      const cue = msg.cue as { x?: unknown; y?: unknown } | undefined;
      if (cue && finite(cue.x) && finite(cue.y)) aim.cue = { x: cue.x, y: cue.y };
      gameAim.set(aim);
      break;
    }
  }
});

/** Players bring others up to date (a newcomer, or a connection that was rebuilt). */
function sendState(peerId: string): void {
  if (!current || seatOf(current, getLocalPeerId()) < 0) return;
  sendData(peerId, { type: 'game', op: 'state', game: toSnapshot(current) });
}

onPeerConnected((peerId) => {
  sendState(peerId);
  // Their arrival can bring a player back (or be one): refresh "waiting for …" on screen.
  if (current) publish();
});

onPeerLeft((peerId) => {
  lastState.delete(peerId);
  lastSyncReq.delete(peerId);
  if (invites.removePeer(peerId)) publishInvites();
  if (outgoing?.to === peerId) {
    clearOutgoingTimer();
    outgoing = null;
    publishOutgoing();
  }
  if (current && seatOf(current, peerId) >= 0) {
    gameAim.set(null);
    publish();
  }
});

onRoomLeft(() => {
  current = null;
  lastState.clear();
  lastSyncReq.clear();
  lastAskedSync = 0;
  gamesOpen.set(false);
  gameNotice.set(null);
  gameAim.set(null);
  publish();
  invites.clear();
  for (const timer of inviteTimers) clearTimeout(timer);
  inviteTimers.clear();
  clearOutgoingTimer();
  outgoing = null;
  publishInvites();
  publishOutgoing();
});

// ── Local actions ────────────────────────────────────────────────────────────

export function openGames(): void {
  // The games view and the whiteboard share the stage.
  closeWhiteboard();
  gamesOpen.set(true);
  gameNotice.set(null);
}

export function closeGames(): void {
  gamesOpen.set(false);
}

/** Whether a game is going on right now with both players here. */
export function gameInPlay(session: Session | null): boolean {
  return inPlay(session);
}

/** Whether that player is in the call right now. */
export function playerPresent(peerId: string): boolean {
  return present(peerId);
}

function begin(kind: GameKind, players: [string, string]): void {
  current = newSession(nanoid(12), kind, players);
  gameAim.set(null);
  gameNotice.set(null);
  publish();
  broadcastData({ type: 'game', op: 'state', game: toSnapshot(current) });
  dropAllInvites();
}

function sendInvite(kind: GameKind, to: string, players: [string, string] | null): boolean {
  const me = getLocalPeerId();
  if (!isGameKind(kind) || !me || to === me || !get(peers).has(to) || !trusted(to)) return false;
  if (inPlay(current)) return false;
  dropOutgoing();
  const id = nanoid(12);
  outgoing = { id, kind, to, name: peerDisplayName(to), status: 'waiting', rematch: players !== null, players };
  sendData(to, { type: 'game', op: 'invite', id, kind });
  outgoingTimer = setTimeout(() => {
    outgoingTimer = null;
    if (outgoing?.id !== id || outgoing.status !== 'waiting') return;
    sendData(to, { type: 'game', op: 'invite-cancel', id });
    answered('expired');
  }, INVITE_TTL_MS);
  publishOutgoing();
  return true;
}

/** Ask someone in the call to play. The game starts if they accept; who moves first is a coin toss. */
export function inviteToGame(kind: GameKind, opponentId: string): boolean {
  return sendInvite(kind, opponentId, null);
}

/** Ask for the same game with the same person, the other one moving first this time. */
export function rematch(): boolean {
  const me = getLocalPeerId();
  if (!current || seatOf(current, me) < 0 || !resultOf(current)) return false;
  const [first, second] = current.players;
  if (!present(first) || !present(second)) return false;
  return sendInvite(current.kind, first === me ? second : first, [second, first]);
}

/** Take back the invitation you sent, or put away its answer. */
export function cancelInvite(): void {
  dropOutgoing();
}

/** Say yes: the person who invited you starts the game. */
export function acceptInvite(id: string): boolean {
  const invite = invites.take(id);
  publishInvites();
  if (!invite || !trusted(invite.from)) return false;
  if (outgoing?.status === 'waiting') dropOutgoing();
  sendData(invite.from, { type: 'game', op: 'invite-reply', id, accept: true });
  openGames();
  return true;
}

/** Say no. */
export function declineInvite(id: string): void {
  const invite = invites.take(id);
  publishInvites();
  if (invite) sendData(invite.from, { type: 'game', op: 'invite-reply', id, accept: false });
}

/** Make a move in the current game. False when it isn't yours to make or isn't legal. */
export function playMove(move: unknown): boolean {
  if (!current) return false;
  const n = current.moves.length;
  if (tryMove(current, getLocalPeerId(), n, move) !== 'applied') return false;
  publish();
  broadcastData({ type: 'game', op: 'move', id: current.id, n, move });
  return true;
}

/** Give up (the other player wins), or, once they've left the call, call the game off. */
export function stopGame(): void {
  if (!current) return;
  const reason = inPlay(current) ? 'resign' : 'abandon';
  if (!stop(current, getLocalPeerId(), reason)) return;
  publish();
  broadcastData({ type: 'game', op: 'stop', id: current.id, reason });
}

/** Put a finished game away (for you only). */
export function dismissGame(): void {
  if (!current || inPlay(current)) return;
  current = null;
  publish();
}

let aimTimer: ReturnType<typeof setTimeout> | null = null;
let pendingAim: Aim | null | undefined;
let lastAimAt = 0;

function flushAim(): void {
  aimTimer = null;
  if (pendingAim === undefined || !current) return;
  const aim = pendingAim;
  pendingAim = undefined;
  lastAimAt = Date.now();
  broadcastData(aim ? { type: 'game', op: 'aim', id: current.id, ...aim } : { type: 'game', op: 'aim', id: current.id, off: true });
}

/** Show the others where you're aiming (null: stopped aiming). At most one update per 70ms, always the latest. */
export function shareAim(aim: Aim | null): void {
  pendingAim = aim;
  if (aimTimer) return;
  aimTimer = setTimeout(flushAim, Math.max(0, AIM_INTERVAL_MS - (Date.now() - lastAimAt)));
}
