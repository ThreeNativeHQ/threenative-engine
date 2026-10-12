/**
 * `pnpm profile:wasm-page -- --url <url> [--control <url>] [--seconds 5] [--calls] [--json]`
 *
 * Profiles a running game page the way a Wasm-engine performance question needs: frame time from
 * requestAnimationFrame, a Chrome CPU profile grouped into engine Wasm, JavaScript and WebGPU calls
 * (with the top inclusive functions), and with `--calls` the JS->Wasm engine calls per frame by name
 * (three-native's opt-in census, `__tnCallCounts`), and with `--gpu-calls` the WebGPU API calls per
 * frame on both pages (render passes, draws, bind groups, buffer writes). `--control` runs a second page, the same game on
 * three.js, through the same measurement, so the verdict is a ratio on one lane, never an absolute.
 *
 * It refuses a software WebGPU adapter (`--allow-software` overrides) and needs a display: run it as
 * `sh scripts/xvfb.sh pnpm profile:wasm-page -- ...`. Wasm function names need a module linked with
 * `--profiling-funcs`; without it the Wasm rows are numbered. Diagnose with it; the steady-state
 * counter gates (render_database_test steady_state, wasm-engine-boot's renderer scenario) hold a fix.
 */
import { type Page, chromium } from "@playwright/test";
import {
  PERFORMANCE_BROWSER_ARGS,
  WEBGPU_BROWSER_ARGS,
} from "../packages/playtest/src/runner/browser.js";

interface IOptions {
  url: string;
  control?: string;
  seconds: number;
  warmupMs: number;
  calls: boolean;
  gpuCalls: boolean;
  json: boolean;
  allowSoftware: boolean;
}

function options(argv: readonly string[]): IOptions {
  const value = (name: string) => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? undefined : argv[at + 1];
  };
  const url = value("url");
  if (url === undefined)
    throw new Error(
      "usage: profile:wasm-page -- --url <url> [--control <url>] [--seconds 5] [--calls] [--json]",
    );
  const seconds = Number(value("seconds") ?? 5);
  const warmupMs = Number(value("warmup-ms") ?? 12000);
  if (!(seconds > 0) || !(warmupMs >= 0))
    throw new Error("--seconds and --warmup-ms must be positive numbers");
  const control = value("control");
  return {
    url,
    ...(control === undefined ? {} : { control }),
    seconds,
    warmupMs,
    calls: argv.includes("--calls"),
    gpuCalls: argv.includes("--gpu-calls"),
    json: argv.includes("--json"),
    allowSoftware: argv.includes("--allow-software"),
  };
}

const SOFTWARE = /swiftshader|llvmpipe|lavapipe|softwarerasterizer|software adapter|basic render/iu;

async function frames(page: Page) {
  return page.evaluate(
    () =>
      new Promise<{ p50: number; p95: number; fps: number }>((resolve) => {
        const times: number[] = [];
        const step = (t: number) => {
          times.push(t);
          if (times.length < 241) requestAnimationFrame(step);
          else {
            const d = times
              .slice(1)
              .map((x, i) => x - (times[i] as number))
              .sort((a, b) => a - b);
            const mean = d.reduce((a, b) => a + b, 0) / d.length;
            resolve({ p50: d[120] as number, p95: d[228] as number, fps: 1000 / mean });
          }
        };
        requestAnimationFrame(step);
      }),
  );
}

interface IProfileNode {
  id: number;
  callFrame: { functionName: string; url: string };
  children?: number[];
}

async function cpu(page: Page, seconds: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");
  await page.waitForTimeout(seconds * 1000);
  const { profile } = (await cdp.send("Profiler.stop")) as {
    profile: { nodes: IProfileNode[]; samples: number[] };
  };
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
  for (const [id, n] of counts) {
    const node = byId.get(id) as IProfileNode;
    groups.set(group(node), (groups.get(group(node)) ?? 0) + n);
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
  return { samples: total, groups: share(groups, 12), inclusive: share(inclusive, 30) };
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
  for (const name of ["GPUDevice", "GPUQueue", "GPUCommandEncoder", "GPURenderPassEncoder", "GPUComputePassEncoder", "GPURenderBundleEncoder"]) {
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

async function gpuCalls(page: Page) {
  return page.evaluate(
    () =>
      new Promise<{ name: string; perFrame: number }[]>((resolve) => {
        const g = globalThis as { __tnGpuCounts?: Map<string, number> };
        g.__tnGpuCounts = new Map();
        let frames = 0;
        const step = () => {
          if (++frames < 121) {
            requestAnimationFrame(step);
            return;
          }
          const counts = g.__tnGpuCounts as Map<string, number>;
          g.__tnGpuCounts = undefined;
          resolve(
            [...counts]
              .map(([name, n]) => ({ name, perFrame: n / 120 }))
              .sort((a, b) => b.perFrame - a.perFrame)
              .slice(0, 25),
          );
        };
        requestAnimationFrame(step);
      }),
  );
}

async function measure(url: string, o: IOptions) {
  const browser = await chromium.launch({
    headless: false,
    args: [...WEBGPU_BROWSER_ARGS, ...PERFORMANCE_BROWSER_ARGS],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // tsx keeps function names with an `__name` helper that the evaluated page functions call.
    await page.addInitScript("globalThis.__name = (fn) => fn;");
    if (o.gpuCalls) await page.addInitScript(GPU_CENSUS);
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
    await page.waitForTimeout(o.warmupMs);
    const frame = await frames(page);
    const profile = await cpu(page, o.seconds);
    const census = o.calls ? await calls(page) : undefined;
    const gpu = o.gpuCalls ? await gpuCalls(page) : undefined;
    if (errors.length > 0) throw new Error(`TN_PROFILE_PAGE_ERROR: ${errors[0]}`);
    return {
      url,
      adapter,
      frame,
      profile,
      ...(census ? { calls: census } : {}),
      ...(gpu ? { gpu } : {}),
    };
  } finally {
    await browser.close();
  }
}

function print(label: string, r: Awaited<ReturnType<typeof measure>>) {
  console.log(`\n== ${label}: ${r.url}\nadapter ${r.adapter}`);
  console.log(
    `frame p50 ${r.frame.p50.toFixed(2)} ms, p95 ${r.frame.p95.toFixed(2)} ms, ${r.frame.fps.toFixed(0)} fps`,
  );
  console.log(
    `cpu (${r.profile.samples} samples): ${r.profile.groups.map((g) => `${g.name} ${g.percent}%`).join(", ")}`,
  );
  for (const row of r.profile.inclusive)
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

const o = options(process.argv.slice(2));
const subject = await measure(o.url, o);
const control =
  o.control === undefined ? undefined : await measure(o.control, { ...o, calls: false });
if (o.json) console.log(JSON.stringify({ subject, ...(control ? { control } : {}) }, null, 2));
else {
  print("subject", subject);
  if (control) {
    print("control", control);
    const ratio = subject.frame.p50 / control.frame.p50;
    console.log(
      `\nsubject/control frame p50: ${ratio.toFixed(2)}x (${ratio > 1 ? "subject slower" : "subject faster"})`,
    );
  }
}
