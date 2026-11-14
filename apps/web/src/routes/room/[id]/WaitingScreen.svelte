<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import Icon from '$lib/ui/Icon.svelte';

  export let hostPresent = true;
  /**
   * Full-screen lobby shown instead of the call until you're let in (guests). Otherwise a card over
   * the call (e.g. sent back to the lobby after a reconnect).
   */
  export let page = false;
  /** Still connecting to the server (not yet told to wait). */
  export let connecting = false;
  export let roomName = '';
  export let displayName = '';
  /** Your camera, for a small preview while you wait. */
  export let previewStream: MediaStream | null = null;

  const dispatch = createEventDispatcher<{ cancel: void }>();

  $: hasPreview = !!previewStream?.getVideoTracks().some((t) => t.readyState === 'live' && t.enabled);
  $: title = connecting
    ? 'Connecting…'
    : hostPresent
      ? page
        ? 'Waiting for the host to let you in'
        : 'Waiting for host...'
      : "The host hasn't joined yet";
  $: description = connecting
    ? 'Getting you to the lobby.'
    : hostPresent
      ? 'The host will let you in shortly.'
      : "You'll be let in once they arrive. Keep this page open.";

  function srcObject(node: HTMLVideoElement, stream: MediaStream | null) {
    node.srcObject = stream;
    return {
      update(next: MediaStream | null) {
        if (node.srcObject !== next) node.srcObject = next;
      },
      destroy() {
        node.srcObject = null;
      },
    };
  }
</script>

{#if page}
  <main class="lobby">
    <section class="lobby-card card fade-in" aria-labelledby="lobby-title" aria-describedby="lobby-desc">
      <p class="lobby-room">{roomName || 'Video call'}</p>
      <div class="preview" class:avatar-only={!hasPreview}>
        {#if hasPreview}
          <!-- svelte-ignore a11y-media-has-caption -->
          <video use:srcObject={previewStream} autoplay muted playsinline aria-label="Your camera preview"></video>
        {:else}
          <span class="avatar" aria-hidden="true">{(displayName || '?').charAt(0).toUpperCase()}</span>
        {/if}
      </div>
      <div class="status" role="status" aria-live="polite">
        <span class="spinner small" aria-hidden="true"></span>
        <h1 id="lobby-title">{title}</h1>
      </div>
      <p id="lobby-desc" class="desc">{description}</p>
      {#if displayName}
        <p class="joining-as"><Icon name="user" size={14} /> Joining as <strong>{displayName}</strong></p>
      {/if}
      <span class="chip"><Icon name="lock" size={12} /> End-to-end encrypted</span>
      <button class="btn cancel" on:click={() => dispatch('cancel')}>Cancel</button>
    </section>
  </main>
{:else}
  <div class="waiting-overlay">
    <div class="waiting-card card fade-in" role="dialog" aria-modal="true" aria-labelledby="waiting-title" aria-describedby="waiting-desc">
      <div class="spinner" aria-hidden="true"></div>
      <h2 id="waiting-title">{title}</h2>
      <p id="waiting-desc">{description}</p>
      <span class="chip"><Icon name="lock" size={12} /> End-to-end encrypted</span>
      <button class="btn cancel" on:click={() => dispatch('cancel')}>Cancel</button>
    </div>
  </div>
{/if}

<style>
  .waiting-overlay {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-4);
    background: rgba(8, 10, 15, 0.72);
    -webkit-backdrop-filter: blur(6px);
    backdrop-filter: blur(6px);
  }

  .waiting-card {
    width: min(100%, 360px);
    padding: var(--space-8) var(--space-6) var(--space-6);
    text-align: center;
    box-shadow: var(--shadow-lg);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-3);
  }

  .spinner {
    width: 40px;
    height: 40px;
    flex-shrink: 0;
    border: 3px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin-bottom: var(--space-2);
  }

  .spinner.small {
    width: 18px;
    height: 18px;
    border-width: 2px;
    margin: 0;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  h2 {
    font-size: var(--text-xl);
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  .waiting-card p {
    color: var(--text-muted);
    font-size: var(--text-base);
    margin-top: calc(var(--space-2) * -1);
  }

  .btn.cancel {
    margin-top: var(--space-2);
  }

  /* ── Full-screen lobby ── */
  /* The page itself doesn't scroll (body is overflow: hidden), so the lobby does. */
  .lobby {
    height: 100vh;
    height: 100dvh;
    display: flex;
    flex-direction: column;
    padding: var(--space-6) var(--space-4);
    overflow-y: auto;
    background:
      radial-gradient(ellipse 70% 40% at 50% 0%, var(--accent-soft), transparent 70%),
      var(--bg);
  }

  .lobby-card {
    margin: auto;
    width: min(100%, 420px);
    padding: var(--space-6);
    box-shadow: var(--shadow-lg);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-3);
    text-align: center;
  }

  .lobby-room {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-muted);
    text-transform: none;
    overflow-wrap: anywhere;
  }

  .preview {
    width: min(100%, 280px);
    aspect-ratio: 16 / 10;
    border-radius: var(--radius);
    overflow: hidden;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .preview.avatar-only {
    width: 88px;
    height: 88px;
    aspect-ratio: auto;
    border-radius: 50%;
  }

  .preview video {
    width: 100%;
    height: 100%;
    object-fit: cover;
    transform: scaleX(-1);
  }

  .avatar {
    font-size: 2rem;
    font-weight: 600;
    color: var(--text-muted);
  }

  .status {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    margin-top: var(--space-2);
  }

  .status h1 {
    font-size: var(--text-xl);
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--text);
  }

  .desc {
    color: var(--text-muted);
    font-size: var(--text-base);
    margin-top: calc(var(--space-2) * -1);
  }

  .joining-as {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    font-size: var(--text-sm);
    color: var(--text-muted);
    max-width: 100%;
    overflow-wrap: anywhere;
  }

  .joining-as strong {
    color: var(--text);
    font-weight: 600;
  }
</style>
