import { makeTempDir } from "../../../test-support/temp-dir.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";

import { PLAYTEST_ASSERTION_REGISTRY, PlaytestScenarioError, loadPlaytestScenario } from "../src/index.js";

// The sibling of silent-drop.spec.ts, for the assertion kinds that spec never
// reached. `states` and `tags` parse through validators that throw; `movement`,
// `camera`, `diagnostics` and friends parsed through per-key spreads of the form
// `typeof x === "number" ? { x } : {}`, which drop a wrong-typed value and keep
// the surrounding assertion. The scenario then runs with the author's check
// missing and reports pass.
//
// Observed RED before the fix: every "rejects" case below resolved instead of
// throwing, and case-by-case the parsed assertion came back missing the key.

async function load(assert: unknown): Promise<unknown> {
  const directory = await makeTempDir("playtest-vacuous-");
  await writeFile(
    join(directory, "scenario.json"),
    JSON.stringify({
      assert,
      name: "vacuous",
      schemaVersion: 1,
      steps: [{ holdFrames: 4, press: "KeyW", release: true }],
      subject: "player",
    }),
  );
  return loadPlaytestScenario(directory, "scenario.json");
}

async function loadError(assert: unknown): Promise<PlaytestScenarioError> {
  let caught: unknown;
  try {
    await load(assert);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PlaytestScenarioError);
  return caught as PlaytestScenarioError;
}

test("a stringified movement threshold is rejected, not dropped into a green run", async () => {
  const error = await loadError({ movement: { entity: "player", minDistance: "0.5" } });

  expect(error.diagnostic.code).toBe("TN_PLAYTEST_SCENARIO_INVALID");
  expect(error.diagnostic.message).toMatch(/assert\.movement\.minDistance.*must be number/u);
});

test("a null movement threshold is rejected rather than treated as absent", async () => {
  const error = await loadError({ movement: { entity: "player", maxDistance: null } });

  expect(error.diagnostic.message).toMatch(/assert\.movement\.maxDistance/u);
});

test("a stringified camera bound is rejected", async () => {
  const error = await loadError({ camera: { entity: "camera", follows: "player", within: "5" } });

  expect(error.diagnostic.message).toMatch(/assert\.camera\.within/u);
});

test("a stringified diagnostics flag is rejected", async () => {
  // `"noConsoleErrors": "true"` is the single most plausible hand-authoring slip,
  // and it used to disable the check it was written to enable.
  const error = await loadError({ diagnostics: { noConsoleErrors: "true" } });

  expect(error.diagnostic.message).toMatch(/assert\.diagnostics\.noConsoleErrors.*must be boolean/u);
});

test("an empty entity id is rejected instead of silently matching nothing", async () => {
  const error = await loadError({ movement: { entity: "", minDistance: 0.5 } });

  expect(error.diagnostic.message).toMatch(/assert\.movement\.entity/u);
});

test("a console opt-out without a reason is rejected at load", async () => {
  const error = await loadError({ diagnostics: { noConsoleErrors: false } });

  expect(error.diagnostic.message).toMatch(/noConsoleErrors.*consoleErrorsOptOutReason/u);
});

test("a network opt-out without a reason is rejected at load", async () => {
  const error = await loadError({ diagnostics: { noNetworkErrors: false } });

  expect(error.diagnostic.message).toMatch(/noNetworkErrors.*networkErrorsOptOutReason/u);
});

test("a wrong-typed field inside an array assertion names its index", async () => {
  const error = await loadError({ visibility: [{ entity: "player" }, { entity: "enemy", minProjectedPixels: "40" }] });

  expect(error.diagnostic.message).toMatch(/assert\.visibility\[1\]\.minProjectedPixels/u);
});

test("every registry field declaring a scalar type is actually enforced", async () => {
  // Guards the fix itself: the check is registry-driven, so a new assertion kind
  // inherits it. This fails if someone adds a scalar field the checker skips.
  const scalarTypes = new Set([
    "boolean", "non-empty string", "non-negative integer", "number",
    "number in [0, 180]", "positive integer", "positive number", "string", "triviality reason",
  ]);
  const wrongValue = (type: string): unknown => (type.includes("string") ? 42 : "not-a-number");

  for (const entry of PLAYTEST_ASSERTION_REGISTRY) {
    for (const field of entry.fields) {
      if (!scalarTypes.has(field.type)) continue;
      const corrupted = { [field.name]: wrongValue(field.type) };
      const error = await loadError({
        [entry.kind]: entry.cardinality === "array" ? [corrupted] : corrupted,
      });
      expect(error.diagnostic.message, `${entry.kind}.${field.name} was accepted`).toMatch(
        new RegExp(`${entry.kind}.*\\.${field.name}`, "u"),
      );
    }
  }
});

