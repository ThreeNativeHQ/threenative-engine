import { makeTempDir } from "../../../test-support/temp-dir.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "vitest";

import {
  evaluateRichPlaytestAssertions,
  PLAYTEST_ASSERTION_REGISTRY,
  PLAYTEST_CAPABILITY_REGISTRY,
  PlaytestScenarioError,
  loadPlaytestScenario,
  requiredPlaytestCapabilities,
} from "../src/index.js";
import { PLAYTEST_SETUP_REGISTRY } from "../src/assertions.js";
import type { IPlaytestResourceAssertion } from "../src/scenario.js";

async function loadScenarioWithAssertions(assertions: unknown) {
  const directory = await makeTempDir("playtest-numeric-bound-");
  await writeFile(join(directory, "scenario.json"), JSON.stringify({
    assert: assertions,
    name: "numeric-bound",
    schemaVersion: 1,
    steps: [{ release: true, waitFrames: 1 }],
  }));
  return loadPlaytestScenario(directory, "scenario.json");
}

async function loadScenarioWithSteps(steps: unknown[]) {
  const directory = await makeTempDir("playtest-wait-resource-");
  await writeFile(join(directory, "scenario.json"), JSON.stringify({
    name: "wait-resource",
    schemaVersion: 1,
    steps,
  }));
  return loadPlaytestScenario(directory, "scenario.json");
}

test("schema version 1 parser preserves a valid semantic scenario", async () => {
  const directory = await makeTempDir("playtest-core-");
  const scenario = {
    artifacts: { screenshots: "before-after" },
    assert: {
      camera: { follows: "player", targetInViewport: true },
      movement: { entity: "player", minDistance: 0.5 },
    },
    name: "standalone-movement",
    schemaVersion: 1,
    setup: { entities: [{ entity: "player", position: [0, 0, 0] }] },
    steps: [{ holdFrames: 5, press: "KeyW", release: true }],
    subject: "player",
    target: "web",
    viewport: { height: 720, width: 1280 },
    warmupFrames: 2,
  };
  await writeFile(join(directory, "scenario.json"), JSON.stringify(scenario));

  const parsed = await loadPlaytestScenario(directory, "scenario.json");

  expect({ ...parsed, sourcePath: undefined }).toEqual({ ...scenario, inputDelivery: "deterministic", sourcePath: undefined });
});

test("scenario parser preserves complete held-pointer sets in arrival order", async () => {
  const directory = await makeTempDir("playtest-pointers-");
  await writeFile(join(directory, "scenario.json"), JSON.stringify({
    assert: { diagnostics: { runtimeReady: true } },
    name: "two-pointers",
    schemaVersion: 1,
    steps: [
      { holdFrames: 2, pointers: [{ id: 7, x: 0.2, y: 0.8 }], release: false },
      {
        holdFrames: 8,
        pointers: [
          { id: 7, x: 0.25, y: 0.8 },
          { buttons: 1, id: 3, x: 0.8, y: 0.8 },
        ],
        release: true,
      },
    ],
  }));

  const parsed = await loadPlaytestScenario(directory, "scenario.json");

  expect(parsed.steps[1]?.pointers?.map(({ id }) => id)).toEqual([7, 3]);
});

test("scenario parser accepts viewport-pixel click steps", async () => {
  const directory = await makeTempDir("playtest-click-");
  await writeFile(join(directory, "scenario.json"), JSON.stringify({
    name: "clicks",
    schemaVersion: 1,
    steps: [
      { at: { x: 640, y: 360 }, kind: "click", label: "start" },
      { at: { entity: "settings" }, kind: "click", label: "settings" },
    ],
  }));

  const parsed = await loadPlaytestScenario(directory, "scenario.json");

  expect(parsed.steps).toEqual([
    { at: { x: 640, y: 360 }, kind: "click", label: "start", release: true },
    { at: { entity: "settings" }, kind: "click", label: "settings", release: true },
  ]);
});

test("scenario parser accepts a browser wheel step", async () => {
  const directory = await makeTempDir("playtest-wheel-");
  await writeFile(join(directory, "scenario.json"), JSON.stringify({
    name: "wheel",
    schemaVersion: 1,
    steps: [{ wheel: { deltaY: -160 }, waitTicks: 4 }],
  }));

  const parsed = await loadPlaytestScenario(directory, "scenario.json");

  expect(parsed.steps).toEqual([
    { release: true, waitTicks: 4, wheel: { deltaY: -160 } },
  ]);
});

test("scenario parser accepts a bounded waitForResource step", async () => {
  const step = {
    timeoutMs: 10_000,
    waitForResource: { equals: true, id: "state", path: "networkConnected" },
  };

  const parsed = await loadScenarioWithSteps([step]);

  expect(parsed.steps).toEqual([{ ...step, release: true }]);
});

test.each([
  ["missing timeout", { waitForResource: { equals: true, id: "state", path: "networkConnected" } }],
  ["zero timeout", { timeoutMs: 0, waitForResource: { equals: true, id: "state", path: "networkConnected" } }],
  ["timeout above maximum", { timeoutMs: 300_001, waitForResource: { equals: true, id: "state", path: "networkConnected" } }],
])("scenario parser rejects a waitForResource step with %s", async (_label, step) => {
  await expect(loadScenarioWithSteps([step])).rejects.toMatchObject({
    diagnostic: { message: expect.stringMatching(/timeoutMs.*positive integer.*300000|timeoutMs.*300000/u) },
  });
});

test.each([
  ["missing path", { equals: true, id: "state" }],
  ["empty path", { equals: true, id: "state", path: "" }],
  ["empty path segment", { equals: true, id: "state", path: "network..connected" }],
  ["missing predicate", { id: "state", path: "networkConnected" }],
  ["multiple predicates", { equals: true, gte: 1, id: "state", path: "networkConnected" }],
  ["wrong numeric predicate type", { gte: "1", id: "state", path: "networkConnected" }],
  ["unknown predicate key", { equals: true, id: "state", path: "networkConnected", textIncludes: "true" }],
])("scenario parser rejects a malformed waitForResource %s", async (_label, waitForResource) => {
  await expect(loadScenarioWithSteps([{ timeoutMs: 10_000, waitForResource }])).rejects.toMatchObject({
    diagnostic: { code: expect.stringMatching(/^TN_PLAYTEST_SCENARIO_(?:INVALID|STEP_INVALID)$/u) },
  });
});

