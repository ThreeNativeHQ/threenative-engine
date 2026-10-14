import { describe, expect, it } from "vitest";
import {
  cpuWindowLabels,
  frameCountDelta,
  parsePerfCounters,
  processTreeDelta,
} from "../src/runner/linuxCpuWindow.js";

const scenario = {
  steps: [{ kind: "wait", label: "pose", waitTicks: 1000, release: true }],
} as Parameters<typeof cpuWindowLabels>[0];
const counts = (updates: number, renders = updates) => ({
  resources: { __threenativeFrameCounts: { updates, renders } },
});

describe("Linux matched CPU windows", () => {
  it("leaves ordinary runs untouched and validates the opt-in boundary", () => {
    expect(cpuWindowLabels(scenario, "android", false, undefined)).toEqual([]);
    expect(cpuWindowLabels(scenario, "browser", false, '["pose"]')).toEqual(["pose"]);
    expect(
      cpuWindowLabels(
        {
          steps: [
            { ...scenario.steps[0]!, press: [], pointers: [], media: { colorScheme: "dark" } },
          ],
        },
        "browser",
        false,
        '["pose"]',
      ),
    ).toEqual(["pose"]);
    for (const value of ["bad", "[]", '["pose","pose"]', '["missing"]', "[1]"]) {
      expect(() => cpuWindowLabels(scenario, "browser", false, value)).toThrow();
    }
    expect(() => cpuWindowLabels(scenario, "android", false, '["pose"]')).toThrow();
    expect(() => cpuWindowLabels(scenario, "browser", true, '["pose"]')).toThrow();
    for (const step of [
      { kind: "press", waitTicks: 1000 },
      { kind: "wait", waitTicks: 999 },
      { kind: "wait", waitTicks: 1000, waitFrames: 0 },
      { kind: "wait", waitTicks: 1000, waitForResource: {} },
    ]) {
      expect(() =>
        cpuWindowLabels(
          { steps: [{ ...step, label: "pose" }] } as typeof scenario,
          "browser",
          false,
          '["pose"]',
        ),
      ).toThrow();
    }
    expect(() =>
      cpuWindowLabels(
        { steps: [...scenario.steps, ...scenario.steps] } as typeof scenario,
        "browser",
        false,
        '["pose"]',
      ),
    ).toThrow();
  });
  it("requires exactly 1000 observed updates and renders", () => {
    expect(frameCountDelta(counts(20), counts(1020))).toEqual({ updates: 1000, renders: 1000 });
    for (const after of [
      counts(1019),
      counts(1020, 1019),
      counts(1021),
      counts(-1),
      counts(Number.NaN),
      {},
    ]) {
      expect(() => frameCountDelta(counts(20), after)).toThrow();
    }
  });
  it("refuses missing, scaled, multiplexed, zero or duplicate perf counters", () => {
    const good = "2000;;instructions:u;10000;100.00\n3000;;cycles:u;10000;100.00\n";
    expect(parsePerfCounters(good)).toEqual({ instructions: 2000, cycles: 3000 });
    for (const bad of [
      "",
      good.replace("2000", "<not supported>"),
      good.replace("2000", "0"),
      good.replace("100.00", "99.99"),
      good.replace("100.00", ""),
      `${good}${good}`,
      `${good}1;;lost;10000;100.00\n`,
    ]) {
      expect(() => parsePerfCounters(bad)).toThrow();
    }
  });
  it("counts all owned processes and rejects disappearing/replaced children or regressing CPU", () => {
    const before = new Map([
      [12, { starttime: "10", jiffies: 20 }],
      [13, { starttime: "11", jiffies: 5 }],
    ]);
    const after = new Map([
      [12, { starttime: "10", jiffies: 24 }],
      [13, { starttime: "11", jiffies: 7 }],
    ]);
    expect(processTreeDelta(before, after, 100)).toEqual({ cpuMs: 60, pids: [12, 13] });
    expect(() => processTreeDelta(before, new Map([[12, after.get(12)!]]), 100)).toThrow();
    expect(() =>
      processTreeDelta(before, new Map([...after, [14, { starttime: "15", jiffies: 1 }]]), 100),
    ).toThrow();
    expect(() =>
      processTreeDelta(
        before,
        new Map([
          [12, { starttime: "99", jiffies: 24 }],
          [13, after.get(13)!],
        ]),
        100,
      ),
    ).toThrow();
    expect(() =>
      processTreeDelta(
        before,
        new Map([
          [12, { starttime: "10", jiffies: 19 }],
          [13, after.get(13)!],
        ]),
        100,
      ),
    ).toThrow();
  });
});

