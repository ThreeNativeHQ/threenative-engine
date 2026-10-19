import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadPlaytestScenario } from "../../packages/playtest/dist/index.js";
import { makeTempDir } from "../../test-support/temp-dir.js";
import * as fogProof from "../verify-volumetric-fog.js";
import {
  fogCaptureIsValid,
  fogCaptureScenario,
  fogCaptureScenarios,
  fogFrameCost,
  fogLightPixelMetrics,
  fogOverlapPixelMetrics,
  fogTextureBaselineMatches,
} from "../verify-volumetric-fog.js";

describe("volumetric fog runtime evidence", () => {
  it("qualifies both enabled responses against repeated-baseline noise and finite GPU readback", () => {
    const qualify = Reflect.get(fogProof, "qualifyFogExposureControls");
    expect(typeof qualify).toBe("function");
    const arm = (value: number, exposure: boolean) => ({
      pixels: Uint8Array.from([value, value, value, 255, value, value, value, 255]),
      state: {
        exposureEnabled: exposure,
        exposureApplied: exposure,
        exposureMeasured: exposure,
        exposureSettled: exposure,
        exposureLuminance: exposure ? 0.1 : 0,
        exposureStops: exposure ? 1 : 0,
      },
    });
    const controls = {
      off: arm(10, false),
      fog: arm(30, false),
      exposure: arm(60, true),
      both: arm(90, true),
      repeat: arm(90, true),
    };
    expect(() => qualify(controls)).not.toThrow();
    expect(() => qualify({ ...controls, both: controls.fog })).toThrow();
    expect(() => qualify({ ...controls, exposure: controls.both })).toThrow();
    expect(() => qualify({ ...controls, repeat: arm(0, true) })).toThrow();
    expect(() =>
      qualify({
        ...controls,
        both: {
          ...controls.both,
          state: { ...controls.both.state, exposureLuminance: Number.NaN },
        },
      }),
    ).toThrow();
  });
  it("rejects software device loss even when the runner reports a pass", () => {
    const good = {
      pass: true,
      capture: {
        rendererKind: "webgpu",
        adapter: { description: "SwiftShader" },
        viewport: { width: 640, height: 400 },
      },
      diagnostics: [],
    };
    expect(fogCaptureIsValid(good)).toBe(true);
    expect(
      fogCaptureIsValid({
        ...good,
        diagnostics: [{ code: "TN_PLAYTEST_SOFTWARE_DEVICE_LOST", severity: "warning" }],
      }),
    ).toBe(false);
    expect(
      fogCaptureIsValid({ ...good, diagnostics: [{ code: "UNRELATED_ERROR", severity: "error" }] }),
    ).toBe(false);
    expect(fogCaptureIsValid({ ...good, capture: undefined })).toBe(false);
    expect(fogCaptureIsValid({ ...good, capture: { rendererKind: "webgl2" } })).toBe(false);
    expect(fogCaptureIsValid({ ...good, capture: { ...good.capture, adapter: {} } })).toBe(false);
    expect(
      fogCaptureIsValid({
        ...good,
        capture: {
          ...good.capture,
          adapter: { features: "timestamp-query", vendor: "unknown", architecture: "unavailable" },
        },
      }),
    ).toBe(false);
    expect(
      fogCaptureIsValid({
        ...good,
        capture: { ...good.capture, viewport: { width: 1, height: 1 } },
      }),
    ).toBe(false);
    expect(fogCaptureIsValid({ ...good, pass: false })).toBe(false);
  });
  it("loads the generated pixel-bearing scenario with the public validator", async () => {
    const root = await makeTempDir("vq07-scenario-");
    for (const { mode, scenario: authored } of await fogCaptureScenarios()) {
      const file = path.join(root, `${mode}.playtest.json`);
      await writeFile(file, JSON.stringify(authored));
      const scenario = await loadPlaytestScenario(root, file);
      expect(scenario.assert?.visual).toHaveLength(mode === "blackOff" ? 2 : 1);
      expect(scenario.artifacts?.screenshots).toBe("after");
    }
  });
  it("loads the committed repeated-lifecycle scenario", async () => {
    const scenario = await loadPlaytestScenario(
      process.cwd(),
      "examples/abyss-framework/playtests/vq-volumetric-fog.playtest.json",
    );
    expect(scenario.steps).toHaveLength(15);
  });
});

