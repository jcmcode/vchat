// Chat is split into conversations: one for everyone in the call, and one private conversation
// per person. Private messages never show in the everyone conversation. Pure helpers (unit-tested
// in threads.test.ts) plus the small amount of "what have I already seen" state the chat button
// and the conversation picker need, kept here so it survives closing and reopening the chat.

import { get, writable, type Readable } from 'svelte/store';

/** The conversation with everyone in the call. Any other conversation id is a peer id. */
export const EVERYONE = '';

/** The parts of a chat message this uses (a `ChatMessage` from mesh.ts fits). */
export interface ThreadMessage {
  id: string;
  fromPeerId: string;
  isLocal: boolean;
  private?: boolean;
  toPeerId?: string;
}

/** The parts of a file transfer this uses (a `FileTransferEntry` fits). */
export interface ThreadFile {
  key: string;
  direction: 'send' | 'receive';
  fromPeerId?: string;
  private?: boolean;
  toPeerId?: string;
}

/** Which conversation a message belongs to: everyone, or the other person in a private chat. */
export function threadOf(msg: ThreadMessage): string {
  if (!msg.private) return EVERYONE;
  return (msg.isLocal ? msg.toPeerId : msg.fromPeerId) ?? EVERYONE;
}

/** Which conversation a file was shared in. */
export function fileThreadOf(file: ThreadFile): string {
  if (!file.private) return EVERYONE;
  return (file.direction === 'send' ? file.toPeerId : file.fromPeerId) ?? EVERYONE;
}

/** Messages in one conversation, in order. */
export function messagesIn<M extends ThreadMessage>(messages: M[], thread: string): M[] {
  return messages.filter((m) => threadOf(m) === thread);
}

/** Unread messages per conversation (only conversations that have some). */
export function unreadByThread(messages: ThreadMessage[], seen: ReadonlySet<string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of messages) {
    if (m.isLocal || seen.has(m.id)) continue;
    const t = threadOf(m);
    out.set(t, (out.get(t) ?? 0) + 1);
  }
  return out;
}

/** People you've had a private conversation with, most recent first. */
export function privatePartners(messages: ThreadMessage[], files: ThreadFile[] = []): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const ids = [...messages.map(threadOf), ...files.map(fileThreadOf)];
  // Walk newest to oldest; files have no timestamps here, so they rank after messages.
  for (let i = messages.length - 1; i >= 0; i--) add(ids[i]);
  for (let i = ids.length - 1; i >= messages.length; i--) add(ids[i]);
  function add(id: string) {
    if (id === EVERYONE || seen.has(id)) return;
    seen.add(id);
    order.push(id);
  }
  return order;
}

/** Received files you haven't looked at in the Files tab yet. */
export function unseenFileCount(files: ThreadFile[], seen: ReadonlySet<string>): number {
  let n = 0;
  for (const f of files) if (f.direction === 'receive' && !seen.has(f.key)) n++;
  return n;
}

// ── Seen state ──

const seenMessages = writable<Set<string>>(new Set());
const seenFiles = writable<Set<string>>(new Set());

/** Ids of messages you've seen (their conversation was open in the chat). */
export const seenMessageIds: Readable<Set<string>> = { subscribe: seenMessages.subscribe };
/** Keys of received files you've seen (the Files tab was open). */
export const seenFileKeys: Readable<Set<string>> = { subscribe: seenFiles.subscribe };

// Both only notify subscribers when something actually changed, so they're safe to call after
// every render.
export function markThreadSeen(messages: ThreadMessage[], thread: string): void {
  const s = get(seenMessages);
  let next: Set<string> | null = null;
  for (const m of messages) {
    if (m.isLocal || s.has(m.id) || threadOf(m) !== thread) continue;
    next ??= new Set(s);
    next.add(m.id);
  }
  if (next) seenMessages.set(next);
}

export function markFilesSeen(files: ThreadFile[]): void {
  const s = get(seenFiles);
  let next: Set<string> | null = null;
  for (const f of files) {
    if (f.direction !== 'receive' || s.has(f.key)) continue;
    next ??= new Set(s);
    next.add(f.key);
  }
  if (next) seenFiles.set(next);
}

/** Messages already in the chat when you join aren't "new" (and nothing carries over between calls). */
export function markAllSeen(messages: ThreadMessage[], files: ThreadFile[]): void {
  seenMessages.set(new Set(messages.filter((m) => !m.isLocal).map((m) => m.id)));
  seenFiles.set(new Set(files.filter((f) => f.direction === 'receive').map((f) => f.key)));
}
