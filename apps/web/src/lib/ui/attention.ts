// Make sure the host notices someone waiting to join, even from another tab: a short chime, a
// flashing tab title while the tab is in the background, and (opt-in) a system notification.
//
// Privacy: the chime is synthesized with WebAudio (nothing is fetched), and the notification text
// is always the same generic sentence. Operating systems keep notification history and show it
// on lock screens, so it never contains a guest's name or email address, or the room's name.

import { get, writable, type Readable } from 'svelte/store';

export const WAITING_NOTIFICATION_TITLE = 'Someone is waiting to join your call';
export const WAITING_NOTIFICATION_BODY = 'Go back to the call to let them in.';
/** At most one chime this often, however many requests arrive. */
export const CHIME_MIN_INTERVAL_MS = 5_000;
/** At most one system notification this often. */
export const NOTIFY_MIN_INTERVAL_MS = 15_000;
/** The tab title alternates between the count and the normal title this often. */
export const FLASH_INTERVAL_MS = 1_000;

/** What the controller needs from the browser (injected, so the logic is testable). */
export interface AttentionEnv {
  now(): number;
  /** The tab is hidden or doesn't have focus. */
  inBackground(): boolean;
  getTitle(): string;
  setTitle(title: string): void;
  chime(): void;
  /** Whether the user turned notifications on and the browser allows them. */
  notificationsAllowed(): boolean;
  /** Show (or replace) the generic notification. */
  notify(): void;
  /** Close it (the queue emptied or the tab is in front again). */
  clearNotification(): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export function waitingTitle(count: number, title: string): string {
  return `(${count}) Waiting to join · ${title}`;
}

export class AttentionController {
  private known = new Set<string>();
  private lastChime = -Infinity;
  private lastNotify = -Infinity;
  private flashTimer: unknown = null;
  private showingCount = false;
  /** The page's own title, from before we changed it. */
  private baseTitle: string | null = null;
  /** The title we last set (to tell our changes from the page's). */
  private shownTitle: string | null = null;

  constructor(private readonly env: AttentionEnv) {}

  get count(): number {
    return this.known.size;
  }

  /** The waiting queue changed: the peer ids of everyone waiting now. */
  update(waitingIds: readonly string[]): void {
    const arrived = waitingIds.some((id) => !this.known.has(id));
    this.known = new Set(waitingIds);
    if (arrived) {
      const now = this.env.now();
      if (now - this.lastChime >= CHIME_MIN_INTERVAL_MS) {
        this.lastChime = now;
        this.env.chime();
      }
      if (this.env.inBackground() && this.env.notificationsAllowed() && now - this.lastNotify >= NOTIFY_MIN_INTERVAL_MS) {
        this.lastNotify = now;
        this.env.notify();
      }
    }
    if (this.count === 0) this.env.clearNotification();
    this.refresh();
  }

  /** The tab was shown, hidden, focused or blurred. */
  visibilityChanged(): void {
    if (!this.env.inBackground()) this.env.clearNotification();
    this.refresh();
  }

  destroy(): void {
    this.known.clear();
    this.stopFlashing();
    this.env.clearNotification();
  }

  private refresh(): void {
    if (this.count === 0 || !this.env.inBackground()) {
      this.stopFlashing();
    } else if (this.flashTimer === null) {
      this.showingCount = false;
      this.flash();
      this.flashTimer = this.env.setInterval(() => this.flash(), FLASH_INTERVAL_MS);
    } else if (this.showingCount) {
      this.show(waitingTitle(this.count, this.base())); // the count changed
    }
  }

  private flash(): void {
    this.showingCount = !this.showingCount;
    const base = this.base();
    this.show(this.showingCount ? waitingTitle(this.count, base) : base);
  }

  /** The page's title. If the page changed it while we were flashing, that's the new one. */
  private base(): string {
    const current = this.env.getTitle();
    if (this.baseTitle === null || current !== this.shownTitle) this.baseTitle = current;
    return this.baseTitle;
  }

  private show(title: string): void {
    this.shownTitle = title;
    this.env.setTitle(title);
  }

