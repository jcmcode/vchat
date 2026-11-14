// Chess: the full rules (castling, en passant, promotion, check, mate, stalemate, and the
// automatic draws: threefold repetition, fifty moves, bare material). Seat 0 is White.
//
// Squares are numbered 0..63 from a1: square = rank * 8 + file, so a1 = 0, h1 = 7, a8 = 56.
// Pieces are letters: uppercase White, lowercase Black, '' for an empty square.

import { isInt, isRecord, type GameOver, type GameRules, type Seat } from './rules.js';

export type Promotion = 'q' | 'r' | 'b' | 'n';

export interface ChessMove {
  from: number;
  to: number;
  promo?: Promotion;
}

/** Everything that decides which moves are legal. */
export interface Position {
  board: string[];
  turn: Seat;
  /** Castling rights still available: some of "KQkq". */
  castle: string;
  /** The square a pawn may capture onto en passant, or -1. */
  ep: number;
}

export interface ChessState extends Position {
  /** Half-moves since the last capture or pawn move (fifty-move rule). */
  half: number;
  /** How often each position has occurred since the last irreversible move (threefold repetition). */
  seen: Record<string, number>;
  last: { from: number; to: number } | null;
  /** The side to move is in check. */
  check: boolean;
  /** Pieces taken so far, in order. */
  captured: string[];
  over: GameOver | null;
}

const KNIGHT: Array<[number, number]> = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const DIAGONAL: Array<[number, number]> = [[1, 1], [1, -1], [-1, -1], [-1, 1]];
const STRAIGHT: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const ALL: Array<[number, number]> = [...DIAGONAL, ...STRAIGHT];
const PROMOTIONS: Promotion[] = ['q', 'r', 'b', 'n'];

export function sideOf(piece: string): Seat {
  return piece === piece.toUpperCase() ? 0 : 1;
}

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';

/** A position from the first four fields of a FEN string. */
export function positionFromFen(fen: string): Position {
  const [placement, turn = 'w', castle = '-', ep = '-'] = fen.trim().split(/\s+/);
  const board: string[] = new Array(64).fill('');
  placement.split('/').forEach((row, i) => {
    let file = 0;
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') file += Number(ch);
      else board[(7 - i) * 8 + file++] = ch;
    }
  });
  return {
    board,
    turn: turn === 'b' ? 1 : 0,
    castle: castle === '-' ? '' : castle,
    ep: ep === '-' ? -1 : (Number(ep[1]) - 1) * 8 + (ep.charCodeAt(0) - 97),
  };
}

/** Whether `by` attacks `sq`. */
export function attacked(board: string[], sq: number, by: Seat): boolean {
  const f = sq & 7;
  const r = sq >> 3;
  const own = (letter: string) => (by === 0 ? letter.toUpperCase() : letter);
  // A pawn attacks diagonally forward, so it sits one rank behind the square (from its own side).
  const pr = by === 0 ? r - 1 : r + 1;
  if (pr >= 0 && pr < 8) {
    if (f > 0 && board[pr * 8 + f - 1] === own('p')) return true;
    if (f < 7 && board[pr * 8 + f + 1] === own('p')) return true;
  }
  for (const [df, dr] of KNIGHT) {
    const nf = f + df;
    const nr = r + dr;
    if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8 && board[nr * 8 + nf] === own('n')) return true;
  }
  for (const [df, dr] of ALL) {
    const nf = f + df;
    const nr = r + dr;
    if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8 && board[nr * 8 + nf] === own('k')) return true;
  }
  for (const [dirs, slider] of [[DIAGONAL, 'b'], [STRAIGHT, 'r']] as const) {
    for (const [df, dr] of dirs) {
      let nf = f + df;
      let nr = r + dr;
      while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
        const piece = board[nr * 8 + nf];
        if (piece) {
          if (piece === own(slider) || piece === own('q')) return true;
          break;
        }
        nf += df;
        nr += dr;
      }
    }
  }
  return false;
}

function kingSquare(board: string[], side: Seat): number {
  return board.indexOf(side === 0 ? 'K' : 'k');
}

