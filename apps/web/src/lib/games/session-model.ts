// One game between two people in the call: who plays, and the list of moves so far.
//
// The position is never sent. Everyone keeps the move list and works the position out with the
// game's rules, so a move only counts if it's legal and comes from the player whose turn it is,
// and a whole game received from someone (a newcomer catching up) is replayed and checked the
// same way. Pure, so it's unit-tested without a network (session-model.test.ts).

import { chess } from './chess.js';
import { connect4 } from './connect4.js';
import { pool } from './pool.js';
import { isRecord, type GameOver, type GameRules, type Seat } from './rules.js';

/**
 * 'pool2' is pool with the newer physics. Every player simulates each shot themselves, so both must
 * run the same physics: a tab still on the old version (which calls it 'pool') can't start or join
 * one of these games, rather than quietly ending up with a different table.
 */
export type GameKind = 'connect4' | 'chess' | 'pool2';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const RULES: Record<GameKind, GameRules<any>> = { connect4, chess, pool2: pool };

export const GAME_NAMES: Record<GameKind, string> = { connect4: 'Connect 4', chess: 'Chess', pool2: 'Pool' };

const MAX_ID = 40;
const MAX_PEER_ID = 64;

/** A game stopped by a player rather than by the rules. */
export interface Stopped {
  reason: 'resign' | 'abandon';
  by: Seat;
}

export interface Session {
  id: string;
  kind: GameKind;
  /** Peer ids; players[0] moves first (White, red, the break). */
  players: [string, string];
  moves: unknown[];
  /** The position after `moves`, as the game's rules define it. */
  state: unknown;
  stopped: Stopped | null;
}

/** What travels between peers. */
export interface Snapshot {
  id: string;
  kind: GameKind;
  players: [string, string];
  moves: unknown[];
  stopped?: Stopped;
}

export function isGameKind(value: unknown): value is GameKind {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(RULES, value);
}

export function newSession(id: string, kind: GameKind, players: [string, string]): Session {
  return { id, kind, players, moves: [], state: RULES[kind].init(), stopped: null };
}

export function seatOf(session: Session, peerId: string): Seat | -1 {
  return session.players[0] === peerId ? 0 : session.players[1] === peerId ? 1 : -1;
}

export function turnOf(session: Session): Seat {
  return RULES[session.kind].turn(session.state);
}

/** How the game ended, if it has. */
export function resultOf(session: Session): GameOver | null {
  if (session.stopped) {
    return session.stopped.reason === 'resign'
      ? { winner: (1 - session.stopped.by) as Seat, reason: 'resign' }
      : { winner: null, reason: 'abandon' };
  }
  return RULES[session.kind].over(session.state);
}

export type MoveOutcome = 'applied' | 'gap' | 'rejected';

/**
 * Move number `n` from `peerId`. 'applied' when it was the next move, legal, and theirs to make;
 * 'gap' when we've missed moves before it (ask for the whole game); 'rejected' otherwise.
 */
export function tryMove(session: Session, peerId: string, n: unknown, move: unknown): MoveOutcome {
  const seat = seatOf(session, peerId);
  if (seat < 0 || typeof n !== 'number' || !Number.isInteger(n) || n < 0) return 'rejected';
  if (n > session.moves.length) return n <= RULES[session.kind].maxMoves ? 'gap' : 'rejected';
  if (n < session.moves.length || resultOf(session)) return 'rejected';
  const rules = RULES[session.kind];
  if (session.moves.length >= rules.maxMoves || rules.turn(session.state) !== seat) return 'rejected';
  const next = rules.apply(session.state, move, seat as Seat);
  if (next === null) return 'rejected';
  session.state = next;
  session.moves.push(move);
  return 'applied';
}

/** A player stops a game that's still going. */
export function stop(session: Session, peerId: string, reason: Stopped['reason']): boolean {
  const seat = seatOf(session, peerId);
  if (seat < 0 || resultOf(session)) return false;
  session.stopped = { reason, by: seat as Seat };
  return true;
}

export function toSnapshot(session: Session): Snapshot {
  return {
    id: session.id,
    kind: session.kind,
    players: session.players,
    moves: session.moves,
    ...(session.stopped ? { stopped: session.stopped } : {}),
  };
}

/** Rebuild a game from what a peer sent, replaying every move through the rules. Null if anything is off. */
export function fromSnapshot(raw: unknown): Session | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id || raw.id.length > MAX_ID || !isGameKind(raw.kind)) return null;
  const players = raw.players;
  if (!Array.isArray(players) || players.length !== 2) return null;
  if (!players.every((p) => typeof p === 'string' && p.length > 0 && p.length <= MAX_PEER_ID) || players[0] === players[1]) return null;
  const rules = RULES[raw.kind];
  if (!Array.isArray(raw.moves) || raw.moves.length > rules.maxMoves) return null;
  const session = newSession(raw.id, raw.kind, [players[0], players[1]]);
  for (const move of raw.moves) {
    if (rules.over(session.state)) return null;
    const next = rules.apply(session.state, move, rules.turn(session.state));
    if (next === null) return null;
    session.state = next;
    session.moves.push(move);
  }
  if (raw.stopped !== undefined) {
    const s = raw.stopped;
    if (!isRecord(s) || (s.reason !== 'resign' && s.reason !== 'abandon') || (s.by !== 0 && s.by !== 1)) return null;
    if (!rules.over(session.state)) session.stopped = { reason: s.reason, by: s.by };
  }
  return session;
}

/**
 * Whether `incoming` should replace `current`.
 *  - The same game: whichever is further along.
 *  - A different game: only when ours isn't in play any more (finished, or a player has gone), or,
 *    when two games were started at the same moment, for the one whose id sorts first, so
 *    everyone settles on the same one.
 */
export function shouldAdopt(current: Session | null, incoming: Session, currentInPlay: boolean): boolean {
  if (!current) return true;
  if (current.id === incoming.id) {
    if (incoming.moves.length !== current.moves.length) return incoming.moves.length > current.moves.length;
    return !!incoming.stopped && !resultOf(current);
  }
  if (!currentInPlay) return true;
  return current.moves.length === 0 && incoming.id < current.id;
}
