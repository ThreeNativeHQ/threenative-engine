/**
 * GPU time of the GI passes at each quality tier (PRD-644 AC-2), from the page's own `GIBudget` windows.
 *
 *   sh <slots>/gpu-slot.sh --exclusive pnpm exec tsx scripts/unreal-look/gi-tier-cost.ts \
 *     --scene gi:cornell [--tiers low,medium,high] [--shadow-tiers low,medium,high] [--windows 3] [--reuse] \
 *     [--url-extra "&probes=1"] [--auto | --interleave [--rounds 5] [--burst 100] [--arms arms.json]] [--out cost.json]
 *
 * Opens the calibration scene at L7 on the owned engine, headed on WebGPU, at 1920 x 1080 with the adapter
 * checked, once per tier. The browser paints on a private Xvfb (`launchWebgpuBrowser`): set
 * `TN_XVFB_SCREEN=1920x1080x24` for this viewport. The first window of 120 frames is the warm-up and is dropped; the mean of the next
 * `--windows` windows is the tier's cost. Run it under the exclusive GPU slot: other GPU work moves the
 * numbers. The report prints the passes that resolved, so a wrong stage name reads as an empty list.
 *
 * The owned engine times its passes natively and reports the whole frame and its labelled stages per sample
 * (`info.render.timestamp`, `info.engine.gpuStages`, three-native `gpu-stages.ts`), so `GIBudget` resolves the
 * stage `SSGI` (`stagesSeen`). `frame` is the whole frame's GPU time per distinct sample after 120 rendered frames of
 * warm-up with its `stages`, and `giDeltaMs` is a tier's frame mean minus the `low` tier's, which draws no GI: the
 * delta and `frame.stages.SSGI` check each other.
 *
 * `--interleave` times the final gather methods in one page instead: it starts at `high`, then alternates `none`,
 * `irradianceField` and `screenProbeGather` in short bursts (`window.__tnRef.setGatherMethod`), `--rounds` times, with
 * the order rotated each round. The GPU clock drifts with the load the page can feed it (a loaded host kept it at P5 to
 * P8 for whole runs), so one run per tier compares clocks, not methods. The bursts share the clock, and the report gives
 * each method's frame and SSGI time, and the paired difference to `none` per round. `--arms` replaces the three methods
 * with a JSON list of `{ name, method, arm }`, where `arm` overrides the chain options (`ssgiProbeRays`,
 * `ssgiTimedPass`, ...), and the paired difference is to the first arm: one knob per arm, one page, one clock.
 *
 * `--auto` is the live proof of the budgets instead: each tier starts with `giAuto=1` and `shadowAuto=1`, and the
 * report lists every window the budgets closed with the step they took and why.
 *
 * The GI tiers draw their shadows at `high`, as the Unreal GI cells do. `--shadow-tiers` instead draws the GI at
 * `medium` (no screen-space gather) and the shadows at each listed tier, so `frameMs` is the whole frame's GPU
 * time at that shadow tier.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Browser, Page } from "@playwright/test";
import { assertVisualPortAvailable, stopVisualServer } from "../visual-gate.js";
import { launchWebgpuBrowser } from "./browser.js";
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
  readonly stepped?: string;
  readonly reason?: string;
}

const flag = (args: readonly string[], name: string): string | undefined => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
};

const mean = (values: readonly number[]): number =>
  values.length === 0 ? Number.NaN : values.reduce((a, b) => a + b, 0) / values.length;

/**
 * The whole frame's resolved GPU milliseconds and the named stages inside it (`info.engine.gpuStages`), one
 * per distinct sample, keyed by the engine's frame id. The page
 * draws the pose in a tight loop beside its own: the host draws nothing while two frames are on the GPU, so the
 * GPU stays busy. A GPU that idles between frames drops to a low clock, and every pass then reads 2 to 5 times
 * dearer (a `low` frame read 14.9 ms at P5 and 3.2 ms boosted). The warm-up is 240 drawn frames and 4 s by default.
 */
