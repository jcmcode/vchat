<script lang="ts">
  /** Connection-quality bars in the corner of a remote tile (measured locally; see conn-stats.ts). */
  import { connQuality } from '$lib/webrtc/conn-stats';
  import { formatMs, formatPct, qualityLabel } from '$lib/webrtc/conn-quality';
  import SignalBars from '$lib/ui/SignalBars.svelte';

  export let peerId: string;
  /** Lets the tile point at this as its accessible description. */
  export let id: string | undefined = undefined;

  $: q = $connQuality.get(peerId);
  $: loss = q ? Math.max(q.lossInPct ?? -1, q.lossOutPct ?? -1) : -1;
  $: label = q
    ? `Connection ${qualityLabel(q.level).toLowerCase()}` +
      (q.rttMs !== null ? `, ${formatMs(q.rttMs)} round trip` : '') +
      (loss >= 0 ? `, ${formatPct(loss)} packet loss` : '') +
      (q.relayed ? ', relayed' : '')
    : '';
</script>

{#if q && q.level !== 'unknown'}
  <span class="tile-quality">
    <SignalBars level={q.level} {label} {id} />
  </span>
{/if}

<style>
  .tile-quality {
    position: absolute;
    top: var(--space-2);
    right: var(--space-2);
    display: inline-flex;
    align-items: center;
    padding: 4px 6px;
    border-radius: var(--radius-pill);
    background: rgba(11, 13, 18, 0.62);
    -webkit-backdrop-filter: blur(6px);
    backdrop-filter: blur(6px);
    /* Purely informational: never in the way of tapping the tile or drawing on a shared screen. */
    pointer-events: none;
  }
</style>
