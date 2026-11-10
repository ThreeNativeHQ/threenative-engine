import { makeTempDir } from "../../../test-support/temp-dir.js";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import type { Page } from "playwright";

import {
  PLAYTEST_PROTOCOL_LIMITS,
  PLAYTEST_PROTOCOL_VERSION,
  PlaytestScenarioError,
  loadPlaytestScenario,
  type IPlaytestStep,
} from "../src/index.js";
import { connectPlaytestBridge, PlaytestBridgeError } from "../src/runner/bridgeClient.js";

const fixtureDirectory = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

// CHARTER.md §8. A wrong-typed assertion value used to be dropped on the floor:
// the validator returned undefined and the caller filtered it out. The scenario
// then ran with zero assertions of that kind and reported green. A harness that
// silently asserts nothing is worse than no harness, because it is trusted.
//
// These tests were observed RED against the pre-fix parser: loadPlaytestScenario
// resolved instead of throwing for the first three.

async function writeScenario(
  assert: unknown,
  steps: IPlaytestStep[] = [{ release: true, waitFrames: 1 }],
  fields: Record<string, unknown> = {},
): Promise<string> {
  const directory = await makeTempDir("playtest-silent-drop-");
  await writeFile(
    join(directory, "scenario.json"),
    JSON.stringify({
      assert,
      ...fields,
      name: "silent-drop",
      schemaVersion: 1,
      steps,
    }),
  );
  return directory;
}

async function loadError(assert: unknown, fields: Record<string, unknown> = {}): Promise<unknown> {
  const directory = await writeScenario(assert, undefined, fields);
  try {
    await loadPlaytestScenario(directory, "scenario.json");
  } catch (error) {
    return error;
  }
  return undefined;
}

function fakePage(capabilities: readonly string[]): Page {
  return {
    evaluate: async (_callback: unknown, input: { method: string }) => {
      if (input.method === "describe") {
        return { capabilities, limits: PLAYTEST_PROTOCOL_LIMITS, name: "test-bridge", protocolVersion: PLAYTEST_PROTOCOL_VERSION };
      }
      if (input.method === "ready") return { ready: true };
      throw new Error(`Unexpected bridge call '${input.method}'.`);
    },
    waitForFunction: async () => undefined,
  } as unknown as Page;
}

test("rejects a whole assertion whose required value is wrong-typed", async () => {
  // `equals` must be a string. As a boolean the entry was silently discarded and
  // `assert.states` became [], so the scenario proved nothing about the player.
  const error = await loadError({ states: [{ entity: "player", equals: true }] });

  expect(error).toBeInstanceOf(PlaytestScenarioError);
  expect((error as PlaytestScenarioError).diagnostic.code).toBe("TN_PLAYTEST_SCENARIO_INVALID");
  expect((error as PlaytestScenarioError).diagnostic.message).toMatch(/states\[0\]\.equals/u);
});

test("rejects an empty entity reference rather than asserting nothing about it", async () => {
  const error = await loadError({ states: [{ entity: "", equals: "alive" }] });

  expect(error).toBeInstanceOf(PlaytestScenarioError);
  expect((error as PlaytestScenarioError).diagnostic.message).toMatch(/states\[0\]\.entity/u);
});

test("rejects an optional key that is present but wrong-typed", async () => {
  // The per-key variant, which §8 never counted: the assertion object survives
  // and only the malformed key vanishes. Here `tags[0]` kept its `tag` check and
  // silently lost its `count` check.
  const error = await loadError({ tags: [{ tag: "enemy", count: "three" }] });

  expect(error).toBeInstanceOf(PlaytestScenarioError);
  expect((error as PlaytestScenarioError).diagnostic.message).toMatch(/tags\[0\]\.count/u);
});

test("rejects the malformed parity animation fixture instead of shrinking the comparison", async () => {
  await expect(loadPlaytestScenario(fixtureDirectory, "parity-mistyped.playtest.json")).rejects.toThrow(
    /parity\.animation\[0\]\.entity/u,
  );
});

test.each([
  ["a non-string resource id", { resources: ["GameState", 7] }, /parity\.resources\[1\]/u],
  ["an unknown parity target", { targets: ["web", "android"] }, /parity\.targets\[1\]/u],
  ["a non-string animation name", { animation: [{ entity: "player", clip: 7 }] }, /parity\.animation\[0\]\.clip/u],
  ["an unknown animation target", { animation: [{ entity: "player", requiredOn: ["android"] }] }, /parity\.animation\[0\]\.requiredOn\[0\]/u],
  ["a non-string compare resource id", { compare: { resources: [7] } }, /parity\.compare\.resources\[0\]/u],
  ["a malformed compare animation", { compare: { animation: [{ entity: 7 }] } }, /parity\.compare\.animation\[0\]\.entity/u],
] as const)("rejects %s at load", async (_label, parity, message) => {
  const error = await loadError({ states: [{ entity: "player", equals: "alive" }] }, { parity });

  expect(error).toBeInstanceOf(PlaytestScenarioError);
  expect((error as PlaytestScenarioError).diagnostic.message).toMatch(message);
});