it("uses an inline favicon instead of the confirmed missing /favicon.ico", async () => {
  const html = await readFile("examples/abyss-framework/vq-fog/index.html", "utf8");
  expect(html).toMatch(/<link\s+rel="icon"\s+href="data:,"\s*\/?\s*>/);
});

it("requires a black no-fog control without weakening the positive-arm visual guard", () => {
  expect(fogCaptureScenario("blackOff", "KeyN").assert?.visual?.[1]?.region).toMatchObject({
    maxLuminance: 0,
    minDarkPixelRatio: 1,
  });
  expect(
    fogCaptureScenario("scatter", "KeyL").assert?.visual?.[0]?.region?.minNonblankPixelRatio,
  ).toBe(0.05);
});

it("qualifies both lights in a fixed scattering ROI and rejects stray-pixel evidence", () => {
  // Synthetic buffers exercise the verifier only; they are never runtime screenshot evidence.
  const frame = () => ({ width: 640, height: 400, data: Buffer.alloc(640 * 400 * 4) });
  const black = frame();
  const both = frame();
  const sunOff = frame();
  const pointOff = frame();
  for (const image of [black, both, sunOff, pointOff])
    for (let y = 25; y < 135; y += 1)
      for (let x = 515; x < 625; x += 1)
        for (let c = 0; c < 3; c += 1) image.data[(y * 640 + x) * 4 + c] = 128;
  for (let y = 155; y < 245; y += 1)
    for (let x = 260; x < 410; x += 1) {
      const i = (y * 640 + x) * 4;
      for (let c = 0; c < 3; c += 1) {
        both.data[i + c] = 30;
        sunOff.data[i + c] = 20;
        pointOff.data[i + c] = 10;
      }
    }
  expect(fogLightPixelMetrics(black, both, sunOff, pointOff).pass).toBe(true);
  expect(fogLightPixelMetrics(black, both, both, pointOff).pass).toBe(false);
  const stray = { ...black, data: Buffer.from(black.data) };
  stray.data[(180 * 640 + 300) * 4] = 255;
  expect(fogLightPixelMetrics(black, stray, black, black).pass).toBe(false);
  const outside = { ...black, data: Buffer.from(black.data) };
  outside.data[(10 * 640 + 10) * 4] = 255;
  expect(fogLightPixelMetrics(black, outside, black, black).pass).toBe(false);
  both.data[(224 * 640 + 193) * 4] = 1;
  expect(fogLightPixelMetrics(black, both, sunOff, pointOff).pass).toBe(false);
  both.data[(224 * 640 + 193) * 4] = 0;
  both.data[(30 * 640 + 520) * 4] = 127;
  expect(fogLightPixelMetrics(black, both, sunOff, pointOff).pass).toBe(false);
  both.data[(30 * 640 + 520) * 4] = 128;
  black.data[0] = 1;
  expect(fogLightPixelMetrics(black, both, sunOff, pointOff).pass).toBe(false);
  expect(() => fogLightPixelMetrics({ ...black, width: 1 }, both, sunOff, pointOff)).toThrow(/640/);
});

it("runs the committed lifecycle and return-to-off scenarios, with actual release counts", async () => {
  const scenarios = await fogCaptureScenarios();
  const lifecycle = scenarios.find(({ mode }) => mode === "lifecycle")?.scenario;
  const off = scenarios.find(({ mode }) => mode === "lifecycleOff")?.scenario;
  expect(lifecycle?.steps).toHaveLength(15);
  expect(lifecycle?.steps[0]?.press).toEqual(["KeyF"]);
  expect(off?.steps).toHaveLength(18);
  expect(lifecycle?.assert?.components).toEqual(
    expect.arrayContaining([expect.objectContaining({ component: "releasedTargets", equals: 3 })]),
  );
  expect(off?.assert?.components).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ component: "releasedTargets", equals: 4 }),
      expect.objectContaining({ component: "liveTargets", equals: 0 }),
    ]),
  );
});

