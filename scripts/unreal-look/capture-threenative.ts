/**
 * ThreeNative side of the PRD-631 reference capture.
 *
 * Scaffolds the `starter` template, adds the harness scene (`scaffold/Reference.ts.in`) and the
 * reference GLBs to that copy, and captures every (layer, sun, pose) cell headed on WebGPU. The
 * look stays in the copy's `src/render/`: tuning a layer means editing the template, then
 * rerunning this with `--reuse`, which re-copies the template source into the same scaffold.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { createProject } from "../../packages/create-threenative/src/index.js";
import {
  LOCAL_FRAMEWORK_PACKAGES,
  assertVisualPortAvailable,
  packageLocalFramework,
  stopVisualServer,
} from "../visual-gate.js";
import { workspacePackages } from "../workspace-packages.js";
import { launchWebgpuBrowser } from "./browser.js";
import { FRAME_GATE } from "./capture-motion-threenative.js";
import { awaitExposureSettled, metersExposure, watchExposure } from "./exposureSettled.js";
import { GPU_PASSES, readPasses } from "./gpuPasses.js";
import {
  MIN_STEPS,
  RENDERER_LOST,
  SETTLE_STEPS,
  atFixedJitterPhase,
  stageBuildFailures,
} from "./jitterPhase.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const REFERENCE = path.join(REPO_ROOT, "tools/unreal-reference");
const TEMPLATE = path.join(REPO_ROOT, "packages/create-threenative/templates/starter");

/** The overlay source. A lane can point this at a private copy to prove its change beside others' unfinished edits. */
const SCAFFOLD_DIR =
  process.env.TN_UNREAL_LOOK_SCAFFOLD ?? path.join(import.meta.dirname, "scaffold");

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
  /** Skip scaffold/render/: capture the template look as it ships (the BEFORE arm). */
  readonly baseline?: boolean;
  /** Hold each pose this many seconds and write its TN_FRAME_BUDGET windows instead of a screenshot. */
  readonly measureSeconds?: number;
  /** Viewport override, `[width, height]`; the Unreal cells use poses.json's resolution. */
  readonly size?: readonly [number, number];
  /** Comma list of L9 stages to switch off (`?off=` in Reference.ts.in): a stage ablation. */
  readonly off?: string;
  readonly port?: number;
}

function replaceOnce(source: string, from: string, to: string, file: string): string {
  if (!source.includes(from)) throw new Error(`TN_UNREAL_LOOK_PATCH: '${from}' not in ${file}`);
  return source.replace(from, to);
}

/**
 * Every capture pose, keyed by Reference.ts.in's `?model=` folder ("" is the calibration scene), so
 * a person opening the page starts where the capture looks, not at the framework camera's origin.
 */
export function referencePoses(reference = REFERENCE): Record<string, readonly IPose[]> {
  const read = (file: string) => JSON.parse(readFileSync(file, "utf8")) as { poses?: IPose[] };
  const poses: Record<string, readonly IPose[]> = {
    "": read(path.join(reference, "poses.json")).poses ?? [],
  };
  // The GI scenes keep their bare folder name; the shadow scenes are `shadow/<name>` (PRD-649).
  for (const [family, prefix] of [
    ["gi", ""],
    ["shadow", "shadow/"],
  ] as const) {
    const root = path.join(reference, family);
    for (const folder of readdirSync(root).sort()) {
      const file = path.join(root, folder, "scene.json");
      if (existsSync(file)) poses[`${prefix}${folder}`] = read(file).poses ?? [];
    }
  }
  return poses;
}

/**
 * The ID layer is a classification image, not a picture: a multisampled edge blends two region colours
 * into a third pixel, and some pairs blend into the colour of a third region (the cornell lamp shade
 * read as 372 pixels of the green wall's edge). Unreal draws its ID frames aliased, so the page draws
 * the ID layer on a single-sampled surface too: `?layer=ID` (calibration scenes) and `?tnRef=ID`
 * (the reference scene) switch `renderer.antialias` off. Idempotent, so a reused scaffold gets it too.
 */
export const ID_LAYER_QUERY = /[?&](layer|tnRef)=ID(&|$)/;
export const ID_LAYER_ANTIALIAS = `antialias: !${ID_LAYER_QUERY}.test(globalThis.location?.search ?? ""),`;
export function idLayerIsAliased(source: string, file: string): string {
  return source.includes(ID_LAYER_ANTIALIAS)
    ? source
    : replaceOnce(
        source,
        "alphaAntialiasing: true,",
        `alphaAntialiasing: true,\n    ${ID_LAYER_ANTIALIAS}`,
        file,
      );
}

