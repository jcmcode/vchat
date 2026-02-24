<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  const dispatch = createEventDispatcher<{ cancel: void }>();
</script>

<div class="waiting-overlay">
  <div class="waiting-card">
    <div class="spinner"></div>
    <h2>Waiting for host...</h2>
    <p>The host will let you in shortly.</p>
    <button class="btn cancel" on:click={() => dispatch('cancel')}>Cancel</button>
  </div>
</div>

<style>
  .waiting-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.85);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }

  .waiting-card {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 2.5rem;
    text-align: center;
    max-width: 360px;
    width: 90%;
  }

  .spinner {
    width: 48px;
    height: 48px;
    border: 4px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin: 0 auto 1.5rem;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  h2 {
    margin-bottom: 0.5rem;
    font-size: 1.3rem;
  }

  p {
    color: var(--text-muted);
    margin-bottom: 1.5rem;
    font-size: 0.9rem;
  }

  .btn.cancel {
    background: var(--bg-elevated);
    color: var(--text);
    padding: 0.6rem 1.5rem;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    font-size: 0.9rem;
  }

  .btn.cancel:hover {
    background: var(--border);
  }
</style>
