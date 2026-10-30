import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../test-support/temp-dir.js";

const { abba, closeStrayPages, fileName, parseArm, poolRuns, saveRun, waitGpuIdle, waitQuiet } =
  await import(new URL("../stress-fair.mjs", import.meta.url).href);

/** A clock and a /proc/loadavg stub: one reading per `pollMs` step. */
const clock = (loads: number[]) => {
  let at = 0;
  let index = 0;
  return {
    now: () => at,
    readLoad: () => loads[Math.min(index++, loads.length - 1)],
    wait: async (ms: number) => {
      at += ms;
    },
  };
};

describe("stress-fair (PRD-770)", () => {
  it("orders the arms ABBA", () => {
    expect(abba(["a", "b"])).toEqual(["a", "b", "b", "a"]);
    expect(abba(["a", "b", "c"])).toEqual(["a", "b", "c", "c", "b", "a"]);
  });

  it("reads engine=url and takes the URL flags as the variant", () => {
    expect(parseArm("threenative-wasm=http://x:5740/main.html?stress&plainShadow")).toMatchObject({
      engine: "threenative-wasm",
      variant: "plainShadow",
    });
    expect(parseArm("three-vanilla=http://x:5736/main.html?stress").variant).toBe("stress");
    expect(() => parseArm("godot=http://x/")).toThrow(/engine/u);
    expect(() => parseArm("http://x/")).toThrow(/engine/u);
  });

  it("starts only after the load stays under 4 for 60 s", async () => {
    // 5 s polls: loud, then quiet readings for 60+ s
    const stub = clock([9, 7, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3]);
    const load = await waitQuiet({ ...stub, pollMs: 5000 });
    expect(load).toBe(3);
    expect(stub.now()).toBe(10_000 + 60_000 + 0);
  });

  it("restarts the 60 s hold when the load spikes, and times out inside the lock", async () => {
    const spike = clock([3, 3, 3, 3, 3, 3, 5, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3]);
    await waitQuiet({ ...spike, pollMs: 5000 });
    expect(spike.now()).toBeGreaterThanOrEqual(30_000 + 5000 + 60_000);
    const busy = clock([9]);
    await expect(waitQuiet({ ...busy, pollMs: 5000, timeoutMs: 20 * 60_000 })).rejects.toThrow(
      /lock released/u,
    );
  });

  it("pools the valid runs and drops a run whose load rose above 6", () => {
    const run = (fps: number, load: number[], sha = "aaaaaaaaaaaa") => ({
      url: "u",
      load,
      build: { kind: "wasm", sha256: sha, commit: "c" },
      report: { metrics: { fps, gpuP95Ms: null }, counts: {} },
    });
    const pooled = poolRuns([run(40, [3, 4]), run(50, [3, 7.5]), run(60, [2, 3])]);
    expect(pooled).toMatchObject({ runs: 2, voidRuns: 1 });
    expect(pooled.report.metrics).toEqual({ fps: 50, gpuP95Ms: null });
    expect(poolRuns([run(40, [8])])).toBeUndefined();
    expect(() => poolRuns([run(40, [3]), run(50, [3], "bbbbbbbbbbbb")])).toThrow(
      /different builds/u,
    );
  });
  it("starts a run only after the GPU stays under 10% for 5 s, and refuses after the timeout", async () => {
    let at = 0;
    const clockOf = {
      now: () => at,
      wait: async (ms: number) => {
        at += ms;
      },
    };
    // A stray page keeps the GPU at 30%, then it closes: 3 s under the limit is not enough, 5 s is.
    const readings = [30, 30, 3, 3, 3, 12, 3, 3, 3, 3, 3, 3];
    let index = 0;
    await waitGpuIdle({ ...clockOf, read: () => readings[Math.min(index++, readings.length - 1)] });
    expect(at).toBe(11_000); // the 12% spike restarts the 5 s hold at t=6 s
    at = 0;
    await expect(waitGpuIdle({ ...clockOf, read: () => 30, timeoutMs: 60_000 })).rejects.toThrow(
      /GPU stayed at or above 10%.*run refused/u,
    );
    expect(() =>
      waitGpuIdle({
        ...clockOf,
        read: () => {
          throw new Error("cannot read GPU utilization");
        },
      }),
    ).rejects.toThrow(/cannot read/u);
  });

  it("closes every page that is not about:blank before a run", async () => {
    const pages = [
      { id: "a", url: "about:blank" },
      { id: "b", url: "http://127.0.0.1:5738/main.html?stress" },
    ];
    const closed: string[] = [];
    const urls = await closeStrayPages({
      pages: async () => pages,
      close: async (page: { id: string }) => void closed.push(page.id),
    });
    expect(urls).toEqual(["http://127.0.0.1:5738/main.html?stress"]);
    expect(closed).toEqual(["b"]);
  });
  it("tells two arms of one engine apart by the value of a URL flag", () => {
    const develop = parseArm("threenative-wasm=http://127.0.0.1:5740/main.html?stress&arm=develop");
    const fb1 = parseArm("threenative-wasm=http://127.0.0.1:5742/main.html?stress&arm=fb1");
    expect(develop.variant).toBe("arm=develop");
    expect(fb1.variant).toBe("arm=fb1");
    expect(parseArm("threenative-wasm=http://x:1/main.html?stress&arm=a&plainShadow").variant).toBe(
      "arm=a&plainShadow",
    );
    // Same engine and same flag keys, other port: still another file.
    expect(fileName("t", "vsync", `${develop.engine} ${develop.url}`)).not.toBe(
      fileName("t", "vsync", `${fb1.engine} ${fb1.url}`),
    );
  });

  it("writes every run to the out dir before pooling can refuse the window", () => {
    const outDir = makeTempDirSync("tn-fair-spec-");
    const run = (sha: string, index: number) => ({
      engine: "threenative-wasm",
      url: "http://127.0.0.1:5740/main.html?stress",
      load: [3],
      build: { kind: "wasm", sha256: sha, commit: "c" },
      report: { metrics: { fps: 60 }, counts: {} },
      index,
    });
    const firstRun = run("aaaaaaaaaaaa", 0);
    const runs = [firstRun, run("bbbbbbbbbbbb", 1)];
    const options = { outDir, tag: "t" };
    for (const entry of runs) saveRun(options, "vsync", entry);
    // The pool refuses (two builds under one URL) after the evidence is on disk.
    expect(() => poolRuns(runs)).toThrow(/different builds/u);
    for (const index of [0, 1])
      expect(
        existsSync(
          join(outDir, fileName("t", "vsync", `${firstRun.engine} ${firstRun.url}`, index)),
        ),
      ).toBe(true);
  });

  it("writes 4 files for 4 runs of 2 arms: an arm's second run does not overwrite its first", () => {
    const outDir = makeTempDirSync("tn-fair-spec-");
    const arms = ["5740", "5742"].map((port) =>
      parseArm(`threenative-wasm=http://127.0.0.1:${port}/main.html?stress&arm=${port}`),
    );
    const order = abba(arms);
    const options = { outDir, tag: "t" };
    for (const arm of order)
      saveRun(options, "uncapped", {
        engine: arm.engine,
        url: arm.url,
        load: [3],
        build: { kind: "wasm", sha256: "aaaaaaaaaaaa", commit: "c" },
        report: { metrics: { fps: 60 }, counts: {} },
      });
    expect(readdirSync(outDir)).toHaveLength(4);
  });
});
