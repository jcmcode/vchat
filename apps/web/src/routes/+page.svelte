<script lang="ts">
  import { goto } from '$app/navigation';
  import {
    generateRoomId,
    getSavedDisplayName,
    saveDisplayName,
    getTurnConfig,
    setTurnConfig,
    setPendingPassword,
    setPendingRoomName,
    setPendingJoin,
    parseInviteLink,
    setRoomKey,
    setRoomToken,
    fetchServerConfig,
    type ServerConfig,
  } from '$lib/stores/room';
  import { onMount } from 'svelte';
  import { generateRoomKey, isValidRoomKey } from '$lib/webrtc/e2e-proof';
  import Icon from '$lib/ui/Icon.svelte';

  let config: ServerConfig | null = null;
  let inviteInput = '';
  let inviteError = '';

  onMount(async () => {
    config = await fetchServerConfig();
  });

  // Private mode: open a pasted invite link. The token and key go into this tab's storage, so
  // they never appear in the address bar or browser history.
  function openInvite() {
    inviteError = '';
    const invite = parseInviteLink(inviteInput);
    if (!invite) {
      inviteError = "That doesn't look like an invite link. Paste the whole link you were sent.";
      return;
    }
    setRoomToken(invite.roomId, invite.token);
    if (invite.key) setRoomKey(invite.roomId, invite.key);
    inviteInput = '';
    goto(`/room/${invite.roomId}`);
  }

  let name = getSavedDisplayName();
  let joinCode = '';
  let roomPasswordInput = '';
  let voiceOnly = false;
  let roomNameInput = '';
  let showSettings = false;
  let turnUrl = '';
  let turnUsername = '';
  let turnCredential = '';

  // Load saved TURN config
  const savedTurn = getTurnConfig();
  if (savedTurn) {
    turnUrl = savedTurn.url;
    turnUsername = savedTurn.username;
    turnCredential = savedTurn.credential;
  }

  function saveSettings() {
    setTurnConfig(turnUrl, turnUsername, turnCredential);
  }

  // Accept a bare code or a pasted room link.
  function parseRoomCode(input: string): string {
    const trimmed = input.trim();
    const match = trimmed.match(/\/room\/([^/?#]+)/);
    return (match ? match[1] : trimmed).toLowerCase();
  }

  function enterRoom(id: string, creator: boolean) {
    saveDisplayName(name.trim());
    // The password goes through sessionStorage so it never lands in the URL or browser history.
    setPendingPassword(roomPasswordInput);
    if (creator) {
      setPendingRoomName(id, roomNameInput);
      // The room's end-to-end key is created here, in your browser, and only ever shared in links.
      setRoomKey(id, generateRoomKey());
    }
    // Name and audio/video choice were made here, so the room skips its pre-join screen.
    // (Handed over in tab storage, never in the URL.)
    setPendingJoin(id, { creator, mode: voiceOnly ? 'audio' : 'video', name: name.trim() });
    goto(`/room/${id}`);
  }

  function createRoom() {
    if (!name.trim()) return;
    enterRoom(generateRoomId(), true);
  }

  function joinRoom() {
    if (!name.trim() || !joinCode.trim()) return;
    const id = parseRoomCode(joinCode);
    // A pasted link carries the room's end-to-end key after "#". Keep it (in this tab only), or
    // the call would be joined without it and nobody in it could be verified.
    const hashAt = joinCode.indexOf('#');
    const key = hashAt >= 0 ? new URLSearchParams(joinCode.slice(hashAt + 1).trim()).get('k') : null;
    if (isValidRoomKey(key)) setRoomKey(id, key);
    enterRoom(id, false);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      if (joinCode.trim()) {
        joinRoom();
      } else {
        createRoom();
      }
    }
  }
</script>

<svelte:head>
  <title>vchat</title>
</svelte:head>

<div class="landing">
  <main class="card fade-in">
    <div class="brand">
      <svg class="mark" viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="9" fill="var(--accent)" />
        <rect x="7" y="10" width="12" height="12" rx="3" fill="none" stroke="#fff" stroke-width="2" />
        <path d="M19 14.5l5-2.5v8l-5-2.5" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round" />
      </svg>
      <h1>vchat</h1>
    </div>

    {#if !config}
      <p class="subtitle" aria-live="polite">Loading…</p>
    {:else if config.mode === 'private'}
      <p class="subtitle">Private, end-to-end encrypted video calls.</p>

      {#if config.misconfigured}
        <p class="field-error" role="alert">This server isn't set up correctly, so it won't accept calls yet. If it's yours, check its startup log.</p>
      {/if}

      <form class="form" on:submit|preventDefault={openInvite}>
        <p class="hint">Got an invite? Open the link you were sent, or paste it here.</p>
        <label class="sr-only" for="invite">Invite link</label>
        <input id="invite" class="input" type="text" bind:value={inviteInput} placeholder="Paste invite link" autocomplete="off" spellcheck="false" />
        {#if inviteError}
          <span class="field-error" role="alert">{inviteError}</span>
        {/if}
        <button class="btn primary" type="submit" disabled={!inviteInput.trim()}>Join call</button>
      </form>

      <div class="settings-toggle">
        <a class="settings-btn" href="/admin"><Icon name="lock" size={14} /> Owner sign in</a>
      </div>
    {:else}
      <p class="subtitle">Peer-to-peer encrypted video calls. No account needed.</p>

      <div class="form">
        <label class="sr-only" for="name">Your name</label>
        <input
          id="name"
          class="input"
          type="text"
          bind:value={name}
          placeholder="Your name"
          on:keydown={handleKeydown}
          maxlength="30"
        />

        <label class="sr-only" for="roomname">Room name (optional)</label>
        <input
          id="roomname"
          class="input"
          type="text"
          bind:value={roomNameInput}
          placeholder="Room name (optional)"
          on:keydown={handleKeydown}
          maxlength="60"
        />

        <label class="sr-only" for="roompw">Room password (optional)</label>
        <input
          id="roompw"
          class="input"
          type="password"
          bind:value={roomPasswordInput}
          placeholder="Room password (optional)"
          on:keydown={handleKeydown}
        />

        <label class="toggle-row">
          <input type="checkbox" bind:checked={voiceOnly} />
          <span>Audio only (no camera)</span>
        </label>

        <button class="btn primary" on:click={createRoom} disabled={!name.trim()}>
          <Icon name="plus" size={18} /> Create Room
        </button>

        <div class="divider">
          <span>or join existing</span>
        </div>

        <div class="join-row">
          <label class="sr-only" for="joincode">Room code or link</label>
          <input
            id="joincode"
            class="input"
            type="text"
            bind:value={joinCode}
            placeholder="Room code or link"
            autocomplete="off"
            spellcheck="false"
            on:keydown={handleKeydown}
            maxlength="200"
          />
          <button
            class="btn secondary"
            on:click={joinRoom}
            disabled={!name.trim() || !joinCode.trim()}
          >
            Join
          </button>
        </div>
      </div>

      <div class="settings-toggle">
        <button
          class="settings-btn"
          aria-expanded={showSettings}
          on:click={() => { showSettings = !showSettings; }}
        >
          <Icon name="settings" size={14} />
          {showSettings ? 'Hide Settings' : 'Settings'}
        </button>
      </div>

      {#if showSettings}
        <div class="settings fade-in">
          <label>
            <span>TURN Server URL (optional override)</span>
            <input
              class="input"
              type="text"
              bind:value={turnUrl}
              on:change={saveSettings}
              placeholder="turn:turn.example.com:3478"
            />
          </label>
          <label>
            <span>TURN Username</span>
            <input
              class="input"
              type="text"
              bind:value={turnUsername}
              on:change={saveSettings}
              placeholder="username"
            />
          </label>
          <label>
            <span>TURN Credential</span>
            <input
              class="input"
              type="password"
              bind:value={turnCredential}
              on:change={saveSettings}
              placeholder="credential"
            />
          </label>
        </div>
      {/if}
    {/if}

    <p class="trust"><Icon name="shield" size={14} /> End-to-end encrypted · No accounts · No logs</p>
  </main>
</div>

<style>
  .landing {
    height: 100%;
    overflow-y: auto;
    display: flex;
    padding: var(--space-4);
    background:
      radial-gradient(ellipse 70% 50% at 50% 0%, var(--accent-soft), transparent 70%),
      var(--bg);
  }

  .card {
    margin: auto;
    width: 100%;
    max-width: 420px;
    padding: var(--space-8) var(--space-8) var(--space-6);
    text-align: center;
  }

  .brand {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    margin-bottom: var(--space-2);
  }

  .mark {
    width: 36px;
    height: 36px;
  }

  h1 {
    font-size: var(--text-3xl);
    font-weight: 700;
    letter-spacing: -0.03em;
    line-height: 1.1;
  }

  .subtitle {
    color: var(--text-muted);
    margin-bottom: var(--space-6);
    font-size: var(--text-base);
  }

  .hint {
    color: var(--text-muted);
    font-size: var(--text-sm);
    text-align: left;
  }

  .field-error {
    color: var(--danger);
    font-size: var(--text-sm);
    text-align: left;
  }

  .form {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .toggle-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 32px;
    font-size: var(--text-sm);
    color: var(--text-muted);
    cursor: pointer;
  }

  .toggle-row input[type='checkbox'] {
    width: 18px;
    height: 18px;
    accent-color: var(--accent);
  }

  .divider {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    margin: var(--space-1) 0;
  }

  .divider::before,
  .divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--border);
  }

  .divider span {
    color: var(--text-subtle);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .join-row {
    display: flex;
    gap: var(--space-2);
  }

  .join-row .input {
    flex: 1;
    min-width: 0;
  }

  .settings-toggle {
    margin-top: var(--space-3);
  }

  .settings-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: none;
    color: var(--text-muted);
    font-size: var(--text-sm);
    min-height: 40px;
    padding: 0 var(--space-3);
    border-radius: var(--radius);
    cursor: pointer;
  }

  .settings-btn:hover {
    color: var(--text);
    background: var(--bg-hover);
    text-decoration: none;
  }

  .settings {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin-top: var(--space-2);
    padding-top: var(--space-4);
    border-top: 1px solid var(--border-subtle);
    text-align: left;
  }

  .settings label {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .settings label span {
    font-size: var(--text-sm);
    color: var(--text-muted);
  }

  .trust {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    margin-top: var(--space-5);
    padding-top: var(--space-4);
    border-top: 1px solid var(--border-subtle);
    color: var(--text-subtle);
    font-size: var(--text-xs);
  }

  @media (max-width: 480px) {
    .card {
      padding: var(--space-6) var(--space-4) var(--space-4);
    }
  }
</style>
