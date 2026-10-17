import { describe, expect, it, vi } from "vitest";
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
import { makeTempDir } from "../../../test-support/temp-dir.js";

async function fixture() {
  const root = await makeTempDir("tn-cpu-fixture-");
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
    await writeFile(join(procRoot, "102/task/102/stat"), stat(102, cpu, "11"));
  };
  await update(10);
  const perfExecutable = join(root, "perf.cjs");
  await writeFile(
    perfExecutable,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const record = args[0] === 'record';
const prefix = record ? 'record-' : '';
if (!record) fs.writeFileSync(path.join(__dirname, 'stat-args'), JSON.stringify(args));
const fifo = args.find(arg => arg.startsWith('--control=fifo:')).slice('--control=fifo:'.length).split(',');
fs.writeFileSync(path.join(__dirname, prefix + 'paths'), JSON.stringify(fifo));
if (record) {
  fs.writeFileSync(path.join(__dirname, 'record-args'), JSON.stringify(args));
  fs.writeFileSync(path.join(__dirname, 'record-pid'), String(process.pid));
  if (fs.existsSync(path.join(__dirname, 'record-denied'))) { console.error('record permission denied'); process.exit(1); }
}
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
    fs.appendFileSync(path.join(__dirname, prefix + 'commands'), command + '\\n');
    if (record && command === 'disable' && fs.existsSync(path.join(__dirname, 'record-disable-denied'))) { console.error('record disable failed'); process.exit(1); }
    if (command === 'disable') fs.writeFileSync(output, record ? fs.existsSync(path.join(__dirname, 'record-empty')) ? '' : 'fake perf data' : fs.existsSync(path.join(__dirname, 'bad')) ? '<not counted>;;instructions:u;10000;100.00\\n' : '2000;;instructions:u;10000;100.00\\n3000;;cycles:u;10000;100.00\\n');
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

type Listener = (event: never) => void;

function rendererSessions(mode: string) {
  const events: string[] = [];
  const cdp = (name: string, respond: (method: string, listeners: Map<string, Listener>) => unknown) => {
    const listeners = new Map<string, Listener>();
    return {
      listeners,
      on: (event: string, listener: Listener) => { listeners.set(event, listener); },
      off: (event: string) => { listeners.delete(event); },
      detach: async () => { events.push(`${name} detach`); },
      send: async (method: string) => {
        events.push(`${name} ${method}`);
        return respond(method, listeners);
      },
    };
  };
  const browserSession = cdp("browser", (method, listeners) => {
    if (method === "SystemInfo.getProcessInfo") return { processInfo: [
      { type: "browser", id: mode === "outside" ? 102 : 101 },
      { type: "renderer", id: mode === "outside" ? 101 : 102 },
      { type: "renderer", id: 103 },
    ] };
    if (method === "Tracing.end") {
      listeners.get("Tracing.dataCollected")?.({ value: [{ name: "TracingStartedInBrowser", args: {} }] } as never);
      listeners.get("Tracing.tracingComplete")?.({} as never);
    }
    return {};
  });
  const pageSession = cdp("page", (method, listeners) => {
    if (method === "Page.getFrameTree") {
      if (mode === "frameFailure") throw new Error("frame unavailable");
      return { frameTree: { frame: { id: "root" } } };
    }
    if (method === "Tracing.start" && mode === "conflict") throw new Error("Tracing already started");
    if (method === "Tracing.end") {
      const frames = mode === "missing" ? [] : [
        { frame: "root", processId: mode === "unknown" ? 999 : mode === "outside" ? 101 : 102 },
        { frame: "spare", processId: 103 },
        ...(mode === "ambiguous" ? [{ frame: "root", processId: 103 }] : []),
      ];
      listeners.get("Tracing.dataCollected")?.({ value: [
        { name: "TracingStartedInBrowser", args: { data: { frames } } },
      ] } as never);
      if (mode !== "timeout") listeners.get("Tracing.tracingComplete")?.({} as never);
    }
    return {};
  });
  const context = { pages: () => [{}], newCDPSession: async () => pageSession };
  const browser = {
    contexts: () => [context],
    newBrowserCDPSession: async () => browserSession,
  } as unknown as Browser;
  return { browser, browserSession, pageSession, events };
}

describe("fake proc/perf acquisition (no benchmark claims)", () => {
  it.each([false, true])("records the owned scope inside the ACKed pose with separate stat FIFOs (browser=%s)", async (renderer) => {
    const f = await fixture();
    const directory = join(f.root, "profiles");
    vi.stubEnv("TN_PLAYTEST_CPU_PROFILE_DIR", directory);
    try {
      const result = await measureCpuWindow("pose/one", async () => ({ ...await f.owner(), renderer }), f.bridge, async () => {
        expect(await readFile(join(f.root, "record-commands"), "utf8")).toBe("enable\n");
        await f.advance();
      }, f.options);
      const artifact = join(directory, "pose%2Fone.perf.data");
      expect(result).toMatchObject({ profile: { kind: "perf-record", path: artifact, recorderScope: renderer ? "main-thread" : "native-process" } });
      expect(await readFile(artifact, "utf8")).toBe("fake perf data");
      const args: string[] = JSON.parse(await readFile(join(f.root, "record-args"), "utf8"));
      expect(args).toEqual([
        "record", "--no-inherit", renderer ? "-t" : "-p", "101", "-e", "cycles:u", "-F", "250", "-m", "64",
        "--call-graph", "dwarf,32768", "-D", "-1", "-o", artifact, expect.stringMatching(/^--control=fifo:/),
      ]);
      const statArgs: string[] = JSON.parse(await readFile(join(f.root, "stat-args"), "utf8"));
      expect(statArgs).toContain("-t");
      expect(statArgs[statArgs.indexOf("-t") + 1]).toBe("101");
      expect(statArgs).not.toContain("-p");
      const statPaths: string[] = JSON.parse(await readFile(join(f.root, "paths"), "utf8"));
      const recordPaths: string[] = JSON.parse(await readFile(join(f.root, "record-paths"), "utf8"));
      expect(new Set([...statPaths, ...recordPaths]).size).toBe(4);
      expect(await readFile(join(f.root, "record-commands"), "utf8")).toBe("enable\ndisable\n");
      expect(await readFile(join(f.root, "commands"), "utf8")).toBe("enable\ndisable\n");
      for (const path of recordPaths) await expect(access(path)).rejects.toThrow();
      const pid = Number(await readFile(join(f.root, "record-pid"), "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
      await f.cleaned();
    } finally {
      vi.unstubAllEnvs();
      await rm(f.root, { recursive: true, force: true });
    }
  });
  for (const failure of ["advance", "record-denied", "record-disable-denied"]) {
    it(`fails closed and reaps both profilers on ${failure}`, async () => {
      const f = await fixture();
      vi.stubEnv("TN_PLAYTEST_CPU_PROFILE_DIR", join(f.root, "profiles"));
      try {
        if (failure !== "advance") await writeFile(join(f.root, failure), "");
        await expect(measureCpuWindow("pose", f.owner, f.bridge, async () => {
          await f.advance();
          if (failure === "advance") throw new Error("advance failed");
        }, f.options)).rejects.toThrow(failure === "advance" ? "advance failed" : /record|perf/i);
        if (failure !== "record-denied") {
          expect(await readFile(join(f.root, "commands"), "utf8")).toBe("enable\ndisable\n");
          expect(await readFile(join(f.root, "record-commands"), "utf8")).toBe("enable\ndisable\n");
        }
        const paths: string[] = JSON.parse(await readFile(join(f.root, "record-paths"), "utf8"));
        for (const path of paths) await expect(access(path)).rejects.toThrow();
        const pid = Number(await readFile(join(f.root, "record-pid"), "utf8"));
        expect(() => process.kill(pid, 0)).toThrow();
        await f.cleaned();
      } finally {
        vi.unstubAllEnvs();
        await rm(f.root, { recursive: true, force: true });
      }
    });
  }
  it("preserves the advance error when recorder disable also fails", async () => {
    const f = await fixture();
    vi.stubEnv("TN_PLAYTEST_CPU_PROFILE_DIR", join(f.root, "profiles"));
    try {
      await writeFile(join(f.root, "record-disable-denied"), "");
      const original = new Error("original advance failure");
      const error = await measureCpuWindow("pose", f.owner, f.bridge, async () => {
        throw original;
      }, f.options).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).cause).toBe(original);
      expect((error as AggregateError).errors).toContain(original);
      expect(await readFile(join(f.root, "commands"), "utf8")).toBe("enable\ndisable\n");
      await f.cleaned();
    } finally {
      vi.unstubAllEnvs();
      await rm(f.root, { recursive: true, force: true });
    }
  });
  for (const failure of ["existing", "empty"]) {
    it(`rejects ${failure} profile output`, async () => {
      const f = await fixture();
      const directory = join(f.root, "profiles");
      const artifact = join(directory, "pose.perf.data");
      vi.stubEnv("TN_PLAYTEST_CPU_PROFILE_DIR", directory);
      try {
        if (failure === "existing") {
          await mkdir(directory);
          await writeFile(artifact, "keep existing profile");
        } else {
          await writeFile(join(f.root, "record-empty"), "");
        }
        await expect(measureCpuWindow("pose", f.owner, f.bridge, () => f.advance(), f.options)).rejects.toThrow();
        if (failure === "existing") expect(await readFile(artifact, "utf8")).toBe("keep existing profile");
        else await f.cleaned();
      } finally {
        vi.unstubAllEnvs();
        await rm(f.root, { recursive: true, force: true });
      }
    });
  }
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
        startUs: expect.any(Number),
        endUs: expect.any(Number),
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
      expect(Number.isSafeInteger(result.startUs)).toBe(true);
      expect(Number.isSafeInteger(result.endUs)).toBe(true);
      expect(result.startUs).toBeGreaterThan(0);
      expect(result.endUs).toBeGreaterThan(result.startUs);
      expect(JSON.parse(JSON.stringify(result)).startUs).toBe(result.startUs);
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
  it("rejects invalid monotonic boundaries after disabling perf", async () => {
    const f = await fixture();
    try {
      await expect(measureCpuWindow("pose", f.owner, f.bridge, async () => {
        await f.advance();
        vi.spyOn(process.hrtime, "bigint").mockReturnValueOnce(0n);
      }, f.options)).rejects.toThrow("invalid monotonic CPU window boundaries");
      expect(await readFile(join(f.root, "commands"), "utf8")).toBe("enable\ndisable\n");
      await f.cleaned();
    } finally {
      vi.restoreAllMocks();
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it("resolves the renderer leader even when Linux preserves the chrome comm", async () => {
    const f = await fixture();
    const info = [
      { type: "browser", id: 101 },
      { type: "renderer", id: 102 },
    ];
    const browser = {
      contexts: () => [{ pages: () => [{}] }],
      newBrowserCDPSession: async () => ({
        send: async () => ({ processInfo: info }),
        detach: async () => {},
      }),
    } as unknown as Browser;
    try {
      await writeFile(join(f.options.procRoot, "102/task/102/comm"), "chrome\n");
      expect(await browserCpuProcess(browser, f.options.procRoot)).toEqual({
        rootPid: 101,
        pid: 102,
        tid: 102,
        renderer: true,
      });
      await rm(join(f.options.procRoot, "102/task/102/stat"));
      await expect(browserCpuProcess(browser, f.options.procRoot)).rejects.toThrow(
        "ENOENT",
      );
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it("maps the page root when browser-target trace metadata is empty", async () => {
    const f = await fixture();
    const { browser, events } = rendererSessions("target");
    try {
      await writeFile(join(f.options.procRoot, "102/task/102/comm"), "CrRendererMain\n");
      expect(await browserCpuProcess(browser, f.options.procRoot)).toEqual({
        rootPid: 101,
        pid: 102,
        tid: 102,
        renderer: true,
      });
      expect(events.filter((event) => event.startsWith("browser Tracing."))).toEqual([]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it.each([
    ["ambiguous", "missing or ambiguous page-root renderer mapping"],
    ["missing", "missing or ambiguous page-root renderer mapping"],
    ["unknown", "missing or ambiguous page-root renderer mapping"],
    ["outside", "renderer is outside owned browser tree"],
    ["conflict", "Tracing already started"],
    ["frameFailure", "frame unavailable"],
    ["timeout", "renderer identity CDP timeout"],
  ])("fails closed on a spare-renderer problem: %s", async (mode, reason) => {
    const f = await fixture();
    const { browser, browserSession, pageSession, events } = rendererSessions(mode);
    try {
      await writeFile(join(f.options.procRoot, "102/task/102/comm"), mode === "comm" ? "other" : "CrRendererMain");
      if (mode === "timeout") vi.useFakeTimers();
      const rejected = expect(browserCpuProcess(browser, f.options.procRoot)).rejects.toThrow(reason);
      if (mode === "timeout") await vi.runAllTimersAsync();
      await rejected;
      expect(events.filter((event) => event.startsWith("browser Tracing."))).toEqual([]);
      expect(events.slice(-2)).toEqual(["page detach", "browser detach"]);
      expect(events.filter((event) => event === "page Tracing.end")).toHaveLength(
        mode === "conflict" || mode === "frameFailure" ? 0 : mode === "timeout" ? 2 : 1,
      );
      expect(browserSession.listeners.size + pageSession.listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
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
        advance: async (ticks: number, options?: { render?: boolean }) => {
          expect(ticks).toBe(1);
          // Only the measured window couples updates to world draws.
          events.push(options?.render === true ? "advance" : "advance-plain");
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
      expect(events.slice(0, start)).toEqual(releaseOnly ? ["release", "advance-plain"] : []);
      expect(events.slice(start, end).filter((event) => event === "advance")).toHaveLength(1000);
      expect(events.slice(start, end)).not.toContain("sample");
      expect(events.slice(end)).toEqual(
        releaseOnly
          ? ["disable", "yield", "sample", "sample", "advance-plain", "sample"]
          : ["disable", "yield", "sample", "sample"],
      );
    },
  );
});
