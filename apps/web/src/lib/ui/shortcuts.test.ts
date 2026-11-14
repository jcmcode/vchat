import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HoldToTalk,
  isMacPlatform,
  isSpaceKey,
  isTalkKey,
  isTypingTarget,
  letterOf,
  matchShortcut,
  routeKeydown,
  shortcutApplies,
  shortcutList,
  spaceHasNativeAction,
  type KeyContext,
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
  // Real Ctrl+Alt on a layout whose C key types "ć" with them still means C…
  assert.equal(matchShortcut({ ...key('ć', { ctrlKey: true, altKey: true }), code: 'KeyC' }, false), 'toggle-chat');
  // …but AltGr (also reported as Ctrl+Alt) is someone typing a character: never a shortcut
  const altGr = { getModifierState: (k: string) => k === 'AltGraph' };
  assert.equal(matchShortcut({ ...key('ć', { ctrlKey: true, altKey: true }), code: 'KeyC', ...altGr }, false), null);
  assert.equal(matchShortcut({ ...key('h', { ctrlKey: true, altKey: true }), ...altGr }, false), null);
  assert.equal(matchShortcut({ ...key('d', { ctrlKey: true }), ...altGr }, false), null);
  assert.equal(matchShortcut({ ...key('?', { ctrlKey: true, altKey: true }), ...altGr }, false), 'help'); // a typed "?" is still "?"
  // A getModifierState that throws is treated as "no AltGr"
  assert.equal(matchShortcut({ ...key('d', { ctrlKey: true }), getModifierState: () => { throw new Error('x'); } }, false), 'toggle-mic');
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
  assert.equal(isSpaceKey(key(' ', { shiftKey: true })), true); // letting go of Space counts with any modifier
  assert.equal(isSpaceKey(key('Enter')), false);
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

/** A microphone, a camera, a hand and a chat panel, driven through routeKeydown like the page does. */
function fakeCall(opts: { on?: boolean; available?: boolean; isMac?: boolean; hasCamera?: boolean } = {}) {
  const st = { on: opts.on ?? false, available: opts.available ?? true, sets: [] as boolean[], camera: true, hand: false, chat: false, help: false };
  const mic = {
    available: () => st.available,
    isOn: () => st.on,
    setOn: (on: boolean) => {
      st.sets.push(on);
      if (st.available) st.on = on;
      hold.micChanged(); // the store notifies synchronously, as audioEnabled does
    },
  };
  const hold = new HoldToTalk(mic);
  const ctx = (over: Partial<KeyContext> = {}): KeyContext => ({
    enabled: true,
    typing: false,
    spaceNative: false,
    defaultPrevented: false,
    whiteboardOpen: false,
    isMac: opts.isMac ?? false,
    hasMic: st.available,
    hasCamera: opts.hasCamera ?? true,
    ...over,
  });
  const prevented: boolean[] = [];
  const down = (e: KeyLike, over: Partial<KeyContext> = {}) => {
    const r = routeKeydown(hold, e, ctx(over));
    prevented.push(r.preventDefault);
    switch (r.action) {
      case 'toggle-mic':
        mic.setOn(!st.on);
        break;
      case 'toggle-camera':
        st.camera = !st.camera;
        break;
      case 'toggle-hand':
        st.hand = !st.hand;
        break;
      case 'toggle-chat':
        st.chat = !st.chat;
        break;
      case 'help':
        st.help = !st.help;
        break;
    }
    return r;
  };
  const up = (e: KeyLike) => hold.keyup(isSpaceKey(e));
  /** The Mic button, clicked (not through a hold). */
  const clickMic = () => mic.setOn(!st.on);
  return { st, hold, down, up, clickMic, prevented };
}

const SPACE = key(' ');
const CTRL = { ...key('Control'), ctrlKey: true };
const ALT = { ...key('Alt'), altKey: true };
const SHIFT = { ...key('Shift'), shiftKey: true };
const META = { ...key('Meta'), metaKey: true };

test('hold-to-talk: unmutes while held, auto-repeat is swallowed, release mutes again', () => {
  const c = fakeCall();
  assert.deepEqual(c.down(SPACE), { preventDefault: true, action: null });
  assert.equal(c.st.on, true);
  assert.equal(c.hold.state, 'holding');
  c.down({ ...SPACE, repeat: true });
  c.down({ ...SPACE, repeat: true });
  assert.deepEqual(c.st.sets, [true]);
  assert.equal(c.up(SPACE), 'swallow');
  assert.equal(c.st.on, false);
  assert.equal(c.hold.state, 'idle');
  assert.deepEqual(c.st.sets, [true, false]);
});

