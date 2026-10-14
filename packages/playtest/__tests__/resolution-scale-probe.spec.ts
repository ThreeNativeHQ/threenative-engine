import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { tsImport } from "tsx/esm/api";
import type { Page } from "playwright";
import { expect, it, vi } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import {
  textureDescriptorBytes,
  installResolutionScaleProbe,
  assertResolutionScaleContext,
  assertResolutionScalePreflight,
  qualifyResolutionScaleBudget,
  resolutionScaleTextureBytes,
  preserveResolutionScaleFailure,
  resolutionScaleGate,
} from "../src/runner/resolution-scale-probe.js";

const hardwareCensus = {
  complete: true,
  backend: { kind: "webgpu" as const, identity: "WebGPUBackend" },
  adapter: { identity: "webgpu:architecture=turing|vendor=nvidia", thermal: "unavailable" },
};

it("reads hardware identity from the installed census contract", () => {
  expect(assertResolutionScalePreflight("webgpu", { resolutionScale: 1 }, hardwareCensus)).toBe(
    hardwareCensus.adapter.identity,
  );
});

it.each([
  [undefined, "TN_RESOLUTION_CENSUS_INCOMPLETE"],
  [{ ...hardwareCensus, complete: false }, "TN_RESOLUTION_CENSUS_INCOMPLETE"],
  [
    { ...hardwareCensus, adapter: { ...hardwareCensus.adapter, identity: "unavailable" } },
    "TN_RESOLUTION_ADAPTER_MISSING",
  ],
  [
    { ...hardwareCensus, adapter: { ...hardwareCensus.adapter, identity: "webgpu:vendor=%20" } },
    "TN_RESOLUTION_ADAPTER_MISSING",
  ],
  [
    {
      ...hardwareCensus,
      adapter: {
        ...hardwareCensus.adapter,
        identity: "webgpu:device=Microsoft%20Basic%20Render%20Driver",
      },
    },
    "TN_RESOLUTION_SOFTWARE_ADAPTER",
  ],
])("refuses unqualified adapter/census %j", (census, error) => {
  expect(() => assertResolutionScalePreflight("webgpu", { resolutionScale: 1 }, census)).toThrow(
    error,
  );
});

it("requires the unchanged WebGPU surface before measurement", () => {
  expect(() =>
    assertResolutionScalePreflight("webgl2", { resolutionScale: 1 }, hardwareCensus),
  ).toThrow("TN_RESOLUTION_WEBGPU_REQUIRED");
  expect(() =>
    assertResolutionScalePreflight(
      "webgpu",
      { resolutionScale: 0.85, compiling: false },
      hardwareCensus,
    ),
  ).toThrow("TN_RESOLUTION_SURFACE_NOT_READY");
  expect(() =>
    assertResolutionScalePreflight(
      "webgpu",
      { resolutionScale: 1, compiling: true },
      hardwareCensus,
    ),
  ).toThrow("TN_RESOLUTION_SURFACE_NOT_READY");
});

it("qualifies the actual frame-budget receiver and restores its method", async () => {
  const prototype = { beginFrame: vi.fn() };
  const begin = prototype.beginFrame;
  const budget = Object.create(prototype);
  await qualifyResolutionScaleBudget(prototype, async () => budget.beginFrame(1, 2));
  expect(prototype.beginFrame).toBe(begin);
  expect(begin).toHaveBeenCalledWith(1, 2);
  await expect(qualifyResolutionScaleBudget(prototype, async () => {})).rejects.toThrow(
    "TN_RESOLUTION_FRAME_BUDGET_IDENTITY",
  );
  await expect(
    qualifyResolutionScaleBudget(prototype, async () => prototype.beginFrame.call({}, 1, 2)),
  ).rejects.toThrow("TN_RESOLUTION_FRAME_BUDGET_IDENTITY");
  await expect(
    qualifyResolutionScaleBudget(prototype, async () => {
      throw new Error("pump failed");
    }),
  ).rejects.toThrow("pump failed");
  expect(prototype.beginFrame).toBe(begin);
});

it("binds byte accounting to the running renderer's texture utility", () => {
  const utils = {
    bytes: 4,
    _getBytesPerTexel(format: string) {
      if (format !== "rgba8unorm") throw new Error("format");
      return this.bytes;
    },
  };
  const bytesPerTexel = resolutionScaleTextureBytes(utils);
  expect(
    textureDescriptorBytes({ size: [2, 3], format: "rgba8unorm" }, bytesPerTexel("rgba8unorm")),
  ).toBe(24);
  expect(() => resolutionScaleTextureBytes(undefined)).toThrow(
    "TN_RESOLUTION_TEXTURE_UTILS_MISSING",
  );
});