test.each([
  ["input", { kind: "input", press: "KeyW" }],
  ["holdTicks", { holdTicks: 1 }],
  ["waitTicks", { waitTicks: 1 }],
])("scenario parser rejects waitForResource mixed with %s", async (_label, mixedStep) => {
  await expect(loadScenarioWithSteps([{
    ...mixedStep,
    timeoutMs: 10_000,
    waitForResource: { equals: true, id: "state", path: "networkConnected" },
  }])).rejects.toMatchObject({
    diagnostic: { code: expect.stringMatching(/^TN_PLAYTEST_SCENARIO_(?:INVALID|STEP_INVALID)$/u) },
  });
});

test.each([
  ["wrong coordinate type", { at: { x: "640", y: 360 }, kind: "click" }],
  ["negative coordinate", { at: { x: -1, y: 360 }, kind: "click" }],
  ["wrong entity type", { at: { entity: 42 }, kind: "click" }],
  ["click with keyboard input", { at: { x: 640, y: 360 }, kind: "click", press: "Enter" }],
  ["unknown kind", { at: { x: 640, y: 360 }, kind: "pointerClick" }],
])("scenario parser rejects malformed click steps: %s", async (_label, step) => {
  const directory = await makeTempDir("playtest-click-invalid-");
  await writeFile(join(directory, "scenario.json"), JSON.stringify({
    name: "invalid-click",
    schemaVersion: 1,
    steps: [step],
  }));

  await expect(loadPlaytestScenario(directory, "scenario.json")).rejects.toMatchObject({
    diagnostic: { code: expect.stringMatching(/^TN_PLAYTEST_SCENARIO_(?:INVALID|STEP_INVALID)$/u) },
  });
});

test.each([
  ["non-array set", { pointers: {}, waitFrames: 1 }],
  ["duplicate ids", { pointers: [{ id: 1, x: 0.2, y: 0.8 }, { id: 1, x: 0.8, y: 0.8 }] }],
  ["unknown pointer field", { pointers: [{ id: 1, x: 0.2, y: 0.8, zone: "left" }] }],
  ["zero buttons", { pointers: [{ buttons: 0, id: 1, x: 0.2, y: 0.8 }] }],
  ["out-of-range coordinate", { pointers: [{ id: 1, x: 1.1, y: 0.8 }] }],
])("scenario parser rejects malformed multi-pointer input: %s", async (_label, step) => {
  const directory = await makeTempDir("playtest-pointers-invalid-");
  await writeFile(join(directory, "scenario.json"), JSON.stringify({
    name: "invalid-pointers",
    schemaVersion: 1,
    steps: [step],
  }));

  await expect(loadPlaytestScenario(directory, "scenario.json")).rejects.toMatchObject({
    diagnostic: { code: expect.stringMatching(/^TN_PLAYTEST_SCENARIO_(?:INVALID|STEP_INVALID)$/u) },
  });
});

test("world assertions preserve and validate a deterministic runtime fingerprint", async () => {
  const directory = await makeTempDir("playtest-world-runtime-");
  const scenario = {
    assert: {
      world: {
        runtime: { agent: "browser", core: "0.1.0", randomState: 90210, rapier: null, step: 1 / 60 },
        seed: 90210,
      },
    },
    name: "world-runtime",
    schemaVersion: 1,
    steps: [{ release: true, waitFrames: 1 }],
  };
  await writeFile(join(directory, "scenario.json"), JSON.stringify(scenario));

  const parsed = await loadPlaytestScenario(directory, "scenario.json");

  expect(parsed.assert?.world).toEqual(scenario.assert.world);
});

test("resource assertions preserve an inclusive upper numeric bound", async () => {
  const directory = await makeTempDir("playtest-resource-lte-");
  const scenario = {
    assert: { resources: [{ changed: true, gte: -1, id: "state", lte: 1, path: "levelX" }] },
    name: "resource-lte",
    schemaVersion: 1,
    steps: [{ release: true, waitFrames: 1 }],
  };
  await writeFile(join(directory, "scenario.json"), JSON.stringify(scenario));

  const parsed = await loadPlaytestScenario(directory, "scenario.json");

  expect(parsed.assert?.resources).toEqual(scenario.assert.resources);
});

test("numeric upper bounds parse at every gte assertion site", async () => {
  const assertions = {
    components: [{ component: "Vitals", entity: "player", gte: 0, lte: 100, path: "health" }],
    hud: [{ gte: 0, id: "timer", lte: 59.9, path: "timeRemaining" }],
    resources: [
      { gte: 0, id: "GameState", lte: 59.9, path: "timeRemaining" },
      { anyOf: [{ gte: -1, lte: 1, path: "levelX" }], id: "state" },
    ],
    tags: [{ gte: 0, lte: 3, tag: "coin" }],
  };

  const parsed = await loadScenarioWithAssertions(assertions);

  expect(parsed.assert).toEqual(assertions);
});

test("ordinary path assertions reject a wrong-typed lte", async () => {
  for (const [kind, id] of [["hud", "timer"], ["resources", "GameState"]] as const) {
    await expect(loadScenarioWithAssertions({
      [kind]: [{ changed: true, id, lte: "59.9", path: "timeRemaining" }],
    })).rejects.toMatchObject({
      diagnostic: {
        code: "TN_PLAYTEST_SCENARIO_INVALID",
        message: expect.stringMatching(new RegExp(`assert\\.${kind}\\[0\\]\\.lte.*finite number`, "u")),
      },
    });
  }
});

