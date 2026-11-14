// Peer-to-peer file transfer over the (end-to-end encrypted) WebRTC data channels.
// Files go straight from the sender's browser to each recipient — never through a server.
//
// Incoming data is untrusted: chunk sizes are checked against the announced file size, and the
// number/size of files any one participant can push at you at once is capped.

import { get, writable } from 'svelte/store';

const CHUNK_SIZE = 16 * 1024; // 16KB
export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
/** Chunks in flight per recipient before waiting for acks. */
const WINDOW = 8;
/** Limits on what one participant can send us at the same time. */
const MAX_INCOMING_PER_PEER = 3;
const MAX_INCOMING_BYTES = 150 * 1024 * 1024;
/** Lifetime limits per participant (finished files stay in memory until you leave the call). */
const MAX_FILES_PER_PEER = 50;
const MAX_KEPT_BYTES_PER_PEER = 300 * 1024 * 1024;
/** Drop an incoming transfer that stalls this long. */
const STALL_MS = 60_000;
/** Images up to this size are previewed inline; larger ones are download-only. */
export const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;

export interface FileTransferEntry {
  /** Unique key in `fileTransfers` (file ids are only unique per sender). */
  key: string;
  fileId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  direction: 'send' | 'receive';
  progress: number; // 0-1
  status: 'pending' | 'transferring' | 'complete' | 'cancelled';
  blob?: Blob;
  fromPeerId?: string;
  displayName?: string;
  /** Sent only to one person. */
  private?: boolean;
  /** For files you sent privately: who to. */
  toDisplayName?: string;
}

export const fileTransfers = writable<Map<string, FileTransferEntry>>(new Map());

interface Outgoing {
  file: File;
  totalChunks: number;
  /** Per-recipient progress: next chunk to send and chunks acknowledged. */
  recipients: Map<string, { nextChunk: number; acked: number }>;
}

interface Incoming {
  chunks: (Uint8Array | undefined)[];
  received: number;
  totalChunks: number;
  fileSize: number;
  meta: FileTransferEntry;
  fromPeerId: string;
  lastActivity: number;
}

/** Keyed by our own file id. */
const outgoingFiles = new Map<string, Outgoing>();
/** Keyed by `${fromPeerId}:${fileId}`. */
const incomingFiles = new Map<string, Incoming>();

let sendDataToPeerFn: ((peerId: string, data: string) => void) | null = null;

export function initFileTransfer(
  sendToPeer: (peerId: string, data: string) => void,
  _broadcast?: (data: string) => void
): void {
  sendDataToPeerFn = sendToPeer;
}

export function resetFileTransfers(): void {
  outgoingFiles.clear();
  incomingFiles.clear();
  fileTransfers.set(new Map());
}

const outKey = (fileId: string) => `out:${fileId}`;
const inKey = (fromPeerId: string, fileId: string) => `${fromPeerId}:${fileId}`;

function patchEntry(key: string, patch: Partial<FileTransferEntry>): void {
  fileTransfers.update((m) => {
    const entry = m.get(key);
    if (!entry) return m;
    return new Map(m).set(key, { ...entry, ...patch });
  });
}

