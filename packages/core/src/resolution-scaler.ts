/**
 * The adaptive drawing-buffer scale: PRD-228 Change A's loop.
 *
 * A game reaches its `display.maxFps` target without hand-authoring a resolution constant.
 * Bayview's own constant took an afternoon and three ladder rungs to find on a physical Pixel 8;
 * the next game would have repeated that from scratch, which is what makes the loop framework
 * work rather than game work.
 *
 * Every number below is pre-registered in the PRD before this file existed and is read from one
 * constant block. A controller tuned inside its own implementation until a playtest went green is
 * a controller nobody can argue with afterwards, so the values move by editing the PRD.
 *
 * Nothing here touches the overlay surface, the camera or the aspect ratio: only the 3D drawing
 * buffer moves, which is the arrangement the device ladder measured and accepted.
 */

import type { GpuClass } from "./gpu-class.js";

/** How the active scale was arrived at, reported beside every fps number. */
export type ScaleSource = "pinned" | "auto" | "auto-pinned";

export const RESOLUTION_SCALER = {
  /**
   * Ratio 0.85 linear, so each step is 0.72x the pixels. Coarse on purpose: every step
   * reallocates render targets on WebGPU, and fine granularity buys smoothness with hitches.
   */
  rungs: [1.0, 0.85, 0.72, 0.61, 0.52, 0.44, 0.38, 0.32, 0.27, 0.23] as const,
  /**
   * The lowest rung a desktop may take while nothing in the render chain reconstructs a
   * full-resolution frame from the smaller one.
   *
   * The ladder above is the device arm's, and it ends at 0.23 because a phone buys the pixels back
   * differently. A desktop has nothing: no temporal stage, no reconstruction, just 5% of the
   * pixels stretched across the panel, which is blocky mush rather than a slow frame — and the
   * report at that point claims the budget was met. 0.61 is where surrendering more pixels stops
   * buying frame time worth what it costs to look at, and it is reported as `atFloor` rather than
   * passed in silence. A host whose chain *does* reconstruct the frame says so, and the deep
   * rungs come back; `renderer-config.ts` decides which floor a platform starts with.
   */
  desktopFloorScale: 0.61,
  /**
   * The rung a class of adapter starts on instead of the ceiling; a class not named here starts at
   * 1.0. Only `mobile-low` moves: one rung down is 0.85, close to the 0.8 content scale Unreal's
   * Low Android bucket sets. A start is a guess the first eligible window corrects — it steps down
   * at once and climbs after `upWindows` clean ones — so a wrong row costs windows, not a stuck
   * look. `unknown` and `discrete` keep the ceiling on purpose: a strong GPU is never capped by a
   * table row.
   */
  startScaleByGpuClass: { "mobile-low": 0.85 } as Partial<Record<GpuClass, number>>,
  /**
   * The signal is **fps against the configured target**, not the presented interval.
   *
   * Amended 2026-08-28 from a device arm, before the second implementation. The original triggers
   * were `presented p95 > 14 ms` down and `< 11.5 ms` up. Under FIFO the presented interval is the
   * *panel's* period, not the game's cost: a game locked at 60 fps on a 60 Hz panel reports
   * presented p95 around 17.5 ms, so `> 14` is true forever. A scaffolded template holding
   * 59.99 fps with a `frame p95` of 7.99 ms out of 16.67 was walked to 552x248 and then told it
   * had run out of room. fps is correct in both regimes: it comes from the mean presented
   * interval, so dropped frames pull it down on their own, and a missed target is missed whether
   * or not a panel caps the top.
   */
  targetFpsFraction: 0.98,
  /**
   * The tail guard on the up-step only. A frame that hits its average target while dropping frames
   * has headroom on paper and none in the hand. A vsync-capped panel's own p95 floor sits near
   * 1.05x the budget, comfortably inside this.
   */
  upTailFraction: 1.15,
  /**
   * A window whose presented p99 is at least this many times its p50 is measuring a **stall**, not
   * a frame rate, and the controller defers on it rather than acting.
   *
   * Amended 2026-08-30 from a browser arm, and this is the second time the fps signal has needed
   * correcting for the same underlying reason: `fps` is `1000 / mean`, and a mean is not robust.
   * `sandbox/lumen-hall` on an NVIDIA Turing at 1600x900 spent its second window building WebGPU
   * pipelines for a five-stage TSL chain. Four of that window's 300 frames took about two seconds
   * each — under `hitchMs`, so they stayed in the window and were averaged. The window reported
   * **22.6 fps** with a **p50 of 9.8 ms**, which is 102 fps. The controller read a 2.6x deficit,
   * took its maximum four-rung jump to 0.52, and the game held 145 fps at 832x468 for the next
   * forty seconds — a third of its pixels surrendered to fix a frame rate that was never missed.
   * The window's own record carried the contradiction the whole time and nothing read it.
   *
   * A down-step is also the wrong medicine specifically here: the resize reallocates every render
   * target, which rebuilds pipelines, which is what stalled in the first place.
   *
   * Ten is chosen to separate the two regimes rather than to tune a result, and the numbers are
   * not close. A vsync-capped panel dropping frames — the case `fps`-from-mean exists to catch —
   * has a p99 of one extra panel period, so a ratio near 2; a game that is simply slow has a ratio
   * near 1. The lumen-hall window's ratio was 200. Nothing real sits between.
   */
  stallP99Multiple: 10,
  /**
   * p99 needs at least three bad samples in a 300-frame window. One profiler or debugger pause can
   * still pull fps-from-mean below the down threshold, so the maximum gets the same stall test.
   * Ordinary missed presents are around 2x p50 and stay far below this boundary.
   */
  stallMaxMultiple: 10,
  /** React to a deficit immediately; climb only on sustained evidence. Asymmetric by design. */
  downWindows: 1,
  upWindows: 4,
  /** Eight frames for the sampled GPU reading plus eight for asynchronous query resolution. */
  maxGpuAgeFrames: 16,
  /** Window GPU samples that make the window's own median fresh evidence; see `IScalerWindow.gpu`. */
  minWindowGpuSamples: 4,
  /** The resize frame is itself a hitch and must never feed the controller. */
  cooldownWindows: 1,
  /**
   * Windows discarded outright at the start. "Window 1 always lies" is already the perf CLI's
   * rule; the controller was the one consumer that believed it. A scaffolded template took its
   * only down-step from a cold-start window reading 51.52 fps while still loading, then spent
   * four windows climbing back to where it started.
   */
  warmupWindows: 1,
  /**
   * The most rungs one down-step may cross. Applies only when fresh GPU timing sizes the
   * jump; without it the fallback below probes a single rung and refunds what earns nothing.
   *
   * Falling one rung per decision costs about twenty seconds per rung at the top of the ladder,
   * and the ladder is ten rungs deep — a game starting at DPR-1 physical spent about three
   * minutes visibly at 29 fps before settling. The jump size comes from the deficit: one window
   * cannot separate the fixed cost from the pixel cost, so it attributes the whole deficit to
   * pixels when GPU timing is unavailable. With fresh GPU timing, the GPU deficit sizes the
   * jump instead: host delay cannot be recovered by surrendering pixels.
   */
  maxDownRungs: 4,
  /**
   * Two down-up-down cycles across one boundary inhibit upward probes for this many windows.
   *
   * The PRD pre-registered this reach as 3 windows. That value cannot fire: a down-then-up leg
   * costs at least `cooldownWindows + upWindows` = 5 windows by the rest of this same table, so a
   * 3-window reach only ever sees the up-then-down leg and the guard is dead code. The reach is
   * therefore derived from the table rather than picked — the tightest a down-up leg can be, plus
   * one — and the correction is recorded in the PRD instead of being tuned in here.
   */
  oscillationCycles: 2,
  oscillationWindows: 1 + 4 + 1,
  /**
   * The insensitivity guard. A downward step is a hypothesis — fewer pixels will buy a faster
   * frame — and it is only paid when the measured GPU cost falls with the pixels. On a scene whose
   * cost is geometry, shadow maps or host work, `gpuMs` stays flat and the controller walks the
   * picture to the floor with the frame exactly as slow: a real browser arm held `GPU p50` of
   * 4-11 ms at scale 0.23 against 6-20 ms at scale 1.
   *
   * After a downward step the scaler compares the GPU time that motivated the step against the GPU
   * time at the new rung. A relative gain below `insensitiveGainFraction`, on a step that cut at
   * least `insensitiveMinPixelDrop` of the pixels, means the cost is not pixel-bound: the step is
   * refunded, the rung it came from becomes the floor, and no further pixels are spent until
   * `insensitiveRiseFraction` of sustained rise shows the workload changed.
   */
  insensitiveGainFraction: 0.1,
  insensitiveMinPixelDrop: 0.2,
  /** A rise of the measured signal over this multiple is a changed workload, not the same one. */
  insensitiveRiseFraction: 1.25,
  /** Consecutive above-`insensitiveRiseFraction` windows needed to clear the memory. */
  insensitiveResetWindows: 2,
  /** A restored rung is held this many windows before any downward probe is reconsidered. */
  insensitiveHoldWindows: 2,
  /**
   * Marker gap: one line per this many windows, so at most one per 5 s at a 120 fps target on the
   * 300-frame report window and longer below it, never shorter.
   */
  insensitiveMarkerWindows: 2,
} as const;

