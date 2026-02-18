<script lang="ts">
  import { page } from '$app/stores';
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { browser } from '$app/environment';
  import {
    peers,
    chatMessages,
    connectionState,
    joinRoom,
    leaveRoom,
    sendChatMessage,
    startSharingScreen,
    stopSharingScreen,
    type PeerConnection,
    type ChatMessage,
  } from '$lib/webrtc/mesh';
  import {
    localStream,
    screenStream,
    audioEnabled,
    videoEnabled,
    isScreenSharing,
    startMedia,
    stopMedia,
    toggleAudio,
    toggleVideo,
    startScreenShare,
    stopScreenShare,
  } from '$lib/media/manager';
  import { getSignalServerUrl, getSavedDisplayName, peerId } from '$lib/stores/room';
  import VideoTile from './VideoTile.svelte';
  import ChatPanel from './ChatPanel.svelte';

  let roomId = '';
  let displayName = '';
  let mediaReady = false;
  let showChat = false;
  let peerList: PeerConnection[] = [];
  let localVideoEl: HTMLVideoElement;
  let copied = false;
  let wasScreenSharing = false;

  $: roomId = $page.params.id;
  $: peerList = Array.from($peers.values());
  $: gridCols = getGridCols(peerList.length + 1); // +1 for self

  function getGridCols(count: number): number {
    if (count <= 1) return 1;
    if (count <= 4) return 2;
    return 3;
  }

  onMount(async () => {
    if (!browser) return;

    // Get display name from URL or saved
    const urlName = $page.url.searchParams.get('name');
    displayName = urlName || getSavedDisplayName() || 'Anonymous';

    try {
      await startMedia();
      mediaReady = true;
    } catch (err) {
      console.error('Failed to get media:', err);
      // Continue without media — can still do text chat
      mediaReady = true;
    }

    const serverUrl = getSignalServerUrl();
    joinRoom(serverUrl, roomId, $peerId, displayName);
  });

  onDestroy(() => {
    if (browser) {
      leaveRoom();
      stopMedia();
    }
  });

  function handleLeave() {
    leaveRoom();
    stopMedia();
    goto('/');
  }

  function handleToggleAudio() {
    toggleAudio();
  }

  function handleToggleVideo() {
    toggleVideo();
  }

  async function handleScreenShare() {
    if ($isScreenSharing) {
      stopSharingScreen();
      stopScreenShare();
    } else {
      const stream = await startScreenShare();
      if (stream) {
        startSharingScreen();
      }
    }
  }

  function copyLink() {
    const url = window.location.href.split('?')[0];
    navigator.clipboard.writeText(url);
    copied = true;
    setTimeout(() => { copied = false; }, 2000);
  }

  // Handle browser-native "Stop sharing" button: when isScreenSharing goes
  // from true to false externally, restore camera tracks on peers
  $: {
    if (wasScreenSharing && !$isScreenSharing) {
      stopSharingScreen();
    }
    wasScreenSharing = $isScreenSharing;
  }

  // Bind local video to stream — show screen when sharing, camera otherwise
  $: if (localVideoEl) {
    if ($isScreenSharing && $screenStream) {
      localVideoEl.srcObject = $screenStream;
    } else if ($localStream) {
      localVideoEl.srcObject = $localStream;
    }
  }
</script>

