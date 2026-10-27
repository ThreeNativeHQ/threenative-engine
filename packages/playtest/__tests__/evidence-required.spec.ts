import { makeTempDir } from "../../../test-support/temp-dir.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";

import { evaluateRichPlaytestAssertions, loadPlaytestScenario, type IPlaytestObservations, type IPlaytestScenario } from "../src/index.js";

// Assertions that used to pass on an empty evidence channel.
//
// The runner is the only producer of IPlaytestObservations in this repo. Its
// before/after channels and labeled series are deliberately optional, so
// "the observation is missing" is not an edge case; every assertion that reads
// one of those channels has to fail closed.
//
// Each test below was observed RED before the fix: the assertion returned
// pass:true against observations that contained nothing at all.

const EMPTY_OBSERVATIONS: IPlaytestObservations = {
  console: [],
  hud: {},
  network: [],
  resources: {},
};

async function evaluate(
  assert: unknown,
  report: Partial<Parameters<typeof evaluateRichPlaytestAssertions>[0]["report"]> = {},
  steps: IPlaytestScenario["steps"] = [{ release: true, waitFrames: 1 }],
) {
  const projectPath = await makeTempDir("playtest-evidence-");
  await writeFile(
    join(projectPath, "scenario.json"),
    JSON.stringify({
      assert,
      name: "evidence",
      schemaVersion: 1,
      steps,
      subject: "player",
    }),
  );
  const scenario = await loadPlaytestScenario(projectPath, "scenario.json");
  return evaluateRichPlaytestAssertions({
    report: {
      diagnostics: [],
      distance: 0,
      entity: "player",
      expectMoved: false,
      frames: 1,
      observations: EMPTY_OBSERVATIONS,
      trivialityOptOuts: [],
      ...report,
    },
    scenario,
  });
}

test("'changed: false' fails when the value was never observed at all", async () => {
  // jsonEqual(undefined, undefined) is true, because JSON.stringify(undefined) is
  // undefined on both sides. A HUD node that does not exist therefore satisfied
  // "this value did not change" — and `observations.hud` is always `{}`, so every
  // hud changed:false assertion in existence was green.
  const evaluated = await evaluate({ hud: [{ id: "score-label", changed: false }] });

  expect(evaluated.assertions.find(({ id }) => id === "hud.score-label")?.pass, "RED observed: required observation was accepted").toBe(false);
});

test("a resource anyOf passes one observed alternative under the same resource id", async () => {
  const evaluated = await evaluate(
    {
      resources: [{
        id: "state",
        anyOf: [
          { path: "jumps", gte: 1, changed: true },
          { path: "peakRise", gte: 0.5, changed: true },
        ],
      }],
    },
    {
      observations: {
        ...EMPTY_OBSERVATIONS,
        resources: { state: { before: { jumps: 0, peakRise: 0 }, after: { jumps: 0, peakRise: 0.75 } } },
      },
    },
  );

  expect(evaluated.assertions).toContainEqual(expect.objectContaining({ id: "resource.state.anyOf", pass: true }));
  expect(evaluated.diagnostics).toEqual([]);
});

test("a resource range requires both inclusive bounds", async () => {
  const evaluated = await evaluate(
    { resources: [{ changed: true, gte: -1, id: "GameState", lte: 1, path: "levelX" }] },
    {
      observations: {
        ...EMPTY_OBSERVATIONS,
        resources: { GameState: { before: { levelX: -99 }, after: { levelX: 0.5 } } },
      },
    },
  );
  const outside = await evaluate(
    { resources: [{ changed: true, gte: -1, id: "GameState", lte: 1, path: "levelX" }] },
    {
      observations: {
        ...EMPTY_OBSERVATIONS,
        resources: { GameState: { before: { levelX: -99 }, after: { levelX: 1.5 } } },
      },
    },
  );

  expect(evaluated.assertions.find(({ id }) => id === "resource.GameState.levelX")?.pass).toBe(true);
  expect(outside.assertions.find(({ id }) => id === "resource.GameState.levelX")?.pass).toBe(false);
});

