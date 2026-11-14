import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAMERA_MAX_BPS,
  cameraTarget,
  encodingFor,
  scaleDownBy,
  screenTarget,
  tuneSender,
  type TunableSender,
} from './quality.js';

const PEERS = [1, 2, 3, 4, 5];

test('one peer gets about full camera quality', () => {
  const t = cameraTarget(1, false);
  assert.equal(t.maxBitrate, CAMERA_MAX_BPS);
  assert.equal(t.maxLines, 720);
  assert.equal(t.maxFramerate, 30);
  assert.equal(t.maintainResolution, false);
});

test('camera bitrate per peer goes down as the call grows, total upload stays near 3-4 Mbps', () => {
  let previous = Infinity;
  for (const n of PEERS) {
    const t = cameraTarget(n, false);
    assert.ok(t.maxBitrate <= previous, `per-peer bitrate must not grow (n=${n})`);
    previous = t.maxBitrate;
    assert.ok(t.maxBitrate * n <= 4_000_000, `total too high at n=${n}`);
  }
  const five = cameraTarget(5, false);
  assert.ok(five.maxBitrate * 5 >= 3_000_000 && five.maxBitrate * 5 <= 4_000_000);
  assert.ok(five.maxLines < 720, 'resolution comes down too (less to encode five times)');
});

test('while presenting, the screen gets priority and most of the budget', () => {
  for (const n of PEERS) {
    const camera = cameraTarget(n, true);
    const screen = screenTarget(n);
    assert.ok(screen.maxBitrate > camera.maxBitrate, `n=${n}`);
    assert.equal(screen.priority, 'high');
    assert.equal(camera.priority, 'low');
    assert.equal(screen.maintainResolution, true);
    assert.ok((screen.maxBitrate + camera.maxBitrate) * n <= 4_000_000, `total too high at n=${n}`);
    assert.ok(camera.maxBitrate <= cameraTarget(n, false).maxBitrate);
  }
});

test('the screen gets the whole budget when no camera goes out with it', () => {
  assert.ok(screenTarget(5, false).maxBitrate > screenTarget(5, true).maxBitrate);
  assert.ok(screenTarget(5, false).maxBitrate * 5 <= 4_000_000);
});

test('odd peer counts are treated as one peer', () => {
  for (const n of [0, -3, NaN, Infinity, 0.5]) {
    assert.deepEqual(cameraTarget(n, false), cameraTarget(1, false));
    assert.deepEqual(screenTarget(n), screenTarget(1));
  }
  assert.deepEqual(cameraTarget(2.9, false), cameraTarget(2, false));
});

test('scaleDownBy fits the shorter side and never scales up', () => {
  assert.equal(scaleDownBy({ width: 1280, height: 720 }, 720), 1);
  assert.equal(scaleDownBy({ width: 1280, height: 720 }, 480), 1.5);
  assert.equal(scaleDownBy({ width: 720, height: 1280 }, 480), 1.5); // portrait phone camera
  assert.equal(scaleDownBy({ width: 640, height: 480 }, 720), 1);
  assert.equal(scaleDownBy({ width: 3840, height: 2160 }, 1080), 2);
  assert.equal(scaleDownBy(undefined, 480), 1);
  assert.equal(scaleDownBy({}, 480), 1);
  assert.equal(scaleDownBy({ width: 1280, height: 720 }, 0), 1);
  assert.equal(scaleDownBy({ width: -5, height: NaN }, 480), 1);
});

test('encodingFor', () => {
  const e = encodingFor(cameraTarget(5, false), { width: 1280, height: 720 });
  assert.equal(e.scaleResolutionDownBy, 1.5);
  assert.equal(e.priority, 'low');
  assert.equal(e.networkPriority, 'low');
});

// ── tuneSender ──────────────────────────────────────────────────────────────────

