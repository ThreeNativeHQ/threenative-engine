/**
 * Nested cost spans across the render phase, default-off.
 *
 * The frame budget names six phases and one of them — `render` — is 16.1 ms of a 20.2 ms frame
 * while every engine-owned thing inside it sums to under 1.5 ms. A phase that big with nothing
 * inside it is not a measurement, it is a question, and four ranked optimisation options were
 * priced against four different answers to it. This is the instrument that answers it: a span tree
 * whose leaves are the parts of the render phase, with the leftover computed rather than assumed.
 *
 * Three properties make it trustworthy enough to price work against:
 *
 *  - **The residual is arithmetic, not a category.** Every non-leaf reports its own duration minus
 *    the durations of the spans it contains, so an unmeasured part shows up as a number instead of
 *    being quietly filed under "other". A child that outlives its parent reports a negative
 *    residual rather than being clamped to zero, because a negative residual means the nesting is
 *    wrong and a clamped one means nothing at all.
 *  - **It is default-off and costs one guarded return when off.** `TN_FRAME_SPANS=1` installs it;
 *    unset, every call site is `if (recorder === undefined) return;` with no clock read.
 *  - **Nothing here decides anything.** It measures the path that exists. It does not select a
 *    renderer, a traversal strategy or a pass order, and no number it produces is evidence for
 *    owning the renderer.
 *
 * The ids are integers on the hot path — a span call must not allocate a string to be cheap enough
 * to put around a per-draw call — and the names exist only in the report.
 */

/** Marker printed once per report window when spans are installed. */
export const SPANS_MARKER = "TN_FRAME_SPANS";

/**
 * The launch flag that installs the spans. Off by default: this is a diagnostic that adds work to
 * the frame it measures, so a game must ask for it.
 */
export const SPANS_FLAG = "TN_FRAME_SPANS";

/**
 * Every span, in the order the report prints them. Integers, because `beginSpan` runs per draw.
 *
 * `pass` and its nested kinds are one id per render call three makes, not one per camera: three
 * renders the main camera first and the shadow and reflection cameras from inside that call, so
 * the nesting is the renderer's own and a flat list of passes would have to invent a relationship
 * the measurement already has.
 */
export const SPANS = {
  /** Compute-driven render work dispatched by the engine before the world render. */
  compute: 0,
  /** The engine's own `beforeRender` seam, where a game prepares the scene it is about to draw. */
  beforeRender: 1,
  /** The scene-graph matrix walk. */
  sceneUpdate: 2,
  /** The projection's reconcile, when one is installed. */
  reconcile: 3,
  /** Virtual-geometry clustered mesh update. */
  clustered: 4,
  /** Automatic discrete LOD selection. */
  lod: 5,
  /** The projected-size cull, apply and restore together. */
  cull: 6,
  /** The main camera's render call. */
  mainPass: 7,
  /** A nested render call three names as a shadow map. */
  shadowPass: 8,
  /** A nested render call three names as a reflector. */
  reflectionPass: 9,
  /** Any other nested render call. */
  nestedPass: 10,
  /** Render-list construction inside a render call. */
  projectObject: 11,
  /** Render-list sort inside a render call. */
  sort: 12,
  /** Per-draw submission inside a render call, accumulated across the draws of one pass. */
  draw: 13,
  /** Terrain block rebuild and merged-attribute swap on the calling thread. */
  terrainBlock: 14,
  /** Terrain seam reconciliation and bridge-attribute swap on the calling thread. */
  terrainSeam: 15,
  /** One actual AnimationPlayer.update call, measured by the crowd fixture. */
  animationUpdate: 16,
  /** One actual SkinnedBatch.write call, including skeleton.update and palette copy. */
  skinnedWrite: 17,
} as const;

export type SpanId = (typeof SPANS)[keyof typeof SPANS];

/** Names, indexed by id. The only place a span name is a string. */
export const SPAN_NAMES: readonly string[] = [
  "compute",
  "beforeRender",
  "sceneUpdate",
  "reconcile",
  "clustered",
  "lod",
  "cull",
  "mainPass",
  "shadowPass",
  "reflectionPass",
  "nestedPass",
  "projectObject",
  "sort",
  "draw",
  "terrainBlock",
  "terrainSeam",
  "animationUpdate",
  "skinnedWrite",
];

export const SPAN_COUNT = SPAN_NAMES.length;

/** Deepest nesting the recorder accepts. Exceeding it is reported, never silently dropped. */
const MAX_DEPTH = 64;

/** Per-frame samples kept for the window percentiles. Matches the frame budget's own ring. */
const DEFAULT_CAPACITY = 1_024;

