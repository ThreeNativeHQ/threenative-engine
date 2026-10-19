/**
 * PRD-278 §5 — does `renderer.toneMappingExposure` reach the frame once
 * an output pipeline is installed, on `three@0.185.1`?
 *
 * The mined `lumen-hall` WorldEnvironment says it does not ("moving it from 0.85 to
 * 1.45 changed nothing at all on screen"); reading `three@0.185.1` says it does
 * (`RenderPipeline.outputColorTransform` defaults to true, and `ToneMappingNode`'s
 * default `exposureNode` is a live `rendererReference('toneMappingExposure')`).
 * AC7 refuses to ship the file until one A/B capture settles it.
 *
 * The scene is the minimal configuration every template ships: ACES tone mapping, a
 * `toneMappingExposure` scalar, and one scene pass installed through a `RenderPipeline`.
 * Three captures settle it: exposure 0.85, exposure 1.45, and a same-value control
 * (0.85 again) that must diff clean against the first — a dirty control means the
 * captures themselves are noisy and neither verdict is earned.
 *
 * Headed on purpose: headless Chromium cannot capture WebGPU (white canvas, correct DOM),
 * so run this through `sh scripts/xvfb.sh pnpm tsx scripts/exposure-ab.ts` or any display.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ESBUILD = path.join(
  REPO_ROOT,
  "node_modules/.bin",
  process.platform === "win32" ? "esbuild.cmd" : "esbuild",
);
const DEFAULT_OUT = path.join(REPO_ROOT, "docs/verification/exposure-ab-2026-08-30");
const DIMENSIONS = { width: 640, height: 360 };
/** The two values the mined file claims were indistinguishable. */
const EXPOSURES = [0.85, 1.45] as const;

/** A capture pair counts as changed above these floors; both at zero means the lane is clean. */
export const EXPOSURE_AB_THRESHOLDS = {
  changedPixelRatio: 0.001,
  perceptualDeltaE: 0.05,
} as const;

export type ExposureAbComparison = {
  readonly pixelMismatchRatio?: number;
  readonly perceptualDeltaE?: number;
};

/**
 * The verdict PRD-278 §5 ships on. The control pair (same exposure twice) must diff clean,
 * or the capture lane is too noisy to judge either way and the run claims nothing.
 */
export function classifyExposureAb(
  lowToHigh: ExposureAbComparison,
  control: ExposureAbComparison,
): "changed" | "unchanged" | "inconclusive" {
  const changed = (comparison: ExposureAbComparison): boolean =>
    (comparison.pixelMismatchRatio ?? 0) > EXPOSURE_AB_THRESHOLDS.changedPixelRatio ||
    (comparison.perceptualDeltaE ?? 0) > EXPOSURE_AB_THRESHOLDS.perceptualDeltaE;
  if (changed(control)) return "inconclusive";
  return changed(lowToHigh) ? "changed" : "unchanged";
}

function entrySource(): string {
  return `
import * as THREE from "three/webgpu";
import { pass } from "three/tsl";
import { startVisualScene } from ${JSON.stringify(path.join(REPO_ROOT, "packages/runtime-native/conformance/scenes/shared/scene-support.js"))};

const canvas = document.getElementById("c");
await startVisualScene(canvas, ${JSON.stringify(DIMENSIONS)}, "exposure-ab", ({ renderer, scene, camera }) => {
  scene.background = new THREE.Color(0x0b1020);
  scene.add(
    new THREE.HemisphereLight(0x9fc5ff, 0x1d2740, 1.8),
    new THREE.DirectionalLight(0xffd6a5, 3.2),
  );
  const subject = new THREE.Mesh(
    new THREE.TorusKnotGeometry(0.66, 0.2, 96, 20),
    new THREE.MeshStandardMaterial({ color: 0x54d2ff, metalness: 0.35, roughness: 0.22 }),
  );
  scene.add(subject);
  subject.rotation.y = 0.4;

  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = Number(globalThis.__TN_EXPOSURE__);
  // The exact shape every template ships: the scalar is set immediately before the
  // output pipeline is installed, which is the configuration the mined file calls dead.
  const pipeline = new THREE.RenderPipeline(renderer);
  pipeline.outputNode = pass(scene, camera).getTextureNode();
  globalThis.__TN_EXPOSURE_AB_READY__ = true;
  return { render: () => pipeline.render() };
});
`;
}

