import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../test-support/temp-dir.js";
import { cyclesOf, runCycleCli } from "../midway-bench/cycle.js";
import { midwayOf } from "../midway-bench/kpis.js";

const line = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;
const T0 = Date.parse("2026-10-14T10:00:00Z");
const iso = (min: number) => new Date(T0 + min * 60000).toISOString();

describe("cyclesOf", () => {
  it("measures start to end in minutes and summarises against the 30 minute goal", () => {
    const text =
      line({ lever: "a", event: "start", at: iso(0), arm: "desktop" }) +
      line({ lever: "a", event: "end", at: iso(24.5), verdict: "keep", runs: ["r1", "r2"] }) +
      line({ lever: "b", event: "start", at: iso(30) }) +
      line({ lever: "b", event: "end", at: iso(75), verdict: "reject" });
    const c = cyclesOf(text, T0);
    expect(c.last.map((x) => [x.lever, x.minutes, x.verdict, x.arm])).toEqual([
      ["a", 24.5, "keep", "desktop"],
      ["b", 45, "reject", undefined],
    ]);
    expect(c.last[0]?.runs).toEqual(["r1", "r2"]);
    expect([c.count, c.medianMin, c.pctUnder, c.skipped]).toEqual([2, 34.75, 50, 0]);
  });

  it("keeps an unfinished cycle open with its elapsed time", () => {
    const c = cyclesOf(
      line({ lever: "x", event: "start", at: iso(0), note: "go" }),
      T0 + 41 * 60000,
    );
    expect(c.count).toBe(0);
    expect(c.medianMin).toBeUndefined();
    expect(c.open).toMatchObject([{ lever: "x", elapsedMin: 41, note: "go" }]);
  });

  it("skips and counts malformed, out-of-order and unverdicted lines without crashing", () => {
    const text = [
      "not json\n",
      line({ lever: "a", event: "end", at: iso(1), verdict: "keep" }), // no open start
      line({ lever: "a", event: "start", at: iso(2) }),
      line({ lever: "a", event: "start", at: iso(3) }), // second start
      line({ lever: "a", event: "end", at: iso(1), verdict: "keep" }), // ends before it starts
      line({ lever: "a", event: "end", at: iso(5), verdict: "maybe" }), // bad verdict
      line({ lever: "", event: "start", at: iso(0) }),
      line({ lever: "a", event: "start", at: "yesterday" }),
      "\n",
      line({ lever: "a", event: "end", at: iso(12), verdict: "inconclusive" }),
    ].join("");
    const c = cyclesOf(text, T0);
    expect(c.skipped).toBe(7);
    expect(c.last).toMatchObject([{ lever: "a", minutes: 10, verdict: "inconclusive" }]);
    expect(cyclesOf(undefined).count).toBe(0);
  });

  it("keeps only the last ten closed cycles but counts all", () => {
    const text = Array.from(
      { length: 12 },
      (_, i) =>
        line({ lever: `l${i}`, event: "start", at: iso(i * 40) }) +
        line({ lever: `l${i}`, event: "end", at: iso(i * 40 + 10), verdict: "keep" }),
    ).join("");
    const c = cyclesOf(text);
    expect([c.count, c.last.length, c.last[0]?.lever]).toEqual([12, 10, "l2"]);
  });
});

