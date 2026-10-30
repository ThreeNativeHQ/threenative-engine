/**
 * Does a shadow tier step reach a frame that is already drawing? (PRD-652, `ShadowFilterBudget.onStep`)
 *
 *   sh <slots>/gpu-slot.sh pnpm exec tsx scripts/unreal-look/tier-live-step.ts --out <dir> [--reuse]
 *
 * Draws penumbra-lab at the `high` shadow tier, calls `window.__tnRef.setShadowTier("medium")` on the live page,
 * and draws it again. A third frame is `medium` from a fresh load. When the live frame equals the fresh one, the
 * step took effect without a reload. Writes `high.png`, `live-medium.png` and `fresh-medium.png`.
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertVisualPortAvailable, stopVisualServer } from "../visual-gate.js";
import { launchWebgpuBrowser } from "./browser.js";
import { patchGi } from "./capture-gi-threenative.js";
import { HIDE_UI, freePort, scaffold, waitForServer } from "./capture-threenative.js";
import { readScene } from "./gi.js";

const flag = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};

const NAME = "shadow:penumbra-lab";
const out = path.resolve(flag("--out") ?? "tier-live-step");
const work =
  process.env.TN_UNREAL_LOOK_WORK ?? path.join(os.homedir(), ".cache/threenative/unreal-look");
const target = await scaffold(work, process.argv.includes("--reuse"), false);
await patchGi(target, [NAME]);
const { scene } = readScene(NAME);
const sun = scene.suns?.find((s) => s.name === "sun15");
const pose = scene.poses.find((p) => p.name === "sun15-contact");
if (sun === undefined || pose === undefined)
  throw new Error("TN_TIER_LIVE_STEP: sun15 not in scene");
const port = await freePort();
await assertVisualPortAvailable(port);
const server = spawn(
  "pnpm",
  ["dev", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  { cwd: target, detached: process.platform !== "win32", stdio: ["ignore", "inherit", "inherit"] },
);
const settle =
  "new Promise((resolve) => { let n = 0; const tick = () => (++n >= 45 ? resolve() : requestAnimationFrame(tick)); requestAnimationFrame(tick); })";
try {
  const origin = `http://127.0.0.1:${port}/`;
  await waitForServer(origin, server);
  const browser = await launchWebgpuBrowser();
  try {
    const [width, height] = scene.resolution;
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await mkdir(out, { recursive: true });
    const visit = async (tier: string) => {
      await page.goto(
        `${origin}main.html?tnRef=L5&tier=${tier}&sun=${sun.elevationDeg},${sun.azimuthDeg}&model=penumbra-lab`,
        { waitUntil: "domcontentloaded" },
      );
      await page.addStyleTag({ content: HIDE_UI });
      await page.waitForSelector('[data-threenative-startup="ready"]', { timeout: 300_000 });
      await page.waitForFunction(() => "__tnRef" in window, undefined, { timeout: 240_000 });
      await page.evaluate(`window.__tnRef.pose(${JSON.stringify(pose)})`);
      await page.evaluate(settle);
    };
    const shoot = async (file: string) => {
      if (errors.length > 0) throw new Error(`TN_UNREAL_LOOK_PAGE_ERROR: ${errors.join(" | ")}`);
      await writeFile(path.join(out, file), await page.screenshot({ type: "png" }));
    };
    await visit("high");
    await shoot("high.png");
    await page.evaluate('window.__tnRef.setShadowTier("medium")');
    await page.evaluate(settle);
    await shoot("live-medium.png");
    await visit("medium");
    await shoot("fresh-medium.png");
    console.info(`TN_TIER_LIVE_STEP wrote ${out}`);
  } finally {
    await browser.close();
  }
} finally {
  await stopVisualServer(server);
}
