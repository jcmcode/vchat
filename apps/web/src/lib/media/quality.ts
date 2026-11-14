// Outgoing video quality for a full mesh.
//
// In a mesh every participant encodes and uploads a separate copy of their camera for each other
// person, so upload bandwidth (and encoder CPU) grows with the size of the call: left alone, a
// 6-person call has everyone uploading five full 720p streams. This policy keeps the total near
// UPLOAD_BUDGET_BPS by splitting it across the peers we send to, and lowers resolution and frame
// rate as each copy gets less bitrate. While presenting, the shared screen gets most of the budget
// and a higher priority than the camera, and keeps its resolution (text stays sharp, the frame
// rate gives way instead).
//
// `cameraTarget` / `screenTarget` / `encodingFor` are pure. `tuneSender` applies a target to an
// RTCRtpSender with getParameters/setParameters, one change at a time per sender, and never throws.

/** Rough total upload for video across all peers. */
export const UPLOAD_BUDGET_BPS = 3_500_000;
/** Camera with a single peer: about what browsers use for 720p by default. */
export const CAMERA_MAX_BPS = 2_500_000;
/** Camera while also sharing a screen (it's a small tile then). */
export const CAMERA_WHILE_PRESENTING_MAX_BPS = 500_000;
export const SCREEN_MAX_BPS = 2_500_000;
/** Part of the budget that goes to the screen while presenting. */
export const SCREEN_SHARE_OF_BUDGET = 0.75;
const CAMERA_MIN_BPS = 150_000;
const SCREEN_MIN_BPS = 300_000;
/** Shared screens are sent at up to 1080 lines (4K screens are scaled down). */
const SCREEN_MAX_LINES = 1080;

export type Priority = 'very-low' | 'low' | 'medium' | 'high';

export interface VideoTarget {
  /** Bits per second, per peer. */
  maxBitrate: number;
  maxFramerate: number;
  /** Most lines (the shorter side: 720 for 1280x720) to send; bigger sources are scaled down, never up. */
  maxLines: number;
  /** Relative share of the bandwidth when it runs short ("low" is the browser's default). */
  priority: Priority;
  /** Keep the resolution and drop frames under pressure (shared screens). */
  maintainResolution: boolean;
}

function clampPeers(peerCount: number): number {
  return Number.isFinite(peerCount) ? Math.max(1, Math.floor(peerCount)) : 1;
}

function cameraLinesFor(bps: number): number {
  if (bps >= 1_000_000) return 720;
  if (bps >= 500_000) return 480;
  if (bps >= 250_000) return 360;
  return 240;
}

/** Camera quality for each of `peerCount` peers (`presenting`: a screen is being shared too). */
export function cameraTarget(peerCount: number, presenting: boolean): VideoTarget {
  const n = clampPeers(peerCount);
  const budget = presenting ? UPLOAD_BUDGET_BPS * (1 - SCREEN_SHARE_OF_BUDGET) : UPLOAD_BUDGET_BPS;
  const cap = presenting ? CAMERA_WHILE_PRESENTING_MAX_BPS : CAMERA_MAX_BPS;
  const maxBitrate = Math.round(Math.max(CAMERA_MIN_BPS, Math.min(cap, budget / n)));
  return {
    maxBitrate,
    maxFramerate: maxBitrate >= 250_000 ? 30 : 15,
    maxLines: cameraLinesFor(maxBitrate),
    priority: 'low',
    maintainResolution: false,
  };
}

/** Shared-screen quality for each of `peerCount` peers (`withCamera`: the camera goes out too). */
export function screenTarget(peerCount: number, withCamera = true): VideoTarget {
  const n = clampPeers(peerCount);
  const budget = withCamera ? UPLOAD_BUDGET_BPS * SCREEN_SHARE_OF_BUDGET : UPLOAD_BUDGET_BPS;
  const maxBitrate = Math.round(Math.max(SCREEN_MIN_BPS, Math.min(SCREEN_MAX_BPS, budget / n)));
  return {
    maxBitrate,
    maxFramerate: maxBitrate >= 1_200_000 ? 30 : 15,
    maxLines: SCREEN_MAX_LINES,
    priority: 'high',
    maintainResolution: true,
  };
}

export interface SourceSize {
  width?: number;
  height?: number;
}

/** How much to scale a source down so its shorter side fits `maxLines` (1 = unchanged). */
export function scaleDownBy(source: SourceSize | undefined, maxLines: number): number {
  const sides = [source?.width, source?.height].filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
  if (sides.length === 0 || !(maxLines > 0)) return 1;
  const lines = Math.min(...sides);
  if (lines <= maxLines) return 1;
  return Math.round((lines / maxLines) * 100) / 100;
}

export interface EncodingSettings {
  maxBitrate: number;
  maxFramerate: number;
  scaleResolutionDownBy: number;
  priority: Priority;
  networkPriority: Priority;
}

