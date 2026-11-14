import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isMacPlatform,
  isTalkKey,
  isTypingTarget,
  letterOf,
  matchShortcut,
  PushToTalk,
  shortcutList,
  spaceHasNativeAction,
  type KeyLike,
  type TargetLike,
} from './shortcuts.js';

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  code: /^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : undefined,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

test('platform detection: Apple devices use Cmd', () => {
  assert.equal(isMacPlatform({ platform: 'MacIntel' }), true);
  assert.equal(isMacPlatform({ platform: 'iPhone' }), true);
  assert.equal(isMacPlatform({ userAgentData: { platform: 'macOS' } }), true);
  assert.equal(isMacPlatform({ platform: 'Win32' }), false);
  assert.equal(isMacPlatform({ userAgentData: { platform: 'Linux' }, platform: 'MacIntel' }), false);
  assert.equal(isMacPlatform(undefined), false);
});

test('mic and camera: Ctrl+D / Ctrl+E elsewhere, Cmd+D / Cmd+E on a Mac', () => {
  assert.equal(matchShortcut(key('d', { ctrlKey: true }), false), 'toggle-mic');
  assert.equal(matchShortcut(key('e', { ctrlKey: true }), false), 'toggle-camera');
  assert.equal(matchShortcut(key('d', { metaKey: true }), true), 'toggle-mic');
  assert.equal(matchShortcut(key('e', { metaKey: true }), true), 'toggle-camera');
  // The other platform's modifier does nothing
  assert.equal(matchShortcut(key('d', { metaKey: true }), false), null);
  assert.equal(matchShortcut(key('d', { ctrlKey: true }), true), null);
  // Extra modifiers make it a different shortcut (Ctrl+Shift+D, Ctrl+Alt+D…)
  assert.equal(matchShortcut(key('D', { ctrlKey: true, shiftKey: true }), false), null);
  assert.equal(matchShortcut(key('d', { ctrlKey: true, altKey: true }), false), null);
  assert.equal(matchShortcut(key('d', { ctrlKey: true, metaKey: true }), false), null);
});

test('hand and chat: Ctrl+Alt elsewhere, Ctrl+Cmd on a Mac (Option keys report odd characters)', () => {
  assert.equal(matchShortcut(key('h', { ctrlKey: true, altKey: true }), false), 'toggle-hand');
  assert.equal(matchShortcut(key('c', { ctrlKey: true, altKey: true }), false), 'toggle-chat');
  assert.equal(matchShortcut(key('h', { ctrlKey: true, metaKey: true }), true), 'toggle-hand');
  assert.equal(matchShortcut(key('c', { ctrlKey: true, metaKey: true }), true), 'toggle-chat');
  // Ctrl+Option is VoiceOver's modifier on a Mac: not ours
  assert.equal(matchShortcut({ ...key('˙', { ctrlKey: true, altKey: true }), code: 'KeyH' }, true), null);
  // AltGr (reported as Ctrl+Alt) turning C into "ć" on a Polish layout still means C
  assert.equal(matchShortcut({ ...key('ć', { ctrlKey: true, altKey: true }), code: 'KeyC' }, false), 'toggle-chat');
  // Plain letters (the whiteboard's tools) and Ctrl/Cmd+Z (its undo) are never ours
  for (const k of ['p', 'm', 't', 'e', 'h', 'd', 'c', '+', '-', '0', '1', ' ']) {
    assert.equal(matchShortcut(key(k), false), null, `plain ${k}`);
    assert.equal(matchShortcut(key(k), true), null, `plain ${k} (mac)`);
  }
  assert.equal(matchShortcut(key('z', { ctrlKey: true }), false), null);
  assert.equal(matchShortcut(key('z', { metaKey: true }), true), null);
});

test('layouts: the letter on the key wins; non-Latin layouts fall back to the physical key', () => {
  assert.equal(letterOf({ key: 'd', code: 'KeyE' }), 'd'); // Dvorak: the key labelled D
  assert.equal(letterOf({ key: 'в', code: 'KeyD' }), 'd'); // Russian
  assert.equal(letterOf({ key: '∂', code: 'KeyD' }), 'd'); // Option+D on a Mac
  assert.equal(letterOf({ key: 'Enter', code: 'Enter' }), null);
  assert.equal(letterOf({ key: '1', code: 'Digit1' }), null);
  assert.equal(matchShortcut({ ...key('в', { ctrlKey: true }), code: 'KeyD' }, false), 'toggle-mic');
});

