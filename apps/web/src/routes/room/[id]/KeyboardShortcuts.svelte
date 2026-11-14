<script context="module" lang="ts">
  let endHold: () => void = () => {};

  /**
   * End hold-to-talk now (mic muted) and start over. Called right before the screen-share picker
   * opens: it can swallow the Space keyup without the window losing focus.
   */
  export function endHoldToTalk(): void {
    endHold();
  }
</script>

<script lang="ts">
  // Call-screen keyboard shortcuts (keys and rules: lib/ui/shortcuts.ts). Renders nothing visible.
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import { audioEnabled, localStream, toggleAudio, toggleVideo, videoEnabled, voiceOnlyMode } from '$lib/media/manager';
  import { toggleHand, localHandRaised } from '$lib/collab/hands';
  import {
    HoldToTalk,
    isMacPlatform,
    isSpaceKey,
    isTypingTarget,
    routeKeydown,
    spaceHasNativeAction,
    type ShortcutAction,
  } from '$lib/ui/shortcuts';

  /** Only in the call itself (not on the pre-join, password, waiting or error screens). */
  export let enabled = false;
  /** Chat-only participants have no microphone or camera. */
  export let chatOnly = false;
  /** Space pans the whiteboard, so hold-to-talk is off while it's open. */
  export let whiteboardOpen = false;
  /** Turn the camera on or off the way the Camera button does (it reports errors). */
  export let onToggleVideo: () => Promise<unknown> = () => toggleVideo();

  const dispatch = createEventDispatcher<{ chat: void; help: void }>();
  const isMac = typeof navigator !== 'undefined' && isMacPlatform(navigator as Navigator & { userAgentData?: { platform?: string } });

  function micTrack(): MediaStreamTrack | undefined {
    return chatOnly ? undefined : get(localStream)?.getAudioTracks()[0];
  }

  /** Same rule as the Camera button: camera off releases the track, so a missing track doesn't mean no camera. */
  function hasCamera(): boolean {
    return !chatOnly && !!get(localStream) && !get(voiceOnlyMode);
  }

  const hold = new HoldToTalk({
    available: () => !!micTrack(),
    isOn: () => !!micTrack()?.enabled,
    setOn: (on) => {
      const track = micTrack();
      if (track && track.enabled !== on) toggleAudio();
    },
  });
  endHold = () => watch(() => hold.reset());

  // The Mic button (or anything else) switching the mic during a hold drops the hold, so letting go
  // of Space doesn't undo it. Subscribed directly: the change must be seen synchronously.
  const stopWatchingMic = audioEnabled.subscribe(() => hold.micChanged());

  /** Read out what a shortcut did (the buttons change silently). */
  let announcement = '';
  /** The click that follows a pointerdown which ended a hold does nothing else. */
  let swallowNextClick = false;

  /** Run a hold transition and announce it. */
  function watch<T>(fn: () => T): T {
    const before = hold.active;
    const result = fn();
    if (!before && hold.active) announcement = 'Microphone on while you hold Space';
    else if (before && !hold.active) announcement = 'Microphone off';
    return result;
  }

  function typing(e: Event): boolean {
    return isTypingTarget(e.target) || isTypingTarget(document.activeElement);
  }

  function run(action: ShortcutAction) {
    switch (action) {
      case 'toggle-mic':
        announcement = toggleAudio() ? 'Microphone on' : 'Microphone off';
        break;
      case 'toggle-camera':
        // Asynchronous now (the camera is released and re-acquired); a press while it's starting gets the same result.
        void onToggleVideo().finally(() => (announcement = get(videoEnabled) ? 'Camera on' : 'Camera off'));
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
    swallowNextClick = false;
    const result = watch(() =>
      routeKeydown(hold, e, {
        enabled,
        typing: typing(e),
        spaceNative: spaceHasNativeAction(e.target) || spaceHasNativeAction(document.activeElement),
        defaultPrevented: e.defaultPrevented,
        whiteboardOpen,
        isMac,
        hasMic: !!micTrack(),
        hasCamera: hasCamera(),
      })
    );
    if (result.preventDefault) e.preventDefault();
    if (result.action) run(result.action);
  }

  function onKeyup(e: KeyboardEvent) {
    if (watch(() => hold.keyup(isSpaceKey(e))) === 'swallow') e.preventDefault();
  }

  function onPointerDown() {
    swallowNextClick = watch(() => hold.interrupt());
  }

  function onClickCapture(e: MouseEvent) {
    if (!swallowNextClick) return;
    swallowNextClick = false;
    e.preventDefault();
    e.stopPropagation();
  }

  function onFocusIn(e: FocusEvent) {
    if (isTypingTarget(e.target)) watch(() => hold.interrupt());
  }

  function startOver() {
    swallowNextClick = false;
    watch(() => hold.reset());
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'hidden') startOver();
  }

  $: if (!enabled || whiteboardOpen || chatOnly) startOver();
  onDestroy(() => {
    stopWatchingMic();
    hold.reset();
    endHold = () => {};
  });
</script>

<svelte:window
  on:keydown={onKeydown}
  on:keyup={onKeyup}
  on:pointerdown|capture={onPointerDown}
  on:click|capture={onClickCapture}
  on:blur={startOver}
  on:focusin={onFocusIn}
  on:pagehide={startOver}
  on:contextmenu={startOver}
/>
<svelte:document on:visibilitychange={onVisibilityChange} />

<div class="sr-only" aria-live="polite">{announcement}</div>
