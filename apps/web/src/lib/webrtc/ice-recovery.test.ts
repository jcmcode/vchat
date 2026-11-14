import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ICE_REBUILD_AFTER_MS,
  ICE_RESTART_AFTER_MS,
  ICE_RESTART_REQUEST_AFTER_MS,
  LEGACY_REBUILD_AFTER_MS,
  MAX_RESTARTS_PER_MIN,
  MIN_RESTART_GAP_MS,
  pinDecision,
  recoveryStep,
  type RecoveryState,
} from './ice-recovery.js';

const down = (over: Partial<RecoveryState> = {}): RecoveryState => ({
  iceUp: false,
  downForMs: ICE_RESTART_AFTER_MS,
  canRestart: true,
  signalingUp: true,
  initiator: true,
  sinceLastRestartMs: Infinity,
  restartsLastMinute: 0,
  ...over,
});

test('recovery: back up means done, whatever else is going on', () => {
  assert.equal(recoveryStep(down({ iceUp: true, downForMs: 60_000, canRestart: false })), 'done');
});

test('recovery: the initiator restarts ICE after a short wait; the other side asks a bit later', () => {
  assert.equal(recoveryStep(down({ downForMs: ICE_RESTART_AFTER_MS - 1 })), 'wait'); // often recovers by itself
  assert.equal(recoveryStep(down({ downForMs: ICE_RESTART_AFTER_MS })), 'restart');
  assert.equal(recoveryStep(down({ initiator: false, downForMs: ICE_RESTART_AFTER_MS })), 'wait');
  assert.equal(recoveryStep(down({ initiator: false, downForMs: ICE_RESTART_REQUEST_AFTER_MS })), 'restart');
});

test('recovery: restarts wait for signaling (the new offer goes through it) and are spaced out', () => {
  assert.equal(recoveryStep(down({ signalingUp: false, downForMs: 5000 })), 'wait');
  assert.equal(recoveryStep(down({ sinceLastRestartMs: MIN_RESTART_GAP_MS - 1 })), 'wait');
  assert.equal(recoveryStep(down({ sinceLastRestartMs: MIN_RESTART_GAP_MS })), 'restart');
  assert.equal(recoveryStep(down({ restartsLastMinute: MAX_RESTARTS_PER_MIN })), 'wait');
});

test('recovery: rebuilt from scratch when restarts did not bring it back, or cannot be used', () => {
  assert.equal(recoveryStep(down({ downForMs: ICE_REBUILD_AFTER_MS })), 'rebuild');
  assert.equal(recoveryStep(down({ downForMs: ICE_REBUILD_AFTER_MS, signalingUp: false })), 'rebuild');
  // An older version on the other side: as before, rebuilt after a few seconds.
  assert.equal(recoveryStep(down({ canRestart: false, downForMs: LEGACY_REBUILD_AFTER_MS - 1 })), 'wait');
  assert.equal(recoveryStep(down({ canRestart: false, downForMs: LEGACY_REBUILD_AFTER_MS })), 'rebuild');
});

test('pin: the certificate never changes; new ICE credentials only as a restart of an established connection', () => {
  const pin = { fingerprint: 'sha-256 AA', ufrag: 'u1' };
  assert.equal(pinDecision(null, pin, false), 'pin');
  assert.equal(pinDecision(pin, { ...pin }, true), 'same');
  assert.equal(pinDecision(pin, { ...pin, ufrag: 'u2' }, true), 'restart');
  // Before the connection was ever up there's nothing to restart: changed credentials are tampering.
  assert.equal(pinDecision(pin, { ...pin, ufrag: 'u2' }, false), 'reject');
  // A different certificate is refused, restart or not.
  assert.equal(pinDecision(pin, { fingerprint: 'sha-256 BB', ufrag: 'u1' }, true), 'reject');
  assert.equal(pinDecision(pin, { fingerprint: 'sha-256 BB', ufrag: 'u2' }, true), 'reject');
});
