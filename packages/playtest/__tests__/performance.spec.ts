import { makeTempDir } from "../../../test-support/temp-dir.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BoxGeometry, Mesh, MeshBasicMaterial, type Scene as ThreeScene, type Vector2 } from "three";
import { expect, test } from "vitest";

import {
  PLAYTEST_BRIDGE_GLOBAL,
  evaluateRichPlaytestAssertions,
  loadPlaytestScenario,
  type IPlaytestBridgeV1,
  type IPlaytestObservations,
  type IPlaytestObservationSnapshot,
  type IPlaytestScenario,
} from "../src/index.js";
import { defineGame } from "../../core/src/game.js";
import { playtest } from "../../core/src/playtest.js";
import { type ICtx, Scene } from "../../core/src/scene.js";
import { buildReport } from "../src/runner/runner.js";
import type { IStandalonePlaytestConfig } from "../src/runner/config.js";

const EMPTY_OBSERVATIONS: IPlaytestObservations = {
  console: [],
  hud: {},
  network: [],
  resources: {},
};

const CONFIG: IStandalonePlaytestConfig = {
  artifactDirectory: "artifacts/playtest-performance",
  headless: true,
  projectPath: ".",
  scenarioPath: "scenario.json",
  timeoutMs: 1_000,
  trace: false,
  url: "http://127.0.0.1:5173",
};

const REGRESSED_MESH_COUNT = 32;
const DECLARED_MAX_DRAW_CALLS = 8;
const DECLARED_MAX_TRIANGLES = 96;

async function scenario(assertion: unknown): Promise<IPlaytestScenario> {
  const directory = await makeTempDir("playtest-performance-");
  await writeFile(join(directory, "scenario.json"), JSON.stringify({
    assert: { performance: assertion },
    name: "performance-proof",
    schemaVersion: 1,
    steps: [{ release: true, waitFrames: 2 }],
  }));
  return loadPlaytestScenario(directory, "scenario.json");
}

function report(series: unknown[]) {
  return {
    diagnostics: [],
    distance: 0,
    entity: "",
    expectMoved: false,
    frames: 2,
    trivialityOptOuts: [],
    observations: {
      ...EMPTY_OBSERVATIONS,
      performanceSeries: series,
    },
  };
}

interface TestRenderer {
  readonly domElement: HTMLCanvasElement;
  readonly info: { render: { calls?: number; triangles?: number } };
  getDrawingBufferSize(target: Vector2): Vector2;
  render(scene: ThreeScene): void;
  setSize(width: number, height: number, updateStyle?: boolean): void;
  dispose(): void;
}

function testCanvas(): HTMLCanvasElement {
  const canvas = new EventTarget() as EventTarget & Partial<HTMLCanvasElement>;
  Object.defineProperties(canvas, {
    clientHeight: { configurable: true, value: 180 },
    clientWidth: { configurable: true, value: 320 },
    parentElement: { configurable: true, value: null },
  });
  return canvas as HTMLCanvasElement;
}

function bridge(): IPlaytestBridgeV1 {
  const value = (globalThis as Record<string, unknown>)[PLAYTEST_BRIDGE_GLOBAL];
  if (typeof value !== "object" || value === null) throw new Error("Playtest bridge was not installed.");
  return value as IPlaytestBridgeV1;
}

function createTestRenderer(canvas: HTMLCanvasElement, observeRendererCounts: boolean): TestRenderer {
  const renderer: TestRenderer = {
    domElement: canvas,
    info: { render: {} },
    getDrawingBufferSize: (target) => target.set(1280, 720),
    render: (scene) => {
      if (!observeRendererCounts) {
        renderer.info.render = {};
        return;
      }
      let calls = 0;
      let triangles = 0;
      scene.traverse((object) => {
        if (!(object as Mesh).isMesh || !object.visible) return;
        const mesh = object as Mesh;
        const geometry = mesh.geometry;
        const position = geometry.getAttribute("position");
        calls += 1;
        triangles += geometry.index === null ? position.count / 3 : geometry.index.count / 3;
      });
      renderer.info.render = { calls, triangles };
    },
    setSize: () => undefined,
    dispose: () => undefined,
  };
  return renderer;
}

