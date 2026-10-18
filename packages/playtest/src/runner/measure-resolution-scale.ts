import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { WEBGPU_BROWSER_ARGS } from "./browser.js";
import { provideDisplay } from "./captureEnvironment.js";
import { acquireRunnerCaptureLock } from "./runner-support.js";
import { PlaywrightTransport, bridgeWaitTimeoutMs } from "./bridgeClient.js";
import { waitForStartupReady } from "./startupReady.js";
import {
  resolutionScaleFrame,
  preserveResolutionScaleFailure,
  resolutionScaleGate,
  resolutionScalePending,
} from "./resolution-scale-probe.js";
import { PLAYTEST_STARTUP_READY_TIMEOUT_MS, type IPlaytestBridgeDescription, type IPlaytestBridgeReady } from "../protocol.js";

import type { ITraceEvent } from "./trace.js";

import type { IResolutionScaleRun, IResolutionScaleRow } from "./resolution-scale-probe.js";

// Use a served starter with resolutionScale pinned to 1; all other render settings stay authored.
const output = resolve(process.argv[2] ?? "artifacts/prd564");
const controlPath = process.env.TN_RESOLUTION_CONTROL_SOURCE;
const controlCode = controlPath === undefined ? undefined : await readFile(controlPath, "utf8");
const control = controlCode === undefined ? undefined : {
  path: resolve(controlPath!), sha256: createHash("sha256").update(controlCode).digest("hex"),
};
const preflightOnly = process.argv[3] === "--preflight";
if (process.argv[3] !== undefined && !preflightOnly)
  throw new Error("Expected --preflight or no mode");
await mkdir(output, { recursive: true });
let checkpointRun = 1;
let checkpointEvidence: Record<string, unknown> = {
  startup: { collected: false }, partial: { collected: false },
};
let checkpointLogs: string[] = [];
const checkpointDisplay: { value?: Awaited<ReturnType<typeof provideDisplay>>["strategy"] } = {};
const checkpoint = async (pendingOperation: string): Promise<void> => {
  await writeFile(resolve(output, `run-${checkpointRun}.json`), JSON.stringify({
    run: checkpointRun, mode: preflightOnly ? "preflight" : "measurement",
    status: "pending", pendingOperation, display: checkpointDisplay.value, ...checkpointEvidence,
  }, null, 2));
  await writeFile(resolve(output, `run-${checkpointRun}.log`), checkpointLogs.join("\n"));
};
const pending = <T>(name: string, operation: () => Promise<T>): Promise<T> =>
  resolutionScalePending(name, checkpoint, operation);