/** Printed when a downward step is refunded because the frame did not respond to the pixels. */
export const RESOLUTION_SCALE_INSENSITIVE_MARKER = "TN_RESOLUTION_SCALE_INSENSITIVE";

/** Pixels retained per rung: 0.85 linear on each axis. */
const RUNG_PIXEL_RATIO = 0.85 * 0.85;

/** One rung value to its index, failing closed on anything the ladder does not contain. */
function rungIndex(value: number, label: string): number {
  const index = RESOLUTION_SCALER.rungs.indexOf(value as never);
  if (index < 0)
    throw new Error(
      `ResolutionScaler ${label} must be one of the pre-registered rung values, received ${String(value)}.`,
    );
  return index;
}

export interface IResolutionScalerOptions {
  /** The `display.maxFps` the loop is holding the budget against. */
  readonly targetFps: number;
  /** Which rung to start on. Must be one of the rungs; defaults to the ceiling. */
  readonly start?: number;
  /**
   * The lowest rung this platform may take, and the rung `atFloor` is reported at. Must be one of
   * the rungs; defaults to the last one, which is the whole ladder the device arm measured with.
   * A desktop host passes `RESOLUTION_SCALER.desktopFloorScale`.
   */
  readonly minScale?: number;
  /**
   * Read whenever the floor is consulted, so the scaler can see a render chain that arrived or
   * changed under it: a chain that reconstructs a display-resolution frame from these pixels
   * lifts the floor for as long as it is installed.
   */
  readonly temporalUpscale?: () => boolean;
}

