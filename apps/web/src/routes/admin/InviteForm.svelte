<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import Icon from '$lib/ui/Icon.svelte';
  import { apiUrl, type SavedRoom } from '$lib/stores/room';
  import WhenPicker from '$lib/ui/WhenPicker.svelte';
  import { durationLabel } from '$lib/invites';
  import { formatRange, type When } from '$lib/when';
  import { MAX_RECIPIENTS, addRecipients, isValidEmail, parseEmailList, splitTyped } from '$lib/email-list';

  export let room: SavedRoom;

  const dispatch = createEventDispatcher<{
    /** The owner's session ended (401). */
    unauthorized: void;
    /** Invites went out for this schedule (or none): the dashboard keeps it on the room. */
    schedule: { roomId: string; startsAt?: number; durationMinutes?: number };
  }>();

  type FailReason = 'invalid' | 'rate-limited' | 'send-failed';
  type Warning = 'schedule-ignored' | 'meeting-ends-after-invite-expires';

  const uid = `invite-${room.roomId}`;

  // Recipients
  let recipients: string[] = [];
  let draft = '';
  let capNotice = false;
  let inputEl: HTMLInputElement;

  // Options
  let passcode = true;
  let includeKey = true;

  // The host's note, shown in each email and calendar invite. Kept after sending, for the next batch.
  const MESSAGE_MAX = 500;
  let message = '';
  $: messageLength = Array.from(message.trim()).length;
  $: messageTooLong = messageLength > MESSAGE_MAX;

  // Schedule (taken from the room; can be changed or removed for these invites)
  let when: When = { startsAt: room.startsAt ?? null, durationMinutes: room.durationMinutes ?? 60 };
  /** Picker shown (always, until a time is set and confirmed); otherwise a one-line summary. */
  let editingSchedule = !room.startsAt;
  $: startsAt = when.startsAt ?? NaN;
  $: duration = when.durationMinutes;
  $: hasSchedule = Number.isFinite(startsAt);
  $: scheduleInPast = hasSchedule && startsAt < Date.now() - 5 * 60_000;
  $: endsAfterExpiry = hasSchedule && startsAt + duration * 60_000 > room.expiresAt;

  // Sending
  let sending = false;
  let results: { email: string; ok: boolean; reason?: FailReason }[] = [];
  let warnings: Warning[] = [];
  let error = '';

  $: valid = recipients.filter(isValidEmail);
  $: invalidCount = recipients.length - valid.length;
  $: sendLabel = sending ? 'Sending…' : `Send ${valid.length || ''} invite${valid.length === 1 ? '' : 's'}`.replace('  ', ' ');

  function add(list: string[]) {
    if (list.length === 0) return;
    const { list: next, dropped } = addRecipients(recipients, list);
    recipients = next;
    capNotice = dropped > 0;
  }

  function commitDraft() {
    add(parseEmailList(draft));
    draft = '';
  }

  function onInput() {
    const { done, rest } = splitTyped(draft);
    if (done.length > 0) {
      add(done);
      draft = rest;
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      // Enter adds what's typed; with nothing typed it sends.
      if (draft.trim()) {
        e.preventDefault();
        commitDraft();
      }
    } else if (e.key === 'Backspace' && !draft && recipients.length > 0) {
      e.preventDefault();
      draft = recipients[recipients.length - 1];
      recipients = recipients.slice(0, -1);
    }
  }

  function onPaste(e: ClipboardEvent) {
    const text = e.clipboardData?.getData('text') ?? '';
    if (!/[\s,;<@]/.test(text)) return; // a plain word: let the browser paste it
    e.preventDefault();
    add(parseEmailList(`${draft} ${text}`));
    draft = '';
  }

  function remove(email: string) {
    recipients = recipients.filter((r) => r !== email);
    capNotice = false;
    inputEl?.focus();
  }

  /** Put an invalid address back in the box to fix it. */
  function edit(email: string) {
    if (draft.trim()) commitDraft();
    recipients = recipients.filter((r) => r !== email);
    draft = email;
    inputEl?.focus();
  }

  function removeSchedule() {
    when = { ...when, startsAt: null };
    editingSchedule = true;
  }

  const REASONS: Record<FailReason, string> = {
    invalid: "This address wasn't accepted. Check it and try again.",
    'rate-limited': 'Too many invites sent recently. Try again later.',
    'send-failed': "The email service couldn't send it. Try again.",
  };

  const WARNINGS: Record<Warning, string> = {
    'schedule-ignored': "The meeting time couldn't be used, so the emails went out without a calendar invite.",
    'meeting-ends-after-invite-expires': "This room's link expires before the meeting ends. Create the room with a longer expiry.",
  };

  function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  }

  async function send() {
    if (draft.trim()) commitDraft();
    const emails = recipients.filter(isValidEmail);
    if (emails.length === 0 || sending) return;
    sending = true;
    error = '';
    results = [];
    warnings = [];
    try {
      const res = await fetch(apiUrl('/api/admin/rooms/email-invite'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          roomId: room.roomId,
          inviteToken: room.inviteToken,
          emails,
          passcode,
          ...(message.trim() ? { message: Array.from(message.trim()).slice(0, MESSAGE_MAX).join('') } : {}),
          ...(includeKey && room.key ? { key: room.key } : {}),
          ...(hasSchedule ? { schedule: { startsAt, durationMinutes: duration } } : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        if (res.status === 401) dispatch('unauthorized');
        error =
          res.status === 400 ? (typeof body.error === 'string' ? `${body.error}.` : "The server didn't accept this request.") + ' Check the addresses and try again.' :
          res.status === 401 ? "You've been signed out. Sign in again to send invites." :
          res.status === 403 ? 'The server refused this request. Reload the page and try again.' :
          res.status === 429 ? 'Too many invites sent recently. Try again later.' :
          res.status === 503 ? "This server isn't set up to send email." :
          "The invites couldn't be sent. Try again.";
        return;
      }
      const sent = new Set(strings(body.sent).map((e) => e.toLowerCase()));
      const failed = new Map<string, FailReason>();
      if (Array.isArray(body.failed)) {
        for (const f of body.failed as { email?: unknown; reason?: unknown }[]) {
          if (typeof f?.email !== 'string') continue;
          const reason = f.reason === 'invalid' || f.reason === 'rate-limited' ? f.reason : 'send-failed';
          failed.set(f.email.toLowerCase(), reason);
        }
      }
      results = emails.map((email) => {
        const key = email.toLowerCase();
        if (sent.has(key)) return { email, ok: true };
        return { email, ok: false, reason: failed.get(key) ?? 'send-failed' };
      });
      warnings = strings(body.warnings).filter((w): w is Warning => w in WARNINGS);
      // Keep what failed for another try; the sent ones are done.
      recipients = recipients.filter((r) => !sent.has(r.toLowerCase()));
      capNotice = false;
      if (sent.size > 0) {
        dispatch('schedule', {
          roomId: room.roomId,
          ...(hasSchedule && !warnings.includes('schedule-ignored') ? { startsAt, durationMinutes: duration } : {}),
        });
      }
    } catch {
      error = 'Could not reach the server. Check your connection and try again.';
    } finally {
      sending = false;
    }
  }
</script>

<form class="invite-form" on:submit|preventDefault={send} aria-labelledby="{uid}-title">
  <h4 id="{uid}-title"><Icon name="send" size={16} /> Email invites</h4>

  <div>
    <label class="field-label" for="{uid}-emails">Send to</label>
    <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
    <div class="recipients" class:has-invalid={invalidCount > 0} on:click|self={() => inputEl?.focus()}>
      {#each recipients as email (email)}
        {@const ok = isValidEmail(email)}
        <span class="recipient" class:invalid={!ok}>
          {#if ok}
            <span class="recipient-text">{email}</span>
          {:else}
            <button type="button" class="recipient-text edit" on:click={() => edit(email)} title="Not a valid email address. Click to edit.">
              {email}<span class="sr-only"> (not a valid email address, click to edit)</span>
            </button>
          {/if}
          <button type="button" class="recipient-remove" on:click={() => remove(email)} aria-label="Remove {email}">
            <Icon name="x" size={12} />
          </button>
        </span>
      {/each}
      <input
        id="{uid}-emails"
        bind:this={inputEl}
        bind:value={draft}
        on:input={onInput}
        on:keydown={onKeydown}
        on:paste={onPaste}
        on:blur={commitDraft}
        type="text"
        inputmode="email"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        placeholder={recipients.length ? '' : 'guest@example.com, another@example.com'}
        aria-describedby="{uid}-emails-hint"
      />
    </div>
    <p id="{uid}-emails-hint" class="hint" class:warn={invalidCount > 0 || capNotice} aria-live="polite">
      {#if invalidCount > 0}
        {invalidCount === 1 ? "1 address doesn't" : `${invalidCount} addresses don't`} look right. Fix or remove {invalidCount === 1 ? 'it' : 'them'} (marked in red).
      {:else if capNotice || recipients.length >= MAX_RECIPIENTS}
        Up to {MAX_RECIPIENTS} people at a time.
      {:else}
        Separate addresses with commas or spaces, or paste a list. Each person gets their own email.
      {/if}
    </p>
  </div>

  <div>
    <label class="field-label" for="{uid}-message">Message (optional)</label>
    <textarea
      id="{uid}-message"
      class="input message"
      rows="3"
      bind:value={message}
      placeholder="e.g. Quick catch-up about the trip. Bring your questions!"
      aria-describedby="{uid}-message-hint"
    ></textarea>
    <p id="{uid}-message-hint" class="hint message-hint" class:warn={messageTooLong}>
      <span>{messageTooLong ? `Only the first ${MESSAGE_MAX} characters will be sent.` : 'Shown in the email and calendar invite.'}</span>
      <span class="count" aria-label="{messageLength} of {MESSAGE_MAX} characters">{messageLength}/{MESSAGE_MAX}</span>
    </p>
  </div>

  <label class="option">
    <input type="checkbox" bind:checked={passcode} />
    <span>
      <strong>Require a passcode</strong>
      <small>{passcode ? 'Each person gets their own 6-digit code.' : "No code. You'll let each person in from the lobby."}</small>
    </span>
  </label>

  {#if room.key}
    <label class="option">
      <input type="checkbox" bind:checked={includeKey} />
      <span>
        <strong>Include the end-to-end key in the link</strong>
        <small>One-click join. The key then passes through this server, the email service and (with a calendar invite) the guest's calendar, and anyone with access to those could use it to listen in unnoticed. For full protection, untick this and send the guest the invite link yourself.</small>
      </span>
    </label>
  {/if}

  <div class="schedule">
    {#if hasSchedule && !editingSchedule}
      <p class="schedule-summary">
        <Icon name="calendar" size={16} />
        <span>Calendar invite for <strong>{formatRange(startsAt, duration)}</strong> ({durationLabel(duration)})</span>
      </p>
      <div class="schedule-actions">
        <button type="button" class="link-btn" on:click={() => (editingSchedule = true)}>Change</button>
        <button type="button" class="link-btn" on:click={removeSchedule}>Remove</button>
      </div>
    {:else}
      <WhenPicker
        id="{uid}-when"
        legend="Meeting time (optional)"
        emptyText="No date: the emails go out without a calendar invite. Pick a day to add one."
        bind:value={when}
      />
      {#if hasSchedule}
        <div class="schedule-actions">
          <button type="button" class="link-btn" on:click={() => (editingSchedule = false)}>Done</button>
        </div>
      {/if}
    {/if}
    {#if hasSchedule}
      <p class="hint">Each email includes a calendar invite they can add to their calendar{passcode ? ", with the link and their code" : ", with the link"}.</p>
    {/if}
    {#if scheduleInPast}
      <p class="hint warn">That time is in the past.</p>
    {:else if endsAfterExpiry}
      <p class="hint warn">This room's link expires before the meeting ends. Create the room with a longer expiry.</p>
    {/if}
  </div>

  <button class="btn primary send" type="submit" disabled={valid.length === 0 || sending}>
    <Icon name="send" size={16} /> {sendLabel}
  </button>

  {#if error}<p class="error" role="alert">{error}</p>{/if}

  {#if results.length > 0}
    <ul class="results" aria-label="Invite results" aria-live="polite">
      {#each results as r (r.email)}
        <li class:ok={r.ok} class:failed={!r.ok}>
          <span class="result-icon"><Icon name={r.ok ? 'check' : 'x'} size={14} /></span>
          <span class="result-text">
            <span class="result-email">{r.email}</span>
            <small>{r.ok ? 'Sent' : REASONS[r.reason ?? 'send-failed']}</small>
          </span>
        </li>
      {/each}
    </ul>
    {#if results.some((r) => !r.ok)}
      <p class="hint">The ones that failed are still in the list above, ready to try again.</p>
    {/if}
  {/if}

  {#each warnings as w}
    <p class="warning" role="status"><Icon name="shield-alert" size={14} /> {WARNINGS[w]}</p>
  {/each}
</form>

<style>
  .invite-form {
    flex-basis: 100%;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-4);
    margin-top: var(--space-2);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius);
    background: var(--bg-elevated);
  }

  h4 {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-base);
    font-weight: 600;
  }

  .recipients {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1);
    min-height: var(--control-h);
    padding: 5px var(--space-2);
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    cursor: text;
    transition: border-color var(--dur-fast) var(--ease), box-shadow var(--dur-fast) var(--ease);
  }

  .recipients:hover {
    border-color: var(--border-strong);
  }

  .recipients:focus-within {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-ring);
  }

  .recipients input {
    flex: 1 1 140px;
    min-width: 0;
    min-height: 32px;
    border: none;
    background: transparent;
    color: var(--text);
    font-size: var(--text-base);
    padding: 0 var(--space-1);
  }

  .recipients input:focus {
    outline: none;
  }

  .recipient {
    display: inline-flex;
    align-items: center;
    max-width: 100%;
    min-width: 0;
    gap: 2px;
    padding-left: var(--space-2);
    border-radius: var(--radius-pill);
    background: var(--accent-soft);
    color: var(--text);
    font-size: var(--text-sm);
    line-height: 1.2;
  }

  .recipient.invalid {
    background: var(--danger-soft);
    color: var(--danger);
    text-decoration: underline wavy;
    text-underline-offset: 3px;
  }

  .recipient-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .recipient-text.edit {
    background: none;
    border: none;
    padding: 0;
    color: inherit;
    font: inherit;
    text-decoration: inherit;
    cursor: pointer;
  }

  .recipient-remove {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: inherit;
    opacity: 0.75;
  }

  .recipient-remove:hover {
    opacity: 1;
    background: var(--bg-hover);
  }

  .hint {
    margin-top: var(--space-1);
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .hint.warn {
    color: var(--warning);
  }

  .message {
    display: block;
    min-height: 76px;
    padding: var(--space-2) var(--space-3);
    line-height: 1.45;
    resize: vertical;
  }

  .message-hint {
    display: flex;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .count {
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
  }

  .option {
    display: flex;
    gap: var(--space-2);
    align-items: flex-start;
    cursor: pointer;
  }

  .option input {
    width: 18px;
    height: 18px;
    margin-top: 1px;
    flex-shrink: 0;
    accent-color: var(--accent);
  }

  .option span {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  .option strong {
    font-size: var(--text-sm);
    font-weight: 500;
  }

  .option small {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .schedule {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .schedule-summary {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--text);
  }

  .schedule-summary :global(svg) {
    flex-shrink: 0;
    margin-top: 1px;
    color: var(--accent);
  }

  .schedule-actions {
    display: flex;
    gap: var(--space-2);
  }

  .schedule-actions .link-btn {
    padding-left: 0;
    padding-right: var(--space-2);
  }

  .send {
    align-self: flex-start;
  }

  .error {
    color: var(--danger);
    font-size: var(--text-sm);
  }

  .warning {
    display: flex;
    gap: var(--space-2);
    align-items: flex-start;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    background: var(--warning-soft);
    color: var(--warning);
    font-size: var(--text-sm);
  }

  .warning :global(svg) {
    flex-shrink: 0;
    margin-top: 2px;
  }

  .results {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin: 0;
  }

  .results li {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    font-size: var(--text-sm);
    min-width: 0;
  }

  .result-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 22px;
    height: 22px;
    border-radius: 50%;
  }

  .results li.ok .result-icon {
    background: var(--success-soft);
    color: var(--success);
  }

  .results li.failed .result-icon {
    background: var(--danger-soft);
    color: var(--danger);
  }

  .result-text {
    display: grid;
    min-width: 0;
  }

  .result-email {
    overflow-wrap: anywhere;
  }

  .result-text small {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .results li.failed small {
    color: var(--danger);
  }

  @media (max-width: 480px) {
    .invite-form {
      padding: var(--space-3);
    }
    .send {
      align-self: stretch;
    }
  }
</style>
