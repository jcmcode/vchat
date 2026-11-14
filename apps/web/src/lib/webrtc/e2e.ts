// End-to-end verification of every peer-to-peer connection.
//
// WebRTC encrypts media and data between browsers (DTLS-SRTP), but the DTLS fingerprints that
// anchor that encryption travel through the signaling server — so a compromised server could try
// to sit in the middle. To rule that out, each room has a secret key that lives only in the invite
// link's "#fragment" (never sent to any server).
//
// For each connection:
//   1. mesh.ts creates it with max-bundle (one transport), rejects any session description that
//      doesn't carry exactly one SHA-256 fingerprint, and pins that fingerprint + ICE credentials.
//   2. Nothing flows yet: our camera/mic are held back, nothing received is shown or played, and
//      only verification messages may cross the data channel.
//   3. When the data channel opens we cross-check the pinned fingerprint against the certificate
//      the browser actually used (getStats), then send an HMAC proof (keyed from the room key) over
//      both fingerprints, the session id, both peer ids and our own display name.
//   4. Only a valid proof from them opens the gate (trustPeer). Anything else — a wrong proof,
//      changed encryption details — blocks the connection; no proof (they don't have the key) or no
//      answer keeps it closed until the user explicitly chooses "Allow anyway".
// Someone in the middle shows each side different fingerprints and lacks the key, so it can't
// produce proofs that match what each side sees. A 6-digit safety code per connection also lets
// people confirm out loud that nobody (not even another key holder) is in the middle.

import { get, writable } from 'svelte/store';
import {
  blockPeer,
  cleanPeerText,
  getLocalDisplayName,
  getLocalPeerId,
  getPeerConnection,
  onPeerChannelOpen,
  onPeerCreated,
  onPeerLeft,
  onPeerSecurityFailure,
  onRoomLeft,
  peerDisplayName,
  registerDataHandler,
  sendVerification,
  setVerifiedName,
  trustPeer,
} from './mesh.js';
import {
  checkProof,
  createProof,
  generateRoomKey,
  importRoomKey,
  isValidRoomKey,
  safetyCode,
  sdpFingerprint,
  type RoomKeys,
} from './e2e-proof.js';

export type Verification =
  | 'pending' // checking
  | 'verified' // proved they hold the room key over this exact connection
  | 'unverified' // no proof (no key, or no answer) — blocked unless you allow it
  | 'allowed' // unverified, but you chose to allow it
  | 'failed' // proof or encryption details were wrong — blocked
  | 'nokey'; // you have no room key, so nobody can be verified (allowed, with a warning)

export interface PeerVerification {
  /** Connection session this state belongs to. */
  sid: string | null;
  state: Verification;
  /** Why it's unverified/failed (for the UI). */
  reason?: string;
  /** Safety code for this connection (same on both sides if nobody is in the middle). */
  code?: string;
}

export const verification = writable<Map<string, PeerVerification>>(new Map());
/** Connections refused for failing verification (shown as a warning banner). */
export const blockedConnections = writable<{ peerId: string; name: string; reason: string }[]>([]);
/** Whether this tab has the room's key. */
export const hasRoomKey = writable(false);

export { generateRoomKey, isValidRoomKey };

/** How long a connection may take to verify before it's shown as "couldn't verify". */
const VERIFY_DEADLINE_MS = 20_000;

let keys: RoomKeys | null = null;
let keyRoomId = '';
const deadlines = new Map<string, ReturnType<typeof setTimeout>>();

function entry(peerId: string): PeerVerification | undefined {
  return get(verification).get(peerId);
}

function setEntry(peerId: string, next: PeerVerification): void {
  verification.update((m) => new Map(m).set(peerId, next));
}

/** Update state only if it still belongs to the connection `sid`, and never undo a final result. */
function setState(peerId: string, sid: string, state: Verification, extra: Partial<PeerVerification> = {}): void {
  const cur = entry(peerId);
  if (cur && cur.sid && cur.sid !== sid) return;
  if (cur && (cur.state === 'verified' || cur.state === 'failed') && state !== cur.state) return;
  setEntry(peerId, { ...cur, ...extra, sid, state });
}

function currentSid(peerId: string): string | null {
  return getPeerConnection(peerId)?.sid ?? null;
}

/** Load the room key (or none) before joining. */
export async function setE2EKey(roomId: string, key: string | undefined): Promise<void> {
  keyRoomId = roomId;
  keys = isValidRoomKey(key) ? await importRoomKey(key) : null;
  hasRoomKey.set(!!keys);
}

// ── Connection identity ────────────────────────────────────────────────────────

/**
 * The DTLS fingerprints of this connection: theirs pinned from their (strictly validated) session
 * description, cross-checked against the certificates the browser actually negotiated.
 */
async function connectionIdentity(peerId: string): Promise<{ local: string; remote: string } | null> {
  const pc = getPeerConnection(peerId);
  const rtc = (pc?.peer as unknown as { _pc?: RTCPeerConnection } | undefined)?._pc;
  const remote = pc?.pinned?.fingerprint;
  const local = sdpFingerprint(rtc?.localDescription?.sdp);
  if (!rtc || !remote || !local) return null;

  try {
    const stats = await rtc.getStats();
    const certs = new Map<string, string>();
    const transports: { local?: string; remote?: string }[] = [];
    stats.forEach((r: Record<string, unknown>) => {
      if (r.type === 'certificate' && typeof r.fingerprint === 'string' && typeof r.fingerprintAlgorithm === 'string') {
        certs.set(r.id as string, `${r.fingerprintAlgorithm.toLowerCase()} ${r.fingerprint.toUpperCase()}`);
      }
      if (r.type === 'transport') {
        transports.push({ local: r.localCertificateId as string | undefined, remote: r.remoteCertificateId as string | undefined });
      }
    });
    // Every transport the browser uses must present exactly the certificates we're verifying.
    for (const t of transports) {
      if (t.remote && certs.has(t.remote) && certs.get(t.remote) !== remote) return null;
      if (t.local && certs.has(t.local) && certs.get(t.local) !== local) return null;
    }
    const withCerts = transports.filter((t) => t.remote && certs.has(t.remote));
    if (withCerts.length > 1) return null; // more than one DTLS transport: not covered by one proof
  } catch {
    // Some browsers don't expose certificate stats; the strict SDP checks + pinning still apply.
  }
  return { local, remote };
}

