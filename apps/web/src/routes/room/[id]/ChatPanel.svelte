<script lang="ts">
  import { createEventDispatcher, afterUpdate, onDestroy, tick } from 'svelte';
  import { get } from 'svelte/store';
  import type { ChatMessage } from '$lib/webrtc/mesh';
  import { typingPeers, privateTypingPeers, sendTypingIndicator, sendFileToRoom, sendChatMessage, peers } from '$lib/webrtc/mesh';
  import Icon from '$lib/ui/Icon.svelte';
  import { fileTransfers, MAX_FILE_SIZE, MAX_PREVIEW_BYTES, type FileTransferEntry } from '$lib/webrtc/file-transfer';
  import { isSafeToPreview } from '$lib/webrtc/image-size';
  import { getLocalDisplayName } from '$lib/webrtc/mesh';
  import { roomName } from '$lib/collab/room-meta';
  import { linkify, type ChatPart } from '$lib/chat/linkify';
  import { formatTranscript, transcriptFileName, formatBytes } from '$lib/chat/transcript';
  import {
    EVERYONE,
    fileThreadOf,
    messagesIn,
    unreadByThread,
    privatePartners,
    unseenFileCount,
    markThreadSeen,
    markFilesSeen,
    seenMessageIds,
    seenFileKeys,
  } from '$lib/chat/threads';

  // Links in a message are found once (a message never changes after it arrives).
  const partsCache = new WeakMap<ChatMessage, ChatPart[]>();
  function partsOf(msg: ChatMessage): ChatPart[] {
    let parts = partsCache.get(msg);
    if (!parts) {
      parts = linkify(msg.text);
      partsCache.set(msg, parts);
    }
    return parts;
  }

  // One object URL per received image, revoked when the panel closes.
  const previewUrls = new Map<Blob, string>();
  function previewUrl(blob: Blob): string {
    let url = previewUrls.get(blob);
    if (!url) {
      url = URL.createObjectURL(blob);
      previewUrls.set(blob, url);
    }
    return url;
  }

  export let messages: ChatMessage[];
  /** The open conversation: '' = everyone; otherwise the peer id of a private conversation. */
  export let recipient = EVERYONE;
  /** Which tab is showing (the call screen can open straight to Files). */
  export let tab: 'chat' | 'files' = 'chat';

  const dispatch = createEventDispatcher<{ close: void }>();

  let inputText = '';
  let inputEl: HTMLInputElement;
  let sendError = '';
  /** Names of people who have left, so their conversation keeps its title. */
  const knownNames = new Map<string, string>();
  $: for (const p of $peers.values()) knownNames.set(p.id, p.displayName);
  $: for (const m of messages) if (!m.isLocal) knownNames.set(m.fromPeerId, m.displayName);
  $: for (const ft of transfers) if (ft.fromPeerId && ft.displayName) knownNames.set(ft.fromPeerId, ft.displayName);

  function nameOf(peerId: string): string {
    return $peers.get(peerId)?.displayName ?? knownNames.get(peerId) ?? 'Someone';
  }

  $: isPrivate = recipient !== EVERYONE;
  $: recipientPeer = isPrivate ? $peers.get(recipient) : undefined;
  $: recipientName = isPrivate ? recipientPeer?.displayName ?? knownNames.get(recipient) ?? 'Someone' : '';
  $: recipientLeft = isPrivate && !recipientPeer;
  $: recipientOnline = !isPrivate || !!recipientPeer?.connected;

  // ── Conversations ──
  $: transfers = Array.from($fileTransfers.values());
  $: threadMessages = messagesIn(messages, recipient);
  $: unread = unreadByThread(messages, $seenMessageIds);
  $: unseenFiles = unseenFileCount(transfers, $seenFileKeys);
  /** Everyone in the call, then anyone you talked to privately who has since left. */
  $: conversations = [
    ...Array.from($peers.values()).map((p) => p.id),
    ...privatePartners(messages, transfers).filter((id) => !$peers.has(id)),
  ];
  $: unreadElsewhere = Array.from(unread).reduce((n, [t, c]) => (t === recipient ? n : n + c), 0);
  /** In the everyone conversation: the newest private conversation with something unread. */
  $: pendingPrivate = !isPrivate
    ? privatePartners(messages).find((id) => (unread.get(id) ?? 0) > 0) ?? null
    : null;

  // Whatever is on screen counts as seen. (After rendering: a store changed by a reactive
  // statement can leave earlier statements stale for that update.)
  /** Files that were new when you opened the Files tab: highlighted until you leave it. */
  let freshFiles = new Set<string>();
  let shownTab = '';
  afterUpdate(() => {
    if (tab === 'chat') markThreadSeen(messages, recipient);
    else {
      if (shownTab !== 'files' || transfers.some((f) => f.direction === 'receive' && !$seenFileKeys.has(f.key))) {
        const fresh = transfers.filter((f) => f.direction === 'receive' && !$seenFileKeys.has(f.key)).map((f) => f.key);
        if (shownTab !== 'files') freshFiles = new Set(fresh);
        else if (fresh.length > 0) freshFiles = new Set([...freshFiles, ...fresh]);
      }
      markFilesSeen(transfers);
    }
    shownTab = tab;
  });

  function openConversation(id: string) {
    if (id !== recipient && isTyping) stopTyping();
    recipient = id;
    tab = 'chat';
    pickerOpen = false;
    sendError = '';
    atBottom = true;
    tick().then(() => inputEl?.focus());
  }

  // Opening the chat with nothing new here but a new private message elsewhere: go to it.
  // (At creation, before anything is marked seen.)
  {
    const unreadNow = unreadByThread(messages, get(seenMessageIds));
    if (tab === 'chat' && !unreadNow.get(recipient)) {
      const next = privatePartners(messages).find((id) => (unreadNow.get(id) ?? 0) > 0);
      if (next) recipient = next;
    }
  }

  // ── Conversation picker ──
  let pickerOpen = false;
  let pickerEl: HTMLDivElement;
  let pickerButton: HTMLButtonElement;

  async function togglePicker() {
    pickerOpen = !pickerOpen;
    if (pickerOpen) {
      await tick();
      pickerEl?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
    }
  }

  function pickerKeydown(e: KeyboardEvent) {
    const items = Array.from(pickerEl.querySelectorAll<HTMLButtonElement>('.option:not(:disabled)'));
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      pickerOpen = false;
      pickerButton?.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = e.key === 'ArrowDown' ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1);
      items[next]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      items[e.key === 'Home' ? 0 : items.length - 1]?.focus();
    } else if (e.key === 'Tab') {
      pickerOpen = false;
    }
  }

  function closePickerOutside(e: MouseEvent) {
    if (!pickerOpen) return;
    const t = e.target as Node;
    if (pickerEl?.contains(t) || pickerButton?.contains(t)) return;
    pickerOpen = false;
  }

  let messagesContainer: HTMLDivElement;
  let typingTimer: ReturnType<typeof setTimeout> | null = null;
  let isTyping = false;
  /** Who our "typing…" went to, so stopping goes to the same place after switching conversation. */
  let typingTo = EVERYONE;
  let fileInput: HTMLInputElement;

  // Follow new messages only while you're at the bottom: scrolling up to read stays put, and a
  // "new messages" button appears instead.
  let atBottom = true;
  let unseen = 0;
  let lastCount = 0;
  let lastThread = recipient;

  function scrollToBottom() {
    if (messagesContainer) messagesContainer.scrollTop = messagesContainer.scrollHeight;
    atBottom = true;
    unseen = 0;
  }

  function handleScroll() {
    const el = messagesContainer;
    atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (atBottom) unseen = 0;
  }

  afterUpdate(() => {
    const count = threadMessages.length;
    if (lastThread !== recipient) {
      lastThread = recipient;
      lastCount = count;
      unseen = 0;
      scrollToBottom();
      return;
    }
    const added = count - lastCount;
    lastCount = count;
    if (atBottom) {
      if (messagesContainer) messagesContainer.scrollTop = messagesContainer.scrollHeight;
    } else if (added > 0) {
      unseen += added;
    }
  });

  onDestroy(() => {
    for (const url of previewUrls.values()) URL.revokeObjectURL(url);
    if (isTyping) stopTyping();
  });

  function stopTyping() {
    if (typingTimer) clearTimeout(typingTimer);
    typingTimer = null;
    if (isTyping) sendTypingIndicator(false, typingTo || undefined);
    isTyping = false;
  }

  function handleSend() {
    const text = inputText.trim();
    if (!text) return;
    if (!sendChatMessage(text, recipient || undefined)) {
      // Keep the draft: the private recipient isn't connected right now.
      sendError = `${recipientName || 'They'} can't receive messages right now. Your message wasn't sent.`;
      return;
    }
    sendError = '';
    inputText = '';
    atBottom = true; // your own message is always shown
    stopTyping();
  }

  function handleInput() {
    if (!isTyping) {
      isTyping = true;
      typingTo = recipient;
      sendTypingIndicator(true, recipient || undefined);
    }
    if (typingTimer) clearTimeout(typingTimer);
    typingTimer = setTimeout(stopTyping, 2000);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // ── Files ──

  /** Files you just sent from this conversation, shown above the message box until they finish. */
  let recentSends: string[] = [];
  let doneTimers = new Map<string, ReturnType<typeof setTimeout>>();
  $: outgoing = recentSends
    .map((key) => $fileTransfers.get(key))
    .filter((ft): ft is FileTransferEntry => !!ft && fileThreadOf(ft) === recipient);
  $: clearFinished(outgoing);
  function clearFinished(list: FileTransferEntry[]) {
    for (const ft of list) {
      if (ft.status === 'transferring' || doneTimers.has(ft.key)) continue;
      const key = ft.key;
      doneTimers.set(
        key,
        setTimeout(() => {
          recentSends = recentSends.filter((k) => k !== key);
          doneTimers.delete(key);
        }, 4000)
      );
    }
  }
  onDestroy(() => {
    for (const t of doneTimers.values()) clearTimeout(t);
  });

  /** Send files picked, dropped or pasted. Problems show above the message box, not in a popup. */
  function sendFiles(files: File[]) {
    if (files.length === 0) return;
    let tooBig = 0;
    let undelivered = false;
    for (const file of files) {
      if (file.size > MAX_FILE_SIZE) {
        tooBig++;
        continue;
      }
      const fileId = sendFileToRoom(file, recipient || undefined);
      if (!fileId) {
        undelivered = true;
        break;
      }
      recentSends = [...recentSends, `out:${fileId}`];
    }
    if (undelivered) {
      sendError = isPrivate ? `${recipientName || 'They'} can't receive files right now.` : 'Nobody is connected to receive files yet.';
    } else if (tooBig > 0) {
      sendError = files.length === 1 ? 'That file is over the 50MB limit.' : `${tooBig} of ${files.length} files are over the 50MB limit and weren't sent.`;
    } else {
      sendError = '';
    }
  }

  function handleFileSelect(e: Event) {
    const files = Array.from((e.target as HTMLInputElement).files ?? []);
    fileInput.value = '';
    sendFiles(files);
  }

  // Drop files anywhere on the chat, or paste one (a screenshot, say) into the message box.
  let dragDepth = 0;
  const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');

  function handleDragEnter(e: DragEvent) {
    if (hasFiles(e)) dragDepth++;
  }

  function handleDragLeave(e: DragEvent) {
    if (hasFiles(e)) dragDepth = Math.max(0, dragDepth - 1);
  }

  function handleDragOver(e: DragEvent) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = recipientLeft ? 'none' : 'copy';
  }

  function handleDrop(e: DragEvent) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    if (recipientLeft) return;
    sendFiles(Array.from(e.dataTransfer?.files ?? []));
  }

  function handlePaste(e: ClipboardEvent) {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return; // ordinary text paste
    e.preventDefault();
    sendFiles(files);
  }

  function downloadFile(blob: Blob, fileName: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /**
   * "Save chat": a plain-text transcript of the chat in memory, built here and downloaded. Nothing
   * is uploaded, and this is the only time chat is written anywhere.
   */
  function saveChat() {
    if (messages.length === 0 && transfers.length === 0) return;
    const savedAt = new Date();
    // Only the room's name, never its code: a room without a name is "Unnamed room".
    const room = $roomName;
    const text = formatTranscript({ roomName: room, localName: getLocalDisplayName(), savedAt, messages, files: transfers });
    downloadFile(new Blob([text], { type: 'text/plain;charset=utf-8' }), transcriptFileName(room, savedAt));
  }

  /**
   * Inline previews only for common raster formats of sensible size (no SVG), and only once the
   * header says the image isn't enormous in pixels (no decode bombs).
   */
  let safePreviews = new Set<Blob>();
  const checkedPreviews = new WeakSet<Blob>();
  $: for (const ft of $fileTransfers.values()) {
    const blob = ft.blob;
    if (!blob || ft.direction !== 'receive' || checkedPreviews.has(blob)) continue;
    if (!/^image\/(png|jpeg|gif|webp)$/.test(ft.mimeType) || ft.fileSize > MAX_PREVIEW_BYTES) continue;
    checkedPreviews.add(blob);
    isSafeToPreview(blob).then((ok) => {
      if (ok) safePreviews = new Set(safePreviews).add(blob);
    });
  }
  function canPreview(ft: FileTransferEntry): boolean {
    return !!ft.blob && safePreviews.has(ft.blob);
  }

  function fileIcon(ft: FileTransferEntry): string {
    if (ft.mimeType.startsWith('image/')) return 'img';
    if (ft.mimeType.startsWith('text/') || ft.mimeType === 'application/pdf') return 'file-text';
    return 'file-doc';
  }

  /** Newest first. */
  $: received = transfers.filter((ft) => ft.direction === 'receive').sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  $: sent = transfers.filter((ft) => ft.direction === 'send').sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));

  // ── Typing ──
  // In the everyone conversation: people typing to everyone. In a private one: only that person,
  // and only when they're typing to you.
  $: typingNames = Array.from($typingPeers)
    .filter((pid) => (isPrivate ? pid === recipient && $privateTypingPeers.has(pid) : !$privateTypingPeers.has(pid)))
    .map((pid) => $peers.get(pid)?.displayName ?? 'Someone');

  $: typingText = typingNames.length === 0
    ? ''
    : typingNames.length === 1
      ? `${typingNames[0]} is typing…`
      : `${typingNames.join(' and ')} are typing…`;

  $: peopleCount = $peers.size;
  const initial = (name: string) => (name.trim()[0] ?? '?').toUpperCase();
