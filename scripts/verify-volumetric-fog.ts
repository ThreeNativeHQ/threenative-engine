import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { type IPlaytestScenario, loadPlaytestScenario } from "../packages/playtest/dist/index.js";
// Use the built public runner: source-runner browser callbacks under tsx may capture __name.
import {
  type IStandalonePlaytestReport,
  WEBGPU_BROWSER_ARGS,
  runDesktopPlaytest,
  runStandalonePlaytest,
} from "../packages/playtest/dist/runner/index.js";
import { parsePerformanceMarkers } from "../packages/playtest/src/runner/perf.js";
import { regionMetrics } from "../packages/playtest/src/runner/steps.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = path.join(root, "examples/abyss-framework/vq-fog");
const cases = [
  ["off", "KeyO"],
  ["zero", "KeyZ"],
  ["fog", "KeyF"],
  ["inside", "KeyI"],
  ["sunOff", "KeyS"],
  ["pointOff", "KeyP"],
  ["overlap", "KeyB"],
  ["half", "KeyH"],
  ["wallOff", "KeyW"],
  ["blackOff", "KeyN"],
  ["scatter", "KeyL"],
  ["scatterSunOff", "KeyK"],
  ["scatterPointOff", "KeyJ"],
] as const;

const textureBoundary = {
  waitForResource: { id: "state", path: "stableTextureFrames", gte: 3 },
  timeoutMs: 30_000,
  release: true,
};

export function fogCaptureScenario(mode: string, key: string): IPlaytestScenario {
  return {
    schemaVersion: 1,
    name: `vq-volumetric-fog-${mode}`,
    target: "web",
    viewport: { width: 640, height: 400 },
    warmupFrames: 60,
    steps: [
      { press: [key], holdTicks: 1, release: true },
      { kind: "wait", waitFrames: 60, release: true },
      textureBoundary,
    ],
    assert: {
      components: [
        {
          entity: "fog",
          component: "ready",
          equals: true,
          allowTrivial: "Capture only the ready graph.",
        },
        {
          entity: "fog",
          component: "mode",
          equals: mode,
          allowTrivial: "A fixed named variant is the screenshot subject.",
        },
        {
          entity: "fog",
          component: "targets",
          equals: ["off", "zero", "blackOff"].includes(mode) ? 0 : 1,
          allowTrivial: "Observe the owned allocation baseline for this variant.",
        },
        ...["settledRenderFrames", "stableTextureFrames"].map((component) => ({
          entity: "fog",
          component,
          gte: 3,
          allowTrivial: "Resource counts must be observed stable over completed rendered frames.",
        })),
        {
          entity: "fog",
          component: "overlaps",
          equals: mode === "overlap",
          allowTrivial: "Only the overlap arm installs a second, nested density bound.",
        },
        ...[
          ["sun", mode !== "sunOff" && !mode.endsWith("SunOff")],
          ["point", mode !== "pointOff" && !mode.endsWith("PointOff")],
          ["scatteringOnly", mode.startsWith("scatter") || mode === "blackOff"],
        ].map(([component, equals]) => ({
          entity: "fog",
          component: String(component),
          equals,
          allowTrivial: "Observe the declared lighting and surface isolation for this arm.",
        })),
      ],
      diagnostics: { noConsoleErrors: true, noRuntimeDiagnostics: true, runtimeReady: true },
      visual: [
        {
          region: {
            x: 0,
            y: 0,
            width: 640,
            height: 400,
            minNonblankPixelRatio: 0.05,
          },
        },
        ...(mode === "blackOff"
          ? [
              {
                region: {
                  x: 0,
                  y: 0,
                  width: 500,
                  height: 400,
                  minNonblankPixelRatio: 0,
                  minDarkPixelRatio: 1,
                  maxLuminance: 0,
                },
              },
            ]
          : []),
      ],
    },
    artifacts: { screenshots: "after", console: true, runtimeTrace: true },
  };
}

