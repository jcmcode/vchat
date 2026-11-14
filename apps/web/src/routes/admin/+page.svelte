<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import Icon from '$lib/ui/Icon.svelte';
  import { generateRoomKey } from '$lib/webrtc/e2e-proof';
  import { downloadIcs, inviteText, mailtoLink, type MeetingInvite } from '$lib/invites';
  import {
    apiUrl,
    fetchServerConfig,
    getSavedRooms,
    pruneSavedRooms,
    clearSavedRooms,
    saveRooms,
    inviteUrl,
    setRoomToken,
    setRoomKey,
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

  // Email sign-in: ask for a code, then enter it.
  let loginEmail = '';
  let loginChallenge = '';
  let loginCode = '';
  let codeSentTo = '';

  // Emailed invites (sent by the server through Resend).
  let invitingRoomId = '';
  let inviteEmail = '';
  let inviteIncludeKey = true;
  let sendingInvite = false;
  let inviteStatus: { ok: boolean; text: string } | null = null;

  let label = '';
  let roomPassword = '';
  let approval = true;
  let expiresInHours = 24;
  /** Optional schedule (datetime-local value) and length, for calendar/email invites. */
  let scheduleAt = '';
  let durationMinutes = 60;
  const DURATIONS = [15, 30, 45, 60, 90, 120];
  let creating = false;
  let createError = '';

  let rooms: SavedRoom[] = [];
  /** The room just created, plus its password (shown once, never stored). */
  let created: { room: SavedRoom; password: string } | null = null;
  let copiedKey = '';

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

  function openInviteForm(room: SavedRoom) {
    invitingRoomId = invitingRoomId === room.roomId ? '' : room.roomId;
    inviteEmail = '';
    inviteIncludeKey = true;
    inviteStatus = null;
  }

  async function sendEmailInvite(room: SavedRoom) {
    const to = inviteEmail.trim();
    if (!to) return;
    sendingInvite = true;
    inviteStatus = null;
    try {
      const { res, body } = await postJson('/api/admin/rooms/email-invite', {
        roomId: room.roomId,
        inviteToken: room.inviteToken,
        email: to,
        ...(inviteIncludeKey && room.key ? { key: room.key } : {}),
      });
      if (res.ok) {
        inviteStatus = { ok: true, text: `Invite sent to ${to}, with their own 6-digit code.` };
        inviteEmail = '';
      } else {
        if (res.status === 401) authenticated = false;
        const msg =
          res.status === 400 ? "That email address doesn't look right." :
          res.status === 429 ? 'Too many invites sent recently. Try again later.' :
          res.status === 503 ? "This server isn't set up to send email." :
          typeof body.error === 'string' ? body.error : "The invite couldn't be sent. Try again.";
        inviteStatus = { ok: false, text: msg };
      }
    } catch {
      inviteStatus = { ok: false, text: 'Could not reach the server.' };
    } finally {
      sendingInvite = false;
    }
  }

  async function logout() {
    // Saved rooms hold host links and room keys: don't leave them in this browser.
    clearSavedRooms();
    rooms = [];
    if (config?.auth === 'access') {
      window.location.href = '/cdn-cgi/access/logout';
      return;
    }
    await fetch(apiUrl('/api/admin/logout'), { method: 'POST', credentials: 'same-origin' });
    authenticated = false;
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
      const startsAt = scheduleAt ? new Date(scheduleAt).getTime() : undefined;
      let hours = expiresInHours;
      if (startsAt && Number.isFinite(startsAt)) {
        const needed = Math.ceil((startsAt + durationMinutes * 60_000 + 2 * 3600_000 - Date.now()) / 3600_000);
        hours = Math.min(Math.max(hours, needed), 30 * 24);
      }
      const res = await fetch(apiUrl('/api/admin/rooms'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ label, password: roomPassword, approval, expiresInHours: hours }),
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
        ...(startsAt && Number.isFinite(startsAt) ? { startsAt, durationMinutes } : {}),
      };
      rooms = [room, ...rooms];
      saveRooms(rooms);
      created = { room, password: roomPassword };
      label = '';
      roomPassword = '';
      scheduleAt = '';
    } finally {
      creating = false;
    }
  }

  /** The invite link, including the room's end-to-end key after "#". */
  function linkFor(room: SavedRoom): string {
    return inviteUrl(room.roomId, room.inviteToken, room.key);
  }

  function inviteFor(room: SavedRoom): MeetingInvite {
    return {
      title: room.label || 'Video call',
      link: linkFor(room),
      startsAt: room.startsAt,
      durationMinutes: room.durationMinutes,
      hasPassword: room.hasPassword,
    };
  }

  function inviteMessage(room: SavedRoom): string {
    return inviteText(inviteFor(room));
  }

  function emailInvite(room: SavedRoom) {
    window.location.href = mailtoLink(inviteFor(room));
  }

  function formatSchedule(room: SavedRoom): string {
    if (!room.startsAt) return '';
    return new Date(room.startsAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      copiedKey = key;
      setTimeout(() => {
        if (copiedKey === key) copiedKey = '';
      }, 2000);
    } catch {
      // clipboard unavailable (e.g. insecure context)
    }
  }

  async function share(room: SavedRoom) {
    try {
      await navigator.share({ title: room.label || 'Video call', text: inviteMessage(room) });
    } catch {
      // cancelled
    }
  }

  function startCall(room: SavedRoom) {
    setRoomToken(room.roomId, room.hostToken);
    if (room.key) setRoomKey(room.roomId, room.key);
    goto(`/room/${room.roomId}`);
  }

  function removeRoom(room: SavedRoom) {
    rooms = rooms.filter((r) => r.roomId !== room.roomId);
    saveRooms(rooms);
    if (created?.room.roomId === room.roomId) created = null;
  }

  function expiresIn(ts: number): string {
    const mins = Math.round((ts - Date.now()) / 60000);
    if (mins < 60) return `${Math.max(mins, 0)} min`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return `${hours} h`;
    return `${Math.round(hours / 24)} days`;
  }

  const canShare = typeof navigator !== 'undefined' && 'share' in navigator;
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
          <button class="btn ghost small" on:click={logout}><Icon name="log-out" size={16} /> Sign out</button>
        </div>
      {/if}
    </header>

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
            <p class="muted small-text">We'll email you a 6-digit code.</p>
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
            <label class="sr-only" for="ownercode">6-digit code</label>
            <!-- svelte-ignore a11y-autofocus -->
            <input
              id="ownercode"
              class="input code-input"
              type="text"
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength="7"
              bind:value={loginCode}
              placeholder="123456"
              autofocus
            />
            {#if loginError}<span class="error" role="alert">{loginError}</span>{/if}
            <button class="btn primary" type="submit" disabled={loginCode.replace(/\D/g, '').length !== 6 || loggingIn}>
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
          <label class="field-label" for="label">Name (optional)</label>
          <input id="label" class="input" type="text" bind:value={label} placeholder="e.g. Family call" maxlength="60" />
        </div>
        <div>
          <label class="field-label" for="roompw">Password (optional)</label>
          <div class="row">
            <input id="roompw" class="input" type="text" bind:value={roomPassword} placeholder="Password (optional)" autocomplete="off" />
            <button type="button" class="btn secondary" on:click={generatePassword}>Generate</button>
          </div>
        </div>
        <label class="toggle-row">
          <input type="checkbox" bind:checked={approval} />
          <span>Guests wait for my approval</span>
        </label>
        <div class="schedule">
          <div>
            <label class="field-label" for="when">When (optional, for calendar invites)</label>
            <input id="when" class="input" type="datetime-local" bind:value={scheduleAt} />
          </div>
          {#if scheduleAt}
            <div>
              <label class="field-label" for="duration">Length</label>
              <select id="duration" class="input" bind:value={durationMinutes}>
                {#each DURATIONS as d}<option value={d}>{d < 60 ? `${d} min` : `${d / 60} h`.replace('.5 h', ' h 30')}</option>{/each}
              </select>
            </div>
          {/if}
        </div>
        <label class="select-row">
          <span>Invite link expires after{scheduleAt ? ' (at least until the meeting ends)' : ''}</span>
          <select class="input" bind:value={expiresInHours}>
            {#each EXPIRY_OPTIONS as opt}
              <option value={opt.hours}>{opt.label}</option>
            {/each}
          </select>
        </label>
        {#if createError}<span class="error" role="alert">{createError}</span>{/if}
        <button class="btn primary" type="submit" disabled={creating}>{creating ? 'Creating…' : 'Create room'}</button>
      </form>

      {#if created}
        <section class="panel created fade-in" aria-live="polite">
          <h3><Icon name="check" size={18} /> Room ready{created.room.label ? `: ${created.room.label}` : ''}</h3>
          <label class="sr-only" for="invitelink">Invite link</label>
          <input id="invitelink" class="input link" readonly value={linkFor(created.room)} on:focus={(e) => e.currentTarget.select()} />
          <div class="actions">
            <button class="btn secondary small" class:done={copiedKey === 'link'} on:click={() => created && copy(linkFor(created.room), 'link')}>
              <Icon name={copiedKey === 'link' ? 'check' : 'copy'} size={16} />
              {copiedKey === 'link' ? 'Copied!' : 'Copy link'}
            </button>
            <button class="btn secondary small" class:done={copiedKey === 'msg'} on:click={() => created && copy(inviteMessage(created.room), 'msg')}>
              <Icon name={copiedKey === 'msg' ? 'check' : 'message'} size={16} />
              {copiedKey === 'msg' ? 'Copied!' : 'Copy invite message'}
            </button>
            {#if config?.emailInvites}
              <button class="btn secondary small" on:click={() => created && openInviteForm(created.room)} title="Email someone their own invite link and code">
                <Icon name="send" size={16} /> Email invite
              </button>
            {:else}
              <button class="btn secondary small" on:click={() => created && emailInvite(created.room)} title="Opens your own email app with the invite drafted">
                <Icon name="send" size={16} /> Email invite
              </button>
            {/if}
            <button class="btn secondary small" on:click={() => created && downloadIcs(inviteFor(created.room))} title="Download a calendar event (.ics) with the link — attach it to an email or open it to add to your calendar">
              <Icon name="calendar" size={16} /> Calendar file
            </button>
            {#if canShare}
              <button class="btn secondary small" on:click={() => created && share(created.room)}><Icon name="share" size={16} /> Share…</button>
            {/if}
            <button class="btn primary small" on:click={() => created && startCall(created.room)}><Icon name="video" size={16} /> Start call</button>
          </div>
          {#if invitingRoomId === created.room.roomId}
            {@const room = created.room}
            <form class="invite-form" on:submit|preventDefault={() => sendEmailInvite(room)}>
              <label class="field-label" for="invite-email-new">Guest's email</label>
              <div class="row">
                <input id="invite-email-new" class="input" type="email" bind:value={inviteEmail} placeholder="guest@example.com" autocomplete="off" />
                <button class="btn primary" type="submit" disabled={!inviteEmail.includes('@') || sendingInvite}>{sendingInvite ? 'Sending…' : 'Send'}</button>
              </div>
              <label class="toggle-row small-text">
                <input type="checkbox" bind:checked={inviteIncludeKey} />
                <span>Include the end-to-end key in the link (one-click join). The key then passes through this server and the email service, and either could use it to listen in unnoticed. For full protection, untick this and send the guest the invite link yourself.</span>
              </label>
              {#if inviteStatus}<p class={inviteStatus.ok ? 'ok small-text' : 'error'} role="status">{inviteStatus.text}</p>{/if}
            </form>
          {/if}
          {#if created.password}
            <p class="pw">
              <span class="muted">Password:</span> <code>{created.password}</code>
              <button class="link-btn" on:click={() => created && copy(created.password, 'pw')}>{copiedKey === 'pw' ? 'Copied!' : 'Copy'}</button>
            </p>
            <p class="muted small-text">Send it separately from the link (e.g. by text). It isn't saved anywhere, so note it now.</p>
          {/if}
          <p class="muted small-text"><Icon name="shield" size={12} /> The link contains this room's end-to-end key. Anyone with the link can join (subject to your password and approval), so share it only with the people you're inviting.</p>
        </section>
      {/if}

      {#if rooms.length > 0}
        <section class="panel rooms">
          <h3>Your rooms</h3>
          <p class="muted small-text">Kept only in this browser. Anyone with a room's invite link can use it until it expires.</p>
          <ul>
            {#each rooms as room (room.roomId)}
              <li class="room-row">
                <div class="room-meta">
                  <strong>{room.label || room.roomId}</strong>
                  <span class="chips">
                    <span class="chip"><Icon name="lock" size={12} /> expires in {expiresIn(room.expiresAt)}</span>
                    {#if room.hasPassword}<span class="chip">password</span>{/if}
                    {#if room.approval}<span class="chip">approval</span>{/if}
                    {#if room.startsAt}<span class="chip accent"><Icon name="calendar" size={12} /> {formatSchedule(room)}</span>{/if}
                  </span>
                </div>
                <div class="actions">
                  <button class="btn secondary small" class:done={copiedKey === room.roomId} on:click={() => copy(linkFor(room), room.roomId)}>
                    <Icon name={copiedKey === room.roomId ? 'check' : 'copy'} size={16} />
                    {copiedKey === room.roomId ? 'Copied!' : 'Copy link'}
                  </button>
                  {#if config?.emailInvites}
                    <button class="btn ghost small icon" class:active={invitingRoomId === room.roomId} on:click={() => openInviteForm(room)} title="Email someone an invite" aria-label="Email someone an invite"><Icon name="send" size={16} /></button>
                  {:else}
                    <button class="btn ghost small icon" on:click={() => emailInvite(room)} title="Email invite" aria-label="Email invite"><Icon name="send" size={16} /></button>
                  {/if}
                  <button class="btn ghost small icon" on:click={() => downloadIcs(inviteFor(room))} title="Calendar file (.ics)" aria-label="Download calendar file"><Icon name="calendar" size={16} /></button>
                  <button class="btn primary small" on:click={() => startCall(room)}>Start</button>
                  <button class="btn ghost danger small icon" on:click={() => removeRoom(room)} title="Remove from this list" aria-label="Remove from this list"><Icon name="trash" size={16} /></button>
                </div>
                {#if invitingRoomId === room.roomId && created?.room.roomId !== room.roomId}
                  <form class="invite-form" on:submit|preventDefault={() => sendEmailInvite(room)}>
                    <label class="field-label" for="invite-email-{room.roomId}">Guest's email</label>
                    <div class="row">
                      <input id="invite-email-{room.roomId}" class="input" type="email" bind:value={inviteEmail} placeholder="guest@example.com" autocomplete="off" />
                      <button class="btn primary" type="submit" disabled={!inviteEmail.includes('@') || sendingInvite}>{sendingInvite ? 'Sending…' : 'Send'}</button>
                    </div>
                    <label class="toggle-row small-text">
                      <input type="checkbox" bind:checked={inviteIncludeKey} />
                      <span>Include the end-to-end key in the link (one-click join). The key then passes through this server and the email service, and either could use it to listen in unnoticed. For full protection, untick this and send the guest the invite link yourself.</span>
                    </label>
                    {#if inviteStatus}<p class={inviteStatus.ok ? 'ok small-text' : 'error'} role="status">{inviteStatus.text}</p>{/if}
                  </form>
                {/if}
              </li>
            {/each}
          </ul>
        </section>
      {/if}
    {/if}
  </div>
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

  .toggle-row,
  .select-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-muted);
    min-height: 36px;
  }

  .toggle-row {
    cursor: pointer;
  }

  .toggle-row input[type='checkbox'] {
    width: 18px;
    height: 18px;
    accent-color: var(--accent);
  }

  .select-row .input {
    width: auto;
    margin-left: auto;
  }

  .created {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    border-color: var(--accent);
    background: linear-gradient(var(--accent-soft), transparent 60%), var(--bg-surface);
  }

  .created h3 {
    color: var(--success);
  }

  .link {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    min-height: 48px;
    color: var(--text);
    border-color: var(--border-strong);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }

  .btn.done {
    color: var(--success);
    border-color: var(--success);
  }

  .pw {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
    font-size: var(--text-sm);
  }

  .pw code {
    font-size: var(--text-base);
  }

  ul {
    list-style: none;
    margin-top: var(--space-3);
  }

  .room-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) 0;
    border-top: 1px solid var(--border-subtle);
    flex-wrap: wrap;
  }

  .room-meta {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
  }

  .room-meta strong {
    overflow: hidden;
    text-overflow: ellipsis;
    font-weight: 600;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
  }

  .muted {
    color: var(--text-muted);
  }

  .small-text {
    font-size: var(--text-sm);
  }

  .error {
    color: var(--danger);
    font-size: var(--text-sm);
  }

  .ok {
    color: var(--success, #22c55e);
  }

  .invite-form {
    flex-basis: 100%;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
    margin-top: var(--space-2);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius);
    background: var(--bg-elevated);
  }

  .invite-form .row .input {
    flex: 1;
    min-width: 0;
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
  .schedule {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: var(--space-3);
    align-items: end;
  }

  @media (max-width: 480px) {
    .schedule {
      grid-template-columns: 1fr;
    }
  }
</style>