async function main(): Promise<void> {
  const { chromium } = await import("@playwright/test");
  const { WEBGPU_BROWSER_ARGS, softwareAdapterName } = await import(
    "../packages/playtest/src/runner/browser.js"
  );
  const { compareCaptures } = await import("../packages/runtime-native/conformance/metrics.mjs");
  const out = process.argv[2] ?? DEFAULT_OUT;
  const directory = await mkdtemp(path.join(REPO_ROOT, "artifacts/exposure-ab-"));
  const captures: { exposure: number; image: Buffer; adapter: Record<string, string> }[] = [];
  let server: ReturnType<typeof createServer> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const entry = path.join(directory, "entry.js");
    const bundle = path.join(directory, "bundle.js");
    await writeFile(entry, entrySource(), "utf8");
    await execFileAsync(
      ESBUILD,
      [
        entry,
        "--bundle",
        "--format=esm",
        "--platform=browser",
        `--outfile=${bundle}`,
        '--define:import.meta.env={"BASE_URL":"/","DEV":false,"MODE":"production","PROD":true,"SSR":false}',
      ],
      { cwd: REPO_ROOT, maxBuffer: 32 * 1024 * 1024 },
    );

    server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
      if (request.url === "/bundle.js") {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end(await readFile(bundle));
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:${DIMENSIONS.width}px;height:${DIMENSIONS.height}px;overflow:hidden}canvas{display:block}</style>` +
          `<canvas id="c" width="${DIMENSIONS.width}" height="${DIMENSIONS.height}"></canvas><script type="module" src="/bundle.js"></script>`,
      );
    });
    await new Promise<void>((resolve, reject) => {
      server?.once("error", reject);
      server?.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    const url = `http://127.0.0.1:${address.port}/`;

    browser = await chromium.launch({
      args: [...WEBGPU_BROWSER_ARGS],
      headless: false,
    });
    for (const exposure of [...EXPOSURES, EXPOSURES[0]]) {
      const page = await browser.newPage({ viewport: DIMENSIONS });
      page.on("console", (message) =>
        console.error(`[console:${message.type()}] ${message.text()}`),
      );
      page.on("pageerror", (error) => console.error(`[pageerror] ${error.message}`));
      try {
        await page.addInitScript((value: number) => {
          (globalThis as { __TN_EXPOSURE__?: number }).__TN_EXPOSURE__ = value;
        }, exposure);
        await page.goto(url, { waitUntil: "domcontentloaded" });
        const adapter = await page.evaluate(async () => {
          const gpuNavigator = navigator as Navigator & {
            gpu?: { requestAdapter(): Promise<{ info?: Record<string, unknown> } | null> };
          };
          const raw = (await gpuNavigator.gpu?.requestAdapter())?.info ?? {};
          return Object.fromEntries(
            Object.entries(raw).filter(([, value]) => typeof value === "string"),
          ) as Record<string, string>;
        });
        const software = softwareAdapterName(adapter);
        if (software !== undefined) throw new Error(`TN_EXPOSURE_AB_SOFTWARE_ADAPTER:${software}`);
        await page.waitForFunction(
          () =>
            (globalThis as { __TN_EXPOSURE_AB_READY__?: boolean }).__TN_EXPOSURE_AB_READY__ ===
            true,
          undefined,
          { timeout: 60_000 },
        );
        await page.evaluate(async () => {
          for (let frame = 0; frame < 30; frame += 1) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          }
        });
        captures.push({ exposure, image: await page.screenshot({ type: "png" }), adapter });
      } finally {
        await page.close();
      }
    }

    const low = captures[0];
    const high = captures[1];
    const control = captures[2];
    if (low === undefined || high === undefined || control === undefined) {
      throw new Error(`TN_EXPOSURE_AB_CAPTURES_MISSING: got ${String(captures.length)} of 3`);
    }
    if (process.env.EXPOSURE_AB_DEBUG !== undefined) {
      await mkdir("/tmp/exposure-ab", { recursive: true });
      await writeFile("/tmp/exposure-ab/low.png", low.image);
      await writeFile("/tmp/exposure-ab/high.png", high.image);
      console.log("debug captures written to /tmp/exposure-ab");
    }

    // A perceptual delta-E above the floor or a changed-pixel ratio above its floor means
    // the frames differ; the control pair must sit at zero or the lane judges nothing.
    const verdicts = {
      lowToHigh: compareCaptures(low.image, high.image),
      control: compareCaptures(low.image, control.image),
    };
    const classification = classifyExposureAb(verdicts.lowToHigh, verdicts.control);
    const report = {
      adapter: low.adapter,
      exposures: [...EXPOSURES, EXPOSURES[0]],
      lowToHigh: verdicts.lowToHigh,
      control: verdicts.control,
      verdict:
        classification === "inconclusive"
          ? "inconclusive:control-differed"
          : classification === "changed"
            ? "toneMappingExposure reaches the frame"
            : "toneMappingExposure does not reach the frame",
    };
    await mkdir(out, { recursive: true });
    await writeFile(path.join(out, "low.png"), low.image);
    await writeFile(path.join(out, "high.png"), high.image);
    await writeFile(path.join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
    if (classification === "inconclusive") process.exitCode = 3;
  } finally {
    try {
      if (browser !== undefined) await browser.close();
    } finally {
      try {
        await closeServer(server);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}

async function closeServer(server: ReturnType<typeof createServer> | undefined): Promise<void> {
  if (server === undefined) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING")
        resolve();
      else reject(error);
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
