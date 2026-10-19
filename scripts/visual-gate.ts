import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import {
  type ScaffoldTemplate,
  createProject,
  discoverTemplateNames,
} from "../packages/create-threenative/src/index.js";
import { WEBGPU_BROWSER_ARGS } from "../packages/playtest/src/runner/browser.js";
import { type CaptureFrameStats, assertFrameShowsSomething } from "./capture-guard.js";
import {
  type ImageScoringArtifact,
  createImageBlindBundle,
  hashPromptFile,
} from "./score-blind.js";
import { localPackageEntries, workspacePackages } from "./workspace-packages.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE_ROOT = path.join(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  "packages/create-threenative/templates",
);
export const TEMPLATE_NAMES: readonly ScaffoldTemplate[] = discoverTemplateNames(TEMPLATE_ROOT);
export const RENDER_LAYER_FILES = [
  "palette.ts",
  "camera.ts",
  "sky.ts",
  "lighting.ts",
  "materials.ts",
  "postprocessing.ts",
] as const;
export const VISUAL_SCORE_FLOOR = 4;
export const LOCAL_FRAMEWORK_PACKAGES = localPackageEntries(REPO_ROOT);

export function visualServerProcessGroup(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): number {
  return platform === "win32" ? pid : -pid;
}

export async function assertVisualPortAvailable(port: number): Promise<void> {
  const probe = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", () => {
        probe.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    });
  } catch (error) {
    throw new Error(
      `TN_VISUAL_PORT_IN_USE: template server port ${port} is unavailable; stop the stale listener before capturing.`,
      { cause: error },
    );
  }
}

async function waitVisualServerExit(server: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (server.exitCode !== null || server.signalCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      server.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    server.once("exit", onExit);
  });
}

