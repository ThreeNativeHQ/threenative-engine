/**
 * GPU time of the GI passes at each quality tier (PRD-644 AC-2), from the page's own `GIBudget` windows.
 *
 *   sh <slots>/gpu-slot.sh --exclusive pnpm exec tsx scripts/unreal-look/gi-tier-cost.ts \
 *     --scene gi:cornell [--tiers low,medium,high] [--shadow-tiers low,medium,high] [--windows 3] [--reuse] \
 *     [--url-extra "&probes=1"] [--out cost.json]
 *
 * Opens the calibration scene at L7 on the owned engine, headed on WebGPU, at 1920 x 1080 with the adapter
 * checked, once per tier. The first window of 120 frames is the warm-up and is dropped; the mean of the next
 * `--windows` windows is the tier's cost. Run it under the exclusive GPU slot: other GPU work moves the
 * numbers. The report prints the passes that resolved, so a wrong stage name reads as an empty list.
 *
 * The owned engine times the whole frame only: it has no per-pass timestamp pool, so `GIBudget` resolves no stage
 * there (`stagesSeen` is empty). `frame` is then the cost: the whole frame's GPU time per distinct sample after 120
 * rendered frames of warm-up, and `giDeltaMs` is a tier's frame mean minus the `low` tier's, which draws no GI.
 *
 * The GI tiers draw their shadows at `high`, as the Unreal GI cells do. `--shadow-tiers` instead draws the GI at
 * `medium` (no screen-space gather) and the shadows at each listed tier, so `frameMs` is the whole frame's GPU
 * time at that shadow tier.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type Browser, type Page, chromium } from "@playwright/test";
import { WEBGPU_BROWSER_ARGS } from "../../packages/playtest/src/runner/browser.js";
import { assertVisualPortAvailable, stopVisualServer } from "../visual-gate.js";
import { patchGi } from "./capture-gi-threenative.js";
import { HIDE_UI, freePort, scaffold, waitForServer } from "./capture-threenative.js";
import { familyOf, readScene, registry, sceneNames } from "./gi.js";

interface IWindow {
  readonly window: number;
  readonly windowMs: number | undefined;
  readonly frameMs: number | undefined;
  readonly budgetMs: number;
  readonly stagesSeen: readonly string[];
  readonly passes: readonly string[];
  readonly finalGatherMethod: string;
}

const flag = (args: readonly string[], name: string): string | undefined => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
};

const mean = (values: readonly number[]): number =>
  values.length === 0 ? Number.NaN : values.reduce((a, b) => a + b, 0) / values.length;

/**
 * The whole frame's resolved GPU milliseconds, one per distinct sample, keyed by the engine's frame id. The page
 * draws the pose in a tight loop beside its own: the host draws nothing while two frames are on the GPU, so the
 * GPU stays busy. A GPU that idles between frames drops to a low clock, and every pass then reads 2 to 5 times
 * dearer (a `low` frame read 14.9 ms at P5 and 3.2 ms boosted). The warm-up is 240 drawn frames and 4 s.
 */
const FRAME_SAMPLER = `(async (want) => {
  const w = window.__tnRef;
  const r = w.renderer;
  const seen = new Map();
  const note = () => {
    const ids = r.backend && r.backend.getTimestampFrames ? r.backend.getTimestampFrames("render") : undefined;
    const id = ids ? ids[ids.length - 1] : undefined;
    const ms = r.info && r.info.render ? r.info.render.timestamp : undefined;
    if (Number.isInteger(id) && typeof ms === "number" && ms > 0 && !seen.has(id)) seen.set(id, ms);
  };
  const tick = () => new Promise((done) => setTimeout(done, 0));
  const t0 = performance.now();
  const f0 = r.info.frame;
  while ((r.info.frame - f0 < 240 || performance.now() - t0 < 4000) && performance.now() - t0 < 60000) {
    r.render(w.world, w.camera);
    await tick();
  }
  while (seen.size < want && performance.now() - t0 < 180000) {
    r.render(w.world, w.camera);
    note();
    await tick();
  }
  return {
    ms: [...seen.values()],
    pixelRatio: r.getPixelRatio ? r.getPixelRatio() : null,
    size: [r.domElement.width, r.domElement.height],
  };
})`;