/** Moves for the piece on `from` that follow how it moves, before checking that the king stays safe. */
function pieceMoves(pos: Position, from: number, out: ChessMove[]): void {
  const { board } = pos;
  const piece = board[from];
  const side = sideOf(piece);
  const f = from & 7;
  const r = from >> 3;
  const canLand = (to: number) => !board[to] || sideOf(board[to]) !== side;
  const walk = (dirs: Array<[number, number]>, far: boolean) => {
    for (const [df, dr] of dirs) {
      let nf = f + df;
      let nr = r + dr;
      while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
        const to = nr * 8 + nf;
        if (canLand(to)) out.push({ from, to });
        if (board[to] || !far) break;
        nf += df;
        nr += dr;
      }
    }
  };
  switch (piece.toLowerCase()) {
    case 'p': {
      const dir = side === 0 ? 1 : -1;
      const push = (to: number) => {
        if (to >> 3 === (side === 0 ? 7 : 0)) for (const promo of PROMOTIONS) out.push({ from, to, promo });
        else out.push({ from, to });
      };
      const one = from + dir * 8;
      if (!board[one]) {
        push(one);
        const two = one + dir * 8;
        if (r === (side === 0 ? 1 : 6) && !board[two]) out.push({ from, to: two });
      }
      for (const df of [-1, 1]) {
        const nf = f + df;
        if (nf < 0 || nf > 7) continue;
        const to = (r + dir) * 8 + nf;
        if ((board[to] && sideOf(board[to]) !== side) || to === pos.ep) push(to);
      }
      break;
    }
    case 'n':
      walk(KNIGHT, false);
      break;
    case 'b':
      walk(DIAGONAL, true);
      break;
    case 'r':
      walk(STRAIGHT, true);
      break;
    case 'q':
      walk(ALL, true);
      break;
    case 'k': {
      walk(ALL, false);
      // Castling: the right is still there (so king and rook are on their squares), nothing stands
      // between them, and the king doesn't start on, cross or land on an attacked square.
      const home = side === 0 ? 4 : 60;
      if (from !== home) break;
      const enemy = (1 - side) as Seat;
      const safe = (...squares: number[]) => squares.every((sq) => !attacked(board, sq, enemy));
      if (pos.castle.includes(side === 0 ? 'K' : 'k') && !board[home + 1] && !board[home + 2] && safe(home, home + 1, home + 2)) {
        out.push({ from, to: home + 2 });
      }
      if (pos.castle.includes(side === 0 ? 'Q' : 'q') && !board[home - 1] && !board[home - 2] && !board[home - 3] && safe(home, home - 1, home - 2)) {
        out.push({ from, to: home - 2 });
      }
      break;
    }
  }
}

/** The position after `move` (which must follow how the piece moves), and what it captured. */
export function play(pos: Position, move: ChessMove): Position & { taken: string } {
  const board = pos.board.slice();
  const piece = board[move.from];
  const side = sideOf(piece);
  const kind = piece.toLowerCase();
  let taken = board[move.to];
  board[move.from] = '';
  if (kind === 'p' && move.to === pos.ep) {
    const victim = move.to + (side === 0 ? -8 : 8);
    taken = board[victim];
    board[victim] = '';
  }
  board[move.to] = kind === 'p' && move.promo ? (side === 0 ? move.promo.toUpperCase() : move.promo) : piece;
  if (kind === 'k' && Math.abs(move.to - move.from) === 2) {
    const kingside = move.to > move.from;
    const rookFrom = kingside ? move.from + 3 : move.from - 4;
    const rookTo = kingside ? move.from + 1 : move.from - 1;
    board[rookTo] = board[rookFrom];
    board[rookFrom] = '';
  }
  let castle = pos.castle;
  if (kind === 'k') castle = castle.replace(side === 0 ? /[KQ]/g : /[kq]/g, '');
  // A rook that moves, or is taken on its home square, ends castling on that side.
  for (const sq of [move.from, move.to]) {
    if (sq === 0) castle = castle.replace('Q', '');
    else if (sq === 7) castle = castle.replace('K', '');
    else if (sq === 56) castle = castle.replace('q', '');
    else if (sq === 63) castle = castle.replace('k', '');
  }
  const ep = kind === 'p' && Math.abs(move.to - move.from) === 16 ? (move.from + move.to) / 2 : -1;
  return { board, turn: (1 - side) as Seat, castle, ep, taken };
}

