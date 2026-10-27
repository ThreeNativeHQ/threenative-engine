/**
 * `pnpm profile:wasm-page -- --url <url> [--control <url>] [--seconds 5] [--load 0] [--calls] [--memory] [--json]`
 *
 * Profiles a running game page the way a Wasm-engine performance question needs: frame time from
 * requestAnimationFrame, a Chrome CPU profile grouped into engine Wasm, JavaScript and WebGPU calls
 * (with the top inclusive functions), and with `--calls` the JS->Wasm engine calls per frame by name
 * (three-native's opt-in census, `__tnCallCounts`), and with `--gpu-calls` the WebGPU API calls per
 * frame on both pages (render passes, draws, bind groups, buffer writes). `--control` runs a second page, the same game on
 * three.js, through the same measurement, so the verdict is a ratio on one lane, never an absolute.
 * `--load <n>` keeps `n` busy-loop processes alive for the whole page run: the stated CPU load.
 *
 * It refuses a software WebGPU adapter (`--allow-software` overrides) and needs a display: run it as
 * `sh scripts/xvfb.sh pnpm profile:wasm-page -- ...`. Wasm function names need a module linked with
 * `--profiling-funcs`; without it the Wasm rows are numbered. Diagnose with it; the steady-state
 * counter gates (render_database_test steady_state, wasm-engine-boot's renderer scenario) hold a fix.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type CDPSession, type Page, chromium } from "@playwright/test";
import {
  PERFORMANCE_BROWSER_ARGS,
  WEBGPU_BROWSER_ARGS,
} from "../packages/playtest/src/runner/browser.js";

import { absolutesVerdict, parseWebMetrics, readHostLoad } from "./engine-load-test/report.js";

interface IOptions {
  url: string;
  control?: string;
  seconds: number;
  warmupMs: number;
  calls: boolean;
  gpuCalls: boolean;
  json: boolean;
  memory: boolean;
  allowSoftware: boolean;
  /** Main-thread busy ms per presented frame, from the CPU profile (a frame cap hides it in p50). */
  cpuWork: boolean;
  /** Selectors clicked in order after load, before the warm-up: real input into the game's own UI. */
  clicks: string[];
  /** Directory that receives each page's raw Chrome .cpuprofile, named by the page's port. */
  saveProfile?: string;
  /** Busy-loop processes kept running for the whole page run: the stated CPU load. */
  load: number;
}

export function options(argv: readonly string[]): IOptions {
  const value = (name: string) => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? undefined : argv[at + 1];
  };
  const url = value("url");
  if (url === undefined)
    throw new Error(
      "usage: profile:wasm-page -- --url <url> [--control <url>] [--seconds 5] [--load 0] [--calls] [--memory] [--json]",
    );
  const seconds = Number(value("seconds") ?? 5);
  const warmupMs = Number(value("warmup-ms") ?? 12000);
  if (!(seconds > 0) || !(warmupMs >= 0))
    throw new Error("--seconds and --warmup-ms must be positive numbers");
  const load = Number(value("load") ?? 0);
  if (!(Number.isInteger(load) && load >= 0))
    throw new Error("--load must be a whole number of processes, 0 or more");
  const control = value("control");
  return {
    url,
    ...(control === undefined ? {} : { control }),
    seconds,
    warmupMs,
    calls: argv.includes("--calls"),
    gpuCalls: argv.includes("--gpu-calls"),
    json: argv.includes("--json"),
    memory: argv.includes("--memory"),
    allowSoftware: argv.includes("--allow-software"),
    cpuWork: argv.includes("--cpu-work"),
    ...(value("save-profile") === undefined
      ? {}
      : { saveProfile: value("save-profile") as string }),
    load,
    clicks: argv.flatMap((arg, i) => {
      if (arg !== "--click") return [];
      const selector = argv[i + 1];
      if (selector === undefined || selector.startsWith("--"))
        throw new Error("--click needs a selector");
      return [selector];
    }),
  };
}

export function startCpuLoad(processes: number): { pids: number[]; stop(): Promise<void> } {
  const children = Array.from({ length: processes }, () =>
    spawn(process.execPath, ["-e", "for(;;){}"], { stdio: "ignore" }),
  );
  return {
    pids: children.map((child) => child.pid as number),
    async stop() {
      await Promise.all(
        children.map(
          (child) =>
            new Promise<void>((resolve) => {
              if (child.exitCode !== null || child.signalCode !== null) return resolve();
              child.once("exit", () => resolve());
              child.kill("SIGKILL");
            }),
        ),
      );
    },
  };
}

