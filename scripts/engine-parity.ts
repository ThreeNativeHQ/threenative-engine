/**
 * Engine parity guard: one scaffolded template, one pose, both engines. The template is captured
 * once on `engine: "threejs"` and once on `engine: "threenative"`, and the two frames are compared
 * as 4x4 tile means of luminance and RGB (the engine-load-test metric). The score is the largest
 * tile delta, so one wrong region cannot hide in a global mean.
 *
 * Calibrated 2026-10-17 on the 13 templates, nvidia, 1904x960: run-to-run noise <= 0.006, the
 * matching templates 0.002-0.097, the real gaps 0.167 (racing's missing sun target), 0.49 and 0.85.
 *
 * Usage: tsx scripts/engine-parity.ts --project <scaffold> --template <name> --out <dir>
 * Exit 0 parity or a listed known gap, 1 a parity failure, 2 a capture that never happened.
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import {
  type IBrowserCaptureSession,
  WEBGPU_BROWSER_ARGS,
  boundedTeardownStep,
  softwareAdapterName,
  withBrowserCapture,
} from "../packages/playtest/dist/runner/index.js";
import { regionMetrics } from "../packages/playtest/src/runner/steps.js";

export const ENGINE_PARITY_THRESHOLD = 0.12;
export const ENGINES = ["threejs", "threenative"] as const;

/** Templates whose engines still differ, each with the open box that tracks it. A gap that closes fails until it leaves this list. */
// Empty since 2026-10-17: sailing (fc56ef24d, lit mesh without normals) and action-rpg (5bb12e56c, NaN launch cone) closed.
export const KNOWN_GAPS: Readonly<Record<string, string>> = {};
const POSE_WAIT_TICKS = 300;
/** Newest render samples inspected for drawn world frames before the pose is photographed. */
export const WORLD_DRAWN_FRAMES = 8;
/** How many of those samples must show the world drawn: the owned engine skips about every third frame while two are on the GPU. */
export const WORLD_DRAWN_MIN = 2;
/** Bound on the wait for the world's first draws; a slow software adapter needs tens of seconds, a dead renderer never answers. */
export const WORLD_DRAWN_TIMEOUT_MS = 150_000;
const FIXED_STEP_SECONDS = 1 / 60;
const POSE_VISUAL_REGION = {
  x: 0,
  y: 0,
  width: 960,
  height: 540,
  minNonblankPixelRatio: 0.01,
};

/** Seconds represented by a pair of actual fixed-step bridge observations. */
export function observedFixedStepSeconds(
  before: { mode: string; tick?: number },
  after: { mode: string; tick?: number },
): number | null {
  if (
    before.mode !== "fixed-step" ||
    after.mode !== "fixed-step" ||
    typeof before.tick !== "number" ||
    !Number.isFinite(before.tick) ||
    typeof after.tick !== "number" ||
    !Number.isFinite(after.tick)
  )
    return null;
  const seconds = (after.tick - before.tick) * FIXED_STEP_SECONDS;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/**
 * Whether the renderer has drawn the world, read from the per-frame render samples.
 *
 * Fixed-step ticks advance the simulation, not the renderer. The owned engine skips a frame while
 * an environment bakes or two frames are still on the GPU (a drawn world interleaves them with
 * zero-draw samples), and it draws only the pipelines that are ready. On a slow software adapter
 * the pose tick can therefore arrive before one world frame has drawn. The world is drawn once the
 * newest sample is one of at least `min` of the newest `frames` samples that each draw at least
 * half of the busiest sample in the series, and that busiest sample drew more than the single pass
 * of an empty frame.
 *
 * The newest sample must itself be a drawn one, because the screenshot composites what the engine
 * last presented: stopping on a skipped frame photographs the frame before it. 2026-10-27 - a merge
 * shifted the skip phase and collectathon scored 0.322 against the 0.12 threshold, on an exposure
 * that had not adapted and a tutorial hint that had not faded yet, while both of its parents scored
 * 0.035 with the same look. The condition below is what tells a stale photograph from a divergent
 * render; it does not move the threshold.
 */
export function worldDrawn(
  series: readonly { drawCalls?: number }[],
  frames = WORLD_DRAWN_FRAMES,
  min = WORLD_DRAWN_MIN,
): boolean {
  const draws = series.map(({ drawCalls }) => (typeof drawCalls === "number" ? drawCalls : 0));
  const peak = Math.max(0, ...draws);
  const newest = draws.at(-1) ?? 0;
  return (
    peak > 1 &&
    newest * 2 >= peak &&
    draws.slice(-frames).filter((count) => count * 2 >= peak).length >= min
  );
}

/** Holds until the renderer has drawn the world (see `worldDrawn`), or fails closed after `timeoutMs`. */
export async function waitForWorld(
  session: Pick<IBrowserCaptureSession, "bridge" | "page">,
  timeoutMs = WORLD_DRAWN_TIMEOUT_MS,
): Promise<{ waitedMs: number; newestDrawCalls: (number | null)[] }> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  for (;;) {
    const { runtimeDiagnosticsSeries } = await session.bridge.sample({
      entities: [],
      include: ["runtimeDiagnosticsSeries"],
    });
    if (runtimeDiagnosticsSeries === undefined) {
      throw new Error(
        "TN_ENGINE_PARITY_WORLD_UNOBSERVABLE: the bridge returned no render samples, so a drawn world cannot be confirmed.",
      );
    }
    const newestDrawCalls = runtimeDiagnosticsSeries
      .slice(-WORLD_DRAWN_FRAMES)
      .map(({ drawCalls }) => drawCalls ?? null);
    if (worldDrawn(runtimeDiagnosticsSeries))
      return { waitedMs: Date.now() - startedAt, newestDrawCalls };
    if (Date.now() >= deadline) {
      throw new Error(
        `TN_ENGINE_PARITY_WORLD_NOT_DRAWN: no world frame drew within ${timeoutMs}ms; draw calls of the newest samples: ${JSON.stringify(newestDrawCalls)}.`,
      );
    }
    await session.page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
  }
}