export async function fogCaptureScenarios() {
  // A requested resolution is not a realized one: these arms must observe their authored transport
  // target, so a half-resolution request that silently rendered full size fails instead of passing.
  const transportTargets: Record<string, readonly [number, number, number]> = {
    half: [320, 200, 48],
    costFull: [640, 400, 48],
    costHalf: [320, 200, 48],
    costOff: [0, 0, 0],
  };
  const observeTransport = (scenario: IPlaytestScenario, mode: string): IPlaytestScenario => {
    const target = transportTargets[mode];
    if (target === undefined) return scenario;
    scenario.assert?.components?.push(
      ...[
        ["targetWidth", target[0]],
        ["targetHeight", target[1]],
        ["pixels", target[0] * target[1]],
        ["steps", target[2]],
      ].map(([component, equals]) => ({
        entity: "fog",
        component: String(component),
        equals,
        allowTrivial: "The transport target must realize this arm's authored resolution and steps.",
      })),
    );
    return scenario;
  };
  const result = cases.map(([mode, key]) => ({
    mode: String(mode),
    scenario: observeTransport(fogCaptureScenario(mode, key), String(mode)),
  }));
  const { sourcePath: _sourcePath, ...lifecycle } = await loadPlaytestScenario(
    root,
    "examples/abyss-framework/playtests/vq-volumetric-fog.playtest.json",
  );
  result.push({ mode: "lifecycle", scenario: lifecycle });
  const off = fogCaptureScenario("off", "KeyO");
  off.name = "vq-volumetric-fog-lifecycle-off";
  off.steps = [...lifecycle.steps, ...off.steps];
  off.assert?.components?.push(
    ...["createdTargets", "releasedTargets", "releasedMaterials", "liveTargets"].map(
      (component) => ({
        entity: "fog",
        component,
        equals: component === "liveTargets" ? 0 : 4,
        allowTrivial: "After four actual fog graphs, off returns the owned allocation baseline.",
      }),
    ),
  );
  result.push({ mode: "lifecycleOff", scenario: off });
  for (const [mode, width, height] of [
    ["resizeSmall", 320, 240],
    ["resizeRestore", 640, 400],
  ] as const) {
    const scenario = fogCaptureScenario("fog", "KeyF");
    scenario.name = `vq-volumetric-fog-${mode}`;
    scenario.steps.push(
      { press: ["KeyR"], holdTicks: 1, release: true },
      { kind: "wait", waitFrames: 60, release: true },
      textureBoundary,
    );
    if (mode === "resizeRestore")
      scenario.steps.push(
        { press: ["KeyT"], holdTicks: 1, release: true },
        { kind: "wait", waitFrames: 60, release: true },
        textureBoundary,
      );
    scenario.assert?.components?.push(
      ...[
        ["targetWidth", width],
        ["targetHeight", height],
        ["pixels", width * height],
        ["createdTargets", 1],
        ["releasedTargets", 0],
        ["liveTargets", 1],
      ].map(([component, equals]) => ({
        entity: "fog",
        component: String(component),
        equals,
        allowTrivial:
          "The existing fog target follows real renderer dimensions without graph replacement.",
      })),
    );
    result.push({ mode, scenario });
  }
  // Extend, rather than replace, the original seventeen frozen controls.
  for (const [mode, key] of [
    ["scatterOutside", "Digit1"],
    ["scatterOutsideSunOff", "Digit2"],
    ["scatterOutsidePointOff", "Digit3"],
  ] as const) {
    const scenario = fogCaptureScenario(mode, key);
    scenario.assert?.components?.push({
      entity: "fog",
      component: "shadowOutside",
      equals: true,
      allowTrivial: "The whole volume lies outside the ordinary directional shadow coverage.",
    });
    result.push({ mode, scenario });
  }
  for (const [mode, keys] of [
    ["cameraCut", ["Digit4"]],
    ["cameraRestore", ["Digit4", "Digit5"]],
    ["streamWallOut", ["Digit6"]],
    ["streamWallIn", ["Digit6", "Digit7"]],
    ["sceneReentry", ["Digit8"]],
    ["sceneRepeatedOff", ["Digit8", "KeyF", "Digit8"]],
  ] as const) {
    const scenario = fogCaptureScenario(mode.startsWith("scene") ? "off" : "fog", "KeyF");
    scenario.name = `vq-volumetric-fog-${mode}`;
    for (const key of keys)
      scenario.steps.push(
        { press: [key], holdTicks: 1, release: true },
        { kind: "wait", waitFrames: 60, release: true },
        textureBoundary,
      );
    const predicates = mode.startsWith("scene")
      ? [
          ["sceneEntries", mode === "sceneRepeatedOff" ? 3 : 2],
          ["sceneExits", mode === "sceneRepeatedOff" ? 2 : 1],
          ["exitReleasedTargets", 1],
          ["exitReleasedMaterials", 1],
          ["createdTargets", 0],
          ["liveTargets", 0],
        ]
      : [
          ["createdTargets", 1],
          ["releasedTargets", 0],
          ["liveTargets", 1],
          ["inside", mode === "cameraCut"],
          ["streamedWall", mode === "streamWallOut"],
        ];
    scenario.assert?.components?.push(
      ...predicates.map(([component, equals]) => ({
        entity: "fog",
        component: String(component),
        equals,
        allowTrivial:
          "Observe retained-controller transitions or actual scene-owner teardown and re-entry.",
      })),
    );
    result.push({ mode, scenario });
  }
  for (const [mode, variant, key] of [
    ["costOff", "off", "KeyO"],
    ["costFull", "fog", "KeyF"],
    ["costHalf", "half", "KeyH"],
  ] as const) {
    const scenario = observeTransport(fogCaptureScenario(variant, key), mode);
    scenario.name = `vq-volumetric-fog-${mode}`;
    scenario.steps.splice(scenario.steps.length - 1, 0, {
      waitForResource: { id: "state", path: "settledRenderFrames", gte: 90 },
      timeoutMs: 120_000,
      release: true,
    });
    scenario.assert?.components?.push({
      entity: "fog",
      component: "settledRenderFrames",
      gte: 90,
      allowTrivial:
        "Measure at least three thirty-frame meter windows after this fixed graph rendered.",
    });
    result.push({ mode, scenario });
  }
  return result;
}

