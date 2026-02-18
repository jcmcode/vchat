<script lang="ts">
  import type { PeerConnection } from '$lib/webrtc/mesh';

  export let peerConnection: PeerConnection;

  let videoEl: HTMLVideoElement;

  $: if (videoEl && peerConnection.stream) {
    videoEl.srcObject = peerConnection.stream;
  }
</script>

<div class="tile">
  {#if peerConnection.stream}
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