let server: Awaited<ReturnType<typeof serveStarter>> | undefined;
let display: Awaited<ReturnType<typeof provideDisplay>> | undefined;
let browser: Browser | undefined;
let captureLease: Awaited<ReturnType<typeof acquireRunnerCaptureLock>> | undefined;
const measurements: IResolutionScaleRun[] = [];
try {
  const startedServer = await pending("starter.bootstrap", () => serveStarter(output, checkpoint));
  server = startedServer;
  const url = startedServer.resolvedUrls!.local[0]!;
  captureLease = await pending("capture.lease", () => acquireRunnerCaptureLock());
  const providedDisplay = await pending("display.provide", () => provideDisplay());
  display = providedDisplay;
  checkpointDisplay.value = providedDisplay.strategy;
  browser = await pending("browser.launch", () => chromium.launch({
    headless: false,
    args: [
      ...WEBGPU_BROWSER_ARGS,
      "--use-angle=vulkan",
      "--use-vulkan",
      "--disable-vulkan-surface",
      "--no-sandbox",
    ],
    env: providedDisplay.env,
  }));
  for (let run = 1; run <= (preflightOnly ? 1 : 3); run++) {
    checkpointRun = run;
    const logs: string[] = [];
    checkpointLogs = logs;
    const evidence: {
      startup: {
        collected: boolean;
        value?: IPlaytestBridgeReady | Awaited<ReturnType<typeof waitForStartupReady>>;
      };
      partial: { collected: boolean; value?: Record<string, unknown> };
      rows?: IResolutionScaleRow[];
      markers?: ITraceEvent[];
    } = { startup: { collected: false }, partial: { collected: false } };
    checkpointEvidence = evidence;
    const launchedBrowser = browser;
    const context = await pending("browser.context", () => launchedBrowser.newContext({
      viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1,
    }));
    const page = await pending("browser.page", () => context.newPage());
    page.on("console", (message) => logs.push(message.text()));
    page.on("pageerror", (error) => logs.push(`PAGE_ERROR:${error.message}`));
    page.on("requestfailed", (request) =>
      logs.push(`REQUEST_FAILED:${request.url()}:${request.failure()?.errorText}`),
    );
    try {
      await pending("page.goto", () => page.goto(url, { waitUntil: "domcontentloaded", timeout: PLAYTEST_STARTUP_READY_TIMEOUT_MS }));
      const transport = new PlaywrightTransport(page);
      const bootError = async () =>
        (await page.locator("[data-threenative-canvas-error]").allTextContents()).join("\n");
      if (!(await pending("bridge.wait", () => transport.waitForBridge(bridgeWaitTimeoutMs())))) {
        const error = await bootError();
        throw new Error(
          error
            ? `TN_RESOLUTION_BOOT_REJECTED: ${error}`
            : "TN_PLAYTEST_BRIDGE_MISSING: starter did not install its bridge",
        );
      }
      const description = await pending("bridge.describe", () => transport.call<IPlaytestBridgeDescription>(
        "describe",
        undefined,
        bridgeWaitTimeoutMs(),
      ));
      const startup = await pending("startup.ready", () => waitForStartupReady({
        bridge: {
          description,
          readiness: async () => {
            const value = await transport.call<IPlaytestBridgeReady>("ready");
            evidence.startup = { collected: true, value };
            return value;
          },
        },
        pump: async () => {
          const error = await bootError();
          if (error) throw new Error(`TN_RESOLUTION_BOOT_REJECTED: ${error}`);
          await resolutionScaleFrame(page);
        },
      }));
      evidence.startup = { collected: true, value: startup };
      if (startup === undefined)
        throw new Error("TN_PLAYTEST_STARTUP_NOT_READY: starter does not report startup");
      const navigations: string[] = [];
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) navigations.push(frame.url());
      });
      const cdp = await context.newCDPSession(page);
      const markers: ITraceEvent[] = [];
      cdp.on("Tracing.dataCollected", (event: { value?: ITraceEvent[] }) => {
        markers.push(
          ...(event.value ?? []).filter((value) => value.name?.startsWith("TN_RESOLUTION_FRAME:")),
        );
      });
      const traceComplete = new Promise<void>((resolve) =>
        cdp.once("Tracing.tracingComplete", () => resolve()),
      );
      // Reuse the shipped CDP transport, with only markers; no CPU profile/render timeline.
      await cdp.send("Tracing.start", {
        traceConfig: { includedCategories: ["blink.user_timing"], excludedCategories: ["*"] },
        transferMode: "ReportEvents",
      });
      await checkpoint("page.evaluate");
      const observed = await page
        .evaluate<{
          preflight?: {
            adapter: string;
            surface: Record<string, unknown>;
            census: unknown;
            frameBudget: { prototypeObserved: boolean };
            textureBytes: { rgba8unorm: number };
          };
          rows?: IResolutionScaleRow[];
          partial: Record<string, unknown>;
          failure?: { name: string; message: string; stack?: string };
        }>(`(async () => {
        const partial = {};
        try {
        const load = (path) => import(/* @vite-ignore */ path);
        const { default: game } = await load("/src/game.ts");
        const { FrameBudget } = await load("/__resolution-core.js");
        const { installResolutionScaleProbe, assertResolutionScaleContext, assertResolutionScalePreflight, qualifyResolutionScaleBudget, resolutionScaleTextureBytes } = await load("/__resolution-probe.js");
        const mountedCanvas = document.querySelector('[data-threenative-canvas="true"] canvas');
        partial.context = { exists: game.ctx !== undefined, phase: game.ctx?.startup?.phase, mountedCanvasPresent: mountedCanvas !== null, canvasMatches: mountedCanvas !== null && game.ctx?.renderer?.domElement === mountedCanvas };
        const ctx = assertResolutionScaleContext(game.ctx, mountedCanvas);
        partial.context.qualified = true;
        const bytesPerTexel = resolutionScaleTextureBytes(ctx.renderer.raw?.backend?.textureUtils);
        const rgba8unormBytes = bytesPerTexel("rgba8unorm");
        partial.textureBytes = { rgba8unorm: rgba8unormBytes };
        if (rgba8unormBytes !== 4) throw new Error("TN_RESOLUTION_TEXTURE_BYTES_UNQUALIFIED: rgba8unorm did not report 4 bytes");
        await qualifyResolutionScaleBudget(FrameBudget?.prototype, () => new Promise(resolve => requestAnimationFrame(() => resolve())));
        partial.frameBudget = { prototypeObserved: true };
        const surface = ctx.renderer.surface();
        partial.surface = { ...surface, compilingPresent: Object.hasOwn(surface, "compiling") };
        const census = ctx.renderer.pipelineCensus?.();
        partial.census = { collected: true, present: census !== undefined, ...(census === undefined ? {} : { value: census }) };
        partial.adapter = { collected: true, present: census?.adapter?.identity !== undefined, ...(census?.adapter?.identity === undefined ? {} : { identity: census.adapter.identity }) };
        const adapter = assertResolutionScalePreflight(ctx.renderer.kind, surface, census);
        const preflight = { surface, census, adapter, frameBudget: { prototypeObserved: true }, textureBytes: { rgba8unorm: rgba8unormBytes } };
        const rows = ${preflightOnly} ? [] : await installResolutionScaleProbe(
          FrameBudget.prototype,
          ctx.renderer,
          globalThis.GPUDevice.prototype,
          bytesPerTexel,
        );
        if (game.ctx !== ctx) throw new Error("TN_RESOLUTION_CONTEXT_IDENTITY: game context changed during measurement");
        assertResolutionScaleContext(game.ctx, document.querySelector('[data-threenative-canvas="true"] canvas'));
        return { preflight, rows, partial };
        } catch (error) {
          return { partial, failure: { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error), ...(error instanceof Error && error.stack ? { stack: error.stack } : {}) } };
        }
      })()`)
        .catch((error: unknown) => {
          if (navigations.length)
            throw new Error(`TN_RESOLUTION_NAVIGATION: ${navigations.join(", ")}`, {
              cause: error,
            });
          throw error;
        });
      let flushTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            await cdp.send("Tracing.end");
            await traceComplete;
          })(),
          new Promise<never>((_resolve, reject) => {
            flushTimer = setTimeout(() => reject(new Error("TN_RESOLUTION_TRACE_FLUSH_TIMEOUT")), bridgeWaitTimeoutMs());
          }),
        ]);
      } finally {
        clearTimeout(flushTimer);
        await cdp.detach();
      }
      evidence.markers = markers;
      evidence.partial = { collected: true, value: observed.partial };
      if (observed.failure) {
        const error = new Error(observed.failure.message);
        error.name = observed.failure.name;
        if (observed.failure.stack) error.stack = observed.failure.stack;
        throw error;
      }
      if (navigations.length)
        throw new Error(`TN_RESOLUTION_NAVIGATION: ${navigations.join(", ")}`);
      const { preflight, rows = [] } = observed;
      if (control !== undefined && preflight?.surface.resolutionSubrect === true)
        throw new Error("TN_RESOLUTION_CONTROL_INVALID: control installed the subrectangle path");
      evidence.rows = rows;
      const adapter = preflight!.adapter;
      if (logs.some((line) => line.startsWith("PAGE_ERROR:")))
        throw new Error("Browser page errors; inspect raw log");
      if (!preflightOnly) measurements.push({ run, rows });
      // Timing stays unqualified until the host-load observation is independently reviewed.
      const gate =
        !preflightOnly && run === 3 ? resolutionScaleGate(measurements, false) : undefined;
      await writeFile(
        resolve(output, `run-${run}.json`),
        JSON.stringify(
          {
            run,
            mode: preflightOnly ? "preflight" : "measurement",
            display: providedDisplay.strategy,
            startup,
            adapter,
            ...(control === undefined ? {} : { control }),
            preflight,
            rows,
            markers,
            ...(gate === undefined ? {} : { gate }),
          },
          null,
          2,
        ),
      );
      if (preflightOnly) {
        console.info(JSON.stringify({ run, adapter, preflight }));
        continue;
      }
      console.info(
        JSON.stringify({
          run,
          adapter,
          ...(gate === undefined ? {} : { gate }),
          steps: rows.map((row) => ({
            scale: row.scale,
            stepMs: row.frames[0]!.frameMs,
            p50Ms: row.windowP50Ms,
            ratio: row.stepRatio,
            pipelines: row.pipelineBuilds,
            textureBytes: row.textureBytes,
          })),
        }),
      );
    } catch (error) {
      await preserveResolutionScaleFailure(error, () =>
        writeFile(
          resolve(output, `run-${run}.json`),
          JSON.stringify(
            {
              run,
              mode: preflightOnly ? "preflight" : "measurement",
              status: "failed",
              display: providedDisplay.strategy,
              ...evidence,
              error: {
                name: error instanceof Error ? error.name : "Error",
                message: error instanceof Error ? error.message : String(error),
                ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
              },
            },
            null,
            2,
          ),
        ),
      );
    } finally {
      await writeFile(resolve(output, `run-${run}.log`), logs.join("\n"));
      await context.close();
    }
  }
} finally {
  try {
    await browser?.close();
    await display?.release();
    await server?.close();
  } finally {
    await captureLease?.release();
  }
}