test("a resource anyOf fails closed when no alternative passes", async () => {
  const evaluated = await evaluate(
    { resources: [{ id: "state", anyOf: [{ path: "jumps", gte: 1, changed: true }] }] },
    {
      observations: {
        ...EMPTY_OBSERVATIONS,
        resources: { state: { before: { jumps: 0 }, after: { jumps: 0 } } },
      },
    },
  );

  expect(evaluated.assertions).toContainEqual(expect.objectContaining({ id: "resource.state.anyOf", pass: false }));
  expect(evaluated.diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_RESOURCE_ANY_OF_ASSERTION_FAILED");
});

test("'changed: false' still passes for a value that exists and held steady", async () => {
  // Positive control for the guard above: failing closed must not mean failing
  // always. A held invariant is the entire point of changed:false.
  const evaluated = await evaluate(
    { resources: [{ id: "GameState", path: "lives", changed: false }] },
    { observations: { ...EMPTY_OBSERVATIONS, resources: { GameState: { before: { lives: 3 }, after: { lives: 3 } } } } },
  );

  expect(evaluated.assertions.find(({ id }) => id === "resource.GameState.lives")?.pass).toBe(true);
});

test("'changed: false' fails when the value did change", async () => {
  const evaluated = await evaluate(
    { resources: [{ id: "GameState", path: "lives", changed: false }] },
    { observations: { ...EMPTY_OBSERVATIONS, resources: { GameState: { before: { lives: 3 }, after: { lives: 2 } } } } },
  );

  expect(evaluated.assertions.find(({ id }) => id === "resource.GameState.lives")?.pass).toBe(false);
});

test("movement.maxDistance fails when the entity was never observed", async () => {
  // `distance` defaults to 0 when the entity is absent from the snapshot, so the
  // blocked-movement proof — the one assertion whose purpose is to show something
  // did NOT move — was satisfied by observing nothing. A typo in the entity id
  // was enough to make it green.
  const evaluated = await evaluate({ movement: { entity: "ghost", maxDistance: 0.2 } });

  expect(evaluated.assertions.find(({ id }) => id === "movement.maxDistance")?.pass).toBe(false);
});

test("movement.maxDistance still passes for an entity that was observed and stayed put", async () => {
  const evaluated = await evaluate(
    { movement: { entity: "player", maxDistance: 0.2 } },
    {
      after: { frame: 1, position: [0, 0, 0.05], tick: 1 },
      before: { frame: 0, position: [0, 0, 0], tick: 0 },
      distance: 0.05,
    },
  );

  expect(evaluated.assertions.find(({ id }) => id === "movement.maxDistance")?.pass).toBe(true);
});

test("movement.maxDistance still fails for an entity that moved too far", async () => {
  const evaluated = await evaluate(
    { movement: { entity: "player", maxDistance: 0.2 } },
    {
      after: { frame: 1, position: [0, 0, 5], tick: 1 },
      before: { frame: 0, position: [0, 0, 0], tick: 0 },
      distance: 5,
    },
  );

  expect(evaluated.assertions.find(({ id }) => id === "movement.maxDistance")?.pass).toBe(false);
});

test("movement.reachesPositionWithin considers the final observed position", async () => {
  const evaluated = await evaluate(
    { movement: { entity: "player", reachesPositionWithin: { maxDistance: 0.25, position: [9, 0, 0] } } },
    {
      after: { frame: 1, position: [8.9, 0, 0], tick: 1 },
      before: { frame: 0, position: [0, 0, 0], tick: 0 },
      effectLog: { entries: [{ kind: "service", payload: { result: { entity: "player", resolved: [0, 0, 0] } }, service: "character.move" }] },
    },
  );

  expect(evaluated.assertions.find(({ id }) => id === "movement.reachesPosition")?.pass).toBe(true);
});

test("movement.reachesPositionWithin accepts a final labeled observation", async () => {
  const evaluated = await evaluate(
    { movement: { entity: "player", reachesPositionWithin: { atStep: "final", maxDistance: 0.25, position: [9, 0, 0] } } },
    {
      after: { frame: 1, position: [8.9, 0, 0], tick: 1 },
      before: { frame: 0, position: [0, 0, 0], tick: 0 },
    },
    [{ label: "final", release: true, waitFrames: 1 }],
  );

  expect(evaluated.assertions.find(({ id }) => id === "movement.reachesPosition")?.pass).toBe(true);
});

test("world runtime fingerprints pass only when the complete metadata matches", async () => {
  const runtime = { agent: "browser", core: "0.1.0", randomState: 90210, rapier: null, step: 1 / 60 };
  const evaluated = await evaluate(
    { world: { runtime, seed: 90210 } },
    {
      observations: {
        ...EMPTY_OBSERVATIONS,
        runtimeObservations: { gameplay: { states: {}, animation: {}, world: { runtime, seed: 90210 } } },
      } as IPlaytestObservations,
    },
  );
  expect(evaluated.assertions.find(({ id }) => id === "world.seed")).toEqual(expect.objectContaining({ pass: true }));

  const mismatched = await evaluate(
    { world: { runtime, seed: 90210 } },
    {
      observations: {
        ...EMPTY_OBSERVATIONS,
        runtimeObservations: {
          gameplay: { states: {}, animation: {}, world: { runtime: { ...runtime, randomState: 90211 }, seed: 90210 } },
        },
      } as IPlaytestObservations,
    },
  );
  expect(mismatched.assertions.find(({ id }) => id === "world.seed")).toEqual(expect.objectContaining({ pass: false }));
  expect(mismatched.diagnostics[0]?.observedRuntimePath).toContain("world/runtime");
});

test("an animation assertion requires matching evidence rather than defaulting to satisfied", async () => {
  // `minCount` was 0 unless `entered` or `advancedFrames` was set, so a bare
  // { entity, clip } assertion evaluated `0 >= 0` and passed with no effect log.
  const evaluated = await evaluate({ animation: [{ entity: "player", clip: "run" }] });

  expect(evaluated.assertions.find(({ id }) => id === "animation.player")?.pass).toBe(false);
  expect(evaluated.diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_ANIMATION_NOT_OBSERVED");
});

test("advancedFrames requires that many matching entries, not merely one", async () => {
  const effectLog = {
    entries: [{ entity: "player", service: "animation.play", value: { clip: "run" } }],
  };

  const evaluated = await evaluate({ animation: [{ entity: "player", clip: "run", advancedFrames: 5 }] }, { effectLog });

  expect(evaluated.assertions.find(({ id }) => id === "animation.player")?.pass).toBe(false);
});

test("an animation assertion passes once its evidence is present", async () => {
  const effectLog = {
    entries: Array.from({ length: 5 }, () => ({ entity: "player", service: "animation.play", value: { clip: "run" } })),
  };

  const evaluated = await evaluate({ animation: [{ entity: "player", clip: "run", advancedFrames: 5 }] }, { effectLog });

  expect(evaluated.assertions.find(({ id }) => id === "animation.player")?.pass).toBe(true);
});

test("an animation assertion reads the runtime animation channel", async () => {
  const evaluated = await evaluate(
    { animation: [{ entity: "player", clip: "run", advancedFrames: 5 }] },
    {
      observations: {
        ...EMPTY_OBSERVATIONS,
        runtimeObservations: {
          gameplay: { animation: { player: { advancedFrames: 8, clip: "run" } }, states: {} },
        },
      } as IPlaytestObservations,
    },
  );

  expect(evaluated.assertions.find(({ id }) => id === "animation.player")?.pass).toBe(true);
});

test("all six held-value assertions reject an unchanged pre-run match", async () => {
  const physicsSnapshot = {
    artifact: {
      primitives: [{ category: "sleep", entity: "body", value: 1 }],
    },
  };
  const effectLog = {
    entries: [{
      payload: { request: { entity: "listener", target: "wall" }, result: { hit: true } },
      service: "physics.raycast",
    }],
  };
  const runtime = {
    gameplay: {
      animation: { player: { advancedFrames: 4, clip: "run" } },
      states: { player: "idle" },
      tags: { coin: { count: 1 } },
    },
    gameplayBefore: {
      animation: { player: { advancedFrames: 4, clip: "run" } },
      states: { player: "idle" },
      tags: { coin: { count: 1 } },
    },
  };
  const diagnostics = {
    scene: {
      renderedEntities: [{
        id: "player",
        projectedBounds: { max: [0.5, 0.5], min: [-0.5, -0.5] },
        visible: true,
      }],
    },
  };
  const evaluated = await evaluate(
    {
      animation: [{ advancedFrames: 4, clip: "run", entity: "player" }],
      occluded: [{ entity: "listener", target: "wall" }],
      settled: [{ entity: "body", minBodies: 1 }],
      states: [{ entity: "player", equals: "idle" }],
      tags: [{ count: 1, tag: "coin" }],
      visibility: [{ entity: "player", minProjectedPixels: 1 }],
    },
    {
      effectLog,
      observations: {
        ...EMPTY_OBSERVATIONS,
        effectLogBefore: effectLog,
        physicsDebugBefore: physicsSnapshot,
        physicsDebugSeries: [{ label: "settled", snapshot: physicsSnapshot, tick: 1 }],
        runtimeDiagnostics: diagnostics,
        runtimeDiagnosticsBefore: diagnostics,
        runtimeObservations: runtime,
      } as IPlaytestObservations,
    },
  );

  for (const id of ["tags.coin", "states.player", "visibility.player", "settled.body", "occluded.listener", "animation.player"]) {
    expect(evaluated.assertions).toContainEqual(expect.objectContaining({ id, pass: false }));
  }
  expect(evaluated.diagnostics.filter(({ code }) => code === "TN_PLAYTEST_ASSERTION_TRIVIAL")).toHaveLength(6);
});

test("a finished animation assertion requires exact runtime completion evidence", async () => {
  const assertion = { animation: [{ entity: "player", clip: "run", advancedFrames: 5, finished: true }] };
  const effectLog = {
    entries: Array.from({ length: 5 }, () => ({ entity: "player", service: "animation.play", value: { clip: "run" } })),
  };

  const missing = await evaluate(assertion, { effectLog });
  expect(missing.assertions.find(({ id }) => id === "animation.player")?.pass).toBe(false);

  const complete = await evaluate(assertion, {
    observations: {
      ...EMPTY_OBSERVATIONS,
      runtimeObservations: {
        gameplay: { animation: { player: { advancedFrames: 8, clip: "run", finished: true } }, states: {} },
      },
    } as IPlaytestObservations,
  });
  expect(complete.assertions.find(({ id }) => id === "animation.player")?.pass).toBe(true);

  const stillPlaying = await evaluate(assertion, {
    observations: {
      ...EMPTY_OBSERVATIONS,
      runtimeObservations: {
        gameplay: { animation: { player: { advancedFrames: 8, clip: "run", finished: false } }, states: {} },
      },
    } as IPlaytestObservations,
  });
  expect(stillPlaying.assertions.find(({ id }) => id === "animation.player")?.pass).toBe(false);
});

test("a finished animation assertion rejects a wrong-typed scenario field", async () => {
  const directory = await makeTempDir("playtest-evidence-animation-");
  await writeFile(
    join(directory, "scenario.json"),
    JSON.stringify({
      assert: { animation: [{ entity: "player", finished: "true" }] },
      name: "evidence",
      schemaVersion: 1,
      steps: [{ release: true, waitFrames: 1 }],
    }),
  );

  await expect(loadPlaytestScenario(directory, "scenario.json")).rejects.toThrow(/finished.*boolean/u);
});

test("a tag assertion must declare a count or a floor to be worth running", async () => {
  // `tags: [{ tag: "coin" }]` degenerated to "a numeric count exists", so it
  // passed on a count of zero — the exact opposite of what the author meant.
  const directory = await makeTempDir("playtest-evidence-tag-");
  await writeFile(
    join(directory, "scenario.json"),
    JSON.stringify({
      assert: { tags: [{ tag: "coin" }] },
      name: "evidence",
      schemaVersion: 1,
      steps: [{ release: true, waitFrames: 1 }],
    }),
  );

  await expect(loadPlaytestScenario(directory, "scenario.json")).rejects.toThrow(/count.*gte|gte.*count/u);
});

test("a tag assertion with a floor still evaluates normally", async () => {
  const evaluated = await evaluate(
    { tags: [{ tag: "coin", gte: 3 }] },
    {
      observations: {
        ...EMPTY_OBSERVATIONS,
        runtimeObservations: { gameplay: { tags: { coin: { count: 4 } } } },
      } as IPlaytestObservations,
    },
  );

  expect(evaluated.assertions.find(({ id }) => id === "tags.coin")?.pass).toBe(true);
});

test("a zero tag count passes when the runtime channel contains no matching tag", async () => {
  const evaluated = await evaluate(
    { tags: [{ tag: "patrol", count: 0 }] },
    {
      observations: {
        ...EMPTY_OBSERVATIONS,
        runtimeObservations: { gameplay: { tags: { player: { count: 1 } } } },
      } as IPlaytestObservations,
    },
  );

  expect(evaluated.assertions.find(({ id }) => id === "tags.patrol")?.pass).toBe(true);
});

test("a zero tag count still fails when the runtime tag channel is unavailable", async () => {
  const evaluated = await evaluate({ tags: [{ tag: "patrol", count: 0 }] });

  expect(evaluated.assertions.find(({ id }) => id === "tags.patrol")?.pass).toBe(false);
});

test("a contact assertion reads the runtime contact channel", async () => {
  const evaluated = await evaluate(
    { contacts: [{ entity: "fox", with: "coin.3", kind: "trigger", minCount: 1 }] },
    {
      observations: {
        ...EMPTY_OBSERVATIONS,
        runtimeObservations: {
          gameplay: {
            animation: {},
            contacts: [{ entity: "fox", kind: "trigger", with: "coin.3" }],
            states: {},
          },
        },
      } as IPlaytestObservations,
    },
  );

  expect(evaluated.assertions.find(({ id }) => id === "contact.fox")?.pass).toBe(true);
});

test("a components assertion fails when the named entity was never observed", async () => {
  const evaluated = await evaluate({ components: [{ component: "health", entity: "ghost", gte: 1 }] });

  expect(evaluated.assertions.find(({ id }) => id === "component.ghost.health.value")?.pass).toBe(false);
  expect(evaluated.diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_COMPONENT_ASSERTION_FAILED");
});

test("a damage regression fails components while diagnostics and resources stay green", async () => {
  const evaluated = await evaluate(
    {
      components: [{ changed: true, component: "health", entity: "player", equals: 2 }],
      diagnostics: { noConsoleErrors: true, runtimeReady: true },
      resources: [{ changed: true, gte: 1, id: "GameState", path: "topSpeed" }],
    },
    {
      observations: {
        ...EMPTY_OBSERVATIONS,
        components: { player: { health: { before: 3, after: 3 } } },
        resources: { GameState: { before: { topSpeed: 0 }, after: { topSpeed: 2 } } },
      },
    },
  );

  expect(evaluated.assertions.find(({ id }) => id === "component.player.health.value")?.pass).toBe(false);
  expect(evaluated.assertions.find(({ id }) => id === "resource.GameState.topSpeed")?.pass).toBe(true);
  expect(evaluated.diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_COMPONENT_ASSERTION_FAILED");
  expect(evaluated.diagnostics.map(({ code }) => code)).not.toContain("TN_PLAYTEST_CONSOLE_ERROR");
});

test("throughoutSteps fails when fewer labeled samples were captured", async () => {
  const evaluated = await evaluate(
    { resources: [{ id: "GameState", path: "coins", equals: 1, throughoutSteps: true }] },
    {
      observations: {
        ...EMPTY_OBSERVATIONS,
        resourceSeries: [{ label: "first", snapshots: { GameState: { coins: 1 } }, tick: 1 }],
      },
    },
    [
      { label: "first", release: true, waitFrames: 1 },
      { label: "second", release: true, waitFrames: 1 },
    ],
  );

  expect(evaluated.assertions.find(({ id }) => id === "resource.GameState.coins.throughoutSteps")?.pass).toBe(false);
});

test("atSteps catches a transient reset while the final value still passes", async () => {
  const evaluated = await evaluate(
    { resources: [{ id: "GameState", path: "coins", equals: 3, atSteps: [{ label: "first", equals: 1 }, { label: "last", equals: 3 }] }] },
    {
      observations: {
        ...EMPTY_OBSERVATIONS,
        resources: { GameState: { before: { coins: 0 }, after: { coins: 3 } } },
        resourceSeries: [
          { label: "first", snapshots: { GameState: { coins: 1 } }, tick: 1 },
          { label: "last", snapshots: { GameState: { coins: 3 } }, tick: 2 },
        ],
      },
    },
    [
      { label: "first", release: true, waitFrames: 1 },
      { label: "last", release: true, waitFrames: 1 },
    ],
  );

  expect(evaluated.assertions.find(({ id }) => id === "resource.GameState.coins")?.pass).toBe(true);
  expect(evaluated.assertions.find(({ id }) => id === "resource.GameState.coins.atSteps")?.pass).toBe(true);
});

test("atSteps reports a reset even when the final value recovered", async () => {
  const evaluated = await evaluate(
    { resources: [{ id: "GameState", path: "coins", equals: 3, atSteps: [{ label: "first", equals: 1 }, { label: "last", equals: 3 }] }] },
    {
      observations: {
        ...EMPTY_OBSERVATIONS,
        resources: { GameState: { before: { coins: 0 }, after: { coins: 3 } } },
        resourceSeries: [
          { label: "first", snapshots: { GameState: { coins: 1 } }, tick: 1 },
          { label: "last", snapshots: { GameState: { coins: 0 } }, tick: 2 },
        ],
      },
    },
    [
      { label: "first", release: true, waitFrames: 1 },
      { label: "last", release: true, waitFrames: 1 },
    ],
  );

  expect(evaluated.assertions.find(({ id }) => id === "resource.GameState.coins")?.pass).toBe(true);
  expect(evaluated.assertions.find(({ id }) => id === "resource.GameState.coins.atSteps")?.pass).toBe(false);
});

test("atSteps lte bounds a running clock at a labeled step", async () => {
  const steps = [
    { label: "dirty", release: true, waitFrames: 1 },
    { label: "settled", release: true, waitFrames: 1 },
  ];
  const run = (settled: number) =>
    evaluate(
      { resources: [{ id: "GameState", path: "elapsed", atSteps: [{ label: "settled", lte: 1 }] }] },
      {
        observations: {
          ...EMPTY_OBSERVATIONS,
          resourceSeries: [
            { label: "dirty", snapshots: { GameState: { elapsed: 2 } }, tick: 1 },
            { label: "settled", snapshots: { GameState: { elapsed: settled } }, tick: 2 },
          ],
        },
      },
      steps,
    );

  expect((await run(0.5)).assertions.find(({ id }) => id === "resource.GameState.elapsed.atSteps")?.pass).toBe(true);
  expect((await run(2.5)).assertions.find(({ id }) => id === "resource.GameState.elapsed.atSteps")?.pass).toBe(false);
});

test("maxCount zero fails when the event channel was never drained", async () => {
  const evaluated = await evaluate({ signals: [{ maxCount: 0, name: "collected" }] });

  expect(evaluated.assertions.find(({ id }) => id === "signal.collected")?.pass).toBe(false);
  expect(evaluated.diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_SIGNAL_NOT_OBSERVED");
});

test("a signal assertion counts bounded events from retained labeled drains", async () => {
  const evaluated = await evaluate(
    { signals: [{ entity: "player", minCount: 2, name: "collected" }] },
    {
      observations: {
        ...EMPTY_OBSERVATIONS,
        signalSeries: [{
          label: "pickup",
          signals: [{ entity: "player", name: "collected" }, { entity: "player", name: "collected" }],
          tick: 1,
        }],
        signals: [{ entity: "player", name: "collected" }, { entity: "player", name: "collected" }],
      },
    },
    [{ label: "pickup", release: true, waitFrames: 1 }],
  );

  expect(evaluated.assertions.find(({ id }) => id === "signal.collected")?.pass).toBe(true);
});

test("throughoutFrames fails without a captured frame series", async () => {
  const evaluated = await evaluate(
    { visual: [{ entityVisible: { entity: "player", minProjectedPixels: 1, throughoutFrames: true } }] },
    {
      observations: {
        ...EMPTY_OBSERVATIONS,
        runtimeDiagnostics: {
          scene: {
            renderedEntities: [{ id: "player", projectedBounds: { min: [-0.5, -0.5], max: [0.5, 0.5] } }],
          },
        },
        visual: {},
      },
    },
  );

  expect(evaluated.assertions.find(({ id }) => id === "visual.0.entityVisible")?.pass).toBe(false);
});

test("visual region maxDarkPixelRatio distinguishes a clear control bound from an unexpected control", async () => {
  const report = {
    observations: {
      ...EMPTY_OBSERVATIONS,
      visual: {
        nonblankRegions: [{ darkPixelRatio: 0.2, height: 20, nonblankPixelRatio: 0.4, width: 16, x: 1172, y: 552 }],
      },
    },
  };
  const evaluated = await evaluate(
    { visual: [{ region: { height: 20, maxDarkPixelRatio: 0.25, width: 16, x: 1172, y: 552 } }] },
    report,
  );
  expect(evaluated.assertions.find(({ id }) => id === "visual.0.region.maxDarkPixels")?.pass).toBe(true);

  const exceeded = await evaluate(
    { visual: [{ region: { height: 20, maxDarkPixelRatio: 0.1, width: 16, x: 1172, y: 552 } }] },
    report,
  );
  expect(exceeded.assertions.find(({ id }) => id === "visual.0.region.maxDarkPixels")?.pass).toBe(false);
  expect(exceeded.diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_REGION_DARK_PIXEL_RATIO_EXCEEDED");
});