interface ICpuProfile {
  nodes: IProfileNode[];
  samples: number[];
  timeDeltas: number[];
}

/** Busy main-thread ms per presented frame: every sample but `(idle)`, weighted by its time delta. */
export function cpuWork(profile: ICpuProfile, frames: number) {
  if (!(frames > 0))
    throw new Error("TN_PROFILE_CPU_WORK_NO_FRAMES: no frame was presented in the profile window");
  if (profile.timeDeltas.length !== profile.samples.length)
    throw new Error("TN_PROFILE_CPU_WORK_DELTAS: the profile's samples and time deltas differ");
  const idle = new Set(
    profile.nodes.filter((node) => node.callFrame.functionName === "(idle)").map((node) => node.id),
  );
  let busyUs = 0;
  let wallUs = 0;
  profile.samples.forEach((id, i) => {
    const delta = profile.timeDeltas[i] as number;
    wallUs += delta;
    if (!idle.has(id)) busyUs += delta;
  });
  // The share of the profile window the main thread was busy: the worker KPI (PRD-752).
  const busyPercent = wallUs > 0 ? (100 * busyUs) / wallUs : 0;
  return { busyMsPerFrame: busyUs / 1000 / frames, busyPercent, frames, wallMs: wallUs / 1000 };
}

/**
 * Frame-interval percentiles. A `hitch` is an interval over twice the run's own median, so it is relative:
 * a 446 fps run (p50 1.8 ms) counts 4 ms frames. `over16ms` and `over33ms` are absolute (a missed 60 Hz and
 * 30 Hz frame) and `maxMs` is the longest interval, so two arms are comparable on the same scale.
 */
export function frameStats(intervals: readonly number[]) {
  if (intervals.length === 0) throw new Error("TN_PROFILE_NO_FRAMES: no frame interval recorded");
  const d = [...intervals].sort((a, b) => a - b);
  const at = (q: number) => d[Math.min(d.length - 1, Math.floor(q * d.length))] as number;
  const p50 = at(0.5);
  const mean = d.reduce((a, b) => a + b, 0) / d.length;
  return {
    p50,
    p95: at(0.95),
    p99: at(0.99),
    hitches: d.filter((x) => x > 2 * p50).length,
    over16ms: d.filter((x) => x > 16.7).length,
    over33ms: d.filter((x) => x > 33.3).length,
    maxMs: d[d.length - 1] as number,
    fps: 1000 / mean,
  };
}

const CLICK_TIMEOUT_MS = 300_000;
const SOFTWARE = /swiftshader|llvmpipe|lavapipe|softwarerasterizer|software adapter|basic render/iu;

const FRAME_SAMPLES = 601;

/**
 * The thread the game draws on: the worker holding the platform source a worker host installs
 * (PRD-752), else the page. A worker page's own requestAnimationFrame times the page, not the game.
 */
async function gameThread(page: Page) {
  for (const worker of page.workers()) {
    if ((await worker.evaluate("typeof globalThis.__tnGamePlatform")) === "object")
      return { kind: "worker" as const, realm: worker };
  }
  return { kind: "page" as const, realm: page };
}

/** Presented-frame intervals in ms, one per requestAnimationFrame on the game's thread, for frameStats. */
async function frames(realm: Pick<Page, "evaluate">) {
  const intervals = await realm.evaluate(
    (count) =>
      new Promise<number[]>((resolve) => {
        const times: number[] = [];
        const step = (t: number) => {
          times.push(t);
          if (times.length < count) requestAnimationFrame(step);
          else resolve(times.slice(1).map((x, i) => x - (times[i] as number)));
        };
        requestAnimationFrame(step);
      }),
    FRAME_SAMPLES,
  );
  return frameStats(intervals);
}

interface IProfileNode {
  id: number;
  callFrame: { functionName: string; url: string };
  children?: number[];
}

/** The renderer main thread's CPU seconds so far: unlike the sampled wall clock, a busy host does not inflate it. */
async function threadSeconds(cdp: CDPSession): Promise<number> {
  const { metrics } = (await cdp.send("Performance.getMetrics")) as {
    metrics: { name: string; value: number }[];
  };
  const found = metrics?.find((metric) => metric.name === "ThreadTime");
  if (found === undefined) throw new Error("TN_PROFILE_THREAD_TIME: Chrome reported no ThreadTime");
  return found.value;
}

