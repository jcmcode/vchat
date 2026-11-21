<script lang="ts">
  // Canvas over a shared screen: shows everyone's laser pointers and drawings, and lets you add
  // your own. Marks are positioned relative to the screen content (letterboxing ignored), so they
  // land on the same spot for every viewer.
  import { onDestroy, onMount } from 'svelte';
  import Icon from '$lib/ui/Icon.svelte';
  import {
    screens,
    annotationVersion,
    annotationTool,
    setAnnotationToolsVisible,
    movePointer,
    hidePointer,
    startAnnotation,
    addAnnotationPoint,
    finishAnnotation,
    undoAnnotation,
    clearAnnotations,
    POINTER_TTL_MS,
  } from '$lib/collab/annotations';
  import { drawPointer, drawStroke, fitRect, prepareCanvas, type SurfaceRect } from '$lib/collab/render';
  import type { StrokeSender } from '$lib/collab/stroke-sender';
  import { colorFor } from '$lib/collab/strokes';
  import { localPeerIdStore } from '$lib/webrtc/mesh';

  /** The <video> showing the shared screen (used for its aspect ratio). */
  export let videoEl: HTMLVideoElement | null = null;
  /** Peer id of the person sharing this screen. */
  export let screen: string;

  let canvas: HTMLCanvasElement;
  let rect: SurfaceRect = { x: 0, y: 0, width: 0, height: 0 };
  let sender: StrokeSender | null = null;
  let frame = 0;

  function aspect(): number {
    const w = videoEl?.videoWidth ?? 0;
    const h = videoEl?.videoHeight ?? 0;
    return w && h ? w / h : 16 / 9;
  }

  function requestDraw() {
    if (!frame) frame = requestAnimationFrame(draw);
  }

  function draw() {
    frame = 0;
    if (!canvas) return;
    const ctx = prepareCanvas(canvas);
    if (!ctx) return;
    rect = fitRect(canvas.clientWidth, canvas.clientHeight, aspect());
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    const state = screens.get(screen);
    if (!state) return;
    for (const stroke of state.board.strokes.values()) drawStroke(ctx, stroke, rect);

    const now = Date.now();
    let animating = false;
    for (const p of state.pointers.values()) {
      const age = now - p.at;
      if (age > POINTER_TTL_MS) continue;
      const fade = age < POINTER_TTL_MS - 400 ? 1 : (POINTER_TTL_MS - age) / 400;
      drawPointer(ctx, rect.x + p.x * rect.width, rect.y + p.y * rect.height, p.color, p.name, fade);
      animating = true;
    }
    if (animating) requestDraw(); // keep animating until pointers fade out
  }

  $: $annotationVersion, screen, requestDraw();

  // Redraw when the shared video's size becomes known or changes (the element arrives after mount).
  let detachVideo: (() => void) | null = null;
  $: {
    detachVideo?.();
    detachVideo = null;
    if (videoEl) {
      const el = videoEl;
      el.addEventListener('resize', requestDraw);
      el.addEventListener('loadedmetadata', requestDraw);
      detachVideo = () => {
        el.removeEventListener('resize', requestDraw);
        el.removeEventListener('loadedmetadata', requestDraw);
      };
      requestDraw();
    }
  }

  let resizeObserver: ResizeObserver;
  onMount(() => {
    resizeObserver = new ResizeObserver(requestDraw);
    resizeObserver.observe(canvas);

    requestDraw();
  });
  onDestroy(() => {
    resizeObserver?.disconnect();
    detachVideo?.();
    if (frame) cancelAnimationFrame(frame);
    if (sender) finishAnnotation(screen, sender);
    if (screens.get(screen)?.pointers.has($localPeerIdStore)) hidePointer(screen);
    annotationTool.set('none');
  });

  function toScreen(e: PointerEvent) {
    const r = canvas.getBoundingClientRect();
    // Map against the video's current shape (not a cached one), so marks land where you point.
    rect = fitRect(canvas.clientWidth, canvas.clientHeight, aspect());
    return {
      x: Math.min(Math.max((e.clientX - r.left - rect.x) / rect.width, 0), 1),
      y: Math.min(Math.max((e.clientY - r.top - rect.y) / rect.height, 0), 1),
    };
  }

  function onDown(e: PointerEvent) {
    if ($annotationTool !== 'pen' || e.button !== 0 || !e.isPrimary || sender) return;
    canvas.setPointerCapture(e.pointerId);
    const p = toScreen(e);
    sender = startAnnotation(screen);
    addAnnotationPoint(sender, p.x, p.y);
  }

  function onMove(e: PointerEvent) {
    const p = toScreen(e);
    if ($annotationTool === 'laser') movePointer(screen, p.x, p.y);
    else if (sender) addAnnotationPoint(sender, p.x, p.y);
  }

  function onUp() {
    if (sender) finishAnnotation(screen, sender);
    sender = null;
  }

  function onLeave() {
    if ($annotationTool === 'laser') hidePointer(screen);
  }

  function setTool(t: 'laser' | 'pen') {
    annotationTool.set($annotationTool === t ? 'none' : t);
  }