export function fogFrameCost(consoleEntries: unknown) {
  if (!Array.isArray(consoleEntries)) throw new Error("VQ07 measured frame windows are missing.");
  const text = consoleEntries.map((entry) => entry.text).join("\n");
  const { budgets } = parsePerformanceMarkers(text);
  const measured = budgets.at(-1);
  if (budgets.length < 3 || measured === undefined)
    throw new Error("VQ07 requires three measured frame windows.");
  const render = measured.phases?.render;
  const frame = measured.frame;
  if (
    !Number.isInteger(measured.window) ||
    measured.window < 3 ||
    !Number.isInteger(measured.frames) ||
    measured.frames < 30 ||
    (measured.gpuMs !== undefined && (!Number.isFinite(measured.gpuMs) || measured.gpuMs < 0)) ||
    measured.surface === undefined ||
    measured.surface.compiling === true ||
    measured.surface.drawingBufferWidth !== 640 ||
    measured.surface.drawingBufferHeight !== 400 ||
    [render, frame].some(
      (metric) =>
        metric === undefined ||
        [metric.mean, metric.p50, metric.p95].some((value) => !Number.isFinite(value) || value < 0),
    )
  )
    throw new Error("VQ07 invalid or compilation-contaminated frame-cost window.");
  // `gpuMs` is the meter's own mean over the frames the device answered for, not over `frames`.
  // A software adapter answers sparsely, so the summary carries how many and how many it skipped.
  const marker = text
    .split("\n")
    .filter((line) => line.includes("TN_FRAME_BUDGET:"))
    .at(-1);
  const raw = marker === undefined ? {} : JSON.parse(marker.split("TN_FRAME_BUDGET:")[1] ?? "{}");
  const gpuSamples = raw.gpu?.samples ?? 0;
  const gpuStaleFrames = raw.gpuStale ?? 0;
  // A count the meter cannot have measured is a malformed meter, not an absent one: `NaN`, a negative
  // or an over-window count would print as a mean over frames nobody answered for. A window with no GPU
  // query stays an explicit zero and is unmeasured; a `gpuMs` without a positive count is rejected
  // rather than reported as a mean over zero frames.
  if (
    [gpuSamples, gpuStaleFrames].some(
      (count) => !Number.isInteger(count) || count < 0 || count > measured.frames,
    ) ||
    (measured.gpuMs !== undefined && gpuSamples === 0)
  )
    throw new Error(
      `VQ07 gpu sample counts must be nonnegative integers within the ${measured.frames}-frame window.`,
    );
  return {
    window: measured.window,
    frames: measured.frames,
    frameMs: frame,
    renderMs: render,
    gpuMs: measured.gpuMs,
    gpuSamples,
    gpuStaleFrames,
    qualification: `Same-fixture host frame/render duration; gpuMs is a mean over ${gpuSamples} of ${measured.frames} frames the device answered for and ${gpuStaleFrames} were stale; software adapters do not establish hardware cost or tier admission.`,
  };
}

// A one-variable diagnostic: retain this fixture's geometry, renderer and resize path,
// while never creating a fog controller. The ordinary 17-case acceptance sequence is separate.
export function fogResizeControlScenarios() {
  return ["resizeOff", "resizeOffRestore"].map((mode) => {
    const scenario = fogCaptureScenario("off", "KeyO");
    scenario.name = `vq-volumetric-fog-${mode}`;
    for (const key of mode === "resizeOff" ? ["KeyR"] : ["KeyR", "KeyT"])
      scenario.steps.push(
        { press: [key], holdTicks: 1, release: true },
        { kind: "wait", waitFrames: 60, release: true },
        textureBoundary,
      );
    scenario.assert?.components?.push(
      ...["createdTargets", "releasedTargets", "liveTargets"].map((component) => ({
        entity: "fog",
        component,
        equals: 0,
        allowTrivial: "The resize control must never allocate a fog controller or target.",
      })),
    );
    return { mode, scenario };
  });
}

export function fogNativePixelMetrics(png: PNG) {
  const metrics = regionMetrics(png, { x: 0, y: 0, width: png.width, height: png.height });
  return { ...metrics, minimum: 0.05, pass: metrics.nonblankPixelRatio >= 0.05 };
}

