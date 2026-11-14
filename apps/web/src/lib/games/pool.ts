// Pool (8-ball) on a 1000 x 500 table.
//
// A move is one shot. Nobody sends where the balls ended up: everyone simulates the shot
// themselves and must arrive at exactly the same table, so the simulation is deterministic. It
// runs in fixed steps and uses only + - * / and Math.sqrt (which give identical results in every
// browser); no sin/cos/atan2, no clocks, no randomness.
//
// Physics: balls slide when struck and then roll (each ball tracks its spin, so a rolling cue ball
// follows through after contact and a sliding one stops dead), rolling balls slow down faster at
// speed, cushions rebound less the harder they're hit, and pockets are openings in the cushions
// with jaws a ball can rattle off.
//
// The rules, kept simple:
//  - Ball 0 is the cue ball, 1-7 solids, 8 the eight, 9-15 stripes.
//  - The break is taken from behind the head string. The table is "open" until someone pockets a
//    ball after the break; that ball's group becomes theirs.
//  - Pocket one of your own and you shoot again. Otherwise the turn passes.
//  - Fouls (pocketing the cue ball, hitting nothing, or hitting the wrong ball first) give the
//    other player the cue ball in hand, anywhere on the table.
//  - Pocket the 8 after clearing your group to win; pocket it early, or with a foul, and you lose.
//    An 8 pocketed on the break goes back on its spot.

import { isRecord, type GameOver, type GameRules, type Seat } from './rules.js';

export const TABLE_W = 1000;
export const TABLE_H = 500;
export const BALL_R = 11;
export const HEAD_STRING = 250;
const FOOT_SPOT = 750;
const MID_Y = 250;

/** Simulation steps per second of table time (what the table animation advances by). */
export const STEPS_PER_SECOND = 240;
const DT = 1 / STEPS_PER_SECOND;
/** Each step is split into this many substeps, so even the fastest ball moves a small fraction of its radius at a time. */
const SUBSTEPS = 4;
const H = DT / SUBSTEPS;
/** Cue ball speed at full power (table units per second; the table is 1000 units long). */
const MAX_SPEED = 3200;
/**
 * Cloth friction while a ball slides (its spin doesn't match its speed): it slows the ball and
 * brings its spin round until it rolls. A solid ball reaches rolling at 5/7 of its sliding speed.
 */
const SLIDE_DECEL = 1200;
/** Rolling resistance: a constant part, plus a part that grows with speed (fast balls die off quicker). */
const ROLL_DECEL = 55;
const ROLL_DRAG = 0.32;
/** Cushion rebound: livelier for gentle hits, deader for hard ones. */
const CUSHION_E_SOFT = 0.86;
const CUSHION_E_LOSS = 0.00005;
const CUSHION_E_MIN = 0.62;
/** Speed kept along the cushion during a rebound. */
const CUSHION_GRIP = 0.96;
const BALL_BOUNCE = 0.95;
/** Below this a rolling ball has stopped. */
const REST_SPEED = 1;
const MAX_STEPS = STEPS_PER_SECOND * 30;
export const MIN_POWER = 0.02;

// Pocket openings: the cushions stop short of each pocket, with a jaw point at each end of the gap.
/** How far the corner pocket opening runs along each rail from the corner. */
const CORNER_GAP = 30;
/** Half the side pocket opening. */
const SIDE_GAP = 25;
/** Jaw points sit just behind the cushion line, so a ball frozen to the rail rolls past them. */
const JAW_SET_BACK = 3;
const JAW_R = 2;

export interface Pocket {
  x: number;
  y: number;
  /** A ball whose centre comes within this distance drops. */
  r: number;
}

export const POCKETS: Pocket[] = [
  { x: 0, y: 0, r: 25 },
  { x: TABLE_W / 2, y: -3, r: 22 },
  { x: TABLE_W, y: 0, r: 25 },
  { x: 0, y: TABLE_H, r: 25 },
  { x: TABLE_W / 2, y: TABLE_H + 3, r: 22 },
  { x: TABLE_W, y: TABLE_H, r: 25 },
];

export type Group = 'solid' | 'stripe';

export interface Ball {
  x: number;
  y: number;
  /** Pocketed. */
  in: boolean;
}

export interface PoolState {
  balls: Ball[];
  turn: Seat;
  /** Each seat's group once the table is no longer open. */
  groups: [Group | null, Group | null];
  /** The shooter may place the cue ball before shooting. */
  ballInHand: boolean;
  breakShot: boolean;
  /** Why the last shot was a foul, if it was. */
  foul: 'scratch' | 'no-hit' | 'wrong-ball' | null;
  /** Balls pocketed by the last shot. */
  potted: number[];
  over: GameOver | null;
}

