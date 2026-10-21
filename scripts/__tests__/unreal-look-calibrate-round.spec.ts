import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type IRound,
  adapterName,
  averageRuns,
  buildRound,
  evaluate,
  gapList,
  limitsFor,
  numbersTable,
  parity,
  readRounds,
  report,
  roundId,
  tierLayer,
} from "../unreal-look/calibrateRound.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const temp = () => {
  const root = mkdtempSync(path.join(tmpdir(), "unreal-look-round-"));
  roots.push(root);
  return root;
};

const LIMITS = { deltaE: 1, dP50: 0.01, dEv: 0.02, iou: 0.98 };
const row = (over: Record<string, unknown> = {}) => ({
  cell: "cornell/cornell",
  region: "Back",
  deltaE: 0.5,
  dP50: 0.005,
  dEv50: 0.01,
  iou: 0.99,
  unreal: { p50: 100 },
  threenative: { p50: 99.5 },
  ...over,
});

describe("tierLayer", () => {
  it("names the capture layer of each GI tier, high being the default L7", () => {
    expect([tierLayer("high"), tierLayer("medium"), tierLayer("low")]).toEqual([
      "L7",
      "L7-medium",
      "L7-low",
    ]);
    expect(() => tierLayer("ultra")).toThrow(/BAD_INPUT.*ultra/);
  });
});

describe("adapterName", () => {
  it("names the adapter from what the capture read back", () => {
    expect(
      adapterName({ vendor: "nvidia", architecture: "turing", device: "", description: "" }),
    ).toBe("nvidia turing");
  });

  it("fails closed on an adapter without a name or on a software adapter", () => {
    expect(() => adapterName(undefined)).toThrow(/UNNAMED_ADAPTER/);
    expect(() =>
      adapterName({ vendor: "", architecture: "", device: "", description: "" }),
    ).toThrow(/UNNAMED_ADAPTER/);
    expect(() => adapterName({ vendor: "google", description: "SwiftShader Device" })).toThrow(
      /SOFTWARE_ADAPTER/,
    );
  });
});

describe("limitsFor", () => {
  it("merges the flat thresholds with the ones of the layer", () => {
    const file = {
      iou: 0.98,
      layers: { L7: { deltaE: 1, dP50: 0.01, dEv: 0.02 }, L9: { deltaE: 2 } },
    };
    expect(limitsFor(file, "L7")).toEqual(LIMITS);
    expect(limitsFor(file, "L9")).toEqual({ iou: 0.98, deltaE: 2 });
  });

  it("fails closed on a layer without thresholds", () => {
    expect(() => limitsFor({ layers: {} }, "L7")).toThrow(/NO_THRESHOLDS.*L7/);
  });
});

describe("evaluate", () => {
  it("passes a region inside every limit and scores it by its worst metric over the limit", () => {
    const result = evaluate(row(), LIMITS);
    expect(result.pass).toBe(true);
    expect(result.ratio).toBeCloseTo(0.98 / 0.99, 5);
    expect(result.ratio).toBeLessThanOrEqual(1);
  });

  it("fails a region over one limit and puts the factor in the ratio", () => {
    const result = evaluate(row({ dP50: 0.034 }), LIMITS);
    expect(result.pass).toBe(false);
    expect(result.ratio).toBeCloseTo(3.4, 5);
    expect(evaluate(row({ iou: 0.9 }), LIMITS).pass).toBe(false);
    const negative = evaluate(row({ dEv50: -0.05 }), LIMITS);
    expect(negative.pass).toBe(false);
    expect(negative.ratio).toBeCloseTo(2.5, 5);
  });

  it("skips a metric the row or the limits do not have, and fails closed when none is left", () => {
    expect(evaluate(row({ dEv50: null }), LIMITS).pass).toBe(true);
    expect(() =>
      evaluate(row({ deltaE: null, dP50: null, dEv50: null, iou: null }), LIMITS),
    ).toThrow(/NO_METRIC/);
    expect(() => evaluate(row(), {})).toThrow(/NO_METRIC/);
  });
});

