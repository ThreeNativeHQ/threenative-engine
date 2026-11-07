import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import {
  Color,
  DirectionalLight,
  HemisphereLight,
  PerspectiveCamera,
  Scene as ThreeScene,
} from "three";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { pass } from "three/tsl";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { evaluateRichPlaytestAssertions } from "../../playtest/src/assertion-evaluators.js";
import { resolveDiagnosticsPolicy } from "../../playtest/src/assertion-report.js";
import { loadPlaytestScenario } from "../../playtest/src/scenario.js";
import { Registry } from "../src/entities.js";
import { Scene } from "../src/scene.js";
import { createGameStore } from "../src/state.js";

const root = resolve(import.meta.dirname, "../../..");
const fixture = "examples/abyss-framework";

async function probe() {
  // The actual scene runs with its renderer/assets boundary stubbed. These distinctive readings
  // catch dropped or invented diagnostics; WorldCells itself has separate engine tests.
  let stats = {
    admission: { backlog: 13, deferred: 2, spentMs: 3.75 },
    bundle: { on: true, children: 11, reason: "default", records: 23 },
    evictions: 7,
    failures: 0,
    gpuScene: { on: false, reason: "renderer has no computeAsync", dispatches: 0 },
    instances: 97,
    loadsInFlight: 2,
    loadsQueued: 3,
    pendingPrewarm: 4,
    pressure: { bytes: 0, cells: 0, instances: 0 },
    residentCells: 3,
  };
  const world = { dispose() {}, stats: () => stats };
  const source = readFileSync(resolve(root, fixture, "src/scenes/WorldProbe.ts"), "utf8");
  const module = { exports: {} };
  const dependencies: Record<string, unknown> = {
    "@threenative/core": { Scene, VirtualShadowNode: class {} },
    "@threenative/core/world": { WorldCells: { load: async () => world } },
    three: { Color, DirectionalLight, HemisphereLight },
    "three/tsl": { pass },
    "three/addons/tsl/display/BloomNode.js": { bloom },
    "../render/terrain.js": { terrainMaterial: () => ({}) },
    // Only the `?world&viewDistance` flight applies it, and this context has no location.
    "../render/worldFog.js": { worldFog: () => undefined },
    // Only `?world&shadowPartial` constructs the PRD-538 probe.
    "../probes/shadowPartial.js": { ShadowPartialProbe: class {} },
    // Only `?probeCost=capture|trace` constructs the PRD-603 probe.
    "../probes/probeCost.js": { ProbeCostProbe: class {}, probeCostMode: () => undefined },
  };
  runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      exports: module.exports,
      require: (name: string) => {
        const stub = dependencies[name];
        if (stub === undefined) throw new Error(`Unexpected fixture dependency ${name}`);
        return stub;
      },
    },
  );
  const { WorldProbe } = module.exports as { WorldProbe: new () => Scene<Record<string, unknown>> };
  const scene = new WorldProbe();
  let flying = false;
  const ctx = {
    add() {},
    assets: {},
    camera: new PerspectiveCamera(),
    entities: new Registry(),
    input: { pressed: () => flying },
    renderer: {},
    scene: new ThreeScene(),
    state: createGameStore<Record<string, unknown>>({}),
  } as unknown as Parameters<typeof scene.load>[0];
  await scene.load(ctx);
  scene.enter(ctx);
  return {
    ctx,
    scene,
    debug: () => ctx.entities.snapshot().world,
    fly: (value: boolean) => {
      flying = value;
    },
    stats: () => stats,
    settle: () => {
      stats = { ...stats, admission: { backlog: 0, deferred: 0, spentMs: 0 }, residentCells: 1 };
    },
  };
}

