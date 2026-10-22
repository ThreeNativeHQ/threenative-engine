import type { Page } from "@playwright/test";
import { STEP_MS } from "./capture-motion-threenative.js";

/**
 * A temporal AA frame depends on where the jitter sequence stands. The engine offsets the projection by one of 31
 * Halton points (`traaJitter`, packages/runtime-native/src/engine/renderer/graph/history.cpp:5), and the resolve keeps
 * a running blend of the frames before. A screenshot that lands on any phase of the sequence differs from the next
 * run's by the sub-pixel offset of that phase: sunlit-room L7 regions moved up to 45 levels between runs with temporal
 * AA on, and by 0 pixels with it off (PRD-636 Decisions, judge2-lane, 2026-10-22).
 *
 * The capture owns the frame loop for the last steps: it holds the gate (FRAME_GATE, capture-motion-threenative.ts),
 * steps one frame at a time on the gate's fixed clock until the engine reports the jitter of `JITTER_PHASE`, takes the
 * screenshot there, and hands the loop back. Unreal's jitter sequence and exposure defaults stay as they are: only the
 * moment of the screenshot is chosen. A page that draws no temporal pass has no jitter and is captured as before.
 */
export const JITTER_PERIOD = 31;
/** The phase every still lands on: the first point of the sequence. */
export const JITTER_PHASE = 0;
/** At least this many steps run on the gate's clock before the frame is taken: two full turns of the sequence. */
export const MIN_STEPS = 2 * JITTER_PERIOD;
/**
 * A metered frame runs this many seconds of the gate's clock first: five time constants of the 1 stop/s the exposure
 * closes at (exposureSettled.ts), so the distance the rest point had in the live loop shrinks to under 1%. The gate's
 * steps are the same on every run, so the exposure that the readings then follow is the same too.
 */
export const EXPOSURE_SETTLE_SECONDS = 5;
export const SETTLE_STEPS = Math.ceil((EXPOSURE_SETTLE_SECONDS * 1000) / STEP_MS);
/** A screenshot that cannot land in this many steps past its minimum (three turns of the sequence) fails closed. */
const EXTRA_STEPS = 3 * JITTER_PERIOD;
/** Set to `free` to take the screenshot on whatever phase the loop is at (the pre-2026-10-22 behaviour, for BEFORE arms). */
export const JITTER_SWITCH = "TN_UNREAL_LOOK_JITTER";

const halton = (start: number, base: number): number => {
  let index = start;
  let fraction = 1;
  let result = 0;
  while (index > 0) {
    fraction /= base;
    result += fraction * (index % base);
    index = Math.floor(index / base);
  }
  return result;
};

/** The sub-pixel offset of a phase, in pixels: the engine's `traaJitter(frame)` with `frame % 31 === phase`. */
export function jitterOf(phase: number): readonly [number, number] {
  if (!Number.isInteger(phase) || phase < 0 || phase >= JITTER_PERIOD)
    throw new Error(
      `TN_UNREAL_LOOK_BAD_INPUT: jitter phase ${phase} is not in 0..${JITTER_PERIOD - 1}`,
    );
  return [halton(phase + 1, 2) - 0.5, halton(phase + 1, 3) - 0.5];
}

/** What the facade reads from the engine each frame (`renderer.info.engine.temporal`). */
export interface ITemporalReading {
  readonly active: boolean;
  readonly frame: number;
  readonly jitter: readonly [number, number];
}

/** True when the engine's last frame was drawn with the jitter of `phase`. The engine prints the offset in float. */
export function atJitterPhase(
  temporal: ITemporalReading | undefined,
  phase = JITTER_PHASE,
): boolean {
  if (temporal === undefined || !temporal.active) return false;
  const [x, y] = jitterOf(phase);
  return Math.abs(temporal.jitter[0] - x) < 1e-6 && Math.abs(temporal.jitter[1] - y) < 1e-6;
}

interface IStep {
  readonly callbacks: number;
  readonly drawn: number;
  readonly skipped: number;
}

const READ_TEMPORAL = "window.__tnRef.renderer.info.engine?.temporal ?? null";
/** Times one step repeats while the engine declines the render (two frames still on the GPU), and the longest wait. */
const MAX_RETRIES = 100;
const MAX_PACE_MS = 400;

type Grabber = Pick<Page, "evaluate" | "waitForTimeout">;

/**
 * Runs `take` (the screenshot) on the frame drawn with the jitter of `JITTER_PHASE`, and gives the loop back after.
 * Throws when the loop moves while `take` runs or the phase cannot be reached: a frame on the wrong phase is a failed
 * capture, not a noisy one.
 */
export async function atFixedJitterPhase<T>(
  page: Grabber,
  take: () => Promise<T>,
  options: { readonly phase?: number; readonly paceMs?: number; readonly minSteps?: number } = {},
): Promise<T> {
  const phase = options.phase ?? JITTER_PHASE;
  const minSteps = options.minSteps ?? MIN_STEPS;
  if (process.env[JITTER_SWITCH] === "free") return take();
  let wait = options.paceMs ?? 80;
  await page.evaluate("window.__tnGate.hold()");
  try {
    let steps = 0;
    let temporal = (await page.evaluate(READ_TEMPORAL)) as ITemporalReading | null;
    // No temporal pass, no jitter: the frame does not depend on a phase.
    if (temporal === null || !temporal.active) return await take();
    while (steps < minSteps || !atJitterPhase(temporal, phase)) {
      if (steps >= minSteps + EXTRA_STEPS)
        throw new Error(
          `TN_UNREAL_LOOK_JITTER_PHASE: the jitter never reached phase ${phase} in ${steps} steps (last frame ${temporal?.frame}, offset ${JSON.stringify(temporal?.jitter)})`,
        );
      for (let attempt = 0; ; attempt++) {
        const step = (await page.evaluate("window.__tnGate.step()")) as IStep;
        if (step.callbacks >= 1 && step.drawn === 0 && step.skipped > 0 && attempt < MAX_RETRIES) {
          wait = Math.min(wait * 1.5, MAX_PACE_MS);
          await page.waitForTimeout(wait);
          continue;
        }
        if (step.callbacks < 1)
          throw new Error("TN_UNREAL_LOOK_JITTER_PHASE: the held loop asked for no frame");
        break;
      }
      steps += 1;
      await page.waitForTimeout(wait);
      temporal = (await page.evaluate(READ_TEMPORAL)) as ITemporalReading | null;
      if (temporal === null)
        throw new Error("TN_UNREAL_LOOK_JITTER_PHASE: the temporal reading vanished");
    }
    console.info(
      `TN_UNREAL_LOOK jitter phase ${phase} at frame ${temporal.frame} after ${steps} steps`,
    );
    const result = await take();
    const after = (await page.evaluate(READ_TEMPORAL)) as ITemporalReading | null;
    if (after?.frame !== temporal.frame || !atJitterPhase(after, phase))
      throw new Error(
        `TN_UNREAL_LOOK_JITTER_PHASE: the loop moved from frame ${temporal.frame} to ${after?.frame} while the screenshot was taken`,
      );
    return result;
  } finally {
    await page.evaluate("window.__tnGate.release()");
  }
}