/** One span's cost across a reported window. */
export interface ISpanSummary {
  /** Frames in the window that entered this span at least once. */
  readonly frames: number;
  /** Entries per frame, mean over the frames that entered it. */
  readonly perFrame: number;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  /**
   * This span's own time minus the time of the spans inside it, at p50.
   *
   * Negative when a child outlived its parent, which means the nesting is wrong. Never clamped: a
   * clamped residual reads as a complete attribution, and this is the number that says whether the
   * attribution is complete.
   */
  readonly residualP50: number;
}

/**
 * One reported window of the span tree.
 *
 * `residual` is the render phase's own cost with every top-level span subtracted — the number this
 * instrument exists to shrink. `coverage` is its complement as a fraction of the phase, and a
 * reader that sees 0.68 is being told that a third of the phase is still unmeasured.
 */
export interface ISpanWindow {
  readonly window: number;
  readonly frames: number;
  /** The render phase as the frame budget charged it, at p50. */
  readonly renderMs: number;
  readonly residualMs: number;
  readonly coverage: number;
  /** Frames whose span nesting exceeded `MAX_DEPTH`, whose residual is therefore incomplete. */
  readonly overflowed: number;
  readonly spans: Readonly<Record<string, ISpanSummary>>;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** A fixed-capacity ring of samples. Never allocates after construction. */
class Ring {
  readonly #buffer: Float64Array;
  #count = 0;
  #cursor = 0;

  constructor(capacity: number) {
    this.#buffer = new Float64Array(capacity);
  }

  push(value: number): void {
    const capacity = this.#buffer.length;
    this.#buffer[this.#cursor % capacity] = value;
    this.#cursor += 1;
    if (this.#count < capacity) this.#count += 1;
  }

  reset(): void {
    this.#count = 0;
    this.#cursor = 0;
  }

  get count(): number {
    return this.#count;
  }

  summarize(scratch: Float64Array): { mean: number; p50: number; p95: number; max: number } {
    const count = this.#count;
    if (count === 0) return { max: 0, mean: 0, p50: 0, p95: 0 };
    let total = 0;
    for (let index = 0; index < count; index += 1) {
      const value = this.#buffer[index] ?? 0;
      scratch[index] = value;
      total += value;
    }
    const view = scratch.subarray(0, count);
    view.sort();
    const rank = (fraction: number): number =>
      round(view[Math.min(count - 1, Math.ceil(fraction * count) - 1)] ?? 0);
    return {
      max: round(view[count - 1] ?? 0),
      mean: round(total / count),
      p50: rank(0.5),
      p95: rank(0.95),
    };
  }
}

/**
 * Accumulates a nested span tree, one frame at a time, and reports it windowed.
 *
 * The owner brackets a frame with `beginFrame` and `endFrame`; the render phase's own duration is
 * handed in at the close rather than measured here, so the root residual is arithmetic against the
 * number the frame budget already reports and cannot drift from it.
 *
 * Nesting is strict: `end(id)` must name the span `begin(id)` opened. A mismatch throws, because a
 * tree whose parentage is wrong produces a residual that is confidently wrong, and that is worse
 * than a loud failure in a mode a game opted into.
 */
export class SpanRecorder {
  readonly capacity: number;
  readonly #stackId = new Int32Array(MAX_DEPTH);
  readonly #stackStart = new Float64Array(MAX_DEPTH);
  readonly #own = new Float64Array(SPAN_COUNT);
  readonly #child = new Float64Array(SPAN_COUNT);
  readonly #entries = new Uint32Array(SPAN_COUNT);
  readonly #entryTotals = new Float64Array(SPAN_COUNT);
  readonly #ownSeries: Ring[] = [];
  readonly #residualSeries: Ring[] = [];
  readonly #renderSeries: Ring;
  readonly #topLevelSeries: Ring;
  readonly #scratch = new Float64Array(DEFAULT_CAPACITY);
  #depth = 0;
  #topLevelMs = 0;
  #frames = 0;
  #overflowed = 0;
  #window = 0;

  constructor(capacity: number = DEFAULT_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1)
      throw new Error(
        `Span recorder capacity must be an integer of at least one, got ${String(capacity)}.`,
      );
    this.capacity = capacity;
    for (let id = 0; id < SPAN_COUNT; id += 1) {
      this.#ownSeries.push(new Ring(capacity));
      this.#residualSeries.push(new Ring(capacity));
    }
    this.#renderSeries = new Ring(capacity);
    this.#topLevelSeries = new Ring(capacity);
  }

  /** Opens a span. Returns false when the tree is already at `MAX_DEPTH` and the span is dropped. */
  begin(id: SpanId, now: number): boolean {
    if (this.#depth >= MAX_DEPTH) {
      this.#overflowed += 1;
      return false;
    }
    this.#stackId[this.#depth] = id;
    this.#stackStart[this.#depth] = now;
    this.#depth += 1;
    this.#entries[id] = (this.#entries[id] ?? 0) + 1;
    return true;
  }

