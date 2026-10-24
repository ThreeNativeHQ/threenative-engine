import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import {
  PLAYTEST_ASSERTION_REGISTRY,
  evaluateRichPlaytestAssertions,
  loadPlaytestScenario,
} from "../src/index.js";
import type { IPlaytestStartupCoverObservation, IPlaytestStartupTimeline } from "../src/protocol.js";
import type { IPlaytestReport } from "../src/report.js";
import { compareStartupFrames, type IStartupCoverFrame } from "../src/runner/startupCover.js";

/**
 * Startup time was a console anecdote: a `TN_STARTUP_WARMUP` line and a `__TN_STARTUP_READY__`
 * global read by hand from a cold-start log. This makes it an observation the runtime stamps and
 * a scenario asserts, and fails closed when the milestone was never reached.
 */

function report(timeline: IPlaytestStartupTimeline | undefined): IPlaytestReport {
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
        : { startup: { phase: "ready", progress: 1, rule: "sustained-frames", timeline } }),
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
      "maxReadyMs",
      "steadyCover",
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
    await expect(scenarioWith({ steadyCover: false })).rejects.toThrow(/steadyCover/u);
  });
});

/**
 * The loading cover flickered against black for seconds on Lantern Vale while every startup
 * milestone looked fine: only the presented frames show it.
 */
describe("startup steadyCover", () => {
  const frame = (ms: number, rgb: [number, number, number], bar = 0): IStartupCoverFrame => {
    const width = 64;
    const height = 36;
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i += 1) {
      // A progress bar: one row of the frame, filled up to `bar` of the width.
      const inBar = Math.floor(i / width) === 24 && i % width < bar * width;
      data.set(inBar ? [230, 180, 60, 255] : [...rgb, 255], i * 4);
    }
    return { data, height, ms, width };
  };
  const cover: [number, number, number] = [180, 196, 186];

  it("passes a cover whose bar fills, and flags a black frame and the page background", () => {
    const steady = compareStartupFrames([frame(100, cover, 0), frame(500, cover, 0.5), frame(900, cover, 0.9)]);
    expect(steady.differing).toEqual([]);
    expect(steady.frames).toBe(3);
    const broken = compareStartupFrames([frame(80, [29, 58, 92]), frame(400, cover, 0.3), frame(450, [4, 4, 4]), frame(900, cover, 0.9)]);
    expect(broken.differing.map(({ ms }) => ms)).toEqual([80, 450]);
  });

  it("fails a broken cover, and fails closed when no frame was recorded", async () => {
    const scenario = await scenarioWith({ steadyCover: true });
    const evaluate = (observation: IPlaytestStartupCoverObservation | undefined) => {
      const base = report({ readyMs: 4200 });
      const startup = base.observations?.startup;
      if (startup !== undefined && observation !== undefined) startup.cover = observation;
      return evaluateRichPlaytestAssertions({ report: base, scenario });
    };
    const pass = evaluate(compareStartupFrames([frame(100, cover), frame(900, cover, 0.9)]));
    expect(pass.assertions).toContainEqual(expect.objectContaining({ id: "startup.steadyCover", pass: true }));
    const broken = evaluate(compareStartupFrames([frame(100, cover), frame(450, [4, 4, 4]), frame(900, cover)]));
    expect(broken.assertions).toContainEqual(expect.objectContaining({ id: "startup.steadyCover", pass: false }));
    expect(broken.diagnostics).toContainEqual(expect.objectContaining({ code: "TN_PLAYTEST_STARTUP_COVER_BROKEN" }));
    for (const unobserved of [undefined, compareStartupFrames([])]) {
      const result = evaluate(unobserved);
      expect(result.assertions).toContainEqual(expect.objectContaining({ id: "startup.steadyCover", pass: false }));
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "TN_PLAYTEST_STARTUP_COVER_UNOBSERVED" }));
    }
  });
});
