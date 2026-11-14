<script lang="ts">
  // "Bob invited you to play Chess" with Accept / Decline. Names are the ones this app shows for
  // each person (from the connection), rendered as plain text.
  import { fly } from 'svelte/transition';
  import Icon from '$lib/ui/Icon.svelte';
  import { acceptInvite, declineInvite, incomingInvites } from '$lib/games/games';
  import { GAME_NAMES } from '$lib/games/session-model';
</script>

<div class="game-invites" aria-live="polite">
  {#each $incomingInvites as invite (invite.id)}
    <div class="invite" role="dialog" aria-label="Game invitation from {invite.name}" transition:fly={{ y: 12, duration: 180 }}>
      <span class="icon" aria-hidden="true"><Icon name="gamepad" size={18} /></span>
      <p class="text">
        <span class="who">{invite.name}</span>
        <span>invited you to play <strong>{GAME_NAMES[invite.kind]}</strong></span>
      </p>
      <div class="buttons">
        <button class="decline" on:click={() => declineInvite(invite.id)}>Decline</button>
        <button class="accept" on:click={() => acceptInvite(invite.id)}>Accept</button>
      </div>
    </div>
  {/each}
</div>

<style>
  .game-invites {
    position: absolute;
    right: var(--space-4);
    bottom: calc(var(--space-4) + 84px);
    z-index: 46;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--space-2);
    max-width: calc(100% - 2 * var(--space-4));
    pointer-events: none;
  }

  .invite {
    pointer-events: auto;
    width: 300px;
    max-width: 100%;
    display: grid;
    grid-template-columns: auto 1fr;
    gap: var(--space-2) var(--space-3);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-lg);
    border: 1px solid var(--border-strong);
    background: var(--bg-overlay);
    box-shadow: var(--shadow-lg);
  }

  .icon {
    width: 34px;
    height: 34px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--accent-soft);
    color: var(--accent);
  }

  .text {
    margin: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    font-size: var(--text-sm);
    color: var(--text-muted);
  }

  .who {
    font-weight: 600;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .text strong {
    color: var(--text);
  }

  .buttons {
    grid-column: 1 / -1;
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
  }

  .buttons button {
    height: 32px;
    padding: 0 var(--space-4);
    border-radius: var(--radius-pill);
    font: inherit;
    font-size: var(--text-sm);
    font-weight: 600;
    cursor: pointer;
  }

  .decline {
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text);
  }

  .decline:hover {
    background: var(--bg-hover);
  }

  .accept {
    border: 0;
    background: var(--accent);
    color: var(--accent-text);
  }

  .accept:hover {
    background: var(--accent-hover);
  }

  .buttons button:focus-visible {
    outline: 2px solid var(--accent-ring);
    outline-offset: 2px;
  }

  @media (max-width: 600px) {
    .game-invites {
      left: var(--space-3);
      right: var(--space-3);
      align-items: stretch;
    }

    .invite {
      width: auto;
    }
  }
</style>