/** Whether two captures end at the same absolute simulation pose. */
export function sameFixedStepPose(
  a: { mode: string; tick?: number },
  b: { mode: string; tick?: number },
): boolean {
  return (
    a.mode === "fixed-step" &&
    b.mode === "fixed-step" &&
    typeof a.tick === "number" &&
    Number.isFinite(a.tick) &&
    typeof b.tick === "number" &&
    Number.isFinite(b.tick) &&
    a.tick === b.tick
  );
}

const POSE = {
  name: "engine-parity-pose",
  schemaVersion: 1,
  target: "web",
  viewport: { width: 960, height: 540 },
  warmupFrames: 30,
  artifacts: { screenshots: "before-after" },
  steps: [
    { kind: "wait", label: "pose", waitTicks: POSE_WAIT_TICKS, screenshot: "pose", release: true },
  ],
  assert: { visual: [{ region: POSE_VISUAL_REGION }] },
};

const CAPTURE_CSS = ".tn-dev-scene-warning { display: none !important; }";
const CAPTURE_EXCLUSION = {
  selector: ".tn-dev-scene-warning",
  reason:
    "Hide only the framework scene-shape diagnostic output; game HUD and rendered game pixels remain unchanged.",
};

function isRuntimeReadout(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
  const record = entry as Record<string, unknown>;
  if (record.severity === "error" || record.error !== undefined) return false;
  if (typeof record.type === "string" && ["assert", "error", "pageerror"].includes(record.type))
    return false;
  return (
    typeof record.label === "string" &&
    (typeof record.value === "string" ||
      typeof record.value === "number" ||
      typeof record.value === "boolean")
  );
}

/** Luminance and RGB means of a 4x4 tile grid, each in 0..1. */
export function tileMeans(image: PNG): number[] {
  const out: number[] = [];
  for (let i = 0; i < 16; i++) {
    const x0 = Math.floor(((i % 4) * image.width) / 4);
    const x1 = Math.floor((((i % 4) + 1) * image.width) / 4);
    const y0 = Math.floor((Math.floor(i / 4) * image.height) / 4);
    const y1 = Math.floor(((Math.floor(i / 4) + 1) * image.height) / 4);
    const sums = [0, 0, 0];
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++)
        for (let c = 0; c < 3; c++)
          sums[c] = (sums[c] as number) + (image.data[(y * image.width + x) * 4 + c] as number);
    const n = (x1 - x0) * (y1 - y0) * 255;
    const [r, g, b] = sums.map((sum) => sum / n) as [number, number, number];
    out.push(0.2126 * r + 0.7152 * g + 0.0722 * b, r, g, b);
  }
  return out;
}

