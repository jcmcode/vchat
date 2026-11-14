<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import {
    BALL_R,
    HEAD_STRING,
    MIN_POWER,
    POCKETS,
    STEPS_PER_SECOND,
    TABLE_H,
    TABLE_W,
    aimPreview,
    canPlaceCue,
    finishShot,
    groupOf,
    startShot,
    stepSim,
    type Ball,
    type PoolState,
    type Sim,
  } from '$lib/games/pool';
  import { gameAim, playMove, shareAim, type Aim } from '$lib/games/games';
  import type { Session } from '$lib/games/session-model';

  export let session: Session;
  export let canMove: boolean;
  /** Balls are still rolling on your screen. */
  export let rolling = false;
  /** The table as it is shown (lags the real game while a shot plays out). */
  export let view: PoolState | null = null;
  /** Plays your shot (the call's game by default). */
  export let play: (shot: unknown) => boolean = playMove;

  let table: PoolState = session.state as PoolState;
  $: view = table;

  const RAIL = 38;
  const FULL_W = TABLE_W + RAIL * 2;
  const FULL_H = TABLE_H + RAIL * 2;
  // Standard ball colours: 1 yellow, 2 blue, 3 red, 4 purple, 5 orange, 6 green, 7 maroon, 8 black
  // (the stripes 9-15 repeat 1-7 as a band).
  const COLORS = ['#f6f3ea', '#f7c614', '#1f4fd6', '#de2a22', '#7b2fbe', '#f57418', '#13894a', '#8a1c1c', '#111317'];
  const CLOTH = '#1f7d50';

  let canvas: HTMLCanvasElement;
  let wrap: HTMLDivElement;
  let ctx: CanvasRenderingContext2D | null = null;
  let scale = 1;
  let raf = 0;
  let observer: ResizeObserver | null = null;

  // What's on screen: the table before the shot being played out, the shot itself, and how many
  // of the game's shots have been shown so far.
  let sim: Sim | null = null;
  let shownId = '';
  let shownMoves = 0;
  let lastFrame = 0;
  let carry = 0;

  // Your aim (while it's your shot).
  let aim: { dx: number; dy: number } | null = null;
  let power = 60;
  let cuePlace: { x: number; y: number } | null = null;
  let dragging: 'aim' | 'cue' | 'pull' | null = null;

  // Pulling the cue back: grab the stick, draw it back (further = harder), let go to strike.
  /** How far back (table units) the stick goes at full power. */
  const PULL_MAX = 170;
  const STICK_LEN = 330;
  /** How close to the stick (table units, either side) counts as grabbing it. */
  const STICK_GRAB = 34;
  /** The stroke forward to the ball before the shot is played. */
  const STROKE_MS = 110;
  let pullStart = 0;
  let pullStartPower = 0;
  let pullMoved = false;
  let overStick = false;
  /** The cue on its way forward (power at the start of the stroke, when it started). */
  let stroke: { power: number; at: number } | null = null;
  let strokeRaf = 0;

  $: ready = canMove && !rolling;
  $: follow(session);
  $: if (!ready && (aim || cuePlace || stroke)) dropAim();
  $: remoteAim = !canMove && !rolling ? $gameAim : null;
  $: table, aim, power, cuePlace, remoteAim, overStick, dragging, redraw();

  /** Keep up with the game: play the newest shot, or jump straight to the table if we fell behind. */
  function follow(s: Session) {
    const total = s.moves.length;
    if (s.id !== shownId || total < shownMoves) {
      shownId = s.id;
      settle(s);
      return;
    }
    // The shot being played out counts as seen (this runs again whenever the parent re-renders).
    if (total === shownMoves + (sim ? 1 : 0)) return;
    // Finish whatever is still rolling before starting the next shot.
    if (sim) {
      while (stepSim(sim)) {
        /* run to rest */
      }
      table = finishShot(table, sim, table.turn);
      sim = null;
      shownMoves++;
    }
    if (total === shownMoves + 1) {
      const next = startShot(table, s.moves[shownMoves]);
      if (next) {
        sim = next;
        rolling = true;
        lastFrame = 0;
        carry = 0;
        schedule();
        return;
      }
    }
    settle(s);
  }

  function settle(s: Session) {
    sim = null;
    rolling = false;
    table = s.state as PoolState;
    shownMoves = s.moves.length;
  }

  function schedule() {
    if (!raf && typeof requestAnimationFrame !== 'undefined') raf = requestAnimationFrame(frame);
  }

  function frame(now: number) {
    raf = 0;
    if (!sim) return;
    const elapsed = lastFrame ? Math.min(0.1, (now - lastFrame) / 1000) : 1 / 60;
    lastFrame = now;
    carry += elapsed * STEPS_PER_SECOND;
    let moving = true;
    while (carry >= 1 && moving) {
      moving = stepSim(sim);
      carry -= 1;
    }
    if (moving) {
      draw();
      schedule();
      return;
    }
    table = finishShot(table, sim, table.turn);
    sim = null;
    shownMoves++;
    rolling = false;
    // The game may have moved on while this played (a background tab animates slowly).
    follow(session);
  }

  // ── Aiming ─────────────────────────────────────────────────────────────────

  function cuePosition(): { x: number; y: number } {
    return cuePlace ?? table.balls[0];
  }

  function toTable(e: PointerEvent): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * FULL_W - RAIL,
      y: ((e.clientY - rect.top) / rect.height) * FULL_H - RAIL,
    };
  }

  function announce() {
    if (!ready) return;
    const shared: Aim | null = aim ? { dx: aim.dx, dy: aim.dy, power: power / 100, ...(cuePlace ? { cue: cuePlace } : {}) } : null;
    shareAim(shared);
  }

  function dropAim() {
    aim = null;
    cuePlace = null;
    dragging = null;
    overStick = false;
    stroke = null;
    if (strokeRaf) cancelAnimationFrame(strokeRaf);
    strokeRaf = 0;
  }

  /** Where the stick's tip sits behind the cue ball at a given power (0-100). */
  function stickBack(p: number): number {
    return BALL_R + 6 + (p / 100) * PULL_MAX;
  }

  /** How far behind the cue ball `p` is along the aim line, and how far to the side of it. */
  function alongAim(p: { x: number; y: number }): { behind: number; side: number } | null {
    if (!aim) return null;
    const length = Math.hypot(aim.dx, aim.dy);
    if (!length) return null;
    const ux = aim.dx / length;
    const uy = aim.dy / length;
    const cue = cuePosition();
    const rx = cue.x - p.x;
    const ry = cue.y - p.y;
    return { behind: rx * ux + ry * uy, side: Math.abs(rx * uy - ry * ux) };
  }

  function onStick(p: { x: number; y: number }): boolean {
    const at = alongAim(p);
    if (!at) return false;
    return at.side < STICK_GRAB && at.behind > BALL_R && at.behind < stickBack(power) + STICK_LEN + STICK_GRAB;
  }

  /** Let go of a pulled-back cue: it strokes forward to the ball, then the shot is played. */
  function strike() {
    if (!ready || !aim || stroke) return;
    stroke = { power, at: performance.now() };
    const tick = (now: number) => {
      strokeRaf = 0;
      if (!stroke) return;
      if (now - stroke.at >= STROKE_MS) {
        power = stroke.power;
        stroke = null;
        shoot();
        return;
      }
      draw();
      strokeRaf = requestAnimationFrame(tick);
    };
    strokeRaf = requestAnimationFrame(tick);
  }

  function aimAt(p: { x: number; y: number }) {
    const cue = cuePosition();
    const dx = p.x - cue.x;
    const dy = p.y - cue.y;
    if (dx * dx + dy * dy < 4) return;
    aim = { dx, dy };
    announce();
  }

  function pointerDown(e: PointerEvent) {
    if (!ready || stroke) return;
    const p = toTable(e);
    const cue = cuePosition();
    const onCue = Math.hypot(p.x - cue.x, p.y - cue.y) < BALL_R * 2.4;
    dragging = table.ballInHand && onCue ? 'cue' : onStick(p) ? 'pull' : 'aim';
    canvas.setPointerCapture(e.pointerId);
    if (dragging === 'aim') aimAt(p);
    if (dragging === 'pull') {
      pullStart = alongAim(p)?.behind ?? 0;
      pullStartPower = power;
      pullMoved = false;
    }
    e.preventDefault();
  }

  function pointerMove(e: PointerEvent) {
    if (!ready || stroke) return;
    const p = toTable(e);
    if (!dragging) {
      overStick = onStick(p);
      return;
    }
    if (dragging === 'pull') {
      // The stick follows the pointer: draw it back for more power, push it in for less.
      const delta = (alongAim(p)?.behind ?? pullStart) - pullStart;
      if (Math.abs(delta) > 4) pullMoved = true;
      const pulled = Math.min(PULL_MAX, Math.max(0, (pullStartPower / 100) * PULL_MAX + delta));
      power = Math.round((pulled / PULL_MAX) * 100);
      announce();
      return;
    }
    if (dragging === 'cue') {
      const x = Math.min(table.breakShot ? HEAD_STRING : TABLE_W - BALL_R, Math.max(BALL_R, p.x));
      const y = Math.min(TABLE_H - BALL_R, Math.max(BALL_R, p.y));
      if (canPlaceCue(table, x, y)) {
        cuePlace = { x, y };
        announce();
      }
    } else {
      aimAt(p);
    }
  }

  function pointerUp() {
    if (dragging === 'pull') {
      dragging = null;
      // A tap on the stick does nothing; a pull let go strikes; pushed all the way in cancels.
      if (pullMoved && power >= MIN_POWER * 100) strike();
      else if (pullMoved) {
        power = pullStartPower;
        announce();
      }
      return;
    }
    dragging = null;
  }

  /** Turn the aim a little (for lining up a fine cut). */
  function nudge(degrees: number) {
    if (!aim) return;
    const a = (degrees * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    aim = { dx: aim.dx * c - aim.dy * s, dy: aim.dx * s + aim.dy * c };
    announce();
  }

  function shoot() {
    if (!ready || !aim) return;
    const shot = { dx: aim.dx, dy: aim.dy, power: Math.max(MIN_POWER, power / 100), ...(table.ballInHand && cuePlace ? { cue: cuePlace } : {}) };
    if (play(shot)) {
      shareAim(null);
      dropAim();
    }
  }

  function keydown(e: KeyboardEvent) {
    if (!ready || stroke) return;
    if (e.key === 'ArrowLeft') nudge(e.shiftKey ? -2 : -0.25);
    else if (e.key === 'ArrowRight') nudge(e.shiftKey ? 2 : 0.25);
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      power = Math.min(100, Math.max(2, power + (e.key === 'ArrowUp' ? 5 : -5)));
      announce();
    } else if (e.key === 'Enter') {
      if (aim) strike();
    }
    else return;
    e.preventDefault();
  }

  // ── Drawing ────────────────────────────────────────────────────────────────

  function redraw() {
    if (ctx && !sim) draw();
  }

  function resize() {
    if (!canvas || !wrap) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = canvas.clientWidth;
    if (!width) return;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(((width * FULL_H) / FULL_W) * dpr);
    scale = canvas.width / FULL_W;
    draw();
  }

  function drawBall(c: CanvasRenderingContext2D, n: number, b: Ball, alpha = 1) {
    c.save();
    c.globalAlpha = alpha;
    c.translate(b.x, b.y);
    // Shadow on the cloth.
    c.beginPath();
    c.arc(1.5, 2.2, BALL_R, 0, Math.PI * 2);
    c.fillStyle = 'rgba(0, 0, 0, 0.3)';
    c.fill();
    c.beginPath();
    c.arc(0, 0, BALL_R, 0, Math.PI * 2);
    const striped = groupOf(n) === 'stripe';
    const color = COLORS[n > 8 ? n - 8 : n];
    c.fillStyle = striped ? COLORS[0] : color;
    c.fill();
    c.save();
    c.clip();
    if (striped) {
      // A wide band round the middle, white caps top and bottom: the way stripes look on a real ball.
      c.fillStyle = color;
      c.fillRect(-BALL_R, -BALL_R * 0.62, BALL_R * 2, BALL_R * 1.24);
    }
    // Light from the top left.
    const shade = c.createRadialGradient(-BALL_R * 0.4, -BALL_R * 0.45, BALL_R * 0.1, 0, 0, BALL_R * 1.05);
    shade.addColorStop(0, 'rgba(255, 255, 255, 0.35)');
    shade.addColorStop(0.45, 'rgba(255, 255, 255, 0)');
    shade.addColorStop(1, 'rgba(0, 0, 0, 0.3)');
    c.fillStyle = shade;
    c.fillRect(-BALL_R, -BALL_R, BALL_R * 2, BALL_R * 2);
    c.restore();
    if (n > 0) {
      // A small number spot, so the ball's colour (or stripe) is what you see.
      c.beginPath();
      c.arc(0, 0, BALL_R * 0.42, 0, Math.PI * 2);
      c.fillStyle = '#f7f5ee';
      c.fill();
      c.fillStyle = '#16181d';
      c.font = `700 ${BALL_R * (n > 9 ? 0.5 : 0.58)}px system-ui, sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(String(n), 0, 0.5);
    }
    c.beginPath();
    c.arc(-BALL_R * 0.38, -BALL_R * 0.42, BALL_R * 0.18, 0, Math.PI * 2);
    c.fillStyle = 'rgba(255, 255, 255, 0.6)';
    c.fill();
    c.restore();
  }

  function drawAim(c: CanvasRenderingContext2D, balls: Ball[], shot: Aim, mine: boolean, back: number, held: boolean) {
    const cue = shot.cue ?? balls[0];
    const length = Math.hypot(shot.dx, shot.dy);
    if (!length) return;
    const ux = shot.dx / length;
    const uy = shot.dy / length;
    const hit = aimPreview(balls, cue.x, cue.y, ux, uy);
    c.save();
    c.lineCap = 'round';
    if (hit) {
      c.strokeStyle = mine ? 'rgba(255, 255, 255, 0.85)' : 'rgba(255, 255, 255, 0.5)';
      c.lineWidth = 1.6;
      c.setLineDash([7, 7]);
      c.beginPath();
      c.moveTo(cue.x + ux * BALL_R, cue.y + uy * BALL_R);
      c.lineTo(hit.x, hit.y);
      c.stroke();
      c.setLineDash([]);
      c.beginPath();
      c.arc(hit.x, hit.y, BALL_R, 0, Math.PI * 2);
      c.stroke();
      if (hit.hit > 0) {
        // Which way the ball it touches would set off.
        const target = balls[hit.hit];
        const nx = (target.x - hit.x) / (BALL_R * 2);
        const ny = (target.y - hit.y) / (BALL_R * 2);
        c.beginPath();
        c.moveTo(target.x + nx * BALL_R, target.y + ny * BALL_R);
        c.lineTo(target.x + nx * (BALL_R + 46), target.y + ny * (BALL_R + 46));
        c.stroke();
      }
    }
    // The cue, drawn back further the harder the shot (and following the pointer while you pull it).
    c.strokeStyle = held ? '#ecd09a' : '#d9b77a';
    c.lineWidth = held ? 6 : 5;
    c.beginPath();
    c.moveTo(cue.x - ux * back, cue.y - uy * back);
    c.lineTo(cue.x - ux * (back + 330), cue.y - uy * (back + 330));
    c.stroke();
    c.strokeStyle = '#f3efe6';
    c.beginPath();
    c.moveTo(cue.x - ux * back, cue.y - uy * back);
    c.lineTo(cue.x - ux * (back + 9), cue.y - uy * (back + 9));
    c.stroke();
    c.restore();
  }

  function draw() {
    const c = ctx;
    if (!c) return;
    c.setTransform(scale, 0, 0, scale, 0, 0);
    c.clearRect(0, 0, FULL_W, FULL_H);

    // Rails, then the cloth.
    c.fillStyle = '#5a3a22';
    c.beginPath();
    c.roundRect(0, 0, FULL_W, FULL_H, 26);
    c.fill();
    c.translate(RAIL, RAIL);
    c.fillStyle = '#17633f';
    c.fillRect(-12, -12, TABLE_W + 24, TABLE_H + 24);
    c.fillStyle = CLOTH;
    c.fillRect(0, 0, TABLE_W, TABLE_H);

    for (const p of POCKETS) {
      c.beginPath();
      c.arc(p.x, p.y, p.r - 2, 0, Math.PI * 2);
      c.fillStyle = '#0b0d10';
      c.fill();
    }

    if (table.breakShot) {
      c.strokeStyle = 'rgba(255, 255, 255, 0.22)';
      c.lineWidth = 1.5;
      c.beginPath();
      c.moveTo(HEAD_STRING, 0);
      c.lineTo(HEAD_STRING, TABLE_H);
      c.stroke();
    }

    const balls: Ball[] = sim ? sim.balls : table.balls.map((b, i) => (i === 0 && cuePlace ? { ...cuePlace, in: false } : b));
    const shot: Aim | null = sim ? null : ready && aim ? { ...aim, power: power / 100 } : remoteAim;
    const shown = shot?.cue && !ready ? balls.map((b, i) => (i === 0 ? { ...shot.cue!, in: false } : b)) : balls;
    if (shot) {
      // During the stroke the tip eases forward from where it was pulled to the ball.
      let back = stickBack(shot.power * 100);
      if (stroke && ready) {
        const t = Math.min(1, (performance.now() - stroke.at) / STROKE_MS);
        back = BALL_R + (stickBack(stroke.power) - BALL_R) * (1 - t * t);
      }
      drawAim(c, shown, shot, ready, back, ready && (dragging === 'pull' || overStick || !!stroke));
    }
    shown.forEach((b, i) => {
      if (!b.in) drawBall(c, i, b);
    });
    if (ready && table.ballInHand && !sim) {
      const cue = shown[0];
      c.strokeStyle = 'rgba(255, 255, 255, 0.8)';
      c.lineWidth = 1.5;
      c.setLineDash([4, 4]);
      c.beginPath();
      c.arc(cue.x, cue.y, BALL_R + 6, 0, Math.PI * 2);
      c.stroke();
      c.setLineDash([]);
    }
  }

  onMount(() => {
    ctx = canvas.getContext('2d');
    observer = new ResizeObserver(resize);
    observer.observe(wrap);
    resize();
    if (sim) schedule();
  });

  onDestroy(() => {
    if (raf) cancelAnimationFrame(raf);
    if (strokeRaf) cancelAnimationFrame(strokeRaf);
    observer?.disconnect();
    if (canMove) shareAim(null);
  });
</script>

<div class="pool">
  <div class="fit" bind:this={wrap}>
    <!-- svelte-ignore a11y-no-noninteractive-tabindex -->
    <canvas
      bind:this={canvas}
      class:ready
      class:grab={ready && overStick && !dragging}
      class:grabbing={ready && dragging === 'pull'}
      tabindex={ready ? 0 : -1}
      aria-label="Pool table. {ready ? 'Press or drag on the table to aim, then pull the cue back and let go to shoot. Left and right arrows fine-tune the aim, up and down set the power, Enter shoots.' : ''}"
      on:pointerdown={pointerDown}
      on:pointermove={pointerMove}
      on:pointerup={pointerUp}
      on:pointercancel={pointerUp}
      on:keydown={keydown}
    ></canvas>
  </div>

  <div class="controls">
    {#if ready}
      <div class="nudge">
        <button class="ctl" on:click={() => nudge(-0.25)} disabled={!aim} aria-label="Turn the aim slightly left" title="Turn slightly left (←)">◂</button>
        <button class="ctl" on:click={() => nudge(0.25)} disabled={!aim} aria-label="Turn the aim slightly right" title="Turn slightly right (→)">▸</button>
      </div>
      <label class="power">
        <span>Power</span>
        <input type="range" min="2" max="100" bind:value={power} on:input={announce} />
        <span class="power-value">{power}%</span>
      </label>
      <button class="shoot" on:click={strike} disabled={!aim || !!stroke}>Shoot</button>
      <span class="hint">
        {#if table.ballInHand}Drag the cue ball to place it{table.breakShot ? ' behind the line' : ''}. {/if}{aim
          ? 'Pull the cue back and let go to shoot.'
          : 'Press or drag on the table to aim.'}
      </span>
    {:else}
      <span class="hint">{rolling ? 'Balls are rolling…' : ''}</span>
    {/if}
  </div>
</div>

<style>
  .pool {
    flex: 1;
    min-height: 0;
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .fit {
    flex: 1;
    min-height: 0;
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    container-type: size;
  }

  canvas {
    width: min(100cqw, 100cqh * 1076 / 576, 1180px);
    aspect-ratio: 1076 / 576;
    display: block;
    border-radius: 14px;
    box-shadow: var(--shadow-md);
    touch-action: none;
  }

  canvas.ready {
    cursor: crosshair;
  }

  canvas.grab {
    cursor: grab;
  }

  canvas.grabbing {
    cursor: grabbing;
  }

  canvas:focus-visible {
    outline: 2px solid var(--accent-ring);
    outline-offset: 2px;
  }

  .controls {
    min-height: 40px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: var(--space-2) var(--space-4);
    flex-shrink: 0;
  }

  .nudge {
    display: flex;
    gap: 2px;
  }

  .ctl {
    width: 36px;
    height: 36px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--bg-surface);
    color: var(--text);
    font-size: 1rem;
    cursor: pointer;
  }

  .ctl:disabled,
  .shoot:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .ctl:hover:not(:disabled) {
    background: var(--bg-hover);
  }

  .power {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-muted);
  }

  .power input {
    width: clamp(110px, 22vw, 240px);
    accent-color: var(--accent);
  }

  .power-value {
    width: 3.2em;
    font-variant-numeric: tabular-nums;
    color: var(--text);
  }

  .shoot {
    height: 36px;
    padding: 0 var(--space-5);
    border-radius: var(--radius-pill);
    border: 0;
    background: var(--accent);
    color: var(--accent-text);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }

  .shoot:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .ctl:focus-visible,
  .shoot:focus-visible {
    outline: 2px solid var(--accent-ring);
    outline-offset: 2px;
  }

  .hint {
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
</style>