it("refuses a missing running context", () => {
  expect(() => assertResolutionScaleContext(undefined, {})).toThrow(
    "TN_RESOLUTION_CONTEXT_MISSING",
  );
});

it("refuses a context whose canvas differs from the mounted canvas", () => {
  const ctx = { renderer: { domElement: {} }, startup: { phase: "ready" } };
  expect(() => assertResolutionScaleContext(ctx, {})).toThrow("TN_RESOLUTION_CONTEXT_IDENTITY");
});

it("refuses a context that has not reached readiness", () => {
  const canvas = {};
  const ctx = { renderer: { domElement: canvas }, startup: { phase: "compiling" } };
  expect(() => assertResolutionScaleContext(ctx, canvas)).toThrow("TN_PLAYTEST_STARTUP_NOT_READY");
});

it("returns the same ready context when its canvas is mounted", () => {
  const canvas = {};
  const ctx = { renderer: { domElement: canvas }, startup: { phase: "ready" } };
  expect(assertResolutionScaleContext(ctx, canvas)).toBe(ctx);
});

it("counts mip/layer/sample payloads and refuses an unmeasured format", () => {
  expect(textureDescriptorBytes({ size: [8, 4, 2], mipLevelCount: 3, sampleCount: 4 }, 4)).toBe(
    1344,
  );
  expect(textureDescriptorBytes({ size: [8, 4, 2], dimension: "3d", mipLevelCount: 3 }, 4)).toBe(
    296,
  );
  expect(() => textureDescriptorBytes({ size: [8, 4], format: "unknown" }, undefined!)).toThrow(
    "Unmeasured",
  );
  expect(() => textureDescriptorBytes({ size: [0, 4] }, 4)).toThrow("dimensions");
});

it("captures exactly step +30 frames for each scale, counts allocations/builds, restores probes", async () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  let insideFrame = false;
  const censusInsideFrames: boolean[] = [];
  const budget = {
    beginFrame(_timestamp: number, _clock: number) { insideFrame = true; },
    endFrame(_now: number, _want: boolean) {
      insideFrame = false;
      return true;
    },
  };
  const device = {
    createTexture(_descriptor: unknown) {
      return {};
    },
  };
  const begin = budget.beginFrame;
  const end = budget.endFrame;
  const create = device.createTexture;
  let scale = 1;
  let builds = 3;
  const renderer = {
    surface: () => ({ resolutionScale: scale }),
    pipelineCensus: () => {
      censusInsideFrames.push(insideFrame);
      return {complete: true, counts: { deviceCreations: builds, failures: 0, pending: 0, droppedEvents: 0 }};
    },
    setResolutionScale(next: number) {
      scale = next;
      builds++;
      device.createTexture({ size: [4, 4], format: "rgba8unorm" });
    },
  };
  const marks = vi.spyOn(performance, "mark").mockImplementation((name, options) => {
    expect(insideFrame).toBe(false);
    expect(name).toMatch(/^TN_RESOLUTION_FRAME:\d+$/);
    expect(options?.startTime).toBeTypeOf("number");
    return {} as PerformanceMark;
  });
  const result = installResolutionScaleProbe(budget, renderer, device, () => 4);
  for (let frame = 0; frame < 213; frame++) {
    if (frame === 151) builds++; // A pipeline created between windows must remain counted.
    budget.beginFrame(frame * 16, frame * 16);
    budget.endFrame(frame * 16 + (frame === 120 ? 12 : 3), true);
  }
  const rows = await result;
  expect(
    rows.map((row) => [row.scale, row.frames.length, row.textureBytes, row.pipelineBuilds]),
  ).toEqual([
    [0.85, 31, 64, 1],
    [0.61, 31, 64, 2],
    [1, 31, 64, 1],
  ]);
  expect(rows.map((row) => row.stepCensusAfter.counts.deviceCreations)).toEqual([4, 6, 7]);
  expect(rows[0]!.stepRatio).toBe(4);
  const first = rows[0]!.frames[0]!;
  expect(first.clockEpochEndMs! - first.clockEpochStartMs!).toBeCloseTo(first.frameMs, 2);
  expect(censusInsideFrames.every((inside) => !inside)).toBe(true);
  expect(marks).toHaveBeenCalledTimes(93);
  rows
    .flatMap((row) => row.frames)
    .forEach((frame) => {
      const calibration = frame.clockCalibration!;
      expect(calibration.marker).toBe(`TN_RESOLUTION_FRAME:${frame.frame}`);
      expect(calibration.performanceBeforeMs).toBeLessThanOrEqual(calibration.performanceAfterMs);
      expect(calibration.wallEpochMs).toBeGreaterThan(0);
      expect(marks).toHaveBeenCalledWith(calibration.marker, {
        startTime: calibration.performanceAfterMs,
      });
    });
  marks.mockRestore();
  expect([budget.beginFrame, budget.endFrame, device.createTexture]).toEqual([begin, end, create]);
  log.mockRestore();
});

