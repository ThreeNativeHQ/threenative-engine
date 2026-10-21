/**
 * GPU time of the GI passes at each quality tier (PRD-644 AC-2), from the page's own `GIBudget` windows.
 *
 *   sh <slots>/gpu-slot.sh --exclusive pnpm exec tsx scripts/unreal-look/gi-tier-cost.ts \
 *     --scene gi:cornell [--tiers low,medium,high] [--shadow-tiers low,medium,high] [--windows 3] [--reuse] \
 *     [--out cost.json]
 *
 * Opens the calibration scene at L7 on the owned engine, headed on WebGPU, at 1920 x 1080 with the adapter
 * checked, once per tier. The first window of 120 frames is the warm-up and is dropped; the mean of the next
 * `--windows` windows is the tier's cost. Run it under the exclusive GPU slot: other GPU work moves the
 * numbers. The report prints the passes that resolved, so a wrong stage name reads as an empty list.
 *
 * The GI tiers draw their shadows at `high`, as the Unreal GI cells do. `--shadow-tiers` instead draws the GI at
 * `medium` (no screen-space gather) and the shadows at each listed tier, so `frameMs` is the whole frame's GPU
 * time at that shadow tier.
 */
import { spawn } from "node:child_process";
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
    insideBudget: first === undefined ? null : giMs <= first.budgetMs,
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
): Promise<object> {
  const { adapter, errors, page } = await openTier(
    browser,
    `${origin}?tnGi=${name}&layer=L7&tier=${tier}&shadowTier=${shadowTier}`,
    pose,
  );
  try {
    const method = (await page.evaluate("window.__tnRef.finalGatherMethod")) as string;
    // No GI pass runs at `none`, so the tier costs no GI time by construction.
    if (method === "none")
      return { adapter, budgetMs: 0, giMs: 0, insideBudget: true, method, windows: 0 };
    return summarize(adapter, await collectWindows(page, errors, count));
  } finally {
    await page.close();
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
  const report: Record<string, object> = {};
  try {
    const origin = `http://127.0.0.1:${port}/`;
    await waitForServer(origin, server);
    const browser = await chromium.launch({ args: [...WEBGPU_BROWSER_ARGS], headless: false });
    try {
      const count = Number(flag(args, "--windows") ?? 3);
      const shadowTiers = flag(args, "--shadow-tiers")?.split(",") ?? [];
      for (const tier of shadowTiers.length > 0 ? [] : tiers) {
        report[tier] = await measureTier(browser, origin, name, tier, pose, count);
        console.info(`TN_GI_TIER_COST ${tier} ${JSON.stringify(report[tier])}`);
      }
      for (const shadowTier of shadowTiers) {
        const key = `shadow-${shadowTier}`;
        report[key] = await measureTier(browser, origin, name, "medium", pose, count, shadowTier);
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
