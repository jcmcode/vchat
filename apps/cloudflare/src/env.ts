import type { IceEnv } from '@vchat/signaling-server/core';
import type { SignalingRoom } from './room.ts';

export interface Env extends IceEnv {
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace<SignalingRoom>;
  /** Optional site-wide password (HTTP basic auth, username "vchat"). */
  SITE_PASSWORD?: string;
  /** Optional comma-separated list of allowed origins. Defaults to same-origin only. */
  ALLOWED_ORIGIN?: string;
}