export async function readFogNativeConsole(
  report: Pick<IStandalonePlaytestReport, "pass" | "capture" | "diagnostics">,
  consolePath: string,
  viewport = { width: 640, height: 400 },
): Promise<unknown> {
  // Failed hosts can exit before writing console.json. Preserve their actual diagnostic.
  if (!fogCaptureIsValid(report, viewport))
    throw new Error(
      `VQ07 native capture failed: ${report.diagnostics.map(({ code, message }) => `${code}: ${message}`).join("; ") || "invalid capture report"}`,
    );
  return JSON.parse(await readFile(consolePath, "utf8"));
}

export function fogTextureBaselineMatches(
  baseline: Record<string, unknown>,
  restored: Record<string, unknown>,
): boolean {
  return (
    [baseline, restored].every((observation) =>
      ["textures", "settledRenderFrames", "stableTextureFrames"].every(
        (key) =>
          typeof observation[key] === "number" &&
          Number.isInteger(observation[key]) &&
          observation[key] >= (key === "textures" ? 0 : 3),
      ),
    ) && baseline.textures === restored.textures
  );
}

interface IFogExposureControl {
  pixels: Uint8Array;
  state: Record<string, unknown>;
}

/** Joint effects must exceed their own repeated-capture noise, not a tuned visual floor. */
export function qualifyFogExposureControls(controls: Record<string, IFogExposureControl>) {
  for (const name of ["off", "fog", "exposure", "both", "repeat"]) {
    const arm = controls[name];
    if (arm === undefined || arm.pixels.length === 0 || arm.pixels.length % 4 !== 0)
      throw new Error(`Missing complete joint control: ${name}`);
    const enabled = ["exposure", "both", "repeat"].includes(name);
    if (arm.state.exposureEnabled !== enabled || arm.state.exposureApplied !== enabled)
      throw new Error(`Exposure installation control mismatch: ${name}`);
    if (
      enabled &&
      (arm.state.exposureMeasured !== true ||
        arm.state.exposureSettled !== true ||
        !Number.isFinite(arm.state.exposureLuminance) ||
        Number(arm.state.exposureLuminance) <= 0 ||
        !Number.isFinite(arm.state.exposureStops))
    )
      throw new Error(`Missing finite settled GPU exposure: ${name}`);
  }
  const both = controls.both?.pixels;
  if (both === undefined) throw new Error("Both-enabled control missing.");
  const difference = (name: string) => {
    const pixels = controls[name]?.pixels;
    if (pixels === undefined) throw new Error(`Control missing: ${name}`);
    if (pixels.length !== both.length) throw new Error("Joint control capture sizes differ.");
    let total = 0;
    let max = 0;
    for (let i = 0; i < both.length; i++) {
      if (i % 4 === 3) continue;
      const delta = Math.abs((both[i] ?? Number.NaN) - (pixels[i] ?? Number.NaN));
      total += delta;
      max = Math.max(max, delta);
    }
    return { mean: total / (both.length * 0.75), max };
  };
  const noise = difference("repeat");
  const fogResponse = difference("exposure");
  const exposureResponse = difference("fog");
  for (const response of [fogResponse, exposureResponse])
    if (response.mean <= noise.mean || response.max <= Math.max(2, noise.max))
      throw new Error(
        "Joint enabled response does not exceed repeated-control/quantization noise.",
      );
  return { noise, fogResponse, exposureResponse };
}

