<script lang="ts">
  import { page } from '$app/stores';
  import { onMount, onDestroy, tick } from 'svelte';
  import { goto, replaceState } from '$app/navigation';
  import { browser } from '$app/environment';
  import {
    peers,
    chatMessages,
    connectionState,
    admissionState,
    admissionDeniedReason,
    admitted,
    friendlyJoinError,
    hostPresent,
    passwordInvalid,
    roomError,
    onForcedOut,
    submitRoomPassword,
    admissionRequests,
    hostStatus,
    reactions as reactionsStore,
    speakingPeers,
    sharingPeers,
    localPeerIdStore,
    joinRoom,
    leaveRoom,
    sendChatMessage,
    sendFileToRoom,
    sendReaction,
    admitPeer,
    denyPeer,
    removePeer,
    startSharingScreen,
    stopSharingScreen,
    roomLocked,
    callEnded,
    roomJoined,
    isTransientRoomError,
    type PeerConnection,
  } from '$lib/webrtc/mesh';
  import { startWaitingAlerts } from '$lib/ui/attention';
  import HostControls from './HostControls.svelte';
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
    cameraStarting,
    startScreenShare,
    stopScreenShare,
    adoptMedia,
    videoDevices,
    cameraFacing,
  } from '$lib/media/manager';
  import {
    signalUrlForRoom,
    getSavedDisplayName,
    saveDisplayName,
    takePendingPassword,
    takePendingRoomName,
    takePendingJoin,
    forgetRoom,
    markRoomCreated,
    wasRoomCreated,
    rememberRoomPassword,
    recallRoomPassword,
    forgetRoomPassword,
    peerId,
    getPeerSecret,
    useRoomIdentity,
    getRelayOnly,
    ensureUniqueTabIdentity,
    fetchServerConfig,
    setRoomToken,
    getRoomToken,
    readToken,
    inviteUrl,
    getSavedRooms,
    setRoomKey,
    getRoomKey,
    roomUrl,
    apiUrl,
  } from '$lib/stores/room';
  import { whiteboardOpen, whiteboardNotice, openWhiteboard, closeWhiteboard } from '$lib/collab/whiteboard';
  import { clearScreen, annotationTool } from '$lib/collab/annotations';
  import { roomName, initRoomName, renameRoom, MAX_ROOM_NAME } from '$lib/collab/room-meta';
  import Icon from '$lib/ui/Icon.svelte';
  import VideoTile from './VideoTile.svelte';
  import { setE2EKey, verification, blockedConnections, hasRoomKey, isValidRoomKey, allowUnverified } from '$lib/webrtc/e2e';
  import { pipMode, pipOpen, pipAvailable, togglePip } from '$lib/ui/pip';
  import ConnectionDetails from './ConnectionDetails.svelte';
  import ConnectionHint from './ConnectionHint.svelte';
  import ChatPanel from './ChatPanel.svelte';
  import WaitingScreen from './WaitingScreen.svelte';
  import AdmissionPanel from './AdmissionPanel.svelte';
  import DeviceSettings from './DeviceSettings.svelte';
  import ReactionOverlay from './ReactionOverlay.svelte';
  import ReactionPicker from './ReactionPicker.svelte';
  import Whiteboard from './Whiteboard.svelte';
  import AnnotationLayer from './AnnotationLayer.svelte';
  import PreJoin from './PreJoin.svelte';
  import type { PreJoinResult } from '$lib/media/preview';
  import { shouldMirror } from '$lib/media/camera';
  import { flipCamera, isTouchDevice, reattachOnTrackChange, syncCameraFacing } from '$lib/media/call-camera';
  import { createWakeLock } from '$lib/media/wake-lock';
  import { localHandRaised, toggleHand } from '$lib/collab/hands';
  import { pinnedPeerId, unpinPeer } from '$lib/ui/participant-prefs';
  import { selectStage } from '$lib/ui/participants';
  import PersonControls from './PersonControls.svelte';
  import HandToasts from './HandToasts.svelte';
  import KeyboardShortcuts, { endHoldToTalk } from './KeyboardShortcuts.svelte';
  import ShortcutsHelp from './ShortcutsHelp.svelte';

  type JoinMode = 'video' | 'audio' | 'chat';

  let roomId = '';
  let displayName = '';
  let mediaReady = false;
  let showChat = false;
  let showDeviceSettings = false;
  let showReactionPicker = false;
  let showShortcuts = false;
  let peerList: PeerConnection[] = [];
  let localVideoEl: HTMLVideoElement;
  let localScreenEl: HTMLVideoElement;
  let stageVideoEl: HTMLVideoElement | null = null;
  let copied = false;
  let wasScreenSharing = false;
  let mediaError = '';
  let wasConnected = false;
  let unreadCount = 0;
  let lastSeenMessageCount = 0;
  let passwordAttempt = '';
  /** Chat-only: joined without camera or microphone. */
  let chatOnly = false;

  /**
   * The landing page, shown before the call: a passcode (step 1, guests with a protected invite),
   * then name + how to join (step 2). 'done' once joining; guests then wait in the lobby.
   */
  let landing: 'loading' | 'passcode' | 'name' | 'done' = 'loading';
  let hasPasscodeStep = false;
  /** The passcode is an emailed 6-digit code (personal invite), not a room password. */
  let passcodeIsCode = false;
  let passcodeValue = '';
  let passcodeError = '';
  let checkingPasscode = false;
  let landingToken: string | undefined;
  let resolvePasscode: (() => void) | null = null;
  $: passcodeReady = passcodeIsCode ? passcodeValue.replace(/\D/g, '').length === 6 : !!passcodeValue;

  /** Guests wait in a full-screen lobby, not the call, until the server lets them in. */
  let lobbyGate = false;
  let everAdmitted = false;
  $: if ($admitted) everAdmitted = true;
  $: showLobby = lobbyGate && !everAdmitted && landing === 'done';
  $: showCall = landing === 'done' && !showLobby;

  // Pre-join (step 2, PreJoin.svelte): name, how to join (video / audio / chat only), device check
  let prejoinMode: JoinMode = 'video';
  /** What the pre-join step handed over, including the already-open camera/microphone. */
  let prejoinResult: PreJoinResult | null = null;
  /** Joined with a personal invite emailed to one person (asks for their 6-digit code). */
  let personalInvite = false;
  /** Connect only through the relay server, so other participants never learn your IP address. */
  let hideIp = getRelayOnly();
  let resolvePrejoin: (() => void) | null = null;

  // Renaming the room (host only)
  let editingName = false;
  let nameDraft = '';

  function handlePrejoinJoin(e: CustomEvent<PreJoinResult>) {
    prejoinResult = e.detail;
    displayName = e.detail.name;
    saveDisplayName(displayName);
    prejoinMode = e.detail.mode;
    hideIp = e.detail.hideIp;
    landing = 'done';
    resolvePrejoin?.();
  }

  // Keep the screen on while in the call (released on leaving, removal and errors).
  const wakeLock = createWakeLock();
  let inCall = false;
  $: if (inCall && !$roomError && $admissionState !== 'denied') void wakeLock.enable();
  else wakeLock.disable();
  // A fatal error (room full, invite expired, too many password attempts…) or being denied ends the
  // call: release the camera and microphone now, not when "Back to home" is clicked.
  $: if (($roomError && !isTransientRoomError($roomError)) || $admissionState === 'denied') stopMedia();

  // Front/back camera flip on phones and tablets (mesh.ts follows the local stream).
  const touchDevice = browser && isTouchDevice();
  async function handleFlipCamera() {
    try {
      await flipCamera();
      cameraError = '';
    } catch {
      cameraError = "Couldn't switch camera.";
    }
  }

  /** Step 1: check the passcode with the server before going on (joining sends it again). */
  async function handleSubmitPasscode() {
    // Codes are digits only (people often paste them with a space in the middle).
    const code = passcodeIsCode ? passcodeValue.replace(/\D/g, '') : passcodeValue;
    if (!code || checkingPasscode) return;
    checkingPasscode = true;
    passcodeError = '';
    const accept = (required: boolean) => {
      if (required) rememberRoomPassword(roomId, code);
      passcodeValue = '';
      resolvePasscode?.();
    };
    try {
      const res = await fetch(apiUrl('/api/invite/check'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId, token: landingToken, code }),
      });
      if (destroyed) return;
      const body = (await res.json().catch(() => ({}))) as { required?: unknown; error?: unknown };
      if (res.ok) accept(body.required !== false);
      else if (res.status === 401) passcodeError = "That passcode didn't match. Check it and try again.";
      else if (res.status === 429) passcodeError = 'Too many attempts. Wait a few minutes.';
      else if (res.status === 400) {
        const reason = typeof body.error === 'string' ? body.error : '';
        roomError.set(friendlyJoinError(reason) ?? friendlyJoinError('Invalid invite') ?? "This invite link isn't valid.");
      }
      // Any other answer (an older server without this check, a proxy, a server error): go on.
      // Joining checks the passcode anyway, and asks again if it's wrong.
      else accept(true);
    } catch {
      passcodeError = "Couldn't reach the server. Check your connection and try again.";
    } finally {
      checkingPasscode = false;
    }
  }

  function handleSubmitPassword() {
    // Codes are digits only (people often paste them with a space in the middle).
    const value = personalInvite ? passwordAttempt.replace(/\D/g, '') : passwordAttempt;
    if (!value) return;
    rememberRoomPassword(roomId, value);
    submitRoomPassword(value);
    passwordAttempt = '';
  }

  function handleWindowClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (showDeviceSettings && !target.closest('.device-settings') && !target.closest('.ctrl-btn')) {
      showDeviceSettings = false;
    }
    if (showReactionPicker && !target.closest('.reaction-picker') && !target.closest('.ctrl-btn')) {
      showReactionPicker = false;
    }
  }

  $: roomId = ($page.params.id ?? '').toLowerCase();
  $: peerList = Array.from($peers.values());

  // ── Stage: whiteboard, a shared screen or the person you pinned takes the main area; tiles move to a strip ──
  // A remote screen only counts once it's actually arriving (a bare claim can't take the stage);
  // selectStage picks the latest such presenter with pickPresenter, and your pin outranks it.
  $: layout = selectStage({
    whiteboardOpen: $whiteboardOpen,
    localSharing: $isScreenSharing,
    sharingPeers: $sharingPeers,
    hasScreen: (id) => !!$peers.get(id)?.screenStream,
    peerIds: $peers.keys(),
    pinned: $pinnedPeerId,
  });
  $: stage = layout.stage;
  $: stagePeer = layout.stagePeerId ? $peers.get(layout.stagePeerId) ?? null : null;
  $: otherSharerPeer = layout.otherSharer ? $peers.get(layout.otherSharer) ?? null : null;
  // A presenter keeps their tile (camera and sound); the stage shows only their screen. A pinned
  // person's tile moves to the stage (one tile per person: it plays their sound).
  $: stripPeers = stage === 'pinned' && stagePeer ? peerList.filter((p) => p.id !== stagePeer?.id) : peerList;
  // Any other screen being shared goes in the strip, so no share is ever hidden.
  $: stripScreens = peerList.filter((p) => p.screenStream && $sharingPeers.has(p.id) && p.id !== stagePeer?.id);
  $: gridCols = getGridCols(peerList.length + 1);

  function getGridCols(count: number): number {
    if (count <= 1) return 1;
    if (count <= 4) return 2;
    return 3;
  }

  // Annotations belong to one share: clear them when that share ends.
  let prevSharers = new Set<string>();
  $: {
    for (const id of prevSharers) if (!$sharingPeers.has(id)) clearScreen(id);
    prevSharers = new Set($sharingPeers);
  }
  $: if (stage !== 'local-screen' && stage !== 'remote-screen') annotationTool.set('none');

  // onMount is async: the user can leave (or the page can unmount) while we await a prompt.
  let destroyed = false;

  let shareUrl = '';

  // ── End-to-end verification summary (header badge) ──
  // Every peer counts (a connection that hasn't opened yet is still being checked).
  $: verStates = peerList.map((p) => $verification.get(p.id)?.state ?? 'pending');
  $: unverifiedPeers = peerList.filter((p) => $verification.get(p.id)?.state === 'unverified');
  $: e2eStatus = !$hasRoomKey
    ? 'nokey'
    : verStates.some((v) => v === 'unverified' || v === 'failed' || v === 'allowed')
      ? 'partial'
      : verStates.length === 0
        ? 'ready'
        : verStates.every((v) => v === 'verified')
          ? 'verified'
          : 'checking';
  $: e2eLabel = {
    verified: 'Verified end-to-end',
    checking: 'Verifying…',
    ready: 'End-to-end encrypted',
    partial: 'Not everyone is verified',
    nokey: 'Not verified',
  }[e2eStatus];
  $: e2eTitle = {
    verified: "Every connection in this call was checked with this room's secret key: it's encrypted end to end, directly between participants, and nobody in between (including the server) can listen in. For extra certainty, compare safety codes (tap a person).",
    checking: "Checking each connection with the room's secret key. Nobody can see or hear you until their connection is verified.",
    ready: "Calls are encrypted end to end. Each person who joins is checked with the room's secret key before you can see or hear each other.",
    partial: "At least one connection couldn't be verified. Unverified people can't see or hear you unless you choose “Allow anyway”.",
    nokey: "You joined without the room's secret key (it's the part of the invite link after “#”), so connections can't be verified. Calls are still encrypted, but you can't rule out someone intercepting them.",
  }[e2eStatus];

  // ── Tap a person: private message / send a file ──
  let selectedPeerId: string | null = null;
  let chatRecipient = '';
  let personFileInput: HTMLInputElement;
  let personNotice = '';
  /** Two-step "Remove from call" (host only), so it can't happen by accident. */
  let confirmRemove = false;
  $: if (selectedPeerId !== undefined) confirmRemove = false;

  function removeSelected() {
    if (!selectedPeer) return;
    if (!confirmRemove) {
      confirmRemove = true;
      return;
    }
    removePeer(selectedPeer.id);
    selectedPeerId = null;
  }
  // (If the person leaves, the lookup returns null and the menu closes.)
  $: selectedPeer = selectedPeerId ? $peers.get(selectedPeerId) ?? null : null;

  function messagePerson(peerId: string) {
    chatRecipient = peerId;
    showChat = true;
    selectedPeerId = null;
  }

  function sendFileToPerson(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !selectedPeer) return;
    const name = selectedPeer.displayName;
    if (file.size > 50 * 1024 * 1024) personNotice = 'That file is over the 50MB limit.';
    else if (!sendFileToRoom(file, selectedPeer.id)) personNotice = `${name} can't receive files right now.`;
    else {
      personNotice = '';
      chatRecipient = selectedPeer.id;
      showChat = true; // the transfer shows up in chat
      selectedPeerId = null;
    }
  }

  function verificationText(v: string | undefined): string {
    switch (v) {
      case 'verified':
        return 'Verified: encrypted end to end, directly between you';
      case 'allowed':
        return 'Not verified: you allowed this connection anyway';
      case 'unverified':
        return "Couldn't verify: blocked unless you allow it";
      case 'failed':
        return 'Blocked: failed verification';
      case 'nokey':
        return "Not verified: you don't have the room key";
      default:
        return 'Verifying…';
    }
  }

  /**
   * Remove the invite token and key ("#...") from the address bar, history and bookmarks.
   * SvelteKit's replaceState throws if its router hasn't finished starting (fresh page loads);
   * fall back to the browser's own history API, keeping SvelteKit's state object intact.
   */
  function stripInviteFromAddressBar() {
    const clean = `/room/${roomId}`;
    if (!window.location.hash) return;
    try {
      replaceState(clean, {});
    } catch {
      history.replaceState(history.state, '', clean);
    }
  }

  onMount(async () => {
    if (!browser) return;

    // An invite link carries its token after "#invite=". Keep it for this tab only and take it out
    // of the address bar so it isn't shown, bookmarked or kept in history.
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const inviteParam = fragment.get('invite');
    if (inviteParam) {
      // A newly opened link replaces any earlier one in this tab, along with its passcode, so an
      // old code isn't replayed against the new invite.
      if (inviteParam !== getRoomToken(roomId)) forgetRoomPassword(roomId);
      setRoomToken(roomId, inviteParam);
    }
    // The room's end-to-end key (only ever in the "#" part of links, never sent to a server).
    const keyParam = fragment.get('k');
    if (isValidRoomKey(keyParam)) setRoomKey(roomId, keyParam);
    // Choices made on the home page (tab storage — URL parameters are deliberately ignored, so a
    // crafted link can't join someone to a call with their camera on).
    const pendingJoin = takePendingJoin(roomId);
    // Mark the room as ours right away, so a refresh during the pre-join screen still reopens it.
    if (pendingJoin?.creator) markRoomCreated(roomId);

    // The router must finish starting before shallow-routing calls work on a fresh page load.
    // Strip the token and key from the address bar before anything else happens.
    await tick();
    if (destroyed) return;
    stripInviteFromAddressBar();
    const config = await fetchServerConfig();
    if (destroyed) return;
    const token = getRoomToken(roomId);
    const tokenInfo = readToken(token);
    personalInvite = tokenInfo.role === 'guest' && !!tokenInfo.to;
    initRoomName(takePendingRoomName(roomId) ?? tokenInfo.label);
    const roomKey = getRoomKey(roomId);
    // Load the end-to-end key now, so the status shown before joining is already right.
    await setE2EKey(roomId, roomKey);
    if (destroyed) return;
    // A personal (emailed) invite is for one person, so it isn't offered for sharing.
    if (tokenInfo.role === 'guest' && token && !personalInvite) shareUrl = inviteUrl(roomId, token, roomKey);
    else if (tokenInfo.role === 'host') {
      const saved = getSavedRooms().find((r) => r.roomId === roomId);
      if (saved) shareUrl = inviteUrl(roomId, saved.inviteToken, saved.key ?? roomKey);
    } else if (config.mode === 'open') shareUrl = roomUrl(roomId, roomKey);

    if (config.mode === 'private' && !token) {
      roomError.set(
        config.misconfigured
          ? "The server isn't set up correctly. Tell the owner."
          : 'This is a private server. You need an invite link from the owner to join.'
      );
      return;
    }
    if (destroyed) return;

    // Guests (not hosts, and not open-mode rooms) wait in the lobby instead of the call.
    lobbyGate = config.mode === 'private' && tokenInfo.role === 'guest';

    // Step 1: a protected invite asks for its passcode first, unless this tab already has it (a
    // refresh). If what we have has gone stale, the server asks again and the password dialog shows.
    hasPasscodeStep = tokenInfo.role === 'guest' && !!tokenInfo.hasPassword && !recallRoomPassword(roomId);
    if (hasPasscodeStep) {
      landingToken = token;
      passcodeIsCode = personalInvite;
      landing = 'passcode';
      await new Promise<void>((resolve) => (resolvePasscode = resolve));
      if (destroyed) return;
    }

    // Step 2 (pre-join): confirm your name and choose video, audio only or chat only.
    // Skipped when coming from the home page, where those choices were just made.
    displayName = pendingJoin?.name || getSavedDisplayName();
    prejoinMode = pendingJoin?.mode ?? 'video';
    if (!pendingJoin || !displayName) {
      landing = 'name';
      await new Promise<void>((resolve) => (resolvePrejoin = resolve));
    }
    if (destroyed) return;
    landing = 'done';
    chatOnly = prejoinMode === 'chat';

    // Open mode only: the creator makes the room. In private mode the token decides everything.
    const isCreator = config.mode === 'open' && wasRoomCreated(roomId);
    const password = takePendingPassword() ?? recallRoomPassword(roomId);
    if (password) rememberRoomPassword(roomId, password);

    if (!chatOnly) {
      try {
        // Use the devices the pre-join check already opened (with your mute/camera-off choices).
        if (prejoinResult?.stream) {
          await adoptMedia(prejoinResult.stream, {
            audio: prejoinResult.micOn,
            video: prejoinResult.camOn,
            voiceOnly: prejoinResult.voiceOnly,
            videoDeviceId: prejoinResult.videoDeviceId,
            facing: prejoinResult.facing,
          });
        } else {
          await startMedia({ voiceOnly: prejoinMode === 'audio' });
          syncCameraFacing();
        }
        if (destroyed) {
          stopMedia(); // left during the camera prompt — release the camera again
          return;
        }
        mediaReady = true;
      } catch (err) {
        console.error('Failed to get media:', err);
        if (err instanceof DOMException) {
          if (err.name === 'NotAllowedError') {
            mediaError = 'Camera/microphone access was denied. You can still chat — check your browser permissions to talk.';
          } else if (err.name === 'NotFoundError') {
            mediaError = 'No camera or microphone found on this device. You can still chat.';
          } else {
            mediaError = `Media error: ${err.message}`;
          }
        } else {
          mediaError = 'Could not access camera or microphone.';
        }
        mediaReady = true;
      }
    }

    if (destroyed) return;

    useRoomIdentity(roomId);
    await ensureUniqueTabIdentity(roomId);
    if (destroyed) return;

    inCall = true;
    await joinRoom({
      serverUrl: signalUrlForRoom(roomId),
      roomId,
      peerId: $peerId,
      secret: getPeerSecret(),
      displayName,
      isCreator,
      password,
      token,
      relayOnly: hideIp,
    });
    // Anything already in the chat at this point isn't "unread".
    lastSeenMessageCount = $chatMessages.length;
    if (chatOnly) showChat = true;
  });

  onDestroy(() => {
    destroyed = true;
    wakeLock.disable();
    if (browser) {
      leaveRoom();
      stopMedia();
      prejoinResult?.stream?.getTracks().forEach((t) => t.stop()); // handed over but not yet used
      // Leaving the page (any way except a reload) forgets this call's chat, password and keys.
      if (roomId) forgetRoom(roomId);
    }
  });

  // Removed by the host, or replaced by another tab: the call has already been torn down. Release
  // the camera and microphone and forget this call's invite, key and password right away, rather
  // than when "Back to home" is clicked (which may never happen if the tab is just closed).
  const stopWatchingForcedOut = onForcedOut(() => {
    inCall = false;
    wakeLock.disable();
    stopMedia();
    if (roomId) forgetRoom(roomId);
  });
  onDestroy(stopWatchingForcedOut);

  // Host: chime, flash the tab title and (opt-in) notify when someone is waiting to join.
  onDestroy(startWaitingAlerts(admissionRequests));

  function handleLeave() {
    leaveRoom();
    stopMedia();
    forgetRoom(roomId); // pressing Leave forgets this call's chat, password and invite in this tab
    goto('/');
  }

  function handleCancelWaiting() {
    leaveRoom();
    stopMedia();
    forgetRoom(roomId);
    goto('/');
  }

  function handleToggleAudio() {
    toggleAudio();
  }

  /** Why the camera didn't turn back on (busy, unplugged, blocked). */
  let cameraError = '';

  async function handleToggleVideo() {
    try {
      await toggleVideo();
      cameraError = '';
    } catch (err) {
      cameraError = err instanceof Error ? err.message : "Couldn't turn the camera on.";
    }
  }

  let meshStopCalled = false;

  async function handleScreenShare() {
    if ($isScreenSharing) {
      stopSharingScreen();
      meshStopCalled = true;
      stopScreenShare();
    } else {
      meshStopCalled = false;
      endHoldToTalk(); // the picker can swallow the Space keyup
      const stream = await startScreenShare();
      // The call ended (or we were removed) while the picker was open: don't start presenting.
      if (stream && (destroyed || !$roomJoined || $roomError)) {
        stopScreenShare();
        return;
      }
      if (stream) {
        startSharingScreen();
      }
    }
  }

  function toggleWhiteboard() {
    if ($whiteboardOpen) closeWhiteboard();
    else openWhiteboard();
  }

  function copyLink() {
    if (!shareUrl) return;
    navigator.clipboard.writeText(shareUrl).catch(() => {});
    copied = true;
    setTimeout(() => { copied = false; }, 2000);
  }

  function startRename() {
    if (!$hostStatus) return;
    nameDraft = $roomName;
    editingName = true;
  }

  function commitRename() {
    if (editingName) renameRoom(nameDraft);
    editingName = false;
  }

  function onRenameKey(e: KeyboardEvent) {
    if (e.key === 'Enter') commitRename();
    else if (e.key === 'Escape') editingName = false;
  }

  function focusOnMount(node: HTMLInputElement) {
    node.focus();
    node.select();
  }

  $: {
    if (wasScreenSharing && !$isScreenSharing && !meshStopCalled) {
      stopSharingScreen();
    }
    if (!$isScreenSharing) {
      meshStopCalled = false;
      if (wasScreenSharing && $localPeerIdStore) clearScreen($localPeerIdStore);
    }
    wasScreenSharing = $isScreenSharing;
  }

  // Your own tile always shows your camera; your shared screen appears on the stage.
  $: if (localVideoEl && $localStream && localVideoEl.srcObject !== $localStream) {
    localVideoEl.srcObject = $localStream;
  }
  $: if (localVideoEl) reattachOnTrackChange(localVideoEl, $localStream?.getVideoTracks()[0]);
  $: if (localScreenEl && $screenStream && localScreenEl.srcObject !== $screenStream) {
    localScreenEl.srcObject = $screenStream;
  }

  // Redirect on denied admission (cancelled if the page goes away first)
  let deniedTimer: ReturnType<typeof setTimeout> | null = null;
  $: if ($admissionState === 'denied' && !deniedTimer) {
    deniedTimer = setTimeout(() => {
      leaveRoom();
      stopMedia();
      goto('/');
    }, 3000);
  }
  onDestroy(() => {
    if (deniedTimer) clearTimeout(deniedTimer);
  });

  $: localSpeaking = $speakingPeers.has('local');
  $: localHasVideo = !chatOnly && !$voiceOnlyMode && $videoEnabled && !!$localStream?.getVideoTracks().length;
  $: canFlipCamera = touchDevice && localHasVideo && $videoDevices.length > 1;

  // Track unread messages when chat is closed
  $: {
    if (showChat) {
      lastSeenMessageCount = $chatMessages.length;
      unreadCount = 0;
    } else if ($chatMessages.length > lastSeenMessageCount) {
      unreadCount = $chatMessages.length - lastSeenMessageCount;
    }
  }

  $: {
    if ($connectionState === 'connected') wasConnected = true;
  }
  $: showReconnecting = wasConnected && $connectionState === 'disconnected';
  // Keyboard shortcuts work in the call itself, not on the landing, password, waiting or error screens.
  $: shortcutsEnabled = showCall && !$roomError && $admissionState === 'none' && (mediaReady || chatOnly);