test('"?" opens help (with Shift or AltGr), but not with Cmd; IME composition never matches', () => {
  assert.equal(matchShortcut(key('?', { shiftKey: true }), false), 'help');
  assert.equal(matchShortcut(key('?', { shiftKey: true }), true), 'help');
  assert.equal(matchShortcut(key('?', { ctrlKey: true, altKey: true }), false), 'help');
  assert.equal(matchShortcut(key('?', { metaKey: true, shiftKey: true }), true), null);
  assert.equal(matchShortcut(key('/', {}), false), null);
  assert.equal(matchShortcut(key('d', { ctrlKey: true, isComposing: true }), false), null);
  // Repeats still match (so the caller can block the browser's default) — acting once is the caller's job
  assert.equal(matchShortcut(key('d', { ctrlKey: true, repeat: true }), false), 'toggle-mic');
});

test('hold-to-talk key is Space with no modifiers', () => {
  assert.equal(isTalkKey(key(' ')), true);
  assert.equal(isTalkKey(key('Spacebar')), true);
  assert.equal(isTalkKey(key(' ', { shiftKey: true })), false);
  assert.equal(isTalkKey(key(' ', { ctrlKey: true })), false);
  assert.equal(isTalkKey(key(' ', { metaKey: true })), false);
  assert.equal(isTalkKey(key(' ', { altKey: true })), false);
  assert.equal(isTalkKey(key('m')), false);
});

