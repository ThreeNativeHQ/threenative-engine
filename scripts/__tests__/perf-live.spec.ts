import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { epicOf, rowsOf } from "../perf-live.js";

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
});