/** A closed frame-budget window's presentation distribution and optional GPU observation. */
export interface IScalerWindow {
  /** The last resolved GPU duration and its age; absent/old observations may only probe. */
  readonly gpuMs?: number;
  readonly gpuAgeFrames?: number;
  /**
   * This window's own GPU samples. When the last resolve is past `maxGpuAgeFrames` but the window
   * holds `minWindowGpuSamples` of them, their median stands in: they were drawn in this window.
   */
  readonly gpu?: { readonly p50: number; readonly samples: number };
  /** Frames per second this window achieved, from the mean presented interval. */
  readonly fps: number;
  /**
   * `p50` says what an ordinary frame cost; `p99` and `max` expose recurring and isolated stalls.
   * The controller needs them to tell a slow game from a stalled one: `fps` alone cannot, because
   * it comes from a mean.
   */
  readonly presented: {
    readonly max: number;
    readonly p50: number;
    readonly p95: number;
    readonly p99: number;
  };
}

export class ResolutionScaler {
  /** fps at or above this is meeting the target. Mutable only through `retarget`. */
  // The three budget fields are placeholders the constructor overwrites before anything can read
  // them; TypeScript cannot see that through the `retarget` call every constructor makes.
  targetFps = 0;
  /**
   * A presented interval above this is a frame that cost more than the target allows: the same
   * bar `targetFps` is, read as a period instead of a rate. Nothing new is chosen here — it is
   * `targetFpsFraction` again, applied to the statistic a mean cannot speak for.
   */
  budgetMs = 0;
  /** presented p95 above this is dropping frames, whatever the mean says. */
  tailMs = 0;
  #index: number;
  /** The lowest rung this platform may take; the whole ladder's last index when it states none. */
  readonly #minIndex: number;
  readonly #temporalUpscale: (() => boolean) | undefined;
  #scaleSource: Exclude<ScaleSource, "pinned"> = "auto";
  #cleanWindows = 0;
  #cooldown = 0;
  #warmup = RESOLUTION_SCALER.warmupWindows;
  #windowIndex = 0;
  // Oscillation state. A "boundary" is the higher of the two rungs a step crossed, so a fall
  // from 1.0 and the climb back to it are recognised as the same boundary.
  #guardBoundary = -1;
  #guardDirection = 0;
  #guardLegs = 0;
  #guardCycles = 0;
  #guardWindow = 0;
  #pinWindows = 0;
  // Unknown-GPU probe state. A down-step taken without fresh GPU timing is a hypothesis —
  // fewer pixels will recover the frame rate — and the next decided window tests it against
  // the fps that motivated it. `#probeBlind` records a failed hypothesis: reprobing the same
  // host-bound workload would only flicker, so unknown-GPU probes stop until fresh timing or
  // a recovered frame rate reopens the question. `#lastHealthyWindow` records the last window
  // whose fresh GPU timing showed headroom, so a single gap after healthy timing holds
  // instead of probing.
  #probeFps: number | undefined = undefined;
  #probeBlind = false;
  #lastHealthyWindow = 0;
  // Insensitivity memory. `#insensitiveProbe` is the outstanding hypothesis of a fresh-GPU
  // downward step; `#insensitiveFloor` is the rung a refunded one proved worth holding (no
  // downward step may cross it while it stands), `#insensitiveSignal` its measured GPU time, and
  // `#insensitiveRise` the consecutive windows of sustained rise that clear both.
  #insensitiveProbe: { fromIndex: number; toIndex: number; signal: number } | undefined = undefined;
  #insensitiveFloor = -1;
  #insensitiveSignal = 0;
  #insensitiveRise = 0;
  #insensitiveHold = 0;
  #lastInsensitiveMarker = Number.NEGATIVE_INFINITY;

