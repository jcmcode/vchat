<script lang="ts">
  import { goto } from '$app/navigation';
  import {
    generateRoomId,
    getSavedDisplayName,
    saveDisplayName,
    getSignalServerUrl,
    setSignalServerUrl,
    getTurnConfig,
    setTurnConfig,
  } from '$lib/stores/room';

  let name = getSavedDisplayName();
  let joinCode = '';
  let roomPasswordInput = '';
  let voiceOnly = false;
  let showSettings = false;
  let signalingUrl = getSignalServerUrl();
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
    setSignalServerUrl(signalingUrl);
    setTurnConfig(turnUrl, turnUsername, turnCredential);
  }

  function createRoom() {
    if (!name.trim()) return;
    saveDisplayName(name.trim());
    const id = generateRoomId();
    const params = new URLSearchParams({ name: name.trim(), creator: '1' });
    if (roomPasswordInput) params.set('password', roomPasswordInput);
    if (voiceOnly) params.set('voiceOnly', '1');
    goto(`/room/${id}?${params.toString()}`);
  }

  function joinRoom() {
    if (!name.trim() || !joinCode.trim()) return;
    saveDisplayName(name.trim());
    const code = joinCode.trim().toLowerCase();
    const params = new URLSearchParams({ name: name.trim() });
    if (roomPasswordInput) params.set('password', roomPasswordInput);
    if (voiceOnly) params.set('voiceOnly', '1');
    goto(`/room/${code}?${params.toString()}`);
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

<div class="landing">
  <div class="card">
    <h1>vchat</h1>
    <p class="subtitle">P2P encrypted video calls. No account needed.</p>

    <div class="form">
      <input
        type="text"
        bind:value={name}
        placeholder="Your name"
        on:keydown={handleKeydown}
        maxlength="30"
      />

      <input
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
        Create Room
      </button>

      <div class="divider">
        <span>or join existing</span>
      </div>

      <div class="join-row">
        <input
          type="text"
          bind:value={joinCode}
          placeholder="Room code"
          on:keydown={handleKeydown}
          maxlength="20"
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
      <button class="settings-btn" on:click={() => { showSettings = !showSettings; }}>
        {showSettings ? 'Hide Settings' : 'Settings'}
      </button>
    </div>

    {#if showSettings}
      <div class="settings">
        <label>
          <span>Signaling Server</span>
          <input
            type="text"
            bind:value={signalingUrl}
            on:change={saveSettings}
            placeholder="ws://localhost:3001"
          />
        </label>
        <label>
          <span>TURN Server URL</span>
          <input
            type="text"
            bind:value={turnUrl}
            on:change={saveSettings}
            placeholder="turn:turn.example.com:3478"
          />
        </label>
        <label>
          <span>TURN Username</span>
          <input
            type="text"
            bind:value={turnUsername}
            on:change={saveSettings}
            placeholder="username"
          />
        </label>
        <label>
          <span>TURN Credential</span>
          <input
            type="password"
            bind:value={turnCredential}
            on:change={saveSettings}
            placeholder="credential"
          />
        </label>
      </div>
    {/if}
  </div>
</div>

<style>
  .landing {
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
  }

  .card {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 2.5rem;
    width: 100%;
    max-width: 400px;
    text-align: center;
  }

  h1 {
    font-size: 2.5rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    margin-bottom: 0.5rem;
  }

  .subtitle {
    color: var(--text-muted);
    margin-bottom: 2rem;
    font-size: 0.95rem;
  }

  .form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  input[type="text"],
  input[type="password"] {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.75rem 1rem;
    color: var(--text);
    font-size: 1rem;
    width: 100%;
  }

  input:focus {
    border-color: var(--accent);
  }

  .toggle-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9rem;
    color: var(--text-muted);
    cursor: pointer;
    justify-content: flex-start;
  }

  .toggle-row input[type="checkbox"] {
    width: auto;
    accent-color: var(--accent);
  }

  .btn {
    padding: 0.75rem 1.5rem;
    border-radius: var(--radius);
    font-size: 1rem;
    font-weight: 500;
    transition: background 0.15s;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn.primary {
    background: var(--accent);
    color: white;
  }

  .btn.primary:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .btn.secondary {
    background: var(--bg-elevated);
    color: var(--text);
    border: 1px solid var(--border);
  }

  .btn.secondary:hover:not(:disabled) {
    background: var(--border);
  }

  .divider {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin: 0.5rem 0;
  }

  .divider::before,
  .divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--border);
  }

  .divider span {
    color: var(--text-muted);
    font-size: 0.85rem;
  }

  .join-row {
    display: flex;
    gap: 0.5rem;
  }

  .join-row input {
    flex: 1;
  }

  .settings-toggle {
    margin-top: 0.5rem;
  }

  .settings-btn {
    background: none;
    color: var(--text-muted);
    font-size: 0.85rem;
    padding: 0.3rem 0;
    border: none;
    cursor: pointer;
  }

  .settings-btn:hover {
    color: var(--text);
  }

  .settings {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-top: 0.5rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--border);
    text-align: left;
  }

  .settings label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .settings label span {
    font-size: 0.8rem;
    color: var(--text-muted);
  }

  .settings input {
    font-size: 0.85rem;
    padding: 0.5rem 0.75rem;
  }

  @media (max-width: 640px) {
    .card {
      padding: 1.5rem;
    }

    h1 {
      font-size: 2rem;
    }
  }
</style>
