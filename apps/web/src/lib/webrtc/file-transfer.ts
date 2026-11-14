import { writable } from 'svelte/store';

const CHUNK_SIZE = 16 * 1024; // 16KB
export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
/** Chunks in flight per recipient before waiting for acks. */
const WINDOW = 8;

export interface FileTransferEntry {
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
  meta: FileTransferEntry;
  fromPeerId: string;
}

const outgoingFiles = new Map<string, Outgoing>();
const incomingFiles = new Map<string, Incoming>();

let sendDataToPeerFn: ((peerId: string, data: string) => void) | null = null;
let broadcastFn: ((data: string) => void) | null = null;

export function initFileTransfer(
  sendToPeer: (peerId: string, data: string) => void,
  broadcast: (data: string) => void
): void {
  sendDataToPeerFn = sendToPeer;
  broadcastFn = broadcast;
}

export function resetFileTransfers(): void {
  outgoingFiles.clear();
  incomingFiles.clear();
  fileTransfers.set(new Map());
}

function patchEntry(fileId: string, patch: Partial<FileTransferEntry>): void {
  fileTransfers.update((m) => {
    const entry = m.get(fileId);
    if (!entry) return m;
    return new Map(m).set(fileId, { ...entry, ...patch });
  });
}

function generateFileId(): string {
  return `f_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function sendFile(
  file: File,
  peerIds: string[],
  localPeerId: string,
  localDisplayName: string
): string | null {
  if (file.size > MAX_FILE_SIZE || peerIds.length === 0) return null;

  const fileId = generateFileId();
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const mimeType = file.type || 'application/octet-stream';

  fileTransfers.update((m) =>
    new Map(m).set(fileId, {
      fileId,
      fileName: file.name,
      fileSize: file.size,
      mimeType,
      direction: 'send',
      progress: totalChunks === 0 ? 1 : 0,
      status: totalChunks === 0 ? 'complete' : 'transferring',
    })
  );

  broadcastFn?.(
    JSON.stringify({
      type: 'file-meta',
      fileId,
      fileName: file.name,
      fileSize: file.size,
      mimeType,
      fromPeerId: localPeerId,
      displayName: localDisplayName,
    })
  );

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
      .catch(() => cancelFileTransfer(fileId));
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
    patchEntry(fileId, { progress: 1, status: 'complete' });
  } else {
    patchEntry(fileId, { progress });
  }
}

export function handleFileMeta(msg: {
  fileId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  fromPeerId: string;
  displayName: string;
}): void {
  if (
    typeof msg.fileId !== 'string' ||
    typeof msg.fileName !== 'string' ||
    !Number.isInteger(msg.fileSize) ||
    msg.fileSize < 0 ||
    msg.fileSize > MAX_FILE_SIZE ||
    incomingFiles.has(msg.fileId)
  ) {
    return;
  }
  const totalChunks = Math.ceil(msg.fileSize / CHUNK_SIZE);
  const mimeType = typeof msg.mimeType === 'string' ? msg.mimeType.slice(0, 100) : 'application/octet-stream';

  const entry: FileTransferEntry = {
    fileId: msg.fileId,
    fileName: msg.fileName.slice(0, 255),
    fileSize: msg.fileSize,
    mimeType,
    direction: 'receive',
    progress: 0,
    status: 'transferring',
    fromPeerId: msg.fromPeerId,
    displayName: msg.displayName,
  };

  if (totalChunks === 0) {
    fileTransfers.update((m) =>
      new Map(m).set(msg.fileId, { ...entry, progress: 1, status: 'complete', blob: new Blob([], { type: mimeType }) })
    );
    return;
  }

  fileTransfers.update((m) => new Map(m).set(msg.fileId, entry));
  incomingFiles.set(msg.fileId, {
    chunks: new Array(totalChunks),
    received: 0,
    totalChunks,
    meta: entry,
    fromPeerId: msg.fromPeerId,
  });
}

export function handleFileChunk(
  msg: { fileId: string; chunkIndex: number; data: string },
  actualFromPeerId: string
): void {
  const incoming = incomingFiles.get(msg.fileId);
  if (!incoming || incoming.fromPeerId !== actualFromPeerId) return;
  const { chunkIndex } = msg;
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= incoming.totalChunks) return;
  if (typeof msg.data !== 'string') return;

  if (!incoming.chunks[chunkIndex]) {
    try {
      incoming.chunks[chunkIndex] = fromBase64(msg.data);
    } catch {
      return;
    }
    incoming.received++;
  }

  sendDataToPeerFn?.(actualFromPeerId, JSON.stringify({ type: 'file-ack', fileId: msg.fileId, chunkIndex }));

  if (incoming.received === incoming.totalChunks) {
    const blob = new Blob(incoming.chunks as BlobPart[], { type: incoming.meta.mimeType });
    incomingFiles.delete(msg.fileId);
    patchEntry(msg.fileId, { progress: 1, status: 'complete', blob });
  } else if (incoming.received % 8 === 0) {
    patchEntry(msg.fileId, { progress: incoming.received / incoming.totalChunks });
  }
}

export function handleFileAck(msg: { fileId: string; chunkIndex: number }, actualFromPeerId: string): void {
  const r = outgoingFiles.get(msg.fileId)?.recipients.get(actualFromPeerId);
  if (!r) return;
  r.acked = Math.min(r.acked + 1, r.nextChunk);
  updateSendProgress(msg.fileId);
  pump(msg.fileId, actualFromPeerId);
}

/** A recipient left mid-transfer: stop waiting on them. */
export function dropRecipient(peerId: string): void {
  for (const [fileId, outgoing] of outgoingFiles) {
    if (outgoing.recipients.delete(peerId)) {
      if (outgoing.recipients.size === 0) {
        outgoingFiles.delete(fileId);
        patchEntry(fileId, { status: 'cancelled' });
      } else {
        updateSendProgress(fileId);
      }
    }
  }
  for (const [fileId, incoming] of incomingFiles) {
    if (incoming.fromPeerId === peerId) {
      incomingFiles.delete(fileId);
      patchEntry(fileId, { status: 'cancelled' });
    }
  }
}

export function cancelFileTransfer(fileId: string): void {
  outgoingFiles.delete(fileId);
  incomingFiles.delete(fileId);
  patchEntry(fileId, { status: 'cancelled' });
  broadcastFn?.(JSON.stringify({ type: 'file-cancel', fileId }));
}

export function handleFileCancel(msg: { fileId: string }, actualFromPeerId: string): void {
  const incoming = incomingFiles.get(msg.fileId);
  if (incoming && incoming.fromPeerId === actualFromPeerId) {
    incomingFiles.delete(msg.fileId);
    patchEntry(msg.fileId, { status: 'cancelled' });
  }
  // A recipient cancelling only stops sending to them.
  const outgoing = outgoingFiles.get(msg.fileId);
  if (outgoing?.recipients.delete(actualFromPeerId)) {
    if (outgoing.recipients.size === 0) {
      outgoingFiles.delete(msg.fileId);
      patchEntry(msg.fileId, { status: 'cancelled' });
    } else {
      updateSendProgress(msg.fileId);
    }
  }
}
