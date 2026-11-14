// Keep the screen on during a call (Screen Wake Lock API), where the browser supports it.
// The browser drops the lock whenever the page is hidden, so it's asked for again when the page
// becomes visible. Failures (battery saver, unsupported) are ignored: it's only a convenience.

interface Sentinel {
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}

export interface WakeLockEnv {
  wakeLock?: { request(type: 'screen'): Promise<Sentinel> };
  document: {
    visibilityState: string;
    addEventListener(type: 'visibilitychange', listener: () => void): void;
    removeEventListener(type: 'visibilitychange', listener: () => void): void;
  };
}

export interface ScreenWakeLock {
  /** Keep the screen on until disable(). Safe to call more than once. */
  enable(): Promise<void>;
  /** Let the screen sleep again (leaving, removed, errors). Safe to call more than once. */
  disable(): void;
  readonly active: boolean;
}

function browserEnv(): WakeLockEnv | null {
  if (typeof navigator === 'undefined' || typeof document === 'undefined') return null;
  return { wakeLock: 'wakeLock' in navigator ? navigator.wakeLock : undefined, document };
}

export function createWakeLock(getEnv: () => WakeLockEnv | null = browserEnv): ScreenWakeLock {
  let env: WakeLockEnv | null = null;
  let wanted = false;
  let sentinel: Sentinel | null = null;
  let requesting = false;

  async function acquire(): Promise<void> {
    if (!wanted || sentinel || requesting || !env?.wakeLock || env.document.visibilityState !== 'visible') return;
    requesting = true;
    try {
      const lock = await env.wakeLock.request('screen');
      if (!wanted) {
        lock.release().catch(() => {});
        return;
      }
      sentinel = lock;
      lock.addEventListener('release', () => {
        if (sentinel === lock) sentinel = null;
      });
    } catch {
      // Not allowed right now (hidden page, battery saver, policy): carry on without it.
    } finally {
      requesting = false;
    }
  }

  function onVisibilityChange(): void {
    if (env?.document.visibilityState === 'visible') void acquire();
  }

  return {
    async enable() {
      if (wanted) return;
      env = env ?? getEnv();
      if (!env) return;
      wanted = true;
      env.document.addEventListener('visibilitychange', onVisibilityChange);
      await acquire();
    },
    disable() {
      if (!wanted) return;
      wanted = false;
      env?.document.removeEventListener('visibilitychange', onVisibilityChange);
      const lock = sentinel;
      sentinel = null;
      lock?.release().catch(() => {});
    },
    get active() {
      return sentinel !== null;
    },
  };
}
