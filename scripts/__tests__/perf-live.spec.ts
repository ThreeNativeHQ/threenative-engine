import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  type IPoint,
  deltaOf,
  epicOf,
  heroOf,
  phaseGapOf,
  pointsOf,
  rowsOf,
  sentenceOf,
  staleReason,
  valueColor,
} from "../perf-live.js";

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

  it("colours a KPI value: green at the target, orange above parity, red below it", () => {
    expect([0.79, 1, 1.04, 1.99, 2, 3].map(valueColor)).toEqual([
      "red",
      "orange",
      "orange",
      "orange",
      "green",
      "green",
    ]);
  });

  it("reports a delta as flat inside the 10% noise band and up or down beyond it", () => {
    expect(deltaOf(1, 1.1).dir).toBe("flat");
    expect(deltaOf(1, 0.91).dir).toBe("flat");
    expect(deltaOf(1, 1.2)).toMatchObject({ dir: "up" });
    expect(deltaOf(1, 0.8)).toMatchObject({ dir: "down" });
    expect(deltaOf(1, 1.5).pct).toBeCloseTo(0.5);
  });

  it("says 'cheaper' at parity or better and 'costs' below it", () => {
    expect(sentenceOf(1.04)).toBe("Native is 1.04× cheaper than legacy on R5. Target 2×.");
    expect(sentenceOf(0.5)).toContain("Native costs 2.00× legacy");
  });

  const HOUR = 3_600_000;
  const point = (
    label: string,
    mode: string,
    t: number,
    ratio?: number,
    objects = 4096,
  ): IPoint => ({
    label,
    mode,
    objects,
    t,
    m: t,
    invalid: false,
    legacyRuns: 1,
    nativeRuns: 1,
    ...(ratio === undefined ? {} : { ratioNoPresent: ratio }),
  });

  it("marks the hero stale after 6 hours or when R2 or R3 was measured after R5", () => {
    const now = 100 * HOUR;
    const r5 = point("v/r5", "R5", now - HOUR, 1.5);
    expect(staleReason([r5], now)).toBeUndefined();
    expect(heroOf([r5], now)).toMatchObject({ status: "orange", ratio: 1.5 });
    expect(heroOf([point("v/old", "R5", now - 7 * HOUR, 2.5)], now)).toMatchObject({
      status: "yellow",
      valueColor: "green",
    });
    // R2 minutes after R5 is the same session; an hour later it is stale.
    expect(staleReason([r5, point("v/r2", "R2", r5.t + 60_000, 0.4)], now)).toBeUndefined();
    expect(staleReason([r5, point("v/r2", "R2", r5.t + HOUR / 2, 0.4)], now)).toContain("v/r2");
    // The control rung and points without a KPI never make R5 stale.
    expect(staleReason([r5, point("c", "R2", now, 1, 256)], now)).toBeUndefined();
    expect(staleReason([r5, point("n", "R3", now)], now)).toBeUndefined();
  });

  it("builds the hero from the newest R5 KPI point and compares it with the one before", () => {
    const now = 10 * HOUR;
    const hero = heroOf(
      [
        point("a", "R5", now - 3 * HOUR, 1),
        point("b", "R2", now - 2 * HOUR, 0.4),
        point("c", "R5", now - HOUR, 1.5),
      ],
      now,
    );
    expect(hero).toMatchObject({ label: "c", status: "orange", delta: { dir: "up", label: "a" } });
    expect(heroOf([point("b", "R2", now, 0.4)], now).status).toBe("none");
    expect(heroOf([], now).status).toBe("none");
  });

  it("names the phase where native spends the most extra ms, and none when it is never slower", () => {
    expect(
      phaseGapOf(
        { game: 2, projection: 2, present: 70 },
        { game: 3, projection: 6.1, present: 99 },
      ),
    ).toEqual({ phase: "projection", native: 6.1, legacy: 2 });
    expect(phaseGapOf({ game: 5 }, { game: 1 })).toBeUndefined();
  });

  it("carries per-arm phases from runs into the point and the hero", () => {
    const run = (arm: string, game: number) => ({
      arm,
      build: { notes: "", type: "release" },
      device: { battery: null, label: "d" },
      display: { height: 720, refreshHz: 60, vsync: false, width: 1280 },
      driver: { adapter: "a", renderer: "r" },
      engine: { name: "threenative", version: "w" },
      rungs: [
        {
          cpuMsPerFrame: 20,
          threadCpuMs: [game + 1, game + 1],
          presentCpuMs: [70, 70],
          phases: {
            game: [game, game],
            animation: [0, 0],
            matrixWorld: [0, 0],
            projection: [0, 0],
            render: [0, 0],
          },
          drawCalls: 5,
          frameMs: [10, 10],
          mode: "L1",
          objectCount: 4096,
          positionHash: "h",
          repeat: 0,
          triangles: 1,
          visibleObjects: 4096,
        },
      ],
    });
    const rows = [
      ...rowsOf(run("tn-desktop", 4), "v111/p-tn-desktop-r1.json", 1),
      ...rowsOf(run("tn-engine-desktop", 8), "v111/p-tn-engine-desktop-r1.json", 2),
    ];
    const [p] = pointsOf(rows);
    expect(p?.legacyPhases).toMatchObject({ game: 4, other: 1, present: 70 });
    expect(p?.nativePhases).toMatchObject({ game: 8, other: 1, present: 70 });
    // The hero reads phases from the newest R5 point that has them.
    const r5 = {
      ...point("v/p", "R5", 1, 1.2),
      legacyPhases: p?.legacyPhases,
      nativePhases: p?.nativePhases,
    };
    expect(heroOf([r5 as IPoint], 3).phases?.gap).toEqual({ phase: "game", native: 8, legacy: 4 });
  });
});
