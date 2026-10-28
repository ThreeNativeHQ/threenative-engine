import { spawn } from "node:child_process";
import { access, cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProject, templateRoot } from "../packages/create-threenative/src/index.js";
import { TEMPLATE_NAMES, inspectAllTemplates, packageLocalFramework } from "./visual-gate.js";

/**
 * The two kits `golden-path-template` already boots, so this matrix covers the rest.
 *
 * Exported so the suite can derive the expected matrix from it and from the templates on
 * disk, instead of keeping a third copy of the list that goes stale the day a kit ships.
 */
export const ALREADY_BOOTED_TEMPLATES = new Set(["platformer", "starter"]);
export const TEMPLATE_PLAYTEST_NAMES = TEMPLATE_NAMES.filter(
  (template) => !ALREADY_BOOTED_TEMPLATES.has(template),
);

async function run(command: string, args: readonly string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} ${args.join(" ")} exited ${code ?? "unknown"}.`)),
    );
  });
}

export interface ITemplatePlaytestResult {
  readonly error?: string;
  readonly pass: boolean;
  readonly template: string;
}

export interface ITemplatePlaytestAudit {
  readonly assumesStartInPlay?: number;
  readonly error?: string;
  readonly explicitStart?: number;
  readonly scenarioCount: number;
  readonly template: string;
}

export interface ITemplatePlaytestStructure {
  readonly errors: readonly string[];
  readonly files?: readonly string[];
  readonly template: string;
}

export interface ITemplatePlaytestDependencies {
  readonly auditRoot?: string;
  readonly createProject?: typeof createProject;
  readonly inspectTemplates?: () => readonly ITemplatePlaytestStructure[];
  readonly run?: typeof run;
  readonly templatePlaytestRoot?: string;
}

interface IJsonRecord {
  readonly [key: string]: unknown;
}

const TEMPLATE_PLAYTEST_ROOTS = ["playtests", "native-playtests"] as const;

/**
 * Runs each selected template independently and reports every result before failing the sweep.
 * A failed scaffold is a result too: the next template must still be exercised.
 */
export async function runTemplatePlaytests(
  templates: readonly string[],
  root: string,
  packageSources: Readonly<Record<string, string>>,
  dependencies: ITemplatePlaytestDependencies = {},
): Promise<readonly ITemplatePlaytestResult[]> {
  const create = dependencies.createProject ?? createProject;
  const execute = dependencies.run ?? run;
  const extrasRoot = dependencies.templatePlaytestRoot ?? defaultTemplatePlaytestRoot();
  const results: ITemplatePlaytestResult[] = [];
  for (const template of templates) {
    const target = path.join(root, template);
    let testError: string | undefined;
    let smokeError: string | undefined;
    let liveMotionError: string | undefined;
    try {
      await create({ install: true, packageSources, target, template });
      try {
        // The guards a template no longer ships, so the engine keeps proving what it proved
        // while a new game proves itself with three scenarios (PRD-449).
        await copyExtras(path.join(extrasRoot, template), path.join(target, "playtests"));
        await execute("pnpm", ["test"], target);
      } catch (error) {
        testError = errorDetail(error);
      }

      const smokeScenario = path.join(target, ".threenative-template-boot.playtest.json");
      try {
        await writeFile(smokeScenario, JSON.stringify(templateBootScenario(template)));
        await execute(
          "pnpm",
          [
            "exec",
            "threenative-playtest",
            "--scenario",
            ".threenative-template-boot.playtest.json",
            "--browser-recipe",
            "webgpu",
            "--headed",
            "--server-command",
            "pnpm dev --host 127.0.0.1 --port $PORT --strictPort",
          ],
          target,
        );
      } catch (error) {
        smokeError = errorDetail(error);
      } finally {
        await rm(smokeScenario, { force: true });
      }

      if (template === "sailing") {
        try {
          await execute(
            "pnpm",
            [
              "exec",
              "threenative-playtest",
              "--scenario",
              "playtests/live/render-motion.playtest.json",
              "--live-clock",
              "--browser-recipe",
              "webgpu",
              "--headed",
              "--server-command",
              "pnpm dev --host 127.0.0.1 --port $PORT --strictPort",
            ],
            target,
          );
        } catch (error) {
          liveMotionError = errorDetail(error);
        }
      }

      const errors = [testError, smokeError, liveMotionError].filter(
        (error): error is string => error !== undefined,
      );
      if (errors.length === 0) {
        console.info(`${template}: scaffolded playtests passed.`);
        results.push({ pass: true, template });
      } else {
        const detail = errors.join(" ");
        console.error(`${template}: scaffolded playtests failed: ${detail}`);
        results.push({ error: detail, pass: false, template });
      }
    } catch (error) {
      const detail = errorDetail(error);
      console.error(`${template}: scaffolded playtests failed: ${detail}`);
      results.push({ error: detail, pass: false, template });
    }
  }
  return results;
}

/** Sits beside `templates/`, so it is never packed into a generated project's `files` list. */
function defaultTemplatePlaytestRoot(): string {
  return path.resolve(templateRoot(), "..", "template-playtests");
}

/** No extras for this template is the normal case, not a failure. */
async function copyExtras(source: string, target: string): Promise<void> {
  await cp(source, target, { recursive: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  });
}

function templateBootScenario(template: string): IJsonRecord {
  return {
    artifacts: { screenshots: "after" },
    assert: {
      diagnostics: { noConsoleErrors: true, noNetworkErrors: true, runtimeReady: true },
      visual: [{ region: { height: 360, minNonblankPixelRatio: 0.0001, width: 640, x: 0, y: 0 } }],
    },
    name: `${template}-real-frame-boot`,
    schemaVersion: 1,
    steps: [{ kind: "wait", release: true, waitTicks: 60 }],
    target: "web",
    viewport: { height: 360, width: 640 },
    warmupFrames: 5,
  };
}

export function assertTemplatePlaytestsPassed(results: readonly ITemplatePlaytestResult[]): void {
  const failed = results.filter(({ pass }) => !pass);
  if (failed.length > 0) {
    throw new Error(
      `TN_TEMPLATE_PLAYTESTS_FAILED: ${failed
        .map(({ error, template }) => `${template}: ${error ?? "unknown error"}`)
        .join("; ")}`,
    );
  }
}

/** Audits every scenario in each template's web and native playtest trees. */
export async function auditTemplatePlaytests(
  root: string,
  templates: readonly string[],
): Promise<readonly ITemplatePlaytestAudit[]> {
  const audits: ITemplatePlaytestAudit[] = [];
  for (const template of templates) {
    let files: readonly string[] = [];
    try {
      files = (
        await Promise.all(
          TEMPLATE_PLAYTEST_ROOTS.map((directory) =>
            scenarioFiles(path.join(root, template, directory)),
          ),
        )
      )
        .flat()
        .sort();
      let explicitStart = 0;
      for (const file of files) {
        const scenario = await readScenario(file);
        if (hasExplicitStart(scenario)) explicitStart += 1;
      }
      audits.push({
        assumesStartInPlay: files.length - explicitStart,
        explicitStart,
        scenarioCount: files.length,
        template,
      });
    } catch (error) {
      const detail = errorDetail(error);
      console.error(`${template}: template playtest audit failed: ${detail}`);
      audits.push({ error: detail, scenarioCount: files.length, template });
    }
  }
  return audits;
}

/** Audits and runs every selected template before failing on any audit or playtest result. */
export async function verifyTemplatePlaytests(
  templates: readonly string[],
  root: string,
  packageSources: Readonly<Record<string, string>>,
  dependencies: ITemplatePlaytestDependencies = {},
): Promise<readonly ITemplatePlaytestResult[]> {
  const audits = await auditTemplatePlaytests(dependencies.auditRoot ?? templateRoot(), templates);
  for (const audit of audits) {
    if (audit.error !== undefined) continue;
    console.info(
      `template audit ${audit.template}: ${audit.scenarioCount} scenarios; ${audit.assumesStartInPlay} assume start in play; ${audit.explicitStart} declare an explicit start.`,
    );
  }

  const structures = (dependencies.inspectTemplates ?? inspectAllTemplates)();
  const structuralFailures = structures.flatMap(({ errors, template }) =>
    templates.includes(template) && errors.length > 0
      ? [{ error: `TN_VISUAL_STRUCTURE_FAILED:\n${errors.join("\n")}`, pass: false, template }]
      : [],
  );
  for (const failure of structuralFailures)
    console.error(`${failure.template}: template structure failed: ${failure.error}`);

  const results = await runTemplatePlaytests(templates, root, packageSources, dependencies);
  const auditFailures = audits.flatMap(({ error, template }) =>
    error === undefined ? [] : [{ error, pass: false, template }],
  );
  assertTemplatePlaytestsPassed([...results, ...auditFailures, ...structuralFailures]);
  return results;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function scenarioFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const files: string[] = [];
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await scenarioFiles(file)));
    else if (entry.isFile() && entry.name.endsWith(".playtest.json")) files.push(file);
  }
  return files.sort();
}

async function readScenario(file: string): Promise<IJsonRecord> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`TN_TEMPLATE_PLAYTEST_AUDIT_INVALID: ${file}: ${String(error)}`);
  }
  if (!isRecord(value)) {
    throw new Error(`TN_TEMPLATE_PLAYTEST_AUDIT_INVALID: ${file}: expected a JSON object.`);
  }
  return value;
}

function hasExplicitStart(scenario: IJsonRecord): boolean {
  const steps = scenario.steps;
  if (steps === undefined) return false;
  if (!Array.isArray(steps)) {
    throw new Error("TN_TEMPLATE_PLAYTEST_AUDIT_INVALID: steps is not an array.");
  }
  return steps.some((step) => isRecord(step) && step.label === "start-game");
}

function isRecord(value: unknown): value is IJsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WASM_ENGINE_FILES = ["tn-native-engine-web.mjs", "tn-native-engine-web.wasm"];

/**
 * Every template boots on the default web engine, which is built, not committed. Check the pair
 * before the sweep packs anything, so a missing engine costs one line instead of eight failed builds.
 */
export async function assertWasmEngineBuilt(repoRoot: string = REPO_ROOT): Promise<void> {
  const web = path.join(repoRoot, "packages/runtime-native/build/web");
  for (const file of WASM_ENGINE_FILES) {
    await access(path.join(web, file)).catch(() => {
      throw new Error(
        `TN_WASM_ENGINE_MISSING: ${path.join(web, file)} does not exist; run \`pnpm wasm:build\` from the repository root.`,
      );
    });
  }
}

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "threenative-template-playtests-"));
  try {
    if (TEMPLATE_NAMES.length === 0) throw new Error("TN_TEMPLATE_DISCOVERY_EMPTY");
    // One template at a time while iterating on it: the full sweep scaffolds, installs and drives
    // eight projects, and a filtered run is the difference between a ten-minute loop and a one-
    // minute one. Unset — which is what CI is — every template runs.
    const only = process.env.TN_TEMPLATE_ONLY?.split(",").filter((name) => name !== "");
    if (only !== undefined) {
      const unknown = only.filter((name) => !TEMPLATE_PLAYTEST_NAMES.includes(name));
      if (unknown.length > 0)
        throw new Error(`TN_TEMPLATE_ONLY names no such template: ${unknown.join(", ")}`);
    }
    await assertWasmEngineBuilt();
    const packageSources = await packageLocalFramework(root);
    await verifyTemplatePlaytests(only ?? TEMPLATE_PLAYTEST_NAMES, root, packageSources);
  } finally {
    if (process.env.TN_TEMPLATE_KEEP === "1") console.info(`TN_TEMPLATE_KEEP root: ${root}`);
    else await rm(root, { force: true, recursive: true });
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    process.stderr.write(`${errorDetail(error)}\n`);
    process.exitCode = 1;
  });
}
