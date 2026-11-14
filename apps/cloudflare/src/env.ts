import type { ServerEnv } from '@vchat/signaling-server/core';
import type { SignalingRoom } from './room.ts';

export interface Env extends ServerEnv {
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace<SignalingRoom>;
  /** Optional comma-separated list of allowed origins. Defaults to same-origin only. */
  ALLOWED_ORIGIN?: string;
  /** Set to "1" to log room activity (off by default: vchat keeps no logs). */
  DEBUG_LOGS?: string;
}

/** Header the Worker sets on requests it forwards to a Durable Object (any client value is overwritten). */
export const CLIENT_HEADER = 'X-Vchat-Client';

/**
 * Header the Worker sets on WebSocket upgrades it forwards to a room's Durable Object: the role of
 * the (already verified) token — 'host', 'guest' or 'open'. Any client value is overwritten.
 */
export const ROLE_HEADER = 'X-Vchat-Role';

/**
 * Owner sign-in endpoints. The Worker hands them all to one Durable Object (AUTH_OBJECT), so their
 * throttles, per-challenge try limits and one-time use hold globally instead of per isolate.
 */
export const AUTH_PATHS: ReadonlySet<string> = new Set(['/api/admin/login', '/api/admin/login/code', '/api/admin/login/verify']);

/** Name of the sign-in Durable Object. Can't collide with a room: room ids are [a-z0-9]{1,20}. */
export const AUTH_OBJECT = '__auth';

/**
 * Internal Durable Object path for POST /api/invite/check: the code is checked inside the room's
 * object, against the same password-guess throttle as joining. Only the Worker can reach it (it
 * forwards /ws requests with their own path).
 */
export const INVITE_CHECK_PATH = '/internal/invite-check';
