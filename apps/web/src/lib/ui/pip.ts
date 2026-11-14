// Picture-in-picture: keep seeing the call while you're in another tab or app (e.g. presenting).
//
// Document Picture-in-Picture (Chromium): the call opens in a small always-on-top window showing
// everyone (video or initial, name, muted and speaking) with mic, camera and leave buttons.
// PipView.svelte is mounted into that window's document from here, so it runs in this window's
// context: no script is loaded or run in the PiP document, nothing is fetched into it, and its
// DOM is built by Svelte with DOM APIs (peer names are text, never HTML). The app's own CSS is
// copied in as a constructed stylesheet; CSP doesn't restrict CSSOM, so this needs no change to
// the Content-Security-Policy whether or not the PiP document inherits it.
//
// Elsewhere (Safari, Chromium on Android): standard picture-in-picture on one video, picked by
// pip-target.ts (shared screen, else the active speaker, else the first remote video). It plays
// in a hidden, muted video element of our own that exists only from the click until PiP closes,
// so the picture can follow the conversation without another click, and nothing extra plays the
// rest of the time. Firefox has neither API: the button is hidden.
//
// Both only ever show streams from connections that passed the trust gate, and close when the
// call ends (leave, removed, replaced). Closing the PiP window leaves the call untouched.

import { derived, get, writable, type Readable } from 'svelte/store';
import { peers, sharingPeers, speakingPeers, peerMediaState, onRoomLeft } from '../webrtc/mesh.js';
import { nextActiveSpeaker, pickPipPeer, type PipCandidate } from './pip-target.js';
import PipView from './PipView.svelte';

export type PipMode = 'document' | 'video';

export interface PipOptions {
  displayName: string;
  chatOnly: boolean;
  /** The main controls' handlers, so PiP does exactly what they do. */
  onToggleAudio: () => void;
  onToggleVideo: () => void;
  onLeave: () => void;
}

interface DocumentPipApi {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
}

function documentPipApi(): DocumentPipApi | null {
  if (typeof window === 'undefined') return null;
  const api = (window as unknown as { documentPictureInPicture?: DocumentPipApi }).documentPictureInPicture;
  return api && typeof api.requestWindow === 'function' ? api : null;
}

function detect(): PipMode | null {
  if (typeof window === 'undefined') return null;
  if (documentPipApi()) return 'document';
  if (document.pictureInPictureEnabled && 'requestPictureInPicture' in HTMLVideoElement.prototype) return 'video';
  return null;
}

/** What this browser supports (null: no picture-in-picture, hide the button). */
export const pipMode: PipMode | null = detect();

const open = writable(false);
/** A picture-in-picture window is showing. */
export const pipOpen: Readable<boolean> = { subscribe: open.subscribe };

const hasTarget = writable(false);
/** The button does something: always for Document PiP; standard PiP needs someone's video (or is open). */
export const pipAvailable: Readable<boolean> = derived([hasTarget, open], ([t, o]) => pipMode === 'document' || t || o);

/** Bumped when the call ends, so a window still opening is closed straight away. */
let callGeneration = 0;

export function togglePip(opts: PipOptions): void {
  if (get(open)) closePip();
  else if (pipMode === 'document') void openDocumentPip(opts);
  else if (pipMode === 'video') void openVideoPip();
}

export function closePip(): void {
  if (docWindow) teardownDocumentPip();
  endVideoPip();
  open.set(false);
}

// ── Document Picture-in-Picture ─────────────────────────────────────────────

let docWindow: Window | null = null;
let docView: PipView | null = null;
let opening = false;

/** The app's CSS (all same-origin), as text. */
function appCss(): string {
  const parts: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // not readable (we never load other origins' styles)
    }
    const css = Array.from(rules, (r) => r.cssText).join('\n');
    const media = sheet.media?.mediaText;
    parts.push(media && media !== 'all' ? `@media ${media} {\n${css}\n}` : css);
  }
  return parts.join('\n');
}

async function openDocumentPip(opts: PipOptions): Promise<void> {
  const api = documentPipApi();
  if (!api || opening || docWindow) return;
  opening = true;
  const generation = callGeneration;
  const people = get(peers).size + 1;
  const rows = people <= 1 ? 1 : Math.ceil(people / 2);
  let win: Window;
  try {
    // Must be the first thing awaited: it needs the click's user activation.
    win = await api.requestWindow({ width: 360, height: Math.min(560, Math.max(220, 62 + rows * 110)) });
  } catch (err) {
    console.warn('Picture-in-picture is not available:', err instanceof Error ? err.message : err);
    return;
  } finally {
    opening = false;
  }
  if (generation !== callGeneration) {
    win.close(); // the call ended while the window was opening
    return;
  }
  const doc = win.document;
  doc.documentElement.lang = document.documentElement.lang || 'en';
  doc.title = 'vchat';
  try {
    const sheet = new (win as unknown as typeof globalThis).CSSStyleSheet();
    sheet.replaceSync(appCss());
    doc.adoptedStyleSheets = [sheet];
  } catch (err) {
    console.warn('Could not style the picture-in-picture window:', err);
  }
  docWindow = win;
  docView = new PipView({ target: doc.body, props: { ...opts } });
  open.set(true);
  // Closed by the user (or by us): the call carries on in the main window.
  win.addEventListener('pagehide', () => {
    if (docWindow === win) teardownDocumentPip();
  }, { once: true });
}

