import { describe, expect, it } from "vitest";

const { breakPoint, loadOf, rampCells } = await import(
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