</script>

<canvas
  bind:this={canvas}
  class="annotation-canvas"
  class:interactive={$annotationTool !== 'none'}
  class:laser={$annotationTool === 'laser'}
  on:pointerdown={onDown}
  on:pointermove={onMove}
  on:pointerup={onUp}
  on:pointercancel={onUp}
  on:pointerleave={onLeave}
></canvas>

<div class="annotation-tools" role="toolbar" aria-label="Annotate shared screen">
  {#if $localPeerIdStore}
    <span class="me" style="--me: {colorFor($localPeerIdStore)}" title="Your annotation color" aria-hidden="true"></span>
  {/if}
  <button class:active={$annotationTool === 'laser'} on:click={() => setTool('laser')} title="Laser pointer" aria-label="Laser pointer" aria-pressed={$annotationTool === 'laser'}>
    <Icon name="laser" size={18} /><span class="label">Pointer</span>
  </button>
  <button class:active={$annotationTool === 'pen'} on:click={() => setTool('pen')} title="Draw on the screen" aria-label="Draw on the screen" aria-pressed={$annotationTool === 'pen'}>
    <Icon name="pen" size={18} /><span class="label">Draw</span>
  </button>
  <span class="sep" aria-hidden="true"></span>
  <button on:click={() => undoAnnotation(screen)} title="Undo your last drawing" aria-label="Undo your last drawing">
    <Icon name="undo" size={18} /><span class="label">Undo</span>
  </button>
  <button on:click={() => clearAnnotations(screen)} title="Clear all drawings for everyone" aria-label="Clear all drawings for everyone">
    <Icon name="trash" size={18} /><span class="label">Clear</span>
  </button>
  <span class="sep" aria-hidden="true"></span>
  <button on:click={() => setAnnotationToolsVisible(false)} title="Hide annotations (restore in Settings)" aria-label="Hide annotations">
    <Icon name="x" size={18} />
  </button>
</div>

<style>
  .annotation-canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    touch-action: none;
    z-index: 2;
  }

  .annotation-canvas.interactive {
    pointer-events: auto;
    cursor: crosshair;
  }

  .annotation-canvas.laser {
    cursor: none;
  }

  .annotation-tools {
    position: absolute;
    top: var(--space-2);
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 2px;
    max-width: calc(100% - var(--space-4));
    padding: 4px;
    background: color-mix(in srgb, var(--bg-surface) 78%, transparent);
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    box-shadow: var(--shadow-md);
    -webkit-backdrop-filter: blur(12px) saturate(1.4);
    backdrop-filter: blur(12px) saturate(1.4);
    z-index: 3;
  }

  .me {
    width: 10px;
    height: 10px;
    margin: 0 var(--space-2) 0 var(--space-2);
    border-radius: 50%;
    background: var(--me);
    box-shadow: 0 0 0 2px var(--bg-surface), 0 0 0 3px var(--border-strong);
    flex: none;
  }

  .sep {
    width: 1px;
    height: 18px;
    margin: 0 2px;
    background: var(--border);
    flex: none;
  }

  .annotation-tools button {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    height: 34px;
    min-width: 34px;
    padding: 0 0.7rem;
    justify-content: center;
    border-radius: var(--radius-pill);
    border: 1px solid transparent;
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: var(--text-sm);
    font-weight: 600;
    cursor: pointer;
    transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
  }

  .annotation-tools button:hover {
    background: var(--bg-hover);
    color: var(--text);
  }

  .annotation-tools button:focus-visible {
    outline: 2px solid var(--accent-ring);
    outline-offset: 1px;
  }

  .annotation-tools button.active {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-text);
  }

  @media (max-width: 600px) {
    .label {
      display: none;
    }

    .annotation-tools button {
      padding: 0;
      width: 38px;
    }
  }
</style>
