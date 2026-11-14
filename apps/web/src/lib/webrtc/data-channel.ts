export type DataChannelMessage =
  | { type: 'chat'; text: string; fromPeerId: string; displayName: string; timestamp: number; private?: boolean }
  | { type: 'screen-state'; sharing: boolean }
  | { type: 'media-state'; audio: boolean; video: boolean }
  | { type: 'typing'; isTyping: boolean; fromPeerId: string }
  | { type: 'reaction'; emoji: string; fromPeerId: string; displayName: string; timestamp: number }
  | { type: 'file-meta'; fileId: string; fileName: string; fileSize: number; mimeType: string; fromPeerId: string; displayName: string }
  | { type: 'file-chunk'; fileId: string; chunkIndex: number; data: string }
  | { type: 'file-cancel'; fileId: string }
  | { type: 'file-ack'; fileId: string; chunkIndex: number };

export function serialize(msg: DataChannelMessage): string {
  return JSON.stringify(msg);
}

/** Any peer-to-peer message; collaboration features (whiteboard, annotations) add their own types. */
export interface AnyDataMessage {
  type: string;
  [key: string]: unknown;
}

export function deserialize(data: string): DataChannelMessage | AnyDataMessage | null {
  try {
    const msg = JSON.parse(data);
    return msg && typeof msg === 'object' && typeof msg.type === 'string' ? msg : null;
  } catch {
    return null;
  }
}