/** A tiny stand-in for a DOM element (tests run without a browser). */
function el(tagName: string, attrs: Record<string, string> = {}, parent?: TargetLike & { attrs?: Record<string, string> }, editable = false) {
  const node: TargetLike & { attrs: Record<string, string>; parent?: typeof parent } = {
    tagName: tagName.toUpperCase(),
    isContentEditable: editable,
    attrs,
    parent,
    getAttribute: (name: string) => (name in attrs ? attrs[name] : null),
    closest(selector: string) {
      // Minimal matcher for the selectors shortcuts.ts uses: tag names, [attr], [attr="v"], :not([attr="v"]).
      const parts = selector.split(',').map((s) => s.trim());
      let cur: (TargetLike & { attrs?: Record<string, string>; parent?: unknown }) | undefined = node;
      while (cur) {
        const c = cur;
        const tag = String(c.tagName).toLowerCase();
        const a = c.attrs ?? {};
        for (const part of parts) {
          const m = /^([a-z]*)((?:\[[^\]]+\])*)(?::not\(\[([a-z-]+)="([^"]*)"\]\))?$/.exec(part);
          if (!m) continue;
          const [, t, attrSel, notName, notVal] = m;
          if (t && t !== tag) continue;
          const conds = [...attrSel.matchAll(/\[([a-z-]+)(?:="([^"]*)")?\]/g)];
          if (!conds.every(([, n, v]) => n in a && (v === undefined || a[n] === v))) continue;
          if (notName && a[notName] === notVal) continue;
          return c;
        }
        cur = c.parent as typeof cur;
      }
      return null;
    },
  };
  return node;
}

test('"is the user typing?": every input, textarea, select, contenteditable and text widget', () => {
  for (const type of ['text', 'password', 'search', 'email', 'number', 'range', 'checkbox', 'file']) {
    assert.equal(isTypingTarget(el('input', { type })), true, type);
  }
  assert.equal(isTypingTarget(el('textarea')), true);
  assert.equal(isTypingTarget(el('select')), true);
  assert.equal(isTypingTarget({ tagName: 'input' }), true); // lower-case tag names too
  assert.equal(isTypingTarget(el('div', { contenteditable: 'true' }, undefined, true)), true);
  assert.equal(isTypingTarget(el('div', { role: 'textbox' })), true);
  assert.equal(isTypingTarget(el('div', { role: 'combobox' })), true);
  // Inside an editable region (e.g. a formatted span in a contenteditable editor)
  const editor = el('div', { contenteditable: '' });
  assert.equal(isTypingTarget(el('span', {}, editor)), true);
  // Not typing
  assert.equal(isTypingTarget(el('body')), false);
  assert.equal(isTypingTarget(el('button')), false);
  assert.equal(isTypingTarget(el('canvas')), false);
  assert.equal(isTypingTarget(el('div', { contenteditable: 'false' })), false);
  assert.equal(isTypingTarget(null), false);
  assert.equal(isTypingTarget(undefined), false);
  assert.equal(isTypingTarget('input'), false);
  assert.equal(isTypingTarget({}), false);
  // A closest() that throws doesn't crash the check
  assert.equal(isTypingTarget({ tagName: 'DIV', closest: () => { throw new Error('bad selector'); } }), false);
});

test('Space keeps its normal meaning on buttons, links, tiles and form controls', () => {
  assert.equal(spaceHasNativeAction(el('button')), true);
  assert.equal(spaceHasNativeAction(el('a', { href: '/' })), true);
  assert.equal(spaceHasNativeAction(el('summary')), true);
  assert.equal(spaceHasNativeAction(el('div', { role: 'button', tabindex: '0' })), true); // a participant tile
  assert.equal(spaceHasNativeAction(el('div', { role: 'switch' })), true);
  assert.equal(spaceHasNativeAction(el('input', { type: 'checkbox' })), true);
  assert.equal(spaceHasNativeAction(el('textarea')), true);
  assert.equal(spaceHasNativeAction(el('span', {}, el('button')) as unknown), true); // icon inside a button
  assert.equal(spaceHasNativeAction(el('body')), false);
  assert.equal(spaceHasNativeAction(el('a')), false); // no href: not a link
  assert.equal(spaceHasNativeAction(el('div')), false);
  assert.equal(spaceHasNativeAction(null), false);
});

function fakeMic(initial: { on: boolean; available?: boolean }) {
  const state = { on: initial.on, available: initial.available ?? true, sets: [] as boolean[] };
  return {
    state,
    mic: {
      available: () => state.available,
      isOn: () => state.on,
      setOn: (on: boolean) => {
        state.sets.push(on);
        if (state.available) state.on = on;
      },
    },
  };
}

test('hold-to-talk: unmutes while held and always mutes again on release', () => {
  const { state, mic } = fakeMic({ on: false });
  const ptt = new PushToTalk(mic);
  assert.equal(ptt.press(), true);
  assert.equal(state.on, true);
  assert.equal(ptt.active, true);
  assert.equal(ptt.press(), true); // key repeat: no second toggle
  assert.deepEqual(state.sets, [true]);
  ptt.release();
  assert.equal(state.on, false);
  assert.equal(ptt.active, false);
  ptt.release(); // blur after keyup etc.: harmless
  assert.deepEqual(state.sets, [true, false]);
});

test('hold-to-talk does nothing if you are already unmuted, or have no microphone', () => {
  const unmuted = fakeMic({ on: true });
  const ptt = new PushToTalk(unmuted.mic);
  assert.equal(ptt.press(), false);
  ptt.release();
  assert.equal(unmuted.state.on, true); // releasing never mutes a mic the hold didn't open
  assert.deepEqual(unmuted.state.sets, []);

  const none = fakeMic({ on: false, available: false });
  const ptt2 = new PushToTalk(none.mic);
  assert.equal(ptt2.press(), false);
  assert.equal(ptt2.active, false);
  assert.deepEqual(none.state.sets, []);
});

test('hold-to-talk: muting by other means while held is respected; release never leaves the mic open', () => {
  const { state, mic } = fakeMic({ on: false });
  const ptt = new PushToTalk(mic);
  ptt.press();
  state.on = false; // the Mic button was pressed while holding
  ptt.release();
  assert.equal(state.on, false);
  assert.deepEqual(state.sets, [true]);

  ptt.press();
  state.on = true; // toggled twice while holding: still open
  ptt.release();
  assert.equal(state.on, false);
});

test('hold-to-talk: if unmuting fails, it is not considered held', () => {
  const state = { on: false };
  const ptt = new PushToTalk({ available: () => true, isOn: () => state.on, setOn: () => {} });
  assert.equal(ptt.press(), false);
  assert.equal(ptt.active, false);
});

test('the help sheet lists every shortcut, spelled for the platform', () => {
  const win = shortcutList(false);
  const mac = shortcutList(true);
  assert.equal(win.length, 6);
  assert.deepEqual(win[0].keys, ['Ctrl', 'D']);
  assert.deepEqual(mac[0].keys, ['Cmd', 'D']);
  assert.deepEqual(win[3].keys, ['Ctrl', 'Alt', 'H']);
  assert.deepEqual(mac[3].keys, ['Ctrl', 'Cmd', 'H']);
  assert.ok(win.some((s) => s.keys.join() === 'Space'));
  assert.ok(win.some((s) => s.keys.join() === '?'));
});