it("requires observed rendered-frame stability before claiming the texture baseline restored", () => {
  const baseline = { textures: 2, settledRenderFrames: 3, stableTextureFrames: 3 };
  expect(fogTextureBaselineMatches(baseline, baseline)).toBe(true);
  expect(fogTextureBaselineMatches(baseline, { ...baseline, textures: 3 })).toBe(false);
  expect(fogTextureBaselineMatches(baseline, { ...baseline, settledRenderFrames: 0 })).toBe(false);
  expect(fogTextureBaselineMatches(baseline, { ...baseline, stableTextureFrames: 2 })).toBe(false);
  expect(fogTextureBaselineMatches({}, baseline)).toBe(false);
});
it("captures the live target at both sizes without replacing the fog controller", async () => {
  const cases = await fogCaptureScenarios();
  for (const [mode, width, height] of [
    ["resizeSmall", 320, 240],
    ["resizeRestore", 640, 400],
  ] as const) {
    const scenario = cases.find((entry) => entry.mode === mode)?.scenario;
    expect(scenario?.assert?.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ component: "targetWidth", equals: width }),
        expect.objectContaining({ component: "targetHeight", equals: height }),
        expect.objectContaining({ component: "createdTargets", equals: 1 }),
        expect.objectContaining({ component: "releasedTargets", equals: 0 }),
      ]),
    );
  }
});

it("waits for measured render stability instead of treating fixed ticks as rendered frames", async () => {
  for (const { scenario } of await fogCaptureScenarios()) {
    expect(scenario.steps.at(-1)).toMatchObject({
      waitForResource: { id: "state", path: "stableTextureFrames", gte: 3 },
      timeoutMs: 30000,
    });
  }
  const restore = (await fogCaptureScenarios()).find(
    ({ mode }) => mode === "resizeRestore",
  )?.scenario;
  const steps = restore?.steps ?? [];
  const restoreAt = steps.findIndex(
    (step) => Array.isArray(step.press) && step.press.includes("KeyT"),
  );
  expect(steps[restoreAt - 1]?.waitForResource).toMatchObject({
    id: "state",
    path: "stableTextureFrames",
    gte: 3,
  });
});

it("presents each intermediate lifecycle graph before the following transition", async () => {
  const scenario = (await fogCaptureScenarios()).find(({ mode }) => mode === "lifecycle")?.scenario;
  const steps = scenario?.steps ?? [];
  const inputs = steps.flatMap((step, index) => (step.press === undefined ? [] : [index]));
  expect(inputs).toHaveLength(5);
  for (const [at, index] of inputs.entries()) {
    const boundary = steps[(inputs[at + 1] ?? steps.length) - 1];
    expect(boundary?.waitForResource).toEqual({ id: "state", path: "stableTextureFrames", gte: 3 });
    expect(boundary?.label).toMatch(/rendered$/);
    expect((inputs[at + 1] ?? steps.length) - 1).toBeGreaterThan(index);
  }
});

it("keeps original arms and adds retained camera, streamed-depth and scene transitions", async () => {
  const scenarios = await fogCaptureScenarios();
  for (const mode of [
    "scatterOutside",
    "scatterOutsideSunOff",
    "scatterOutsidePointOff",
    "cameraCut",
    "cameraRestore",
    "streamWallOut",
    "streamWallIn",
    "sceneReentry",
    "sceneRepeatedOff",
  ])
    expect(
      scenarios.find((entry) => entry.mode === mode),
      mode,
    ).toBeDefined();
  for (const mode of ["cameraCut", "cameraRestore", "streamWallOut", "streamWallIn"]) {
    const scenario = scenarios.find((entry) => entry.mode === mode)?.scenario;
    expect(scenario?.assert?.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ component: "createdTargets", equals: 1 }),
        expect.objectContaining({ component: "releasedTargets", equals: 0 }),
      ]),
    );
  }
});

