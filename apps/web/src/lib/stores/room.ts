import { writable } from 'svelte/store';
import { nanoid } from 'nanoid';

export const roomId = writable<string>('');
export const peerId = writable<string>(nanoid(12));
export const displayName = writable<string>('');
export const isInRoom = writable<boolean>(false);

const SIGNAL_URL_KEY = 'vchat_signal_url';
const DISPLAY_NAME_KEY = 'vchat_display_name';
const TURN_URL_KEY = 'vchat_turn_url';
const TURN_USERNAME_KEY = 'vchat_turn_username';
const TURN_CREDENTIAL_KEY = 'vchat_turn_credential';

export function getSignalServerUrl(): string {
  if (typeof window === 'undefined') return 'ws://localhost:3001';
  const saved = localStorage.getItem(SIGNAL_URL_KEY);
  if (saved) return saved;

  // Dev server: direct connection to signaling on port 3001
  if (window.location.port === '5173') {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.hostname}:3001`;
  }

  // Production: reverse-proxied through Caddy at /ws
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

export function setSignalServerUrl(url: string): void {
  if (typeof window !== 'undefined') {
    localStorage.setItem(SIGNAL_URL_KEY, url);
  }
}

export function getSavedDisplayName(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(DISPLAY_NAME_KEY) ?? '';
}

export function saveDisplayName(name: string): void {
  if (typeof window !== 'undefined') {
    localStorage.setItem(DISPLAY_NAME_KEY, name);
  }
}

export interface TurnConfig {
  url: string;
  username: string;
  credential: string;
}

export function getTurnConfig(): TurnConfig | null {
  if (typeof window === 'undefined') return null;

  // localStorage override takes priority
  const url = localStorage.getItem(TURN_URL_KEY);
  if (url) {
    return {
      url,
      username: localStorage.getItem(TURN_USERNAME_KEY) ?? '',
      credential: localStorage.getItem(TURN_CREDENTIAL_KEY) ?? '',
    };
  }

  // Fall back to build-time defaults (set via VITE_TURN_* env vars)
  const defaultUrl = import.meta.env.VITE_TURN_URL;
  if (defaultUrl) {
    return {
      url: defaultUrl,
      username: import.meta.env.VITE_TURN_USER ?? '',
      credential: import.meta.env.VITE_TURN_CREDENTIAL ?? '',
    };
  }

  return null;
}

export function setTurnConfig(url: string, username: string, credential: string): void {
  if (typeof window === 'undefined') return;
  if (url) {
    localStorage.setItem(TURN_URL_KEY, url);
    localStorage.setItem(TURN_USERNAME_KEY, username);
    localStorage.setItem(TURN_CREDENTIAL_KEY, credential);
  } else {
    localStorage.removeItem(TURN_URL_KEY);
    localStorage.removeItem(TURN_USERNAME_KEY);
    localStorage.removeItem(TURN_CREDENTIAL_KEY);
  }
}

export function generateRoomId(): string {
  // readable room codes: 6 chars, lowercase alphanumeric
  return nanoid(6).toLowerCase();
}
