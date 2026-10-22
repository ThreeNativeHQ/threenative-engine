import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ICheckDeps,
  type IGiLock,
  type IMeasuredRow,
  checkCommand,
  writeGiLocks,
} from "../unreal-look/giLocks.js";
import {
  type IRatchet,
  RATCHET_FILE,
  checkRatchets,
  cutRatchets,
  giCovered,
  mergeRatchets,
  readRatchets,
  referenceCovered,
  writeRatchets,
} from "../unreal-look/ratchet.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const temp = () => {
  const root = mkdtempSync(path.join(tmpdir(), "ratchet-"));
  roots.push(root);
  return root;
};

const row = (
  region: string,
  dP50: number,
  deltaE: number,
  iou: number | null = 0.9,
): IMeasuredRow => ({
  cell: "room/window",
  region,
  dP50,
  deltaE,
  iou,
  unreal: { p50: 100 },
});
/** Two runs of one capture: Wall is far from Unreal, Floor near. */
const runs = (wall = 0.2): IMeasuredRow[][] => [
  [row("Wall", wall, 6), row("Floor", 0.02, 1)],
  [row("Wall", wall + 0.01, 6.5), row("Floor", 0.021, 1.1)],
];
const none = () => false;
const CUT = { scene: "room", layer: "L7-high", since: "abc1234", date: "2026-10-22" };

describe("cutting a ratchet", () => {
  it("bounds each metric at the worst run plus the run spread, away from Unreal", () => {
    const cut = cutRatchets(CUT, runs(), none);
    const wall = (metric: string) => cut.find((r) => r.region === "Wall" && r.metric === metric);
    expect(wall("dP50")).toMatchObject({ value: 0.21, spread: 0.01, bound: 0.22, runs: 2 });
    expect(wall("deltaE")?.bound).toBeCloseTo(7, 5);
    // The overlap is a floor: its bound sits below the worst run. Equal runs widen by the minimum step.
    expect(wall("iou")).toMatchObject({ value: 0.9, bound: 0.8999 });
    expect(cut).toHaveLength(6);
  });

  it("widens a spread of zero to one display level of the Unreal median, so a repeat run holds", () => {
    const same = [[row("Wall", 0.2, 6)], [row("Wall", 0.2, 6)]];
    const dP50 = cutRatchets(CUT, same, none).find((r) => r.metric === "dP50");
    expect(dP50?.bound).toBeCloseTo(0.21, 6);
  });

  it("skips every metric that a parity lock covers and every metric a run did not measure", () => {
    const covered = (r: IMeasuredRow, metric: string) =>
      r.region === "Floor" || metric === "deltaE";
    const noIou = runs().map((run) => run.map((r) => ({ ...r, iou: null })));
    const cut = cutRatchets(CUT, noIou, covered);
    expect(cut.map((r) => `${r.region} ${r.metric}`)).toEqual(["Wall dP50"]);
  });

  it("needs two runs, so that the spread is measured", () => {
    expect(() => cutRatchets(CUT, [runs()[0] as IMeasuredRow[]], none)).toThrow(/TOO_FEW_RUNS/);
  });

  it("reads which metrics the parity locks of each kind cover", () => {
    const ref = referenceCovered("L9", [
      { layer: "L9", sun: "sun60", pose: "exterior", region: "Sky", metric: "dP50" },
    ]);
    const sky = { ...row("Sky", 0, 0), cell: "sun60_exterior" };
    expect(ref(sky, "dP50")).toBe(true);
    expect(ref(sky, "deltaE")).toBe(false);
    const lock = { scene: "room", layer: "L7-high", pose: "window", region: "Floor" } as IGiLock;
    const gi = giCovered("room", "L7-high", [lock]);
    expect(gi(row("Floor", 0, 0), "dP50")).toBe(true);
    // A GI lock with no overlap bound leaves the overlap to a ratchet.
    expect(gi(row("Floor", 0, 0), "iou")).toBe(false);
    expect(gi(row("Wall", 0, 0), "dP50")).toBe(false);
  });
});