export interface PoolShot {
  /** Direction (any length). */
  dx: number;
  dy: number;
  /** MIN_POWER..1. */
  power: number;
  /** Where the cue ball is placed first (only with ball in hand). */
  cue?: { x: number; y: number };
}

export function groupOf(ball: number): Group | null {
  if (ball >= 1 && ball <= 7) return 'solid';
  if (ball >= 9 && ball <= 15) return 'stripe';
  return null;
}

/** Balls of `group` still on the table. */
export function remaining(state: PoolState, group: Group): number[] {
  const out: number[] = [];
  state.balls.forEach((ball, i) => {
    if (!ball.in && groupOf(i) === group) out.push(i);
  });
  return out;
}

// Rack, apex on the foot spot, the 8 in the middle, a solid and a stripe on the back corners.
const RACK = [[1], [9, 2], [3, 8, 10], [11, 4, 5, 12], [6, 13, 14, 7, 15]];
const RACK_SPACING = BALL_R * 2 + 0.6;
const ROW_STEP = RACK_SPACING * 0.8660254;

function rack(): Ball[] {
  const balls: Ball[] = [];
  balls[0] = { x: HEAD_STRING, y: MID_Y, in: false };
  RACK.forEach((row, k) => {
    row.forEach((n, j) => {
      balls[n] = { x: FOOT_SPOT + k * ROW_STEP, y: MID_Y + (j - k / 2) * RACK_SPACING, in: false };
    });
  });
  return balls;
}

function finite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function inPocket(x: number, y: number): boolean {
  for (const p of POCKETS) {
    const dx = x - p.x;
    const dy = y - p.y;
    if (dx * dx + dy * dy < p.r * p.r) return true;
  }
  return false;
}

function overlaps(balls: Ball[], x: number, y: number, skip: number): boolean {
  for (let i = 0; i < balls.length; i++) {
    if (i === skip || balls[i].in) continue;
    const dx = balls[i].x - x;
    const dy = balls[i].y - y;
    if (dx * dx + dy * dy < BALL_R * BALL_R * 4) return true;
  }
  return false;
}

/** Whether the shooter may put the cue ball at (x, y). */
export function canPlaceCue(state: PoolState, x: number, y: number): boolean {
  if (!finite(x) || !finite(y)) return false;
  if (x < BALL_R || x > TABLE_W - BALL_R || y < BALL_R || y > TABLE_H - BALL_R) return false;
  if (state.breakShot && x > HEAD_STRING) return false;
  return !inPocket(x, y) && !overlaps(state.balls, x, y, 0);
}

/** The free spot nearest (x, y) along the long axis of the table. */
function freeSpot(balls: Ball[], x: number, y: number, skip: number): { x: number; y: number } {
  for (let k = 0; k < 200; k++) {
    for (const sign of [1, -1]) {
      const nx = x + sign * k * BALL_R;
      if (nx < BALL_R * 3 || nx > TABLE_W - BALL_R * 3) continue;
      if (!overlaps(balls, nx, y, skip)) return { x: nx, y };
    }
  }
  return { x, y };
}

function parseShot(raw: unknown): PoolShot | null {
  if (!isRecord(raw) || !finite(raw.dx) || !finite(raw.dy) || !finite(raw.power)) return null;
  if (raw.power < MIN_POWER || raw.power > 1) return null;
  if (raw.dx * raw.dx + raw.dy * raw.dy < 1e-12) return null;
  const shot: PoolShot = { dx: raw.dx, dy: raw.dy, power: raw.power };
  if (raw.cue !== undefined) {
    if (!isRecord(raw.cue) || !finite(raw.cue.x) || !finite(raw.cue.y)) return null;
    shot.cue = { x: raw.cue.x, y: raw.cue.y };
  }
  return shot;
}

// ── Simulation ───────────────────────────────────────────────────────────────

interface MovingBall extends Ball {
  vx: number;
  vy: number;
  /**
   * The ball's spin, as the speed it would roll at if it were rolling without slipping. Equal to
   * (vx, vy) while it rolls; different while it slides (just struck, or just after a collision).
   */
  ux: number;
  uy: number;
}

export interface Sim {
  balls: MovingBall[];
  /** The first ball the cue ball touched, or -1. */
  firstHit: number;
  /** Balls pocketed, in order. */
  potted: number[];
  steps: number;
}

