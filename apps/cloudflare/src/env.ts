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