  /** Closes the span `begin` opened. Throws when it names a different span. */
  end(id: SpanId, now: number): void {
    if (this.#depth === 0)
      throw new Error(`Span ${SPAN_NAMES[id] ?? String(id)} ended with no span open.`);
    const depth = this.#depth - 1;
    const open = this.#stackId[depth] ?? -1;
    if (open !== id)
      throw new Error(
        `Span ${SPAN_NAMES[id] ?? String(id)} ended while ${SPAN_NAMES[open] ?? String(open)} was open.`,
      );
    this.#depth = depth;
    const ms = now - (this.#stackStart[depth] ?? now);
    this.#own[id] = (this.#own[id] ?? 0) + ms;
    this.#attribute(ms);
  }

  /**
   * Adds `ms` to a span that is entered many times per frame — a per-draw call, or a call site that
   * cannot be bracketed. Counts as one entry and attributes to the enclosing span exactly as a
   * bracketed one would.
   */
  add(id: SpanId, ms: number): void {
    this.#own[id] = (this.#own[id] ?? 0) + ms;
    this.#entries[id] = (this.#entries[id] ?? 0) + 1;
    this.#attribute(ms);
  }

  #attribute(ms: number): void {
    if (this.#depth === 0) {
      this.#topLevelMs += ms;
      return;
    }
    const parent = this.#stackId[this.#depth - 1] ?? -1;
    if (parent >= 0) this.#child[parent] = (this.#child[parent] ?? 0) + ms;
  }

  /** How many spans are currently open. Zero outside a frame's own work. */
  get depth(): number {
    return this.#depth;
  }

  /**
   * Throws a half-open frame away without recording it.
   *
   * A frame that failed mid-render has a span stack that cannot be closed honestly, and recording
   * it would put a fabricated zero in the window. The loop abandons it instead, so the window only
   * ever reports frames whose spans all closed.
   */
  abandonFrame(): void {
    this.#depth = 0;
    for (let id = 0; id < SPAN_COUNT; id += 1) {
      this.#own[id] = 0;
      this.#child[id] = 0;
      this.#entries[id] = 0;
    }
    this.#topLevelMs = 0;
  }

  /** Records the frame's totals against the render phase the frame budget charged. */
  endFrame(renderPhaseMs: number): void {
    if (this.#depth !== 0) {
      const open = this.#stackId[this.#depth - 1] ?? -1;
      this.#depth = 0;
      throw new Error(
        `Span ${SPAN_NAMES[open] ?? String(open)} was still open at the end of a frame.`,
      );
    }
    if (!Number.isFinite(renderPhaseMs))
      throw new Error(
        `Span recorder received a non-finite render phase: ${String(renderPhaseMs)}.`,
      );
    for (let id = 0; id < SPAN_COUNT; id += 1) {
      this.#ownSeries[id]?.push(this.#own[id] ?? 0);
      this.#residualSeries[id]?.push((this.#own[id] ?? 0) - (this.#child[id] ?? 0));
      this.#entryTotals[id] = (this.#entryTotals[id] ?? 0) + (this.#entries[id] ?? 0);
      this.#own[id] = 0;
      this.#child[id] = 0;
      this.#entries[id] = 0;
    }
    this.#renderSeries.push(renderPhaseMs);
    this.#topLevelSeries.push(this.#topLevelMs);
    this.#topLevelMs = 0;
    this.#frames += 1;
  }

  /** The window just closed, or `undefined` when no frame was recorded in it. */
  window(): ISpanWindow | undefined {
    const frames = this.#frames;
    if (frames === 0) return undefined;
    this.#window += 1;
    const render = this.#renderSeries.summarize(this.#scratch);
    // The spans that were open when nothing else was, at the same percentile as the phase itself.
    // Summing every span instead would count each child twice — once inside its parent, once on its
    // own — and report a residual that is too small by exactly the nesting depth.
    const topLevel = this.#topLevelSeries.summarize(this.#scratch).p50;
    const residualMs = round(render.p50 - topLevel);
    const spans: Record<string, ISpanSummary> = {};
    for (let id = 0; id < SPAN_COUNT; id += 1) {
      const own = this.#ownSeries[id];
      if (own === undefined || own.count === 0) continue;
      const summary = own.summarize(this.#scratch);
      const residual = this.#residualSeries[id]?.summarize(this.#scratch) ?? {
        max: 0,
        mean: 0,
        p50: 0,
        p95: 0,
      };
      const entries = this.#entryMean(id, frames);
      // A span that was entered and cost almost nothing is a *measurement*, and dropping it
      // because it rounds to zero is the same "absent means zero" confusion the rest of this file
      // refuses. Measured on the reference game in a browser: the world render call costs about
      // 0.07 ms there, and dropping it left a window with no `mainPass` row at all — which reads
      // as "the render never happened" rather than "the render was cheap". Only a span nothing
      // ever entered is omitted.
      if (entries === 0) continue;
      spans[SPAN_NAMES[id] ?? String(id)] = {
        frames,
        mean: summary.mean,
        max: summary.max,
        p50: summary.p50,
        p95: summary.p95,
        perFrame: entries,
        residualP50: residual.p50,
      };
    }
    const window: ISpanWindow = {
      coverage: render.p50 > 0 ? round(1 - residualMs / render.p50) : 0,
      frames,
      overflowed: this.#overflowed,
      renderMs: render.p50,
      residualMs,
      spans,
      window: this.#window,
    };
    this.#resetWindow();
    return window;
  }

  /** Mean entries per frame for one span, from the window's own totals. */
  #entryMean(id: number, frames: number): number {
    const total = this.#entryTotals[id] ?? 0;
    return round(total / frames);
  }

