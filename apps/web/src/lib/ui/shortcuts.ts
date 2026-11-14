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
// Nothing fires while focus is in a text field, select or contenteditable element, or for a
// character typed with AltGr.

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
  /** KeyboardEvent.getModifierState, to tell AltGr (a character key on many layouts) from Ctrl+Alt. */
  getModifierState?: (key: string) => boolean;
}

function altGraph(e: KeyLike): boolean {
  try {
    return typeof e.getModifierState === 'function' && e.getModifierState('AltGraph') === true;
  } catch {
    return false;
  }
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
  // AltGr types characters (Polish AltGr+C is "ć"): never a shortcut, even though it reports Ctrl+Alt.
  if (e.shiftKey || altGraph(e)) return null;
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

/** Whether a shortcut has anything to do (if not, the key is left to the browser). */
export function shortcutApplies(action: ShortcutAction, ctx: { hasMic: boolean; hasCamera: boolean }): boolean {
  if (action === 'toggle-mic') return ctx.hasMic;
  if (action === 'toggle-camera') return ctx.hasCamera;
  return true;
}

/** The Space key, with or without modifiers (letting go of it always counts). */
export function isSpaceKey(e: Pick<KeyLike, 'key'>): boolean {
  return e.key === ' ' || e.key === 'Spacebar';
}

/** Space with no modifiers: the key that starts hold-to-talk. */
export function isTalkKey(e: KeyLike): boolean {
  return isSpaceKey(e) && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
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
 * - idle: nothing held.
 * - holding: Space is held and it unmuted the microphone.
 * - waiting: a hold ended early (another key, a click, focus moving into a text field, the mic
 *   switched some other way). The mic is muted and every key press is ignored until Space is let
 *   go (or the window loses focus), so a key combination can't turn the mic straight back on.
 */
export type HoldState = 'idle' | 'holding' | 'waiting';

/** What the page does with a key event: leave it to the shortcuts, or swallow it (preventDefault, nothing else). */
export type HoldVerdict = 'pass' | 'swallow';

/**
 * Hold-to-talk: while muted, holding Space unmutes until it's released. Every way out mutes again,
 * and nothing during a hold can turn "open while held" into "open": the key or click that ends a
 * hold does nothing else, and if the mic is switched some other way the hold is dropped (what
 * happens next is then up to the user). If you were already unmuted, holding Space does nothing.
 */
export class HoldToTalk {
  private current: HoldState = 'idle';
  /** True while this class itself is switching the mic (so micChanged can tell). */
  private switching = false;

  constructor(private readonly mic: MicControl) {}

  get state(): HoldState {
    return this.current;
  }

  /** True while Space is held and it was this that unmuted the microphone. */
  get active(): boolean {
    return this.current === 'holding';
  }

  /**
   * A key went down. `talkKey`: it's Space with no modifiers. `canStart`: Space may start a hold
   * here (in the call, not typing, not on a button, whiteboard closed, not an auto-repeat).
   */
  keydown(talkKey: boolean, canStart: boolean): HoldVerdict {
    if (this.current === 'holding') {
      if (!talkKey) this.end('waiting'); // and the key does nothing else
      return 'swallow'; // (Space auto-repeat while holding is swallowed too)
    }
    if (this.current === 'waiting') return 'swallow';
    if (!talkKey || !canStart || !this.mic.available() || this.mic.isOn()) return 'pass';
    this.setMic(true);
    if (!this.mic.isOn()) return 'pass';
    this.current = 'holding';
    return 'swallow';
  }

  /** A key went up. `spaceKey`: it's Space (modifiers don't matter for letting go). */
  keyup(spaceKey: boolean): HoldVerdict {
    if (this.current === 'holding') {
      // Space let go: done. Anything else let go: only Space alone may hold the mic open.
      this.end(spaceKey ? 'idle' : 'waiting');
      return spaceKey ? 'swallow' : 'pass';
    }
    if (this.current === 'waiting' && spaceKey) {
      this.current = 'idle';
      return 'swallow';
    }
    return 'pass';
  }

  /**
   * Something other than a key interrupts a hold (a click or tap, focus moving into a text field).
   * Returns true if it ended one: then the click that caused it must do nothing else.
   */
  interrupt(): boolean {
    if (this.current !== 'holding') return false;
    this.end('waiting');
    return true;
  }

  /** Mute if holding, and start over: the window lost focus, the tab was hidden, a system picker is about to open, the call ended. */
  reset(): void {
    if (this.current === 'holding') this.end('idle');
    this.current = 'idle';
  }

  /** The microphone was switched by something else (the Mic button…): drop the hold and leave the mic alone. */
  micChanged(): void {
    if (!this.switching && this.current === 'holding') this.current = 'waiting';
  }

  private end(next: HoldState): void {
    this.current = next;
    if (this.mic.isOn()) this.setMic(false);
  }

  private setMic(on: boolean): void {
    this.switching = true;
    try {
      this.mic.setOn(on);
    } finally {
      this.switching = false;
    }
  }
}

/** Where a key press happens (the page fills this in from the DOM and its own state). */
export interface KeyContext {
  /** In the call itself (not the pre-join, password, waiting or error screens). */
  enabled: boolean;
  /** Focus is in a text field (see isTypingTarget). */
  typing: boolean;
  /** Space already means something where focus is (see spaceHasNativeAction). */
  spaceNative: boolean;
  /** Another handler already acted on this key. */
  defaultPrevented: boolean;
  whiteboardOpen: boolean;
  isMac: boolean;
  hasMic: boolean;
  hasCamera: boolean;
}

export interface KeydownResult {
  preventDefault: boolean;
  /** The shortcut to run now, if any. */
  action: ShortcutAction | null;
}

/**
 * Everything the call screen does with a keydown. Hold-to-talk sees it first: during a hold (and
 * after one ended early, until Space is let go) no key reaches the shortcuts, so Space + Ctrl+D can
 * never leave the microphone open.
 */
export function routeKeydown(hold: HoldToTalk, e: KeyLike, ctx: KeyContext): KeydownResult {
  const talk = isTalkKey(e);
  const canStart =
    talk && ctx.enabled && !ctx.whiteboardOpen && !e.repeat && !e.isComposing && !ctx.typing && !ctx.spaceNative && !ctx.defaultPrevented;
  if (hold.keydown(talk, canStart) === 'swallow') return { preventDefault: true, action: null };
  if (!ctx.enabled || ctx.defaultPrevented || e.isComposing || ctx.typing) return { preventDefault: false, action: null };
  const action = matchShortcut(e, ctx.isMac);
  // A shortcut with nothing to do (Ctrl+D for someone without a mic) is left to the browser.
  if (!action || !shortcutApplies(action, ctx)) return { preventDefault: false, action: null };
  // Block the browser's own use of the combination (Ctrl/Cmd+D bookmarks) even on auto-repeat; act once.
  return { preventDefault: true, action: e.repeat ? null : action };
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
