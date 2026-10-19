/**
 * Per-pass draw and triangle attribution, on by default, for every platform.
 *
 * The frame budget already owned the milliseconds; this owns the submissions. Three's
 * `renderer.info.reset()` runs once per frame before the world render, and a nested shadow or
 * reflection `renderer.render(...)` shares that same `info`, so `info.render` reports main plus
 * every nested pass combined. The aggregate cannot tell a 316-draw shadow lane from a 1,418-draw
 * colour pass, and every optimisation attempt had to hand-roll the split. This is the split: each
 * `render()` is one entry on a stack, and its own submissions are the counter delta across its
 * call minus the deltas of the nested calls it made, so the innermost active render call owns
 * exactly what it submitted.
 *
 * Three names its own shadow pass by temporarily renaming the scene to `Shadow Map [ ... ]`
 * (`renderShadow`), and a reflection pass names its scene with `Reflector` in it. Those are
 * borrowed, not invented: the classifier reads three's vocabulary and falls back to `nested`.
 *
 * Measurement, not policy: installing this alters no draw. `install` answers `undefined` on a
 * renderer whose `info.render` cannot be read, and a consumer must then report the pass split as
 * absent rather than zero.
 *
 * The main pass's own draws are also split by where their mesh came from, counted at the one place
 * a draw is counted — `info.update`, which every backend calls per submitted draw with the object
 * that owns it — so the sources sum to `draws` by construction instead of by an estimate beside it.
 */

/** The named kinds of a render pass. Closed on purpose: a consumer bounds a known kind. */
export const FRAME_PASS_KINDS = ["main", "shadow", "reflection", "nested"] as const;

export type FramePassKind = (typeof FRAME_PASS_KINDS)[number];

/**
 * Where a main-pass draw's mesh came from. Closed, and `other` is the default.
 *
 * Each entry is a system that owns its meshes and writes the origin on them, so the split reads as
 * an answer about systems rather than about geometry: `gpuScene` and `bundles` are `WorldCells`' two
 * ways of drawing one main batch (a GPU-dressed key, and the same mesh replayed from the world's
 * bundle), `terrain` is every mesh `world-tiles.ts` creates, `proxies` is the shadow halves and the
 * whole-map impostor aggregates, `chunks` is a hand-placed chunk's own draws, `instanced` is a main
 * batch the GPU scene never dressed, and `sky` is a daylight rig's sky box. What is left in `other`
 * is a mesh no world system claimed — a character, a prop, a water surface the game loaded — which is
 * the bucket that has to be small enough to be worth naming one draw at a time.
 */
export const MAIN_DRAW_SOURCES = [
  "gpuScene",
  "bundles",
  "terrain",
  "proxies",
  "chunks",
  "instanced",
  "sky",
  "other",
] as const;

export type MainDrawSource = (typeof MAIN_DRAW_SOURCES)[number];

/**
 * One render call's own submissions, attributed to its innermost active render call.
 *
 * `drawsBySource` is `main`'s own draws by origin, in the frame's counts rather than in percentiles:
 * it sums to `draws` for the frame, which is the claim the split exists to answer. Absent when the
 * renderer named no object for one of those draws, because a split that guessed where a draw came
 * from would read as a measurement.
 */
export interface IRenderPassSample {
  readonly draws: number;
  readonly drawsBySource?: Readonly<Partial<Record<MainDrawSource, number>>>;
  readonly kind: FramePassKind;
  readonly triangles: number;
}

/** Whether a tag names a source this file counts. Anything else is `other`. */
function isMainDrawSource(tag: unknown): tag is MainDrawSource {
  return (MAIN_DRAW_SOURCES as readonly unknown[]).includes(tag);
}

/**
 * The source a drawn object belongs to, read from the two tags its creator set on it.
 *
 * `tnBundled` is the marker `WorldCells` already keeps, and it wins: a bundled mesh is a mesh the
 * world drew through a recorded `BundleGroup` rather than one it submitted per object, so counting
 * it as a GPU-scene key as well would name the same draw twice.
 */
function drawSourceOf(object: unknown): MainDrawSource | undefined {
  const userData =
    typeof object === "object" && object !== null
      ? (object as { readonly userData?: Record<string, unknown> }).userData
      : undefined;
  if (typeof userData !== "object" || userData === null) return undefined;
  if (userData.tnBundled === true) return "bundles";
  const tagged = userData.tnDrawSource;
  return isMainDrawSource(tagged) ? tagged : "other";
}