  constructor(options: IResolutionScalerOptions) {
    const { minScale, start, targetFps, temporalUpscale } = options;
    this.retarget(targetFps);
    this.#index = start === undefined ? 0 : rungIndex(start, "start");
    this.#minIndex =
      minScale === undefined ? RESOLUTION_SCALER.rungs.length - 1 : rungIndex(minScale, "minScale");
    this.#temporalUpscale = temporalUpscale;
  }

  /**
   * Re-reads the budget when the engine's resolved display target changes.
   *
   * The web cannot know a panel's rate before it has presented a window's worth of frames, so a
   * 120 Hz display starts on the 60 fallback and moves. The rungs and every decision already made
   * stay: only the bar the next window is judged against changes, and a target that is not a
   * positive rate throws exactly as it does in the constructor.
   */
  retarget(targetFps: number): void {
    if (!Number.isFinite(targetFps) || targetFps <= 0)
      throw new Error(
        `ResolutionScaler targetFps must be a finite number greater than zero, received ${String(targetFps)}.`,
      );
    this.targetFps = targetFps * RESOLUTION_SCALER.targetFpsFraction;
    this.budgetMs = 1000 / this.targetFps;
    this.tailMs = (1000 / targetFps) * RESOLUTION_SCALER.upTailFraction;
  }

  /** The scale the renderer should be applying right now. */
  get scale(): number {
    return RESOLUTION_SCALER.rungs[this.#index] ?? 1;
  }

  /**
   * The lowest rung the scaler may take right now. The platform's own floor, lifted for as long
   * as the render chain reconstructs the frame from the pixels it is being asked to surrender.
   */
  get #limitIndex(): number {
    return this.#temporalUpscale?.() === true ? RESOLUTION_SCALER.rungs.length - 1 : this.#minIndex;
  }

  get scaleSource(): Exclude<ScaleSource, "pinned"> {
    return this.#scaleSource;
  }

  /**
   * True when the floor is reached and the tail is still over budget. The window keeps reporting
   * the true scale: a scaler that ran out of room must say so rather than let the number read as
   * a met budget.
   */
  get atFloor(): boolean {
    return this.#atFloor;
  }
  #atFloor = false;

