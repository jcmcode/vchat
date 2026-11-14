import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkProof,
  createProof,
  generateRoomKey,
  importRoomKey,
  isValidRoomKey,
  readSdpIdentity,
  safetyCode,
  sdpFingerprint,
  type ProofContext,
} from './e2e-proof.js';

const hex = (b: string) => Array.from({ length: 32 }, () => b).join(':');
const FP_ALICE = `sha-256 ${hex('AA')}`;
const FP_BOB = `sha-256 ${hex('BB')}`;
const FP_M1 = `sha-256 ${hex('11')}`;
const FP_M2 = `sha-256 ${hex('22')}`;

function sdp(opts: { fps?: string[]; sessionFp?: string; sLine?: string; bundle?: string; ufrags?: string[]; rejected?: boolean } = {}): string {
  const fps = opts.fps ?? [FP_BOB.split(' ')[1], FP_BOB.split(' ')[1]];
  const ufrags = opts.ufrags ?? ['abcd', 'abcd'];
  const lines = ['v=0', 'o=- 1 2 IN IP4 127.0.0.1', `s=${opts.sLine ?? '-'}`, 't=0 0', `a=group:BUNDLE ${opts.bundle ?? '0 1'}`];
  if (opts.sessionFp) lines.push(`a=fingerprint:sha-256 ${opts.sessionFp}`);
  lines.push('m=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=mid:0', `a=ice-ufrag:${ufrags[0]}`, `a=fingerprint:sha-256 ${fps[0]}`);
  lines.push('m=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'a=mid:1', `a=ice-ufrag:${ufrags[1]}`, `a=fingerprint:sha-256 ${fps[1]}`);
  if (opts.rejected) lines.push('m=video 0 UDP/TLS/RTP/SAVPF 96', 'a=mid:2', 'a=ice-ufrag:zzzz');
  return lines.join('\r\n') + '\r\n';
}

const ctx = (over: Partial<ProofContext> = {}): ProofContext => ({
  roomId: 'room1',
  sid: 'sid1',
  fromId: 'alice',
  toId: 'bob',
  fromFp: FP_ALICE,
  toFp: FP_BOB,
  fromName: 'Alice',
  ...over,
});

test('room keys are 256-bit base64url and validated', () => {
  const k = generateRoomKey();
  assert.ok(isValidRoomKey(k));
  assert.notEqual(k, generateRoomKey());
  assert.equal(isValidRoomKey('short'), false);
});

test('strict SDP identity: accepts a normal bundled description', () => {
  assert.deepEqual(readSdpIdentity(sdp()), { fingerprint: FP_BOB, ufrag: 'abcd' });
  assert.ok(readSdpIdentity(sdp({ rejected: true })), 'rejected (port 0) sections are ignored');
});

test('strict SDP identity: rejects fingerprint tricks a malicious server could use', () => {
  // Real fingerprint planted at session level, attacker cert at media level (browser uses media-level).
  assert.equal(readSdpIdentity(sdp({ sessionFp: hex('BB'), fps: [hex('11'), hex('11')] })), null);
  // Real fingerprint hidden in free text.
  assert.equal(readSdpIdentity(sdp({ sLine: `a=fingerprint:sha-256 ${hex('BB')}`, fps: [hex('11'), hex('11')] })), null);
  // Different fingerprints per section.
  assert.equal(readSdpIdentity(sdp({ fps: [hex('BB'), hex('11')] })), null);
  // Media not bundled onto one transport (separate DTLS for the data channel).
  assert.equal(readSdpIdentity(sdp({ bundle: '0' })), null);
  // Different ICE credentials per section.
  assert.equal(readSdpIdentity(sdp({ ufrags: ['abcd', 'efgh'] })), null);
  // Not SHA-256 / malformed.
  assert.equal(readSdpIdentity(sdp().replace(/sha-256/g, 'sha-1')), null);
  assert.equal(readSdpIdentity('garbage'), null);
});

test('own fingerprint is read from the local SDP', () => {
  assert.equal(sdpFingerprint(sdp()), FP_BOB);
});

test('direct connection: proofs verify both ways', async () => {
  const keys = await importRoomKey(generateRoomKey());
  const fromAlice = await createProof(keys, ctx());
  const fromBob = await createProof(keys, ctx({ fromId: 'bob', toId: 'alice', fromFp: FP_BOB, toFp: FP_ALICE, fromName: 'Bob' }));
  assert.equal(await checkProof(keys, fromAlice, ctx()), true);
  assert.equal(await checkProof(keys, fromBob, ctx({ fromId: 'bob', toId: 'alice', fromFp: FP_BOB, toFp: FP_ALICE, fromName: 'Bob' })), true);
});

test('man in the middle is detected (relayed proofs, forged proofs)', async () => {
  const keys = await importRoomKey(generateRoomKey());
  // Alice sees M1 as "Bob"; Bob sees M2 as "Alice".
  const fromAlice = await createProof(keys, ctx({ toFp: FP_M1 }));
  assert.equal(await checkProof(keys, fromAlice, ctx({ fromFp: FP_M2, toFp: FP_BOB })), false);
  const otherKeys = await importRoomKey(generateRoomKey());
  const forged = await createProof(otherKeys, ctx({ fromFp: FP_M2, toFp: FP_BOB }));
  assert.equal(await checkProof(keys, forged, ctx({ fromFp: FP_M2, toFp: FP_BOB })), false);
});

test('proofs bind room, session, direction and the sender\'s name', async () => {
  const keys = await importRoomKey(generateRoomKey());
  const p = await createProof(keys, ctx());
  assert.equal(await checkProof(keys, p, ctx({ roomId: 'room2' })), false);
  assert.equal(await checkProof(keys, p, ctx({ sid: 'other' })), false);
  assert.equal(await checkProof(keys, p, ctx({ fromId: 'bob', toId: 'alice' })), false);
  assert.equal(await checkProof(keys, p, ctx({ fromName: 'Mallory' })), false, 'server relabelling a name is detected');
  assert.equal(await checkProof(keys, 'garbage!!', ctx()), false);
});

test('safety codes match for a direct connection and differ with someone in the middle', async () => {
  const keys = await importRoomKey(generateRoomKey());
  const alice = await safetyCode(keys, 'room1', FP_ALICE, FP_BOB);
  const bob = await safetyCode(keys, 'room1', FP_BOB, FP_ALICE);
  assert.equal(alice, bob);
  assert.match(alice, /^\d{3} \d{3} \d{3} \d{3}$/);
  const aliceSeesMitm = await safetyCode(keys, 'room1', FP_ALICE, FP_M1);
  const bobSeesMitm = await safetyCode(keys, 'room1', FP_BOB, FP_M2);
  assert.notEqual(aliceSeesMitm, bobSeesMitm);
});
