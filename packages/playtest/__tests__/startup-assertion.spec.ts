import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import {
  PLAYTEST_ASSERTION_REGISTRY,
  evaluateRichPlaytestAssertions,
  loadPlaytestScenario,
} from "../src/index.js";
import type { IPlaytestStartupOffscreenBytes, IPlaytestStartupTimeline } from "../src/protocol.js";
import type { IPlaytestReport } from "../src/report.js";

/**
 * Startup time was a console anecdote: a `TN_STARTUP_WARMUP` line and a `__TN_STARTUP_READY__`
 * global read by hand from a cold-start log. This makes it an observation the runtime stamps and
 * a scenario asserts, and fails closed when the milestone was never reached.
 */

function report(
  timeline: IPlaytestStartupTimeline | undefined,
  offscreenBytes?: IPlaytestStartupOffscreenBytes,
): IPlaytestReport {
  return {
    diagnostics: [],
    distance: 0,
    entity: "proof",
    expectMoved: false,
    frames: 2,
    observations: {
      console: [],
      hud: {},
      network: [],
      resources: {},
      ...(timeline === undefined
        ? {}
        : {
            startup: {
              phase: "ready",
              progress: 1,
              rule: "sustained-frames",
              timeline,
              ...(offscreenBytes === undefined ? {} : { offscreenBytes }),
            },
          }),
    },
    trivialityOptOuts: [],
  };
}

async function scenarioWith(startup: Record<string, unknown>) {
  const root = await makeTempDir("threenative-startup-assertion-");
  await mkdir(root, { recursive: true });
  const file = path.join(root, "startup.playtest.json");
  await writeFile(
    file,
    JSON.stringify({
      assert: { startup },
      name: "startup",
      schemaVersion: 1,
      steps: [{ release: true, waitFrames: 1 }],
      target: "web",
      viewport: { height: 720, width: 1280 },
      warmupFrames: 0,
    }),
  );
  return loadPlaytestScenario(root, file);
}

