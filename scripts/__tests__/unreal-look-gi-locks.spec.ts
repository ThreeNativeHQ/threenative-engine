import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readRounds } from "../unreal-look/calibrateRound.js";
import { main } from "../unreal-look/compare.js";
import {
  GI_LOCK_FILE,
  type ICheckDeps,
  type IGiLock,
  type IMeasuredRow,
  checkCommand,
  checkGiLocks,
  isGiCheck,
  lockCells,
  mergeLocks,
  readGiLocks,
  withOfflineRoot,
  writeGiLocks,
} from "../unreal-look/giLocks.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const temp = () => {
  const root = mkdtempSync(path.join(tmpdir(), "gi-locks-"));
  roots.push(root);
  return root;
};

const row = (pose: string, region: string, over: Partial<IMeasuredRow> = {}): IMeasuredRow => ({
  cell: `room/${pose}`,
  region,
  deltaE: 2,
  dP50: 0.1,
  iou: 0.99,
  unreal: { p50: 100 },
  ...over,
});
/** The rows of one run: two poses, two regions in each. */
const rows = (over: Partial<IMeasuredRow> = {}): IMeasuredRow[] =>
  ["a", "b"].flatMap((pose) => ["Floor", "Wall"].map((region) => row(pose, region, over)));
const cut = (runs = [rows(), rows()], round = "r1") => lockCells(round, "room", "L7-high", runs);
const at = (locks: IGiLock[], pose: string, region: string) =>
  locks.find((lock) => lock.pose === pose && lock.region === region) as IGiLock;

describe("lockCells", () => {
  it("cuts one lock per region, with no noise when the runs are the same", () => {
    const locks = cut();
    expect(locks).toHaveLength(4);
    expect(locks[0]).toMatchObject({
      scene: "room",
      layer: "L7-high",
      pose: "a",
      region: "Floor",
      round: "r1",
      noiseDP50: 0,
      noiseDeltaE: 0,
      noiseIoU: 0,
      minIoU: 0.99,
    });
  });

  it("widens a ceiling by one display level of the reference median, and no more", () => {
    // p50 100: one display level is 1% of dP50, and a little over 0.4 of deltaE.
    const [lock] = cut();
    expect(lock?.maxDP50).toBeCloseTo(0.11, 4);
    expect(lock?.maxDeltaE).toBeGreaterThan(2.3);
    expect(lock?.maxDeltaE).toBeLessThan(2.6);
    // A darker median has a coarser step: one level of 12 is 1/12 of dP50.
    const dark = lockCells("r1", "room", "L7-high", [
      [row("a", "Floor", { unreal: { p50: 12 } })],
      [row("a", "Floor", { unreal: { p50: 12 } })],
    ]);
    expect(dark[0]?.maxDP50).toBeCloseTo(0.1 + 1 / 12, 4);
    // Without a reference median there is no step.
    const bare = lockCells("r1", "room", "L7-high", [
      [row("a", "Floor", { unreal: null })],
      [row("a", "Floor", { unreal: null })],
    ]);
    expect(bare[0]?.maxDP50).toBeCloseTo(0.1, 4);
    expect(bare[0]?.maxDeltaE).toBeCloseTo(2, 4);
  });

  it("widens every bound by the noise between the two runs, and a floor goes down by it", () => {
    const [lock] = lockCells("r1", "room", "L7-high", [
      [row("a", "Floor", { dP50: 0.1, iou: 0.99, unreal: null })],
      [row("a", "Floor", { dP50: 0.12, iou: 0.97, unreal: null })],
    ]);
    expect(lock).toMatchObject({ noiseDP50: 0.02, noiseIoU: 0.02 });
    expect(lock?.maxDP50).toBeCloseTo(0.13, 4); // mean 0.11 plus noise 0.02
    expect(lock?.minIoU).toBeCloseTo(0.96, 4); // mean 0.98 minus noise 0.02
  });

  it("rounds a bound away from the value it was cut from", () => {
    const value = 0.123456789;
    const [lock] = lockCells("r1", "room", "L7-high", [
      [row("a", "Floor", { dP50: value, iou: value, unreal: null })],
      [row("a", "Floor", { dP50: value, iou: value, unreal: null })],
    ]);
    expect(lock?.maxDP50).toBeGreaterThanOrEqual(value);
    expect(lock?.minIoU).toBeLessThanOrEqual(value);
    expect(String(lock?.maxDP50).replace("0.", "")).toHaveLength(5);
  });

  it("fails closed on one run, on runs that measure different regions and on a missing value", () => {
    expect(() => cut([rows()])).toThrow(/TN_UNREAL_LOOK_TOO_FEW_RUNS/);
    expect(() => cut([rows(), rows().slice(1)])).toThrow(/TN_UNREAL_LOOK_RUN_MISMATCH/);
    expect(() => cut([rows(), []])).toThrow(/TN_UNREAL_LOOK_RUN_MISMATCH/);
    expect(() => cut([[], []])).toThrow(/TN_UNREAL_LOOK_RUN_MISMATCH/);
    expect(() => cut([rows(), rows({ deltaE: null })])).toThrow(/TN_UNREAL_LOOK_MISSING_METRIC/);
    expect(() => lockCells("r1", "other", "L7-high", [rows(), rows()])).toThrow(
      /TN_UNREAL_LOOK_BAD_INPUT.*not a cell of the scene other/,
    );
  });
});

