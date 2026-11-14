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

  export let peerConnection: PeerConnection;
  export let speaking = false;
  /** Fit the whole picture (for shared screens) instead of filling the tile. */
  export let contain = false;
  /** This person is presenting their screen. */
  export let presenting = false;
  /** Show their shared screen (the stage) instead of their camera. It never plays sound: the shared audio is mixed into their microphone. */
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
    return !!overlayEl && e.target instanceof Node && overlayEl.contains(e.target);
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

  $: if (videoEl && shown && videoEl.srcObject !== shown) {
    videoEl.srcObject = shown;
  }

  // Route audio to the speaker picked in Device Settings (Chrome/Edge/Firefox support setSinkId).
  $: if (videoEl && $selectedAudioOutput && 'setSinkId' in videoEl) {
    (videoEl as HTMLVideoElement & { setSinkId(id: string): Promise<void> })
      .setSinkId($selectedAudioOutput)
      .catch(() => {});
  }

  // Volume and "Mute for me" from the person card: only how they play on this device. Their sound
  // (shared-screen audio included, mixed into the microphone) plays from their camera tile; a
  // screen tile always stays silent.
  $: playback = playbackFor($peerAudioPrefs.get(peerConnection.id));
  $: if (videoEl) {
    videoEl.volume = playback.volume;
    videoEl.muted = screen || playback.muted;
  }
  $: handRaised = $raisedHands.has(peerConnection.id);
</script>

<!-- svelte-ignore a11y-no-noninteractive-tabindex -->
<div
  class="tile"
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
    <video bind:this={videoEl} autoplay playsinline muted={screen} class:hidden={!showVideo}></video>
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
    background: rgba(11, 13, 18, 0.62);
    -webkit-backdrop-filter: blur(6px);
    backdrop-filter: blur(6px);
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