/** The encoding parameters for `target`, given the size of the track being sent. */
export function encodingFor(target: VideoTarget, source?: SourceSize): EncodingSettings {
  return {
    maxBitrate: target.maxBitrate,
    maxFramerate: target.maxFramerate,
    scaleResolutionDownBy: scaleDownBy(source, target.maxLines),
    priority: target.priority,
    networkPriority: target.priority,
  };
}

// ── Per-viewer camera size ─────────────────────────────────────────────────────
//
// Each connection has its own encoder, so each copy of the camera can be just as big as the person
// receiving it actually shows it: a thumbnail in the strip (during a screen share, with the board
// open) doesn't need 720p, and a viewer whose tab is hidden doesn't need video at all. Viewers tell
// us how they show our camera (`view` messages, view-size.ts); a viewer can only ever lower what
// it receives, never raise it above its share of the upload budget.

/** How a viewer shows our camera, as it told us (sizes in device pixels). */
export type RemoteView =
  | { kind: 'box'; w: number; h: number; fit: 'cover' | 'contain' }
  /** Not on screen at all (their tab is hidden, or no tile of ours is showing). */
  | { kind: 'none' }
  /** Shown somewhere they can't measure (a system picture-in-picture window): no limit. */
  | { kind: 'full' };

const MAX_VIEW_SIDE = 16_384;

/** Validate a `view` message: `{full: true}`, `{w: 0, h: 0}` (not shown) or `{w, h, fit}`. */
export function parseView(msg: unknown): RemoteView | null {
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as Record<string, unknown>;
  if (m.full === true) return { kind: 'full' };
  const side = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_VIEW_SIDE;
  if (!side(m.w) || !side(m.h)) return null;
  if (m.w === 0 || m.h === 0) return { kind: 'none' };
  if (m.fit !== 'cover' && m.fit !== 'contain') return null;
  return { kind: 'box', w: m.w, h: m.h, fit: m.fit };
}

/** Sizes a viewer-sized camera snaps up to, so small resizes don't keep reconfiguring the encoder. */
export const VIEW_LINE_STEPS = [180, 240, 360, 480, 540, 720, 1080];
/** For a viewer that shows nothing: a trickle that costs next to nothing and resumes at once. */
export const HIDDEN_VIEW = { maxBitrate: 60_000, maxFramerate: 5, maxLines: 180 };

/**
 * Lines (the source's shorter side) needed to fill a viewer's box without upscaling: `cover` fills
 * the box (cropping), `contain` fits inside it. An unknown source size counts as 1280x720.
 */
