<script lang="ts">
  // Brief "… raised their hand" notices. Names are the ones this app shows for each person
  // (authenticated, from hands.ts), rendered as plain text.
  import { handToasts } from '$lib/collab/hands';
  import Icon from '$lib/ui/Icon.svelte';
</script>

<div class="hand-toasts" role="status" aria-live="polite">
  {#each $handToasts as toast (toast.id)}
    <div class="hand-toast fade-in">
      <Icon name="hand" size={15} />
      <span class="who">{toast.name}</span>
      <span class="what">raised their hand</span>
    </div>
  {/each}
</div>

<style>
  .hand-toasts {
    position: absolute;
    top: var(--space-3);
    left: 0;
    right: 0;
    z-index: 45;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    pointer-events: none;
  }

  .hand-toast {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: min(360px, calc(100% - 24px));
    padding: 6px 12px;
    border-radius: var(--radius-pill);
    background: rgba(11, 13, 18, 0.78);
    -webkit-backdrop-filter: blur(6px);
    backdrop-filter: blur(6px);
    color: #fff;
    font-size: var(--text-sm);
    box-shadow: var(--shadow-md);
  }

  .hand-toast :global(svg) {
    color: var(--warning);
  }

  .who {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
  }

  .what {
    flex-shrink: 0;
  }
</style>