const FRAME_SAMPLER = `(async (want, warmFrames = 240, warmMs = 4000) => {
  const w = window.__tnRef;
  const r = w.renderer;
  const seen = new Map();
  const note = () => {
    const ids = r.backend && r.backend.getTimestampFrames ? r.backend.getTimestampFrames("render") : undefined;
    const id = ids ? ids[ids.length - 1] : undefined;
    const ms = r.info && r.info.render ? r.info.render.timestamp : undefined;
    const stages = r.info && r.info.engine && r.info.engine.gpuStages ? { ...r.info.engine.gpuStages } : {};
    if (Number.isInteger(id) && typeof ms === "number" && ms > 0 && !seen.has(id)) seen.set(id, { ms, stages });
  };
  const tick = () => new Promise((done) => setTimeout(done, 0));
  const t0 = performance.now();
  const f0 = r.info.frame;
  while ((r.info.frame - f0 < warmFrames || performance.now() - t0 < warmMs) && performance.now() - t0 < 60000) {
    r.render(w.world, w.camera);
    await tick();
  }
  while (seen.size < want && performance.now() - t0 < 180000) {
    r.render(w.world, w.camera);
    note();
    await tick();
  }
  const samples = [...seen.values()];
  const names = [...new Set(samples.flatMap((sample) => Object.keys(sample.stages)))];
  return {
    ms: samples.map((sample) => sample.ms),
    // A stage that drew no pass in a sample is absent there: it cost 0.
    stages: Object.fromEntries(names.map((name) => [name, samples.map((sample) => sample.stages[name] ?? 0)])),
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
  warmup = 1,
): Promise<IWindow[]> {
  const windows = new Map<number, IWindow>();
  const deadline = Date.now() + 240_000;
  while (windows.size < count + 1 && Date.now() < deadline) {
    const last = (await page.evaluate("window.__tnRef.giBudget?.() ?? null")) as IWindow | null;
    if (last?.window !== undefined) windows.set(last.window, last);
    if (errors.length > 0) throw new Error(`TN_UNREAL_LOOK_PAGE_ERROR: ${errors.join(" | ")}`);
    await page.waitForTimeout(250);
  }
  return [...windows.values()].filter((w) => w.window > warmup);
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
      stages: Record<string, number[]>;
    };
    const frame = {
      ...frameStats(sampled.ms),
      gpu: gpuState(),
      pixelRatio: sampled.pixelRatio,
      size: sampled.size,
      stages: Object.fromEntries(
        Object.entries(sampled.stages).map(([stage, values]) => [stage, frameStats(values)]),
      ),
    };
    // No GI pass runs at `none`, so the tier costs no GI time by construction.
    if (method === "none")
      return { adapter, budgetMs: 0, frame, giMs: 0, insideBudget: true, method, windows: 0 };
    return { ...summarize(adapter, await collectWindows(page, errors, count)), frame };
  } finally {
    await page.close();
  }
}

/**
 * The live proof: the page starts at a tier with both budgets free to move (`giAuto=1`, `shadowAuto=1`), and the
 * report lists the windows they closed, each with the reading it judged and the step it took.
 */
async function watchSteps(
  browser: Browser,
  origin: string,
  name: string,
  tier: string,
  pose: unknown,
  count: number,
  urlExtra: string,
): Promise<Record<string, unknown>> {
  const { adapter, errors, page } = await openTier(
    browser,
    `${origin}?tnGi=${name}&layer=L7&tier=${tier}&shadowTier=high&giAuto=1&shadowAuto=1${urlExtra}`,
    pose,
  );
  try {
    const windows = await collectWindows(page, errors, count, 0);
    const shadow = await page.evaluate("window.__tnRef.shadowBudget?.() ?? null");
    return { adapter, gpu: gpuState(), shadow, started: tier, windows };
  } finally {
    await page.close();
  }
}

/** One arm of an interleaved run: a final gather method and the chain options that override the tier's (`setGatherMethod`). */
interface IArm {
  readonly name: string;
  readonly method: string;
  readonly arm?: Readonly<Record<string, unknown>>;
}

const METHOD_ARMS: readonly IArm[] = ["none", "irradianceField", "screenProbeGather"].map(
  (method) => ({
    name: method,
    method,
  }),
);

interface IBurst {
  readonly arm: string;
  readonly round: number;
  readonly ms: readonly number[];
  readonly stages: Readonly<Record<string, readonly number[]>>;
  readonly gpu: string;
}

const spread = (values: readonly number[]): number => {
  const m = mean(values);
  return values.length < 2
    ? Number.NaN
    : Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1));
};

/**
 * One page at `high`: every round times each arm for `burst` samples, the order rotated, so they share the GPU clock.
 * `paired` is each arm's round mean minus the first arm's in the same round.
 */
async function measureInterleaved(
  browser: Browser,
  origin: string,
  name: string,
  pose: unknown,
  rounds: number,
  burst: number,
  urlExtra: string,
  arms: readonly IArm[] = METHOD_ARMS,
): Promise<Record<string, unknown>> {
  const { adapter, errors, page } = await openTier(
    browser,
    `${origin}?tnGi=${name}&layer=L7&tier=high&shadowTier=high${urlExtra}`,
    pose,
  );
  try {
    await page.evaluate(`${FRAME_SAMPLER}(30, 240, 6000)`);
    const bursts: IBurst[] = [];
    for (let round = 0; round < rounds; round++) {
      const turn = round % arms.length;
      for (const { name: arm, method, arm: options } of [
        ...arms.slice(turn),
        ...arms.slice(0, turn),
      ]) {
        await page.evaluate(
          `window.__tnRef.setGatherMethod(${JSON.stringify(method)}, ${JSON.stringify(options ?? {})})`,
        );
        const sampled = (await page.evaluate(`${FRAME_SAMPLER}(${burst}, 60, 800)`)) as {
          ms: number[];
          stages: Record<string, number[]>;
        };
        if (errors.length > 0) throw new Error(`TN_UNREAL_LOOK_PAGE_ERROR: ${errors.join(" | ")}`);
        // A gather that draws must time its stage: no reading means the chain did not build (a bad arm), not 0 ms.
        if (method === "screenProbeGather" && (sampled.stages.SSGI ?? []).every((ms) => !(ms > 0)))
          throw new Error(
            `TN_GI_ARMS: ${arm} drew no SSGI stage; check the page console for the chain error`,
          );
        bursts.push({ arm, gpu: gpuState(), round, ms: sampled.ms, stages: sampled.stages });
      }
    }
    const perArm = Object.fromEntries(
      arms.map(({ name: arm }) => {
        const own = bursts.filter((b) => b.arm === arm);
        const ssgi = own.flatMap((b) => b.stages.SSGI ?? []);
        return [
          arm,
          {
            frame: frameStats(own.flatMap((b) => b.ms)),
            ssgi: ssgi.length === 0 ? null : frameStats(ssgi),
            // The stage's share of its own sample's frame: the GPU clock moves both alike, so the share survives a
            // P2 to P8 swing that moves the milliseconds 2 to 3 times.
            ssgiShare:
              ssgi.length === 0
                ? null
                : Number(
                    mean(
                      own.flatMap((b) =>
                        (b.stages.SSGI ?? []).map((ms, i) => ms / (b.ms[i] ?? Number.NaN)),
                      ),
                    ).toFixed(4),
                  ),
            roundMeans: own.map((b) => Number(mean(b.ms).toFixed(3))),
          },
        ];
      }),
    );
    const baseline = arms[0]?.name ?? "";
    const paired = Object.fromEntries(
      arms.slice(1).map(({ name: arm }) => {
        const deltas = Array.from({ length: rounds }, (_, round) => {
          const at = (m: string) => bursts.find((b) => b.round === round && b.arm === m);
          return mean(at(arm)?.ms ?? []) - mean(at(baseline)?.ms ?? []);
        });
        return [
          arm,
          {
            meanMs: Number(mean(deltas).toFixed(3)),
            sdMs: Number(spread(deltas).toFixed(3)),
            rounds: deltas.map((d) => Number(d.toFixed(3))),
          },
        ];
      }),
    );
    return {
      adapter,
      bursts: bursts.map(({ arm, round, gpu, ms, stages }) => ({
        arm,
        round,
        ssgi: stages.SSGI === undefined ? null : Number(mean(stages.SSGI).toFixed(3)),
        gpu,
        mean: Number(mean(ms).toFixed(3)),
      })),
      arms,
      paired,
      perArm,
      rounds,
      burst,
      urlExtra,
    };
  } finally {
    await page.close();
  }
}

/** The `--arms` file: a JSON list of `{ name, method, arm? }`, at least two, names unique. Fails closed. */
export function parseArms(text: string): IArm[] {
  const arms = JSON.parse(text) as unknown;
  if (!Array.isArray(arms) || arms.length < 2)
    throw new Error("TN_GI_ARMS: --arms needs a JSON list of at least two { name, method, arm? }");
  for (const entry of arms as IArm[]) {
    if (typeof entry?.name !== "string" || typeof entry.method !== "string")
      throw new Error(`TN_GI_ARMS: an arm needs a name and a method: ${JSON.stringify(entry)}`);
    if (entry.arm !== undefined && (typeof entry.arm !== "object" || entry.arm === null))
      throw new Error(`TN_GI_ARMS: ${entry.name}: arm must be an object of chain options`);
  }
  const names = (arms as IArm[]).map((entry) => entry.name);
  if (new Set(names).size !== names.length)
    throw new Error(`TN_GI_ARMS: duplicate arm names ${names.join(",")}`);
  return arms as IArm[];
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

/** The measurements one page session takes, as the flags ask: the live proof, or the tiers and then the shadow tiers. */
async function measureAll(
  browser: Browser,
  origin: string,
  name: string,
  pose: unknown,
  args: readonly string[],
): Promise<Record<string, Record<string, unknown>>> {
  const report: Record<string, Record<string, unknown>> = {};
  const tiers = (flag(args, "--tiers") ?? "low,medium,high").split(",");
  const count = Number(flag(args, "--windows") ?? 3);
  const urlExtra = flag(args, "--url-extra") ?? "";
  if (args.includes("--interleave")) {
    const rounds = Number(flag(args, "--rounds") ?? 5);
    const burst = Number(flag(args, "--burst") ?? 100);
    const armsFile = flag(args, "--arms");
    const arms = armsFile === undefined ? METHOD_ARMS : parseArms(await readFile(armsFile, "utf8"));
    report.interleave = await measureInterleaved(
      browser,
      origin,
      name,
      pose,
      rounds,
      burst,
      urlExtra,
      arms,
    );
    console.info(`TN_GI_INTERLEAVE ${JSON.stringify(report.interleave)}`);
    return report;
  }
  if (args.includes("--auto")) {
    for (const tier of tiers) {
      report[`auto-${tier}`] = await watchSteps(browser, origin, name, tier, pose, count, urlExtra);
      console.info(`TN_GI_AUTO ${tier} ${JSON.stringify(report[`auto-${tier}`])}`);
    }
    return report;
  }
  const shadowTiers = flag(args, "--shadow-tiers")?.split(",") ?? [];
  for (const tier of shadowTiers.length > 0 ? [] : tiers)
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
  return report;
}

export async function main(args: readonly string[]): Promise<number> {
  const value = flag(args, "--scene") ?? "gi:cornell";
  const [name = ""] = sceneNames(
    value,
    registry(familyOf(value)).scenes.map((s) => s.name),
  );
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
  let report: Record<string, Record<string, unknown>> = {};
  try {
    const origin = `http://127.0.0.1:${port}/`;
    await waitForServer(origin, server);
    const browser = await launchWebgpuBrowser();
    try {
      report = await measureAll(browser, origin, name, pose, args);
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
