/**
 * ThreeNative side of a PRD-638 motion run: the page renders exactly one frame per step, with the camera
 * and the lamps of one frame of the run, and the harness reads that frame back.
 *
 *   pnpm unreal-look:capture --engine threenative --scene gi:cornell --motion pan|switch [--layers L7]
 *
 * The frame loop asks the browser for a frame with requestAnimationFrame. FRAME_GATE replaces it before
 * the page's own scripts run: until `hold()` it passes through, afterwards it queues the callbacks and
 * `step()` hands them one synthetic 1/60 s frame inside a real rendering opportunity. Every step must draw
 * at least one frame. The engine declines a render while two frames are still on the GPU (a loaded host);
 * that step drew nothing, so it is repeated, with a longer wait, until a frame is drawn. A step that both
 * draws and skips throws: it would shift the run against Unreal's.
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
/** Steps before the draws per step are counted: a shader compile can add one to the first steps. */
const SETTLE_STEPS = 8;
/** Times one step is repeated while the GPU frame gate declines it, and the longest wait between steps. */
const MAX_RETRIES = 100;
const MAX_PACE_MS = 400;

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
  // The renderer's drawn-frame and declined-render counters: info.frame and info.engine.frameGateSkips.
  const counters = () => {
    const info = window.__tnRef.renderer.info;
    return { frame: info.frame, skips: info.engine?.frameGateSkips ?? 0 };
  };
  // One synthetic frame for everything queued, run inside a real rendering opportunity so the canvas presents.
  // Resolves with how many callbacks ran and how many frames the renderer drew and declined while they ran.
  gate.step = () => new Promise((resolve, reject) => real(() => {
    const callbacks = [...gate.queue.values()];
    gate.queue.clear();
    gate.time += 1000 / 60;
    gate.steps += 1;
    try {
      const before = counters();
      for (const callback of callbacks) callback(gate.time);
      const after = counters();
      resolve({ callbacks: callbacks.length, drawn: after.frame - before.frame, skipped: after.skips - before.skips });
    } catch (error) {
      reject(error);
    }
  }));
  window.__tnGate = gate;
})();`;

interface IStep {
  callbacks: number;
  drawn: number;
  skipped: number;
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
  let steps = 0;
  let retried = 0;
  let wait = pace;
  const drew = new Map<number, number>();
  // One more step of the loop, repeated while the engine's GPU frame gate declines it. A declined step drew
  // nothing, so the render state did not move, and the next step is the same frame of the run. A loaded host
  // leaves two frames on the GPU, so each repeat also waits longer.
  const advance = async (label: string) => {
    for (let attempt = 0; ; attempt++) {
      const { callbacks, drawn, skipped } = (await page.evaluate(
        "window.__tnGate.step()",
      )) as IStep;
      if (callbacks >= 1 && drawn === 0 && skipped > 0 && attempt < MAX_RETRIES) {
        retried += 1;
        wait = Math.min(wait * 1.5, MAX_PACE_MS);
        await page.waitForTimeout(wait);
        continue;
      }
      // A step draws the frame, and may count more than one draw (the overlay's own render, a compile).
      if (callbacks < 1 || drawn < 1 || skipped !== 0)
        throw new Error(
          `TN_UNREAL_LOOK_FRAME_STEP: ${label}: ${callbacks} callbacks, ${drawn} frames drawn, ${skipped} skipped after ${attempt} retries`,
        );
      if (steps >= SETTLE_STEPS) drew.set(drawn, (drew.get(drawn) ?? 0) + 1);
      steps += 1;
      await page.waitForTimeout(wait);
      return;
    }
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
        // How many steps counted 1, 2, ... draws after the settle steps, and how many were repeated for the frame gate.
        drawsPerStep: Object.fromEntries([...drew].sort(([a], [b]) => a - b)),
        stepsRepeatedForTheFrameGate: retried,
        finalPaceMs: wait,
        paceMs: pace,
        seconds: (Date.now() - started) / 1000,
      },
      null,
      2,
    )}\n`,
  );
  return spec.frames + stills.length;
}
