// Pure crypto + SDP checks for end-to-end verification (no browser/WebRTC objects, so it's
// unit-testable). See e2e.ts for the protocol and mesh.ts for how connections are gated.

export const E2E_PROTOCOL = 'vchat-e2e-v2';

/** A new random room key (256 bits, base64url, 43 chars). */
export function generateRoomKey(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

export function isValidRoomKey(key: unknown): key is string {
  return typeof key === 'string' && /^[A-Za-z0-9_-]{43}$/.test(key);
}

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('not base64url');
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

export interface RoomKeys {
  /** Signs/verifies per-connection proofs. */
  auth: CryptoKey;
  /** Derives the short safety code people can compare out loud. */
  code: CryptoKey;
}

/** Derive purpose-specific keys from the room key (HKDF), so it can be reused safely later. */
export async function importRoomKey(key: string): Promise<RoomKeys> {
  const base = await crypto.subtle.importKey('raw', fromB64url(key), 'HKDF', false, ['deriveKey']);
  const derive = (info: string) =>
    crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(info) },
      base,
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      ['sign', 'verify']
    );
  return { auth: await derive(`${E2E_PROTOCOL} auth`), code: await derive(`${E2E_PROTOCOL} safety-code`) };
}

// ── SDP checks ─────────────────────────────────────────────────────────────────

const FP_LINE = /^a=fingerprint:(\S+) ([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2})+)\s*$/;

export interface SdpIdentity {
  /** "sha-256 AB:CD:…" — the one DTLS certificate fingerprint in the description. */
  fingerprint: string;
  /** ICE username fragment (all m-sections must share it under BUNDLE). */
  ufrag: string;
}

/**
 * Strictly read the DTLS identity from a session description. Rejects anything a malicious
 * server could use to make the fingerprint we verify differ from the one the browser enforces:
 * fingerprint text outside proper attribute lines, several different fingerprints, non-SHA-256,
 * or media sections that aren't all bundled onto one transport.
 */
export function readSdpIdentity(sdp: unknown): SdpIdentity | null {
  if (typeof sdp !== 'string' || sdp.length > 64 * 1024) return null;
  const lines = sdp.split(/\r?\n/);

  // Every occurrence of "fingerprint:" must be a proper, well-formed a=fingerprint line.
  const mentions = (sdp.match(/fingerprint:/gi) ?? []).length;
  const fps = new Set<string>();
  let fpLines = 0;
  for (const line of lines) {
    const m = line.match(FP_LINE);
    if (!m) continue;
    fpLines++;
    fps.add(`${m[1].toLowerCase()} ${m[2].toUpperCase()}`);
  }
  if (fpLines === 0 || fpLines !== mentions || fps.size !== 1) return null;
  const fingerprint = [...fps][0];
  if (!fingerprint.startsWith('sha-256 ') || fingerprint.split(':').length !== 32) return null;

  // One transport: every active m-section (port != 0) must be in the BUNDLE group, and they must
  // share one ICE ufrag (we also force bundlePolicy max-bundle). Rejected sections are ignored.
  const bundle = lines.find((l) => l.startsWith('a=group:BUNDLE'));
  const bundled = new Set((bundle ?? '').slice('a=group:BUNDLE'.length).trim().split(/\s+/).filter(Boolean));
  const sections: string[][] = [];
  for (const line of lines) {
    if (line.startsWith('m=')) sections.push([line]);
    else if (sections.length) sections[sections.length - 1].push(line);
  }
  const active = sections.filter((sec) => sec[0].split(' ')[1] !== '0');
  if (active.length === 0) return null;
  const ufrags = new Set<string>();
  for (const sec of active) {
    const mid = sec.find((l) => l.startsWith('a=mid:'))?.slice(6).trim();
    if (!mid || !bundled.has(mid)) return null;
    for (const l of sec) if (l.startsWith('a=ice-ufrag:')) ufrags.add(l.slice(12).trim());
  }
  for (const l of lines) {
    if (l.startsWith('m=')) break; // session-level attributes only
    if (l.startsWith('a=ice-ufrag:')) ufrags.add(l.slice(12).trim());
  }
  if (ufrags.size !== 1) return null;
  return { fingerprint, ufrag: [...ufrags][0] };
}

