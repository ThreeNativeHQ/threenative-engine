import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { epicOf, pointsOf, rowsOf } from "../perf-live.js";

const pilot = "artifacts/engine-load-test/prd-449/pilots/scoreboard-tn-r3-2026-09-28.json";

describe("perf-live", () => {
  it.skipIf(!existsSync(new URL(`../../${pilot}`, import.meta.url)))(
    "turns a bench report into one row per workload with p50 and p95",
    async () => {
      const report = JSON.parse(
        await readFile(new URL(`../../${pilot}`, import.meta.url), "utf8").catch(() => "null"),
      );
      if (report === null) return; // pilots are untracked local artifacts
      const rows = rowsOf(report, "x.json", 1);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row.p95).toBeGreaterThanOrEqual(row.p50);
      // Copied pilots share one mtime, so the date in the file name orders them.
      expect(rowsOf(report, "x-2026-09-27.json", 5)[0]?.t).toBe(Date.parse("2026-09-27T12:00:00Z"));
      expect(rowsOf(report, "x.json", 5)[0]?.t).toBe(5);
    },
  );

  it("carries p99 and the hitch count into each row, so the tooltip can show them", () => {
    const run = {
      arm: "tn-web",
      build: { notes: "", type: "release" },
      device: { battery: null, label: "d" },
      display: { height: 720, refreshHz: 60, vsync: false, width: 1280 },
      driver: { adapter: "a", renderer: "r" },
      engine: { name: "threenative", version: "w" },
      rungs: [
        {
          drawCalls: 5,
          frameMs: [10, 10, 10, 10, 10, 10, 10, 10, 10, 50],
          mode: "L1",
          objectCount: 4,
          positionHash: "h",
          repeat: 0,
          triangles: 1,
          visibleObjects: 4,
        },
      ],
    };
    const [row] = rowsOf(run, "x.json", 1);
    expect(row).toMatchObject({ hitches: 1, p50: 10, p99: 50 });
  });

  it("fails closed on a json that is not a run report", () => {
    expect(() => rowsOf({ hello: 1 }, "x.json", 1)).toThrow();
  });

  it("reads cycles, phases and box counts from the epic PRD", () => {
    const md =
      "## Cycle v1 — land it\n#### Phase v1.0: A\n- [x] one proof: x\n- [ ] two\n## Cycle v2 — next\n#### Phase v2.1: B\n- [ ] three\n";
    const [v1, v2] = epicOf(md);
    expect([v1?.id, v1?.phases[0]?.done, v1?.phases[0]?.total, v2?.phases[0]?.id]).toEqual([
      "v1",
      1,
      2,
      "v2.1",
    ]);
    expect(v1?.phases[0]?.boxes[0]?.text).toBe("one");
  });

  it("groups repeats into benchmark points: medians per arm, ratios, host load, time order", () => {
    const run = (
      arm: "tn-desktop" | "tn-engine-desktop",
      rungs: [number, number, number][],
      loaded = false,
    ) => ({
      arm,
      build: { notes: "", type: "release" },
      device: { battery: null, label: "d" },
      display: { height: 720, refreshHz: 60, vsync: false, width: 1280 },
      driver: { adapter: "a", renderer: "r" },
      engine: { name: "threenative", version: "w" },
      ...(loaded ? { hostLoad: { cores: 12, load1: 10, absolutes: "invalid-absolute" } } : {}),
      rungs: rungs.map(([objectCount, cpu, thread]) => ({
        cpuMsPerFrame: cpu,
        threadCpuMs: [thread, thread, thread],
        drawCalls: 5,
        frameMs: [10, 10, 10],
        mode: "L1",
        objectCount,
        positionHash: "h",
        repeat: 0,
        triangles: 1,
        visibleObjects: objectCount,
      })),
    });
    const rows = [
      // Two repeats per arm; the legacy frame costs twice the native one.
      ...rowsOf(run("tn-desktop", [[4, 80, 6]]), "v111/step0-tn-desktop-r1.json", 1),
      ...rowsOf(run("tn-desktop", [[4, 80, 6]]), "v111/step0-tn-desktop-r2.json", 2),
      ...rowsOf(run("tn-engine-desktop", [[4, 40, 3]]), "v111/step0-tn-engine-desktop-r1.json", 3),
      ...rowsOf(run("tn-engine-desktop", [[4, 40, 3]]), "v111/step0-tn-engine-desktop-r2.json", 4),
      // Three legacy repeats, one on a loaded host: the median is the middle run.
      ...rowsOf(run("tn-desktop", [[4, 90, 6]], true), "v111/step2-tn-desktop-r1.json", 5),
      ...rowsOf(run("tn-desktop", [[4, 100, 6]]), "v111/step2-tn-desktop-r2.json", 6),
      ...rowsOf(run("tn-desktop", [[4, 96, 6]]), "v111/step2-tn-desktop-r3.json", 7),
      ...rowsOf(run("tn-engine-desktop", [[4, 50, 3]]), "v111/step2-tn-engine-desktop-r1.json", 8),
      ...rowsOf(run("tn-engine-desktop", [[4, 60, 3]]), "v111/step2-tn-engine-desktop-r2.json", 9),
      // One file, two object counts of the same mode: two points, never one mixed median.
      ...rowsOf(
        run("tn-desktop", [
          [4, 80, 6],
          [8, 80, 6],
        ]),
        "crossing-cuts/a1-tn-desktop-r1.json",
        10,
      ),
      ...rowsOf(
        run("tn-engine-desktop", [
          [4, 40, 3],
          [8, 80, 3],
        ]),
        "crossing-cuts/a1-tn-engine-desktop-r1.json",
        11,
      ),
      // Ignored: no desktop arm in the name; native only, so no ratio.
      ...rowsOf(run("tn-desktop", [[4, 1, 1]]), "v111/other-tn-r9.json", 12),
      ...rowsOf(run("tn-engine-desktop", [[4, 1, 1]]), "solo-tn-engine-desktop-r1.json", 13),
    ];
    const points = pointsOf(rows);
    expect(points.map((p) => `${p.label}@${p.objects}`)).toEqual([
      "v111/step0@4",
      "v111/step2@4",
      "crossing-cuts/a1@4",
      "crossing-cuts/a1@8",
    ]);
    expect(points[0]).toMatchObject({
      invalid: false,
      legacyRuns: 2,
      nativeRuns: 2,
      ratioCpu: 2,
      ratioNoPresent: 2,
      t: 4,
    });
    expect(points[1]).toMatchObject({
      invalid: true,
      legacyRuns: 3,
      nativeRuns: 2,
      legacyCpu: 96,
      nativeCpu: 55,
      ratioNoPresent: 2,
      t: 9,
    });
    expect(points[1]?.ratioCpu).toBeCloseTo(96 / 55);
    expect(points.slice(2).map((p) => p.ratioCpu)).toEqual([2, 1]);
  });
});
