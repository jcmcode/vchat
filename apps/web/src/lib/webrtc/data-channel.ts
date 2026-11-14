export type DataChannelMessage =
  | { type: 'chat'; text: string; fromPeerId: string; displayName: string; timestamp: number; private?: boolean }
  /** `mid`: which of the sender's own video transceivers carries the screen (see media-slots.ts). */
  | { type: 'screen-state'; sharing: boolean; mid?: string }
  | { type: 'media-state'; audio: boolean; video: boolean }
  | { type: 'typing'; isTyping: boolean; fromPeerId: string; private?: boolean }
  | { type: 'reaction'; emoji: string; fromPeerId: string; displayName: string; timestamp: number }
  | { type: 'file-meta'; fileId: string; fileName: string; fileSize: number; mimeType: string; fromPeerId: string; displayName: string }
  | { type: 'file-chunk'; fileId: string; chunkIndex: number; data: string }
  | { type: 'file-cancel'; fileId: string }
  | { type: 'file-ack'; fileId: string; chunkIndex: number }
  /** What this version supports (sent once a connection is trusted). */
  | { type: 'caps'; iceRestart?: boolean }
  /** How we show their camera: `{w, h, fit}` in device pixels, `{w: 0, h: 0}` not shown, `{full: true}` no limit. */
  | { type: 'view'; w?: number; h?: number; fit?: 'cover' | 'contain'; full?: true };

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
