import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { evaluateRichPlaytestAssertions } from "../src/assertions.js";
import type { IPlaytestReport } from "../src/report.js";
import type { IPlaytestScenario } from "../src/scenario.js";
import {
  measureWorldTopology,
  type IWorldTopologyField,
} from "../src/evaluators/world-gameplay.js";

function scenario(assert: IPlaytestScenario["assert"] = {}): IPlaytestScenario {
  return {
    assert,
    name: "terrain-topology",
    schemaVersion: 1,
    steps: [],
    subject: "player",
    target: "web",
    viewport: { height: 720, width: 1280 },
    warmupFrames: 0,
  } as IPlaytestScenario;
}

function report(
  debug: unknown,
  residency: Record<string, { after?: unknown }> = {},
): IPlaytestReport {
  const fields = debug as Record<string, unknown>;
  return {
    diagnostics: [],
    distance: 0,
    entity: "player",
    expectMoved: false,
    frames: 1,
    observations: {
      components: {
        terrain: {
          peakResidentBytes: { after: 1 },
          peakResidentTiles: { after: 1 },
          residentByteBudget: { after: 1 },
          residentBytes: { after: 1 },
          residentTileBudget: { after: 1 },
          residentTiles: { after: 1 },
          ...residency,
          ...(Object.hasOwn(fields, "topology")
            ? { topology: { after: fields.topology } }
            : {}),
        },
      },
      console: [],
      hud: {},
      network: [],
      resources: {},
    },
    trivialityOptOuts: [],
  };
}

for (const [label, debug] of [
  ["missing topology", {}],
  [
    "malformed topology",
    { topology: { columns: 2, depth: 1, heights: [0], rows: 2, width: 1 } },
  ],
] as const) {
  test(`fails closed for ${label}`, () => {
    const result = evaluateRichPlaytestAssertions({ report: report(debug), scenario: scenario() });
    const topologyAssertions = result.assertions.filter(({ id }) => id.startsWith("world.topology."));

    expect(topologyAssertions).toHaveLength(8);
    expect(topologyAssertions.every(({ pass }) => !pass)).toBe(true);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "TN_PLAYTEST_WORLD_TOPOLOGY_ASSERTION_FAILED" }),
    );
  });
}

test("uses routed flow when measuring drainage hierarchy", () => {
  const rows = 65;
  const columns = 65;
  const heights = Float32Array.from({ length: rows * columns }, (_, index) => {
    const x = index % columns;
    const z = Math.floor(index / columns);
    return Math.hypot(x - 32, z - 32);
  });
  const routedFlow = new Float32Array(heights.length).fill(1);
  const noFlow = new Float32Array(heights.length);
  const base: Omit<IWorldTopologyField, "flow"> = {
    columns,
    depth: 1024,
    heights,
    rows,
    width: 1024,
  };

  const routed = measureWorldTopology({ ...base, flow: routedFlow });
  const disabled = measureWorldTopology({ ...base, flow: noFlow });

  expect(routed.maxHortonStrahlerOrder).toBeGreaterThan(disabled.maxHortonStrahlerOrder);
  expect(disabled.maxHortonStrahlerOrder).toBe(0);
});

test("fails residency when retained bytes exceed the declared cap", () => {
  const result = evaluateRichPlaytestAssertions({
    report: report({}, {
      peakResidentBytes: { after: 200 },
      residentByteBudget: { after: 100 },
      residentBytes: { after: 200 },
    }),
    scenario: scenario(),
  });
  expect(result.assertions).toContainEqual(
    expect.objectContaining({ id: "world.residency", pass: false }),
  );
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ code: "TN_PLAYTEST_WORLD_RESIDENCY_ASSERTION_FAILED" }),
  );
});