  private stopFlashing(): void {
    if (this.flashTimer !== null) this.env.clearInterval(this.flashTimer);
    this.flashTimer = null;
    this.showingCount = false;
    if (this.baseTitle !== null && this.env.getTitle() === this.shownTitle) this.env.setTitle(this.baseTitle);
    this.baseTitle = null;
    this.shownTitle = null;
  }
}

// ── Browser glue ──────────────────────────────────────────────────────────────

/** A preference, not a secret: whether the host asked for system notifications. */
const PREF_KEY = 'vchat_waiting_alerts';

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window && window.isSecureContext;
}

function permission(): NotificationPermission | 'unsupported' {
  return notificationsSupported() ? Notification.permission : 'unsupported';
}

function readPref(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) === '1' && permission() === 'granted';
  } catch {
    return false;
  }
}

function writePref(on: boolean): void {
  try {
    if (on) localStorage.setItem(PREF_KEY, '1');
    else localStorage.removeItem(PREF_KEY);
  } catch {
    // storage unavailable: the choice lasts for this page only
  }
}

/** Whether system notifications are on (asked for by the host and allowed by the browser). */
export const waitingAlertsEnabled = writable<boolean>(typeof window === 'undefined' ? false : readPref());

/**
 * Turn system notifications on. Call this only from a click: it may show the browser's permission
 * prompt, which is never shown on its own. Also unlocks the chime's audio while we have a gesture.
 */
export async function enableWaitingAlerts(): Promise<'on' | 'denied' | 'unsupported'> {
  unlockAudio();
  if (!notificationsSupported()) return 'unsupported';
  let result: NotificationPermission = Notification.permission;
  if (result === 'default') {
    try {
      result = (await Notification.requestPermission()) ?? Notification.permission;
    } catch {
      result = Notification.permission;
    }
  }
  const on = result === 'granted';
  writePref(on);
  waitingAlertsEnabled.set(on);
  return on ? 'on' : 'denied';
}

export function disableWaitingAlerts(): void {
  writePref(false);
  waitingAlertsEnabled.set(false);
}

let audio: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (audio) return audio;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    audio = new Ctor();
  } catch {
    audio = null;
  }
  return audio;
}

/** Create/resume the audio context during a user gesture, so later chimes can play. */
export function unlockAudio(): void {
  if (typeof window === 'undefined') return;
  audioContext()?.resume().catch(() => {});
}

/** Two short sine tones (A5, E6), quiet, about half a second. */
function playChime(): void {
  const ctx = audioContext();
  if (!ctx) return;
  try {
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const t0 = ctx.currentTime + 0.02;
    [880, 1318.5].forEach((frequency, i) => {
      const start = t0 + i * 0.16;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.12, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.3);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.32);
    });
  } catch {
    // audio unavailable: the title and notification still work
  }
}

function showNotification(): Notification | null {
  try {
    // Generic on purpose (see top of file). No icon: nothing is fetched.
    const n = new Notification(WAITING_NOTIFICATION_TITLE, { body: WAITING_NOTIFICATION_BODY, tag: 'vchat-waiting' });
    n.onclick = () => {
      window.focus();
      n.close();
    };
    return n;
  } catch {
    return null; // e.g. mobile browsers that only allow notifications from a service worker
  }
}

/**
 * Watch the host's admission queue and get their attention when someone new is waiting.
 * Returns a function that stops watching and restores the title.
 */
export function startWaitingAlerts(requests: Readable<readonly { peerId: string }[]>): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  let notification: Notification | null = null;
  const controller = new AttentionController({
    now: () => Date.now(),
    inBackground: () => document.visibilityState !== 'visible' || !document.hasFocus(),
    getTitle: () => document.title,
    setTitle: (title) => {
      document.title = title;
    },
    chime: playChime,
    notificationsAllowed: () => get(waitingAlertsEnabled) && permission() === 'granted',
    notify: () => {
      notification?.close();
      notification = showNotification();
    },
    clearNotification: () => {
      notification?.close();
      notification = null;
    },
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (handle) => window.clearInterval(handle as number),
  });
  const onChange = () => controller.visibilityChanged();
  document.addEventListener('visibilitychange', onChange);
  window.addEventListener('focus', onChange);
  window.addEventListener('blur', onChange);
  const unsubscribe = requests.subscribe((list) => controller.update(list.map((r) => r.peerId)));
  return () => {
    unsubscribe();
    document.removeEventListener('visibilitychange', onChange);
    window.removeEventListener('focus', onChange);
    window.removeEventListener('blur', onChange);
    controller.destroy();
    audio?.close().catch(() => {});
    audio = null;
  };
}
