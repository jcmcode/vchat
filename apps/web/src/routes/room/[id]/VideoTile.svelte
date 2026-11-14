<script lang="ts">
  import type { PeerConnection } from '$lib/webrtc/mesh';
  import { selectedAudioOutput } from '$lib/media/manager';

  export let peerConnection: PeerConnection;
  export let speaking = false;

  let videoEl: HTMLVideoElement;

  $: if (videoEl && peerConnection.stream && videoEl.srcObject !== peerConnection.stream) {
    videoEl.srcObject = peerConnection.stream;
  }

  // Route audio to the speaker picked in Device Settings (Chrome/Edge/Firefox support setSinkId).
  $: if (videoEl && $selectedAudioOutput && 'setSinkId' in videoEl) {
    (videoEl as HTMLVideoElement & { setSinkId(id: string): Promise<void> })
      .setSinkId($selectedAudioOutput)
      .catch(() => {});
  }
</script>

<div class="tile" class:speaking>
  {#if peerConnection.stream}
    <!-- svelte-ignore a11y-media-has-caption -->
    <video
      bind:this={videoEl}
      autoplay
      playsinline
    ></video>
  {:else}
    <div class="no-video">
      <span class="avatar">{peerConnection.displayName.charAt(0).toUpperCase()}</span>
    </div>
  {/if}
  <span class="tile-name">{peerConnection.displayName}</span>
</div>

<style>
  .tile {
    position: relative;
    background: var(--bg-surface);
    border-radius: var(--radius);
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 2px solid transparent;
    transition: border-color 0.2s, box-shadow 0.2s;
  }

  .tile.speaking {
    border-color: var(--success);
    box-shadow: 0 0 12px rgba(34, 197, 94, 0.3);
  }

  video {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .no-video {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    background: var(--bg-elevated);
  }

  .avatar {
    font-size: 3rem;
    font-weight: 600;
    color: var(--text-muted);
    background: var(--border);
    width: 80px;
    height: 80px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .tile-name {
    position: absolute;
    bottom: 8px;
    left: 8px;
    background: rgba(0, 0, 0, 0.6);
    color: white;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 0.8rem;
  }
</style>