test("preserves valid parity fields unchanged", async () => {
  const directory = await writeScenario(
    { states: [{ entity: "player", equals: "alive" }] },
    undefined,
    {
      parity: {
        animation: [{ clip: "run", entity: "player", requiredOn: ["web", "desktop"] }],
        resources: ["GameState"],
        targets: ["web", "desktop"],
      },
    },
  );

  const parsed = await loadPlaytestScenario(directory, "scenario.json");

  expect(parsed.parity).toEqual({
    animation: [{ clip: "run", entity: "player", requiredOn: ["web", "desktop"] }],
    resources: ["GameState"],
    targets: ["web", "desktop"],
  });
});

test("rejects a wrong-typed present viewport and defaults only when viewport is absent", async () => {
  const error = await loadError(
    { states: [{ entity: "player", equals: "alive" }] },
    { viewport: { height: 720, width: "1280" } },
  );

  expect(error).toBeInstanceOf(PlaytestScenarioError);
  expect((error as PlaytestScenarioError).diagnostic.message).toMatch(/viewport\.width/u);

  const directory = await writeScenario({ states: [{ entity: "player", equals: "alive" }] });
  const parsed = await loadPlaytestScenario(directory, "scenario.json");

  expect(parsed.viewport).toEqual({ height: 720, width: 1280 });
});

test("still accepts a valid assertion unchanged", async () => {
  // Positive control. Without this, making every validator throw would satisfy the
  // three tests above while breaking every real scenario.
  const directory = await writeScenario({
    states: [{ entity: "player", equals: "alive" }],
    tags: [{ tag: "enemy", count: 3 }],
  });

  const parsed = await loadPlaytestScenario(directory, "scenario.json");

  expect(parsed.assert?.states).toEqual([{ entity: "player", equals: "alive" }]);
  expect(parsed.assert?.tags).toEqual([{ tag: "enemy", count: 3 }]);
});

test("an absent optional key stays absent rather than throwing", async () => {
  // The other half of the absent-vs-wrong-typed distinction. If optionalX threw on
  // absence too, every scenario that omits an optional key would break.
  //
  // `gte` is now pinned here because a tag assertion carrying neither `count` nor
  // `gte` is rejected at load time — boundless, it passed on a count of zero (see
  // evidence-required.spec.ts). `count` is still the absent optional key under
  // test, so what this case proves is unchanged.
  const directory = await writeScenario({ tags: [{ tag: "enemy", gte: 1 }] });

  const parsed = await loadPlaytestScenario(directory, "scenario.json");

  expect(parsed.assert?.tags).toEqual([{ tag: "enemy", gte: 1 }]);
});

test("rejects a wrong-typed signal name at load instead of coercing it", async () => {
  const error = await loadError({ signals: [{ name: 42 }] });

  expect(error).toBeInstanceOf(PlaytestScenarioError);
  expect((error as PlaytestScenarioError).diagnostic.message).toMatch(/signals\[0\]\.name/u);
});

