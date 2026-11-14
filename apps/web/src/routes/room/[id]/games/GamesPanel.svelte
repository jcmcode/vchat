<script lang="ts">
  import { createEventDispatcher, onDestroy } from 'svelte';
  import Icon from '$lib/ui/Icon.svelte';
  import { localPeerIdStore, peers } from '$lib/webrtc/mesh';
  import { cancelInvite, dismissGame, gameSession, inviteToGame, outgoingInvite, rematch, stopGame } from '$lib/games/games';
  import { GAME_NAMES, resultOf, seatOf, turnOf, type GameKind } from '$lib/games/session-model';
  import { remaining, type PoolState } from '$lib/games/pool';
  import type { ChessState } from '$lib/games/chess';
  import type { Connect4State } from '$lib/games/connect4';
  import Connect4Board from './Connect4Board.svelte';
  import ChessBoard from './ChessBoard.svelte';
  import PoolTable from './PoolTable.svelte';

  const dispatch = createEventDispatcher<{ close: void }>();

  const GAMES: Array<{ kind: GameKind; blurb: string }> = [
    { kind: 'chess', blurb: 'The classic. Full rules, check to checkmate.' },
    { kind: 'pool', blurb: '8-ball. Aim, set your power and shoot.' },
    { kind: 'connect4', blurb: 'Drop discs, get four in a row.' },
  ];
  const SEATS: Record<GameKind, [string, string]> = {
    chess: ['White', 'Black'],
    connect4: ['Red', 'Yellow'],
    pool: ['', ''],
  };
  const REASONS: Record<string, string> = {
    checkmate: 'by checkmate',
    stalemate: 'stalemate',
    repetition: 'the same position three times',
    fifty: 'fifty moves without a capture or pawn move',
    material: 'not enough pieces left to mate',
    four: 'four in a row',
    full: 'the board is full',
    resign: 'by resignation',
    abandon: 'the game was called off',
    eight: 'by pocketing the 8',
    'eight-early': 'the 8 went in too early',
    'eight-foul': 'foul on the 8',
  };
  const FOULS: Record<string, string> = {
    scratch: 'The cue ball went in',
    'no-hit': 'The cue ball hit nothing',
    'wrong-ball': 'Wrong ball hit first',
  };

  let opponentId = '';
  let confirmResign = false;
  let confirmTimer: ReturnType<typeof setTimeout> | null = null;
  // Pool plays each shot out before showing its result.
  let rolling = false;
  let poolView: PoolState | null = null;

  $: session = $gameSession;
  $: me = $localPeerIdStore;
  $: others = Array.from($peers.values()).filter((p) => p.trusted);
  // With one other person they're the opponent; in a group you choose (nobody is picked for you).
  $: if (!others.some((p) => p.id === opponentId)) opponentId = others.length === 1 ? others[0].id : '';
  $: opponentName = others.find((p) => p.id === opponentId)?.displayName ?? '';

  function initial(name: string): string {
    return Array.from(name.trim())[0]?.toUpperCase() ?? '?';
  }
  $: seat = session ? seatOf(session, me) : -1;
  $: result = session ? resultOf(session) : null;
  // Who's in the call right now (follows people coming and going).
  $: here = new Set([me, ...others.map((p) => p.id)]);
  $: allHere = !!session && session.players.every((id) => here.has(id));
  $: inPlay = !!session && !result && allHere;
  $: awayId = session && !result ? session.players.find((id) => !here.has(id)) ?? null : null;
  $: turn = session ? turnOf(session) : 0;
  $: canMove = !!session && inPlay && seat === turn;
  $: if (session?.kind !== 'pool') {
    rolling = false;
    poolView = null;
  }
  $: if (!inPlay) confirmResign = false;

  function nameOf(id: string, all = $peers): string {
    if (id === me) return 'You';
    return all.get(id)?.displayName ?? 'Someone who left';
  }

  $: names = session ? session.players.map((id) => nameOf(id, $peers)) : [];

  function seatLabel(i: number): string {
    if (!session) return '';
    if (session.kind !== 'pool') return SEATS[session.kind][i];
    const group = (poolView ?? (session.state as PoolState)).groups[i];
    return group === 'solid' ? 'Solids' : group === 'stripe' ? 'Stripes' : '';
  }

  function poolLeft(i: number): number | null {
    if (session?.kind !== 'pool') return null;
    const state = poolView ?? (session.state as PoolState);
    const group = state.groups[i];
    return group ? remaining(state, group).length : null;
  }

  $: status = describe(session, result, turn, seat, awayId, rolling, names);
  $: detail = poolDetail(session, poolView, rolling, result);

  function describe(..._deps: unknown[]): string {
    if (!session) return '';
    if (rolling) return 'Balls are rolling…';
    if (result) {
      const why = REASONS[result.reason] ?? '';
      if (result.winner === null) return `Draw${result.reason === 'abandon' ? '' : ':'} ${why}`.trim();
      const winner = result.winner === seat ? 'You won' : `${names[result.winner]} won`;
      return `${winner} ${why}`.trim();
    }
    if (awayId) return `${nameOf(awayId)} isn't in the call. The game picks up when they're back.`;
    const check = session.kind === 'chess' && (session.state as ChessState).check ? ' Check!' : '';
    if (seat === turn) return `Your turn.${check}`;
    return `${names[turn]}'s turn.${check}`;
  }

  function poolDetail(..._deps: unknown[]): string {
    if (session?.kind !== 'pool' || rolling || result) return '';
    const state = poolView ?? (session.state as PoolState);
    if (state.breakShot) return 'Break shot.';
    const parts: string[] = [];
    if (state.foul) parts.push(`${FOULS[state.foul]}: ball in hand.`);
    if (!state.groups[0]) parts.push('Open table: the first ball pocketed decides who has solids or stripes.');
    return parts.join(' ');
  }

  function start(kind: GameKind) {
    if (opponentId) inviteToGame(kind, opponentId);
  }

  $: invite = $outgoingInvite;
  $: waiting = invite?.status === 'waiting';
  const ANSWERS: Record<string, string> = {
    declined: 'said no this time.',
    busy: 'is busy right now.',
    expired: "didn't answer.",
  };

  function resign() {
    if (!inPlay) {
      stopGame();
      return;
    }
    if (!confirmResign) {
      confirmResign = true;
      if (confirmTimer) clearTimeout(confirmTimer);
      confirmTimer = setTimeout(() => (confirmResign = false), 4000);
      return;
    }
    confirmResign = false;
    stopGame();
  }

  onDestroy(() => {
    if (confirmTimer) clearTimeout(confirmTimer);
  });

  // Typed views of the position for each board.
  $: connect4State = session?.kind === 'connect4' ? (session.state as Connect4State) : null;
  $: chessState = session?.kind === 'chess' ? (session.state as ChessState) : null;