  /**
   * Feeds one completed frame-budget window. Returns the new scale when this window caused a
   * step, `undefined` otherwise. Allocation-free: no object is constructed on the steady path.
   */
  observe(window: IScalerWindow): number | undefined {
    this.#windowIndex += 1;
    if (this.#scaleSource === "auto-pinned" && --this.#pinWindows === 0) {
      this.#scaleSource = "auto";
      this.#guardLegs = this.#guardCycles = this.#cleanWindows = 0;
      // The loop propagates scaleSource only when a scale is returned, including an unchanged one.
      return this.scale;
    }
    if (this.#warmup > 0) {
      this.#warmup -= 1;
      return undefined;
    }
    if (this.#cooldown > 0) {
      this.#cooldown -= 1;
      return undefined;
    }
    // A stalled window is not a measurement of the frame rate, in either direction: acting on the
    // mean would cut resolution the game did not need, and counting it clean would climb on a
    // window that was mostly spent stopped. Deferring means neither — the clean run it interrupts
    // is left standing rather than thrown away. Resetting it made the up-path unreachable for any
    // game that hitches more often than once every `cooldownWindows + upWindows` windows: one
    // 400 ms frame every third window pinned a scaler at 0.44 through seventeen minutes of
    // otherwise perfect 60 fps, which is a forest streaming its next hillside.
    //
    // Unless the stalls are not what makes the frame slow: a weak GPU whose shadow redraws stall
    // every window and whose ordinary frame still misses the budget is judged on that frame,
    // downward only (see `#slowUnderStalls`).
    const stalled = this.#stalled(window);
    if (stalled && !this.#slowUnderStalls(window)) return undefined;
    const gpuMs = this.#freshGpuMs(window);
    this.#noteGpuObservation(window, gpuMs);
    if (this.#insensitiveHold > 0) this.#insensitiveHold -= 1;
    this.#trackInsensitiveRise(gpuMs);
    const refunded = this.#settleInsensitiveProbe(gpuMs);
    if (refunded !== undefined) return refunded;
    if (window.fps < this.targetFps && (gpuMs === undefined || gpuMs > this.budgetMs)) {
      // **Only the mean is under target: hold.** `fps` is `1000 / mean`, and on the one panel
      // arrangement every game actually ships into — `display.maxFps` equal to the refresh rate,
      // vsync on — the mean is the only statistic with any room to move. fps is bounded *above*
      // by the target there, so the whole test lives in the 2% under it, and each present the
      // compositor drops spends a third of a percent. Seven doubled intervals out of 300 crossed
      // the bar on `sandbox/wildwood` while the median and the tail both sat on the panel period,
      // and fewer pixels do not bring a dropped present back: the step won nothing, the next
      // window spent another rung, and the picture walked to 5% of its pixels in 140 seconds.
      // This is `stallP99Multiple`'s lesson at 2x rather than at 10x.
      //
      // Deferred rather than merely not acted on, and the difference is the whole repair. Such a
      // window says nothing about the pixel cost **in either direction**, which is exactly what
      // the stall guard above says about its own case — so it is neither grounds to fall nor a
      // reason to throw away the clean run a climb needs. Counting it against the climb stops the
      // descent and never gives the pixels back: replayed against the state `sandbox/wildwood`'s
      // own record documents — parked at 0.61 while holding 60.0 fps — that reading held 0.61 for
      // five minutes. The picture stops getting worse and never gets sharp again, which is half a
      // fix and the wrong half.
      if (!this.#overBudget(window)) return undefined;
      this.#cleanWindows = 0;
      // Unknown GPU timing is not evidence of a GPU bottleneck: an adapter without timestamp
      // queries reports nothing either way, and neither this window's fps nor its presentation
      // tail can separate fixed host cost from pixel cost. So the fallback may only probe —
      // one rung down, refunded unless fewer pixels earn a better frame rate.
      // The memory holds both kinds of probe: a workload already shown not to answer to pixels
      // does not become pixel-bound just because this window lost its GPU timestamp.
      if (this.#insensitiveHold > 0 || this.#insensitiveFloor >= 0) return undefined;
      if (gpuMs === undefined) return this.#probeUnknown(window);
      if (this.#index >= this.#limitIndex) {
        this.#atFloor = true;
        return undefined;
      }
      const fromIndex = this.#index;
      const stepped = this.#step(this.#rungsToDrop(1000 / gpuMs));
      // Record the hypothesis only for a fresh-GPU step: that is the signal that can separate
      // pixel cost from host cost, and a step the oscillation guard has just pinned is not one
      // the next window will be allowed to test.
      if (this.#scaleSource === "auto") {
        const pixelDrop = 1 - (this.scale / (RESOLUTION_SCALER.rungs[fromIndex] ?? 1)) ** 2;
        if (pixelDrop >= RESOLUTION_SCALER.insensitiveMinPixelDrop)
          this.#insensitiveProbe = { fromIndex, toIndex: this.#index, signal: gpuMs };
      }
      return stepped;
    }
    this.#atFloor = false;
    // A stalled window is never grounds to climb.
    if (stalled) return undefined;
    if (this.#scaleSource === "auto-pinned") return undefined;
    const nextScale = RESOLUTION_SCALER.rungs[Math.max(0, this.#index - 1)] ?? 1;
    const canClimb =
      gpuMs === undefined
        ? window.presented.p95 <= this.tailMs
        : gpuMs * (nextScale / this.scale) ** 2 <= this.budgetMs;
    if (!canClimb) {
      this.#cleanWindows = 0;
      return undefined;
    }
    this.#cleanWindows += 1;
    if (this.#cleanWindows < RESOLUTION_SCALER.upWindows) return undefined;
    this.#cleanWindows = 0;
    if (this.#index === 0) return undefined;
    return this.#step(-1);
  }

  /**
   * Records what this window's GPU observation settles about earlier inferences. Fresh timing
   * supersedes everything drawn from its absence; a recovered frame rate reopens a question a
   * failed probe closed, because the workload changed.
   */
  #noteGpuObservation(window: IScalerWindow, gpuMs: number | undefined): void {
    if (gpuMs !== undefined) {
      this.#probeFps = undefined;
      this.#probeBlind = false;
      if (gpuMs <= this.budgetMs) this.#lastHealthyWindow = this.#windowIndex;
    } else if (window.fps >= this.targetFps) {
      this.#probeFps = undefined;
      this.#probeBlind = false;
    }
  }

  /**
   * Settles the outstanding insensitivity hypothesis against this window's fresh GPU time. Returns
   * the restored scale when the step is refunded, `undefined` when it earned its pixels or there is
   * nothing to settle. A window without fresh timing waits rather than guessing.
   */
  #settleInsensitiveProbe(gpuMs: number | undefined): number | undefined {
    const probe = this.#insensitiveProbe;
    if (probe === undefined || gpuMs === undefined) return undefined;
    this.#insensitiveProbe = undefined;
    const gain = (probe.signal - gpuMs) / probe.signal;
    if (gain >= RESOLUTION_SCALER.insensitiveGainFraction) return undefined;
    const restored = RESOLUTION_SCALER.rungs[probe.fromIndex] ?? 1;
    this.#index = probe.fromIndex;
    this.#insensitiveFloor = probe.fromIndex;
    this.#insensitiveSignal = probe.signal;
    this.#insensitiveHold = RESOLUTION_SCALER.insensitiveHoldWindows;
    this.#cleanWindows = 0;
    // The restore is itself a resize and must not feed the controller.
    this.#cooldown = RESOLUTION_SCALER.cooldownWindows;
    this.#emitInsensitive(RESOLUTION_SCALER.rungs[probe.toIndex] ?? 1, restored, gain);
    return restored;
  }

  /**
   * Clears the memory once the measured signal has risen past `insensitiveRiseFraction` for
   * `insensitiveResetWindows` windows: a heavier workload may be pixel-bound where the old one was
   * not, and the floor it set must not lock the picture soft for the rest of the session.
   */
  #trackInsensitiveRise(gpuMs: number | undefined): void {
    if (this.#insensitiveFloor < 0 || gpuMs === undefined) return;
    if (gpuMs <= this.#insensitiveSignal * RESOLUTION_SCALER.insensitiveRiseFraction) {
      this.#insensitiveRise = 0;
      return;
    }
    this.#insensitiveRise += 1;
    if (this.#insensitiveRise < RESOLUTION_SCALER.insensitiveResetWindows) return;
    this.#insensitiveFloor = -1;
    this.#insensitiveSignal = 0;
    this.#insensitiveRise = 0;
    this.#insensitiveHold = 0;
  }

  /** One marker per refunded step, no more often than `insensitiveMarkerWindows`. */
  #emitInsensitive(scale: number, restored: number, gain: number): void {
    if (
      this.#windowIndex - this.#lastInsensitiveMarker <
      RESOLUTION_SCALER.insensitiveMarkerWindows
    )
      return;
    this.#lastInsensitiveMarker = this.#windowIndex;
    console.info(
      `${RESOLUTION_SCALE_INSENSITIVE_MARKER} scale=${String(scale)} restored=${String(restored)} gainPct=${String(Math.round(gain * 100))}`,
    );
  }

  /**
   * One decided over-budget window with no fresh GPU timing. Returns the new scale when this
   * window caused a step, `undefined` otherwise.
   */
  #probeUnknown(window: IScalerWindow): number | undefined {
    // A pending probe is evaluated before the floor guard: parking at the final rung must
    // not strand the hypothesis that fewer pixels would help. Improvement counts only when
    // the new deficit prices fewer rungs than the old one — the same rung table as every
    // sized jump, so timing noise that never crosses a rung boundary refunds instead of
    // ratcheting the ladder down one tremor at a time.
    if (this.#probeFps !== undefined) {
      const earned = this.#rungsToDrop(window.fps) < this.#rungsToDrop(this.#probeFps);
      this.#probeFps = undefined;
      if (!earned) {
        this.#probeBlind = true;
        return this.#step(-1, false);
      }
      if (this.#index >= this.#limitIndex) {
        this.#atFloor = true;
        return undefined;
      }
      this.#probeFps = window.fps;
      return this.#step(1);
    }
    if (this.#index >= this.#limitIndex) {
      this.#atFloor = true;
      return undefined;
    }
    // A gap immediately after fresh-healthy timing is transient, not a new bottleneck.
    if (this.#windowIndex - this.#lastHealthyWindow <= 1) return undefined;
    if (this.#probeBlind) return undefined;
    this.#probeFps = window.fps;
    return this.#step(1);
  }
  /**
   * True when the median or tail corroborates the missed presentation budget. This alone cannot
   * identify a pixel bottleneck; fresh GPU timing takes precedence in observe().
   *
   * Two independent witnesses, each already carrying its own pre-registered bar, and either is
   * enough:
   *
   *  - **the median present is over the target's period.** An unlocked renderer holding a steady
   *    17.24 ms against a 16.67 ms budget shows up here and nowhere else: its tail is as tight as
   *    its middle, and it is simply doing too much work every frame.
   *  - **the tail is past `tailMs`.** Under FIFO an interval is a whole number of panel periods,
   *    so a game that misses a real share of its vsyncs moves p95 to two periods in one jump —
   *    the 45 fps window the device arm chose the mean signal for. There is nothing in between to
   *    fall through: `upTailFraction` sits in the empty gap between one period and two.
   *
   * When neither speaks, the deficit is a handful of doubled intervals in an otherwise on-budget
   * window: jitter from the compositor, a GC, an input burst, an audio callback. None of that is
   * bought back with pixels, and spending a rung on it is how the picture walks to the floor.
   */
  /**
   * Whether a stalled window's ordinary frame misses the budget on its own: the window is under
   * target and fresh GPU timing alone exceeds the budget, so setting the stalls aside still leaves
   * a slow frame that fewer pixels can speed up. A game whose GPU meets the budget keeps the stall
   * deferral; a weak GPU does not stay at full resolution forever because its hitches recur. On an
   * Intel Iris Xe, Machinefall's shadow redraws (120-350 ms) put presented p99 at 15-63x p50 in
   * all but one judged window, p50 sat at 9-12 ms against 8.33, and the scale held 1.0 for the
   * whole walk (PRD-549).
   */
  #slowUnderStalls(window: IScalerWindow): boolean {
    const gpuMs = this.#freshGpuMs(window);
    // Fresh GPU over budget in a window under target. Not the present median: on the Iris Xe it
    // read 7 ms while the main pass took 30 ms and the window ran at 35 fps (PRD-549, live11).
    return window.fps < this.targetFps && gpuMs !== undefined && gpuMs > this.budgetMs;
  }

  #overBudget(window: IScalerWindow): boolean {
    return window.presented.p50 > this.budgetMs || window.presented.p95 > this.tailMs;
  }

  #freshGpuMs({ gpu, gpuMs, gpuAgeFrames }: IScalerWindow): number | undefined {
    if (
      gpuMs !== undefined &&
      Number.isFinite(gpuMs) &&
      gpuMs > 0 &&
      gpuAgeFrames !== undefined &&
      Number.isInteger(gpuAgeFrames) &&
      gpuAgeFrames >= 0 &&
      gpuAgeFrames <= RESOLUTION_SCALER.maxGpuAgeFrames
    )
      return gpuMs;
    // An integrated GPU resolves timestamps hundreds of frames late (Iris Xe: 233-593, PRD-549),
    // so the last reading is always old while the window is full of its own samples.
    return gpu !== undefined &&
      gpu.samples >= RESOLUTION_SCALER.minWindowGpuSamples &&
      Number.isFinite(gpu.p50) &&
      gpu.p50 > 0
      ? gpu.p50
      : undefined;
  }

  /**
   * True when this window's recurring tail or single worst sample is an order of magnitude past
   * its middle, which is a stall rather than a frame rate. A window with no p50 to compare against
   * says nothing either way.
   */
  #stalled(window: IScalerWindow): boolean {
    const { max, p50, p99 } = window.presented;
    if (!(p50 > 0) || !Number.isFinite(p99) || !Number.isFinite(max)) return false;
    return (
      p99 >= p50 * RESOLUTION_SCALER.stallP99Multiple ||
      max >= p50 * RESOLUTION_SCALER.stallMaxMultiple
    );
  }

  /**
   * How many rungs one down-step should cross, from the fps deficit alone.
   *
   * Each rung is `0.72x` the pixels, so closing a deficit of `target / measured` needs
   * `log(deficit) / log(1 / 0.72)` rungs if the whole frame scaled with pixels. It does not — but
   * a single window cannot say how much of it does, and the up-step is there to give back what
   * this takes too eagerly.
   */
  #rungsToDrop(fps: number): number {
    if (!(fps > 0)) return RESOLUTION_SCALER.maxDownRungs;
    const deficit = this.targetFps / fps;
    if (!(deficit > 1)) return 1;
    const rungs = Math.ceil(Math.log(deficit) / Math.log(1 / RUNG_PIXEL_RATIO));
    return Math.min(Math.max(1, rungs), RESOLUTION_SCALER.maxDownRungs);
  }

  #step(direction: number, countGuard = true): number {
    // The boundary a fall from rung n crosses is the same one the climb back to n crosses.
    const boundary = direction > 0 ? this.#index : this.#index - 1;
    // The platform's floor is a limit, not a step count: a jump sized on a deficit can ask for
    // more rungs than the floor allows, and it must land on the floor rather than past it.
    const next = this.#index + direction;
    this.#index = direction > 0 ? Math.min(next, this.#limitIndex) : Math.max(0, next);
    this.#cooldown = RESOLUTION_SCALER.cooldownWindows;
    // A refund is a measurement correction, not workload oscillation: counting it would let
    // probe/refund cycles pin the scaler at a rung pixels were just proven not to earn.
    if (countGuard) this.#noteForOscillationGuard(boundary, direction);
    return this.scale;
  }

  #noteForOscillationGuard(boundary: number, direction: number): void {
    const withinReach =
      this.#windowIndex - this.#guardWindow <= RESOLUTION_SCALER.oscillationWindows;
    const continues =
      boundary === this.#guardBoundary && withinReach && direction !== this.#guardDirection;
    this.#guardLegs = continues ? this.#guardLegs + 1 : 1;
    this.#guardBoundary = boundary;
    this.#guardDirection = direction;
    this.#guardWindow = this.#windowIndex;
    // down, up, down is one cycle. The next cycle reuses this leg as its first.
    if (this.#guardLegs < 3) return;
    this.#guardLegs = 1;
    this.#guardCycles += 1;
    if (this.#guardCycles < RESOLUTION_SCALER.oscillationCycles) return;
    // Suppress upward probes temporarily; neither recovery nor later overload may be locked out
    // for the rest of a session because the workload once sat near a thermal edge.
    this.#index = Math.max(this.#index, boundary + 1);
    this.#scaleSource = "auto-pinned";
    this.#pinWindows = RESOLUTION_SCALER.oscillationWindows;
  }
}
