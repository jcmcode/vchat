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
    videoEnabled,
  } from '$lib/media/manager';
  import { replaceTrackOnAllPeers, useNewMicTrack } from '$lib/webrtc/mesh';
  import { rememberDevice } from '$lib/media/device-prefs';
  import { flipCamera, isTouchDevice, rememberCameraWhenInUse } from '$lib/media/call-camera';
  import { createEventDispatcher, onMount } from 'svelte';
  import Icon from '$lib/ui/Icon.svelte';
  import { annotationToolsVisible, setAnnotationToolsVisible } from '$lib/collab/annotations';

  export let theatreMode = false;
  export let chatOnly = false;

  const dispatch = createEventDispatcher<{ shortcuts: void }>();

  const touch = isTouchDevice();
  $: canFlip = touch && $videoEnabled && $videoDevices.length > 1;

  onMount(() => {
    // Chat-only guests can use view settings without camera/microphone access.
    void enumerateDevices().catch(() => {});
  });

  let deviceError = '';

  async function handleAudioChange(e: Event) {
    const deviceId = (e.target as HTMLSelectElement).value;
    deviceError = '';
    try {
      const track = await switchAudioDevice(deviceId);
      if (track) {
        useNewMicTrack(track);
        rememberDevice('audioInput', deviceId);
      }
    } catch {
      deviceError = "Couldn't switch microphone — it may be in use by another app.";
    }
  }

  async function handleVideoChange(e: Event) {
    const deviceId = (e.target as HTMLSelectElement).value;
    deviceError = '';
    try {
      // With the camera off this only remembers the choice, for when it's turned back on.
      const track = await switchVideoDevice(deviceId);
      // The camera goes out next to a shared screen, so it's switched for peers either way.
      if (track) replaceTrackOnAllPeers(track, 'video');
      // Remembered for next time only if it's the camera actually in use (now, or once turned on).
      if (track?.getSettings().deviceId === deviceId) rememberDevice('videoInput', deviceId);
      else if (!track) rememberCameraWhenInUse(deviceId);
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
      await flipCamera(); // mesh.ts follows the local stream
    } catch {
      deviceError = "Couldn't switch camera.";
    }
  }
</script>

<div class="device-settings card fade-in" role="dialog" aria-label="Call settings">
  <div class="settings-header">Call settings</div>
  {#if deviceError}<p class="device-error" role="alert">{deviceError}</p>{/if}

  {#if !chatOnly}
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
  {/if}

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

  <div class="field">
    <label class="annotation-pref">
      <input type="checkbox" checked={$annotationToolsVisible} on:change={(e) => setAnnotationToolsVisible(e.currentTarget.checked)} />
      Show screen-share annotations and tools
    </label>
    {#if theatreMode}<small>Annotations are hidden in theatre mode.</small>{/if}
  </div>

  <button type="button" class="shortcuts-link" on:click={() => dispatch('shortcuts')}>
    <Icon name="keyboard" size={15} /> Keyboard shortcuts <kbd>?</kbd>
  </button>
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
    max-height: calc(100dvh - 110px);
    overflow-y: auto;
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

  .annotation-pref {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .annotation-pref input {
    accent-color: var(--accent);
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

  .shortcuts-link {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    align-self: flex-start;
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent);
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .shortcuts-link:hover {
    text-decoration: underline;
  }

  .shortcuts-link kbd {
    padding: 0 5px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .device-error {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--danger);
  }
</style>
