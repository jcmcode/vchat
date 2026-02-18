<script lang="ts">
  import { createEventDispatcher, afterUpdate } from 'svelte';
  import type { ChatMessage } from '$lib/webrtc/mesh';

  export let messages: ChatMessage[];

  const dispatch = createEventDispatcher<{ send: string; close: void }>();

  let inputText = '';
  let messagesContainer: HTMLDivElement;

  afterUpdate(() => {
    if (messagesContainer) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
  });

  function handleSend() {
    if (!inputText.trim()) return;
    dispatch('send', inputText.trim());
    inputText = '';
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
</script>

<aside class="chat-panel">
  <div class="chat-header">
    <span>Chat</span>
    <button class="close-btn" on:click={() => dispatch('close')}>x</button>
  </div>

  <div class="messages" bind:this={messagesContainer}>
    {#each messages as msg (msg.timestamp + msg.fromPeerId)}
      <div class="message" class:own={msg.isLocal}>
        <div class="msg-meta">
          <span class="msg-name">{msg.isLocal ? 'You' : msg.displayName}</span>
          <span class="msg-time">{formatTime(msg.timestamp)}</span>
        </div>
        <div class="msg-text">{msg.text}</div>
      </div>
    {/each}
    {#if messages.length === 0}
      <div class="empty">No messages yet</div>
    {/if}
  </div>

  <div class="chat-input">
    <input
      type="text"
      bind:value={inputText}
      on:keydown={handleKeydown}
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

  .chat-input {
    display: flex;
    gap: 0.5rem;
    padding: 0.75rem;
    border-top: 1px solid var(--border);
  }

  .chat-input input {
    flex: 1;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.5rem 0.75rem;
    color: var(--text);
    font-size: 0.9rem;
  }

  .chat-input input:focus {
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
</style>
