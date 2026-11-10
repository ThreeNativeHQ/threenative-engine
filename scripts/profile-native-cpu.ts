import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { cpus, platform, release } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { PNG } from "pngjs";
import { waitForServer } from "./lib/dev-server.js";
import type {
  DirtyRatio,
  Hierarchy,
  IWorkloadConfig,
  RenderMode,
  RenderingMode,
  ScenarioPreset,
  Visibility,
} from "./native-cpu-profile/workload.js";
import { createFoxScaleWorkloadConfig, summarizeSamples } from "./native-cpu-profile/workload.js";

export type AdapterClass = "hardware" | "software" | "unknown";
export type EvidenceClass =
  | "visual-verified"
  | "visual-rejected"
  | "timing-only-browser-hardware"
  | "timing-only-browser-software-diagnostic";

export interface IPresentationFrameSummary {
  readonly alphaOpaqueRatio: number;
  readonly foregroundRatio: number;
  readonly height: number;
  readonly label: string;
  readonly luminanceStdDev: number;
  readonly reason?: string;
  readonly status: "pass" | "fail";
  readonly uniqueColorBuckets: number;
  readonly width: number;
}

export interface IPresentationSummary {
  readonly after: IPresentationFrameSummary;
  readonly before: IPresentationFrameSummary;
}

export interface IPresentationPreconditions {
  readonly display?: string;
  readonly headed: boolean;
  readonly verifyPresentation: boolean;
}

export interface IAdapterInfo {
  readonly architecture?: string;
  readonly description?: string;
  readonly device?: string;
  readonly vendor?: string;
}

export interface IScenarioMatrix {
  readonly dirtyRatios: readonly DirtyRatio[];
  readonly hierarchies: readonly Hierarchy[];
  readonly objectCounts: readonly number[];
  readonly passes: readonly (1 | 2)[];
  readonly renderModes: readonly RenderMode[];
  readonly rendering?: readonly RenderingMode[];
  readonly seed: number;
  readonly scenarioPresets: readonly ScenarioPreset[];
  readonly visibilities: readonly Visibility[];
}

export interface IProfileArgs extends IScenarioMatrix {
  readonly allowSoftware: boolean;
  readonly browser?: string;
  readonly browserArgs: readonly string[];
  readonly diagnostic: boolean;
  readonly evidenceClass: "timing-only" | "visual-verified";
  readonly headed: boolean;
  readonly outputDir: string;
  readonly port: number;
  readonly rendererStages: boolean;
  readonly renderAdvisor: boolean;
  readonly rendering: readonly RenderingMode[];
  readonly repeats: number;
  readonly samples: number;
  readonly verifyPresentation: boolean;
  readonly visualEvidenceScenario?: ScenarioPreset;
  readonly warmupFrames: number;
  readonly warmupMs: number;
}

export interface IProfileArgumentsSnapshot {
  readonly allowSoftware: boolean;
  readonly browser: string | null;
  readonly browserArgs: readonly string[];
  readonly diagnostic: boolean;
  readonly dirtyRatios: readonly DirtyRatio[];
  readonly evidenceClass: IProfileArgs["evidenceClass"];
  readonly headed: boolean;
  readonly hierarchies: readonly Hierarchy[];
  readonly objectCounts: readonly number[];
  readonly outputDir: string;
  readonly passes: readonly (1 | 2)[];
  readonly port: number;
  readonly renderAdvisor: boolean;
  readonly rendererStages: boolean;
  readonly renderModes: readonly RenderMode[];
  readonly rendering: readonly RenderingMode[];
  readonly repeats: number;
  readonly samples: number;
  readonly scenarioPresets: readonly ScenarioPreset[];
  readonly seed: number;
  readonly verifyPresentation: boolean;
  readonly visualEvidenceScenario: ScenarioPreset | null;
  readonly visibilities: readonly Visibility[];
  readonly warmupFrames: number;
  readonly warmupMs: number;
}

export interface IProfileProvenance {
  readonly arguments: IProfileArgumentsSnapshot;
  readonly argv: readonly string[];
}

const BOOLEAN_ARGUMENTS = new Set([
  "--allow-software",
  "--diagnostic",
  "--headed",
  "--help",
  "--renderer-stages",
  "--render-advisor",
  "--verify-presentation",
]);
const VALUE_ARGUMENTS = new Set([
  "--browser",
  "--browser-arg",
  "--dirty",
  "--hierarchy",
  "--objects",
  "--output-dir",
  "--passes",
  "--port",
  "--repeats",
  "--render-mode",
  "--rendering",
  "--samples",
  "--seed",
  "--scenario",
  "--visibility",
  "--warmup-frames",
  "--warmup-ms",
  "--visual-evidence",
]);

