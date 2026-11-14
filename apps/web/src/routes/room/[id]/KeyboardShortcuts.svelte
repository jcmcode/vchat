<script lang="ts">
  // Call-screen keyboard shortcuts (keys and rules: lib/ui/shortcuts.ts). Renders nothing visible.
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import { localStream, toggleAudio, toggleVideo } from '$lib/media/manager';
  import { toggleHand, localHandRaised } from '$lib/collab/hands';
  import {
    isMacPlatform,
    isTalkKey,
    isTypingTarget,
    matchShortcut,
    spaceHasNativeAction,
    PushToTalk,
    type ShortcutAction,
  } from '$lib/ui/shortcuts';

  /** Only in the call itself (not on the pre-join, password, waiting or error screens). */
  export let enabled = false;
  /** Chat-only participants have no microphone or camera. */
  export let chatOnly = false;
  /** Space pans the whiteboard, so hold-to-talk is off while it's open. */
  export let whiteboardOpen = false;

  const dispatch = createEventDispatcher<{ chat: void; help: void }>();
  const isMac = typeof navigator !== 'undefined' && isMacPlatform(navigator as Navigator & { userAgentData?: { platform?: string } });

  function micTrack(): MediaStreamTrack | undefined {
    return chatOnly ? undefined : get(localStream)?.getAudioTracks()[0];
  }

  const ptt = new PushToTalk({
    available: () => !!micTrack(),
    isOn: () => !!micTrack()?.enabled,
    setOn: (on) => {
      const track = micTrack();
      if (track && track.enabled !== on) toggleAudio();
    },
  });

  /** Read out what a shortcut did (the buttons change silently). */
  let announcement = '';

  function release() {
    if (ptt.active) {
      ptt.release();
      announcement = 'Microphone off';
    }
  }

  function typing(e: Event): boolean {
    return isTypingTarget(e.target) || isTypingTarget(document.activeElement);
  }

  function run(action: ShortcutAction) {
    switch (action) {
      case 'toggle-mic':
        if (micTrack()) announcement = toggleAudio() ? 'Microphone on' : 'Microphone off';
        break;
      case 'toggle-camera':
        if (!chatOnly && get(localStream)?.getVideoTracks().length) announcement = toggleVideo() ? 'Camera on' : 'Camera off';
        break;
      case 'toggle-hand':
        toggleHand();
        announcement = get(localHandRaised) ? 'Hand raised' : 'Hand lowered';
        break;
      case 'toggle-chat':
        dispatch('chat');
        break;
      case 'help':
        dispatch('help');
        break;
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (ptt.active) {
      if (isTalkKey(e)) {
        e.preventDefault(); // key repeat while holding
        return;
      }
      // Hold-to-talk lasts only while Space alone is held. Any other key ends it (the mic is muted
      // again) and does nothing else, so a missed keyup can't leave the microphone open.
      release();
      return;
    }
    if (!enabled || e.defaultPrevented || e.isComposing || typing(e)) return;
    if (isTalkKey(e)) {
      if (e.repeat || whiteboardOpen || spaceHasNativeAction(e.target) || spaceHasNativeAction(document.activeElement)) return;
      if (ptt.press()) {
        e.preventDefault();
        announcement = 'Microphone on while you hold Space';
      }
      return;
    }
    const action = matchShortcut(e, isMac);
    if (!action) return;
    e.preventDefault(); // e.g. Ctrl/Cmd+D would otherwise bookmark the page
    if (!e.repeat) run(action);
  }

  function onKeyup(e: KeyboardEvent) {
    if (!ptt.active) return;
    if (isTalkKey(e)) e.preventDefault();
    release(); // Space released (or anything else let go: only Space alone may hold the mic open)
  }

  function onFocusIn(e: FocusEvent) {
    if (isTypingTarget(e.target)) release();
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'hidden') release();
  }

  $: if (!enabled || whiteboardOpen || chatOnly) release();
  onDestroy(() => ptt.release());
</script>

<svelte:window
  on:keydown={onKeydown}
  on:keyup={onKeyup}
  on:blur={release}
  on:focusin={onFocusIn}
  on:pagehide={release}
  on:contextmenu={release}
/>
<svelte:document on:visibilitychange={onVisibilityChange} />

<div class="sr-only" aria-live="polite">{announcement}</div>
