// Keyboard shortcuts for the call screen. Pure logic (no DOM access), unit-tested in
// shortcuts.test.ts; KeyboardShortcuts.svelte wires it to the window.
//
// Toggles use modifier combinations, like other call apps, so they can't collide with typing or
// with the whiteboard's single-key tools (P, M, T, E, H, +, -, 0, 1), which ignore any key pressed
// with Ctrl, Cmd or Alt:
//
//   Ctrl/Cmd+D                      microphone on/off
//   Ctrl/Cmd+E                      camera on/off
//   Ctrl+Alt+H  (Mac: Ctrl+Cmd+H)   raise/lower your hand
//   Ctrl+Alt+C  (Mac: Ctrl+Cmd+C)   open/close the chat
//   ?                               this list
//   Space, held                     talk while muted (off while the whiteboard is open: Space pans it)
//
// Nothing fires while focus is in a text field, select or contenteditable element.

export type ShortcutAction = 'toggle-mic' | 'toggle-camera' | 'toggle-hand' | 'toggle-chat' | 'help';

/** The parts of a KeyboardEvent the matching looks at. */
export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
}

/** Apple keyboards use Cmd where others use Ctrl (iPadOS Safari reports itself as a Mac). */
export function isMacPlatform(nav: { platform?: string; userAgentData?: { platform?: string } } | undefined): boolean {
  const platform = nav?.userAgentData?.platform || nav?.platform || '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/**
 * The letter a key stands for. The layout's own letter wins (so Dvorak and AZERTY users press the
 * letter printed on their key); when the key doesn't produce a Latin letter (Cyrillic or Greek
 * layouts, or Option on a Mac turning H into "˙"), the physical key decides.
 */
export function letterOf(e: Pick<KeyLike, 'key' | 'code'>): string | null {
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase();
  const m = /^Key([A-Z])$/.exec(e.code ?? '');
  return m ? m[1].toLowerCase() : null;
}

/**
 * Which shortcut a key press is, if any. Callers must still check `isTypingTarget` first, and
 * should call preventDefault on a match even when `repeat` is set (holding Ctrl+D must not open the
 * bookmark dialog) while only acting on the first press.
 */
export function matchShortcut(e: KeyLike, isMac: boolean): ShortcutAction | null {
  if (e.isComposing) return null;
  // "?" needs Shift (or AltGr) on most layouts, so only Cmd rules it out (Cmd+? is the Mac Help menu).
  if (e.key === '?' && !e.metaKey) return 'help';
  if (e.shiftKey) return null;
  const letter = letterOf(e);
  if (!letter) return null;
  const primary = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (primary && !e.altKey) {
    if (letter === 'd') return 'toggle-mic';
    if (letter === 'e') return 'toggle-camera';
    return null;
  }
  // Mac: Ctrl+Cmd (Ctrl+Option is VoiceOver's modifier). Elsewhere: Ctrl+Alt (Ctrl+Win belongs to the OS).
  const secondary = isMac ? e.ctrlKey && e.metaKey && !e.altKey : e.ctrlKey && e.altKey && !e.metaKey;
  if (secondary) {
    if (letter === 'h') return 'toggle-hand';
    if (letter === 'c') return 'toggle-chat';
  }
  return null;
}

/** Space with no modifiers: the hold-to-talk key. */
export function isTalkKey(e: KeyLike): boolean {
  return (e.key === ' ' || e.key === 'Spacebar') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
}

/** What `isTypingTarget` and `spaceHasNativeAction` read from an element (a DOM Element fits). */
export interface TargetLike {
  tagName?: unknown;
  isContentEditable?: unknown;
  getAttribute?: (name: string) => string | null;
  closest?: (selector: string) => unknown;
}

const TEXT_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);
const EDITABLE_SELECTOR =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"]';

function roleOf(t: TargetLike): string {
  const role = typeof t.getAttribute === 'function' ? t.getAttribute('role') : null;
  return typeof role === 'string' ? role.trim().toLowerCase() : '';
}