// ── Protocol ───────────────────────────────────────────────────────────────────

onPeerCreated((peerId, sid) => {
  const prev = deadlines.get(peerId);
  if (prev) clearTimeout(prev);
  setEntry(peerId, { sid, state: 'pending' });
  deadlines.set(
    peerId,
    setTimeout(() => {
      deadlines.delete(peerId);
      const cur = entry(peerId);
      const live = currentSid(peerId);
      if (cur?.state === 'pending' && live && (!cur.sid || cur.sid === live)) {
        setState(peerId, live, 'unverified', { reason: "didn't complete verification in time" });
      }
    }, VERIFY_DEADLINE_MS)
  );
});

onPeerChannelOpen(async (peerId, sid) => {
  const cur = entry(peerId);
  setEntry(peerId, { ...cur, sid, state: cur?.sid === sid ? cur.state : 'pending' });

  if (!keys) {
    // We can't verify anyone without the key: let it through, clearly marked.
    sendVerification(peerId, sid, { type: 'e2e-auth', mac: null });
    setState(peerId, sid, 'nokey');
    trustPeer(peerId, sid);
    return;
  }

  const ids = await connectionIdentity(peerId);
  if (currentSid(peerId) !== sid) return;
  if (!ids) {
    fail(peerId, sid, 'its encryption details did not match');
    return;
  }
  const name = getLocalDisplayName();
  const mac = await createProof(keys, {
    roomId: keyRoomId,
    sid,
    fromId: getLocalPeerId(),
    toId: peerId,
    fromFp: ids.local,
    toFp: ids.remote,
    fromName: name,
  });
  const code = await safetyCode(keys, keyRoomId, ids.local, ids.remote);
  if (currentSid(peerId) !== sid) return;
  sendVerification(peerId, sid, { type: 'e2e-auth', mac, name });
  setEntry(peerId, { ...entry(peerId), sid, state: entry(peerId)?.state ?? 'pending', code });
  // Their proof may have arrived first.
  if (entry(peerId)?.state === 'verified') trustPeer(peerId, sid);
});

registerDataHandler('e2e-auth', async (fromPeerId, msg) => {
  const sid = currentSid(fromPeerId);
  if (!sid || !keys) return; // without a key we already allowed the connection
  const cur = entry(fromPeerId);
  if (cur?.sid === sid && (cur.state === 'verified' || cur.state === 'failed')) return; // final

  if (msg.mac === null || msg.mac === undefined) {
    // They have no room key. Could be someone who typed the room code — or someone in the middle.
    setState(fromPeerId, sid, 'unverified', { reason: "they don't have this room's secret key" });
    return;
  }

  const name = typeof msg.name === 'string' ? cleanPeerText(msg.name).trim().slice(0, 30) : '';
  const ids = await connectionIdentity(fromPeerId);
  if (currentSid(fromPeerId) !== sid) return;
  if (!ids || !name) {
    fail(fromPeerId, sid, 'its encryption details did not match');
    return;
  }
  const ok = await checkProof(keys, msg.mac, {
    roomId: keyRoomId,
    sid,
    fromId: fromPeerId,
    toId: getLocalPeerId(),
    fromFp: ids.remote,
    toFp: ids.local,
    fromName: name,
  });
  if (currentSid(fromPeerId) !== sid) return;
  if (!ok) {
    fail(fromPeerId, sid, 'its verification proof was wrong');
    return;
  }
  setState(fromPeerId, sid, 'verified');
  setVerifiedName(fromPeerId, sid, name);
  trustPeer(fromPeerId, sid); // no-op until our side of the channel is open; retried there
});

function fail(peerId: string, sid: string | null, reason: string): void {
  if (sid) setState(peerId, sid, 'failed', { reason });
  const name = peerDisplayName(peerId);
  blockedConnections.update((list) => [...list.filter((b) => b.peerId !== peerId), { peerId, name, reason }]);
  blockPeer(peerId);
}

onPeerSecurityFailure((peerId, reason) => fail(peerId, currentSid(peerId) ?? entry(peerId)?.sid ?? null, reason));

/** The user chose to let an unverified connection through ("Allow anyway"). */
export function allowUnverified(peerId: string): void {
  const sid = currentSid(peerId);
  const cur = entry(peerId);
  if (!sid || cur?.sid !== sid || cur.state !== 'unverified') return;
  setState(peerId, sid, 'allowed');
  trustPeer(peerId, sid);
}

onPeerLeft((peerId) => {
  const t = deadlines.get(peerId);
  if (t) clearTimeout(t);
  deadlines.delete(peerId);
  verification.update((m) => {
    if (!m.has(peerId) || m.get(peerId)?.state === 'failed') return m;
    const next = new Map(m);
    next.delete(peerId);
    return next;
  });
});

onRoomLeft(() => {
  for (const t of deadlines.values()) clearTimeout(t);
  deadlines.clear();
  verification.set(new Map());
  blockedConnections.set([]);
  keys = null;
  hasRoomKey.set(false);
});