/** Set up the shot (placing the cue ball first, with ball in hand). Null when the shot isn't allowed. */
export function startShot(state: PoolState, raw: unknown): Sim | null {
  if (state.over) return null;
  const shot = parseShot(raw);
  if (!shot) return null;
  const balls: MovingBall[] = state.balls.map((b) => ({ x: b.x, y: b.y, in: b.in, vx: 0, vy: 0, ux: 0, uy: 0 }));
  const cue = balls[0];
  if (state.ballInHand && shot.cue) {
    if (!canPlaceCue(state, shot.cue.x, shot.cue.y)) return null;
    cue.x = shot.cue.x;
    cue.y = shot.cue.y;
  }
  if (cue.in) return null;
  const length = Math.sqrt(shot.dx * shot.dx + shot.dy * shot.dy);
  const speed = MAX_SPEED * shot.power;
  // A centre-ball hit: the cue ball sets off sliding, with no spin yet.
  cue.vx = (shot.dx / length) * speed;
  cue.vy = (shot.dy / length) * speed;
  return { balls, firstHit: -1, potted: [], steps: 0 };
}

/** Is the cushion solid at this point along a long rail (top/bottom), or is it a pocket opening? */
function longRailSolid(x: number): boolean {
  const fromSide = x - TABLE_W / 2;
  return x >= CORNER_GAP && x <= TABLE_W - CORNER_GAP && (fromSide >= SIDE_GAP || fromSide <= -SIDE_GAP);
}

/** Is the cushion solid at this point along a short rail (left/right)? */
function shortRailSolid(y: number): boolean {
  return y >= CORNER_GAP && y <= TABLE_H - CORNER_GAP;
}

const JAWS: { x: number; y: number }[] = [
  // Corners: one jaw on each rail.
  { x: CORNER_GAP, y: -JAW_SET_BACK },
  { x: -JAW_SET_BACK, y: CORNER_GAP },
  { x: TABLE_W - CORNER_GAP, y: -JAW_SET_BACK },
  { x: TABLE_W + JAW_SET_BACK, y: CORNER_GAP },
  { x: CORNER_GAP, y: TABLE_H + JAW_SET_BACK },
  { x: -JAW_SET_BACK, y: TABLE_H - CORNER_GAP },
  { x: TABLE_W - CORNER_GAP, y: TABLE_H + JAW_SET_BACK },
  { x: TABLE_W + JAW_SET_BACK, y: TABLE_H - CORNER_GAP },
  // Sides.
  { x: TABLE_W / 2 - SIDE_GAP, y: -JAW_SET_BACK },
  { x: TABLE_W / 2 + SIDE_GAP, y: -JAW_SET_BACK },
  { x: TABLE_W / 2 - SIDE_GAP, y: TABLE_H + JAW_SET_BACK },
  { x: TABLE_W / 2 + SIDE_GAP, y: TABLE_H + JAW_SET_BACK },
];

function cushionBounce(normalSpeed: number): number {
  const e = CUSHION_E_SOFT - CUSHION_E_LOSS * normalSpeed;
  return e < CUSHION_E_MIN ? CUSHION_E_MIN : e;
}

/**
 * Bounce off a cushion whose inward normal is (nx, ny), with `into` = the speed into it (> 0).
 * The cushion reverses the ball, takes a little off its speed along it, and kills its roll into the
 * cushion (it comes off sliding, and picks up roll again on the cloth).
 */
function rebound(b: MovingBall, nx: number, ny: number, into: number): void {
  const e = cushionBounce(into);
  const along = b.vx * -ny + b.vy * nx;
  const out = into * e;
  b.vx = nx * out + -ny * along * CUSHION_GRIP;
  b.vy = ny * out + nx * along * CUSHION_GRIP;
  const spinIn = b.ux * nx + b.uy * ny;
  b.ux -= spinIn * nx;
  b.uy -= spinIn * ny;
}

/** Cloth friction for one substep: slide towards rolling, or roll and slow down. */
function friction(b: MovingBall): void {
  const sx = b.vx - b.ux;
  const sy = b.vy - b.uy;
  const slip = Math.sqrt(sx * sx + sy * sy);
  if (slip > 1e-9) {
    const grip = SLIDE_DECEL * H;
    if (slip <= grip * 3.5) {
      // Reaches rolling within this substep: speed and spin meet at the rolling speed.
      b.vx = (5 * b.vx + 2 * b.ux) / 7;
      b.vy = (5 * b.vy + 2 * b.uy) / 7;
      b.ux = b.vx;
      b.uy = b.vy;
    } else {
      const k = grip / slip;
      b.vx -= sx * k;
      b.vy -= sy * k;
      b.ux += 2.5 * sx * k;
      b.uy += 2.5 * sy * k;
    }
    return;
  }
  const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
  const slower = speed - (ROLL_DECEL + ROLL_DRAG * speed) * H;
  if (slower <= REST_SPEED) {
    b.vx = 0;
    b.vy = 0;
    b.ux = 0;
    b.uy = 0;
  } else {
    const k = slower / speed;
    b.vx *= k;
    b.vy *= k;
    b.ux = b.vx;
    b.uy = b.vy;
  }
}