async function cpu(page: Page, seconds: number, withWork: boolean, saveAs?: string) {
  const framesBefore = withWork ? await presentedFrames(page) : 0;
  const cdp = await page.context().newCDPSession(page);
  if (withWork) await cdp.send("Performance.enable");
  const threadBefore = withWork ? await threadSeconds(cdp) : 0;
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");
  await page.waitForTimeout(seconds * 1000);
  const { profile } = (await cdp.send("Profiler.stop")) as { profile: ICpuProfile };
  if (saveAs) writeFileSync(saveAs, JSON.stringify(profile));
  const frames = withWork ? (await presentedFrames(page)) - framesBefore : 0;
  const work = withWork
    ? {
        ...cpuWork(profile, frames),
        threadMsPerFrame: (1000 * ((await threadSeconds(cdp)) - threadBefore)) / frames,
      }
    : undefined;
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map<number, number>();
  for (const node of profile.nodes)
    for (const child of node.children ?? []) parents.set(child, node.id);
  const counts = new Map<number, number>();
  for (const id of profile.samples) counts.set(id, (counts.get(id) ?? 0) + 1);
  const total = profile.samples.length;
  const name = (node: IProfileNode) => node.callFrame.functionName || "(anonymous)";
  const group = (node: IProfileNode) =>
    node.callFrame.url.endsWith(".wasm")
      ? "engine wasm"
      : node.callFrame.url
        ? "javascript"
        : name(node);
  const groups = new Map<string, number>();
  const inclusive = new Map<string, number>();
  const self = new Map<string, number>();
  for (const [id, n] of counts) {
    const node = byId.get(id) as IProfileNode;
    groups.set(group(node), (groups.get(group(node)) ?? 0) + n);
    const own = name(node)
      .replace(/std::__2::/gu, "")
      .slice(0, 140);
    self.set(own, (self.get(own) ?? 0) + n);
    const seen = new Set<string>();
    for (let at: number | undefined = id; at !== undefined; at = parents.get(at)) {
      const key = name(byId.get(at) as IProfileNode)
        .replace(/std::__2::/gu, "")
        .slice(0, 140);
      if (seen.has(key)) continue;
      seen.add(key);
      inclusive.set(key, (inclusive.get(key) ?? 0) + n);
    }
  }
  const share = (entries: Map<string, number>, limit: number) =>
    [...entries]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([key, n]) => ({ name: key, percent: Number(((100 * n) / total).toFixed(1)) }));
  return {
    ...(work ? { work } : {}),
    samples: total,
    groups: share(groups, 12),
    inclusive: share(inclusive, 30),
    self: share(self, 20),
  };
}

/** Counts every presented frame from page load; installed by --cpu-work (CPU_WORK_COUNTER). */
const CPU_WORK_COUNTER = `(() => { globalThis.__tnPresented = 0;
  const count = () => { globalThis.__tnPresented++; requestAnimationFrame(count); };
  requestAnimationFrame(count); })();`;

async function presentedFrames(page: Page) {
  return Number(await page.evaluate("globalThis.__tnPresented"));
}

async function calls(page: Page) {
  return page.evaluate(
    () =>
      new Promise<{ perFrame: number; top: { name: string; perFrame: number }[] }>(
        (resolve, reject) => {
          const g = globalThis as {
            __tnCallCounts?: Map<string, number>;
            __tnEngineTypes?: Map<number, string>;
          };
          if (g.__tnEngineTypes === undefined) {
            reject(
              new Error(
                "TN_PROFILE_NOT_WASM_ENGINE: the page did not load three-native's Wasm back end",
              ),
            );
            return;
          }
          g.__tnCallCounts = new Map();
          let frames = 0;
          const step = () => {
            if (++frames < 121) {
              requestAnimationFrame(step);
              return;
            }
            const counts = g.__tnCallCounts as Map<string, number>;
            g.__tnCallCounts = undefined;
            const named = [...counts].map(([key, n]) => {
              const [kind, member] = key.split(" ") as [string, string];
              const dot = member.indexOf(".");
              const type =
                g.__tnEngineTypes?.get(Number(member.slice(0, dot))) ?? member.slice(0, dot);
              return { name: `${kind} ${type}.${member.slice(dot + 1)}`, perFrame: n / 120 };
            });
            named.sort((a, b) => b.perFrame - a.perFrame);
            resolve({
              perFrame: named.reduce((sum, row) => sum + row.perFrame, 0),
              top: named.slice(0, 40),
            });
          };
          requestAnimationFrame(step);
        },
      ),
  );
}