async function renderControl(
  meshCount: number,
  observeRendererCounts: boolean,
): Promise<IPlaytestObservationSnapshot> {
  const canvas = testCanvas();
  const callbacks: Array<(time: number) => void> = [];
  const requestFrame = globalThis.requestAnimationFrame;
  const cancelFrame = globalThis.cancelAnimationFrame;
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: (callback: (time: number) => void) => {
      callbacks.push(callback);
      return callbacks.length;
    },
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    configurable: true,
    value: () => undefined,
  });
  class RegressedScene extends Scene {
    override enter(ctx: ICtx): void {
      for (let index = 0; index < meshCount; index += 1) {
        const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
        mesh.position.set((index % 8) - 3.5, Math.floor(index / 8) - 1.5, 0);
        ctx.add(mesh);
      }
    }
  }
  const game = defineGame({
    initialState: {},
    // A runner-announced plugin plays the diagnostics consumer: collection stays off until
    // something says it will read the series.
    plugins: [
      playtest(),
      {
        setup: (_ctx, runtime) => {
          runtime?.enableRuntimeDiagnostics?.();
          return undefined;
        },
      },
    ],
    renderer: {
      canvas,
      preferWebGPU: false,
      webgl2Factory: () => createTestRenderer(canvas, observeRendererCounts),
    },
    scenes: { regressed: RegressedScene },
    start: "regressed",
  });
  try {
    await game.start();
    callbacks.shift()?.(0);
    callbacks.shift()?.(16);
    callbacks.shift()?.(32);
    return await bridge().sample({ include: ["runtimeDiagnosticsSeries"] });
  } finally {
    game.stop();
    if (requestFrame === undefined) Reflect.deleteProperty(globalThis, "requestAnimationFrame");
    else Object.defineProperty(globalThis, "requestAnimationFrame", { value: requestFrame });
    if (cancelFrame === undefined) Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
    else Object.defineProperty(globalThis, "cancelAnimationFrame", { value: cancelFrame });
  }
}

test("performance bounds pass against observed frame cost and renderer counts", async () => {
  const loaded = await scenario({ maxDrawCalls: 10, maxFrameMsP95: 20, maxFrameMsReason: "fixture series reads 18 ms", maxTriangles: 500 });
  const evaluated = evaluateRichPlaytestAssertions({
    report: report([
      { drawCalls: 4, frameMs: 16, triangles: 120 },
      { drawCalls: 5, frameMs: 18, triangles: 140 },
      { drawCalls: 3, frameMs: 17, triangles: 100 },
    ]),
    scenario: loaded,
  });

  expect(evaluated.assertions).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "performance.samples", pass: true }),
    expect.objectContaining({ id: "performance.maxFrameMsP95", pass: true }),
    expect.objectContaining({ id: "performance.maxDrawCalls", pass: true }),
    expect.objectContaining({ id: "performance.maxTriangles", pass: true }),
  ]));
  expect(evaluated.diagnostics).toEqual([]);
});

/** The frame budget's phase split and the presentation completion ride along on every sample. */
const withoutPhaseAndCompletion = (sample: object): Record<string, unknown> => {
  const { completedAtMs: _completedAtMs, phases: _phases, sequence: _sequence, ...rest } = sample as Record<string, unknown>;
  return rest;
};

test("the permanent regressed-scene control drives the render loop and turns red", async () => {
  const loaded = await scenario({ maxDrawCalls: DECLARED_MAX_DRAW_CALLS, maxTriangles: DECLARED_MAX_TRIANGLES });
  const snapshot = await renderControl(REGRESSED_MESH_COUNT, true);
  const result = buildReport(CONFIG, loaded, undefined, snapshot, [], []);

  expect((snapshot.runtimeDiagnosticsSeries ?? []).map(withoutPhaseAndCompletion)).toEqual([
    { drawCalls: REGRESSED_MESH_COUNT, frameMs: 16, triangles: REGRESSED_MESH_COUNT * 12 },
    { drawCalls: REGRESSED_MESH_COUNT, frameMs: 16, triangles: REGRESSED_MESH_COUNT * 12 },
  ]);
  expect(result.assertionResults).toEqual(expect.arrayContaining([
    expect.objectContaining({ details: expect.objectContaining({ actual: REGRESSED_MESH_COUNT }), id: "performance.maxDrawCalls", pass: false }),
    expect.objectContaining({ details: expect.objectContaining({ actual: REGRESSED_MESH_COUNT * 12 }), id: "performance.maxTriangles", pass: false }),
  ]));
  expect(result.diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_PERFORMANCE_ASSERTION_FAILED");
  expect(result.pass).toBe(false);
});

test("the permanent regressed-scene control fails closed when renderer counts disappear", async () => {
  const loaded = await scenario({ maxDrawCalls: DECLARED_MAX_DRAW_CALLS, maxTriangles: DECLARED_MAX_TRIANGLES });
  const snapshot = await renderControl(REGRESSED_MESH_COUNT, false);
  const result = buildReport(CONFIG, loaded, undefined, snapshot, [], []);

  // The engine frame budget rides along on every sample; this control is about the renderer
  // counts disappearing, so compare the sample without its phase split.
  expect((snapshot.runtimeDiagnosticsSeries ?? []).map(withoutPhaseAndCompletion)).toEqual([
    { frameMs: 16 },
    { frameMs: 16 },
  ]);
  expect((snapshot.runtimeDiagnosticsSeries ?? []).every(({ phases }) => phases !== undefined)).toBe(true);
  expect(result.assertionResults).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "performance.maxDrawCalls", pass: false }),
    expect.objectContaining({ id: "performance.maxTriangles", pass: false }),
  ]));
  expect(result.diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_PERFORMANCE_ASSERTION_FAILED");
  expect(result.pass).toBe(false);
});