it("rejects missing marker instrumentation and restores the measurement seams", async () => {
  const budget = {
    beginFrame: vi.fn((_now: number, _clock: number) => {}),
    endFrame: vi.fn((_now: number, _want: boolean) => {}),
  };
  const device = { createTexture: vi.fn() };
  const originals = [budget.beginFrame, budget.endFrame, device.createTexture];
  const renderer = {
    surface: () => ({ resolutionScale: 0.85 }),
    setResolutionScale: vi.fn(),
    pipelineCensus: () => ({
      complete: true,
      counts: { deviceCreations: 0, failures: 0, pending: 0, droppedEvents: 0 },
    }),
  };
  const marks = vi.spyOn(performance, "mark").mockImplementation(() => {
    throw new Error("marker unavailable");
  });
  const result = installResolutionScaleProbe(budget, renderer, device, () => 4);
  for (let frame = 0; frame < 120; frame++) {
    budget.beginFrame(frame, frame);
    budget.endFrame(frame + 1, true);
  }
  // The first measured frame requires a ready scale-1 surface before the forced step.
  renderer.surface = () => ({
    resolutionScale: renderer.setResolutionScale.mock.calls.length ? 0.85 : 1,
  });
  budget.beginFrame(120, 120);
  budget.endFrame(121, true);
  await expect(result).rejects.toThrow("marker unavailable");
  expect([budget.beginFrame, budget.endFrame, device.createTexture]).toEqual(originals);
  marks.mockRestore();
});

it("startup frame survives actual tsx serialization without browser helpers", async () => {
  const corrected = await tsImport("../src/runner/resolution-scale-probe.ts", import.meta.url);
  let frames = 0;
  const browser = {
    requestAnimationFrame: (callback: () => void) => {
      frames += 1;
      callback();
    },
  };
  const page = {
    evaluate: (script: string | ((arg: unknown) => unknown), arg?: unknown) =>
      Promise.resolve().then(() =>
        runInNewContext(
          typeof script === "string" ? script : `(${String(script)})(${JSON.stringify(arg)})`,
          browser,
        ),
      ),
  } as Pick<Page, "evaluate">;
  await corrected.resolutionScaleFrame(page);
  expect(frames).toBe(1);
  expect(Object.hasOwn(browser, "__name")).toBe(false);
});

it.each([null, "no", 0])("rejects malformed compile observation %j", (compiling) => {
  expect(() =>
    Reflect.apply(assertResolutionScalePreflight, undefined, [
      "webgpu",
      { resolutionScale: 1, compiling },
      hardwareCensus,
    ]),
  ).toThrow("TN_RESOLUTION_SURFACE_MALFORMED");
});
it("accepts an explicit idle compile observation", () => {
  expect(
    assertResolutionScalePreflight(
      "webgpu",
      { resolutionScale: 1, compiling: false },
      hardwareCensus,
    ),
  ).toBe(hardwareCensus.adapter.identity);
});
it("persists partial failure observations before rethrowing the identical failure", async () => {
  const error = new Error("TN_RESOLUTION_SURFACE_NOT_READY");
  const partial = { startup: { phase: "ready" }, surface: { resolutionScale: 1, compiling: true } };
  let persisted: unknown;
  const result = preserveResolutionScaleFailure(error, async () => {
    persisted = structuredClone(partial);
  });
  await expect(result).rejects.toBe(error);
  expect(persisted).toEqual(partial);
  expect(Object.hasOwn(persisted as object, "adapter")).toBe(false);
});

