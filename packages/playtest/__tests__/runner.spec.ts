import { makeTempDir } from "../../../test-support/temp-dir.js";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";
import { expect, test, vi } from "vitest";

import {
  loadPlaytestScenario,
  PLAYTEST_PROTOCOL_LIMITS,
  PLAYTEST_PROTOCOL_VERSION,
  type IPlaytestObservationSnapshot,
  type IPlaytestScenario,
} from "../src/index.js";
import { classifyAdapter } from "../src/evaluators/adapter-class.js";
import type { JsonValue } from "../src/protocol.js";
import type { IPlaytestReport } from "../src/report.js";
import type { IStandalonePlaytestConfig } from "../src/runner/config.js";
import { exitCodeForReport } from "../src/runner/cli.js";
import {
  boundedTeardownStep,
  advanceFixedStep,
  buildReport,
  captureVisualSurface,
  handlePlaytestSignal,
  openPageAndConnectBridge,
  pageLifecycleDiagnostic,
  playtestStepDrivesMovement,
  resolveManagedServerCommand,
  runStandalonePlaytest,
  STANDALONE_PLAYTEST_OBSERVATION_FIELDS,
  substituteManagedPort,
} from "../src/runner/runner.js";
import { sampleVisualElementBounds, screenshotObservations } from "../src/runner/steps.js";
import { playtestStepHoldTicks, playtestStepWaitTicks } from "../src/scenario.js";
import { chromium, type Page } from "playwright";
import { PLAYTEST_ASSERTION_REGISTRY } from "../src/index.js";
import { HOST_PLAYTEST_OBSERVATION_FIELDS } from "../src/runner/observationFields.js";
import { waitForStartupReady } from "../src/runner/startupReady.js";
import { SCREENSHOT_TIMEOUT_MS } from "../src/runner/shared.js";

const CONFIG: IStandalonePlaytestConfig = {
  artifactDirectory: "artifacts/playtest",
  headless: true,
  projectPath: ".",
  scenarioPath: "playtests/play.playtest.json",
  timeoutMs: 1_000,
  trace: false,
  url: "http://127.0.0.1:5173",
};

function installGlobal(name: string, value: unknown): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
  return () => {
    if (descriptor === undefined) delete (globalThis as Record<string, unknown>)[name];
    else Object.defineProperty(globalThis, name, descriptor);
  };
}

function brightScreenshot(): Buffer {
  const png = new PNG({ height: 4, width: 4 });
  png.data.fill(255);
  return PNG.sync.write(png);
}

function targetPaintScreenshot(hidden: boolean): Buffer {
  const png = new PNG({ height: 4, width: 4 });
  png.data.fill(255);
  if (!hidden) {
    png.data[0] = 0;
    png.data[1] = 0;
    png.data[2] = 0;
  }
  return PNG.sync.write(png);
}

test("visual capture clips the largest canvas without waiting for locator stability", async () => {
  const smallCanvas = { height: 1, width: 1 } as HTMLCanvasElement;
  const renderCanvas = { height: 2, width: 4 } as HTMLCanvasElement;
  const locatorScreenshot = vi.fn(async () => Buffer.from("locator-canvas"));
  const boundingBox = vi.fn(async () => ({ height: 360, width: 640, x: 12, y: 24 }));
  const nth = vi.fn(() => ({ boundingBox, screenshot: locatorScreenshot }));
  const evaluateAll = vi.fn(async (callback: (elements: HTMLCanvasElement[]) => unknown) =>
    callback([smallCanvas, renderCanvas]),
  );
  const locator = { evaluateAll, nth };
  const pageScreenshot = vi.fn(async () => Buffer.from("canvas"));
  const page = {
    locator: vi.fn(() => locator),
    screenshot: pageScreenshot,
  } as unknown as Page;

  await expect(captureVisualSurface(page)).resolves.toEqual(Buffer.from("canvas"));
  expect(page.locator).toHaveBeenCalledWith("canvas");
  expect(nth).toHaveBeenCalledWith(1);
  expect(boundingBox).toHaveBeenCalledWith();
  expect(locatorScreenshot).not.toHaveBeenCalled();
  expect(pageScreenshot).toHaveBeenCalledWith({
    clip: { height: 360, width: 640, x: 12, y: 24 },
    timeout: SCREENSHOT_TIMEOUT_MS,
  });
});

test("visual observations rasterize an element-bound region captured beside the screenshot", () => {
  const png = new PNG({ height: 20, width: 30 });
  png.data.fill(255);
  const currentScenario = scenario({
    visual: [{ region: { element: { id: "threenative-canvas-error" }, minNonblankPixelRatio: 0.5 } }],
  });
  const captureBounds = [{
    assertionIndex: 0,
    bounds: { height: 10, width: 12, x: 4, y: 3 },
    element: { id: "threenative-canvas-error" },
    rendered: true,
  }];

  const observations = (screenshotObservations as unknown as (...args: unknown[]) => unknown)(
    undefined,
    PNG.sync.write(png),
    currentScenario,
    undefined,
    captureBounds,
  ) as { elementRegions?: unknown[] };

  expect(observations.elementRegions).toEqual([{
    assertionIndex: 0,
    bounds: { height: 10, width: 12, x: 4, y: 3 },
    darkPixelRatio: 0,
    element: { id: "threenative-canvas-error" },
    nonblankPixelRatio: 1,
    rendered: true,
  }]);
});

test("browser visual capture records id or selector bounds and renderability", async () => {
  let targetHidden = false;
  let isolationActive = false;
  let styleCount = 0;
  const visible = {
    contains: () => false,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ height: 10, left: 4, top: 3, width: 12 }),
    parentElement: null,
    removeAttribute: (name: string) => {
      if (name === "style") targetHidden = false;
    },
    setAttribute: () => undefined,
    style: {
      setProperty: (name: string, value: string) => {
        if (name === "opacity" && value === "0") targetHidden = true;
      },
    },
  };
  const transparent = {
    contains: () => false,
    getBoundingClientRect: () => ({ height: 10, left: 4, top: 3, width: 12 }),
    parentElement: null,
  };
  const pointerEventsStyle = { remove: () => undefined };
  const isolationStyle = { remove: () => { isolationActive = false; } };
  const probe = {
    remove: () => undefined,
    removeAttribute: () => undefined,
    setAttribute: () => undefined,
  };
  const restoreDocument = installGlobal("document", {
    createElement: (tagName: string) => {
      if (tagName === "style") return styleCount++ === 0 ? pointerEventsStyle : isolationStyle;
      return probe;
    },
    elementFromPoint: () => visible,
    getElementById: (id: string) => id === "visible" ? visible : transparent,
    head: { appendChild: (element: unknown) => { if (element === isolationStyle) isolationActive = true; } },
    querySelector: () => visible,
  });
  const restoreWindow = installGlobal("window", {
    getComputedStyle: (element: unknown) => ({
      display: "block",
      getPropertyValue: () => "",
      opacity: element === transparent ? "0" : "1",
      visibility: element === probe && isolationActive ? "hidden" : "visible",
    }),
    innerHeight: 720,
    innerWidth: 1280,
  });
  try {
    const page = {
      evaluate: async (callback: (targets: unknown) => unknown, targets: unknown) => callback(targets),
      screenshot: async () => targetPaintScreenshot(targetHidden),
    } as unknown as Page;
    await expect(sampleVisualElementBounds(page, [
      { region: { element: { id: "visible" } } },
      { region: { element: { selector: ".visible" } } },
      { region: { element: { id: "transparent" } } },
    ] as never)).resolves.toEqual([
      {
        assertionIndex: 0,
        bounds: { height: 10, width: 12, x: 4, y: 3 },
        element: { id: "visible" },
        rendered: true,
      },
      {
        assertionIndex: 1,
        bounds: { height: 10, width: 12, x: 4, y: 3 },
        element: { selector: ".visible" },
        rendered: true,
      },
      {
        assertionIndex: 2,
        bounds: { height: 10, width: 12, x: 4, y: 3 },
        element: { id: "transparent" },
        rendered: false,
      },
    ]);
  } finally {
    restoreWindow();
    restoreDocument();
  }
});

test("browser visual element regions accept painted noninteractive nodes", async () => {
  const canvas = {};
  let targetHidden = false;
  let isolationActive = false;
  let styleCount = 0;
  const target = {
    contains: () => false,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ height: 10, left: 4, top: 3, width: 12 }),
    parentElement: null,
    removeAttribute: (name: string) => {
      if (name === "style") targetHidden = false;
    },
    setAttribute: () => undefined,
    style: {
      setProperty: (name: string, value: string) => {
        if (name === "opacity" && value === "0") targetHidden = true;
      },
    },
  };
  let forcedPointerEvents = false;
  const pointerEventsStyle = { remove: () => { forcedPointerEvents = false; } };
  const isolationStyle = { remove: () => { isolationActive = false; } };
  const probe = {
    remove: () => undefined,
    removeAttribute: () => undefined,
    setAttribute: () => undefined,
  };
  const restoreDocument = installGlobal("document", {
    createElement: (tagName: string) => {
      if (tagName === "style") return styleCount++ === 0 ? pointerEventsStyle : isolationStyle;
      return probe;
    },
    elementFromPoint: () => forcedPointerEvents ? target : canvas,
    getElementById: () => target,
    head: {
      appendChild: (element: unknown) => {
        if (element === pointerEventsStyle) forcedPointerEvents = true;
        if (element === isolationStyle) isolationActive = true;
      },
    },
  });
  const restoreWindow = installGlobal("window", {
    getComputedStyle: (element: unknown) => ({
      display: "block",
      getPropertyValue: () => "",
      opacity: "1",
      visibility: element === probe && isolationActive ? "hidden" : "visible",
    }),
    innerHeight: 720,
    innerWidth: 1280,
  });
  try {
    const page = {
      evaluate: async (callback: (targets: unknown) => unknown, targets: unknown) => callback(targets),
      screenshot: async () => targetPaintScreenshot(targetHidden),
    } as unknown as Page;
    await expect(sampleVisualElementBounds(page, [
      { region: { element: { id: "target" } } },
    ] as never)).resolves.toEqual([
      {
        assertionIndex: 0,
        bounds: { height: 10, width: 12, x: 4, y: 3 },
        element: { id: "target" },
        rendered: true,
      },
    ]);
  } finally {
    restoreWindow();
    restoreDocument();
  }
});