describe("checking a ratchet", () => {
  const ratchets = cutRatchets(CUT, runs(), none);

  it("holds on the runs that cut it and on runs closer to Unreal", () => {
    expect(checkRatchets("room", "L7-high", runs(), ratchets)).toEqual([]);
    expect(checkRatchets("room", "L7-high", runs(0.05), ratchets)).toEqual([]);
  });

  it("negative control: an arm that moves one region away from Unreal fails on that region only", () => {
    const worse = runs();
    (worse[1] as IMeasuredRow[])[0] = row("Wall", 0.3, 6.5);
    const failures = checkRatchets("room", "L7-high", worse, ratchets);
    expect(failures).toEqual([
      "room L7-high room/window Wall dP50: 0.3 in run 2 is further from Unreal than the ratchet 0.22 (cut at abc1234, value 0.21)",
    ]);
  });

  it("fails closed on a ratcheted region that a run does not measure, and on a rebuilt scene", () => {
    const missing = [runs()[0] as IMeasuredRow[], [row("Wall", 0.2, 6)]];
    expect(checkRatchets("room", "L7-high", missing, ratchets).join("\n")).toMatch(
      /Floor dP50: missing from run 2/,
    );
    const based = cutRatchets({ ...CUT, basis: "aaaaaaaaaaaa" }, runs(), none);
    expect(checkRatchets("room", "L7-high", runs(), based, { basis: "bbbbbbbbbbbb" })).toHaveLength(
      6,
    );
  });

  it("checks only its scene, layer and the cells asked for", () => {
    const far = runs(0.9);
    expect(checkRatchets("other", "L7-high", far, ratchets)).toEqual([]);
    expect(checkRatchets("room", "L9", far, ratchets)).toEqual([]);
    expect(checkRatchets("room", "L7-high", far, ratchets, { cells: () => false })).toEqual([]);
  });
});

describe("re-cutting a ratchet", () => {
  const scope = { scene: "room", layer: "L7-high", covered: () => false };
  const stored = cutRatchets(CUT, runs(), none);

  it("moves a bound toward Unreal when a fix lands, so that the gain cannot be lost later", () => {
    const fresh = cutRatchets({ ...CUT, since: "fix5678" }, runs(0.1), none);
    const merged = mergeRatchets(stored, fresh, scope);
    expect(merged.tightened).toContain("room L7-high room/window Wall dP50: 0.22 -> 0.12");
    const wall = merged.ratchets.find((r) => r.region === "Wall" && r.metric === "dP50");
    expect(wall).toMatchObject({ bound: 0.12, since: "fix5678" });
    // The old capture now breaks the re-cut ratchet: the gain is held.
    expect(checkRatchets("room", "L7-high", runs(), merged.ratchets).length).toBeGreaterThan(0);
  });

  it("refuses a cut further from Unreal, unless --relax names a reason that the ratchet keeps", () => {
    const fresh = cutRatchets(CUT, runs(0.4), none);
    expect(() => mergeRatchets(stored, fresh, scope)).toThrow(/RATCHET_LOOSER/);
    const relaxed = mergeRatchets(stored, fresh, scope, "judge 123: trade for the wall seam");
    const wall = relaxed.ratchets.find((r) => r.region === "Wall" && r.metric === "dP50");
    expect(wall).toMatchObject({ bound: 0.42, reason: "judge 123: trade for the wall seam" });
  });

  it("removes a ratchet that a parity lock now covers, and refuses to drop one it does not", () => {
    const fresh = stored.filter((r) => r.region !== "Floor");
    expect(() => mergeRatchets(stored, fresh, scope)).toThrow(/RATCHET_DROPPED/);
    const merged = mergeRatchets(stored, fresh, { ...scope, covered: (r) => r.region === "Floor" });
    expect(merged.parity).toHaveLength(3);
    expect(merged.ratchets.some((r) => r.region === "Floor")).toBe(false);
  });

  it("keeps the ratchets of other scenes and layers", () => {
    const other = cutRatchets({ ...CUT, layer: "L9" }, runs(), none);
    const merged = mergeRatchets([...stored, ...other], stored, scope);
    expect(merged.ratchets).toHaveLength(stored.length + other.length);
  });
});

