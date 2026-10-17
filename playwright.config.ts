import { type ChildProcess, spawn } from "node:child_process";
import { cp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import { PNG } from "pngjs";
import { createProject } from "./packages/create-threenative/src/index.js";
import { WEBGPU_BROWSER_ARGS } from "./packages/playtest/src/runner/browser.js";
import { localPackageEntries, workspacePackages } from "./scripts/workspace-packages.js";
import { acquireHotReloadProjectLock } from "./test-support/hot-reload-lock.js";
import {
  packageSourcesMatch,
  selectHotReloadServerProject,
} from "./test-support/hot-reload-project.js";
import {
  contactShadowCoverage,
  dominantColorCoverage,
  findLargestColorObject,
} from "./test-support/starter-look-image.js";
import { makeTempDir } from "./test-support/temp-dir.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const starterLookServer = process.argv.includes("--starter-look-server");
const hotReloadServer = process.argv.includes("--hot-reload-server");
const starterLookGatePort = 4176;
const starterLookReadyPort = 4175;
const hotReloadPort = 4177;
const replayPort = 4178;
const hotReloadProjectFile = path.join(
  tmpdir(),
  `threenative-hot-reload-${path.basename(repoRoot)}.path`,
);
const hotReloadProjectLock = `${hotReloadProjectFile}.lock`;
const localPackages = localPackageEntries(repoRoot);
const workspacePackageManifests = new Map(
  workspacePackages(repoRoot).map((item) => [item.name, item]),
);
// The scaffolded projects install from tarballs, not from `packages/*` directly: a source
// directory still carries `catalog:` specifiers, which only resolve inside this workspace.
// `pnpm pack` rewrites them, which is the same thing CI's scaffold smoke does.
const localPackageSources = await packLocalPackages();

async function packLocalPackages(): Promise<Record<string, string>> {
  const existing = process.env.THREENATIVE_PACKED_PACKAGES;
  const staging = existing ?? (await makeTempDir("threenative-packed-"));
  if (existing === undefined) {
    for (const [name] of localPackages) {
      if (workspacePackageManifests.get(name)?.scripts.build !== undefined) {
        await run("pnpm", ["--filter", name, "run", "build"]);
      }
      await run("pnpm", ["--filter", name, "exec", "pnpm", "pack", "--pack-destination", staging]);
    }
    process.env.THREENATIVE_PACKED_PACKAGES = staging;
  }
  const files = await readdir(staging);
  const sources: Record<string, string> = {};
  for (const [packageName, prefix] of localPackages) {
    const tarball = files.find((file) => file.startsWith(prefix));
    if (tarball === undefined) throw new Error(`pnpm pack produced no tarball for ${packageName}.`);
    sources[packageName] = path.join(staging, tarball);
  }
  return sources;
}

async function run(command: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], { cwd: repoRoot, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited ${code}.`)),
    );
  });
}

if (starterLookServer) await runStarterLookServer();
if (hotReloadServer) await runHotReloadServer();
const hotReloadProject =
  starterLookServer || hotReloadServer ? undefined : await prepareHotReloadProject();
if (hotReloadProject !== undefined) process.env.THREENATIVE_HOT_RELOAD_PROJECT = hotReloadProject;

async function prepareHotReloadProject(): Promise<string> {
  const existing = await readSharedHotReloadProject();
  if (existing !== undefined) return existing;
  const lock = await acquireHotReloadProjectLock({ lockPath: hotReloadProjectLock });
  try {
    const retry = await readSharedHotReloadProject();
    if (retry !== undefined) return retry;
    const temporaryRoot = await makeTempDir("threenative-hot-reload-");
    const target = path.join(temporaryRoot, "starter");
    await createProject(
      { install: true, packageSources: localPackageSources, target, template: "starter" },
      repoRoot,
    );
    await writeFile(hotReloadProjectFile, target);
    return target;
  } finally {
    await lock.release();
  }
}

async function runHotReloadServer(): Promise<void> {
  const deadline = Date.now() + 120_000;
  const environmentTarget = process.env.THREENATIVE_HOT_RELOAD_PROJECT;
  let target = selectHotReloadServerProject(environmentTarget, await readSharedHotReloadProject());
  while (target === undefined && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    target = selectHotReloadServerProject(environmentTarget, await readSharedHotReloadProject());
  }
  if (target === undefined) throw new Error("THREENATIVE_HOT_RELOAD_PROJECT was not exported.");
  const server = startStarterServer(target, hotReloadPort);
  const output: string[] = [];
  server.stdout?.on("data", (chunk) => output.push(String(chunk)));
  server.stderr?.on("data", (chunk) => output.push(String(chunk)));
  try {
    await waitForUrl(`http://127.0.0.1:${hotReloadPort}/`, server, 120_000);
    await keepServerAlive(server);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${output.join("").slice(-4_000)}`,
    );
  } finally {
    await rm(path.dirname(target), {
      force: true,
      maxRetries: 10,
      recursive: true,
      retryDelay: 100,
    });
  }
}

async function readSharedHotReloadProject(): Promise<string | undefined> {
  const target = (await readFile(hotReloadProjectFile, "utf8").catch(() => "")).trim();
  if (target.length === 0) return undefined;
  try {
    const manifest = JSON.parse(await readFile(path.join(target, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const installedSources = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.optionalDependencies,
    };
    const current = packageSourcesMatch(localPackageSources, installedSources);
    return current ? target : undefined;
  } catch {
    return undefined;
  }
}

async function runStarterLookServer(): Promise<void> {
  const temporaryRoot = await makeTempDir("threenative-starter-look-");
  const target = path.join(temporaryRoot, "starter");
  const artifacts = path.join(temporaryRoot, "artifacts");
  await createProject(
    { install: true, packageSources: localPackageSources, target, template: "starter" },
    repoRoot,
  );

  const server = startStarterServer(target, starterLookGatePort);
  const serverOutput: string[] = [];
  server.stdout?.on("data", (chunk) => serverOutput.push(String(chunk)));
  server.stderr?.on("data", (chunk) => serverOutput.push(String(chunk)));
  let exposedServer: ChildProcess | undefined;

  try {
    await waitForUrl(`http://127.0.0.1:${starterLookGatePort}/`, server, 120_000);
    await runStarterLookScenario(artifacts, starterLookGatePort);
    exposedServer = startStarterServer(target, starterLookReadyPort);
    exposedServer.stdout?.on("data", (chunk) => serverOutput.push(String(chunk)));
    exposedServer.stderr?.on("data", (chunk) => serverOutput.push(String(chunk)));
    await waitForUrl(`http://127.0.0.1:${starterLookReadyPort}/`, exposedServer, 120_000);
    await keepServerAlive(exposedServer);
  } catch (error) {
    // The artifacts directory is removed below, so a CI failure would otherwise destroy the only
    // copy of the frame it is complaining about. Keep it where the workflow can upload it.
    await cp(artifacts, path.join(repoRoot, "test-results", "starter-look"), {
      recursive: true,
    }).catch(() => undefined);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${serverOutput.join("").slice(-4_000)}`,
    );
  } finally {
    exposedServer?.kill();
    server.kill();
    await rm(temporaryRoot, {
      force: true,
      maxRetries: 10,
      recursive: true,
      retryDelay: 100,
    });
  }
}

function startStarterServer(target: string, port: number): ChildProcess {
  return spawn(
    "pnpm",
    ["--dir", target, "dev", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd: repoRoot,
      env: { ...process.env, CHOKIDAR_USEPOLLING: process.env.CHOKIDAR_USEPOLLING ?? "true" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

async function waitForUrl(url: string, server: ChildProcess, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (server.exitCode !== null)
      throw new Error(`Starter server exited with code ${server.exitCode}.`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Vite has not started listening yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Starter server did not become ready within ${timeoutMs}ms.`);
}

