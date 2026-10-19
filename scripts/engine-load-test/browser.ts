// Shared browser plumbing for the PRD-117 web arms. Both arms park a §5.1 run report on
// `window.__ENGINE_LOAD_TEST__`; this file opens the page, waits, and hands the object back.
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import path from "node:path";
import { chromium } from "@playwright/test";
import { PNG } from "pngjs";
import { downscaleFrame } from "../../examples/engine-load-test/src/frame-read.js";
import {
  DEFAULT_AXES,
  canonicalPlacementBytes,
  createPlacements,
  culledOffsetX,
  positionHash,
} from "../../examples/engine-load-test/src/workload.js";
import {
  PERFORMANCE_BROWSER_ARGS,
  WEBGPU_BROWSER_ARGS,
  softwareAdapterName,
} from "../../packages/playtest/src/runner/browser.js";
import type { IRunReport } from "./report.js";

// Vsync is disabled on both arms rather than pinned on both: under vsync a frame needing 17 ms of
// work presents at 33 ms, so the knee would report which side of a 16.7 ms boundary an engine
// landed on instead of what it cost. See the deviation note in the verification document.
// `--ozone-platform=x11` is deliberately absent: forcing X11 on this machine drops WebGPU to
// SwiftShader, and a software rasteriser is not what either engine ships to a browser tab.
export const BENCH_BROWSER_ARGS = [
  "--enable-unsafe-webgpu",
  "--disable-gpu-sandbox",
  "--ignore-gpu-blocklist",
  "--disable-gpu-vsync",
  "--disable-frame-rate-limit",
  "--autoplay-policy=no-user-gesture-required",
] as const;

/**
 * `--browser-recipe webgpu` is the playtest runner's recipe (X11 ozone and Vulkan on, uncapped): the one that
 * reaches a real Linux Vulkan driver on an X display (the Debian laptop's Xwayland), where the default args
 * land on SwiftShader. Every web arm of a run takes the same args.
 */
export function browserLaunchArgs(
  waylandDisplay: string | undefined,
  recipe = recipeFlag(process.argv),
): string[] {
  if (recipe === "webgpu")
    return [
      ...WEBGPU_BROWSER_ARGS,
      ...PERFORMANCE_BROWSER_ARGS,
      "--autoplay-policy=no-user-gesture-required",
    ];
  if (recipe !== undefined)
    throw new Error(`TN_BENCH_BAD_FLAG: unknown --browser-recipe ${recipe}`);
  return waylandDisplay
    ? [...BENCH_BROWSER_ARGS, "--ozone-platform=wayland"]
    : [...BENCH_BROWSER_ARGS];
}

function recipeFlag(argv: readonly string[]): string | undefined {
  const index = argv.indexOf("--browser-recipe");
  return index === -1 ? undefined : argv[index + 1];
}

const MIME: Record<string, string> = {
  ".css": "text/css",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".json": "application/json",
  ".pck": "application/octet-stream",
  ".png": "image/png",
  ".wasm": "application/wasm",
};

export interface IDriveOptions {
  onConsole?: (text: string) => void;
  timeoutMs: number;
  url: string;
}