interface IRenderCounters {
  readonly drawCalls?: number;
  readonly calls?: number;
  readonly triangles?: number;
}

/**
 * Three's own per-frame counters, the surface this file reads and wraps.
 *
 * `update` is three's per-draw counter, not one of the aggregates: WebGPU's `WebGPUInfo` and the
 * WebGL2 fallback inside it both call it once per submitted draw with the object that owns it, and
 * a standalone `WebGLRenderer` calls it with a vertex count instead — which is why a draw this
 * cannot read a `userData` off is left unattributed rather than guessed at.
 */
interface IInfoCounters {
  readonly render?: IRenderCounters | undefined;
  update?(object: unknown, count: number, instanceCount: number): void;
}

/**
 * The slice of three's timestamp query pool this reads.
 *
 * Three keys one pool per query type (`render`, `compute`) at
 * `renderer.backend.timestampQueryPool`, and each pool exposes the two maps it fills in itself:
 * `queryOffsets` is the uid of every allocated pass (appended synchronously as the pass begins,
 * cleared when a resolve starts) and `timestamps` is every uid's resolved duration in
 * milliseconds, written when the asynchronous resolve lands. Both are three's own public fields,
 * not a borrowed internal, and reading them is what turns the one summed `info.render.timestamp`
 * into a per-pass number.
 */
export interface ITimestampQueryPool {
  readonly queryOffsets?: Map<string, number> | undefined;
  readonly timestamps?: Map<string, number> | undefined;
}

/**
 * The slice of a renderer this reads: the raw three renderer, not `IRendererLike`. It is
 * deliberately structural so the unit test can stand in a fake that nests exactly as three does.
 */
export interface IRenderPassTarget {
  readonly info?: IInfoCounters | undefined;
  /**
   * Three's backend, for per-pass GPU time. Optional: a WebGL2 fallback and a test double may
   * carry no timestamp pool, and every GPU read is then absent rather than zero.
   */
  readonly backend?:
    | { readonly timestampQueryPool?: Record<string, ITimestampQueryPool | null> }
    | undefined;
  render(scene: unknown, camera: unknown): void;
}

/** One allocated timestamp query, before its duration resolves: the pass kind and three's uid. */
interface IGpuUidEntry {
  readonly kind: FramePassKind;
  readonly uid: string;
}

/**
 * One resolved frame's GPU milliseconds: the frame it belongs to, its own passes, and every pass it
 * drew. `total` is the frame's cost — three's `framesDuration` for that frame, read back from the
 * per-pass map rather than from the single number its resolve returns.
 *
 * A reading exists only when **every** pass the frame recorded has a resolved timestamp. A frame
 * with any pass still in flight understates the frame's cost if its resolved parts were summed and
 * forwarded as the whole, so it stays absent until the read is complete. Frames are delivered in
 * order and an unresolved one is skipped, never waited on: once a newer frame is delivered the
 * older unresolved frame is intentionally omitted — a missing reading, never a partial zero.
 */
export interface IGpuFrameReading {
  readonly frame: number;
  /** Milliseconds the main pass cost. `0` when the frame drew none; whole whenever the frame is. */
  readonly main: number;
  /**
   * Every shadow pass's milliseconds: `0` when the frame drew none. A resolved `0` is a real
   * render that cost nothing, so {@link shadowPasses} — not this value — says whether one was made.
   */
  readonly shadow: number;
  /**
   * How many shadow passes the frame recorded. `0` means it drew no shadow; `> 0` means it rendered
   * one, however small the cost. This is the producer's own record, so a consumer never has to guess
   * "rendered" from a value that a genuine render can leave at zero.
   */
  readonly shadowPasses: number;
  /** Every resolved pass of the frame — main, shadow and everything else. Whole, never partial. */
  readonly total: number;
}

interface IPassFrame {
  readonly entryDraws: number;
  readonly entryTriangles: number;
  readonly kind: FramePassKind;
  childDraws: number;
  childTriangles: number;
  /** Timestamp uids the nested calls this pass made allocated, in allocation order. */
  childUids?: string[];
  /** This pass's own draws per origin, held only for a main pass and dropped the moment one is unclassifiable. */
  drawsBySource?: Partial<Record<MainDrawSource, number>>;
  /** A draw named no object to read, so {@link drawsBySource} would be a partial answer. */
  unclassifiable?: boolean;
}