test("browser visual element regions reject nodes hidden by a noninteractive overlay", async () => {
  const target = {
    contains: () => false,
    getBoundingClientRect: () => ({ height: 720, left: 0, top: 0, width: 1280 }),
    parentElement: null,
  };
  const overlay = {};
  let forcedPointerEvents = false;
  const pointerEventsStyle = { remove: () => { forcedPointerEvents = false; } };
  const restoreDocument = installGlobal("document", {
    createElement: () => pointerEventsStyle,
    elementFromPoint: () => forcedPointerEvents ? overlay : target,
    getElementById: () => target,
    head: { appendChild: () => { forcedPointerEvents = true; } },
  });
  const restoreWindow = installGlobal("window", {
    getComputedStyle: () => ({ display: "block", getPropertyValue: () => "", opacity: "1", visibility: "visible" }),
    innerHeight: 720,
    innerWidth: 1280,
  });
  try {
    const page = {
      evaluate: async (callback: (targets: unknown) => unknown, targets: unknown) => callback(targets),
      screenshot: async () => brightScreenshot(),
    } as unknown as Page;
    await expect(sampleVisualElementBounds(page, [
      { region: { element: { id: "target" } } },
    ] as never)).resolves.toEqual([
      {
        assertionIndex: 0,
        bounds: { height: 720, width: 1280, x: 0, y: 0 },
        element: { id: "target" },
        rendered: false,
      },
    ]);
  } finally {
    restoreWindow();
    restoreDocument();
  }
});

test("fixed-step startup races retry without hiding a stopped loop", async () => {
  let attempts = 0;
  const bridge = {
    advance: vi.fn(async (_ticks: number) => {
      attempts += 1;
      if (attempts === 1) throw new Error("page.evaluate: Error: Cannot advance a stopped loop.");
    }),
  };
  const page = { evaluate: vi.fn(async () => undefined) } as unknown as Page;

  await advanceFixedStep(page, bridge, 10);

  // The first one-tick request retries once; the remaining nine ticks each use one bounded request.
  expect(attempts).toBe(11);
  expect(bridge.advance.mock.calls.every((args) => args[0] === 1 && args.length === 1)).toBe(true);
  expect(page.evaluate).toHaveBeenCalledTimes(1);
});

test("a rendered fixed-step advance draws one world frame per tick and lets the HUD paint between them", async () => {
  const bridge = { advance: vi.fn(async (_ticks: number, _options?: { render?: boolean }) => undefined) };
  const page = { evaluate: vi.fn(async () => undefined) } as unknown as Page;

  await advanceFixedStep(page, bridge, 10, true);

  expect(bridge.advance.mock.calls).toEqual(Array.from({ length: 10 }, () => [1, { render: true }]));
  expect(page.evaluate).toHaveBeenCalledTimes(9);
});

test.each([0, -1, 1.5, Number.NaN])("fixed-step driving rejects invalid tick count %s", async (ticks) => {
  const bridge = { advance: vi.fn() };
  await expect(advanceFixedStep({} as Page, bridge, ticks)).rejects.toThrow("positive integer");
  expect(bridge.advance).not.toHaveBeenCalled();
});

test("browser bridge handshake honors the configured operation timeout", async () => {
  vi.useFakeTimers();
  try {
    const evaluate = vi.fn(async (_callback: unknown, input: { method: string }) => {
      if (input.method === "describe") {
        await new Promise<void>((resolve) => setTimeout(resolve, 5_100));
        return {
          capabilities: [],
          limits: PLAYTEST_PROTOCOL_LIMITS,
          name: "test-bridge",
          protocolVersion: PLAYTEST_PROTOCOL_VERSION,
        };
      }
      if (input.method === "ready") return { ready: true };
      throw new Error(`Unexpected bridge method: ${input.method}`);
    });
    const page = {
      evaluate,
      goto: vi.fn(async () => undefined),
      waitForFunction: vi.fn(async () => undefined),
      waitForLoadState: vi.fn(async () => undefined),
    } as unknown as Page;

    const pending = openPageAndConnectBridge(
      page,
      { ...CONFIG, timeoutMs: 6_000 },
      scenario(undefined),
    );
    await vi.advanceTimersByTimeAsync(5_100);

    await expect(pending).resolves.toBeDefined();
  } finally {
    vi.useRealTimers();
  }
});

function scenario(assert: IPlaytestScenario["assert"]): IPlaytestScenario {
  return {
    ...(assert === undefined ? {} : { assert }),
    name: "runner-proof",
    schemaVersion: 1,
    steps: [{ release: true, waitFrames: 1 }],
    target: "web",
    viewport: { height: 720, width: 1280 },
    warmupFrames: 0,
  };
}

function labeledScenario(
  assert: IPlaytestScenario["assert"],
  labels: readonly string[],
): IPlaytestScenario {
  return {
    ...scenario(assert),
    steps: labels.map((label) => ({ label, release: true, waitFrames: 1 })),
  };
}

function report(
  currentScenario: IPlaytestScenario,
  hud: Record<string, { after?: unknown; before?: unknown }> = {},
  options: {
    consoleEntries?: Array<{ text: string; type: string }>;
    runtimeReady?: boolean;
  } = {},
) {
  return buildReport(
    CONFIG,
    currentScenario,
    undefined,
    undefined,
    options.consoleEntries ?? [],
    [],
    undefined,
    hud,
    options.runtimeReady,
  );
}

// Without --enable-features=Vulkan, or headless on a host the browser will not take a GPU
// from, Chromium serves WebGPU from SwiftShader and says nothing: the adapter answers, the
// limits look healthy, and the run reports a CPU rasteriser's results. One sweep lost a
// scenario to 43 spurious console errors this way. See
// docs/verification/sweep-platformer-2026-08-16.md.
function reportWithAdapter(
  adapter: Record<string, string>,
  config: IStandalonePlaytestConfig = CONFIG,
) {
  return buildReport(
    config,
    scenario(undefined),
    undefined,
    undefined,
    [],
    [],
    undefined,
    {},
    true,
    undefined,
    [],
    undefined,
    {
      adapter,
      browserArgs: [],
      captureMethod: "page.screenshot",
      rendererKind: "webgpu",
      target: "web",
      viewport: { height: 720, width: 1280 },
    },
  );
}

function errorCodes(report: IPlaytestReport): string[] {
  return report.diagnostics.filter(({ severity }) => severity === "error").map(({ code }) => code);
}

