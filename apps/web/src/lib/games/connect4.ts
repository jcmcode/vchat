// Connect 4: 7 columns, 6 rows, four in a row wins. Seat 0 (red) drops first.

import { isInt, isRecord, type GameOver, type GameRules, type Seat } from './rules.js';

export const COLS = 7;
export const ROWS = 6;

export interface Connect4State {
  /** Row by row from the bottom: cells[row * COLS + col]. 0 empty, 1 seat 0, 2 seat 1. */
  cells: number[];
  turn: Seat;
  /** The cell of the last disc dropped. */
  last: number | null;
  /** The winning four (or more) cells. */
  line: number[] | null;
  over: GameOver | null;
}

export interface Connect4Move {
  col: number;
}

const DIRECTIONS: Array<[number, number]> = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
];

/** The row a disc dropped in `col` lands on, or -1 when the column is full. */
export function landingRow(cells: number[], col: number): number {
  for (let row = 0; row < ROWS; row++) if (cells[row * COLS + col] === 0) return row;
  return -1;
}

function winningLine(cells: number[], row: number, col: number): number[] | null {
  const who = cells[row * COLS + col];
  for (const [dc, dr] of DIRECTIONS) {
    const line = [row * COLS + col];
    for (const sign of [1, -1]) {
      let r = row + dr * sign;
      let c = col + dc * sign;
      while (r >= 0 && r < ROWS && c >= 0 && c < COLS && cells[r * COLS + c] === who) {
        line.push(r * COLS + c);
        r += dr * sign;
        c += dc * sign;
      }
    }
    if (line.length >= 4) return line;
  }
  return null;
}

export const connect4: GameRules<Connect4State> = {
  maxMoves: COLS * ROWS,
  init: () => ({ cells: new Array(COLS * ROWS).fill(0), turn: 0, last: null, line: null, over: null }),
  turn: (state) => state.turn,
  over: (state) => state.over,
  apply(state, move, by) {
    if (state.over || by !== state.turn) return null;
    if (!isRecord(move) || !isInt(move.col, 0, COLS - 1)) return null;
    const row = landingRow(state.cells, move.col);
    if (row < 0) return null;
    const cells = state.cells.slice();
    const cell = row * COLS + move.col;
    cells[cell] = by + 1;
    const line = winningLine(cells, row, move.col);
    const full = cells.every((c) => c !== 0);
    const over: GameOver | null = line ? { winner: by, reason: 'four' } : full ? { winner: null, reason: 'full' } : null;
    return { cells, turn: (1 - by) as Seat, last: cell, line, over };
  },
};
