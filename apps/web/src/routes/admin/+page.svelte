<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import Icon from '$lib/ui/Icon.svelte';
  import { generateRoomKey } from '$lib/webrtc/e2e-proof';
  import type { When } from '$lib/when';
  import WhenPicker from '$lib/ui/WhenPicker.svelte';
  import RoomCard from './RoomCard.svelte';
  import {
    apiUrl,
    fetchServerConfig,
    getSavedRooms,
    pruneSavedRooms,
    clearSavedRooms,
    saveRooms,
    setRoomToken,
    setRoomKey,
    withInvites,
    type PersonalInvite,
    type ServerConfig,
    type SavedRoom,
  } from '$lib/stores/room';

  let config: ServerConfig | null = null;
  let loading = true;
  let authenticated = false;
  let email: string | null = null;

  let loginPassword = '';
  let loginError = '';
  let loggingIn = false;
  let logoutError = '';
  let loggingOut = false;

  // Email sign-in: ask for a code, then enter it.
  let loginEmail = '';
  let loginChallenge = '';
  let loginCode = '';
  let codeSentTo = '';

  let label = '';
  let roomPassword = '';
  let approval = true;
  let expiresInHours = 24;
  /** Optional schedule and length, for calendar/email invites. */
  let when: When = { startsAt: null, durationMinutes: 60 };
  let creating = false;
  let createError = '';

  let rooms: SavedRoom[] = [];
  /** The room just created: shown first, open and highlighted. */
  let freshId = '';
  let showOptions = false;
  let usePassword = false;
  $: expiryLabel = EXPIRY_OPTIONS.find((o) => o.hours === expiresInHours)?.label ?? `${expiresInHours} hours`;
  $: optionsSummary = [
    approval ? 'you let people in' : 'people join directly',
    usePassword ? 'password' : 'no password',
    when.startsAt != null ? 'scheduled' : null,
    `link works for ${expiryLabel}`,
  ]
    .filter(Boolean)
    .join(' · ');

  function togglePassword(e: Event) {
    usePassword = (e.currentTarget as HTMLInputElement).checked;
    if (usePassword && !roomPassword) generatePassword();
    if (!usePassword) roomPassword = '';
  }

  const EXPIRY_OPTIONS = [
    { hours: 1, label: '1 hour' },
    { hours: 8, label: '8 hours' },
    { hours: 24, label: '1 day' },
    { hours: 24 * 7, label: '1 week' },
    { hours: 24 * 30, label: '30 days' },
  ];

  onMount(async () => {
    config = await fetchServerConfig();
    if (config.mode === 'private') await refreshSession();
    pruneSavedRooms();
    rooms = getSavedRooms();
    loading = false;
  });

  async function refreshSession() {
    try {
      const res = await fetch(apiUrl('/api/admin/session'), { credentials: 'same-origin' });
      const body = await res.json();
      authenticated = !!body.authenticated;
      email = body.email ?? null;
    } catch {
      authenticated = false;
    }
  }

  async function login() {
    loginError = '';
    loggingIn = true;
    try {
      const res = await fetch(apiUrl('/api/admin/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ password: loginPassword }),
      });
      if (res.ok) {
        loginPassword = '';
        await refreshSession();
      } else {
        loginError = (await res.json().catch(() => ({}))).error ?? 'Sign in failed';
      }
    } catch {
      loginError = 'Could not reach the server.';
    } finally {
      loggingIn = false;
    }
  }

  async function postJson(path: string, payload: unknown): Promise<{ res: Response; body: Record<string, unknown> }> {
    const res = await fetch(apiUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { res, body };
  }

  async function requestCode() {
    loginError = '';
    loggingIn = true;
    try {
      const { res, body } = await postJson('/api/admin/login/code', { email: loginEmail.trim() });
      if (!res.ok || typeof body.challenge !== 'string') {
        loginError = res.status === 429 ? 'Too many codes requested. Wait a few minutes and try again.' : 'Could not send a code. Try again.';
        return;
      }
      loginChallenge = body.challenge;
      codeSentTo = loginEmail.trim();
      loginCode = '';
    } catch {
      loginError = 'Could not reach the server.';
    } finally {
      loggingIn = false;
    }
  }

  async function verifyCode() {
    loginError = '';
    loggingIn = true;
    try {
      const { res } = await postJson('/api/admin/login/verify', { challenge: loginChallenge, code: loginCode.replace(/\D/g, '') });
      if (res.ok) {
        loginChallenge = '';
        loginCode = '';
        await refreshSession();
      } else {
        loginError = res.status === 429 ? 'Too many attempts. Wait a few minutes and try again.' : 'Wrong or expired code.';
      }
    } catch {
      loginError = 'Could not reach the server.';
    } finally {
      loggingIn = false;
    }
  }

  function startOver() {
    loginChallenge = '';
    loginCode = '';
    loginError = '';
  }

  /** Emailed invites went out for a meeting time (or none): keep it on the saved room. */
  function updateSchedule(e: CustomEvent<{ roomId: string; startsAt?: number; durationMinutes?: number }>) {
    const { roomId, startsAt, durationMinutes: minutes } = e.detail;
    const apply = (r: SavedRoom): SavedRoom => {
      if (r.roomId !== roomId) return r;
      const next = { ...r, startsAt, durationMinutes: minutes };
      if (!startsAt) {
        delete next.startsAt;
        delete next.durationMinutes;
      }
      return next;
    };
    rooms = rooms.map(apply);
    saveRooms(rooms);
  }

  /** Personal invites went out: keep each person's code and link with the room. */
  function rememberInvites(e: CustomEvent<{ roomId: string; invites: PersonalInvite[] }>) {
    const { roomId, invites } = e.detail;
    rooms = rooms.map((r) => (r.roomId === roomId ? withInvites(r, invites) : r));
    saveRooms(rooms);
  }

  async function logout() {
    if (loggingOut) return;
    logoutError = '';
    loggingOut = true;
    // Saved rooms hold host links and room keys: don't leave them in this browser.
    clearSavedRooms();
    rooms = [];
    deleted = null;
    if (config?.auth === 'access') {
      window.location.href = '/cdn-cgi/access/logout';
      return;
    }
    try {
      const res = await fetch(apiUrl('/api/admin/logout'), { method: 'POST', credentials: 'same-origin' });
      if (res.ok || res.status === 401) authenticated = false;
      else logoutError = 'Sign-out failed. Try again.';
    } catch {
      logoutError = 'Could not reach the server to sign out. Try again.';
    } finally {
      loggingOut = false;
    }
  }

  function generatePassword() {
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(10));
    const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]);
    roomPassword = `${chars.slice(0, 5).join('')}-${chars.slice(5).join('')}`;
  }

  async function createRoom() {
    createError = '';
    creating = true;
    try {
      // A scheduled meeting's invite must stay valid until the meeting is over (plus some slack).
      const startsAt = when.startsAt ?? undefined;
      const durationMinutes = when.durationMinutes;
      let hours = expiresInHours;
      if (startsAt && Number.isFinite(startsAt)) {
        const needed = Math.ceil((startsAt + durationMinutes * 60_000 + 2 * 3600_000 - Date.now()) / 3600_000);
        hours = Math.min(Math.max(hours, needed), 30 * 24);
      }
      const res = await fetch(apiUrl('/api/admin/rooms'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ label, password: usePassword ? roomPassword : '', approval, expiresInHours: hours }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        createError = body.error ?? 'Could not create room';
        if (res.status === 401) authenticated = false;
        return;
      }
      const room: SavedRoom = {
        roomId: body.roomId,
        label: body.label,
        inviteToken: body.inviteToken,
        hostToken: body.hostToken,
        expiresAt: body.expiresAt,
        approval: body.approval,
        hasPassword: body.hasPassword,
        createdAt: Date.now(),
        // End-to-end key: made here in your browser, only ever shared inside the invite link.
        key: generateRoomKey(),
        ...(usePassword && roomPassword ? { password: roomPassword } : {}),
        ...(startsAt && Number.isFinite(startsAt) ? { startsAt, durationMinutes } : {}),
      };
      rooms = [room, ...rooms];
      saveRooms(rooms);
      freshId = room.roomId;
      label = '';
      roomPassword = '';
      usePassword = false;
      showOptions = false;
      when = { ...when, startsAt: null };
    } catch {
      createError = 'Could not finish creating the room. Check your connection and try again.';
    } finally {
      creating = false;
    }
  }

  function startCall(room: SavedRoom) {
    setRoomToken(room.roomId, room.hostToken);
    if (room.key) setRoomKey(room.roomId, room.key);
    goto(`/room/${room.roomId}`);
  }

  /** The room just deleted, kept for a few seconds so it can be undone. */
  let deleted: { room: SavedRoom; index: number } | null = null;
  let undoTimer: ReturnType<typeof setTimeout> | undefined;

  function removeRoom(room: SavedRoom) {
    const index = rooms.findIndex((r) => r.roomId === room.roomId);
    if (index < 0) return;
    rooms = rooms.filter((r) => r.roomId !== room.roomId);
    saveRooms(rooms);
    if (freshId === room.roomId) freshId = '';
    deleted = { room, index };
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => (deleted = null), 8000);
  }

  function undoRemove() {
    if (!deleted) return;
    const { room, index } = deleted;
    rooms = [...rooms.slice(0, index), room, ...rooms.slice(index)];
    saveRooms(rooms);
    deleted = null;
    clearTimeout(undoTimer);
  }

  onDestroy(() => clearTimeout(undoTimer));