describe("averageRuns", () => {
  const run = (dP50: number) => [
    {
      pose: "cornell",
      region: "Back",
      dP50,
      deltaE: 0.4,
      dEv: 0.01,
      iou: 0.99,
      pass: true,
      ratio: 0.5,
    },
  ];

  it("averages the regions of the runs and keeps the spread between them", () => {
    const [back] = averageRuns([run(0.004), run(0.008)]);
    expect(back).toMatchObject({ pose: "cornell", region: "Back" });
    expect(back?.dP50).toBeCloseTo(0.006, 6);
    expect(back?.spread).toBeCloseTo(0.004, 6);
  });

  it("fails closed when the runs disagree on the regions, or there is one run", () => {
    expect(() => averageRuns([run(0.004), [] as ReturnType<typeof run>])).toThrow(/RUN_MISMATCH/);
    expect(() => averageRuns([run(0.004)])).toThrow(/TOO_FEW_RUNS/);
  });
});

const verdictFile = (over: Record<string, unknown> = {}) => ({
  status: "COMPLETE",
  model: "claude-sonnet-5-5",
  sessionId: "s1",
  costUsd: 0.4,
  durationMs: 60_000,
  criteria: { file: "round-criteria.md", sha256: "abc" },
  frames: [
    {
      id: "cornell/L7/cornell",
      verdict: "NEUTRAL",
      vsUnreal: "CLOSE",
      reasons: "same lighting",
      differences: "red tint is weaker",
    },
    {
      id: "cornell/L7/corner",
      verdict: "NEUTRAL",
      vsUnreal: "MATCH",
      reasons: "same",
      differences: "",
    },
  ],
  overall: { verdict: "NEUTRAL", vsUnreal: "CLOSE", reasons: "one cell is close" },
  ...over,
});
const region = (pose: string, over: Record<string, unknown> = {}) => ({
  pose,
  region: "Back",
  dP50: 0.004,
  deltaE: 0.4,
  dEv: 0.01,
  iou: 0.99,
  pass: true,
  ratio: 0.6,
  spread: 0.001,
  ...over,
});
const meta = (over: Record<string, unknown> = {}) => ({
  date: "2026-10-21T14:05:12.000Z",
  scene: "cornell",
  tier: "high" as const,
  expect: "preserve" as const,
  before: { commit: "9854dd1", stamp: "aaaaaaaaaaaa", dirty: false },
  after: { commit: "9854dd1", stamp: "aaaaaaaaaaaa", dirty: false },
  engine: "threenative",
  adapter: "nvidia turing",
  directLight: { pass: true, overridden: false, worst: 0.4 },
  poses: ["cornell", "corner"],
  ...over,
});
const regions = [region("cornell", { dP50: 0.034, pass: false, ratio: 3.4 }), region("corner")];

describe("buildRound", () => {
  it("makes one entry per cell with the numbers and both judge answers", () => {
    const round = buildRound(meta(), regions, verdictFile());
    expect(round.id).toBe("20261021T140512Z-cornell-high-aaaaaaa");
    expect(round.cells.map((cell) => [cell.pose, cell.verdict, cell.vsUnreal])).toEqual([
      ["cornell", "NEUTRAL", "CLOSE"],
      ["corner", "NEUTRAL", "MATCH"],
    ]);
    expect(round.cells[0]).toMatchObject({ worst: 3.4, differences: "red tint is weaker" });
    expect(round.cells[0]?.regions[0]).toMatchObject({ region: "Back", dP50: 0.034, pass: false });
    expect(round.overall).toMatchObject({ verdict: "NEUTRAL", vsUnreal: "CLOSE" });
    expect(round.judge).toMatchObject({ model: "claude-sonnet-5-5", sessionId: "s1" });
  });

  it("rejects an answer outside the two scales, a missing cell and an unfinished verdict", () => {
    const bad = (frame: Record<string, unknown>) =>
      verdictFile({ frames: [{ ...verdictFile().frames[0], ...frame }, verdictFile().frames[1]] });
    expect(() => buildRound(meta(), regions, bad({ verdict: "BETTER" }))).toThrow(/BAD_VERDICT/);
    expect(() => buildRound(meta(), regions, bad({ vsUnreal: "NEAR" }))).toThrow(/BAD_VERDICT/);
    expect(() =>
      buildRound(meta(), regions, verdictFile({ frames: [verdictFile().frames[0]] })),
    ).toThrow(/MISSING_CELL.*corner/);
    expect(() => buildRound(meta(), regions, verdictFile({ status: "FAILED" }))).toThrow(
      /BAD_VERDICT.*COMPLETE/,
    );
    expect(() => buildRound(meta(), regions.slice(1), verdictFile())).toThrow(
      /MISSING_CELL.*cornell/,
    );
  });
});