describe("startup playtest assertion", () => {
  it("is a registered kind that requires the runtime.startup capability", () => {
    const entry = PLAYTEST_ASSERTION_REGISTRY.find((candidate) => candidate.kind === "startup");
    expect(entry?.cardinality).toBe("object");
    expect(entry?.requiredCapabilities).toEqual(["runtime.startup"]);
    expect(entry?.fields.map((field) => field.name).sort()).toEqual([
      "maxCompileSettledMs",
      "maxEnteredMs",
      "maxOffscreenBytes",
      "maxReadyMs",
    ]);
  });

  it("passes every ceiling the timeline meets", async () => {
    const scenario = await scenarioWith({ maxEnteredMs: 2500, maxReadyMs: 8000 });
    const result = evaluateRichPlaytestAssertions({
      report: report({ enteredMs: 1900, loadStartedMs: 300, readyMs: 4200 }),
      scenario,
    });
    expect(result.assertions).toContainEqual(
      expect.objectContaining({ id: "startup.enteredMs", pass: true }),
    );
    expect(result.assertions).toContainEqual(
      expect.objectContaining({ id: "startup.readyMs", pass: true }),
    );
    expect(result.diagnostics).toEqual([]);
  });

  it("fails a ceiling the timeline misses and names the milestone", async () => {
    const scenario = await scenarioWith({ maxEnteredMs: 2500 });
    const result = evaluateRichPlaytestAssertions({
      report: report({ enteredMs: 9540, loadStartedMs: 300 }),
      scenario,
    });
    expect(result.assertions).toContainEqual(
      expect.objectContaining({ id: "startup.enteredMs", pass: false }),
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "TN_PLAYTEST_STARTUP_TOO_SLOW" }),
    );
  });

  it("fails closed when the runtime reported no timeline or never reached the milestone", async () => {
    const scenario = await scenarioWith({ maxReadyMs: 8000 });
    const absent = evaluateRichPlaytestAssertions({ report: report(undefined), scenario });
    expect(absent.assertions).toContainEqual(
      expect.objectContaining({ id: "startup.readyMs", pass: false }),
    );
    expect(absent.diagnostics).toContainEqual(
      expect.objectContaining({ code: "TN_PLAYTEST_STARTUP_UNOBSERVABLE" }),
    );
    const unreached = evaluateRichPlaytestAssertions({
      report: report({ enteredMs: 1900, loadStartedMs: 300 }),
      scenario,
    });
    expect(unreached.assertions).toContainEqual(
      expect.objectContaining({ id: "startup.readyMs", pass: false }),
    );
  });

  it("rejects an empty or non-positive startup assertion at load", async () => {
    await expect(scenarioWith({})).rejects.toThrow(/at least one of/u);
    await expect(scenarioWith({ maxReadyMs: 0 })).rejects.toThrow(/positive finite number/u);
    await expect(scenarioWith({ maxSlowMs: 5 })).rejects.toThrow(/maxSlowMs/u);
  });

  describe("off-screen bytes", () => {
    const measured = (
      overrides: Partial<IPlaytestStartupOffscreenBytes> = {},
    ): IPlaytestStartupOffscreenBytes => ({
      awaitedBytes: 501_000,
      fix: "Stream these files with WorldCells, or prefetch them after the reveal.",
      offscreenBytes: 500_000,
      top: [{ bytes: 500_000, path: "forest.glb", reason: "outside-view" }],
      unattributedBytes: 0,
      unsizedFiles: 0,
      visibleBytes: 1_000,
      warn: true,
      ...overrides,
    });
    const timeline = { enteredMs: 1900, loadStartedMs: 300, readyMs: 4200 };

    it("warns without any assertion when most of the wait is not on screen", async () => {
      const scenario = await scenarioWith({ maxReadyMs: 8000 });
      const result = evaluateRichPlaytestAssertions({
        report: report(timeline, measured()),
        scenario,
      });
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "TN_PLAYTEST_STARTUP_OFFSCREEN_BYTES",
          message: expect.stringContaining("forest.glb"),
          severity: "warning",
          suggestion: expect.stringContaining("WorldCells"),
        }),
      );
      expect(result.assertions.every((assertion) => assertion.pass)).toBe(true);
    });

    it("stays quiet for an inform-level or clean measurement", async () => {
      const scenario = await scenarioWith({ maxReadyMs: 8000 });
      for (const offscreenBytes of [
        measured({ offscreenBytes: 4_000, top: [], visibleBytes: 80_000, warn: false }),
        measured({ offscreenBytes: 0, top: [], visibleBytes: 501_000, warn: false }),
      ]) {
        const result = evaluateRichPlaytestAssertions({
          report: report(timeline, offscreenBytes),
          scenario,
        });
        expect(result.diagnostics).toEqual([]);
      }
    });

    it("gates on maxOffscreenBytes: passes under the ceiling and fails over it", async () => {
      const over = evaluateRichPlaytestAssertions({
        report: report(timeline, measured()),
        scenario: await scenarioWith({ maxOffscreenBytes: 1_000 }),
      });
      expect(over.assertions).toContainEqual(
        expect.objectContaining({ id: "startup.offscreenBytes", pass: false }),
      );
      expect(over.diagnostics).toContainEqual(
        expect.objectContaining({ code: "TN_PLAYTEST_STARTUP_OFFSCREEN_BYTES", severity: "error" }),
      );
      const clean = evaluateRichPlaytestAssertions({
        report: report(
          timeline,
          measured({ offscreenBytes: 0, top: [], visibleBytes: 501_000, warn: false }),
        ),
        scenario: await scenarioWith({ maxOffscreenBytes: 0 }),
      });
      expect(clean.assertions).toContainEqual(
        expect.objectContaining({ id: "startup.offscreenBytes", pass: true }),
      );
      expect(clean.diagnostics).toEqual([]);
    });

    it("fails closed when there is no measurement or nothing awaited could be sized", async () => {
      const scenario = await scenarioWith({ maxOffscreenBytes: 1_000 });
      for (const offscreenBytes of [
        undefined,
        measured({ awaitedBytes: 0, offscreenBytes: 0, top: [], unsizedFiles: 3, warn: false }),
      ]) {
        const result = evaluateRichPlaytestAssertions({
          report: report(timeline, offscreenBytes),
          scenario,
        });
        expect(result.assertions).toContainEqual(
          expect.objectContaining({ id: "startup.offscreenBytes", pass: false }),
        );
        expect(result.diagnostics).toContainEqual(
          expect.objectContaining({ code: "TN_PLAYTEST_STARTUP_UNOBSERVABLE" }),
        );
      }
    });

    it("rejects a negative or fractional ceiling at load", async () => {
      await expect(scenarioWith({ maxOffscreenBytes: -1 })).rejects.toThrow(/non-negative integer/u);
      await expect(scenarioWith({ maxOffscreenBytes: 1.5 })).rejects.toThrow(/non-negative integer/u);
      await expect(scenarioWith({ maxOffscreenBytes: "0" })).rejects.toThrow(/maxOffscreenBytes/u);
    });
  });
});
