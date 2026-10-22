import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";
import { readRounds } from "../unreal-look/calibrateRound.js";
import { main } from "../unreal-look/compare.js";
import { readScene, sceneDir } from "../unreal-look/gi.js";
import {
  GI_LOCK_FILE,
  type ICheckDeps,
  type IGiLock,
  type IMeasuredRow,
  checkCommand,
  checkGiLocks,
  compareCapture,
  giCommand,
  isGiCheck,
  isGiLock,
  lockCells,
  lockCommand,
  lockKey,
  mergeLocks,
  readGiLocks,
  sceneBasis,
  splitParity,
  staleLocks,
  withOfflineRoot,
  writeGiLocks,
} from "../unreal-look/giLocks.js";

const BASIS = "0123456789ab";
/** The spec cuts and checks locks against one basis unless a test names another. */
const cells = (
  round: string,
  scene: string,
  layer: string,
  runs: readonly (readonly IMeasuredRow[])[],
  basis = BASIS,
  noise: readonly (readonly (readonly IMeasuredRow[])[])[] = [],
) => lockCells(round, scene, layer, runs, basis, noise);
const checkWith = (
  scene: string,
  layer: string,
  runs: readonly (readonly IMeasuredRow[])[],
  locks: readonly IGiLock[],
  basis = BASIS,
) => checkGiLocks(scene, layer, runs, locks, basis);

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
const cut = (runs = [rows(), rows()], round = "r1") => cells(round, "room", "L7-high", runs);
/** A capture with no ID frame has no overlap. */
const flat = (over: Partial<IMeasuredRow> = {}) => rows({ iou: null, ...over });
/** The two runs of another capture, which differ by `drift` in dP50. */
const noiseOf = (drift: number) => [flat({ dP50: 0.1 }), flat({ dP50: 0.1 + drift })];
/** The locks of one capture and the noise of another, as the L9 frames of the preview loop make them. */
const cutOne = (round = "head1") => cells(round, "room", "L9", [flat()], BASIS, [noiseOf(0.01)]);
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
      basis: BASIS,
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
    const dark = cells("r1", "room", "L7-high", [
      [row("a", "Floor", { unreal: { p50: 12 } })],
      [row("a", "Floor", { unreal: { p50: 12 } })],
    ]);
    expect(dark[0]?.maxDP50).toBeCloseTo(0.1 + 1 / 12, 4);
    // Without a reference median there is no step.
    const bare = cells("r1", "room", "L7-high", [
      [row("a", "Floor", { unreal: null })],
      [row("a", "Floor", { unreal: null })],
    ]);
    expect(bare[0]?.maxDP50).toBeCloseTo(0.1, 4);
    expect(bare[0]?.maxDeltaE).toBeCloseTo(2, 4);
  });

  it("widens every bound by the noise between the two runs, and a floor goes down by it", () => {
    const [lock] = cells("r1", "room", "L7-high", [
      [row("a", "Floor", { dP50: 0.1, iou: 0.99, unreal: null })],
      [row("a", "Floor", { dP50: 0.12, iou: 0.97, unreal: null })],
    ]);
    expect(lock).toMatchObject({ noiseDP50: 0.02, noiseIoU: 0.02 });
    expect(lock?.maxDP50).toBeCloseTo(0.13, 4); // mean 0.11 plus noise 0.02
    expect(lock?.minIoU).toBeCloseTo(0.96, 4); // mean 0.98 minus noise 0.02
  });

  it("rounds a bound away from the value it was cut from", () => {
    const value = 0.123456789;
    const [lock] = cells("r1", "room", "L7-high", [
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
    expect(() => cells("r1", "other", "L7-high", [rows(), rows()])).toThrow(
      /TN_UNREAL_LOOK_BAD_INPUT.*not a cell of the scene other/,
    );
  });

  it("cuts one capture with the noise of another, and marks that the check reads one capture", () => {
    const locks = cutOne();
    expect(locks).toHaveLength(4);
    expect(locks[0]).toMatchObject({ layer: "L9", round: "head1", runs: 1, noiseDP50: 0.01 });
    // The value, the noise of the other capture, and one display level of a median of 100.
    expect(locks[0]?.maxDP50).toBeCloseTo(0.1 + 0.01 + 0.01, 4);
    expect(cut()[0]).not.toHaveProperty("runs");
  });

  it("takes the widest spread of the noise groups", () => {
    const [lock] = cells("head1", "room", "L9", [flat()], BASIS, [noiseOf(0.02), noiseOf(0.05)]);
    expect(lock).toMatchObject({ noiseDP50: 0.05, noiseDeltaE: 0 });
    expect(lock?.maxDP50).toBeCloseTo(0.1 + 0.05 + 0.01, 4);
  });

  it("leaves out the overlap bound when the capture has no overlap, and keeps it when it has", () => {
    const [lock] = cutOne() as [IGiLock];
    expect(lock).not.toHaveProperty("minIoU");
    expect(lock).not.toHaveProperty("noiseIoU");
    expect(cut()[0]).toMatchObject({ minIoU: 0.99, noiseIoU: 0 });
  });

  it("fails closed on one run with no noise, noise beside two runs, a short group and a region the noise lacks", () => {
    expect(() => cells("h", "room", "L9", [flat()])).toThrow(
      /TN_UNREAL_LOOK_TOO_FEW_RUNS.*--noise/,
    );
    expect(() => cells("h", "room", "L9", [], BASIS, [noiseOf(0)])).toThrow(/TOO_FEW_RUNS/);
    expect(() => cells("h", "room", "L9", [flat(), flat()], BASIS, [noiseOf(0)])).toThrow(
      /TN_UNREAL_LOOK_BAD_INPUT.*--noise/,
    );
    expect(() => cells("h", "room", "L9", [flat()], BASIS, [[flat()]])).toThrow(
      /TN_UNREAL_LOOK_TOO_FEW_RUNS.*--noise group/,
    );
    expect(() => cells("h", "room", "L9", [flat()], BASIS, [[flat(), flat().slice(1)]])).toThrow(
      /TN_UNREAL_LOOK_RUN_MISMATCH.*noise runs/,
    );
    expect(() =>
      cells("h", "room", "L9", [flat()], BASIS, [[flat(), flat({ deltaE: null })]]),
    ).toThrow(/TN_UNREAL_LOOK_MISSING_METRIC/);
  });

  it("fails closed on a capture whose runs have an overlap in one run and none in the other", () => {
    expect(() => cut([flat(), rows()])).toThrow(/TN_UNREAL_LOOK_MISSING_METRIC.*iou/);
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

  it("refuses a round on another scene basis: the old bounds do not carry over, and --relax cuts them again", () => {
    const first = cut();
    const rebuilt = cells("r2", "room", "L7-high", [rows(), rows()], "ffffffffffff");
    expect(() => mergeLocks(first, rebuilt)).toThrow(
      /TN_UNREAL_LOOK_LOCK_STALE.*4 locked cell\(s\).*room L7-high a Floor/,
    );
    expect(() => mergeLocks(first, rebuilt, { tighten: true })).toThrow(/LOCK_STALE/);
    const cutAgain = mergeLocks(first, rebuilt, { relax: true });
    expect(cutAgain.stale).toHaveLength(4);
    expect(cutAgain.moved).toHaveLength(4);
    expect(
      cutAgain.locks.every((lock) => lock.basis === "ffffffffffff" && lock.round === "r2"),
    ).toBe(true);
  });

  it("counts more noise, or a lower overlap, as looser", () => {
    const noisy = cells("r2", "room", "L7-high", [
      rows(),
      rows().map((r) => ({ ...r, deltaE: 2.001 })),
    ]);
    expect(() => mergeLocks(cut(), noisy)).toThrow(/LOCK_LOOSER.*noiseDeltaE/);
    expect(() => mergeLocks(cut(), cutWith({ iou: 0.9 }))).toThrow(/LOCK_LOOSER.*minIoU/);
  });

  it("counts a dropped overlap bound as looser, and a new one as tighter", () => {
    const without = cut([flat(), flat()], "r2");
    expect(() => mergeLocks(cut(), without)).toThrow(/LOCK_LOOSER.*a Floor minIoU: 0\.99 -> none/);
    expect(mergeLocks(without, cut()).improved).toHaveLength(4);
    expect(mergeLocks(cut(), without, { relax: true }).locks[0]).not.toHaveProperty("minIoU");
  });

  it("cannot drop a locked cell: a round that no longer measures it is refused, with or without --relax", () => {
    const first = cut();
    const fewer = cells("r2", "room", "L7-high", [rows().slice(1), rows().slice(1)]);
    expect(() => mergeLocks(first, fewer)).toThrow(
      /TN_UNREAL_LOOK_LOCK_DROPPED.*1 locked cell.*room L7-high a Floor/,
    );
    expect(() => mergeLocks(first, fewer, { relax: true, tighten: true })).toThrow(/LOCK_DROPPED/);
  });
});

describe("checkGiLocks", () => {
  const locks = cut();
  const check = (runs: IMeasuredRow[][], basis = BASIS) =>
    checkWith("room", "L7-high", runs, locks, basis);
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
    const noisy = cells("r1", "room", "L7-high", [
      rows(),
      rows().map((r) => ({ ...r, dP50: 0.12 })),
    ]);
    const runs = [
      rows().map((r) => ({ ...r, dP50: 0.1 })),
      rows().map((r) => ({ ...r, dP50: 0.12 })),
    ];
    expect(checkWith("room", "L7-high", runs, noisy)).toEqual([]);
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

  it("cannot judge a lock that was cut against another scene basis, and names the round", () => {
    expect(() => check([rows(), rows()], "aaaaaaaaaaaa")).toThrow(
      /TN_UNREAL_LOOK_LOCK_STALE.*room L7-high: 4 of 4 lock\(s\).*\(round r1\).*--relax/s,
    );
    expect(staleLocks(locks, "room", "L7-high", BASIS)).toEqual([]);
    expect(staleLocks(locks, "room", "L7-high", "aaaaaaaaaaaa")).toHaveLength(4);
    // A lock of another scene or layer is not this check's business.
    expect(staleLocks(locks, "elsewhere", "L7-high", "aaaaaaaaaaaa")).toEqual([]);
    expect(staleLocks(locks, "room", "L7-low", "aaaaaaaaaaaa")).toEqual([]);
  });

  it("reads one capture for a lock that one capture cut, and none for no capture", () => {
    const one = cutOne();
    expect(checkWith("room", "L9", [flat()], one)).toEqual([]);
    expect(() => checkWith("room", "L9", [], one)).toThrow(
      /TN_UNREAL_LOOK_TOO_FEW_RUNS.*cut from 1/,
    );
    const failures = checkWith("room", "L9", [flat({ dP50: 0.5 })], one);
    expect(failures[0]).toMatch(
      /room L9 a Floor dP50: 0\.5 is above the lock 0\.12 in run 1 \(round head1\)/,
    );
    // Two captures still have to agree to the locked noise.
    const apart = [flat({ dP50: 0.1 }), flat({ dP50: 0.115 })];
    expect(checkWith("room", "L9", apart, one)[0]).toMatch(
      /the runs differ by 0\.015, more than the locked noise 0\.01/,
    );
  });

  it("asks for no overlap where the lock has none, and checks it where the lock has one", () => {
    const one = cutOne();
    expect(checkWith("room", "L9", [rows({ iou: 0.1 })], one)).toEqual([]);
    expect(checkWith("room", "L7-high", [rows({ iou: null }), rows()], locks)[0]).toMatch(
      /a Floor iou: a run gave no value/,
    );
  });

  it("cannot check on one run or on a scene and layer without a lock", () => {
    expect(() => check([rows()])).toThrow(/TN_UNREAL_LOOK_TOO_FEW_RUNS/);
    expect(() => checkWith("room", "L7-low", [rows(), rows()], locks)).toThrow(
      /TN_UNREAL_LOOK_NO_LOCKS.*room at L7-low/,
    );
    expect(() => checkWith("elsewhere", "L7-high", [rows(), rows()], locks)).toThrow(/NO_LOCKS/);
  });
});

describe("the lock file", () => {
  it("writes and reads back the same locks", () => {
    const file = path.join(temp(), "parity-locks.json");
    const locks = cut();
    writeGiLocks(file, locks);
    expect(readGiLocks(file)).toEqual(locks);
  });

  it("writes and reads back a lock with no overlap bound and one capture", () => {
    const file = path.join(temp(), "parity-locks.json");
    writeGiLocks(file, cutOne());
    const read = readGiLocks(file);
    expect(read).toEqual(cutOne());
    expect(read[0]).toMatchObject({ runs: 1 });
    expect(read[0]).not.toHaveProperty("minIoU");
  });

  it("fails closed on an overlap bound without its noise and on a capture count that is not a number of captures", () => {
    const dir = temp();
    const put = (name: string, lock: unknown) => {
      const file = path.join(dir, name);
      writeFileSync(file, JSON.stringify({ version: 1, locks: [lock] }));
      return file;
    };
    const [one] = cut() as [IGiLock];
    const { noiseIoU: _noise, ...half } = one;
    expect(() => readGiLocks(put("half.json", half))).toThrow(/minIoU and noiseIoU go together/);
    for (const runs of [0, 1.5, "1"])
      expect(() => readGiLocks(put("runs.json", { ...one, runs }))).toThrow(
        /runs must be a whole number of at least 1/,
      );
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
    const { basis: _basis, ...unbound } = one;
    expect(() => readGiLocks(put("unbound.json", { version: 1, locks: [unbound] }))).toThrow(
      /basis must be the 12 hex digits/,
    );
    expect(() =>
      readGiLocks(put("short.json", { version: 1, locks: [{ ...one, basis: "abc" }] })),
    ).toThrow(/basis must be/);
  });
});

describe("the committed lock file", () => {
  const locks = readGiLocks(GI_LOCK_FILE);
  const board = readRounds(
    new URL("../../tools/unreal-reference/gi/parity", import.meta.url).pathname,
  );
  const slack = (value: number) => 1e-3 * Math.abs(value) + 1e-4; // a round file keeps four digits

  it("locks the approved rounds at high and the approved L9 capture: sunlit-room and cornell, and mirror-room L8", () => {
    const groups = new Map<string, number>();
    for (const lock of locks) {
      const key = `${lock.scene} ${lock.layer}`;
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    // A lock exists only where the region is at parity, so a group may hold fewer locks than the scene has regions.
    expect([...groups.keys()].sort()).toEqual([
      "cornell L1",
      "cornell L7-high",
      "cornell L9",
      "mirror-room L8",
      "sunlit-room L1",
      "sunlit-room L7-high",
      "sunlit-room L9",
    ]);
  });

  it("names a round on the scoreboard that holds each locked region, inside the bounds of its lock", () => {
    for (const lock of locks.filter((candidate) => candidate.layer.startsWith("L7"))) {
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
      const floor = lock.minIoU as number;
      expect(region?.iou as number, `${name} iou`).toBeGreaterThanOrEqual(floor - slack(floor));
    }
  });

  it("cuts the L1 direct-light locks from the runs of one arm, with an overlap bound, for the regions at parity", () => {
    const l1 = locks.filter((lock) => lock.layer === "L1");
    for (const lock of l1) {
      expect(lock.round, lockKey(lock)).toMatch(/^arm-[0-9a-f]{12}$/);
      expect([undefined, 3], lockKey(lock)).toContain(lock.runs);
      expect(lock.minIoU, lockKey(lock)).toBeDefined();
    }
    // Poses with no region at parity have no lock; no pose has one that is not a pose of the scene.
    for (const scene of new Set(l1.map((lock) => lock.scene)))
      expect(
        readScene(`gi:${scene}`).scene.poses.map((pose) => pose.name),
        scene,
      ).toEqual(
        expect.arrayContaining([
          ...new Set(l1.filter((lock) => lock.scene === scene).map((lock) => lock.pose)),
        ]),
      );
  });

  it("cuts the L9 locks from the captures of one head, for the regions at parity", () => {
    const l9 = locks.filter((lock) => lock.layer === "L9");
    for (const lock of l9) {
      expect(lock.round, lockKey(lock)).toMatch(/^[a-z0-9]+-[0-9a-f]{9}$/);
      // One capture with the noise of others, or the repeat captures of one code state.
      expect([1, 3], lockKey(lock)).toContain(lock.runs ?? 2);
    }
    // A lock exists only where the region is at parity: a pose may have none, but every locked pose is the scene's.
    for (const scene of new Set(l9.map((lock) => lock.scene)))
      expect(readScene(`gi:${scene}`).scene.poses.map((pose) => pose.name)).toEqual(
        expect.arrayContaining([
          ...new Set(l9.filter((lock) => lock.scene === scene).map((lock) => lock.pose)),
        ]),
      );
  });
});

describe("sceneBasis", () => {
  const scene = (stats: unknown = { generatedAt: "a", resolution: [4, 4], cells: { x: 1 } }) => {
    const dir = temp();
    mkdirSync(path.join(dir, "id"));
    writeFileSync(path.join(dir, "reference-stats.json"), JSON.stringify(stats));
    writeFileSync(path.join(dir, "id", "p1.png"), "frame one");
    writeFileSync(path.join(dir, "id", "p2.png"), "frame two");
    writeFileSync(path.join(dir, "scene.json"), '{"regions":[]}');
    return dir;
  };

  it("is 12 hex digits, and the same for the same scene", () => {
    expect(sceneBasis("room", scene())).toMatch(/^[0-9a-f]{12}$/);
    expect(sceneBasis("room", scene())).toBe(sceneBasis("room", scene()));
  });

  it("ignores the time the statistics were written and the motion runs, and follows every input that sets a measurement", () => {
    const base = sceneBasis("room", scene());
    expect(
      sceneBasis("room", scene({ generatedAt: "b", resolution: [4, 4], cells: { x: 1 } })),
    ).toBe(base);
    expect(
      sceneBasis("room", scene({ generatedAt: "a", resolution: [4, 4], cells: { x: 2 } })),
    ).not.toBe(base);
    expect(
      sceneBasis("room", scene({ generatedAt: "a", resolution: [8, 8], cells: { x: 1 } })),
    ).not.toBe(base);
    const frame = scene();
    writeFileSync(path.join(frame, "id", "p2.png"), "frame two, rebuilt");
    expect(sceneBasis("room", frame)).not.toBe(base);
    const definition = scene();
    writeFileSync(path.join(definition, "scene.json"), '{"regions":[{"name":"Floor"}]}');
    expect(sceneBasis("room", definition)).not.toBe(base);
    const motion = scene();
    writeFileSync(
      path.join(motion, "scene.json"),
      '{"regions":[],"motion":{"pan":{"frames":180}}}',
    );
    expect(sceneBasis("room", motion)).toBe(base);
    const extra = scene();
    writeFileSync(path.join(extra, "id", "p3.png"), "a third pose");
    expect(sceneBasis("room", extra)).not.toBe(base);
  });

  it("fails closed on a scene without statistics, frames or definition", () => {
    const dir = temp();
    expect(() => sceneBasis("room", dir)).toThrow();
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

describe("a capture with no ID frames", () => {
  const capture = () => {
    const run = temp();
    mkdirSync(path.join(run, "room", "L9"), { recursive: true });
    writeFileSync(path.join(run, "room", "L9", "a.png"), "frame");
    return run;
  };

  it("gets the committed Unreal ID frames beside its own layer folders", () => {
    const ids = temp();
    withOfflineRoot(
      capture(),
      (root) => {
        const scene = path.join(root, "threenative", "room");
        expect(readdirSync(scene).sort()).toEqual(["ID", "L9"]);
        expect(readlinkSync(path.join(scene, "ID"))).toBe(ids);
        expect(readFileSync(path.join(scene, "L9", "a.png"), "utf8")).toBe("frame");
      },
      { key: "room", dir: ids },
    );
  });

  it("is used as it is when it has ID frames, and refused when it has no frames of the scene", () => {
    const run = capture();
    mkdirSync(path.join(run, "room", "ID"));
    withOfflineRoot(
      run,
      (root) => expect(lstatSync(path.join(root, "threenative")).isSymbolicLink()).toBe(true),
      { key: "room", dir: temp() },
    );
    expect(() => withOfflineRoot(temp(), () => 1, { key: "room", dir: temp() })).toThrow(
      /TN_UNREAL_LOOK_MISSING_CELL.*no frames of room/,
    );
  });

  it("is compared with the committed Unreal statistics, and measures no overlap", () => {
    const { resolution } = JSON.parse(
      readFileSync(path.join(sceneDir("gi:cornell"), "reference-stats.json"), "utf8"),
    ) as { resolution: [number, number] };
    const frame = new PNG({ width: resolution[0], height: resolution[1] });
    for (let i = 0; i < frame.data.length; i += 4) frame.data.set([128, 128, 128, 255], i);
    const run = temp();
    mkdirSync(path.join(run, "cornell", "L9"), { recursive: true });
    for (const { name } of readScene("gi:cornell").scene.poses)
      writeFileSync(path.join(run, "cornell", "L9", `${name}.png`), PNG.sync.write(frame));
    const flatRows = compareCapture("gi:cornell", "L9", run);
    expect(flatRows.length).toBeGreaterThan(0);
    expect(flatRows.every((r) => r.iou === null && Number.isFinite(r.dP50))).toBe(true);
    // With the Unreal ID frames as its own, the same capture overlaps everywhere.
    mkdirSync(path.join(run, "cornell", "ID"));
    for (const name of readdirSync(path.join(sceneDir("gi:cornell"), "id")))
      writeFileSync(
        path.join(run, "cornell", "ID", name),
        readFileSync(path.join(sceneDir("gi:cornell"), "id", name)),
      );
    const ownRows = compareCapture("gi:cornell", "L9", run);
    expect(ownRows.map((r) => r.region)).toEqual(flatRows.map((r) => r.region));
    expect(ownRows.every((r) => r.iou === 1)).toBe(true);
    expect(() => compareCapture("gi:cornell", "L9", path.join(run, "nope"))).toThrow(
      /MISSING_CELL.*nope/,
    );
  });
});

describe("the check command", () => {
  const world = (runs: Record<string, IMeasuredRow[]>, basis = BASIS, locks = cut()) => {
    const file = path.join(temp(), "parity-locks.json");
    writeGiLocks(file, locks);
    const out = { log: [] as string[], error: [] as string[] };
    const deps: ICheckDeps = {
      basis: () => basis,
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
    expect(w.out.log[0]).toBe("room L7-high: 4 locked region(s) on 2 runs, every bound holds");
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

  it("prints the total distance to Unreal of the layer: the mean of the runs over every region", () => {
    const w = world({
      run1: rows({ dP50: 0.1, deltaE: 2, pass: true }),
      run2: rows({ dP50: 0.2, deltaE: 4, pass: false }),
    });
    checkCommand(w.args("run1", "run2"), w.deps);
    expect(w.out.log).toContain(
      "room L7-high: distance to Unreal dP50 0.6000, deltaE 12.00 over 4 region(s), 0 at parity",
    );
  });

  it("exits 1 on a stale lock and says why, instead of listing bounds it cannot judge", () => {
    const w = world({ run1: rows(), run2: rows() }, "aaaaaaaaaaaa");
    expect(checkCommand(w.args("run1", "run2"), w.deps)).toBe(1);
    expect(w.out.error).toHaveLength(1);
    expect(w.out.error[0]).toMatch(
      /^GI LOCK BROKEN TN_UNREAL_LOOK_LOCK_STALE: room L7-high: 4 of 4/,
    );
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

  it("reads one capture when the locks were cut from one", () => {
    const w = world({ run1: flat() }, BASIS, cutOne());
    expect(checkCommand(w.args("run1"), w.deps)).toBe(0);
    expect(w.out.log[0]).toBe("room L9: 4 locked region(s) on 1 run, every bound holds");
    const broken = world({ run1: flat({ dP50: 0.5 }) }, BASIS, cutOne());
    expect(checkCommand(broken.args("run1"), broken.deps)).toBe(1);
    expect(broken.out.error[0]).toMatch(/^GI LOCK BROKEN room L9 a Floor dP50: 0\.5 is above/);
    expect(() => checkCommand(broken.args(), broken.deps)).toThrow(/TOO_FEW_RUNS/);
  });

  it("checks every layer of the scene unless --layer names one", () => {
    const w = world({ run1: flat() }, BASIS, [...cut(), ...cutOne()]);
    // The L7 locks were cut from two runs: one capture cannot check them, and --layer leaves them out.
    expect(() => checkCommand(w.args("run1"), w.deps)).toThrow(/TOO_FEW_RUNS.*room at L7-high/);
    expect(checkCommand([...w.args("run1"), "--layer", "L9"], w.deps)).toBe(0);
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

describe("the lock command", () => {
  const world = (runs: Record<string, IMeasuredRow[]>) => {
    const file = path.join(temp(), "parity-locks.json");
    const out = { log: [] as string[], error: [] as string[] };
    const deps: ICheckDeps = {
      basis: () => BASIS,
      compare: (_scene, _layer, run) => {
        const found = runs[run];
        if (!found) throw new Error(`TN_UNREAL_LOOK_MISSING_CELL: ${run}`);
        return found;
      },
      log: (line) => out.log.push(line),
      error: (line) => out.error.push(line),
    };
    const args = (...more: string[]) => [
      "--write-locks",
      "head1",
      "--scene",
      "gi:room",
      "--layer",
      "L9",
      "--locks",
      file,
      ...more,
    ];
    return { file, out, deps, args };
  };
  const runs = { good: flat(), n1: flat({ dP50: 0.1 }), n2: flat({ dP50: 0.11 }) };

  it("cuts one layer from one capture and the noise of another, and writes the lock file", () => {
    const w = world(runs);
    expect(lockCommand(w.args("--captures", "good", "--noise", "n1,n2"), w.deps)).toBe(0);
    expect(readGiLocks(w.file)).toEqual(cutOne());
    expect(w.out.log[0]).toMatch(
      /^locked room L9 from head1: 4 region\(s\) in 2 pose\(s\), 4 added, 0 moved, 0 tighter and kept/,
    );
  });

  it("refuses a cut that is looser than the lock, writes nothing, and --relax accepts it", () => {
    const w = world({ ...runs, worse: flat({ dP50: 0.3 }) });
    lockCommand(w.args("--captures", "good", "--noise", "n1,n2"), w.deps);
    const before = readFileSync(w.file, "utf8");
    const loose = w.args("--captures", "worse", "--noise", "n1,n2");
    expect(() => lockCommand(loose, w.deps)).toThrow(/TN_UNREAL_LOOK_LOCK_LOOSER/);
    expect(readFileSync(w.file, "utf8")).toBe(before);
    expect(lockCommand([...loose, "--relax"], w.deps)).toBe(0);
    expect(readGiLocks(w.file)[0]?.maxDP50).toBeCloseTo(0.3 + 0.01 + 0.01, 4);
  });

  it("keeps a lock only where every run is at parity, drops the lock of any other region, and lists it", () => {
    const off = (pose: string, region: string, pass: boolean | null) =>
      flat().map((r) => (r.cell.endsWith(pose) && r.region === region ? { ...r, pass } : r));
    const w = world({
      ...runs,
      good: off("a", "Wall", false).map((r) => ({ ...r, pass: r.pass ?? true })),
    });
    lockCommand(w.args("--captures", "n1", "--noise", "n1,n2", "--keep-off-parity"), w.deps);
    expect(readGiLocks(w.file)).toHaveLength(4);
    w.out.log.length = 0;
    const cutArgs = w.args("--captures", "good", "--noise", "n1,n2", "--relax");
    expect(lockCommand(cutArgs, w.deps)).toBe(0);
    expect(readGiLocks(w.file).map((l) => `${l.pose} ${l.region}`)).toEqual([
      "a Floor",
      "b Floor",
      "b Wall",
    ]);
    expect(w.out.log.join("\n")).toMatch(/removed 1 lock\(s\) off parity:\n\s+room L9 a Wall/);
  });

  it("splits the rows of the runs into the regions at parity in every run and the ones that are not", () => {
    const r1 = rows({ pass: true });
    const r2 = rows({ pass: true }).map((r) => (r.region === "Wall" ? { ...r, pass: false } : r));
    const r3 = rows({ pass: true }).map((r) => (r.cell.endsWith("b") ? { ...r, pass: null } : r));
    const split = splitParity([r1, r2, r3]);
    expect(split.off.sort()).toEqual(["room/a Wall", "room/b Floor", "room/b Wall"]);
    expect(split.runs.map((run) => run.map((r) => `${r.cell} ${r.region}`))).toEqual([
      ["room/a Floor"],
      ["room/a Floor"],
      ["room/a Floor"],
    ]);
    // A row with no pass field has no verdict to read: it stays.
    expect(splitParity([rows()]).off).toEqual([]);
  });

  it("--recut takes every bound from the cut, the looser and the tighter ones, and refuses --tighten or --relax beside it", () => {
    const w = world({ ...runs, worse: flat({ dP50: 0.3 }), better: flat({ dP50: 0.05 }) });
    const noise = ["--noise", "n1,n2"];
    lockCommand(w.args("--captures", "good", ...noise), w.deps);
    lockCommand(w.args("--captures", "worse", ...noise, "--recut"), w.deps);
    expect(readGiLocks(w.file)[0]?.maxDP50).toBeCloseTo(0.3 + 0.01 + 0.01, 4);
    lockCommand(w.args("--captures", "better", ...noise, "--recut"), w.deps);
    expect(readGiLocks(w.file)[0]?.maxDP50).toBeCloseTo(0.05 + 0.01 + 0.01, 4);
    expect(() =>
      lockCommand(w.args("--captures", "better", ...noise, "--recut", "--relax"), w.deps),
    ).toThrow(/--recut already moves every bound/);
  });

  it("needs a capture, noise for a single capture, one layer and no contradicting flags", () => {
    const w = world(runs);
    expect(() => lockCommand(w.args("--noise", "n1,n2"), w.deps)).toThrow(/TOO_FEW_RUNS/);
    expect(() => lockCommand(w.args("--captures", "good"), w.deps)).toThrow(
      /TOO_FEW_RUNS.*--noise/,
    );
    expect(() => lockCommand(w.args("--captures", "good", "--noise", "n1"), w.deps)).toThrow(
      /--noise group/,
    );
    expect(() => lockCommand(w.args("--captures", "good", "--noise", "n1,nope"), w.deps)).toThrow(
      /MISSING_CELL: nope/,
    );
    const noLayer = w
      .args("--captures", "good", "--noise", "n1,n2")
      .filter((a) => a !== "--layer" && a !== "L9");
    expect(() => lockCommand(noLayer, w.deps)).toThrow(/cuts one layer/);
    const both = w.args("--captures", "good", "--noise", "n1,n2", "--tighten", "--relax");
    expect(() => lockCommand(both, w.deps)).toThrow(/exclude each other/);
    expect(() => lockCommand(["--write-locks", "h", "--layer", "L9"], w.deps)).toThrow(
      /needs one scene/,
    );
  });

  it("takes `--write-locks` with one named GI scene, and the reference scene keeps its own", () => {
    expect(isGiLock(["--write-locks", "head1", "--scene", "gi:cornell"])).toBe(true);
    expect(isGiLock(["--write-locks", "head1"])).toBe(false);
    expect(isGiLock(["--scene", "gi:cornell"])).toBe(false);
    expect(isGiLock(["--write-locks", "h", "--scene", "shadow:lamp"])).toBe(false);
    expect(giCommand(["--sun", "60"])).toBeUndefined();
    expect(giCommand(["--write-locks", "head1", "--layer", "L9"])).toBeUndefined();
    expect(() =>
      main(["--write-locks", "head1", "--scene", "gi:cornell", "--layer", "L9"]),
    ).toThrow(/TN_UNREAL_LOOK_TOO_FEW_RUNS/);
  });
});
