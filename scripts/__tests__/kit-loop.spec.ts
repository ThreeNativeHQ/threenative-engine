import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../test-support/temp-dir.js";

const { appendRow, goalsFor, measureDir, renderHtml } = await import(
  new URL("../kit-loop.mjs", import.meta.url).href
);
const { emptyLedger } = await import(new URL("../ci-speed-loop.mjs", import.meta.url).href);

const inputs = {
  "transcript.json": {
    type: "result",
    num_turns: 41,
    duration_ms: 1_380_000,
    usage: {
      input_tokens: 1_000,
      output_tokens: 20_000,
      cache_creation_input_tokens: 79_000,
      cache_read_input_tokens: 2_000_000,
    },
  },
  "gates.json": {
    scenarios: { total: 4, green: 3 },
    presentedP95Ms: 15.2,
    budgetMs: 16.7,
    visualVerdict: "CLOSE",
  },
  "friction.json": { searchMisses: 2, duplicates: 1, wrongApi: 3, retries: 4 },
  "play-grade.json": { grade: 3, judge: "opus fresh judge" },
  "retro.json": {
    worked: ["kit found by the mario alias"],
    failed: ["coin ring scenario red"],
    frictions: [{ text: "searched 'triple jump' and missed", transcriptLine: 212 }],
  },
};

function coldBuild(overrides: Record<string, unknown> = {}) {
  const dir = makeTempDirSync("kit-loop");
  for (const [name, value] of Object.entries({ ...inputs, ...overrides })) {
    if (value !== undefined) writeFileSync(path.join(dir, name), JSON.stringify(value));
  }
  return dir;
}

describe("kit-loop", () => {
  it("turns a cold build into K1-K4 and the retro", () => {
    const row = measureDir(coldBuild());
    expect(row.metrics).toEqual({
      k1Tokens: 100_000,
      k1WallMin: 23,
      k1Turns: 41,
      k2ScenarioPct: 75,
      k2PresentedP95Ms: 15.2,
      k2BudgetMs: 16.7,
      k2BudgetMet: true,
      k2Visual: "CLOSE",
      k3Friction: 10,
      k4Grade: 3,
    });
    expect(row.friction).toEqual({ searchMisses: 2, duplicates: 1, wrongApi: 3, retries: 4 });
    expect(row.retro.frictions[0].transcriptLine).toBe(212);
  });

  it("fails closed on a missing input file or a missing field, never a zero", () => {
    for (const name of Object.keys(inputs)) {
      const dir = coldBuild();
      rmSync(path.join(dir, name));
      expect(() => measureDir(dir)).toThrow(name);
    }
    const noUsage = coldBuild({ "transcript.json": { num_turns: 3, duration_ms: 1 } });
    expect(() => measureDir(noUsage)).toThrow(/usage/u);
    const badGrade = coldBuild({ "play-grade.json": { grade: 0 } });
    expect(() => measureDir(badGrade)).toThrow(/grade/u);
    const badVerdict = coldBuild({ "gates.json": { ...inputs["gates.json"], visualVerdict: "" } });
    expect(() => measureDir(badVerdict)).toThrow(/visualVerdict/u);
    const fourFrictions = coldBuild({
      "retro.json": {
        ...inputs["retro.json"],
        frictions: Array(4).fill({ text: "x", transcriptLine: 1 }),
      },
    });
    expect(() => measureDir(fourFrictions)).toThrow(/top 3/u);
  });

  it("numbers rows, marks the first as the baseline and sets targets from it", () => {
    const one = appendRow(emptyLedger(), measureDir(coldBuild()), {
      kit: "collectathon",
      reference: "sm64",
    });
    const two = appendRow(one, measureDir(coldBuild()), { kit: "shooter", reference: "quake" });
    expect(two.iterations.map((r: { id: number; decision: string }) => [r.id, r.decision])).toEqual(
      [
        [1, "baseline"],
        [2, "iteration"],
      ],
    );
    const goals = Object.fromEntries(
      goalsFor(two.iterations[0].metrics).map((g: { key: string; goal: number }) => [
        g.key,
        g.goal,
      ]),
    );
    expect(goals).toEqual({ k1Tokens: 60_000, k2ScenarioPct: 100, k3Friction: 5, k4Grade: 4 });
    expect(() => appendRow(one, measureDir(coldBuild()), { kit: "", reference: "x" })).toThrow(
      /kit/u,
    );
  });

  it("renders the KPIs against the baseline and targets, and an empty ledger as baseline pending", () => {
    const ledger = appendRow(emptyLedger(), measureDir(coldBuild()), {
      kit: "collectathon",
      reference: "sm64",
    });
    const html = renderHtml(ledger, new Date(0));
    expect(html).toContain("<title>Kit authoring loop</title>");
    expect(html).toContain("≤ 60000 tokens");
    expect(html).toContain("searched &#39;triple jump&#39; and missed");
    expect(renderHtml(emptyLedger(), new Date(0))).toContain("Baseline pending");
  });
});
