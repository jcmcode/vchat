// What every game provides: pure, deterministic rules. Both players (and anyone watching) run the
// same rules on the same list of moves, so everyone arrives at the same position without trusting
// what anyone else says the position is. Nothing here touches the network or the DOM.

export type Seat = 0 | 1;

export interface GameOver {
  /** The winning seat, or null for a draw. */
  winner: Seat | null;
  /** Short machine-readable reason ('checkmate', 'four', 'resign', …). */
  reason: string;
}

export interface GameRules<S> {
  /** The starting position. Seat 0 moves first. */
  init(): S;
  /** The position after `move` by `by`, or null when that isn't a legal move (never throws, never mutates). */
  apply(state: S, move: unknown, by: Seat): S | null;
  /** Whose turn it is. */
  turn(state: S): Seat;
  /** Set once the game is decided. */
  over(state: S): GameOver | null;
  /** Most moves a game may have (bounds what a peer can make us replay). */
  maxMoves: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isInt(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}
