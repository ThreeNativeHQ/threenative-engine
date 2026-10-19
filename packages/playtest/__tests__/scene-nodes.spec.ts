import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { makeTempDirSync } from "../../../test-support/temp-dir.js";
import { emitSceneNodes } from "../src/evaluators/scene-nodes.js";
import { loadPlaytestScenario } from "../src/scenario.js";

/**
 * The scene graph, read as numbers instead of looked at.
 *
 * `assert.scene` bounds the room — is anything lit, does the fog clear the world. It cannot say
 * where one object is, whether the camera is pointed at it, or whether the texture it is wearing
 * ever loaded. Those are the questions an agent takes a screenshot for, and a screenshot is the
 * one instrument that cannot say why.
 *
 * These pin the bound and every way it must fail closed. A green `sceneNodes` result must mean a
 * node was found and measured; it must never mean the run had nothing to say.
 */

const baseReport = {
  diagnostics: [],
  distance: 0,
  entity: "player",
  expectMoved: false,
  frames: 1,
  observations: { console: [], hud: {}, network: [], resources: {} },
  trivialityOptOuts: [],
};

const baseScenario = {
  name: "scene-nodes",
  schemaVersion: 1,
  steps: [{ label: "goal", release: true, waitFrames: 1 }],
  subject: "player",
  target: "web",
};

function evaluate(assertion: unknown, observations: Record<string, unknown> = {}) {
  const assertions: Array<{ details?: Record<string, unknown>; id: string; pass: boolean }> = [];
  const diagnostics: Array<{ code: string; message: string; severity: "error" | "warning"; suggestion?: string }> = [];
  emitSceneNodes({
    assertions,
    diagnostics,
    input: {
      report: {
        ...baseReport,
        observations: { ...baseReport.observations, ...observations },
      } as never,
      scenario: { ...baseScenario, assert: assertion } as never,
    },
    scenarioAssertions: assertion as never,
  } as never);
  return { assertions, diagnostics };
}

function node(overrides: Record<string, unknown> = {}) {
  return {
    name: "crate",
    path: "Scene/Vault/crate",
    position: [0, 1, 0],
    scale: [1, 1, 1],
    type: "Mesh",
    visible: true,
    visibleInTree: true,
    ...overrides,
  };
}

function observation(nodes: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    sceneNodes: [
      {
        matched: nodes.length,
        nodes,
        selector: { nameContains: "crate" },
        truncated: false,
        ...overrides,
      },
    ],
  };
}

async function loadScenario(assert: unknown): Promise<unknown> {
  const dir = makeTempDirSync("scene-nodes-scenario");
  writeFileSync(join(dir, "scene.playtest.json"), JSON.stringify({ ...baseScenario, assert }));
  return loadPlaytestScenario(dir, "scene.playtest.json");
}

describe("assert.sceneNodes fails closed", () => {
  test("a run that reported no scene nodes fails rather than passing on silence", () => {
    const { assertions, diagnostics } = evaluate({ sceneNodes: [{ select: { nameContains: "crate" }, visible: true }] });
    expect(assertions).toEqual([
      { details: { expected: 1, observed: undefined }, id: "sceneNodes.observed", pass: false },
    ]);
    expect(diagnostics[0]?.code).toBe("TN_PLAYTEST_SCENE_NODES_UNOBSERVED");
  });

  test("a selector that matched nothing fails, and no other bound is reported as met", () => {
    const { assertions, diagnostics } = evaluate(
      { sceneNodes: [{ select: { nameContains: "crate" }, visible: true }] },
      observation([]),
    );
    expect(assertions.filter(({ pass }) => pass)).toEqual([]);
    expect(assertions.map(({ id }) => id)).toEqual(["sceneNodes[0].count"]);
    expect(diagnostics[0]?.code).toBe("TN_PLAYTEST_SCENE_NODES_COUNT");
  });

  test("a node whose frustum membership was never observed does not count as on screen", () => {
    const { assertions, diagnostics } = evaluate(
      { sceneNodes: [{ inFrustum: true, select: { nameContains: "crate" } }] },
      observation([node()]),
    );
    expect(assertions.find(({ id }) => id === "sceneNodes[0].inFrustum")?.pass).toBe(false);
    expect(diagnostics[0]?.code).toBe("TN_PLAYTEST_SCENE_NODE_OFF_SCREEN");
  });
});

