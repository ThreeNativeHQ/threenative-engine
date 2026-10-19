import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { WEBGPU_BROWSER_ARGS } from "./browser.js";
import { CaptureLockTimeoutError } from "./captureLock.js";
import { PlaytestCliUsageError } from "./config.js";
import type { IProvidedDisplay } from "./captureEnvironment.js";
import { acquireRunnerCaptureLock, provideRunDisplay } from "./runner-support.js";
import {
  createTraceAccumulator,
  formatTraceSummary,
  parseTraceArgs,
  traceExitCode,
  TRACE_CATEGORIES,
  type ITraceArgs,
  type ITraceEvent,
  type ITraceSummary,
  type TraceReadiness,
  summariseRafTimestamps,
} from "./trace.js";

/**
 * The browser half of `threenative-playtest trace`: launch the game on a real display, wait for
 * the world, record, drive input, and hand the raw events to the streaming summariser in
 * `trace.ts`. Everything that decides what a number *means* lives there and is unit-tested; this
 * file only drives Chromium.
 */

/** The recipe extends the WebGPU arguments; replacing them reintroduces SwiftShader silently. */
export function traceBrowserArgs(extra: readonly string[]): string[] {
  return [...WEBGPU_BROWSER_ARGS, ...extra];
}

/**
 * Where the raw trace lands when the caller does not say. Under `artifacts/` because that is
 * where this package's other large outputs go, and named by the minute so two runs do not
 * silently overwrite one another's evidence.
 */
export function defaultTracePath(now: Date = new Date(), cwd: string = process.cwd()): string {
  const stamp = now.toISOString().replace(/[:.]/gu, "-");
  return resolve(cwd, "artifacts", "traces", `trace-${stamp}.json`);
}

export async function traceCommand(argv: readonly string[]): Promise<number> {
  const args = parseTraceArgs(argv);
  const output = args.output === undefined ? defaultTracePath() : resolve(args.output);
  try {
    const summary = await recordTrace(args, output);
    const exitCode = traceExitCode(summary);
    process.stdout.write(args.text ? formatTraceSummary(summary) : `${JSON.stringify({ ...summary, pass: exitCode === 0 }, null, 2)}\n`);
    process.exitCode = exitCode;
    return exitCode;
  } catch (error) {
    // A usage error and a capture-lock timeout both belong to the CLI's own handlers; anything
    // else is this command failing to produce a trace, which is exit 2 with the cause named.
    if (error instanceof PlaytestCliUsageError) throw error;
    if (error instanceof CaptureLockTimeoutError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `${JSON.stringify({ diagnostics: [{ code: "TN_TRACE_RUN_FAILED", message, severity: "error" }], pass: false }, null, 2)}\n`,
    );
    process.exitCode = 2;
    return 2;
  }
}

