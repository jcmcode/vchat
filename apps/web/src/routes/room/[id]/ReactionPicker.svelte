<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  const dispatch = createEventDispatcher<{ react: string }>();

  const emojis = ['\u{1F44D}', '\u{2764}\u{FE0F}', '\u{1F602}', '\u{1F44F}', '\u{1F525}', '\u{1F4AF}'];
</script>

<div class="reaction-picker">
  {#each emojis as emoji}
    <button class="emoji-btn" on:click={() => dispatch('react', emoji)}>{emoji}</button>
  {/each}
</div>

<style>
  .reaction-picker {
    position: fixed;
    bottom: 70px;
    left: 50%;
    transform: translateX(-50%);
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.5rem;
    display: flex;
    gap: 0.25rem;
    z-index: 50;
  }

  .emoji-btn {
    font-size: 1.5rem;
    padding: 0.4rem;
    border-radius: 6px;
    background: none;
    transition: background 0.15s;
    line-height: 1;
  }

  .emoji-btn:hover {
    background: var(--bg-elevated);
  }
</style>