interface FakeOptions {
  encodings?: Record<string, unknown>[];
  /** Refuse parameter sets this matches (like a browser that doesn't support some field). */
  refuse?: (params: Record<string, unknown>) => boolean;
  getThrows?: boolean;
  setThrowsSync?: boolean;
  delayMs?: number;
}

function fakeSender(opts: FakeOptions = {}) {
  let params: Record<string, unknown> = { transactionId: 't0', encodings: opts.encodings ?? [{ active: true }] };
  let tx = 0;
  let inFlight = 0;
  const calls: Record<string, unknown>[] = [];
  let attempts = 0;
  let maxConcurrent = 0;
  const sender: TunableSender = {
    getParameters() {
      if (opts.getThrows) throw new Error('closed');
      return JSON.parse(JSON.stringify({ ...params, transactionId: `t${++tx}` }));
    },
    async setParameters(p: never) {
      if (opts.setThrowsSync) throw new Error('sync');
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      try {
        attempts++;
        await new Promise((r) => setTimeout(r, opts.delayMs ?? 1));
        const next = p as unknown as Record<string, unknown>;
        if (opts.refuse?.(next)) throw new DOMException('unsupported', 'InvalidModificationError');
        calls.push(next);
        params = next;
      } finally {
        inFlight--;
      }
    },
  };
  return { sender, calls, current: () => params, maxConcurrent: () => maxConcurrent, attempts: () => attempts };
}

const firstEncoding = (p: Record<string, unknown>) => (p.encodings as Record<string, unknown>[])[0];

test('tuneSender applies the target', async () => {
  const f = fakeSender();
  await tuneSender(f.sender, screenTarget(2), { width: 3840, height: 2160 });
  assert.equal(f.calls.length, 1);
  const enc = (f.current().encodings as Record<string, unknown>[])[0];
  assert.equal(enc.maxBitrate, screenTarget(2).maxBitrate);
  assert.equal(enc.scaleResolutionDownBy, 2);
  assert.equal(enc.priority, 'high');
  assert.equal(enc.active, true, 'other fields are kept');
  assert.equal(f.current().degradationPreference, 'maintain-resolution');
});

test('tuneSender skips senders without parameters, and unchanged settings', async () => {
  const none = { getParameters: () => ({}), setParameters: () => Promise.reject(new Error('unexpected')) } as unknown as TunableSender;
  await tuneSender(none, cameraTarget(1, false));

  const f = fakeSender();
  await tuneSender(f.sender, cameraTarget(3, false), { width: 1280, height: 720 });
  await tuneSender(f.sender, cameraTarget(3, false), { width: 1280, height: 720 });
  assert.equal(f.calls.length, 1);
});

test('tuneSender drops only degradationPreference when the browser refuses it, and remembers that', async () => {
  const f = fakeSender({ refuse: (p) => 'degradationPreference' in p });
  await tuneSender(f.sender, screenTarget(4), { width: 1920, height: 1080 });
  const enc = firstEncoding(f.current());
  assert.equal(enc.priority, 'high', 'the other fields still apply');
  assert.equal(enc.networkPriority, 'high');
  assert.equal(enc.maxFramerate, screenTarget(4).maxFramerate);
  assert.equal(f.current().degradationPreference, undefined);
  const before = f.attempts();
  await tuneSender(f.sender, screenTarget(4), { width: 1920, height: 1080 });
  assert.equal(f.attempts(), before, 'nothing left to change: no more attempts');
  // A new target is applied in one go, without the refused field.
  await tuneSender(f.sender, screenTarget(2), { width: 1920, height: 1080 });
  assert.equal(f.attempts(), before + 1);
  assert.equal(firstEncoding(f.current()).maxBitrate, screenTarget(2).maxBitrate);
});

