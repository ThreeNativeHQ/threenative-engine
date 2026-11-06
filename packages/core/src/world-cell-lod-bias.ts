import type { IRendererLike } from "./renderer.js";
import { DEFAULT_TARGET_FPS } from "./target-fps.js";

/**
 * The adaptive LOD bias: one multiplier both selection paths read, moved by the main pass's own GPU
 * time.
 *
 * The loop had no home before this module and lived in `world-cells.ts` between `process` and the
 * prefetch lookahead; it moves here as it was — same constants, same order of tests, same marker
 * line — with its four inputs behind a host so a world can answer them and a test can drive it. The
 * bias itself is written out through the host: the shared multiplier in `model-lod.ts` and the GPU
 * uniform the dispatch carries are one number, and this class owns none of them.
 */

/** The adaptive LOD bias floor. A bias is only ever allowed to coarsen selection, never refine it. */
const LOD_BIAS_MIN = 1;
/** The adaptive LOD bias ceiling, so a runaway maps to a coarser but still bounded world. */
const LOD_BIAS_MAX = 2.5;
/** How much the bias rises per over-budget step. */
const LOD_BIAS_RISE = 1.08;
/** How much the bias decays per comfortably-under-budget step. */
const LOD_BIAS_DECAY = 0.95;
/** Seconds between rise or decay steps; a change is never larger than one step. */
const LOD_BIAS_STEP_SECONDS = 0.5;
/** Below this share of the affordable budget the bias decays; between it and the budget it holds. */
const LOD_BIAS_DECAY_SHARE = 0.6;
/** Seconds between two `TN_LOD_BIAS` lines. */
const LOD_BIAS_MARKER_SECONDS = 1;
/** The line the adaptive loop prints when it moves the bias. */
export const LOD_BIAS_MARKER = "TN_LOD_BIAS";

/** What the loop asks its world for: the clock, the sample, the two gates and the one write. */
export interface ICellLodBiasHost {
  readonly now: () => number;
  /** The renderer whose main pass is being measured; `update`'s argument, else the last one seen. */
  readonly renderer: () => IRendererLike | undefined;
  /** The prewarm gate: what the loading screen waits on, as the three counters it reports. */
  readonly prewarm: () => {
    readonly queued: number;
    readonly owed: number;
    readonly drawn: number;
  };
  /** The GPU-selected main-pass triangles of the last landed tally, absent before one lands. */
  readonly gpuTriangles: () => number | undefined;
  /** Writes the multiplier to both selection paths: the shared one and the GPU uniform. */
  readonly apply: (bias: number) => void;
}

export class CellLodBias {
  readonly #enabled: boolean;
  readonly #mainGpuShare: number;
  readonly #host: ICellLodBiasHost;
  /** The distance multiplier both selection paths are using right now. */
  #bias = LOD_BIAS_MIN;
  /** The clock the step cadence and the first marker line are measured from. */
  readonly #startedAt: number;
  /** The last time a rise or decay step ran. */
  #stepAt: number;
  /** The last time the `TN_LOD_BIAS` line printed. */
  #toldAt: number;

  constructor(enabled: boolean, mainGpuShare: number, host: ICellLodBiasHost) {
    this.#enabled = enabled;
    this.#mainGpuShare = mainGpuShare;
    this.#host = host;
    // The marker is periodic, and a world's first five seconds are its own: the clock starts at the
    // world, not before it, so loading does not print a line.
    this.#startedAt = host.now();
    this.#stepAt = this.#startedAt;
    this.#toldAt = this.#startedAt - LOD_BIAS_MARKER_SECONDS * 1000;
  }

