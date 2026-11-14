<script lang="ts">
  // One room on the owner's dashboard: start the call, or invite people to it. Inviting has two
  // ways, each self-contained: share the room's link (with its password right next to it), or email
  // each person their own link and code.
  import { createEventDispatcher } from 'svelte';
  import Icon from '$lib/ui/Icon.svelte';
  import { downloadIcs, inviteText, mailtoLink, type MeetingInvite } from '$lib/invites';
  import { inviteUrl, type PersonalInvite, type SavedRoom } from '$lib/stores/room';
  import InviteForm from './InviteForm.svelte';

  export let room: SavedRoom;
  /** The server can send invite emails itself. */
  export let emailInvites = false;
  /** Just created: open and highlighted. */
  export let fresh = false;

  const dispatch = createEventDispatcher<{
    start: SavedRoom;
    remove: SavedRoom;
    unauthorized: void;
    schedule: { roomId: string; startsAt?: number; durationMinutes?: number };
    sent: { roomId: string; invites: PersonalInvite[] };
  }>();

  let open = fresh;
  let tab: 'link' | 'email' = 'link';
  let copied = '';
  let showPassword = false;
  let confirmRemove = false;

  const canShare = typeof navigator !== 'undefined' && 'share' in navigator;
  $: link = inviteUrl(room.roomId, room.inviteToken, room.key);
  $: invited = room.invites ?? [];
  $: title = room.label || 'Untitled room';

  function meeting(withPassword = false): MeetingInvite {
    return {
      title: room.label || 'Video call',
      link,
      startsAt: room.startsAt,
      durationMinutes: room.durationMinutes,
      hasPassword: room.hasPassword,
      ...(withPassword && room.password ? { password: room.password } : {}),
    };
  }

  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = key;
      setTimeout(() => {
        if (copied === key) copied = '';
      }, 2000);
    } catch {
      // clipboard unavailable (e.g. insecure context)
    }
  }

  async function share() {
    try {
      await navigator.share({ title: room.label || 'Video call', text: inviteText(meeting()) });
    } catch {
      // cancelled
    }
  }

  function remove() {
    if (!confirmRemove) {
      confirmRemove = true;
      setTimeout(() => (confirmRemove = false), 4000);
      return;
    }
    dispatch('remove', room);
  }

  function expiresIn(ts: number): string {
    const mins = Math.round((ts - Date.now()) / 60000);
    if (mins < 60) return `${Math.max(mins, 0)} min`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return `${hours} hours`;
    return `${Math.round(hours / 24)} days`;
  }

  function when(ts: number): string {
    return new Date(ts).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function ago(ts: number): string {
    const mins = Math.round((Date.now() - ts) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return `${hours} h ago`;
    return `${Math.round(hours / 24)} days ago`;
  }

  /** "123 456": easier to read out. */
  function spaced(code: string): string {
    return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
  }
</script>

<article class="room" class:fresh class:open aria-labelledby="room-{room.roomId}">
  <header class="head">
    <div class="meta">
      {#if fresh}<span class="badge"><Icon name="check" size={12} /> Ready</span>{/if}
      <h3 id="room-{room.roomId}">{title}</h3>
      <p class="facts">
        {#if room.startsAt}<span><Icon name="calendar" size={12} /> {when(room.startsAt)}</span>{/if}
        <span>Link works for {expiresIn(room.expiresAt)}</span>
        {#if room.hasPassword}<span><Icon name="lock" size={12} /> Password</span>{/if}
        <span>{room.approval ? 'You let people in' : 'People join directly'}</span>
      </p>
    </div>
    <div class="main-actions">
      <button class="btn secondary" aria-expanded={open} on:click={() => (open = !open)}>
        <Icon name="users" size={16} /> Invite people
        <span class="chev" class:up={open}><Icon name="chevron-down" size={14} /></span>
      </button>
      <button class="btn primary" on:click={() => dispatch('start', room)}><Icon name="video" size={16} /> Start call</button>
    </div>
  </header>

  {#if open}
    <div class="invite">
      {#if emailInvites}
        <div class="tabs" role="tablist" aria-label="How to invite">
          <button role="tab" aria-selected={tab === 'link'} class:on={tab === 'link'} on:click={() => (tab = 'link')}>
            <Icon name="link" size={15} /> Share a link
          </button>
          <button role="tab" aria-selected={tab === 'email'} class:on={tab === 'email'} on:click={() => (tab = 'email')}>
            <Icon name="send" size={15} /> Email people
          </button>
        </div>
      {/if}

      {#if tab === 'link' || !emailInvites}
        <div class="pane" role={emailInvites ? 'tabpanel' : undefined}>
          <p class="explain">
            Send this link to the people you want in the call{room.hasPassword ? ', along with the password' : ''}.
            {room.approval ? "When they open it, you'll be asked to let them in." : ''}
          </p>

          <div class="item">
            <span class="item-label">1 · Link</span>
            <div class="field">
              <input class="input mono" readonly value={link} aria-label="Invite link" on:focus={(e) => e.currentTarget.select()} />
              <button class="btn secondary small" class:done={copied === 'link'} on:click={() => copy(link, 'link')}>
                <Icon name={copied === 'link' ? 'check' : 'copy'} size={15} />
                {copied === 'link' ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>

          {#if room.hasPassword}
            <div class="item">
              <span class="item-label">2 · Password</span>
              {#if room.password}
                <div class="field">
                  <code class="secret">{showPassword ? room.password : '•'.repeat(Math.min(room.password.length, 12))}</code>
                  <button class="link-btn" on:click={() => (showPassword = !showPassword)}>{showPassword ? 'Hide' : 'Show'}</button>
                  <button class="btn secondary small" class:done={copied === 'pw'} on:click={() => room.password && copy(room.password, 'pw')}>
                    <Icon name={copied === 'pw' ? 'check' : 'copy'} size={15} />
                    {copied === 'pw' ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <p class="hint">Safest: send the password in a different message or app than the link.</p>
              {:else}
                <p class="hint">This room was made before passwords were saved, so it isn't shown. Make a new room to see it here.</p>
              {/if}
            </div>
          {/if}

          <div class="more">
            <span class="item-label">Or</span>
            <button class="btn ghost small" class:done={copied === 'msg'} on:click={() => copy(inviteText(meeting()), 'msg')}>
              <Icon name={copied === 'msg' ? 'check' : 'message'} size={15} />
              {copied === 'msg' ? 'Copied' : 'Copy a ready-to-send message'}
            </button>
            {#if room.password}
              <button
                class="btn ghost small"
                class:done={copied === 'msgpw'}
                title="Simplest for them, but anyone who sees the message can get in"
                on:click={() => copy(inviteText(meeting(true)), 'msgpw')}
              >
                <Icon name={copied === 'msgpw' ? 'check' : 'lock'} size={15} />
                {copied === 'msgpw' ? 'Copied' : 'Message with the password included'}
              </button>
            {/if}
            {#if canShare}
              <button class="btn ghost small" on:click={share}><Icon name="share" size={15} /> Share…</button>
            {/if}
            {#if !emailInvites}
              <a class="btn ghost small" href={mailtoLink(meeting())}><Icon name="send" size={15} /> Draft an email</a>
            {/if}
            <button class="btn ghost small" on:click={() => downloadIcs(meeting())} title="A calendar event with the link, to attach to an email or add to a calendar">
              <Icon name="calendar" size={15} /> Calendar file
            </button>
          </div>
          <p class="hint"><Icon name="shield" size={12} /> The link holds this room's end-to-end key. Only give it to people you're inviting.</p>
        </div>
      {:else}
        <div class="pane" role="tabpanel">
          <p class="explain">Each person gets an email with their own link and a 6-digit code. Their link only works with their code.</p>
          <InviteForm {room} on:unauthorized on:schedule on:sent />
        </div>
      {/if}

      {#if invited.length > 0}
        <div class="invited">
          <span class="item-label">Invited by email</span>
          <ul>
            {#each invited as inv (inv.email)}
              <li>
                <span class="who">
                  <span class="addr">{inv.email}</span>
                  <small>sent {ago(inv.sentAt)}{inv.code ? '' : ' · no code, you let them in'}</small>
                </span>
                {#if inv.code}
                  <code class="code" title="Their code">{spaced(inv.code)}</code>
                  <button class="link-btn" on:click={() => inv.code && copy(inv.code, `c:${inv.email}`)}>
                    {copied === `c:${inv.email}` ? 'Copied' : 'Copy code'}
                  </button>
                {/if}
                <button
                  class="link-btn"
                  title="Their own link, to send another way (e.g. by text) if the email didn't arrive"
                  on:click={() => copy(inviteUrl(room.roomId, inv.token, room.key), `l:${inv.email}`)}
                >
                  {copied === `l:${inv.email}` ? 'Copied' : 'Copy their link'}
                </button>
              </li>
            {/each}
          </ul>
          <p class="hint">If someone can't get in, send them their link and code by text.</p>
        </div>
      {/if}

      <div class="foot">
        <button class="link-btn danger" on:click={remove}>
          {confirmRemove ? 'Click again to remove it from this list' : 'Remove from this list'}
        </button>
      </div>
    </div>
  {/if}
</article>

<style>
  .room {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-5);
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
    min-width: 0;
  }

  .room.fresh {
    border-color: var(--accent);
    background: linear-gradient(var(--accent-soft), transparent 120px), var(--bg-surface);
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .meta {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    flex: 1 1 220px;
  }

  .badge {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--success);
  }

  h3 {
    font-size: var(--text-lg);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .facts {
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 2px var(--space-3);
    font-size: var(--text-sm);
    color: var(--text-muted);
  }

  .facts span {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .main-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .chev {
    display: inline-flex;
    transition: transform var(--dur-fast) var(--ease);
  }

  .chev.up {
    transform: rotate(180deg);
  }

  .invite {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding-top: var(--space-4);
    border-top: 1px solid var(--border-subtle);
  }

  .tabs {
    display: flex;
    gap: 4px;
    padding: 4px;
    border-radius: var(--radius);
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
  }

  .tabs button {
    flex: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    height: 36px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: var(--text-sm);
    font-weight: 600;
    cursor: pointer;
  }

  .tabs button.on {
    background: var(--bg-surface);
    color: var(--text);
    box-shadow: var(--shadow-sm);
  }

  .pane {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .explain {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  .item {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .item-label {
    font-size: var(--text-xs);
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-subtle);
  }

  .field {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }

  .field .input {
    flex: 1;
    min-width: 0;
  }

  .mono {
    font-family: var(--font-mono, monospace);
    font-size: var(--text-sm);
  }

  .secret,
  .code {
    font-family: var(--font-mono, monospace);
    font-size: var(--text-lg);
    letter-spacing: 0.06em;
    padding: 4px 10px;
    border-radius: var(--radius-sm);
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
  }

  .code {
    font-size: var(--text-base);
  }

  .more {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1) var(--space-2);
  }

  .hint {
    margin: 0;
    display: flex;
    align-items: center;
    gap: var(--space-1);
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .btn.done {
    color: var(--success);
    border-color: var(--success);
  }

  .invited {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .invited ul {
    list-style: none;
    margin: 0;
    display: flex;
    flex-direction: column;
  }

  .invited li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1) var(--space-3);
    padding: var(--space-2) 0;
    border-top: 1px solid var(--border-subtle);
    font-size: var(--text-sm);
  }

  .who {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1 1 180px;
  }

  .who small {
    color: var(--text-muted);
  }

  .addr {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .foot {
    display: flex;
    justify-content: flex-end;
  }

  .link-btn.danger {
    color: var(--danger);
    font-size: var(--text-sm);
  }

  @media (max-width: 480px) {
    .room {
      padding: var(--space-4);
    }
    .main-actions,
    .main-actions .btn {
      width: 100%;
    }
    .main-actions .btn {
      justify-content: center;
    }
  }
</style>