function gateRuns() {
  const census = (deviceCreations: number) => ({
    complete: true,
    counts: { deviceCreations, failures: 0, pending: 0, droppedEvents: 0 },
  });
  return [1, 2, 3].map((run) => ({
    run,
    rows: [0.85, 0.61, 1].map((scale, step) => ({
      scale,
      frames: Array.from({ length: 31 }, (_, index) => ({
        frame: step * 31 + index,
        frameMs: index === 0 ? 2 : 1,
        rafIntervalMs: 1000,
      })),
      allocations: [],
      textureBytes: 0,
      pipelineBuilds: 0,
      windowP50Ms: 1,
      stepRatio: 2,
      censusBefore: census(10),
      stepCensusAfter: census(10),
      censusAfter: census(10),
    })),
  }));
}
it.each([
  [2, true, "decline"],
  [2.001, true, "continue"],
  [3, false, "unqualified"],
])("uses strict CPU spike boundary %s with timing qualified %s", (cpu, qualified, verdict) => {
  const runs = gateRuns();
  runs[0]!.rows[0]!.frames[0]!.frameMs = cpu;
  expect(resolutionScaleGate(runs, qualified).verdict).toBe(verdict);
});
it("earns only first-step-frame pipeline builds under loaded timing", () => {
  const later = gateRuns();
  later[0]!.rows[0]!.censusAfter.counts.deviceCreations = 11;
  later[0]!.rows[0]!.pipelineBuilds = 1;
  expect(resolutionScaleGate(later, false).verdict).toBe("unqualified");
  expect(resolutionScaleGate(later, true).verdict).toBe("decline");
  later[0]!.rows[0]!.stepCensusAfter.counts.deviceCreations = 11;
  expect(resolutionScaleGate(later, false).verdict).toBe("continue");
});
it("does not treat an incomplete step snapshot as zero pipeline builds", () => {
  const runs = gateRuns();
  runs[0]!.rows[0]!.stepCensusAfter.complete = false;
  expect(resolutionScaleGate(runs, true).verdict).toBe("unqualified");
});
it.each([
  "empty contexts",
  "missing context",
  "missing step",
  "missing frame",
  "malformed CPU",
  "incomplete window",
  "pending window",
  "missing census",
  "inconsistent count",
])("fails closed for %s", (fault) => {
  const runs = gateRuns();
  if (fault === "empty contexts") runs.length = 0;
  if (fault === "missing context") runs.pop();
  if (fault === "missing step") runs[0]!.rows.pop();
  if (fault === "missing frame") runs[0]!.rows[0]!.frames.pop();
  if (fault === "malformed CPU") runs[0]!.rows[0]!.frames[0]!.frameMs = Number.NaN;
  if (fault === "incomplete window") runs[0]!.rows[0]!.censusAfter.complete = false;
  if (fault === "pending window") runs[0]!.rows[0]!.censusAfter.counts.pending = 1;
  if (fault === "missing census") Reflect.set(runs[0]!.rows[0]!, "censusBefore", undefined);
  if (fault === "inconsistent count") runs[0]!.rows[0]!.pipelineBuilds = 1;
  expect(() => resolutionScaleGate(runs, true)).toThrow("TN_RESOLUTION_GATE_INVALID");
});

it("startup checkpoint persists before a deferred operation and is replaced by its final record", async () => {
  const corrected = await tsImport("../src/runner/resolution-scale-probe.ts", import.meta.url);
  const directory = await makeTempDir("tn-resolution-checkpoint-");
  const path = join(directory, "run-1.json");
  const evidence = { startup: { collected: false }, partial: { collected: false } };
  const record = (value: object) => writeFile(path, JSON.stringify(value));
  let finish: (() => void) | undefined;
  const deferred = new Promise<void>((resolve) => { finish = resolve; });
  let observedPending: (() => void) | undefined;
  const pendingObserved = new Promise<void>((resolve) => { observedPending = resolve; });
  const operation = corrected.resolutionScalePending(
    "starter.listen",
    (pendingOperation: string) => record({ status: "pending", pendingOperation, ...evidence }),
    async () => {
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
        status: "pending", pendingOperation: "starter.listen", ...evidence,
      });
      observedPending!();
      await deferred;
      await record({ status: "complete", ...evidence });
    },
  );
  await Promise.race([pendingObserved, operation]);
  expect(JSON.parse(await readFile(path, "utf8")).status).toBe("pending");
  finish!();
  await operation;
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ status: "complete", ...evidence });
  const failure = new Error("startup rejected");
  await expect(corrected.resolutionScalePending("starter.listen", async () => {}, async () => {
    throw failure;
  })).rejects.toBe(failure);
  await expect(preserveResolutionScaleFailure(failure, () => record({ status: "failed", error: failure.message, ...evidence }))).rejects.toBe(failure);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ status: "failed", error: failure.message, ...evidence });
});
