<script lang="ts">
  import { legalMoves, sideOf, squareName, type ChessMove, type ChessState, type Promotion } from '$lib/games/chess';
  import { playMove } from '$lib/games/games';

  export let state: ChessState;
  /** Your seat (0 White, 1 Black), or -1 when watching. */
  export let seat: number;
  export let canMove: boolean;

  // Solid glyphs for both sides (coloured in CSS); U+FE0E keeps them from turning into emoji.
  const GLYPH: Record<string, string> = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
  const NAME: Record<string, string> = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };
  const PROMOTIONS: Promotion[] = ['q', 'r', 'b', 'n'];
  const glyph = (piece: string) => `${GLYPH[piece.toLowerCase()]}︎`;

  let selected = -1;
  let targets: ChessMove[] = [];
  /** The pawn move waiting for a choice of piece. */
  let promoting: { from: number; to: number } | null = null;

  // Black sees the board from Black's side.
  $: flipped = seat === 1;
  $: squares = Array.from({ length: 64 }, (_, i) => {
    const row = i >> 3;
    const col = i & 7;
    return flipped ? row * 8 + (7 - col) : (7 - row) * 8 + col;
  });
  $: targetSet = new Set(targets.map((m) => m.to));
  $: checkedKing = state.check ? state.board.indexOf(state.turn === 0 ? 'K' : 'k') : -1;
  // Any change to the game drops a half-made move.
  $: state, clearSelection();
  $: takenByWhite = state.captured.filter((p) => sideOf(p) === 1);
  $: takenByBlack = state.captured.filter((p) => sideOf(p) === 0);

  function clearSelection() {
    selected = -1;
    targets = [];
    promoting = null;
  }

  function press(sq: number) {
    if (!canMove) return;
    promoting = null;
    if (selected >= 0 && targetSet.has(sq)) {
      const options = targets.filter((m) => m.to === sq);
      if (options.some((m) => m.promo)) promoting = { from: selected, to: sq };
      else playMove({ from: selected, to: sq });
      return;
    }
    const piece = state.board[sq];
    if (piece && sideOf(piece) === seat && sq !== selected) {
      selected = sq;
      targets = legalMoves(state, sq);
    } else {
      clearSelection();
    }
  }

  function promote(promo: Promotion) {
    if (promoting) playMove({ ...promoting, promo });
  }

  function describe(sq: number): string {
    const piece = state.board[sq];
    const what = piece ? `${sideOf(piece) === 0 ? 'white' : 'black'} ${NAME[piece.toLowerCase()]}` : 'empty';
    return `${squareName(sq)}, ${what}${targetSet.has(sq) ? ', can move here' : ''}`;
  }
</script>