/** Every legal move for the side to move (or only those of the piece on `from`). */
export function legalMoves(pos: Position, from?: number): ChessMove[] {
  const candidates: ChessMove[] = [];
  const side = pos.turn;
  for (let sq = 0; sq < 64; sq++) {
    if (from !== undefined && sq !== from) continue;
    const piece = pos.board[sq];
    if (piece && sideOf(piece) === side) pieceMoves(pos, sq, candidates);
  }
  const enemy = (1 - side) as Seat;
  return candidates.filter((move) => {
    const next = play(pos, move);
    return !attacked(next.board, kingSquare(next.board, side), enemy);
  });
}

function positionKey(pos: Position): string {
  return `${pos.board.map((p) => p || '.').join('')}${pos.turn}${pos.castle}:${pos.ep}`;
}

/** Neither side can possibly mate: bare kings, or a single bishop or knight. */
function bareMaterial(board: string[]): boolean {
  let minors = 0;
  for (const piece of board) {
    if (!piece) continue;
    const kind = piece.toLowerCase();
    if (kind === 'k') continue;
    if (kind === 'b' || kind === 'n') minors++;
    else return false;
  }
  return minors <= 1;
}

function parseMove(move: unknown): ChessMove | null {
  if (!isRecord(move) || !isInt(move.from, 0, 63) || !isInt(move.to, 0, 63)) return null;
  if (move.promo === undefined) return { from: move.from, to: move.to };
  if (typeof move.promo !== 'string' || !PROMOTIONS.includes(move.promo as Promotion)) return null;
  return { from: move.from, to: move.to, promo: move.promo as Promotion };
}

export function stateFromPosition(pos: Position): ChessState {
  const check = attacked(pos.board, kingSquare(pos.board, pos.turn), (1 - pos.turn) as Seat);
  return { ...pos, half: 0, seen: { [positionKey(pos)]: 1 }, last: null, check, captured: [], over: null };
}

export const chess: GameRules<ChessState> = {
  // Far beyond any real game; the fifty-move rule ends things long before.
  maxMoves: 1200,
  init: () => stateFromPosition(positionFromFen(START)),
  turn: (state) => state.turn,
  over: (state) => state.over,
  apply(state, raw, by) {
    if (state.over || by !== state.turn) return null;
    const wanted = parseMove(raw);
    if (!wanted) return null;
    const move = legalMoves(state, wanted.from).find((m) => m.to === wanted.to && m.promo === wanted.promo);
    if (!move) return null;

    const mover = state.board[move.from];
    const next = play(state, move);
    const irreversible = mover.toLowerCase() === 'p' || !!next.taken;
    const half = irreversible ? 0 : state.half + 1;
    const key = positionKey(next);
    const seen = irreversible ? { [key]: 1 } : { ...state.seen, [key]: (state.seen[key] ?? 0) + 1 };
    const check = attacked(next.board, kingSquare(next.board, next.turn), by);
    const stuck = legalMoves(next).length === 0;

    let over: GameOver | null = null;
    if (stuck) over = check ? { winner: by, reason: 'checkmate' } : { winner: null, reason: 'stalemate' };
    else if (bareMaterial(next.board)) over = { winner: null, reason: 'material' };
    else if (seen[key] >= 3) over = { winner: null, reason: 'repetition' };
    else if (half >= 100) over = { winner: null, reason: 'fifty' };

    return {
      board: next.board,
      turn: next.turn,
      castle: next.castle,
      ep: next.ep,
      half,
      seen,
      last: { from: move.from, to: move.to },
      check,
      captured: next.taken ? [...state.captured, next.taken] : state.captured,
      over,
    };
  },
};

/** "e4" for square 28. */
export function squareName(sq: number): string {
  return `${'abcdefgh'[sq & 7]}${(sq >> 3) + 1}`;
}
