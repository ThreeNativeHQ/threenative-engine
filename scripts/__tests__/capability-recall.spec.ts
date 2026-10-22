import { describe, expect, it } from "vitest";
import {
  type ICapabilitySearchResult,
  loadCapabilityManifest,
} from "../../packages/engine-mcp/src/index.js";
import {
  type CapabilitySearcher,
  type ICapabilityRecallBudget,
  type ICapabilityRecallRow,
  compareBudget,
  loadCorpus,
  measureRecall,
  resolveCorpusSources,
  validateCorpus,
} from "../capability-recall.js";

const manifestFile = "packages/create-threenative/capabilities.json";

function row(overrides: Partial<ICapabilityRecallRow> = {}): ICapabilityRecallRow {
  return {
    expect: ["GroundSnap"],
    id: "fixture.row",
    query: "keep a character's feet on the floor",
    reject: [],
    scope: "mechanic",
    source: "template:starter#What the framework owns, and what you own",
    ...overrides,
  };
}

function result(symbol: string): ICapabilitySearchResult {
  return {
    constraints: [],
    example: "const capability = new GroundSnap();",
    importPath: "@threenative/core",
    matchedSituation: "fixture",
    score: 0,
    summary: "fixture",
    symbol,
  };
}

function budget(overrides: Partial<ICapabilityRecallBudget> = {}): ICapabilityRecallBudget {
  return {
    recallAtK: 0,
    recalledRows: [],
    rejectHits: 0,
    rowCount: 1,
    rowIds: ["fixture.row"],
    version: 1,
    zeroResultRate: 0,
    unresolvedResultRate: 0,
    notOwnedRows: {},
    ...overrides,
  };
}

