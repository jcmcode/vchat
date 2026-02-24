import { writable, get } from 'svelte/store';

const CHUNK_SIZE = 16 * 1024; // 16KB
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

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

// Outgoing transfers: file data + chunk tracking
const outgoingFiles = new Map<string, { file: File; nextChunk: number; totalChunks: number; peerIds: string[] }>();
// Incoming transfers: received chunks
const incomingChunks = new Map<string, { chunks: string[]; totalChunks: number; meta: FileTransferEntry }>();

let sendDataToPeerFn: ((peerId: string, data: string) => void) | null = null;
let broadcastFn: ((data: string) => void) | null = null;

export function initFileTransfer(
  sendToPeer: (peerId: string, data: string) => void,
  broadcast: (data: string) => void
): void {
  sendDataToPeerFn = sendToPeer;
  broadcastFn = broadcast;
}

function generateFileId(): string {
  return `f_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function sendFile(file: File, peerIds: string[], localPeerId: string, localDisplayName: string): string | null {
  if (file.size > MAX_FILE_SIZE) {
    return null;
  }

  const fileId = generateFileId();
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

  const entry: FileTransferEntry = {
    fileId,
    fileName: file.name,
    fileSize: file.size,
    mimeType: file.type || 'application/octet-stream',
    direction: 'send',
    progress: 0,
    status: 'transferring',
  };

  fileTransfers.update((m) => {
    const updated = new Map(m);
    updated.set(fileId, entry);
    return updated;
  });

  outgoingFiles.set(fileId, { file, nextChunk: 0, totalChunks, peerIds });

  // Send file metadata to all peers
  const meta = JSON.stringify({
    type: 'file-meta',
    fileId,
    fileName: file.name,
    fileSize: file.size,
    mimeType: file.type || 'application/octet-stream',
    fromPeerId: localPeerId,
    displayName: localDisplayName,
  });

  if (broadcastFn) broadcastFn(meta);

  // Start sending chunks to each peer
  for (const pid of peerIds) {
    sendNextChunk(fileId, pid);
  }

  return fileId;
}

function sendNextChunk(fileId: string, peerId: string): void {
  const outgoing = outgoingFiles.get(fileId);
  if (!outgoing) return;

  const { file, nextChunk, totalChunks } = outgoing;
  if (nextChunk >= totalChunks) {
    // Done
    fileTransfers.update((m) => {
      const updated = new Map(m);
      const entry = updated.get(fileId);
      if (entry) {
        updated.set(fileId, { ...entry, progress: 1, status: 'complete' });
      }
      return updated;
    });
    outgoingFiles.delete(fileId);
    return;
  }

  const start = nextChunk * CHUNK_SIZE;
  const end = Math.min(start + CHUNK_SIZE, file.size);
  const slice = file.slice(start, end);

  const reader = new FileReader();
  reader.onload = () => {
    const base64 = (reader.result as string).split(',')[1];
    const msg = JSON.stringify({
      type: 'file-chunk',
      fileId,
      chunkIndex: nextChunk,
      data: base64,
      fromPeerId: '', // filled by caller context
    });

    if (sendDataToPeerFn) sendDataToPeerFn(peerId, msg);

    // Update progress
    outgoing.nextChunk = nextChunk + 1;
    fileTransfers.update((m) => {
      const updated = new Map(m);
      const entry = updated.get(fileId);
      if (entry) {
        updated.set(fileId, { ...entry, progress: outgoing.nextChunk / totalChunks });
      }
      return updated;
    });
  };
  reader.readAsDataURL(slice);
}

export function handleFileMeta(msg: {
  fileId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  fromPeerId: string;
  displayName: string;
}): void {
  const totalChunks = Math.ceil(msg.fileSize / CHUNK_SIZE);

  const entry: FileTransferEntry = {
    fileId: msg.fileId,
    fileName: msg.fileName,
    fileSize: msg.fileSize,
    mimeType: msg.mimeType,
    direction: 'receive',
    progress: 0,
    status: 'transferring',
    fromPeerId: msg.fromPeerId,
    displayName: msg.displayName,
  };

  fileTransfers.update((m) => {
    const updated = new Map(m);
    updated.set(msg.fileId, entry);
    return updated;
  });

  incomingChunks.set(msg.fileId, {
    chunks: new Array(totalChunks),
    totalChunks,
    meta: entry,
  });
}

export function handleFileChunk(msg: {
  fileId: string;
  chunkIndex: number;
  data: string;
  fromPeerId: string;
}): void {
  const incoming = incomingChunks.get(msg.fileId);
  if (!incoming) return;

  incoming.chunks[msg.chunkIndex] = msg.data;

  // Send ack
  if (sendDataToPeerFn) {
    sendDataToPeerFn(msg.fromPeerId, JSON.stringify({
      type: 'file-ack',
      fileId: msg.fileId,
      chunkIndex: msg.chunkIndex,
      fromPeerId: '',
    }));
  }

  // Check how many chunks received
  const received = incoming.chunks.filter((c) => c !== undefined).length;
  const progress = received / incoming.totalChunks;

  fileTransfers.update((m) => {
    const updated = new Map(m);
    const entry = updated.get(msg.fileId);
    if (entry) {
      updated.set(msg.fileId, { ...entry, progress });
    }
    return updated;
  });

  // All chunks received — assemble blob
  if (received === incoming.totalChunks) {
    const binaryChunks = incoming.chunks.map((b64) => {
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    });

    const blob = new Blob(binaryChunks, { type: incoming.meta.mimeType });

    fileTransfers.update((m) => {
      const updated = new Map(m);
      const entry = updated.get(msg.fileId);
      if (entry) {
        updated.set(msg.fileId, { ...entry, progress: 1, status: 'complete', blob });
      }
      return updated;
    });

    incomingChunks.delete(msg.fileId);
  }
}

export function handleFileAck(msg: { fileId: string; chunkIndex: number; fromPeerId: string }): void {
  // Send next chunk to this peer
  sendNextChunk(msg.fileId, msg.fromPeerId);
}

export function cancelFileTransfer(fileId: string): void {
  outgoingFiles.delete(fileId);
  incomingChunks.delete(fileId);

  fileTransfers.update((m) => {
    const updated = new Map(m);
    const entry = updated.get(fileId);
    if (entry) {
      updated.set(fileId, { ...entry, status: 'cancelled' });
    }
    return updated;
  });

  if (broadcastFn) {
    broadcastFn(JSON.stringify({ type: 'file-cancel', fileId, fromPeerId: '' }));
  }
}

export function handleFileCancel(msg: { fileId: string }): void {
  outgoingFiles.delete(msg.fileId);
  incomingChunks.delete(msg.fileId);

  fileTransfers.update((m) => {
    const updated = new Map(m);
    const entry = updated.get(msg.fileId);
    if (entry) {
      updated.set(msg.fileId, { ...entry, status: 'cancelled' });
    }
    return updated;
  });
}
