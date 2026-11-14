// End-to-end verification of every peer-to-peer connection.
//
// WebRTC encrypts media and data between browsers (DTLS-SRTP), but the DTLS fingerprints that
// anchor that encryption travel through the signaling server — so a compromised server could try
// to sit in the middle. To rule that out, each room has a secret key that lives only in the invite
// link's "#fragment" (browsers don't send that part of a link to servers; the one exception is an
// emailed invite the owner chooses to include the key in, which passes through the server).
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
// produce proofs that match what each side sees. A 12-digit safety code per connection also lets
// people confirm out loud that nobody (not even another key holder) is in the middle. Its inputs
// include a nonce from each side, committed to in the proof message (`commit`) and revealed in a
// separate `e2e-reveal` only once the other side's commitment has arrived, so a key holder in the
// middle can't steer the two codes into agreeing (see e2e-proof.ts).

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
  SafetyCodeExchange,
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
  /**
   * Why there's no safety code for a verified connection: 'outdated' = they're on an older version
   * of the app, which doesn't take part in the safety-code exchange (they need to reload).
   */
  codeNote?: 'outdated';
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

// ── Safety-code exchange ─────────────────────────────────────────────────────

/** The commit-then-reveal exchange for each peer's current connection session. */
const exchanges = new Map<string, { sid: string; ex: SafetyCodeExchange; codeDone: boolean }>();

function exchangeFor(peerId: string, sid: string) {
  let rec = exchanges.get(peerId);
  if (!rec || rec.sid !== sid) {
    rec = { sid, ex: new SafetyCodeExchange(), codeDone: false };
    exchanges.set(peerId, rec);
  }
  return rec;
}

/** Send our nonce if (and only if) both commitments are out; then try to finish the code. */
function maybeReveal(peerId: string, sid: string): void {
  const rec = exchanges.get(peerId);
  if (!rec || rec.sid !== sid) return;
  const nonce = rec.ex.reveal();
  if (nonce) sendVerification(peerId, sid, { type: 'e2e-reveal', nonce });
  void maybeFinishCode(peerId, sid);
}

/** Both nonces known: work out the code (once) for this session and show it. */
async function maybeFinishCode(peerId: string, sid: string): Promise<void> {
  const rec = exchanges.get(peerId);
  if (!keys || !rec || rec.sid !== sid || rec.codeDone || !rec.ex.complete) return;
  rec.codeDone = true;
  const ids = await connectionIdentity(peerId);
  if (!ids || currentSid(peerId) !== sid || exchanges.get(peerId) !== rec) return;
  const code = await safetyCode(keys, keyRoomId, sid, { fp: ids.local, nonce: rec.ex.nonce }, { fp: ids.remote, nonce: rec.ex.theirNonce! });
  const cur = entry(peerId);
  if (currentSid(peerId) !== sid || cur?.sid !== sid) return;
  setEntry(peerId, { ...cur, code });
}

// ── Protocol ───────────────────────────────────────────────────────────────────

/**
 * Peers who proved the room key at some point in this call. Their tab keeps the key for as long as
 * it keeps their peer id, so a later connection from the same id claiming to have no key isn't
 * them: it's someone in the middle trying to get "Allow anyway" clicked.
 */
const verifiedThisCall = new Set<string>();

onPeerCreated((peerId, sid) => {
  const prev = deadlines.get(peerId);
  if (prev) clearTimeout(prev);
  exchanges.delete(peerId); // a new connection starts a new exchange
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
  if (cur?.sid === sid) setEntry(peerId, { ...cur, sid });
  else setEntry(peerId, { sid, state: 'pending' });

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
  // Prove the name in exactly the form the other side will check it in (it cleans what it receives
  // the same way), so a name with characters that get stripped still verifies.
  const name = cleanPeerText(getLocalDisplayName()).trim().slice(0, 30);
  const mac = await createProof(keys, {
    roomId: keyRoomId,
    sid,
    fromId: getLocalPeerId(),
    toId: peerId,
    fromFp: ids.local,
    toFp: ids.remote,
    fromName: name,
  });
  const rec = exchangeFor(peerId, sid);
  const commit = await rec.ex.commit;
  if (currentSid(peerId) !== sid || exchanges.get(peerId) !== rec) return;
  sendVerification(peerId, sid, { type: 'e2e-auth', mac, name, commit });
  rec.ex.committed();
  // Their proof (and commitment) may have arrived first.
  maybeReveal(peerId, sid);
  if (entry(peerId)?.state === 'verified') trustPeer(peerId, sid);
});

registerDataHandler('e2e-auth', async (fromPeerId, msg) => {
  const sid = currentSid(fromPeerId);
  if (!sid || !keys) return; // without a key we already allowed the connection
  const hasProof = msg.mac !== null && msg.mac !== undefined;
  if (hasProof && msg.commit !== undefined) {
    // Recorded before anything is awaited, so their reveal (right behind it on the ordered channel)
    // finds it. Only the first commitment for a session counts; a different one is tampering.
    const rec = exchangeFor(fromPeerId, sid);
    if (rec.ex.receiveCommit(msg.commit) === 'conflict') {
      fail(fromPeerId, sid, 'it changed its safety-code commitment');
      return;
    }
    maybeReveal(fromPeerId, sid);
  }
  const cur = entry(fromPeerId);
  if (cur?.sid === sid && (cur.state === 'verified' || cur.state === 'failed')) return; // final

  if (msg.mac === null || msg.mac === undefined) {
    if (verifiedThisCall.has(fromPeerId)) {
      fail(fromPeerId, sid, 'it proved the room key earlier in this call and now says it has none');
      return;
    }
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
  verifiedThisCall.add(fromPeerId);
  // An older version of the app sends no commitment and so can't share a safety code with us. (We
  // never fall back to the old, fingerprint-only code: someone in the middle could strip the
  // commitments to force it.)
  if (!exchanges.get(fromPeerId)?.ex.hasTheirCommit) {
    const now = entry(fromPeerId);
    if (now?.sid === sid) setEntry(fromPeerId, { ...now, codeNote: 'outdated' });
  }
  setVerifiedName(fromPeerId, sid, name);
  trustPeer(fromPeerId, sid); // no-op until our side of the channel is open; retried there
});

registerDataHandler('e2e-reveal', async (fromPeerId, msg) => {
  const sid = currentSid(fromPeerId);
  if (!sid || !keys) return;
  const rec = exchanges.get(fromPeerId);
  // A nonce must follow a commitment on the same (ordered) channel.
  const result = rec && rec.sid === sid ? await rec.ex.receiveReveal(msg.nonce) : 'early';
  if (currentSid(fromPeerId) !== sid) return;
  if (result === 'bad' || result === 'early') {
    fail(fromPeerId, sid, "its safety-code exchange didn't add up");
    return;
  }
  if (result === 'ok') void maybeFinishCode(fromPeerId, sid);
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
  exchanges.delete(peerId);
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
  exchanges.clear();
  verifiedThisCall.clear();
  verification.set(new Map());
  blockedConnections.set([]);
  keys = null;
  hasRoomKey.set(false);
});
