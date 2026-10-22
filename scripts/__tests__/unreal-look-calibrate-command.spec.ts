import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type IDeps, main } from "../unreal-look/calibrate.js";
import type { IMeasured } from "../unreal-look/calibrateRound.js";
import { sceneBasis } from "../unreal-look/giLocks.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const PIXEL = PNG.sync.write(new PNG({ width: 1, height: 1 }));
const POSES = ["cornell", "corner"];
const COMMIT = "a".repeat(40);
const ADAPTER = { vendor: "nvidia", architecture: "turing", device: "", description: "" };

/** A temp world: an Unreal tree, a store, a scoreboard, and fakes for everything that needs a GPU or a model. */
function world(options: { omitUnreal?: string } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "unreal-look-calibrate-"));
  roots.push(root);
  const unreal = path.join(root, "unreal");
  for (const variant of ["ID", "L1", "L7-Epic", "L7-Medium", "L7-Low"])
    for (const pose of POSES) {
      const file = path.join(unreal, "cornell", variant, `${pose}.png`);
      if (file.endsWith(options.omitUnreal ?? "\0")) continue;
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, PIXEL);
    }
  const state = { commit: COMMIT, dirty: false, stamp: "1".repeat(64) };
  const behaviour = {
    adapter: ADAPTER as unknown,
    engine: "threenative",
    skip: undefined as string | undefined,
    directLightOk: true,
    judgeCode: 0,
    verdict: undefined as unknown,
    layers: ["ID", "L1", "L7", "L7-high", "L7-medium", "L7-low"],
    /** A multi-sun scene reports one engine per sun: `<scene>/<layer>/<sun>` (the sunlit-room scene). */
    suns: undefined as Record<string, string> | undefined,
    /** The run folder whose capture dies before it writes anything. */
    dieOn: undefined as string | undefined,
  };
  const calls = {
    capture: [] as { layers: string[]; out: string }[],
    judge: [] as string[][],
    sheet: [] as string[],
  };
  const log: string[] = [];
  const report = (job: { scene: string; layers: string[] }): Record<string, unknown> => {
    const out: Record<string, unknown> = { adapter: behaviour.adapter };
    const engines = behaviour.suns
      ? Object.entries(behaviour.suns).map(([sun, engine]) => [`/${sun}`, engine] as const)
      : [["", behaviour.engine] as const];
    for (const layer of job.layers)
      for (const [suffix, engine] of engines) out[`${job.scene}/${layer}${suffix}`] = { engine };
    return out;
  };
  const deps: IDeps = {
    captureLayers: async () => behaviour.layers,
    state: async () => ({ ...state }),
    resolve: (ref) => {
      if (ref === "HEAD") return state.commit;
      if (/^[0-9a-f]{40}$/.test(ref)) return ref;
      throw new Error(`unknown ref ${ref}`);
    },
    capture: async (job) => {
      calls.capture.push({ layers: job.layers, out: job.out });
      if (path.basename(job.out) === behaviour.dieOn) throw new Error("the browser crashed");
      for (const layer of job.layers)
        for (const pose of POSES) {
          const file = path.join(job.out, job.scene, layer, `${pose}.png`);
          if (file.endsWith(behaviour.skip ?? "\0")) continue;
          mkdirSync(path.dirname(file), { recursive: true });
          writeFileSync(file, PIXEL);
        }
      writeFileSync(path.join(job.out, "gi-capture.json"), JSON.stringify(report(job)));
    },
    compare: (scene, layer): IMeasured[] =>
      POSES.map((pose) => ({
        cell: `${scene}/${pose}`,
        region: "Back",
        deltaE: layer === "L1" && !behaviour.directLightOk ? 4 : 0.4,
        dP50: 0.004,
        dEv50: 0.01,
        iou: 0.99,
      })),
    judge: async (args) => {
      calls.judge.push(args);
      const out = args[args.indexOf("--out") + 1] as string;
      const frames = POSES.map((pose) => ({
        id: `cornell/L7/${pose}`,
        verdict: "NEUTRAL",
        vsUnreal: pose === "corner" ? "MATCH" : "CLOSE",
        reasons: "same lighting",
        differences: pose === "corner" ? "" : "the red tint is weaker",
      }));
      writeFileSync(
        out,
        JSON.stringify(
          behaviour.verdict ?? {
            status: "COMPLETE",
            model: "claude-sonnet-5-5",
            sessionId: "s1",
            costUsd: 0.3,
            durationMs: 5000,
            criteria: { sha256: "abc" },
            frames,
            overall: { verdict: "NEUTRAL", vsUnreal: "CLOSE", reasons: "one cell is close" },
          },
        ),
      );
      return behaviour.judgeCode;
    },
    sheet: async (spec) => {
      calls.sheet.push(spec);
    },
    now: () => new Date("2026-10-21T14:05:12.000Z"),
    log: (line) => log.push(line),
  };
  const argv = (
    extra: string[] = [],
    base = ["--scene", "gi:cornell", "--tier", "high", "--before", "HEAD"],
  ) => [
    ...base,
    "--unreal",
    unreal,
    "--store",
    path.join(root, "store"),
    "--scoreboard",
    path.join(root, "parity"),
    // A round checks the GI locks of its AFTER arm: the default is the repository's own file, so a spec names its own.
    "--locks",
    path.join(root, "no-locks.json"),
    ...extra,
  ];
  return { root, deps, state, behaviour, calls, log, argv, unreal };
}

