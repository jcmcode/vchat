<script lang="ts" context="module">
  export interface TextChange {
    text?: string;
    color?: string;
    size?: number;
    boxWidth?: number;
  }
</script>

<script lang="ts">
  // Editor for one whiteboard text box: a plain textarea (the text uses markdown-like markers) with
  // a small floating format bar. The formatted result is drawn on the canvas once editing ends.
  // Peer text is only ever shown as a textarea value, never as HTML.
  import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
  import Icon from '$lib/ui/Icon.svelte';
  import { FONT_STACK, LINE_HEIGHT, MAX_TEXT_LENGTH, continueList, toggleInline, toggleList, type Edit } from '$lib/collab/richtext';
  import { BOX_MAX_WIDTH, BOX_MIN_WIDTH } from '$lib/collab/strokes';

  export let text: string;
  export let color: string;
  /** Font size in world units. */
  export let size: number;
  /** Wrap width in world units. */
  export let boxWidth: number;
  export let zoom: number;
  /** Position of the box's top-left corner inside the board area, in CSS pixels. */
  export let left: number;
  export let top: number;
  export let containerWidth: number;
  export let colors: string[];
  export let sizes: { label: string; size: number }[];

  const dispatch = createEventDispatcher<{ change: TextChange; move: { dx: number; dy: number }; finish: void }>();
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  const mod = isMac ? 'Cmd' : 'Ctrl';

  let root: HTMLDivElement;
  let ta: HTMLTextAreaElement;
  let barWidth = 0;
  let barHeight = 0;
  let boxHeight = 0;
  let destroyed = false;

  onMount(() => {
    // Focus right away (still inside the tap/click that opened the editor, so mobile keyboards open).
    setValue(text);
    autoGrow();
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(text.length, text.length);
  });
  onDestroy(() => (destroyed = true));

  // Remote edits (or format changes) replace the value; keep the caret where it was.
  $: if (ta && ta.value !== text) {
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    setValue(text);
    ta.setSelectionRange(Math.min(s, text.length), Math.min(e, text.length));
  }

  // DOM writes go through a local alias: assigning to `ta.value` / `ta.style` directly would mark
  // `ta` as changed and re-run the reactive statements that depend on it (an endless update loop).
  function setValue(v: string) {
    const el = ta;
    el.value = v;
  }

  $: fontPx = size * zoom;
  $: widthPx = boxWidth * zoom;
  $: text, fontPx, widthPx, ta && tick().then(autoGrow);

  function autoGrow() {
    const el = ta;
    if (!el || destroyed) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(el.scrollHeight, fontPx * LINE_HEIGHT)}px`;
    boxHeight = el.offsetHeight;
  }

  function emitText() {
    dispatch('change', { text: ta.value });
  }

  function apply(edit: Edit) {
    if (edit.text.length > MAX_TEXT_LENGTH) return;
    setValue(edit.text);
    ta.setSelectionRange(edit.selStart, edit.selEnd);
    ta.focus({ preventScroll: true });
    emitText();
  }

  function inline(marker: '**' | '_' | '__') {
    apply(toggleInline(ta.value, ta.selectionStart, ta.selectionEnd, marker));
  }

  function list(kind: 'bullet' | 'number') {
    apply(toggleList(ta.value, ta.selectionStart, ta.selectionEnd, kind));
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      dispatch('finish');
      return;
    }
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
      const k = e.key.toLowerCase();
      if (k === 'b' || k === 'i' || k === 'u') {
        e.preventDefault();
        inline(k === 'b' ? '**' : k === 'i' ? '_' : '__');
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && ta.selectionStart === ta.selectionEnd) {
      const edit = continueList(ta.value, ta.selectionStart);
      if (edit) {
        e.preventDefault();
        apply(edit);
      }
    }
  }

  function onBlur() {
    // Finish when focus moves somewhere else in the page (not to the format bar, and not when the
    // whole window loses focus, e.g. switching apps).
    setTimeout(() => {
      if (destroyed || !document.hasFocus()) return;
      if (root?.contains(document.activeElement)) return;
      dispatch('finish');
    }, 0);
  }

  // ── Dragging: move the box, or resize its width ──
  let drag: { kind: 'move' | 'resize'; id: number; x: number; y: number; startWidth: number } | null = null;

  function startDrag(e: PointerEvent, kind: 'move' | 'resize') {
    if (e.button !== 0 || drag) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag = { kind, id: e.pointerId, x: e.clientX, y: e.clientY, startWidth: widthPx };
  }

  function onDragMove(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.kind === 'move') {
      dispatch('move', { dx: e.clientX - drag.x, dy: e.clientY - drag.y });
      drag.x = e.clientX;
      drag.y = e.clientY;
    } else {
      const px = drag.startWidth + (e.clientX - drag.x);
      dispatch('change', { boxWidth: Math.min(Math.max(Math.round(px / zoom), BOX_MIN_WIDTH), BOX_MAX_WIDTH) });
    }
  }

  function endDrag(e: PointerEvent) {
    if (drag && e.pointerId === drag.id) {
      drag = null;
      ta?.focus({ preventScroll: true });
    }
  }

  function onResizeKey(e: KeyboardEvent) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = (e.shiftKey ? 80 : 20) * (e.key === 'ArrowLeft' ? -1 : 1);
    dispatch('change', { boxWidth: Math.min(Math.max(boxWidth + step, BOX_MIN_WIDTH), BOX_MAX_WIDTH) });
  }

  // Format bar above the box (below it when there's no room), kept inside the board area.
  $: barLeft = Math.min(Math.max(left - 6, 4), Math.max(4, containerWidth - barWidth - 4));
  $: barTop = top - barHeight - 14 >= 4 ? top - barHeight - 14 : top + boxHeight + 14;
</script>

<div class="text-editor" bind:this={root}>
  <div
    class="format-bar"
    role="toolbar"
    aria-label="Text formatting"
    style="left: {barLeft}px; top: {barTop}px;"
    bind:clientWidth={barWidth}
    bind:clientHeight={barHeight}
  >
    <div class="fgroup" role="group" aria-label="Style">
      <button type="button" class="fbtn" on:mousedown|preventDefault on:click={() => inline('**')} title="Bold ({mod}+B)" aria-label="Bold">
        <Icon name="bold" size={16} />
      </button>
      <button type="button" class="fbtn" on:mousedown|preventDefault on:click={() => inline('_')} title="Italic ({mod}+I)" aria-label="Italic">
        <Icon name="italic" size={16} />
      </button>
      <button type="button" class="fbtn" on:mousedown|preventDefault on:click={() => inline('__')} title="Underline ({mod}+U)" aria-label="Underline">
        <Icon name="underline" size={16} />
      </button>
    </div>
    <div class="fgroup" role="group" aria-label="Lists">
      <button type="button" class="fbtn" on:mousedown|preventDefault on:click={() => list('bullet')} title="Bulleted list" aria-label="Bulleted list">
        <Icon name="list" size={16} />
      </button>
      <button type="button" class="fbtn" on:mousedown|preventDefault on:click={() => list('number')} title="Numbered list" aria-label="Numbered list">
        <Icon name="list-ordered" size={16} />
      </button>
    </div>
    <div class="fgroup" role="group" aria-label="Font size">
      {#each sizes as s}
        <button
          type="button"
          class="fbtn size"
          class:active={size === s.size}
          on:mousedown|preventDefault
          on:click={() => dispatch('change', { size: s.size })}
          title="Font size {s.label}"
          aria-label="Font size {s.label}"
          aria-pressed={size === s.size}>{s.label}</button
        >
      {/each}
    </div>
    <div class="fgroup" role="group" aria-label="Text color">
      {#each colors as c}
        <button
          type="button"
          class="fswatch"
          class:active={color === c}
          style="--swatch: {c}"
          on:mousedown|preventDefault
          on:click={() => dispatch('change', { color: c })}
          title="Text color {c}"
          aria-label="Text color {c}"
          aria-pressed={color === c}
        ></button>
      {/each}
    </div>
    <div class="fgroup" role="group" aria-label="Box">
      <button
        type="button"
        class="fbtn grip"
        on:mousedown|preventDefault
        on:pointerdown={(e) => startDrag(e, 'move')}
        on:pointermove={onDragMove}
        on:pointerup={endDrag}
        on:pointercancel={endDrag}
        title="Drag to move the text box"
        aria-label="Move text box (drag)"
      >
        <Icon name="move" size={16} />
      </button>
      <button type="button" class="fbtn" on:mousedown|preventDefault on:click={() => dispatch('finish')} title="Done (Esc)" aria-label="Done editing">
        <Icon name="check" size={16} />
      </button>
    </div>
  </div>

  <textarea
    bind:this={ta}
    class="entry"
    style="left: {left}px; top: {top}px; width: {widthPx}px; color: {color}; font: 400 {fontPx}px/{LINE_HEIGHT} {FONT_STACK};"
    rows="1"
    maxlength={MAX_TEXT_LENGTH}
    spellcheck="true"
    placeholder="Type…"
    aria-label="Text box. Formatting: **bold**, _italic_, __underline__, lines starting with - or 1. make lists. Escape to finish."
    on:input={() => {
      emitText();
      autoGrow();
    }}
    on:keydown={onKeydown}
    on:blur={onBlur}
  ></textarea>
  <button
    type="button"
    class="resize"
    style="left: {left + widthPx + 2}px; top: {top}px; height: {Math.max(boxHeight, 16)}px;"
    aria-label="Text box width: {boxWidth}. Drag, or use the left and right arrow keys."
    title="Drag to change the width"
    on:keydown={onResizeKey}
    on:mousedown|preventDefault
    on:pointerdown={(e) => startDrag(e, 'resize')}
    on:pointermove={onDragMove}
    on:pointerup={endDrag}
    on:pointercancel={endDrag}
  ></button>
</div>

<style>
  .text-editor {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  .entry,
  .resize,
  .format-bar {
    pointer-events: auto;
  }

  .entry {
    position: absolute;
    box-sizing: content-box;
    min-height: 1em;
    margin: 0;
    padding: 0;
    border: none;
    border-radius: 2px;
    background: rgba(255, 255, 255, 0.88);
    outline: 1.5px dashed var(--accent);
    outline-offset: 4px;
    box-shadow: 0 0 0 4px rgba(255, 255, 255, 0.88);
    resize: none;
    overflow: hidden;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .entry::placeholder {
    color: #9aa1b2;
  }

  .resize {
    position: absolute;
    width: 10px;
    padding: 0;
    border: none;
    background: transparent;
    margin-left: 2px;
    cursor: ew-resize;
    touch-action: none;
    border-radius: 4px;
  }

  .resize::after {
    content: '';
    position: absolute;
    left: 3px;
    top: 50%;
    width: 4px;
    height: min(28px, 80%);
    transform: translateY(-50%);
    border-radius: 2px;
    background: var(--accent);
    opacity: 0.7;
  }

  .format-bar {
    position: absolute;
    z-index: 5;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px 0;
    max-width: calc(100% - 8px);
    padding: 3px 4px;
    background: var(--bg-overlay);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-md);
  }

  .fgroup {
    display: flex;
    align-items: center;
    gap: 1px;
    padding: 0 4px;
    position: relative;
  }

  .fgroup + .fgroup::before {
    content: '';
    position: absolute;
    left: 0;
    top: 50%;
    height: 18px;
    transform: translateY(-50%);
    border-left: 1px solid var(--border);
  }

  .fbtn {
    min-width: 30px;
    height: 30px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 0.3rem;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: var(--text-xs);
    font-weight: 700;
    cursor: pointer;
  }

  .fbtn:hover {
    background: var(--bg-hover);
    color: var(--text);
  }

  .fbtn.active {
    background: var(--accent-soft);
    color: var(--accent);
    border-color: var(--accent-ring);
  }

  .fbtn.grip {
    cursor: move;
    touch-action: none;
  }

  .fbtn.size {
    min-width: 26px;
  }

  .fswatch {
    width: 18px;
    height: 18px;
    margin: 0 2px;
    padding: 0;
    border-radius: 50%;
    border: 2px solid var(--bg-overlay);
    box-shadow: 0 0 0 1px var(--border-strong);
    background: var(--swatch);
    cursor: pointer;
  }

  .fswatch.active {
    box-shadow: 0 0 0 2px var(--accent);
  }

  .fbtn:focus-visible,
  .fswatch:focus-visible,
  .resize:focus-visible {
    outline: 2px solid var(--accent-ring);
    outline-offset: 1px;
  }
</style>
