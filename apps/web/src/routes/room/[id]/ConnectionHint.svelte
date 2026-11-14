<script lang="ts">
  /** A quiet hint when most of your connections are poor (likely your own network). */
  import { connQuality } from '$lib/webrtc/conn-stats';
  import { isLocalConnectionPoor } from '$lib/webrtc/conn-quality';
  import SignalBars from '$lib/ui/SignalBars.svelte';

  $: poor = isLocalConnectionPoor(Array.from($connQuality.values(), (q) => q.level));
</script>

<div class="conn-hint-live" role="status">
  {#if poor}
    <span class="conn-hint">
      <SignalBars level="poor" />
      Your connection is poor. Video may freeze or drop.
    </span>
  {/if}
</div>

<style>
  .conn-hint-live {
    position: absolute;
    top: var(--space-3);
    left: 50%;
    transform: translateX(-50%);
    z-index: 20;
    max-width: calc(100% - 2 * var(--space-4));
    pointer-events: none;
  }

  .conn-hint {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: 4px 12px;
    border-radius: var(--radius-pill);
    background: rgba(11, 13, 18, 0.72);
    -webkit-backdrop-filter: blur(6px);
    backdrop-filter: blur(6px);
    color: #fff;
    font-size: var(--text-xs);
    font-weight: 500;
    text-align: center;
  }
</style>
