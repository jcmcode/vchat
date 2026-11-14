<script lang="ts">
  // Person card: volume, "Mute for me" and pin. Only changes your own view; nothing is sent.
  import { createEventDispatcher } from 'svelte';
  import type { PeerConnection } from '$lib/webrtc/mesh';
  import { peerAudioPrefs, pinnedPeerId, setPeerMutedForMe, setPeerVolume, togglePin } from '$lib/ui/participant-prefs';
  import { DEFAULT_AUDIO_PREF } from '$lib/ui/participants';
  import Icon from '$lib/ui/Icon.svelte';

  export let peer: PeerConnection;
  /** They're on the stage right now (pinned, and nothing else took it). */
  export let onStage = false;

  const dispatch = createEventDispatcher<{ pinned: void }>();

  $: pref = $peerAudioPrefs.get(peer.id) ?? DEFAULT_AUDIO_PREF;
  $: pinned = $pinnedPeerId === peer.id;

  function onVolume(e: Event) {
    setPeerVolume(peer.id, (e.currentTarget as HTMLInputElement).valueAsNumber);
  }

  function pin() {
    const wasPinned = pinned;
    togglePin(peer.id);
    if (!wasPinned) dispatch('pinned');
  }
</script>

<div class="person-controls">
  <div class="volume-row">
    <label class="vol-label" for="person-volume">Volume</label>
    <input
      id="person-volume"
      type="range"
      min="0"
      max="100"
      step="5"
      value={pref.volume}
      aria-valuetext="{pref.volume}%"
      on:input={onVolume}
    />
    <output for="person-volume" class="vol-value">{pref.volume}%</output>
  </div>
  <div class="control-buttons">
    <button class="btn secondary" class:on={pref.muted} aria-pressed={pref.muted} on:click={() => setPeerMutedForMe(peer.id, !pref.muted)}>
      <Icon name={pref.muted ? 'volume-x' : 'volume'} size={16} /> Mute for me
    </button>
    <button class="btn secondary" class:on={pinned} on:click={pin}>
      <Icon name="pin" size={16} /> {pinned ? 'Unpin' : 'Pin to stage'}
    </button>
  </div>
  <p class="hint">
    {#if pinned && !onStage}
      Pinned. They take the stage when the whiteboard is closed and you aren't sharing your screen.
    {:else}
      Only on your screen, for this call. Nobody else is told.
    {/if}
  </p>
</div>

<style>
  .person-controls {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .volume-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .vol-label {
    font-size: var(--text-sm);
    color: var(--text-muted);
  }

  .volume-row input {
    flex: 1;
    min-width: 0;
    accent-color: var(--accent);
  }

  .vol-value {
    min-width: 3.2em;
    text-align: right;
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
  }

  .control-buttons {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-2);
  }

  .btn.on {
    border-color: var(--accent);
    color: var(--accent);
  }

  .hint {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
</style>