test.each([
  ["architecture", { architecture: "swiftshader", vendor: "google" }],
  ["description", { description: "llvmpipe (LLVM 17, 256 bits)", vendor: "mesa" }],
  ["device", { device: "Microsoft Basic Render Driver", vendor: "microsoft" }],
])("a software WebGPU adapter named in %s fails the run", (_field, adapter) => {
  const result = reportWithAdapter(adapter);

  expect(result.diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_SOFTWARE_ADAPTER");
  // The scenario `reportWithAdapter` builds asserts nothing, so it is red whatever the adapter
  // says. Asserting only `pass` here would leave this test green with the diagnostic demoted.
  expect(errorCodes(result)).toContain("TN_PLAYTEST_SOFTWARE_ADAPTER");
  expect(result.pass).toBe(false);
});

test("a hardware WebGPU adapter passes without a software diagnostic", () => {
  const result = reportWithAdapter({ architecture: "turing", vendor: "nvidia" });

  expect(result.diagnostics.map(({ code }) => code)).not.toContain("TN_PLAYTEST_SOFTWARE_ADAPTER");
});

test("--allow-software accepts the fallback deliberately", () => {
  const result = reportWithAdapter(
    { architecture: "swiftshader", vendor: "google" },
    { ...CONFIG, allowSoftwareAdapter: true },
  );

  expect(result.diagnostics.map(({ code }) => code)).not.toContain("TN_PLAYTEST_SOFTWARE_ADAPTER");
});

// A native host reporting its own software adapter is not a licence: the target only says which
// machine asked, not that anyone accepted the answer. Hosted device lanes have no hardware to
// reach for (the emulator is configured `-gpu swiftshader_indirect`, the Linux runners bind
// llvmpipe, the Windows runner answers `Microsoft Basic Render Driver`), and a generic local
// desktop run can hit the same wall by accident. So the error stands on every target, and the
// hosted lanes say `TN_PLAYTEST_ALLOW_SOFTWARE=1` where they declare their own acceptance.
test.each(["android", "desktop", "ios"] as const)(
  "a software adapter the %s host reported itself fails unless it was accepted",
  (target) => {
    const result = reportWithAdapter(
      { device: "Microsoft Basic Render Driver", vendor: "microsoft" },
      { ...CONFIG, target },
    );
    const diagnostic = result.diagnostics.find(({ code }) => code === "TN_PLAYTEST_SOFTWARE_ADAPTER");

    expect(diagnostic?.severity).toBe("error");
    expect(diagnostic?.message).toContain("Microsoft Basic Render Driver");
    expect(errorCodes(result)).toContain("TN_PLAYTEST_SOFTWARE_ADAPTER");
    // The acceptance only removes the error; the fact stays on the report and still classifies.
    expect(result.capture?.adapter).toEqual({
      device: "Microsoft Basic Render Driver",
      vendor: "microsoft",
    });
  },
);

test.each(["android", "desktop", "ios"] as const)(
  "a %s host that declared --allow-software passes with the adapter labelled",
  (target) => {
    const result = reportWithAdapter(
      { device: "Microsoft Basic Render Driver", vendor: "microsoft" },
      { ...CONFIG, allowSoftwareAdapter: true, target },
    );

    expect(result.diagnostics.map(({ code }) => code)).not.toContain("TN_PLAYTEST_SOFTWARE_ADAPTER");
    expect(classifyAdapter(result)).toEqual({
      adapterClass: "software",
      softwareAdapter: "Microsoft Basic Render Driver",
    });
  },
);

test("a software adapter on the desktop host still classifies the run as software", () => {
  const result = reportWithAdapter(
    { architecture: "swiftshader", vendor: "google" },
    { ...CONFIG, target: "desktop" },
  );

  expect(classifyAdapter(result)).toEqual({
    adapterClass: "software",
    softwareAdapter: "swiftshader",
  });
});

test("runner carries a supplied HUD observation into the evaluated report", () => {
  const result = report(
    scenario({ hud: [{ id: "score", path: "#root", textIncludes: "1" }] }),
    { score: { after: { "#root": "Score: 1" } } },
  );

  expect(result.observations?.hud.score).toBeDefined();
  expect(result.assertionResults).toContainEqual({
    details: expect.objectContaining({ after: "Score: 1" }),
    id: "hud.score.#root",
    pass: true,
  });
  expect(result.pass).toBe(true);
});

test("runner records the reason for each triviality opt-out", () => {
  const reason = "The initial health is intentionally held while the independent flag transition proves the scenario ran.";
  const currentScenario = scenario({
    components: [
      { allowTrivial: reason, component: "health", entity: "player", equals: 3 },
      { allowTrivial: "This reason is present but the initial value fails, so this row proves an actual transition.", changed: true, component: "armed", entity: "player", equals: true },
    ],
  });
  const snapshot = (armed: boolean): IPlaytestObservationSnapshot => ({
    clock: { mode: "fixed-step", tick: armed ? 1 : 0 },
    components: { player: { armed, health: 3 } },
    entities: [],
    resources: {},
  });

  const result = buildReport(CONFIG, currentScenario, snapshot(false), snapshot(true), [], []);

  expect(result.pass).toBe(true);
  expect(result.trivialityOptOutCount).toBe(1);
  expect(result.trivialityOptOuts).toEqual([{ id: "component.player.health.value", reason }]);
  expect(result.assertionResults).toContainEqual(expect.objectContaining({
    details: expect.objectContaining({ trivialityOptOut: true }),
    id: "component.player.health.value",
  }));
});

test("runner records a tag triviality reason while another assertion proves the run", () => {
  const reason = "The initial coin count is intentionally held while the player state transition proves this scenario executed.";
  const currentScenario = scenario({
    states: [{ entity: "player", equals: "active" }],
    tags: [{ allowTrivial: reason, count: 1, tag: "coin" }],
  });
  const snapshot = (state: string): IPlaytestObservationSnapshot => ({
    clock: { mode: "fixed-step", tick: state === "active" ? 1 : 0 },
    entities: [],
    gameplay: {
      animation: {},
      states: { player: state },
      tags: { coin: { count: 1 } },
    },
    resources: {},
  });

  const result = buildReport(CONFIG, currentScenario, snapshot("idle"), snapshot("active"), [], []);

  expect(result.pass).toBe(true);
  expect(result.trivialityOptOuts).toEqual([{ id: "tags.coin", reason }]);
  expect(result.assertionResults).toContainEqual(expect.objectContaining({
    details: expect.objectContaining({ trivialityOptOut: true }),
    id: "tags.coin",
  }));
});

test("a scenario with only waived triviality assertions fails closed", () => {
  const reason = "The initial corpse state is deliberately held only while this scenario proves nothing else.";
  const currentScenario = scenario({
    components: [{ allowTrivial: reason, component: "health", entity: "player", equals: 3 }],
  });
  const snapshot: IPlaytestObservationSnapshot = {
    clock: { mode: "fixed-step", tick: 0 },
    components: { player: { health: 3 } },
    entities: [],
    resources: {},
  };

  const result = buildReport(CONFIG, currentScenario, snapshot, snapshot, [], []);

  expect(result.pass).toBe(false);
  expect(result.trivialityOptOuts).toEqual([{ id: "component.player.health.value", reason }]);
  expect(result.diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_SCENARIO_ASSERTS_NOTHING");
  expect(exitCodeForReport(result)).toBe(1);
});

test("standalone reports retain framebuffer coverage observations", () => {
  expect(STANDALONE_PLAYTEST_OBSERVATION_FIELDS).toContain("framebufferCoverage");
});

test("every registered assertion kind names an observation some runner produces", () => {
  // A kind registered with an observation path no runner lists fails every scenario with
  // 'The standalone runner does not produce an X observation' — which is how the startup kind
  // shipped: evaluator, schema and docs green, the runner unable to run it.
  const produced = new Set<string>([
    ...STANDALONE_PLAYTEST_OBSERVATION_FIELDS,
    ...HOST_PLAYTEST_OBSERVATION_FIELDS,
  ]);
  const orphans = PLAYTEST_ASSERTION_REGISTRY.filter(
    (entry) => !produced.has(entry.observationPath),
  ).map((entry) => `${entry.kind} -> ${entry.observationPath}`);
  // Three kinds predate this guard and are not produced by either runner today; they are pinned
  // here as known debt so that a fourth cannot join them unnoticed.
  expect(orphans).toEqual([
    "reachability -> entityTransforms",
    "overlayNodes -> overlayNodes",
    "occluded -> effectLog",
  ]);
});

test("framebuffer coverage passes only after observing readable matching frames in the complete window", () => {
  const currentScenario = scenario({
    framebufferCoverage: {
      backdrop: [5, 7, 11],
      tolerance: 8,
      window: { endStep: "loading", startStep: "loading" },
    },
  });
  const result = buildReport(
    CONFIG,
    currentScenario,
    undefined,
    undefined,
    [],
    [],
    undefined,
    {},
    true,
    undefined,
    [],
    {
      boundarySource: "scenario-steps",
      frameCount: 3,
      windowCompleted: true,
      windowStarted: true,
    },
  );

  expect(result.assertionResults).toContainEqual(expect.objectContaining({
    id: "framebufferCoverage",
    pass: true,
  }));
  expect(result.pass).toBe(true);
});

test.each([
  [
    "zero frames",
    { boundarySource: "scenario-steps" as const, frameCount: 0, windowCompleted: true, windowStarted: true },
    "TN_PLAYTEST_FRAMEBUFFER_FRAMES_MISSING",
  ],
  [
    "unreadable pixels",
    { boundarySource: "scenario-steps" as const, frameCount: 1, unreadableReason: "SecurityError", windowCompleted: true, windowStarted: true },
    "TN_PLAYTEST_FRAMEBUFFER_PIXELS_UNREADABLE",
  ],
  [
    "a violating frame",
    {
      boundarySource: "scenario-steps" as const,
      firstViolation: {
        frameIndex: 0,
        grid: { columns: 1, rows: 1, samples: [[255, 255, 255] as [number, number, number]] },
        screenshotPath: "artifacts/framebuffer-coverage-frame-0.png",
      },
      frameCount: 1,
      windowCompleted: true,
      windowStarted: true,
    },
    "TN_PLAYTEST_FRAMEBUFFER_COVERAGE_FAILED",
  ],
])("framebuffer coverage fails closed for %s", (_label, observation, diagnosticCode) => {
  const currentScenario = scenario({
    framebufferCoverage: {
      backdrop: [5, 7, 11],
      tolerance: 8,
      window: { endStep: "loading", startStep: "loading" },
    },
  });
  const result = buildReport(
    CONFIG,
    currentScenario,
    undefined,
    undefined,
    [],
    [],
    undefined,
    {},
    true,
    undefined,
    [],
    observation,
  );

  expect(result.assertionResults).toContainEqual(expect.objectContaining({
    id: "framebufferCoverage",
    pass: false,
  }));
  expect(result.diagnostics.map(({ code }) => code)).toContain(diagnosticCode);
  expect(result.pass).toBe(false);
});

test("a framebuffer window that was never reached maps to exit code 2", () => {
  const currentScenario = scenario({
    framebufferCoverage: {
      backdrop: [5, 7, 11],
      tolerance: 8,
      window: { endStep: "loading", startStep: "loading" },
    },
  });
  const result = buildReport(CONFIG, currentScenario, undefined, undefined, [], []);

  expect(result.diagnostics.map(({ code }) => code)).toContain(
    "TN_PLAYTEST_FRAMEBUFFER_WINDOW_NOT_REACHED",
  );
  expect(exitCodeForReport(result)).toBe(2);
});

test("visibility can prove a streamed entity is absent or present", () => {
  const currentScenario = scenario({
    visibility: [
      { entity: "chunk.0", present: false },
      { entity: "chunk.7", minProjectedPixels: 1, present: true },
    ],
  });
  const beforeSnapshot: IPlaytestObservationSnapshot = {
    clock: { mode: "fixed-step", tick: 0 },
    entities: [{ id: "chunk.0", visible: true }],
  };
  const afterSnapshot: IPlaytestObservationSnapshot = {
    clock: { mode: "fixed-step", tick: 1 },
    entities: [{ bounds: { height: 100, width: 100, x: 100, y: 100 }, id: "chunk.7", visible: true }],
  };

  const result = buildReport(CONFIG, currentScenario, beforeSnapshot, afterSnapshot, [], []);

  expect(result.assertionResults).toContainEqual(expect.objectContaining({ id: "visibility.chunk.0", pass: true }));
  expect(result.assertionResults).toContainEqual(expect.objectContaining({ id: "visibility.chunk.7", pass: true }));
  expect(result.pass).toBe(true);
});

test("visibility presence fails when an unloaded entity remains registered", () => {
  const currentScenario = scenario({ visibility: [{ entity: "chunk.0", present: false }] });
  const snapshot: IPlaytestObservationSnapshot = {
    clock: { mode: "fixed-step", tick: 1 },
    entities: [{ id: "chunk.0", visible: false }],
  };

  const result = buildReport(CONFIG, currentScenario, snapshot, snapshot, [], []);

  expect(result.assertionResults).toContainEqual(expect.objectContaining({ id: "visibility.chunk.0", pass: false }));
  expect(result.diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_VISIBILITY_FAILED");
  expect(result.pass).toBe(false);
});

test("visibility evaluates projected pixels when present is also asserted", () => {
  const currentScenario = scenario({
    visibility: [{ entity: "chunk.7", minProjectedPixels: 1_000_000_000, present: true }],
  });
  const snapshot: IPlaytestObservationSnapshot = {
    clock: { mode: "fixed-step", tick: 1 },
    entities: [{ bounds: { height: 100, width: 100, x: 100, y: 100 }, id: "chunk.7", visible: true }],
  };

  const result = buildReport(CONFIG, currentScenario, snapshot, snapshot, [], []);

  expect(result.assertionResults).toContainEqual(expect.objectContaining({
    id: "visibility.chunk.7",
    pass: false,
  }));
  expect(result.pass).toBe(false);
});

test("rotationChanged falls back to before/after bridge quaternions", () => {
  const currentScenario = scenario({ movement: { entity: "player", rotationChanged: true } });
  const snapshot = (rotation: [number, number, number, number]): IPlaytestObservationSnapshot => ({
    clock: { mode: "fixed-step", tick: 1 },
    entities: [{ id: "player", transform: { position: [0, 0, 0], rotation } }],
    resources: {},
  });

  const result = buildReport(
    CONFIG,
    currentScenario,
    snapshot([0, 0, 0, 1]),
    snapshot([0, 0.3826834, 0, 0.9238795]),
    [],
    [],
  );

  expect(result.assertionResults).toContainEqual(expect.objectContaining({ id: "movement.rotation", pass: true }));
  expect(result.pass).toBe(true);
});

test("movement assertions can baseline a subject that appears after a scene transition", () => {
  const currentScenario: IPlaytestScenario = {
    ...scenario({ movement: { entity: "player", minAxisDelta: { axis: "-z", min: 0.5 } } }),
    subject: "player",
  };
  const menuSnapshot: IPlaytestObservationSnapshot = {
    clock: { mode: "fixed-step", tick: 20 },
    entities: [{ id: "camera.main" }],
    resources: { state: { screen: "menu" } },
  };
  const gameplaySnapshot: IPlaytestObservationSnapshot = {
    clock: { mode: "fixed-step", tick: 40 },
    entities: [{ id: "player", transform: { position: [0, 0, 0] } }],
    resources: { state: { screen: "playing" } },
  };
  const afterSnapshot: IPlaytestObservationSnapshot = {
    clock: { mode: "fixed-step", tick: 60 },
    entities: [{ id: "player", transform: { position: [0, 0, -1] } }],
    resources: { state: { screen: "playing" } },
  };

  const result = buildReport(
    CONFIG,
    currentScenario,
    menuSnapshot,
    afterSnapshot,
    [],
    [],
    undefined,
    {},
    true,
    undefined,
    [],
    undefined,
    undefined,
    undefined,
    [],
    undefined,
    undefined,
    gameplaySnapshot,
  );

  expect(result.movementDelta).toEqual([0, 0, -1]);
  expect(result.assertionResults).toContainEqual(expect.objectContaining({ id: "movement.axisDelta", pass: true }));
  expect(result.observations?.resources).toEqual({ state: { before: { screen: "menu" }, after: { screen: "playing" } } });
  expect(result.pass).toBe(true);
});

test("anonymous movement rejects concurrent autonomous motion", () => {
  const currentScenario = {
    ...scenario({ movement: { minDistance: 1 } }),
    steps: [
      { kind: "wait" as const, release: true, waitTicks: 1 },
      { kind: "input" as const, press: "ArrowRight", release: true, holdTicks: 1 },
      { kind: "wait" as const, release: true, waitTicks: 1 },
    ],
  };
  const snapshot = (
    tick: number,
    autonomousHeight: number,
    controlledX: number,
  ): IPlaytestObservationSnapshot => ({
    clock: { mode: "fixed-step", tick },
    entities: [
      { id: "autonomous", transform: { position: [0, autonomousHeight, 0] }, visible: true },
      { id: "controlled", transform: { position: [controlledX, 0, 0] }, visible: true },
    ],
  });
  const beforeSnapshot = snapshot(0, 0, 0);
  const inputBefore = snapshot(1, 3, 0);
  const inputAfter = snapshot(2, 7, 2);
  const afterSnapshot = snapshot(3, 11, 2);

  const result = buildReport(
    CONFIG,
    currentScenario,
    beforeSnapshot,
    afterSnapshot,
    [],
    [],
    undefined,
    {},
    true,
    undefined,
    [],
    undefined,
    undefined,
    undefined,
    [
      { after: inputBefore, before: beforeSnapshot, inputDriven: false },
      { after: inputAfter, before: inputBefore, inputDriven: true },
      { after: afterSnapshot, before: inputAfter, inputDriven: false },
    ],
  );

  expect(result.entity).toBe("controlled");
  expect(result.assertionResults).toContainEqual(expect.objectContaining({
    details: expect.objectContaining({ entity: "controlled", distance: 2 }),
    id: "movement.distance",
    pass: true,
  }));
  expect(result.pass).toBe(true);
});

test("anonymous movement rejects faster autonomous motion", () => {
  const currentScenario = {
    ...scenario({ movement: { minDistance: 1 } }),
    steps: [
      { kind: "wait" as const, release: true, waitTicks: 1 },
      { kind: "input" as const, press: "ArrowRight", release: true, waitTicks: 1 },
      { kind: "wait" as const, release: true, waitTicks: 1 },
    ],
  };
  const snapshot = (tick: number, x: number): IPlaytestObservationSnapshot => ({
    clock: { mode: "fixed-step", tick },
    entities: [{ id: "autonomous", transform: { position: [x, 0, 0] }, visible: true }],
  });
  const result = buildReport(
    CONFIG,
    currentScenario,
    snapshot(0, 0),
    snapshot(3, 4),
    [],
    [],
    undefined,
    {},
    true,
    undefined,
    [],
    undefined,
    undefined,
    undefined,
    [
      { after: snapshot(1, 1), before: snapshot(0, 0), inputDriven: false },
      { after: snapshot(2, 3), before: snapshot(1, 1), inputDriven: true },
      { after: snapshot(3, 4), before: snapshot(2, 3), inputDriven: false },
    ],
  );

  expect(result.entity).toBe("");
  expect(result.assertionResults).toContainEqual(expect.objectContaining({ id: "movement.distance", pass: false }));
  expect(result.pass).toBe(false);
});

test("buttonless pointer movement drives the browser step", () => {
  expect(playtestStepDrivesMovement({
    pointerPosition: { x: 0.5, y: 0.5 },
    release: true,
    waitFrames: 1,
  }, false)).toBe(true);
  expect(playtestStepDrivesMovement({ release: true, waitFrames: 1 }, false)).toBe(false);
});

test("buttonless pointer movement drives anonymous movement through the browser runner", async () => {
  const fixtureHtml = `<!doctype html>
    <html>
      <body>
        <canvas id="view" width="640" height="360"></canvas>
        <script>
          let pointerSeen = false;
          let sampleCount = 0;
          addEventListener("pointermove", () => {
            if (!pointerSeen) console.log("pointermove-observed");
            pointerSeen = true;
          });
          globalThis.__THREENATIVE_PLAYTEST_BRIDGE__ = {
            describe: () => ({
              capabilities: ["entity.observe"],
              limits: {
                maxEntitiesPerSample: 100,
                maxEventsPerDrain: 1000,
                maxPayloadBytes: 1000000,
                operationTimeoutMs: 5000,
              },
              name: "runner-pointer-fixture",
              protocolVersion: 1,
            }),
            ready: () => ({ ready: true }),
            sample: () => {
              sampleCount += 1;
              // Samples 1 and 2 bracket the input-off baseline; sample 3 follows pointerPosition.
              const pointerMovement = sampleCount >= 3 && pointerSeen;
              return {
                clock: { mode: "render-frame", timeMs: sampleCount * 16 },
                entities: [{
                  id: "pointer-driven",
                  transform: { position: [pointerMovement ? 1 : 0, 0, 0] },
                  visible: true,
                }],
                resources: {},
              };
            },
          };
        </script>
      </body>
    </html>`;
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(fixtureHtml);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Pointer fixture has no port.");
  const projectPath = await makeTempDir("playtest-runner-pointer-");
  await writeFile(
    join(projectPath, "scenario.json"),
    JSON.stringify({
      artifacts: { screenshots: false },
      assert: { movement: { minDistance: 0.5 } },
      name: "runner-pointer",
      schemaVersion: 1,
      steps: [
        { kind: "wait", release: true, waitFrames: 1 },
        { kind: "input", pointerPosition: { x: 0.5, y: 0.5 }, release: true, waitFrames: 1 },
        { kind: "wait", release: true, waitFrames: 1 },
      ],
      target: "web",
      viewport: { height: 360, width: 640 },
      warmupFrames: 0,
    }),
  );

  try {
    const report = await runStandalonePlaytest({
      artifactDirectory: join(projectPath, "artifacts"),
      headless: true,
      projectPath,
      scenarioPath: "scenario.json",
      timeoutMs: 15_000,
      trace: false,
      url: `http://127.0.0.1:${address.port}`,
    });

    expect(report.pass).toBe(true);
    expect(report.entity).toBe("pointer-driven");
    expect(report.distance).toBe(1);
    expect(report.observations?.console.map(({ text }) => text)).toContain("pointermove-observed");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }
}, 60_000);

test.each([undefined, 10])("browser runner samples after startup and optional startTick %s", async (startTick) => {
  const fixtureHtml = await readFile(new URL("./fixtures/app.html", import.meta.url), "utf8");
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(fixtureHtml);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Startup fixture has no port.");
  const projectPath = await makeTempDir("playtest-runner-startup-");
  await writeFile(
    join(projectPath, "scenario.json"),
    JSON.stringify({
      artifacts: { screenshots: false },
      assert: { movement: { entity: "player", minDistance: 0.2 } },
      ...(startTick === undefined ? {} : { startTick }),
      name: "runner-startup",
      schemaVersion: 1,
      steps: [{ holdFrames: 10, press: "KeyW", release: true }],
      subject: "player",
      target: "web",
      viewport: { height: 360, width: 640 },
      warmupFrames: 0,
    }),
  );

  try {
    const report = await runStandalonePlaytest({
      artifactDirectory: join(projectPath, "artifacts"),
      headless: true,
      projectPath,
      scenarioPath: "scenario.json",
      timeoutMs: 15_000,
      trace: false,
      url: `http://127.0.0.1:${address.port}/?mode=startup-delayed${startTick === undefined ? "" : "&clock=fixed-step"}`,
    });

    expect(report.pass, JSON.stringify(report.diagnostics)).toBe(true);
    if (startTick !== undefined) {
      expect(report.before?.tick).toBe(startTick);
      expect(report.after?.tick).toBe(startTick + 10);
    }
    expect(report.frames).toBe(10);
    expect(report.startup).toMatchObject({ phase: "ready", rule: "sustained-frames" });
    expect(report.observations?.resources.startup).toEqual({
      before: { sampledBeforeReady: false },
      after: { sampledBeforeReady: false },
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error === undefined ? resolve() : reject(error)),
    );
  }
}, 60_000);

test("browser runner waits on an asynchronously changing resource", async () => {
  const fixtureHtml = await readFile(new URL("./fixtures/app.html", import.meta.url), "utf8");
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(fixtureHtml);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Resource fixture has no port.");
  const projectPath = await makeTempDir("playtest-runner-resource-");
  await writeFile(join(projectPath, "scenario.json"), JSON.stringify({
    artifacts: { screenshots: false },
    assert: { resources: [{ changed: true, equals: true, id: "state", path: "networkConnected" }] },
    name: "runner-resource-wait",
    schemaVersion: 1,
    steps: [{ timeoutMs: 1_000, waitForResource: { equals: true, id: "state", path: "networkConnected" } }],
    target: "web",
    viewport: { height: 360, width: 640 },
    warmupFrames: 0,
  }));

  try {
    const report = await runStandalonePlaytest({
      artifactDirectory: join(projectPath, "artifacts"),
      headless: true,
      projectPath,
      scenarioPath: "scenario.json",
      timeoutMs: 15_000,
      trace: false,
      url: `http://127.0.0.1:${address.port}/?mode=wait-resource`,
    });

    expect(report.pass).toBe(true);
    expect(report.assertionResults).toContainEqual(expect.objectContaining({ id: "resource.state.networkConnected", pass: true }));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }
}, 60_000);

test("browser runner times out a resource wait with the last observation", async () => {
  const fixtureHtml = await readFile(new URL("./fixtures/app.html", import.meta.url), "utf8");
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(fixtureHtml);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Resource timeout fixture has no port.");
  const projectPath = await makeTempDir("playtest-runner-resource-timeout-");
  await writeFile(join(projectPath, "scenario.json"), JSON.stringify({
    artifacts: { screenshots: false },
    assert: { resources: [{ equals: true, id: "state", path: "networkConnected" }] },
    name: "runner-resource-timeout",
    schemaVersion: 1,
    steps: [{ timeoutMs: 32, waitForResource: { equals: true, id: "state", path: "networkConnected" } }],
    target: "web",
    viewport: { height: 360, width: 640 },
    warmupFrames: 0,
  }));

  try {
    const report = await runStandalonePlaytest({
      artifactDirectory: join(projectPath, "artifacts"),
      headless: true,
      projectPath,
      scenarioPath: "scenario.json",
      timeoutMs: 15_000,
      trace: false,
      url: `http://127.0.0.1:${address.port}/?mode=wait-resource-timeout`,
    });

    expect(report.pass).toBe(false);
    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      code: "TN_PLAYTEST_OBSERVATION_UNAVAILABLE",
      message: expect.stringContaining("last observation false"),
    }));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }
}, 60_000);

