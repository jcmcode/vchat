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

test('tuneSender skips senders that are not negotiated yet, and unchanged settings', async () => {
  const empty = fakeSender({ encodings: [] });
  await tuneSender(empty.sender, cameraTarget(1, false));
  assert.equal(empty.calls.length, 0);

  const f = fakeSender();
  await tuneSender(f.sender, cameraTarget(3, false), { width: 1280, height: 720 });
  await tuneSender(f.sender, cameraTarget(3, false), { width: 1280, height: 720 });
  assert.equal(f.calls.length, 1);
});

test('tuneSender drops degradationPreference when the browser refuses it, and remembers that', async () => {
  const f = fakeSender({ refuse: (p) => 'degradationPreference' in p });
  await tuneSender(f.sender, screenTarget(4), { width: 1920, height: 1080 });
  assert.equal(f.calls.length, 1);
  assert.equal(firstEncoding(f.current()).priority, 'high', 'the other fields still apply');
  assert.equal(f.current().degradationPreference, undefined);
  const before = f.attempts();
  await tuneSender(f.sender, screenTarget(4), { width: 1920, height: 1080 });
  assert.equal(f.attempts(), before, 'nothing left to change: no more attempts');
});

test('tuneSender falls back to the basic fields when the browser refuses the others', async () => {
  const f = fakeSender({ refuse: (p) => firstEncoding(p).priority !== undefined });
  await tuneSender(f.sender, screenTarget(4), { width: 1920, height: 1080 });
  assert.equal(f.calls.length, 1);
  const enc = firstEncoding(f.current());
  assert.equal(enc.maxBitrate, screenTarget(4).maxBitrate);
  assert.equal(enc.scaleResolutionDownBy, 1);
  assert.equal(enc.priority, undefined);
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