describe("main", () => {
  it("prints the usage on --help", async () => {
    const w = world();
    expect(await main(["--help"], w.deps)).toBe(0);
    expect(w.log.join("\n")).toMatch(/unreal-look:calibrate --scene gi:<name> --tier/);
  });

  it("refuses a bad scene, tier, run count, expectation or a missing --before", async () => {
    const w = world();
    const run = (extra: string[], base?: string[]) => main(w.argv(extra, base), w.deps);
    await expect(run([], ["--tier", "high", "--before", "HEAD"])).rejects.toThrow(
      /BAD_INPUT.*--scene/,
    );
    await expect(
      run([], ["--scene", "gi:nowhere", "--tier", "high", "--before", "HEAD"]),
    ).rejects.toThrow(/BAD_INPUT.*nowhere/);
    await expect(
      run([], ["--scene", "shadow:lamp-room", "--tier", "high", "--before", "HEAD"]),
    ).rejects.toThrow(/BAD_INPUT/);
    await expect(
      run([], ["--scene", "gi:cornell", "--tier", "ultra", "--before", "HEAD"]),
    ).rejects.toThrow(/BAD_INPUT.*ultra/);
    await expect(run(["--runs", "1"])).rejects.toThrow(/TOO_FEW_RUNS/);
    await expect(run(["--expect", "better"])).rejects.toThrow(/BAD_INPUT.*--expect/);
    await expect(run([], ["--scene", "gi:cornell", "--tier", "high"])).rejects.toThrow(
      /BAD_INPUT.*--before/,
    );
    expect(w.calls.capture).toEqual([]);
  });

  it("fails before any capture when the harness lacks the tier layer or Unreal lacks a frame", async () => {
    const w = world();
    w.behaviour.layers = ["ID", "L1", "L7"];
    await expect(
      main(w.argv(["--tier", "medium"], ["--scene", "gi:cornell", "--before", "HEAD"]), w.deps),
    ).rejects.toThrow(/BAD_INPUT|NO_TIER_LAYER/);
    await expect(
      main(w.argv([], ["--scene", "gi:cornell", "--tier", "medium", "--before", "HEAD"]), w.deps),
    ).rejects.toThrow(/NO_TIER_LAYER.*L7-medium/);
    const lacking = world({ omitUnreal: "L7-Epic/corner.png" });
    await expect(main(lacking.argv(), lacking.deps)).rejects.toThrow(
      /MISSING_CELL.*L7-Epic\/corner.png/,
    );
    expect(w.calls.capture).toEqual([]);
    expect(lacking.calls.capture).toEqual([]);
  });

  it("captures ID, L1 and the tier layer twice, and fails closed on a missing cell, an unnamed adapter or the wrong engine", async () => {
    const missing = world();
    missing.behaviour.skip = "L7-high/corner.png";
    await expect(main(missing.argv(), missing.deps)).rejects.toThrow(
      /MISSING_CELL.*L7-high\/corner.png/,
    );
    const unnamed = world();
    unnamed.behaviour.adapter = { vendor: "", architecture: "", device: "", description: "" };
    await expect(main(unnamed.argv(), unnamed.deps)).rejects.toThrow(/UNNAMED_ADAPTER/);
    const software = world();
    software.behaviour.adapter = { vendor: "google", description: "SwiftShader" };
    await expect(main(software.argv(), software.deps)).rejects.toThrow(/SOFTWARE_ADAPTER/);
    const wrong = world();
    wrong.behaviour.engine = "threejs";
    await expect(main(wrong.argv(), wrong.deps)).rejects.toThrow(/WRONG_ENGINE.*cornell\/L1/);
    for (const w of [missing, unnamed, software, wrong]) expect(w.calls.judge).toEqual([]);
  });

  it("reads the engine of a multi-sun scene from its per-sun keys, and fails closed when one sun is off the owned engine", async () => {
    const w = world();
    w.behaviour.suns = { sun60: "threenative", sun15: "threenative" };
    expect(await main(w.argv(["--capture-only"]), w.deps)).toBe(0);
    expect(w.calls.capture).toHaveLength(2);
    const wrong = world();
    wrong.behaviour.suns = { sun60: "threenative", sun15: "threejs" };
    await expect(main(wrong.argv(), wrong.deps)).rejects.toThrow(
      /WRONG_ENGINE.*cornell\/L1.*threejs/,
    );
    const none = world();
    none.behaviour.suns = {};
    await expect(main(none.argv(), none.deps)).rejects.toThrow(
      /WRONG_ENGINE.*cornell\/L1.*undefined/,
    );
  });

  it("keeps a run that already verifies, so a failed attempt resumes at the run that died", async () => {
    const w = world();
    w.behaviour.dieOn = "run2";
    await expect(main(w.argv(["--capture-only"]), w.deps)).rejects.toThrow(/browser crashed/);
    expect(w.calls.capture.map((c) => path.basename(c.out))).toEqual(["run1", "run2"]);
    w.behaviour.dieOn = undefined;
    expect(await main(w.argv(["--capture-only"]), w.deps)).toBe(0);
    expect(w.calls.capture.map((c) => path.basename(c.out))).toEqual(["run1", "run2", "run2"]);
  });

  it("runs the baseline round on one arm: two runs, numbers, sheets, a judge, a scoreboard entry", async () => {
    const w = world();
    const code = await main(w.argv(), w.deps);
    expect(code).toBe(0);
    expect(w.calls.capture.map((c) => [c.layers, path.basename(c.out)])).toEqual([
      [["ID", "L1", "L7-high"], "run1"],
      [["ID", "L1", "L7-high"], "run2"],
    ]);
    const args = w.calls.judge[0] as string[];
    const values = (flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
    expect(values("--before").map((d) => path.basename(String(d)))).toEqual(["run1", "run2"]);
    expect(values("--after")).toEqual(values("--before"));
    expect(values("--tier")).toEqual(["high"]);
    expect(values("--layer")).toEqual(["L7"]);
    expect(values("--unreal")).toEqual([w.unreal]);
    const criteria = readFileSync(String(values("--criteria")[0]), "utf8");
    expect(criteria).toMatch(/Criteria for cornell at tier high/);
    expect(criteria).toMatch(/Numbers \(where to look; decide from the images\)/);

    const files = readdirSync(path.join(w.root, "parity"));
    expect(files).toEqual(["20261021T140512Z-cornell-high-1111111.json"]);
    const round = JSON.parse(readFileSync(path.join(w.root, "parity", files[0] as string), "utf8"));
    expect(round).toMatchObject({
      scene: "cornell",
      tier: "high",
      engine: "threenative",
      adapter: "nvidia turing",
      directLight: { pass: true, overridden: false },
    });
    expect(
      round.cells.map((c: { pose: string; vsUnreal: string }) => [c.pose, c.vsUnreal]),
    ).toEqual([
      ["cornell", "CLOSE"],
      ["corner", "MATCH"],
    ]);
    const text = w.log.join("\n");
    expect(text).toMatch(/GAP LIST[\s\S]*cornell CLOSE/);
    expect(text).toMatch(/PARITY cornell high: OPEN/);

    const spec = JSON.parse(readFileSync(String(w.calls.sheet[0]), "utf8"));
    expect(spec.sheets).toHaveLength(2);
    const [first] = spec.sheets[0].rows;
    expect(first.map((tile: { label: string }) => tile.label)).toEqual([
      "UNREAL 5.8.3 · L7-Epic · cornell",
      "WASM ENGINE BEFORE · L7 · high · cornell",
      "WASM ENGINE AFTER · L7 · high · cornell",
    ]);
    expect(first[2].sub).toBe("aaaaaaa · nvidia turing · run1");
    expect(spec.sheets[0].rows).toHaveLength(2);
  });

  it("--status prints the latest round, the gap list and the parity of each scene, and needs no capture", async () => {
    const w = world();
    const board = ["--scoreboard", path.join(w.root, "parity")];
    expect(await main(["--status", ...board], w.deps)).toBe(0);
    expect(w.log.join("\n")).toMatch(/no round on the scoreboard .* any scene at any tier/);
    expect(await main(w.argv(), w.deps)).toBe(0);
    w.log.length = 0;
    const captures = w.calls.capture.length;
    expect(await main(["--status", ...board], w.deps)).toBe(0);
    const text = w.log.join("\n");
    expect(text).toMatch(/1 round\(s\)\nROUND .*-cornell-high-1111111/);
    expect(text).toMatch(/GAP LIST/);
    expect(text).toMatch(/PARITY cornell high: OPEN/);
    expect(w.calls.capture).toHaveLength(captures);
    w.log.length = 0;
    await main(["--status", ...board, "--scene", "gi:cornell", "--tier", "medium"], w.deps);
    expect(w.log.join("\n")).toMatch(/no round .* for cornell at medium/);
    await expect(main(["--status", "--tier", "ultra"], w.deps)).rejects.toThrow(/BAD_INPUT.*ultra/);
  });

  it("never captures an arm twice: the second round reuses the stored runs", async () => {
    const w = world();
    await main(w.argv(), w.deps);
    const captures = w.calls.capture.length;
    await main(w.argv(), w.deps);
    expect(w.calls.capture).toHaveLength(captures);
    expect(w.log.join("\n")).toMatch(/reusing 2 runs/);
  });

  it("finds the BEFORE arm of another commit in the store, and says how to make one when it is missing", async () => {
    const w = world();
    const earlier = "b".repeat(40);
    await expect(
      main(w.argv([], ["--scene", "gi:cornell", "--tier", "high", "--before", earlier]), w.deps),
    ).rejects.toThrow(/NO_BEFORE.*bbbbbbb.*--capture-only/s);
    expect(w.calls.capture).toEqual([]);
    // The tree at the earlier commit captures its arm once.
    w.state.commit = earlier;
    w.state.stamp = "2".repeat(64);
    expect(
      await main(w.argv(["--capture-only"], ["--scene", "gi:cornell", "--tier", "high"]), w.deps),
    ).toBe(0);
    expect(w.calls.judge).toEqual([]);
    expect(readdirSync(path.join(w.root, "store", "arms"))).toEqual(["222222222222"]);
    // The change is made: a new commit and stamp.
    w.state.commit = COMMIT;
    w.state.stamp = "1".repeat(64);
    expect(
      await main(
        w.argv([], ["--scene", "gi:cornell", "--tier", "high", "--before", earlier]),
        w.deps,
      ),
    ).toBe(0);
    const args = w.calls.judge[0] as string[];
    const before = args.flatMap((a, i) => (a === "--before" ? [String(args[i + 1])] : []));
    const after = args.flatMap((a, i) => (a === "--after" ? [String(args[i + 1])] : []));
    expect(before[0]).toContain("222222222222");
    expect(after[0]).toContain("111111111111");
    const round = JSON.parse(
      readFileSync(
        path.join(w.root, "parity", readdirSync(path.join(w.root, "parity"))[0] as string),
        "utf8",
      ),
    );
    expect(round.before).toMatchObject({ commit: earlier, dirty: false });
    expect(round.after).toMatchObject({ commit: COMMIT });
  });

  it("stops on red direct light unless the override is given, and records the override", async () => {
    const w = world();
    w.behaviour.directLightOk = false;
    await expect(main(w.argv(), w.deps)).rejects.toThrow(/DIRECT_LIGHT_RED.*PRD-646/s);
    expect(w.calls.judge).toEqual([]);
    expect(existsSync(path.join(w.root, "parity"))).toBe(false);
    expect(await main(w.argv(["--allow-red-direct-light"]), w.deps)).toBe(0);
    const [file] = readdirSync(path.join(w.root, "parity"));
    const round = JSON.parse(readFileSync(path.join(w.root, "parity", String(file)), "utf8"));
    expect(round.directLight).toMatchObject({ pass: false, overridden: true });
    expect(w.log.join("\n")).toMatch(/direct light RED.*overridden/s);
  });

  it("returns the judge's exit code 2 for a REGRESSION and still records the round", async () => {
    const w = world();
    w.behaviour.judgeCode = 2;
    expect(await main(w.argv(), w.deps)).toBe(2);
    expect(readdirSync(path.join(w.root, "parity"))).toHaveLength(1);
  });

  it("writes no scoreboard entry when the verdict file is not complete or misses a cell", async () => {
    const failed = world();
    failed.behaviour.verdict = { status: "FAILED", error: "boom" };
    await expect(main(failed.argv(), failed.deps)).rejects.toThrow(/BAD_VERDICT.*FAILED/);
    expect(existsSync(path.join(failed.root, "parity"))).toBe(false);
    const partial = world();
    partial.behaviour.verdict = {
      status: "COMPLETE",
      frames: [
        {
          id: "cornell/L7/cornell",
          verdict: "NEUTRAL",
          vsUnreal: "MATCH",
          reasons: "x",
          differences: "",
        },
      ],
      overall: { verdict: "NEUTRAL", vsUnreal: "MATCH", reasons: "x" },
    };
    await expect(main(partial.argv(), partial.deps)).rejects.toThrow(/MISSING_CELL.*corner/);
  });

  it("captures an arm and stops on --capture-only, and plans without a capture on --dry-run", async () => {
    const w = world();
    expect(
      await main(w.argv(["--capture-only"], ["--scene", "gi:cornell", "--tier", "high"]), w.deps),
    ).toBe(0);
    expect(w.calls.capture).toHaveLength(2);
    expect(w.calls.judge).toEqual([]);
    const fresh = world();
    expect(await main(fresh.argv(["--dry-run"]), fresh.deps)).toBe(0);
    expect(fresh.calls.capture).toEqual([]);
    expect(fresh.calls.judge).toEqual([]);
    expect(fresh.log.join("\n")).toMatch(
      /dry run: cornell tier high layer L7-high, 2 poses \(cornell, corner\)/,
    );
  });

  describe("--lock (PRD-654)", () => {
    const round = (stamp: string) => `20261021T140512Z-cornell-high-${stamp.slice(0, 7)}`;
    const setup = async () => {
      const w = world();
      const locks = path.join(w.root, "locks.json");
      const lock = (id: string, extra: string[] = []) => [
        "--lock",
        id,
        "--store",
        path.join(w.root, "store"),
        "--scoreboard",
        path.join(w.root, "parity"),
        "--locks",
        locks,
        ...extra,
      ];
      const read = () => JSON.parse(readFileSync(locks, "utf8")).locks as Record<string, unknown>[];
      /** A round on a new tree: its stamp, and the numbers the compare gives from now on. */
      const roundWith = async (
        digit: string,
        numbers: { dP50?: number; regions?: string[] } = {},
        expected = 0,
        extra: string[] = [],
      ) => {
        w.state.stamp = digit.repeat(64);
        w.deps.compare = (scene): IMeasured[] =>
          POSES.flatMap((pose) =>
            (numbers.regions ?? ["Back"]).map((region) => ({
              cell: `${scene}/${pose}`,
              region,
              deltaE: 0.4,
              dP50: numbers.dP50 ?? 0.004,
              dEv50: 0.01,
              iou: 0.99,
            })),
          );
        expect(await main(w.argv(extra), w.deps)).toBe(expected);
        return round(w.state.stamp);
      };
      return { w, lock, read, roundWith, locks };
    };

    it("cuts one lock per region from the two runs of an approved round, and again changes nothing", async () => {
      const { w, lock, read, roundWith } = await setup();
      const id = await roundWith("1");
      expect(await main(lock(id), w.deps)).toBe(0);
      expect(read()).toHaveLength(2);
      expect(read()[0]).toMatchObject({
        scene: "cornell",
        layer: "L7-high",
        pose: "cornell",
        region: "Back",
        round: id,
        basis: sceneBasis("cornell"),
        maxDP50: 0.004,
        maxDeltaE: 0.4,
        minIoU: 0.99,
        noiseDP50: 0,
      });
      expect(w.log.join("\n")).toMatch(
        /locked cornell L7-high from .*: 2 region\(s\) in 2 pose\(s\), 2 added/,
      );
      const before = readFileSync(path.join(w.root, "locks.json"), "utf8");
      expect(await main(lock(id), w.deps)).toBe(0);
      expect(readFileSync(path.join(w.root, "locks.json"), "utf8")).toBe(before);
    });

    it("keeps a tighter round until --tighten, and refuses a looser round until --relax", async () => {
      const { w, lock, read, roundWith } = await setup();
      await main(lock(await roundWith("1")), w.deps);
      const better = await roundWith("2", { dP50: 0.002 });
      w.log.length = 0;
      expect(await main(lock(better), w.deps)).toBe(0);
      expect(read()[0]).toMatchObject({ maxDP50: 0.004 });
      expect(w.log.join("\n")).toMatch(/2 region\(s\) are tighter in this round: pass --tighten/);
      expect(await main(lock(better, ["--tighten"]), w.deps)).toBe(0);
      expect(read()[0]).toMatchObject({ maxDP50: 0.002, round: better });
      const worse = await roundWith("3", { dP50: 0.01 });
      await expect(main(lock(worse), w.deps)).rejects.toThrow(
        /LOCK_LOOSER.*maxDP50: 0\.002 -> 0\.01/,
      );
      await expect(main(lock(worse, ["--tighten"]), w.deps)).rejects.toThrow(/LOCK_LOOSER/);
      expect(read()[0]).toMatchObject({ maxDP50: 0.002 });
      expect(await main(lock(worse, ["--relax"]), w.deps)).toBe(0);
      expect(read()[0]).toMatchObject({ maxDP50: 0.01, round: worse });
      expect(w.log.join("\n")).toMatch(/relaxed 2 bound\(s\) on purpose/);
    });

    it("checks the locks of its AFTER arm: a worse round exits 2 and names the region, a better one passes", async () => {
      const { w, lock, roundWith, locks } = await setup();
      await main(lock(await roundWith("1")), w.deps);
      w.log.length = 0;
      await roundWith("2", { dP50: 0.002 }, 0, ["--locks", locks]);
      expect(w.log.join("\n")).toMatch(
        /GI locks hold: every locked region of cornell at L7-high is inside its bound/,
      );
      w.log.length = 0;
      const worse = await roundWith("3", { dP50: 0.01 }, 2, ["--locks", locks]);
      const text = w.log.join("\n");
      expect(text).toMatch(/GI LOCKS BROKEN \(\d+\): the change makes a locked region worse/);
      expect(text).toMatch(/cornell L7-high cornell Back dP50: 0\.01 is above the lock 0\.004/);
      expect(text).toMatch(/pass --relax to pnpm unreal-look:calibrate --lock <round>/);
      // The round is on the scoreboard all the same, so the evidence of the regression is kept.
      expect(readdirSync(path.join(w.root, "parity"))).toContain(`${worse}.json`);
      // A scene without a lock at this layer skips the check and says nothing about it.
      w.log.length = 0;
      await roundWith("4", { dP50: 0.009 }, 0, ["--locks", path.join(w.root, "elsewhere.json")]);
      expect(w.log.join("\n")).not.toMatch(/GI lock/i);
    });

    it("treats a lock cut against another scene basis as stale: a round logs it and passes, --lock needs --relax", async () => {
      const { w, lock, read, roundWith, locks } = await setup();
      await main(lock(await roundWith("1")), w.deps);
      // The scene was rebuilt since: the stored locks name the basis of the old one.
      const data = JSON.parse(readFileSync(locks, "utf8"));
      for (const entry of data.locks) entry.basis = "ffffffffffff";
      writeFileSync(locks, JSON.stringify(data));
      w.log.length = 0;
      const second = await roundWith("2", { dP50: 0.009 }, 0, ["--locks", locks]);
      const text = w.log.join("\n");
      expect(text).toMatch(/GI locks STALE: 2 lock\(s\) of cornell at L7-high were cut against/);
      expect(text).not.toMatch(/GI LOCKS BROKEN|GI locks hold/);
      await expect(main(lock(second), w.deps)).rejects.toThrow(/LOCK_STALE.*2 locked cell/);
      expect(read()[0]).toMatchObject({ basis: "ffffffffffff" });
      expect(await main(lock(second, ["--relax"]), w.deps)).toBe(0);
      expect(read()[0]).toMatchObject({ basis: sceneBasis("cornell"), round: second });
    });

    it("cannot drop a locked region: a round that lacks it is refused", async () => {
      const { w, lock, read, roundWith } = await setup();
      await main(lock(await roundWith("1", { regions: ["Back", "Floor"] })), w.deps);
      expect(read()).toHaveLength(4);
      const fewer = await roundWith("2", { regions: ["Back"] });
      await expect(main(lock(fewer, ["--relax"]), w.deps)).rejects.toThrow(
        /LOCK_DROPPED.*2 locked cell\(s\).*cornell L7-high cornell Floor/,
      );
      expect(read()).toHaveLength(4);
    });

    it("fails closed on a missing round, a dirty arm, a missing arm, an arm that moved and both flags", async () => {
      const { w, lock, roundWith } = await setup();
      const id = await roundWith("1");
      await expect(main(lock("nope"), w.deps)).rejects.toThrow(/NO_ROUND.*nope/);
      await expect(main(["--lock", "--store", "x"], w.deps)).rejects.toThrow(/BAD_INPUT/);
      await expect(main(lock(id, ["--tighten", "--relax"]), w.deps)).rejects.toThrow(
        /exclude each other/,
      );
      const empty = lock(id).map((arg, i, all) =>
        all[i - 1] === "--store" ? path.join(w.root, "empty") : arg,
      );
      await expect(main(empty, w.deps)).rejects.toThrow(/NO_ARM.*cannot be measured again/);
      const moved = w.deps.compare;
      w.deps.compare = (scene, layer, root) =>
        moved(scene, layer, root).map((row) => ({ ...row, dP50: 0.5 }));
      await expect(main(lock(id), w.deps)).rejects.toThrow(/ROUND_MISMATCH.*cornell\/Back/);
      w.deps.compare = moved;
      const file = path.join(w.root, "parity", `${id}.json`);
      const data = JSON.parse(readFileSync(file, "utf8"));
      data.after.dirty = true;
      writeFileSync(file, JSON.stringify(data));
      await expect(main(lock(id), w.deps)).rejects.toThrow(/DIRTY_ARM/);
    });
  });
});
