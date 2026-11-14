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
    isScreenSharing,
    videoEnabled,
  } from '$lib/media/manager';
  import { replaceTrackOnAllPeers, useNewMicTrack } from '$lib/webrtc/mesh';
  import { rememberDevice } from '$lib/media/device-prefs';
  import { cameraNeedsReopen, flipCamera, isTouchDevice, syncCameraFacing } from '$lib/media/call-camera';
  import Icon from '$lib/ui/Icon.svelte';
  import { onMount } from 'svelte';

  const touch = isTouchDevice();
  $: canFlip = touch && $videoEnabled && $videoDevices.length > 1;

  onMount(() => {
    enumerateDevices();
  });

  let deviceError = '';

  async function handleAudioChange(e: Event) {
    const deviceId = (e.target as HTMLSelectElement).value;
    deviceError = '';
    try {
      const track = await switchAudioDevice(deviceId);
      if (track) useNewMicTrack(track); // keeps shared-screen audio mixed in while presenting
      rememberDevice('audioInput', deviceId);
    } catch {
      deviceError = "Couldn't switch microphone — it may be in use by another app.";
    }
  }

  async function handleVideoChange(e: Event) {
    const deviceId = (e.target as HTMLSelectElement).value;
    deviceError = '';
    // The camera is released (joined with it off): don't open it now, just use this one when it's turned on.
    if (cameraNeedsReopen()) {
      selectedVideoDevice.set(deviceId);
      rememberDevice('videoInput', deviceId);
      return;
    }
    try {
      const track = await switchVideoDevice(deviceId);
      // While screen sharing, peers keep seeing the screen; the new camera is used when sharing stops.
      if (track && !$isScreenSharing) replaceTrackOnAllPeers(track, 'video');
      syncCameraFacing();
      rememberDevice('videoInput', deviceId);
    } catch {
      deviceError = "Couldn't switch camera — it may be in use by another app.";
    }
  }

  function handleOutputChange(e: Event) {
    const deviceId = (e.target as HTMLSelectElement).value;
    selectedAudioOutput.set(deviceId);
    rememberDevice('audioOutput', deviceId);
    // VideoTile applies this with setSinkId on each remote video element.
  }

  async function handleFlip() {
    deviceError = '';
    try {
      const track = await flipCamera();
      if (track && !$isScreenSharing) replaceTrackOnAllPeers(track, 'video');
    } catch {
      deviceError = "Couldn't switch camera.";
    }
  }
</script>

<div class="device-settings card fade-in" role="dialog" aria-label="Device settings">
  <div class="settings-header">Device settings</div>
  {#if deviceError}<p class="device-error" role="alert">{deviceError}</p>{/if}

  <div class="field">
    <label class="field-label" for="dev-mic">Microphone</label>
    <select id="dev-mic" class="input" value={$selectedAudioDevice} on:change={handleAudioChange}>
      {#each $audioDevices as device}
        <option value={device.deviceId}>{device.label || 'Microphone'}</option>
      {/each}
    </select>
  </div>

  <div class="field">
    <label class="field-label" for="dev-cam">Camera</label>
    <select id="dev-cam" class="input" value={$selectedVideoDevice} on:change={handleVideoChange}>
      {#each $videoDevices as device}
        <option value={device.deviceId}>{device.label || 'Camera'}</option>
      {/each}
    </select>
    {#if canFlip}
      <button type="button" class="btn small flip" on:click={handleFlip}>
        <Icon name="switch-camera" size={16} /> Switch front / back camera
      </button>
    {/if}
  </div>

  {#if $audioOutputDevices.length > 0}
    <div class="field">
      <label class="field-label" for="dev-spk">Speaker</label>
      <select id="dev-spk" class="input" value={$selectedAudioOutput} on:change={handleOutputChange}>
        {#each $audioOutputDevices as device}
          <option value={device.deviceId}>{device.label || 'Speaker'}</option>
        {/each}
      </select>
    </div>
  {/if}
</div>

<style>
  .device-settings {
    position: absolute;
    bottom: 92px;
    left: 0;
    right: 0;
    margin-inline: auto;
    z-index: 50;
    width: min(360px, calc(100% - 24px));
    padding: var(--space-4);
    background: var(--bg-overlay);
    box-shadow: var(--shadow-lg);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .settings-header {
    font-weight: 600;
    font-size: var(--text-base);
  }

  select.input {
    text-overflow: ellipsis;
  }

  @media (max-width: 640px) {
    .device-settings {
      bottom: 68px;
    }
  }
  .flip {
    margin-top: var(--space-2);
    gap: var(--space-2);
    align-self: flex-start;
  }

  .device-error {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--danger);
  }
</style>
