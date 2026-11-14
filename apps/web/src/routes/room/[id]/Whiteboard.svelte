<script lang="ts">
  // Shared infinite whiteboard. Drawing data is in shared world coordinates; the view (pan/zoom)
  // is yours alone. Pan: scroll / two-finger scroll, Hand tool, Space+drag, middle mouse, two
  // fingers on touch. Zoom: Ctrl/Cmd+wheel, trackpad or touch pinch, the zoom buttons.
  import { onDestroy, onMount, createEventDispatcher } from 'svelte';
  import Icon from '$lib/ui/Icon.svelte';
  import TextEditor, { type TextChange } from './whiteboard/TextEditor.svelte';
  import {
    board,
    boardVersion,
    boardStatus,
    savedView,
    startStroke,
    addPoint,
    finishStroke,
    cancelStroke,
    createText,
    saveText,
    removeItems,
    eraseAt,
    textAt,
    undoLast,
    clearAll,
    localPeerId,
    type TextFields,
  } from '$lib/collab/whiteboard';
  import { exportDocx, exportPdf, exportPng } from '$lib/collab/export';
  import { drawStroke, itemBounds, prepareCanvas, worldView } from '$lib/collab/render';
  import { BOX_DEFAULT_WIDTH, WORLD, WORLD_LIMIT, focusBounds, newStrokeId } from '$lib/collab/strokes';
  import { measuredTextBounds } from '$lib/collab/render';
  import type { StrokeSender } from '$lib/collab/stroke-sender';

  const dispatch = createEventDispatcher<{ close: void }>();

  type WbTool = 'pen' | 'highlighter' | 'text' | 'eraser' | 'hand';
  const COLORS = ['#111827', '#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6'];
  /** Stroke sizes in screen pixels at the moment you draw (so the pen feels the same at any zoom). */
  const SIZES = [
    { label: 'S', px: 2 },
    { label: 'M', px: 4 },
    { label: 'L', px: 9 },
  ];
  /** Text sizes in world units. */
  const TEXT_SIZES = [
    { label: 'S', size: 14 },
    { label: 'M', size: 20 },
    { label: 'L', size: 32 },
    { label: 'XL', size: 48 },
  ];
  const MIN_ZOOM = 0.1;
  const MAX_ZOOM = 4;
  const ERASER_PX = 10;
  const SAVE_INTERVAL_MS = 150;

  const TOOLS: { id: WbTool; icon: string; label: string; key: string }[] = [
    { id: 'pen', icon: 'pen', label: 'Pen', key: 'P' },
    { id: 'highlighter', icon: 'highlighter', label: 'Highlighter', key: 'M' },
    { id: 'text', icon: 'type', label: 'Text', key: 'T' },
    { id: 'eraser', icon: 'eraser', label: 'Eraser', key: 'E' },
    { id: 'hand', icon: 'hand', label: 'Hand (pan)', key: 'H' },
  ];

  let tool: WbTool = 'pen';
  let color = COLORS[0];
  let sizeIndex = 1;
  let textSize = TEXT_SIZES[1].size;
  let confirmingClear = false;
  let exporting = false;
  let exportOpen = false;
  let exportMenu: HTMLDivElement;
  let notice = '';
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;

  let wrap: HTMLDivElement;
  let canvas: HTMLCanvasElement;
  let viewW = 0;
  let viewH = 0;

  // ── Camera (local only) ──
  let camX = 0;
  let camY = 0;
  let zoom = 1;

  const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

  function clampCam() {
    const lim = WORLD_LIMIT * 1.1;
    camX = clamp(camX, -lim, lim);
    camY = clamp(camY, -lim, lim);
  }

  /** Zoom to `next`, keeping the world point under (sx, sy) (board-relative pixels) in place. */
  function zoomAround(sx: number, sy: number, next: number) {
    const z = clamp(next, MIN_ZOOM, MAX_ZOOM);
    if (!Number.isFinite(z)) return;
    const wx = camX + sx / zoom;
    const wy = camY + sy / zoom;
    zoom = z;
    camX = wx - sx / zoom;
    camY = wy - sy / zoom;
    clampCam();
  }

  function zoomBy(factor: number) {
    zoomAround(viewW / 2, viewH / 2, zoom * factor);
  }

  function resetZoom() {
    zoomAround(viewW / 2, viewH / 2, 1);
  }

  function fitContent() {
    const b = focusBounds(board, measuredTextBounds);
    if (!b || viewW <= 0 || viewH <= 0) {
      zoom = 1;
      camX = -viewW / 2;
      camY = -viewH / 2;
      return;
    }
    const pad = 48;
    const w = Math.max(b.maxX - b.minX, 1);
    const h = Math.max(b.maxY - b.minY, 1);
    zoom = clamp(Math.min((viewW - pad * 2) / w, (viewH - pad * 2) / h), MIN_ZOOM, 1.5);
    camX = (b.minX + b.maxX) / 2 - viewW / 2 / zoom;
    camY = (b.minY + b.maxY) / 2 - viewH / 2 / zoom;
    clampCam();
  }

  function toWorld(clientX: number, clientY: number): { x: number; y: number } {
    const r = canvas.getBoundingClientRect();
    return { x: camX + (clientX - r.left) / zoom, y: camY + (clientY - r.top) / zoom };
  }

  // ── Rendering ──
  let frame = 0;
  function requestDraw() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      draw();
    });
  }

  function draw() {
    if (!canvas) return;
    const ctx = prepareCanvas(canvas);
    if (!ctx) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    const view = worldView(camX, camY, zoom);
    const minX = camX;
    const minY = camY;
    const maxX = camX + w / zoom;
    const maxY = camY + h / zoom;
    const hidden = editing?.id;
    for (const s of board.strokes.values()) {
      if (s.id === hidden) continue;
      const b = itemBounds(s);
      if (b.maxX < minX || b.minX > maxX || b.maxY < minY || b.minY > maxY) continue;
      drawStroke(ctx, s, view);
      if (tool === 'text' && s.text !== undefined) {
        // Show where text boxes are while the text tool is active (local only).
        ctx.save();
        ctx.strokeStyle = 'rgba(64, 96, 232, 0.35)';
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;
        ctx.strokeRect(
          (b.minX - camX) * zoom - 4,
          (b.minY - camY) * zoom - 4,
          (b.maxX - b.minX) * zoom + 8,
          (b.maxY - b.minY) * zoom + 8
        );
        ctx.restore();
      }
    }
  }

  $: $boardVersion, onBoardChanged();
  $: camX, camY, zoom, tool, viewW, viewH, requestDraw();

  // Dot grid that moves with the view (CSS background, so it costs nothing to redraw).
  function gridStep(z: number): number {
    let g = 24 * z;
    while (g < 14) g *= 2;
    while (g > 56) g /= 2;
    return g;
  }
  const mod = (a: number, n: number) => ((a % n) + n) % n;
  $: grid = gridStep(zoom);
  $: gridStyle = `background-size: ${grid}px ${grid}px; background-position: ${mod(-camX * zoom - grid / 2, grid)}px ${mod(-camY * zoom - grid / 2, grid)}px;`;

  let resizeObserver: ResizeObserver;
  onMount(() => {
    viewW = wrap.clientWidth;
    viewH = wrap.clientHeight;
    if (savedView.cam) {
      ({ x: camX, y: camY, zoom } = savedView.cam);
    } else if (board.strokes.size > 0) {
      fitContent();
    } else {
      camX = -viewW / 2;
      camY = -viewH / 2;
    }
    resizeObserver = new ResizeObserver(() => {
      viewW = wrap.clientWidth;
      viewH = wrap.clientHeight;
      requestDraw();
    });
    resizeObserver.observe(wrap);

    // Non-passive so the page doesn't scroll/zoom while panning and zooming the board.
    wrap.addEventListener('wheel', onWheel, { passive: false });
    wrap.addEventListener('gesturestart', onGestureStart as EventListener, { passive: false });
    wrap.addEventListener('gesturechange', onGestureChange as EventListener, { passive: false });
    requestDraw();
  });

  onDestroy(() => {
    savedView.cam = { x: camX, y: camY, zoom };
    if (sender) finishStroke(sender);
    if (editing) finishEditing();
    resizeObserver?.disconnect();
    wrap?.removeEventListener('wheel', onWheel);
    wrap?.removeEventListener('gesturestart', onGestureStart as EventListener);
    wrap?.removeEventListener('gesturechange', onGestureChange as EventListener);
    if (frame) cancelAnimationFrame(frame);
    if (noticeTimer) clearTimeout(noticeTimer);
  });

  function showNotice(msg: string) {
    notice = msg;
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => (notice = ''), 4000);
  }

  // ── Wheel / trackpad ──
  function onWheel(e: WheelEvent) {
    e.preventDefault();
    let dx = e.deltaX;
    let dy = e.deltaY;
    if (e.deltaMode === 1) {
      dx *= 16;
      dy *= 16;
    } else if (e.deltaMode === 2) {
      dx *= viewW;
      dy *= viewH;
    }
    if (e.ctrlKey || e.metaKey) {
      // Ctrl/Cmd+wheel, and trackpad pinch (browsers report it as wheel + ctrlKey).
      const r = wrap.getBoundingClientRect();
      zoomAround(e.clientX - r.left, e.clientY - r.top, zoom * Math.exp(-clamp(dy, -50, 50) * 0.01));
      return;
    }
    if (e.shiftKey && dx === 0) {
      dx = dy;
      dy = 0;
    }
    camX += dx / zoom;
    camY += dy / zoom;
    clampCam();
  }

  // Safari (macOS) reports trackpad pinch as gesture events instead of ctrl+wheel.
  let gestureBase = 1;
  type GestureLike = Event & { scale: number; clientX: number; clientY: number };
  function onGestureStart(e: GestureLike) {
    e.preventDefault();
    gestureBase = zoom;
  }
  function onGestureChange(e: GestureLike) {
    e.preventDefault();
    if (touches.size > 0 || !Number.isFinite(e.scale)) return; // touch pinch is handled by pointer events
    const r = wrap.getBoundingClientRect();
    zoomAround(e.clientX - r.left, e.clientY - r.top, gestureBase * e.scale);
  }

  // ── Pointers ──
  type Mode = 'idle' | 'draw' | 'erase' | 'pan' | 'pinch';
  let mode: Mode = 'idle';
  let activeId: number | null = null;
  let activeType = '';
  let sender: StrokeSender | null = null;
  let modeStartedAt = 0;
  let panLast = { x: 0, y: 0 };
  let lastErase: { x: number; y: number } | null = null;
  /** Active touch points (client coordinates), for two-finger pan/pinch. */
  const touches = new Map<number, { x: number; y: number }>();
  let pinch: { dist: number; zoom: number; wx: number; wy: number } | null = null;
  let spaceDown = false;
  let lastTap: { t: number; x: number; y: number } | null = null;
  /** Your last tiny stroke (a tap), removed again if the tap turns out to be a double-tap on text. */
  let lastDot: { id: string; at: number } | null = null;

  function startPinch() {
    const [a, b] = [...touches.values()];
    const r = canvas.getBoundingClientRect();
    const mx = (a.x + b.x) / 2 - r.left;
    const my = (a.y + b.y) / 2 - r.top;
    pinch = { dist: Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1), zoom, wx: camX + mx / zoom, wy: camY + my / zoom };
    mode = 'pinch';
    activeId = null;
  }

  function updatePinch() {
    if (!pinch || touches.size < 2) return;
    const [a, b] = [...touches.values()];
    const r = canvas.getBoundingClientRect();
    const mx = (a.x + b.x) / 2 - r.left;
    const my = (a.y + b.y) / 2 - r.top;
    zoom = clamp((pinch.zoom * Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1)) / pinch.dist, MIN_ZOOM, MAX_ZOOM);
    camX = pinch.wx - mx / zoom;
    camY = pinch.wy - my / zoom;
    clampCam();
  }

  function strokeWidth(): number {
    const w = SIZES[sizeIndex].px / zoom;
    return Math.round(clamp(w, 0.25, WORLD.maxWidth) * 100) / 100;
  }

  function onPointerDown(e: PointerEvent) {
    canvas.focus({ preventScroll: true });
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) {
        // A second finger turns a fresh touch action into a pinch. It never takes over a stroke
        // that is well under way, and never interrupts a pen or mouse.
        const fresh = performance.now() - modeStartedAt < 250;
        if (mode === 'idle' || (activeType === 'touch' && (mode === 'pan' || fresh))) {
          if (mode === 'draw' && sender) {
            cancelStroke(sender);
            sender = null;
          }
          startPinch();
        }
        return;
      }
      if (touches.size > 2) return;
    }
    if (mode !== 'idle') return; // one active pointer at a time (palms, extra fingers are ignored)
    if (editing) {
      finishEditing(); // clicking outside the box finishes editing (and does nothing else)
      return;
    }

    const middle = e.pointerType === 'mouse' && e.button === 1;
    const penEraser = e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32) !== 0);
    if (e.button !== 0 && !middle && !penEraser) return;
    const p = toWorld(e.clientX, e.clientY);

    // Double-click / double-tap on a text box edits it, whatever the tool.
    const now = performance.now();
    const isDouble = !!lastTap && now - lastTap.t < 400 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 20;
    lastTap = isDouble ? null : { t: now, x: e.clientX, y: e.clientY };
    if (isDouble && !middle && tool !== 'eraser' && !penEraser) {
      const hit = textAt(p.x, p.y, 6 / zoom);
      if (hit) {
        e.preventDefault();
        if (lastDot && now - lastDot.at < 800) removeItems([lastDot.id]);
        lastDot = null;
        beginEditing(hit.id);
        return;
      }
    }

    activeId = e.pointerId;
    activeType = e.pointerType;
    modeStartedAt = now;

    if (middle || spaceDown || tool === 'hand') {
      e.preventDefault();
      mode = 'pan';
      panLast = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (tool === 'text' && !penEraser) {
      e.preventDefault();
      activeId = null;
      const hit = textAt(p.x, p.y, 6 / zoom);
      if (hit) beginEditing(hit.id);
      else beginDraft(p.x, p.y);
      return;
    }
    canvas.setPointerCapture(e.pointerId);
    if (tool === 'eraser' || penEraser) {
      mode = 'erase';
      lastErase = p;
      eraseAt(p.x, p.y, ERASER_PX / zoom);
      return;
    }
    const s = startStroke({ color, width: strokeWidth(), tool: tool === 'highlighter' ? 'highlighter' : 'pen' });
    if (!s) {
      activeId = null;
      return;
    }
    sender = s;
    mode = 'draw';
    addPoint(sender, p.x, p.y);
  }

  function eraseAlong(p: { x: number; y: number }) {
    const r = ERASER_PX / zoom;
    const from = lastErase ?? p;
    const steps = Math.min(Math.ceil(Math.hypot(p.x - from.x, p.y - from.y) / r), 40);
    for (let i = 1; i <= steps; i++) {
      eraseAt(from.x + ((p.x - from.x) * i) / steps, from.y + ((p.y - from.y) * i) / steps, r);
    }
    if (steps === 0) eraseAt(p.x, p.y, r);
    lastErase = p;
  }

  function onPointerMove(e: PointerEvent) {
    if (e.pointerType === 'touch' && touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (mode === 'pinch') {
      updatePinch();
      return;
    }
    if (e.pointerId !== activeId) return;
    if (mode === 'pan') {
      camX -= (e.clientX - panLast.x) / zoom;
      camY -= (e.clientY - panLast.y) / zoom;
      clampCam();
      panLast = { x: e.clientX, y: e.clientY };
      return;
    }
    // Use coalesced events for smooth lines on fast movement.
    const events = (e.getCoalescedEvents?.() ?? []).length ? e.getCoalescedEvents() : [e];
    for (const ev of events) {
      const p = toWorld(ev.clientX, ev.clientY);
      if (mode === 'erase') eraseAlong(p);
      else if (mode === 'draw' && sender) addPoint(sender, p.x, p.y);
    }
  }

  function onPointerUp(e: PointerEvent) {
    touches.delete(e.pointerId);
    if (mode === 'pinch') {
      if (touches.size < 2) {
        mode = 'idle';
        pinch = null;
      }
      return;
    }
    if (e.pointerId !== activeId) return;
    if (mode === 'draw' && sender) {
      const s = sender;
      finishStroke(s);
      const quick = performance.now() - modeStartedAt < 300;
      lastDot = quick && s.stroke.points.length <= 6 && s.stroke.points.length > 0 ? { id: s.stroke.id, at: performance.now() } : null;
    }
    sender = null;
    lastErase = null;
    mode = 'idle';
    activeId = null;
  }

  // ── Text boxes ──
  interface Editing extends TextFields {
    id: string;
    /** False until the first non-empty save (a new box isn't sent while it's empty). */
    created: boolean;
    seenV: number;
    seenEditor: string;
  }
  let editing: Editing | null = null;
  /** Local edits not yet sent. */
  let dirty = false;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  function beginDraft(x: number, y: number) {
    const size = textSize;
    editing = {
      id: newStrokeId(localPeerId()),
      created: false,
      text: '',
      color,
      size,
      boxWidth: BOX_DEFAULT_WIDTH,
      x: Math.round(x),
      // Put the first line's middle where you clicked.
      y: Math.round(y - (size * 1.35) / 2),
      seenV: 0,
      seenEditor: '',
    };
    dirty = false;
  }

  function beginEditing(id: string) {
    const item = board.strokes.get(id);
    if (!item || item.text === undefined) return;
    editing = {
      id,
      created: true,
      text: item.text,
      color: item.color,
      size: item.width,
      boxWidth: item.boxWidth ?? BOX_DEFAULT_WIDTH,
      x: item.points[0],
      y: item.points[1],
      seenV: item.v ?? 0,
      seenEditor: item.editor ?? item.author,
    };
    dirty = false;
    requestDraw();
  }

  function fieldsOf(e: Editing): TextFields {
    return { text: e.text, color: e.color, size: e.size, boxWidth: e.boxWidth, x: e.x, y: e.y };
  }

  function scheduleSave() {
    dirty = true;
    if (!saveTimer) saveTimer = setTimeout(flushSave, SAVE_INTERVAL_MS);
  }

  function flushSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    if (!editing || !dirty) return;
    const e = editing;
    if (e.text.trim()) {
      if (!e.created) {
        if (createText(e.id, fieldsOf(e))) e.created = true;
      } else {
        saveText(e.id, fieldsOf(e));
      }
    }
    const item = board.strokes.get(e.id);
    if (item) {
      e.seenV = item.v ?? 0;
      e.seenEditor = item.editor ?? item.author;
    }
    dirty = false;
  }

  function finishEditing() {
    if (!editing) return;
    flushSave();
    const e = editing;
    editing = null;
    if (e.created && !e.text.trim()) removeItems([e.id]); // emptied box: delete it
    requestDraw();
  }

  function onEditorChange(change: TextChange) {
    if (!editing) return;
    editing = { ...editing, ...change };
    if (change.size !== undefined) textSize = change.size;
    scheduleSave();
  }

  function onEditorMove(dx: number, dy: number) {
    if (!editing) return;
    editing = { ...editing, x: Math.round(editing.x + dx / zoom), y: Math.round(editing.y + dy / zoom) };
    scheduleSave();
  }

  /** Board changed (possibly by someone else): redraw, and follow remote edits of the box being edited. */
  function onBoardChanged() {
    requestDraw();
    if (!editing?.created) return;
    const item = board.strokes.get(editing.id);
    if (!item || item.text === undefined) {
      editing = null;
      dirty = false;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = null;
      showNotice('The text box you were editing was removed.');
      return;
    }
    const v = item.v ?? 0;
    const ed = item.editor ?? item.author;
    if (v === editing.seenV && ed === editing.seenEditor) return;
    // Someone else saved a newer version. Take it unless you have unsent changes (your next save
    // gets a higher version and wins).
    editing.seenV = v;
    editing.seenEditor = ed;
    if (!dirty) {
      editing = {
        ...editing,
        text: item.text,
        color: item.color,
        size: item.width,
        boxWidth: item.boxWidth ?? BOX_DEFAULT_WIDTH,
        x: item.points[0],
        y: item.points[1],
      };
    }
  }

  // ── Keyboard ──
  function isTyping(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && !!target.closest('input, textarea, select, [contenteditable="true"]');
  }

  function onKeydown(e: KeyboardEvent) {
    if (editing || isTyping(e.target)) return;
    if (e.key === ' ' && (e.target === canvas || e.target === document.body)) {
      e.preventDefault();
      spaceDown = true;
      return;
    }
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undoLast();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key.toLowerCase()) {
      case 'p':
        tool = 'pen';
        break;
      case 'm':
        tool = 'highlighter';
        break;
      case 't':
        tool = 'text';
        break;
      case 'e':
        tool = 'eraser';
        break;
      case 'h':
        tool = 'hand';
        break;
      case '+':
      case '=':
        zoomBy(1.25);
        break;
      case '-':
      case '_':
        zoomBy(1 / 1.25);
        break;
      case '0':
        resetZoom();
        break;
      case '1':
        fitContent();
        break;
    }
  }

  function onKeyup(e: KeyboardEvent) {
    if (e.key === ' ') spaceDown = false;
  }

  function onWindowClick(e: MouseEvent) {
    if (exportOpen && exportMenu && !exportMenu.contains(e.target as Node)) exportOpen = false;
  }

  async function doExport(kind: 'png' | 'pdf' | 'docx') {
    exportOpen = false;
    flushSave();
    exporting = true;
    try {
      if (kind === 'pdf') await exportPdf(board);
      else if (kind === 'docx') await exportDocx(board);
      else await exportPng(board);
    } catch {
      showNotice('Export failed. The board may be too large for this browser.');
    } finally {
      exporting = false;
    }
  }

  function handleUndo() {
    finishEditing();
    undoLast();
  }

  function handleClear() {
    if (!confirmingClear) {
      confirmingClear = true;
      setTimeout(() => (confirmingClear = false), 3000);
      return;
    }
    confirmingClear = false;
    finishEditing();
    clearAll();
  }

  $: zoomPct = Math.round(zoom * 100);
  $: panning = mode === 'pan';
  $: status = notice || $boardStatus;