test("refuses a scenario whose observation this runner cannot produce", async () => {
  const directory = await writeScenario({ movement: { entity: "player", notFacing: { entity: "patrol", minDegrees: 20 } } });
  const scenario = await loadPlaytestScenario(directory, "scenario.json");
  let caught: unknown;
  try {
    await connectPlaytestBridge(fakePage(["entity.observe", "runtime.contacts"]), scenario);
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(PlaytestBridgeError);
  const error = caught as PlaytestBridgeError;
  expect(error.diagnostic.code).toBe("TN_PLAYTEST_OBSERVATION_UNAVAILABLE");
  expect(error.diagnostic.path).toBe("effectLog");
  expect(error.diagnostic.message).toContain("movement.notFacing");
  expect(error.diagnostic.message).not.toContain("patrol yaw");
});

test("names an unavailable labeled movement series", async () => {
  const directory = await writeScenario(
    {
      movement: {
        entity: "player",
        reachesPositionWithin: { atStep: "goal", maxDistance: 1, position: [1, 0, 0] },
      },
    },
    [{ label: "goal", release: true, waitFrames: 1 }, { release: true, waitFrames: 1 }],
  );
  const scenario = await loadPlaytestScenario(directory, "scenario.json");
  let caught: unknown;
  try {
    await connectPlaytestBridge(fakePage(["entity.observe"]), scenario);
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(PlaytestBridgeError);
  const error = caught as PlaytestBridgeError;
  expect(error.diagnostic.code).toBe("TN_PLAYTEST_OBSERVATION_UNAVAILABLE");
  expect(error.diagnostic.path).toBe("effectLogSeries");
});

test("allows a labeled physics series to reach assertion evaluation", async () => {
  const directory = await writeScenario(
    { contacts: [{ atStep: "hit", entity: "player", minCount: 1 }] },
    [{ label: "hit", release: true, waitFrames: 1 }],
  );
  const scenario = await loadPlaytestScenario(directory, "scenario.json");
  const client = await connectPlaytestBridge(fakePage(["entity.observe", "runtime.contacts"]), scenario);
  expect(client).toBeDefined();
});

test("keeps a supported observation kind connected", async () => {
  const directory = await writeScenario({ resources: [{ id: "GameState", path: "coins", gte: 1 }] });
  const scenario = await loadPlaytestScenario(directory, "scenario.json");

  const client = await connectPlaytestBridge(fakePage(["browser.screenshot", "runtime.resources"]), scenario);

  expect(client?.description.capabilities).toContain("runtime.resources");
});

test("browser transport satisfies runtime diagnostics when no application bridge exists", async () => {
  const directory = await writeScenario({
    diagnostics: { noConsoleErrors: true, noRuntimeDiagnostics: true },
  });
  const scenario = await loadPlaytestScenario(directory, "scenario.json");
  const page = {
    waitForFunction: async () => {
      throw new Error("bridge missing");
    },
  } as unknown as Page;

  const client = await connectPlaytestBridge(page, scenario);

  expect(client).toBeUndefined();
});

test("reports a missing component observation as a capability defect", async () => {
  const directory = await writeScenario({ components: [{ component: "health", entity: "player", gte: 1 }] });
  const scenario = await loadPlaytestScenario(directory, "scenario.json");
  let caught: unknown;
  try {
    await connectPlaytestBridge(fakePage(["browser.screenshot"]), scenario);
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(PlaytestBridgeError);
  expect((caught as PlaytestBridgeError).diagnostic.code).toBe("TN_PLAYTEST_CAPABILITY_MISSING");
  expect((caught as PlaytestBridgeError).diagnostic.capability).toBe("runtime.components");
});

test("reports a missing signal drain as a capability defect", async () => {
  const directory = await writeScenario({ signals: [{ name: "collected", minCount: 1 }] });
  const scenario = await loadPlaytestScenario(directory, "scenario.json");
  let caught: unknown;
  try {
    await connectPlaytestBridge(fakePage(["browser.screenshot"]), scenario);
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(PlaytestBridgeError);
  expect((caught as PlaytestBridgeError).diagnostic.code).toBe("TN_PLAYTEST_CAPABILITY_MISSING");
  expect((caught as PlaytestBridgeError).diagnostic.capability).toBe("runtime.events");
});

test("rejects a bridge advertising an unregistered capability", async () => {
  const directory = await writeScenario({ movement: { entity: "player", minDistance: 0.1 } });
  const scenario = await loadPlaytestScenario(directory, "scenario.json");
  let caught: unknown;
  try {
    await connectPlaytestBridge(fakePage(["entity.observe", "runtime.audio.fake"]), scenario);
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(PlaytestBridgeError);
  expect((caught as PlaytestBridgeError).diagnostic.code).toBe("TN_PLAYTEST_BRIDGE_CAPABILITY_UNKNOWN");
  expect((caught as PlaytestBridgeError).diagnostic.capability).toBe("runtime.audio.fake");
});

// The same §8 failure mode survived in four array-entry validators that predate the
// requireRecord toolkit: a malformed ENTRY was mapped to undefined and filtered out of
// the array, so the declared assertion count shrank silently. Each test below was
// observed RED against the pre-fix parser: the scenario loaded with the junk entry
// gone and no diagnostic anywhere.

test("rejects a non-record contacts entry instead of dropping it", async () => {
  const error = await loadError({
    contacts: [{ entity: "player", minCount: 1, with: "coin" }, "oops"],
  });

  expect(error).toBeInstanceOf(PlaytestScenarioError);
  expect((error as PlaytestScenarioError).diagnostic.message).toMatch(/contacts\[1\]/u);
});

test("rejects a wrong-typed requiredOn target instead of filtering it out", async () => {
  // A typo'd target ("android") silently widened the assertion to every target.
  const error = await loadError({
    contacts: [{ entity: "player", minCount: 1, requiredOn: ["android"], with: "coin" }],
  });

  expect(error).toBeInstanceOf(PlaytestScenarioError);
  expect((error as PlaytestScenarioError).diagnostic.message).toMatch(/requiredOn\[0\]/u);
});

test("rejects a hud entry that is not an object and one that names no path", async () => {
  const untyped = await loadError({ hud: ["score"] });
  expect(untyped).toBeInstanceOf(PlaytestScenarioError);
  expect((untyped as PlaytestScenarioError).diagnostic.message).toMatch(/hud\[0\]/u);

  const idless = await loadError({ hud: [{ gte: 1 }] });
  expect(idless).toBeInstanceOf(PlaytestScenarioError);
  expect((idless as PlaytestScenarioError).diagnostic.message).toMatch(/hud\[0\]\.id/u);
});

test("rejects a resource atSteps entry that is not a labeled sample", async () => {
  // atSteps belongs to resource and component series, never to hud entries.
  const error = await loadError({ resources: [{ atSteps: ["nope"], id: "score" }] });

  expect(error).toBeInstanceOf(PlaytestScenarioError);
  expect((error as PlaytestScenarioError).diagnostic.message).toMatch(/atSteps\[0\]/u);
});

test("rejects a visual entry that is not an object instead of dropping it", async () => {
  const error = await loadError({
    visual: [{ region: { height: 10, width: 10, x: 0, y: 0 } }, 7],
  });

  expect(error).toBeInstanceOf(PlaytestScenarioError);
  expect((error as PlaytestScenarioError).diagnostic.message).toMatch(/visual\[1\]/u);
});

test("rejects an empty visual assertion that can never fail", async () => {
  // With every key absent (or mistyped into omission) the row evaluated to nothing
  // while still reporting pass — an unevidenced green in the report.
  const error = await loadError({ visual: [{}] });

  expect(error).toBeInstanceOf(PlaytestScenarioError);
  expect((error as PlaytestScenarioError).diagnostic.message).toMatch(/visual\[0\]/u);
});

test("rejects an aerodynamics entry without an entity", async () => {
  const error = await loadError({ aerodynamics: [{ minForceSamples: 2 }] });

  expect(error).toBeInstanceOf(PlaytestScenarioError);
  expect((error as PlaytestScenarioError).diagnostic.message).toMatch(/aerodynamics\[0\]\.entity/u);
});

test("rejects a wrong-typed aerodynamics control instead of emptying controls", async () => {
  // `controls` flattened to [], whose .every() is vacuously true — the control check
  // passed without ever running on web targets where minForceSamples alone satisfies
  // the final guard.
  const error = await loadError({
    aerodynamics: [{
      controls: [{ sign: "positive", surface: 42 }],
      entity: "wing",
      minForceSamples: 1,
    }],
  });

  expect(error).toBeInstanceOf(PlaytestScenarioError);
  expect((error as PlaytestScenarioError).diagnostic.message).toMatch(/aerodynamics\[0\]\.controls\[0\]/u);
});

test("still accepts valid contacts, hud, visual, and aerodynamics assertions unchanged", async () => {
  const directory = await writeScenario(
    {
      aerodynamics: [{
        controls: [{ minAbs: 0.5, sign: "positive", surface: "elevator" }],
        entity: "wing",
        minForceSamples: 2,
        torques: [{ axis: "z", label: "pitch-up", sign: "negative" }],
      }],
      contacts: [{ entity: "player", minCount: 1, requiredOn: ["web", "desktop"], with: "coin" }],
      hud: [{ gte: 1, id: "score" }],
      resources: [{ atSteps: [{ equals: "3/3", label: "done" }], id: "state" }],
      visual: [{ region: { height: 64, width: 64, x: 10, y: 10 } }],
    },
    [{ label: "done", release: true, waitFrames: 1 }],
  );

  const parsed = await loadPlaytestScenario(directory, "scenario.json");

  expect(parsed.assert?.contacts).toEqual([{
    atStep: undefined,
    entity: "player",
    kind: undefined,
    maxCount: undefined,
    minCount: 1,
    requiredOn: ["web", "desktop"],
    with: "coin",
  }]);
  expect(parsed.assert?.hud).toEqual([{ gte: 1, id: "score" }]);
  expect(parsed.assert?.resources).toEqual([{
    atSteps: [{ equals: "3/3", label: "done" }],
    id: "state",
  }]);
});
