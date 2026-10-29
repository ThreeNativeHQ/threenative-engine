import { describe, expect, it } from "vitest";
import { shadowPerfOf } from "../shadow-perf/dashboard.js";

const FILE = "/x/results.json";
const doc = (iterations: unknown[]) =>
  JSON.stringify({
    schema: 1,
    updatedAt: "2026-10-20T22:00:00Z",
    phase: "iteration 0",
    iterations,
  });
const it0 = (cells: unknown[], extra: object = {}) => ({
  id: "it0",
  lever: "baseline",
  startedAt: "2026-10-20T21:00:00Z",
  finishedAt: "2026-10-20T21:24:00Z",
  decision: "keep",
  cells,
  ...extra,
});

describe("Shadows vs Unreal tab (PRD-650/652)", () => {
  it("is pending without a results file", () => {
    expect(shadowPerfOf(undefined, FILE)).toEqual({ status: "pending", file: FILE });
  });

  it("is invalid on bad JSON or a bad shape, naming the problem", () => {
    expect(shadowPerfOf("{", FILE)).toMatchObject({
      status: "invalid",
      problem: expect.stringMatching(/^JSON/),
    });
    expect(shadowPerfOf(doc([it0([], { decision: "won" })]), FILE)).toMatchObject({
      status: "invalid",
      problem: "it0: unknown decision won",
    });
    expect(
      shadowPerfOf(doc([it0([{ scene: "gi:cornell", arm: "tn", runs: 5, totalMs: -1 }])]), FILE),
    ).toMatchObject({ status: "invalid" });
  });

  it("refuses a missing time without a reason, and keeps a reasoned one undefined", () => {
    expect(
      shadowPerfOf(doc([it0([{ scene: "gi:cornell", arm: "unreal", runs: 0 }])]), FILE),
    ).toMatchObject({
      status: "invalid",
      problem: "it0 gi:cornell unreal: totalMs missing without an unavailable reason",
    });
    const ok = shadowPerfOf(
      doc([
        it0([
          {
            scene: "gi:cornell",
            arm: "unreal",
            runs: 0,
            unavailable: "ProfileGPU hook not merged",
          },
        ]),
      ]),
      FILE,
    );
    expect(ok.status).toBe("ok");
    if (ok.status === "ok") expect(ok.iterations[0]?.pairs[0]?.shadowRatio).toBeUndefined();
  });

  it("pairs TN and Unreal per scene and times the cycle", () => {
    const ok = shadowPerfOf(
      doc([
        it0([
          { scene: "gi:cornell", arm: "tn", layer: "L6", runs: 5, totalMs: 6, shadowMs: 2 },
          { scene: "gi:cornell", arm: "unreal", layer: "L7-Low", runs: 5, totalMs: 4, shadowMs: 1 },
          {
            scene: "shadow:penumbra-lab",
            arm: "tn",
            layer: "L5",
            runs: 5,
            totalMs: 3,
            shadowMs: 0.5,
          },
        ]),
      ]),
      FILE,
    );
    expect(ok.status).toBe("ok");
    if (ok.status !== "ok") return;
    const [cornell, lab] = ok.iterations[0]?.pairs ?? [];
    expect(cornell).toMatchObject({ scene: "gi:cornell", totalRatio: 1.5, shadowRatio: 2 });
    expect(lab?.unreal).toBeUndefined();
    expect(lab?.shadowRatio).toBeUndefined();
    expect(ok.iterations[0]?.cycleMinutes).toBe(24);
  });
});