// Wraps the WebGPU prototypes' methods so that, while `__tnGpuCounts` is a Map, each call counts as
// "<Interface>.<method>". Installed before the page's scripts; off, a wrapper costs one global read.
const GPU_CENSUS = `(() => {
  for (const name of ["GPUDevice", "GPUQueue", "GPUCommandEncoder", "GPURenderPassEncoder", "GPUComputePassEncoder", "GPURenderBundleEncoder", "GPUCanvasContext"]) {
    const proto = globalThis[name]?.prototype;
    if (!proto) continue;
    for (const key of Object.getOwnPropertyNames(proto)) {
      const d = Object.getOwnPropertyDescriptor(proto, key);
      if (!d || typeof d.value !== "function" || key === "constructor") continue;
      const original = d.value;
      Object.defineProperty(proto, key, { ...d, value: function (...args) {
        const counts = globalThis.__tnGpuCounts;
        if (counts) counts.set(name + "." + key, (counts.get(name + "." + key) ?? 0) + 1);
        return original.apply(this, args);
      } });
    }
  }
})();`;

/**
 * WebGPU API calls per presented frame. A game loop capped below the display rate (Midway's maxFps 60
 * under an uncapped requestAnimationFrame) renders on some callbacks only, so dividing by callbacks
 * would credit the arm with the faster callback rate. The divisor is `getCurrentTexture`, which both
 * back ends call once per frame they present; the window runs until 120 such frames passed.
 */
async function gpuCalls(page: Page) {
  return page.evaluate(
    () =>
      new Promise<{ name: string; perFrame: number }[]>((resolve) => {
        const g = globalThis as { __tnGpuCounts?: Map<string, number> };
        g.__tnGpuCounts = new Map();
        const step = () => {
          const counts = g.__tnGpuCounts as Map<string, number>;
          const presented = counts.get("GPUCanvasContext.getCurrentTexture") ?? 0;
          if (presented < 120) {
            requestAnimationFrame(step);
            return;
          }
          g.__tnGpuCounts = undefined;
          resolve(
            [...counts]
              .map(([name, n]) => ({ name, perFrame: n / presented }))
              .sort((a, b) => b.perFrame - a.perFrame),
          );
        };
        requestAnimationFrame(step);
      }),
  );
}

export async function measure(url: string, o: IOptions) {
  const browser = await chromium.launch({
    headless: false,
    args: [...WEBGPU_BROWSER_ARGS, ...PERFORMANCE_BROWSER_ARGS],
  });
  // Started after the launch, so a launch failure leaves no busy process behind.
  const cpuLoad = startCpuLoad(o.load);
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // tsx keeps function names with an `__name` helper that the evaluated page functions call.
    await page.addInitScript("globalThis.__name = (fn) => fn;");
    if (o.gpuCalls) await page.addInitScript(GPU_CENSUS);
    if (o.cpuWork) await page.addInitScript(CPU_WORK_COUNTER);
    const started = Date.now();
    await page.goto(url);
    const adapter = await page.evaluate(async () => {
      const gpu = (
        navigator as {
          gpu?: { requestAdapter(): Promise<{ info: Record<string, string> } | null> };
        }
      ).gpu;
      const found = await gpu?.requestAdapter();
      // GPUAdapterInfo's fields are prototype getters: Object.values would read none of them.
      const info = found?.info ?? {};
      return ["vendor", "architecture", "device", "description"]
        .map((key) => info[key] ?? "")
        .join(" ");
    });
    if (!o.allowSoftware && (adapter.trim() === "" || SOFTWARE.test(adapter)))
      throw new Error(
        `TN_PROFILE_SOFTWARE_ADAPTER: '${adapter}' is not a hardware WebGPU adapter (pass --allow-software to measure it anyway)`,
      );
    // Real input into the game's own UI: each click waits for its target to be actionable, so the
    // startup time below ends when the game is ready to be started, not when the HTML arrived.
    for (const selector of o.clicks) await page.click(selector, { timeout: CLICK_TIMEOUT_MS });
    const startupMs = Date.now() - started;
    await page.waitForTimeout(o.warmupMs);
    const reading = readHostLoad();
    const hostLoad = { ...reading, absolutes: absolutesVerdict(reading) };
    const thread = await gameThread(page);
    const frame = await frames(thread.realm);
    if (o.saveProfile !== undefined) mkdirSync(o.saveProfile, { recursive: true });
    const saveAs =
      o.saveProfile === undefined
        ? undefined
        : join(o.saveProfile, `${new URL(url).port}.cpuprofile`);
    const profile = await cpu(page, o.seconds, o.cpuWork, saveAs);
    const census = o.calls ? await calls(page) : undefined;
    const gpu = o.gpuCalls ? await gpuCalls(page) : undefined;
    const memory = o.memory
      ? await page.evaluate(() => ({
          jsHeapUsedBytes: (performance as { memory?: { usedJSHeapSize?: number } }).memory
            ?.usedJSHeapSize,
          wasmMemoryBytes: (
            globalThis as { __tnWasmMemoryBytes?: () => number }
          ).__tnWasmMemoryBytes?.(),
        }))
      : undefined;
    if (memory) {
      for (const field of ["wasmMemoryBytes", "jsHeapUsedBytes"] as const) {
        const value = memory[field];
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
          throw new Error(`TN_PROFILE_MEMORY_MISSING: ${field} is unavailable`);
      }
    }
    if (errors.length > 0) throw new Error(`TN_PROFILE_PAGE_ERROR: ${errors[0]}`);
    return {
      url,
      hostLoad,
      cpuLoad: { processes: o.load },
      ...(memory ? { memory: parseWebMetrics({ memory }).memory } : {}),
      adapter,
      startupMs,
      gameThread: thread.kind,
      frame,
      profile,
      ...(census ? { calls: census } : {}),
      ...(gpu ? { gpu } : {}),
    };
  } finally {
    await cpuLoad.stop();
    await browser.close();
  }
}