describe("the ratchet file", () => {
  it("round-trips and fails closed on a bad entry or a duplicate", () => {
    const file = path.join(temp(), "ratchets.json");
    const ratchets = cutRatchets(CUT, runs(), none);
    writeRatchets(file, ratchets);
    expect(readRatchets(file)).toHaveLength(ratchets.length);
    writeRatchets(file, [...ratchets, ratchets[0] as IRatchet]);
    expect(() => readRatchets(file)).toThrow(/ratcheted twice/);
    writeRatchets(file, [{ ...(ratchets[0] as IRatchet), metric: "bogus" as never }]);
    expect(() => readRatchets(file)).toThrow(/unknown metric/);
    expect(() => readRatchets(path.join(temp(), "none.json"))).toThrow(/no ratchet file/);
  });

  it("the committed file parses", () => {
    expect(() => readRatchets(RATCHET_FILE)).not.toThrow();
  });
});

describe("compare --check on a GI scene", () => {
  const world = (measured: Record<string, IMeasuredRow[]>, locks: IGiLock[] = []) => {
    const dir = temp();
    const lockFile = path.join(dir, "parity-locks.json");
    // A lock on another layer: the checked layer has ratchets only.
    writeGiLocks(lockFile, [
      {
        scene: "room",
        layer: "L1",
        pose: "window",
        region: "Floor",
        round: "r1",
        basis: "0123456789ab",
        maxDP50: 1,
        maxDeltaE: 9,
        noiseDP50: 0,
        noiseDeltaE: 0,
      },
      ...locks,
    ]);
    const ratchetFile = path.join(dir, "ratchets.json");
    writeRatchets(ratchetFile, cutRatchets(CUT, runs(), none));
    const out = { log: [] as string[], error: [] as string[] };
    const deps: ICheckDeps = {
      basis: () => "0123456789ab",
      compare: (_scene, _layer, run) => measured[run] ?? [],
      log: (line) => out.log.push(line),
      error: (line) => out.error.push(line),
    };
    const args = [
      "--check",
      "--scene",
      "gi:room",
      "--layer",
      "L7-high",
      "--locks",
      lockFile,
      "--ratchets",
      ratchetFile,
      "--captures",
      "a",
      "--captures",
      "b",
    ];
    return { out, deps, args };
  };

  it("exits 0 while every ratchet holds, on a layer with no parity lock", () => {
    const [a, b] = runs() as [IMeasuredRow[], IMeasuredRow[]];
    const w = world({ a, b });
    expect(checkCommand(w.args, w.deps)).toBe(0);
    expect(w.out.log).toContain("room L7-high: 6 ratchet(s), every one holds");
  });

  it("exits 1 and prints RATCHET BROKEN when one region slides away from Unreal", () => {
    const [a] = runs() as [IMeasuredRow[]];
    const w = world({ a, b: [row("Wall", 0.5, 6), row("Floor", 0.02, 1)] });
    expect(checkCommand(w.args, w.deps)).toBe(1);
    expect(w.out.error).toEqual([
      "RATCHET BROKEN room L7-high room/window Wall dP50: 0.5 in run 2 is further from Unreal than the ratchet 0.22 (cut at abc1234, value 0.21)",
    ]);
  });
});

describe("ratchet command line", () => {
  it("reaches the cut through the compare import cycle and fails closed on a missing capture", () => {
    // compare.ts imports ratchet.ts: a top-level await on main() deadlocked that cycle and exited 13 with no message.
    const dir = mkdtempSync(path.join(tmpdir(), "ratchet-cli-"));
    const cli = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/unreal-look/ratchet.ts",
        "--cut",
        "abc1234",
        "--scene",
        "gi:cornell",
        "--layer",
        "L1",
        "--captures",
        path.join(dir, "missing"),
        "--ratchets",
        path.join(dir, "r.json"),
      ],
      { encoding: "utf8" },
    );
    rmSync(dir, { recursive: true, force: true });
    expect(cli.status).toBe(1);
    expect(cli.stderr).toMatch(/TN_UNREAL_LOOK_/);
  }, 60_000);
});