function teardownDocumentPip(): void {
  const win = docWindow;
  const view = docView;
  docWindow = null;
  docView = null;
  try {
    view?.$destroy();
  } catch {
    // the window is already gone
  }
  if (win && !win.closed) win.close();
  open.set(false);
}

// ── Standard (video element) picture-in-picture ─────────────────────────────

/** Our hidden video element: exists (and plays) only while standard PiP is opening or open. */
let pipVideo: HTMLVideoElement | null = null;
let target: string | null = null;
let activeSpeaker: string | null = null;
let lastSwitchAt = 0;
let switchTimer: ReturnType<typeof setTimeout> | null = null;
/** Don't swap the picture more often than this when the speaker changes. */
const SWITCH_DWELL_MS = 3000;

/** Only connections that passed the trust gate (mesh.ts sets `stream` only once trusted). */
function trustedStream(id: string): MediaStream | null {
  const pc = get(peers).get(id);
  return pc?.trusted ? pc.stream : null;
}

function candidates(): PipCandidate[] {
  const media = get(peerMediaState);
  const sharing = get(sharingPeers);
  return Array.from(get(peers).keys(), (id) => {
    const live = !!trustedStream(id)?.getVideoTracks().some((t) => t.readyState === 'live');
    const isSharing = sharing.has(id);
    return { id, sharing: isSharing, hasVideo: live && (isSharing || media.get(id)?.video !== false) };
  });
}

/** Stop standard PiP: leave it, stop playing, and drop the element and its stream. */
function endVideoPip(): void {
  const video = pipVideo;
  if (!video) return;
  pipVideo = null;
  if (document.pictureInPictureElement === video) document.exitPictureInPicture().catch(() => {});
  video.pause();
  video.srcObject = null;
  video.remove();
  open.set(false);
}

/** Show `stream` in the PiP video (while it exists), or end PiP if there's nothing to show. */
function showInPip(stream: MediaStream | null): void {
  if (!pipVideo) return;
  if (!stream) {
    endVideoPip();
    return;
  }
  if (pipVideo.srcObject !== stream) {
    pipVideo.srcObject = stream;
    pipVideo.play().catch(() => {});
  }
}

function refreshFallback(): void {
  if (switchTimer) clearTimeout(switchTimer);
  switchTimer = null;
  activeSpeaker = nextActiveSpeaker(activeSpeaker, get(speakingPeers), (id) => get(peers).has(id));
  const list = candidates();
  const wanted = pickPipPeer(list, activeSpeaker, target);
  if (wanted !== target) {
    const currentOk = list.some((c) => c.id === target && c.hasVideo);
    const wait = lastSwitchAt + SWITCH_DWELL_MS - Date.now();
    if (pipVideo && currentOk && wait > 0) {
      switchTimer = setTimeout(refreshFallback, wait);
    } else if (!pipVideo || wanted || !target || !trustedStream(target)) {
      // (While open, keep showing someone whose camera just went off rather than closing, unless they left.)
      target = wanted;
      lastSwitchAt = Date.now();
    }
  }
  hasTarget.set(!!wanted);
  showInPip(target ? trustedStream(target) : null);
}

async function openVideoPip(): Promise<void> {
  const stream = target ? trustedStream(target) : null;
  if (pipVideo || !stream) return;
  const video = document.createElement('video');
  video.muted = true; // the call's sound plays from the tiles
  video.playsInline = true;
  video.setAttribute('aria-hidden', 'true');
  video.tabIndex = -1;
  // Rendered (so it can load) but invisible, like a tile's video while the camera is off.
  Object.assign(video.style, { position: 'fixed', right: '0', bottom: '0', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' });
  video.addEventListener('enterpictureinpicture', () => {
    if (pipVideo === video) open.set(true);
  });
  video.addEventListener('leavepictureinpicture', () => {
    if (pipVideo === video) endVideoPip();
  });
  document.body.append(video);
  pipVideo = video;
  lastSwitchAt = Date.now();
  showInPip(stream);
  try {
    if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('video not ready')), 1500);
        video.addEventListener('loadedmetadata', () => (clearTimeout(t), resolve()), { once: true });
      });
    }
    if (pipVideo !== video) return; // ended while loading
    await video.requestPictureInPicture();
  } catch (err) {
    console.warn('Picture-in-picture is not available:', err instanceof Error ? err.message : err);
    if (pipVideo === video) endVideoPip();
  }
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  if (pipMode === 'video') {
    peers.subscribe(refreshFallback);
    sharingPeers.subscribe(refreshFallback);
    speakingPeers.subscribe(refreshFallback);
    peerMediaState.subscribe(refreshFallback);
  }
  // Leave, removed by the host, replaced by another tab, or the page going away: all end here.
  onRoomLeft(() => {
    callGeneration++;
    closePip();
    if (switchTimer) clearTimeout(switchTimer);
    switchTimer = null;
    target = null;
    activeSpeaker = null;
  });
}