interface IPixelFrame {
  width: number;
  height: number;
  data: Uint8Array;
}
// Pinned before capture: room interior excludes the foreground plate (x < 238),
// while the second patch lies wholly inside that plate. No single bright pixel can pass.
const SCATTER_ROI = { x: 260, y: 155, width: 150, height: 90 };
const FOG_EVALUATION_ROI = { x: 0, y: 0, width: 500, height: 400 };
const CALIBRATION_ROI = { x: 515, y: 25, width: 110, height: 110 };
const WALL_ROI = { x: 184, y: 216, width: 18, height: 18 };
export function fogLightPixelMetrics(
  black: IPixelFrame,
  both: IPixelFrame,
  sunOff: IPixelFrame,
  pointOff: IPixelFrame,
) {
  const images = [black, both, sunOff, pointOff];
  if (
    images.some(
      (image) => image.width !== 640 || image.height !== 400 || image.data.length !== 640 * 400 * 4,
    )
  )
    throw new Error("VQ07 scattering evidence requires complete 640x400 RGBA pixels.");
  const maxRgb = (image: IPixelFrame, roi: typeof SCATTER_ROI) => {
    let maximum = 0;
    for (let y = roi.y; y < roi.y + roi.height; y += 1)
      for (let x = roi.x; x < roi.x + roi.width; x += 1)
        for (let c = 0; c < 3; c += 1)
          maximum = Math.max(maximum, image.data[(y * image.width + x) * 4 + c] ?? Number.NaN);
    return maximum;
  };
  const delta = (without: IPixelFrame) => {
    let total = 0;
    let changed = 0;
    for (let y = SCATTER_ROI.y; y < SCATTER_ROI.y + SCATTER_ROI.height; y += 1)
      for (let x = SCATTER_ROI.x; x < SCATTER_ROI.x + SCATTER_ROI.width; x += 1) {
        let strongest = 0;
        for (let c = 0; c < 3; c += 1) {
          const i = (y * both.width + x) * 4 + c;
          const difference = (both.data[i] ?? Number.NaN) - (without.data[i] ?? Number.NaN);
          total += difference;
          strongest = Math.max(strongest, difference);
        }
        if (strongest > 2) changed += 1;
      }
    const pixels = SCATTER_ROI.width * SCATTER_ROI.height;
    return { meanRgbDelta: total / (pixels * 3), changedPixelRatio: changed / pixels };
  };
  const baselineMaxRgb = maxRgb(black, FOG_EVALUATION_ROI);
  let calibrationMinimum = 255;
  let calibrationMaxDifference = 0;
  for (let y = CALIBRATION_ROI.y; y < CALIBRATION_ROI.y + CALIBRATION_ROI.height; y += 1)
    for (let x = CALIBRATION_ROI.x; x < CALIBRATION_ROI.x + CALIBRATION_ROI.width; x += 1)
      for (let c = 0; c < 3; c += 1) {
        const i = (y * 640 + x) * 4 + c;
        const reference = black.data[i] ?? Number.NaN;
        calibrationMinimum = Math.min(calibrationMinimum, reference);
        for (const image of images)
          calibrationMaxDifference = Math.max(
            calibrationMaxDifference,
            Math.abs((image.data[i] ?? Number.NaN) - reference),
          );
      }
  const wallMaxRgb = Math.max(...images.map((image) => maxRgb(image, WALL_ROI)));
  const sun = delta(sunOff);
  const point = delta(pointOff);
  return {
    baselineMaxRgb,
    wallMaxRgb,
    roi: SCATTER_ROI,
    wallRoi: WALL_ROI,
    evaluationRoi: FOG_EVALUATION_ROI,
    calibrationRoi: CALIBRATION_ROI,
    calibrationMinimum,
    calibrationMaxDifference,
    sun,
    point,
    thresholds: {
      minMeanRgbDelta: 1,
      minChangedPixelRatio: 0.1,
      maxBlackRgb: 0,
      minCalibrationRgb: 32,
      maxCalibrationDifference: 0,
    },
    pass:
      baselineMaxRgb === 0 &&
      calibrationMinimum >= 32 &&
      calibrationMaxDifference === 0 &&
      wallMaxRgb === 0 &&
      [sun, point].every((metric) => metric.meanRgbDelta >= 1 && metric.changedPixelRatio >= 0.1),
  };
}

// Overlapping bounds are only qualified if the second one actually changes the image: the same
// camera and lights, one extra nested density bound, a difference too large to be noise.
export function fogOverlapPixelMetrics(single: IPixelFrame, overlap: IPixelFrame) {
  if (
    single.width !== overlap.width ||
    single.height !== overlap.height ||
    single.data.length !== overlap.data.length
  )
    throw new Error("VQ07 overlap evidence requires equally sized frames.");
  const pixels = single.width * single.height;
  let changed = 0;
  let maxChannelDelta = 0;
  for (let i = 0; i < pixels; i += 1)
    for (let c = 0; c < 3; c += 1) {
      const at = i * 4 + c;
      const difference = Math.abs(
        (overlap.data[at] ?? Number.NaN) - (single.data[at] ?? Number.NaN),
      );
      maxChannelDelta = Math.max(maxChannelDelta, difference);
      if (difference > 2) changed += 1;
    }
  const changedPixelRatio = changed / (pixels * 3);
  return {
    changedPixelRatio,
    maxChannelDelta,
    thresholds: { minChangedPixelRatio: 0.05, minMaxChannelDelta: 4 },
    pass: changedPixelRatio >= 0.05 && maxChannelDelta >= 4,
  };
}

export function fogCaptureIsValid(
  report: {
    pass: boolean;
    capture?: {
      rendererKind?: string;
      adapter?: Record<string, string>;
      viewport?: { width: number; height: number };
    };
    diagnostics: readonly { code: string; severity: string }[];
  },
  viewport = { width: 640, height: 400 },
): boolean {
  return (
    report.pass &&
    report.capture?.rendererKind === "webgpu" &&
    report.capture.viewport?.width === viewport.width &&
    report.capture.viewport.height === viewport.height &&
    ["vendor", "architecture", "device", "description"].some((key) => {
      const value = report.capture?.adapter?.[key];
      return (
        typeof value === "string" && value.trim() !== "" && !/^(unknown|unavailable)$/i.test(value)
      );
    }) &&
    !report.diagnostics.some(
      (diagnostic) =>
        diagnostic.severity === "error" || diagnostic.code === "TN_PLAYTEST_SOFTWARE_DEVICE_LOST",
    )
  );
}

