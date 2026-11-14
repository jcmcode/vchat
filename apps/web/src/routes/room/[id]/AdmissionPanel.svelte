<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { AdmissionRequest } from '$lib/webrtc/mesh';
  import Icon from '$lib/ui/Icon.svelte';

  export let requests: AdmissionRequest[];

  const dispatch = createEventDispatcher<{ admit: string; deny: string }>();
</script>

<div class="admission-panel card fade-in" role="region" aria-label="Join requests">
  <div class="admission-header"><Icon name="users" size={15} /> Waiting to join</div>
  {#each requests as req (req.peerId)}
    <div class="admission-item">
      <span class="req-avatar" aria-hidden="true">{req.displayName.charAt(0).toUpperCase()}</span>
      <span class="req-name">
        {req.displayName}
        {#if req.email}<small class="req-email" title="The address their personal invite was sent to">{req.email}</small>{/if}
      </span>
      <div class="req-actions">
        <button class="btn small primary" on:click={() => dispatch('admit', req.peerId)} aria-label="Approve {req.displayName}">Approve</button>
        <button class="btn small danger" on:click={() => dispatch('deny', req.peerId)} aria-label="Deny {req.displayName}">Deny</button>
      </div>
    </div>
  {/each}
</div>

<style>
  .admission-panel {
    position: absolute;
    top: var(--space-3);
    right: var(--space-3);
    z-index: 50;
    width: min(340px, calc(100% - 24px));
    max-height: calc(100% - 24px);
    overflow-y: auto;
    background: var(--bg-overlay);
    box-shadow: var(--shadow-lg);
  }

  .admission-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    font-weight: 600;
    font-size: var(--text-sm);
    color: var(--text-muted);
    border-bottom: 1px solid var(--border-subtle);
  }

  .admission-item {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border-subtle);
  }

  .admission-item:last-child {
    border-bottom: none;
  }

  .req-avatar {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    flex-shrink: 0;
    border-radius: 50%;
    background: var(--accent-soft);
    color: var(--accent);
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .req-email {
    display: block;
    font-size: var(--text-xs, 0.75rem);
    font-weight: 400;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .req-name {
    flex: 1;
    min-width: 0;
    font-size: var(--text-base);
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .req-actions {
    display: flex;
    gap: var(--space-1);
    flex-shrink: 0;
  }

  .req-actions .btn {
    min-height: 40px;
  }

  @media (max-width: 400px) {
    .admission-item {
      flex-wrap: wrap;
    }

    .req-actions {
      width: 100%;
      justify-content: flex-end;
    }
  }
</style>