async function recordTrace(args: ITraceArgs, output: string): Promise<ITraceSummary> {
  const { chromium } = await import("playwright");
  const accumulator = createTraceAccumulator({
    stallThresholdMs: args.stallThresholdMs,
    topFunctions: args.topFunctions,
  });
  await mkdir(dirname(output), { recursive: true });

  // Pixel work contends for one GPU and one compositor, so a trace queues behind any other
  // capture the same way a playtest does — and it must be the only thing measuring while it runs.
  const lease = await acquireRunnerCaptureLock();
  let display: IProvidedDisplay | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    display = await provideRunDisplay();
    browser = await chromium.launch({
      args: traceBrowserArgs(args.browserArgs),
      env: display.env,
      // Headed always. Headless Chromium serves WebGPU from SwiftShader even with the Vulkan
      // flag, and a trace of a CPU rasteriser names the rasteriser's functions.
      headless: false,
    });
    const page = await browser.newPage({ viewport: args.viewport });
    await page.addInitScript(installGpuPipelineDiagnostics);
    const controlUrl = new URL("/__tn_trace_presentation_control__", args.url).href;
    await page.route(controlUrl, (route) => route.fulfill({
      body: "<!doctype html><title>ThreeNative trace presentation control</title>",
      contentType: "text/html",
    }));
    await page.goto(controlUrl, { timeout: args.waitTimeoutSeconds * 1_000, waitUntil: "load" });
    await page.bringToFront();
    let presentationControl: ReturnType<typeof summariseRafTimestamps>;
    let presentationControlError: string | undefined;
    try {
      presentationControl = summariseRafTimestamps(
        await sampleRafTimestamps(page, Math.min(args.waitTimeoutSeconds * 1_000, 30_000)),
      );
    } catch (error) {
      presentationControlError = error instanceof Error ? error.message : String(error);
    }
    const adapter = await probeAdapter(page);
    await page.goto(args.url, { timeout: args.waitTimeoutSeconds * 1_000, waitUntil: "commit" });
    const readiness = await awaitWorld(page, args);
    await page.waitForTimeout(args.settleSeconds * 1_000);

    const writer = openTraceFile(output);
    const cdp = await page.context().newCDPSession(page);
    cdp.on("Tracing.dataCollected", (event: { value?: readonly ITraceEvent[] }) => {
      for (const traceEvent of event.value ?? []) {
        accumulator.add(traceEvent);
        writer.write(traceEvent);
      }
    });
    const complete = new Promise<void>((settle) => cdp.once("Tracing.tracingComplete", () => settle()));
    await cdp.send("Tracing.start", {
      traceConfig: { includedCategories: [...TRACE_CATEGORIES] },
      transferMode: "ReportEvents",
    });
    await driveInput(page, args);
    const pipelineDiagnostics = await page.evaluate(() => {
      return (globalThis as typeof globalThis & {
        __TN_TRACE_INVALID_GPU_PIPELINES__?: readonly {
          depthStencil: Readonly<Record<string, unknown>>;
          label?: string;
          stack: string;
        }[];
      }).__TN_TRACE_INVALID_GPU_PIPELINES__ ?? [];
    });
    await cdp.send("Tracing.end");
    await complete;
    await writer.close();

    return accumulator.summarise({
      ...(adapter === undefined ? {} : { adapter }),
      allowSoftware: args.allowSoftware,
      allowVirtualDisplay: args.allowVirtualDisplay,
      displayStrategy: display.strategy.kind,
      drivenInput: args.keys,
      output,
      pipelineDiagnostics,
      ...(presentationControl === undefined ? {} : { presentationControl }),
      ...(presentationControlError === undefined ? {} : { presentationControlError }),
      readiness,
      seconds: args.seconds,
      url: args.url,
      virtualDisplay: display.strategy.kind === "private-xvfb",
    });
  } finally {
    await browser?.close().catch(() => undefined);
    await display?.release();
    await lease.release();
  }
}

/**
 * Preserve WebGPU's behavior while recording the authored call site that supplied an invalid
 * depth descriptor. Chromium's eventual validation error otherwise points only into its async
 * pipeline compiler, after the descriptor's owner is no longer on the stack.
 */
export function installGpuPipelineDiagnostics(): void {
  type PipelineDescriptor = {
    readonly depthStencil?: { readonly format?: unknown };
    readonly label?: string;
  };
  type PipelineDiagnostic = {
    readonly depthStencil: Readonly<Record<string, unknown>>;
    readonly label?: string;
    readonly stack: string;
  };
  const globals: {
    console: Pick<Console, "error">;
    GPUDevice?: { prototype?: { createRenderPipelineAsync?(descriptor: PipelineDescriptor): Promise<unknown> } };
    __TN_TRACE_INVALID_GPU_PIPELINES__?: PipelineDiagnostic[];
    __TN_TRACE_GPU_PIPELINES_INSTALLED__?: boolean;
  } = globalThis;
  globals.__TN_TRACE_INVALID_GPU_PIPELINES__ = [];
  if (globals.__TN_TRACE_GPU_PIPELINES_INSTALLED__ === true) return;
  const prototype = globals.GPUDevice?.prototype;
  const create = prototype?.createRenderPipelineAsync;
  if (prototype === undefined || create === undefined) return;
  globals.__TN_TRACE_GPU_PIPELINES_INSTALLED__ = true;
  prototype.createRenderPipelineAsync = function (descriptor: PipelineDescriptor): Promise<unknown> {
    const depthStencil = descriptor?.depthStencil;
    if (depthStencil !== undefined && typeof depthStencil.format !== "string") {
      const diagnostic: PipelineDiagnostic = {
        depthStencil: { ...depthStencil },
        ...(typeof descriptor.label === "string" ? { label: descriptor.label } : {}),
        stack: new Error("createRenderPipelineAsync called without depthStencil.format").stack ?? "stack unavailable",
      };
      globals.__TN_TRACE_INVALID_GPU_PIPELINES__?.push(diagnostic);
      globals.console.error("TN_INVALID_DEPTH_PIPELINE", diagnostic);
    }
    return create.call(this, descriptor);
  };
}