test("valid scalar values still parse unchanged", async () => {
  // Positive control. Making the parser throw on everything would satisfy every
  // test above while breaking every real scenario.
  const scenario = await load({
    camera: { entity: "camera", follows: "player", targetInViewport: true, within: 5 },
    diagnostics: { noConsoleErrors: true, noNetworkErrors: true },
    movement: { entity: "player", maxDistance: 10, minDistance: 0.5, rotationChanged: true },
  }) as { assert: Record<string, unknown> };

  expect(scenario.assert.movement).toEqual({ entity: "player", maxDistance: 10, minDistance: 0.5, rotationChanged: true });
  expect(scenario.assert.camera).toEqual({ entity: "camera", follows: "player", targetInViewport: true, within: 5 });
});

test("the boolean triviality opt-out is rejected instead of coerced", async () => {
  const error = await loadError({
    resources: [{ allowTrivial: true, equals: 0, id: "state", path: "spent" }],
  });

  expect(error.diagnostic.code).toBe("TN_PLAYTEST_SCENARIO_INVALID");
  expect(error.diagnostic.message).toMatch(/assert\.resources\[0\]\.allowTrivial.*string with at least 20 non-whitespace characters.*boolean/u);
});

test("a triviality reason must contain prose, not only whitespace or one character", async () => {
  for (const reason of ["x", " ".repeat(30)]) {
    const error = await loadError({
      resources: [{ allowTrivial: reason, equals: 0, id: "state", path: "spent" }],
    });

    expect(error.diagnostic.message).toMatch(/allowTrivial.*at least 20 non-whitespace characters/u);
  }
});

test("a reason-string triviality opt-out parses unchanged", async () => {
  const reason = "The value is intentionally held until the separate transition assertion proves the route.";
  const scenario = await load({
    resources: [{ allowTrivial: reason, equals: 0, id: "state", path: "spent" }],
  }) as { assert: { resources: Array<{ allowTrivial?: string }> } };

  expect(scenario.assert.resources[0]?.allowTrivial).toBe(reason);
});

test("the six held-value assertion kinds reject boolean and short triviality opt-outs", async () => {
  const cases: Array<[string, unknown]> = [
    ["tags", [{ count: 1, tag: "coin" }]],
    ["states", [{ entity: "player", equals: "idle" }]],
    ["visibility", [{ entity: "player", present: true }]],
    ["settled", [{ entity: "body", minBodies: 1 }]],
    ["occluded", [{}]],
    ["animation", [{ clip: "run", entity: "player" }]],
  ];

  for (const [kind, assertion] of cases) {
    for (const allowTrivial of [true, "too short"]) {
      const value = Array.isArray(assertion)
        ? assertion.map((entry) => ({ ...(entry as Record<string, unknown>), allowTrivial }))
        : assertion;
      const error = await loadError({ [kind]: value });
      expect(error.diagnostic.message, `${kind} accepted ${JSON.stringify(allowTrivial)}`).toMatch(
        new RegExp(`assert\\.${kind}\\[0\\]\\.allowTrivial.*at least 20 non-whitespace characters`, "u"),
      );
    }
  }
});

test("every registry entry carries rationale and the audit reclassifies the six held-value kinds", () => {
  expect(PLAYTEST_ASSERTION_REGISTRY).toHaveLength(35);
  expect(PLAYTEST_ASSERTION_REGISTRY.every(({ trivialityRationale }) => trivialityRationale.trim().length > 0)).toBe(true);
  expect(PLAYTEST_ASSERTION_REGISTRY.filter(({ triviality }) => triviality === "reject-initial-value").map(({ kind }) => kind)).toEqual([
    "components",
    "resources",
    "tags",
    "states",
    "hud",
    "visibility",
    "settled",
    "occluded",
    "animation",
  ]);
});

test("an empty signals array fails at load instead of asserting nothing", async () => {
  const error = await loadError({ signals: [] });

  expect(error.diagnostic.message).toMatch(/assert\.signals.*at least one/u);
});
