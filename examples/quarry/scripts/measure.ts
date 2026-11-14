// Runs one arm's route and reports the frame it produced. Exists so the number PRD-280 opens or
// closes the batch on can be re-taken by CI or by another agent with one command, rather than
// recovered by hand out of a log — every number in this repository's Android-fps hunt was read out
// of these markers by hand once, and that is what `playtest perf` was written to stop.
//
//   pnpm --filter quarry measure -- --arm dense --url http://127.0.0.1:5191
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { QUARRY_ARMS, type QuarryArm, parseArm } from "../src/quarry/arm.js";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, "../../..");

interface IPhase {
  readonly p50: number;
  readonly p95: number;
  readonly samples: number;
}

interface IFrameBudgetWindow {
  readonly fps: number;
  readonly frame: IPhase;
  readonly gpuMs?: number;
  readonly phases: Readonly<Record<string, IPhase>>;
  readonly presented?: IPhase;
  readonly surface?: { readonly drawingBufferHeight: number; readonly drawingBufferWidth: number };
  readonly window: number;
}

export interface IArmMeasurement {
  readonly adapter: unknown;
  /** The run failed on the engine's perf warning alone, and was measured anyway. */
  readonly perfWarning: boolean;
  readonly arm: QuarryArm;
  readonly target: string;
  readonly drawCalls: number;
  readonly framePresentedMsP50: number;
  readonly fps: number;
  readonly gpuMs: number | null;
  readonly hostGapMsP50: number;
  readonly recut: IRecutMeasurement | null;
  readonly renderMsP50: number;
  readonly renderMsP95: number;
  readonly steadyWindows: number;
  readonly triangles: number;
  readonly view: IViewMeasurement | null;
  readonly viewCull: string;
  readonly viewport: string;
}

/** What the view does not hold, and what it costs to drop it — PRD-600's Phase 1 numbers. */
export interface IViewMeasurement {
  /** Submitted triangles whose cluster bounds or copy sphere lie wholly outside the frustum. */
  readonly outsideTriangles: number;
  /** That, as a share of the triangles the clustered meshes and batch copies submit. */
  readonly outsideShare: number;
  /** Submitted triangles from clustered meshes and batch copies. */
  readonly triangles: number;
  /** Batch copies and how many of them lie outside. */
  readonly copies: number;
  readonly outsideCopies: number;
}

/** The cost of one re-cut: the `#compact` copy and the index upload along the route. */
export interface IRecutMeasurement {
  readonly samples: number;
  readonly ms: number;
  readonly megabytesPerSecond: number;
}

/** One `TN_CLUSTER_VIEW` marker the quarry prints: what the view holds, on a 30-frame cadence. */
interface IViewWindow {
  readonly copies: number;
  readonly frame: number;
  readonly outsideClusters: number;
  readonly outsideCopies: number;
  readonly outsideTriangles: number;
  readonly recutBytes: number;
  readonly recutMs: number;
  readonly recutSamples: number;
  readonly triangles: number;
}

function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("TN_QUARRY_NO_SAMPLES: nothing to take a median of.");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

function argument(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`TN_QUARRY_MEASURE_MISSING_ARG: --${name} is required.`);
  }
  return value;
}