/** The GPU clock state right after a saturated run, so a reader can see the sample was taken boosted. */
function gpuState(): string {
  try {
    return execFileSync(
      "nvidia-smi",
      [
        "--query-gpu=pstate,clocks.sm,clocks.mem,utilization.gpu,power.draw,temperature.gpu",
        "--format=csv,noheader",
      ],
      { encoding: "utf8", timeout: 10_000 },
    ).trim();
  } catch {
    return "unavailable";
  }
}

function frameStats(ms: readonly number[]): object {
  const sorted = [...ms].sort((a, b) => a - b);
  const at = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN;
  return {
    mean: Number(mean(ms).toFixed(3)),
    median: Number(at(0.5).toFixed(3)),
    p95: Number(at(0.95).toFixed(3)),
    samples: ms.length,
  };
}

/** Opens the scene at a tier, checks the adapter is a real GPU and returns the page ready to watch. */
async function openTier(
  browser: Browser,
  url: string,
  pose: unknown,
): Promise<{ adapter: Record<string, string>; errors: string[]; page: Page }> {
  const page = await browser.newPage({
    deviceScaleFactor: 1,
    viewport: { height: 1080, width: 1920 },
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.addStyleTag({ content: HIDE_UI });
  await page.waitForSelector('[data-threenative-startup="ready"]', { timeout: 300_000 });
  await page.waitForFunction(() => "__tnRef" in window, undefined, { timeout: 240_000 });
  const adapter = (await page.evaluate(
    "navigator.gpu?.requestAdapter().then((a) => a && { vendor: a.info.vendor, architecture: a.info.architecture, description: a.info.description })",
  )) as Record<string, string> | null;
  if (!adapter || /swiftshader|llvmpipe/i.test(JSON.stringify(adapter)))
    throw new Error(`TN_UNREAL_LOOK_SOFTWARE_ADAPTER: ${JSON.stringify(adapter)}`);
  await page.evaluate(`window.__tnRef.pose(${JSON.stringify(pose)})`);
  return { adapter, errors, page };
}

/** Collects the windows a page's `GIBudget` closes until `count` measured ones follow the warm-up. */
async function collectWindows(
  page: Page,
  errors: readonly string[],
  count: number,
): Promise<IWindow[]> {
  const windows = new Map<number, IWindow>();
  const deadline = Date.now() + 240_000;
  while (windows.size < count + 1 && Date.now() < deadline) {
    const last = (await page.evaluate("window.__tnRef.giBudget?.() ?? null")) as IWindow | null;
    if (last?.window !== undefined) windows.set(last.window, last);
    if (errors.length > 0) throw new Error(`TN_UNREAL_LOOK_PAGE_ERROR: ${errors.join(" | ")}`);
    await page.waitForTimeout(250);
  }
  return [...windows.values()].filter((w) => w.window > 1);
}

function summarize(adapter: Record<string, string>, kept: readonly IWindow[]): object {
  const resolved = kept.filter((w) => w.windowMs !== undefined);
  const giMs = mean(resolved.map((w) => w.windowMs ?? 0));
  const first = kept[0];
  return {
    adapter,
    budgetMs: first?.budgetMs ?? null,
    frameMs: Number(mean(resolved.map((w) => w.frameMs ?? 0)).toFixed(3)),
    giMs: Number(giMs.toFixed(3)),
    insideBudget: first === undefined || resolved.length === 0 ? null : giMs <= first.budgetMs,
    method: first?.finalGatherMethod ?? null,
    passes: first?.passes ?? [],
    stagesSeen: first?.stagesSeen ?? [],
    windows: kept.length,
  };
}

async function measureTier(
  browser: Browser,
  origin: string,
  name: string,
  tier: string,
  pose: unknown,
  count: number,
  shadowTier = "high",
  frames = 600,
  urlExtra = "",
): Promise<Record<string, unknown>> {
  const { adapter, errors, page } = await openTier(
    browser,
    `${origin}?tnGi=${name}&layer=L7&tier=${tier}&shadowTier=${shadowTier}${urlExtra}`,
    pose,
  );
  try {
    const method = (await page.evaluate("window.__tnRef.finalGatherMethod")) as string;
    const sampled = (await page.evaluate(`${FRAME_SAMPLER}(${frames})`)) as {
      ms: number[];
      pixelRatio: number | null;
      size: number[];
    };
    const frame = {
      ...frameStats(sampled.ms),
      gpu: gpuState(),
      pixelRatio: sampled.pixelRatio,
      size: sampled.size,
    };
    // No GI pass runs at `none`, so the tier costs no GI time by construction.
    if (method === "none")
      return { adapter, budgetMs: 0, frame, giMs: 0, insideBudget: true, method, windows: 0 };
    return { ...summarize(adapter, await collectWindows(page, errors, count)), frame };
  } finally {
    await page.close();
  }
}

/** Every tier's frame mean minus the `low` tier's, which draws no GI: what the tier's GI costs when no pass is named. */
function addDeltas(report: Record<string, Record<string, unknown>>): void {
  const base = (report.low?.frame as { mean: number } | undefined)?.mean;
  for (const [tier, entry] of Object.entries(report)) {
    const frame = entry.frame as { mean: number } | undefined;
    if (base !== undefined && frame !== undefined && tier !== "low")
      entry.giDeltaMs = Number((frame.mean - base).toFixed(3));
    console.info(`TN_GI_TIER_COST ${tier} ${JSON.stringify(entry)}`);
  }
}

export async function main(args: readonly string[]): Promise<number> {
  const value = flag(args, "--scene") ?? "gi:cornell";
  const [name = ""] = sceneNames(
    value,
    registry(familyOf(value)).scenes.map((s) => s.name),
  );
  const tiers = (flag(args, "--tiers") ?? "low,medium,high").split(",");
  const work =
    process.env.TN_UNREAL_LOOK_WORK ?? path.join(os.homedir(), ".cache/threenative/unreal-look");
  const target = await scaffold(work, args.includes("--reuse"), false);
  await patchGi(target, [name]);
  const [pose] = readScene(name).scene.poses;
  if (pose === undefined) throw new Error(`TN_UNREAL_LOOK_BAD_INPUT: ${name} has no pose`);
  const port = await freePort();
  await assertVisualPortAvailable(port);
  const server = spawn(
    "pnpm",
    ["dev", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd: target,
      detached: process.platform !== "win32",
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  const report: Record<string, Record<string, unknown>> = {};
  try {
    const origin = `http://127.0.0.1:${port}/`;
    await waitForServer(origin, server);
    const browser = await chromium.launch({ args: [...WEBGPU_BROWSER_ARGS], headless: false });
    try {
      const count = Number(flag(args, "--windows") ?? 3);
      const urlExtra = flag(args, "--url-extra") ?? "";
      const shadowTiers = flag(args, "--shadow-tiers")?.split(",") ?? [];
      for (const tier of shadowTiers.length > 0 ? [] : tiers) {
        report[tier] = await measureTier(
          browser,
          origin,
          name,
          tier,
          pose,
          count,
          "high",
          600,
          urlExtra,
        );
      }
      addDeltas(report);
      for (const shadowTier of shadowTiers) {
        const key = `shadow-${shadowTier}`;
        report[key] = await measureTier(
          browser,
          origin,
          name,
          "medium",
          pose,
          count,
          shadowTier,
          600,
          urlExtra,
        );
        console.info(`TN_GI_TIER_COST ${key} ${JSON.stringify(report[key])}`);
      }
    } finally {
      await browser.close();
    }
  } finally {
    await stopVisualServer(server);
  }
  const out = flag(args, "--out");
  if (out !== undefined) {
    await mkdir(path.dirname(path.resolve(out)), { recursive: true });
    await writeFile(path.resolve(out), `${JSON.stringify({ scene: name, ...report }, null, 2)}\n`);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
