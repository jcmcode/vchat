<script lang="ts">
  import { REACTION_EMOJI } from '$lib/webrtc/mesh';
  import { createEventDispatcher } from 'svelte';

  const dispatch = createEventDispatcher<{ react: string }>();

  // Same set the receiving side accepts (anything else is dropped).
  const emojis = REACTION_EMOJI;
  const names = ['Thumbs up', 'Heart', 'Laughing', 'Clapping', 'Fire', 'Hundred'];
</script>

<div class="reaction-picker card fade-in" role="group" aria-label="Send a reaction">
  {#each emojis as emoji, i}
    <button class="emoji-btn" on:click={() => dispatch('react', emoji)} aria-label={names[i]} title={names[i]}>{emoji}</button>
  {/each}
</div>

<style>
  .reaction-picker {
    position: absolute;
    bottom: 92px;
    left: 0;
    right: 0;
    margin-inline: auto;
    z-index: 50;
    width: max-content;
    max-width: calc(100% - 24px);
    padding: var(--space-2);
    display: flex;
    gap: var(--space-1);
    background: var(--bg-overlay);
    border-radius: var(--radius-pill);
    box-shadow: var(--shadow-lg);
  }

  .emoji-btn {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    background: transparent;
    font-size: 1.5rem;
    line-height: 1;
    transition: background var(--dur-fast) var(--ease), transform var(--dur-fast) var(--ease);
  }

  .emoji-btn:hover {
    background: var(--bg-hover);
    transform: scale(1.12);
  }

  .emoji-btn:focus-visible {
    outline: 2px solid var(--accent-ring);
    outline-offset: 1px;
    border-radius: 50%;
  }

  @media (max-width: 640px) {
    .reaction-picker {
      bottom: 68px;
    }

    .emoji-btn {
      width: 40px;
      height: 40px;
    }
  }
</style>