/** Cushions and pocket jaws. */
function cushions(b: MovingBall): void {
  if (b.x < BALL_R && b.vx < 0 && shortRailSolid(b.y)) {
    b.x = BALL_R * 2 - b.x;
    rebound(b, 1, 0, -b.vx);
  } else if (b.x > TABLE_W - BALL_R && b.vx > 0 && shortRailSolid(b.y)) {
    b.x = (TABLE_W - BALL_R) * 2 - b.x;
    rebound(b, -1, 0, b.vx);
  }
  if (b.y < BALL_R && b.vy < 0 && longRailSolid(b.x)) {
    b.y = BALL_R * 2 - b.y;
    rebound(b, 0, 1, -b.vy);
  } else if (b.y > TABLE_H - BALL_R && b.vy > 0 && longRailSolid(b.x)) {
    b.y = (TABLE_H - BALL_R) * 2 - b.y;
    rebound(b, 0, -1, b.vy);
  }
  const reach = BALL_R + JAW_R;
  for (const j of JAWS) {
    const dx = b.x - j.x;
    const dy = b.y - j.y;
    const d2 = dx * dx + dy * dy;
    if (d2 >= reach * reach || d2 === 0) continue;
    const d = Math.sqrt(d2);
    const nx = dx / d;
    const ny = dy / d;
    b.x = j.x + nx * reach;
    b.y = j.y + ny * reach;
    const into = -(b.vx * nx + b.vy * ny);
    if (into > 0) rebound(b, nx, ny, into);
  }
}

/** In a pocket: within a pocket's drop zone, or through an opening past the cushion line. */
function dropped(b: Ball): boolean {
  return b.x < 0 || b.x > TABLE_W || b.y < 0 || b.y > TABLE_H || inPocket(b.x, b.y);
}

function substep(sim: Sim): void {
  const { balls } = sim;
  const n = balls.length;
  for (let i = 0; i < n; i++) {
    const b = balls[i];
    if (b.in || (b.vx === 0 && b.vy === 0 && b.ux === 0 && b.uy === 0)) continue;
    b.x += b.vx * H;
    b.y += b.vy * H;
    friction(b);
    if (dropped(b)) {
      b.in = true;
      b.vx = b.vy = b.ux = b.uy = 0;
      sim.potted.push(i);
      continue;
    }
    cushions(b);
  }
  const touching = BALL_R * 2;
  for (let i = 0; i < n; i++) {
    const a = balls[i];
    if (a.in) continue;
    for (let j = i + 1; j < n; j++) {
      const b = balls[j];
      if (b.in) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= touching * touching) continue;
      const d = Math.sqrt(d2);
      const nx = d > 0 ? dx / d : 1;
      const ny = d > 0 ? dy / d : 0;
      const push = (touching - d) / 2;
      a.x -= nx * push;
      a.y -= ny * push;
      b.x += nx * push;
      b.y += ny * push;
      const closing = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
      if (closing <= 0) continue;
      // Equal masses: the speed along the line of centres is (almost all) handed over. Spin isn't,
      // so afterwards each ball slides until the cloth turns its spin into roll: a rolling cue ball
      // follows through, a sliding one stops (a stun shot), and an object ball sets off sliding.
      const impulse = ((1 + BALL_BOUNCE) / 2) * closing;
      a.vx -= impulse * nx;
      a.vy -= impulse * ny;
      b.vx += impulse * nx;
      b.vy += impulse * ny;
      if (i === 0 && sim.firstHit < 0) sim.firstHit = j;
    }
  }
}

/** Advance one step. Returns whether anything is still moving. */
export function stepSim(sim: Sim): boolean {
  for (let k = 0; k < SUBSTEPS; k++) substep(sim);
  sim.steps++;
  let moving = false;
  for (const b of sim.balls) {
    if (!b.in && (b.vx !== 0 || b.vy !== 0 || b.ux !== 0 || b.uy !== 0)) {
      moving = true;
      break;
    }
  }
  return moving && sim.steps < MAX_STEPS;
}

