export type DataChannelMessage =
  | { type: 'chat'; text: string; fromPeerId: string; displayName: string; timestamp: number }
  | { type: 'typing'; isTyping: boolean; fromPeerId: string }
  | { type: 'reaction'; emoji: string; fromPeerId: string; displayName: string; timestamp: number }
  | { type: 'file-meta'; fileId: string; fileName: string; fileSize: number; mimeType: string; fromPeerId: string; displayName: string }
  | { type: 'file-chunk'; fileId: string; chunkIndex: number; data: string }
  | { type: 'file-cancel'; fileId: string }
  | { type: 'file-ack'; fileId: string; chunkIndex: number };

export function serialize(msg: DataChannelMessage): string {
  return JSON.stringify(msg);
}

export function deserialize(data: string): DataChannelMessage | null {
  try {
    return JSON.parse(data) as DataChannelMessage;
  } catch {
    return null;
  }
}