describe("mergeLocks", () => {
  const cutWith = (over: Partial<IMeasuredRow>, round = "r2") =>
    cut([rows(over), rows(over)], round);

  it("adds the cells that no lock covers and leaves every other scene and layer alone", () => {
    const other = { ...at(cut(), "a", "Floor"), scene: "another", round: "r0" };
    const merged = mergeLocks([other], cut());
    expect(merged.added).toHaveLength(4);
    expect(merged.locks).toHaveLength(5);
    expect(merged.locks[0]).toBe(other);
  });

  it("keeps the bounds of a tighter round until --tighten asks for them", () => {
    const first = cut();
    const better = cutWith({ dP50: 0.05 });
    const kept = mergeLocks(first, better);
    expect(kept.improved).toHaveLength(4);
    expect(kept.moved).toEqual([]);
    expect(kept.locks).toEqual(first);
    const moved = mergeLocks(first, better, { tighten: true });
    expect(moved.moved).toHaveLength(4);
    expect(moved.locks[0]).toMatchObject({ round: "r2" });
    expect((moved.locks[0] as IGiLock).maxDP50).toBeLessThan((first[0] as IGiLock).maxDP50);
  });

  it("is idempotent: the same round locks the same bounds", () => {
    const merged = mergeLocks(cut(), cut());
    expect(merged).toMatchObject({ added: [], moved: [], improved: [], looser: [] });
  });

  it("refuses a looser round, names the bound, and loosens only with --relax", () => {
    const first = cut();
    const worse = cutWith({ dP50: 0.4 });
    expect(() => mergeLocks(first, worse)).toThrow(
      /TN_UNREAL_LOOK_LOCK_LOOSER.*room L7-high a Floor maxDP50: 0\.11 -> 0\.41/,
    );
    expect(() => mergeLocks(first, worse, { tighten: true })).toThrow(/LOCK_LOOSER/);
    const relaxed = mergeLocks(first, worse, { relax: true });
    expect(relaxed.moved).toHaveLength(4);
    expect(relaxed.looser.length).toBeGreaterThan(0);
    expect((relaxed.locks[0] as IGiLock).maxDP50).toBeCloseTo(0.41, 4);
  });

  it("counts more noise, or a lower overlap, as looser", () => {
    const noisy = lockCells("r2", "room", "L7-high", [
      rows(),
      rows().map((r) => ({ ...r, deltaE: 2.001 })),
    ]);
    expect(() => mergeLocks(cut(), noisy)).toThrow(/LOCK_LOOSER.*noiseDeltaE/);
    expect(() => mergeLocks(cut(), cutWith({ iou: 0.9 }))).toThrow(/LOCK_LOOSER.*minIoU/);
  });

  it("cannot drop a locked cell: a round that no longer measures it is refused, with or without --relax", () => {
    const first = cut();
    const fewer = lockCells("r2", "room", "L7-high", [rows().slice(1), rows().slice(1)]);
    expect(() => mergeLocks(first, fewer)).toThrow(
      /TN_UNREAL_LOOK_LOCK_DROPPED.*1 locked cell.*room L7-high a Floor/,
    );
    expect(() => mergeLocks(first, fewer, { relax: true, tighten: true })).toThrow(/LOCK_DROPPED/);
  });
});