export function linesForView(view: { w: number; h: number; fit: 'cover' | 'contain' }, source?: SourceSize): number {
  const okSide = (v: number | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
  const srcW = okSide(source?.width) && okSide(source?.height) ? source.width : 1280;
  const srcH = okSide(source?.width) && okSide(source?.height) ? source.height : 720;
  const k = view.fit === 'cover' ? Math.max(view.w / srcW, view.h / srcH) : Math.min(view.w / srcW, view.h / srcH);
  return Math.ceil(k * Math.min(srcW, srcH) - 1e-6); // (no rounding noise pushing 464.0000001 to 465)
}

/**
 * The camera target for one viewer: `base` (this peer's share of the upload budget), lowered to
 * what that viewer shows. Never more than `base` in any respect. The bitrate follows the size
 * (pixels^0.75: small pictures still need some bits per pixel to look clean).
 */
export function cameraForViewer(base: VideoTarget, view: RemoteView | undefined, source?: SourceSize): VideoTarget {
  if (!view || view.kind === 'full') return base;
  if (view.kind === 'none') {
    return {
      ...base,
      maxBitrate: Math.min(base.maxBitrate, HIDDEN_VIEW.maxBitrate),
      maxFramerate: Math.min(base.maxFramerate, HIDDEN_VIEW.maxFramerate),
      maxLines: Math.min(base.maxLines, HIDDEN_VIEW.maxLines),
    };
  }
  const needed = linesForView(view, source);
  const step = VIEW_LINE_STEPS.find((l) => l >= needed) ?? Infinity;
  if (step >= base.maxLines) return base;
  const maxBitrate = Math.round(Math.max(Math.min(CAMERA_MIN_BPS, base.maxBitrate), base.maxBitrate * (step / base.maxLines) ** 1.5));
  return { ...base, maxLines: step, maxBitrate };
}

// ── Applying it ────────────────────────────────────────────────────────────────

type Encoding = Partial<EncodingSettings> & Record<string, unknown>;
interface SendParameters {
  encodings?: Encoding[];
  degradationPreference?: string;
  [key: string]: unknown;
}

/** The parts of RTCRtpSender used here (so it can be tested without a browser). */
export interface TunableSender {
  getParameters(): unknown;
  setParameters(parameters: never): Promise<void>;
}

/** What we set: the encoding fields, plus degradationPreference (on the parameters) for screens. */
type Field = keyof EncodingSettings | 'degradationPreference';
/** Widely supported, tried first on their own when something is refused. */
const ESSENTIAL: Field[] = ['maxBitrate', 'scaleResolutionDownBy'];
/** Added one at a time, most useful first, when a browser refuses something. */
const OPTIONAL: Field[] = ['maxFramerate', 'degradationPreference', 'priority', 'networkPriority'];
const MAINTAIN_RESOLUTION = 'maintain-resolution';

/** Fields each sender's browser refused, so they aren't tried again on every change. */
const refusedFields = new WeakMap<TunableSender, Set<Field>>();

function matches(params: SendParameters & { encodings: Encoding[] }, wanted: EncodingSettings, fields: Field[]): boolean {
  return fields.every((f) => {
    if (f === 'degradationPreference') return params.degradationPreference === MAINTAIN_RESOLUTION;
    if (f === 'scaleResolutionDownBy') {
      return params.encodings.every((e) => Math.abs((Number(e.scaleResolutionDownBy) || 1) - wanted.scaleResolutionDownBy) < 0.01);
    }
    return params.encodings.every((e) => e[f] === wanted[f]);
  });
}

/**
 * The sender's parameters, or null if it has none (closed). Some browsers (older Firefox) report no
 * encodings at all; then we offer one (`seeded`), which they accept and others refuse.
 */
function readParameters(sender: TunableSender): { params: SendParameters & { encodings: Encoding[] }; seeded: boolean } | null {
  try {
    const params = sender.getParameters() as SendParameters | null;
    if (!params || !Array.isArray(params.encodings)) return null;
    const seeded = params.encodings.length === 0;
    if (seeded) params.encodings = [{}];
    return { params: params as SendParameters & { encodings: Encoding[] }, seeded };
  } catch {
    return null;
  }
}

/** One getParameters/setParameters round setting only `fields`. False if the browser refused it. */
async function trySet(sender: TunableSender, wanted: EncodingSettings, fields: Field[]): Promise<boolean> {
  const read = readParameters(sender);
  if (!read) return true; // gone: nothing to do
  const { params } = read;
  // Same values on every encoding (there is one: no simulcast). Count and rids stay untouched.
  for (const f of fields) {
    if (f === 'degradationPreference') params.degradationPreference = MAINTAIN_RESOLUTION;
    else for (const e of params.encodings) (e as Record<string, unknown>)[f] = wanted[f];
  }
  try {
    await sender.setParameters(params as never);
    return true;
  } catch {
    return false;
  }
}

async function applyOnce(sender: TunableSender, target: VideoTarget, source: SourceSize | undefined): Promise<void> {
  const wanted = encodingFor(target, source);
  const refused = refusedFields.get(sender) ?? new Set<Field>();
  const optional = OPTIONAL.filter((f) => !refused.has(f) && (f !== 'degradationPreference' || target.maintainResolution));
  const read = readParameters(sender);
  if (!read) return;
  if (!read.seeded && matches(read.params, wanted, [...ESSENTIAL, ...optional])) return;
  if (await trySet(sender, wanted, [...ESSENTIAL, ...optional])) return;
  // A browser that won't take the encoding we offered: try again on the next change.
  if (read.seeded) return;

  // Something was refused. Find out what, one field at a time, keeping everything that's accepted.
  let kept = ESSENTIAL;
  if (!(await trySet(sender, wanted, kept))) {
    await trySet(sender, wanted, ['maxBitrate']);
    return;
  }
  for (const f of optional) {
    if (await trySet(sender, wanted, [...kept, f])) kept = [...kept, f];
    else refused.add(f);
  }
  refusedFields.set(sender, refused);
}

interface TuneJob {
  target: VideoTarget;
  source: SourceSize | undefined;
}
const queued = new WeakMap<TunableSender, TuneJob>();
const running = new WeakMap<TunableSender, Promise<void>>();

/**
 * Apply `target` to `sender`. Changes to one sender run one at a time (a setParameters call made
 * while another is pending would be refused); if several arrive meanwhile, only the latest is
 * applied. The returned promise settles when the sender is up to date, and never rejects.
 */
export function tuneSender(sender: TunableSender, target: VideoTarget, source?: SourceSize): Promise<void> {
  queued.set(sender, { target, source });
  const busy = running.get(sender);
  if (busy) return busy;
  const run = (async () => {
    try {
      for (let job = queued.get(sender); job; job = queued.get(sender)) {
        queued.delete(sender);
        await applyOnce(sender, job.target, job.source);
      }
    } catch {
      // applyOnce handles its own errors; nothing may escape from here.
    } finally {
      running.delete(sender);
    }
  })();
  running.set(sender, run);
  return run;
}