export function nativeFogScenario(
  scenario: IPlaytestScenario,
  viewport = scenario.viewport,
): IPlaytestScenario {
  if (!scenario.assert?.components?.length)
    throw new Error("Native fog proof requires state predicates.");
  return {
    ...scenario,
    target: "desktop",
    viewport,
    artifacts: { screenshots: "after", console: true },
    assert: {
      resources: scenario.assert.components.map(({ entity: _entity, component, ...predicate }) => ({
        id: "state",
        path: component,
        ...predicate,
      })),
      startup: { maxEnteredMs: 120_000, maxReadyMs: 120_000 },
    },
  };
}

export function fogNativeCaptureIsValid(
  report: Pick<
    IStandalonePlaytestReport,
    "pass" | "capture" | "diagnostics" | "runtime" | "target" | "startup" | "assertionResults"
  >,
  nativeConsole: unknown,
  viewport = { width: 640, height: 400 },
): boolean {
  return (
    fogCaptureIsValid(report, viewport) &&
    report.runtime === "native" &&
    report.target === "desktop" &&
    report.capture?.target === "desktop" &&
    report.capture.captureMethod === "device.screenshot" &&
    report.startup?.phase === "ready" &&
    report.startup.compileSettled === true &&
    (report.assertionResults?.length ?? 0) > 0 &&
    report.assertionResults?.every((result) => result.pass) === true &&
    !report.diagnostics.some((diagnostic) => /DEVICE_LOST|BRIDGE_MISSING/u.test(diagnostic.code)) &&
    Array.isArray(nativeConsole) &&
    nativeConsole.length > 0 &&
    nativeConsole.every(
      (entry) =>
        entry &&
        typeof entry.text === "string" &&
        typeof entry.type === "string" &&
        entry.type !== "error" &&
        !/\[FATAL\]|\[WebGPU\].*(?:Device error|Device lost|Failed)|validation error|device(?:[ _-]| was )?lost|(?:Type|Reference|Range|Syntax)Error|TN_(?:NATIVE_START_FAILED|ASSETS_UNRESOLVED)/iu.test(
          entry.text,
        ),
    ) &&
    nativeConsole.some((entry) => entry.text.includes("TN_NATIVE_SMOKE_FIRST_FRAME"))
  );
}