/** Our own SDP's fingerprint (the browser wrote it, so a looser parse is fine). */
export function sdpFingerprint(sdp: string | undefined | null): string | null {
  const m = sdp?.match(/^a=fingerprint:(\S+) ([0-9A-Fa-f:]+)\s*$/m);
  return m ? `${m[1].toLowerCase()} ${m[2].toUpperCase()}` : null;
}

// ── Proofs ─────────────────────────────────────────────────────────────────────

export interface ProofContext {
  roomId: string;
  /** Connection session id (both sides share it). */
  sid: string;
  fromId: string;
  toId: string;
  fromFp: string;
  toFp: string;
  /** The sender's own display name — authenticated, so the server can't relabel people. */
  fromName: string;
}

function transcript(c: ProofContext): Uint8Array<ArrayBuffer> {
  // JSON array: unambiguous field boundaries (no delimiter tricks).
  return new TextEncoder().encode(JSON.stringify([E2E_PROTOCOL, c.roomId, c.sid, c.fromId, c.toId, c.fromFp, c.toFp, c.fromName]));
}

export async function createProof(keys: RoomKeys, c: ProofContext): Promise<string> {
  return b64url(await crypto.subtle.sign('HMAC', keys.auth, transcript(c)));
}

/** Check a proof using the fingerprints as *we* see them (fromFp = theirs, toFp = ours). */
export async function checkProof(keys: RoomKeys, proof: unknown, c: ProofContext): Promise<boolean> {
  if (typeof proof !== 'string' || proof.length > 100) return false;
  let mac: Uint8Array<ArrayBuffer>;
  try {
    mac = fromB64url(proof);
  } catch {
    return false;
  }
  return crypto.subtle.verify('HMAC', keys.auth, mac, transcript(c));
}

// ── Safety codes: commit, then reveal ─────────────────────────────────────────
//
// A 12-digit code both people see for their connection. If it matches when read out loud, nobody
// is in the middle, not even someone who has the room key (and can therefore forge proofs).
//
// The code can't depend on the DTLS fingerprints alone. Someone in the middle sees both real
// fingerprints before choosing its own two certificates (it can make both sides start the
// connection, so both offers reach it first). It could then pick, from a table of certificates
// made in advance, the pair whose codes agree: a birthday search, about 2^20 tries per side for a
// 40-bit code, which takes seconds.
//
// So each side also contributes a random nonce, committed first and revealed only after it has
// the other side's commitment (as ZRTP does). Whoever sits in the middle must commit to its own
// nonce on each leg before it can learn the honest side's, so the two codes it ends up with are
// independent random numbers: one blind 1-in-10^12 guess per connection attempt, and every
// attempt is a visibly new connection.

export const SAFETY_CODE_DIGITS = 12;
const SAS_LABEL = 'vchat-sas-v3';
const NONCE_BYTES = 32;
/** base64url of 32 bytes: a nonce, or a SHA-256 commitment. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** SHA-256 of the label and the nonce, base64url: what a side commits to before revealing. */
export async function commitTo(nonce: Uint8Array): Promise<string> {
  const label = new TextEncoder().encode(`${SAS_LABEL} commit`);
  const data = new Uint8Array(label.length + nonce.length);
  data.set(label);
  data.set(nonce, label.length);
  return b64url(await crypto.subtle.digest('SHA-256', data));
}

export interface CodeShare {
  /** This side's DTLS fingerprint. */
  fp: string;
  /** This side's revealed nonce (base64url). */
  nonce: string;
}

/** The number a code is made of, from any transcript: `digits` decimal digits of an HMAC. */
export async function deriveCode(keys: RoomKeys, parts: string[], digits = SAFETY_CODE_DIGITS): Promise<string> {
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', keys.code, new TextEncoder().encode(JSON.stringify(parts))));
  let n = 0n;
  for (const byte of mac.subarray(0, 8)) n = (n << 8n) | BigInt(byte);
  return (n % 10n ** BigInt(digits)).toString().padStart(digits, '0');
}

/**
 * The safety code for one connection, the same on both sides when nobody is in the middle: over
 * the room, the connection's session id, and each side's fingerprint with its nonce (in a fixed
 * order, so it doesn't matter who computes it). Formatted in groups of three.
 */
