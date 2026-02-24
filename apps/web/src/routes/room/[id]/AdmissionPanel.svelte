<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { AdmissionRequest } from '$lib/webrtc/mesh';

  export let requests: AdmissionRequest[];

  const dispatch = createEventDispatcher<{ admit: string; deny: string }>();
</script>

<div class="admission-panel">
  <div class="admission-header">Waiting to join</div>
  {#each requests as req (req.peerId)}
    <div class="admission-item">
      <span class="req-name">{req.displayName}</span>
      <div class="req-actions">
        <button class="btn approve" on:click={() => dispatch('admit', req.peerId)}>Approve</button>
        <button class="btn deny" on:click={() => dispatch('deny', req.peerId)}>Deny</button>
      </div>
    </div>
  {/each}
</div>

<style>
  .admission-panel {
    position: fixed;
    top: 60px;
    right: 16px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    z-index: 50;
    min-width: 260px;
    max-width: 320px;
    overflow: hidden;
  }

  .admission-header {
    padding: 0.6rem 1rem;
    font-weight: 600;
    font-size: 0.85rem;
    border-bottom: 1px solid var(--border);
    color: var(--text-muted);
  }

  .admission-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.6rem 1rem;
    gap: 0.5rem;
    border-bottom: 1px solid var(--border);
  }

  .admission-item:last-child {
    border-bottom: none;
  }

  .req-name {
    font-size: 0.9rem;
    font-weight: 500;
  }

  .req-actions {
    display: flex;
    gap: 0.4rem;
  }

  .btn {
    padding: 0.3rem 0.7rem;
    border-radius: 4px;
    font-size: 0.8rem;
    font-weight: 500;
  }

  .btn.approve {
    background: var(--success);
    color: white;
  }

  .btn.approve:hover {
    background: #16a34a;
  }

  .btn.deny {
    background: var(--danger);
    color: white;
  }

  .btn.deny:hover {
    background: #dc2626;
  }
</style>
