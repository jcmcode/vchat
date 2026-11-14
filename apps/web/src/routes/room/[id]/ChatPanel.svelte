<script lang="ts">
  import { createEventDispatcher, afterUpdate, onDestroy } from 'svelte';
  import type { ChatMessage } from '$lib/webrtc/mesh';
  import { typingPeers, sendTypingIndicator, sendFileToRoom, sendChatMessage, peers } from '$lib/webrtc/mesh';
  import Icon from '$lib/ui/Icon.svelte';
  import { fileTransfers, MAX_FILE_SIZE, MAX_PREVIEW_BYTES, type FileTransferEntry } from '$lib/webrtc/file-transfer';
  import { isSafeToPreview } from '$lib/webrtc/image-size';
  import { getLocalDisplayName } from '$lib/webrtc/mesh';
  import { roomName } from '$lib/collab/room-meta';
  import { linkify, type ChatPart } from '$lib/chat/linkify';
  import { formatTranscript, transcriptFileName } from '$lib/chat/transcript';

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

  const dispatch = createEventDispatcher<{ close: void }>();

  let inputText = '';
  /** '' = everyone; otherwise the peer id of a private recipient (the call screen can preset it). */
  export let recipient = '';
  let inputEl: HTMLInputElement;
  let sendError = '';
  /** Name to show for a recipient who has left (we never silently switch a private message to everyone). */
  let lastRecipientName = '';

  $: recipientPeer = recipient ? $peers.get(recipient) : undefined;
  $: if (recipientPeer) lastRecipientName = recipientPeer.displayName;
  $: recipientName = recipient ? recipientPeer?.displayName ?? lastRecipientName : '';
  $: recipientOnline = !recipient || !!recipientPeer?.connected;
  $: if (recipient) sendError = '';

  function replyPrivately(peerId: string) {
    if (!$peers.has(peerId)) return;
    recipient = peerId;
    inputEl?.focus();
  }
  let messagesContainer: HTMLDivElement;
  let typingTimer: ReturnType<typeof setTimeout> | null = null;
  let isTyping = false;
  let fileInput: HTMLInputElement;

  afterUpdate(() => {
    if (messagesContainer) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
  });

  onDestroy(() => {
    for (const url of previewUrls.values()) URL.revokeObjectURL(url);
    if (typingTimer) clearTimeout(typingTimer);
    if (isTyping) sendTypingIndicator(false, recipient || undefined);
  });

  function handleSend() {
    if (!inputText.trim()) return;
    if (!sendChatMessage(inputText.trim(), recipient || undefined)) {
      // Keep the draft: the private recipient isn't connected right now.
      sendError = `${recipientName || 'They'} can't receive messages right now. Your message wasn't sent.`;
      return;
    }
    sendError = '';
    inputText = '';
    if (isTyping) {
      isTyping = false;
      sendTypingIndicator(false, recipient || undefined);
    }
    if (typingTimer) {
      clearTimeout(typingTimer);
      typingTimer = null;
    }
  }

  function handleInput() {
    if (!isTyping) {
      isTyping = true;
      sendTypingIndicator(true, recipient || undefined);
    }
    if (typingTimer) clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      isTyping = false;
      sendTypingIndicator(false, recipient || undefined);
      typingTimer = null;
    }, 2000);
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

  function handleFileSelect(e: Event) {
    const files = (e.target as HTMLInputElement).files;
    if (!files || files.length === 0) return;
    const file = files[0];
    fileInput.value = '';
    if (file.size > MAX_FILE_SIZE) {
      alert('File too large. Maximum size is 50MB.');
      return;
    }
    if (!sendFileToRoom(file, recipient || undefined)) {
      alert(recipient ? `${recipientName} can't receive files right now.` : 'Nobody is connected to receive the file yet.');
    }
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

  // Typing indicator text
  $: typingNames = Array.from($typingPeers).map((pid) => {
    const peerMap = $peers;
    const pc = peerMap.get(pid);
    return pc?.displayName ?? pid;
  });

  $: typingText = typingNames.length === 0
    ? ''
    : typingNames.length === 1
      ? `${typingNames[0]} is typing...`
      : `${typingNames.join(' and ')} are typing...`;

  // Active file transfers
  $: transfers = Array.from($fileTransfers.values());
</script>

<aside class="chat-panel" aria-label="Chat">
  <div class="chat-header">
    <span class="chat-title"><Icon name="message" size={18} /> Chat</span>
    <div class="chat-actions">
      <button
        class="icon-btn save-btn"
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

  <div class="messages" bind:this={messagesContainer} role="log" aria-live="polite" aria-label="Messages">
    {#each messages as msg (msg.id)}
      <div class="message" class:own={msg.isLocal} class:private={msg.private}>
        <div class="msg-meta">
          <span class="msg-name">
            {#if msg.private}
              {msg.isLocal ? `You → ${msg.toDisplayName ?? 'someone'}` : `${msg.displayName} → you`}
            {:else}
              {msg.isLocal ? 'You' : msg.displayName}
            {/if}
          </span>
          {#if msg.private}
            <span class="private-tag" title={msg.isLocal ? 'Sent only to them, directly from your device' : 'Sent to you as a private message'}><Icon name="lock" size={11} /> Private</span>
          {/if}
          <span class="msg-time">{formatTime(msg.timestamp)}</span>
        </div>
        <div class="bubble">
          <!-- Kept on one line: with pre-wrap, whitespace between these tags would show. -->
          <div class="msg-text">{#each partsOf(msg) as part}{#if part.kind === 'link'}<a class="msg-link" href={part.href} target="_blank" rel="noopener noreferrer nofollow" referrerpolicy="no-referrer">{part.before}<span class="link-domain">{part.domain}</span>{part.after}</a>{:else}{part.text}{/if}{/each}</div>
        </div>
        {#if !msg.isLocal && $peers.has(msg.fromPeerId)}
          <button class="reply-private" on:click={() => replyPrivately(msg.fromPeerId)}>
            <Icon name="lock" size={12} /> Reply privately
          </button>
        {/if}
      </div>
    {/each}

    {#each transfers as ft (ft.key)}
      <div class="message file-msg" class:own={ft.direction === 'send'}>
        <div class="msg-meta">
          <span class="msg-name">
            {ft.direction === 'send' ? (ft.private ? `You → ${ft.toDisplayName}` : 'You') : ft.private ? `${ft.displayName ?? 'Peer'} → you` : ft.displayName ?? 'Peer'}
          </span>
        </div>
        <div class="bubble file-bubble">
          <div class="file-name"><Icon name="paperclip" size={14} /> <span>{ft.fileName}</span></div>
          {#if ft.status === 'transferring'}
            <div class="file-progress">
              <div class="progress-bar">
                <div class="progress-fill" style="width: {ft.progress * 100}%"></div>
              </div>
              <span class="progress-text">{Math.round(ft.progress * 100)}%</span>
            </div>
          {:else if ft.status === 'complete' && ft.direction === 'receive' && ft.blob}
            {#if canPreview(ft)}
              <img class="file-preview" src={previewUrl(ft.blob)} alt={ft.fileName} />
            {/if}
            <button class="file-download" on:click={() => { if (ft.blob) downloadFile(ft.blob, ft.fileName); }}>
              <Icon name="download" size={14} /> Download {ft.fileName}
            </button>
          {:else if ft.status === 'complete' && ft.direction === 'send'}
            <div class="file-sent"><Icon name="check" size={13} /> Sent</div>
          {:else if ft.status === 'cancelled'}
            <div class="file-cancelled">Cancelled</div>
          {/if}
        </div>
      </div>
    {/each}

    {#if messages.length === 0 && transfers.length === 0}
      <div class="empty">
        <Icon name="lock" size={20} />
        <span>No messages yet</span>
        <small>Messages and files go directly between participants, end-to-end encrypted.</small>
      </div>
    {/if}
  </div>

  {#if typingText}
    <div class="typing-indicator" aria-live="polite">{typingText}</div>
  {/if}

  <div class="composer" class:private={!!recipient}>
    <div class="recipient-row">
      <label for="chat-recipient">To</label>
      <div class="select-wrap">
        {#if recipient}<span class="select-icon"><Icon name="lock" size={14} /></span>{/if}
        <select id="chat-recipient" class="input" class:has-icon={!!recipient} bind:value={recipient}>
          <option value="">Everyone</option>
          {#each Array.from($peers.values()) as p (p.id)}
            <option value={p.id} disabled={!p.connected && p.id !== recipient}>
              {p.displayName} (private){p.connected ? '' : ' · connecting'}
            </option>
          {/each}
          {#if recipient && !recipientPeer}
            <option value={recipient}>{recipientName} (left)</option>
          {/if}
        </select>
      </div>
    </div>
    {#if sendError}
      <p class="send-error" role="alert">{sendError}</p>
    {:else if !recipientOnline}
      <p class="send-error" role="status">{recipientName} isn't connected right now.</p>
    {/if}

    <div class="chat-input">
      <input type="file" bind:this={fileInput} on:change={handleFileSelect} style="display:none" />
      <button class="icon-btn attach-btn" on:click={() => fileInput.click()} title="Send file" aria-label="Send file">
        <Icon name="paperclip" size={18} />
      </button>
      <input
        type="text"
        class="input"
        bind:this={inputEl}
        bind:value={inputText}
        on:keydown={handleKeydown}
        on:input={handleInput}
        placeholder={recipient ? `Private message to ${recipientName}…` : 'Message everyone…'}
        aria-label={recipient ? `Private message to ${recipientName}` : 'Message everyone'}
      />
      <button class="icon-btn send-btn" on:click={handleSend} disabled={!inputText.trim()} aria-label="Send" title="Send">
        <Icon name="send" size={18} />
      </button>
    </div>
  </div>
</aside>

<style>
  /* Docked sidebar on wide screens: sits beside the call column and shrinks it. */
  .chat-panel {
    position: relative;
    flex: 0 0 340px;
    width: 340px;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg-surface);
    border-left: 1px solid var(--border-subtle);
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
    min-height: 56px;
    padding: var(--space-2) var(--space-3) var(--space-2) var(--space-4);
    border-bottom: 1px solid var(--border-subtle);
    flex-shrink: 0;
  }

  .chat-title {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-lg);
    font-weight: 600;
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

  .chat-actions {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }

  .save-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
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
    background: var(--accent-soft);
    border-color: transparent;
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

  /* Private / direct messages: warm tint + lock so they never read as public. */
  .message.private .bubble {
    background: var(--warning-soft);
    border-color: var(--warning);
  }

  .private-tag {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 1px 6px;
    border-radius: var(--radius-pill);
    background: var(--warning-soft);
    color: var(--warning);
    font-size: 0.6875rem;
    font-weight: 600;
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
    max-width: 240px;
    color: var(--text-subtle);
    font-size: var(--text-xs);
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

  .recipient-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text-muted);
  }

  .select-wrap {
    position: relative;
    flex: 1;
    min-width: 0;
  }

  .select-wrap select {
    min-height: 36px;
    font-size: var(--text-sm);
    padding: 0 var(--space-2);
  }

  .select-wrap select.has-icon {
    padding-left: 30px;
    border-color: var(--warning);
    background: var(--warning-soft);
  }

  .select-icon {
    position: absolute;
    left: 10px;
    top: 50%;
    transform: translateY(-50%);
    display: flex;
    color: var(--warning);
    pointer-events: none;
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

  .composer.private .chat-input .input {
    border-color: var(--warning);
  }

  .composer.private .chat-input .input:focus-visible {
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

  .send-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  /* ── File transfers ── */
  .file-bubble {
    min-width: 200px;
  }

  .file-name {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--text-sm);
    font-weight: 500;
    overflow-wrap: anywhere;
  }

  .file-progress {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-top: var(--space-2);
  }

  .progress-bar {
    flex: 1;
    height: 6px;
    background: var(--bg-active);
    border-radius: var(--radius-pill);
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: var(--accent);
    border-radius: var(--radius-pill);
    transition: width var(--dur) var(--ease);
  }

  .progress-text {
    font-size: var(--text-xs);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .file-preview {
    display: block;
    max-width: 100%;
    max-height: 160px;
    border-radius: var(--radius);
    margin-top: var(--space-2);
  }

  .file-download {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 36px;
    max-width: 100%;
    margin-top: var(--space-2);
    padding: 0 var(--space-3);
    background: var(--bg-surface);
    color: var(--accent);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-size: var(--text-sm);
    font-weight: 500;
    overflow-wrap: anywhere;
    text-align: left;
  }

  .file-download:hover {
    background: var(--bg-hover);
    border-color: var(--border-strong);
  }

  .file-sent {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-top: var(--space-1);
    font-size: var(--text-xs);
    color: var(--success);
  }

  .file-cancelled {
    margin-top: var(--space-1);
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
</style>