describe("capability recall gate", () => {
  it("finds startup placement edits through the public terrain starter API", () => {
    const measurement = measureRecall(
      [
        row({
          expect: ["editWorldPlacements"],
          query: "move remove add generated props without rebaking",
        }),
      ],
      manifestFile,
    );
    expect(measurement.metrics.recallAtK).toBe(1);
  });

  it("pins transport ownership while keeping replication and prediction game-owned", async () => {
    const corpus = await loadCorpus();
    const transport = corpus.rows.find((candidate) => candidate.id === "request.multiplayer");
    expect(transport).toMatchObject({
      expect: ["connect"],
      query: "exchange authenticated multiplayer messages over WebTransport",
    });
    expect(transport?.notOwned).toBeUndefined();

    for (const id of ["request.multiplayer-replication", "request.multiplayer-prediction"]) {
      const gameOwned = corpus.rows.find((candidate) => candidate.id === id);
      expect(gameOwned?.notOwned, id).toBe("networked-multiplayer");
    }
  });

  it("should throw when the corpus is empty", () => {
    expect(() => validateCorpus({ rows: [], version: 1 })).toThrow(
      "TN_CAPABILITY_RECALL: corpus.json: corpus has no rows",
    );
  });

  it("should throw when a row expects a symbol absent from the manifest", () => {
    expect(() =>
      measureRecall([row({ expect: ["RenamedCapability"] })], manifestFile, (() => [
        result("GroundSnap"),
      ]) as CapabilitySearcher),
    ).toThrow("RenamedCapability");
  });

  it("should throw when a source pointer no longer resolves", async () => {
    await expect(
      resolveCorpusSources([row({ source: "template:starter#Heading removed by a later edit" })]),
    ).rejects.toThrow("template:starter#Heading removed by a later edit");
  });

  it("should accept a sandbox game pointer and reject an unknown source kind", async () => {
    await expect(
      resolveCorpusSources([row({ source: "sandbox:midway#render/world.ts" })]),
    ).resolves.toBeUndefined();
    await expect(resolveCorpusSources([row({ source: "notes:midway#world.ts" })])).rejects.toThrow(
      "notes:midway#world.ts",
    );
  });

  it("should count a row as a miss when no expected symbol is returned", () => {
    const measurement = measureRecall([row()], manifestFile, (() => []) as CapabilitySearcher);
    expect(measurement.metrics.recallAtK).toBe(0);
    expect(measurement.rows[0]?.recalled).toBe(false);
  });

  it("should accept the MCP response envelope used by the search server", () => {
    const measurement = measureRecall([row()], manifestFile, (() => ({
      guidance: "",
      results: [result("GroundSnap")],
      verdict: "matched",
    })) as CapabilitySearcher);

    expect(measurement.rows[0]?.returned).toEqual(["GroundSnap"]);
    expect(measurement.rows[0]?.recalled).toBe(true);
  });

  it("should keep an unpinned not-owned answer unresolved", () => {
    const measurement = measureRecall([row()], manifestFile, (() => ({
      guidance: "write it in src/",
      results: [],
      verdict: "none",
    })) as CapabilitySearcher);

    expect(measurement.rows[0]?.guided).toBe(false);
    expect(measurement.rows[0]?.zeroResult).toBe(true);
    expect(measurement.rows[0]?.unresolvedResult).toBe(true);
    expect(measurement.metrics.zeroResultRate).toBe(1);
    expect(measurement.metrics.unresolvedResultRate).toBe(1);
  });

  it("should require the corpus-pinned not-owned guidance", () => {
    const guidance = loadCapabilityManifest(manifestFile).notOwned.find(
      (entry) => entry.id === "inventory",
    )?.guidance;
    expect(guidance).toBeDefined();

    const measurement = measureRecall([row({ notOwned: "inventory" })], manifestFile, (() => ({
      guidance,
      results: [],
      verdict: "none",
    })) as CapabilitySearcher);
    expect(measurement.rows[0]?.guided).toBe(true);
    expect(measurement.metrics.guided).toBe(1);
    expect(measurement.metrics.actionable).toBe(1);
  });

  it("should reject a not-owned response whose guidance differs from the manifest", () => {
    expect(() =>
      measureRecall([row({ notOwned: "inventory" })], manifestFile, (() => ({
        guidance: "write it in src/",
        results: [],
        verdict: "none",
      })) as CapabilitySearcher),
    ).toThrow("not-owned response guidance does not match its manifest entry");
  });

  it("should fail when zeroResultRate exceeds the recorded floor", () => {
    const measurement = measureRecall([row()], manifestFile, (() => []) as CapabilitySearcher);
    const regressions = compareBudget(measurement, budget());
    expect(regressions).toContainEqual({
      message: "unresolvedResultRate 1.000000 exceeds floor 0.000000",
      metric: "unresolvedResultRate",
      rowIds: ["fixture.row"],
    });
  });

  it("should fail when rowCount drops below the floor", () => {
    const measurement = measureRecall([row()], manifestFile, (() => [
      result("GroundSnap"),
    ]) as CapabilitySearcher);
    const regressions = compareBudget(measurement, budget({ rowCount: 2 }));
    expect(regressions).toContainEqual({
      message: "rowCount 1 is below floor 2",
      metric: "rowCount",
      rowIds: ["corpus"],
    });
  });

  it("should reject a lost baseline hit when another row compensates", () => {
    const measurement = measureRecall(
      [
        row({ id: "baseline.hit", query: "lost baseline hit" }),
        row({ id: "compensating.improvement", query: "newly recalled" }),
      ],
      manifestFile,
      ((query: string) =>
        query === "newly recalled" ? [result("GroundSnap")] : []) as CapabilitySearcher,
    );
    const protectedBudget = budget({
      recallAtK: 0.5,
      recalledRows: ["baseline.hit"],
      rowCount: 2,
      zeroResultRate: 0.5,
    });

    expect(measurement.metrics.recallAtK).toBe(protectedBudget.recallAtK);
    expect(measurement.metrics.zeroResultRate).toBe(protectedBudget.zeroResultRate);
    expect(compareBudget(measurement, protectedBudget)).toContainEqual({
      message: "1 previously recalled row no longer reaches an expected symbol",
      metric: "recalledRows",
      rowIds: ["baseline.hit"],
    });
  });

  it("should reject a corpus row replacement even when rowCount stays constant", () => {
    const measurement = measureRecall(
      [
        row({ id: "baseline.hit", query: "baseline still valid" }),
        row({ id: "compensating.improvement", query: "newly recalled" }),
      ],
      manifestFile,
      (() => [result("GroundSnap")]) as CapabilitySearcher,
    );
    const protectedBudget = budget({
      recallAtK: 0.5,
      recalledRows: ["baseline.hit"],
      rowCount: 2,
      rowIds: ["baseline.hit", "baseline.miss"],
      zeroResultRate: 0.5,
    });

    expect(compareBudget(measurement, protectedBudget)).toContainEqual({
      message: "corpus row ids changed; missing baseline.miss; added compensating.improvement",
      metric: "rowIds",
      rowIds: ["baseline.miss", "compensating.improvement"],
    });
  });

  it("should protect the pinned not-owned row-to-guidance mapping", () => {
    const guidance = loadCapabilityManifest(manifestFile).notOwned.find(
      (entry) => entry.id === "inventory",
    )?.guidance;
    const measurement = measureRecall(
      [row({ id: "baseline.not-owned", notOwned: "inventory" })],
      manifestFile,
      (() => ({ guidance, results: [], verdict: "none" })) as CapabilitySearcher,
    );

    expect(
      compareBudget(
        measurement,
        budget({
          notOwnedRows: { "baseline.not-owned": "save-load" },
        }),
      ),
    ).toContainEqual({
      message:
        "pinned notOwned rows changed; expected baseline.not-owned=save-load; current baseline.not-owned=inventory",
      metric: "notOwnedRows",
      rowIds: ["baseline.not-owned"],
    });
  });

  it("should resolve and score the complete text of a wrapped brief bullet", async () => {
    const wrappedQuery =
      "Use a third-person camera and a compact hub that leads to at least two distinct areas. Name the starting area the literal `hub`; the proof compares `state.area` against that word.";
    const wrappedRow = row({
      expect: ["defineGame"],
      id: "brief.exploration.wrapped",
      query: wrappedQuery,
      source: "brief:exploration#1",
    });

    await expect(resolveCorpusSources([wrappedRow])).resolves.toBeUndefined();
    let searchedQuery = "";
    const measurement = measureRecall([wrappedRow], manifestFile, ((query: string) => {
      searchedQuery = query;
      return [result("defineGame")];
    }) as CapabilitySearcher);

    expect(searchedQuery).toBe(wrappedQuery);
    expect(measurement.rows[0]?.query).toBe(wrappedQuery);
    expect(measurement.rows[0]?.recalled).toBe(true);
  });

  it("should pass when every number improves", () => {
    const measurement = measureRecall([row()], manifestFile, (() => [
      result("GroundSnap"),
    ]) as CapabilitySearcher);
    expect(
      compareBudget(measurement, budget({ recallAtK: 0.5, rejectHits: 1, zeroResultRate: 1 })),
    ).toEqual([]);
  });
});