test('Space + Ctrl/Cmd+D: the mic ends up muted, whatever order things are let go in', () => {
  for (const isMac of [false, true]) {
    const mod = isMac ? META : CTRL;
    const d = { ...key('d'), ctrlKey: !isMac, metaKey: isMac };
    for (const releaseOrder of [['d', 'mod', 'space'], ['space', 'd', 'mod'], ['mod', 'd', 'space'], ['d', 'space', 'mod']]) {
      const c = fakeCall({ isMac });
      c.down(SPACE);
      assert.equal(c.st.on, true);
      c.down(mod); // ends the hold: muted, and nothing else
      assert.equal(c.st.on, false);
      assert.deepEqual(c.down(d), { preventDefault: true, action: null }); // ignored (and no bookmark dialog)
      assert.equal(c.st.on, false);
      for (const k of releaseOrder) c.up(k === 'space' ? SPACE : k === 'd' ? d : mod);
      assert.equal(c.st.on, false, `${isMac ? 'mac' : 'pc'} ${releaseOrder}`);
      assert.equal(c.hold.state, 'idle');
      assert.deepEqual(c.st.sets, [true, false]);
    }
  }
});

test('Space + other shortcuts during a hold: nothing runs, the mic is muted', () => {
  const sequences: { name: string; keys: KeyLike[]; check: (c: ReturnType<typeof fakeCall>) => void }[] = [
    { name: 'Ctrl+E', keys: [CTRL, { ...key('e'), ctrlKey: true }], check: (c) => assert.equal(c.st.camera, true) },
    {
      name: 'Ctrl+Alt+H',
      keys: [CTRL, { ...ALT, ctrlKey: true }, { ...key('h'), ctrlKey: true, altKey: true }],
      check: (c) => assert.equal(c.st.hand, false),
    },
    { name: 'Ctrl+Alt+C', keys: [CTRL, { ...ALT, ctrlKey: true }, { ...key('c'), ctrlKey: true, altKey: true }], check: (c) => assert.equal(c.st.chat, false) },
    { name: '?', keys: [SHIFT, { ...key('?'), shiftKey: true }], check: (c) => assert.equal(c.st.help, false) },
    { name: 'plain letter', keys: [key('x')], check: () => {} },
  ];
  for (const s of sequences) {
    const c = fakeCall();
    c.down(SPACE);
    for (const k of s.keys) assert.equal(c.down(k).action, null, s.name);
    s.check(c);
    assert.equal(c.st.on, false, s.name);
    c.up(SPACE);
    assert.equal(c.st.on, false, s.name);
  }
});

test('a shortcut key arriving mid-hold without its modifier keydown (missed event) still only ends the hold', () => {
  for (const k of [
    { ...key('d'), ctrlKey: true },
    { ...key('e'), ctrlKey: true },
    { ...key('h'), ctrlKey: true, altKey: true },
    { ...key('c'), ctrlKey: true, altKey: true },
    { ...key('?'), shiftKey: true },
  ]) {
    const c = fakeCall();
    c.down(SPACE);
    assert.deepEqual(c.down(k), { preventDefault: true, action: null });
    assert.equal(c.st.on, false);
    c.up(k);
    c.up(SPACE);
    assert.equal(c.st.on, false);
    assert.deepEqual(c.st.sets, [true, false]);
  }
});

test('after a hold ends early, a second Space does not start a new hold until Space is let go', () => {
  const c = fakeCall();
  c.down(SPACE);
  c.down(CTRL);
  assert.equal(c.hold.state, 'waiting');
  c.up(CTRL);
  assert.equal(c.down({ ...SPACE, repeat: true }).preventDefault, true);
  assert.equal(c.down(SPACE).preventDefault, true); // a fresh keydown too
  assert.equal(c.st.on, false);
  assert.equal(c.up(SPACE), 'swallow');
  assert.equal(c.hold.state, 'idle');
  // Once let go, Space works again
  c.down(SPACE);
  assert.equal(c.st.on, true);
  c.up(SPACE);
  assert.equal(c.st.on, false);
  // A Space released with a modifier still counts as letting go
  c.down(SPACE);
  c.down(SHIFT);
  c.up({ ...SPACE, shiftKey: true });
  assert.equal(c.hold.state, 'idle');
  assert.equal(c.st.on, false);
});