async function serveStarter(
  output: string,
  checkpoint: (pendingOperation: string) => Promise<void>,
): Promise<{ resolvedUrls: { local: string[] } | null; close(): Promise<void> }> {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const load = (path: string) => import(path);
  const tooling = createRequire(resolve(repo, "examples/abyss-framework/package.json"));
  await checkpoint("starter.import-vite");
  const { createServer } = await load(tooling.resolve("vite"));
  await checkpoint("starter.import-scaffolder");
  const { createProject } = await load(resolve(repo, "packages/create-threenative/src/index.ts"));
  await checkpoint("starter.create-target");
  // Retain this artifact; fail before overwriting an earlier run's starter project.
  const target = resolve(output, "starter-project");
  await mkdir(target);
  await checkpoint("starter.scaffold");
  await createProject({ target, template: "starter", install: false });
  if (controlCode !== undefined)
    await writeFile(resolve(target, "src/render/worldEnvironment.ts"), controlCode);
  await checkpoint("starter.link-dependencies");
  await mkdir(resolve(target, "node_modules"));
  for (const name of [
    "three",
    "react",
    "react-dom",
    "@threenative",
    "create-threenative",
    "vite",
    "@vitejs",
    "@tailwindcss",
    "tailwindcss",
  ])
    await symlink(
      resolve(repo, "examples/abyss-framework/node_modules", name),
      resolve(target, "node_modules", name),
      "dir",
    );
  await checkpoint("starter.create-server");
  const server = await createServer({
    root: target,
    cacheDir: resolve(target, "node_modules/.vite"),
    plugins: [
      {
        name: "resolution-measurement-fixture",
        resolveId(id: string) {
          if (id.startsWith("/__resolution-")) return id;
        },
        load(id: string) {
          const modules: Record<string, string> = {
            "/__resolution-core.js": "export { FrameBudget } from '@threenative/core';",
            "/__resolution-probe.js": `export { installResolutionScaleProbe, assertResolutionScaleContext, assertResolutionScalePreflight, qualifyResolutionScaleBudget, resolutionScaleTextureBytes } from '${repo}/packages/playtest/src/runner/resolution-scale-probe.ts';`,
          };
          return modules[id];
        },
        transform(code: string, id: string) {
          if (id === resolve(target, "threenative.config.ts")) {
            if (!code.includes('resolutionScale: "auto"'))
              throw new Error("Starter resolutionScale auto pin source is missing");
            return code.replace('resolutionScale: "auto"', "resolutionScale: 1");
          }
        },
      },
    ],
    server: { host: "127.0.0.1", port: 0, fs: { allow: [repo] } },
  });
  await checkpoint("starter.listen");
  try {
    await server.listen();
  } catch (error) {
    await server.close();
    throw error;
  }
  return server;
}