/** Applies the harness patches to a scaffolded starter; fails closed when the template moved. */
export async function patchScaffold(
  target: string,
  fresh: boolean,
  baseline: boolean,
): Promise<void> {
  // The look under tuning: these files replace the template's own in the copy only. A tuned
  // file moves into the templates once the reference cells match Unreal.
  if (!baseline)
    await cp(path.join(SCAFFOLD_DIR, "render"), path.join(target, "src/render"), {
      recursive: true,
    });
  // Until the engine facade has TempNode, auto exposure (a TempNode subclass) refuses to start:
  // set TN_UNREAL_LOOK_NO_AUTO_EXPOSURE=1 to capture with it off. The capture is then not an L9 match.
  if (process.env.TN_UNREAL_LOOK_NO_AUTO_EXPOSURE === "1") {
    const q = path.join(target, "src/render/quality.ts");
    await writeFile(
      q,
      (await readFile(q, "utf8")).replaceAll(
        "autoExposureEnabled: true",
        "autoExposureEnabled: false",
      ),
    );
  }
  await cp(
    path.join(SCAFFOLD_DIR, "Reference.ts.in"),
    path.join(target, "src/scenes/Reference.ts"),
  );
  // The render modules that only the overlay has: the baseline arm gets inert stand-ins (the template look).
  await cp(
    path.join(SCAFFOLD_DIR, baseline ? "tuningBaseline.ts.in" : "tuning.ts.in"),
    path.join(target, "src/scenes/tuning.ts"),
  );
  await writeFile(
    path.join(target, "src/scenes/referencePoses.ts"),
    `// Generated by scripts/unreal-look/capture-threenative.ts from the tools/unreal-reference poses.\nexport const POSES: Record<string, readonly { name: string; position: number[]; target: number[]; hfovDeg: number }[]> = ${JSON.stringify(referencePoses())};\n`,
  );
  await mkdir(path.join(target, "assets/unreal-reference"), { recursive: true });
  for (const file of ["scene.glb", "scene-id.glb"])
    await cp(path.join(REFERENCE, file), path.join(target, "assets/unreal-reference", file));
  const starter = path.join(target, "threenative.config.ts");
  await writeFile(starter, idLayerIsAliased(await readFile(starter, "utf8"), starter));
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
  // The scene renders on the template's default engine, the owned C++ Wasm engine (owner,
  // 2026-10-19); upstream three is never pinned here.
  // TN_UNREAL_LOOK_RESOLUTION_AUTO=1 keeps the template's "auto" scale, so a perf run can show the primary
  // resolution scale answer a frame over its period (PRD-644 `## Decisions`). A capture never sets it.
  if (process.env.TN_UNREAL_LOOK_RESOLUTION_AUTO === "1") return;
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

/**
 * What a scaffold's install was packed from: the framework packages' committed trees, their
 * uncommitted and untracked edits, and the separately built files (the Wasm engine pair). A
 * reused scaffold whose stamp differs would capture the framework as it was when first packed.
 */
export function frameworkStamp(
  root: string,
  directories: readonly string[],
  built: readonly string[],
): string {
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { maxBuffer: 1 << 30 });
  const hash = createHash("sha256");
  hash.update(git("ls-tree", "HEAD", "--", ...directories));
  hash.update(git("diff", "HEAD", "--binary", "--", ...directories));
  const untracked = git("ls-files", "-o", "--exclude-standard", "--", ...directories)
    .toString()
    .split("\n");
  for (const file of [...untracked.filter(Boolean).map((f) => path.join(root, f)), ...built]) {
    const stat = existsSync(file) ? statSync(file) : undefined;
    hash.update(`${path.relative(root, file)}:${stat?.size}:${stat?.mtimeMs}\n`);
  }
  return hash.digest("hex");
}

function localFrameworkStamp(): string {
  const names = new Set(LOCAL_FRAMEWORK_PACKAGES.map(([name]) => name));
  const directories = workspacePackages(REPO_ROOT)
    .filter((item) => names.has(item.name))
    .map((item) => path.relative(REPO_ROOT, item.directory));
  const engine = path.join(REPO_ROOT, "packages/runtime-native/build/web/tn-native-engine-web");
  return frameworkStamp(REPO_ROOT, directories, [`${engine}.mjs`, `${engine}.wasm`]);
}