test("evaluates a compact metric observation produced from the exact field", () => {
  const rows = 65;
  const columns = 65;
  const heights = Float32Array.from({ length: rows * columns }, (_, index) => {
    const x = index % columns;
    const z = Math.floor(index / columns);
    return Math.sin(x * 0.17) * 2 + Math.cos(z * 0.13) * 1.5;
  });
  const flow = new Float32Array(heights.length).fill(0.5);
  const field: IWorldTopologyField = {
    columns,
    depth: 1024,
    flow,
    heights,
    rows,
    width: 1024,
  };
  const metrics = measureWorldTopology(field);
  const result = evaluateRichPlaytestAssertions({
    report: report({ topology: { columns, depth: 1024, metrics, rows, width: 1024 } }),
    scenario: scenario(),
  });
  const observed = result.assertions
    .filter(({ id }) => id.startsWith("world.topology."))
    .map(({ details }) => (details as { metric?: number }).metric);
  expect(observed).toEqual([
    metrics.directionalAnisotropy,
    metrics.powerSpectrumSlope,
    metrics.reliefFieldEdge,
    metrics.median64mRelief,
    metrics.maxHortonStrahlerOrder,
    metrics.profileCurvatureExcessKurtosis,
    metrics.effectiveVertexDensityPerKm2,
    metrics.slopeTailAbove30Degrees,
  ]);
});

test("rejects a resident-tile topology that is smaller than the declared measurement region", () => {
  const result = evaluateRichPlaytestAssertions({
    report: report({
      topology: {
        columns: 2,
        depth: 64,
        flow: [0, 0, 0, 0],
        heights: [0, 1, 1, 0],
        rows: 2,
        width: 64,
      },
    }),
    scenario: scenario(),
  });
  expect(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "TN_PLAYTEST_WORLD_TOPOLOGY_ASSERTION_FAILED" &&
        diagnostic.message.includes("1024m by 1024m"),
    ),
  ).toBe(true);
});

test("retains terrain walk frame times for the blend-tail measurement", () => {
  const scenario = JSON.parse(
    readFileSync(path.resolve("examples/abyss-framework/playtests/terrain.playtest.json"), "utf8"),
  );
  expect(scenario.assert.performance).toEqual({ minFps: 1 });
});

test("requires the terrain scenario to prove an LOD transition after its baseline", () => {
  const scenario = JSON.parse(
    readFileSync(path.resolve("examples/abyss-framework/playtests/terrain.playtest.json"), "utf8"),
  ) as { assert: { components: Array<Record<string, unknown>> } };
  const component = (name: string): Record<string, unknown> | undefined =>
    scenario.assert.components.find((assertion) => assertion.component === name);
  const lod = scenario.assert.components.find((assertion) => assertion.component === "lodTransitions");
  expect(lod).toMatchObject({ changed: true });
  expect(lod).not.toHaveProperty("allowTrivial");
  expect(lod).not.toHaveProperty("gte");
  expect(component("maxSeamGap")).toMatchObject({ changed: true, gte: 0.000001, lte: 64 });
  expect(component("maxSeamGap")).not.toHaveProperty("allowTrivial");
  expect(component("stitchedEdges")).toMatchObject({ changed: true, entity: "terrainCpuReference", gte: 1 });
  expect(component("stitchedEdges")).not.toHaveProperty("allowTrivial");
  expect(component("maxVisualSeamGap")).toMatchObject({ lte: 0 });
  expect(component("skirtVertexCount")).toMatchObject({ gte: 1 });
  expect(component("maxLodPop")).toMatchObject({
    allowTrivial: "TerrainTiles keeps the measured LOD mismatch below its declared transition bound from startup.",
    changed: true,
    lte: 16,
  });
  expect(component("maxLodTransitionFrames")).toMatchObject({ gte: 3 });
});

test("rejects a terrain observation when reconciliation produced no stitched edge", () => {
  const result = evaluateRichPlaytestAssertions({
    report: report({}, { stitchedEdges: { after: 0 } }),
    scenario: scenario({
      components: [{ component: "stitchedEdges", entity: "terrain", gte: 1 }],
    }),
  });

  expect(result.assertions).toContainEqual(
    expect.objectContaining({ id: "component.terrain.stitchedEdges.value", pass: false }),
  );
});