describe("cycle CLI", () => {
  const dir = () => makeTempDir("cycles-");
  const at = (min: number) => new Date(T0 + min * 60000);
  it("appends start and end lines and records the engine commit", async () => {
    const d = await dir();
    expect(
      runCycleCli(["start", "lever", "--arm", "native", "--note", "n"], {
        dir: d,
        now: at(0),
        commit: "abc",
      }).code,
    ).toBe(0);
    expect(
      runCycleCli(["end", "lever", "keep", "--runs", "r1, r2"], { dir: d, now: at(20) }).code,
    ).toBe(0);
    const lines = (await readFile(path.join(d, "cycles.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { lever: "lever", event: "start", at: iso(0), arm: "native", note: "n", engineCommit: "abc" },
      { lever: "lever", event: "end", at: iso(20), verdict: "keep", runs: ["r1", "r2"] },
    ]);
    expect(cyclesOf(lines.map(line2).join("")).last[0]?.minutes).toBe(20);
  });

  it("refuses end without an open start and a second start, writing nothing", async () => {
    const d = await dir();
    expect(runCycleCli(["end", "x", "keep"], { dir: d, now: at(1) })).toMatchObject({ code: 2 });
    expect(runCycleCli(["start", "x"], { dir: d, now: at(2) }).code).toBe(0);
    expect(runCycleCli(["start", "x"], { dir: d, now: at(3) })).toMatchObject({
      code: 2,
      message: expect.stringContaining("already open"),
    });
    expect(runCycleCli(["start", "y"], { dir: d, now: at(3) }).code).toBe(0);
    expect(runCycleCli(["end", "x", "keep"], { dir: d, now: at(4) }).code).toBe(0);
    expect(runCycleCli(["end", "x", "keep"], { dir: d, now: at(5) }).code).toBe(2);
    expect((await readFile(path.join(d, "cycles.jsonl"), "utf8")).trim().split("\n")).toHaveLength(
      3,
    );
  });

  it.each([
    [[], "usage"],
    [["start"], "lever"],
    [["end", "x", "great"], "verdict"],
    [["end", "x"], "verdict"],
    [["start", "x", "--arm", "gpu"], "--arm"],
    [["start", "x", "--bogus", "1"], "unknown"],
    [["start", "x", "--note"], "incomplete"],
    [["start", "x", "--runs", "r"], "belongs"],
  ])("rejects bad arguments %j with exit 2", async (argv, text) => {
    const d = await dir();
    const r = runCycleCli(argv as string[], { dir: d, now: at(0) });
    expect(r.code).toBe(2);
    expect(r.message).toContain(text);
    await expect(readFile(path.join(d, "cycles.jsonl"), "utf8")).rejects.toThrow();
  });

  it("exits 2 from the real command for a refused call", async () => {
    const d = await dir();
    const r = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/midway-bench/cycle.ts", "end", "z", "keep"],
      {
        encoding: "utf8",
        env: { ...process.env, MIDWAY_RUNS: d },
      },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("no open cycle");
  });
});

const line2 = (o: unknown) => `${JSON.stringify(o)}\n`;

describe("Iteration cycles panel", () => {
  const draw = async (cycles: unknown, now: number) => {
    const html = await readFile(new URL("../midway-bench/dashboard.html", import.meta.url), "utf8");
    const script = (html.split("<script>")[1] as string)
      .split("</script>")[0]
      ?.replace("tick(); setInterval(tick, 5000);", "");
    return runInNewContext(`${script}\ncyclesPanel(data, ${now});`, {
      data: JSON.parse(JSON.stringify(cycles)),
      document: { getElementById: () => ({}) },
    }) as string;
  };
  it("carries the ledger in the midway state", () => {
    const text =
      line({ lever: "a", event: "start", at: iso(0) }) +
      line({ lever: "a", event: "end", at: iso(10), verdict: "keep" });
    expect(midwayOf([], undefined, undefined, T0, text).cycles).toMatchObject({
      count: 1,
      medianMin: 10,
      targetMin: 30,
    });
    expect(midwayOf([]).cycles).toMatchObject({ count: 0, open: [], skipped: 0 });
  });
  it("says no cycles yet for an empty ledger", async () => {
    expect(await draw(cyclesOf(undefined), T0)).toContain("no cycles yet");
  });
  it("colours under-goal green, over-goal red, and shows open cycles live with skipped lines", async () => {
    const text = [
      line({ lever: "fast", event: "start", at: iso(0) }),
      line({ lever: "fast", event: "end", at: iso(12), verdict: "keep", runs: ["r1"] }),
      line({ lever: "slow", event: "start", at: iso(20) }),
      line({ lever: "slow", event: "end", at: iso(70), verdict: "reject" }),
      line({ lever: "now", event: "start", at: iso(100) }),
      "garbage\n",
    ].join("");
    const html = await draw(cyclesOf(text, T0 + 140 * 60000), T0 + 140 * 60000);
    expect(html).toContain('<span class="ok">12.0 min</span>');
    expect(html).toContain('<span class="bad">50.0 min</span>');
    expect(html).toContain('<span class="bad">40.0 min ⏱</span>');
    expect(html).toContain("OPEN");
    expect(html).toContain("1 malformed line skipped");
    expect(html).toContain("50% under 30 min");
    expect(html).toContain("median 31.0 min");
  });
});