function readArguments(args: readonly string[]): Map<string, string[]> {
  const values = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--") continue;
    const equals = argument.indexOf("=");
    const name = equals < 0 ? argument : argument.slice(0, equals);
    if (BOOLEAN_ARGUMENTS.has(name)) {
      if (equals >= 0) throw new Error(`${name} does not accept a value.`);
      values.set(name, []);
      continue;
    }
    if (!VALUE_ARGUMENTS.has(name)) throw new Error(`Unknown argument: ${argument}`);
    let value: string | undefined;
    if (equals < 0) {
      index += 1;
      value = args[index];
    } else {
      value = argument.slice(equals + 1);
    }
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value.`);
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  return values;
}

function positiveInteger(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

function nonNegativeInteger(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error(`${label} must be a non-negative integer.`);
  return parsed;
}

function list(value: string | undefined, fallback: readonly string[]): readonly string[] {
  return value === undefined ? fallback : value.split(",").filter((item) => item.length > 0);
}

function objectCounts(value: string | undefined, fallback: readonly number[]): readonly number[] {
  const parsed = list(value, fallback.map(String)).map(Number);
  if (parsed.length === 0 || parsed.some((count) => !Number.isSafeInteger(count) || count <= 0))
    throw new Error("--objects must contain positive integers.");
  return parsed;
}

function dirtyRatios(
  value: string | undefined,
  fallback: readonly DirtyRatio[],
): readonly DirtyRatio[] {
  const percentages = list(
    value,
    fallback.map((ratio) => String(ratio * 100)),
  ).map(Number);
  if (percentages.length === 0 || percentages.some((ratio) => ![0, 10, 100].includes(ratio)))
    throw new Error("--dirty must contain percentages 0, 10, or 100.");
  return percentages.map((percentage) => percentage / 100) as DirtyRatio[];
}

function enumList<T extends string>(
  value: string | undefined,
  fallback: readonly T[],
  supported: readonly T[],
  label: string,
): readonly T[] {
  const parsed = list(value, fallback);
  if (parsed.length === 0 || parsed.some((item) => !supported.includes(item as T)))
    throw new Error(`${label} contains an unsupported value.`);
  return parsed as readonly T[];
}

function optionalEnumList<T extends string>(
  value: string | undefined,
  supported: readonly T[],
  label: string,
): readonly T[] {
  const parsed = list(value, []);
  if (parsed.some((item) => !supported.includes(item as T)))
    throw new Error(`${label} contains an unsupported value.`);
  return parsed as readonly T[];
}

export function parseProfileArgs(args: readonly string[]): IProfileArgs {
  const values = readArguments(args);
  const diagnostic = values.has("--diagnostic");
  const value = (name: string): string | undefined => values.get(name)?.at(-1);
  const visualEvidence = value("--visual-evidence");
  if (visualEvidence !== undefined && visualEvidence !== "fox-scale")
    throw new Error("--visual-evidence currently supports only fox-scale.");
  const canonicalFoxVisual = visualEvidence === "fox-scale";
  const verifyPresentation = values.has("--verify-presentation") || canonicalFoxVisual;
  const seed = nonNegativeInteger(value("--seed"), 90210, "--seed");
  if (seed > 0xffff_ffff) throw new Error("--seed must be an unsigned 32-bit integer.");
  return {
    allowSoftware: values.has("--allow-software"),
    browser: value("--browser"),
    browserArgs: values.get("--browser-arg") ?? [],
    diagnostic,
    dirtyRatios: dirtyRatios(
      value("--dirty"),
      canonicalFoxVisual ? [0.1] : diagnostic ? [0.1] : [0, 0.1, 1],
    ),
    evidenceClass: verifyPresentation ? "visual-verified" : "timing-only",
    headed: values.has("--headed") || canonicalFoxVisual,
    hierarchies: enumList(
      value("--hierarchy"),
      canonicalFoxVisual ? ["flat"] : diagnostic ? ["flat"] : ["flat", "deep"],
      ["flat", "deep"],
      "--hierarchy",
    ),
    objectCounts: objectCounts(
      value("--objects"),
      canonicalFoxVisual ? [1_850] : diagnostic ? [500] : [500, 1_000, 2_000, 4_000],
    ),
    passes: enumList(value("--passes"), ["1"], ["1", "2"], "--passes").map(Number) as (1 | 2)[],
    renderModes: enumList(
      value("--render-mode"),
      ["independent"],
      [
        "independent",
        "distinct-materials",
        "instanced",
        "merged",
        "scene-projection",
        "bundled",
        "bundled-dynamic",
      ],
      "--render-mode",
    ),
    rendering: enumList(
      value("--rendering"),
      ["complete"],
      ["complete", "cpu-only"],
      "--rendering",
    ),
    outputDir: value("--output-dir") ?? "artifacts/native-cpu-profile",
    port: positiveInteger(value("--port"), 5320, "--port"),
    rendererStages: values.has("--renderer-stages"),
    renderAdvisor: values.has("--render-advisor"),
    repeats: positiveInteger(
      value("--repeats"),
      canonicalFoxVisual ? 3 : diagnostic ? 1 : 3,
      "--repeats",
    ),
    samples: positiveInteger(
      value("--samples"),
      canonicalFoxVisual ? 120 : diagnostic ? 12 : 180,
      "--samples",
    ),
    scenarioPresets: canonicalFoxVisual
      ? ["fox-scale"]
      : optionalEnumList(value("--scenario"), ["fox-scale"], "--scenario"),
    seed,
    verifyPresentation,
    visualEvidenceScenario: canonicalFoxVisual ? "fox-scale" : undefined,
    visibilities: enumList(
      value("--visibility"),
      canonicalFoxVisual
        ? ["all-visible"]
        : diagnostic
          ? ["mostly-culled"]
          : ["all-visible", "mostly-culled", "alternating"],
      ["all-visible", "mostly-culled", "alternating"],
      "--visibility",
    ),
    warmupFrames: nonNegativeInteger(
      value("--warmup-frames"),
      canonicalFoxVisual ? 60 : diagnostic ? 2 : 120,
      "--warmup-frames",
    ),
    warmupMs: nonNegativeInteger(
      value("--warmup-ms"),
      canonicalFoxVisual ? 0 : diagnostic ? 0 : 2_000,
      "--warmup-ms",
    ),
  };
}

export function buildProfileProvenance(
  args: IProfileArgs,
  rawArguments: readonly string[],
): IProfileProvenance {
  return {
    arguments: {
      allowSoftware: args.allowSoftware,
      browser: args.browser ?? null,
      browserArgs: [...args.browserArgs],
      diagnostic: args.diagnostic,
      dirtyRatios: [...args.dirtyRatios],
      evidenceClass: args.evidenceClass,
      headed: args.headed,
      hierarchies: [...args.hierarchies],
      objectCounts: [...args.objectCounts],
      outputDir: args.outputDir,
      passes: [...args.passes],
      port: args.port,
      renderAdvisor: args.renderAdvisor,
      rendererStages: args.rendererStages,
      renderModes: [...args.renderModes],
      rendering: [...args.rendering],
      repeats: args.repeats,
      samples: args.samples,
      scenarioPresets: [...args.scenarioPresets],
      seed: args.seed,
      verifyPresentation: args.verifyPresentation,
      visualEvidenceScenario: args.visualEvidenceScenario ?? null,
      visibilities: [...args.visibilities],
      warmupFrames: args.warmupFrames,
      warmupMs: args.warmupMs,
    },
    argv: [...rawArguments],
  };
}

export function buildScenarioMatrix(
  matrix: IScenarioMatrix & Partial<Pick<IProfileArgs, "visualEvidenceScenario">>,
): readonly (IWorkloadConfig & { readonly rendering: RenderingMode })[] {
  const scenarios: (IWorkloadConfig & { readonly rendering: RenderingMode })[] = [];
  const renderings = matrix.rendering ?? ["complete"];
  if (matrix.visualEvidenceScenario !== "fox-scale") {
    for (const hierarchy of matrix.hierarchies) {
      for (const dirtyRatio of matrix.dirtyRatios) {
        for (const visibility of matrix.visibilities) {
          for (const objectCount of matrix.objectCounts) {
            for (const renderMode of matrix.renderModes) {
              for (const passes of matrix.passes) {
                for (const rendering of renderings) {
                  scenarios.push({
                    dirtyRatio,
                    hierarchy,
                    objectCount,
                    passes,
                    renderMode,
                    rendering,
                    seed: matrix.seed,
                    visibility,
                  });
                }
              }
            }
          }
        }
      }
    }
  }
  for (const preset of matrix.scenarioPresets ?? []) {
    if (preset === "fox-scale") {
      for (const renderMode of matrix.renderModes) {
        for (const rendering of renderings) {
          scenarios.push({ ...createFoxScaleWorkloadConfig(matrix.seed), renderMode, rendering });
        }
      }
    }
  }
  return scenarios;
}

export function classifyAdapter(adapter: IAdapterInfo | null): AdapterClass {
  if (adapter === null) return "unknown";
  const description = Object.values(adapter)
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();
  if (description.length === 0) return "unknown";
  if (/swiftshader|llvmpipe|lavapipe|software|basic render/u.test(description)) return "software";
  return /\b(?:ada|ampere|hopper|turing|nvidia|geforce|quadro|rtx|gtx|amd|radeon|intel|arc|iris|uhd graphics|apple|qualcomm|adreno|arm|mali|powervr|rdna|m[1-9])\b|\bgfx[0-9]\b/u.test(
    description,
  )
    ? "hardware"
    : "unknown";
}

export function assertGpuEvidenceAllowed(adapter: AdapterClass, allowSoftware: boolean): void {
  if (adapter !== "hardware" && !allowSoftware)
    throw new Error(
      `Adapter is ${adapter}; pass --allow-software to collect explicitly diagnostic results.`,
    );
}

const PRESENTATION_LIMITS = {
  maxUniformBucketRatio: 0.985,
  minDimension: 16,
  minForegroundRatio: 0.02,
  minLuminanceStdDev: 0.015,
  minOpaqueRatio: 0.95,
  minUniqueColorBuckets: 16,
} as const;

const PRESENTATION_GUIDANCE =
  "Canonical visual evidence command: sh scripts/xvfb.sh pnpm profile:native-cpu -- --headed --verify-presentation --scenario fox-scale";

export function assertPresentationPreconditions(preconditions: IPresentationPreconditions): void {
  if (!preconditions.verifyPresentation) return;
  if (!preconditions.headed) {
    throw new Error(
      `Presentation verification is fail-closed and cannot run headless. Use --headed --verify-presentation under Xvfb. ${PRESENTATION_GUIDANCE}`,
    );
  }
  if (preconditions.display === undefined || preconditions.display.trim().length === 0) {
    throw new Error(
      `Presentation verification requires DISPLAY; headless Chromium WebGPU counters do not prove presentation. ${PRESENTATION_GUIDANCE}`,
    );
  }
}

function failedPresentationSummary(
  summary: Omit<IPresentationFrameSummary, "reason" | "status">,
  reason: string,
): IPresentationFrameSummary {
  return { ...summary, reason, status: "fail" };
}

export function validatePresentationFrame(png: Buffer, label: string): IPresentationFrameSummary {
  const image = PNG.sync.read(png);
  const pixels = image.width * image.height;
  const buckets = new Map<number, number>();
  let foreground = 0;
  let luminanceTotal = 0;
  let luminanceSquaredTotal = 0;
  let opaque = 0;
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const red = image.data[offset] ?? 0;
    const green = image.data[offset + 1] ?? 0;
    const blue = image.data[offset + 2] ?? 0;
    const alpha = image.data[offset + 3] ?? 0;
    if (alpha >= 250) opaque += 1;
    const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
    luminanceTotal += luminance;
    luminanceSquaredTotal += luminance * luminance;
    const bucket = ((red >> 4) << 12) | ((green >> 4) << 8) | ((blue >> 4) << 4) | (alpha >> 4);
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }
  const mean = pixels === 0 ? 0 : luminanceTotal / pixels;
  const variance = pixels === 0 ? 0 : luminanceSquaredTotal / pixels - mean * mean;
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const red = image.data[offset] ?? 0;
    const green = image.data[offset + 1] ?? 0;
    const blue = image.data[offset + 2] ?? 0;
    const alpha = image.data[offset + 3] ?? 0;
    const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
    if (alpha >= 250 && Math.abs(luminance - mean) >= 0.02) foreground += 1;
  }
  const maxBucket = Math.max(0, ...buckets.values());
  const summary = {
    alphaOpaqueRatio: pixels === 0 ? 0 : opaque / pixels,
    foregroundRatio: pixels === 0 ? 0 : foreground / pixels,
    height: image.height,
    label,
    luminanceStdDev: Math.sqrt(Math.max(0, variance)),
    uniqueColorBuckets: buckets.size,
    width: image.width,
  };
  if (
    image.width < PRESENTATION_LIMITS.minDimension ||
    image.height < PRESENTATION_LIMITS.minDimension
  ) {
    throw new Error(
      JSON.stringify(
        failedPresentationSummary(
          summary,
          `presentation dimensions ${image.width}x${image.height} are too small`,
        ),
      ),
    );
  }
  if (summary.alphaOpaqueRatio < PRESENTATION_LIMITS.minOpaqueRatio) {
    throw new Error(
      JSON.stringify(failedPresentationSummary(summary, "presentation is mostly transparent")),
    );
  }
  if (summary.uniqueColorBuckets < PRESENTATION_LIMITS.minUniqueColorBuckets) {
    throw new Error(
      JSON.stringify(failedPresentationSummary(summary, "presentation is blank/uniform")),
    );
  }
  if (pixels > 0 && maxBucket / pixels > PRESENTATION_LIMITS.maxUniformBucketRatio) {
    throw new Error(
      JSON.stringify(failedPresentationSummary(summary, "presentation is near-uniform")),
    );
  }
  if (summary.luminanceStdDev < PRESENTATION_LIMITS.minLuminanceStdDev) {
    throw new Error(
      JSON.stringify(
        failedPresentationSummary(summary, "presentation luminance variance is too low"),
      ),
    );
  }
  if (summary.foregroundRatio < PRESENTATION_LIMITS.minForegroundRatio) {
    throw new Error(
      JSON.stringify(
        failedPresentationSummary(summary, "presentation foreground ratio is too low"),
      ),
    );
  }
  return { ...summary, status: "pass" };
}

export function classifyEvidence(input: {
  readonly adapterClass: AdapterClass;
  readonly presentation?: {
    readonly after?: { readonly status: string };
    readonly before?: { readonly status: string };
  };
  readonly verifyPresentation: boolean;
}): EvidenceClass {
  if (input.verifyPresentation) {
    return input.presentation?.before?.status === "pass" &&
      input.presentation.after?.status === "pass"
      ? "visual-verified"
      : "visual-rejected";
  }
  return input.adapterClass === "hardware"
    ? "timing-only-browser-hardware"
    : "timing-only-browser-software-diagnostic";
}

interface IBrowserResult {
  readonly adapter: IAdapterInfo | null;
  readonly samples: Record<string, readonly number[]>;
  readonly scenario: IWorkloadConfig & { readonly samples: number; readonly warmupFrames: number };
}

interface IProfileRun {
  readonly adapterClass: AdapterClass;
  readonly browserErrors: readonly string[];
  readonly evidence: EvidenceClass;
  readonly presentation?: IPresentationSummary;
  readonly repeat: number;
  readonly result: IBrowserResult;
  readonly summaries: Record<string, ReturnType<typeof summarizeSamples>>;
}

async function stopServer(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null) return;
  server.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => server.once("close", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
}

export function queryOf(
  scenario: IWorkloadConfig & { readonly rendering?: RenderingMode },
  args: IProfileArgs,
): string {
  return new URLSearchParams({
    dirty: String(scenario.dirtyRatio * 100),
    hierarchy: scenario.hierarchy,
    objects: String(scenario.objectCount),
    passes: String(scenario.passes ?? 1),
    ...(scenario.scenario ? { scenario: scenario.scenario } : {}),
    renderMode: scenario.renderMode ?? "independent",
    rendering: scenario.rendering ?? "complete",
    renderAdvisor: args.renderAdvisor ? "1" : "0",
    rendererStages: args.rendererStages ? "1" : "0",
    samples: String(args.samples),
    seed: String(scenario.seed),
    visibility: scenario.visibility,
    warmup: String(args.warmupFrames),
  }).toString();
}

function parsePresentationFailure(error: unknown, label: string): IPresentationFrameSummary {
  const message = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(message) as IPresentationFrameSummary;
    return parsed;
  } catch {
    return {
      alphaOpaqueRatio: 0,
      foregroundRatio: 0,
      height: 0,
      label,
      luminanceStdDev: 0,
      reason: message,
      status: "fail",
      uniqueColorBuckets: 0,
      width: 0,
    };
  }
}

async function capturePresentationFrame(
  page: Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>["newPage"]>>,
  outputDir: string,
  label: string,
  savePng: boolean,
): Promise<IPresentationFrameSummary> {
  const canvas = page.locator("canvas").first();
  await canvas.waitFor({ state: "visible", timeout: 30_000 });
  const png = await canvas.screenshot({ type: "png" });
  const stats = validatePresentationFrame(png, label);
  const hash = createHash("sha256").update(png).digest("hex");
  const summary = { ...stats, sha256: hash } as IPresentationFrameSummary & {
    readonly sha256: string;
  };
  if (savePng) await writeFile(path.join(outputDir, `${label}.png`), png);
  return summary;
}

async function verifyPresentation(
  page: Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>["newPage"]>>,
  args: IProfileArgs,
  scenario: IWorkloadConfig,
  repeat: number,
  phase: "after" | "before",
): Promise<IPresentationFrameSummary> {
  const labelParts = [
    "native-cpu-profile",
    scenario.scenario ?? `${scenario.objectCount}-${scenario.renderMode ?? "independent"}`,
    `run-${repeat}`,
    phase,
  ];
  const label = labelParts.join("-");
  const savePng = scenario.scenario === "fox-scale" && repeat === 1;
  try {
    return await capturePresentationFrame(page, args.outputDir, label, savePng);
  } catch (error) {
    const failure = parsePresentationFailure(error, label);
    throw new Error(`Presentation verification failed: ${JSON.stringify(failure)}`);
  }
}

function collectGitSource(): { branch: string; dirty: boolean; project: string; sha: string } {
  const git = (args: readonly string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
  const status = git(["status", "--porcelain"]);
  return {
    branch: git(["branch", "--show-current"]),
    dirty: status.length > 0,
    project: path.resolve("examples/native-cpu-load-test"),
    sha: git(["rev-parse", "HEAD"]),
  };
}

async function runProfile(args: IProfileArgs, rawArguments: readonly string[]): Promise<void> {
  assertPresentationPreconditions({
    display: process.env.DISPLAY ?? process.env.WAYLAND_DISPLAY,
    headed: args.headed,
    verifyPresentation: args.verifyPresentation,
  });
  await mkdir(args.outputDir, { recursive: true });
  const source = collectGitSource();
  const project = source.project;
  const server = spawn(
    "pnpm",
    [
      "--filter",
      "threenative-native-cpu-load-test",
      "dev",
      "--host",
      "127.0.0.1",
      "--port",
      String(args.port),
      "--strictPort",
    ],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  const output: string[] = [];
  server.stdout?.on("data", (chunk) => output.push(String(chunk)));
  server.stderr?.on("data", (chunk) => output.push(String(chunk)));
  const baseUrl = `http://127.0.0.1:${args.port}/`;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await waitForServer({ child: server, label: "Load-test server", url: baseUrl });
    browser = await chromium.launch({
      args: [
        "--ozone-platform=x11",
        "--enable-unsafe-webgpu",
        "--enable-features=Vulkan",
        "--disable-gpu-sandbox",
        "--ignore-gpu-blocklist",
        ...args.browserArgs,
      ],
      executablePath: args.browser,
      headless: !args.headed,
    });
    const runs: IProfileRun[] = [];
    for (const scenario of buildScenarioMatrix(args)) {
      for (let repeat = 1; repeat <= args.repeats; repeat += 1) {
        const page = await browser.newPage({ viewport: { height: 720, width: 1280 } });
        const errors: string[] = [];
        page.on("console", (message) => {
          if (message.type() === "error") errors.push(`console: ${message.text()}`);
        });
        page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
        await page.goto(`${baseUrl}?${queryOf(scenario, args)}`, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(
          () => Boolean((window as unknown as { __TN_CPU_PROFILE__?: unknown }).__TN_CPU_PROFILE__),
          undefined,
          { timeout: 60_000 },
        );
        if (args.warmupMs > 0) await page.waitForTimeout(args.warmupMs);
        if (errors.length > 0)
          throw new Error(
            `Browser console errors before presentation verification:\n${errors.join("\n")}`,
          );
        const beforePresentation = args.verifyPresentation
          ? await verifyPresentation(page, args, scenario, repeat, "before")
          : undefined;
        const result = (await page.evaluate(() =>
          (
            window as unknown as { __TN_CPU_PROFILE__: { run: () => Promise<unknown> } }
          ).__TN_CPU_PROFILE__.run(),
        )) as IBrowserResult;
        const afterPresentation = args.verifyPresentation
          ? await verifyPresentation(page, args, scenario, repeat, "after")
          : undefined;
        if (errors.length > 0) throw new Error(`Browser console errors:\n${errors.join("\n")}`);
        const adapterClass = classifyAdapter(result.adapter);
        assertGpuEvidenceAllowed(adapterClass, args.allowSoftware);
        const presentation =
          beforePresentation !== undefined && afterPresentation !== undefined
            ? { after: afterPresentation, before: beforePresentation }
            : undefined;
        const evidence = classifyEvidence({
          adapterClass,
          presentation,
          verifyPresentation: args.verifyPresentation,
        });
        if (args.verifyPresentation && evidence !== "visual-verified") {
          throw new Error(`Presentation verification failed closed with evidence=${evidence}.`);
        }
        const summaries = Object.fromEntries(
          Object.entries(result.samples).map(([name, values]) => [name, summarizeSamples(values)]),
        );
        runs.push({
          adapterClass,
          browserErrors: [...errors],
          evidence,
          presentation,
          repeat,
          result,
          summaries,
        });
        process.stdout.write(
          `${scenario.objectCount} ${scenario.renderMode} passes=${scenario.passes} ${scenario.hierarchy} dirty=${scenario.dirtyRatio} ${scenario.visibility} run=${repeat}: matrix=${summaries.matrixWorldMs?.median.toFixed(3)}ms render=${summaries.renderMs?.median.toFixed(3)}ms draws=${summaries.drawCalls?.median.toFixed(0)} frame=${summaries.frameMs?.median.toFixed(3)}ms (${adapterClass})\n`,
        );
        await page.close();
      }
    }
    await mkdir(args.outputDir, { recursive: true });
    const report = {
      ...buildProfileProvenance(args, rawArguments),
      browser: {
        display: process.env.DISPLAY ?? process.env.WAYLAND_DISPLAY ?? null,
        headed: args.headed,
        verifyPresentation: args.verifyPresentation,
      },
      evidence: runs.every((run) => run.evidence === "visual-verified")
        ? "visual-verified"
        : runs.some((run) => run.evidence === "visual-rejected")
          ? "visual-rejected"
          : runs.every((run) => run.adapterClass === "hardware")
            ? "timing-only-browser-hardware"
            : "timing-only-browser-software-diagnostic",
      host: {
        cpu: cpus()[0]?.model ?? "unknown",
        node: process.version,
        os: `${platform()} ${release()}`,
      },
      recordedAt: new Date().toISOString(),
      runs,
      source,
    };
    const outputPath = path.join(args.outputDir, `profile-${Date.now()}.json`);
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`wrote ${outputPath}\n`);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${output.join("").slice(-4_000)}`,
    );
  } finally {
    await browser?.close();
    await stopServer(server);
  }
}

export async function runNativeCpuProfile(
  cliArgs: readonly string[] = process.argv.slice(2),
): Promise<void> {
  if (cliArgs.includes("--help")) {
    process.stdout.write(
      "pnpm profile:native-cpu -- [--diagnostic] [--render-advisor] [--visual-evidence fox-scale] [--verify-presentation --headed] [--scenario fox-scale] [--objects 500,1000] [--render-mode independent,distinct-materials,instanced,merged,scene-projection] [--rendering cpu-only,complete] [--passes 1,2] [--hierarchy flat,deep] [--dirty 0,10,100] [--visibility all-visible,mostly-culled,alternating] [--repeats 3] [--samples 180] [--allow-software]\nVisual evidence must run headed with a display; use pnpm profile:native-cpu:fox or sh scripts/xvfb.sh pnpm profile:native-cpu -- --headed --verify-presentation --scenario fox-scale. Timing-only headless runs are labeled timing-only. CPU-only rows contain preparation measurements and zeroed render counters.\n",
    );
    return;
  }
  await runProfile(parseProfileArgs(cliArgs), cliArgs);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void (async () => {
    const { createGateRecorder } = await import("./gate-records.mjs");
    const recorder = await createGateRecorder({
      phase: "profile-native-cpu",
      command: ["pnpm profile:native-cpu", ...process.argv.slice(2)].join(" "),
    });
    let exit = 0;
    try {
      await runNativeCpuProfile();
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      exit = 1;
    } finally {
      await recorder.finish(exit);
    }
    if (exit !== 0) process.exitCode = 1;
  })();
}
