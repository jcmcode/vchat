<script lang="ts">
  import {
    audioDevices,
    videoDevices,
    audioOutputDevices,
    selectedAudioDevice,
    selectedVideoDevice,
    selectedAudioOutput,
    switchAudioDevice,
    switchVideoDevice,
    enumerateDevices,
  } from '$lib/media/manager';
  import { replaceTrackOnAllPeers } from '$lib/webrtc/mesh';
  import { onMount } from 'svelte';

  onMount(() => {
    enumerateDevices();
  });

  async function handleAudioChange(e: Event) {
    const deviceId = (e.target as HTMLSelectElement).value;
    const track = await switchAudioDevice(deviceId);
    if (track) replaceTrackOnAllPeers(track, 'audio');
  }

  async function handleVideoChange(e: Event) {
    const deviceId = (e.target as HTMLSelectElement).value;
    const track = await switchVideoDevice(deviceId);
    if (track) replaceTrackOnAllPeers(track, 'video');
  }

  function handleOutputChange(e: Event) {
    const deviceId = (e.target as HTMLSelectElement).value;
    selectedAudioOutput.set(deviceId);
    // Setting audio output requires setSinkId on video elements, handled by caller
  }
</script>

<div class="device-settings">
  <div class="settings-header">Device Settings</div>

  <label>
    <span>Microphone</span>
    <select value={$selectedAudioDevice} on:change={handleAudioChange}>
      {#each $audioDevices as device}
        <option value={device.deviceId}>{device.label || 'Microphone'}</option>
      {/each}
    </select>
  </label>

  <label>
    <span>Camera</span>
    <select value={$selectedVideoDevice} on:change={handleVideoChange}>
      {#each $videoDevices as device}
        <option value={device.deviceId}>{device.label || 'Camera'}</option>
      {/each}
    </select>
  </label>

  {#if $audioOutputDevices.length > 0}
    <label>
      <span>Speaker</span>
      <select value={$selectedAudioOutput} on:change={handleOutputChange}>
        {#each $audioOutputDevices as device}
          <option value={device.deviceId}>{device.label || 'Speaker'}</option>
        {/each}
      </select>
    </label>
  {/if}
</div>

<style>
  .device-settings {
    position: fixed;
    bottom: 70px;
    left: 50%;
    transform: translateX(-50%);
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1rem;
    z-index: 50;
    min-width: 280px;
    max-width: 360px;
  }

  .settings-header {
    font-weight: 600;
    font-size: 0.9rem;
    margin-bottom: 0.75rem;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin-bottom: 0.6rem;
  }

  label span {
    font-size: 0.8rem;
    color: var(--text-muted);
  }

  select {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.4rem 0.5rem;
    color: var(--text);
    font-size: 0.85rem;
    font-family: inherit;
  }

  select:focus {
    border-color: var(--accent);
    outline: none;
  }
</style>