function readCounters(target: IRenderPassTarget): { draws: number; triangles: number } | undefined {
  const render = target.info?.render;
  if (render === undefined) return undefined;
  const draws = render.drawCalls ?? render.calls;
  const triangles = render.triangles;
  if (typeof draws !== "number" || !Number.isFinite(draws) || draws < 0) return undefined;
  if (typeof triangles !== "number" || !Number.isFinite(triangles) || triangles < 0)
    return undefined;
  return { draws, triangles };
}

const installed = new WeakSet<object>();

/**
 * Resolved frames kept for GPU attribution. A resolve lags the frame it measures by a few frames,
 * so the uid list for a frame must outlive the frame that produced it; 64 frames is far more than
 * that lag and bounds the map on a game that never resolves.
 */
const GPU_UID_FRAME_LIMIT = 64;

/**
 * Names a render call by what three already calls it: the outermost call is the main camera, and a
 * nested call carries the scene name three or the reflector gave it.
 */
function passKind(scene: unknown, depth: number): FramePassKind {
  if (depth === 0) return "main";
  const name =
    typeof scene === "object" &&
    scene !== null &&
    typeof (scene as { name?: unknown }).name === "string"
      ? (scene as { name: string }).name
      : "";
  if (name.startsWith("Shadow Map")) return "shadow";
  if (/reflect/iu.test(name)) return "reflection";
  return "nested";
}

/**
 * Records one presented frame's passes. The owner calls `beginFrame` before the world render and
 * `passes()` after it; a nested render inside the world render is attributed without the owner
 * knowing it happened.
 */
/** The last resolved shadow-pass GPU milliseconds per instrumented renderer; see {@link shadowRedrawGpuMs}. */
const lastShadowGpuMs = new WeakMap<object, number>();

/**
 * What the last resolved frame that drew a shadow spent on its shadow passes, on this renderer, or
 * `undefined` before one resolved (or with no recorder installed). A shadow node reads it to price
 * a redraw in GPU time: its own `performance.now()` around the draw is only the CPU encode.
 */
export function shadowRedrawGpuMs(renderer: unknown): number | undefined {
  return typeof renderer === "object" && renderer !== null
    ? lastShadowGpuMs.get(renderer)
    : undefined;
}

/** Records a resolved shadow-pass reading for {@link shadowRedrawGpuMs}; the recorder's own feed. */
export function noteShadowRedrawGpuMs(renderer: object, ms: number): void {
  lastShadowGpuMs.set(renderer, ms);
}

export class RenderPassBudget {
  readonly #target: IRenderPassTarget;
  readonly #original: (scene: unknown, camera: unknown) => void;
  readonly #frame: IRenderPassSample[] = [];
  readonly #stack: IPassFrame[] = [];
  /** Timestamp uids each render call allocated, keyed by the Three.js frame they belong to. */
  readonly #gpuUids = new Map<number, IGpuUidEntry[]>();
  /** The last frame `nextGpuFrame` handed out; every earlier frame has been reported. */
  #deliveredGpuFrame = -1;