test("served fixture reports the production protocol limits and valid capabilities", async () => {
  const fixtureHtml = await readFile(new URL("./fixtures/app.html", import.meta.url), "utf8");
  const server = createServer((request, response) => {
    if (request.url === "/@vite/client") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end("/* acquisition fixture */");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`${fixtureHtml}<script src="/@vite/client"></script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Contract fixture has no port.");
  const projectPath = await makeTempDir("playtest-runner-contract-");
  await writeFile(
    join(projectPath, "scenario.json"),
    JSON.stringify({
      artifacts: { screenshots: false },
      assert: {
        resources: [
          {
            changed: true,
            gte: 2,
            id: "fixtureRun",
            path: "sampleCount",
          },
          {
            allowTrivial: "The bridge contract is a held protocol invariant verified by this served fixture.",
            equals: PLAYTEST_PROTOCOL_LIMITS,
            id: "bridgeContract",
            path: "limits",
          },
          {
            allowTrivial: "The bridge capabilities are a held protocol invariant verified by this served fixture.",
            equals: ["camera.observe", "entity.bounds", "entity.observe", "entity.setup", "runtime.resources"],
            id: "bridgeContract",
            path: "capabilities",
          },
        ],
      },
      name: "runner-contract",
      schemaVersion: 1,
      steps: [{ release: true, waitFrames: 1 }],
      target: "web",
      viewport: { height: 360, width: 640 },
      warmupFrames: 0,
    }),
  );

  try {
    const report = await runStandalonePlaytest({
      artifactDirectory: join(projectPath, "artifacts"),
      headless: true,
      projectPath,
      scenarioPath: "scenario.json",
      timeoutMs: 15_000,
      trace: false,
      url: `http://127.0.0.1:${address.port}`,
    });
    expect(report.pass).toBe(true);
    expect(report.acquisition?.requestUrls).toContain(`http://127.0.0.1:${address.port}/`);
    expect(report.acquisition?.requestUrls).toContain(`http://127.0.0.1:${address.port}/@vite/client`);
    expect(new Set(report.acquisition?.requestUrls).size).toBe(report.acquisition?.requestUrls.length);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error === undefined ? resolve() : reject(error)),
    );
  }
}, 60_000);