  /**
   * The adaptive LOD bias control loop. Reads the main pass's smoothed GPU time from the renderer
   * and, once per `LOD_BIAS_STEP_SECONDS`, raises the shared bias while that pass is over its share
   * of the frame and decays it back toward 1 while it is comfortably under; between the two it
   * holds, which is the band that keeps a level sitting on the budget from oscillating. A window with
   * no fresh sample is a hold, never a rise on a stale number, and a rise needs the world itself to be
   * the thing being drawn — see {@link #overBudget}, which is also what replaced the warmup
   * seconds. The decay is never gated: a world that can afford its main pass gives the bias back.
   */
  step(renderer: IRendererLike | undefined): void {
    if (this.#enabled === false) {
      // Byte-identical to the pre-bias selection: the multiplier is pinned at 1 every frame.
      this.#apply(LOD_BIAS_MIN);
      return;
    }
    const now = this.#host.now();
    if (now - this.#stepAt < LOD_BIAS_STEP_SECONDS * 1000) return;
    const source = renderer ?? this.#host.renderer();
    // The frame the budget is a share of: the game's resolved target, 60 fps until one is known.
    // Never the frame just measured — an expensive pass makes its own frame long and would pass its
    // own test, and a fast one shrank the share until a 3 ms pass coarsened a world running at
    // 400 fps against a 120 fps target (PRD-478).
    const target = source?.targetFps?.();
    const frameMs = 1000 / (target !== undefined && target > 0 ? target : DEFAULT_TARGET_FPS);
    const gpuMs = source?.gpuMainMs?.();
    if (gpuMs === undefined) return;
    this.#stepAt = now;
    const affordableMs = this.#mainGpuShare * frameMs;
    if (!(affordableMs > 0)) return;
    const bias =
      gpuMs > affordableMs
        ? this.#overBudget()
        : gpuMs < LOD_BIAS_DECAY_SHARE * affordableMs
          ? Math.max(LOD_BIAS_MIN, this.#bias * LOD_BIAS_DECAY)
          : this.#bias;
    if (bias === this.#bias) return;
    this.#apply(bias);
    if (now - this.#toldAt >= LOD_BIAS_MARKER_SECONDS * 1000) {
      this.#toldAt = now;
      const triangles = this.#host.gpuTriangles();
      console.info(
        `${LOD_BIAS_MARKER} bias=${bias.toFixed(3)} gpuMs=${gpuMs.toFixed(2)} ` +
          `budgetMs=${affordableMs.toFixed(2)} ` +
          `tris=${triangles === undefined ? "n/a" : String(triangles)}`,
      );
    }
  }

  /**
   * The next bias while the main pass is over its share of the frame, or the bias unchanged when the
   * world is not what that pass is drawing.
   *
   * A load's GPU time is shader compiles, buffer uploads and the prewarm — none of it main-pass world
   * geometry, so a coarser selection cannot take any of it back. What it costs is the first playable
   * frame: every tree selects the level authored for its distance times the bias, the coarsest levels
   * hold almost nothing, and the shadow casters, which take no bias, leave a band of tree shadows with
   * no trees 80-300 m out. Measured on Machinefall (RTX 2080, WebGPU), the bias climbed 1.08 → 2.33
   * over six `TN_LOD_BIAS` steps, all of them before the loading overlay dropped.
   *
   * So the rise waits for the two measurements that say the world is being drawn: the prewarm gate —
   * what a game's loading screen waits on, and `stats().pendingPrewarm` as the same thing as a number
   * — and the main pass's own GPU-selected triangle tally, where a tally that landed and says zero is
   * a world drawn as nothing. A world with no tally at all (no GPU scene, or nothing landed yet) has no
   * opinion about its own triangles, so the prewarm speaks for it alone. Both are measurements of the
   * thing being judged, which is what the warmup seconds were standing in for.
   */
  #overBudget(): number {
    const prewarm = this.#host.prewarm();
    if (prewarm.queued > 0 || prewarm.owed > prewarm.drawn) return this.#bias;
    if (this.#host.gpuTriangles() === 0) return this.#bias;
    return Math.min(LOD_BIAS_MAX, this.#bias * LOD_BIAS_RISE);
  }

  /** Writes the bias to both selection paths: the shared CPU multiplier and the GPU uniform. */
  #apply(bias: number): void {
    this.#bias = bias;
    this.#host.apply(bias);
  }
}