function main(): void {
  const arm = parseArm(argument("arm"));
  const target = argument("target", "browser");
  if (target !== "browser" && target !== "desktop")
    throw new Error(
      `TN_QUARRY_MEASURE_TARGET: --target must be browser or desktop, not '${target}'.`,
    );
  const url = argument("url", "http://127.0.0.1:5191");
  // PRD-600's before/after: `--view-cull off` draws every cluster and every copy, exactly as the
  // route drew them before the cut was pruned by the view. The browser lane reads it from the URL;
  // the desktop host has no URL, so its arm is the shipped one and this flag is refused there
  // rather than silently measuring something else.
  const viewCull = argument("view-cull", "on");
  if (viewCull !== "on" && viewCull !== "off")
    throw new Error(
      `TN_QUARRY_MEASURE_VIEW_CULL: --view-cull must be on or off, not '${viewCull}'.`,
    );
  if (target === "desktop" && viewCull === "off")
    throw new Error(
      "TN_QUARRY_MEASURE_VIEW_CULL: the desktop lane has no URL to carry --view-cull; build the arm with it off instead.",
    );
  const artifacts = resolve(
    repositoryRoot,
    target === "browser" ? `artifacts/quarry/${arm}` : `artifacts/quarry/native-${arm}`,
  );
  mkdirSync(artifacts, { recursive: true });

  const browserArguments = [
    resolve(here, "../playtests/quarry-route.playtest.json"),
    "--url",
    `${url}/?arm=${arm}&viewCull=${viewCull}`,
    "--browser-recipe",
    "webgpu",
    // Headed against the real adapter: under the runner's private Xvfb a heavy scene can fall
    // back to SwiftShader, and a software adapter would invent a difference between the arms
    // out of nothing.
    "--headed",
  ];
  const desktopArguments = [
    "playtests/quarry-route-desktop.playtest.json",
    "--target",
    "desktop",
    "--executable",
    `dist-native/quarry-${arm}`,
    "--project",
    resolve(here, ".."),
  ];

  // A slow arm is what this script measures, so a run whose only failure is the engine's own perf
  // warning is still a measurement; it is recorded below. Any other failure throws.
  const runRoute = (args: Parameters<typeof execFileSync>): string => {
    try {
      return execFileSync(...args) as unknown as string;
    } catch (error) {
      const stdout = (error as { stdout?: string }).stdout;
      if (typeof stdout !== "string" || stdout.trim() === "") throw error;
      return stdout;
    }
  };
  const report = JSON.parse(
    runRoute([
      process.execPath,
      [
        resolve(repositoryRoot, "packages/playtest/dist/runner/cli.js"),
        ...(target === "browser" ? browserArguments : desktopArguments),
        "--timeout",
        // Long enough for a software adapter to finish the route. The quarry is bound on GPU work,
        // and on this stack a machine with no usable GPU falls back to SwiftShader, where a route of
        // 1,850 ticks takes minutes of presentation nobody budgeted for when this budget was 5.
        "900000",
        "--artifacts",
        artifacts,
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        // The native host picks Wayland otherwise and then reports no display at all.
        env: { ...process.env, SDL_VIDEODRIVER: "x11" },
        maxBuffer: 256 * 1024 * 1024,
      },
    ]),
  ) as {
    observations: {
      console: readonly { text: string }[];
      resourceSeries?: readonly { snapshots: Record<string, Record<string, number>> }[];
    };
    pass: boolean;
    diagnostics?: readonly { code: string; severity?: string }[];
  };

  const failures = (report.diagnostics ?? []).filter((item) => item.severity === "error");
  const perfWarningsOnly =
    failures.length > 0 && failures.every((item) => item.code === "TN_PLAYTEST_PERF_WARNING");
  if (report.pass !== true && !perfWarningsOnly)
    throw new Error(`TN_QUARRY_MEASURE_SCENARIO_FAILED: the ${arm} route did not pass.`);

  const windows: IFrameBudgetWindow[] = [];
  const viewWindows: IViewWindow[] = [];
  for (const line of report.observations.console) {
    const view = line.text.indexOf("TN_CLUSTER_VIEW:");
    if (view !== -1) {
      viewWindows.push(
        JSON.parse(line.text.slice(view + "TN_CLUSTER_VIEW:".length)) as IViewWindow,
      );
      continue;
    }
    // The browser lane reports the marker bare; the native host's console arrives through the
    // mailbox with a `[log] ` level prefix, so the marker is found rather than required at
    // column zero.
    const marker = line.text.indexOf("TN_FRAME_BUDGET:");
    if (marker === -1) continue;
    // Fails closed, like `playtest perf`: a marker whose JSON will not parse is a measurement
    // that did not happen, never a sample that quietly vanishes.
    windows.push(
      JSON.parse(line.text.slice(marker + "TN_FRAME_BUDGET:".length)) as IFrameBudgetWindow,
    );
  }
  // Window 1 always lies: it holds the load, the first shader compiles and the first uploads.
  const steady = windows.filter((entry) => entry.window > 1);
  if (steady.length < 2)
    throw new Error(
      `TN_QUARRY_MEASURE_NOT_ENOUGH_WINDOWS: ${steady.length} steady windows, need at least 2.`,
    );

  const last = report.observations.resourceSeries?.at(-1)?.snapshots.GameState;
  if (last === undefined)
    throw new Error("TN_QUARRY_MEASURE_NO_STATE: the run reported no game state.");

  const gpuSamples = steady
    .map((entry) => entry.gpuMs)
    .filter((value): value is number => typeof value === "number");
  const surface = steady[0]?.surface;
  // The view markers buckle to the same window count as the frame budget, so window 1 is dropped
  // for the same reason: it holds the load and the first cuts.
  const steadyViews = viewWindows.filter((entry) => entry.frame > 30);
  const viewOf = (pick: (window: IViewWindow) => number): number =>
    steadyViews.length === 0 ? 0 : median(steadyViews.map(pick));
  const viewTriangles = viewOf((window) => window.triangles);
  const recutSamples = steadyViews.reduce((sum, window) => sum + window.recutSamples, 0);
  const recutMs = steadyViews.reduce((sum, window) => sum + window.recutMs, 0);
  const recutBytes = steadyViews.reduce((sum, window) => sum + window.recutBytes, 0);
  const measurement: IArmMeasurement = {
    perfWarning: perfWarningsOnly,
    // The browser lane names its adapter in `capture.json`; the desktop lane's adapter is the one
    // the host printed into its own log, and claiming otherwise would be inventing evidence.
    adapter:
      target === "browser"
        ? (
            JSON.parse(readFileSync(resolve(artifacts, "capture.json"), "utf8")) as {
              adapter: unknown;
            }
          ).adapter
        : "packed Linux desktop native host (see the run's console.json)",
    arm,
    target,
    viewCull,
    drawCalls: last.drawCalls as number,
    framePresentedMsP50: median(
      steady.map((entry) => entry.presented?.p50).filter((v): v is number => v !== undefined),
    ),
    fps: median(steady.map((entry) => entry.fps)),
    gpuMs: gpuSamples.length === 0 ? null : median(gpuSamples),
    hostGapMsP50: median(steady.map((entry) => entry.phases.hostGap?.p50 ?? 0)),
    recut:
      recutSamples === 0
        ? null
        : {
            megabytesPerSecond:
              recutMs > 0 ? Math.round((recutBytes / 1e3 / recutMs) * 100) / 100 : 0,
            ms: Math.round((recutMs / recutSamples) * 1000) / 1000,
            samples: recutSamples,
          },
    renderMsP50: median(steady.map((entry) => entry.phases.render?.p50 ?? 0)),
    renderMsP95: median(steady.map((entry) => entry.phases.render?.p95 ?? 0)),
    steadyWindows: steady.length,
    triangles: last.triangles as number,
    view:
      steadyViews.length === 0
        ? null
        : {
            copies: Math.round(viewOf((window) => window.copies)),
            outsideCopies: Math.round(viewOf((window) => window.outsideCopies)),
            outsideShare:
              viewTriangles > 0
                ? Math.round(
                    (viewOf((window) => window.outsideTriangles) / viewTriangles) * 1_000,
                  ) / 1_000
                : 0,
            outsideTriangles: Math.round(viewOf((window) => window.outsideTriangles)),
            triangles: Math.round(viewTriangles),
          },
    viewport:
      surface === undefined
        ? "unknown"
        : `${surface.drawingBufferWidth}x${surface.drawingBufferHeight}`,
  };

  writeFileSync(
    resolve(artifacts, "measurement.json"),
    `${JSON.stringify(measurement, null, 2)}\n`,
  );
  console.log(JSON.stringify(measurement, null, 2));
}

if (!QUARRY_ARMS.includes(process.argv[process.argv.indexOf("--arm") + 1] as QuarryArm))
  throw new Error(`TN_QUARRY_MEASURE_ARM: --arm must be one of ${QUARRY_ARMS.join(", ")}.`);
main();