<div class="chess">
  <div class="taken" aria-label="Pieces taken by {flipped ? 'White' : 'Black'}">
    {#each flipped ? takenByWhite : takenByBlack as piece}
      <span class="piece small" class:white={sideOf(piece) === 0}>{glyph(piece)}</span>
    {/each}
  </div>

  <div class="fit">
    <div class="board" class:playable={canMove} role="group" aria-label="Chess board">
      {#each squares as sq, i (sq)}
        {@const piece = state.board[sq]}
        <button
          class="square"
          class:dark={((sq >> 3) + (sq & 7)) % 2 === 0}
          class:selected={sq === selected}
          class:last={state.last?.from === sq || state.last?.to === sq}
          class:check={sq === checkedKing}
          class:own={canMove && !!piece && sideOf(piece) === seat}
          aria-label={describe(sq)}
          aria-pressed={sq === selected}
          on:click={() => press(sq)}
        >
          {#if i % 8 === 0}<span class="coord rank">{(sq >> 3) + 1}</span>{/if}
          {#if i >= 56}<span class="coord file">{'abcdefgh'[sq & 7]}</span>{/if}
          {#if piece}
            <span class="piece" class:white={sideOf(piece) === 0}>{glyph(piece)}</span>
          {/if}
          {#if targetSet.has(sq)}
            <span class="target" class:capture={!!piece || sq === state.ep}></span>
          {/if}
        </button>
      {/each}

      {#if promoting}
        <div class="promotion" role="dialog" aria-label="Choose a piece for your pawn">
          <span class="promotion-title">Promote to</span>
          <div class="promotion-row">
            {#each PROMOTIONS as promo}
              <button class="promotion-btn" on:click={() => promote(promo)} aria-label={NAME[promo]}>
                <span class="piece" class:white={seat === 0}>{glyph(promo)}</span>
              </button>
            {/each}
          </div>
          <button class="promotion-cancel" on:click={clearSelection}>Cancel</button>
        </div>
      {/if}
    </div>
  </div>

  <div class="taken" aria-label="Pieces taken by {flipped ? 'Black' : 'White'}">
    {#each flipped ? takenByBlack : takenByWhite as piece}
      <span class="piece small" class:white={sideOf(piece) === 0}>{glyph(piece)}</span>
    {/each}
  </div>
</div>

<style>
  .chess {
    flex: 1;
    min-height: 0;
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-1);
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

  .board {
    position: relative;
    width: min(100cqw, 100cqh, 760px);
    aspect-ratio: 1;
    display: grid;
    grid-template-columns: repeat(8, 1fr);
    grid-template-rows: repeat(8, 1fr);
    border-radius: var(--radius);
    overflow: hidden;
    box-shadow: var(--shadow-md);
    container-type: inline-size;
  }

  .square {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 0;
    background: #e6ebf5;
    color: inherit;
    cursor: default;
    min-width: 0;
    min-height: 0;
  }

  .square.dark {
    background: #7389b8;
  }

  .square.last {
    background: #f1dd7c;
  }

  .square.dark.last {
    background: #cdb650;
  }

  .square.selected,
  .square.dark.selected {
    background: #8fd48a;
  }

  .square.check {
    background: radial-gradient(circle, #ff6b6b 25%, #d93636 85%);
  }

  .square.own {
    cursor: pointer;
  }

  .square:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: -3px;
    z-index: 1;
  }

  .piece {
    font-size: 9.6cqw;
    line-height: 1;
    font-family: 'Segoe UI Symbol', 'Apple Symbols', 'Noto Sans Symbols2', 'DejaVu Sans', sans-serif;
    color: #20232d;
    text-shadow: 0 0 2px rgba(255, 255, 255, 0.55);
    user-select: none;
    pointer-events: none;
  }

  .piece.white {
    color: #ffffff;
    text-shadow:
      1px 0 0 #20232d,
      -1px 0 0 #20232d,
      0 1px 0 #20232d,
      0 -1px 0 #20232d,
      0 2px 3px rgba(0, 0, 0, 0.35);
  }

  .piece.small {
    font-size: 1.15rem;
  }

  .taken {
    height: 1.5rem;
    width: min(100%, 760px);
    display: flex;
    align-items: center;
    gap: 1px;
    padding: 0 var(--space-1);
    overflow: hidden;
    flex-shrink: 0;
  }

  .target {
    position: absolute;
    width: 30%;
    height: 30%;
    border-radius: 50%;
    background: rgba(20, 30, 50, 0.32);
    pointer-events: none;
  }

  .target.capture {
    width: 88%;
    height: 88%;
    background: transparent;
    border: 0.7cqw solid rgba(20, 30, 50, 0.38);
  }

  .playable .square:has(.target) {
    cursor: pointer;
  }

  .coord {
    position: absolute;
    font-size: max(9px, 1.9cqw);
    font-weight: 700;
    line-height: 1;
    color: #5d70a0;
    pointer-events: none;
  }

  .square.dark .coord {
    color: #e6ebf5;
  }

  .coord.rank {
    top: 4%;
    left: 5%;
  }

  .coord.file {
    bottom: 4%;
    right: 6%;
  }

  .promotion {
    position: absolute;
    inset: 0;
    z-index: 2;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    background: rgba(10, 12, 18, 0.72);
    color: #fff;
  }

  .promotion-title {
    font-weight: 600;
  }

  .promotion-row {
    display: flex;
    gap: var(--space-2);
  }

  .promotion-btn {
    width: 16cqw;
    height: 16cqw;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius);
    border: 1px solid rgba(255, 255, 255, 0.25);
    background: #7389b8;
    cursor: pointer;
  }

  .promotion-btn:hover,
  .promotion-btn:focus-visible {
    background: #8fd48a;
    outline: none;
  }

  .promotion-cancel {
    border: 0;
    background: transparent;
    color: #fff;
    font: inherit;
    text-decoration: underline;
    cursor: pointer;
  }
</style>
