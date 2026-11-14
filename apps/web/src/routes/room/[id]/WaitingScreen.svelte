<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import Icon from '$lib/ui/Icon.svelte';

  export let hostPresent = true;

  const dispatch = createEventDispatcher<{ cancel: void }>();
</script>

<div class="waiting-overlay">
  <div class="waiting-card card fade-in" role="dialog" aria-modal="true" aria-labelledby="waiting-title" aria-describedby="waiting-desc">
    <div class="spinner" aria-hidden="true"></div>
    {#if hostPresent}
      <h2 id="waiting-title">Waiting for host...</h2>
      <p id="waiting-desc">The host will let you in shortly.</p>
    {:else}
      <h2 id="waiting-title">The host hasn't joined yet</h2>
      <p id="waiting-desc">You'll be let in once they arrive. Keep this page open.</p>
    {/if}
    <span class="chip"><Icon name="lock" size={12} /> End-to-end encrypted</span>
    <button class="btn cancel" on:click={() => dispatch('cancel')}>Cancel</button>
  </div>
</div>

<style>
  .waiting-overlay {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-4);
    background: rgba(8, 10, 15, 0.72);
    -webkit-backdrop-filter: blur(6px);
    backdrop-filter: blur(6px);
  }

  .waiting-card {
    width: min(100%, 360px);
    padding: var(--space-8) var(--space-6) var(--space-6);
    text-align: center;
    box-shadow: var(--shadow-lg);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-3);
  }

  .spinner {
    width: 40px;
    height: 40px;
    border: 3px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin-bottom: var(--space-2);
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  h2 {
    font-size: var(--text-xl);
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  p {
    color: var(--text-muted);
    font-size: var(--text-base);
    margin-top: calc(var(--space-2) * -1);
  }

  .btn.cancel {
    margin-top: var(--space-2);
  }
</style>