</script>

<svelte:head>
  <title>vchat · Owner</title>
</svelte:head>

<div class="page">
  <div class="shell fade-in">
    <header class="top">
      <a class="brand" href="/" aria-label="vchat home">
        <svg class="mark" viewBox="0 0 32 32" aria-hidden="true">
          <rect width="32" height="32" rx="9" fill="var(--accent)" />
          <rect x="7" y="10" width="12" height="12" rx="3" fill="none" stroke="#fff" stroke-width="2" />
          <path d="M19 14.5l5-2.5v8l-5-2.5" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round" />
        </svg>
        <span>vchat</span>
        <span class="chip accent">Owner</span>
      </a>
      {#if authenticated}
        <div class="who">
          {#if email}<span class="muted email">{email}</span>{/if}
          <button class="btn ghost small" disabled={loggingOut} on:click={logout}><Icon name="log-out" size={16} /> Sign out</button>
        </div>
      {/if}
    </header>
    {#if logoutError}<p class="error" role="alert">{logoutError}</p>{/if}

    {#if loading}
      <section class="panel"><p class="muted" aria-live="polite">Loading…</p></section>
    {:else if config?.mode === 'open'}
      <section class="panel stack">
        <p>Owner sign-in isn't enabled on this server, so it runs in <strong>open mode</strong>: anyone can create rooms from the home page.</p>
        <p class="muted">To make it private, set <code>SECRET_KEY</code> plus an owner sign-in: <code>OWNER_EMAIL</code> (email codes), Cloudflare Access, or <code>ADMIN_PASSWORD</code>. See the README.</p>
        <a class="btn secondary" href="/">Go to home page</a>
      </section>
    {:else if config?.misconfigured}
      <section class="panel"><p class="error" role="alert">This server isn't set up correctly, so it won't accept calls yet. If it's yours, check its startup log.</p></section>
    {:else if !authenticated}
      {#if config?.auth === 'email'}
        {#if !loginChallenge}
          <form class="panel form" on:submit|preventDefault={requestCode}>
            <h2><Icon name="lock" size={18} /> Owner sign in</h2>
            <p class="muted small-text">We'll email you an 8-digit code.</p>
            <label class="sr-only" for="owneremail">Email</label>
            <!-- svelte-ignore a11y-autofocus -->
            <input id="owneremail" class="input" type="email" bind:value={loginEmail} placeholder="you@example.com" autocomplete="email" autofocus />
            {#if loginError}<span class="error" role="alert">{loginError}</span>{/if}
            <button class="btn primary" type="submit" disabled={!loginEmail.includes('@') || loggingIn}>
              {loggingIn ? 'Sending…' : 'Email me a code'}
            </button>
          </form>
        {:else}
          <form class="panel form" on:submit|preventDefault={verifyCode}>
            <h2><Icon name="lock" size={18} /> Enter your code</h2>
            <p class="muted small-text">If {codeSentTo} is the owner's address, a code is on its way. It expires in 10 minutes.</p>
            <label class="sr-only" for="ownercode">8-digit code</label>
            <!-- svelte-ignore a11y-autofocus -->
            <input
              id="ownercode"
              class="input code-input"
              type="text"
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength="10"
              bind:value={loginCode}
              placeholder="12345678"
              autofocus
            />
            {#if loginError}<span class="error" role="alert">{loginError}</span>{/if}
            <button class="btn primary" type="submit" disabled={loginCode.replace(/\D/g, '').length !== 8 || loggingIn}>
              {loggingIn ? 'Checking…' : 'Sign in'}
            </button>
            <button class="link-btn" type="button" on:click={startOver}>Use a different email or send a new code</button>
          </form>
        {/if}
      {:else if config?.auth === 'password'}
        <form class="panel form" on:submit|preventDefault={login}>
          <h2><Icon name="lock" size={18} /> Owner sign in</h2>
          <label class="sr-only" for="ownerpw">Owner password</label>
          <!-- svelte-ignore a11y-autofocus -->
          <input id="ownerpw" class="input" type="password" bind:value={loginPassword} placeholder="Owner password" autocomplete="current-password" autofocus />
          {#if loginError}<span class="error" role="alert">{loginError}</span>{/if}
          <button class="btn primary" type="submit" disabled={!loginPassword || loggingIn}>
            {loggingIn ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      {:else}
        <section class="panel stack">
          <h2><Icon name="lock" size={18} /> Owner sign in</h2>
          <p>This server uses <strong>Cloudflare Access</strong> for owner sign-in, but this page isn't behind it yet.</p>
          <p class="muted">In Cloudflare Zero Trust, add the paths <code>/admin</code> and <code>/api/admin</code> to your Access application, then reload.</p>
          <button class="btn secondary" on:click={() => location.reload()}>Reload</button>
        </section>
      {/if}
    {:else}
      <form class="panel form" on:submit|preventDefault={createRoom}>
        <h2><Icon name="plus" size={18} /> New room</h2>
        <div>
          <label class="field-label" for="label">Name <span class="muted">(optional)</span></label>
          <div class="row">
            <input id="label" class="input" type="text" bind:value={label} placeholder="e.g. Family call" maxlength="60" />
            <button class="btn primary" type="submit" disabled={creating || (usePassword && !roomPassword)}>{creating ? 'Creating…' : 'Create room'}</button>
          </div>
        </div>

        <button type="button" class="options-toggle" aria-expanded={showOptions} aria-controls="room-options" on:click={() => (showOptions = !showOptions)}>
          <span class="options-summary">
            <strong>Options</strong>
            <span class="muted">{optionsSummary}</span>
          </span>
          <span class="chev" class:up={showOptions}><Icon name="chevron-down" size={16} /></span>
        </button>

        {#if showOptions}
          <div class="options" id="room-options">
            <label class="option">
              <input type="checkbox" bind:checked={approval} />
              <span>
                <strong>I let people in</strong>
                <small>{approval ? 'People wait in a lobby until you let them in. Recommended.' : 'Anyone with the link (and password, if set) joins straight away.'}</small>
              </span>
            </label>
            <div>
              <label class="option">
                <input type="checkbox" checked={usePassword} on:change={togglePassword} />
                <span>
                  <strong>Require a password</strong>
                  <small>{usePassword ? "People need this as well as the link. It's shown with the room's invite link later." : 'The link alone is enough.'}</small>
                </span>
              </label>
              {#if usePassword}
                <div class="row pw-row">
                  <input class="input mono" type="text" bind:value={roomPassword} aria-label="Room password" autocomplete="off" spellcheck="false" />
                  <button type="button" class="btn secondary small" on:click={generatePassword}>New one</button>
                </div>
              {/if}
            </div>
            <WhenPicker id="when" legend="Meeting time (optional, for calendar invites)" bind:value={when} />
            <label class="select-row">
              <span>The link works for{when.startsAt != null ? ' (at least until the meeting ends)' : ''}</span>
              <select class="input" bind:value={expiresInHours}>
                {#each EXPIRY_OPTIONS as opt}
                  <option value={opt.hours}>{opt.label}</option>
                {/each}
              </select>
            </label>
          </div>
        {/if}
        {#if createError}<span class="error" role="alert">{createError}</span>{/if}
      </form>

      {#if rooms.length > 0}
        <section class="rooms" aria-labelledby="rooms-title">
          <div class="rooms-head">
            <h3 id="rooms-title">Your rooms</h3>
            <span class="muted small-text">Kept only in this browser</span>
          </div>
          {#each rooms as room (room.roomId)}
            <RoomCard
              {room}
              emailInvites={!!config?.emailInvites}
              fresh={room.roomId === freshId}
              on:start={(e) => startCall(e.detail)}
              on:remove={(e) => removeRoom(e.detail)}
              on:unauthorized={() => (authenticated = false)}
              on:schedule={updateSchedule}
              on:sent={rememberInvites}
            />
          {/each}
        </section>
      {:else}
        <p class="muted small-text empty">Make a room, then use <strong>Invite people</strong> to send the link.</p>
      {/if}
    {/if}
  </div>

  {#if deleted}
    <div class="toast fade-in" role="status">
      <span class="toast-text">
        <strong>Deleted “{deleted.room.label || 'Untitled room'}”</strong>
        <small>Links you already sent keep working until they expire.</small>
      </span>
      <button class="btn secondary small" on:click={undoRemove}><Icon name="undo" size={15} /> Undo</button>
      <button class="btn ghost icon small" aria-label="Dismiss" on:click={() => (deleted = null)}><Icon name="x" size={15} /></button>
    </div>
  {/if}
</div>

<style>
  .page {
    height: 100%;
    overflow-y: auto;
    padding: var(--space-8) var(--space-4);
    background:
      radial-gradient(ellipse 70% 40% at 50% 0%, var(--accent-soft), transparent 70%),
      var(--bg);
  }

  .shell {
    width: 100%;
    max-width: 600px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
    padding: 0 var(--space-1);
  }

  .brand {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--text);
    font-size: var(--text-xl);
    font-weight: 700;
    letter-spacing: -0.02em;
  }

  .brand:hover {
    text-decoration: none;
  }

  .brand .chip {
    letter-spacing: 0;
  }

  .mark {
    width: 28px;
    height: 28px;
  }

  .who {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    min-width: 0;
  }

  .email {
    font-size: var(--text-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 200px;
  }

  .panel {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-md);
    padding: var(--space-6);
  }

  .stack {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-3);
  }

  .form {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  h2,
  h3 {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-lg);
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  h3 {
    margin-bottom: var(--space-1);
  }

  .row {
    display: flex;
    gap: var(--space-2);
  }

  .row .input {
    flex: 1;
    min-width: 0;
  }

  .select-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-muted);
    min-height: 36px;
  }



  .select-row .input {
    width: auto;
    margin-left: auto;
  }











  .muted {
    color: var(--text-muted);
  }

  .mono {
    font-family: var(--font-mono, monospace);
  }

  .options-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    width: 100%;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius);
    background: var(--bg-elevated);
    color: var(--text);
    font: inherit;
    font-size: var(--text-sm);
    text-align: left;
    cursor: pointer;
  }

  .options-toggle:hover {
    border-color: var(--border-strong);
  }

  .options-summary {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .chev {
    display: inline-flex;
    color: var(--text-muted);
    transition: transform var(--dur-fast) var(--ease);
  }

  .chev.up {
    transform: rotate(180deg);
  }

  .options {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .option {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    cursor: pointer;
  }

  .option input[type='checkbox'] {
    width: 18px;
    height: 18px;
    margin-top: 2px;
    flex-shrink: 0;
    accent-color: var(--accent);
  }

  .option > span {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }

  .option small {
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  .pw-row {
    margin: var(--space-2) 0 0 calc(18px + var(--space-3));
  }

  .rooms {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .rooms-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    padding: 0 var(--space-1);
  }

  .toast {
    position: fixed;
    left: 0;
    right: 0;
    margin: 0 auto;
    bottom: var(--space-6);
    z-index: 50;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: max-content;
    max-width: calc(100vw - 2 * var(--space-4));
    padding: var(--space-3) var(--space-3) var(--space-3) var(--space-4);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-md);
  }

  .toast-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    font-size: var(--text-sm);
  }

  .toast-text strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .toast-text small {
    color: var(--text-muted);
  }

  .empty {
    text-align: center;
    margin: 0;
  }

  .small-text {
    font-size: var(--text-sm);
  }

  .error {
    color: var(--danger);
    font-size: var(--text-sm);
  }

  .code-input {
    font-family: var(--font-mono, monospace);
    font-size: var(--text-xl);
    letter-spacing: 0.3em;
    text-align: center;
  }

  .link-btn {
    align-self: center;
  }

  code {
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    padding: 1px 6px;
    border-radius: var(--radius-sm);
    font-size: 0.85em;
  }

  @media (max-width: 480px) {
    .panel {
      padding: var(--space-4);
    }
    .row {
      flex-direction: column;
    }
    .select-row {
      flex-wrap: wrap;
    }
    .select-row .input {
      margin-left: 0;
      width: 100%;
    }
  }
</style>