test('one refused field does not drop the others', async () => {
  const f = fakeSender({ refuse: (p) => firstEncoding(p).priority !== undefined });
  await tuneSender(f.sender, screenTarget(4), { width: 3840, height: 2160 });
  const enc = firstEncoding(f.current());
  assert.equal(enc.maxBitrate, screenTarget(4).maxBitrate);
  assert.equal(enc.scaleResolutionDownBy, 2);
  assert.equal(enc.maxFramerate, screenTarget(4).maxFramerate);
  assert.equal(enc.networkPriority, 'high');
  assert.equal(enc.priority, undefined);
  assert.equal(f.current().degradationPreference, 'maintain-resolution');
});

test('tuneSender falls back to the bitrate alone if even the resolution scale is refused', async () => {
  const f = fakeSender({ refuse: (p) => firstEncoding(p).scaleResolutionDownBy !== undefined });
  await tuneSender(f.sender, cameraTarget(5, false), { width: 1280, height: 720 });
  const enc = firstEncoding(f.current());
  assert.equal(enc.maxBitrate, cameraTarget(5, false).maxBitrate);
  assert.equal(enc.scaleResolutionDownBy, undefined);
});

test('tuneSender offers an encoding to browsers that report none', async () => {
  const f = fakeSender({ encodings: [] });
  await tuneSender(f.sender, cameraTarget(5, false), { width: 1280, height: 720 });
  assert.equal(f.calls.length, 1);
  assert.equal((f.current().encodings as unknown[]).length, 1);
  assert.equal(firstEncoding(f.current()).maxBitrate, cameraTarget(5, false).maxBitrate);

  // A browser that refuses the offered encoding isn't probed field by field.
  const refusing = fakeSender({ encodings: [], refuse: () => true });
  await tuneSender(refusing.sender, cameraTarget(5, false), { width: 1280, height: 720 });
  assert.equal(refusing.attempts(), 1);
});

test('tuneSender never throws', async () => {
  await tuneSender(fakeSender({ getThrows: true }).sender, cameraTarget(2, false));
  await tuneSender(fakeSender({ setThrowsSync: true }).sender, cameraTarget(2, false));
  const broken = { getParameters: () => null, setParameters: () => Promise.reject(new Error('x')) } as unknown as TunableSender;
  await tuneSender(broken, cameraTarget(2, false));
});

test('tuneSender runs one change at a time per sender and ends on the latest target', async () => {
  const f = fakeSender({ delayMs: 5 });
  const size = { width: 1280, height: 720 };
  const runs = [1, 2, 3, 4, 5].map((n) => tuneSender(f.sender, cameraTarget(n, false), size));
  await Promise.all(runs);
  assert.equal(f.maxConcurrent(), 1);
  assert.ok(f.calls.length <= 2, 'intermediate targets are skipped');
  const enc = (f.current().encodings as Record<string, unknown>[])[0];
  assert.equal(enc.maxBitrate, cameraTarget(5, false).maxBitrate);
  // A later change after the queue drained still applies.
  await tuneSender(f.sender, cameraTarget(1, false), size);
  assert.equal((f.current().encodings as Record<string, unknown>[])[0].maxBitrate, cameraTarget(1, false).maxBitrate);
});

// ── Per-viewer camera size ─────────────────────────────────────────────────────

test('view messages are validated strictly', async () => {
  const { parseView } = await import('./quality.js');
  assert.deepEqual(parseView({ type: 'view', w: 640, h: 360, fit: 'cover' }), { kind: 'box', w: 640, h: 360, fit: 'cover' });
  assert.deepEqual(parseView({ type: 'view', w: 0, h: 0 }), { kind: 'none' });
  assert.deepEqual(parseView({ type: 'view', full: true, w: 'x' }), { kind: 'full' });
  for (const bad of [
    null,
    'view',
    { w: 640, h: 360 }, // no fit
    { w: 640, h: 360, fit: 'stretch' },
    { w: -1, h: 360, fit: 'cover' },
    { w: 1.5, h: 360, fit: 'cover' },
    { w: 99_999, h: 360, fit: 'cover' },
    { w: '640', h: 360, fit: 'cover' },
    { full: 'yes' },
  ]) {
    assert.equal(parseView(bad), null, JSON.stringify(bad));
  }
});