describe("PRD-477 world capture fixture", () => {
  it("publishes actual world stats and preserves admission overshoot and the GPU fallback reason", async () => {
    const run = await probe();
    expect(run.ctx.state.getState().stats).toEqual(run.stats());
    expect(run.debug()).toMatchObject({
      admissionBacklog: 13,
      admissionDeferred: 2,
      admissionSpentMs: 3.75,
      gpuSceneOn: false,
      gpuSceneReason: "renderer has no computeAsync",
      loadsQueued: 3,
      pendingPrewarm: 4,
      maxAdmissionSpentMs: 3.75,
      maxInstances: 97,
    });
    run.settle();
    run.scene.render(run.ctx);
    expect(run.ctx.state.getState().stats).toEqual(run.stats());
    expect(run.debug()).toMatchObject({
      admissionBacklog: 0,
      admissionSpentMs: 0,
      maxAdmissionSpentMs: 3.75,
      maxResidentCells: 3,
    });
  });

  it("reports the input-gated camera pose and elapsed flight time without changing the fixed route", async () => {
    const run = await probe();
    run.scene.update(run.ctx, 10);
    expect(run.debug()).toMatchObject({
      cameraPosition: [-160, 24, 0],
      cameraTarget: [-120, 10, 0],
      flyTimeMs: 0,
    });
    run.fly(true);
    run.scene.update(run.ctx, 0.5);
    expect(run.debug()).toMatchObject({
      cameraPosition: [-128, 24, 0],
      cameraTarget: [-88, 10, 0],
      flyTimeMs: 500,
    });
    run.fly(false);
    run.scene.update(run.ctx, 10);
    expect(run.debug()).toMatchObject({ cameraPosition: [-128, 24, 0], flyTimeMs: 500 });
    run.fly(true);
    run.scene.update(run.ctx, 10);
    expect(run.debug()?.cameraPosition).toEqual([180, 24, 0]);
  });

  it("reports landmark positions from the authored chunk transforms", async () => {
    const run = await probe();
    const landmarks = ["yard_0_2", "yard_1_1"].flatMap((chunk) => {
      const bytes = readFileSync(resolve(root, fixture, `assets/world/chunks/${chunk}.glb`));
      const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString("utf8")) as {
        nodes: Array<{ name: string; translation: number[] }>;
      };
      return json.nodes.map((node) => ({ id: node.name, position: node.translation }));
    });
    expect(run.debug()?.landmarks).toEqual(landmarks);
  });

  it("loads a chronological named screenshot series along the same KeyF leg", async () => {
    const scenario = await loadPlaytestScenario(
      root,
      `${fixture}/playtests/phase477-world-capture.playtest.json`,
    );
    expect(scenario.target).toBe("web");
    const moving = scenario.steps.filter((step) => step.press === "KeyF");
    expect(moving).toHaveLength(32);
    expect(moving.every((step) => step.waitTicks === 9 && step.release)).toBe(true);
    expect(moving.map((step) => step.screenshot)).toEqual(
      Array.from(
        { length: 32 },
        (_, index) => `phase477-walk-${String(index + 1).padStart(2, "0")}`,
      ),
    );
    expect(scenario.steps.every((step) => step.label === step.screenshot)).toBe(true);
    expect(scenario.steps[0]?.screenshot).toBe("phase477-pose-start");
    expect(scenario.steps.at(-1)?.screenshot).toBe("phase477-pose-end");
  });

  it("keeps every captured walking pose forward-moving through the actual release cadence", async () => {
    const scenario = await loadPlaytestScenario(
      root,
      `${fixture}/playtests/phase477-world-capture.playtest.json`,
    );
    const run = await probe();
    let previous = -160;
    for (const step of scenario.steps.filter((row) => row.press === "KeyF")) {
      run.fly(true);
      // The hosted runner observes one release-boundary tick after each held step.
      // Reproduce that observed cadence, without changing the scene or importer contract.
      for (let tick = 0; tick < (step.waitTicks ?? 0) + 1; tick++)
        run.scene.update(run.ctx, 1 / 60);
      run.fly(false);
      const position = run.debug()?.cameraPosition as number[];
      const x = position[0];
      if (x === undefined) throw new Error("WorldProbe camera x was not observed");
      expect(x).toBeGreaterThan(previous);
      previous = x;
    }
    expect(previous).toBe(180);
  });

  it("keeps the camera's line of sight on the map after the route leaves it", async () => {
    // The fixture is 4 x 4 cells of 64 m from -128, and no terrain tile wholly off it is meshed, so
    // a gaze that lands past the edge frames empty sky (CI `integration / capture`, walk-28).
    const run = await probe();
    run.fly(true);
    for (let tick = 0; tick < 400; tick++) {
      run.scene.update(run.ctx, 1 / 60);
      const [px, py, pz] = run.debug()?.cameraPosition as [number, number, number];
      const [tx, ty, tz] = run.debug()?.cameraTarget as [number, number, number];
      const reach = py / (py - ty);
      const gaze = [px + (tx - px) * reach, pz + (tz - pz) * reach];
      for (const axis of gaze) expect(Math.abs(axis)).toBeLessThanOrEqual(128 + 1e-9);
    }
    expect(run.debug()?.cameraPosition).toEqual([180, 24, 0]);
  });

  it.each([
    ["traverses and returns to the same resident count", 3, 8, 9, true],
    ["frozen warm-up residency", 3, 2, 9, false],
    ["never evicts", 3, 8, 0, false],
    ["ends over the residency cap", 26, 8, 9, false],
    ["ends with no resident cells", 0, 8, 9, false],
  ])(
    "checks actual streaming churn: %s",
    async (_name, residentCells, changes, evictions, pass) => {
      const scenario = await loadPlaytestScenario(
        root,
        `${fixture}/playtests/phase477-world-capture.playtest.json`,
      );
      // Reproduce the hosted route's equal endpoint counts through the real evaluator.
      // These synthetic observations test the assertion contract, not runtime acceptance.
      scenario.assert = {
        components: scenario.assert?.components?.filter(({ component }) =>
          ["residentCells", "residenceChanges", "evictions"].includes(component),
        ),
      };
      const result = evaluateRichPlaytestAssertions({
        scenario,
        report: {
          diagnostics: [],
          distance: 0,
          entity: "world",
          expectMoved: false,
          frames: 1,
          trivialityOptOuts: [],
          observations: {
            console: [],
            network: [],
            hud: {},
            resources: {},
            components: {
              world: {
                residentCells: { before: 3, after: residentCells },
                residenceChanges: { before: 2, after: changes },
                evictions: { before: 0, after: evictions },
              },
            },
          },
        },
      });
      const checks = result.assertions.filter(({ id }) => id.startsWith("component.world."));
      expect(checks).toHaveLength(3);
      expect(checks.every((assertion) => assertion.pass)).toBe(pass);
    },
  );

  it.each(["desktop", "android"])(
    "loads the %s proof contract with real upper bounds and settle assertions",
    async (target) => {
      const scenario = await loadPlaytestScenario(
        root,
        `${fixture}/playtests/phase477-world-streaming.${target}.playtest.json`,
      );
      // Android uses the documented CLI --target android override of a web scenario.
      expect(scenario.target).toBe(target === "android" ? "web" : target);
      if (target === "desktop") {
        // The desktop runner produces no runtimeDiagnostics, so the block is web-only there; the
        // native run proves the world drew with bundles on instead (PRD-494, dcb5204ec).
        expect(scenario.assert?.diagnostics).toBeUndefined();
        expect(scenario.assert?.components).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ component: "bundleOn", equals: true }),
          ]),
        );
      } else {
        expect(scenario.assert?.diagnostics).toMatchObject({
          runtimeReady: true,
          noRuntimeDiagnostics: true,
          noConsoleErrors: true,
        });
        expect(resolveDiagnosticsPolicy(scenario.assert?.diagnostics, target)).toMatchObject({
          noNetworkErrors: false,
          networkErrorsOptOutReason: expect.stringContaining("no network observer"),
        });
      }
      expect(scenario.assert?.components).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ component: "maxResidentCells", gte: 1, lte: 25 }),
          expect.objectContaining({ component: "instances", gte: 1, lte: 20_000 }),
          expect.objectContaining({ component: "admissionBacklog", equals: 0 }),
          expect.objectContaining({ component: "loadsQueued", equals: 0 }),
        ]),
      );
      // The final admission unit may overshoot 2ms. Do not turn a diagnostic into a false cap.
      expect(
        scenario.assert?.components?.find((row) => row.component === "maxAdmissionSpentMs")?.lte,
      ).toBeUndefined();
    },
  );
});