function print(label: string, r: Awaited<ReturnType<typeof measure>>) {
  console.log(`\n== ${label}: ${r.url}\nadapter ${r.adapter}`);
  console.log(
    `host load ${r.hostLoad.load1} on ${r.hostLoad.cores} cores, absolutes ${r.hostLoad.absolutes}`,
  );
  console.log(`cpu load ${r.cpuLoad.processes} busy processes`);
  if (r.memory)
    console.log(
      `memory: Wasm ${r.memory.wasmMemoryBytes} bytes, JS heap used ${r.memory.jsHeapUsedBytes} bytes`,
    );
  console.log(
    `startup ${(r.startupMs / 1000).toFixed(1)} s; frame p50 ${r.frame.p50.toFixed(2)} ms, p95 ${r.frame.p95.toFixed(2)} ms, p99 ${r.frame.p99.toFixed(2)} ms, ${r.frame.hitches} hitches (over 2x own median), ${r.frame.over16ms} over 16.7 ms, ${r.frame.over33ms} over 33.3 ms, max ${r.frame.maxMs.toFixed(1)} ms, ${r.frame.fps.toFixed(0)} fps`,
  );
  if (r.profile.work)
    console.log(
      `cpu work ${r.profile.work.busyMsPerFrame.toFixed(2)} ms per frame, main thread ${r.profile.work.busyPercent.toFixed(0)}% busy (thread CPU ${r.profile.work.threadMsPerFrame.toFixed(2)} ms) over ${r.profile.work.frames} frames`,
    );
  console.log(
    `cpu (${r.profile.samples} samples): ${r.profile.groups.map((g) => `${g.name} ${g.percent}%`).join(", ")}`,
  );
  for (const row of r.profile.inclusive)
    console.log(`  ${String(row.percent).padStart(5)}%  ${row.name}`);
  console.log("self time:");
  for (const row of r.profile.self)
    console.log(`  ${String(row.percent).padStart(5)}%  ${row.name}`);
  if (r.gpu) {
    console.log(
      `webgpu calls per frame: ${r.gpu.reduce((sum, row) => sum + row.perFrame, 0).toFixed(1)}`,
    );
    for (const row of r.gpu) console.log(`  ${row.perFrame.toFixed(1).padStart(8)}  ${row.name}`);
  }
  if (r.calls) {
    console.log(`engine calls per frame: ${r.calls.perFrame.toFixed(1)}`);
    for (const row of r.calls.top)
      console.log(`  ${row.perFrame.toFixed(1).padStart(8)}  ${row.name}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const o = options(process.argv.slice(2));
  const subject = await measure(o.url, o);
  const control =
    o.control === undefined
      ? undefined
      : await measure(o.control, { ...o, calls: false, memory: false });
  if (o.json) console.log(JSON.stringify({ subject, ...(control ? { control } : {}) }, null, 2));
  else {
    print("subject", subject);
    if (control) {
      print("control", control);
      const ratio = subject.frame.p50 / control.frame.p50;
      console.log(
        `\nsubject/control frame p50: ${ratio.toFixed(2)}x (${ratio > 1 ? "subject slower" : "subject faster"})`,
      );
      const [a, b] = [subject.profile.work, control.profile.work];
      if (a && b)
        console.log(
          `subject/control cpu work per frame: ${(a.busyMsPerFrame / b.busyMsPerFrame).toFixed(2)}x (${(b.busyMsPerFrame / a.busyMsPerFrame).toFixed(2)}x less CPU in subject if above 1)`,
        );
    }
  }
}