function closestMatch(t: TargetLike, selector: string): boolean {
  if (typeof t.closest !== 'function') return false;
  try {
    return !!t.closest(selector);
  } catch {
    return false;
  }
}

/**
 * Is focus somewhere the user types? Any input (text, password, range, checkbox… all of them, to
 * be safe), textarea, select, contenteditable element (the whiteboard's text editor included) or
 * ARIA text widget. Shortcuts never fire there.
 */
export function isTypingTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const t = target as TargetLike;
  const tag = typeof t.tagName === 'string' ? t.tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (t.isContentEditable === true) return true;
  if (TEXT_ROLES.has(roleOf(t))) return true;
  return closestMatch(t, EDITABLE_SELECTOR);
}

const SPACE_NATIVE_ROLES = new Set([
  'button',
  'checkbox',
  'switch',
  'radio',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'tab',
  'slider',
]);
const SPACE_NATIVE_SELECTOR =
  'button, a[href], summary, [role="button"], [role="checkbox"], [role="switch"], [role="radio"], [role="link"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="tab"], [role="slider"]';

/**
 * Does Space already mean something where focus is (press a button, tick a box, type a space)?
 * Then hold-to-talk stays out of the way and keyboard users keep the standard behaviour.
 */
export function spaceHasNativeAction(target: unknown): boolean {
  if (isTypingTarget(target)) return true;
  if (!target || typeof target !== 'object') return false;
  const t = target as TargetLike;
  const tag = typeof t.tagName === 'string' ? t.tagName.toUpperCase() : '';
  if (tag === 'BUTTON' || tag === 'SUMMARY' || (tag === 'A' && typeof t.getAttribute === 'function' && t.getAttribute('href') !== null)) return true;
  if (SPACE_NATIVE_ROLES.has(roleOf(t))) return true;
  return closestMatch(t, SPACE_NATIVE_SELECTOR);
}

/** How the page reads and changes the microphone (kept abstract so the logic can be tested). */
export interface MicControl {
  /** There is a microphone to use (not chat-only, a track exists). */
  available(): boolean;
  isOn(): boolean;
  setOn(on: boolean): void;
}

/**
 * Hold-to-talk: while muted, holding the key unmutes until it's released. Releasing always mutes
 * again, and so does anything that could hide the release (the page calls `release` on keyup, any
 * other key, window blur, the tab being hidden, focus moving into a text field, the whiteboard
 * opening, leaving the call). If you were already unmuted, holding the key does nothing.
 */
export class PushToTalk {
  private holding = false;

  constructor(private readonly mic: MicControl) {}

  /** True while the key is held and it was this that unmuted the microphone. */
  get active(): boolean {
    return this.holding;
  }

  /** The key went down. Returns true if it unmuted the microphone (and is now holding it open). */
  press(): boolean {
    if (this.holding) return true;
    if (!this.mic.available() || this.mic.isOn()) return false;
    this.mic.setOn(true);
    this.holding = this.mic.isOn();
    return this.holding;
  }

  /** Mute again if a hold opened the microphone. Safe to call any number of times. */
  release(): void {
    if (!this.holding) return;
    this.holding = false;
    if (this.mic.isOn()) this.mic.setOn(false);
  }
}

export interface ShortcutHelpEntry {
  keys: string[];
  label: string;
}

/** The list shown on the shortcuts sheet, spelled for this platform. */
export function shortcutList(isMac: boolean): ShortcutHelpEntry[] {
  const primary = isMac ? 'Cmd' : 'Ctrl';
  const secondary = isMac ? ['Ctrl', 'Cmd'] : ['Ctrl', 'Alt'];
  return [
    { keys: [primary, 'D'], label: 'Mute or unmute your microphone' },
    { keys: [primary, 'E'], label: 'Turn your camera on or off' },
    { keys: ['Space'], label: 'Hold to talk while muted (not while the whiteboard is open)' },
    { keys: [...secondary, 'H'], label: 'Raise or lower your hand' },
    { keys: [...secondary, 'C'], label: 'Open or close the chat' },
    { keys: ['?'], label: 'Show or hide this list' },
  ];
}