test("an empty performance series fails closed instead of passing vacuously", async () => {
  const loaded = await scenario({ maxFrameMsP95: 20, maxFrameMsReason: "fixture" });
  const evaluated = evaluateRichPlaytestAssertions({
    report: report([]),
    scenario: loaded,
  });

  expect(evaluated.assertions).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "performance.samples", pass: false }),
    expect.objectContaining({ id: "performance.maxFrameMsP95", pass: false }),
  ]));
  expect(evaluated.diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_PERFORMANCE_SAMPLES_MISSING");
});

/**
 * PRD-214's budget gate. The device measurement it exists for — a Pixel 8 presenting at 18.3 fps
 * with `renderer.render()` owning ~88% of the frame — could only ever be recorded in prose,
 * because nothing in the harness could assert an fps floor or say which phase blew it.
 */
const DEVICE_SHAPED_SERIES = [
  { frameMs: 54.44, phases: { hostGap: 1.42, overlay: 0.3, render: 49.42, residual: 0.04, update: 3.26 } },
  { frameMs: 56.01, phases: { hostGap: 1.5, overlay: 0.3, render: 50.1, residual: 0.05, update: 3.3 } },
  { frameMs: 55.2, phases: { hostGap: 1.45, overlay: 0.3, render: 49.8, residual: 0.04, update: 3.28 } },
];

test("the fps floor turns red on the measured device frame and names the phase that owns it", async () => {
  const loaded = await scenario({ maxPhaseMsP95: { render: 12 }, minFps: 30 });
  const evaluated = evaluateRichPlaytestAssertions({ report: report(DEVICE_SHAPED_SERIES), scenario: loaded });

  expect(evaluated.assertions).toEqual(expect.arrayContaining([
    expect.objectContaining({ details: expect.objectContaining({ actual: 18.11, expected: 30, unit: "fps" }), id: "performance.minFps", pass: false }),
    expect.objectContaining({ details: expect.objectContaining({ actual: 50.1, expected: 12, phase: "render" }), id: "performance.maxPhaseMsP95.render", pass: false }),
  ]));
  expect(evaluated.diagnostics.map(({ message }) => message)).toEqual(expect.arrayContaining([
    expect.stringContaining("performance.minFps expected at least 30 fps, observed 18.11"),
    expect.stringContaining("performance.maxPhaseMsP95.render expected at most 12 ms, observed 50.1"),
  ]));
});

test("the same budget passes on a frame that meets it, so the gate is not simply always red", async () => {
  const loaded = await scenario({ maxPhaseMsP95: { render: 12 }, minFps: 30 });
  const healthy = DEVICE_SHAPED_SERIES.map(() => ({
    frameMs: 16.7,
    phases: { hostGap: 1.4, overlay: 0.3, render: 9.2, residual: 0.04, update: 3.2 },
  }));
  const evaluated = evaluateRichPlaytestAssertions({ report: report(healthy), scenario: loaded });

  expect(evaluated.assertions).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "performance.minFps", pass: true }),
    expect.objectContaining({ id: "performance.maxPhaseMsP95.render", pass: true }),
  ]));
});

test("a phase ceiling fails closed when the run carries no frame-budget split", async () => {
  const loaded = await scenario({ maxPhaseMsP95: { render: 12 } });
  const evaluated = evaluateRichPlaytestAssertions({
    report: report([{ frameMs: 16.7 }, { frameMs: 16.7 }]),
    scenario: loaded,
  });

  expect(evaluated.assertions).toEqual(expect.arrayContaining([
    expect.objectContaining({ details: expect.objectContaining({ actual: null }), id: "performance.maxPhaseMsP95.render", pass: false }),
  ]));
  expect(evaluated.diagnostics.map(({ message }) => message)).toEqual(expect.arrayContaining([
    expect.stringContaining("received no frame-budget phase samples"),
  ]));
});

test("a wrong-typed phase split invalidates the sample rather than being ignored", async () => {
  const loaded = await scenario({ minFps: 30 });
  const evaluated = evaluateRichPlaytestAssertions({
    report: report([{ frameMs: 16.7, phases: { render: "slow" } }]),
    scenario: loaded,
  });

  expect(evaluated.assertions).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "performance.samples", pass: false }),
    expect.objectContaining({ id: "performance.minFps", pass: false }),
  ]));
});