<div class="room">
  <!-- Top bar -->
  <header>
    <div class="room-info">
      <span class="room-id">{roomId}</span>
      <button class="copy-btn" on:click={copyLink}>
        {copied ? 'Copied!' : 'Copy link'}
      </button>
      <span class="conn-status" class:connected={$connectionState === 'connected'}>
        {$connectionState}
      </span>
    </div>
    <div class="peer-count">
      {peerList.length + 1} in call
    </div>
  </header>

  <!-- Video grid -->
  <main class="video-grid" style="--cols: {gridCols}">
    <!-- Local video -->
    <div class="tile self" class:screen-sharing={$isScreenSharing}>
      <video
        bind:this={localVideoEl}
        autoplay
        muted
        playsinline
      ></video>
      <span class="tile-name">{displayName} (you)</span>
      {#if !$audioEnabled}
        <span class="muted-badge">Muted</span>
      {/if}
    </div>

    <!-- Remote peers -->
    {#each peerList as pc (pc.id)}
      <VideoTile peerConnection={pc} />
    {/each}
  </main>

  <!-- Chat panel -->
  {#if showChat}
    <ChatPanel
      messages={$chatMessages}
      on:send={(e) => sendChatMessage(e.detail)}
      on:close={() => { showChat = false; }}
    />
  {/if}

  <!-- Controls bar -->
  <footer>
    <div class="controls">
      <button
        class="ctrl-btn"
        class:off={!$audioEnabled}
        on:click={handleToggleAudio}
        title={$audioEnabled ? 'Mute' : 'Unmute'}
      >
        {$audioEnabled ? 'Mic On' : 'Mic Off'}
      </button>

      <button
        class="ctrl-btn"
        class:off={!$videoEnabled}
        on:click={handleToggleVideo}
        title={$videoEnabled ? 'Camera off' : 'Camera on'}
      >
        {$videoEnabled ? 'Cam On' : 'Cam Off'}
      </button>

      <button
        class="ctrl-btn"
        class:active={$isScreenSharing}
        on:click={handleScreenShare}
        title={$isScreenSharing ? 'Stop sharing' : 'Share screen'}
      >
        {$isScreenSharing ? 'Stop Share' : 'Screen'}
      </button>

      <button
        class="ctrl-btn"
        class:active={showChat}
        on:click={() => { showChat = !showChat; }}
        title="Chat"
      >
        Chat
      </button>

      <button class="ctrl-btn leave" on:click={handleLeave} title="Leave call">
        Leave
      </button>
    </div>
  </footer>
</div>

<style>
  .room {
    height: 100vh;
    display: flex;
    flex-direction: column;
    background: var(--bg);
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    background: var(--bg-surface);
    border-bottom: 1px solid var(--border);
  }

  .room-info {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .room-id {
    font-weight: 600;
    font-size: 1.1rem;
    font-family: monospace;
  }

  .copy-btn {
    background: var(--bg-elevated);
    color: var(--text-muted);
    padding: 0.3rem 0.6rem;
    border-radius: 4px;
    font-size: 0.8rem;
    border: 1px solid var(--border);
  }

  .copy-btn:hover {
    color: var(--text);
  }

  .conn-status {
    font-size: 0.8rem;
    color: var(--text-muted);
  }

  .conn-status.connected {
    color: var(--success);
  }

  .peer-count {
    color: var(--text-muted);
    font-size: 0.9rem;
  }

  .video-grid {
    flex: 1;
    display: grid;
    grid-template-columns: repeat(var(--cols), 1fr);
    gap: 4px;
    padding: 4px;
    overflow: hidden;
  }

  .tile {
    position: relative;
    background: var(--bg-surface);
    border-radius: var(--radius);
    overflow: hidden;
  }

  .tile video {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .tile.self:not(.screen-sharing) video {
    transform: scaleX(-1);
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

  .muted-badge {
    position: absolute;
    top: 8px;
    right: 8px;
    background: var(--danger);
    color: white;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 0.7rem;
  }

  footer {
    padding: 0.75rem;
    background: var(--bg-surface);
    border-top: 1px solid var(--border);
  }

  .controls {
    display: flex;
    justify-content: center;
    gap: 0.5rem;
  }

  .ctrl-btn {
    background: var(--bg-elevated);
    color: var(--text);
    padding: 0.6rem 1.2rem;
    border-radius: var(--radius);
    font-size: 0.9rem;
    border: 1px solid var(--border);
    transition: all 0.15s;
  }

  .ctrl-btn:hover {
    background: var(--border);
  }

  .ctrl-btn.off {
    background: var(--danger);
    border-color: var(--danger);
    color: white;
  }

  .ctrl-btn.active {
    background: var(--accent);
    border-color: var(--accent);
    color: white;
  }

  .ctrl-btn.leave {
    background: var(--danger);
    border-color: var(--danger);
    color: white;
  }

  .ctrl-btn.leave:hover {
    background: #dc2626;
  }
</style>
