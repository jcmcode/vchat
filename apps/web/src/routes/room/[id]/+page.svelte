<script lang="ts">
  import { page } from '$app/stores';
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { browser } from '$app/environment';
  import {
    peers,
    chatMessages,
    connectionState,
    admissionState,
    admissionRequests,
    hostStatus,
    reactions as reactionsStore,
    speakingPeers,
    joinRoom,
    leaveRoom,
    sendChatMessage,
    sendReaction,
    admitPeer,
    denyPeer,
    startSharingScreen,
    stopSharingScreen,
    type PeerConnection,
  } from '$lib/webrtc/mesh';
  import {
    localStream,
    screenStream,
    audioEnabled,
    videoEnabled,
    isScreenSharing,
    voiceOnlyMode,
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
  import WaitingScreen from './WaitingScreen.svelte';
  import AdmissionPanel from './AdmissionPanel.svelte';
  import DeviceSettings from './DeviceSettings.svelte';
  import ReactionOverlay from './ReactionOverlay.svelte';
  import ReactionPicker from './ReactionPicker.svelte';

  let roomId = '';
  let displayName = '';
  let mediaReady = false;
  let showChat = false;
  let showDeviceSettings = false;
  let showReactionPicker = false;
  let peerList: PeerConnection[] = [];
  let localVideoEl: HTMLVideoElement;
  let copied = false;
  let wasScreenSharing = false;

  $: roomId = $page.params.id;
  $: peerList = Array.from($peers.values());
  $: gridCols = getGridCols(peerList.length + 1);

  function getGridCols(count: number): number {
    if (count <= 1) return 1;
    if (count <= 4) return 2;
    return 3;
  }

  onMount(async () => {
    if (!browser) return;

    const urlName = $page.url.searchParams.get('name');
    displayName = urlName || getSavedDisplayName() || 'Anonymous';

    const isCreator = $page.url.searchParams.get('creator') === '1';
    const password = $page.url.searchParams.get('password') || undefined;
    const voiceOnly = $page.url.searchParams.get('voiceOnly') === '1';

    try {
      await startMedia({ voiceOnly });
      mediaReady = true;
    } catch (err) {
      console.error('Failed to get media:', err);
      mediaReady = true;
    }

    const serverUrl = getSignalServerUrl();
    joinRoom(serverUrl, roomId, $peerId, displayName, isCreator, password);
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

  function handleCancelWaiting() {
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

  let meshStopCalled = false;

  async function handleScreenShare() {
    if ($isScreenSharing) {
      stopSharingScreen();
      meshStopCalled = true;
      stopScreenShare();
    } else {
      meshStopCalled = false;
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

  $: {
    if (wasScreenSharing && !$isScreenSharing && !meshStopCalled) {
      stopSharingScreen();
    }
    if (!$isScreenSharing) {
      meshStopCalled = false;
    }
    wasScreenSharing = $isScreenSharing;
  }

  $: if (localVideoEl) {
    if ($isScreenSharing && $screenStream) {
      localVideoEl.srcObject = $screenStream;
    } else if ($localStream) {
      localVideoEl.srcObject = $localStream;
    }
  }

  // Redirect on denied admission
  $: if ($admissionState === 'denied') {
    setTimeout(() => {
      leaveRoom();
      stopMedia();
      goto('/');
    }, 3000);
  }

  $: localSpeaking = $speakingPeers.has('local');
</script>

{#if $admissionState === 'waiting'}
  <WaitingScreen on:cancel={handleCancelWaiting} />
{/if}

{#if $admissionState === 'denied'}
  <div class="denied-overlay">
    <div class="denied-card">
      <h2>Access Denied</h2>
      <p>You were not admitted to this room. Redirecting...</p>
    </div>
  </div>
{/if}

<div class="room">
  <header>
    <div class="room-info">
      <span class="room-id">{roomId}</span>
      <button class="copy-btn" on:click={copyLink}>
        {copied ? 'Copied!' : 'Copy link'}
      </button>
      <span class="conn-status" class:connected={$connectionState === 'connected'}>
        {$connectionState}
      </span>
      {#if $hostStatus}
        <span class="host-badge">Host</span>
      {/if}
    </div>
    <div class="peer-count">
      {peerList.length + 1} in call
    </div>
  </header>

  {#if $hostStatus && $admissionRequests.length > 0}
    <AdmissionPanel
      requests={$admissionRequests}
      on:admit={(e) => admitPeer(e.detail)}
      on:deny={(e) => denyPeer(e.detail)}
    />
  {/if}

  <ReactionOverlay reactions={$reactionsStore} />

  <main class="video-grid" style="--cols: {gridCols}">
    <div class="tile self" class:screen-sharing={$isScreenSharing} class:speaking={localSpeaking}>
      {#if $voiceOnlyMode && !$isScreenSharing}
        <div class="no-video">
          <span class="avatar">{displayName.charAt(0).toUpperCase()}</span>
        </div>
      {:else}
        <video
          bind:this={localVideoEl}
          autoplay
          muted
          playsinline
        ></video>
      {/if}
      <span class="tile-name">{displayName} (you)</span>
      {#if !$audioEnabled}
        <span class="muted-badge">Muted</span>
      {/if}
    </div>

    {#each peerList as pc (pc.id)}
      <VideoTile peerConnection={pc} speaking={$speakingPeers.has(pc.id)} />
    {/each}
  </main>

  {#if showChat}
    <ChatPanel
      messages={$chatMessages}
      on:send={(e) => sendChatMessage(e.detail)}
      on:close={() => { showChat = false; }}
    />
  {/if}

  {#if showDeviceSettings}
    <DeviceSettings />
  {/if}

  {#if showReactionPicker}
    <ReactionPicker on:react={(e) => { sendReaction(e.detail); showReactionPicker = false; }} />
  {/if}

  <footer>
    <div class="controls">
      <button
        class="ctrl-btn"
        class:off={!$audioEnabled}
        on:click={handleToggleAudio}
        title={$audioEnabled ? 'Mute' : 'Unmute'}
      >
        <span class="ctrl-label">{$audioEnabled ? 'Mic On' : 'Mic Off'}</span>
      </button>

      <button
        class="ctrl-btn"
        class:off={!$videoEnabled}
        on:click={handleToggleVideo}
        title={$videoEnabled ? 'Camera off' : 'Camera on'}
      >
        <span class="ctrl-label">{$videoEnabled ? 'Cam On' : 'Cam Off'}</span>
      </button>

      <button
        class="ctrl-btn"
        class:active={$isScreenSharing}
        on:click={handleScreenShare}
        title={$isScreenSharing ? 'Stop sharing' : 'Share screen'}
      >
        <span class="ctrl-label">{$isScreenSharing ? 'Stop' : 'Screen'}</span>
      </button>

      <button
        class="ctrl-btn"
        class:active={showChat}
        on:click={() => { showChat = !showChat; }}
        title="Chat"
      >
        <span class="ctrl-label">Chat</span>
      </button>

      <button
        class="ctrl-btn"
        class:active={showReactionPicker}
        on:click={() => { showReactionPicker = !showReactionPicker; showDeviceSettings = false; }}
        title="React"
      >
        <span class="ctrl-label">React</span>
      </button>

      <button
        class="ctrl-btn"
        class:active={showDeviceSettings}
        on:click={() => { showDeviceSettings = !showDeviceSettings; showReactionPicker = false; }}
        title="Settings"
      >
        <span class="ctrl-label">Settings</span>
      </button>

      <button class="ctrl-btn leave" on:click={handleLeave} title="Leave call">
        <span class="ctrl-label">Leave</span>
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

  .host-badge {
    font-size: 0.75rem;
    background: var(--accent);
    color: white;
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    font-weight: 600;
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
    border: 2px solid transparent;
    transition: border-color 0.2s, box-shadow 0.2s;
  }

  .tile.speaking {
    border-color: var(--success);
    box-shadow: 0 0 12px rgba(34, 197, 94, 0.3);
  }

  .tile video {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .tile.self:not(.screen-sharing) video {
    transform: scaleX(-1);
  }

  .tile .no-video {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    background: var(--bg-elevated);
  }

  .tile .avatar {
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

  .denied-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.85);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }

  .denied-card {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 2rem;
    text-align: center;
    max-width: 320px;
  }

  .denied-card h2 {
    color: var(--danger);
    margin-bottom: 0.5rem;
  }

  .denied-card p {
    color: var(--text-muted);
    font-size: 0.9rem;
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
    flex-wrap: wrap;
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

  @media (max-width: 640px) {
    .video-grid {
      grid-template-columns: 1fr;
    }

    .ctrl-btn {
      padding: 0.5rem 0.8rem;
      font-size: 0.8rem;
    }

    .room-info {
      gap: 0.4rem;
    }

    .room-id {
      font-size: 0.9rem;
    }

    header {
      padding: 0.5rem 0.75rem;
    }

    .copy-btn {
      display: none;
    }
  }
</style>