// Playwright's bundled Chromium has no hardware WebGPU here; a system Chromium does. Both arms
// run in whichever binary this resolves to, so neither can be handed a better one than the other.
export function benchBrowserPath(): string | undefined {
  const override = process.env.BENCH_BROWSER_BIN;
  if (override !== undefined && override.length > 0) return override;
  for (const candidate of [
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    `${process.env.HOME ?? ""}/.local/bin/brave`,
    "/usr/bin/brave",
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

// A hardware pilot is the point of this arm, and a software rasteriser answers just as
// successfully as a GPU: the page loads, the ladder runs, and the numbers are a CPU's. Naming the
// adapter is not enough when the arm exists to be compared, so the collector refuses one.
export function assertHardwareAdapter(adapter: string): string {
  const software = softwareAdapterName({ adapter });
  if (software !== undefined) throw new Error(`TN_BENCH_SOFTWARE_ADAPTER: ${software}`);
  return adapter;
}

// Two things `parseRunReport` cannot know, and only this collector sees. The adapter: a hardware
// pilot is the point of this arm, and a software rasteriser answers as successfully as a GPU, so a
// control measured on one is not a control. The legacy `positionHash` is recomputed from the
// shared workload here. It covers the first eight placements only. Every initial built placement
// is checked below; complete geometry/material/camera fixture identity is still an open gate.
export function assertBrowserPlacements(report: IRunReport): IRunReport {
  for (const rung of report.rungs) {
    const placements = createPlacements(rung.objectCount);
    const fraction = report.axes?.visibleFraction ?? DEFAULT_AXES.visibleFraction;
    const round = rung.mode === "L2" ? Math.fround : (value: number) => value;
    const digest = createHash("sha256")
      .update(
        canonicalPlacementBytes(rung.objectCount, (index) => {
          const placement = placements[index];
          if (placement === undefined) throw new Error(`TN_BENCH_PLACEMENT_MISSING:${index}`);
          const x = placement.x + culledOffsetX(index, fraction);
          return { x: round(x), y: round(placement.y), z: round(placement.z) };
        }),
      )
      .digest("hex");
    if (rung.initialPlacementSha256 !== digest)
      throw new Error(
        `TN_BENCH_PLACEMENT_MISMATCH: ${rung.mode}@${rung.objectCount} built ${rung.initialPlacementSha256 ?? "missing"}, expected ${digest}`,
      );
  }
  return report;
}

export function assertPlainThreePilot(report: IRunReport): IRunReport {
  assertHardwareAdapter(report.driver.adapter);
  for (const rung of report.rungs) {
    const expected = positionHash(createPlacements(rung.objectCount));
    if (rung.positionHash !== expected)
      throw new Error(
        `TN_BENCH_SCENE_MISMATCH: ${rung.objectCount} objects hashed ${rung.positionHash}, the workload hashes ${expected}`,
      );
  }
  return assertBrowserPlacements(report);
}

export async function driveBenchmarkPage(options: IDriveOptions): Promise<unknown> {
  const browser = await chromium.launch({
    args: browserLaunchArgs(process.env.WAYLAND_DISPLAY),
    executablePath: benchBrowserPath(),
    headless: false,
  });
  try {
    const page = await browser.newPage({ viewport: { height: 900, width: 1440 } });
    page.on("console", (message) => options.onConsole?.(`${message.type()}: ${message.text()}`));
    page.on("pageerror", (error) => options.onConsole?.(`pageerror: ${error.message}`));
    // A console 404 names no URL; the response does.
    page.on("response", (response) => {
      if (response.status() >= 400)
        options.onConsole?.(`http ${response.status()}: ${response.url()}`);
    });
    // The driver awaits this only after closing a rung's timed window, before changing the scene.
    await page.exposeFunction("__TN_BENCH_CAPTURE__", async () => {
      const image = PNG.sync.read(await page.locator("canvas").first().screenshot({ type: "png" }));
      const small = new PNG({ width: 160, height: 90 });
      small.data = Buffer.from(downscaleFrame(image.data, image.width, image.height));
      return PNG.sync.write(small).toString("base64");
    });
    await page.goto(options.url, { timeout: 120_000, waitUntil: "load" });
    const deadline = Date.now() + options.timeoutMs;
    while (Date.now() < deadline) {
      const state = (await page.evaluate(() => {
        const scope = globalThis as unknown as Record<string, unknown>;
        return {
          error: scope.__ENGINE_LOAD_TEST_ERROR__ ?? null,
          report: scope.__ENGINE_LOAD_TEST__ ?? null,
        };
      })) as { error: unknown; report: unknown };
      if (state.error !== null) throw new Error(`TN_BENCH_ARM_FAILED: ${String(state.error)}`);
      if (state.report !== null) return state.report;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error(`TN_BENCH_TIMEOUT: no report after ${options.timeoutMs} ms at ${options.url}`);
  } finally {
    await browser.close();
  }
}

// Godot's threaded web export refuses to start without cross-origin isolation, so the static
// server always sends the two headers rather than making the export type decide.
export async function serveDirectory(root: string, port: number): Promise<Server> {
  const server = createServer((request, response) => {
    const requested = decodeURIComponent((request.url ?? "/").split("?")[0] as string);
    const relative = requested === "/" ? "/index.html" : requested;
    const file = path.join(root, path.normalize(relative).replace(/^(\.\.[/\\])+/, ""));
    void (async () => {
      try {
        const info = await stat(file);
        if (!info.isFile()) throw new Error("not a file");
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Length": info.size,
          "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
          "Cross-Origin-Embedder-Policy": "require-corp",
          "Cross-Origin-Opener-Policy": "same-origin",
        });
        createReadStream(file).pipe(response);
      } catch {
        response.writeHead(404).end("not found");
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return server;
}

export function startProcess(command: string, args: readonly string[], cwd: string): ChildProcess {
  return spawn(command, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

export async function waitForUrl(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // The server has not started listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`TN_BENCH_SERVER_TIMEOUT: ${url} never became ready`);
}