</script>

<svelte:window
  on:keydown={onKeydown}
  on:keyup={onKeyup}
  on:blur={() => (spaceDown = false)}
  on:click={onWindowClick}
/>

<section class="whiteboard" aria-label="Shared whiteboard">
  <div class="toolbar" role="toolbar" aria-label="Whiteboard tools">
    <div class="group" role="group" aria-label="Tool">
      {#each TOOLS as t}
        <button
          class="tool"
          class:active={tool === t.id}
          on:click={() => (tool = t.id)}
          title="{t.label} ({t.key})"
          aria-label={t.label}
          aria-keyshortcuts={t.key}
          aria-pressed={tool === t.id}
        >
          <Icon name={t.icon} size={18} />
        </button>
      {/each}
    </div>

    <div class="group" role="group" aria-label="Color">
      {#each COLORS as c}
        <button
          class="swatch"
          class:active={color === c}
          style="--swatch: {c}"
          on:click={() => {
            color = c;
            if (tool === 'eraser' || tool === 'hand') tool = 'pen';
          }}
          title="Color {c}"
          aria-label="Color {c}"
          aria-pressed={color === c}
        ></button>
      {/each}
    </div>

    <div class="group" role="group" aria-label="Stroke size">
      {#each SIZES as s, i}
        <button
          class="tool size"
          class:active={sizeIndex === i}
          on:click={() => (sizeIndex = i)}
          title="Stroke size {s.label}"
          aria-label="Stroke size {s.label}"
          aria-pressed={sizeIndex === i}
        >
          <span class="dot" style="--d: {5 + i * 4}px" aria-hidden="true"></span>
        </button>
      {/each}
    </div>

    <div class="group" role="group" aria-label="Edit">
      <button class="tool" on:click={handleUndo} title="Undo your last mark (Ctrl/Cmd+Z)" aria-label="Undo" aria-keyshortcuts="Control+Z Meta+Z">
        <Icon name="undo" size={18} />
      </button>
      <button
        class="tool"
        class:danger={confirmingClear}
        on:click={handleClear}
        title="Clear the board for everyone"
        aria-label={confirmingClear ? 'Clear for everyone?' : 'Clear'}
      >
        <Icon name="trash" size={18} />
        {#if confirmingClear}<span class="confirm">Clear for everyone?</span>{/if}
      </button>
    </div>

    <div class="group end" role="group" aria-label="Export and close">
      <div class="menu-anchor" bind:this={exportMenu}>
        <button
          class="tool labeled"
          class:open={exportOpen}
          on:click={() => (exportOpen = !exportOpen)}
          disabled={exporting}
          title="Export the board"
          aria-haspopup="menu"
          aria-expanded={exportOpen}
        >
          <Icon name="download" size={16} /><span class="lbl">Export</span><Icon name="chevron-down" size={14} />
        </button>
        {#if exportOpen}
          <div class="menu" role="menu">
            <button class="menu-item" role="menuitem" on:click={() => doExport('pdf')} title="Download as PDF">
              <Icon name="file-text" size={16} /> PDF document
            </button>
            <button class="menu-item" role="menuitem" on:click={() => doExport('docx')} title="Download as an editable Word document (picture + text)">
              <Icon name="file-doc" size={16} /> Word document (.docx)
            </button>
            <button class="menu-item" role="menuitem" on:click={() => doExport('png')} title="Download as PNG image">
              <Icon name="image" size={16} /> PNG image
            </button>
          </div>
        {/if}
      </div>
      <button class="tool" on:click={() => dispatch('close')} title="Close whiteboard (stays shared)" aria-label="Close whiteboard">
        <Icon name="x" size={18} />
      </button>
    </div>
  </div>

  <div class="board-wrap" bind:this={wrap} style={gridStyle}>
    <canvas
      bind:this={canvas}
      class="board"
      class:text-cursor={tool === 'text'}
      class:erase-cursor={tool === 'eraser'}
      class:grab={tool === 'hand' || spaceDown}
      class:grabbing={panning}
      tabindex="-1"
      aria-label="Whiteboard canvas. Scroll to pan, Ctrl or Cmd plus scroll to zoom."
      on:pointerdown={onPointerDown}
      on:pointermove={onPointerMove}
      on:pointerup={onPointerUp}
      on:pointercancel={onPointerUp}
      on:contextmenu={(e) => {
        if (mode !== 'idle') e.preventDefault();
      }}
    ></canvas>

    {#if editing}
      <TextEditor
        text={editing.text}
        color={editing.color}
        size={editing.size}
        boxWidth={editing.boxWidth}
        {zoom}
        left={(editing.x - camX) * zoom}
        top={(editing.y - camY) * zoom}
        containerWidth={viewW}
        colors={COLORS}
        sizes={TEXT_SIZES}
        on:change={(e) => onEditorChange(e.detail)}
        on:move={(e) => onEditorMove(e.detail.dx, e.detail.dy)}
        on:finish={finishEditing}
      />
    {/if}

    <div class="zoom" role="group" aria-label="Zoom">
      <button class="zbtn" on:click={() => zoomBy(1 / 1.25)} title="Zoom out (-)" aria-label="Zoom out" aria-keyshortcuts="-">
        <Icon name="zoom-out" size={16} />
      </button>
      <button class="zbtn pct" on:click={resetZoom} title="Reset to 100% (0)" aria-label="Zoom {zoomPct}%, reset to 100%" aria-keyshortcuts="0">
        {zoomPct}%
      </button>
      <button class="zbtn" on:click={() => zoomBy(1.25)} title="Zoom in (+)" aria-label="Zoom in" aria-keyshortcuts="+">
        <Icon name="zoom-in" size={16} />
      </button>
      <button class="zbtn" on:click={fitContent} title="Fit to content (1)" aria-label="Fit to content" aria-keyshortcuts="1">
        <Icon name="fit" size={16} />
      </button>
    </div>

    <div class="status" role="status" aria-live="polite">
      {#if status}<span>{status}</span>{/if}
    </div>
  </div>
</section>

<style>
  .whiteboard {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-height: 0;
    gap: var(--space-2);
  }

  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1) 0;
    padding: var(--space-1) var(--space-2);
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
    min-width: 0;
  }

  .group {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 var(--space-2);
    position: relative;
  }

  .group + .group::before {
    content: '';
    position: absolute;
    left: 0;
    top: 50%;
    height: 20px;
    transform: translateY(-50%);
    border-left: 1px solid var(--border);
  }

  .group:first-child {
    padding-left: 0;
  }

  .group.end {
    margin-left: auto;
    padding-right: 0;
  }

  .tool {
    min-width: 34px;
    height: 34px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.3rem;
    padding: 0 0.45rem;
    border-radius: var(--radius-sm);
    border: 1px solid transparent;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    font: inherit;
    font-size: var(--text-sm);
    font-weight: 600;
    transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
  }

  .tool:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--text);
  }

  .tool:focus-visible,
  .swatch:focus-visible,
  .menu-item:focus-visible,
  .zbtn:focus-visible {
    outline: 2px solid var(--accent-ring);
    outline-offset: 1px;
  }

  .tool.active {
    background: var(--accent-soft);
    color: var(--accent);
    border-color: var(--accent-ring);
  }

  .tool.danger {
    background: var(--danger-soft);
    color: var(--danger);
    border-color: var(--danger);
  }

  .tool.open {
    background: var(--bg-active);
    color: var(--text);
  }

  .tool:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .confirm {
    font-size: var(--text-xs);
    white-space: nowrap;
  }

  .size {
    min-width: 30px;
  }

  .dot {
    width: var(--d);
    height: var(--d);
    border-radius: 50%;
    background: currentColor;
  }

  .swatch {
    width: 22px;
    height: 22px;
    margin: 0 2px;
    padding: 0;
    border-radius: 50%;
    border: 2px solid var(--bg-surface);
    box-shadow: 0 0 0 1px var(--border-strong);
    background: var(--swatch);
    cursor: pointer;
    transition: transform var(--dur-fast) var(--ease);
  }

  .swatch:hover {
    transform: scale(1.1);
  }

  .swatch.active {
    box-shadow: 0 0 0 2px var(--accent);
  }

  .menu-anchor {
    position: relative;
  }

  .menu {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 10;
    min-width: 200px;
    display: flex;
    flex-direction: column;
    padding: var(--space-1);
    background: var(--bg-overlay);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-lg);
  }

  .menu-item {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    height: 36px;
    padding: 0 var(--space-3);
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: var(--text-sm);
    cursor: pointer;
    text-align: left;
    white-space: nowrap;
  }

  .menu-item:hover {
    background: var(--bg-hover);
  }

  @media (max-width: 480px) {
    .lbl {
      display: none;
    }

    .group {
      padding: 0 var(--space-1);
    }

    .swatch {
      margin: 0 1px;
    }
  }

  .board-wrap {
    position: relative;
    flex: 1;
    min-height: 0;
    border-radius: var(--radius-lg);
    border: 1px solid var(--border-subtle);
    /* The board itself is always a clean white surface (what exports look like). */
    background-color: #ffffff;
    background-image: radial-gradient(circle, #d3d7df 1px, transparent 1.3px);
    overflow: hidden;
    touch-action: none;
  }

  .board {
    width: 100%;
    height: 100%;
    display: block;
    touch-action: none;
    cursor: crosshair;
    outline: none;
  }

  .board:focus-visible {
    box-shadow: inset 0 0 0 2px var(--accent-ring);
  }

  .board.text-cursor {
    cursor: text;
  }

  .board.erase-cursor {
    cursor: cell;
  }

  .board.grab {
    cursor: grab;
  }

  .board.grabbing {
    cursor: grabbing;
  }

  .zoom {
    position: absolute;
    right: var(--space-2);
    bottom: var(--space-2);
    z-index: 4;
    display: flex;
    align-items: center;
    gap: 1px;
    padding: 3px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-sm);
  }

  .zbtn {
    min-width: 30px;
    height: 30px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 0.3rem;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: var(--text-xs);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
  }

  .zbtn.pct {
    min-width: 48px;
  }

  .zbtn:hover {
    background: var(--bg-hover);
    color: var(--text);
  }

  .status {
    position: absolute;
    left: var(--space-2);
    bottom: var(--space-2);
    max-width: calc(100% - 200px);
    z-index: 4;
    pointer-events: none;
  }

  .status span {
    display: inline-block;
    padding: 6px 10px;
    border-radius: var(--radius);
    background: var(--bg-overlay);
    border: 1px solid var(--border);
    color: var(--text);
    font-size: var(--text-xs);
    box-shadow: var(--shadow-sm);
  }

  @media (max-width: 480px) {
    .status {
      bottom: 52px;
      max-width: calc(100% - 16px);
    }
  }
</style>