  #resetWindow(): void {
    for (let id = 0; id < SPAN_COUNT; id += 1) {
      this.#ownSeries[id]?.reset();
      this.#residualSeries[id]?.reset();
      this.#entryTotals[id] = 0;
    }
    this.#renderSeries.reset();
    this.#topLevelSeries.reset();
    this.#frames = 0;
    this.#overflowed = 0;
  }
}

/**
 * The installed recorder, or `undefined` when spans are off.
 *
 * `Symbol.for` on `globalThis` rather than module state, because core is built once per entry: a
 * game that imports `@threenative/core/world` gets a second copy of this module, and a recorder
 * installed by the main entry is invisible to it. The world's own spans (terrain block rebuild and
 * seam swap) recorded nothing in a browser walk for exactly that reason — two copies, two states.
 * The global symbol is one slot every copy reads, and a parameter would still put a recorder on the
 * hot path for a diagnostic that is off in every shipped build.
 */
const RECORDER_SLOT = Symbol.for("threenative.frameSpans.recorder");

type RecorderHost = { [key: symbol]: SpanRecorder | undefined };

function recorderHost(): RecorderHost {
  // quality-allow: the recorder lives on globalThis under a private symbol, which no lib type names.
  return globalThis as unknown as RecorderHost;
}

/** Installs or removes the recorder every `beginSpan`/`endSpan` routes to, in every entry copy. */
export function setSpanRecorder(next: SpanRecorder | undefined): void {
  recorderHost()[RECORDER_SLOT] = next;
}

export function spanRecorder(): SpanRecorder | undefined {
  return recorderHost()[RECORDER_SLOT];
}

/** The one clock the spans and the frame budget share, so their numbers are comparable. */
export function spanNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}

/**
 * Opens a span. One guarded return when spans are off — no clock read, no allocation, no branch on
 * anything but the recorder's own presence.
 */
export function beginSpan(id: SpanId): void {
  const active = spanRecorder();
  if (active === undefined) return;
  active.begin(id, spanNow());
}

export function endSpan(id: SpanId): void {
  const active = spanRecorder();
  if (active === undefined) return;
  active.end(id, spanNow());
}

/** Adds an already-measured duration to a span entered many times per frame. */
export function addSpan(id: SpanId, ms: number): void {
  const active = spanRecorder();
  if (active === undefined) return;
  active.add(id, ms);
}

/**
 * Whether `TN_FRAME_SPANS` asks for spans on this launch.
 *
 * Three ways in, because the three launches have three different seams and none of them is
 * `import.meta.env` (Vite replaces that at build time, and a measurement flag must be settable
 * without rebuilding the game): a native host forwards `TN_FRAME_SPANS` through `process.env`, a
 * browser page carries `?tnFrameSpans=1` in its URL, and any harness can set
 * `globalThis.__tnFrameSpans` before the game boots.
 */
export function spansRequested(): boolean {
  const host = globalThis as {
    process?: { env?: Record<string, unknown> };
    __tnFrameSpans?: unknown;
  };
  const fromEnv = host.process?.env?.[SPANS_FLAG];
  if (typeof fromEnv === "string" && fromEnv !== "" && fromEnv !== "0" && fromEnv !== "false")
    return true;
  const query = globalThis.location?.search;
  if (typeof query === "string" && /[?&]tnFrameSpans=(?!0(?:&|$))(?!false(?:&|$))[^&]/u.test(query))
    return true;
  const fromGlobal = host.__tnFrameSpans;
  return (
    fromGlobal === true ||
    (typeof fromGlobal === "string" &&
      fromGlobal !== "" &&
      fromGlobal !== "0" &&
      fromGlobal !== "false")
  );
}

/** The window as the marker line prints it. */
export function formatSpansWindow(window: ISpanWindow): string {
  return `${SPANS_MARKER}:${JSON.stringify(window)}`;
}