function generateFileId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return `f_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** Strip control, zero-width and bidi characters (e.g. "photo‮gpj.exe" posing as "photoexe.jpg"). */
export function safeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/g, '').trim();
  return (cleaned || 'file').slice(0, 200);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Send a file to the given peers (everyone connected, or one person for a private send).
 * Returns the file id, or null if it's too big or there's nobody to send to.
 */
export function sendFile(
  file: File,
  peerIds: string[],
  localPeerId: string,
  localDisplayName: string,
  privateTo?: { displayName: string }
): string | null {
  if (file.size > MAX_FILE_SIZE || peerIds.length === 0) return null;

  const fileId = generateFileId();
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const mimeType = file.type || 'application/octet-stream';
  const fileName = safeFileName(file.name);

  fileTransfers.update((m) =>
    new Map(m).set(outKey(fileId), {
      key: outKey(fileId),
      fileId,
      fileName,
      fileSize: file.size,
      mimeType,
      direction: 'send',
      progress: totalChunks === 0 ? 1 : 0,
      status: totalChunks === 0 ? 'complete' : 'transferring',
      ...(privateTo ? { private: true, toDisplayName: privateTo.displayName } : {}),
    })
  );

  const meta = JSON.stringify({
    type: 'file-meta',
    fileId,
    fileName,
    fileSize: file.size,
    mimeType,
    fromPeerId: localPeerId,
    displayName: localDisplayName,
    ...(privateTo ? { private: true } : {}),
  });
  // Only the recipients learn about the file at all.
  for (const pid of peerIds) sendDataToPeerFn?.(pid, meta);

  if (totalChunks === 0) return fileId;

  outgoingFiles.set(fileId, {
    file,
    totalChunks,
    recipients: new Map(peerIds.map((id) => [id, { nextChunk: 0, acked: 0 }])),
  });
  for (const pid of peerIds) pump(fileId, pid);
  return fileId;
}

/** Keep up to WINDOW unacknowledged chunks in flight to one recipient. */
function pump(fileId: string, peerId: string): void {
  const outgoing = outgoingFiles.get(fileId);
  const r = outgoing?.recipients.get(peerId);
  if (!outgoing || !r) return;

  while (r.nextChunk < outgoing.totalChunks && r.nextChunk - r.acked < WINDOW) {
    const chunkIndex = r.nextChunk++;
    const start = chunkIndex * CHUNK_SIZE;
    outgoing.file
      .slice(start, Math.min(start + CHUNK_SIZE, outgoing.file.size))
      .arrayBuffer()
      .then((buf) => {
        if (!outgoingFiles.has(fileId)) return; // cancelled meanwhile
        sendDataToPeerFn?.(
          peerId,
          JSON.stringify({ type: 'file-chunk', fileId, chunkIndex, data: toBase64(new Uint8Array(buf)) })
        );
      })
      .catch(() => cancelFileTransfer(outKey(fileId)));
  }
}

function updateSendProgress(fileId: string): void {
  const outgoing = outgoingFiles.get(fileId);
  if (!outgoing) return;
  let acked = 0;
  let done = true;
  for (const r of outgoing.recipients.values()) {
    acked += r.acked;
    if (r.acked < outgoing.totalChunks) done = false;
  }
  const progress = acked / (outgoing.totalChunks * outgoing.recipients.size);
  if (done) {
    outgoingFiles.delete(fileId);
    patchEntry(outKey(fileId), { progress: 1, status: 'complete' });
  } else {
    patchEntry(outKey(fileId), { progress });
  }
}

function incomingLoad(fromPeerId: string): { count: number; bytes: number } {
  let count = 0;
  let bytes = 0;
  for (const f of incomingFiles.values()) {
    if (f.fromPeerId === fromPeerId) count++;
    bytes += f.fileSize;
  }
  return { count, bytes };
}

/** Everything this participant has sent us so far this call (in progress or kept in memory). */
function lifetimeLoad(fromPeerId: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  for (const e of get(fileTransfers).values()) {
    if (e.direction !== 'receive' || e.fromPeerId !== fromPeerId || e.status === 'cancelled') continue;
    files++;
    bytes += e.fileSize;
  }
  return { files, bytes };
}

let stallTimer: ReturnType<typeof setInterval> | null = null;

/** Cancel incoming transfers that stopped making progress (so they don't hold memory forever). */
function watchStalls(): void {
  if (stallTimer) return;
  stallTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, incoming] of incomingFiles) {
      if (now - incoming.lastActivity > STALL_MS) cancelFileTransfer(key);
    }
    if (incomingFiles.size === 0 && stallTimer) {
      clearInterval(stallTimer);
      stallTimer = null;
    }
  }, 10_000);
}

export function handleFileMeta(
  msg: { fileId: unknown; fileName: unknown; fileSize: unknown; mimeType: unknown; private?: unknown },
  fromPeerId: string,
  displayName: string
): void {
  const fileSize = msg.fileSize;
  if (
    typeof msg.fileId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(msg.fileId) ||
    typeof msg.fileName !== 'string' ||
    typeof fileSize !== 'number' ||
    !Number.isInteger(fileSize) ||
    fileSize < 0 ||
    fileSize > MAX_FILE_SIZE
  ) {
    return;
  }
  const key = inKey(fromPeerId, msg.fileId);
  if (get(fileTransfers).has(key)) return; // never let a second announcement overwrite a transfer

  const load = incomingLoad(fromPeerId);
  if (load.count >= MAX_INCOMING_PER_PEER || load.bytes + fileSize > MAX_INCOMING_BYTES) return;
  const lifetime = lifetimeLoad(fromPeerId);
  if (lifetime.files >= MAX_FILES_PER_PEER || lifetime.bytes + fileSize > MAX_KEPT_BYTES_PER_PEER) return;

  const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
  const mimeType =
    typeof msg.mimeType === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(msg.mimeType) ? msg.mimeType.slice(0, 100) : 'application/octet-stream';

  const entry: FileTransferEntry = {
    key,
    fileId: msg.fileId,
    fileName: safeFileName(msg.fileName),
    fileSize,
    mimeType,
    direction: 'receive',
    progress: 0,
    status: 'transferring',
    fromPeerId,
    displayName,
    ...(msg.private === true ? { private: true } : {}),
  };

  if (totalChunks === 0) {
    fileTransfers.update((m) =>
      new Map(m).set(key, { ...entry, progress: 1, status: 'complete', blob: new Blob([], { type: mimeType }) })
    );
    return;
  }

  fileTransfers.update((m) => new Map(m).set(key, entry));
  incomingFiles.set(key, {
    chunks: new Array(totalChunks),
    received: 0,
    totalChunks,
    fileSize,
    meta: entry,
    fromPeerId,
    lastActivity: Date.now(),
  });
  watchStalls();
}

export function handleFileChunk(msg: { fileId: unknown; chunkIndex: unknown; data: unknown }, fromPeerId: string): void {
  if (typeof msg.fileId !== 'string') return;
  const key = inKey(fromPeerId, msg.fileId);
  const incoming = incomingFiles.get(key);
  if (!incoming) return;
  const chunkIndex = msg.chunkIndex;
  if (typeof chunkIndex !== 'number' || !Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= incoming.totalChunks) return;
  if (typeof msg.data !== 'string') return;

  // Each chunk must be exactly the size the announced file implies.
  const expected = chunkIndex === incoming.totalChunks - 1 ? incoming.fileSize - chunkIndex * CHUNK_SIZE : CHUNK_SIZE;
  if (msg.data.length !== Math.ceil(expected / 3) * 4) return;

  if (!incoming.chunks[chunkIndex]) {
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = fromBase64(msg.data);
    } catch {
      return;
    }
    if (bytes.length !== expected) return;
    incoming.chunks[chunkIndex] = bytes;
    incoming.received++;
    incoming.lastActivity = Date.now();
  }

  sendDataToPeerFn?.(fromPeerId, JSON.stringify({ type: 'file-ack', fileId: msg.fileId, chunkIndex }));

  if (incoming.received === incoming.totalChunks) {
    const blob = new Blob(incoming.chunks as BlobPart[], { type: incoming.meta.mimeType });
    incomingFiles.delete(key);
    patchEntry(key, { progress: 1, status: 'complete', blob });
  } else if (incoming.received % 8 === 0) {
    patchEntry(key, { progress: incoming.received / incoming.totalChunks });
  }
}

export function handleFileAck(msg: { fileId: unknown; chunkIndex: unknown }, fromPeerId: string): void {
  if (typeof msg.fileId !== 'string') return;
  const r = outgoingFiles.get(msg.fileId)?.recipients.get(fromPeerId);
  if (!r) return;
  r.acked = Math.min(r.acked + 1, r.nextChunk);
  updateSendProgress(msg.fileId);
  pump(msg.fileId, fromPeerId);
}

/** A peer left or its connection was replaced: stop waiting on them / for them. */
export function dropRecipient(peerId: string): void {
  for (const [fileId, outgoing] of outgoingFiles) {
    if (outgoing.recipients.delete(peerId)) {
      if (outgoing.recipients.size === 0) {
        outgoingFiles.delete(fileId);
        patchEntry(outKey(fileId), { status: 'cancelled' });
      } else {
        updateSendProgress(fileId);
      }
    }
  }
  for (const [key, incoming] of incomingFiles) {
    if (incoming.fromPeerId === peerId) {
      incomingFiles.delete(key);
      patchEntry(key, { status: 'cancelled' });
    }
  }
}

/** Cancel a transfer by its entry key (from the UI). */
export function cancelFileTransfer(key: string): void {
  patchEntry(key, { status: 'cancelled' });
  if (key.startsWith('out:')) {
    const fileId = key.slice(4);
    const outgoing = outgoingFiles.get(fileId);
    outgoingFiles.delete(fileId);
    for (const pid of outgoing?.recipients.keys() ?? []) {
      sendDataToPeerFn?.(pid, JSON.stringify({ type: 'file-cancel', fileId }));
    }
    return;
  }
  const incoming = incomingFiles.get(key);
  incomingFiles.delete(key);
  if (incoming) {
    sendDataToPeerFn?.(incoming.fromPeerId, JSON.stringify({ type: 'file-cancel', fileId: incoming.meta.fileId }));
  }
}

export function handleFileCancel(msg: { fileId: unknown }, fromPeerId: string): void {
  if (typeof msg.fileId !== 'string') return;
  // The sender cancelled a file they were sending us.
  const key = inKey(fromPeerId, msg.fileId);
  if (incomingFiles.delete(key)) patchEntry(key, { status: 'cancelled' });
  // A recipient cancelled: stop sending to them only.
  const outgoing = outgoingFiles.get(msg.fileId);
  if (outgoing?.recipients.delete(fromPeerId)) {
    if (outgoing.recipients.size === 0) {
      outgoingFiles.delete(msg.fileId);
      patchEntry(outKey(msg.fileId), { status: 'cancelled' });
    } else {
      updateSendProgress(msg.fileId);
    }
  }
}
