/**
 * PRD-307 Phase 1 — what does `scene.environment` cost per frame, and which half can baking win?
 *
 * Drives `examples/prd307-environment-cost` through five arms in one browser and reports `gpuMs`
 * per arm. The question it answers is structural, not a benchmark score:
 *
 * - `static` vs `dirty/1` — is a set-once environment silently re-prefiltered every frame? If the
 *   two are equal, it is, and baking the prefilter wins frame time. If `dirty/1` is higher, the
 *   prefilter is a one-time load cost and baking wins **launch** time only.
 * - `static` vs `none` — the per-fragment sampling cost, which baking cannot touch at all.
 *
 * ## The negative control is the point
 *
 * `none` removes strictly more work than `static`, so `gpuMs(none) <= gpuMs(static)` must hold. When
 * it does not, the lane is reading noise, and the inversion is a **lower bound** on its noise floor,
 * not the complete floor. The first run of this probe reported `none` 0.37 ms *above* `static`;
 * that is useful noise evidence, but an independently observed `resolutionMs` is still required
 * before any delta can be resolved. That check is built in here rather than left to whoever reads
 * the table, because the reader who most needs it is the one who already believes the result.
 *
 * Reported differences smaller than the measured floor print as `below noise floor`, never as a
 * number. An arm that produced no steady window throws: an unmeasured arm is a failure, never an
 * empty pass.
 *
 * ## Running it
 *
 * ```sh
 * pnpm tsx scripts/env-cost-probe.ts [port] [secondsPerArm] [resolutionMs]
 * ```
 *
 * `resolutionMs` is an independently observed positive meter resolution/noise value. Omitting it
 * makes the report fail closed after collection; the negative control cannot manufacture one.
 *
 * Needs a real GPU adapter — the run prints `adapter:` and a SwiftShader fallback makes every
 * number meaningless. Vsync is disabled so the GPU holds sustained clocks; even so this lane is
 * only accurate to its own printed floor, and the device lane owns any absolute verdict.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { chromium } from "@playwright/test";
import {
  type IArmSample,
  type IFrameWindow,
  assertNoArmFailures,
  steadyWindows,
  summarise,
} from "./env-cost-report.js";
import { waitForServer } from "./lib/dev-server.js";
import { stopVisualServer } from "./visual-gate.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

const BROWSER_ARGS = [
  "--enable-unsafe-webgpu",
  "--enable-features=Vulkan",
  "--use-angle=vulkan",
  "--use-vulkan=native",
  "--disable-vulkan-fallback-to-gl-for-testing",
  // Sustained clocks: at 60 fps vsync the GPU idles ~85% of the frame and downclocks, which
  // widened every arm's spread past the differences being measured.
  "--disable-gpu-vsync",
  "--disable-frame-rate-limit",
];

const RUNS = [
  { label: "static", query: "arm=static" },
  { label: "none", query: "arm=none" },
  { label: "dirty/8", query: "arm=dirty&every=8" },
  { label: "dirty/2", query: "arm=dirty&every=2" },
  { label: "dirty/1", query: "arm=dirty&every=1" },
] as const;

const port = Number(process.argv[2] ?? 5491);
const seconds = Number(process.argv[3] ?? 60);
const resolutionMs = process.argv[4] === undefined ? undefined : Number(process.argv[4]);
if (!Number.isInteger(port) || port < 1) throw new Error(`Unusable port ${process.argv[2]}.`);
if (!Number.isFinite(seconds) || seconds <= 0)
  throw new Error(`Unusable seconds ${process.argv[3]}.`);
if (resolutionMs !== undefined && (!Number.isFinite(resolutionMs) || resolutionMs <= 0))
  throw new Error(`Unusable resolution ${process.argv[4]}.`);

const dir = path.join(REPO_ROOT, "examples", "prd307-environment-cost");
const server = spawn(
  "pnpm",
  ["dev", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  {
    cwd: dir,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  },
);

const arms: IArmSample[] = [];
const fpsByArm = new Map<string, number>();
try {
  await waitForServer({
    child: server,
    label: "Env-cost server",
    timeoutMs: 120_000,
    url: `http://127.0.0.1:${port}/`,
  });
  const browser = await chromium.launch({ args: BROWSER_ARGS, headless: false });
  try {
    for (const [index, run] of RUNS.entries()) {
      const page = await browser.newPage({ viewport: { height: 1080, width: 1920 } });
      const lines: string[] = [];
      const failures: string[] = [];
      page.on("console", (message) => lines.push(message.text()));
      page.on("pageerror", (error) => failures.push(`PAGEERROR ${error.message}`));
      page.on("crash", () => failures.push("PAGECRASH page crashed"));

      try {
        await page.goto(`http://127.0.0.1:${port}/?${run.query}`, {
          waitUntil: "domcontentloaded",
        });
        await page.waitForSelector("canvas", { timeout: 60_000 });
        if (index === 0) {
          const adapter = await page.evaluate(async () => {
            const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
            const handle = (await gpu?.requestAdapter()) as {
              info?: Record<string, string>;
            } | null;
            const info = handle?.info;
            return info === undefined
              ? "NO ADAPTER"
              : `vendor=${info.vendor} arch=${info.architecture}`;
          });
          console.log(`adapter: ${adapter}`);
          if (adapter.includes("NO ADAPTER") || /swiftshader|llvmpipe/i.test(adapter)) {
            throw new Error(`Refusing to measure on ${adapter} — this lane needs a real adapter.`);
          }
        }
        await page.waitForTimeout(seconds * 1000);
      } catch (error) {
        failures.push(`RUN ${((error as Error).message ?? String(error)).split("\n")[0]}`);
      }

      try {
        await page.close();
      } catch (error) {
        failures.push(`PAGE_CLOSE ${((error as Error).message ?? String(error)).split("\n")[0]}`);
      }

      // Keep the meter failure separate from ordinary console lines. Every recorded failure is
      // checked below even when the arm did collect valid steady windows.
      let windows: readonly IFrameWindow[] | undefined;
      try {
        windows = steadyWindows(lines);
      } catch (error) {
        failures.push(`FRAME_BUDGET ${(error as Error).message}`);
      }
      assertNoArmFailures(run.label, failures);
      if (windows === undefined) throw new Error(`Arm ${run.label} has no frame-budget windows.`);

      arms.push({
        gpuMs: windows.map((window) => window.gpuMs),
        label: run.label,
        resolutionMs,
      });
      fpsByArm.set(run.label, windows.reduce((total, w) => total + w.fps, 0) / windows.length);
    }
  } finally {
    await browser.close();
  }
} finally {
  await stopVisualServer(server);
}

for (const arm of arms) {
  const sorted = [...arm.gpuMs].sort((a, b) => a - b);
  const at = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? Number.NaN;
  console.log(
    `ARM ${arm.label.padEnd(8)} windows=${String(arm.gpuMs.length).padStart(2)}` +
      ` gpuMs median=${at(0.5).toFixed(2)} p10-p90=${at(0.1).toFixed(2)}-${at(0.9).toFixed(2)}` +
      ` fps=${(fpsByArm.get(arm.label) ?? Number.NaN).toFixed(1)}`,
  );
}

const summary = summarise(arms);
console.log(
  `\nnoise floor: ${summary.floor.toFixed(2)} ms — negative control ${summary.controlHeld ? "held (none <= static)" : "INVERTED (none read above static)"}`,
);
const show = (value: number | undefined): string =>
  value === undefined ? "below noise floor" : `${value >= 0 ? "+" : ""}${value.toFixed(2)} ms`;
console.log(
  `  dirty/1 - static       ${show(summary.prefilterPerFrame).padEnd(18)} cost of re-prefiltering every frame`,
);
console.log(
  `  static  - none         ${show(summary.samplingPerFrame).padEnd(18)} per-fragment sampling — baking CANNOT win this`,
);
