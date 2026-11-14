import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkProof,
  createProof,
  generateRoomKey,
  importRoomKey,
  isValidRoomKey,
  readSdpIdentity,
  SafetyCodeExchange,
  safetyCode,
  deriveCode,
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

/** A random SHA-256 fingerprint, as a certificate made in advance would have. */
function randomFp(): string {
  return `sha-256 ${Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':')}`;
}

/** Run the exchange between two sides by the rules: both commit, then both reveal. */
async function exchange(x: SafetyCodeExchange, y: SafetyCodeExchange): Promise<void> {
  x.committed();
  y.committed();
  assert.equal(x.receiveCommit(await y.commit), 'ok');
  assert.equal(y.receiveCommit(await x.commit), 'ok');
  const nx = x.reveal();
  const ny = y.reveal();
  assert.ok(nx && ny);
  assert.equal(await y.receiveReveal(nx), 'ok');
  assert.equal(await x.receiveReveal(ny), 'ok');
}

test('safety codes match on both ends of a direct connection, and differ per connection', async () => {
  const keys = await importRoomKey(generateRoomKey());
  const alice = new SafetyCodeExchange();
  const bob = new SafetyCodeExchange();
  await exchange(alice, bob);
  assert.ok(alice.complete && bob.complete);
  const aliceCode = await safetyCode(keys, 'room1', 'sid1', { fp: FP_ALICE, nonce: alice.nonce }, { fp: FP_BOB, nonce: alice.theirNonce! });
  const bobCode = await safetyCode(keys, 'room1', 'sid1', { fp: FP_BOB, nonce: bob.nonce }, { fp: FP_ALICE, nonce: bob.theirNonce! });
  assert.equal(aliceCode, bobCode);
  assert.match(aliceCode, /^\d{3} \d{3} \d{3} \d{3}$/);

  // The next connection between the same two people gets fresh nonces, so a fresh code.
  const alice2 = new SafetyCodeExchange();
  const bob2 = new SafetyCodeExchange();
  await exchange(alice2, bob2);
  const again = await safetyCode(keys, 'room1', 'sid1', { fp: FP_ALICE, nonce: alice2.nonce }, { fp: FP_BOB, nonce: alice2.theirNonce! });
  assert.notEqual(again, aliceCode);
  // Room, session and fingerprints all count.
  const share = (fp: string, nonce: string) => ({ fp, nonce });
  const base = [share(FP_ALICE, alice.nonce), share(FP_BOB, bob.nonce)] as const;
  const variants = await Promise.all([
    safetyCode(keys, 'room2', 'sid1', ...base),
    safetyCode(keys, 'room1', 'sid2', ...base),
    safetyCode(keys, 'room1', 'sid1', share(FP_M1, alice.nonce), base[1]),
  ]);
  for (const v of variants) assert.notEqual(v, aliceCode);
});

test('safety codes: a nonce is never revealed before both commitments are out, and only once', async () => {
  const a = new SafetyCodeExchange();
  const b = new SafetyCodeExchange();
  assert.equal(a.reveal(), null); // nothing committed yet
  assert.equal(a.receiveCommit(await b.commit), 'ok');
  assert.equal(a.reveal(), null); // ours isn't out yet
  a.committed();
  assert.equal(a.reveal(), a.nonce);
  assert.equal(a.reveal(), null); // only once

  const c = new SafetyCodeExchange();
  c.committed();
  assert.equal(c.reveal(), null); // theirs hasn't arrived
});