test("a served fixture that stays in collapsing startup fails with the named readiness diagnostic", async () => {
  const fixtureHtml = await readFile(new URL("./fixtures/app.html", import.meta.url), "utf8");
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(fixtureHtml);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Stuck fixture has no port.");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const currentScenario = {
    artifacts: { screenshots: "after" as const },
    name: "runner-startup-stuck",
    schemaVersion: 1 as const,
    steps: [{ release: true, waitFrames: 1 }],
    target: "web" as const,
    viewport: { height: 360, width: 640 },
    warmupFrames: 0,
  };

  try {
    const bridge = await openPageAndConnectBridge(
      page,
      { ...CONFIG, timeoutMs: 5_000, url: `http://127.0.0.1:${address.port}/?mode=startup-stuck` },
      currentScenario,
    );
    if (bridge === undefined) throw new Error("Expected the stuck fixture bridge.");
    let clock = 0;
    await expect(waitForStartupReady({
      bridge,
      now: () => {
        clock += 101;
        return clock;
      },
      pump: async () => {
        await page.evaluate(() => undefined);
      },
      timeoutMs: 100,
    })).rejects.toMatchObject({ diagnostic: { code: "TN_PLAYTEST_STARTUP_NOT_READY" } });
  } finally {
    await page.close();
    await browser.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error === undefined ? resolve() : reject(error)),
    );
  }
}, 60_000);

test("anonymous movement rejects constant-speed autonomous render-frame motion", () => {
  const currentScenario = {
    ...scenario({ movement: { minDistance: 1 } }),
    steps: [
      { kind: "wait" as const, release: true, waitFrames: 1 },
      { kind: "input" as const, press: "ArrowRight", release: true, holdFrames: 5 },
      { kind: "wait" as const, release: true, waitFrames: 1 },
    ],
  };
  const snapshot = (timeMs: number, autonomousX: number): IPlaytestObservationSnapshot => ({
    clock: { mode: "render-frame", timeMs },
    entities: [{ id: "autonomous", transform: { position: [autonomousX, 0, 0] }, visible: true }],
  });
  const beforeSnapshot = snapshot(0, 0);
  const inputBefore = snapshot(16, 16);
  const inputAfter = snapshot(96, 96);
  const afterSnapshot = snapshot(112, 112);

  const result = buildReport(
    CONFIG,
    currentScenario,
    beforeSnapshot,
    afterSnapshot,
    [],
    [],
    undefined,
    {},
    true,
    undefined,
    [],
    undefined,
    undefined,
    undefined,
    [
      { after: inputBefore, before: beforeSnapshot, inputDriven: false },
      { after: inputAfter, before: inputBefore, inputDriven: true },
      { after: afterSnapshot, before: inputAfter, inputDriven: false },
    ],
  );

  expect(result.entity).toBe("");
  expect(result.distance).toBe(0);
  expect(result.assertionResults).toContainEqual(expect.objectContaining({
    id: "movement.distance",
    pass: false,
  }));
  expect(result.pass).toBe(false);
});

test("anonymous movement passes an input-sensitive render-frame candidate and fails without contrast", () => {
  const currentScenario = {
    ...scenario({ movement: { minDistance: 1 } }),
    steps: [
      { kind: "wait" as const, release: true, waitFrames: 1 },
      { kind: "input" as const, press: "ArrowRight", release: true, holdFrames: 5 },
      { kind: "wait" as const, release: true, waitFrames: 1 },
    ],
  };
  const snapshot = (timeMs: number, x: number): IPlaytestObservationSnapshot => ({
    clock: { mode: "render-frame", timeMs },
    entities: [{ id: "controlled", transform: { position: [x, 0, 0] }, visible: true }],
  });
  const beforeSnapshot = snapshot(0, 0);
  const inputBefore = snapshot(16, 0);
  const inputAfter = snapshot(96, 80);
  const afterSnapshot = snapshot(112, 80);

  const withContrast = buildReport(
    CONFIG,
    currentScenario,
    beforeSnapshot,
    afterSnapshot,
    [],
    [],
    undefined,
    {},
    true,
    undefined,
    [],
    undefined,
    undefined,
    undefined,
    [
      { after: inputBefore, before: beforeSnapshot, inputDriven: false },
      { after: inputAfter, before: inputBefore, inputDriven: true },
      { after: afterSnapshot, before: inputAfter, inputDriven: false },
    ],
  );

  expect(withContrast.pass).toBe(true);
  expect(withContrast.entity).toBe("controlled");

  const withoutContrast = buildReport(
    CONFIG,
    currentScenario,
    beforeSnapshot,
    afterSnapshot,
    [],
    [],
    undefined,
    {},
    true,
    undefined,
    [],
    undefined,
    undefined,
    undefined,
    [{ after: inputAfter, before: inputBefore, inputDriven: true }],
  );

  expect(withoutContrast.distance).toBe(0);
  expect(withoutContrast.assertionResults).toContainEqual(expect.objectContaining({
    id: "movement.distance",
    pass: false,
  }));
  expect(withoutContrast.pass).toBe(false);
});

