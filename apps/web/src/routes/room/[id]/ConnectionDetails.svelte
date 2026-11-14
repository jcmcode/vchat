<script lang="ts">
  /** Connection details for the person card. Measured on this device only (see conn-stats.ts). */
  import { connQuality } from '$lib/webrtc/conn-stats';
  import { formatKbps, formatMs, formatPct, qualityLabel } from '$lib/webrtc/conn-quality';
  import SignalBars from '$lib/ui/SignalBars.svelte';

  export let peerId: string;

  $: q = $connQuality.get(peerId);
  $: level = q?.level ?? 'unknown';
  $: video = q?.recvVideo;
</script>

<section class="conn" aria-label="Connection">
  <div class="conn-head">
    <span class="conn-title">Connection</span>
    <span class="conn-level {level}">
      <SignalBars {level} label="Connection quality: {qualityLabel(level).toLowerCase()}" />
      <span aria-hidden="true">{qualityLabel(level)}</span>
    </span>
  </div>
  {#if q}
    <dl>
      <dt>Round trip</dt>
      <dd>{formatMs(q.rttMs)}</dd>
      <dt>Packet loss</dt>
      <dd>
        {#if q.lossInPct === null && q.lossOutPct === null}—{:else}{formatPct(q.lossInPct)} in · {formatPct(q.lossOutPct)} out{/if}
      </dd>
      {#if q.jitterMs !== null}
        <dt>Jitter</dt>
        <dd>{formatMs(q.jitterMs)}</dd>
      {/if}
      <dt>Route</dt>
      <dd>{q.relayed === null ? '—' : q.relayed ? 'Relayed (TURN server)' : 'Direct'}</dd>
      {#if video}
        <dt>Receiving</dt>
        <dd>{video.width}×{video.height}{video.fps !== null ? ` · ${Math.round(video.fps)} fps` : ''}</dd>
      {/if}
      {#if q.outgoingKbps !== null}
        <dt>Upload estimate</dt>
        <dd>{formatKbps(q.outgoingKbps)}</dd>
      {/if}
    </dl>
  {/if}
</section>

<style>
  .conn {
    border: 1px solid var(--border);
    border-radius: var(--radius, 10px);
    padding: var(--space-3, 0.75rem);
    display: grid;
    gap: var(--space-2, 0.5rem);
  }

  .conn-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2, 0.5rem);
  }

  .conn-title {
    color: var(--text-muted);
    font-size: var(--text-sm, 0.85rem);
  }

  .conn-level {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-size: var(--text-sm, 0.85rem);
    font-weight: 600;
    color: var(--text-muted);
  }

  .conn-level.good {
    color: var(--success);
  }

  .conn-level.fair {
    color: var(--warning);
  }

  .conn-level.poor {
    color: var(--danger);
  }

  dl {
    margin: 0;
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.2rem var(--space-3, 0.75rem);
    font-size: var(--text-xs, 0.75rem);
  }

  dt {
    color: var(--text-muted);
  }

  dd {
    margin: 0;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
</style>
