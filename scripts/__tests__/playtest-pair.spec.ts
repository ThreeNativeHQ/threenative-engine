import { describe, expect, it } from "vitest";
import { type IPairOptions, pairReports, parsePairArgs } from "../playtest-pair.js";

const OPTIONS: IPairOptions = {
  entity: "world",
  fields: ["shadowByMove", "shadowRenders"],
  equal: ["shadowByMove"],
};

const WORLD = {
  shadowByMove: 1,
  shadowRenders: 4,
  cameraPosition: [0, 1, 2],
  cameraTarget: [0, 0, 0],
};

const sample = (label: string, tick: number, world: Record<string, unknown>) => ({
  label,
  tick,
  snapshots: { world },
});

const report = (...componentSeries: unknown[]) => ({ observations: { componentSeries } });

describe("pairReports", () => {
  it("passes an equal pair", () => {
    const result = pairReports(
      report(sample("pre", 10, WORLD), sample("post", 40, WORLD)),
      report(sample("pre", 10, WORLD), sample("post", 40, WORLD)),
      OPTIONS,
    );
    expect(result.mismatches).toEqual([]);
    expect(result.rows.map((row) => row.label)).toEqual(["pre", "post"]);
  });

  it("reports an --equal field difference as a mismatch", () => {
    const result = pairReports(
      report(sample("pre", 10, WORLD)),
      report(sample("pre", 10, { ...WORLD, shadowByMove: 0 })),
      OPTIONS,
    );
    expect(result.mismatches).toEqual([{ label: "pre", reason: "shadowByMove differs: 1|0" }]);
  });

  it("reports a label missing on one side as a mismatch", () => {
    const result = pairReports(
      report(sample("pre", 10, WORLD), sample("post", 40, WORLD)),
      report(sample("pre", 10, WORLD)),
      OPTIONS,
    );
    expect(result.mismatches).toEqual([{ label: "post", reason: "missing in B" }]);
  });

  it("reports an empty series as a mismatch", () => {
    const result = pairReports(report(), report(sample("pre", 10, WORLD)), OPTIONS);
    expect(result.mismatches).toContainEqual({ reason: "series A is empty" });
  });

  it("reports a camera diff without failing the pair", () => {
    const result = pairReports(
      report(sample("pre", 10, WORLD)),
      report(sample("pre", 10, { ...WORLD, cameraPosition: [0, 1, 3] })),
      OPTIONS,
    );
    expect(result.rows.map((row) => row.camera)).toEqual(["diff"]);
    expect(result.mismatches).toEqual([]);
  });

  it("rejects arguments without --entity", () => {
    expect(() => parsePairArgs(["a.json", "b.json", "--fields", "shadowByMove"])).toThrow(
      "--entity",
    );
  });
});