test('safety codes: commitments and reveals that break the rules are refused', async () => {
  const honest = new SafetyCodeExchange();
  const other = new SafetyCodeExchange();
  // A nonce before any commitment.
  assert.equal(await honest.receiveReveal(other.nonce), 'early');
  // Malformed commitments are ignored; a second, different one is a conflict.
  for (const bad of [undefined, null, 42, '', 'x'.repeat(43) + '=', 'short']) assert.equal(honest.receiveCommit(bad), 'malformed');
  assert.equal(honest.hasTheirCommit, false);
  assert.equal(honest.receiveCommit(await other.commit), 'ok');
  assert.equal(honest.receiveCommit(await other.commit), 'ok'); // the same one again is fine
  assert.equal(honest.receiveCommit(await new SafetyCodeExchange().commit), 'conflict');

  // A nonce that doesn't open the commitment (a different one chosen after seeing ours) is refused,
  // and so is anything after it.
  const swapped = new SafetyCodeExchange();
  assert.equal(await honest.receiveReveal(swapped.nonce), 'bad');
  assert.equal(await honest.receiveReveal(other.nonce), 'bad');
  assert.equal(honest.theirNonce, null);

  const fresh = new SafetyCodeExchange();
  const peer = new SafetyCodeExchange();
  fresh.receiveCommit(await peer.commit);
  for (const garbage of [12, 'not base64!', 'A'.repeat(42), 'A'.repeat(44)]) assert.equal(await new SafetyCodeExchange().receiveReveal(garbage), 'bad');
  assert.equal(await fresh.receiveReveal(peer.nonce), 'ok');
  assert.equal(await fresh.receiveReveal(peer.nonce), 'repeat');
  assert.equal(await fresh.receiveReveal(new SafetyCodeExchange().nonce), 'bad');
  assert.equal(fresh.theirNonce, peer.nonce);
  assert.throws(() => new SafetyCodeExchange(new Uint8Array(16)));
});

test('safety codes: a key holder in the middle can no longer steer the two codes into agreeing', async () => {
  // Tiny 2-digit codes, so the attacker's odds can be measured: 1 in 100 by chance.
  const DIGITS = 2;
  const keys = await importRoomKey(generateRoomKey()); // the attacker has the room key too
  const table = Array.from({ length: 40 }, randomFp); // certificates it made in advance

  // The old scheme (code from the fingerprints alone): choosing its two certificates after seeing
  // both real fingerprints, the attacker finds a pair whose codes agree almost every time.
  const legacy = (x: string, y: string) => deriveCode(keys, ['legacy', 'room1', ...[x, y].sort()], DIGITS);
  let legacyWins = 0;
  for (let t = 0; t < 10; t++) {
    const fpA = randomFp();
    const fpB = randomFp();
    const towardAlice = new Set<string>();
    for (const m of table) towardAlice.add(await legacy(fpA, m));
    for (const m of table) {
      if (towardAlice.has(await legacy(m, fpB))) {
        legacyWins++;
        break;
      }
    }
  }
  assert.ok(legacyWins >= 9, `birthday search won ${legacyWins}/10`);

  // Now: on each leg the attacker must commit to its nonce before the honest side reveals its own,
  // so whatever certificates and nonces it picks, the two codes are independent random numbers.
  let wins = 0;
  const TRIALS = 300;
  for (let t = 0; t < TRIALS; t++) {
    const alice = new SafetyCodeExchange();
    const bob = new SafetyCodeExchange();
    const towardAlice = new SafetyCodeExchange();
    const towardBob = new SafetyCodeExchange();
    await exchange(alice, towardAlice);
    await exchange(towardBob, bob);
    const fpA = randomFp();
    const fpB = randomFp();
    const fpM1 = table[t % table.length];
    const fpM2 = table[(t * 7 + 3) % table.length];
    // The attacker even gives both legs the same session id.
    const aliceSees = await safetyCode(keys, 'room1', 'sid', { fp: fpA, nonce: alice.nonce }, { fp: fpM1, nonce: alice.theirNonce! }, DIGITS);
    const bobSees = await safetyCode(keys, 'room1', 'sid', { fp: fpB, nonce: bob.nonce }, { fp: fpM2, nonce: bob.theirNonce! }, DIGITS);
    if (aliceSees === bobSees) wins++;
  }
  // About 3 in 300 expected by chance; the birthday search above won nearly every time.
  assert.ok(wins < 15, `${wins}/${TRIALS} codes agreed`);
});
