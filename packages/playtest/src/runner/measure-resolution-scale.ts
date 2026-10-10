import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { WEBGPU_BROWSER_ARGS } from "./browser.js";
import { provideDisplay } from "./captureEnvironment.js";
import { PlaywrightTransport, bridgeWaitTimeoutMs } from "./bridgeClient.js";
import { waitForStartupReady } from "./startupReady.js";
import {
  resolutionScaleFrame,
  preserveResolutionScaleFailure,
  resolutionScaleGate,
} from "./resolution-scale-probe.js";
import type { IPlaytestBridgeDescription, IPlaytestBridgeReady } from "../protocol.js";

import type { IResolutionScaleRun } from "./resolution-scale-probe.js";

// Use a served starter with resolutionScale pinned to 1; all other render settings stay authored.
const output = resolve(process.argv[2] ?? "artifacts/prd564");
const preflightOnly = process.argv[3] === "--preflight";
if (process.argv[3] !== undefined && !preflightOnly)
  throw new Error("Expected --preflight or no mode");
await mkdir(output, { recursive: true });
const server = await serveStarter(output);
const url = server.resolvedUrls.local[0];
const display = await provideDisplay();
let browser;
const measurements: IResolutionScaleRun[] = [];
try {
  browser = await chromium.launch({
    headless: false,
    args: [
      ...WEBGPU_BROWSER_ARGS,
      "--use-angle=vulkan",
      "--use-vulkan",
      "--disable-vulkan-surface",
      "--no-sandbox",
    ],
    env: display.env,
  });
  for (let run = 1; run <= (preflightOnly ? 1 : 3); run++) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    const logs: string[] = [];
    page.on("console", (message) => logs.push(message.text()));
    page.on("pageerror", (error) => logs.push(`PAGE_ERROR:${error.message}`));
    const evidence: any = { startup: { collected: false }, partial: { collected: false } };
    try {
      await page.goto(url);
      const transport = new PlaywrightTransport(page);
      const bootError = async () =>
        (await page.locator("[data-threenative-canvas-error]").allTextContents()).join("\n");
      if (!(await transport.waitForBridge(bridgeWaitTimeoutMs()))) {
        const error = await bootError();
        throw new Error(
          error
            ? `TN_RESOLUTION_BOOT_REJECTED: ${error}`
            : "TN_PLAYTEST_BRIDGE_MISSING: starter did not install its bridge",
        );
      }
      const description = await transport.call<IPlaytestBridgeDescription>(
        "describe",
        undefined,
        bridgeWaitTimeoutMs(),
      );
      const startup = await waitForStartupReady({
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
      });
      evidence.startup = { collected: true, value: startup };
      if (startup === undefined)
        throw new Error("TN_PLAYTEST_STARTUP_NOT_READY: starter does not report startup");
      const navigations: string[] = [];
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) navigations.push(frame.url());
      });
      const observed = await page
        .evaluate<{
          preflight?: any;
          rows?: any[];
          partial: any;
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
      evidence.rows = rows;
      const adapter = preflight.adapter;
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
            display: display.strategy,
            startup,
            adapter,
            preflight,
            rows,
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
          steps: rows.map((row: any) => ({
            scale: row.scale,
            stepMs: row.frames[0].frameMs,
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
              display: display.strategy,
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
  await browser?.close();
  await display.release();
  await server.close();
}

async function serveStarter(output: string): Promise<any> {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const load = (path: string) => import(path);
  const tooling = createRequire(resolve(repo, "examples/abyss-framework/package.json"));
  const { createServer } = await load(tooling.resolve("vite"));
  const { createProject } = await load(resolve(repo, "packages/create-threenative/src/index.ts"));
  const target = await mkdtemp(resolve(output, "starter-"));
  await createProject({ target, template: "starter", install: false });
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
  await server.listen();
  return server;
}
