<script lang="ts">
  /**
   * A quiet one-line hint about poor connections (trusted links only; see connectionHint). It sits
   * in the page flow with the other notices, so it never covers the stage or its toolbars.
   */
  import { peers } from '$lib/webrtc/mesh';
  import { connQuality } from '$lib/webrtc/conn-stats';
  import { connectionHint, type QualityLevel } from '$lib/webrtc/conn-quality';
  import SignalBars from '$lib/ui/SignalBars.svelte';

  $: hint = connectionHint(Array.from($connQuality, ([id, q]): [string, QualityLevel] => [id, q.level]));
  $: peerName = hint?.kind === 'peer' ? $peers.get(hint.peerId)?.displayName ?? null : null;
</script>

<div class="conn-hint-live" role="status">
  {#if hint?.kind === 'local'}
    <p class="conn-hint">
      <SignalBars level="poor" />
      Your connection is poor. Video may freeze or drop.
    </p>
  {:else if peerName !== null}
    <p class="conn-hint">
      <SignalBars level="poor" />
      <span class="text">Connection to <span class="name">{peerName}</span> is poor.</span>
    </p>
  {/if}
</div>

<style>
  .conn-hint-live {
    flex-shrink: 0;
  }

  .conn-hint {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    padding: 3px var(--space-4);
    font-size: var(--text-xs);
    color: var(--text-muted);
    border-bottom: 1px solid var(--border-subtle);
    flex-shrink: 0;
  }

  .text {
    display: inline-flex;
    gap: 0.25em;
    min-width: 0;
  }

  .name {
    max-width: 16em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
  }
</style>
