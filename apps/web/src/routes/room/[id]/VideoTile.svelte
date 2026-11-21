<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { peerMediaState, type PeerConnection } from '$lib/webrtc/mesh';
  import type { Verification } from '$lib/webrtc/e2e';
  import { selectedAudioOutput } from '$lib/media/manager';
  import { peerAudioPrefs } from '$lib/ui/participant-prefs';
  import { playbackFor } from '$lib/ui/participants';
  import { raisedHands } from '$lib/collab/hands';
  import Icon from '$lib/ui/Icon.svelte';
  import TileQuality from './TileQuality.svelte';
  import { cameraView } from '$lib/webrtc/view-size';

  export let peerConnection: PeerConnection;
  export let speaking = false;
  /** Fit the whole picture (for shared screens) instead of filling the tile. */
  export let contain = false;
  /** This person is presenting their screen. */
  export let presenting = false;
  /** Show their shared screen (the stage) instead of their camera. It also plays the screen's captured audio when available. */
  export let screen = false;
  /** Exposed so overlays (screen annotations) can read the video's size. */
  export let videoEl: HTMLVideoElement | null = null;
  /** End-to-end verification state of this connection. */
  export let verification: Verification | undefined = undefined;
  /** Tapping the tile opens actions (message privately, send a file). */
  export let selectable = false;

  const dispatch = createEventDispatcher<{ select: void }>();
  let qualityShown = false;

  /** Overlays in the slot (screen annotations and their toolbar) handle their own clicks and keys. */
  let overlayEl: HTMLElement | null = null;
  function fromOverlay(e: Event): boolean {
    // A control can remove itself during its click (Hide annotations). The event path
    // still identifies the overlay after the original target has left the DOM.
    return !!overlayEl && e.composedPath().includes(overlayEl);
  }

  // With overlays (screen annotations have their own buttons) the tile isn't a button itself:
  // buttons can't contain buttons. A tap still opens the card; the page offers a separate button.
  $: asButton = selectable && !$$slots.default;

  function onKey(e: KeyboardEvent) {
    if (asButton && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      dispatch('select');
    }
  }

  // What the peer told us about their mic/camera (over the data channel).
  $: media = $peerMediaState.get(peerConnection.id);
  $: shown = screen ? peerConnection.screenStream : peerConnection.stream;
  $: showVideo = !!shown && (screen || media?.video !== false);

  let playBlocked = false;
  async function playScreen(el: HTMLVideoElement, stream: MediaStream) {
    try {
      await el.play();
      if (el === videoEl && el.srcObject === stream) playBlocked = false;
    } catch (error) {
      if (el === videoEl && el.srcObject === stream && error instanceof DOMException && error.name === 'NotAllowedError') {
        playBlocked = true;
      }
    }
  }

  $: if (videoEl && shown && videoEl.srcObject !== shown) {
    playBlocked = false;
    videoEl.srcObject = shown;
    if (screen) void playScreen(videoEl, shown);
  }

  // Route audio to the speaker picked in Device Settings (Chrome/Edge/Firefox support setSinkId).
  $: if (videoEl && 'setSinkId' in videoEl) {
    (videoEl as HTMLVideoElement & { setSinkId(id: string): Promise<void> })
      .setSinkId($selectedAudioOutput)
      .catch(() => {});
  }

  // Apply participant playback preferences to both their voice and their shared media.
  $: playback = playbackFor($peerAudioPrefs.get(peerConnection.id));
  $: muted = playback.muted || (screen && !shown?.getAudioTracks().length);
  $: if (videoEl) videoEl.volume = playback.volume;
  $: handRaised = $raisedHands.has(peerConnection.id);
</script>

<!-- svelte-ignore a11y-no-noninteractive-tabindex -->
<div
  class="tile"
  use:cameraView={{ peerId: peerConnection.id, fit: contain ? 'contain' : 'cover', enabled: !screen }}
  class:speaking
  class:contain
  class:selectable
  role={asButton ? 'button' : undefined}
  tabindex={asButton ? 0 : undefined}
  aria-label={asButton ? `${peerConnection.displayName}${handRaised ? ', hand raised' : ''}${playback.muted ? ', muted for you' : ''}: message, send a file, volume or pin` : undefined}
  aria-describedby={qualityShown ? `quality-${peerConnection.id}` : undefined}
  on:click={(e) => selectable && !fromOverlay(e) && dispatch('select')}
  on:keydown={onKey}