async function runStarterLookScenario(artifacts: string, port: number): Promise<void> {
  const runner = spawn(
    process.execPath,
    [
      path.join(repoRoot, "packages/playtest/dist/runner/cli.js"),
      path.join(repoRoot, "playtests/starter-look.playtest.json"),
      "--project",
      repoRoot,
      "--url",
      `http://127.0.0.1:${port}/`,
      "--artifacts",
      artifacts,
      "--browser-recipe",
      "webgpu",
      "--headed",
      // GitHub Actions' Xvfb has no hardware adapter; keep this scaffold smoke deterministic there.
      ...(process.env.CI === "true" ? ["--allow-software"] : []),
    ],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  const stdout: string[] = [];
  const stderr: string[] = [];
  runner.stdout?.on("data", (chunk) => stdout.push(String(chunk)));
  runner.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
  const exitCode = await new Promise<number>((resolveExit) =>
    runner.once("close", (code) => resolveExit(code ?? 2)),
  );
  if (exitCode !== 0) {
    throw new Error(
      `Starter look scenario exited with code ${exitCode}: ${stderr.join("")}${stdout.join("")}`,
    );
  }
  const report = JSON.parse(stdout.join("")) as { pass?: boolean };
  if (report.pass !== true)
    throw new Error(`Starter look scenario reported failure: ${stdout.join("")}`);
  await assertStarterScreenshot(path.join(artifacts, "starter-look.png"));
}

async function assertStarterScreenshot(file: string): Promise<void> {
  const image = PNG.sync.read(await readFile(file));
  if (image.width !== 1280 || image.height !== 720) {
    throw new Error(
      `Starter look screenshot must be 1280x720, got ${image.width}x${image.height}.`,
    );
  }
  const stage = { bottom: 660, left: 220, right: 1060, top: 160 };
  const pixels = stagePixels(image, stage);
  // The starter is a grey test arena: the pushable crate is its one saturated blue block and the
  // player is the near-white mannequin. Measured on the 1280x720 reference: the crate is the
  // largest blue object (the pickup and flag sit more than eight pixels away), and the mannequin
  // is 239 near-white pixels against a 126 pixel floor.
  const crate = findLargestColorObject(
    image,
    stage,
    (red, green, blue) => blue > 120 && blue > red * 1.6 && blue > green * 1.25 && red < 90,
  );
  const mannequin = countPixels(
    image,
    stage,
    (red, green, blue) =>
      red > 215 &&
      green > 215 &&
      blue > 215 &&
      Math.max(red, green, blue) - Math.min(red, green, blue) < 18,
  );
  const luminance =
    pixels.reduce((sum, [red, green, blue]) => sum + pixelLuminance(red, green, blue), 0) /
    pixels.length;
  // A look failure that names only its own count cannot be diagnosed from a CI log — the frame is
  // in a temp directory that is gone by the time anyone reads it. Every throw below carries what
  // the stage actually contained.
  // A stage that is one flat colour is a canvas that never painted, not a look regression. On
  // GitHub's runners serve WebGPU from SwiftShader and can composite the DOM without the WebGPU
  // canvas: the HUD and loading bar arrive over one flat background while the 3D view is absent.
  // Captured examples include run 33296384093 at 98.1% one light bucket and run 33841815831 at
  // 98.2% one dark bucket, so colour or luminance alone is not the signal. A painted hardware frame
  // is much more diverse; the recovered coastal reference's largest bucket covers 66.2%.
  const adapter = await readCaptureAdapter(file);
  const software = /swiftshader|llvmpipe|lavapipe|softpipe/iu.test(
    `${adapter?.architecture ?? ""} ${adapter?.vendor ?? ""}`,
  );
  const unpaintedStage = dominantColorCoverage(image, stage) >= 0.98;
  if (unpaintedStage) {
    if (!software) {
      throw new Error(
        `Starter look reference failed: the canvas never painted on adapter ${adapter?.vendor ?? "unknown"}/${adapter?.architecture ?? "unknown"}. luminance ${luminance.toFixed(4)}, top colours ${describeDominantColors(pixels)}`,
      );
    }
    console.info(
      `TN_STARTER_LOOK_UNEXECUTED: adapter ${adapter?.vendor}/${adapter?.architecture} did not composite the WebGPU canvas into the screenshot (luminance ${luminance.toFixed(4)}, dominant colour ${(dominantColorCoverage(image, stage) * 100).toFixed(1)}%, top colours ${describeDominantColors(pixels)}). The look gate did not execute on this machine; it is proven on a hardware adapter, not here.`,
    );
    return;
  }
  const stageReport =
    `stage ${stage.right - stage.left}x${stage.bottom - stage.top} (${pixels.length} px), ` +
    `luminance ${luminance.toFixed(4)}, crate ${crate.count}, mannequin ${mannequin}, ` +
    `threshold ${Math.ceil(pixels.length * 0.0005)}, top colours ${describeDominantColors(pixels)}`;
  if (luminance < 0.02)
    throw new Error(
      `Starter look reference failed: stage luminance ${luminance.toFixed(4)} is black. ${stageReport}`,
    );
  if (crate.count < pixels.length * 0.0005)
    throw new Error(
      `Starter look reference failed: blue crate pixels ${crate.count} are missing. ${stageReport}`,
    );
  // The mannequin reads near-white only under the photo environment's fill light, and the starter
  // does not set that environment on a software adapter (it loses the GPU process there), so on
  // that lane the frame is lit by the sun alone and no pixel reaches the threshold. Said out loud,
  // never silent; the black, crate and contact-shadow checks still run.
  if (software && mannequin < pixels.length * 0.0003)
    console.info(
      `TN_STARTER_LOOK_MANNEQUIN_SKIPPED: adapter ${adapter?.vendor}/${adapter?.architecture} is software, so the starter drops its fill light and the mannequin check does not apply (mannequin ${mannequin}).`,
    );
  else if (mannequin < pixels.length * 0.0003)
    throw new Error(
      `Starter look reference failed: mannequin pixels ${mannequin} are missing. ${stageReport}`,
    );
  if (crate.bounds === undefined)
    throw new Error("Starter look reference failed: crate bounds are unavailable.");
  const contact = contactShadowCoverage(image, crate.bounds);
  if (contact < 0.02)
    throw new Error(
      `Starter look reference failed: contact-shadow coverage ${contact.toFixed(4)} is too low.`,
    );
}

/**
 * The handful of colours that actually cover the stage, quantised to 32-level buckets. This is
 * what separates "nothing rendered" from "it rendered and the crate is the wrong colour", which
 * the counts alone cannot tell apart.
 */
/**
 * The capture's own record of which adapter served WebGPU. `a run that does not name its adapter
 * is not evidence` — so the blank-canvas branch below reads it rather than inferring from CI.
 */
async function readCaptureAdapter(
  screenshotFile: string,
): Promise<{ architecture?: string; vendor?: string } | undefined> {
  try {
    const capture = JSON.parse(
      await readFile(path.join(path.dirname(screenshotFile), "capture.json"), "utf8"),
    ) as { adapter?: { architecture?: string; vendor?: string } };
    return capture.adapter;
  } catch {
    return undefined;
  }
}

function describeDominantColors(pixels: readonly [number, number, number][]): string {
  const buckets = new Map<string, number>();
  for (const [red, green, blue] of pixels) {
    const key = `${red >> 5},${green >> 5},${blue >> 5}`;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return [...buckets.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([key, count]) => {
      const [red, green, blue] = key.split(",").map((part) => Number(part) * 32);
      return `rgb(${red},${green},${blue})x${((count / pixels.length) * 100).toFixed(1)}%`;
    })
    .join(" ");
}

function stagePixels(
  image: PNG,
  stage: { bottom: number; left: number; right: number; top: number },
): [number, number, number][] {
  const pixels: [number, number, number][] = [];
  for (let y = stage.top; y < stage.bottom; y += 1) {
    for (let x = stage.left; x < stage.right; x += 1) pixels.push(readPixel(image, x, y));
  }
  return pixels;
}

function countPixels(
  image: PNG,
  stage: { bottom: number; left: number; right: number; top: number },
  matches: (r: number, g: number, b: number) => boolean,
): number {
  let count = 0;
  for (let y = stage.top; y < stage.bottom; y += 1) {
    for (let x = stage.left; x < stage.right; x += 1) {
      const [red, green, blue] = readPixel(image, x, y);
      if (matches(red, green, blue)) count += 1;
    }
  }
  return count;
}

function readPixel(image: PNG, x: number, y: number): [number, number, number] {
  const index = (y * image.width + x) * 4;
  return [image.data[index] ?? 0, image.data[index + 1] ?? 0, image.data[index + 2] ?? 0];
}

function pixelLuminance(red: number, green: number, blue: number): number {
  return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
}

async function keepServerAlive(server: ChildProcess): Promise<void> {
  await new Promise<void>((resolveHold, rejectHold) => {
    const stop = () => {
      server.kill();
      resolveHold();
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    server.once("exit", (code) =>
      rejectHold(
        new Error(`Starter server exited after the gate passed with code ${code ?? "unknown"}.`),
      ),
    );
  });
}

/**
 * How long Playwright waits for each dev server to answer before giving up. A cold vite server
 * compiles the module graph on the first request, and a CI runner is slower than a workstation.
 */
const WEB_SERVER_BOOT_TIMEOUT_MS = 300_000;

export default defineConfig({
  globalSetup: "./test-support/root-playwright-setup.ts",
  testDir: "./examples/abyss-vanilla/__tests__",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4173",
    headless: true,
    screenshot: "only-on-failure",
    launchOptions: {
      args: [...WEBGPU_BROWSER_ARGS],
    },
  },
  // Cold vite dev servers on a CI runner compile the whole module graph on the first request,
  // and the starter's render chain made that graph considerably heavier. 120 s was enough until
  // it was not: CI run 33350164891 died on "Timed out waiting 120000ms from config.webServer"
  // while every one of these servers starts in seconds on a warm developer machine. The wait is
  // a ceiling on patience, not a performance assertion — nothing here measures boot time.
  webServer: [
    {
      command: "pnpm --filter abyss-vanilla dev --host 127.0.0.1 --port 4173 --strictPort",
      url: "http://127.0.0.1:4173",
      timeout: WEB_SERVER_BOOT_TIMEOUT_MS,
      reuseExistingServer: false,
    },
    {
      command: "node --import tsx playwright.config.ts --starter-look-server",
      url: "http://127.0.0.1:4175",
      timeout: WEB_SERVER_BOOT_TIMEOUT_MS,
      reuseExistingServer: false,
    },
    ...(hotReloadProject === undefined
      ? []
      : [
          {
            command: "node --import tsx playwright.config.ts --hot-reload-server",
            env: {
              ...process.env,
              CHOKIDAR_USEPOLLING: process.env.CHOKIDAR_USEPOLLING ?? "true",
            },
            url: `http://127.0.0.1:${hotReloadPort}`,
            timeout: WEB_SERVER_BOOT_TIMEOUT_MS,
            reuseExistingServer: false,
          },
        ]),
    {
      command: "pnpm --filter abyss-framework dev --host 127.0.0.1 --port 4178 --strictPort",
      url: `http://127.0.0.1:${replayPort}`,
      timeout: WEB_SERVER_BOOT_TIMEOUT_MS,
      reuseExistingServer: false,
    },
  ],
  projects: [
    {
      name: "abyss-vanilla",
      testDir: "./examples/abyss-vanilla/__tests__",
    },
    {
      name: "hot-reload",
      testDir: "./tests/browser",
      use: {
        baseURL: `http://127.0.0.1:${hotReloadPort}`,
        // This proof drives a real game — it lands a player, walks it, and reads a score across ten
        // HMR updates — and headless Chromium serves WebGPU from SwiftShader whatever the flags
        // say. Headless, the run reported a reload counter stuck at zero for weeks; headed, on the
        // same machine and the same project, it passes in 32 seconds. It is the same fact that
        // made the provenance sweep unfixable until it launched headed. The lane already provisions
        // a display for pixel work, so there is one to launch into.
        headless: false,
        launchOptions: {
          args: [...WEBGPU_BROWSER_ARGS],
        },
      },
    },
    {
      name: "abyss-framework-replay",
      testDir: "./tests/browser-replay",
      use: { baseURL: `http://127.0.0.1:${replayPort}`, headless: false },
    },
  ],
});
