/**
 * ThreeNative side of the PRD-631 reference capture.
 *
 * Scaffolds the `starter` template, adds the harness scene (`scaffold/Reference.ts.in`) and the
 * reference GLBs to that copy, and captures every (layer, sun, pose) cell headed on WebGPU. The
 * look stays in the copy's `src/render/`: tuning a layer means editing the template, then
 * rerunning this with `--reuse`, which re-copies the template source into the same scaffold.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { createProject } from "../../packages/create-threenative/src/index.js";
import { WEBGPU_BROWSER_ARGS } from "../../packages/playtest/src/runner/browser.js";
import {
  assertVisualPortAvailable,
  packageLocalFramework,
  stopVisualServer,
} from "../visual-gate.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const REFERENCE = path.join(REPO_ROOT, "tools/unreal-reference");
const TEMPLATE = path.join(REPO_ROOT, "packages/create-threenative/templates/starter");

interface IPose {
  readonly name: string;
  readonly position: number[];
  readonly target: number[];
  readonly hfovDeg: number;
}
interface ISun {
  readonly name: string;
  readonly elevationDeg: number;
  readonly azimuthDeg: number;
}
interface IPoses {
  readonly resolution: [number, number];
  readonly suns: readonly ISun[];
  readonly poses: readonly IPose[];
}

export interface IThreeNativeCaptureOptions {
  readonly out: string;
  readonly layers: readonly string[];
  readonly cells?: ReadonlySet<string>;
  readonly reuse: boolean;
  readonly port?: number;
}

function replaceOnce(source: string, from: string, to: string, file: string): string {
  if (!source.includes(from)) throw new Error(`TN_UNREAL_LOOK_PATCH: '${from}' not in ${file}`);
  return source.replace(from, to);
}

/** Applies the harness patches to a scaffolded starter; fails closed when the template moved. */
async function patchScaffold(target: string, fresh = true): Promise<void> {
  await cp(
    path.join(import.meta.dirname, "scaffold/Reference.ts.in"),
    path.join(target, "src/scenes/Reference.ts"),
  );
  await mkdir(path.join(target, "assets/unreal-reference"), { recursive: true });
  for (const file of ["scene.glb", "scene-id.glb"])
    await cp(path.join(REFERENCE, file), path.join(target, "assets/unreal-reference", file));
  if (!fresh) return;
  const game = path.join(target, "src/game.ts");
  let source = await readFile(game, "utf8");
  source = replaceOnce(
    source,
    'import { Play } from "./scenes/Play.js";',
    'import { Play } from "./scenes/Play.js";\nimport { Reference } from "./scenes/Reference.js";',
    game,
  );
  source = replaceOnce(
    source,
    "scenes: { play: Play },",
    "scenes: { play: Play, reference: Reference },",
    game,
  );
  source = replaceOnce(source, 'start: "play",', 'start: "reference",', game);
  await writeFile(game, source);
  const config = path.join(target, "threenative.config.ts");
  // One drawing pixel per display pixel, so both engines rasterise the same grid.
  await writeFile(
    config,
    replaceOnce(
      await readFile(config, "utf8"),
      'resolutionScale: "auto"',
      "resolutionScale: 1",
      config,
    ),
  );
}