</script>

<svelte:window on:click={closePickerOutside} />

<!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
<aside
  class="chat-panel"
  class:private={isPrivate && tab === 'chat'}
  aria-label="Chat"
  on:dragenter={handleDragEnter}
  on:dragleave={handleDragLeave}
  on:dragover={handleDragOver}
  on:drop={handleDrop}
>
  <div class="chat-header">
    <div class="tabs" role="tablist" aria-label="Chat and files">
      <button class="tab" role="tab" id="chat-tab-chat" aria-selected={tab === 'chat'} aria-controls="chat-pane-chat" on:click={() => (tab = 'chat')}>
        <Icon name="message" size={16} /> Chat
        {#if tab !== 'chat' && unread.size > 0}<span class="dot" aria-label="new messages"></span>{/if}
      </button>
      <button class="tab" role="tab" id="chat-tab-files" aria-selected={tab === 'files'} aria-controls="chat-pane-files" on:click={() => (tab = 'files')}>
        <Icon name="paperclip" size={16} /> Files
        {#if unseenFiles > 0}
          <span class="count" aria-label="{unseenFiles} new">{unseenFiles}</span>
        {:else if transfers.length > 0}
          <span class="count muted">{transfers.length}</span>
        {/if}
      </button>
    </div>
    <div class="chat-actions">
      <button
        class="icon-btn"
        on:click={saveChat}
        disabled={messages.length === 0 && transfers.length === 0}
        aria-label="Save chat"
        title="Save chat as a text file (made on this device, nothing is uploaded)"
      >
        <Icon name="download" size={18} />
      </button>
      <button class="icon-btn" on:click={() => dispatch('close')} aria-label="Close chat" title="Close chat">
        <Icon name="x" size={18} />
      </button>
    </div>
  </div>

  <input type="file" multiple bind:this={fileInput} on:change={handleFileSelect} style="display:none" />

  {#if tab === 'chat'}
    <!-- ── Conversation picker ── -->
    <div class="convo-bar">
      <button
        class="convo-button"
        bind:this={pickerButton}
        on:click|stopPropagation={togglePicker}
        aria-haspopup="listbox"
        aria-expanded={pickerOpen}
        aria-label="Conversation: {isPrivate ? `private with ${recipientName}` : 'everyone'}. Change conversation"
      >
        {#if isPrivate}
          <span class="avatar private-avatar">{initial(recipientName)}</span>
          <span class="convo-text">
            <strong>{recipientName}</strong>
            <small><Icon name="lock" size={11} /> {recipientLeft ? 'Left the call' : 'Private'}</small>
          </span>
        {:else}
          <span class="avatar everyone-avatar"><Icon name="users" size={16} /></span>
          <span class="convo-text">
            <strong>Everyone</strong>
            <small>{peopleCount + 1} in the call</small>
          </span>
        {/if}
        {#if unreadElsewhere > 0}<span class="count" aria-label="{unreadElsewhere} unread in other conversations">{unreadElsewhere}</span>{/if}
        <span class="caret" class:open={pickerOpen}><Icon name="chevron-down" size={16} /></span>
      </button>
      {#if isPrivate}
        <button class="back-btn" on:click={() => openConversation(EVERYONE)} title="Back to the everyone chat" aria-label="Back to the everyone chat">
          <Icon name="users" size={15} /> <span class="back-label">Everyone</span>
          {#if (unread.get(EVERYONE) ?? 0) > 0}<span class="dot" aria-label="new messages"></span>{/if}
        </button>
      {/if}

      {#if pickerOpen}
        <!-- svelte-ignore a11y-interactive-supports-focus -->
        <div class="picker" role="listbox" aria-label="Conversations" bind:this={pickerEl} on:keydown={pickerKeydown}>
          <button class="option" role="option" aria-selected={recipient === EVERYONE} on:click={() => openConversation(EVERYONE)}>
            <span class="avatar everyone-avatar"><Icon name="users" size={15} /></span>
            <span class="option-text"><strong>Everyone</strong><small>Group chat</small></span>
            {#if (unread.get(EVERYONE) ?? 0) > 0}<span class="count">{unread.get(EVERYONE)}</span>{/if}
            {#if recipient === EVERYONE}<span class="tick"><Icon name="check" size={15} /></span>{/if}
          </button>
          <div class="picker-label"><Icon name="lock" size={11} /> Private message</div>
          {#each conversations as id (id)}
            {@const p = $peers.get(id)}
            {@const n = unread.get(id) ?? 0}
            <button
              class="option"
              role="option"
              aria-selected={recipient === id}
              on:click={() => openConversation(id)}
            >
              <span class="avatar private-avatar">{initial(nameOf(id))}</span>
              <span class="option-text">
                <strong>{nameOf(id)}</strong>
                <small>{!p ? 'Left the call' : p.connected ? 'Only you two see it' : 'Connecting…'}</small>
              </span>
              {#if n > 0}<span class="count">{n}</span>{/if}
              {#if recipient === id}<span class="tick"><Icon name="check" size={15} /></span>{/if}
            </button>
          {:else}
            <p class="picker-empty">Nobody else is here yet.</p>
          {/each}
        </div>
      {/if}
    </div>

    <div class="messages-wrap" id="chat-pane-chat" role="tabpanel" aria-labelledby="chat-tab-chat">
      {#if pendingPrivate}
        <button class="private-nudge" on:click={() => pendingPrivate && openConversation(pendingPrivate)}>
          <Icon name="lock" size={14} />
          <span><strong>{nameOf(pendingPrivate)}</strong> sent you a private message</span>
          <span class="nudge-open">Open</span>
        </button>
      {/if}
      <div
        class="messages"
        bind:this={messagesContainer}
        on:scroll={handleScroll}
        role="log"
        aria-live="polite"
        aria-label={isPrivate ? `Private messages with ${recipientName}` : 'Messages to everyone'}
      >
        {#each threadMessages as msg (msg.id)}
          <div class="message" class:own={msg.isLocal}>
            <div class="msg-meta">
              {#if !isPrivate || !msg.isLocal}
                <span class="msg-name">{msg.isLocal ? 'You' : msg.displayName}</span>
              {/if}
              <span class="msg-time">{formatTime(msg.timestamp)}</span>
            </div>
            <div class="bubble">
              <!-- Kept on one line: with pre-wrap, whitespace between these tags would show. -->
              <div class="msg-text">{#each partsOf(msg) as part}{#if part.kind === 'link'}<a class="msg-link" href={part.href} target="_blank" rel="noopener noreferrer nofollow" referrerpolicy="no-referrer">{part.before}<span class="link-domain">{part.domain}</span>{part.after}</a>{:else}{part.text}{/if}{/each}</div>
            </div>
            {#if !isPrivate && !msg.isLocal && $peers.has(msg.fromPeerId)}
              <button class="reply-private" on:click={() => openConversation(msg.fromPeerId)}>
                <Icon name="lock" size={12} /> Message privately
              </button>
            {/if}
          </div>
        {/each}

        {#if threadMessages.length === 0}
          <div class="empty">
            {#if isPrivate}
              <span class="avatar private-avatar big">{initial(recipientName)}</span>
              <span>Private chat with {recipientName}</span>
              <small>Only the two of you see these messages and files. They go straight between your devices, end-to-end encrypted.</small>
            {:else}
              <Icon name="lock" size={20} />
              <span>No messages yet</span>
              <small>Messages go directly between participants, end-to-end encrypted.</small>
            {/if}
          </div>
        {/if}
      </div>
      {#if !atBottom && threadMessages.length > 0}
        <button class="jump-btn" class:has-new={unseen > 0} on:click={scrollToBottom}>
          <Icon name="chevron-down" size={14} />
          {unseen > 0 ? `${unseen} new` : 'Latest'}
        </button>
      {/if}
    </div>

    {#if typingText}
      <div class="typing-indicator" aria-live="polite">{typingText}</div>
    {/if}

    <div class="composer">
      {#if outgoing.length > 0}
        <ul class="outgoing" aria-label="Files you're sending">
          {#each outgoing as ft (ft.key)}
            <li>
              <Icon name="paperclip" size={13} />
              <span class="out-name">{ft.fileName}</span>
              {#if ft.status === 'transferring'}
                <span class="mini-bar"><span style="width: {ft.progress * 100}%"></span></span>
                <span class="out-pct">{Math.round(ft.progress * 100)}%</span>
              {:else if ft.status === 'complete'}
                <span class="out-done"><Icon name="check" size={12} /> Sent</span>
              {:else}
                <span class="out-pct">Cancelled</span>
              {/if}
              <button class="link-btn" on:click={() => (tab = 'files')}>Files</button>
            </li>
          {/each}
        </ul>
      {/if}

      {#if recipientLeft}
        <p class="send-error" role="status">{recipientName} left the call. You can still read your conversation.</p>
      {:else if sendError}
        <p class="send-error" role="alert">{sendError}</p>
      {:else if !recipientOnline}
        <p class="send-error" role="status">{recipientName} isn't connected right now.</p>
      {/if}

      <div class="chat-input">
        <button
          class="icon-btn attach-btn"
          on:click={() => fileInput.click()}
          disabled={recipientLeft}
          title={isPrivate ? `Send files to ${recipientName} (or drop them here)` : 'Send files to everyone (or drop them here)'}
          aria-label="Send files"
        >
          <Icon name="paperclip" size={18} />
        </button>
        <input
          type="text"
          class="input"
          bind:this={inputEl}
          bind:value={inputText}
          on:keydown={handleKeydown}
          on:input={handleInput}
          on:paste={handlePaste}
          disabled={recipientLeft}
          placeholder={isPrivate ? `Message ${recipientName}…` : 'Message everyone…'}
          aria-label={isPrivate ? `Private message to ${recipientName}` : 'Message everyone'}
        />
        <button class="icon-btn send-btn" on:click={handleSend} disabled={!inputText.trim() || recipientLeft} aria-label="Send" title="Send">
          <Icon name="send" size={18} />
        </button>
      </div>
    </div>
  {:else}
    <!-- ── Files ── -->
    <div class="files" id="chat-pane-files" role="tabpanel" aria-labelledby="chat-tab-files">
      {#if transfers.length === 0}
        <div class="empty">
          <Icon name="paperclip" size={20} />
          <span>No files yet</span>
          <small>Files people send you show up here to download. They go straight between devices, end-to-end encrypted, and are gone when you leave.</small>
        </div>
      {:else}
        {#each [{ title: 'Received', list: received }, { title: 'Sent by you', list: sent }] as section (section.title)}
          {#if section.list.length > 0}
            <h3 class="files-heading">{section.title} <span>{section.list.length}</span></h3>
            <ul class="file-list">
              {#each section.list as ft (ft.key)}
                <li class="file-row" class:new={freshFiles.has(ft.key)}>
                  {#if canPreview(ft) && ft.blob}
                    <img class="thumb" src={previewUrl(ft.blob)} alt="" />
                  {:else}
                    <span class="thumb icon-thumb"><Icon name={fileIcon(ft)} size={18} /></span>
                  {/if}
                  <div class="file-info">
                    <span class="file-name" title={ft.fileName}>{ft.fileName}</span>
                    <span class="file-sub">
                      {formatBytes(ft.fileSize)} ·
                      {#if ft.direction === 'receive'}
                        from {ft.displayName ?? 'someone'}
                      {:else}
                        to {ft.private ? ft.toDisplayName ?? 'someone' : 'everyone'}
                      {/if}
                      {#if ft.private}<span class="private-tag"><Icon name="lock" size={10} /> Private</span>{/if}
                    </span>
                    {#if ft.status === 'transferring'}
                      <span class="mini-bar wide"><span style="width: {ft.progress * 100}%"></span></span>
                    {/if}
                  </div>
                  <div class="file-action">
                    {#if ft.status === 'transferring'}
                      <span class="out-pct">{Math.round(ft.progress * 100)}%</span>
                    {:else if ft.status === 'complete' && ft.direction === 'receive' && ft.blob}
                      <button
                        class="icon-btn dl-btn"
                        on:click={() => { if (ft.blob) downloadFile(ft.blob, ft.fileName); }}
                        aria-label="Download {ft.fileName}"
                        title="Download"
                      >
                        <Icon name="download" size={17} />
                      </button>
                    {:else if ft.status === 'complete'}
                      <span class="out-done"><Icon name="check" size={13} /> Sent</span>
                    {:else if ft.status === 'cancelled'}
                      <span class="out-pct">Cancelled</span>
                    {/if}
                  </div>
                </li>
              {/each}
            </ul>
          {/if}
        {/each}
      {/if}
    </div>
    <div class="files-foot">
      <button class="send-file-btn" on:click={() => fileInput.click()} disabled={recipientLeft}>
        <Icon name="paperclip" size={16} />
        Send a file to {isPrivate ? recipientName : 'everyone'}
      </button>
    </div>
  {/if}

  {#if dragDepth > 0}
    <div class="drop-overlay" class:blocked={recipientLeft} aria-hidden="true">
      <Icon name="paperclip" size={22} />
      {#if recipientLeft}
        <strong>{recipientName} has left</strong>
      {:else}
        <strong>Drop to send</strong>
        <span>{isPrivate ? `Only to ${recipientName}` : 'To everyone in the call'} · 50MB max per file</span>
      {/if}
    </div>
  {/if}
</aside>

<style>
  /* Docked sidebar on wide screens: sits beside the call column and shrinks it. */
  .chat-panel {
    --convo: var(--accent);
    --convo-soft: var(--accent-soft);
    position: relative;
    flex: 0 0 340px;
    width: 340px;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg-surface);
    border-left: 1px solid var(--border-subtle);
  }

  /* A private conversation gets a warm tint throughout, so it never reads as the group chat. */
  .chat-panel.private {
    --convo: var(--warning);
    --convo-soft: var(--warning-soft);
  }

  /* Narrow screens: full-height sheet over the call. */
  @media (max-width: 899px) {
    .chat-panel {
      position: fixed;
      inset: 0;
      z-index: 60;
      width: 100%;
      border-left: none;
      animation: sheet-in var(--dur) var(--ease) both;
    }
  }

  @keyframes sheet-in {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: none; }
  }

  .chat-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    min-height: 56px;
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border-subtle);
    flex-shrink: 0;
  }

  /* ── Tabs ── */
  .tabs {
    display: flex;
    gap: 2px;
    padding: 3px;
    border-radius: var(--radius);
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
  }

  .tab {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 34px;
    padding: 0 var(--space-3);
    border-radius: calc(var(--radius) - 3px);
    background: transparent;
    color: var(--text-muted);
    font-size: var(--text-sm);
    font-weight: 600;
    transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
  }

  .tab:hover {
    color: var(--text);
  }

  .tab[aria-selected='true'] {
    background: var(--bg-surface);
    color: var(--text);
    box-shadow: var(--shadow-sm);
  }

  .count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: var(--radius-pill);
    background: var(--accent);
    color: var(--accent-text);
    font-size: 0.6875rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .count.muted {
    background: var(--bg-active);
    color: var(--text-muted);
  }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
  }

  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    flex-shrink: 0;
    border-radius: var(--radius);
    background: transparent;
    color: var(--text-muted);
    transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
  }

  .icon-btn:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--text);
  }

  .icon-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .chat-actions {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  /* ── Conversation bar ── */
  .convo-bar {
    position: relative;
    z-index: 4;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border-subtle);
    background: var(--convo-soft);
    flex-shrink: 0;
    transition: background var(--dur) var(--ease);
  }

  .convo-button {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 44px;
    padding: 4px var(--space-2) 4px 4px;
    border-radius: var(--radius);
    background: transparent;
    color: var(--text);
    text-align: left;
    transition: background var(--dur-fast) var(--ease);
  }

  .convo-button:hover,
  .convo-button[aria-expanded='true'] {
    background: color-mix(in srgb, var(--bg-surface) 60%, transparent);
  }

  .convo-text,
  .option-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    line-height: 1.2;
  }

  .convo-text strong,
  .option-text strong {
    font-size: var(--text-sm);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .convo-text small,
  .option-text small {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .chat-panel.private .convo-text small {
    color: var(--warning);
  }

  .caret {
    display: flex;
    color: var(--text-muted);
    transition: transform var(--dur-fast) var(--ease);
  }

  .caret.open {
    transform: rotate(180deg);
  }

  .avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    flex-shrink: 0;
    border-radius: 50%;
    font-size: var(--text-sm);
    font-weight: 700;
  }

  .everyone-avatar {
    background: var(--accent-soft);
    color: var(--accent);
  }

  .private-avatar {
    background: var(--warning-soft);
    color: var(--warning);
    border: 1px solid color-mix(in srgb, var(--warning) 35%, transparent);
  }

  .avatar.big {
    width: 48px;
    height: 48px;
    font-size: var(--text-lg);
  }

  .back-btn {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-height: 32px;
    padding: 0 var(--space-2);
    border-radius: var(--radius-pill);
    background: var(--bg-surface);
    border: 1px solid var(--border);
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-weight: 600;
    flex-shrink: 0;
  }

  @media (max-width: 380px) {
    .back-label {
      display: none;
    }
  }

  .back-btn:hover {
    color: var(--text);
    border-color: var(--border-strong);
  }

  .picker {
    position: absolute;
    top: calc(100% - 4px);
    left: var(--space-3);
    right: var(--space-3);
    max-height: min(360px, 60vh);
    overflow-y: auto;
    padding: var(--space-1);
    border-radius: var(--radius-lg);
    background: var(--bg-overlay);
    border: 1px solid var(--border-strong);
    box-shadow: var(--shadow-lg);
    animation: pop-in var(--dur-fast) var(--ease) both;
  }

  @keyframes pop-in {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: none; }
  }

  .picker-label {
    display: flex;
    align-items: center;
    gap: 4px;
    margin: var(--space-2) var(--space-2) var(--space-1);
    color: var(--text-subtle);
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .picker-empty {
    margin: var(--space-1) var(--space-2) var(--space-2);
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .option {
    width: 100%;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 44px;
    padding: 4px var(--space-2) 4px 4px;
    border-radius: var(--radius);
    background: transparent;
    color: var(--text);
    text-align: left;
  }

  .option:hover,
  .option:focus-visible {
    background: var(--bg-hover);
    outline: none;
  }

  .option[aria-selected='true'] {
    background: var(--bg-active);
  }

  .option .avatar {
    width: 30px;
    height: 30px;
  }

  .tick {
    display: flex;
    color: var(--accent);
  }

  /* ── Messages ── */
  .messages-wrap {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .private-nudge {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: var(--space-2) var(--space-3) 0;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius);
    background: var(--warning-soft);
    border: 1px solid color-mix(in srgb, var(--warning) 40%, transparent);
    color: var(--text);
    font-size: var(--text-sm);
    text-align: left;
    flex-shrink: 0;
  }

  .private-nudge > :global(svg) {
    color: var(--warning);
    flex-shrink: 0;
  }

  .private-nudge span:first-of-type {
    flex: 1;
    min-width: 0;
  }

  .nudge-open {
    color: var(--warning);
    font-weight: 600;
  }

  .jump-btn {
    position: absolute;
    left: 50%;
    bottom: var(--space-3);
    transform: translateX(-50%);
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 32px;
    padding: 0 var(--space-3);
    border-radius: var(--radius-pill);
    background: var(--bg-overlay);
    border: 1px solid var(--border-strong);
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: 500;
    box-shadow: var(--shadow-md);
  }

  .jump-btn.has-new {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-text);
  }

  /* Shown while files are dragged over the chat. Never takes pointer events, so the drop lands. */
  .drop-overlay {
    position: absolute;
    inset: var(--space-2);
    z-index: 5;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    padding: var(--space-6);
    text-align: center;
    border: 2px dashed var(--convo);
    border-radius: var(--radius-lg);
    background: color-mix(in srgb, var(--bg-surface) 88%, var(--convo));
    color: var(--text);
    pointer-events: none;
  }

  .drop-overlay.blocked {
    border-color: var(--border-strong);
  }

  .drop-overlay span {
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  .messages {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-4) var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .message {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    max-width: 92%;
    align-self: flex-start;
  }

  .message.own {
    align-items: flex-end;
    align-self: flex-end;
  }

  .msg-meta {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    flex-wrap: wrap;
    margin-bottom: 3px;
    padding: 0 var(--space-1);
  }

  .msg-name {
    font-weight: 600;
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .message.own .msg-name {
    color: var(--accent);
  }

  .msg-time {
    color: var(--text-subtle);
    font-size: var(--text-xs);
  }

  .bubble {
    max-width: 100%;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-lg);
    border-top-left-radius: var(--radius-sm);
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
  }

  .message.own .bubble {
    border-top-left-radius: var(--radius-lg);
    border-top-right-radius: var(--radius-sm);
    background: var(--convo-soft);
    border-color: transparent;
  }

  .chat-panel.private .message.own .bubble {
    border-color: color-mix(in srgb, var(--warning) 35%, transparent);
  }

  .msg-text {
    font-size: var(--text-base);
    line-height: 1.4;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  /* Links show their full, normalized address (see lib/chat/linkify.ts), with the site's domain in
     bold. No long-press preview on iOS/macOS, which would fetch the page. */
  .msg-link {
    color: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
    -webkit-touch-callout: none;
  }

  .msg-link:hover {
    text-decoration-thickness: 2px;
  }

  .link-domain {
    font-weight: 700;
  }

  .private-tag {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 1px 6px;
    border-radius: var(--radius-pill);
    background: var(--warning-soft);
    color: var(--warning);
    font-size: 0.625rem;
    font-weight: 700;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }

  .reply-private {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-height: 28px;
    margin-top: 2px;
    padding: 0 var(--space-1);
    background: none;
    color: var(--text-muted);
    font-size: var(--text-xs);
    border-radius: var(--radius-sm);
    opacity: 0;
    transition: opacity var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
  }

  .message:hover .reply-private,
  .message:focus-within .reply-private,
  .reply-private:focus-visible {
    opacity: 1;
  }

  .reply-private:hover {
    color: var(--warning);
  }

  /* Touch screens have no hover: keep the action visible. */
  @media (hover: none) {
    .reply-private {
      opacity: 1;
    }
  }

  .empty {
    margin: auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-6);
    text-align: center;
    color: var(--text-muted);
    font-size: var(--text-base);
  }

  .empty small {
    max-width: 250px;
    color: var(--text-subtle);
    font-size: var(--text-xs);
    line-height: 1.45;
  }

  .typing-indicator {
    padding: var(--space-1) var(--space-4);
    font-size: var(--text-xs);
    color: var(--text-muted);
    font-style: italic;
  }

  /* ── Composer ── */
  .composer {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
    padding-bottom: max(var(--space-3), env(safe-area-inset-bottom));
    border-top: 1px solid var(--border-subtle);
  }

  .send-error {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--warning);
  }

  .outgoing {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .outgoing li {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 32px;
    padding: 0 var(--space-2);
    border-radius: var(--radius);
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .out-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
    font-weight: 500;
  }

  .mini-bar {
    display: block;
    width: 56px;
    height: 4px;
    border-radius: var(--radius-pill);
    background: var(--bg-active);
    overflow: hidden;
    flex-shrink: 0;
  }

  .mini-bar.wide {
    width: 100%;
    margin-top: 6px;
  }

  .mini-bar span {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width var(--dur) var(--ease);
  }

  .out-pct {
    font-size: var(--text-xs);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .out-done {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: var(--text-xs);
    color: var(--success);
    white-space: nowrap;
  }

  .link-btn {
    background: none;
    color: var(--accent);
    font-size: var(--text-xs);
    font-weight: 600;
    padding: 4px 2px;
  }

  .chat-input {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .chat-input .input {
    flex: 1;
    min-width: 0;
  }

  .chat-panel.private .chat-input .input {
    border-color: color-mix(in srgb, var(--warning) 60%, var(--border));
  }

  .chat-panel.private .chat-input .input:focus-visible {
    box-shadow: 0 0 0 3px var(--warning-soft);
  }

  .attach-btn {
    width: 44px;
    height: 44px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
  }

  .send-btn {
    width: 44px;
    height: 44px;
    background: var(--accent);
    color: var(--accent-text);
  }

  .send-btn:hover:not(:disabled) {
    background: var(--accent-hover);
    color: var(--accent-text);
  }

  /* ── Files tab ── */
  .files {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-2) var(--space-3) var(--space-4);
    display: flex;
    flex-direction: column;
  }

  .files-heading {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: var(--space-3) var(--space-1) var(--space-2);
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .files-heading span {
    color: var(--text-subtle);
  }

  .file-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .file-row {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2);
    border-radius: var(--radius);
    border: 1px solid transparent;
    transition: background var(--dur-fast) var(--ease);
  }

  .file-row:hover {
    background: var(--bg-hover);
  }

  .file-row.new {
    background: var(--accent-soft);
    border-color: color-mix(in srgb, var(--accent) 30%, transparent);
  }

  .thumb {
    width: 40px;
    height: 40px;
    flex-shrink: 0;
    border-radius: var(--radius-sm);
    object-fit: cover;
    background: var(--bg-elevated);
  }

  .icon-thumb {
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border-subtle);
    color: var(--text-muted);
  }

  .file-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .file-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-sm);
    font-weight: 500;
  }

  .file-sub {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .file-action {
    flex-shrink: 0;
    display: flex;
    align-items: center;
  }

  .dl-btn {
    width: 38px;
    height: 38px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    color: var(--accent);
  }

  .files-foot {
    flex-shrink: 0;
    padding: var(--space-3);
    padding-bottom: max(var(--space-3), env(safe-area-inset-bottom));
    border-top: 1px solid var(--border-subtle);
  }

  .send-file-btn {
    width: 100%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    min-height: 44px;
    padding: 0 var(--space-3);
    border-radius: var(--radius);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .send-file-btn:hover:not(:disabled) {
    background: var(--bg-hover);
    border-color: var(--border-strong);
  }

  .send-file-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
</style>