export async function scaffold(work: string, reuse: boolean, baseline: boolean): Promise<string> {
  const target = path.join(work, "starter");
  const stampFile = path.join(work, "framework.stamp");
  const stamp = localFrameworkStamp();
  const packed = existsSync(stampFile) ? await readFile(stampFile, "utf8") : undefined;
  if (reuse && packed !== stamp && existsSync(path.join(target, "node_modules")))
    console.log(
      "TN_UNREAL_LOOK --reuse: the framework changed since this scaffold was packed; packing it again",
    );
  if (reuse && packed === stamp && existsSync(path.join(target, "node_modules"))) {
    // The look lives in src/render/; re-copy it (and public/) so a template edit reaches the
    // scaffold. Everything else, including the stamped config and the install, stays.
    await rm(path.join(target, "src/render"), { recursive: true, force: true });
    await cp(path.join(TEMPLATE, "src/render"), path.join(target, "src/render"), {
      recursive: true,
    });
    await cp(path.join(TEMPLATE, "public"), path.join(target, "public"), { recursive: true });
    await patchScaffold(target, false, baseline);
    return target;
  }
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  const packageSources = await packageLocalFramework(work);
  await createProject(
    { install: true, packageSources, target: "starter", template: "starter" },
    work,
  );
  await patchScaffold(target, true, baseline);
  await writeFile(stampFile, stamp);
  return target;
}

