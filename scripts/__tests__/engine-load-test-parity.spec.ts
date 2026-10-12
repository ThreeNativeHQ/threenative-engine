import { describe, expect, it } from "vitest";
import {
  COLD_CACHE_BYTES,
  assertSymmetricSpans,
  assertWallClock,
  cacheDelta,
  parityProblem,
  parityRows,
  parityTable,
} from "../engine-load-test/parity.js";

const arm = { adapter: "NVIDIA", boot: "ready", window: "1280x720" };

describe("the arm parity guard", () => {
  it("passes when every run of both arms agrees on every required facet", () => {
    const rows = parityRows([arm, arm], [arm], { required: ["adapter", "boot", "window"] });
    expect(rows.every((row) => row.pass)).toBe(true);
    expect(parityProblem(rows)).toBeUndefined();
  });

  it("fails a facet the arms disagree on and names it in the table", () => {
    const rows = parityRows([arm], [{ ...arm, window: "1920x1080" }], { required: ["window"] });
    const problem = parityProblem(rows, ["legacy", "native"]);
    expect(problem).toContain("1 facet");
    expect(problem).toContain("| window | 1280x720 | 1920x1080 | MISMATCH |");
    expect(parityTable(rows, ["legacy", "native"]).split("\n")[0]).toBe(
      "| facet | legacy | native | parity |",
    );
  });

  it("fails an arm that disagrees with itself across runs", () => {
    const rows = parityRows([arm, { ...arm, adapter: "llvmpipe" }], [arm], {
      required: ["adapter"],
    });
    expect(rows.find((row) => row.facet === "adapter")).toMatchObject({
      left: "NVIDIA | llvmpipe",
      pass: false,
    });
  });

  it("fails a required facet that neither arm reported, and an arm with no runs", () => {
    expect(parityProblem(parityRows([arm], [arm], { required: ["presentMode"] }))).toContain(
      "presentMode",
    );
    expect(parityProblem(parityRows([], [arm], { required: ["adapter"] }))).toContain("missing");
  });

  it("fails a fact both arms share when it is not the fixed value they must hold", () => {
    const both = { ...arm, driverShaderCache: "cold (+3 files, +4096 KiB)" };
    const rows = parityRows([both], [both], { expected: { driverShaderCache: "warm" } });
    expect(rows.find((row) => row.facet === "driverShaderCache")?.pass).toBe(false);
  });

  it("shows the facts both arms were handed from one source, and lets one fail", () => {
    const rows = parityRows([arm], [arm], {
      shared: [
        { facet: "scenario", value: "r5.json" },
        { facet: "bundle", left: "abc", pass: false, right: "def" },
      ],
    });
    expect(rows.slice(0, 2)).toEqual([
      { facet: "scenario", left: "r5.json", pass: true, right: "r5.json" },
      { facet: "bundle", left: "abc", pass: false, right: "def" },
    ]);
  });
});

describe("the driver shader-cache delta", () => {
  it("counts new files and grown bytes, and ignores a shrunk file", () => {
    const before = new Map([
      ["a", 100],
      ["b", 500],
    ]);
    const after = new Map([
      ["a", 160],
      ["b", 400],
      ["c", 40],
    ]);
    expect(cacheDelta(before, after)).toEqual({ added: 1, bytes: 100 });
  });

  it("calls megabytes a cold cache, not a few appended shaders", () => {
    expect(COLD_CACHE_BYTES).toBe(1024 * 1024);
  });
});

describe("the instrument symmetry guards", () => {
  it("refuses arms that emit different span families", () => {
    expect(() =>
      assertSymmetricSpans(["render", "update"], ["render"], ["legacy", "native"]),
    ).toThrow(/span families differ: legacy only \[update\], native only \[\]/u);
    expect(() => assertSymmetricSpans(["render"], ["render"])).not.toThrow();
  });

  it("refuses an arm whose frame budget phases all read zero", () => {
    const window = (phases: Record<string, number>) =>
      `TN_FRAME_BUDGET:${JSON.stringify({
        phases: Object.fromEntries(Object.entries(phases).map(([k, mean]) => [k, { mean }])),
      })}`;
    const flat = window({ overlay: 0, render: 0, residual: 0, ui: 0, update: 0 });
    expect(() => assertWallClock(`${flat}\n${flat}`)).toThrow(/performance\.now does not advance/u);
    expect(() => assertWallClock(`${flat}\n${window({ render: 1.5 })}`)).not.toThrow();
  });

  it("fails closed when the run printed no frame budget window at all", () => {
    expect(() => assertWallClock("no windows here")).toThrow(/no TN_FRAME_BUDGET window/u);
  });
});