async function main(): Promise<void> {
  const nativeRuntime = process.env.THREENATIVE_RUNTIME_BINARY;
  const resizeControl = process.env.VQ_FOG_RESIZE_CONTROL === "1";
  if (resizeControl && nativeRuntime === undefined)
    throw new Error("The native resize control requires the actual desktop host.");
  const artifacts = path.join(
    root,
    "artifacts",
    resizeControl
      ? "volumetric-fog-native-resize-control"
      : nativeRuntime === undefined
        ? "volumetric-fog"
        : "volumetric-fog-native",
  );
  const nativeBundle = path.join(artifacts, "fog-native.js");
  const hash = async (file: string) =>
    createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
  await mkdir(artifacts, { recursive: true });
  const dirty = execFileSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (dirty !== "")
    throw new Error("VQ07 captures require a clean committed source tree for SHA provenance.");
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const results: Record<string, unknown>[] = [];
  const summary = {
    sourceSha,
    pass: false,
    resizeControl,
    executionHost: { platform: process.platform, architecture: process.arch },
    nativeArtifacts: undefined as { runtimeSha256: string; bundleSha256: string } | undefined,
    qualification:
      nativeRuntime === undefined
        ? "Browser WebGPU software correctness; no native or hardware-performance claim."
        : "Linux native host software-rendered correctness; no Android, iOS, OS-window lifecycle or hardware-performance claim.",
    results,
  };
  await writeFile(
    path.join(artifacts, "attempt.json"),
    JSON.stringify({
      sourceSha,
      runId: process.env.GITHUB_RUN_ID,
      target: nativeRuntime === undefined ? "browser" : "desktop",
    }),
  );
  try {
    if (nativeRuntime !== undefined) {
      // Stage the asset manifest and run from its root, as packaged native games do.
      const { compileAssets } = await import("../packages/assets/dist/index.js");
      await compileAssets({ cwd: fixture, output: artifacts });
      execFileSync(
        process.execPath,
        [
          "packages/runtime-native/scripts/bundle.mjs",
          "--project",
          fixture,
          "--entry",
          "src/game.ts",
          "--target",
          "desktop",
          "--native-backend",
          "--output",
          nativeBundle,
        ],
        { cwd: root, stdio: "inherit" },
      );
      summary.nativeArtifacts = {
        runtimeSha256: await hash(nativeRuntime),
        bundleSha256: await hash(nativeBundle),
      };
    }
    for (const { mode, scenario: authored } of resizeControl
      ? fogResizeControlScenarios()
      : await fogCaptureScenarios()) {
      const scenario =
        nativeRuntime === undefined
          ? authored
          : nativeFogScenario(
              authored,
              mode === "resizeSmall" || mode === "resizeOff"
                ? { width: 320, height: 240 }
                : authored.viewport,
            );
      const directory = path.join(artifacts, mode);
      await mkdir(directory, { recursive: true });
      const scenarioPath = path.join(directory, "scenario.playtest.json");
      await writeFile(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`);
      await loadPlaytestScenario(root, scenarioPath);
      const report =
        nativeRuntime === undefined
          ? await runStandalonePlaytest({
              artifactDirectory: directory,
              projectPath: fixture,
              scenarioPath,
              target: "browser",
              headless: false,
              allowSoftwareAdapter: true,
              browserArgs: WEBGPU_BROWSER_ARGS,
              port: 0,
              url: "http://127.0.0.1:5173/",
              timeoutMs: 120_000,
              trace: false,
              server: {
                cwd: root,
                command: `VQ_FOG_HTTP_LOG=${JSON.stringify(path.join(directory, "http-errors.jsonl"))} node examples/abyss-framework/node_modules/vite/bin/vite.js preview --config examples/abyss-framework/vq-fog/vite.config.ts --host 127.0.0.1 --port \${PORT}`,
                timeoutMs: 60_000,
              },
            })
          : await runDesktopPlaytest({
              artifactDirectory: directory,
              projectPath: artifacts,
              scenarioPath,
              target: "desktop",
              desktop: {
                executable: nativeRuntime,
                hostArgs: ["run", nativeBundle, "--windowed", "--width", "640", "--height", "400"],
              },
              allowSoftwareAdapter: true,
              headless: false,
              timeoutMs: 120_000,
              trace: false,
              url: "",
            });
      await writeFile(path.join(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
      await writeFile(
        path.join(directory, "observations.json"),
        `${JSON.stringify(report.observations, null, 2)}\n`,
      );
      const nativeConsole =
        nativeRuntime === undefined
          ? undefined
          : await readFogNativeConsole(
              report,
              path.join(directory, "console.json"),
              scenario.viewport,
            );
      const valid =
        nativeRuntime === undefined
          ? fogCaptureIsValid(report)
          : fogNativeCaptureIsValid(report, nativeConsole, scenario.viewport);
      const observedState = report.observations?.resources?.state?.after as
        | Record<string, unknown>
        | undefined;
      results.push({
        mode,
        sourceSha,
        pass: valid,
        capture: report.capture,
        resources: Object.fromEntries(
          ["textures", "settledRenderFrames", "stableTextureFrames"].map((key) => [
            key,
            observedState?.[key],
          ]),
        ),
        diagnostics: report.diagnostics,
        lights: {
          directional: {
            name: "fog-directional",
            type: "DirectionalLight",
            shadow: "ordinary-map",
          },
          point: { name: "fog-point", type: "PointLight", shadow: "none", range: 8 },
        },
      });
      await writeFile(
        path.join(artifacts, "summary.json"),
        `${JSON.stringify(summary, null, 2)}\n`,
      );
      if (!valid)
        throw new Error(
          `VQ07 ${mode}: rejected runtime/capture diagnostics; preserve artifacts as diagnostic only.`,
        );
      const png = PNG.sync.read(await readFile(path.join(directory, "after.png")));
      if (png.width !== scenario.viewport.width || png.height !== scenario.viewport.height)
        throw new Error(
          `VQ07 ${mode}: actual screenshot dimensions do not match the declared capture viewport.`,
        );
      if (mode.startsWith("cost")) {
        const measured = fogFrameCost(
          JSON.parse(await readFile(path.join(directory, "console.json"), "utf8")),
        );
        results.push({
          assertion: `${mode} measured per-frame cost`,
          ...measured,
          transportPixels: observedState?.pixels,
          transportWidth: observedState?.targetWidth,
          transportHeight: observedState?.targetHeight,
          raySteps: observedState?.steps,
          directionalLights: 1,
          localLights: 1,
        });
      }
      if (nativeRuntime !== undefined) {
        const metrics = fogNativePixelMetrics(png);
        results.push({ assertion: `${mode} authored whole-frame nonblank ratio`, ...metrics });
        if (!metrics.pass)
          throw new Error(
            `VQ07 ${mode}: native pixels fail the authored five-percent nonblank gate.`,
          );
      }
    }
    if (resizeControl) {
      if (nativeRuntime === undefined) throw new Error("Missing native resize-control executable.");
      if (
        (await hash(nativeRuntime)) !== summary.nativeArtifacts?.runtimeSha256 ||
        (await hash(nativeBundle)) !== summary.nativeArtifacts?.bundleSha256
      )
        throw new Error("VQ07 native executable or game bundle changed during resize control.");
      summary.pass = true;
      return;
    }
    const off = PNG.sync.read(await readFile(path.join(artifacts, "off/after.png")));
    const zero = PNG.sync.read(await readFile(path.join(artifacts, "zero/after.png")));
    if (off.width !== zero.width || off.height !== zero.height || !off.data.equals(zero.data))
      throw new Error("VQ07 zero-density identity failed: rendered off/zero pixels differ.");
    results.push({ assertion: "zero-density pixel identity", pass: true });
    const restored = PNG.sync.read(await readFile(path.join(artifacts, "lifecycleOff/after.png")));
    if (!off.data.equals(restored.data))
      throw new Error("VQ07 lifecycle off did not restore the baseline pixels.");
    results.push({ assertion: "repeated lifecycle restores baseline pixels", pass: true });
    const baselineResources = results.find((result) => result.mode === "off")?.resources as
      | Record<string, unknown>
      | undefined;
    const restoredResources = results.find((result) => result.mode === "lifecycleOff")?.resources as
      | Record<string, unknown>
      | undefined;
    const texturesRestored =
      baselineResources !== undefined &&
      restoredResources !== undefined &&
      fogTextureBaselineMatches(baselineResources, restoredResources);
    results.push({
      assertion: "renderer texture allocation baseline",
      baselineResources,
      restoredResources,
      pass: texturesRestored,
    });
    if (!texturesRestored)
      throw new Error("VQ07 renderer texture allocation baseline did not settle and restore.");
    const fog = PNG.sync.read(await readFile(path.join(artifacts, "fog/after.png")));
    const resized = PNG.sync.read(await readFile(path.join(artifacts, "resizeRestore/after.png")));
    if (
      fog.width !== resized.width ||
      fog.height !== resized.height ||
      !fog.data.equals(resized.data)
    )
      throw new Error("VQ07 target resize restore did not recover the exact fog pixels.");
    results.push({ assertion: "target/depth resize restores exact pixels", pass: true });
    const overlapMetrics = fogOverlapPixelMetrics(
      fog,
      PNG.sync.read(await readFile(path.join(artifacts, "overlap/after.png"))),
    );
    results.push({ assertion: "overlapping density bounds change the image", ...overlapMetrics });
    if (!overlapMetrics.pass)
      throw new Error("VQ07 the overlapping density bound did not measurably change the image.");
    for (const [mode, reference] of [
      ["cameraCut", "inside"],
      ["cameraRestore", "fog"],
      ["streamWallOut", "wallOff"],
      ["streamWallIn", "fog"],
      ["sceneReentry", "off"],
      ["sceneRepeatedOff", "off"],
    ] as const) {
      const frame = PNG.sync.read(await readFile(path.join(artifacts, mode, "after.png")));
      const expected = PNG.sync.read(await readFile(path.join(artifacts, reference, "after.png")));
      if (!frame.data.equals(expected.data))
        throw new Error(`VQ07 ${mode} differs from fresh ${reference} pixels.`);
      results.push({ assertion: `${mode} matches fresh ${reference} pixels`, pass: true });
      if (mode.startsWith("scene")) {
        const resources = results.find((result) => result.mode === mode)?.resources as
          | Record<string, unknown>
          | undefined;
        if (
          !resources ||
          !baselineResources ||
          !fogTextureBaselineMatches(baselineResources, resources)
        )
          throw new Error(`VQ07 ${mode} did not restore renderer texture allocations.`);
      }
    }
    const lightFrames = await Promise.all(
      ["blackOff", "scatter", "scatterSunOff", "scatterPointOff"].map(async (mode) =>
        PNG.sync.read(await readFile(path.join(artifacts, mode, "after.png"))),
      ),
    );
    const [black, both, sunOff, pointOff] = lightFrames;
    if (!black || !both || !sunOff || !pointOff)
      throw new Error("Missing scattering-control frame.");
    const metrics = fogLightPixelMetrics(black, both, sunOff, pointOff);
    results.push({ assertion: "isolated light-scattering pixels", ...metrics });
    if (!metrics.pass)
      throw new Error("VQ07 isolated light-scattering/black-control pixel gates failed.");
    const outsideFrames = await Promise.all(
      ["scatterOutside", "scatterOutsideSunOff", "scatterOutsidePointOff"].map(async (mode) =>
        PNG.sync.read(await readFile(path.join(artifacts, mode, "after.png"))),
      ),
    );
    const [outside, outsideSunOff, outsidePointOff] = outsideFrames;
    if (!outside || !outsideSunOff || !outsidePointOff)
      throw new Error("Missing outside-shadow-map control.");
    const outsideMetrics = fogLightPixelMetrics(black, outside, outsideSunOff, outsidePointOff);
    results.push({ assertion: "unshadowed light outside directional map", ...outsideMetrics });
    if (!outsideMetrics.pass)
      throw new Error("VQ07 outside-shadow-map light-response gates failed.");
    if (
      nativeRuntime !== undefined &&
      ((await hash(nativeRuntime)) !== summary.nativeArtifacts?.runtimeSha256 ||
        (await hash(nativeBundle)) !== summary.nativeArtifacts?.bundleSha256)
    )
      throw new Error("VQ07 native executable or game bundle changed during proof.");
    summary.pass = true;
  } finally {
    await writeFile(path.join(artifacts, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  }
}
if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
