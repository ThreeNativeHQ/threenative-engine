import { describe, expect, it } from "vitest";

const { breakPoint, familyOf, loadOf, rampCells, rollingMedian, trendSeries } = await import(
  new URL("../stress-dashboard.mjs", import.meta.url).href
);

describe("stress dashboard: load ramp", () => {
  it("reads load=N from the variant and defaults to 1", () => {
    expect(loadOf("plainShadow&load=4&arm=tn-l4&uncapped")).toBe(4);
    expect(loadOf("load=8")).toBe(8);
    expect(loadOf("stress")).toBe(1);
    expect(loadOf(undefined)).toBe(1);
    // `arm=load` is an arm name, and a malformed value is not a load.
    expect(loadOf("arm=load")).toBe(1);
    expect(loadOf("load=0")).toBe(1);
    expect(loadOf("load=x")).toBe(1);
  });

  it("finds the first load over the line, and says when an earlier load has no run", () => {
    const cells = [
      { load: 1, p95: 12 },
      { load: 2, p95: null },
      { load: 4, p95: 20 },
      { load: 8, p95: 90 },
    ];
    expect(breakPoint(cells, 16.7)).toEqual({ load: 4, p95: 20, gapBefore: true });
    expect(breakPoint(cells, 33.3)).toEqual({ load: 8, p95: 90, gapBefore: true });
    expect(breakPoint(cells.slice(0, 1), 16.7)).toBeNull();
    // Unsorted input and an all-missing series.
    expect(breakPoint([...cells].reverse(), 16.7)?.load).toBe(4);
    expect(breakPoint([{ load: 1, p95: null }], 16.7)).toBeNull();
  });

  it("keeps a missing or void run as null, never zero", () => {
    const row = (id: number, engine: string, variant: string, p95: number, peak = 3) => ({
      id,
      engine,
      variant,
      decision: "measure",
      pass: "vsync",
      shadow: "plain",
      build: { sha256: "4fb0aba5a921" },
      load: { peak },
      metrics: { presentedP95Ms: p95 },
    });
    const ctx = { loadVoid: 6, shadowOf: (r: { shadow: string }) => r.shadow };
    const series = rampCells(
      [
        row(1, "three-vanilla", "stress", 16.8),
        row(2, "three-vanilla", "load=2", 25, 6.5),
        row(3, "three-vanilla", "load=4", 50),
        { ...row(4, "three-vanilla", "load=8", 0), load: undefined },
      ],
      ctx,
    );
    const vanilla = series.find((s: { engine: string }) => s.engine === "three-vanilla");
    const vsync = vanilla.cells.vsync.map((c: { load: number; row?: { id: number } }) => [
      c.load,
      c.row?.id ?? null,
    ]);
    // load 2 is void (host load 6.5 > 6) and load 8 has no fair-window load record.
    expect(vsync).toEqual([
      [1, 1],
      [2, null],
      [4, 3],
      [8, null],
    ]);
  });
});

describe("stress dashboard: arm families", () => {
  it("strips a trailing -l<N> from the arm", () => {
    expect(familyOf("plainShadow&load=4&arm=tn-l4&uncapped")).toBe("tn");
    expect(familyOf("plainShadow&load=8&arm=tn-clamp-l8")).toBe("tn-clamp");
    expect(familyOf("load=4&arm=vanilla-l4")).toBe("vanilla");
    // No arm, or an arm without a ramp suffix, has no family.
    expect(familyOf("stress")).toBe("");
    expect(familyOf("arm=stack3")).toBe("");
    expect(familyOf("arm=load")).toBe("");
  });

  it("splits a series by family only when an engine has two or more families", () => {
    const row = (id: number, variant: string, p95: number) => ({
      id,
      engine: "threenative-wasm",
      variant,
      decision: "measure",
      pass: "vsync",
      shadow: "plain",
      build: { sha256: "4fb0aba5a921" },
      load: { peak: 3 },
      metrics: { presentedP95Ms: p95 },
    });
    const ctx = { loadVoid: 6, shadowOf: (r: { shadow: string }) => r.shadow };
    const split = rampCells(
      [row(1, "load=2&arm=tn-l2", 20), row(2, "load=2&arm=tn-clamp-l2", 18)],
      ctx,
    );
    expect(split.map((s: { family: string }) => s.family).sort()).toEqual(["tn", "tn-clamp"]);
    const at2 = (s: { cells: { vsync: { load: number; row?: { id: number } }[] } }) =>
      s.cells.vsync.find((c) => c.load === 2)?.row?.id;
    expect(split.map(at2).sort()).toEqual([1, 2]);
    // One family (or none) keeps today's single series.
    const one = rampCells([row(1, "load=2&arm=tn-l2", 20), row(2, "stress", 17)], ctx);
    expect(one).toHaveLength(1);
  });
});

describe("stress dashboard: trend series", () => {
  const row = (
    id: number,
    engine: string,
    variant: string,
    pass: string | undefined,
    peak = 3,
  ) => ({
    id,
    engine,
    variant,
    pass,
    shadow: variant.includes("plainShadow") ? "plain" : "virtual",
    load: { peak },
    metrics: { fps: 60 },
  });
  const ctx = { loadVoid: 6, shadowOf: (r: { shadow: string }) => r.shadow };

  it("makes one series per scene and pass at load 1, without ramp, vanilla or void rows", () => {
    const series = trendSeries(
      [
        row(1, "threenative-wasm", "stress", "vsync"),
        row(2, "threenative-wasm", "stress", "uncapped"),
        row(3, "threenative-wasm", "plainShadow&arm=a", "uncapped"),
        row(4, "threenative-wasm", "stress", "vsync"),
        row(5, "threenative-wasm", "plainShadow&load=4&arm=tn-l4", "vsync"),
        row(6, "three-vanilla", "stress", "vsync"),
        row(7, "threenative-wasm", "stress", "vsync", 6.5),
        row(8, "threenative-wasm", "stress", undefined),
      ],
      ctx,
    );
    expect(series.map((s: { key: string }) => s.key)).toEqual([
      "virtual|vsync",
      "virtual|uncapped",
      "plain|uncapped",
    ]);
    expect(series[0].rows.map((r: { id: number }) => r.id)).toEqual([1, 4]);
  });

  it("takes a centered rolling median of 5, clipped at the ends", () => {
    expect(rollingMedian([1, 100, 3, 4, 5, 6], 5)).toEqual([3, 3.5, 4, 5, 4.5, 5]);
    expect(rollingMedian([], 5)).toEqual([]);
  });
});