export function freePort(): Promise<number> {
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

export async function waitForServer(url: string, server: ChildProcess): Promise<void> {
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

export const HIDE_UI = `body * { visibility: hidden !important; }
[data-threenative-canvas], [data-threenative-canvas] * { visibility: visible !important; }`;

export async function captureThreeNative(options: IThreeNativeCaptureOptions): Promise<number> {
  const poses = JSON.parse(await readFile(path.join(REFERENCE, "poses.json"), "utf8")) as IPoses;
  const work =
    process.env.TN_UNREAL_LOOK_WORK ?? path.join(os.homedir(), ".cache/threenative/unreal-look");
  const target = await scaffold(work, options.reuse, options.baseline === true);
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
    const [width, height] = options.size ?? poses.resolution;
    const browser = await launchWebgpuBrowser();
    try {
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
      const errors: string[] = [];
      const passes = process.env.TN_UNREAL_LOOK_GPU_PASSES === "1";
      if (passes) await page.addInitScript(GPU_PASSES);
      // A still holds the loop to land on one jitter phase (jitterPhase.ts); a measured cell keeps the browser's frames.
      if (options.measureSeconds === undefined) await page.addInitScript(FRAME_GATE);
      const exposure = watchExposure(page);
      // The frame meter prints to the console; a measured cell keeps the windows between two marks.
      let meter: string[] = [];
      page.on("console", (message) => {
        if (message.text().startsWith("TN_FRAME_BUDGET")) meter.push(message.text());
        if (RENDERER_LOST.test(message.text())) errors.push(message.text());
        errors.push(...stageBuildFailures(message.text()));
      });
      page.on("pageerror", (error) => errors.push(error.message));
      // Engine markers that say whether a stage ran (probe bake, refusals) belong in the capture log.
      page.on("console", (message) => {
        if (
          message.type() === "error" ||
          message.type() === "warning" ||
          /^(TN_(WORLD_ENVIRONMENT|INDIRECT_LIGHT|PROBE_VOLUME|REFLECTION_CAPTURE|NATIVE_|RENDER_CHAIN|SSR|SSGI|GI_CACHE|SKY_OCCLUSION|AUTO_EXPOSURE|VIRTUAL_SHADOW)|GPU sky|CPU environment sky)/.test(
            message.text(),
          )
        )
          console.info(`page: ${message.text().slice(0, 1500)}`);
      });
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
          const started = Date.now();
          await page.goto(
            `${origin}?tnRef=${layer}&sun=${sun.elevationDeg},${sun.azimuthDeg}${options.baseline ? "&baseline=1" : ""}${options.off ? `&off=${options.off}` : ""}${process.env.TN_UNREAL_LOOK_QUERY ?? ""}`,
            {
              waitUntil: "domcontentloaded",
            },
          );
          await page.addStyleTag({ content: HIDE_UI });
          // The GI cache bake runs inside startup: 110-250 s measured, longer on a loaded host.
          await page.waitForSelector('[data-threenative-startup="ready"]', { timeout: 600_000 });
          const readyMs = Date.now() - started;
          await page.waitForFunction(() => "__tnRef" in window, undefined, { timeout: 240_000 });
          // Page start to the scene being ready; the GI cache bake (TN_GI_CACHE) runs inside this.
          console.info(
            `TN_UNREAL_LOOK startup layer=${layer} ready=${readyMs}ms scene=${Date.now() - started}ms`,
          );
          // A progressive GI bake shows a provisional cache first; a capture is of the converged one.
          await page.waitForFunction(
            () =>
              (window as never as { __tnRef: { giConverged?: boolean } }).__tnRef.giConverged !==
              false,
            undefined,
            {
              timeout: 900_000,
            },
          );
          if (options.measureSeconds === undefined)
            console.info(`TN_UNREAL_LOOK converged layer=${layer} after=${Date.now() - started}ms`);
          const engine = await page.evaluate("window.__tnRef.engine");
          if (engine !== "threenative")
            throw new Error(`TN_UNREAL_LOOK_WRONG_ENGINE: ${layer} drew on ${String(engine)}`);
          if (count === 0) console.info(`TN_UNREAL_LOOK engine=${engine}`);
          for (const pose of wanted) {
            const poseAt = Date.now();
            await page.evaluate((p) => {
              (window as unknown as { __tnRef: { pose(p: unknown): void } }).__tnRef.pose(p);
            }, pose);
            // Let the chain, its denoisers and the shadow map settle on the new view.
            // Auto exposure (L9) closes at 1 stop/s like Unreal's: give it about 8 s to land.
            const settle = layer === "L9" ? 480 : 45;
            // A string, because tsx names the inner arrow functions with a helper the page lacks.
            await page.evaluate(
              `new Promise((resolve) => { let n = 0; const tick = () => (++n >= ${settle} ? resolve() : requestAnimationFrame(tick)); requestAnimationFrame(tick); })`,
            );
            // The frame count above is a floor: a frame is taken once the readings say the exposure came to rest
            // (two runs of one cell otherwise differ by the distance each stopped short, PRD-631).
            const metered = metersExposure({
              baseline: options.baseline,
              layer,
              measureSeconds: options.measureSeconds,
              switches: `${options.off ?? ""}${process.env.TN_UNREAL_LOOK_QUERY ?? ""}`,
            });
            if (metered)
              console.info(
                `TN_UNREAL_LOOK exposure ${pose.name} at rest after ${await awaitExposureSettled(page, exposure, poseAt)} ms of waiting`,
              );
            if (errors.length > 0)
              throw new Error(`TN_UNREAL_LOOK_PAGE_ERROR: ${errors.join(" | ")}`);
            const name = layer === "ID" ? `ID_${pose.name}` : `${layer}_${sun.name}_${pose.name}`;
            // The chain's applied stages and, when temporal AA runs, its reset and history state.
            console.info(
              `TN_UNREAL_LOOK debug ${name} ${JSON.stringify(await page.evaluate("window.__tnRef.debug()"))}`,
            );
            if (options.measureSeconds !== undefined) {
              meter = [];
              if (passes) {
                const rows = await readPasses(page, options.measureSeconds);
                await mkdir(path.join(options.out, layer), { recursive: true });
                await writeFile(
                  path.join(options.out, layer, `${name}.gpu-passes.json`),
                  `${JSON.stringify(rows ?? null, null, 2)}\n`,
                );
              } else await page.waitForTimeout(options.measureSeconds * 1000);
              const log = path.join(options.out, layer, `${name}.frame-budget.log`);
              await mkdir(path.dirname(log), { recursive: true });
              await writeFile(log, `${meter.join("\n")}\n`);
              console.info(`TN_UNREAL_LOOK measured ${name} windows=${meter.length} log=${log}`);
              count += 1;
              continue;
            }
            const file = path.join(options.out, layer, `${name}.png`);
            await mkdir(path.dirname(file), { recursive: true });
            await atFixedJitterPhase(
              page,
              async () => writeFile(file, await page.screenshot({ type: "png" })),
              { minSteps: metered ? SETTLE_STEPS : MIN_STEPS },
            );
            // A device lost while the frame was held leaves a black PNG: the frame fails, it is not kept.
            if (errors.length > 0)
              throw new Error(`TN_UNREAL_LOOK_PAGE_ERROR: ${errors.join(" | ")}`);
            // Names the cell the preceding page: TN_AUTO_EXPOSURE reports belong to.
            console.info(`TN_UNREAL_LOOK cell ${name}`);
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