test('letting go of another key that was down before Space ends the hold too', () => {
  const c = fakeCall();
  c.down(SPACE);
  assert.equal(c.up(key('a')), 'pass');
  assert.equal(c.st.on, false);
  assert.equal(c.hold.state, 'waiting');
  c.up(SPACE);
  assert.equal(c.hold.state, 'idle');
});

test('a click or focus into a text field ends the hold, and that click must do nothing else', () => {
  const c = fakeCall();
  c.down(SPACE);
  assert.equal(c.hold.interrupt(), true); // swallow the click
  assert.equal(c.st.on, false);
  assert.equal(c.hold.interrupt(), false); // a second click is a normal click
  c.up(SPACE);
  assert.equal(c.hold.interrupt(), false);
  assert.equal(c.st.on, false);
});

test('clicking Mute then Unmute during a hold is not undone when Space is let go', () => {
  const c = fakeCall();
  c.down(SPACE);
  c.clickMic(); // mute: drops the hold
  assert.equal(c.st.on, false);
  assert.equal(c.hold.state, 'waiting');
  c.clickMic(); // unmute, on purpose
  assert.equal(c.st.on, true);
  c.up(SPACE);
  assert.equal(c.st.on, true);
});

test('blur, a hidden tab or the screen-share picker start over with the mic muted', () => {
  const c = fakeCall();
  c.down(SPACE);
  c.hold.reset();
  assert.equal(c.st.on, false);
  assert.equal(c.hold.state, 'idle');
  c.down(SPACE);
  c.down(CTRL);
  c.hold.reset(); // from "waiting" too: keys work again without a Space keyup
  assert.equal(c.hold.state, 'idle');
  assert.equal(c.down({ ...key('d'), ctrlKey: true }).action, 'toggle-mic');
});

test('hold-to-talk does nothing when already unmuted, without a mic, while typing, on a button, with the whiteboard open, or outside the call', () => {
  const unmuted = fakeCall({ on: true });
  assert.equal(unmuted.down(SPACE).preventDefault, false);
  unmuted.up(SPACE);
  assert.equal(unmuted.st.on, true); // letting go never mutes a mic the hold didn't open
  assert.deepEqual(unmuted.st.sets, []);

  const noMic = fakeCall({ available: false });
  noMic.down(SPACE);
  assert.equal(noMic.hold.state, 'idle');

  for (const over of [{ typing: true }, { spaceNative: true }, { whiteboardOpen: true }, { enabled: false }, { defaultPrevented: true }]) {
    const c = fakeCall();
    assert.equal(c.down(SPACE, over).preventDefault, false, JSON.stringify(over));
    assert.equal(c.st.on, false);
  }
  const c = fakeCall();
  c.down({ ...SPACE, repeat: true }); // a repeat never starts a hold (Space was held elsewhere)
  assert.equal(c.st.on, false);

  const failing = new HoldToTalk({ available: () => true, isOn: () => false, setOn: () => {} });
  assert.equal(failing.keydown(true, true), 'pass');
  assert.equal(failing.active, false);
});

test('shortcuts with nothing to do are left to the browser; shortcuts never run while typing or outside the call', () => {
  const chatOnly = fakeCall({ available: false, hasCamera: false });
  assert.deepEqual(chatOnly.down({ ...key('d'), ctrlKey: true }), { preventDefault: false, action: null });
  assert.deepEqual(chatOnly.down({ ...key('e'), ctrlKey: true }), { preventDefault: false, action: null });
  assert.equal(chatOnly.down({ ...key('h'), ctrlKey: true, altKey: true }).action, 'toggle-hand');
  const audioOnly = fakeCall({ hasCamera: false });
  assert.equal(audioOnly.down({ ...key('e'), ctrlKey: true }).preventDefault, false);
  assert.equal(audioOnly.down({ ...key('d'), ctrlKey: true }).action, 'toggle-mic');
  assert.equal(audioOnly.st.on, true);
  const c = fakeCall();
  assert.deepEqual(c.down({ ...key('d'), ctrlKey: true }, { typing: true }), { preventDefault: false, action: null });
  assert.deepEqual(c.down({ ...key('d'), ctrlKey: true }, { enabled: false }), { preventDefault: false, action: null });
  assert.deepEqual(c.down({ ...key('d'), ctrlKey: true, repeat: true }), { preventDefault: true, action: null });
  assert.equal(c.st.on, false);
  assert.equal(shortcutApplies('toggle-chat', { hasMic: false, hasCamera: false }), true);
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
