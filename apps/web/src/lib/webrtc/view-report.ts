// Tells each person in the call how big we show their camera (view-size.ts), at most once a second,
// so they send us no bigger a picture than that (quality.ts cameraForViewer, applied in mesh.ts).
// Imported for its side effects by the call page.

import { onPeerConnected, onPeerLeft, onRoomLeft, sendData } from './mesh.js';
import { pipMode, pipOpen } from '../ui/pip.js';
import { LatestSender } from './latest-sender.js';
import { measureViews, onViewsChanged, viewReport, type Box, type ViewReport } from './view-size.js';

type Report = ViewReport | { full: true };

const senders = new Map<string, LatestSender<Report>>();
let boxes = new Map<string, Box>();
/** The system picture-in-picture window (one video, any size) is open: we can't measure it. */
let systemPip = false;

function reportFor(peerId: string): Report {
  return systemPip ? { full: true } : viewReport(boxes.get(peerId));
}

function refresh(): void {
  boxes = measureViews();
  for (const sender of senders.values()) sender.notify();
}

// A new trusted connection (also after a reconnect): start telling this person afresh.
onPeerConnected((peerId) => {
  senders.get(peerId)?.cancel();
  const sender = new LatestSender<Report>({
    intervalMs: 1000,
    read: () => reportFor(peerId),
    send: (report) => sendData(peerId, { type: 'view', ...report }),
  });
  senders.set(peerId, sender);
  boxes = measureViews();
  sender.notify();
});

onPeerLeft((peerId) => {
  senders.get(peerId)?.cancel();
  senders.delete(peerId);
});

onRoomLeft(() => {
  for (const sender of senders.values()) sender.cancel();
  senders.clear();
  boxes = new Map();
});

onViewsChanged(refresh);

if (typeof window !== 'undefined' && pipMode === 'video') {
  pipOpen.subscribe((open) => {
    systemPip = open;
    refresh();
  });
}
