import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect4, COLS, type Connect4State } from './connect4.js';
import { chess, legalMoves, play, positionFromFen, stateFromPosition, type ChessState, type Position } from './chess.js';
import { BALL_R, TABLE_H, TABLE_W, canPlaceCue, pool, remaining, startShot, stepSim, type PoolState } from './pool.js';
import { fromSnapshot, newSession, resultOf, shouldAdopt, stop, toSnapshot, tryMove } from './session-model.js';
import type { Seat } from './rules.js';
import { INVITE_TTL_MS, InviteBook } from './invite-model.js';

// ── Connect 4 ────────────────────────────────────────────────────────────────

function dropAll(cols: number[]): Connect4State {
  let state = connect4.init();
  for (const col of cols) {
    const next = connect4.apply(state, { col }, state.turn);
    assert.ok(next, `column ${col} should be playable`);
    state = next;
  }
  return state;
}

test('connect 4: four in a row wins, in every direction', () => {
  assert.deepEqual(dropAll([0, 0, 1, 1, 2, 2, 3]).over, { winner: 0, reason: 'four' }); // across
  assert.deepEqual(dropAll([0, 1, 0, 1, 0, 1, 0]).over, { winner: 0, reason: 'four' }); // up
  assert.deepEqual(dropAll([0, 1, 1, 2, 2, 3, 2, 3, 3, 6, 3]).over, { winner: 0, reason: 'four' }); // diagonal up
  assert.deepEqual(dropAll([3, 2, 2, 1, 1, 0, 1, 0, 0, 6, 0]).over, { winner: 0, reason: 'four' }); // diagonal down
  assert.equal(dropAll([0, 0, 1, 1, 2, 2, 3]).line?.length, 4);
});

test('connect 4: turns, full columns and bad moves', () => {
  let state = connect4.init();
  assert.equal(connect4.apply(state, { col: 0 }, 1), null, 'not your turn');
  for (const bad of [null, {}, { col: -1 }, { col: COLS }, { col: 1.5 }, { col: '3' }, 3]) {
    assert.equal(connect4.apply(state, bad, 0), null, JSON.stringify(bad));
  }
  state = dropAll([0, 0, 0, 0, 0, 0]);
  assert.equal(connect4.apply(state, { col: 0 }, state.turn), null, 'column is full');
  const won = dropAll([0, 0, 1, 1, 2, 2, 3]);
  assert.equal(connect4.apply(won, { col: 5 }, won.turn), null, 'game is over');
});

test('connect 4: a full board with no four is a draw', () => {
  // Columns filled in an order that never lines up four.
  const order = [0, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 2, 3, 2, 3, 2, 3, 3, 2, 3, 2, 3, 2, 4, 5, 4, 5, 4, 5, 5, 4, 5, 4, 5, 4, 6, 6, 6, 6, 6, 6];
  assert.deepEqual(dropAll(order).over, { winner: null, reason: 'full' });
});

// ── Chess ────────────────────────────────────────────────────────────────────

function perft(pos: Position, depth: number): number {
  const moves = legalMoves(pos);
  if (depth === 1) return moves.length;
  let nodes = 0;
  for (const move of moves) nodes += perft(play(pos, move), depth - 1);
  return nodes;
}

test('chess: move counts match the known values from the starting position', () => {
  const start = chess.init();
  assert.equal(perft(start, 1), 20);
  assert.equal(perft(start, 2), 400);
  assert.equal(perft(start, 3), 8902);
  assert.equal(perft(start, 4), 197281);
});

test('chess: move counts match on positions full of castling, en passant, pins and promotions', () => {
  const kiwipete = positionFromFen('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq -');
  assert.equal(perft(kiwipete, 1), 48);
  assert.equal(perft(kiwipete, 2), 2039);
  assert.equal(perft(kiwipete, 3), 97862);
  const endgame = positionFromFen('8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - -');
  assert.equal(perft(endgame, 4), 43238);
  const promotions = positionFromFen('rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ -');
  assert.equal(perft(promotions, 3), 62379);
});

const sq = (name: string) => (Number(name[1]) - 1) * 8 + (name.charCodeAt(0) - 97);

