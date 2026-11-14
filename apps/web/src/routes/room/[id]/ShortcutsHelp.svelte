<script lang="ts">
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import { isMacPlatform, shortcutList } from '$lib/ui/shortcuts';
  import Icon from '$lib/ui/Icon.svelte';

  const dispatch = createEventDispatcher<{ close: void }>();
  const isMac = typeof navigator !== 'undefined' && isMacPlatform(navigator as Navigator & { userAgentData?: { platform?: string } });
  const entries = shortcutList(isMac);

  let closeBtn: HTMLButtonElement;
  let previousFocus: Element | null = null;

  onMount(() => {
    previousFocus = document.activeElement;
    closeBtn?.focus();
  });
  onDestroy(() => {
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
  });

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      dispatch('close');
    }
  }
</script>

<svelte:window on:keydown={onKeydown} />

<!-- svelte-ignore a11y-click-events-have-key-events -->
<!-- svelte-ignore a11y-no-static-element-interactions -->
<div class="shortcuts-backdrop" on:click|self={() => dispatch('close')}>
  <div class="shortcuts-sheet card fade-in" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title">
    <div class="sheet-head">
      <Icon name="keyboard" size={18} />
      <h2 id="shortcuts-title">Keyboard shortcuts</h2>
      <button class="btn ghost small icon" bind:this={closeBtn} on:click={() => dispatch('close')} aria-label="Close">
        <Icon name="x" size={16} />
      </button>
    </div>
    <dl>
      {#each entries as entry}
        <div class="row">
          <dt>
            {#each entry.keys as k, i}{#if i > 0}<span class="plus" aria-hidden="true">+</span>{/if}<kbd>{k}</kbd>{/each}
          </dt>
          <dd>{entry.label}</dd>
        </div>
      {/each}
    </dl>
    <p class="note">They don't work while you're typing in a text field. With the whiteboard open, its own keys (P, M, T, E, H, Space…) work as usual.</p>
  </div>
</div>

<style>
  .shortcuts-backdrop {
    position: fixed;
    inset: 0;
    z-index: 70;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-4);
    background: rgba(0, 0, 0, 0.45);
  }

  .shortcuts-sheet {
    width: 100%;
    max-width: 420px;
    max-height: calc(100dvh - 32px);
    overflow-y: auto;
    padding: var(--space-5);
    background: var(--bg-surface);
    box-shadow: var(--shadow-lg);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .sheet-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .sheet-head h2 {
    flex: 1;
    margin: 0;
    font-size: var(--text-lg);
    font-weight: 600;
  }

  dl {
    margin: 0;
    display: grid;
    gap: var(--space-2);
  }

  .row {
    display: grid;
    grid-template-columns: minmax(120px, auto) 1fr;
    align-items: center;
    gap: var(--space-3);
  }

  dt {
    display: flex;
    align-items: center;
    gap: 3px;
    white-space: nowrap;
  }

  dd {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-muted);
  }

  kbd {
    display: inline-block;
    min-width: 1.6em;
    padding: 1px 6px;
    border: 1px solid var(--border-strong);
    border-bottom-width: 2px;
    border-radius: var(--radius-sm);
    background: var(--bg-elevated);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    text-align: center;
    color: var(--text);
  }

  .plus {
    font-size: var(--text-xs);
    color: var(--text-subtle);
  }

  .note {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
</style>