test("rejects a zero raw seam observation", () => {
  const result = evaluateRichPlaytestAssertions({
    report: report({}, { maxSeamGap: { after: 0 } }),
    scenario: scenario({
      components: [
        { component: "maxSeamGap", entity: "terrain", gte: 0.000001, lte: 64 },
      ],
    }),
  });

  expect(result.assertions).toContainEqual(
    expect.objectContaining({ id: "component.terrain.maxSeamGap.value", pass: false }),
  );
});

test.each<{
  name: string;
  before?: number;
  after?: number;
  changed?: boolean;
  equals?: number;
  gte?: number;
  lte?: number;
  pass: boolean;
  trivial?: boolean;
}>([
  {
    name: "changed value within an initially satisfied range",
    changed: true,
    before: 2,
    after: 3,
    gte: 1,
    lte: 4,
    pass: true,
  },
  {
    name: "unchanged value within an initially satisfied range",
    changed: false,
    before: 2,
    after: 2,
    gte: 1,
    lte: 4,
    pass: true,
  },
  {
    name: "changed comparator unmet",
    changed: true,
    before: 2,
    after: 2,
    gte: 1,
    lte: 4,
    pass: false,
  },
  {
    name: "unchanged comparator unmet",
    changed: false,
    before: 2,
    after: 3,
    gte: 1,
    lte: 4,
    pass: false,
  },
  {
    name: "changed value outside numeric range",
    changed: true,
    before: 2,
    after: 5,
    gte: 1,
    lte: 4,
    pass: false,
  },
  {
    name: "unchanged value outside numeric range",
    changed: false,
    before: 5,
    after: 5,
    gte: 1,
    lte: 4,
    pass: false,
  },
  {
    name: "changed value matching equality",
    changed: true,
    before: 2,
    after: 3,
    equals: 3,
    pass: true,
  },
  {
    name: "unchanged value matching equality",
    changed: false,
    before: 2,
    after: 2,
    equals: 2,
    pass: true,
  },
  {
    name: "changed value violating equality",
    changed: true,
    before: 2,
    after: 3,
    equals: 2,
    pass: false,
  },
  {
    name: "initially satisfied numeric range alone stays trivial",
    before: 2,
    after: 3,
    gte: 1,
    lte: 4,
    pass: false,
    trivial: true,
  },
  {
    name: "numeric range crossed after the baseline",
    before: 0,
    after: 3,
    gte: 1,
    lte: 4,
    pass: true,
  },
  ...[true, false].flatMap((changed) => [
    { name: `${changed}: missing baseline`, changed, after: 2, gte: 1, pass: false },
    { name: `${changed}: missing current`, changed, before: 2, pass: false },
    { name: `${changed}: missing both`, changed, pass: false },
  ]),
])("component temporal comparison: $name", ({ name: _name, before, after, pass, ...expected }) => {
  const input = report({});
  if (input.observations?.components === undefined)
    throw new Error("Expected component observations.");
  input.observations.components.probe = { metric: { before, after } };
  const { trivial = false, ...comparison } = expected;
  const result = evaluateRichPlaytestAssertions({
    report: input,
    scenario: scenario({ components: [{ entity: "probe", component: "metric", ...comparison }] }),
  });
  expect(result.assertions.find(({ id }) => id === "component.probe.metric.value")).toMatchObject({
    pass,
    details: { trivial },
  });
  const rejectedAsTrivial = result.diagnostics.some(
    ({ code, message }) =>
      code === "TN_PLAYTEST_ASSERTION_TRIVIAL" && message.includes("component.probe.metric.value"),
  );
  expect(rejectedAsTrivial).toBe(trivial);
});
