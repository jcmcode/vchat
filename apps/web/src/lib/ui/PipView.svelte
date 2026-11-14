<script lang="ts">
  /**
   * The call in a Document Picture-in-Picture window (mounted there by pip.ts). It runs in the main
   * window's context and reads the same stores, so it follows people joining, leaving and changing
   * tracks, and its buttons call the same functions as the main controls.
   *
   * Peer names are only ever rendered as text. Video is shown only for connections that passed the
   * trust gate (mesh.ts sets `stream` once a connection is verified or allowed), and every video
   * here is muted: the call's sound keeps playing from the main window.
   */
  import { peers, speakingPeers, peerMediaState, sharingPeers } from '$lib/webrtc/mesh';
  import { verification } from '$lib/webrtc/e2e';
  import { localStream, audioEnabled, videoEnabled, voiceOnlyMode } from '$lib/media/manager';
  import Icon from './Icon.svelte';

  export let displayName: string;
  export let chatOnly = false;
  export let onToggleAudio: () => void;
  export let onToggleVideo: () => void;
  export let onLeave: () => void;

  /** Plays a stream in a muted video element and follows it when the stream changes. */
  function playStream(node: HTMLVideoElement, stream: MediaStream | null) {
    const set = (next: MediaStream | null) => {
      if (node.srcObject === next) return;
      node.srcObject = next;
      if (next) node.play().catch(() => {});
    };
    node.muted = true;
    set(stream);
    return {
      update: set,
      destroy: () => {
        node.srcObject = null;
      },
    };
  }

  function initial(name: string): string {
    return (Array.from(name.trim())[0] ?? '?').toUpperCase();
  }

  $: people = Array.from($peers.values(), (pc) => {
    const media = $peerMediaState.get(pc.id);
    const sharing = $sharingPeers.has(pc.id);
    // Their shared screen while one is arriving, else their camera (both set only once trusted).
    const screen = pc.trusted && sharing ? pc.screenStream : null;
    const stream = pc.trusted ? screen ?? pc.stream : null;
    const state = $verification.get(pc.id)?.state;
    return {
      id: pc.id,
      name: pc.displayName,
      stream,
      showVideo: !!stream && (!!screen || media?.video !== false),
      sharing,
      contain: !!screen,
      muted: media?.audio === false,
      speaking: $speakingPeers.has(pc.id),
      unverified: state === 'unverified' || state === 'failed' || state === 'allowed' || state === 'nokey',
    };
  });
  $: hasMic = !chatOnly && !!$localStream?.getAudioTracks().length;
  // Camera off removes the camera track (manager.ts), so the button depends on how you joined.
  $: hasCam = !chatOnly && !!$localStream && !$voiceOnlyMode;
  $: selfVideo = hasCam && $videoEnabled && $localStream?.getVideoTracks().length ? $localStream : null;
</script>

<div class="pip">
  <ul class="people" class:many={people.length >= 2} aria-label="Participants">
    {#each people as p (p.id)}
      <li class="person" class:speaking={p.speaking}>
        {#if p.showVideo}
          <!-- svelte-ignore a11y-media-has-caption -->
          <video use:playStream={p.stream} autoplay muted playsinline class:contain={p.contain}></video>
        {:else}
          <span class="avatar" aria-hidden="true">{initial(p.name)}</span>
        {/if}
        <span class="label">
          {#if p.unverified}
            <span class="warn" title="Not verified end to end"><Icon name="shield-alert" size={12} /><span class="sr-only">not verified</span></span>
          {/if}
          <span class="name">{p.name}{p.sharing ? ' · presenting' : ''}</span>
          {#if p.muted}
            <span class="muted" title="Muted"><Icon name="mic-off" size={12} /><span class="sr-only">muted</span></span>
          {/if}
          {#if p.speaking}<span class="sr-only">speaking</span>{/if}
        </span>
      </li>
    {/each}
    <li class="person self" class:speaking={$speakingPeers.has('local')}>
      {#if selfVideo}
        <!-- svelte-ignore a11y-media-has-caption -->
        <video use:playStream={selfVideo} autoplay muted playsinline></video>
      {:else}
        <span class="avatar" aria-hidden="true">{initial(displayName)}</span>
      {/if}
      <span class="label">
        <span class="name">{displayName} (you)</span>
        {#if hasMic && !$audioEnabled}
          <span class="muted" title="Muted"><Icon name="mic-off" size={12} /><span class="sr-only">muted</span></span>
        {/if}
      </span>
    </li>
  </ul>

  <div class="controls" role="group" aria-label="Call controls">
    {#if hasMic}
      <button class:off={!$audioEnabled} aria-pressed={$audioEnabled} on:click={onToggleAudio} title={$audioEnabled ? 'Mute' : 'Unmute'}>
        <Icon name={$audioEnabled ? 'mic' : 'mic-off'} size={18} />
        <span class="sr-only">Mic</span>
      </button>
    {/if}
    {#if hasCam}
      <button class:off={!$videoEnabled} aria-pressed={$videoEnabled} on:click={onToggleVideo} title={$videoEnabled ? 'Camera off' : 'Camera on'}>
        <Icon name={$videoEnabled ? 'video' : 'video-off'} size={18} />
        <span class="sr-only">Camera</span>
      </button>
    {/if}
    <button class="leave" on:click={onLeave} title="Leave call">
      <Icon name="phone-off" size={18} />
      <span class="sr-only">Leave call</span>
    </button>
  </div>
</div>

<style>
  .pip {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-sans);
  }

  .people {
    flex: 1;
    min-height: 0;
    list-style: none;
    margin: 0;
    padding: 6px;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-auto-rows: minmax(72px, 1fr);
    gap: 6px;
    overflow-y: auto;
  }

  .people.many {
    grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  }

  .person {
    position: relative;
    min-width: 0;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    border-radius: var(--radius);
    border: 1px solid var(--border-subtle);
    background: linear-gradient(160deg, var(--bg-elevated), var(--bg-surface));
  }

  .person.speaking {
    border-color: var(--success);
    box-shadow: 0 0 0 2px var(--success);
  }

  video {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  video.contain {
    object-fit: contain;
    background: #000;
  }

  .self video {
    transform: scaleX(-1);
  }

  .avatar {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--accent);
    background: var(--accent-soft);
    border: 1px solid var(--border);
  }

  .label {
    position: absolute;
    left: 4px;
    bottom: 4px;
    max-width: calc(100% - 8px);
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 8px;
    border-radius: var(--radius-pill);
    background: rgba(11, 13, 18, 0.62);
    color: #fff;
    font-size: 0.6875rem;
    font-weight: 500;
  }

  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .muted {
    display: inline-flex;
    flex-shrink: 0;
    color: #f87171;
  }

  .warn {
    display: inline-flex;
    flex-shrink: 0;
    color: var(--warning);
  }

  .controls {
    flex-shrink: 0;
    display: flex;
    justify-content: center;
    gap: 8px;
    padding: 6px;
    background: var(--bg-surface);
    border-top: 1px solid var(--border-subtle);
  }

  .controls button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 36px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    color: var(--text);
  }

  .controls button:hover {
    background: var(--bg-overlay);
  }

  .controls button.off {
    background: var(--danger-soft);
    border-color: transparent;
    color: var(--danger);
  }

  .controls button.leave {
    width: 52px;
    background: var(--danger);
    border-color: transparent;
    color: #fff;
  }
</style>
