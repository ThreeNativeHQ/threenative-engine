import { existsSync } from "node:fs";
import { readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { expectedLadderCounts } from "../../examples/engine-load-test/src/ladder.js";
import { makeTempDir } from "../../test-support/temp-dir.js";
import {
  type IPoint,
  deltaOf,
  desktopOf,
  epicOf,
  heroOf,
  ledgerTab,
  loadRuns,
  phaseGapOf,
  pointsOf,
  rowsOf,
  sentenceOf,
  staleReason,
  valueColor,
  webOf,
  withNav,
} from "../perf-live.js";

const pilot = "artifacts/engine-load-test/prd-449/pilots/scoreboard-tn-r3-2026-09-28.json";

describe("perf-live", () => {
  describe("Desktop KPI (v1)", () => {
    const run = (arm: string, mode: "R2" | "R3" | "R5", thread: number) => ({
      arm,
      build: { notes: "", type: "release" },
      device: { battery: null, label: "test fixture" },
      display: { height: 1080, refreshHz: 60, vsync: false, width: 1920 },
      driver: { adapter: "Intel test adapter", renderer: "r" },
      engine: { name: arm === "godot-desktop" ? "godot" : "threenative", version: "test" },
      identity: { sourceSha: "abc123" },
      rungs: [
        {
          mode,
          framePath: path.resolve("scripts/__tests__/fixtures/engine-load-test/scene.png"),
          objectCount: 4096,
          repeat: 0,
          positionHash: "h",
          visibleObjects: 4096,
          drawCalls: 116,
          triangles: 155919,
          frameMs: [thread + 100, thread + 101, thread + 102],
          threadCpuMs: [thread, thread, thread],
          ladder: expectedLadderCounts(mode, 4096),
          ...(mode === "R2" ? {} : { foxMeasurement: { heightM: 0.5, screenFraction: 0.04 } }),
          renderCheck: {
            distinctColors: 100,
            luminanceStdDev: 0.2,
            maxLuminance: 0.8,
            sampledPixels: 1000,
          },
        },
      ],
    });
    it("renders FPS for both desktop and web arms in the comparison and KPI table", async () => {
      const legacy = run("tn-desktop", "R5", 20);
      const native = run("tn-engine-desktop", "R5", 10);
      const [legacyRung] = legacy.rungs;
      const [nativeRung] = native.rungs;
      if (!legacyRung || !nativeRung) throw new Error("missing fixture rung");
      legacyRung.frameMs = [10, 10, 10, 20];
      nativeRung.frameMs = [5, 5, 5, 10];
      const reportRows = [
        ...rowsOf(legacy, "fps-tn-desktop-r1.json", 1),
        ...rowsOf(native, "fps-tn-engine-desktop-r1.json", 2),
      ];
      expect(reportRows[0]).toMatchObject({ fps: 80, fpsLow1: 50 });
      const loaded = [legacy, native].map((report, i) => ({
        report: report as Parameters<typeof desktopOf>[0][number]["report"],
        file: `v1-confirm-fps-${report.arm}-r1.json`,
        mtime: i + 1,
        rows: rowsOf(report, `v1-confirm-fps-${report.arm}-r1.json`, i + 1),
      }));
      const desktop = desktopOf(loaded);
      expect(desktop.kpi.find((r) => r.rung === "R5")?.pair?.left).toMatchObject({
        fps: 80,
        fpsLow1: 50,
      });
      const elements = new Map<string, { innerHTML: string; addEventListener(): void }>();
      const html = await readFile(new URL("../perf-live.html", import.meta.url), "utf8");
      const script = (html.split("<script>")[1] as string)
        .split("</script>")[0]
        ?.replace("tick(); setInterval(tick, 2000);", "");
      runInNewContext(
        `${script}\ndesktop = data; web = webData; renderCompare(); renderDesktop(); renderWeb();`,
        {
          data: desktop,
          webData: webOf([
            ...rowsOf({ ...legacy, arm: "tn-web" }, "fps-tn-web-r1.json", 1),
            ...rowsOf({ ...native, arm: "tn-engine-web" }, "fps-tn-engine-web-r1.json", 2),
          ]),
          document: {
            getElementById: (id: string) => {
              if (!elements.has(id)) elements.set(id, { innerHTML: "", addEventListener() {} });
              return elements.get(id);
            },
          },
        },
      );
      for (const id of ["compare", "desktop", "web"]) {
        const output = elements.get(id)?.innerHTML;
        expect(output).toContain("80.0 fps");
        expect(output).toContain("160.0 fps");
        expect(output).toContain("50.0 fps");
        expect(output).toContain("100.0 fps");
      }
      expect(elements.get("compare")?.innerHTML).toContain("uncapped (vsync off)");
      expect(elements.get("compare")?.innerHTML).toContain(
        "page frames per second (performance.now)",
      );
      expect(elements.get("desktop")?.innerHTML).toContain("uncapped (vsync off)");
      legacyRung.frameMs = [];
      expect(() => rowsOf(legacy, "empty.json", 1)).toThrow();
    });

    async function fixture(
      check: (
        dir: string,
        put: (
          tag: string,
          arm: string,
          mode: "R2" | "R3" | "R5",
          thread: number,
          round?: number,
          time?: number,
        ) => Promise<void>,
      ) => Promise<void>,
    ) {
      const dir = await makeTempDir("perf-live-");
      const put = async (
        tag: string,
        arm: string,
        mode: "R2" | "R3" | "R5",
        thread: number,
        round = 1,
        time = 1,
      ) => {
        const file = path.join(dir, `${tag}-${arm}-r${round}.json`);
        await writeFile(file, JSON.stringify(run(arm, mode, thread)));
        await utimes(file, time, time);
      };
      try {
        await check(dir, put);
      } finally {
        await rm(dir, { recursive: true });
      }
    }

    it("loads confirmation sets and uses pooled and per-round no-present thread CPU ratios", async () => {
      await fixture(async (dir, put) => {
        for (const [mode, tag] of [
          ["R2", "v1-confirm-R2"],
          ["R3", "v1-confirm-R3"],
          ["R5", "v1-confirm"],
        ] as const) {
          for (const [round, legacy, engine] of [
            [1, 12, 3],
            [2, 20, 10],
            [3, 24, 6],
          ]) {
            await put(tag, "tn-desktop", mode, legacy as number, round);
            await put(tag, "tn-engine-desktop", mode, engine as number, round);
          }
        }
        const desktop = desktopOf(await loadRuns([dir]));
        expect(desktop.kpi.map((r) => r.rung)).toEqual(["R2", "R3", "R5"]);
        for (const row of desktop.kpi) {
          expect(row).toMatchObject({
            status: "measured",
            commits: ["abc123"],
            pair: {
              left: { threadCpuP50: 20, triangles: 155919 },
              right: { threadCpuP50: 6, triangles: 155919 },
              ratio: { threadCpu: 20 / 6 },
            },
            rounds: [
              { round: 1, ratio: 4 },
              { round: 2, ratio: 2 },
              { round: 3, ratio: 4 },
            ],
          });
        }
        expect(desktop.gpu.status).toBe("PENDING");
        expect(desktop.godot.status).toBe("PENDING");
        const html = await readFile(new URL("../perf-live.html", import.meta.url), "utf8");
        expect(html.indexOf('id="desktop"')).toBeLessThan(html.indexOf('id="web"'));
        const element = { innerHTML: "", addEventListener() {} };
        const script = (html.split("<script>")[1] as string)
          .split("</script>")[0]
          ?.replace("tick(); setInterval(tick, 2000);", "");
        runInNewContext(`${script}\ndesktop = data; renderDesktop();`, {
          data: desktop,
          document: { getElementById: () => element },
        });
        expect(element.innerHTML).toContain("Desktop KPI (v1)");
        expect(element.innerHTML).toMatch(/real-GPU inclusive \(R5\).*PENDING/su);
        expect(element.innerHTML).toMatch(/Godot \(R5\).*PENDING/su);
      });
    });

    it("selects the newest confirmation set without filling a missing arm from an older set", async () => {
      await fixture(async (dir, put) => {
        await put("v1-confirm", "tn-desktop", "R5", 12);
        await put("v1-confirm", "tn-engine-desktop", "R5", 6);
        await put("v1-confirm-new", "tn-desktop", "R5", 30, 1, 2);
        expect(desktopOf(await loadRuns([dir])).kpi.at(-1)?.status).toBe("PENDING");
        await put("v1-confirm-new", "tn-engine-desktop", "R5", 10, 1, 3);
        expect(desktopOf(await loadRuns([dir])).kpi.at(-1)?.pair?.ratio.threadCpu).toBe(3);
      });
    });

    it("lets a real-display set outrank the Xvfb confirm set for its rung, and says which lane it is", async () => {
      await fixture(async (dir, put) => {
        await put("v1-confirm-R3", "tn-desktop", "R3", 12);
        await put("v1-confirm-R3", "tn-engine-desktop", "R3", 6);
        expect(desktopOf(await loadRuns([dir])).kpi[1]).toMatchObject({
          lane: "Xvfb",
          pair: { ratio: { threadCpu: 2 } },
        });
        await put("gpu-R3-desktop", "tn-desktop", "R3", 12);
        await put("gpu-R3-desktop", "tn-engine-desktop", "R3", 4);
        expect(desktopOf(await loadRuns([dir])).kpi[1]).toMatchObject({
          lane: "real GPU",
          pair: { ratio: { threadCpu: 3 } },
        });
      });
    });

    it("shows GPU inclusive timing and Godot frame percentiles only when reports exist", async () => {
      await fixture(async (dir, put) => {
        await put("v1-confirm", "tn-engine-desktop", "R5", 6);
        await put("gpu-R5-test", "tn-desktop", "R5", 12);
        await put("gpu-R5-test", "tn-engine-desktop", "R5", 6);
        await put("godot-R5", "godot-desktop", "R5", 20);
        await rename(
          path.join(dir, "godot-R5-godot-desktop-r1.json"),
          path.join(dir, "godot.json"),
        );
        const desktop = desktopOf(await loadRuns([dir]));
        expect(desktop.gpu).toMatchObject({
          status: "measured",
          adapters: ["Intel test adapter"],
          pair: { ratio: { p50: 113 / 107 } },
        });
        expect(desktop.godot).toMatchObject({
          status: "measured",
          pair: {
            left: { p50: 121, p95: 122, p99: 122 },
            right: { p50: 107, p95: 108, p99: 108 },
          },
        });
      });
    });

    it("names the desktop batching waiver while still refusing mismatched triangles", async () => {
      await fixture(async (dir, put) => {
        await put("v1-confirm", "tn-desktop", "R5", 12);
        await put("v1-confirm", "tn-engine-desktop", "R5", 6);
        const file = path.join(dir, "v1-confirm-tn-engine-desktop-r1.json");
        const report = run("tn-engine-desktop", "R5", 6);
        report.rungs = report.rungs.map((rung) => ({ ...rung, drawCalls: 18 }));
        await writeFile(file, JSON.stringify(report));
        const waiver = process.env.TN_BENCH_WAIVE;
        expect(desktopOf(await loadRuns([dir])).kpi.at(-1)?.pair?.ratio.threadCpu).toBe(2);
        expect(process.env.TN_BENCH_WAIVE).toBe(waiver);
        report.rungs = report.rungs.map((rung) => ({ ...rung, triangles: 1 }));
        await writeFile(file, JSON.stringify(report));
        await utimes(file, 10, 10);
        expect(desktopOf(await loadRuns([dir])).kpi.at(-1)).toMatchObject({
          status: "PENDING",
          problem: expect.stringContaining("triangles"),
        });
        const html = await readFile(new URL("../perf-live.html", import.meta.url), "utf8");
        expect(html).toContain("Draw-call parity waived");
      });
    });
  });
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
    expect([0.79, 1, 1.04, 2.99, 3, 4].map(valueColor)).toEqual([
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
    expect(sentenceOf(1.04)).toBe("Native is 1.04× cheaper than legacy on R5. Target 3×.");
    expect(sentenceOf(0.5)).toContain("Native costs 2.00× legacy");
  });

  it("headlines actual Midway diagnostics and pending arms while retaining R5 as the cheap tier", async () => {
    const html = await readFile(new URL("../perf-live.html", import.meta.url), "utf8");
    const script = (html.split("<script>")[1] as string)
      .split("</script>")[0]
      ?.replace("tick(); setInterval(tick, 2000);", "");
    const elements = new Map<string, { innerHTML: string; addEventListener(): void }>();
    const render = (data: unknown) =>
      runInNewContext(`${script}\nmidway = data; hero = r5; renderHero(); renderCheapTier();`, {
        data,
        r5: {
          status: "green",
          ratio: 3.25,
          sentence: "Existing R5 result",
          now: 1,
          t: 1,
          label: "historical-r5",
        },
        document: {
          getElementById: (id: string) => {
            if (!elements.has(id)) elements.set(id, { innerHTML: "", addEventListener() {} });
            return elements.get(id);
          },
        },
      });
    render({
      candidate: {
        gap: { legacyMs: 10.65, desktop: { ms: 7.04531175, build: "T <candidate>", runs: 2 } },
      },
    });
    expect(html).toContain('get("/api/midway")');
    expect(html.indexOf('id="hero"')).toBeLessThan(html.indexOf('id="cheapHero"'));
    const output = elements.get("hero")?.innerHTML;
    for (const text of [
      "Midway · final tier",
      "1.51×",
      "PENDING",
      "experimental · unqualified",
      "thread CPU",
      "active wall time",
      "T &lt;candidate&gt;",
    ])
      expect(output).toContain(text);
    for (const text of ["Cheap tier · R5", "3.25×", "Existing R5 result", "historical-r5"])
      expect(elements.get("cheapHero")?.innerHTML).toContain(text);
    render(undefined);
    expect(elements.get("hero")?.innerHTML).toContain("PENDING");
    expect(elements.get("hero")?.innerHTML).not.toContain("3.25×");
    expect(elements.get("hero")?.innerHTML).not.toContain("0.00×");
    render({ candidate: { gap: { legacyMs: 0, desktop: { ms: 0, build: "bad", runs: 1 } } } });
    expect(elements.get("hero")?.innerHTML).not.toContain("Infinity");
    render({ candidate: { gap: { legacyMs: 10, wasm: { ms: 5, build: "wasm", runs: 3 } } } });
    expect(elements.get("hero")?.innerHTML).toContain("2.00×");
    expect(elements.get("hero")?.innerHTML).toContain("experimental · unqualified");
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
    expect(heroOf([point("v/old", "R5", now - 7 * HOUR, 3.5)], now)).toMatchObject({
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
  });

  it("compares the hero only with the previous point on the same lane", () => {
    const now = 10 * HOUR;
    const hero = heroOf(
      [
        point("v111/head-R5-old", "R5", now - 4 * HOUR, 2.1),
        point("v111/gpu-R5-cut2", "R5", now - 2 * HOUR, 2.97),
        point("v111/head-R5", "R5", now - HOUR, 2.13),
      ],
      now,
    );
    expect(hero).toMatchObject({ lane: "Xvfb", delta: { label: "v111/head-R5-old", dir: "flat" } });
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

  describe("the web comparison", () => {
    const webRun = (
      arm: "tn-web" | "tn-engine-web",
      p50: number,
      extra: { adapter?: string; loaded?: boolean; identity?: object; web?: object } = {},
    ) => ({
      arm,
      build: { notes: "", type: "release" },
      device: { battery: null, label: "d" },
      display: { height: 720, refreshHz: 60, vsync: false, width: 1280 },
      driver: { adapter: extra.adapter ?? "intel / gen-12lp", renderer: "r" },
      engine: { name: "threenative", version: "w" },
      ...(extra.loaded
        ? { hostLoad: { cores: 16, load1: 12, absolutes: "invalid-absolute" } }
        : {}),
      ...(extra.identity ? { identity: extra.identity } : {}),
      ...(extra.web ? { web: extra.web } : {}),
      rungs: [
        {
          drawCalls: 116,
          frameMs: [p50, p50, p50],
          mode: "L1",
          objectCount: 4096,
          positionHash: "h",
          repeat: 0,
          triangles: 1,
          visibleObjects: 4096,
        },
      ],
    });
    it("carries mean FPS and 1% low into both web arms and rejects empty frames", () => {
      const legacy = webRun("tn-web", 10);
      const native = webRun("tn-engine-web", 5);
      const [legacyRung] = legacy.rungs;
      const [nativeRung] = native.rungs;
      if (!legacyRung || !nativeRung) throw new Error("missing fixture rung");
      legacyRung.frameMs = [10, 10, 10, 20];
      nativeRung.frameMs = [5, 5, 5, 10];
      const rows = [
        ...rowsOf(legacy, "fps-tn-web-r1.json", 1),
        ...rowsOf(native, "fps-tn-engine-web-r1.json", 2),
      ];
      expect(rows[0]).toMatchObject({ fps: 80, fpsLow1: 50 });
      const [pair] = webOf(rows).pairs;
      expect(pair?.legacy).toMatchObject({ fps: 80, fpsLow1: 50 });
      expect(pair?.native).toMatchObject({ fps: 160, fpsLow1: 100 });
      legacyRung.frameMs = [];
      expect(() => rowsOf(legacy, "empty.json", 1)).toThrow();
    });

    const web = {
      startup: { entryMs: 100, firstFrameMs: 500, wasmInstantiateMs: [10, 6] },
      memory: { jsHeapUsedBytes: 4e7, wasmMemoryBytes: 1e8 },
      artifact: { jsBytes: 1, jsGzipBytes: 2, wasmBytes: 3, wasmGzipBytes: 4 },
    };

    it("carries the adapter, the identity and the web block into a row, and flags a software adapter", () => {
      const [row] = rowsOf(
        webRun("tn-engine-web", 20, {
          identity: { sourceSha: "abc123", browser: "Chrome 140" },
          web,
        }),
        "web/x-tn-engine-web-r1.json",
        1,
      );
      expect(row).toMatchObject({
        adapter: "intel / gen-12lp",
        software: false,
        commit: "abc123",
        browser: "Chrome 140",
        web: { firstFrameMs: 500, wasmInstantiateMs: 16, wasmMemoryBytes: 1e8, wasmGzipBytes: 4 },
      });
      const [soft] = rowsOf(webRun("tn-web", 5, { adapter: "google / swiftshader" }), "w.json", 1);
      expect(soft?.software).toBe(true);
      expect(soft?.commit).toBeUndefined();
    });

    it("pairs tn-web with tn-engine-web apart from the desktop KPI, and marks a one-armed pair pending", () => {
      const rows = [
        ...rowsOf(webRun("tn-web", 4, { web }), "web/base-tn-web-r1.json", 1),
        ...rowsOf(webRun("tn-web", 6), "web/base-tn-web-r2.json", 2),
        ...rowsOf(
          webRun("tn-engine-web", 20, { loaded: true, web }),
          "web/base-tn-engine-web-r1.json",
          3,
        ),
        ...rowsOf(webRun("tn-engine-web", 30), "web/base-tn-engine-web-r2.json", 4),
        ...rowsOf(webRun("tn-engine-web", 25), "web/next-tn-engine-web-r1.json", 5),
      ];
      // The desktop KPI never takes a web run.
      expect(pointsOf(rows)).toEqual([]);
      const { pairs } = webOf(rows);
      expect(pairs.map((p) => [p.label, p.status])).toEqual([
        ["web/base", "measured"],
        ["web/next", "pending"],
      ]);
      const [base] = pairs;
      expect(base?.legacy.p50).toBe(5);
      expect(base?.native.p50).toBe(25);
      expect(base?.ratioP50).toBeCloseTo(0.2);
      expect(base?.invalid).toBe(true);
      expect(base?.commits).toEqual([]);
      expect(base?.native.web?.wasmMemoryBytes).toBe(1e8);
      expect(pairs[1]?.ratioP50).toBeUndefined();
    });

    it("judges an alternating A/B: a win, a regression, the noise and a pending side", () => {
      const ab = (tag: string, a: number[], b: number[]) => [
        ...a.flatMap((p50, i) =>
          rowsOf(webRun("tn-engine-web", p50), `web/${tag}-A${i * 2 + 1}.json`, i),
        ),
        ...b.flatMap((p50, i) =>
          rowsOf(webRun("tn-engine-web", p50), `web/${tag}-B${i * 2 + 2}.json`, i),
        ),
      ];
      const { cuts } = webOf([
        ...ab("win", [28, 29, 30], [25, 26, 27]),
        ...ab("worse", [25, 26], [27, 28]),
        ...ab("noise", [25, 27], [26, 28]),
        ...ab("half", [25], []),
      ]);
      const verdicts = Object.fromEntries(cuts.map((c) => [c.label, c.verdict]));
      expect(verdicts).toEqual({
        "web/win": "win",
        "web/worse": "regression",
        "web/noise": "inconclusive",
        "web/half": "pending",
      });
      expect(cuts.find((c) => c.label === "web/win")?.ratio).toBeCloseTo(26 / 29);
    });

    it("lists the runs that counted crossings", () => {
      const counted = webRun("tn-engine-web", 20) as ReturnType<typeof webRun> & {
        rungs: { bridgeCalls?: number[] }[];
      };
      (counted.rungs[0] as { bridgeCalls?: number[] }).bridgeCalls = [100, 120, 110];
      const { census } = webOf(rowsOf(counted, "web/census.json", 1));
      expect(census).toEqual([
        { label: "web/census", mode: "L1", objects: 4096, crossings: 110, t: 1 },
      ]);
    });

    it("draws the web card from /api/web, with pending, missing and regression labels", async () => {
      const html = await readFile(new URL("../perf-live.html", import.meta.url), "utf8");
      expect(html).toContain('get("/api/web")');
      expect(html).toContain('id="web"');
      for (const label of ["pending", "missing", "regression", "software adapter"])
        expect(html).toContain(label);
    });
  });

  describe("the hub tabs (PRD-751)", () => {
    const ledgerFile = async (text: string) => {
      const file = path.join(await makeTempDir("dashboard-tab"), "ledger.json");
      await writeFile(file, text);
      return file;
    };

    it("puts every tab in the nav and marks the current one", async () => {
      const html = withNav(
        await readFile(new URL("../perf-live.html", import.meta.url), "utf8"),
        "/ci-speed",
      );
      for (const href of ["/", "/midway", "/shadows", "/ci-speed", "/asset-perf", "/kit-loop"])
        expect(html).toContain(`href="${href}"`);
      expect(html).toContain('<a href="/ci-speed" aria-current="page">');
      expect(html.match(/<nav class="tabs">/gu)).toHaveLength(1);
    });

    it("renders the CI speed and asset perf ledgers live", async () => {
      const empty = '{"schemaVersion":1,"iterations":[]}';
      const ci = await ledgerTab("ci-speed", await ledgerFile(empty));
      expect(ci).toContain("<title>CI speed loop</title>");
      expect(ci).toContain('<a href="/ci-speed" aria-current="page">');
      const asset = await ledgerTab("asset-perf", await ledgerFile(empty));
      expect(asset).toContain("<title>Asset pipeline performance</title>");
      expect(asset).toContain('fetch("/api/asset-perf"');
    });

    it("renders the kit-loop ledger as a tab (PRD-750)", async () => {
      const kit = await ledgerTab(
        "kit-loop",
        await ledgerFile('{"schemaVersion":1,"iterations":[]}'),
      );
      expect(kit).toContain("<title>Kit authoring loop</title>");
      expect(kit).toContain('<a href="/kit-loop" aria-current="page">Kit loop</a>');
      expect(kit).toContain("Baseline pending");
      expect(await ledgerTab("kit-loop", "/nonexistent/ledger.json")).toContain("pending");
    });

    it("fails closed: a missing ledger is pending, a malformed one is invalid", async () => {
      const missing = await ledgerTab("ci-speed", "/nonexistent/ledger.json");
      expect(missing).toContain("pending");
      expect(missing).toContain('<a href="/ci-speed" aria-current="page">');
      expect(await ledgerTab("asset-perf", await ledgerFile("{not json"))).toContain("invalid");
      expect(await ledgerTab("ci-speed", await ledgerFile('{"schemaVersion":2}'))).toContain(
        "invalid",
      );
    });
  });
});