test("numeric upper bounds enforce an interval and keep the triviality guard", async () => {
  const assertions = { resources: [{ changed: true, gte: 0, id: "GameState", lte: 59.9, path: "timeRemaining" }] };
  const scenario = await loadScenarioWithAssertions(assertions);
  const evaluate = (scenarioToEvaluate: typeof scenario, before: number, after: number) => evaluateRichPlaytestAssertions({
    report: {
      diagnostics: [],
      distance: 0,
      entity: "player",
      expectMoved: false,
      frames: 1,
      trivialityOptOuts: [],
      observations: {
        console: [],
        hud: {},
        network: [],
        resources: { GameState: { after: { timeRemaining: after }, before: { timeRemaining: before } } },
      },
    },
    scenario: scenarioToEvaluate,
  });

  const inRange = evaluate(scenario, 60, 59.5);
  const aboveUpperBound = evaluate(scenario, 60, 60.5);
  const alreadySatisfied = evaluate(scenario, 30, 29);
  const lteOnlyScenario = await loadScenarioWithAssertions({
    resources: [{ changed: true, id: "GameState", lte: 59.9, path: "timeRemaining" }],
  });
  const lteOnlyAlreadySatisfied = evaluate(lteOnlyScenario, 30, 29);

  expect(inRange.assertions.find(({ id }) => id === "resource.GameState.timeRemaining")?.pass).toBe(true);
  expect(aboveUpperBound.assertions.find(({ id }) => id === "resource.GameState.timeRemaining")?.pass).toBe(false);
  expect(alreadySatisfied.assertions.find(({ id }) => id === "resource.GameState.timeRemaining")?.pass).toBe(false);
  expect(alreadySatisfied.diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_ASSERTION_TRIVIAL");
  expect(lteOnlyAlreadySatisfied.assertions.find(({ id }) => id === "resource.GameState.timeRemaining")?.pass).toBe(false);
  expect(lteOnlyAlreadySatisfied.diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_ASSERTION_TRIVIAL");
});

test("world assertions reject unknown runtime fingerprint keys", async () => {
  const directory = await makeTempDir("playtest-world-runtime-invalid-");
  await writeFile(join(directory, "scenario.json"), JSON.stringify({
    assert: { world: { runtime: { agent: "browser", core: "0.1.0", randomState: 1, rapier: null, step: 1 / 60, extra: true }, seed: 1 } },
    name: "invalid-world-runtime",
    schemaVersion: 1,
    steps: [{ release: true, waitFrames: 1 }],
  }));

  await expect(loadPlaytestScenario(directory, "scenario.json")).rejects.toMatchObject({
    diagnostic: { message: expect.stringMatching(/Unknown key 'extra'/u) },
  });
});

test("scenario loading rejects mixed frame and fixed timing", async () => {
  for (const [index, step] of [
    { holdTicks: 5, press: "KeyW", release: true, waitFrames: 5 },
    { holdFrames: 5, press: "KeyW", release: true, waitTicks: 5 },
  ].entries()) {
    const directory = await makeTempDir(`playtest-mixed-timing-${index}-`);
    await writeFile(
      join(directory, "scenario.json"),
      JSON.stringify({ name: "mixed-timing", schemaVersion: 1, steps: [step] }),
    );

    await expect(loadPlaytestScenario(directory, "scenario.json")).rejects.toMatchObject({
      diagnostic: { message: expect.stringMatching(/frame timing or fixed ticks/) },
    });
  }
});

test("scenario loading rejects duplicate step labels", async () => {
  const directory = await makeTempDir("playtest-duplicate-label-");
  await writeFile(join(directory, "scenario.json"), JSON.stringify({
    name: "duplicate-label",
    schemaVersion: 1,
    steps: [
      { label: "pickup", release: true, waitFrames: 1 },
      { label: "pickup", release: true, waitFrames: 1 },
    ],
  }));

  await expect(loadPlaytestScenario(directory, "scenario.json")).rejects.toMatchObject({
    diagnostic: { message: expect.stringMatching(/duplicate label 'pickup'/u) },
  });
});

test("scenario loading rejects a wrong-typed step label", async () => {
  const directory = await makeTempDir("playtest-wrong-label-");
  await writeFile(join(directory, "scenario.json"), JSON.stringify({
    name: "wrong-label",
    schemaVersion: 1,
    steps: [{ label: 42, release: true, waitFrames: 1 }],
  }));

  await expect(loadPlaytestScenario(directory, "scenario.json")).rejects.toMatchObject({
    diagnostic: { message: expect.stringMatching(/label must be a non-empty string/u) },
  });
});

test("scenario loading rejects an atSteps label that was never sampled", async () => {
  const directory = await makeTempDir("playtest-missing-label-");
  await writeFile(join(directory, "scenario.json"), JSON.stringify({
    assert: { resources: [{ atSteps: [{ equals: 1, label: "missing" }], id: "GameState", path: "coins" }] },
    name: "missing-label",
    schemaVersion: 1,
    steps: [{ label: "present", release: true, waitFrames: 1 }],
  }));

  await expect(loadPlaytestScenario(directory, "scenario.json")).rejects.toMatchObject({
    diagnostic: { message: expect.stringMatching(/names step label 'missing'/u) },
  });
});

test("scenario loading rejects an animation atStep that was never sampled", async () => {
  const directory = await makeTempDir("playtest-animation-missing-step-");
  await writeFile(join(directory, "scenario.json"), JSON.stringify({
    assert: { animation: [{ atStep: "missing", clip: "run", entity: "player" }] },
    name: "missing-animation-step",
    schemaVersion: 1,
    steps: [{ label: "present", release: true, waitFrames: 1 }],
  }));

  await expect(loadPlaytestScenario(directory, "scenario.json")).rejects.toMatchObject({
    diagnostic: { message: expect.stringMatching(/names step label 'missing'/u) },
  });
});

test("scenario loading preserves the framebuffer coverage contract", async () => {
  const directory = await makeTempDir("playtest-framebuffer-coverage-");
  const framebufferCoverage = {
    backdrop: [5, 7, 11],
    grid: { columns: 32, rows: 18 },
    tolerance: 8,
    window: { endStep: "loading-end", startStep: "loading-start" },
  };
  await writeFile(join(directory, "scenario.json"), JSON.stringify({
    assert: { framebufferCoverage },
    name: "framebuffer-coverage",
    schemaVersion: 1,
    steps: [
      { label: "loading-start", release: true, waitFrames: 2 },
      { label: "loading-end", release: true, waitFrames: 2 },
    ],
  }));

  const parsed = await loadPlaytestScenario(directory, "scenario.json");

  expect(parsed.assert?.framebufferCoverage).toEqual(framebufferCoverage);
});

test.each([
  ["wrong backdrop shape", { backdrop: [5, 7], tolerance: 8, window: { startStep: "loading", endStep: "loading" } }],
  ["wrong backdrop channel type", { backdrop: [5, "7", 11], tolerance: 8, window: { startStep: "loading", endStep: "loading" } }],
  ["out-of-range backdrop channel", { backdrop: [5, 7, 256], tolerance: 8, window: { startStep: "loading", endStep: "loading" } }],
  ["wrong tolerance type", { backdrop: [5, 7, 11], tolerance: "8", window: { startStep: "loading", endStep: "loading" } }],
  ["out-of-range tolerance", { backdrop: [5, 7, 11], tolerance: 256, window: { startStep: "loading", endStep: "loading" } }],
  ["wrong grid type", { backdrop: [5, 7, 11], grid: [], tolerance: 8, window: { startStep: "loading", endStep: "loading" } }],
  ["wrong grid dimension type", { backdrop: [5, 7, 11], grid: { columns: "32", rows: 18 }, tolerance: 8, window: { startStep: "loading", endStep: "loading" } }],
  ["zero grid dimension", { backdrop: [5, 7, 11], grid: { columns: 32, rows: 0 }, tolerance: 8, window: { startStep: "loading", endStep: "loading" } }],
  ["excessive grid dimension", { backdrop: [5, 7, 11], grid: { columns: 257, rows: 18 }, tolerance: 8, window: { startStep: "loading", endStep: "loading" } }],
  ["wrong window type", { backdrop: [5, 7, 11], tolerance: 8, window: "loading" }],
  ["wrong window label type", { backdrop: [5, 7, 11], tolerance: 8, window: { startStep: 1, endStep: "loading" } }],
])("scenario loading rejects framebuffer coverage with %s", async (_label, framebufferCoverage) => {
  const directory = await makeTempDir("playtest-framebuffer-invalid-");
  await writeFile(join(directory, "scenario.json"), JSON.stringify({
    assert: { framebufferCoverage },
    name: "framebuffer-invalid",
    schemaVersion: 1,
    steps: [{ label: "loading", release: true, waitFrames: 1 }],
  }));

  await expect(loadPlaytestScenario(directory, "scenario.json")).rejects.toMatchObject({
    diagnostic: { code: "TN_PLAYTEST_SCENARIO_INVALID" },
  });
});

test("scenario loading rejects a reversed framebuffer coverage window", async () => {
  const directory = await makeTempDir("playtest-framebuffer-reversed-");
  await writeFile(join(directory, "scenario.json"), JSON.stringify({
    assert: {
      framebufferCoverage: {
        backdrop: [5, 7, 11],
        tolerance: 8,
        window: { endStep: "first", startStep: "second" },
      },
    },
    name: "framebuffer-reversed",
    schemaVersion: 1,
    steps: [
      { label: "first", release: true, waitFrames: 1 },
      { label: "second", release: true, waitFrames: 1 },
    ],
  }));

  await expect(loadPlaytestScenario(directory, "scenario.json")).rejects.toMatchObject({
    diagnostic: { message: expect.stringMatching(/must not precede/u) },
  });
});

test("schema version 1 parser keeps stable diagnostics", async () => {
  const directory = await makeTempDir("playtest-core-");
  await writeFile(join(directory, "scenario.json"), JSON.stringify({
    name: "invalid",
    schemaVersion: 2,
    steps: [],
  }));

  // Faithful translation of node's assert.rejects(promise, validatorFn): assert the
  // promise rejects and that the thrown value satisfies every check in the validator.
  let caught: unknown;
  try {
    await loadPlaytestScenario(directory, "scenario.json");
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PlaytestScenarioError);
  const error = caught as PlaytestScenarioError;
  expect(error.diagnostic.code).toBe("TN_PLAYTEST_SCENARIO_INVALID");
  expect(error.diagnostic.severity).toBe("error");
  expect(error.diagnostic.message).toMatch(/schemaVersion must be 1/);
});

test("scenario loading rejects unknown assertion kinds instead of ignoring them", async () => {
  const directory = await makeTempDir("playtest-core-");
  await writeFile(join(directory, "scenario.json"), JSON.stringify({
    assert: { unknownKind: [] },
    name: "unknown-assertion",
    schemaVersion: 1,
    steps: [{ release: true, waitFrames: 1 }],
  }));

  // Faithful translation of node's assert.rejects(promise, validatorFn).
  let caught: unknown;
  try {
    await loadPlaytestScenario(directory, "scenario.json");
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PlaytestScenarioError);
  const error = caught as PlaytestScenarioError;
  expect(error.diagnostic.code).toBe("TN_PLAYTEST_SCENARIO_INVALID");
  expect(error.diagnostic.message).toMatch(/Unknown key 'unknownKind'/u);
});

test("scenario loading preserves a resource anyOf contract", async () => {
  const directory = await makeTempDir("playtest-resource-anyof-");
  await writeFile(join(directory, "scenario.json"), JSON.stringify({
    assert: { resources: [{ id: "state", anyOf: [{ path: "jumps", gte: 1, changed: true }, { path: "peakRise", gte: 0.5, changed: true }] }] },
    name: "resource-anyof",
    schemaVersion: 1,
    steps: [{ release: true, waitFrames: 1 }],
  }));

  const parsed = await loadPlaytestScenario(directory, "scenario.json");

  expect(parsed.assert?.resources?.[0]).toEqual({
    id: "state",
    anyOf: [
      { path: "jumps", gte: 1, changed: true },
      { path: "peakRise", gte: 0.5, changed: true },
    ],
  });
});

test("resource assertion types reject mixed anyOf and normal path fields", () => {
  const normal: IPlaytestResourceAssertion = { gte: 1, id: "state", path: "jumps" };
  const alternatives: IPlaytestResourceAssertion = {
    anyOf: [{ gte: 1, path: "jumps" }],
    id: "state",
  };
  // @ts-expect-error anyOf is exclusive with normal path assertion fields.
  const mixed: IPlaytestResourceAssertion = {
    anyOf: [{ gte: 1, path: "jumps" }],
    equals: 1,
    id: "state",
  };
  expect(normal).toMatchObject({ id: "state", path: "jumps" });
  expect(alternatives).toMatchObject({ id: "state", anyOf: expect.any(Array) });
  expect(mixed).toMatchObject({ id: "state" });
});

test.each([
  ["empty", []],
  ["malformed", [{ path: "jumps" }]],
])("scenario loading rejects a %s resource anyOf", async (_label, anyOf) => {
  const directory = await makeTempDir("playtest-resource-anyof-invalid-");
  await writeFile(join(directory, "scenario.json"), JSON.stringify({
    assert: { resources: [{ id: "state", anyOf }] },
    name: "invalid-resource-anyof",
    schemaVersion: 1,
    steps: [{ release: true, waitFrames: 1 }],
  }));

  await expect(loadPlaytestScenario(directory, "scenario.json")).rejects.toMatchObject({
    diagnostic: { code: "TN_PLAYTEST_SCENARIO_INVALID" },
  });
});

test("every assertion and setup operation owns known capability metadata", () => {
  const known = new Set(PLAYTEST_CAPABILITY_REGISTRY.map(({ name }) => name));
  for (const entry of [...PLAYTEST_ASSERTION_REGISTRY, ...PLAYTEST_SETUP_REGISTRY]) {
    // `${entry.kind} has no capability metadata`
    expect(entry.requiredCapabilities.length > 0).toBeTruthy();
    // `${entry.kind}: ${capability}`
    entry.requiredCapabilities.forEach((capability) => expect(known.has(capability)).toBeTruthy());
  }
});

test("preflight requirements derive from the registries", () => {
  const required = requiredPlaytestCapabilities({
    assert: { movement: { minDistance: 1 } },
    name: "move",
    schemaVersion: 1,
    setup: { entities: [{ entity: "player", position: [0, 0, 0] }] },
    steps: [{ press: "KeyW", release: true }],
    target: "web",
    viewport: { height: 720, width: 1280 },
    warmupFrames: 0,
  });

  expect(required).toEqual(["browser.input", "browser.screenshot", "entity.observe", "entity.setup"]);
});

/**
 * P2-3 Phase 1 characterization.
 *
 * Every registered assertion family is declared in one scenario and evaluated twice: once against
 * observations crafted so each family passes, once against empty observations. The pinned result
 * ids, their order, the pass/fail verdicts, and the fail-closed diagnostic codes are the contract
 * the P2-3 module split must reproduce without observable change. `camera` produces its result in
 * runner.ts (evaluateCamera), so its coverage here is the base-probe exemption the evaluator
 * already honours (report.follow set).
 */
const FAMILY_SCENARIO_ASSERTS = {
  tone: [{ mean: { min: 60 } }],
  aerodynamics: [{ controls: [{ sign: "positive", surface: "elevator" }], entity: "aircraft", minForceSamples: 1 }],
  animation: [{ advancedFrames: 2, clip: "run", entity: "player" }],
  audio: [{ cue: "speech:p01", maxPlays: 1, minGapMs: 500, minPlays: 1 }],
  camera: { entity: "camera.main", follows: "player", targetInViewport: true },
  components: [{ changed: true, component: "health", entity: "player", equals: 2 }],
  contacts: [{ entity: "fox", kind: "trigger", minCount: 1, with: "coin" }],
  deviceMetrics: { maxTemperatureRiseC: 5, notThermallyConfounded: true },
  diagnostics: { noConsoleErrors: true, noNetworkErrors: true, noRuntimeDiagnostics: true, runtimeReady: true },
  framebufferCoverage: { backdrop: [5, 7, 11], tolerance: 8, window: { endStep: "loading-end", startStep: "loading-start" } },
  hud: [{ id: "score-label", textIncludes: "Score" }],
  movement: { entity: "player", minDistance: 0.5 },
  occluded: [{ entity: "listener", target: "emitter" }],
  overlayNodes: [{ equals: "true", overlayId: "game-ui", selector: "[data-testid=fps-crosshair]" }],
  parity: { minFpsRatio: 0.85, reference: { fps: 100, serial: "fixture-phone", thermallyConfounded: false }, referenceReport: "native.json", referenceSide: "native" },
  performance: { maxDrawCalls: 10, maxFrameMsP95: 16, maxTriangles: 10_000 },
  reachability: { artifact: "artifacts/envelope.json", entities: ["platform.a", "platform.b"] },
  resources: [{ changed: true, gte: 1, id: "GameState", path: "coins" }],
  renderChain: { tier: "high", velocity: { maxRejectionFraction: 0.2 } },
  pipelineCensus: {
    maxNodeBuildsAfterWarmUpSettled: 0,
    maxRenderPipelineCreationsAfterWarmUpSettled: 0,
  },
  scene: { cameraClearsScene: true, fogClearsScene: true, litMaterialsAreLit: true, minVisibleLights: 1 },
  sceneNodes: [{ select: { nameContains: "crate" }, visible: true }],
  footSlip: [{ atStep: "loading-end", feet: ["footL", "footR"], maxSlip: 0.35 }],
  sightLine: { maxBlockedRatio: 0.02 },
  hudAudit: { minContrast: 3, noDebugText: true },
  engineCost: { maxPerFrame: { bridgeCrossings: 2000 }, source: "family dispatch fixture bound" },
  causedBy: [
    {
      cause: { contact: { entity: "fox", kind: "trigger", with: "coin" } },
      effect: { becomes: "won", path: "states.player" },
      neverBefore: true,
      withinTicks: 8,
    },
  ],
  startup: { maxReadyMs: 60_000 },
  settled: [{ entity: "crate", minBodies: 2 }],
  signals: [{ minCount: 1, name: "collected" }],
  states: [{ entity: "player", equals: "won" }],
  tags: [{ gte: 1, tag: "coin" }],
  visibility: [{ entity: "player", minProjectedPixels: 10 }],
  visual: [{ frameDiff: { minChangedPixelRatio: 0.01 }, region: { height: 10, minNonblankPixelRatio: 0.1, width: 10, x: 0, y: 0 } }],
  world: { seed: 90210 },
} as const;

/** Result ids of the all-families scenario when every family's evidence arrived. */
const FAMILY_PASS_IDS = [
  "tone.0.mean",
  "deviceMetrics.observed",
  "deviceMetrics.notThermallyConfounded",
  "deviceMetrics.maxTemperatureRiseC",
  "framebufferCoverage",
  "reachability.0.platform.a.platform.b",
  "overlayNode.game-ui:[data-testid=fps-crosshair]",
  "visual.0.frameDiff",
  "visual.0.region",
  "parity.fpsRatio",
  "parity.sameDevice",
  "parity.thermalComparability",
  "performance.samples",
  "performance.maxFrameMsP95",
  "performance.maxDrawCalls",
  "performance.maxTriangles",
  "resource.GameState.coins",
  "signal.collected",
  "audio.speech:p01",
  "world.seed",
  "component.player.health.value",
  "aerodynamics.0",
  "hud.score-label",
  "tags.coin",
  "states.player",
  "renderChain.tier",
  "renderChain.velocity.rejectionFraction",
  "pipelineCensus.maxNodeBuildsAfterWarmUpSettled",
  "pipelineCensus.maxRenderPipelineCreationsAfterWarmUpSettled",
  "scene.minVisibleLights",
  "scene.litMaterialsAreLit",
  "scene.fogClearsScene",
  "scene.cameraClearsScene",
  "sceneNodes[0].count",
  "sceneNodes[0].visible",
  "footSlip[0].slip",
  "sightLine",
  "hudAudit.debugText",
  "hudAudit.contrast",
  "engineCost.observed",
  "engineCost.maxPerFrame.bridgeCrossings",
  "causedBy[0].neverBefore",
  "causedBy[0].withinTicks",
  "startup.readyMs",
  "diagnostics",
  "movement.distance",
  "visibility.player",
  "contact.fox",
  "settled.crate",
  "occluded.listener",
  "animation.player",
] as const;

async function loadFamilyScenario() {
  const directory = await makeTempDir("playtest-family-contract-");
  await mkdir(join(directory, "artifacts"), { recursive: true });
  await writeFile(
    join(directory, "artifacts", "envelope.json"),
    JSON.stringify({ jump: { fallDistanceToGround: 4, forwardReach: 3, maxRise: 1.2 } }),
  );
  await writeFile(join(directory, "scenario.json"), JSON.stringify({
    assert: FAMILY_SCENARIO_ASSERTS,
    name: "family-contract",
    schemaVersion: 1,
    steps: [
      { label: "loading-start", release: true, waitFrames: 1 },
      { label: "loading-end", release: true, waitFrames: 1 },
    ],
    subject: "player",
    target: "web",
    viewport: { height: 720, width: 1280 },
  }));
  return loadPlaytestScenario(directory, "scenario.json");
}

function familyReportObservations(fulfilled: boolean) {
  if (!fulfilled) {
    return {
      console: [],
      hud: {},
      network: [],
      resources: {},
    };
  }
  const physicsSample = (primitives: unknown[]) => ({ artifact: { primitives }, label: undefined });
  return {
    tone: [{ code: "TN_TONE", label: "after.png", mean: 100, p1: 0, p50: 100, p99: 200, clipFraction: 0, blackFraction: 0 }],
    components: { player: { health: { after: 2, before: 3 } } },
    console: [
      { level: "log", text: `TN_FRAME_BUDGET:${JSON.stringify({ gpu: { p95: 4, samples: 8 } })}` },
      { level: "log", text: `TN_FRAME_BUDGET:${JSON.stringify({ counters: { bridgeCrossings: { max: 900, mean: 800, p50: 800, p95: 900, p99: 900, samples: 300 }, engine: {} }, window: 1 })}` },
    ],
    deviceMetrics: {
      available: true,
      errors: [],
      samples: [{ at: 0 }, { at: 9000 }],
      serial: "fixture-phone",
      source: "adb",
      verdict: {
        endTemperatureC: 35.1,
        endThermalStatus: 0,
        maxThermalStatus: 0,
        peakTemperatureC: 35.1,
        powerRailWindowAdvanced: null,
        reasons: [],
        startTemperatureC: 34.7,
        startThermalStatus: 0,
        temperatureRiseC: 0.4,
        thermallyConfounded: false,
      },
    },
    effectLog: {
      entries: [
        { kind: "service", payload: { request: { entity: "aircraft", inputs: { surfaces: { elevator: 0.5 } } } }, service: "physics.aerodynamics.setInputs" },
        { kind: "service", payload: { request: { entity: "listener", target: "emitter" }, result: { hit: true } }, service: "physics.raycast" },
      ],
    },
    entityTransforms: {
      "platform.a": { halfExtents: [1, 1, 1], position: [0, 0, 0] },
      "platform.b": { halfExtents: [1, 1, 1], position: [1, 0.5, 0] },
    },
    framebufferCoverage: { boundarySource: "scenario-steps", frameCount: 3, windowCompleted: true, windowStarted: true },
    hud: { "score-label": { after: { text: "Score: 10" }, before: { text: "—" } } },
    network: [],
    overlayNodes: { "game-ui:[data-testid=fps-crosshair]": { after: { text: "true", visible: true } } },
    performanceSeries: [{ drawCalls: 5, frameMs: 10, phases: { render: 1, update: 0.1 }, triangles: 100 }],
    physicsDebugBefore: physicsSample([
      { category: "sleep", entity: "crate.1", value: 0 },
      { category: "sleep", entity: "crate.2", value: 0 },
    ]),
    physicsDebugSeries: [{
      label: "loading-end",
      snapshot: { artifact: { primitives: [
        { category: "aero", entity: "aircraft", from: [0, 0, 0], to: [0, 1, 0], value: 1.5 },
        { category: "sleep", entity: "crate.1", value: 1 },
        { category: "sleep", entity: "crate.2", value: 1 },
      ] } },
      tick: 2,
    }],
    resourceSeries: [],
    startup: {
      phase: "ready",
      progress: 1,
      rule: "sustained-frames",
      timeline: { enteredMs: 900, loadStartedMs: 200, readyMs: 2400 },
    },
    renderChain: {
      dropped: [],
      requested: ["bloom"],
      source: "pinned",
      stages: ["bloom"],
      tier: "high",
      velocity: {
        measurementFrame: 3,
        provisioned: false,
        required: false,
        source: null,
        rejectionFraction: 0.1,
      },
    },
    pipelineCensus: {
      version: 1,
      complete: true,
      overflowed: false,
      backend: { kind: "webgpu", identity: "fixture-backend" },
      clock: { source: "performance", originMs: 0 },
      build: { identity: "fixture-build" },
      adapter: { identity: "fixture-adapter", thermal: "unavailable" },
      firstPresent: { boundaryMs: 2, eventsSettled: 1 },
      warmUpSettled: { boundaryMs: 1, eventsSettled: 1, nodeBuilds: 1, renderPipelineCreations: 1 },
      counts: {
        lookups: 1,
        creations: 1,
        failures: 0,
        pending: 0,
        uniquePrograms: 1,
        uniquePipelines: 1,
        recordedEvents: 1,
        droppedEvents: 0,
        nodeBuilds: 1,
      },
      events: [{
        sequence: 1,
        programIdentity: "fixture-program",
        pipelineIdentity: "fixture-pipeline",
        kind: "render",
        pass: "main",
        mode: "sync",
        status: "created",
        vertex: { bytes: 1, hash: "fixture-vertex" },
        provenance: { material: { name: "fixture" }, unknown: false },
        reasons: ["fixture"],
        startedMs: 0,
        settledMs: 1,
        nodeBuilds: 1,
        beforeFirstPresent: true,
        beforeWarmUpSettled: true,
      }],
      incompleteReasons: [],
    },
    resources: { GameState: { after: { coins: 2 }, before: { coins: 0 } } },
    // A stride matched to the ground: each foot holds still for half of a 20-tick cycle.
    footSlip: [{
      entity: "player",
      feet: ["footL", "footR"],
      label: "loading-end",
      samples: Array.from({ length: 41 }, (_, tick) => {
        const foot = (offset: number) => {
          const phase = (tick + offset) % 20;
          const planted = Math.floor((tick + offset) / 20) * 2 + 0.3;
          return phase < 10 ? [0, -0.9, planted] : [0, -0.8, planted + (phase - 9) * 0.2];
        };
        return { body: [0, 0, tick * 0.1], feet: [foot(0), foot(10)] };
      }),
    }],
    sightLine: {
      entity: "player",
      samples: [{ blocked: false, blockers: [], distance: 5 }],
    },
    hudAudit: {
      items: [{ background: [10, 10, 12, 1], color: [255, 255, 255, 1], fontSizePx: 14, selector: "div.hud", text: "Score 10" }],
    },
    sceneNodes: [
      {
        matched: 1,
        nodes: [
          {
            name: "crate",
            path: "Scene/crate",
            position: [0, 1, 0],
            scale: [1, 1, 1],
            type: "Mesh",
            visible: true,
            visibleInTree: true,
          },
        ],
        selector: { nameContains: "crate" },
        truncated: false,
      },
    ],
    scene: {
      background: "color:#101018",
      camera: { far: 500, forward: [0, 0, -1], fov: 60, near: 0.1, position: [0, 2, 8], type: "PerspectiveCamera" },
      lights: [{ color: "#ffffff", intensity: 2, type: "DirectionalLight", visible: true }],
      materials: { MeshStandardMaterial: 4 },
      objects: 18,
      truncated: false,
      worldExtent: { max: [12, 4, 12], min: [-12, 0, -12] },
    },
    runtimeDiagnostics: { scene: { renderedEntities: [{ id: "player", projectedBounds: { max: [0.5, 0.5], min: [-0.5, -0.5] }, visible: true }] } },
    runtimeObservations: {
      gameplay: {
        animation: { player: { advancedFrames: 5, clip: "run", finished: true } },
        audio: {
          cues: { "speech:p01": 1 },
          recentCues: [
            { atMs: 2000, cue: "speech:p02" },
            { atMs: 3200, cue: "speech:p01" },
          ],
        },
        contacts: [{ entity: "fox", kind: "trigger", tick: 4, with: "coin" }],
        states: { player: "won" },
        tags: { coin: { count: 3 } },
        transitions: [{ from: "playing", path: "states.player", tick: 5, to: "won" }],
        world: { seed: 90210 },
      },
    },
    signalSeries: [{ label: "loading-end", signals: [{ entity: "player", name: "collected" }], tick: 1 }],
    signals: [{ entity: "player", name: "collected" }],
    visual: {
      changedPixelRatio: 0.5,
      comparisonSource: "after.png",
      nonblankRegions: [{ height: 10, nonblankPixelRatio: 0.5, width: 10, x: 0, y: 0 }],
    },
  };
}

test("should preserve every assertion family's result contract", async () => {
  const scenario = await loadFamilyScenario();
  const evaluate = async (observations: Record<string, unknown>) => evaluateRichPlaytestAssertions({
    report: {
      // A distance is the length of a line between two observations, so a report that carries one
      // carries both. minDistance now says so — it refuses to read a fallback zero as a
      // measurement, the way maxDistance already did — and this fixture stands for a fulfilled
      // run, which is a run that observed its subject.
      after: { frame: 10, position: [5, 0, 0], tick: 10 },
      before: { frame: 0, position: [0, 0, 0], tick: 0 },
      diagnostics: [],
      distance: 5,
      // occluded reads the retained effect log from the report, not from observations.
      effectLog: (observations as { effectLog?: unknown }).effectLog,
      entity: "player",
      expectMoved: false,
      follow: { entity: "camera.main", within: 10 },
      frames: 10,
      observations: observations as never,
      trivialityOptOuts: [],
    },
    scenario,
  });

  const fulfilled = await evaluate(familyReportObservations(true));

  // Family coverage first: every declared registry kind produced at least one result under its
  // own prefix (camera rides the base probe via report.follow).
  for (const entry of PLAYTEST_ASSERTION_REGISTRY) {
    if ((scenario.assert as Record<string, unknown>)[entry.kind] === undefined) continue;
    const covered = fulfilled.assertions.some(({ id }) => id.startsWith(entry.resultIdPrefix))
      || (entry.kind === "movement" && (fulfilled.assertions.some(({ id }) => id.startsWith("movement."))))
      || (entry.kind === "camera");
    expect(covered, `RED observed: assertion family result missing for '${entry.kind}'`).toBe(true);
  }

  expect(fulfilled.assertions.map(({ id }) => id), "RED observed: assertion family result ordering changed").toEqual([...FAMILY_PASS_IDS]);
  expect(fulfilled.assertions.every(({ pass }) => pass === true), "RED observed: assertion family verdict changed").toBe(true);
  expect(fulfilled.diagnostics, "RED observed: assertion family diagnostics changed").toEqual([]);

  // Fail-closed pin: with no evidence at all every family still emits exactly one failing result
  // (visual collapses to its not-evaluated placeholder) and names a diagnostic code.
  const empty = await evaluate(familyReportObservations(false));
  expect(empty.assertions.map(({ id }) => id), "RED observed: assertion family result ordering changed").toEqual([
    "tone.0.observed",
    "deviceMetrics.observed",
    "framebufferCoverage",
    "reachability.0.platform.a.platform.b",
    "overlayNode.game-ui:[data-testid=fps-crosshair]",
    "visual.0",
    "parity.observed",
    "performance.samples",
    "performance.maxFrameMsP95",
    "performance.maxDrawCalls",
    "performance.maxTriangles",
    "resource.GameState.coins",
    "signal.collected",
    "audio.speech:p01",
    "world.seed",
    "component.player.health.value",
    "aerodynamics.0",
    "hud.score-label",
    "tags.coin",
    "states.player",
    "renderChain.tier",
    "renderChain.velocity.rejectionFraction",
    "pipelineCensus.maxNodeBuildsAfterWarmUpSettled",
    "pipelineCensus.maxRenderPipelineCreationsAfterWarmUpSettled",
    // One result, not four: with no scene observed at all there is nothing to bound, and the
    // family says so once rather than failing each bound against nothing.
    "scene.observed",
    "sceneNodes.observed",
    "footSlip[0].observed",
    "sightLine.observed",
    "hudAudit.observed",
    "engineCost.observed",
    "causedBy.observed",
    "startup.readyMs",
    "diagnostics",
    "movement.distance",
    "visibility.player",
    "contact.fox",
    "settled.crate",
    "occluded.listener",
    "animation.player",
  ]);
  // Exactly two results survive with no evidence: `diagnostics` is the health check whose clean
  // channels are empty channels, and `movement.distance` reads the report-level aggregate, which
  // this harness still reports. Everything else must fail closed.
  expect(empty.assertions.filter(({ pass }) => pass).map(({ id }) => id), "RED observed: fail-closed families passed on missing evidence").toEqual([
    "diagnostics",
    "movement.distance",
  ]);
  expect(empty.diagnostics.map(({ code }) => code), "RED observed: fail-closed diagnostic codes changed").toEqual([
    "TN_PLAYTEST_TONE_UNOBSERVED",
    "TN_PLAYTEST_DEVICE_METRICS_UNAVAILABLE",
    "TN_PLAYTEST_FRAMEBUFFER_WINDOW_NOT_REACHED",
    "TN_PLAYTEST_REACHABILITY_ASSERTION_FAILED",
    "TN_PLAYTEST_OVERLAY_NODE_ASSERTION_FAILED",
    "TN_PLAYTEST_ASSERTION_NOT_EVALUATED",
    "TN_PLAYTEST_PARITY_SERIES_MISSING",
    "TN_PLAYTEST_PERFORMANCE_SAMPLES_MISSING",
    "TN_PLAYTEST_PERFORMANCE_ASSERTION_FAILED",
    "TN_PLAYTEST_PERFORMANCE_ASSERTION_FAILED",
    "TN_PLAYTEST_PERFORMANCE_ASSERTION_FAILED",
    "TN_PLAYTEST_RESOURCE_ASSERTION_FAILED",
    "TN_PLAYTEST_SIGNAL_NOT_OBSERVED",
    "TN_PLAYTEST_AUDIO_ASSERTION_FAILED",
    "TN_PLAYTEST_WORLD_ASSERTION_FAILED",
    "TN_PLAYTEST_COMPONENT_ASSERTION_FAILED",
    "TN_PLAYTEST_AERODYNAMICS_ASSERTION_FAILED",
    "TN_PLAYTEST_HUD_ASSERTION_FAILED",
    "TN_PLAYTEST_TAG_COUNT_ASSERTION_FAILED",
    "TN_PLAYTEST_STATE_ASSERTION_FAILED",
    "TN_PLAYTEST_RENDER_CHAIN_UNOBSERVABLE",
    "TN_PLAYTEST_RENDER_CHAIN_UNOBSERVABLE",
    "TN_PLAYTEST_PIPELINE_CENSUS_UNOBSERVABLE",
    "TN_PLAYTEST_PIPELINE_CENSUS_UNOBSERVABLE",
    "TN_PLAYTEST_SCENE_UNOBSERVED",
    "TN_PLAYTEST_SCENE_NODES_UNOBSERVED",
    "TN_PLAYTEST_FOOT_SLIP_UNOBSERVED",
    "TN_PLAYTEST_SIGHT_LINE_UNOBSERVED",
    "TN_PLAYTEST_HUD_AUDIT_UNOBSERVED",
    "TN_PLAYTEST_ENGINE_COST_UNOBSERVED",
    "TN_PLAYTEST_TRANSITIONS_UNOBSERVED",
    "TN_PLAYTEST_STARTUP_UNOBSERVABLE",
    "TN_PLAYTEST_VISIBILITY_FAILED",
    "TN_PLAYTEST_CONTACT_NOT_OBSERVED",
    "TN_PLAYTEST_PHYSICS_NOT_SETTLED",
    "TN_PLAYTEST_OCCLUSION_NOT_OBSERVED",
    "TN_PLAYTEST_ANIMATION_NOT_OBSERVED",
  ]);
  expect(empty.diagnostics.every(({ severity }) => severity === "error"), "RED observed: diagnostic severity changed").toBe(true);
});

/**
 * P2-3 Phase 2. Each registered family is evaluated on its own, through the package's public
 * entry, so the split modules cannot hide a family whose dispatch mapping went missing. `camera`
 * evaluates in runner.ts, so its exemption here is the base probe (report.follow).
 */
test("should evaluate all registered families through the public entry", async () => {
  const directory = await makeTempDir("playtest-family-dispatch-");
  await mkdir(join(directory, "artifacts"), { recursive: true });
  await writeFile(
    join(directory, "artifacts", "envelope.json"),
    JSON.stringify({ jump: { fallDistanceToGround: 4, forwardReach: 3, maxRise: 1.2 } }),
  );
  const observations = familyReportObservations(true);

  for (const entry of PLAYTEST_ASSERTION_REGISTRY) {
    await writeFile(join(directory, "scenario.json"), JSON.stringify({
      assert: { [entry.kind]: (FAMILY_SCENARIO_ASSERTS as Record<string, unknown>)[entry.kind] },
      name: "family-dispatch",
      schemaVersion: 1,
      steps: [
        { label: "loading-start", release: true, waitFrames: 1 },
        { label: "loading-end", release: true, waitFrames: 1 },
      ],
      subject: "player",
      target: "web",
      viewport: { height: 720, width: 1280 },
    }));
    const scenario = await loadPlaytestScenario(directory, "scenario.json");
    const evaluated = evaluateRichPlaytestAssertions({
      report: {
        diagnostics: [],
        distance: 5,
        effectLog: (observations as { effectLog?: unknown }).effectLog,
        entity: "player",
        expectMoved: false,
        follow: { entity: "camera.main", within: 10 },
        frames: 10,
        observations: observations as never,
        trivialityOptOuts: [],
      },
      scenario,
    });
    const mapped = evaluated.assertions.some(({ id }) => id.startsWith(entry.resultIdPrefix));
    expect(mapped || entry.kind === "camera", `RED observed: registered family has no evaluator for '${entry.kind}'`).toBe(true);
  }
});


test("startTick alone requires fixed-step capability and preserves safe integer anchors", async () => {
  const directory = await makeTempDir("playtest-start-tick-");
  for (const startTick of [0, 600, Number.MAX_SAFE_INTEGER]) {
    await writeFile(join(directory, "scenario.json"), JSON.stringify({ name: "anchor", schemaVersion: 1, startTick, steps: [{ waitFrames: 1 }] }));
    const parsed = await loadPlaytestScenario(directory, "scenario.json");
    expect(parsed.startTick).toBe(startTick);
    expect(requiredPlaytestCapabilities(parsed)).toContain("runtime.fixedStep");
  }
});

test.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "600", null, true])("startTick rejects invalid anchor %s", async (startTick) => {
  const directory = await makeTempDir("playtest-start-tick-invalid-");
  await writeFile(join(directory, "scenario.json"), JSON.stringify({ name: "anchor", schemaVersion: 1, startTick, steps: [{ waitFrames: 1 }] }));
  await expect(loadPlaytestScenario(directory, "scenario.json")).rejects.toThrow("startTick");
});
