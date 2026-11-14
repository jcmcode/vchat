<script lang="ts">
  import { COLS, ROWS, landingRow, type Connect4State } from '$lib/games/connect4';
  import { playMove } from '$lib/games/games';

  export let state: Connect4State;
  /** Your seat (0 red, 1 yellow), or -1 when watching. */
  export let seat: number;
  export let canMove: boolean;

  let hoverCol = -1;

  const columns = Array.from({ length: COLS }, (_, i) => i);
  // Drawn top row first.
  const rows = Array.from({ length: ROWS }, (_, i) => ROWS - 1 - i);

  $: winning = new Set(state.line ?? []);
  $: ghostRow = canMove && hoverCol >= 0 ? landingRow(state.cells, hoverCol) : -1;

  function drop(col: number) {
    if (canMove) playMove({ col });
  }

  function label(col: number): string {
    const full = landingRow(state.cells, col) < 0;
    return `Column ${col + 1}${full ? ', full' : ''}`;
  }
</script>

<div class="fit">
  <div class="board" class:playable={canMove} role="group" aria-label="Connect 4 board">
    {#each columns as col}
      <button
        class="column"
        disabled={!canMove || landingRow(state.cells, col) < 0}
        aria-label={label(col)}
        on:click={() => drop(col)}
        on:pointerenter={() => (hoverCol = col)}
        on:pointerleave={() => (hoverCol = -1)}
        on:focus={() => (hoverCol = col)}
        on:blur={() => (hoverCol = -1)}
      >
        {#each rows as row}
          {@const cell = row * COLS + col}
          {@const who = state.cells[cell]}
          <span class="hole">
            {#if who}
              <span
                class="disc p{who}"
                class:dropped={state.last === cell}
                class:win={winning.has(cell)}
                style="--fall: {ROWS - row}"
              ></span>
            {:else if ghostRow === row && hoverCol === col}
              <span class="disc ghost p{seat + 1}"></span>
            {/if}
          </span>
        {/each}
      </button>
    {/each}
  </div>
</div>

<style>
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
    width: min(100cqw, 100cqh * 7 / 6, 720px);
    aspect-ratio: 7 / 6;
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    padding: 1.5%;
    background: #2f55d4;
    border-radius: 4%/4.6%;
    box-shadow: inset 0 -6px 0 rgba(0, 0, 0, 0.18), var(--shadow-md);
  }

  .column {
    display: grid;
    grid-template-rows: repeat(6, 1fr);
    padding: 0;
    border: 0;
    background: transparent;
    border-radius: 12px;
    cursor: default;
    overflow: hidden;
  }

  .playable .column:not(:disabled) {
    cursor: pointer;
  }

  .playable .column:not(:disabled):hover,
  .column:focus-visible {
    background: rgba(255, 255, 255, 0.1);
  }

  .column:focus-visible {
    outline: 2px solid #fff;
    outline-offset: -2px;
  }

  .hole {
    position: relative;
    margin: 9%;
    border-radius: 50%;
    background: #16204a;
    box-shadow: inset 0 3px 5px rgba(0, 0, 0, 0.45);
  }

  .disc {
    position: absolute;
    inset: 0;
    border-radius: 50%;
  }

  .disc.p1 {
    background: radial-gradient(circle at 35% 30%, #ff8a8a, #e23b3b 60%, #b92525);
  }

  .disc.p2 {
    background: radial-gradient(circle at 35% 30%, #fff0a3, #f6c927 60%, #d19e0a);
  }

  .disc.ghost {
    opacity: 0.35;
  }

  .disc.dropped {
    animation: fall calc(90ms * var(--fall) + 120ms) cubic-bezier(0.5, 0, 0.9, 0.6);
  }

  .disc.win {
    box-shadow: 0 0 0 4px #fff, 0 0 14px 4px rgba(255, 255, 255, 0.7);
    z-index: 1;
  }

  @keyframes fall {
    from {
      transform: translateY(calc(-128% * var(--fall)));
    }
    to {
      transform: translateY(0);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .disc.dropped {
      animation: none;
    }
  }
</style>