export async function safetyCode(
  keys: RoomKeys,
  roomId: string,
  sid: string,
  a: CodeShare,
  b: CodeShare,
  /** Only tests use fewer, to measure an attacker's odds. */
  digits = SAFETY_CODE_DIGITS
): Promise<string> {
  const [first, second] = [a, b].sort((x, y) => (x.fp === y.fp ? (x.nonce < y.nonce ? -1 : 1) : x.fp < y.fp ? -1 : 1));
  const code = await deriveCode(keys, [SAS_LABEL, roomId, sid, first.fp, first.nonce, second.fp, second.nonce], digits);
  return code.replace(/(\d{3})(?=\d)/g, '$1 ');
}

export type RevealResult =
  /** Their nonce opens their commitment. */
  | 'ok'
  /** The same nonce again (harmless). */
  | 'repeat'
  /** A nonce before any commitment (an honest side never does this on an ordered channel). */
  | 'early'
  /** Malformed, doesn't open the commitment, or contradicts the nonce they already revealed. */
  | 'bad';

/**
 * One side of the commit-then-reveal exchange for one connection session. Pure (no WebRTC), so
 * the ordering rules are unit-tested:
 *   1. our commitment goes out with our proof (`commit`, then `committed()`);
 *   2. their commitment is recorded when their proof arrives (`receiveCommit`; only the first counts);
 *   3. our nonce is released only once both commitments are out (`reveal()` returns it exactly once);
 *   4. their nonce must open their commitment (`receiveReveal`).
 * The code can be computed once `theirNonce` is set and we have revealed.
 */
export class SafetyCodeExchange {
  /** Our nonce (base64url). Secret until `reveal()` hands it out. */
  readonly nonce: string;
  /** Our commitment to it. */
  readonly commit: Promise<string>;
  private sentCommit = false;
  private theirCommit: string | null = null;
  private revealed = false;
  private pendingNonce: string | null = null;
  private opened: string | null = null;

  constructor(random: Uint8Array = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))) {
    if (random.length !== NONCE_BYTES) throw new Error('nonce must be 32 bytes');
    this.nonce = b64url(random);
    this.commit = commitTo(random);
  }

  /** Our commitment has been sent. */
  committed(): void {
    this.sentCommit = true;
  }

  /**
   * Record their commitment. Only the first well-formed one counts: 'malformed' for anything that
   * isn't one (it's ignored), 'conflict' for one that differs from what they committed to before.
   */
  receiveCommit(commit: unknown): 'ok' | 'malformed' | 'conflict' {
    if (typeof commit !== 'string' || !TOKEN_RE.test(commit)) return 'malformed';
    if (this.theirCommit === null) this.theirCommit = commit;
    return this.theirCommit === commit ? 'ok' : 'conflict';
  }

  get hasTheirCommit(): boolean {
    return this.theirCommit !== null;
  }

  /** Our nonce, exactly once, as soon as both commitments are out; null before that (and after). */
  reveal(): string | null {
    if (!this.sentCommit || this.theirCommit === null || this.revealed) return null;
    this.revealed = true;
    return this.nonce;
  }

  get hasRevealed(): boolean {
    return this.revealed;
  }

  /** Check their nonce against their commitment. */
  async receiveReveal(nonce: unknown): Promise<RevealResult> {
    if (typeof nonce !== 'string' || !TOKEN_RE.test(nonce)) return 'bad';
    if (this.theirCommit === null) return 'early';
    if (this.pendingNonce !== null) return this.pendingNonce === nonce ? 'repeat' : 'bad';
    this.pendingNonce = nonce;
    let bytes: Uint8Array;
    try {
      bytes = fromB64url(nonce);
    } catch {
      return 'bad';
    }
    if (bytes.length !== NONCE_BYTES || (await commitTo(bytes)) !== this.theirCommit) return 'bad';
    this.opened = nonce;
    return 'ok';
  }

  /** Their nonce, once it has opened their commitment. */
  get theirNonce(): string | null {
    return this.opened;
  }

  /** Both nonces are known: the code can be computed. */
  get complete(): boolean {
    return this.revealed && this.opened !== null;
  }
}