export function parityScore(a: PNG, b: PNG): number {
  if (a.width !== b.width || a.height !== b.height)
    throw new Error(`TN_ENGINE_PARITY_SIZE: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  const left = tileMeans(a);
  const right = tileMeans(b);
  return Math.max(...left.map((value, i) => Math.abs(value - (right[i] as number))));
}

/** The verdict for one template's score. A known gap passes; a known gap that closed fails until it is delisted. */
export function verdict(
  template: string,
  score: number,
  gaps: Readonly<Record<string, string>> = KNOWN_GAPS,
): { ok: boolean; message: string } {
  const gap = gaps[template];
  const within = score <= ENGINE_PARITY_THRESHOLD;
  const value = `${template}: score ${score.toFixed(3)} (threshold ${ENGINE_PARITY_THRESHOLD})`;
  if (gap === undefined)
    return within
      ? { ok: true, message: `${value}: the engines match` }
      : { ok: false, message: `TN_ENGINE_PARITY: ${value}: threenative differs from threejs` };
  return within
    ? {
        ok: false,
        message: `TN_ENGINE_PARITY_GAP_CLOSED: ${value}: remove ${template} from KNOWN_GAPS`,
      }
    : { ok: true, message: `${value}: known gap (${gap})` };
}

/** The config source with its default export re-exported under one engine; works for any export shape and overrides a pin. */
export function withEngine(source: string, engine: (typeof ENGINES)[number]): string {
  const matches = source.match(/^export\s+default\s+/gmu) ?? [];
  if (matches.length !== 1)
    throw new Error(
      "TN_ENGINE_PARITY_CONFIG: expected exactly one `export default` in threenative.config.ts",
    );
  return `${source.replace(/^export\s+default\s+/mu, "const __engineParityBase = ")}\nexport default { ...__engineParityBase, engine: "${engine}" };\n`;
}

/** Preserve the browser's GPU watchdog sample and the raw capture observations before its owned capture session tears down. */
export async function withBrowserWatchdogArtifact<T>(
  session: IBrowserCaptureSession,
  artifactPath: string,
  capture: () => Promise<T>,
): Promise<T> {
  const page = session.page;
  const captureStartedAt = new Date().toISOString();
  let captureFailed = false;
  let captureFailure: unknown;
  try {
    return await capture();
  } catch (error) {
    captureFailed = true;
    captureFailure = error;
    throw error;
  } finally {
    if (captureFailed) {
      try {
        writeFileSync(
          path.join(path.dirname(artifactPath), "capture-observations.json"),
          `${JSON.stringify(
            {
              captureStartedAt,
              captureFailedAt: new Date().toISOString(),
              captureError:
                captureFailure instanceof Error ? captureFailure.message : String(captureFailure),
              provenance: session.provenance,
              observedErrorsAfterStartup: session.errors,
              observedConsoleEntries: session.consoleEntries,
              observedNetworkEntries: session.networkEntries,
            },
            null,
            2,
          )}\n`,
        );
      } catch (error) {
        console.error(
          `TN_ENGINE_PARITY_OBSERVATIONS_ARTIFACT: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      let detachSession: (() => Promise<void>) | undefined;
      let expired = false;
      const deadlineMs = 900;
      const started = Date.now();
      const artifact: {
        captureStartedAt: string;
        captureFailedAt: string;
        browserVersion: string | null;
        query: string;
        status: "watchdog-kill-confirmed" | "inconclusive";
        samples: Array<{ response?: unknown; error?: string }>;
        reason?: string;
        detachError?: string;
      } = {
        captureStartedAt,
        captureFailedAt: new Date(started).toISOString(),
        browserVersion: null,
        query: "GPU.WatchdogThread.Event",
        status: "inconclusive",
        samples: [],
      };
      const diagnostics = async () => {
        const browser = page.context().browser();
        if (browser === null) {
          artifact.reason = "Playwright browser is unavailable";
          return;
        }
        artifact.browserVersion = browser.version();
        const pendingSession = browser.newBrowserCDPSession().then((value) => {
          if (expired) {
            void Promise.resolve()
              .then(() => value.detach())
              .catch(() => undefined);
            return undefined;
          }
          detachSession = () => value.detach();
          return value;
        });
        const activeSession = await pendingSession;
        if (activeSession === undefined || expired) return;
        for (let attempt = 0; attempt < 3 && !expired; attempt++) {
          try {
            const result = await activeSession.send("Browser.getHistograms", {
              query: artifact.query,
              delta: false,
            });
            if (expired) return;
            artifact.samples.push({ response: result });
            const histogram = result.histograms.find((entry) => entry.name === artifact.query);
            if (
              histogram?.buckets.some(
                (bucket) => bucket.low === 1 && bucket.high === 2 && bucket.count > 0,
              )
            ) {
              artifact.status = "watchdog-kill-confirmed";
              break;
            }
          } catch (error) {
            if (expired) return;
            artifact.samples.push({
              error: error instanceof Error ? error.message : String(error),
            });
          }
          if (attempt < 2 && !expired) await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (artifact.status === "inconclusive" && !expired)
          artifact.reason =
            "No positive GPU.WatchdogThread.Event [1,2) sample; status is inconclusive";
      };
      const diagnosticRun = diagnostics().catch((error: unknown) => {
        if (!expired) artifact.reason = error instanceof Error ? error.message : String(error);
      });
      const completed = await boundedTeardownStep(diagnosticRun, deadlineMs);
      expired = !completed;
      if (!completed) artifact.reason = "CDP diagnostic deadline elapsed; status is inconclusive";
      if (detachSession !== undefined) {
        const detach = Promise.resolve()
          .then(detachSession)
          .catch((error: unknown) => {
            artifact.detachError = error instanceof Error ? error.message : String(error);
          });
        const remaining = Math.max(0, deadlineMs - (Date.now() - started));
        if (remaining > 0) await boundedTeardownStep(detach, remaining);
        else void detach;
      }
      try {
        writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
      } catch (error) {
        console.error(
          `TN_ENGINE_PARITY_WATCHDOG_ARTIFACT: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}

/** Two frames side by side, threejs left, for the reviewer. */
export function sideBySide(a: PNG, b: PNG): PNG {
  const gap = 16;
  const out = new PNG({ width: a.width + gap + b.width, height: Math.max(a.height, b.height) });
  out.data.fill(24);
  PNG.bitblt(a, out, 0, 0, a.width, a.height, 0, 0);
  PNG.bitblt(b, out, 0, 0, b.width, b.height, a.width + gap, 0);
  return out;
}

function posePng(dir: string): string {
  const files = (function walk(d: string): string[] {
    return readdirSync(d).flatMap((f) => {
      const p = path.join(d, f);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  })(dir).filter((f) => f.endsWith(".png") && path.basename(f).includes("pose"));
  const file = files.sort().at(-1);
  if (file === undefined) throw new Error(`TN_ENGINE_PARITY_CAPTURE: no pose frame in ${dir}`);
  return file;
}

async function main(argv: string[]): Promise<number> {
  const arg = (name: string): string => {
    const value = argv[argv.indexOf(name) + 1];
    if (!argv.includes(name) || value === undefined) throw new Error(`missing ${name}`);
    return value;
  };
  const project = path.resolve(arg("--project"));
  const template = arg("--template");
  const out = path.resolve(arg("--out"));
  mkdirSync(out, { recursive: true });
  const scenario = path.join(out, "pose.playtest.json");
  writeFileSync(scenario, JSON.stringify(POSE, null, 2));
  const configFile = path.join(project, "threenative.config.ts");
  const original = readFileSync(configFile, "utf8");
  const frames: PNG[] = [];
  const observations: Partial<
    Record<
      (typeof ENGINES)[number],
      {
        adapter: Readonly<Record<string, string>> | undefined;
        elapsed: number | null;
        finalTick: number | null;
      }
    >
  > = {};
  try {
    for (const engine of ENGINES) {
      writeFileSync(configFile, withEngine(original, engine));
      const artifacts = path.join(out, engine);
      mkdirSync(artifacts, { recursive: true });
      const captureConfig = {
        projectPath: project,
        scenarioPath: scenario,
        artifactDirectory: artifacts,
        target: "browser" as const,
        url: "http://127.0.0.1:5173",
        server: {
          command: "pnpm dev --host 127.0.0.1 --port $PORT --strictPort",
          cwd: project,
          timeoutMs: 120_000,
        },
        port: 0,
        headless: false,
        // Covers the pose, the wait for a drawn world and the screenshot, each slow on a software adapter.
        timeoutMs: 240_000,
        trace: false,
        browserArgs: [
          ...WEBGPU_BROWSER_ARGS,
          "--enable-logging",
          `--log-file=${path.join(artifacts, "browser.log")}`,
        ],
        allowSoftwareAdapter: process.env.TN_PLAYTEST_ALLOW_SOFTWARE === "1",
      };
      try {
        const capture = async (session: IBrowserCaptureSession) => {
          const adapter = session.provenance.adapter;
          if (adapter === undefined || Object.keys(adapter).length === 0) {
            throw new Error("TN_ENGINE_PARITY_ADAPTER: capture did not report adapter.info");
          }
          observations[engine] = { adapter, elapsed: null, finalTick: null };
          const readPose = async () => {
            const snapshot = await session.bridge.sample({
              entities: [],
              include: ["diagnostics"],
            });
            return {
              clock: snapshot.clock,
              diagnostics: snapshot.diagnostics ?? [],
            };
          };
          const before = await readPose();
          if (
            before.clock.mode !== "fixed-step" ||
            typeof before.clock.tick !== "number" ||
            !Number.isFinite(before.clock.tick)
          ) {
            throw new Error("TN_ENGINE_PARITY_POSE: bridge did not publish an initial clock tick");
          }
          await session.bridge.advance(POSE_WAIT_TICKS);
          const world = await waitForWorld(session);
          const after = await readPose();
          if (
            after.clock.mode !== "fixed-step" ||
            typeof after.clock.tick !== "number" ||
            !Number.isFinite(after.clock.tick) ||
            after.clock.tick - before.clock.tick !== POSE_WAIT_TICKS
          ) {
            throw new Error(
              `TN_ENGINE_PARITY_POSE: expected ${POSE_WAIT_TICKS} fixed-step ticks, observed ${JSON.stringify({ before: before.clock, after: after.clock })}`,
            );
          }
          const expectedElapsedDelta = POSE_WAIT_TICKS / 60;
          const elapsed = observedFixedStepSeconds(before.clock, after.clock);
          if (
            elapsed === null ||
            !Number.isFinite(elapsed) ||
            Math.abs(elapsed - expectedElapsedDelta) > FIXED_STEP_SECONDS
          ) {
            throw new Error(
              `TN_ENGINE_PARITY_POSE: expected ${expectedElapsedDelta}s from the observed fixed-step clock, received ${JSON.stringify({ before: before.clock, after: after.clock, elapsed })}`,
            );
          }
          observations[engine] = { adapter, elapsed, finalTick: after.clock.tick };
          const runtimeErrors = after.diagnostics.filter((entry) => !isRuntimeReadout(entry));
          const diagnostic = await session.page.evaluate(() => {
            const element = document.querySelector<HTMLElement>(".tn-dev-scene-warning");
            return element === null
              ? null
              : {
                  text: element.textContent?.trim() ?? "",
                  displayBeforeExclusion: getComputedStyle(element).display,
                };
          });
          await session.page.addStyleTag({ content: CAPTURE_CSS });
          const exclusionState = await session.page.evaluate(() => {
            const element = document.querySelector<HTMLElement>(".tn-dev-scene-warning");
            return element === null ? null : getComputedStyle(element).display;
          });
          if (exclusionState !== null && exclusionState !== "none") {
            throw new Error(
              `TN_ENGINE_PARITY_CAPTURE_CSS: diagnostic remained visible (${exclusionState})`,
            );
          }
          const screenshot = await session.screenshot("pose");
          const errors = session.errors;
          const consoleEntries = session.consoleEntries;
          const networkEntries = session.networkEntries;
          const visual = regionMetrics(PNG.sync.read(readFileSync(screenshot)), POSE_VISUAL_REGION);
          if (visual.nonblankPixelRatio < POSE_VISUAL_REGION.minNonblankPixelRatio) {
            throw new Error(
              `TN_ENGINE_PARITY_VISUAL: expected at least ${POSE_VISUAL_REGION.minNonblankPixelRatio} nonblank pixels, observed ${visual.nonblankPixelRatio}`,
            );
          }
          if (errors.length > 0 || networkEntries.length > 0 || runtimeErrors.length > 0) {
            throw new Error(
              `TN_ENGINE_PARITY_DIAGNOSTICS: ${JSON.stringify({ errors, consoleEntries, networkEntries, runtimeErrors })}`,
            );
          }
          writeFileSync(
            path.join(artifacts, "capture.json"),
            `${JSON.stringify(
              {
                ...session.provenance,
                softwareAdapter: softwareAdapterName(adapter) ?? null,
                diagnosticsPolicy: {
                  noConsoleErrors: true,
                  noNetworkErrors: true,
                  noRuntimeDiagnostics: true,
                },
                captureExclusions: [CAPTURE_EXCLUSION],
                diagnosticPanel: diagnostic,
                diagnosticDisplayAfterExclusion: exclusionState,
                pose: {
                  before: before.clock,
                  after: after.clock,
                  elapsedSeconds: elapsed,
                  sceneElapsedSeconds: after.clock.tick * FIXED_STEP_SECONDS,
                  waitTicks: POSE_WAIT_TICKS,
                },
                visual,
                world,
                publishedDiagnostics: after.diagnostics,
                observedErrorsAfterStartup: errors,
                observedConsoleEntries: consoleEntries,
                observedNetworkEntries: networkEntries,
                screenshot,
              },
              null,
              2,
            )}\n`,
          );
        };
        await withBrowserCapture(captureConfig, (session) =>
          withBrowserWatchdogArtifact(session, path.join(artifacts, "browser-watchdog.json"), () =>
            capture(session),
          ),
        );
      } catch (error) {
        // A known gap may fail on its own arm (action-rpg's threejs console errors); anything else may not.
        if (KNOWN_GAPS[template] === undefined) {
          console.error(
            `TN_ENGINE_PARITY_CAPTURE: ${template} on ${engine} failed: ${String(error)}`,
          );
          return 2;
        }
      }
      frames.push(PNG.sync.read(readFileSync(posePng(artifacts))));
    }
  } finally {
    writeFileSync(configFile, original);
  }
  const [threejsObservation, threenativeObservation] = [
    observations.threejs,
    observations.threenative,
  ];
  if (threejsObservation !== undefined && threenativeObservation !== undefined) {
    const normalizeAdapter = (adapter: Readonly<Record<string, string>> | undefined) =>
      JSON.stringify(
        Object.entries(adapter ?? {}).sort(([left], [right]) => left.localeCompare(right)),
      );
    if (
      normalizeAdapter(threejsObservation.adapter) !==
      normalizeAdapter(threenativeObservation.adapter)
    ) {
      throw new Error(
        `TN_ENGINE_PARITY_ADAPTER: arms used different adapters (${JSON.stringify({ threejs: threejsObservation.adapter, threenative: threenativeObservation.adapter })})`,
      );
    }
    if (
      threejsObservation.elapsed === null ||
      threenativeObservation.elapsed === null ||
      Math.abs(threejsObservation.elapsed - threenativeObservation.elapsed) > 1 / 60
    ) {
      throw new Error(
        `TN_ENGINE_PARITY_POSE: arms did not reach the same observed scene elapsed (${JSON.stringify({ threejs: threejsObservation.elapsed, threenative: threenativeObservation.elapsed })})`,
      );
    }
    if (
      threejsObservation.finalTick === null ||
      threenativeObservation.finalTick === null ||
      !sameFixedStepPose(
        { mode: "fixed-step", tick: threejsObservation.finalTick },
        { mode: "fixed-step", tick: threenativeObservation.finalTick },
      )
    ) {
      throw new Error(
        `TN_ENGINE_PARITY_POSE: arms ended at different observed scene ticks (${JSON.stringify({ threejs: threejsObservation.finalTick, threenative: threenativeObservation.finalTick })})`,
      );
    }
  }
  const [threejs, threenative] = frames as [PNG, PNG];
  writeFileSync(
    path.join(out, "side-by-side.png"),
    PNG.sync.write(sideBySide(threejs, threenative)),
  );
  const score = parityScore(threejs, threenative);
  const result = verdict(template, score);
  writeFileSync(
    path.join(out, "result.json"),
    `${JSON.stringify({ template, score, ...result }, null, 2)}\n`,
  );
  (result.ok ? console.info : console.error)(result.message);
  return result.ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(`TN_ENGINE_PARITY_CAPTURE: ${String(error)}`);
      process.exitCode = 2;
    });
}