describe("checkGiLocks", () => {
  const locks = cut();
  const check = (runs: IMeasuredRow[][]) => checkGiLocks("room", "L7-high", runs, locks);
  const worse = (over: Partial<IMeasuredRow>) =>
    rows().map((r) => (r.cell === "room/a" && r.region === "Floor" ? { ...r, ...over } : r));

  it("passes the runs that the locks were cut from", () => {
    expect(check([rows(), rows()])).toEqual([]);
  });

  it("passes a region that moved by less than one display level", () => {
    expect(check([worse({ dP50: 0.105 }), worse({ dP50: 0.105 })])).toEqual([]);
  });

  it("fails a region that is past its ceiling, and names the metric, the run and the round", () => {
    const failures = check([rows(), worse({ dP50: 0.2 })]);
    expect(failures).toHaveLength(2); // past the ceiling, and the runs differ
    expect(failures[0]).toMatch(
      /room L7-high a Floor dP50: 0\.2 is above the lock 0\.11 in run 2 \(round r1\)/,
    );
    expect(check([worse({ deltaE: 9 }), worse({ deltaE: 9 })])[0]).toMatch(
      /a Floor deltaE: 9 is above/,
    );
  });

  it("fails a region whose overlap fell under the floor", () => {
    expect(check([worse({ iou: 0.5 }), worse({ iou: 0.5 })])[0]).toMatch(
      /a Floor iou: 0\.5 is below the lock 0\.99/,
    );
  });

  it("fails two runs that disagree by more than the locked noise, though both hold", () => {
    const failures = check([worse({ dP50: 0.1 }), worse({ dP50: 0.108 })]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/dP50: the runs differ by 0\.008, more than the locked noise 0/);
  });

  it("allows as much disagreement as the locked noise", () => {
    const noisy = lockCells("r1", "room", "L7-high", [
      rows(),
      rows().map((r) => ({ ...r, dP50: 0.12 })),
    ]);
    const runs = [
      rows().map((r) => ({ ...r, dP50: 0.1 })),
      rows().map((r) => ({ ...r, dP50: 0.12 })),
    ];
    expect(checkGiLocks("room", "L7-high", runs, noisy)).toEqual([]);
  });

  it("fails a locked region that a run does not have, and says which run", () => {
    const missing = rows().filter((r) => !(r.cell === "room/b" && r.region === "Wall"));
    const failures = check([missing, rows()]);
    expect(failures).toEqual(["room L7-high b Wall: missing from run 1 (locked by round r1)"]);
    expect(check([missing, missing])[0]).toMatch(/missing from run 1 and run 2/);
  });

  it("fails a run that has no value for a metric", () => {
    expect(check([worse({ iou: null }), rows()])[0]).toMatch(/a Floor iou: a run gave no value/);
  });

  it("cannot check on one run or on a scene and layer without a lock", () => {
    expect(() => check([rows()])).toThrow(/TN_UNREAL_LOOK_TOO_FEW_RUNS/);
    expect(() => checkGiLocks("room", "L7-low", [rows(), rows()], locks)).toThrow(
      /TN_UNREAL_LOOK_NO_LOCKS.*room at L7-low/,
    );
    expect(() => checkGiLocks("elsewhere", "L7-high", [rows(), rows()], locks)).toThrow(/NO_LOCKS/);
  });
});