describe("assert.sceneNodes measures what a screenshot would have shown", () => {
  test("a visible mesh under a hidden ancestor fails, and the message names the parent chain", () => {
    const { assertions, diagnostics } = evaluate(
      { sceneNodes: [{ select: { nameContains: "crate" }, visible: true }] },
      observation([node({ visible: true, visibleInTree: false })]),
    );
    expect(assertions.find(({ id }) => id === "sceneNodes[0].visible")?.pass).toBe(false);
    expect(diagnostics[0]?.code).toBe("TN_PLAYTEST_SCENE_NODE_INVISIBLE");
    expect(diagnostics[0]?.message).toContain("Scene/Vault/crate");
  });

  test("a bound texture slot carrying no image fails, and the slot is named", () => {
    const { assertions, diagnostics } = evaluate(
      { sceneNodes: [{ select: { nameContains: "crate" }, texturesLoaded: true }] },
      observation([
        node({
          materials: [
            { lit: true, maps: ["map", "normalMap"], mapsUnloaded: ["normalMap"], name: "", transparent: false, type: "MeshStandardMaterial", visible: true },
          ],
        }),
      ]),
    );
    expect(assertions.find(({ id }) => id === "sceneNodes[0].texturesLoaded")?.pass).toBe(false);
    expect(diagnostics[0]?.code).toBe("TN_PLAYTEST_SCENE_NODE_TEXTURE_UNLOADED");
    expect(diagnostics[0]?.message).toContain("normalMap");
  });

  test("a node with no materials is not textured, even though every empty list passes .every", () => {
    const { assertions, diagnostics } = evaluate(
      { sceneNodes: [{ select: { nameContains: "crate" }, texturesLoaded: true }] },
      observation([node({ materials: [] })]),
    );
    expect(assertions.find(({ id }) => id === "sceneNodes[0].texturesLoaded")?.pass).toBe(false);
    expect(diagnostics[0]?.code).toBe("TN_PLAYTEST_SCENE_NODE_TEXTURE_UNLOADED");
  });

  test("a node that is present, visible, framed and textured passes every bound", () => {
    const { assertions, diagnostics } = evaluate(
      { sceneNodes: [{ inFrustum: true, minTriangles: 12, select: { nameContains: "crate" }, texturesLoaded: true, visible: true }] },
      observation([
        node({
          geometry: { attributes: ["normal", "position", "uv"], triangles: 12, vertices: 24 },
          inFrustum: true,
          materials: [{ lit: true, maps: ["map"], mapsUnloaded: [], name: "", transparent: false, type: "MeshStandardMaterial", visible: true }],
        }),
      ]),
    );
    expect(diagnostics).toEqual([]);
    expect(assertions.every(({ pass }) => pass)).toBe(true);
    expect(assertions.map(({ id }) => id)).toContain("sceneNodes[0].minTriangles");
  });

  test("maxCount 0 is how a scenario asserts a node is absent", () => {
    const { assertions, diagnostics } = evaluate(
      { sceneNodes: [{ maxCount: 0, select: { nameContains: "debug" } }] },
      { sceneNodes: [{ matched: 0, nodes: [], selector: { nameContains: "debug" }, truncated: false }] },
    );
    expect(diagnostics).toEqual([]);
    expect(assertions).toEqual([
      { details: { matched: 0, maxCount: 0, minCount: 0, selector: "nameContains=debug" }, id: "sceneNodes[0].count", pass: true },
    ]);
  });

  test("a truncated report says its triangle sum is a floor rather than a total", () => {
    const { diagnostics } = evaluate(
      { sceneNodes: [{ minTriangles: 1_000, select: { nameContains: "crate" } }] },
      observation([node({ geometry: { attributes: ["position"], triangles: 12, vertices: 36 } })], { matched: 400, truncated: true }),
    );
    expect(diagnostics.at(-1)?.suggestion).toContain("sample");
  });
});

describe("a malformed sceneNodes assertion throws at load", () => {
  test("an assertion that selects nodes and bounds nothing is refused", async () => {
    await expect(loadScenario({ sceneNodes: [{ select: { nameContains: "crate" } }] })).rejects.toThrow(/at least one of/u);
  });

  test("a selector that filters nothing is refused", async () => {
    await expect(loadScenario({ sceneNodes: [{ select: { limit: 4 }, visible: true }] })).rejects.toThrow(/filters nothing/u);
  });

  test("a wrong-typed bound is refused rather than coerced", async () => {
    await expect(loadScenario({ sceneNodes: [{ select: { name: "crate" }, visible: "yes" }] })).rejects.toThrow();
  });

  test("an unknown key is refused rather than ignored", async () => {
    await expect(loadScenario({ sceneNodes: [{ onScreen: true, select: { name: "crate" } }] })).rejects.toThrow();
  });

  test("minCount above maxCount is refused, because no run can satisfy it", async () => {
    await expect(loadScenario({ sceneNodes: [{ maxCount: 1, minCount: 3, select: { name: "crate" } }] })).rejects.toThrow(/no run can satisfy/u);
  });

  test("a sceneNodes value that is not an array is refused rather than silently dropped", async () => {
    await expect(loadScenario({ sceneNodes: { select: { name: "crate" }, visible: true } })).rejects.toThrow();
  });
});
