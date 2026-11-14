// The microphone, camera and speaker you last picked, remembered for next time (localStorage).
// Only browser device ids are kept: opaque strings that are specific to this site, which the
// browser itself already remembers for it. They are reset when you clear the site's data.

const KEY = 'vchat_devices';

export interface DevicePrefs {
  audioInput: string;
  videoInput: string;
  audioOutput: string;
}

const EMPTY: DevicePrefs = { audioInput: '', videoInput: '', audioOutput: '' };

/** Device ids are opaque printable strings; anything else (or anything huge) is ignored. */
export function cleanDeviceId(value: unknown): string {
  return typeof value === 'string' && /^[\x21-\x7e]{1,256}$/.test(value) ? value : '';
}

export function parseDevicePrefs(raw: string | null | undefined): DevicePrefs {
  if (!raw) return { ...EMPTY };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...EMPTY };
    const p = parsed as Record<string, unknown>;
    return {
      audioInput: cleanDeviceId(p.audioInput),
      videoInput: cleanDeviceId(p.videoInput),
      audioOutput: cleanDeviceId(p.audioOutput),
    };
  } catch {
    return { ...EMPTY };
  }
}

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function local(): KeyValueStore | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function loadDevicePrefs(store: KeyValueStore | null = local()): DevicePrefs {
  try {
    return parseDevicePrefs(store?.getItem(KEY));
  } catch {
    return { ...EMPTY };
  }
}

/** Remember a device the user picked ('' forgets it). */
export function rememberDevice(kind: keyof DevicePrefs, deviceId: string, store: KeyValueStore | null = local()): void {
  if (!store) return;
  const prefs = { ...loadDevicePrefs(store), [kind]: cleanDeviceId(deviceId) };
  try {
    if (!prefs.audioInput && !prefs.videoInput && !prefs.audioOutput) store.removeItem(KEY);
    else store.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // storage full or unavailable: just don't remember
  }
}