import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "playwright";
import type { IPlaytestBridgeClient } from "../src/runner/bridgeClient.js";
import { browserCpuProcess, measureCpuWindow } from "../src/runner/linuxCpuWindow.js";
import { runStep } from "../src/runner/steps.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tn-cpu-fixture-"));
  const procRoot = join(root, "proc");
  const sysRoot = join(root, "sys");
  for (const pid of [101, 102])
    await mkdir(join(procRoot, `${pid}/task/${pid}`), { recursive: true });
  await mkdir(join(sysRoot, "devices/system/cpu/cpufreq/policy0"), { recursive: true });
  await writeFile(
    join(sysRoot, "devices/system/cpu/cpufreq/policy0/scaling_governor"),
    "performance\n",
  );
  await writeFile(join(procRoot, "loadavg"), "0.10 0.20 0.30 1/100 123\n");
  await writeFile(join(procRoot, "101/task/101/children"), "102\n");
  await writeFile(join(procRoot, "102/task/102/children"), "\n");
  await writeFile(join(procRoot, "101/task/101/comm"), "CrRendererMain\n");
  const stat = (pid: number, cpu: number, identity: string) => {
    const fields = Array<string>(20).fill("0");
    fields[0] = "S";
    fields[11] = String(cpu);
    fields[19] = identity;
    return `${pid} (thread ) name) ${fields.join(" ")}\n`;
  };
  const update = async (cpu: number, identity = "10") => {
    await writeFile(join(procRoot, "101/stat"), stat(101, cpu, "10"));
    await writeFile(join(procRoot, "101/task/101/stat"), stat(101, cpu, identity));
    await writeFile(join(procRoot, "101/task/101/schedstat"), `${cpu * 1000000} 0 0\n`);
    await writeFile(join(procRoot, "102/stat"), stat(102, cpu, "11"));
  };
  await update(10);
  const perfExecutable = join(root, "perf.cjs");
  await writeFile(
    perfExecutable,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const fifo = args.find(arg => arg.startsWith('--control=fifo:')).slice('--control=fifo:'.length).split(',');
fs.writeFileSync(path.join(__dirname, 'paths'), JSON.stringify(fifo));
if (fs.existsSync(path.join(__dirname, 'denied'))) { console.error('permission denied'); process.exit(1); }
const control = fs.openSync(fifo[0], fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
const ack = fs.openSync(fifo[1], fs.constants.O_RDWR);
const output = args[args.indexOf('-o') + 1];
const buffer = Buffer.alloc(64);
setInterval(() => {
  try {
    const n = fs.readSync(control, buffer, 0, buffer.length, null);
    if (!n) return;
    const command = buffer.subarray(0,n).toString().trim();
    fs.appendFileSync(path.join(__dirname, 'commands'), command + '\\n');
    if (command === 'disable') fs.writeFileSync(output, fs.existsSync(path.join(__dirname, 'bad')) ? '<not counted>;;instructions:u;10000;100.00\\n' : '2000;;instructions:u;10000;100.00\\n3000;;cycles:u;10000;100.00\\n');
    fs.writeSync(ack, 'ack\\n\\0');
  } catch(error) { if(error.code !== 'EAGAIN') throw error; }
}, 2);
process.on('SIGINT', () => process.exit(0));
`,
  );
  await chmod(perfExecutable, 0o700);
  let frames = 0;
  let tick = 0;
  const bridge = {
    sample: async () => ({
      ...counts(frames),
      clock: { mode: "fixed-step", tick },
      diagnostics: [],
    }),
  } as Pick<IPlaytestBridgeClient, "sample">;
  const owner = async () => ({ rootPid: 101, pid: 101, tid: 101 });
  const options = { procRoot, sysRoot, perfExecutable, hz: 100 };
  const advance = async (identity = "10", count = 1000, endTick = count) => {
    expect((await readFile(join(root, "commands"), "utf8")).trim()).toBe("enable");
    await update(20, identity);
    frames = count;
    tick = endTick;
  };
  const cleaned = async () => {
    const paths: string[] = JSON.parse(await readFile(join(root, "paths"), "utf8"));
    for (const path of paths) await expect(access(path)).rejects.toThrow();
  };
  return { root, bridge, owner, options, advance, cleaned };
}

describe("fake proc/perf acquisition (no benchmark claims)", () => {
  it("ACKs enable/disable around the advance, accounts for the owned child and removes FIFOs", async () => {
    const f = await fixture();
    try {
      const result = await measureCpuWindow(
        "pose",
        f.owner,
        f.bridge,
        () => f.advance(),
        f.options,
      );
      expect(result).toEqual({
        label: "pose",
        frames: 1000,
        startTick: 0,
        endTick: 1000,
        updates: 1000,
        renders: 1000,
        mainThread: {
          pid: 101,
          tid: 101,
          starttime: "10",
          cpuNs: 10000000,
          cpuMs: 10,
          cpuMsPerFrame: 0.01,
          instructions: 2000,
          instructionsPerFrame: 2,
          cycles: 3000,
          cyclesPerFrame: 3,
        },
        processTree: { cpuMs: 200, pids: [101, 102] },
        host: { load: [0.1, 0.2, 0.3], governors: { policy0: "performance" } },
      });
      expect(await readFile(join(f.root, "commands"), "utf8")).toBe("enable\ndisable\n");
      await f.cleaned();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
  for (const failure of ["identity", "frames", "ticks", "negativeTick", "fractionalTick", "counter", "permission", "advance", "child"]) {
    it(`fails closed on ${failure} and cleans its FIFOs`, async () => {
      const f = await fixture();
      try {
        if (failure === "counter") await writeFile(join(f.root, "bad"), "");
        if (failure === "permission") await writeFile(join(f.root, "denied"), "");
        await expect(
          measureCpuWindow(
            "pose",
            f.owner,
            f.bridge,
            async () => {
              if (failure === "advance") throw new Error("advance failed");
              await f.advance(
                failure === "identity" ? "99" : "10",
                failure === "frames" ? 999 : 1000,
                failure === "ticks" ? 1001 : failure === "negativeTick" ? -1 : failure === "fractionalTick" ? 1000.5 : 1000,
              );
              if (failure === "child")
                await rm(join(f.options.procRoot, "102"), { recursive: true });
            },
            f.options,
          ),
        ).rejects.toThrow();
        await f.cleaned();
      } finally {
        await rm(f.root, { recursive: true, force: true });
      }
    });
  }
  it("resolves only one CDP renderer and verifies its Linux main-thread comm", async () => {
    const f = await fixture();
    let info = [
      { type: "browser", id: 102 },
      { type: "renderer", id: 101 },
    ];
    const browser = {
      contexts: () => [{ pages: () => [{}] }],
      newBrowserCDPSession: async () => ({
        send: async () => ({ processInfo: info }),
        detach: async () => {},
      }),
    } as unknown as Browser;
    try {
      expect(await browserCpuProcess(browser, f.options.procRoot)).toEqual({
        rootPid: 102,
        pid: 101,
        tid: 101,
        renderer: true,
      });
      info.push({ type: "renderer", id: 103 });
      await expect(browserCpuProcess(browser, f.options.procRoot)).rejects.toThrow("ambiguous");
      info = info.slice(0, 2);
      await writeFile(join(f.options.procRoot, "101/task/101/comm"), "other\n");
      await expect(browserCpuProcess(browser, f.options.procRoot)).rejects.toThrow(
        "CrRendererMain",
      );
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it.each([false, true])(
    "wraps exactly 1000 browser advances, excluding release advances (%s)",
    async (releaseOnly) => {
      const events: string[] = [];
      const page = {
        keyboard: {
          up: async () => {
            events.push("release");
          },
        },
        evaluate: async () => {
          events.push("yield");
        },
      } as unknown as Page;
      const bridge = {
        advance: async (ticks: number) => {
          expect(ticks).toBe(1);
          events.push("advance");
        },
        description: { capabilities: ["runtime.fixedStep"] },
        sample: async () => {
          events.push("sample");
          return { clock: { mode: "fixed-step", tick: 1000 }, diagnostics: [] };
        },
      } as unknown as IPlaytestBridgeClient;
      await runStep(
        page,
        bridge,
        { ...scenario.steps[0]!, ...(releaseOnly ? { press: [] } : {}) },
        { width: 100, height: 100 },
        "subject",
        [],
        { heldKeys: new Set(releaseOnly ? ["KeyW"] : []), pointerButtons: 0, pointers: new Map() },
        { include: ["resources"] },
        false,
        undefined,
        false,
        async (advance) => {
          events.push("enable");
          await advance();
          events.push("disable");
        },
      );
      const start = events.indexOf("enable");
      const end = events.indexOf("disable");
      expect(events.slice(0, start)).toEqual(releaseOnly ? ["release", "advance", "yield"] : []);
      expect(events.slice(start, end).filter((event) => event === "advance")).toHaveLength(1000);
      expect(events.slice(start, end)).not.toContain("sample");
      expect(events.slice(end)).toEqual(
        releaseOnly
          ? ["disable", "yield", "sample", "sample", "advance", "yield", "sample"]
          : ["disable", "yield", "sample", "sample"],
      );
    },
  );
});
