import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { runsGameInWorker } from "../src/runner/worker-probe.js";

// The owned engine's Wasm pthread workers sit in Atomics.wait and never answer a CDP evaluate, so an
// unbounded probe hung every forest-kit run right after the bridge connected (PRD-762, 2026-11-08).
const worker = (answer: Promise<unknown>) => ({ evaluate: () => answer, url: () => "worker.js" });

describe("runsGameInWorker", () => {
  it("finds the game worker behind workers that never answer", async () => {
    const page = { workers: () => [worker(new Promise(() => {})), worker(new Promise(() => {})), worker(Promise.resolve("object"))] };
    expect(await runsGameInWorker(page as unknown as Page)).toBe(true);
  }, 5000);

  it("answers false when no worker answers", async () => {
    const page = { workers: () => [worker(new Promise(() => {})), worker(Promise.resolve("undefined"))] };
    expect(await runsGameInWorker(page as unknown as Page)).toBe(false);
  }, 5000);
});
