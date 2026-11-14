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

/**
 * A 6-digit code both people see for their connection. If it matches when read out loud,
 * nobody is in the middle — even someone who has the room key.
 */
export async function safetyCode(keys: RoomKeys, roomId: string, fpA: string, fpB: string): Promise<string> {
  const [a, b] = [fpA, fpB].sort();
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', keys.code, new TextEncoder().encode(JSON.stringify([roomId, a, b]))));
  const n = ((mac[0] << 16) | (mac[1] << 8) | mac[2]) % 1_000_000;
  return n.toString().padStart(6, '0').replace(/(\d{3})(\d{3})/, '$1 $2');
}
