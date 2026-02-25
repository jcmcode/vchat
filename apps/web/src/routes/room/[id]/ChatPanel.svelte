<script lang="ts">
  import { createEventDispatcher, afterUpdate, onDestroy } from 'svelte';
  import type { ChatMessage } from '$lib/webrtc/mesh';
  import { typingPeers, sendTypingIndicator, sendFileToRoom, peers } from '$lib/webrtc/mesh';
  import { fileTransfers } from '$lib/webrtc/file-transfer';

  export let messages: ChatMessage[];

  const dispatch = createEventDispatcher<{ send: string; close: void }>();

  let inputText = '';
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
    if (typingTimer) clearTimeout(typingTimer);
    if (isTyping) sendTypingIndicator(false);
  });

  function handleSend() {
    if (!inputText.trim()) return;
    dispatch('send', inputText.trim());
    inputText = '';
    if (isTyping) {
      isTyping = false;
      sendTypingIndicator(false);
    }
    if (typingTimer) {
      clearTimeout(typingTimer);
      typingTimer = null;
    }
  }

  function handleInput() {
    if (!isTyping) {
      isTyping = true;
      sendTypingIndicator(true);
    }
    if (typingTimer) clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      isTyping = false;
      sendTypingIndicator(false);
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
    if (file.size > 50 * 1024 * 1024) {
      alert('File too large. Maximum size is 50MB.');
      return;
    }
    sendFileToRoom(file);
    fileInput.value = '';
  }

  function downloadFile(blob: Blob, fileName: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  }

  function isImage(mimeType: string): boolean {
    return mimeType.startsWith('image/');
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

<aside class="chat-panel">
  <div class="chat-header">
    <span>Chat</span>
    <button class="close-btn" on:click={() => dispatch('close')}>x</button>
  </div>

  <div class="messages" bind:this={messagesContainer}>
    {#each messages as msg (msg.id)}
      <div class="message" class:own={msg.isLocal}>
        <div class="msg-meta">
          <span class="msg-name">{msg.isLocal ? 'You' : msg.displayName}</span>
          <span class="msg-time">{formatTime(msg.timestamp)}</span>
        </div>
        <div class="msg-text">{msg.text}</div>
      </div>
    {/each}

    {#each transfers as ft (ft.fileId)}
      <div class="message file-msg">
        <div class="msg-meta">
          <span class="msg-name">{ft.direction === 'send' ? 'You' : ft.displayName ?? 'Peer'}</span>
          <span class="msg-time">{ft.fileName}</span>
        </div>
        {#if ft.status === 'transferring'}
          <div class="file-progress">
            <div class="progress-bar">
              <div class="progress-fill" style="width: {ft.progress * 100}%"></div>
            </div>
            <span class="progress-text">{Math.round(ft.progress * 100)}%</span>
          </div>
        {:else if ft.status === 'complete' && ft.direction === 'receive' && ft.blob}
          {#if isImage(ft.mimeType)}
            <img class="file-preview" src={URL.createObjectURL(ft.blob)} alt={ft.fileName} />
          {/if}
          <button class="file-download" on:click={() => { if (ft.blob) downloadFile(ft.blob, ft.fileName); }}>
            Download {ft.fileName}
          </button>
        {:else if ft.status === 'complete' && ft.direction === 'send'}
          <div class="file-sent">Sent</div>
        {:else if ft.status === 'cancelled'}
          <div class="file-cancelled">Cancelled</div>
        {/if}
      </div>
    {/each}

    {#if messages.length === 0 && transfers.length === 0}
      <div class="empty">No messages yet</div>
    {/if}
  </div>

  {#if typingText}
    <div class="typing-indicator">{typingText}</div>
  {/if}

  <div class="chat-input">
    <input type="file" bind:this={fileInput} on:change={handleFileSelect} style="display:none" />
    <button class="attach-btn" on:click={() => fileInput.click()} title="Send file">
      +
    </button>
    <input
      type="text"
      bind:value={inputText}
      on:keydown={handleKeydown}
      on:input={handleInput}
      placeholder="Type a message..."
    />
    <button class="send-btn" on:click={handleSend} disabled={!inputText.trim()}>
      Send
    </button>
  </div>
</aside>

<style>
  .chat-panel {
    position: absolute;
    right: 0;
    top: 0;
    bottom: 0;
    width: 320px;
    background: var(--bg-surface);
    border-left: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    z-index: 10;
  }

  .chat-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border);
    font-weight: 600;
  }

  .close-btn {
    background: none;
    color: var(--text-muted);
    font-size: 1.2rem;
    padding: 0.2rem 0.5rem;
  }

  .close-btn:hover {
    color: var(--text);
  }

  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .message {
    padding: 0.4rem 0;
  }

  .message.own .msg-name {
    color: var(--accent);
  }

  .msg-meta {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    margin-bottom: 0.15rem;
  }

  .msg-name {
    font-weight: 600;
    font-size: 0.85rem;
  }

  .msg-time {
    color: var(--text-muted);
    font-size: 0.75rem;
  }

  .msg-text {
    font-size: 0.9rem;
    word-break: break-word;
  }

  .empty {
    color: var(--text-muted);
    text-align: center;
    padding: 2rem;
    font-size: 0.9rem;
  }

  .typing-indicator {
    padding: 0.3rem 1rem;
    font-size: 0.8rem;
    color: var(--text-muted);
    font-style: italic;
  }

  .chat-input {
    display: flex;
    gap: 0.5rem;
    padding: 0.75rem;
    border-top: 1px solid var(--border);
  }

  .attach-btn {
    background: var(--bg-elevated);
    color: var(--text-muted);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.5rem 0.7rem;
    font-size: 1.1rem;
    line-height: 1;
  }

  .attach-btn:hover {
    color: var(--text);
    background: var(--border);
  }

  .chat-input input[type="text"] {
    flex: 1;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.5rem 0.75rem;
    color: var(--text);
    font-size: 0.9rem;
  }

  .chat-input input[type="text"]:focus {
    border-color: var(--accent);
  }

  .send-btn {
    background: var(--accent);
    color: white;
    padding: 0.5rem 1rem;
    border-radius: var(--radius);
    font-size: 0.9rem;
  }

  .send-btn:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .send-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .file-msg {
    padding: 0.4rem 0;
  }

  .file-progress {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.3rem;
  }

  .progress-bar {
    flex: 1;
    height: 6px;
    background: var(--bg-elevated);
    border-radius: 3px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.2s;
  }

  .progress-text {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .file-preview {
    max-width: 200px;
    max-height: 150px;
    border-radius: 4px;
    margin-top: 0.3rem;
  }

  .file-download {
    background: var(--bg-elevated);
    color: var(--accent);
    padding: 0.3rem 0.6rem;
    border-radius: 4px;
    font-size: 0.8rem;
    border: 1px solid var(--border);
    margin-top: 0.3rem;
  }

  .file-download:hover {
    background: var(--border);
  }

  .file-sent {
    font-size: 0.8rem;
    color: var(--success);
    margin-top: 0.2rem;
  }

  .file-cancelled {
    font-size: 0.8rem;
    color: var(--text-muted);
    margin-top: 0.2rem;
  }

  @media (max-width: 640px) {
    .chat-panel {
      width: 100%;
      position: fixed;
      inset: 0;
    }
  }
</style>
