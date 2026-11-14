// Recovering a direct connection that dropped (ICE "disconnected"): a Wi-Fi to mobile switch, a VPN
// coming up, a laptop changing networks.
//
// The fast way back is an ICE restart: new ICE credentials and candidates on the *same*
// RTCPeerConnection. The DTLS session survives it, so there's no new handshake, no new end-to-end
// verification and no new keyframe wait; media resumes in about a second. Rebuilding the connection
// from scratch (new session, handshake, verification) stays as the fallback.
//
// Only the side that made the original offer (the initiator) can start a restart: it calls
// restartIce() and makes a new offer. The other side asks it to (a `renegotiate` signal) if nothing
// has happened a moment later. Both sides must run a version that accepts the new ICE credentials
// (`caps.iceRestart`, sent once a connection is trusted): an older version treats changed
// credentials as tampering and blocks the connection, so with it we rebuild as before.
//
// Why accepting a new ICE ufrag is safe: what anchors the encryption, and what the end-to-end proof
// covers (e2e-proof.ts), is the DTLS certificate fingerprint, and that stays pinned: a description
// with a different fingerprint is still refused. ICE credentials aren't secret from the signaling
// server anyway (they travel in the session descriptions it relays), so a server could already
// point ICE at itself with the first offer; that only ever lets it relay packets it can't read.
// An ICE restart can't change the DTLS session, so it gives a server nothing new.
//
// Pure (no browser objects), so it's unit-tested in ice-recovery.test.ts.

/** The initiator restarts ICE once the connection has been down this long (it often comes back on its own sooner). */
export const ICE_RESTART_AFTER_MS = 2000;
/** The other side asks the initiator to restart if the connection is still down after this long. */
export const ICE_RESTART_REQUEST_AFTER_MS = 3500;
/** Still down after this long despite restarts: rebuild the connection from scratch. */
export const ICE_REBUILD_AFTER_MS = 15_000;
/** Without ICE restarts (the other side runs an older version): rebuild after this long, as before. */
export const LEGACY_REBUILD_AFTER_MS = 5000;
/** At least this long between two restarts of one connection (a restart takes a few seconds). */
export const MIN_RESTART_GAP_MS = 5000;
/** Restarts of one connection per minute, at most. */
export const MAX_RESTARTS_PER_MIN = 4;
/** How often a connection that's down is checked on. */
export const RECOVERY_POLL_MS = 1000;
/** ICE restarts we accept from one peer per minute (each one sets ICE gathering going again). */
export const MAX_ACCEPTED_RESTARTS_PER_MIN = 6;

export interface RecoveryState {
  /** ICE is connected (or completed) again. */
  iceUp: boolean;
  /** How long it has been down. */
  downForMs: number;
  /** Both sides support ICE restarts, and this connection was established and trusted. */
  canRestart: boolean;
  /** We and they are both in the room on the signaling server, so a new offer can reach them. */
  signalingUp: boolean;
  /** We made the original offer. */
  initiator: boolean;
  /** Since our last restart (or request for one) on this connection; Infinity if none. */
  sinceLastRestartMs: number;
  /** Restarts (or requests) in the last minute. */
  restartsLastMinute: number;
}

export type RecoveryStep =
  /** It's back: stop. */
  | 'done'
  /** Check again in RECOVERY_POLL_MS. */
  | 'wait'
  /** Restart ICE (initiator), or ask the initiator to (the other side); then keep checking. */
  | 'restart'
  /** Give up on this connection and make a new one. */
  | 'rebuild';

export function recoveryStep(s: RecoveryState): RecoveryStep {
  if (s.iceUp) return 'done';
  if (!s.canRestart) return s.downForMs >= LEGACY_REBUILD_AFTER_MS ? 'rebuild' : 'wait';
  if (s.downForMs >= ICE_REBUILD_AFTER_MS) return 'rebuild';
  if (s.downForMs < (s.initiator ? ICE_RESTART_AFTER_MS : ICE_RESTART_REQUEST_AFTER_MS)) return 'wait';
  // The new offer, answer and candidates all go through the signaling server.
  if (!s.signalingUp) return 'wait';
  if (s.sinceLastRestartMs < MIN_RESTART_GAP_MS || s.restartsLastMinute >= MAX_RESTARTS_PER_MIN) return 'wait';
  return 'restart';
}

export interface Pin {
  /** "sha-256 AB:CD:…": the remote DTLS certificate. */
  fingerprint: string;
  /** The remote ICE username fragment. */
  ufrag: string;
}

export type PinDecision =
  /** The first remote description: pin it. */
  | 'pin'
  /** Same certificate and ICE credentials (an ordinary renegotiation). */
  | 'same'
  /** Same certificate, new ICE credentials, on a connection that was established: an ICE restart. */
  | 'restart'
  /** A different certificate (never acceptable), or new ICE credentials before the connection was ever up. */
  | 'reject';

/** Check a remote description's identity against what's pinned for the connection. */
export function pinDecision(pinned: Pin | null, next: Pin, established: boolean): PinDecision {
  if (!pinned) return 'pin';
  if (pinned.fingerprint !== next.fingerprint) return 'reject';
  if (pinned.ufrag === next.ufrag) return 'same';
  return established ? 'restart' : 'reject';
}