/** Apply the rules to a finished shot. */
export function finishShot(state: PoolState, sim: Sim, by: Seat): PoolState {
  const balls: Ball[] = sim.balls.map((b) => ({ x: b.x, y: b.y, in: b.in }));
  const other = (1 - by) as Seat;
  const potted = sim.potted.slice();
  const cueIn = potted.includes(0);
  const eightIn = potted.includes(8);
  const objects = potted.filter((i) => i !== 0 && i !== 8);
  const myGroup = state.groups[by];
  const onEight = myGroup !== null && remaining(state, myGroup).length === 0;

  let foul: PoolState['foul'] = null;
  if (cueIn) foul = 'scratch';
  else if (sim.firstHit < 0) foul = 'no-hit';
  else if (myGroup === null) {
    if (sim.firstHit === 8 && !state.breakShot) foul = 'wrong-ball';
  } else if (onEight ? sim.firstHit !== 8 : groupOf(sim.firstHit) !== myGroup) foul = 'wrong-ball';

  let over: GameOver | null = null;
  if (eightIn) {
    if (state.breakShot) {
      const spot = freeSpot(balls, FOOT_SPOT, MID_Y, 8);
      balls[8] = { ...spot, in: false };
    } else if (onEight && !foul) over = { winner: by, reason: 'eight' };
    else over = { winner: other, reason: onEight ? 'eight-foul' : 'eight-early' };
  }

  let groups = state.groups;
  if (myGroup === null && !state.breakShot && !foul && objects.length > 0) {
    const mine = groupOf(objects[0]) as Group;
    const theirs: Group = mine === 'solid' ? 'stripe' : 'solid';
    groups = by === 0 ? [mine, theirs] : [theirs, mine];
  }

  if (cueIn) {
    const spot = freeSpot(balls, HEAD_STRING, MID_Y, 0);
    balls[0] = { ...spot, in: false };
  }

  const group = groups[by];
  const scored = group === null ? objects.length > 0 : objects.some((i) => groupOf(i) === group);
  const again = !foul && scored;
  return {
    balls,
    turn: over || again ? by : other,
    groups,
    ballInHand: !!foul && !over,
    breakShot: false,
    foul,
    potted,
    over,
  };
}

export const pool: GameRules<PoolState> = {
  maxMoves: 400,
  init: () => ({ balls: rack(), turn: 0, groups: [null, null], ballInHand: true, breakShot: true, foul: null, potted: [], over: null }),
  turn: (state) => state.turn,
  over: (state) => state.over,
  apply(state, move, by) {
    if (by !== state.turn) return null;
    const sim = startShot(state, move);
    if (!sim) return null;
    while (stepSim(sim)) {
      /* run to rest */
    }
    return finishShot(state, sim, by);
  },
};

// ── Aiming help (display only; never part of the rules) ─────────────────────

export interface AimPreview {
  /** Where the cue ball's centre is when it first touches something. */
  x: number;
  y: number;
  /** The ball it would touch, or -1 for a cushion. */
  hit: number;
}

/** Where a shot from (cx, cy) along (dx, dy) first touches a ball or cushion. */
export function aimPreview(balls: Ball[], cx: number, cy: number, dx: number, dy: number): AimPreview | null {
  const length = Math.sqrt(dx * dx + dy * dy);
  if (!(length > 0)) return null;
  const ux = dx / length;
  const uy = dy / length;
  let best = Infinity;
  let hit = -1;
  for (let i = 1; i < balls.length; i++) {
    if (balls[i].in) continue;
    const ox = balls[i].x - cx;
    const oy = balls[i].y - cy;
    const along = ox * ux + oy * uy;
    if (along <= 0) continue;
    const off2 = ox * ox + oy * oy - along * along;
    const reach2 = BALL_R * BALL_R * 4;
    if (off2 >= reach2) continue;
    const t = along - Math.sqrt(reach2 - off2);
    if (t >= 0 && t < best) {
      best = t;
      hit = i;
    }
  }
  const walls = [
    ux > 0 ? (TABLE_W - BALL_R - cx) / ux : ux < 0 ? (BALL_R - cx) / ux : Infinity,
    uy > 0 ? (TABLE_H - BALL_R - cy) / uy : uy < 0 ? (BALL_R - cy) / uy : Infinity,
  ];
  for (const t of walls) {
    if (t >= 0 && t < best) {
      best = t;
      hit = -1;
    }
  }
  if (!Number.isFinite(best)) return null;
  return { x: cx + ux * best, y: cy + uy * best, hit };
}