it("records a clean measured frame-cost window and refuses missing or mixed-window evidence", () => {
  const metric = { mean: 3, p50: 2.8, p95: 4 };
  const window = {
    window: 3,
    frames: 30,
    frame: metric,
    phases: { render: metric },
    surface: { drawingBufferWidth: 640, drawingBufferHeight: 400 },
  };
  const logs = [1, 2, 3].map((n) => ({
    text: `TN_FRAME_BUDGET:${JSON.stringify({ ...window, window: n })}`,
  }));
  expect(fogFrameCost(logs)).toMatchObject({ frames: 30, renderMs: metric, gpuMs: undefined });
  // gpuMs is a mean over the frames the device answered for, so the sparse ones travel with it.
  const sparse = fogFrameCost([
    ...logs.slice(0, 2),
    {
      text: `TN_FRAME_BUDGET:${JSON.stringify({
        ...window,
        gpuMs: 174.78,
        gpu: { mean: 174.78, p50: 174.69, p95: 179.36, samples: 4 },
        gpuStale: 26,
      })}`,
    },
  ]);
  expect(sparse).toMatchObject({ gpuMs: 174.78, gpuSamples: 4, gpuStaleFrames: 26 });
  expect(sparse.qualification).toMatch(/4 of 30 frames/);
  // A gpu mean over a count the meter never measured is the same silent lie in its own field.
  const measuredGpu = { mean: 174.78, p50: 174.69, p95: 179.36, samples: 4 };
  for (const gpu of [
    { gpu: { ...measuredGpu, samples: "many" }, gpuMs: 174.78 },
    { gpu: { ...measuredGpu, samples: -4 }, gpuMs: 174.78 },
    { gpu: { ...measuredGpu, samples: 31 }, gpuMs: 174.78 },
    { gpuStale: -26 },
    { gpu: undefined, gpuStale: 30 },
  ])
    expect(() =>
      fogFrameCost([
        ...logs.slice(0, 2),
        {
          text: `TN_FRAME_BUDGET:${JSON.stringify({ ...window, gpuMs: 174.78, gpuStale: 26, ...gpu })}`,
        },
      ]),
    ).toThrow(/gpu sample count/);
  expect(() => fogFrameCost([])).toThrow(/windows/);
  expect(() => fogFrameCost(logs.slice(0, 2))).toThrow(/windows/);
  for (const change of [
    { frames: 0 },
    { frames: undefined },
    { window: 1 },
    { gpuMs: -1 },
    { phases: {} },
    { surface: { ...window.surface, compiling: true } },
  ])
    expect(() =>
      fogFrameCost([
        ...logs.slice(0, 2),
        { text: `TN_FRAME_BUDGET:${JSON.stringify({ ...window, ...change })}` },
      ]),
    ).toThrow(/frame-cost|windows/);
  expect(() => fogFrameCost([{ text: "TN_FRAME_BUDGET:{broken" }])).toThrow(/MALFORMED/);
});
it("waits for actual render observations before the three dedicated cost captures", async () => {
  const scenarios = await fogCaptureScenarios();
  for (const mode of ["costOff", "costFull", "costHalf"]) {
    const scenario = scenarios.find((entry) => entry.mode === mode)?.scenario;
    expect(scenario?.steps).toContainEqual(
      expect.objectContaining({
        waitForResource: { id: "state", path: "settledRenderFrames", gte: 90 },
      }),
    );
  }
});

it("observes the realized transport target instead of trusting the request", async () => {
  const scenarios = await fogCaptureScenarios();
  for (const [mode, width, height, steps] of [
    ["half", 320, 200, 48],
    ["costFull", 640, 400, 48],
    ["costHalf", 320, 200, 48],
    ["costOff", 0, 0, 0],
  ] as const) {
    const components = scenarios.find((entry) => entry.mode === mode)?.scenario.assert?.components;
    expect(components, mode).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ component: "targetWidth", equals: width }),
        expect.objectContaining({ component: "targetHeight", equals: height }),
        expect.objectContaining({ component: "pixels", equals: width * height }),
        expect.objectContaining({ component: "steps", equals: steps }),
      ]),
    );
  }
});

it("declares the second density bound and measures that it changes the image", () => {
  for (const mode of ["overlap", "fog"]) {
    expect(fogCaptureScenario(mode, "KeyF").assert?.components).toContainEqual(
      expect.objectContaining({ component: "overlaps", equals: mode === "overlap" }),
    );
  }
  const frame = { width: 2, height: 1, data: new Uint8Array(8) };
  const second = { width: 2, height: 1, data: new Uint8Array([0, 0, 0, 255, 0, 0, 0, 255]) };
  expect(fogOverlapPixelMetrics(frame, second)).toMatchObject({
    changedPixelRatio: 0,
    maxChannelDelta: 0,
    pass: false,
  });
  expect(
    fogOverlapPixelMetrics(frame, {
      ...second,
      data: new Uint8Array([0, 0, 0, 255, 0, 9, 0, 255]),
    }),
  ).toMatchObject({ pass: true });
});