async function sampleRafTimestamps(
  page: import("playwright").Page,
  timeoutMs: number,
): Promise<readonly number[]> {
  return await page.evaluate((sampleTimeoutMs) => new Promise<number[]>((resolveSample, rejectSample) => {
    const timestamps: number[] = [];
    const timeout = setTimeout(
      () => rejectSample(new Error(`presentation control observed only ${timestamps.length - 1} of 180 rAF intervals`)),
      sampleTimeoutMs,
    );
    function sample(time: number): void {
      timestamps.push(time);
      if (timestamps.length < 181) requestAnimationFrame(sample);
      else {
        clearTimeout(timeout);
        resolveSample(timestamps);
      }
    }
    requestAnimationFrame(sample);
  }), timeoutMs);
}

/**
 * Hold until the game says its world is up, then trace the *game*. Tracing the load instead puts
 * the loading tier's pipeline compiles in the same sample as the mid-play stalls this command
 * exists to find, and they are far larger. A gate that never fires degrades to tracing anyway
 * with the fact recorded, because a trace of the wrong window still beats a hang.
 */
async function awaitWorld(
  page: import("playwright").Page,
  args: ITraceArgs,
): Promise<TraceReadiness> {
  if (args.waitFor === undefined) return "skipped";
  try {
    await page.waitForFunction(args.waitFor, undefined, {
      polling: 250,
      timeout: args.waitTimeoutSeconds * 1_000,
    });
    return "observed";
  } catch {
    return "timed-out";
  }
}

/** `adapter.info`, so the summary can refuse to describe a CPU rasteriser as the game's GPU. */
async function probeAdapter(
  page: import("playwright").Page,
): Promise<Record<string, string> | undefined> {
  try {
    return (await page.evaluate(async () => {
      const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ info?: unknown } | null> } }).gpu;
      const info = (await gpu?.requestAdapter())?.info as Record<string, unknown> | undefined;
      if (info === undefined) return undefined;
      const fields: Record<string, string> = {};
      for (const key of ["architecture", "description", "device", "vendor"]) {
        const value = info[key];
        if (typeof value === "string" && value.length > 0) fields[key] = value;
      }
      return fields;
    })) ?? undefined;
  } catch {
    // A page without WebGPU is a fact about the page, not a reason to abandon the trace.
    return undefined;
  }
}

/**
 * Hold the movement keys for the traced window. A standing camera re-uses everything it drew
 * last frame — culling results, shadow maps, the lot — so a trace taken from a parked viewpoint
 * measures a game nobody is playing.
 */
async function driveInput(page: import("playwright").Page, args: ITraceArgs): Promise<void> {
  for (const key of args.keys) await page.keyboard.down(key);
  try {
    await page.waitForTimeout(args.seconds * 1_000);
  } finally {
    for (const key of args.keys) await page.keyboard.up(key).catch(() => undefined);
  }
}

interface ITraceFileWriter {
  close(): Promise<void>;
  write(event: ITraceEvent): void;
}

/**
 * Streams the raw events to disk as they arrive, in DevTools' own `{ "traceEvents": [...] }`
 * shape. Collecting them into an array and serialising it at the end holds the trace twice, and
 * one 63-second recording came to 266 MB across 1.18 M events.
 */
function openTraceFile(output: string): ITraceFileWriter {
  const stream = createWriteStream(output, { encoding: "utf8" });
  stream.write('{"traceEvents":[');
  let written = 0;
  return {
    close(): Promise<void> {
      return new Promise<void>((settle, fail) => {
        stream.once("error", fail);
        stream.end("]}\n", () => settle());
      });
    },
    write(event: ITraceEvent): void {
      // Backpressure is left to the stream's own buffer: the handler CDP calls is synchronous,
      // so there is nowhere to await a drain, and a local disk keeps up with the trace.
      stream.write(written === 0 ? JSON.stringify(event) : `,${JSON.stringify(event)}`);
      written += 1;
    },
  };
}