describe("the lock file", () => {
  it("writes and reads back the same locks", () => {
    const file = path.join(temp(), "parity-locks.json");
    const locks = cut();
    writeGiLocks(file, locks);
    expect(readGiLocks(file)).toEqual(locks);
  });

  it("fails closed on an empty list, a wrong version, a duplicate and a bad number", () => {
    const dir = temp();
    const put = (name: string, content: unknown) => {
      const file = path.join(dir, name);
      writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
      return file;
    };
    const [one] = cut() as [IGiLock];
    expect(() => readGiLocks(put("empty.json", { version: 1, locks: [] }))).toThrow(
      /empty list locks nothing/,
    );
    expect(() => readGiLocks(put("version.json", { version: 2, locks: [one] }))).toThrow(
      /BAD_INPUT/,
    );
    expect(() => readGiLocks(put("twice.json", { version: 1, locks: [one, one] }))).toThrow(
      /locked twice/,
    );
    expect(() =>
      readGiLocks(put("negative.json", { version: 1, locks: [{ ...one, maxDP50: -1 }] })),
    ).toThrow(/maxDP50 must be a non-negative number/);
    expect(() =>
      readGiLocks(put("name.json", { version: 1, locks: [{ ...one, region: "" }] })),
    ).toThrow(/region must be a non-empty string/);
    expect(() => readGiLocks(put("broken.json", "{"))).toThrow(/BAD_INPUT/);
  });
});