test("a missing HUD id fails changed:false instead of passing on absent values", () => {
  const result = report(scenario({ hud: [{ id: "missing", changed: false }] }));

  expect(result.pass).toBe(false);
  expect(result.assertionResults).toContainEqual(expect.objectContaining({ id: "hud.missing", pass: false }));
  expect(result.diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_HUD_ASSERTION_FAILED");
});

test("an empty assertion set remains a failed report", () => {
  const result = report(scenario(undefined));

  expect(result.pass).toBe(false);
  expect(result.assertionResults).toContainEqual({
    details: { reason: "no-evaluated-assertions" },
    id: "scenario.assertions",
    pass: false,
  });
  expect(result.diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_SCENARIO_NO_ASSERTIONS");
});

test("the evaluator fails an empty assertion set before exitCodeForReport can read it as a pass", () => {
  // The evaluator appends a failing scenario.assertions result. The exit code is therefore never 0.
  expect(exitCodeForReport(report(scenario(undefined)))).not.toBe(0);
});

test("the legacy TypeScript scenario is rejected by the JSON loader", async () => {
  const directory = await makeTempDir("playtest-legacy-scenario-");
  await writeFile(join(directory, "play.playtest.ts"), "export const playScenario = {};\n");

  await expect(loadPlaytestScenario(directory, "play.playtest.ts")).rejects.toMatchObject({
    diagnostic: { code: "TN_PLAYTEST_SCENARIO_INVALID" },
  });
});

test("a browser pageerror fails noConsoleErrors", () => {
  const result = report(
    scenario({ diagnostics: { noConsoleErrors: true } }),
    {},
    { consoleEntries: [{ text: "boom", type: "pageerror" }] },
  );

  expect(result.pass).toBe(false);
  expect(result.diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_CONSOLE_ERROR");
});

test("a browser pageerror is also a real runtime diagnostic", () => {
  const result = report(
    scenario({
      diagnostics: {
        noConsoleErrors: false,
        consoleErrorsOptOutReason: "This unit test isolates page errors from the console policy.",
        noRuntimeDiagnostics: true,
      },
    }),
    {},
    { consoleEntries: [{ text: "boom", type: "pageerror" }] },
  );

  expect(result.pass).toBe(false);
  expect(result.diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_RUNTIME_DIAGNOSTIC");
});

test("runtimeReady fails when the page never exposes a canvas", () => {
  const result = report(
    scenario({ diagnostics: { runtimeReady: true } }),
    {},
    { runtimeReady: false },
  );

  expect(result.pass).toBe(false);
  expect(result.diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_RUNTIME_NOT_READY");
  expect(result.diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_RUNTIME_DIAGNOSTIC");
});

test("legacy frame aliases stay separate from canonical tick helpers", () => {
  expect(playtestStepHoldTicks({ holdFrames: 5, press: "KeyW", release: true }, 0)).toBe(0);
  expect(playtestStepWaitTicks({ release: true, waitFrames: 5 })).toBe(0);
  expect(playtestStepHoldTicks({ holdTicks: 5, press: "KeyW", release: true }, 0)).toBe(5);
  expect(playtestStepWaitTicks({ release: true, waitTicks: 5 })).toBe(5);
});

test("an authored hold counts for a pointer step, not only a key press", () => {
  // A touch stick anchors on one step and moves on the next. When holdTicks was read only for
  // `press` steps, every pointer step discarded its hold, advanced one live frame, and the car
  // read a machine-dependent few ticks of throttle — the racing touch-controls flake.
  expect(
    playtestStepHoldTicks({ holdTicks: 45, pointers: [{ id: 1, x: 0.2, y: 0.5 }], release: true }, 0),
  ).toBe(45);
  // A pointer step with no authored hold is still not a hold step.
  expect(
    playtestStepHoldTicks({ pointers: [{ id: 1, x: 0.2, y: 0.5 }], release: true } as never, 0),
  ).toBe(0);
});

test("runner carries performance samples in their separate report channel", () => {
  const currentScenario = scenario({ performance: { maxFrameMsP95: 20 } });
  const snapshot: IPlaytestObservationSnapshot = {
    clock: { mode: "render-frame", timeMs: 32 },
    runtimeDiagnosticsSeries: [
      { frameMs: 16, drawCalls: 2, triangles: 12 },
      { frameMs: 18, drawCalls: 3, triangles: 20 },
    ],
  };

  const result = buildReport(CONFIG, currentScenario, snapshot, snapshot, [], []);

  expect(result.observations?.performanceSeries).toEqual(snapshot.runtimeDiagnosticsSeries);
  expect(result.assertionResults).toContainEqual(expect.objectContaining({ id: "performance.maxFrameMsP95", pass: true }));
  expect(result.pass).toBe(true);
});

test("runner carries performance samples for parity-only scenarios", () => {
  const currentScenario = scenario({
    parity: {
      minFpsRatio: 0.85,
      reference: { fps: 60, serial: "pixel-8", thermallyConfounded: false },
      referenceReport: "reports/native.json",
      referenceSide: "native",
    },
  });
  const snapshot: IPlaytestObservationSnapshot = {
    clock: { mode: "render-frame", timeMs: 32 },
    runtimeDiagnosticsSeries: [
      { frameMs: 16, drawCalls: 2, triangles: 12 },
      { frameMs: 18, drawCalls: 3, triangles: 20 },
    ],
  };

  const result = buildReport(CONFIG, currentScenario, snapshot, snapshot, [], []);

  expect(result.observations?.performanceSeries).toEqual(snapshot.runtimeDiagnosticsSeries);
  expect(result.assertionResults).toContainEqual(
    expect.objectContaining({ id: "parity.fpsRatio", pass: true }),
  );
});

test("runner keeps performance samples out of visual throughout-frame observations", () => {
  const currentScenario = scenario({
    performance: { maxFrameMsP95: 20 },
    visual: [{ entityVisible: { entity: "player", minProjectedPixels: 1, throughoutFrames: true } }],
  });
  const snapshot: IPlaytestObservationSnapshot = {
    clock: { mode: "render-frame", timeMs: 32 },
    runtimeDiagnosticsSeries: [{ frameMs: 16, drawCalls: 2, triangles: 12 }],
  };
  const visualSeries = [{
    scene: {
      renderedEntities: [{ id: "player", projectedBounds: { max: [0.5, 0.5], min: [-0.5, -0.5] } }],
    },
  }];

  const result = buildReport(CONFIG, currentScenario, snapshot, snapshot, [], [], undefined, {}, true, {
    runtimeDiagnosticsSeries: visualSeries,
  });

  expect(result.observations?.performanceSeries).toEqual(snapshot.runtimeDiagnosticsSeries);
  expect(result.observations?.visual?.runtimeDiagnosticsSeries).toEqual(visualSeries);
  expect(result.assertionResults).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "performance.maxFrameMsP95", pass: true }),
    expect.objectContaining({ id: "visual.0.entityVisible", pass: true }),
  ]));
  expect(result.pass).toBe(true);
});

test("runner does not reinterpret the shared series for visual-only scenarios", () => {
  const currentScenario = scenario({ visual: [{ entityVisible: { entity: "player", minProjectedPixels: 1 } }] });
  const snapshot: IPlaytestObservationSnapshot = {
    clock: { mode: "render-frame", timeMs: 32 },
    runtimeDiagnosticsSeries: [{ frameMs: 16, drawCalls: 2, triangles: 12 }],
  };

  const result = buildReport(CONFIG, currentScenario, snapshot, snapshot, [], []);

  expect(result.observations?.visual?.runtimeDiagnosticsSeries).toBeUndefined();
});

test("runner derives semantic series from labeled snapshots and the exported field list", () => {
  const currentScenario: IPlaytestScenario = {
    assert: {
      components: [{ atSteps: [{ equals: 2, label: "last" }], changed: true, component: "health", entity: "player", gte: 2 }],
      resources: [{ atSteps: [{ equals: 1, label: "first" }, { equals: 3, label: "last" }], id: "GameState", path: "coins", equals: 3 }],
      signals: [{ entity: "player", minCount: 2, name: "collected" }],
    },
    name: "semantic-series",
    schemaVersion: 1,
    steps: [
      { label: "first", release: true, waitFrames: 1 },
      { label: "last", release: true, waitFrames: 1 },
    ],
    target: "web",
    viewport: { height: 720, width: 1280 },
    warmupFrames: 0,
  };
  const snapshot = (coins: number, health: number, tick: number): IPlaytestObservationSnapshot => ({
    clock: { mode: "fixed-step", tick },
    components: { player: { health } },
    entities: [],
    resources: { GameState: { coins } },
  });

  const result = buildReport(
    CONFIG,
    currentScenario,
    snapshot(0, 1, 0),
    snapshot(3, 2, 2),
    [],
    [],
    undefined,
    {},
    true,
    undefined,
    [
      { label: "first", signals: [{ entity: "player", name: "collected" }], snapshot: snapshot(1, 3, 1) },
      { label: "last", signals: [{ entity: "player", name: "collected" }], snapshot: snapshot(3, 2, 2) },
    ],
  );

  expect(STANDALONE_PLAYTEST_OBSERVATION_FIELDS).toContain("resourceSeries");
  expect(result.observations?.resourceSeries).toHaveLength(2);
  expect(result.observations?.componentSeries?.[1]?.snapshots.player?.health).toBe(2);
  expect(result.observations?.signals).toHaveLength(2);
  expect(result.pass).toBe(true);
});

test.each([
  { initial: undefined, first: 0, firstTick: 1, final: 2, baseline: 0, pass: true },
  { initial: undefined, first: 2, firstTick: 1, final: 2, baseline: 2, pass: false },
  { initial: undefined, first: 0, firstTick: 2, final: 2, baseline: undefined, pass: false },
  { initial: undefined, first: undefined, firstTick: 1, final: 2, baseline: undefined, pass: false },
  { initial: 2, first: 0, firstTick: 1, final: 2, baseline: 2, pass: false },
  { initial: 0, first: 1, firstTick: 1, final: undefined, baseline: 0, pass: false },
])("runner measures spawned component changes only across two observed times %j", (entry) => {
  const snapshot = (shots: number | undefined, tick: number): IPlaytestObservationSnapshot => ({
    clock: { mode: "fixed-step", tick },
    components: shots === undefined ? {} : { tower: { shots } },
  });
  const result = buildReport(
    CONFIG,
    scenario({ components: [{ entity: "tower", component: "shots", gte: 1, changed: true }] }),
    snapshot(entry.initial, 0), snapshot(entry.final, 2), [], [], undefined, {}, true, undefined,
    [{ label: "placed", signals: [], snapshot: snapshot(entry.first, entry.firstTick) }],
  );
  expect(result.observations?.components?.tower?.shots?.before).toBe(entry.baseline);
  expect(result.pass).toBe(entry.pass);
});

test("runner keeps the pre-scenario baseline for final-value component assertions", () => {
  const snapshot = (present: boolean, tick: number): IPlaytestObservationSnapshot => ({
    clock: { mode: "fixed-step", tick },
    components: present ? { tower: { shots: 2 } } : {},
  });
  const result = buildReport(
    CONFIG, scenario({ components: [{ entity: "tower", component: "shots", gte: 1 }] }),
    snapshot(false, 0), snapshot(true, 2), [], [], undefined, {}, true, undefined,
    [{ label: "placed", signals: [], snapshot: snapshot(true, 1) }],
  );
  expect(result.observations?.components?.tower?.shots?.before).toBeUndefined();
  expect(result.pass).toBe(true);
});

test("runner preserves physics debug series for contact and settled assertions", () => {
  const currentScenario = scenario({
    contacts: [{ atStep: "contact", entity: "player", kind: "contact", minCount: 1, with: "solid-body" }],
    settled: [{
      atStep: "settled",
      compareToStep: "drop",
      entity: "crate",
      minBodies: 2,
      minMeanPoseDistance: 0.05,
    }],
  });
  const debugSnapshot = (offset: number, includeContact: boolean): JsonValue => ({
    artifact: {
      primitives: [
        ...(includeContact ? [{ category: "contact", id: "player:solid-body" }] : []),
        { category: "sleep", entity: "crate.0", value: 1 },
        { category: "sleep", entity: "crate.1", value: 1 },
        { category: "center-of-mass", entity: "crate.0", position: [offset, 0, 0] },
        { category: "center-of-mass", entity: "crate.1", position: [offset, 1, 0] },
      ],
    },
  });
  const physicsDebugSeries = [
    { label: "drop", snapshot: debugSnapshot(0, false), tick: 1 },
    { label: "contact", snapshot: debugSnapshot(1, true), tick: 2 },
    { label: "settled", snapshot: debugSnapshot(1, false), tick: 3 },
  ];
  const afterSnapshot: IPlaytestObservationSnapshot = {
    clock: { mode: "fixed-step", tick: 3 },
    physicsDebugSeries,
  };

  const result = buildReport(CONFIG, currentScenario, undefined, afterSnapshot, [], []);

  expect(result.observations?.physicsDebugSeries).toEqual(physicsDebugSeries);
  expect(result.assertionResults).toContainEqual(expect.objectContaining({ id: "contact.player", pass: true }));
  expect(result.assertionResults).toContainEqual(expect.objectContaining({ id: "settled.crate", pass: true }));
  expect(result.pass).toBe(true);
});

test("anonymous contact assertions require a retained candidate even for maxCount zero", () => {
  const currentScenario = labeledScenario(
    { contacts: [{ atStep: "contact", maxCount: 0 }] },
    ["contact"],
  );
  const result = buildReport(
    CONFIG,
    currentScenario,
    undefined,
    {
      clock: { mode: "fixed-step", tick: 1 },
      physicsDebugSeries: [{ label: "contact", snapshot: { artifact: { primitives: [] } }, tick: 1 }],
    },
    [],
    [],
  );

  expect(result.assertionResults).toContainEqual(expect.objectContaining({ id: "contact.0", pass: false }));
  expect(result.diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_CONTACT_CANDIDATES_UNAVAILABLE");
  expect(result.pass).toBe(false);
});

test("anonymous settled assertions choose an observed body cohort", () => {
  const currentScenario = labeledScenario(
    { settled: [{ atStep: "settled", compareToStep: "drop", minBodies: 2, minMeanPoseDistance: 0.05 }] },
    ["drop", "settled"],
  );
  const debugSnapshot = (offset: number): JsonValue => ({
    artifact: {
      primitives: [
        { category: "sleep", entity: "crate.0", value: 1 },
        { category: "sleep", entity: "crate.1", value: 1 },
        { category: "center-of-mass", entity: "crate.0", position: [offset, 0, 0] },
        { category: "center-of-mass", entity: "crate.1", position: [offset, 1, 0] },
      ],
    },
  });
  const result = buildReport(
    CONFIG,
    currentScenario,
    undefined,
    {
      clock: { mode: "fixed-step", tick: 2 },
      physicsDebugSeries: [
        { label: "drop", snapshot: debugSnapshot(0), tick: 1 },
        { label: "settled", snapshot: debugSnapshot(1), tick: 2 },
      ],
    },
    [],
    [],
  );

  // Anonymous assertions are identified by their position in the sealed proof, not by the
  // entity the run discovered — otherwise two arms of a paired round emit different ids for the
  // same assertion and nothing can join them.
  expect(result.assertionResults).toContainEqual(expect.objectContaining({ id: "settled.0", pass: true }));
  expect(result.assertionResults).toContainEqual(
    expect.objectContaining({ details: expect.objectContaining({ entity: "crate." }) }),
  );
  expect(result.pass).toBe(true);
});

test("terminal anonymous state passes only after retained contact evidence", () => {
  const currentScenario = labeledScenario(
    {
      contacts: [{ atStep: "goal-contact", minCount: 1 }],
      states: [{ equals: "won" }],
    },
    ["before", "goal-contact", "after"],
  );
  const gameplay = (state: string): IPlaytestObservationSnapshot["gameplay"] => ({
    animation: {},
    states: { avatar: state },
  });
  const snapshot = (state: string, tick: number): IPlaytestObservationSnapshot => ({
    clock: { mode: "fixed-step", tick },
    gameplay: gameplay(state),
  });
  const result = buildReport(
    CONFIG,
    currentScenario,
    undefined,
    {
      ...snapshot("won", 3),
      physicsDebugSeries: [{
        label: "goal-contact",
        snapshot: { artifact: { primitives: [{ category: "contact", id: "solid:destination" }] } },
        tick: 2,
      }],
    },
    [],
    [],
    undefined,
    {},
    true,
    undefined,
    [
      { label: "before", signals: [], snapshot: snapshot("idle", 1) },
      { label: "goal-contact", signals: [], snapshot: snapshot("won", 2) },
      { label: "after", signals: [], snapshot: snapshot("won", 3) },
    ],
  );

  expect(result.assertionResults).toContainEqual(expect.objectContaining({ id: "contact.0", pass: true }));
  // Anonymous assertions are identified by their position in the sealed proof, not by the
  // entity the run discovered — otherwise two arms of a paired round emit different ids for the
  // same assertion and nothing can join them.
  expect(result.assertionResults).toContainEqual(expect.objectContaining({ id: "states.0", pass: true }));
  expect(result.assertionResults).toContainEqual(
    expect.objectContaining({ details: expect.objectContaining({ entity: "avatar" }) }),
  );
  expect(result.pass).toBe(true);
});

test("terminal anonymous state rejects success that predates retained contact", () => {
  const currentScenario = labeledScenario(
    {
      contacts: [{ atStep: "goal-contact", minCount: 1 }],
      states: [{ equals: "won" }],
    },
    ["before", "goal-contact"],
  );
  const gameplay = (state: string): IPlaytestObservationSnapshot["gameplay"] => ({
    animation: {},
    states: { avatar: state },
  });
  const snapshot = (state: string, tick: number): IPlaytestObservationSnapshot => ({
    clock: { mode: "fixed-step", tick },
    gameplay: gameplay(state),
  });
  const result = buildReport(
    CONFIG,
    currentScenario,
    undefined,
    {
      ...snapshot("won", 2),
      physicsDebugSeries: [{
        label: "goal-contact",
        snapshot: { artifact: { primitives: [{ category: "contact", id: "solid:destination" }] } },
        tick: 2,
      }],
    },
    [],
    [],
    undefined,
    {},
    true,
    undefined,
    [
      { label: "before", signals: [], snapshot: snapshot("won", 1) },
      { label: "goal-contact", signals: [], snapshot: snapshot("won", 2) },
    ],
  );

  expect(result.assertionResults).toContainEqual(expect.objectContaining({ id: "states.0", pass: false }));
  expect(result.diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_STATE_ORDERING_FAILED");
  expect(result.pass).toBe(false);
});

test("terminal anonymous state rejects contact-only and success without retained contact", () => {
  const currentScenario = labeledScenario(
    {
      contacts: [{ atStep: "goal-contact", minCount: 1 }],
      states: [{ equals: "won" }],
    },
    ["before", "goal-contact"],
  );
  const gameplay = (state: string): IPlaytestObservationSnapshot["gameplay"] => ({
    animation: {},
    states: { avatar: state },
  });
  const snapshot = (state: string, tick: number): IPlaytestObservationSnapshot => ({
    clock: { mode: "fixed-step", tick },
    gameplay: gameplay(state),
  });
  const run = (state: string, includeContact: boolean) => buildReport(
    CONFIG,
    currentScenario,
    undefined,
    {
      ...snapshot(state, 2),
      physicsDebugSeries: [{
        label: "goal-contact",
        snapshot: { artifact: { primitives: includeContact ? [{ category: "contact", id: "solid:destination" }] : [] } },
        tick: 2,
      }],
    },
    [],
    [],
    undefined,
    {},
    true,
    undefined,
    [
      { label: "before", signals: [], snapshot: snapshot("idle", 1) },
      { label: "goal-contact", signals: [], snapshot: snapshot(state, 2) },
    ],
  );

  expect(run("idle", true).assertionResults?.find(({ id }) => id.startsWith("states."))).toMatchObject({ pass: false });
  expect(run("won", false).assertionResults?.find(({ id }) => id.startsWith("states."))).toMatchObject({ pass: false });
});

test("named final-state assertions remain plain equality checks", () => {
  const currentScenario = {
    ...labeledScenario(
      {
        contacts: [{ atStep: "goal-contact", minCount: 1 }],
        states: [{ entity: "avatar", equals: "won" }],
      },
      ["before", "goal-contact"],
    ),
    subject: "avatar",
  };
  const gameplay = (state: string): IPlaytestObservationSnapshot["gameplay"] => ({
    animation: {},
    states: { avatar: state },
  });
  const snapshot = (state: string, tick: number): IPlaytestObservationSnapshot => ({
    clock: { mode: "fixed-step", tick },
    gameplay: gameplay(state),
  });
  const result = buildReport(
    CONFIG,
    currentScenario,
    undefined,
    {
      ...snapshot("won", 2),
      physicsDebugSeries: [{
        label: "goal-contact",
        snapshot: { artifact: { primitives: [{ category: "contact", id: "avatar:destination" }] } },
        tick: 2,
      }],
    },
    [],
    [],
    undefined,
    {},
    true,
    undefined,
    [
      { label: "before", signals: [], snapshot: snapshot("won", 1) },
      { label: "goal-contact", signals: [], snapshot: snapshot("won", 2) },
    ],
  );

  expect(result.assertionResults).toContainEqual(expect.objectContaining({ id: "states.avatar", pass: true }));
  expect(result.pass).toBe(true);
});

test("settled fails closed when physics evidence reports omitted bodies", () => {
  const currentScenario = scenario({
    settled: [{ atStep: "settled", entity: "crate", minBodies: 1 }],
  });
  const afterSnapshot: IPlaytestObservationSnapshot = {
    clock: { mode: "fixed-step", tick: 1 },
    physicsDebugSeries: [{
      label: "settled",
      snapshot: {
        artifact: {
          overflow: { bodyLimit: 100, omittedBodies: 1, totalBodies: 101 },
          primitives: [{ category: "sleep", entity: "crate.0", value: 1 }],
        },
      },
      tick: 1,
    }],
  };

  const result = buildReport(CONFIG, currentScenario, undefined, afterSnapshot, [], []);

  expect(result.assertionResults).toContainEqual(
    expect.objectContaining({ id: "settled.crate", pass: false }),
  );
  expect(result.diagnostics.map(({ code }) => code)).toContain(
    "TN_PLAYTEST_PHYSICS_EVIDENCE_TRUNCATED",
  );
  expect(result.pass).toBe(false);
});

test("the bridge handshake survives a dev server reloading the page underneath it", async () => {
  const goto = vi.fn(async () => {
    if (goto.mock.calls.length <= 2) {
      throw new Error("page.evaluate: Execution context was destroyed, most likely because of a navigation");
    }
    throw new Error("TN_TEST_REACHED_THIRD_ATTEMPT");
  });
  const page = {
    goto,
    waitForLoadState: vi.fn(async () => undefined),
  } as unknown as Page;

  // The third attempt throws a non-navigation error, which must propagate untouched — that is
  // how this test observes that the first two navigation races were retried rather than raised.
  await expect(openPageAndConnectBridge(page, CONFIG, scenario(undefined))).rejects.toThrow(
    "TN_TEST_REACHED_THIRD_ATTEMPT",
  );
  expect(goto).toHaveBeenCalledTimes(3);
});

test("a page that never stops reloading fails closed instead of running the scenario", async () => {
  const goto = vi.fn(async () => {
    throw new Error("page.evaluate: Execution context was destroyed, most likely because of a navigation");
  });
  const page = {
    goto,
    waitForLoadState: vi.fn(async () => undefined),
  } as unknown as Page;

  await expect(openPageAndConnectBridge(page, CONFIG, scenario(undefined))).rejects.toMatchObject({
    diagnostic: { code: "TN_PLAYTEST_PAGE_NAVIGATED" },
  });
  expect(goto).toHaveBeenCalledTimes(3);
});

test("an ordinary navigation failure is not retried and is not relabelled", async () => {
  const goto = vi.fn(async () => {
    throw new Error("net::ERR_CONNECTION_REFUSED at http://127.0.0.1:5173");
  });
  const page = {
    goto,
    waitForLoadState: vi.fn(async () => undefined),
  } as unknown as Page;

  await expect(openPageAndConnectBridge(page, CONFIG, scenario(undefined))).rejects.toThrow(
    "ERR_CONNECTION_REFUSED",
  );
  expect(goto).toHaveBeenCalledTimes(1);
});

test("a renderer crash is reported as a crash, not as an unexplained runner error", () => {
  const destroyed = new Error("page.evaluate: Execution context was destroyed, most likely because of a navigation");

  const diagnostic = pageLifecycleDiagnostic(
    destroyed,
    { closed: false, crashed: true, frameNavigations: [], navigations: [], settled: true, tail: [] },
    "http://127.0.0.1:4173",
  );

  expect(diagnostic?.code).toBe("TN_PLAYTEST_PAGE_CRASHED");
  expect(diagnostic?.message).toContain("crashed");
});

test("a mid-run navigation is reported with the location the page moved to", () => {
  const destroyed = new Error("page.evaluate: Execution context was destroyed, most likely because of a navigation");

  const diagnostic = pageLifecycleDiagnostic(
    destroyed,
    { closed: false, crashed: false, frameNavigations: ["http://127.0.0.1:4173/game-over"], navigations: ["http://127.0.0.1:4173/game-over"], settled: true, tail: [] },
    "http://127.0.0.1:4173",
  );

  expect(diagnostic?.code).toBe("TN_PLAYTEST_PAGE_NAVIGATED");
  expect(diagnostic?.message).toContain("http://127.0.0.1:4173/game-over");
});

test("a page that closed without navigating is not reported as a navigation", () => {
  // The exact lifecycle a production profile recorded when its browser went away 18.8 s into a
  // 60 s window: the page closed, and the only main-frame navigation was the run's own.
  const closed = new Error("page.evaluate: Target page, context or browser has been closed");

  const diagnostic = pageLifecycleDiagnostic(
    closed,
    {
      closed: true,
      crashed: false,
      frameNavigations: ["http://127.0.0.1:4173/"],
      navigations: [],
      settled: true,
      tail: ['log: TN_PROD_FRAME_SAMPLES:[{"clockMs":18804,"frameIndex":1080}]'],
    },
    "http://127.0.0.1:4173",
  );

  expect(diagnostic?.code).toBe("TN_PLAYTEST_PAGE_CLOSED");
  expect(diagnostic?.message).not.toContain("navigated");
  // Still a failure: the run reached no assertion, and the report must not read as a pass.
  expect(diagnostic?.severity).toBe("error");
});

test("a renderer that goes away without either Playwright event is not reported as a navigation", () => {
  // Run 36821800527, `template-nonvisual (starter, 2/3)`: `page closed: false`,
  // `main-frame navigations: 1` (the run's own), no navigation after the handshake, no crash event,
  // and the report read "navigated to an unrecorded location" with a fix aimed at the game. Nothing
  // moved the document and nothing closed the page: the renderer was destroyed.
  const destroyed = new Error("page.evaluate: Execution context was destroyed, most likely because of a navigation");

  const diagnostic = pageLifecycleDiagnostic(
    destroyed,
    {
      closed: false,
      crashed: false,
      frameNavigations: ["http://127.0.0.1:37675/"],
      navigations: [],
      settled: true,
      tail: ['log: TN_FRAME_HITCH:{"gapMs":2649.9,"uptimeMs":4641.9}'],
    },
    "http://127.0.0.1:37675",
  );

  expect(diagnostic?.code).toBe("TN_PLAYTEST_PAGE_CRASHED");
  expect(diagnostic?.message).toContain("without navigating or closing");
  expect(diagnostic?.severity).toBe("error");
});

test("an error that is neither a crash nor a navigation keeps propagating", () => {
  const unrelated = new Error("TypeError: entity registry is not iterable");

  expect(
    pageLifecycleDiagnostic(unrelated, { closed: false, crashed: false, frameNavigations: [], navigations: [], settled: true, tail: [] }, "http://127.0.0.1:4173"),
  ).toBeUndefined();
});

test("a teardown step that finishes is reported as finished", async () => {
  await expect(boundedTeardownStep(Promise.resolve(), 1_000)).resolves.toBe(true);
  await expect(boundedTeardownStep(undefined, 1_000)).resolves.toBe(true);
  await expect(boundedTeardownStep(Promise.reject(new Error("closed badly")), 1_000)).resolves.toBe(
    true,
  );
});

test("a browser that never closes does not hold the process open", async () => {
  // Chromium under a virtual display can sit in close() forever. The run's report is already
  // written by then, so teardown has to give up and let the caller SIGKILL it — otherwise the
  // next scenario in a template's `&&` chain never starts.
  const started = Date.now();

  await expect(boundedTeardownStep(new Promise(() => undefined), 50)).resolves.toBe(false);

  expect(Date.now() - started).toBeLessThan(1_000);
});

test("managed server commands replace selected explicit and dynamic ports before the shell runs", () => {
  const command = "pnpm dev --host 127.0.0.1 --port $PORT --strictPort --inspect=${PORT}";
  const explicit = {
    ...CONFIG,
    port: 4_321,
    server: { command, cwd: ".", timeoutMs: 1_000 },
    url: "http://127.0.0.1:4321",
  } satisfies IStandalonePlaytestConfig;
  const dynamic = {
    ...CONFIG,
    port: 0,
    server: { command, cwd: ".", timeoutMs: 1_000 },
  } satisfies IStandalonePlaytestConfig;

  expect(resolveManagedServerCommand(explicit)).toBe(
    "pnpm dev --host 127.0.0.1 --port 4321 --strictPort --inspect=4321",
  );
  expect(resolveManagedServerCommand(dynamic, 49_876)).toBe(
    "pnpm dev --host 127.0.0.1 --port 49876 --strictPort --inspect=49876",
  );
  expect(substituteManagedPort("pnpm dev --port --strictPort", 4_321)).toBe(
    "pnpm dev --port 4321 --strictPort",
  );
});

test("a signal requests shared managed-server cleanup before exiting", async () => {
  const events: string[] = [];
  const teardown = vi.fn(async (stopManagedServer: boolean) => {
    events.push(`teardown:${stopManagedServer}`);
    await Promise.resolve();
    events.push("teardown-settled");
  });
  const setExitCode = vi.fn((code: number) => events.push(`exit-code:${code}`));
  const exit = vi.fn((code: number) => events.push(`exit:${code}`));

  await handlePlaytestSignal(teardown, setExitCode, exit, "browser", () => undefined);

  expect(teardown).toHaveBeenCalledWith(true);
  expect(events).toEqual(["teardown:true", "teardown-settled", "exit-code:2", "exit:2"]);
});
