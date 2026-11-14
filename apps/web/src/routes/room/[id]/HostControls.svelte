<script lang="ts">
  // The host's menu: lock/unlock the call, opt in to "someone's waiting" notifications, and end the
  // call for everyone (with a confirm step). The server enforces who may do this; this is only UI.
  import { setRoomLocked, endCallForEveryone } from '$lib/webrtc/mesh';
  import {
    waitingAlertsEnabled,
    enableWaitingAlerts,
    disableWaitingAlerts,
    notificationsSupported,
    unlockAudio,
  } from '$lib/ui/attention';
  import Icon from '$lib/ui/Icon.svelte';

  /** As reported by the server. */
  export let locked = false;
  /** Signaling is connected (commands can't be sent otherwise). */
  export let connected = true;

  let open = false;
  let confirmEnd = false;
  let alertNote = '';
  let root: HTMLDivElement;
  let trigger: HTMLButtonElement;
  const supported = notificationsSupported();

  function toggleMenu() {
    open = !open;
    confirmEnd = false;
    alertNote = '';
    if (open) unlockAudio(); // a user gesture: lets the "someone's waiting" chime play later
  }

  function close() {
    open = false;
    confirmEnd = false;
  }

  function toggleLock() {
    setRoomLocked(!locked);
  }

  async function toggleAlerts() {
    alertNote = '';
    if ($waitingAlertsEnabled) {
      disableWaitingAlerts();
      return;
    }
    // Only ever asked from this click, never on page load.
    const result = await enableWaitingAlerts();
    if (result === 'denied') alertNote = 'Notifications are blocked for this site. Allow them in your browser settings.';
    else if (result === 'unsupported') alertNote = "This browser can't show notifications here.";
  }

  function endForEveryone() {
    if (!confirmEnd) {
      confirmEnd = true;
      return;
    }
    if (!endCallForEveryone()) {
      confirmEnd = false;
      return;
    }
    close();
  }

  function onWindowClick(e: MouseEvent) {
    // The path is fixed when the click starts: a button inside the menu that has since been swapped
    // out (e.g. "End call for everyone" -> confirm) still counts as inside.
    if (open && root && !e.composedPath().includes(root)) close();
  }

  function onKeydown(e: KeyboardEvent) {
    if (open && e.key === 'Escape') {
      close();
      trigger?.focus();
    }
  }
</script>

<svelte:window on:click={onWindowClick} on:keydown={onKeydown} />

<div class="host-controls" bind:this={root}>
  <button
    bind:this={trigger}
    class="chip accent host-trigger"
    aria-haspopup="dialog"
    aria-expanded={open}
    on:click={toggleMenu}
    title="Host controls"
  >
    Host <Icon name="chevron-down" size={12} />
  </button>

  {#if open}
    <div class="host-menu card fade-in" role="dialog" aria-label="Host controls">
      <button class="menu-item" on:click={toggleLock} disabled={!connected}>
        <span class="item-icon" class:on={locked}><Icon name="lock" size={16} /></span>
        <span class="item-text">
          <strong>{locked ? 'Unlock the call' : 'Lock the call'}</strong>
          <small>{locked ? 'People with an invite can join again.' : 'Nobody new can join, even with an invite. People already waiting stay.'}</small>
        </span>
      </button>

      <button class="menu-item" role="switch" aria-checked={$waitingAlertsEnabled} on:click={toggleAlerts} disabled={!supported}>
        <span class="switch" class:on={$waitingAlertsEnabled} aria-hidden="true"></span>
        <span class="item-text">
          <strong>Alert me when someone's waiting</strong>
          <small>{supported ? 'A system notification while this tab is in the background. It never shows who.' : 'Not available in this browser.'}</small>
        </span>
      </button>
      {#if alertNote}<p class="note" role="alert">{alertNote}</p>{/if}

      <div class="end-area">
        {#if confirmEnd}
          <p class="confirm-text" role="alert">End the call for everyone? Everyone is disconnected, including people waiting.</p>
          <div class="confirm-actions">
            <button class="btn small ghost" on:click={() => (confirmEnd = false)}>Cancel</button>
            <button class="btn small danger-solid" on:click={endForEveryone} disabled={!connected}>
              <Icon name="phone-off" size={15} /> End call
            </button>
          </div>
        {:else}
          <button class="btn small danger end-btn" on:click={endForEveryone} disabled={!connected}>
            <Icon name="phone-off" size={15} /> End call for everyone
          </button>
        {/if}
      </div>
      {#if !connected}<p class="note">Reconnecting… these controls work again once you're back.</p>{/if}
    </div>
  {/if}
</div>

<style>
  .host-controls {
    position: relative;
    flex-shrink: 0;
  }

  .host-trigger {
    min-height: 28px;
    padding: 2px 8px 2px 10px;
    cursor: pointer;
  }

  .host-trigger:hover {
    filter: brightness(1.15);
  }

  .host-trigger:focus-visible {
    outline: 2px solid var(--accent-ring);
    outline-offset: 2px;
  }

  .host-menu {
    position: absolute;
    top: calc(100% + var(--space-2));
    left: 0;
    z-index: 60;
    width: min(320px, calc(100vw - 24px));
    padding: var(--space-2);
    background: var(--bg-overlay);
    box-shadow: var(--shadow-lg);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .menu-item {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    width: 100%;
    min-height: 44px;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius);
    background: transparent;
    border: none;
    color: var(--text);
    text-align: left;
    cursor: pointer;
  }

  .menu-item:hover:not(:disabled) {
    background: var(--bg-hover);
  }

  .menu-item:focus-visible {
    outline: 2px solid var(--accent-ring);
    outline-offset: -2px;
  }

  .menu-item:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .switch {
    position: relative;
    flex-shrink: 0;
    width: 28px;
    height: 16px;
    margin-top: 2px;
    border-radius: var(--radius-pill);
    background: var(--border-strong);
    transition: background var(--dur-fast) var(--ease);
  }

  .switch::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #fff;
    transition: transform var(--dur-fast) var(--ease);
  }

  .switch.on {
    background: var(--accent);
  }

  .switch.on::after {
    transform: translateX(12px);
  }

  .item-icon {
    display: inline-flex;
    margin-top: 1px;
    color: var(--text-muted);
  }

  .item-icon.on {
    color: var(--warning);
  }

  .item-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .item-text strong {
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .item-text small {
    font-size: var(--text-xs);
    color: var(--text-muted);
    line-height: 1.4;
  }

  .note {
    padding: 0 var(--space-3) var(--space-2);
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .end-area {
    margin-top: var(--space-1);
    padding: var(--space-2) var(--space-3) var(--space-1);
    border-top: 1px solid var(--border-subtle);
  }

  .end-btn {
    width: 100%;
  }

  .confirm-text {
    font-size: var(--text-sm);
    color: var(--text);
    margin-bottom: var(--space-2);
  }

  .confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
  }

  .danger-solid {
    background: var(--danger);
    border-color: transparent;
    color: #fff;
  }

  .danger-solid:hover:not(:disabled) {
    background: var(--danger);
    filter: brightness(0.92);
  }
</style>
