import type { Page } from "playwright";

/** How long one worker may take to answer the probe. */
const WORKER_PROBE_MS = 1000;

/**
 * A worker host installs its platform source in the worker before the game starts (PRD-752).
 * Every worker is asked at once and each answer is bounded: a Wasm pthread worker blocked in
 * Atomics.wait never answers a CDP evaluate, and an unbounded probe hung the run (PRD-762).
 */
export async function runsGameInWorker(page: Page): Promise<boolean> {
  const answers = await Promise.all(page.workers().map((worker) => Promise.race([
    worker.evaluate("typeof globalThis.__tnGamePlatform").catch(() => undefined),
    new Promise<undefined>((resolve) => { setTimeout(resolve, WORKER_PROBE_MS, undefined).unref?.(); }),
  ])));
  return answers.includes("object");
}