function playChess(moves: string[], from: ChessState = chess.init()): ChessState {
  let state = from;
  for (const text of moves) {
    const move = { from: sq(text.slice(0, 2)), to: sq(text.slice(2, 4)), ...(text[4] ? { promo: text[4] } : {}) };
    const next = chess.apply(state, move, state.turn);
    assert.ok(next, `${text} should be legal`);
    state = next;
  }
  return state;
}

test('chess: checkmate, stalemate and check', () => {
  const mate = playChess(['f2f3', 'e7e5', 'g2g4', 'd8h4']);
  assert.deepEqual(mate.over, { winner: 1, reason: 'checkmate' });
  assert.equal(chess.apply(mate, { from: sq('a2'), to: sq('a3') }, 0), null, 'no moves after mate');

  const stale = playChess(['g5g6'], stateFromPosition(positionFromFen('7k/8/5K2/6Q1/8/8/8/8 w - -')));
  assert.deepEqual(stale.over, { winner: null, reason: 'stalemate' });

  const check = playChess(['e2e4', 'f7f6', 'd1h5']);
  assert.equal(check.check, true);
  assert.equal(check.over, null);
  assert.equal(chess.apply(check, { from: sq('a7'), to: sq('a6') }, 1), null, 'must answer the check');
  assert.ok(chess.apply(check, { from: sq('g7'), to: sq('g6') }, 1));
});

test('chess: illegal moves, wrong turns and malformed moves are refused', () => {
  const start = chess.init();
  assert.equal(chess.apply(start, { from: sq('e2'), to: sq('e4') }, 1), null, "Black can't move White");
  assert.equal(chess.apply(start, { from: sq('e7'), to: sq('e5') }, 0), null, "White can't move Black's pieces");
  assert.equal(chess.apply(start, { from: sq('e2'), to: sq('e5') }, 0), null);
  assert.equal(chess.apply(start, { from: sq('e1'), to: sq('g1') }, 0), null, "can't castle through pieces");
  for (const bad of [null, 'e2e4', {}, { from: 12 }, { from: 12, to: 64 }, { from: -1, to: 3 }, { from: 12, to: 28, promo: 'k' }, { from: 12.5, to: 28 }]) {
    assert.equal(chess.apply(start, bad, 0), null, JSON.stringify(bad));
  }
});