describe("the committed lock file", () => {
  const locks = readGiLocks(GI_LOCK_FILE);
  const board = readRounds(
    new URL("../../tools/unreal-reference/gi/parity", import.meta.url).pathname,
  );
  const slack = (value: number) => 1e-3 * Math.abs(value) + 1e-4; // a round file keeps four digits

  it("locks the approved rounds: sunlit-room and cornell at high", () => {
    const groups = new Map<string, number>();
    for (const lock of locks) {
      const key = `${lock.scene} ${lock.layer}`;
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    expect(Object.fromEntries(groups)).toEqual({
      "sunlit-room L7-high": 40,
      "cornell L7-high": 12,
    });
  });

  it("names a round on the scoreboard that holds each locked region, inside the bounds of its lock", () => {
    for (const lock of locks) {
      const round = board.find((candidate) => candidate.id === lock.round);
      expect(round, `${lock.round} is not on the scoreboard`).toBeDefined();
      const region = round?.cells
        .find((cell) => cell.pose === lock.pose)
        ?.regions.find((candidate) => candidate.region === lock.region);
      const name = `${lock.scene} ${lock.pose} ${lock.region}`;
      expect(region, `${lock.round} has no ${name}`).toBeDefined();
      // The approved frames pass their own locks: the round's numbers sit inside every bound.
      expect(region?.dP50 as number, `${name} dP50`).toBeLessThanOrEqual(
        lock.maxDP50 + slack(lock.maxDP50),
      );
      expect(region?.deltaE as number, `${name} deltaE`).toBeLessThanOrEqual(
        lock.maxDeltaE + slack(lock.maxDeltaE),
      );
      expect(region?.iou as number, `${name} iou`).toBeGreaterThanOrEqual(
        lock.minIoU - slack(lock.minIoU),
      );
    }
  });
});

describe("withOfflineRoot", () => {
  it("names the capture folder, not the temporary root, in an error about one of its files", () => {
    const run = temp();
    let root = "";
    expect(() =>
      withOfflineRoot(run, (made) => {
        root = made;
        throw new Error(`TN_UNREAL_LOOK_MISSING_CELL: ${made}/threenative/room/L7-high/a.png`);
      }),
    ).toThrow(`MISSING_CELL: ${run}/room/L7-high/a.png`);
    expect(root).not.toBe("");
    expect(() => withOfflineRoot(path.join(run, "nope"), () => 1)).toThrow(/MISSING_CELL.*nope/);
  });
});

describe("the check command", () => {
  const world = (runs: Record<string, IMeasuredRow[]>) => {
    const file = path.join(temp(), "parity-locks.json");
    writeGiLocks(file, cut());
    const out = { log: [] as string[], error: [] as string[] };
    const deps: ICheckDeps = {
      compare: (_scene, _layer, run) => {
        const found = runs[run];
        if (!found) throw new Error(`TN_UNREAL_LOOK_MISSING_CELL: ${run}`);
        return found;
      },
      log: (line) => out.log.push(line),
      error: (line) => out.error.push(line),
    };
    const args = (...captures: string[]) => [
      "--check",
      "--scene",
      "gi:room",
      "--locks",
      file,
      ...captures.flatMap((capture) => ["--captures", capture]),
    ];
    return { out, deps, args };
  };

  it("exits 0 when every bound holds", () => {
    const w = world({ run1: rows(), run2: rows() });
    expect(checkCommand(w.args("run1", "run2"), w.deps)).toBe(0);
    expect(w.out.log).toEqual(["room L7-high: 4 locked region(s) on 2 runs, every bound holds"]);
    expect(w.out.error).toEqual([]);
  });

  it("exits 1 and prints each broken bound", () => {
    const w = world({ run1: rows(), run2: rows({ dP50: 0.3 }) });
    expect(checkCommand(w.args("run1", "run2"), w.deps)).toBe(1);
    expect(w.out.error.some((line) => /^GI LOCK BROKEN room L7-high a Floor dP50/.test(line))).toBe(
      true,
    );
    expect(w.out.log[0]).toMatch(/bound\(s\) broken/);
  });

  it("exits 1 when a run cannot be compared", () => {
    const w = world({ run1: rows() });
    expect(checkCommand(w.args("run1", "run2"), w.deps)).toBe(1);
    expect(w.out.error[0]).toMatch(/GI LOCK BROKEN .*MISSING_CELL: run2/);
  });

  it("needs two capture folders and a scene that has locks", () => {
    const w = world({ run1: rows(), run2: rows() });
    expect(() => checkCommand(w.args("run1"), w.deps)).toThrow(/TOO_FEW_RUNS/);
    expect(() => checkCommand(w.args(), w.deps)).toThrow(/TOO_FEW_RUNS/);
    const other = w.args("run1", "run2").map((arg) => (arg === "gi:room" ? "gi:cornell" : arg));
    expect(() => checkCommand(other, w.deps)).toThrow(/NO_LOCKS/);
    expect(() => checkCommand(["--check", "--captures", "a", "--captures", "b"], w.deps)).toThrow(
      /needs one scene/,
    );
  });

  it("takes `--check` with one named GI scene and nothing else", () => {
    expect(isGiCheck(["--check", "--scene", "gi:cornell"])).toBe(true);
    expect(isGiCheck(["--scene", "gi:cornell", "--captures", "a", "--check"])).toBe(true);
    // The reference scene's check, the GI report and any other family keep their own commands.
    expect(isGiCheck(["--check"])).toBe(false);
    expect(isGiCheck(["--check", "--layer", "L9", "--sun", "60"])).toBe(false);
    expect(isGiCheck(["--scene", "gi:cornell", "--layer", "L7-high"])).toBe(false);
    expect(isGiCheck(["--check", "--scene", "gi"])).toBe(false);
    expect(isGiCheck(["--check", "--scene", "shadow:lamp"])).toBe(false);
  });

  it("is what `compare --check --scene` runs", () => {
    expect(() => main(["--check", "--scene", "gi:cornell", "--captures", "only-one"])).toThrow(
      /TN_UNREAL_LOOK_TOO_FEW_RUNS/,
    );
  });
});