</script>

<div class="games">
  <header class="bar">
    <div class="title">
      <Icon name="gamepad" size={18} />
      <span>{session ? GAME_NAMES[session.kind] : 'Games'}</span>
    </div>

    {#if session}
      <div class="players">
        {#each session.players as id, i}
          <span class="chip" class:turn={!result && !rolling && turn === i} class:winner={result?.winner === i && !rolling}>
            <span class="dot {session.kind} s{i}" aria-hidden="true"></span>
            <span class="chip-name">{names[i]}</span>
            {#if seatLabel(i)}<span class="chip-seat">{seatLabel(i)}{poolLeft(i) !== null ? ` · ${poolLeft(i)} left` : ''}</span>{/if}
          </span>
        {/each}
        {#if seat < 0}<span class="watching">Watching</span>{/if}
      </div>
    {/if}

    <div class="actions">
      {#if session && seat >= 0 && !result}
        <button class="btn" class:danger={confirmResign} on:click={resign}>
          {inPlay ? (confirmResign ? 'Really resign?' : 'Resign') : 'End game'}
        </button>
      {/if}
      {#if session && result && !rolling}
        {#if invite?.rematch}
          <span class="asked" role="status">
            {#if waiting}<span class="spinner" aria-hidden="true"></span>Asked {invite.name} for a rematch…{:else}{invite.name} {ANSWERS[invite.status]}{/if}
          </span>
          <button class="btn" on:click={cancelInvite}>{waiting ? 'Cancel' : 'OK'}</button>
        {:else if seat >= 0 && allHere}
          <button class="btn primary" on:click={rematch}>Rematch</button>
        {/if}
        <button class="btn" on:click={dismissGame}>Other games</button>
      {:else if session && seat < 0 && !inPlay}
        <button class="btn" on:click={dismissGame}>Other games</button>
      {/if}
      <button class="btn icon" on:click={() => dispatch('close')} aria-label="Hide games" title="Hide games (the game keeps going)">
        <Icon name="x" size={16} />
      </button>
    </div>
  </header>

  {#if session}
    <p class="status" class:over={!!result && !rolling} role="status" aria-live="polite">
      <strong>{status}</strong>
      {#if detail}<span class="detail">{detail}</span>{/if}
    </p>
    <div class="play">
      {#if connect4State}
        <Connect4Board state={connect4State} {seat} {canMove} />
      {:else if chessState}
        <ChessBoard state={chessState} {seat} {canMove} />
      {:else if session.kind === 'pool'}
        {#key session.id}
          <PoolTable {session} {canMove} bind:rolling bind:view={poolView} />
        {/key}
      {/if}
    </div>
  {:else}
    <div class="picker">
      {#if others.length === 0}
        <p class="lead">Games are for two. Once someone else joins the call, you can start one here.</p>
      {:else if others.length === 1}
        <p class="lead">Pick a game to play with <strong>{others[0].displayName}</strong>.</p>
      {:else}
        <div class="choose">
          <p class="lead" id="choose-label">
            {#if opponentName}
              Playing with <strong>{opponentName}</strong>. Pick a game; everyone else can watch.
            {:else}
              Who do you want to play with?
            {/if}
          </p>
          <div class="people" role="radiogroup" aria-labelledby="choose-label">
            {#each others as p (p.id)}
              <button
                class="person"
                class:chosen={p.id === opponentId}
                role="radio"
                aria-checked={p.id === opponentId}
                aria-label={p.displayName}
                on:click={() => (opponentId = p.id)}
              >
                <span class="avatar" aria-hidden="true">{initial(p.displayName)}</span>
                <span class="person-name">{p.displayName}</span>
              </button>
            {/each}
          </div>
        </div>
      {/if}
      {#if invite && !invite.rematch}
        <div class="invite-status" class:answered={!waiting} role="status">
          {#if waiting}
            <span class="spinner" aria-hidden="true"></span>
            <span>Invited <strong>{invite.name}</strong> to play {GAME_NAMES[invite.kind]}. Waiting for them to accept…</span>
          {:else}
            <span><strong>{invite.name}</strong> {ANSWERS[invite.status]}</span>
          {/if}
          <button class="btn" on:click={cancelInvite}>{waiting ? 'Cancel' : 'OK'}</button>
        </div>
      {/if}
      <div class="cards">
        {#each GAMES as game}
          <button
            class="card"
            class:asked={waiting && invite?.kind === game.kind && invite?.to === opponentId}
            disabled={!opponentId || waiting}
            title={opponentId ? `Invite ${opponentName} to play ${GAME_NAMES[game.kind]}` : 'Choose who to play with first'}
            on:click={() => start(game.kind)}
          >
            <span class="art {game.kind}" aria-hidden="true">
              {#if game.kind === 'chess'}
                <span>{'♞︎'}</span>
              {:else if game.kind === 'pool'}
                <span class="eight"><b>8</b></span>
              {:else}
                <span class="discs"><i></i><i></i><i></i><i></i></span>
              {/if}
            </span>
            <span class="card-name">{GAME_NAMES[game.kind]}</span>
            <span class="card-blurb">{game.blurb}</span>
          </button>
        {/each}
      </div>
      <p class="foot">Games go straight between the people in the call, end-to-end encrypted like everything else.</p>
    </div>
  {/if}
</div>

<style>
  .games {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-height: 0;
    gap: var(--space-2);
  }

  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
    padding: var(--space-2) var(--space-3);
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
    min-width: 0;
  }

  .title {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-weight: 600;
  }

  .players {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 240px;
    padding: 3px 10px 3px 6px;
    border-radius: var(--radius-pill);
    border: 1px solid var(--border);
    font-size: var(--text-sm);
    color: var(--text-muted);
  }

  .chip.turn {
    border-color: var(--accent-ring);
    background: var(--accent-soft);
    color: var(--text);
  }

  .chip.winner {
    border-color: var(--success);
    background: var(--success-soft);
    color: var(--text);
  }

  .chip-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
  }

  .chip-seat {
    white-space: nowrap;
    color: var(--text-muted);
  }

  .dot {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    flex-shrink: 0;
    border: 1px solid rgba(0, 0, 0, 0.35);
  }

  .dot.chess.s0 {
    background: #fff;
  }

  .dot.chess.s1 {
    background: #20232d;
    border-color: rgba(255, 255, 255, 0.4);
  }

  .dot.connect4.s0 {
    background: #e23b3b;
  }

  .dot.connect4.s1 {
    background: #f6c927;
  }

  .dot.pool {
    background: #1f7d50;
  }

  .watching {
    font-size: var(--text-xs);
    color: var(--text-subtle);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-left: auto;
  }

  .btn {
    height: 32px;
    padding: 0 var(--space-3);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: var(--text-sm);
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
  }

  .btn:hover {
    background: var(--bg-hover);
  }

  .btn.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-text);
  }

  .btn.primary:hover {
    background: var(--accent-hover);
  }

  .btn.danger {
    background: var(--danger-soft);
    border-color: var(--danger);
    color: var(--danger);
  }

  .btn.icon {
    width: 32px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
  }

  .btn:focus-visible,
  .card:focus-visible,
  .person:focus-visible {
    outline: 2px solid var(--accent-ring);
    outline-offset: 2px;
  }

  .status {
    margin: 0;
    text-align: center;
    font-size: var(--text-base);
    min-height: 1.4em;
  }

  .status.over strong {
    color: var(--success);
  }

  .detail {
    margin-left: var(--space-2);
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  .play {
    flex: 1;
    min-height: 0;
    display: flex;
  }

  .picker {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-5);
    padding: var(--space-4);
  }

  .lead {
    margin: 0;
    text-align: center;
    color: var(--text-muted);
  }

  .lead strong {
    color: var(--text);
  }

  .invite-status {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: var(--space-2) var(--space-3);
    max-width: 560px;
    padding: var(--space-2) var(--space-2) var(--space-2) var(--space-4);
    border-radius: var(--radius-lg);
    border: 1px solid var(--accent-ring);
    background: var(--accent-soft);
    font-size: var(--text-sm);
    text-align: center;
  }

  .invite-status.answered {
    border-color: var(--border);
    background: var(--bg-surface);
  }

  .asked {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-muted);
    white-space: nowrap;
  }

  .card.asked:disabled {
    opacity: 1;
    border-color: var(--accent);
  }

  .spinner {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    border-radius: 50%;
    border: 2px solid var(--accent-ring);
    border-top-color: transparent;
    animation: spin 0.9s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
  }

  .choose {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-3);
  }

  .people {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--space-2);
    max-width: 640px;
  }

  .person {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    max-width: 220px;
    padding: 6px 14px 6px 6px;
    border-radius: var(--radius-pill);
    border: 1px solid var(--border);
    background: var(--bg-surface);
    color: var(--text);
    font: inherit;
    font-size: var(--text-sm);
    font-weight: 600;
    cursor: pointer;
    transition: border-color var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease);
  }

  .person:hover {
    border-color: var(--border-strong);
    background: var(--bg-hover);
  }

  .person.chosen {
    border-color: var(--accent);
    background: var(--accent-soft);
  }

  .avatar {
    width: 28px;
    height: 28px;
    flex-shrink: 0;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-elevated);
    color: var(--accent);
    font-weight: 700;
  }

  .person.chosen .avatar {
    background: var(--accent);
    color: var(--accent-text);
  }

  .person-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cards {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--space-4);
  }

  .card {
    width: 200px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-5) var(--space-4);
    border-radius: var(--radius-lg);
    border: 1px solid var(--border);
    background: var(--bg-surface);
    color: var(--text);
    font: inherit;
    cursor: pointer;
    transition: transform var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
  }

  .card:hover:not(:disabled) {
    border-color: var(--accent);
    transform: translateY(-2px);
  }

  .card:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .art {
    width: 72px;
    height: 72px;
    border-radius: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 44px;
    line-height: 1;
  }

  .art.chess {
    background: #7389b8;
    color: #fff;
    font-family: 'Segoe UI Symbol', 'Apple Symbols', 'Noto Sans Symbols2', 'DejaVu Sans', sans-serif;
  }

  .art.pool {
    background: #1f7d50;
  }

  .eight {
    width: 46px;
    height: 46px;
    border-radius: 50%;
    background: #16181d;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .eight b {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: #f7f5ee;
    color: #16181d;
    font-size: 15px;
    line-height: 22px;
    text-align: center;
  }

  .art.connect4 {
    background: #2f55d4;
  }

  .discs {
    display: grid;
    grid-template-columns: repeat(2, 20px);
    gap: 6px;
  }

  .discs i {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #e23b3b;
  }

  .discs i:nth-child(2),
  .discs i:nth-child(3) {
    background: #f6c927;
  }

  .card-name {
    font-weight: 700;
    font-size: var(--text-lg);
  }

  .card-blurb {
    font-size: var(--text-sm);
    color: var(--text-muted);
    text-align: center;
  }

  .foot {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-subtle);
    text-align: center;
  }
</style>