async function scaffold(work: string, reuse: boolean): Promise<string> {
  const target = path.join(work, "starter");
  if (reuse && existsSync(path.join(target, "node_modules"))) {
    // The look lives in src/render/; re-copy it (and public/) so a template edit reaches the
    // scaffold. Everything else, including the stamped config and the install, stays.
    await rm(path.join(target, "src/render"), { recursive: true, force: true });
    await cp(path.join(TEMPLATE, "src/render"), path.join(target, "src/render"), {
      recursive: true,
    });
    await cp(path.join(TEMPLATE, "public"), path.join(target, "public"), { recursive: true });
    await patchScaffold(target, false);
    return target;
  } else {
    await rm(work, { recursive: true, force: true });
    await mkdir(work, { recursive: true });
    const packageSources = await packageLocalFramework(work);
    await createProject(
      { install: true, packageSources, target: "starter", template: "starter" },
      work,
    );
  }
  await patchScaffold(target);
  return target;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

async function waitForServer(url: string, server: ChildProcess): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`dev server exited ${server.exitCode}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`TN_UNREAL_LOOK_SERVER: ${url} not ready in 120 s`);
}

const HIDE_UI = `body * { visibility: hidden !important; }
[data-threenative-canvas], [data-threenative-canvas] * { visibility: visible !important; }`;

export async function captureThreeNative(options: IThreeNativeCaptureOptions): Promise<number> {
  const poses = JSON.parse(await readFile(path.join(REFERENCE, "poses.json"), "utf8")) as IPoses;
  const work =
    process.env.TN_UNREAL_LOOK_WORK ?? path.join(os.homedir(), ".cache/threenative/unreal-look");
  const target = await scaffold(work, options.reuse);
  const port = options.port ?? (await freePort());
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
  let count = 0;
  try {
    const origin = `http://127.0.0.1:${port}/`;
    await waitForServer(origin, server);
    const [width, height] = poses.resolution;
    const browser = await chromium.launch({ args: [...WEBGPU_BROWSER_ARGS], headless: false });
    try {
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const adapter = await (async () => {
        await page.goto(origin, { waitUntil: "domcontentloaded" });
        return page.evaluate(async () => {
          const gpu = (
            navigator as unknown as {
              gpu?: { requestAdapter(): Promise<{ info: Record<string, string> } | null> };
            }
          ).gpu;
          const found = await gpu?.requestAdapter();
          if (!found) return null;
          const { vendor, architecture, device, description } = found.info;
          return { vendor, architecture, device, description };
        });
      })();
      if (adapter === null)
        throw new Error("TN_UNREAL_LOOK_NO_WEBGPU: navigator.gpu has no adapter");
      console.info(`TN_UNREAL_LOOK adapter ${JSON.stringify(adapter)}`);
      if (/swiftshader|llvmpipe/i.test(JSON.stringify(adapter)))
        throw new Error(`TN_UNREAL_LOOK_SOFTWARE_ADAPTER: ${JSON.stringify(adapter)}`);
      for (const layer of options.layers) {
        const suns =
          layer === "ID" ? [{ name: "id", elevationDeg: 60, azimuthDeg: 25 }] : poses.suns;
        for (const sun of suns) {
          const wanted = poses.poses.filter(
            (pose) =>
              options.cells === undefined ||
              layer === "ID" ||
              options.cells.has(`${sun.name}/${pose.name}`),
          );
          if (wanted.length === 0) continue;
          await page.goto(`${origin}?tnRef=${layer}&sun=${sun.elevationDeg},${sun.azimuthDeg}`, {
            waitUntil: "domcontentloaded",
          });
          await page.addStyleTag({ content: HIDE_UI });
          await page.waitForSelector('[data-threenative-startup="ready"]', { timeout: 120_000 });
          await page.waitForFunction(() => "__tnRef" in window, undefined, { timeout: 30_000 });
          for (const pose of wanted) {
            await page.evaluate((p) => {
              (window as unknown as { __tnRef: { pose(p: unknown): void } }).__tnRef.pose(p);
            }, pose);
            // Let the chain, its denoisers and the shadow map settle on the new view.
            await page.evaluate(
              () =>
                new Promise<void>((resolve) => {
                  let frames = 0;
                  const tick = () => (++frames >= 45 ? resolve() : requestAnimationFrame(tick));
                  requestAnimationFrame(tick);
                }),
            );
            if (errors.length > 0)
              throw new Error(`TN_UNREAL_LOOK_PAGE_ERROR: ${errors.join(" | ")}`);
            const name = layer === "ID" ? `ID_${pose.name}` : `${layer}_${sun.name}_${pose.name}`;
            const file = path.join(options.out, layer, `${name}.png`);
            await mkdir(path.dirname(file), { recursive: true });
            await writeFile(file, await page.screenshot({ type: "png" }));
            count += 1;
          }
        }
      }
      await writeFile(
        path.join(options.out, "capture.json"),
        `${JSON.stringify({ adapter, capturedAt: new Date().toISOString(), cells: count }, null, 2)}\n`,
      );
    } finally {
      await browser.close();
    }
  } finally {
    await stopVisualServer(server);
  }
  return count;
}