test("a budget naming a phase the engine does not measure throws at load", async () => {
  await expect(scenario({ maxPhaseMsP95: { renderr: 12 } })).rejects.toThrow(/is not a frame-budget phase/u);
  await expect(scenario({ maxPhaseMsP95: {} })).rejects.toThrow(/must name at least one frame-budget phase/u);
  await expect(scenario({ maxPhaseMsP95: { render: "12" } })).rejects.toThrow(/non-negative number/u);
  await expect(scenario({ minFps: "30" })).rejects.toThrow();
});

/**
 * The per-pass split: a shadow or reflection pass shares three's `info.render` with the colour
 * pass, so the whole-frame `maxDrawCalls` cannot bound it. These are the same measured series the
 * marker carries, split by the pass that submitted them.
 */
const PASS_SERIES = [
  {
    frameMs: 16,
    passes: [
      { draws: 100, kind: "main", triangles: 1000 },
      { draws: 40, kind: "shadow", triangles: 400 },
      { draws: 60, kind: "reflection", triangles: 600 },
    ],
  },
  {
    frameMs: 16.5,
    passes: [
      { draws: 120, kind: "main", triangles: 1200 },
      { draws: 45, kind: "shadow", triangles: 450 },
      { draws: 65, kind: "reflection", triangles: 650 },
    ],
  },
];

test("a per-pass budget passes when every declared pass stays under it", async () => {
  const loaded = await scenario({ maxPassDrawCalls: { shadow: 50 }, maxPassTriangles: { reflection: 700 } });
  const evaluated = evaluateRichPlaytestAssertions({ report: report(PASS_SERIES), scenario: loaded });

  expect(evaluated.assertions).toEqual(expect.arrayContaining([
    expect.objectContaining({ details: expect.objectContaining({ actual: 45, expected: 50, pass: "shadow" }), id: "performance.maxPassDrawCalls.shadow", pass: true }),
    expect.objectContaining({ details: expect.objectContaining({ actual: 650, expected: 700, pass: "reflection" }), id: "performance.maxPassTriangles.reflection", pass: true }),
  ]));
  expect(evaluated.diagnostics).toEqual([]);
});

test("a per-pass budget fails with the actual and the limit in the message", async () => {
  const loaded = await scenario({ maxPassDrawCalls: { shadow: 44 }, maxPassTriangles: { main: 1100 } });
  const evaluated = evaluateRichPlaytestAssertions({ report: report(PASS_SERIES), scenario: loaded });

  expect(evaluated.assertions).toEqual(expect.arrayContaining([
    expect.objectContaining({ details: expect.objectContaining({ actual: 45, expected: 44, pass: "shadow" }), id: "performance.maxPassDrawCalls.shadow", pass: false }),
    expect.objectContaining({ details: expect.objectContaining({ actual: 1200, expected: 1100, pass: "main" }), id: "performance.maxPassTriangles.main", pass: false }),
  ]));
  expect(evaluated.diagnostics.map(({ message }) => message)).toEqual(expect.arrayContaining([
    expect.stringContaining("performance.maxPassDrawCalls.shadow expected at most 44 draw calls, observed 45"),
    expect.stringContaining("performance.maxPassTriangles.main expected at most 1100 triangles, observed 1200"),
  ]));
});

test("a per-pass ceiling fails closed when the run carries no pass split", async () => {
  const loaded = await scenario({ maxPassDrawCalls: { shadow: 400 } });
  const evaluated = evaluateRichPlaytestAssertions({
    report: report([{ frameMs: 16.7 }, { frameMs: 16.7 }]),
    scenario: loaded,
  });

  expect(evaluated.assertions).toEqual(expect.arrayContaining([
    expect.objectContaining({ details: expect.objectContaining({ actual: null }), id: "performance.maxPassDrawCalls.shadow", pass: false }),
  ]));
  expect(evaluated.diagnostics.map(({ message }) => message)).toEqual(expect.arrayContaining([
    expect.stringContaining("received no per-pass samples for 'shadow'"),
  ]));
});

test("a budget with no per-pass bounds adds no per-pass assertion", async () => {
  const loaded = await scenario({ minFps: 30 });
  const evaluated = evaluateRichPlaytestAssertions({ report: report(PASS_SERIES), scenario: loaded });

  expect(evaluated.assertions.some(({ id }) => id.startsWith("performance.maxPass"))).toBe(false);
  expect(evaluated.diagnostics).toEqual([]);
});

test("a budget naming an unknown pass throws at load", async () => {
  await expect(scenario({ maxPassDrawCalls: { colour: 10 } })).rejects.toThrow(/is not a render pass/u);
  await expect(scenario({ maxPassDrawCalls: {} })).rejects.toThrow(/must name at least one render pass/u);
  await expect(scenario({ maxPassTriangles: { main: "10" } })).rejects.toThrow(/non-negative number/u);
});