describe("gapList", () => {
  it("lists the cells that are not MATCH, the furthest from the thresholds first", () => {
    const round = buildRound(
      meta(),
      [region("cornell", { ratio: 1.4 }), region("corner", { ratio: 5.2, pass: false })],
      verdictFile({
        frames: [
          { ...verdictFile().frames[0], vsUnreal: "CLOSE" },
          { ...verdictFile().frames[1], vsUnreal: "FAR" },
        ],
      }),
    );
    expect(gapList(round).map((gap) => [gap.pose, gap.vsUnreal, gap.worst])).toEqual([
      ["corner", "FAR", 5.2],
      ["cornell", "CLOSE", 1.4],
    ]);
  });

  it("is empty when every cell matches", () => {
    const frames = verdictFile().frames.map((frame) => ({ ...frame, vsUnreal: "MATCH" }));
    const round = buildRound(
      meta(),
      [region("cornell"), region("corner")],
      verdictFile({ frames }),
    );
    expect(gapList(round)).toEqual([]);
  });
});

describe("parity", () => {
  const matching = (id: string, over: Record<string, unknown> = {}, session = id): IRound => {
    const scene = String(over.scene ?? "cornell");
    const frames = verdictFile().frames.map((frame) => ({
      ...frame,
      id: frame.id.replace("cornell/", `${scene}/`),
      vsUnreal: "MATCH",
    }));
    const round = buildRound(
      meta({ date: `2026-10-21T14:0${id}:00.000Z`, ...over }),
      [region("cornell"), region("corner")],
      verdictFile({ frames, sessionId: `s${session}` }),
    );
    return round;
  };
  const check = (rounds: IRound[]) => parity(rounds, "cornell", "high", ["cornell", "corner"]);

  it("stays open with no round, one round or one CLOSE cell", () => {
    expect(check([])).toMatchObject({ atParity: false });
    expect(check([matching("1")]).reasons.join(" ")).toMatch(/1 of 2 judge rounds/);
    const close = buildRound(
      meta({ date: "2026-10-21T14:02:00.000Z" }),
      [region("cornell"), region("corner")],
      verdictFile({ sessionId: "s2" }),
    );
    const result = check([matching("1"), close]);
    expect(result.atParity).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/1 of 2/);
  });

  it("reaches parity with every region inside the thresholds and two judges on one stamp", () => {
    expect(check([matching("1"), matching("2")])).toEqual({ atParity: true, reasons: [] });
  });

  it("does not count rounds of another scene, tier or stamp, or a round with red direct light", () => {
    const other = matching("1", {
      after: { commit: "bbbbbbb", stamp: "bbbbbbbbbbbb", dirty: false },
    });
    expect(check([other, matching("2")]).atParity).toBe(false);
    expect(check([matching("1", { tier: "medium" }), matching("2")]).atParity).toBe(false);
    expect(check([matching("1", { scene: "sunlit-room" }), matching("2")]).atParity).toBe(false);
    const overridden = matching("1", { directLight: { pass: false, overridden: true, worst: 3 } });
    expect(check([overridden, matching("2")]).atParity).toBe(false);
  });

  it("stays open while a region of the latest round is outside the thresholds", () => {
    const frames = verdictFile().frames.map((frame) => ({ ...frame, vsUnreal: "MATCH" }));
    const red = buildRound(
      meta({ date: "2026-10-21T14:03:00.000Z" }),
      [region("cornell", { pass: false, ratio: 1.3 }), region("corner")],
      verdictFile({ frames, sessionId: "s3" }),
    );
    const result = check([matching("1"), red]);
    expect(result.atParity).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/outside the thresholds/);
  });
});