export async function stopVisualServer(server: ChildProcess): Promise<void> {
  if (server.pid === undefined || server.exitCode !== null || server.signalCode !== null) return;
  const stopped = waitVisualServerExit(server, 2_000);
  try {
    process.kill(visualServerProcessGroup(server.pid), "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  if (await stopped) return;
  try {
    process.kill(visualServerProcessGroup(server.pid), "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  await waitVisualServerExit(server, 1_000);
}

export interface TemplateStructureResult {
  readonly errors: readonly string[];
  readonly files: readonly string[];
  readonly template: ScaffoldTemplate;
}

export interface VisualScoreFile {
  readonly parity: { readonly framework: number; readonly vanilla: number };
  readonly templates: Record<ScaffoldTemplate, number>;
}

export interface VisualCaptureResult {
  readonly stats: CaptureFrameStats;
  readonly template: ScaffoldTemplate;
}

export type CaptureTemplate = (
  template: ScaffoldTemplate,
  root: string,
  packageSources: Record<string, string>,
  port: number,
) => Promise<{ content: Buffer; stats: CaptureFrameStats }>;

export interface IVisualCaptureOptions {
  readonly captureTemplate?: CaptureTemplate;
  readonly visualRoot?: string;
}

const VISUAL_ROOT = path.join(REPO_ROOT, "docs/verification/visuals");
const BASELINE = path.join(REPO_ROOT, "docs/product/VISUAL-BASELINE.md");

/** The gate owns the verification capture. */
export async function persistTemplateCapture(
  template: ScaffoldTemplate,
  content: Buffer,
  visualRoot = VISUAL_ROOT,
): Promise<void> {
  await mkdir(visualRoot, { recursive: true });
  await writeFile(path.join(visualRoot, `${template}.png`), content);
}

function sourceFiles(directory: string): string[] {
  const entries = readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.(?:ts|tsx)$/u.test(entry.name) ? [file] : [];
  });
}

function requiredImport(source: string, stem: string): boolean {
  return new RegExp(`(?:from|import\\s*\\()\\s*["'][^"']*${stem}\\.js["']`, "u").test(source);
}

function paletteKeys(source: string): string[] | undefined {
  const body = source.match(/export\s+const\s+palette\s*=\s*\{([\s\S]*?)\}\s+as\s+const/u)?.[1];
  if (body === undefined) return undefined;
  return [...body.matchAll(/^\s{2}([A-Za-z_$][\w$]*)\s*:/gmu)].map((match) => match[1] ?? "");
}

export function inspectTemplate(
  template: ScaffoldTemplate,
  root = TEMPLATE_ROOT,
): TemplateStructureResult {
  const templateRoot = path.join(root, template, "src");
  const renderRoot = path.join(templateRoot, "render");
  const errors: string[] = [];
  const files = existsSync(renderRoot)
    ? readdirSync(renderRoot).filter((file) => file.endsWith(".ts"))
    : [];
  const sources = existsSync(templateRoot)
    ? sourceFiles(templateRoot).map((file) => ({ file, source: readFileSync(file, "utf8") }))
    : [];

  for (const file of RENDER_LAYER_FILES) {
    const filePath = path.join(renderRoot, file);
    if (!existsSync(filePath)) errors.push(`${template}: missing src/render/${file}`);
    const stem = file.slice(0, -3);
    if (
      !sources.some(
        ({ file: sourceFile, source }) => sourceFile !== filePath && requiredImport(source, stem),
      )
    )
      errors.push(`${template}: src/render/${file} has no live importer`);
  }

  const palette = existsSync(path.join(renderRoot, "palette.ts"))
    ? readFileSync(path.join(renderRoot, "palette.ts"), "utf8")
    : "";
  const keys = paletteKeys(palette);
  if (keys === undefined) errors.push(`${template}: palette.ts must export a palette object`);
  else {
    if (keys.length > 6)
      errors.push(`${template}: palette has ${keys.length} named colours; maximum is 6`);
    if (keys.filter((key) => key === "accent").length !== 1)
      errors.push(`${template}: palette must contain exactly one accent role`);
  }

  const readRender = (file: string): string => {
    const filePath = path.join(renderRoot, file);
    return existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  };
  const materials = readRender("materials.ts");
  const sky = readRender("sky.ts");
  const lighting = readRender("lighting.ts");
  const post = readRender("postprocessing.ts");
  const worldEnvironment = readRender("worldEnvironment.ts");
  const postPipeline = `${post}\n${worldEnvironment}`;
  if (!/from ["']\.\/palette\.js["']/u.test(materials))
    errors.push(`${template}: materials.ts must import palette.ts`);
  if (!/from ["']\.\/palette\.js["']/u.test(sky))
    errors.push(`${template}: sky.ts must import palette.ts`);
  // An image-based environment is fill and rim at once: it lights every face the key misses and
  // puts the sky's own highlight on every silhouette, which is what the rim light was faking.
  const imageLit = /\.environment\s*=/u.test(`${sky}\n${lighting}`);
  const directional = (lighting.match(/new DirectionalLight/g) ?? []).length;
  if (directional < (imageLit ? 1 : 2))
    errors.push(`${template}: lighting.ts needs a key and rim DirectionalLight`);
  if (!imageLit && !/new (?:HemisphereLight|AmbientLight)/u.test(lighting))
    errors.push(`${template}: lighting.ts needs a fill or ambient light`);
  // The shadow-map markers belong to a light that casts one. A ray-marched kit computes its own
  // occlusion and enables no shadow map, so demanding the soft-filter settings there would only
  // demand dead configuration.
  if (/castShadow\s*=\s*true/u.test(lighting)) {
    for (const marker of ["PCFSoftShadowMap", "normalBias"]) {
      if (!lighting.includes(marker)) errors.push(`${template}: lighting.ts is missing ${marker}`);
    }
  }
  for (const marker of ["toneMapping", "toneMappingExposure", "createRenderChain", "bloom("]) {
    if (!postPipeline.includes(marker))
      errors.push(`${template}: render pipeline is missing ${marker}`);
  }

  return { errors, files, template };
}

export function inspectAllTemplates(root = TEMPLATE_ROOT): readonly TemplateStructureResult[] {
  const names = discoverTemplateNames(root);
  if (names.length === 0) throw new Error(`TN_TEMPLATE_DISCOVERY_EMPTY: ${root}`);
  return names.map((template) => inspectTemplate(template, root));
}

function score(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 5)
    throw new Error(`TN_VISUAL_SCORE_INVALID: ${label} must be an integer from 1 to 5.`);
  return value;
}

export function validateVisualScores(value: unknown): VisualScoreFile {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("TN_VISUAL_SCORE_INVALID: expected a score object.");
  const record = value as Record<string, unknown>;
  const templateRecord = record.templates;
  const parity = record.parity;
  if (
    typeof templateRecord !== "object" ||
    templateRecord === null ||
    Array.isArray(templateRecord)
  )
    throw new Error("TN_VISUAL_SCORE_INVALID: templates scores are required.");
  if (typeof parity !== "object" || parity === null || Array.isArray(parity))
    throw new Error("TN_VISUAL_SCORE_INVALID: parity scores are required.");
  const templateScores = templateRecord as Record<string, unknown>;
  const missingTemplates = TEMPLATE_NAMES.filter(
    (template) => !Object.hasOwn(templateScores, template),
  );
  const staleTemplates = Object.keys(templateScores).filter(
    (template) => !TEMPLATE_NAMES.includes(template as ScaffoldTemplate),
  );
  if (missingTemplates.length > 0 || staleTemplates.length > 0)
    throw new Error(
      `TN_VISUAL_SCORE_TEMPLATES_MISMATCH: missing ${missingTemplates.join(", ") || "none"}; stale ${staleTemplates.join(", ") || "none"}.`,
    );
  const templates = Object.fromEntries(
    TEMPLATE_NAMES.map((template) => [template, score(templateScores[template], template)]),
  ) as Record<ScaffoldTemplate, number>;
  const parityRecord = parity as Record<string, unknown>;
  const result: VisualScoreFile = {
    parity: {
      framework: score(parityRecord.framework, "parity.framework"),
      vanilla: score(parityRecord.vanilla, "parity.vanilla"),
    },
    templates,
  };
  for (const [label, valueToCheck] of Object.entries({ ...templates, ...result.parity })) {
    if (valueToCheck < VISUAL_SCORE_FLOOR)
      throw new Error(
        `TN_VISUAL_SCORE_FLOOR: ${label} scored ${valueToCheck}; floor is ${VISUAL_SCORE_FLOOR}.`,
      );
  }
  return result;
}

function argumentValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function runCommand(command: string, args: readonly string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const output: string[] = [];
    child.stdout?.on("data", (chunk) => output.push(String(chunk)));
    child.stderr?.on("data", (chunk) => output.push(String(chunk)));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `${command} ${args.join(" ")} exited ${code ?? "unknown"}.\n${output.join("").slice(-4_000)}`,
          ),
        );
    });
  });
}