</script>

{#if landing !== 'done'}
  <main class="landing">
    <section class="landing-card card fade-in" class:wide={landing === 'name'} aria-labelledby="landing-title">
      <header class="landing-head">
        <h1 id="landing-title">{$roomName || 'Join the call'}</h1>
        <span class="chip"><Icon name="lock" size={12} /> End-to-end encrypted</span>
      </header>
      {#if hasPasscodeStep && landing !== 'loading'}
        <ol class="steps">
          <li class:current={landing === 'passcode'} class:done={landing === 'name'} aria-current={landing === 'passcode' ? 'step' : undefined}>
            <span class="step-num" aria-hidden="true">{#if landing === 'name'}<Icon name="check" size={12} />{:else}1{/if}</span>
            Passcode
          </li>
          <li class:current={landing === 'name'} aria-current={landing === 'name' ? 'step' : undefined}>
            <span class="step-num" aria-hidden="true">2</span>
            Your name
          </li>
        </ol>
      {/if}

      {#if landing === 'loading'}
        <p class="landing-loading" role="status">
          <span class="landing-spinner" aria-hidden="true"></span> Loading…
        </p>
      {:else if landing === 'passcode'}
        <form class="step" on:submit|preventDefault={handleSubmitPasscode} aria-labelledby="passcode-title" novalidate>
          <h2 id="passcode-title">Enter your passcode</h2>
          <p class="step-sub" id="passcode-help">
            {passcodeIsCode ? 'Type the 6-digit code from your invite email.' : 'Type the room password the host gave you.'}
          </p>
          <label class="sr-only" for="passcode-input">{passcodeIsCode ? '6-digit code' : 'Room password'}</label>
          {#if passcodeIsCode}
            <!-- svelte-ignore a11y-autofocus -->
            <input
              id="passcode-input"
              class="input code-input"
              type="text"
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength="7"
              placeholder="123456"
              bind:value={passcodeValue}
              on:input={() => (passcodeError = '')}
              aria-invalid={passcodeError ? 'true' : undefined}
              aria-describedby={passcodeError ? 'passcode-error' : 'passcode-help'}
              autofocus
            />
          {:else}
            <!-- svelte-ignore a11y-autofocus -->
            <input
              id="passcode-input"
              class="input"
              type="text"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              placeholder="Room password"
              bind:value={passcodeValue}
              on:input={() => (passcodeError = '')}
              aria-invalid={passcodeError ? 'true' : undefined}
              aria-describedby={passcodeError ? 'passcode-error' : 'passcode-help'}
              autofocus
            />
          {/if}
          {#if passcodeError}<p id="passcode-error" class="step-error" role="alert">{passcodeError}</p>{/if}
          <div class="dialog-actions">
            <button type="button" class="btn ghost" on:click={() => goto('/')}>Cancel</button>
            <button type="submit" class="btn primary" disabled={!passcodeReady || checkingPasscode}>
              {checkingPasscode ? 'Checking…' : 'Continue'}
            </button>
          </div>
        </form>
      {:else}
        <PreJoin
          initialName={displayName}
          initialMode={prejoinMode}
          {hideIp}
          on:join={handlePrejoinJoin}
          on:cancel={() => goto('/')}
        />
      {/if}
    </section>
  </main>
{/if}

{#if showLobby}
  <WaitingScreen
    page
    connecting={$admissionState !== 'waiting'}
    hostPresent={$hostPresent}
    roomName={$roomName}
    {displayName}
    previewStream={chatOnly ? null : $localStream}
    on:cancel={handleCancelWaiting}
  />
{:else if $admissionState === 'waiting'}
  <WaitingScreen hostPresent={$hostPresent} on:cancel={handleCancelWaiting} />
{/if}

{#if $admissionState === 'denied'}
  <div class="overlay">
    <div class="dialog card fade-in center" role="alertdialog" aria-modal="true" aria-labelledby="denied-title">
      <div class="dialog-icon danger"><Icon name="x" size={22} /></div>
      <h2 id="denied-title">Couldn't join</h2>
      <p class="dialog-sub">{$admissionDeniedReason || 'You were not admitted to this room.'} Redirecting...</p>
    </div>
  </div>
{:else if $roomError}
  <div class="overlay">
    <div class="dialog card fade-in center" role="alertdialog" aria-modal="true" aria-labelledby="error-title">
      <div class="dialog-icon danger"><Icon name={$callEnded ? 'phone-off' : 'x'} size={22} /></div>
      <h2 id="error-title">{$callEnded ? 'Call ended' : "Couldn't join"}</h2>
      <p class="dialog-sub">{$roomError}</p>
      <div class="dialog-actions">
        <button class="btn primary" on:click={handleLeave}>Back to home</button>
      </div>
    </div>
  </div>
{:else if $admissionState === 'password'}
  <div class="overlay">
    <form
      class="dialog card fade-in center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="password-title"
      on:submit|preventDefault={handleSubmitPassword}
    >
      <div class="dialog-icon"><Icon name="lock" size={22} /></div>
      {#if personalInvite}
        <h2 id="password-title">Enter your code</h2>
        <p class="dialog-sub" class:invalid={$passwordInvalid} role={$passwordInvalid ? 'alert' : undefined}>
          {$passwordInvalid ? "That code didn't match. Check the email and try again." : 'Type the 6-digit code from your invite email.'}
        </p>
        <!-- svelte-ignore a11y-autofocus -->
        <input
          class="input code-input"
          type="text"
          inputmode="numeric"
          maxlength="7"
          bind:value={passwordAttempt}
          placeholder="123456"
          aria-label="6-digit code"
          autocomplete="one-time-code"
          autofocus
        />
      {:else}
        <h2 id="password-title">Password required</h2>
        <p class="dialog-sub" class:invalid={$passwordInvalid} role={$passwordInvalid ? 'alert' : undefined}>
          {$passwordInvalid ? 'That password was wrong. Try again.' : 'This room is password protected.'}
        </p>
        <!-- svelte-ignore a11y-autofocus -->
        <input
          class="input"
          type="password"
          bind:value={passwordAttempt}
          placeholder="Room password"
          aria-label="Room password"
          autocomplete="off"
          autofocus
        />
      {/if}
      <div class="dialog-actions">
        <button type="button" class="btn ghost" on:click={handleLeave}>Cancel</button>
        <button type="submit" class="btn primary" disabled={!passwordAttempt}>Join</button>
      </div>
    </form>
  </div>
{/if}

{#if showCall}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="room" on:click={handleWindowClick}>
    <header>
      <div class="room-info">
        <span
          class="status-dot"
          class:connected={$connectionState === 'connected'}
          class:disconnected={$connectionState === 'disconnected'}
          title={$connectionState}
          role="status"
        >
          <span class="sr-only">{$connectionState}</span>
        </span>
        {#if editingName}
          <input
            class="rename-input input"
            bind:value={nameDraft}
            maxlength={MAX_ROOM_NAME}
            placeholder="Room name"
            aria-label="Room name"
            on:keydown={onRenameKey}
            on:blur={commitRename}
            use:focusOnMount
          />
        {:else if $hostStatus}
          <button class="room-id renamable" title="Rename this room for everyone" on:click={startRename}>
            <span class="room-id-text">{$roomName || roomId}</span>
            <span class="pen"><Icon name="pen" size={14} /></span>
            <span class="sr-only">Rename room</span>
          </button>
        {:else}
          <h1 class="room-id" title={roomId}>{$roomName || roomId}</h1>
        {/if}
        {#if $hostStatus}
          <HostControls locked={$roomLocked} connected={$roomJoined} />
        {/if}
        {#if $roomLocked}
          <span class="chip warning" title="The host locked this call: nobody new can join" role="status">
            <Icon name="lock" size={11} /> Locked
          </span>
        {/if}
      </div>
      <div class="header-end">
        <span class="e2e-badge {e2eStatus}" title={e2eTitle} role="status">
          <Icon name={e2eStatus === 'partial' || e2eStatus === 'nokey' ? 'shield-alert' : e2eStatus === 'verified' ? 'shield-check' : 'shield'} size={15} />
          <span class="e2e-label">{e2eLabel}</span>
        </span>
        {#if shareUrl}
          <button class="btn small copy-btn" class:copied on:click={copyLink} title="Copy a link others can use to join">
            <Icon name={copied ? 'check' : 'link'} size={15} />
            <span class="copy-label">{copied ? 'Copied!' : 'Copy invite link'}</span>
          </button>
        {/if}
        <div class="peer-count" title="Participants">
          <Icon name="users" size={16} />
          <span aria-hidden="true">{peerList.length + 1}</span>
          <span class="sr-only">{peerList.length + 1} in call</span>
        </div>
      </div>
    </header>

    {#each $blockedConnections as blocked (blocked.peerId)}
      <div class="banner danger" role="alert">
        <Icon name="shield-alert" size={16} />
        Blocked the connection to {blocked.name}: {blocked.reason}. Someone may be trying to intercept the call. Share a fresh invite link through a channel you trust.
      </div>
    {/each}

    {#each unverifiedPeers as up (up.id)}
      <div class="banner warning" role="alert">
        <Icon name="shield-alert" size={16} />
        <span>
          Couldn't verify <strong>{up.displayName}</strong> ({$verification.get(up.id)?.reason ?? 'no proof'}). You can't see or hear each other
          until they're verified. The name shown is not proof of who this is. Only allow it if you've confirmed, outside this call, that it's
          really them and why they have no key: an unverified connection can be listened to by someone in the middle.
        </span>
        <button class="btn small secondary" on:click={() => allowUnverified(up.id)}>Allow anyway</button>
      </div>
    {/each}

    {#if showReconnecting}
      <div class="banner warning" role="status">
        <span class="reconnect-spinner"></span>
        Connection lost. Reconnecting...
      </div>
    {/if}

    <ConnectionHint />

    {#if mediaError}
      <div class="banner danger" role="alert">
        {mediaError}
      </div>
    {/if}

    {#if cameraError}
      <div class="banner danger" role="alert">
        <span>{cameraError}</span>
        <button class="banner-dismiss" on:click={() => (cameraError = '')} aria-label="Dismiss">
          <Icon name="x" size={14} />
        </button>
      </div>
    {/if}

    {#if $whiteboardNotice && !$whiteboardOpen}
      <div class="banner info" role="status">
        <Icon name="whiteboard" size={16} />
        <span>{$whiteboardNotice.name} opened the whiteboard.</span>
        <button class="banner-btn" on:click={openWhiteboard}>Open it</button>
        <button class="banner-dismiss" on:click={() => whiteboardNotice.set(null)} aria-label="Dismiss">
          <Icon name="x" size={14} />
        </button>
      </div>
    {/if}

    <div class="room-body">
      <div class="call-col">
        <main class="call-area" class:has-stage={!!stage}>
          {#if stage}
            <section class="stage" aria-label={stage === 'whiteboard' ? 'Whiteboard' : stage === 'pinned' ? 'Pinned participant' : 'Shared screen'}>
              {#if stage === 'whiteboard'}
                <Whiteboard on:close={closeWhiteboard} />
              {:else if stage === 'local-screen'}
                <div class="stage-screen">
                  <!-- svelte-ignore a11y-media-has-caption -->
                  <video bind:this={localScreenEl} autoplay muted playsinline></video>
                  <span class="tile-name"><span class="name-text">You are presenting</span></span>
                  {#if $localPeerIdStore}
                    <AnnotationLayer videoEl={localScreenEl} screen={$localPeerIdStore} />
                  {/if}
                </div>
              {:else if stage === 'pinned' && stagePeer}
                {#key stagePeer.id}
                  <VideoTile
                    peerConnection={stagePeer}
                    speaking={$speakingPeers.has(stagePeer.id)}
                    contain
                    verification={$verification.get(stagePeer.id)?.state}
                    selectable
                    on:select={() => (selectedPeerId = stagePeer?.id ?? null)}
                  />
                {/key}
                <button class="stage-btn" on:click={unpinPeer} title="Put {stagePeer.displayName} back with everyone else">
                  <Icon name="pin" size={14} /> Unpin
                </button>
                {#if otherSharerPeer}
                  <button class="stage-sharing-btn" on:click={unpinPeer} title="Unpin {stagePeer.displayName} and show the shared screen">
                    <Icon name="screen-share" size={14} />
                    <span class="sharing-name">{otherSharerPeer.displayName}</span> is sharing · View
                  </button>
                {/if}
              {:else if stagePeer}
                {#key stagePeer.id}
                  <VideoTile
                    peerConnection={stagePeer}
                    speaking={$speakingPeers.has(stagePeer.id)}
                    contain
                    screen
                    presenting
                    verification={$verification.get(stagePeer.id)?.state}
                    bind:videoEl={stageVideoEl}
                    selectable
                    on:select={() => (selectedPeerId = stagePeer?.id ?? null)}
                  >
                    <AnnotationLayer videoEl={stageVideoEl} screen={stagePeer.id} />
                  </VideoTile>
                {/key}
                <button class="stage-btn" on:click={() => (selectedPeerId = stagePeer?.id ?? null)} aria-label="Options for {stagePeer.displayName}: volume, mute for me, pin">
                  <Icon name="more-horizontal" size={14} /> Options
                </button>
              {/if}
            </section>
          {/if}

          <div class={stage ? 'tile-strip' : 'video-grid'} style={stage ? '' : `--cols: ${gridCols}`}>
            <div class="tile self" class:speaking={localSpeaking}>
              {#if localHasVideo}
                <video bind:this={localVideoEl} class:unmirrored={!shouldMirror($cameraFacing)} autoplay muted playsinline></video>
                {#if canFlipCamera}
                  <button class="flip-btn" on:click={handleFlipCamera} title="Switch camera" aria-label="Switch between front and back camera">
                    <Icon name="switch-camera" size={18} />
                  </button>
                {/if}
              {:else}
                <div class="no-video">
                  <span class="avatar">{displayName.charAt(0).toUpperCase()}</span>
                </div>
              {/if}
              {#if $localHandRaised}
                <span class="hand-badge" title="Your hand is raised"><Icon name="hand" size={15} /><span class="sr-only">Your hand is raised</span></span>
              {/if}
              <span class="tile-name">
                <span class="name-text">{displayName} (you){chatOnly ? ' · chat only' : ''}</span>
                {#if !chatOnly && !$audioEnabled}
                  <span class="muted-icon" title="Muted"><Icon name="mic-off" size={13} /><span class="sr-only">Muted</span></span>
                {/if}
              </span>
            </div>

            {#each stripPeers as pc (pc.id)}
              <VideoTile
                peerConnection={pc}
                speaking={$speakingPeers.has(pc.id)}
                presenting={$sharingPeers.has(pc.id)}
                verification={$verification.get(pc.id)?.state}
                selectable
                on:select={() => (selectedPeerId = pc.id)}
              />
            {/each}

            {#each stripScreens as pc (pc.id)}
              <VideoTile peerConnection={pc} contain screen presenting verification={$verification.get(pc.id)?.state} />
            {/each}
          </div>
        </main>

        {#if $hostStatus && $admissionRequests.length > 0}
          <AdmissionPanel
            requests={$admissionRequests}
            on:admit={(e) => admitPeer(e.detail)}
            on:deny={(e) => denyPeer(e.detail)}
          />
        {/if}

        <ReactionOverlay reactions={$reactionsStore} />

        {#if showDeviceSettings}
          <DeviceSettings on:shortcuts={() => { showDeviceSettings = false; showShortcuts = true; }} />
        {/if}

        <HandToasts />

        {#if showReactionPicker}
          <ReactionPicker on:react={(e) => { sendReaction(e.detail); showReactionPicker = false; }} />
        {/if}

        <footer>
          <div class="controls" role="group" aria-label="Call controls">
            {#if !chatOnly && $localStream?.getAudioTracks().length}
              <button
                class="ctrl-btn"
                class:off={!$audioEnabled}
                aria-pressed={$audioEnabled}
                on:click={handleToggleAudio}
                title={$audioEnabled ? 'Mute' : 'Unmute'}
              >
                <Icon name={$audioEnabled ? 'mic' : 'mic-off'} size={22} />
                <span class="ctrl-label">Mic</span>
              </button>
            {/if}

            {#if !chatOnly && $localStream && !$voiceOnlyMode}
              <button
                class="ctrl-btn"
                class:off={!$videoEnabled}
                aria-pressed={$videoEnabled}
                disabled={$cameraStarting}
                on:click={handleToggleVideo}
                title={$videoEnabled ? 'Camera off' : 'Camera on'}
              >
                <Icon name={$videoEnabled ? 'video' : 'video-off'} size={22} />
                <span class="ctrl-label">Camera</span>
              </button>
            {/if}

            {#if !chatOnly}
              <button
                class="ctrl-btn"
                class:active={$isScreenSharing}
                aria-pressed={$isScreenSharing}
                on:click={handleScreenShare}
                title={$isScreenSharing ? 'Stop sharing' : 'Share screen'}
              >
                <Icon name={$isScreenSharing ? 'screen-share-off' : 'screen-share'} size={22} />
                <span class="ctrl-label">{$isScreenSharing ? 'Stop' : 'Share'}</span>
              </button>
            {/if}

            <button
              class="ctrl-btn"
              class:active={$whiteboardOpen}
              aria-pressed={$whiteboardOpen}
              on:click={toggleWhiteboard}
              title={$whiteboardOpen ? 'Hide whiteboard' : 'Open the shared whiteboard'}
            >
              <Icon name="whiteboard" size={22} />
              <span class="ctrl-label">Board</span>
            </button>

            {#if pipMode}
              <button
                class="ctrl-btn"
                class:active={$pipOpen}
                aria-pressed={$pipOpen}
                disabled={!$pipAvailable}
                on:click={() => togglePip({ displayName, chatOnly, onToggleAudio: handleToggleAudio, onToggleVideo: handleToggleVideo, onLeave: handleLeave })}
                title={$pipOpen ? 'Close the pop-out window' : $pipAvailable ? 'Pop the call out into a small window that stays on top' : 'No video to pop out yet'}
              >
                <Icon name="pip" size={22} />
                <span class="ctrl-label">Pop out</span>
              </button>
            {/if}

            <button
              class="ctrl-btn"
              class:active={showChat}
              aria-pressed={showChat}
              on:click={() => { showChat = !showChat; }}
              title="Chat"
            >
              <Icon name="message" size={22} />
              <span class="ctrl-label">Chat</span>
              {#if unreadCount > 0 && !showChat}
                <span class="unread-badge" aria-hidden="true">{unreadCount > 99 ? '99+' : unreadCount}</span>
                <span class="sr-only">{unreadCount} unread</span>
              {/if}
            </button>

            <button
              class="ctrl-btn"
              class:active={showReactionPicker}
              aria-pressed={showReactionPicker}
              aria-haspopup="true"
              on:click={() => { showReactionPicker = !showReactionPicker; showDeviceSettings = false; }}
              title="React"
            >
              <Icon name="smile" size={22} />
              <span class="ctrl-label">React</span>
            </button>

            <button
              class="ctrl-btn"
              class:active={$localHandRaised}
              aria-pressed={$localHandRaised}
              on:click={toggleHand}
              title={$localHandRaised ? 'Lower your hand' : 'Raise your hand'}
              aria-keyshortcuts="Control+Alt+H Control+Meta+H"
            >
              <Icon name="hand" size={22} />
              <span class="ctrl-label">Hand</span>
            </button>

            {#if !chatOnly}
              <button
                class="ctrl-btn"
                class:active={showDeviceSettings}
                aria-pressed={showDeviceSettings}
                aria-haspopup="true"
                on:click={() => { showDeviceSettings = !showDeviceSettings; showReactionPicker = false; }}
                title="Settings"
              >
                <Icon name="settings" size={22} />
                <span class="ctrl-label">Settings</span>
              </button>
            {/if}

            <span class="ctrl-sep" aria-hidden="true"></span>

            <button class="ctrl-btn leave" on:click={handleLeave} title="Leave call">
              <Icon name="phone-off" size={22} />
              <span class="ctrl-label">Leave</span>
            </button>
          </div>
        </footer>
      </div>

      {#if selectedPeer}
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <div class="person-backdrop" on:click|self={() => (selectedPeerId = null)}>
          <div class="person-card" role="dialog" aria-modal="true" aria-label="Actions for {selectedPeer.displayName}">
            <div class="person-head">
              <span class="person-avatar">{selectedPeer.displayName.charAt(0).toUpperCase()}</span>
              <div>
                <strong>{selectedPeer.displayName}</strong>
                <p class="person-ver {$verification.get(selectedPeer.id)?.state ?? 'pending'}">
                  <Icon name={$verification.get(selectedPeer.id)?.state === 'verified' ? 'shield-check' : 'shield-alert'} size={13} />
                  {verificationText($verification.get(selectedPeer.id)?.state)}
                </p>
              </div>
              <button class="btn ghost small icon" on:click={() => (selectedPeerId = null)} aria-label="Close"><Icon name="x" size={16} /></button>
            </div>
            <div class="person-actions">
              <button class="btn secondary" on:click={() => selectedPeer && messagePerson(selectedPeer.id)}>
                <Icon name="message" size={16} /> Message privately
              </button>
              <button class="btn secondary" on:click={() => personFileInput.click()} disabled={!selectedPeer.connected}>
                <Icon name="paperclip" size={16} /> Send a file
              </button>
              <input type="file" bind:this={personFileInput} on:change={sendFileToPerson} hidden />
            </div>
            <PersonControls
              peer={selectedPeer}
              onStage={stagePeer?.id === selectedPeer.id}
              on:pinned={() => (selectedPeerId = null)}
            />
            {#if $verification.get(selectedPeer.id)?.code}
              <div class="safety-code">
                <span class="muted">Safety code</span>
                <strong>{$verification.get(selectedPeer.id)?.code}</strong>
                <p>Read all of it to {selectedPeer.displayName} (by voice, or another app). If you both see the same code, nobody is in the middle of your connection.</p>
              </div>
            {/if}
            <ConnectionDetails peerId={selectedPeer.id} />
            {#if $verification.get(selectedPeer.id)?.state === 'unverified'}
              <button class="btn secondary" on:click={() => selectedPeer && allowUnverified(selectedPeer.id)}>
                <Icon name="shield-alert" size={16} /> Allow this unverified connection
              </button>
            {/if}
            {#if $hostStatus}
              <button class="btn danger-ghost" on:click={removeSelected}>
                <Icon name="x" size={16} />
                {confirmRemove ? `Tap again to remove ${selectedPeer.displayName}` : 'Remove from call'}
              </button>
            {/if}
            {#if personNotice}<p class="person-notice" role="alert">{personNotice}</p>{/if}
            <p class="person-foot">Only {selectedPeer.displayName} receives it, encrypted straight from your device.</p>
          </div>
        </div>
      {/if}

      {#if showChat}
        <ChatPanel
          messages={$chatMessages}
          bind:recipient={chatRecipient}
          on:close={() => { showChat = false; }}
        />
      {/if}
    </div>
  </div>
{/if}

<KeyboardShortcuts
  enabled={shortcutsEnabled}
  {chatOnly}
  whiteboardOpen={$whiteboardOpen}
  onToggleVideo={handleToggleVideo}
  on:chat={() => { showChat = !showChat; }}
  on:help={() => { showShortcuts = !showShortcuts; }}
/>
{#if showShortcuts}
  <ShortcutsHelp on:close={() => (showShortcuts = false)} />
{/if}

<style>
  /* ── Landing (before the call): passcode, then name ─────────────────── */
  /* The page itself doesn't scroll (body is overflow: hidden), so the landing does. */
  .landing {
    height: 100vh;
    height: 100dvh;
    display: flex;
    flex-direction: column;
    padding: var(--space-6) var(--space-4);
    overflow-y: auto;
    background:
      radial-gradient(ellipse 70% 40% at 50% 0%, var(--accent-soft), transparent 70%),
      var(--bg);
  }

  .landing-card {
    margin: auto;
    width: min(100%, 440px);
    padding: var(--space-6);
    box-shadow: var(--shadow-lg);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  /* The pre-join step has a camera preview next to the form. */
  .landing-card.wide {
    width: min(100%, 820px);
  }

  .landing-head {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-2);
  }

  .landing-head h1 {
    font-size: var(--text-xl);
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--text);
    overflow-wrap: anywhere;
  }

  .steps {
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-4);
    font-size: var(--text-sm);
    color: var(--text-subtle);
  }

  .steps li {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }

  .steps li.current {
    color: var(--text);
    font-weight: 500;
  }

  .steps li.done {
    color: var(--text-muted);
  }

  .step-num {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: 1px solid var(--border-strong);
    font-size: var(--text-xs);
    font-weight: 600;
  }

  .steps li.current .step-num {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-text);
  }

  .steps li.done .step-num {
    background: var(--success-soft);
    border-color: transparent;
    color: var(--success);
  }

  .step {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding-top: var(--space-4);
    border-top: 1px solid var(--border-subtle);
  }

  .step h2 {
    font-size: var(--text-lg);
    font-weight: 600;
    color: var(--text);
  }

  .step-sub {
    color: var(--text-muted);
    font-size: var(--text-sm);
    margin-top: calc(var(--space-2) * -1);
  }

  .step-error {
    color: var(--danger);
    font-size: var(--text-sm);
  }

  .landing-loading {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  .landing-spinner {
    width: 16px;
    height: 16px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: landing-spin 0.8s linear infinite;
  }

  @keyframes landing-spin {
    to { transform: rotate(360deg); }
  }

  @media (max-width: 480px) {
    .landing {
      padding: var(--space-4);
    }
    .landing-card {
      padding: var(--space-5);
    }
    .step .dialog-actions .btn {
      flex: 1;
    }
  }

  .room {
    height: 100vh;
    height: 100dvh;
    display: flex;
    flex-direction: column;
    background: var(--bg);
  }

  /* ── Header ─────────────────────────────────────────────────────────── */
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    min-height: 56px;
    padding: var(--space-2) var(--space-4);
    background: var(--bg-surface);
    border-bottom: 1px solid var(--border-subtle);
    flex-shrink: 0;
  }

  .room-info,
  .header-end {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
  }

  .header-end {
    flex-shrink: 0;
  }

  .room-id {
    font-size: var(--text-lg);
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--text);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status-dot {
    width: 9px;
    height: 9px;
    flex-shrink: 0;
    border-radius: 50%;
    background: var(--warning);
    box-shadow: 0 0 0 3px var(--warning-soft);
  }

  .status-dot.connected {
    background: var(--success);
    box-shadow: 0 0 0 3px var(--success-soft);
  }

  .status-dot.disconnected {
    background: var(--danger);
    box-shadow: 0 0 0 3px var(--danger-soft);
  }

  .renamable {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 40px;
    background: transparent;
    border: 1px solid transparent;
    color: var(--text);
    padding: 0 var(--space-2);
    margin-left: calc(var(--space-2) * -1);
    border-radius: var(--radius);
    cursor: text;
    transition: background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
  }

  .renamable:hover {
    background: var(--bg-hover);
    border-color: var(--border);
  }

  .renamable .pen {
    display: inline-flex;
    color: var(--text-subtle);
  }

  .renamable:hover .pen {
    color: var(--text-muted);
  }

  .room-id-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .rename-input {
    width: min(280px, 50vw);
    font-weight: 600;
  }

  .copy-btn.copied {
    color: var(--success);
    border-color: transparent;
    background: var(--success-soft);
  }

  .peer-count {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 36px;
    padding: 0 var(--space-3);
    border-radius: var(--radius-pill);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    color: var(--text-muted);
    font-size: var(--text-sm);
    font-weight: 500;
  }

  /* ── Banners ────────────────────────────────────────────────────────── */
  .banner {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    font-size: var(--text-sm);
    border-bottom: 1px solid transparent;
    flex-shrink: 0;
  }

  .banner.warning {
    background: var(--warning-soft);
    color: var(--warning);
  }

  .banner.danger {
    background: var(--danger-soft);
    color: var(--danger);
    text-align: center;
  }

  .banner.info {
    background: var(--accent-soft);
    color: var(--text);
  }

  .banner.info > :global(svg) {
    color: var(--accent);
  }

  .banner-btn {
    min-height: 32px;
    padding: 0 var(--space-3);
    border-radius: var(--radius-pill);
    background: var(--accent);
    color: var(--accent-text);
    font-size: var(--text-sm);
    font-weight: 500;
  }

  .banner-btn:hover {
    background: var(--accent-hover);
  }

  .banner-dismiss {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    margin: -6px 0;
    border-radius: var(--radius);
    background: transparent;
    color: var(--text-muted);
  }

  .banner-dismiss:hover {
    background: var(--bg-hover);
    color: var(--text);
  }

  .reconnect-spinner {
    width: 14px;
    height: 14px;
    border: 2px solid var(--warning-soft);
    border-top-color: var(--warning);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    flex-shrink: 0;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* ── Layout: [call column | chat sidebar] ───────────────────────────── */
  .room-body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: row;
  }

  .call-col {
    position: relative;
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .call-area {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .video-grid {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
    grid-auto-rows: minmax(0, 1fr);
    gap: var(--space-3);
    padding: var(--space-3);
    overflow: hidden;
  }

  .call-area.has-stage {
    flex-direction: row;
    gap: var(--space-3);
    padding: var(--space-3);
  }

  .stage {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    position: relative;
  }

  .stage > :global(.tile),
  .stage-screen {
    flex: 1;
    min-width: 0;
    position: relative;
    background: #000;
    border-radius: var(--radius-lg);
    border: 1px solid var(--border-subtle);
    overflow: hidden;
  }

  .stage-screen video {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .tile-strip {
    width: 232px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    overflow-y: auto;
    scrollbar-width: thin;
  }

  .tile-strip > :global(.tile),
  .tile-strip > .tile {
    aspect-ratio: 16 / 10;
    flex-shrink: 0;
  }

  /* ── Tiles (self tile; VideoTile mirrors this) ──────────────────────── */
  .tile {
    position: relative;
    min-width: 0;
    min-height: 0;
    background: var(--bg-surface);
    border-radius: var(--radius-lg);
    border: 1px solid var(--border-subtle);
    overflow: hidden;
    transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
  }

  .tile.speaking {
    border-color: var(--success);
    box-shadow: 0 0 0 2px var(--success), 0 0 20px var(--success-soft);
  }

  .tile video {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .tile.self video {
    transform: scaleX(-1);
  }

  /* A back camera isn't mirrored (text would read backwards). */
  .tile.self video.unmirrored {
    transform: none;
  }

  .flip-btn {
    position: absolute;
    top: var(--space-2);
    right: var(--space-2);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    border: 1px solid rgba(255, 255, 255, 0.18);
    background: rgba(11, 13, 18, 0.62);
    -webkit-backdrop-filter: blur(6px);
    backdrop-filter: blur(6px);
    color: #fff;
  }

  .flip-btn:focus-visible {
    outline: 2px solid var(--accent-ring);
    outline-offset: 2px;
  }

  .tile .no-video {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    background: linear-gradient(160deg, var(--bg-elevated), var(--bg-surface));
  }

  .tile .avatar {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 72px;
    height: 72px;
    border-radius: 50%;
    font-size: 2rem;
    font-weight: 600;
    color: var(--accent);
    background: var(--accent-soft);
    border: 1px solid var(--border);
  }

  .tile-strip .avatar {
    width: 44px;
    height: 44px;
    font-size: 1.25rem;
  }

  .tile-name {
    position: absolute;
    left: var(--space-2);
    bottom: var(--space-2);
    max-width: calc(100% - 16px);
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border-radius: var(--radius-pill);
    background: rgba(11, 13, 18, 0.62);
    -webkit-backdrop-filter: blur(6px);
    backdrop-filter: blur(6px);
    color: #fff;
    font-size: var(--text-xs);
    font-weight: 500;
  }

  .name-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .muted-icon {
    display: inline-flex;
    color: #f87171;
    flex-shrink: 0;
  }

  /* Raised hand on your own tile (VideoTile has the same for others) */
  .hand-badge {
    position: absolute;
    top: var(--space-2);
    left: var(--space-2);
    display: inline-flex;
    padding: 5px;
    border-radius: var(--radius-pill);
    background: var(--warning);
    color: #1a1300;
    box-shadow: var(--shadow-sm);
    pointer-events: none;
  }

  /* Unpin / Options, over whoever is on the stage */
  .stage-btn {
    position: absolute;
    right: var(--space-2);
    bottom: var(--space-2);
    z-index: 3;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border: 0;
    border-radius: var(--radius-pill);
    background: rgba(11, 13, 18, 0.62);
    -webkit-backdrop-filter: blur(6px);
    backdrop-filter: blur(6px);
    color: #fff;
    font-size: var(--text-xs);
    font-weight: 500;
    cursor: pointer;
  }

  /* While your pin holds the stage: someone else is sharing (tap to unpin and view it) */
  .stage-sharing-btn {
    position: absolute;
    top: var(--space-2);
    left: 50%;
    transform: translateX(-50%);
    z-index: 3;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: calc(100% - 24px);
    padding: 4px 12px;
    border: 0;
    border-radius: var(--radius-pill);
    background: var(--accent);
    color: var(--accent-text);
    font-size: var(--text-xs);
    font-weight: 600;
    white-space: nowrap;
    cursor: pointer;
    box-shadow: var(--shadow-md);
  }

  .stage-sharing-btn .sharing-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .stage-sharing-btn:focus-visible {
    outline: 2px solid var(--accent-ring);
    outline-offset: 2px;
  }

  .stage-btn:hover {
    background: rgba(11, 13, 18, 0.82);
  }

  .stage-btn:focus-visible {
    outline: 2px solid var(--accent-ring);
    outline-offset: 2px;
  }

  /* ── Controls ───────────────────────────────────────────────────────── */
  footer {
    flex-shrink: 0;
    padding: var(--space-3) var(--space-4);
    padding-bottom: max(var(--space-3), env(safe-area-inset-bottom));
    background: var(--bg-surface);
    border-top: 1px solid var(--border-subtle);
  }

  .controls {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .ctrl-btn {
    position: relative;
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    min-width: 64px;
    height: 56px;
    padding: 0 var(--space-3);
    border-radius: var(--radius-lg);
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    color: var(--text);
    transition: background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease),
      color var(--dur-fast) var(--ease), transform var(--dur-fast) var(--ease);
  }

  .ctrl-btn:hover {
    background: var(--bg-overlay);
    border-color: var(--border-strong);
  }

  .ctrl-btn:active {
    transform: translateY(1px);
  }

  .ctrl-btn:focus-visible {
    outline: 2px solid var(--accent-ring);
    outline-offset: 2px;
    border-radius: var(--radius-lg);
  }

  .ctrl-label {
    font-size: 0.6875rem;
    font-weight: 500;
    line-height: 1;
    letter-spacing: 0.01em;
  }

  .ctrl-btn.off {
    background: var(--danger-soft);
    border-color: transparent;
    color: var(--danger);
  }

  .ctrl-btn.off:hover {
    background: var(--danger-soft);
    border-color: var(--danger);
  }

  .ctrl-btn:disabled {
    opacity: 0.6;
    cursor: progress;
  }

  .ctrl-btn.active {
    background: var(--accent-soft);
    border-color: transparent;
    color: var(--accent);
  }

  .ctrl-btn.active:hover {
    border-color: var(--accent);
  }

  .ctrl-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .ctrl-sep {
    width: 1px;
    height: 28px;
    margin: 0 var(--space-1);
    background: var(--border);
  }

  .ctrl-btn.leave {
    background: var(--danger);
    border-color: transparent;
    color: #fff;
    min-width: 72px;
  }

  .ctrl-btn.leave:hover {
    background: var(--danger);
    border-color: transparent;
    filter: brightness(1.1);
  }

  .unread-badge {
    position: absolute;
    top: -6px;
    right: -6px;
    min-width: 20px;
    height: 20px;
    padding: 0 5px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-pill);
    background: var(--accent);
    color: var(--accent-text);
    border: 2px solid var(--bg-surface);
    font-size: 0.6875rem;
    font-weight: 700;
    line-height: 1;
  }

  /* ── Dialogs ────────────────────────────────────────────────────────── */
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-4);
    background: rgba(8, 10, 15, 0.72);
    -webkit-backdrop-filter: blur(6px);
    backdrop-filter: blur(6px);
    overflow-y: auto;
  }

  .dialog {
    width: min(100%, 400px);
    padding: var(--space-6);
    box-shadow: var(--shadow-lg);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .dialog.center {
    align-items: stretch;
    text-align: center;
    width: min(100%, 360px);
  }

  .dialog h2 {
    font-size: var(--text-xl);
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--text);
    overflow-wrap: anywhere;
  }

  .dialog-sub {
    color: var(--text-muted);
    font-size: var(--text-base);
    margin-top: calc(var(--space-2) * -1);
    overflow-wrap: anywhere;
  }

  .dialog-sub.invalid {
    color: var(--danger);
  }

  .dialog-icon {
    align-self: center;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: var(--accent-soft);
    color: var(--accent);
  }

  .dialog-icon.danger {
    background: var(--danger-soft);
    color: var(--danger);
  }

  .dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    margin-top: var(--space-2);
  }

  .dialog.center .dialog-actions {
    justify-content: center;
  }

  .code-input {
    font-family: var(--font-mono, monospace);
    font-size: var(--text-xl, 1.25rem);
    letter-spacing: 0.3em;
    text-align: center;
  }

  /* ── Responsive ─────────────────────────────────────────────────────── */
  @media (max-width: 1100px) {
    .tile-strip {
      width: 190px;
    }
  }

  @media (max-width: 768px) {
    .call-area.has-stage {
      flex-direction: column;
    }

    .tile-strip {
      width: 100%;
      height: 112px;
      flex-direction: row;
      overflow-x: auto;
      overflow-y: hidden;
    }

    .tile-strip > :global(.tile),
    .tile-strip > .tile {
      height: 100%;
      width: auto;
    }
  }

  @media (max-width: 640px) {
    header {
      padding: var(--space-2) var(--space-3);
    }

    .room-id {
      font-size: var(--text-base);
    }

    .copy-btn {
      width: 36px;
      padding: 0;
    }

    .copy-label {
      display: none;
    }

    .video-grid {
      grid-template-columns: minmax(0, 1fr);
      gap: var(--space-2);
      padding: var(--space-2);
    }

    .call-area.has-stage {
      gap: var(--space-2);
      padding: var(--space-2);
    }

    footer {
      padding: var(--space-2);
      padding-bottom: max(var(--space-2), env(safe-area-inset-bottom));
    }

    .controls {
      gap: var(--space-1);
    }

    .ctrl-btn,
    .ctrl-btn.leave {
      min-width: 44px;
      width: 44px;
      height: 44px;
      padding: 0;
      border-radius: var(--radius);
    }

    .ctrl-label {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
    }

    .ctrl-sep {
      display: none;
    }

    .dialog {
      padding: var(--space-5);
    }
  }
  /* ── End-to-end badge ── */
  .e2e-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.25rem 0.6rem;
    border-radius: var(--radius-pill, 999px);
    font-size: var(--text-xs, 0.75rem);
    font-weight: 600;
    border: 1px solid var(--border);
    color: var(--text-muted);
    cursor: help;
    white-space: nowrap;
  }

  .e2e-badge.verified {
    color: var(--success);
    background: var(--success-soft);
    border-color: transparent;
  }

  .e2e-badge.partial,
  .e2e-badge.nokey {
    color: var(--warning);
    background: var(--warning-soft);
    border-color: transparent;
  }

  @media (max-width: 640px) {
    .e2e-label {
      display: none;
    }
  }

  /* ── Person menu ── */
  .person-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 60;
    padding: 1rem;
  }

  .person-card {
    width: 100%;
    max-width: 360px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg, 14px);
    box-shadow: var(--shadow-lg);
    padding: var(--space-5, 1.25rem);
    display: flex;
    flex-direction: column;
    gap: var(--space-4, 1rem);
    max-height: calc(100dvh - 2rem);
    overflow-y: auto;
  }

  .person-head {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3, 0.75rem);
  }

  .person-head > div {
    flex: 1;
    min-width: 0;
  }

  .person-avatar {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--accent-soft);
    color: var(--accent-text, var(--accent));
    font-weight: 700;
    flex-shrink: 0;
  }

  .person-ver {
    margin: 0.2rem 0 0;
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-size: var(--text-xs, 0.75rem);
    color: var(--text-muted);
  }

  .person-ver.verified {
    color: var(--success);
  }

  .person-ver.unverified,
  .person-ver.allowed,
  .person-ver.nokey,
  .person-ver.failed {
    color: var(--warning);
  }

  .danger-ghost {
    color: var(--danger);
    border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
    background: transparent;
  }

  .danger-ghost:hover {
    background: color-mix(in srgb, var(--danger) 10%, transparent);
  }

  .safety-code {
    border: 1px solid var(--border);
    border-radius: var(--radius, 10px);
    padding: var(--space-3, 0.75rem);
    display: grid;
    gap: 0.25rem;
  }

  .safety-code strong {
    font-family: var(--font-mono, monospace);
    font-size: 1.4rem;
    letter-spacing: 0.08em;
  }

  .safety-code p {
    margin: 0;
    font-size: var(--text-xs, 0.75rem);
    color: var(--text-muted);
  }

  .person-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-2, 0.5rem);
  }

  .person-notice {
    margin: 0;
    color: var(--warning);
    font-size: var(--text-sm, 0.85rem);
  }

  .person-foot {
    margin: 0;
    font-size: var(--text-xs, 0.75rem);
    color: var(--text-muted);
  }
</style>