>
  {#if shown}
    <!-- The video element stays mounted (it also plays the person's audio); it's hidden when their camera is off. -->
    <!-- svelte-ignore a11y-media-has-caption -->
    <video bind:this={videoEl} autoplay playsinline {muted} class:hidden={!showVideo}></video>
  {/if}
  {#if screen && playBlocked && videoEl && shown}
    <button
      class="play-screen"
      on:click|stopPropagation={() => videoEl && shown && playScreen(videoEl, shown)}
    >Play shared screen</button>
  {/if}
  {#if !showVideo}
    <div class="no-video">
      <span class="avatar">{peerConnection.displayName.charAt(0).toUpperCase()}</span>
    </div>
  {/if}
  {#if $$slots.default}
    <div class="tile-overlay" bind:this={overlayEl}><slot /></div>
  {/if}
  {#if handRaised && !screen}
    <span class="hand-badge" title="Hand raised"><Icon name="hand" size={15} /><span class="sr-only">hand raised</span></span>
  {/if}
  {#if !screen}
    <!-- Once per person: on their own tile, not on their shared screen (ids must stay unique). -->
    <TileQuality peerId={peerConnection.id} id="quality-{peerConnection.id}" bind:shown={qualityShown} />
  {/if}
  <span class="tile-name">
    {#if verification === 'verified'}
      <span class="ver verified" title="Verified end-to-end"><Icon name="shield-check" size={13} /><span class="sr-only">verified</span></span>
    {:else if verification === 'unverified' || verification === 'failed' || verification === 'allowed' || verification === 'nokey'}
      <span class="ver unverified" title="Not verified end to end"><Icon name="shield-alert" size={13} /><span class="sr-only">not verified</span></span>
    {/if}
    <span class="name-text">{peerConnection.displayName}{presenting ? ' · presenting' : ''}</span>
    {#if media?.audio === false}
      <span class="muted-dot" title="Muted"><Icon name="mic-off" size={13} /><span class="sr-only">muted</span></span>
    {/if}
    {#if playback.muted}
      <span class="silenced" title="Muted for you"><Icon name="volume-x" size={13} /><span class="sr-only">muted for you</span></span>
    {/if}
  </span>
</div>

<style>
  .play-screen {
    position: absolute;
    z-index: 6;
    padding: var(--space-2) var(--space-3);
    color: white;
    background: #17191e;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-pill);
  }

  .tile.selectable {
    cursor: pointer;
  }

  .tile.selectable:hover {
    border-color: var(--border-strong);
  }

  .ver {
    display: inline-flex;
    flex-shrink: 0;
  }

  .ver.verified {
    color: var(--success);
  }

  .ver.unverified {
    color: var(--warning);
  }

  .tile {
    position: relative;
    min-width: 0;
    min-height: 0;
    background: var(--bg-surface);
    border-radius: var(--radius-lg);
    border: 1px solid var(--border-subtle);
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
  }

  .tile.speaking {
    border-color: var(--success);
    box-shadow: 0 0 0 2px var(--success), 0 0 20px var(--success-soft);
  }

  video {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .tile.contain video {
    object-fit: contain;
    background: #000;
  }

  video.hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
  }

  .no-video {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    background: linear-gradient(160deg, var(--bg-elevated), var(--bg-surface));
  }

  .avatar {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 72px;
    height: 72px;
    border-radius: 50%;
    font-size: 2rem;
    font-weight: 600;
    color: var(--accent);
    background: var(--accent-soft);
    border: 1px solid var(--border);
  }

  :global(.tile-strip) .avatar {
    width: 44px;
    height: 44px;
    font-size: 1.25rem;
  }

  .tile-name {
    position: absolute;
    left: var(--space-2);
    bottom: var(--space-2);
    max-width: calc(100% - 16px);
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border-radius: var(--radius-pill);
    /* Solid, not backdrop-filter: a blur over playing video is recomputed every frame, per tile. */
    background: rgba(11, 13, 18, 0.78);
    color: #fff;
    font-size: var(--text-xs);
    font-weight: 500;
  }

  .name-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .muted-dot {
    display: inline-flex;
    flex-shrink: 0;
    color: #f87171;
  }

  .tile-overlay {
    display: contents;
  }

  .silenced {
    display: inline-flex;
    flex-shrink: 0;
    color: #fbbf24;
  }

  .hand-badge {
    position: absolute;
    top: var(--space-2);
    left: var(--space-2);
    display: inline-flex;
    padding: 5px;
    border-radius: var(--radius-pill);
    background: var(--warning);
    color: #1a1300;
    box-shadow: var(--shadow-sm);
    pointer-events: none;
  }
</style>