async function waitForServer(
  url: string,
  server: ChildProcess,
  timeoutMs = 120_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (server.exitCode !== null)
      throw new Error(`Visual server exited with code ${server.exitCode}.`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Visual server did not become ready within ${timeoutMs}ms.`);
}

export async function packageLocalFramework(root: string): Promise<Record<string, string>> {
  const packageRoot = path.join(root, "packages");
  await mkdir(packageRoot, { recursive: true });
  const packages = LOCAL_FRAMEWORK_PACKAGES;
  const manifests = new Map(workspacePackages(REPO_ROOT).map((item) => [item.name, item]));
  const archives = new Map<string, string>();
  for (const [name] of packages) {
    if (manifests.get(name)?.scripts.build !== undefined) {
      await runCommand("pnpm", ["--filter", name, "build"], REPO_ROOT);
    }
    await runCommand(
      "pnpm",
      ["--filter", name, "pack", "--pack-destination", packageRoot],
      REPO_ROOT,
    );
  }
  for (const file of await readdir(packageRoot)) {
    if (!file.endsWith(".tgz")) continue;
    const key = packages.find(([, prefix]) => file.startsWith(prefix))?.[0];
    if (key !== undefined) archives.set(key, path.join(packageRoot, file));
  }
  if (archives.size !== packages.length)
    throw new Error("TN_VISUAL_PACKAGES_MISSING: local package archives were not created.");
  return Object.fromEntries(archives);
}

const captureTemplate: CaptureTemplate = async (
  template: ScaffoldTemplate,
  root: string,
  packageSources: Record<string, string>,
  port: number,
): Promise<{ content: Buffer; stats: CaptureFrameStats }> => {
  const result = await createProject(
    {
      install: true,
      packageSources,
      target: template,
      template,
    },
    root,
  );
  await runCommand("pnpm", ["build"], result.target);
  await assertVisualPortAvailable(port);
  const server = spawn(
    "pnpm",
    ["dev", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd: result.target,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const output: string[] = [];
  server.stdout?.on("data", (chunk) => output.push(String(chunk)));
  server.stderr?.on("data", (chunk) => output.push(String(chunk)));
  try {
    await waitForServer(`http://127.0.0.1:${port}/`, server);
    const browser = await chromium.launch({
      args: [...WEBGPU_BROWSER_ARGS],
      headless: false,
      timeout: 30_000,
    });
    try {
      const page = await browser.newPage({ viewport: { height: 720, width: 1280 } });
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("canvas", { timeout: 30_000 });
      if ((await page.locator('[data-threenative-canvas="true"]').count()) > 0)
        await page.waitForSelector('[data-threenative-startup="ready"]', { timeout: 30_000 });
      else await page.waitForTimeout(2_000);
      await page.waitForTimeout(250);
      if (pageErrors.length > 0) throw new Error(`TN_VISUAL_PAGE_ERROR: ${pageErrors.join(" | ")}`);
      const content = await page.screenshot({ type: "png" });
      const stats = assertFrameShowsSomething(content, template);
      return { content, stats };
    } finally {
      await browser.close();
    }
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${output.join("").slice(-4_000)}`,
    );
  } finally {
    await stopVisualServer(server);
  }
};

export async function captureAllTemplates(
  root: string,
  packages: Record<string, string>,
  options: IVisualCaptureOptions = {},
): Promise<readonly VisualCaptureResult[]> {
  const capture = options.captureTemplate ?? captureTemplate;
  const results: VisualCaptureResult[] = [];
  for (const [index, template] of TEMPLATE_NAMES.entries()) {
    const packageSources = Object.fromEntries(
      Object.entries(packages).filter(
        ([name]) => name !== "@threenative/ui" || template !== "minimal",
      ),
    );
    const result = await capture(template, root, packageSources, 5300 + index);
    await persistTemplateCapture(template, result.content, options.visualRoot);
    results.push({ stats: result.stats, template });
  }
  return results;
}

async function buildAllTemplates(root: string, packages: Record<string, string>): Promise<void> {
  for (const template of TEMPLATE_NAMES) {
    const packageSources = Object.fromEntries(
      Object.entries(packages).filter(
        ([name]) => name !== "@threenative/ui" || template !== "minimal",
      ),
    );
    const result = await createProject(
      {
        install: true,
        packageSources,
        target: template,
        template,
      },
      root,
    );
    await runCommand("pnpm", ["build"], result.target);
    console.log(`${template}: scaffold build passed.`);
  }
}

function createParityBundle(framework: string, vanilla: string): void {
  const bundle = path.join(VISUAL_ROOT, "parity-blind");
  const reveal = path.join(VISUAL_ROOT, "parity-reveal.json");
  const artifacts: ImageScoringArtifact[] = [
    { arm: "framework", content: readFileSync(framework), id: "framework-reference" },
    { arm: "vanilla", content: readFileSync(vanilla), id: "vanilla-reference" },
  ];
  createImageBlindBundle(hashPromptFile(BASELINE), artifacts, bundle, reveal);
}

export async function runVisualGate(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const structures = inspectAllTemplates();
  const structuralErrors = structures.flatMap(({ errors }) => errors);
  if (structuralErrors.length > 0)
    throw new Error(`TN_VISUAL_STRUCTURE_FAILED:\n${structuralErrors.join("\n")}`);
  console.log(`Visual structure passed for ${TEMPLATE_NAMES.join(", ")}.`);
  if (args.includes("--structural-only")) return;

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "threenative-visuals-"));
  try {
    const packages = await packageLocalFramework(temporaryRoot);
    if (args.includes("--build-only")) {
      await buildAllTemplates(temporaryRoot, packages);
      return;
    }
    const captures = await captureAllTemplates(temporaryRoot, packages);
    for (const capture of captures)
      console.log(`${capture.template}: ${JSON.stringify(capture.stats)}`);

    const framework =
      argumentValue(args, "--framework-frame") ?? path.join(VISUAL_ROOT, "parity-framework.png");
    const vanilla =
      argumentValue(args, "--vanilla-frame") ?? path.join(VISUAL_ROOT, "parity-vanilla.png");
    if (!existsSync(framework) || !existsSync(vanilla))
      throw new Error(
        "TN_VISUAL_PARITY_UNVERIFIED: supply --framework-frame and --vanilla-frame for a blind pair.",
      );
    createParityBundle(framework, vanilla);

    const scorePath = argumentValue(args, "--scores") ?? path.join(VISUAL_ROOT, "scores.json");
    if (!existsSync(scorePath))
      throw new Error(
        `TN_VISUAL_SCORE_UNVERIFIED: human Visuals scores are required at ${scorePath}.`,
      );
    const scores = validateVisualScores(JSON.parse(await readFile(scorePath, "utf8")) as unknown);
    if (scores.parity.framework < scores.parity.vanilla)
      throw new Error(
        `TN_VISUAL_PARITY_LOSS: framework ${scores.parity.framework} < vanilla ${scores.parity.vanilla}.`,
      );
    console.log(
      `Visual scores passed at floor ${VISUAL_SCORE_FLOOR}; framework parity is not below vanilla.`,
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void (async () => {
    const { createGateRecorder } = await import("./gate-records.mjs");
    const recorder = await createGateRecorder({
      phase: "visual-gate",
      command: ["pnpm visuals", ...process.argv.slice(2)].join(" "),
    });
    let exit = 0;
    try {
      await runVisualGate();
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      exit = 1;
    } finally {
      await recorder.finish(exit);
    }
    if (exit !== 0) process.exitCode = 1;
  })();
}