  private constructor(target: IRenderPassTarget) {
    this.#target = target;
    this.#original = target.render;
    const instrumented = (scene: unknown, camera: unknown): void => {
      const counters = readCounters(target);
      if (counters === undefined) {
        this.#original.call(target, scene, camera);
        return;
      }
      const offsets = target.backend?.timestampQueryPool?.render?.queryOffsets;
      const allocatedBefore = offsets?.size ?? 0;
      const depth = this.#stack.length;
      const frame: IPassFrame = {
        childDraws: 0,
        childTriangles: 0,
        entryDraws: counters.draws,
        entryTriangles: counters.triangles,
        kind: passKind(scene, depth),
      };
      this.#stack.push(frame);
      try {
        this.#original.call(target, scene, camera);
      } finally {
        this.#stack.pop();
        const after = readCounters(target);
        if (after !== undefined) {
          const totalDraws = after.draws - frame.entryDraws;
          const totalTriangles = after.triangles - frame.entryTriangles;
          const parent = this.#stack[this.#stack.length - 1];
          if (parent !== undefined) {
            parent.childDraws += totalDraws;
            parent.childTriangles += totalTriangles;
          }
          const drawsBySource = frame.unclassifiable === true ? undefined : frame.drawsBySource;
          this.#frame.push({
            draws: Math.max(0, totalDraws - frame.childDraws),
            ...(drawsBySource === undefined ? {} : { drawsBySource }),
            kind: frame.kind,
            triangles: Math.max(0, totalTriangles - frame.childTriangles),
          });
        }
        this.#attributeGpu(frame, offsets, allocatedBefore);
      }
    };
    target.render = instrumented;
    this.#instrumentDraws(target.info);
    installed.add(target);
  }

  /**
   * Attributes each counted draw to the origin of the object behind it.
   *
   * Only a draw the main pass itself submitted is counted, because a nested render's draws are
   * subtracted out of `main`: counting them here too would put shadow work in the main pass's split
   * and break the sum the split exists to reconcile. The original `update` still runs, so
   * `info.render.drawCalls` — the number everything else is read against — is untouched.
   */
  #instrumentDraws(info: IInfoCounters | undefined): void {
    const update = info?.update;
    if (info === undefined || typeof update !== "function") return;
    info.update = (object: unknown, count: number, instanceCount: number): void => {
      const frame = this.#stack[this.#stack.length - 1];
      if (frame?.kind === "main" && frame.unclassifiable !== true) {
        const source = drawSourceOf(object);
        if (source === undefined) frame.unclassifiable = true;
        else {
          frame.drawsBySource ??= {};
          const drawsBySource = frame.drawsBySource;
          drawsBySource[source] = (drawsBySource[source] ?? 0) + 1;
        }
      }
      update.call(info, object, count, instanceCount);
    };
  }

  /**
   * Instruments `target`'s `render` in place and answers the recorder, or `undefined` when the
   * renderer cannot report its own counters. Refuses a double install: one frame must not be
   * counted twice.
   */
  static install(target: IRenderPassTarget): RenderPassBudget | undefined {
    if (installed.has(target)) return undefined;
    if (readCounters(target) === undefined) return undefined;
    return new RenderPassBudget(target);
  }

  /**
   * The kind of the innermost render call currently running, or undefined outside one.
   *
   * A per-object diagnostic needs the same attribution this class already does: a mesh submitted
   * inside a shadow render is shadow work, and charging it to the main pass is how a shadow map
   * disappears from a cost report.
   */
  activeKind(): FramePassKind | undefined {
    return this.#stack[this.#stack.length - 1]?.kind;
  }

  /** Clears the previous frame's passes. Call before the frame's first world render. */
  beginFrame(): void {
    this.#frame.length = 0;
  }

  /**
   * The passes just recorded, children before the main call. The array is reused, so a consumer
   * reads it before the next `beginFrame`.
   */
  passes(): readonly IRenderPassSample[] {
    return this.#frame;
  }

  /**
   * The oldest resolved frame that has not been handed out yet, and where its GPU time went.
   *
   * Three answers a resolve with **one** number: the summed duration of the last frame in the
   * batch (`three.webgpu.js:83746`). Every other frame that batch measured is written to the pool's
   * own `timestamps` map, one entry per pass, keyed by the frame its uid names, and read by nobody.
   * A resolve that caught up on k sampled frames therefore reported one of them, and the k-1 others
   * were gone for good, because the pool is emptied before the resolve is submitted and the next one
   * starts from nothing.
   *
   * That is what made the frame budget's sample count a function of frame *rate*: the engine asked
   * for a resolve on the same 1-in-8 stride it samples on, three skips a resolve while one is still
   * in flight, and the stride is a frame count where the round trip is not — so the faster the game
   * presented, the fewer samples a window carried (28 in a 300-frame window on the 2026-10-03
   * Machinefall probe, 1-2 in its ~200 fps windows, against the ~37 the sampler asked for).
   *
   * The uid list per frame is already kept here, so the batch is walked instead of collapsed: one
   * sample per presented frame, one frame per sample, which is the shape the budget's series wants.
   * Frames are delivered in uid order and an unresolved one is skipped rather than waited on, so no
   * one frame ever stalls the frames behind it. An unresolved frame is retried only while it is the
   * oldest undelivered one: the moment a newer complete frame is delivered, the cursor moves past
   * the gap and the older unresolved frame is intentionally omitted — a missing reading, never a
   * zeroed partial. Only the bounded uid ring retires a frame that never resolves at all.
   *
   * A kind with no pass in the frame is zero, not absent: a frame that drew a main pass and no
   * shadow genuinely spent 0 ms on shadow. A frame is absent, though, until **every** pass it
   * recorded has resolved: its parts are only a whole frame when the whole frame came back, and a
   * partial `total` forwarded as the frame's cost is what the phase comparison must not read.
   * The caller subtracts the known kinds from `total` to leave `other` (post chain, reflection,
   * HUD). Passes are summed per kind, so a shadow cascade's several passes are one number, and main
   * never absorbs the nested shadow's.
   */
  nextGpuFrame(): IGpuFrameReading | undefined {
    for (const frame of this.#gpuUids.keys()) {
      if (frame <= this.#deliveredGpuFrame) continue;
      const sum = this.#gpuSum(frame);
      if (sum === undefined) continue;
      this.#deliveredGpuFrame = frame;
      if (sum.shadowPasses > 0) noteShadowRedrawGpuMs(this.#target, sum.shadow);
      return {
        frame,
        main: sum.main,
        shadow: sum.shadow,
        shadowPasses: sum.shadowPasses,
        total: sum.total,
      };
    }
    return undefined;
  }

  /**
   * One frame's resolved GPU milliseconds from the pool's per-pass map, or `undefined` until every
   * pass it recorded has come back. `total` is every resolved pass of the frame — main, shadow and
   * everything else — so the frame's own cost does not have to be inferred from three's one number
   * for the batch, and it is only ever returned whole.
   */
  #gpuSum(
    frame: number,
  ): { main: number; shadow: number; shadowPasses: number; total: number } | undefined {
    const entries = this.#gpuUids.get(frame);
    const timestamps = this.#target.backend?.timestampQueryPool?.render?.timestamps;
    if (timestamps === undefined || entries === undefined || entries.length === 0) return undefined;
    let main = 0;
    let shadow = 0;
    let shadowPasses = 0;
    let total = 0;
    let resolved = 0;
    for (const { kind, uid } of entries) {
      if (kind === "shadow") shadowPasses += 1;
      const ms = timestamps.get(uid);
      if (ms === undefined || !Number.isFinite(ms) || ms < 0) continue;
      resolved += 1;
      total += ms;
      if (kind === "main") main += ms;
      else if (kind === "shadow") shadow += ms;
    }
    // A partial sum is not the frame's cost: subtracting the known kinds from a partial `total`
    // leaves an `other` no one measured. The frame stays absent until the whole read is in.
    if (resolved !== entries.length) return undefined;
    return { main, shadow, shadowPasses, total };
  }

  /**
   * Attributes the uids allocated during one render call to that call, not its parent, by the same
   * child-subtraction the draws get: a nested render's uids are claimed by the nested frame before
   * the parent computes its own, so `main` does not absorb a shadow's pass.
   */
  #attributeGpu(
    frame: IPassFrame,
    offsets: Map<string, number> | undefined,
    allocatedBefore: number,
  ): void {
    if (offsets === undefined || offsets.size <= allocatedBefore) return;
    const allocated: string[] = [];
    let index = 0;
    for (const uid of offsets.keys()) {
      index += 1;
      if (index > allocatedBefore) allocated.push(uid);
    }
    if (allocated.length === 0) return;
    const childUids = frame.childUids;
    const own =
      childUids === undefined ? allocated : allocated.filter((uid) => !childUids.includes(uid));
    const parent = this.#stack[this.#stack.length - 1];
    if (parent !== undefined) {
      parent.childUids ??= [];
      parent.childUids.push(...allocated);
    }
    for (const uid of own) this.#recordGpuUid(uid, frame.kind);
  }

  /** Files one allocated uid under the frame the uid names, dropping the oldest frames over time. */
  #recordGpuUid(uid: string, kind: FramePassKind): void {
    const match = /:f(\d+)$/u.exec(uid);
    if (match === null) return;
    const frame = Number(match[1]);
    const entries = this.#gpuUids.get(frame);
    if (entries === undefined) this.#gpuUids.set(frame, [{ kind, uid }]);
    else entries.push({ kind, uid });
    while (this.#gpuUids.size > GPU_UID_FRAME_LIMIT) {
      const oldest = this.#gpuUids.keys().next().value;
      if (oldest === undefined) break;
      this.#gpuUids.delete(oldest);
    }
  }
}
