/**
 * ThreeNative side of a PRD-638 motion run: the page renders exactly one frame per step, with the camera
 * and the lamps of one frame of the run, and the harness reads that frame back.
 *
 *   pnpm unreal-look:capture --engine threenative --scene gi:cornell --motion pan|switch [--layers L7]
 *
 * The frame loop asks the browser for a frame with requestAnimationFrame. FRAME_GATE replaces it before
 * the page's own scripts run: until `hold()` it passes through, afterwards it queues the callbacks and
 * `step()` hands them one synthetic 1/60 s frame inside a real rendering opportunity. Every step checks
 * that the renderer drew the same number of frames as in the first step and skipped none. A frame the
 * renderer skips (the engine caps frames in flight) would shift the run against Unreal's, so it throws.
 *
 * Frames land in <out>/<scene>/motion/<run>/<layer>/<run>.NNNN.png and still-NNNN.0000.png, the names
 * Unreal's Movie Render Queue writes. Unreal warms 180 frames before the first frame of a run and of a
 * still (REFERENCE_WARM_UP); so does this.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { type ISceneJson, REFERENCE_WARM_UP, sceneKey } from "./gi.js";
import { frameFile, stillJob } from "./motion.js";

/** Milliseconds between two steps: the engine's GPU frame gate lags about 35 ms under Xvfb. */
const PACE_MS = 80;
/** Steps before the frames-per-step count is fixed: a shader compile can add one to the first steps. */
const SETTLE_STEPS = 8;

export const FRAME_GATE = `(() => {
  const real = window.requestAnimationFrame.bind(window);
  const cancelReal = window.cancelAnimationFrame.bind(window);
  const gate = { manual: false, queue: new Map(), next: 1e9, time: 0, steps: 0 };
  window.requestAnimationFrame = (callback) => {
    if (!gate.manual) return real(callback);
    gate.next += 1;
    gate.queue.set(gate.next, callback);
    return gate.next;
  };
  window.cancelAnimationFrame = (id) => {
    if (!gate.queue.delete(id)) cancelReal(id);
  };
  // Switch to queued frames once the loop's pending browser frame has run and asked for the next one.
  gate.hold = () => new Promise((resolve) => {
    gate.manual = true;
    gate.time = performance.now();
    const wait = () => (gate.queue.size > 0 ? resolve(gate.queue.size) : real(wait));
    real(wait);
  });
  // One synthetic frame for everything queued, run inside a real rendering opportunity so the canvas presents.
  gate.step = () => new Promise((resolve, reject) => real(() => {
    const callbacks = [...gate.queue.values()];
    gate.queue.clear();
    gate.time += 1000 / 60;
    gate.steps += 1;
    try {
      for (const callback of callbacks) callback(gate.time);
      resolve(callbacks.length);
    } catch (error) {
      reject(error);
    }
  }));
  window.__tnGate = gate;
})();`;

interface IFrameInfo {
  frame: number;
  skips: number;
}

export interface IMotionCaptureInput {
  page: Page;
  scene: ISceneJson;
  sceneId: string;
  layer: string;
  run: string;
  out: string;
  warmUp?: number;
  paceMs?: number;
}

const frameInfo = (page: Page): Promise<IFrameInfo> =>
  page.evaluate(
    "(() => { const i = window.__tnRef.renderer.info; return { frame: i.frame, skips: i.engine?.frameGateSkips ?? 0 }; })()",
  ) as Promise<IFrameInfo>;

/**
 * Renders the frames of one motion run, and the converged still of each listed frame, and writes them as
 * PNG files. Returns the number of files. Throws when a step does not draw exactly one frame.
 */
export async function captureMotionFrames(input: IMotionCaptureInput): Promise<number> {
  const { page, scene, run } = input;
  const spec = scene.motion?.[run];
  if (!spec) throw new Error(`TN_UNREAL_LOOK_BAD_INPUT: ${input.sceneId} has no motion run ${run}`);
  const warmUp = input.warmUp ?? REFERENCE_WARM_UP;
  const pace = input.paceMs ?? PACE_MS;
  const dir = path.join(input.out, sceneKey(input.sceneId), "motion", run, input.layer);
  await mkdir(dir, { recursive: true });
  const at = (frame: number) =>
    page.evaluate(`window.__tnRef.motionFrame(${JSON.stringify(run)}, ${frame})`);
  await page.evaluate("window.__tnGate.hold()");
  let perStep: number | undefined;
  let steps = 0;
  const firstDrawn: number[] = [];
  const advance = async (label: string) => {
    const before = await frameInfo(page);
    const callbacks = (await page.evaluate("window.__tnGate.step()")) as number;
    const after = await frameInfo(page);
    const drawn = after.frame - before.frame;
    if (firstDrawn.length < 12) firstDrawn.push(drawn);
    // The first steps may count extra frames (a shader compile advances the frame id outside the loop), so the
    // per-step count is read from the first step after SETTLE_STEPS and every later step must match it.
    if (steps >= SETTLE_STEPS) perStep ??= drawn;
    if (
      callbacks < 1 ||
      drawn < 1 ||
      (perStep !== undefined && drawn !== perStep) ||
      after.skips !== before.skips
    )
      throw new Error(
        `TN_UNREAL_LOOK_FRAME_STEP: ${label}: ${callbacks} callbacks, ${drawn} frames drawn (a step draws ${perStep ?? "?"}; the first steps drew ${firstDrawn.join(",")}), ${after.skips - before.skips} skipped`,
      );
    steps += 1;
    await page.waitForTimeout(pace);
  };
  const grab = async (file: string) =>
    writeFile(path.join(dir, file), await page.screenshot({ type: "png" }));
  const started = Date.now();
  await at(0);
  for (let i = 0; i < warmUp; i++) await advance(`${run} warm-up ${i}`);
  for (let frame = 0; frame < spec.frames; frame++) {
    await at(frame);
    await advance(`${run} frame ${frame}`);
    await grab(frameFile(run, frame));
  }
  const stills = spec.stills ?? [];
  for (const frame of stills) {
    await at(frame);
    for (let i = 0; i < warmUp; i++) await advance(`still ${frame} warm-up ${i}`);
    await advance(`still ${frame}`);
    await grab(frameFile(stillJob(frame), 0));
  }
  await writeFile(
    path.join(dir, "motion-capture.json"),
    `${JSON.stringify(
      {
        scene: input.sceneId,
        run,
        layer: input.layer,
        frames: spec.frames,
        stills,
        warmUp,
        steps,
        framesDrawnPerStep: perStep,
        firstStepsDrew: firstDrawn,
        paceMs: pace,
        seconds: (Date.now() - started) / 1000,
      },
      null,
      2,
    )}\n`,
  );
  return spec.frames + stills.length;
}