describe("readRounds", () => {
  it("reads every round file and fails closed on a malformed one", () => {
    const dir = temp();
    const round = buildRound(meta(), regions, verdictFile());
    writeFileSync(path.join(dir, `${round.id}.json`), JSON.stringify(round));
    expect(readRounds(dir).map((r) => r.id)).toEqual([round.id]);
    expect(readRounds(path.join(dir, "missing"))).toEqual([]);
    writeFileSync(path.join(dir, "bad.json"), "{");
    expect(() => readRounds(dir)).toThrow(/BAD_ROUND.*bad.json/);
    writeFileSync(path.join(dir, "bad.json"), JSON.stringify({ id: "x" }));
    expect(() => readRounds(dir)).toThrow(/BAD_ROUND.*bad.json/);
  });
});

describe("roundId", () => {
  it("is the UTC time, the scene, the tier and the first seven characters of the stamp", () => {
    expect(roundId("2026-10-21T14:05:12.000Z", "sunlit-room", "medium", "0123456789ab")).toBe(
      "20261021T140512Z-sunlit-room-medium-0123456",
    );
  });
});

describe("report", () => {
  it("prints the cells, the gap list and the parity line", () => {
    const round = buildRound(meta(), regions, verdictFile());
    const text = report(round, check());
    expect(text).toMatch(/ROUND 20261021T140512Z-cornell-high-aaaaaaa/);
    expect(text).toMatch(/cornell\s+NEUTRAL\s+vs Unreal CLOSE/);
    expect(text).toMatch(/GAP LIST/);
    expect(text).toMatch(/Back.*3\.4x/);
    expect(text).toMatch(/PARITY cornell high: OPEN/);
    function check() {
      return parity([round], "cornell", "high", ["cornell", "corner"]);
    }
  });

  it("says when direct light was red and the round was run anyway", () => {
    const round = buildRound(
      meta({ directLight: { pass: false, overridden: true, worst: 4.2 } }),
      regions,
      verdictFile(),
    );
    expect(report(round, { atParity: false, reasons: [] })).toMatch(
      /direct light RED.*overridden.*4\.2x/s,
    );
  });
});

describe("numbersTable", () => {
  it("lists the regions outside the thresholds, furthest first, and counts the rest", () => {
    const text = numbersTable([
      region("cornell", { region: "Floor", ratio: 1.2, pass: false }),
      region("cornell", { region: "Back" }),
      region("corner", { region: "Wall_Red", ratio: 3.4, pass: false }),
    ]);
    expect(text).toMatch(/^1 of 3 regions are inside the PRD-631 thresholds/);
    expect(text.indexOf("Wall_Red")).toBeLessThan(text.indexOf("Floor"));
    expect(text).toMatch(/\| corner \| Wall_Red \| 0\.004 \| 0\.4 \| 0\.99 \| 3\.4x \|/);
    expect(numbersTable([region("cornell")])).toBe(
      "1 of 1 regions are inside the PRD-631 thresholds.",
    );
  });
});

describe("averageRuns without a linear copy of the Unreal frame", () => {
  it("keeps dEv null when no run has one", () => {
    const [first] = averageRuns([
      [region("cornell", { dEv: null })],
      [region("cornell", { dEv: null })],
    ]);
    expect(first?.dEv).toBeNull();
  });
});
