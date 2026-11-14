<script lang="ts">
  /** Three signal bars for a connection-quality level (good = 3, fair = 2, poor = 1). */
  import type { QualityLevel } from '$lib/webrtc/conn-quality';

  export let level: QualityLevel;
  /** Accessible label, e.g. "Connection good". Empty: decorative (the text next to it says it). */
  export let label = '';
  export let id: string | undefined = undefined;

  $: filled = level === 'good' ? 3 : level === 'fair' ? 2 : level === 'poor' ? 1 : 0;
</script>

<span class="bars {level}" {id} role={label ? 'img' : undefined} aria-label={label || undefined} aria-hidden={label ? undefined : 'true'}>
  <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true" focusable="false">
    <rect x="0" y="7" width="3" height="5" rx="1" class:on={filled >= 1} />
    <rect x="5.5" y="3.5" width="3" height="8.5" rx="1" class:on={filled >= 2} />
    <rect x="11" y="0" width="3" height="12" rx="1" class:on={filled >= 3} />
  </svg>
</span>

<style>
  .bars {
    display: inline-flex;
    flex-shrink: 0;
  }

  rect {
    fill: currentColor;
    opacity: 0.3;
  }

  rect.on {
    opacity: 1;
  }

  .good {
    color: var(--success);
  }

  .fair {
    color: var(--warning);
  }

  .poor {
    color: var(--danger);
  }
</style>