test('chess: promotion needs a piece, en passant and castling work', () => {
  const pawn = stateFromPosition(positionFromFen('8/P6k/8/8/8/8/8/K7 w - -'));
  assert.equal(chess.apply(pawn, { from: sq('a7'), to: sq('a8') }, 0), null, 'must choose a piece');
  assert.equal(chess.apply(pawn, { from: sq('a7'), to: sq('a8'), promo: 'n' }, 0)?.board[sq('a8')], 'N');

  const ep = playChess(['e2e4', 'a7a6', 'e4e5', 'd7d5', 'e5d6']);
  assert.equal(ep.board[sq('d5')], '', 'the passed pawn is taken');
  assert.equal(ep.board[sq('d6')], 'P');
  assert.deepEqual(ep.captured, ['p']);

  const castled = playChess(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5', 'e1g1']);
  assert.equal(castled.board[sq('g1')], 'K');
  assert.equal(castled.board[sq('f1')], 'R');
  assert.equal(castled.castle, 'kq');
});

test('chess: automatic draws', () => {
  const shuffle = ['g1f3', 'g8f6', 'f3g1', 'f6g8'];
  assert.deepEqual(playChess([...shuffle, ...shuffle]).over, { winner: null, reason: 'repetition' });
  const bare = playChess(['a1b2'], stateFromPosition(positionFromFen('8/8/8/8/8/7k/1p6/K7 w - -')));
  assert.deepEqual(bare.over, { winner: null, reason: 'material' });
});

// ── Pool ─────────────────────────────────────────────────────────────────────

test('pool: the same shots always give exactly the same table', () => {
  const shots = [
    { dx: 1, dy: 0.013, power: 1 },
    { dx: 0.3, dy: -0.8, power: 0.7 },
    { dx: -1, dy: 0.4, power: 0.55 },
    { dx: 0.2, dy: 1, power: 0.9 },
  ];
  const run = () => {
    let state = pool.init();
    for (const shot of shots) {
      if (state.over) break;
      const withCue = state.ballInHand && !state.breakShot ? { ...shot, cue: { x: state.balls[0].x, y: state.balls[0].y } } : shot;
      const next = pool.apply(state, withCue, state.turn);
      assert.ok(next, 'shot should be allowed');
      state = next;
    }
    return state;
  };
  const a = run();
  assert.equal(JSON.stringify(a), JSON.stringify(run()));
  // Also survives a trip through JSON (how it reaches the other player).
  assert.equal(JSON.stringify(a), JSON.stringify(JSON.parse(JSON.stringify(a))));
});

test('pool: balls stay on the table and never overlap', () => {
  let state = pool.init();
  const shots = [
    { dx: 1, dy: 0.02, power: 1 },
    { dx: 1, dy: 1, power: 1 },
    { dx: -1, dy: 0.3, power: 1 },
    { dx: 0.1, dy: -1, power: 1 },
    { dx: 1, dy: -0.2, power: 0.8 },
    { dx: -0.6, dy: -1, power: 1 },
  ];
  for (const shot of shots) {
    if (state.over) break;
    const next = pool.apply(state, shot, state.turn);
    assert.ok(next);
    state = next;
    const on = state.balls.filter((b) => !b.in);
    for (const b of on) {
      assert.ok(b.x >= BALL_R - 1e-6 && b.x <= TABLE_W - BALL_R + 1e-6 && b.y >= BALL_R - 1e-6 && b.y <= TABLE_H - BALL_R + 1e-6, 'on the table');
    }
    for (let i = 0; i < on.length; i++) {
      for (let j = i + 1; j < on.length; j++) {
        assert.ok(Math.hypot(on[i].x - on[j].x, on[i].y - on[j].y) > BALL_R * 2 - 0.5, 'not overlapping');
      }
    }
  }
});

/** A table with only the listed balls on it. */
function table(placed: Record<number, [number, number]>, extra: Partial<PoolState> = {}): PoolState {
  const base = pool.init();
  const balls = base.balls.map((_, i) => (placed[i] ? { x: placed[i][0], y: placed[i][1], in: false } : { x: 0, y: 0, in: true }));
  return { ...base, balls, ballInHand: false, breakShot: false, ...extra };
}

test('pool: pocketing a ball on an open table claims its group and keeps the turn', () => {
  // The 3 sits in front of the middle of the right-hand end; shoot it straight into the corner line.
  const state = table({ 0: [800, 60], 3: [900, 30], 8: [500, 250], 12: [300, 400] });
  const next = pool.apply(state, { dx: 100, dy: -30, power: 0.5 }, 0);
  assert.ok(next);
  assert.deepEqual(next.potted, [3]);
  assert.deepEqual(next.groups, ['solid', 'stripe']);
  assert.equal(next.turn, 0);
  assert.equal(next.foul, null);
});

test('pool: fouls hand over the cue ball', () => {
  const miss = pool.apply(table({ 0: [500, 250], 3: [900, 400], 8: [100, 100] }), { dx: -1, dy: 0, power: 0.2 }, 0);
  assert.equal(miss?.foul, 'no-hit');
  assert.equal(miss?.turn, 1);
  assert.equal(miss?.ballInHand, true);

  const wrong = pool.apply(table({ 0: [500, 250], 12: [600, 250], 3: [100, 100], 8: [100, 400] }, { groups: ['solid', 'stripe'] }), { dx: 1, dy: 0, power: 0.2 }, 0);
  assert.equal(wrong?.foul, 'wrong-ball');
  assert.equal(wrong?.turn, 1);

  const scratch = pool.apply(table({ 0: [960, 40], 3: [100, 100], 8: [500, 250] }), { dx: 1, dy: -1, power: 0.3 }, 0);
  assert.equal(scratch?.foul, 'scratch');
  assert.equal(scratch?.balls[0].in, false, 'the cue ball comes back');
  assert.equal(scratch?.ballInHand, true);
});

test('pool: the 8 wins after your group is cleared and loses before', () => {
  const eightShot = { dx: 100, dy: -30, power: 0.5 };
  const early = pool.apply(table({ 0: [800, 60], 8: [900, 30], 3: [300, 300], 12: [300, 400] }, { groups: ['solid', 'stripe'] }), eightShot, 0);
  assert.deepEqual(early?.over, { winner: 1, reason: 'eight-early' });
  const win = pool.apply(table({ 0: [800, 60], 8: [900, 30], 12: [300, 400] }, { groups: ['solid', 'stripe'] }), eightShot, 0);
  assert.deepEqual(win?.over, { winner: 0, reason: 'eight' });
  assert.equal(pool.apply(win as PoolState, eightShot, 0), null, 'no shots after the game');
});

/** Play a shot out and return the finished simulation. */
function simulate(state: PoolState, shot: object) {
  const sim = startShot(state, shot);
  assert.ok(sim);
  while (stepSim(sim)) {
    /* run to rest */
  }
  return sim;
}

test('pool physics: a rolling cue ball follows through, a sliding one stops dead', () => {
  // Both sink the 3 in the top side pocket, straight on.
  // From far away and soft, the cue ball is rolling by the time it arrives and keeps going.
  const follow = simulate(table({ 0: [TABLE_W / 2, 470], 3: [TABLE_W / 2, 240], 8: [100, 100] }), { dx: 0, dy: -1, power: 0.25 });
  assert.equal(follow.firstHit, 3);
  assert.ok(follow.potted.includes(3));
  assert.ok(follow.balls[0].in || follow.balls[0].y < 240 - BALL_R * 4, `followed through to ${follow.balls[0].y}`);

  // From close and harder, it's still sliding at contact, so it stops where it hit (a stun shot).
  const stun = simulate(table({ 0: [TABLE_W / 2, 300], 3: [TABLE_W / 2, 240], 8: [100, 100] }), { dx: 0, dy: -1, power: 0.5 });
  assert.equal(stun.firstHit, 3);
  assert.ok(stun.potted.includes(3));
  assert.ok(Math.abs(stun.balls[0].y - (240 + BALL_R * 2)) < BALL_R * 2, `stopped at ${stun.balls[0].y}`);
});

test('pool physics: a struck ball slides, then rolls at 5/7 of its speed', () => {
  const sim = startShot(table({ 0: [100, 250], 8: [900, 450] }), { dx: 1, dy: 0, power: 0.3 });
  assert.ok(sim);
  const start = sim.balls[0].vx;
  for (let i = 0; i < 240 * 3 && sim.balls[0].vx !== sim.balls[0].ux; i++) stepSim(sim);
  assert.equal(sim.balls[0].vx, sim.balls[0].ux, 'rolling');
  assert.ok(sim.balls[0].x < TABLE_W / 2, 'within half the table');
  assert.ok(sim.balls[0].vx < start * (5 / 7) + 1 && sim.balls[0].vx > start * 0.6, `${sim.balls[0].vx} vs ${start}`);
});

test('pool physics: the fastest shot never passes through a ball', () => {
  const sim = simulate(table({ 0: [100, 250], 3: [130, 250], 8: [900, 450] }), { dx: 1, dy: 0, power: 1 });
  assert.equal(sim.firstHit, 3);
  assert.ok(sim.balls[0].x < sim.balls[3].x || sim.balls[3].in, 'the object ball stays ahead');
});

test('pool physics: balls drop through the pocket openings and bounce off solid cushion', () => {
  // Rolled along the top rail into the corner.
  const corner = simulate(table({ 0: [300, BALL_R], 8: [500, 250] }), { dx: -1, dy: 0, power: 0.4 });
  assert.deepEqual(corner.potted, [0]);
  // Straight into the side pocket.
  const side = simulate(table({ 0: [TABLE_W / 2, 300], 8: [100, 100] }), { dx: 0, dy: -1, power: 0.4 });
  assert.deepEqual(side.potted, [0]);
  // Straight at the cushion beside it: comes back.
  const bounce = simulate(table({ 0: [300, 300], 8: [100, 100] }), { dx: 0, dy: -1, power: 0.4 });
  assert.deepEqual(bounce.potted, []);
  assert.ok(bounce.balls[0].y > BALL_R);
});

test('pool: placing the cue ball and refusing bad shots', () => {
  const start = pool.init();
  assert.equal(canPlaceCue(start, 100, 100), true);
  assert.equal(canPlaceCue(start, 600, 100), false, 'the break is from behind the head string');
  assert.equal(canPlaceCue(start, 5, 100), false, 'off the table');
  assert.equal(pool.apply(start, { dx: 1, dy: 0, power: 1, cue: { x: 600, y: 100 } }, 0), null);
  assert.equal(pool.apply(start, { dx: 1, dy: 0, power: 1 }, 1), null, 'not your turn');
  for (const bad of [null, {}, { dx: 0, dy: 0, power: 1 }, { dx: 1, dy: 0, power: 2 }, { dx: 1, dy: 0, power: 0 }, { dx: NaN, dy: 0, power: 1 }, { dx: '1', dy: 0, power: 1 }]) {
    assert.equal(pool.apply(start, bad, 0), null, JSON.stringify(bad));
  }
  const afterBreak = pool.apply(start, { dx: 1, dy: 0, power: 1 }, 0);
  assert.ok(afterBreak);
  assert.equal(afterBreak.breakShot, false);
  assert.equal(remaining(afterBreak, 'solid').length + remaining(afterBreak, 'stripe').length + afterBreak.potted.filter((i) => i !== 0 && i !== 8).length, 14);
});

// ── Sessions ─────────────────────────────────────────────────────────────────

test('session: moves count only in order, from the player whose turn it is', () => {
  const s = newSession('g1', 'connect4', ['alice', 'bob']);
  assert.equal(tryMove(s, 'bob', 0, { col: 3 }), 'rejected', "not bob's turn");
  assert.equal(tryMove(s, 'carol', 0, { col: 3 }), 'rejected', 'not a player');
  assert.equal(tryMove(s, 'alice', 0, { col: 3 }), 'applied');
  assert.equal(tryMove(s, 'alice', 0, { col: 3 }), 'rejected', 'already played');
  assert.equal(tryMove(s, 'bob', 3, { col: 3 }), 'gap', 'we missed moves');
  assert.equal(tryMove(s, 'bob', 1, { col: 9 }), 'rejected', 'not legal');
  assert.equal(tryMove(s, 'bob', 1, { col: 3 }), 'applied');
  assert.equal(s.moves.length, 2);
});

test('session: a pool game at the move limit ends for players and late joiners', () => {
  const s = newSession('long-game', 'pool2', ['alice', 'bob']);
  const shot = { dx: 1, dy: 0, power: 0.02, cue: { x: 100, y: 100 } };
  for (let n = 0; n < pool.maxMoves; n++) {
    assert.equal(tryMove(s, s.players[pool.turn(s.state as PoolState)], n, shot), 'applied');
  }
  const result = { winner: null, reason: 'move-limit' };
  assert.deepEqual(resultOf(s), result);
  assert.equal(tryMove(s, s.players[pool.turn(s.state as PoolState)], pool.maxMoves, shot), 'rejected');
  assert.deepEqual(resultOf(fromSnapshot(toSnapshot(s))!), result);
});

test('session: a snapshot is replayed through the rules', () => {
  const s = newSession('g1', 'chess', ['alice', 'bob']);
  tryMove(s, 'alice', 0, { from: sq('e2'), to: sq('e4') });
  tryMove(s, 'bob', 1, { from: sq('e7'), to: sq('e5') });
  const copy = fromSnapshot(JSON.parse(JSON.stringify(toSnapshot(s))));
  assert.ok(copy);
  assert.deepEqual(copy.state, s.state);

  const snap = toSnapshot(s);
  assert.equal(fromSnapshot({ ...snap, moves: [{ from: sq('e2'), to: sq('e5') }] }), null, 'illegal move inside');
  assert.equal(fromSnapshot({ ...snap, kind: 'poker' }), null);
  assert.equal(fromSnapshot({ ...snap, kind: 'constructor' }), null);
  assert.equal(fromSnapshot({ ...snap, players: ['alice', 'alice'] }), null);
  assert.equal(fromSnapshot({ ...snap, players: ['alice'] }), null);
  assert.equal(fromSnapshot({ ...snap, id: '' }), null);
  assert.equal(fromSnapshot({ ...snap, moves: new Array(5000).fill({}) }), null);
  assert.equal(fromSnapshot(null), null);
});

test('session: resigning, and which game wins when two arrive', () => {
  const s = newSession('m', 'connect4', ['alice', 'bob']);
  assert.equal(stop(s, 'carol', 'resign'), false);
  assert.equal(stop(s, 'bob', 'resign'), true);
  assert.deepEqual(resultOf(s), { winner: 0 as Seat, reason: 'resign' });
  assert.equal(stop(s, 'alice', 'resign'), false, 'already over');
  assert.deepEqual(resultOf(fromSnapshot(toSnapshot(s))!), { winner: 0, reason: 'resign' });

  const mine = newSession('m', 'connect4', ['alice', 'bob']);
  const ahead = newSession('m', 'connect4', ['alice', 'bob']);
  tryMove(ahead, 'alice', 0, { col: 1 });
  assert.equal(shouldAdopt(null, mine, false), true);
  assert.equal(shouldAdopt(mine, ahead, true), true, 'same game, further along');
  assert.equal(shouldAdopt(ahead, mine, true), false, 'same game, behind');
  assert.equal(shouldAdopt(mine, s, true), true, 'same game, now resigned');
  assert.equal(shouldAdopt(mine, newSession('a', 'chess', ['alice', 'bob']), true), true, 'started together: the first id wins');
  assert.equal(shouldAdopt(mine, newSession('z', 'chess', ['alice', 'bob']), true), false);
  assert.equal(shouldAdopt(ahead, newSession('a', 'chess', ['alice', 'bob']), true), false, "a game under way isn't replaced");
  assert.equal(shouldAdopt(ahead, newSession('z', 'chess', ['alice', 'bob']), false), true, 'ours is over or a player left');
});

// ── Invitations ──────────────────────────────────────────────────────────────

test('invites: one per person, checked, rate limited, and only the sender can take one back', () => {
  const book = new InviteBook();
  assert.equal(book.receive('bob', { id: 'i1', kind: 'chess' }, 0)?.from, 'bob');
  for (const bad of [null, {}, { id: 'x', kind: 'poker' }, { id: '', kind: 'chess' }, { id: 'x'.repeat(41), kind: 'pool2' }, { id: 7, kind: 'pool2' }]) {
    assert.equal(book.receive('carol', bad, 5_000), null, JSON.stringify(bad));
  }
  assert.equal(book.receive('bob', { id: 'i2', kind: 'pool2' }, 500), null, 'too soon');
  assert.equal(book.receive('bob', { id: 'i3', kind: 'pool2' }, 2_000)?.id, 'i3', 'a newer one replaces the older');
  assert.deepEqual(book.list().map((i) => i.id), ['i3']);

  book.receive('dave', { id: 'd1', kind: 'connect4' }, 3_000);
  assert.equal(book.cancel('dave', 'i3'), false, "dave can't take back bob's invitation");
  assert.equal(book.cancel('bob', 'i1'), false, 'that one is gone already');
  assert.equal(book.cancel('bob', 'i3'), true);
  assert.equal(book.take('d1')?.from, 'dave');
  assert.equal(book.take('d1'), undefined, 'answered once');
});

test('invites: go when the sender leaves or nobody answers in time', () => {
  const book = new InviteBook();
  book.receive('bob', { id: 'b', kind: 'chess' }, 0);
  book.receive('carol', { id: 'c', kind: 'chess' }, 10_000);
  assert.equal(book.removePeer('bob'), true);
  assert.equal(book.expire(10_000 + INVITE_TTL_MS - 1), false);
  assert.equal(book.expire(10_000 + INVITE_TTL_MS), true);
  assert.deepEqual(book.list(), []);
});