test('lines needed for a viewer box depend on how it fits and on the source shape', async () => {
  const { linesForView } = await import('./quality.js');
  const hd = { width: 1280, height: 720 };
  assert.equal(linesForView({ w: 640, h: 360, fit: 'cover' }, hd), 360);
  // A strip thumbnail (232x145 CSS px at 2x): cover fills the box, so the height decides.
  assert.equal(linesForView({ w: 464, h: 290, fit: 'cover' }, hd), 290);
  assert.equal(linesForView({ w: 464, h: 290, fit: 'contain' }, hd), 261);
  // A portrait phone camera in a landscape tile: filling the width needs more lines.
  assert.equal(linesForView({ w: 464, h: 290, fit: 'cover' }, { width: 720, height: 1280 }), 464);
  // Unknown source size counts as 1280x720.
  assert.equal(linesForView({ w: 640, h: 360, fit: 'cover' }), 360);
});

test('each viewer gets the camera no bigger than it shows it, and never more than its share', async () => {
  const { cameraForViewer, HIDDEN_VIEW, VIEW_LINE_STEPS } = await import('./quality.js');
  const hd = { width: 1280, height: 720 };
  const base = cameraTarget(1, false); // 720 lines, 2.5 Mbps
  assert.equal(base.maxLines, 720);

  // No information (older version) or an unmeasurable window: unchanged.
  assert.deepEqual(cameraForViewer(base, undefined, hd), base);
  assert.deepEqual(cameraForViewer(base, { kind: 'full' }, hd), base);
  // Big enough tile: unchanged.
  assert.deepEqual(cameraForViewer(base, { kind: 'box', w: 2560, h: 1440, fit: 'cover' }, hd), base);

  // A thumbnail: snapped up to a step, bitrate down with it.
  const thumb = cameraForViewer(base, { kind: 'box', w: 464, h: 290, fit: 'cover' }, hd);
  assert.equal(thumb.maxLines, 360);
  assert.ok(VIEW_LINE_STEPS.includes(thumb.maxLines));
  assert.ok(thumb.maxBitrate < base.maxBitrate / 2 && thumb.maxBitrate >= 150_000, String(thumb.maxBitrate));
  assert.equal(thumb.maxFramerate, base.maxFramerate);
  assert.equal(encodingFor(thumb, hd).scaleResolutionDownBy, 2);

  // Small changes in size land on the same step (no encoder churn while resizing).
  const a = cameraForViewer(base, { kind: 'box', w: 600, h: 338, fit: 'cover' }, hd);
  const b = cameraForViewer(base, { kind: 'box', w: 630, h: 354, fit: 'cover' }, hd);
  assert.deepEqual(a, b);

  // Not shown at all: a trickle.
  const hidden = cameraForViewer(base, { kind: 'none' }, hd);
  assert.equal(hidden.maxLines, HIDDEN_VIEW.maxLines);
  assert.equal(hidden.maxBitrate, HIDDEN_VIEW.maxBitrate);
  assert.equal(hidden.maxFramerate, HIDDEN_VIEW.maxFramerate);

  // Never above the base, in any respect, whatever the viewer claims.
  for (const peers of PEERS) {
    for (const presenting of [false, true]) {
      const share = cameraTarget(peers, presenting);
      for (const view of [
        { kind: 'box' as const, w: 16_384, h: 16_384, fit: 'cover' as const },
        { kind: 'box' as const, w: 1, h: 1, fit: 'contain' as const },
        { kind: 'box' as const, w: 800, h: 450, fit: 'contain' as const },
        { kind: 'none' as const },
      ]) {
        const t = cameraForViewer(share, view, hd);
        assert.ok(t.maxLines <= share.maxLines && t.maxBitrate <= share.maxBitrate && t.maxFramerate <= share.maxFramerate);
        assert.equal(t.priority, share.priority);
      }
    }
  }
});
