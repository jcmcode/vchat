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
    { kind: 'pool2', blurb: '8-ball. Aim, set your power and shoot.' },
    { kind: 'connect4', blurb: 'Drop discs, get four in a row.' },
  ];
  const SEATS: Record<GameKind, [string, string]> = {
    chess: ['White', 'Black'],
    connect4: ['Red', 'Yellow'],
    pool2: ['', ''],
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

  let confirmResign = false;
  let confirmTimer: ReturnType<typeof setTimeout> | null = null;
  // Pool plays each shot out before showing its result.
  let rolling = false;
  let poolView: PoolState | null = null;
  /** You picked a game and are now choosing who to play it with. */
  let choosing: GameKind | null = null;

  $: session = $gameSession;
  $: me = $localPeerIdStore;
  // Everyone else in the call. Only people whose connection is verified can be invited; the rest
  // are shown as still connecting (so the picker never claims you're alone when you aren't).
  $: everyone = Array.from($peers.values());
  $: others = everyone.filter((p) => p.trusted);
  $: connecting = everyone.filter((p) => !p.trusted);
  // The person you're choosing for left (or everyone did): back to the games.
  $: if (choosing && everyone.length === 0) choosing = null;
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
  $: if (session?.kind !== 'pool2') {
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
    if (session.kind !== 'pool2') return SEATS[session.kind][i];
    const group = (poolView ?? (session.state as PoolState)).groups[i];
    return group === 'solid' ? 'Solids' : group === 'stripe' ? 'Stripes' : '';
  }

  /** Pool: 'solid' or 'stripe' once this seat's group is decided. */
  function poolGroup(i: number): string | null {
    if (session?.kind !== 'pool2') return null;
    return (poolView ?? (session.state as PoolState)).groups[i];
  }

  function poolLeft(i: number): number | null {
    if (session?.kind !== 'pool2') return null;
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
    if (session?.kind !== 'pool2' || rolling || result) return '';
    const state = poolView ?? (session.state as PoolState);
    if (state.breakShot) return 'Break shot.';
    const parts: string[] = [];
    if (state.foul) parts.push(`${FOULS[state.foul]}: ball in hand.`);
    if (!state.groups[0]) parts.push('Open table: the first ball pocketed decides who has solids or stripes.');
    return parts.join(' ');
  }

  /** Pick a game: with one other person it goes straight to them; otherwise choose who next. */
  function pickGame(kind: GameKind) {
    if (waiting) return;
    if (others.length === 1 && connecting.length === 0) {
      invite1(kind, others[0].id);
      return;
    }
    choosing = kind;
  }

  function invite1(kind: GameKind, peerId: string) {
    if (inviteToGame(kind, peerId)) choosing = null;
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
            <span class="dot {session.kind} s{i} {poolGroup(i) ?? ''}" aria-hidden="true"></span>
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
      {:else if session.kind === 'pool2'}
        {#key session.id}
          <PoolTable {session} {canMove} bind:rolling bind:view={poolView} />
        {/key}
      {/if}
    </div>
  {:else}
    <div class="picker">
      {#if choosing}
        <div class="choose">
          <p class="lead" id="choose-label">Who do you want to play <strong>{GAME_NAMES[choosing]}</strong> with?</p>
          <div class="people" role="group" aria-labelledby="choose-label">
            {#each others as p (p.id)}
              <button class="person" on:click={() => choosing && invite1(choosing, p.id)} title="Invite {p.displayName} to play {GAME_NAMES[choosing]}">
                <span class="avatar" aria-hidden="true">{initial(p.displayName)}</span>
                <span class="person-name">{p.displayName}</span>
              </button>
            {/each}
            {#each connecting as p (p.id)}
              <button class="person" disabled title="Still connecting securely to {p.displayName}">
                <span class="avatar" aria-hidden="true">{initial(p.displayName)}</span>
                <span class="person-name">{p.displayName}</span>
                <span class="person-state">connecting…</span>
              </button>
            {/each}
          </div>
          <button class="btn" on:click={() => (choosing = null)}>Back to games</button>
        </div>
      {:else if everyone.length === 0}
        <p class="lead">Games are for two. Once someone else joins the call, pick a game here and invite them.</p>
      {:else if others.length === 0}
        <p class="lead">Connecting securely to {everyone.length === 1 ? everyone[0].displayName : 'the others'}… You can invite {everyone.length === 1 ? 'them' : 'someone'} in a moment.</p>
      {:else}
        <p class="lead">Pick a game, then choose who to play with. Everyone else can watch.</p>
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
      {#if !choosing}
        <div class="cards">
          {#each GAMES as game}
            <button
              class="card"
              class:asked={waiting && invite?.kind === game.kind}
              disabled={others.length === 0 || waiting}
              title={others.length === 0 ? 'Someone else needs to be in the call first' : `Play ${GAME_NAMES[game.kind]}`}
              on:click={() => pickGame(game.kind)}
            >
              <span class="art {game.kind}" aria-hidden="true">
                {#if game.kind === 'chess'}
                  <span>{'♞︎'}</span>
                {:else if game.kind === 'pool2'}
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
      {/if}
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

  .dot.pool2 {
    background: #1f7d50;
  }

  /* A little solid or striped ball once the table isn't open any more. */
  .dot.pool2.solid {
    background: radial-gradient(circle at 50% 50%, #f7f5ee 0 22%, #f7c614 24%);
  }

  .dot.pool2.stripe {
    background:
      radial-gradient(circle at 50% 50%, #f7f5ee 0 22%, transparent 24%),
      linear-gradient(#f6f3ea 0 22%, #f7c614 22% 78%, #f6f3ea 78%);
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

  .person:disabled {
    cursor: default;
    opacity: 0.6;
  }

  .person:disabled:hover {
    border-color: var(--border);
    background: var(--bg-surface);
  }

  .person-state {
    font-weight: 400;
    color: var(--text-muted);
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

  .person:not(:disabled):hover .avatar {
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

  .art.pool2 {
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
