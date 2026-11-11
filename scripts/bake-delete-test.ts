import type { Dirent } from "node:fs";
import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";
import type { IBakeReceipt, IBakeReceiptOutput } from "../packages/assets/src/index.js";
import { templateNames } from "./lib/repo-inventory.mjs";

/**
 * The delete-test: build a game, run its scenario, delete every file the bake produced, run the
 * same scenario against the same source, and require that the game still runs and still draws the
 * same picture.
 *
 * This is the rule that separates a baking pass from v1's IR — *delete the entire baked output and
 * the game runs identically, just slower* — turned from a paragraph in an architecture document
 * into a command that goes red. It is written now, while there is one baking pass to get it right
 * on, rather than retrofitted after a second one has already been shipped wrong.
 *
 * Fails closed everywhere: a missing receipt, an empty receipt, a receipt naming a path outside the
 * output root, a scenario that asserts nothing, and a second run that does not complete are all
 * failures. None of them is a skip.
 */

export const RECEIPT_NAME = "bake.receipt.json";
export const MANIFEST_NAME = "assets.manifest.json";

export interface ICaptureDelta {
  /** Mean absolute per-channel difference, 0–255. */
  readonly meanAbsolute: number;
  /** Fraction of pixels whose colour changed at all, 0–1. */
  readonly movedRatio: number;
}

export interface IBakeDeleteTestReport {
  readonly band: ICaptureDelta;
  readonly change: ICaptureDelta;
  readonly deleted: readonly string[];
  readonly pass: boolean;
  readonly reasons: readonly string[];
  readonly template: string;
}

/** Reads a receipt, failing closed on every shape that would let the gate delete nothing. */
export async function readReceipt(outputRoot: string): Promise<IBakeReceipt> {
  let raw: string;
  try {
    raw = await readFile(path.join(outputRoot, RECEIPT_NAME), "utf8");
  } catch {
    throw new Error(
      `TN_DELETE_TEST_NO_RECEIPT: '${path.join(outputRoot, RECEIPT_NAME)}' does not exist, so nothing here knows what the bake produced. Build the project with a pipeline that writes one.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `TN_DELETE_TEST_BAD_RECEIPT: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { outputs?: unknown }).outputs)
  ) {
    throw new Error("TN_DELETE_TEST_BAD_RECEIPT: no outputs array");
  }
  const receipt = parsed as IBakeReceipt;
  if (receipt.outputs.length === 0) {
    throw new Error(
      "TN_DELETE_TEST_EMPTY_RECEIPT: the receipt lists no outputs, so a green run would prove nothing was deleted rather than that the game survived deletion.",
    );
  }
  return receipt;
}

/**
 * Resolves every path the gate will unlink, and refuses anything outside the output root.
 *
 * A receipt is a file on disk, so it is input: a `../` entry would have this gate delete the
 * project's source assets and then report that the game could not run without them.
 */
export function deletionPlan(receipt: IBakeReceipt, outputRoot: string): string[] {
  const root = path.resolve(outputRoot);
  const paths: string[] = [];
  for (const output of receipt.outputs as readonly IBakeReceiptOutput[]) {
    if (typeof output.path !== "string" || output.path.length === 0) {
      throw new Error("TN_DELETE_TEST_BAD_RECEIPT: an output has no path");
    }
    const absolute = path.resolve(root, output.path);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
      throw new Error(
        `TN_DELETE_TEST_ESCAPES_ROOT: receipt entry '${output.path}' resolves to '${absolute}', outside '${root}'.`,
      );
    }
    paths.push(absolute);
  }
  // The manifest and the receipt are bake output too, and deleting them is the point: the runtime
  // documents a fallback to the source path when the manifest is absent, and this is the only
  // thing that has ever exercised it end to end.
  paths.push(path.resolve(root, MANIFEST_NAME), path.resolve(root, RECEIPT_NAME));
  return paths;
}

/** Unlinks the plan, and reports what was actually there to remove. */
export async function deletePlan(paths: readonly string[]): Promise<string[]> {
  const removed: string[] = [];
  for (const target of paths) {
    try {
      await stat(target);
    } catch {
      continue;
    }
    await rm(target, { force: true });
    removed.push(target);
  }
  if (removed.length === 0) {
    throw new Error(
      "TN_DELETE_TEST_DELETED_NOTHING: every path in the receipt was already absent, so this run cannot show the game survives losing them.",
    );
  }
  return removed;
}

/**
 * A scenario that asserts nothing passes for free, which is the v1 harness failure this repository
 * already paid for: both runs would go green whatever the deletion did.
 *
 * A scenario's assertions live in its top-level `assert` object — diagnostics, performance,
 * resources — so an empty or absent one is the shape to refuse.
 */
export function assertScenarioAsserts(scenario: unknown, file: string): void {
  const record = scenario as { assert?: unknown; steps?: unknown } | null;
  const steps = record?.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error(`TN_DELETE_TEST_EMPTY_SCENARIO: '${file}' has no steps.`);
  }
  const assertions = record?.assert;
  const populated =
    assertions !== null &&
    typeof assertions === "object" &&
    Object.keys(assertions as Record<string, unknown>).length > 0;
  if (!populated) {
    throw new Error(
      `TN_DELETE_TEST_EMPTY_SCENARIO: '${file}' asserts nothing, so both runs would pass whatever the bake did.`,
    );
  }
}

/** Fraction of pixels that moved, and the mean absolute channel difference. */
export function compareCaptures(left: Buffer, right: Buffer): ICaptureDelta {
  const one = PNG.sync.read(left);
  const two = PNG.sync.read(right);
  if (one.width !== two.width || one.height !== two.height) {
    throw new Error(
      `TN_DELETE_TEST_CAPTURE_SIZE: ${one.width}x${one.height} against ${two.width}x${two.height}`,
    );
  }
  let moved = 0;
  let total = 0;
  for (let offset = 0; offset < one.data.length; offset += 4) {
    let delta = 0;
    for (let channel = 0; channel < 3; channel += 1) {
      delta += Math.abs((one.data[offset + channel] ?? 0) - (two.data[offset + channel] ?? 0));
    }
    if (delta > 0) moved += 1;
    total += delta / 3;
  }
  const pixels = one.data.length / 4;
  return { meanAbsolute: total / pixels, movedRatio: moved / pixels };
}

/**
 * Decides the run, against a band measured in this same job rather than an assumed zero.
 *
 * Captures here are not bit-deterministic — two identical builds of the same template move most of
 * their pixels by a small amount — so the threshold is the same-code band, with headroom, and the
 * band itself is printed so a future reader can see what it was.
 */
export function judge(band: ICaptureDelta, change: ICaptureDelta): string[] {
  const ceiling = Math.max(band.meanAbsolute * 3, 1);
  if (change.meanAbsolute > ceiling) {
    return [
      `TN_DELETE_TEST_PICTURE_MOVED: the unbaked run differs by mean |Δ| ${change.meanAbsolute.toFixed(3)}/255, past the ${ceiling.toFixed(3)} ceiling set by this job's same-code band of ${band.meanAbsolute.toFixed(3)}.`,
    ];
  }
  return [];
}

/**
 * Stops the project's dev server from re-baking the files this gate is about to delete.
 *
 * The templates' `vite.config.ts` installs `assetsWatchPlugin()`, which recompiles `assets/` into
 * `public/` every time `pnpm dev` starts. Left in place it restores every deleted output before the
 * page loads, and the gate reports a green that measured nothing — which is what the first run of
 * this gate did, and what its negative control caught.
 *
 * Fails closed: a config with no watcher line is refused rather than tested, because "the line was
 * not there" and "the watcher is off" look identical from here and only one of them is safe.
 */
export async function disableAssetWatcher(projectDir: string): Promise<void> {
  const file = path.join(projectDir, "vite.config.ts");
  const source = await readFile(file, "utf8");
  const line = "    assetsWatchPlugin(),\n";
  if (!source.includes(line)) {
    throw new Error(
      `TN_DELETE_TEST_WATCHER_UNKNOWN: '${file}' does not install assetsWatchPlugin() in the shape this gate knows how to switch off. Without that, the dev server re-bakes what this gate deletes and the result means nothing.`,
    );
  }
  await writeFile(
    file,
    source.replace(line, "    // assetsWatchPlugin() — disabled by the delete-test\n"),
  );
}

/** Every file under `root`, relative to it — used to report what a failing run could not find. */
export async function listFiles(root: string, prefix = ""): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await listFiles(root, relative)));
    else files.push(relative);
  }
  return files;
}

export interface IScenarioRun {
  readonly detail: string;
  readonly ok: boolean;
}

export interface IBakeDeleteTestDependencies {
  readonly build: (projectDir: string) => Promise<void>;
  /** Switches off whatever would rebuild the bake between the deletion and the second run. */
  readonly disableWatcher: (projectDir: string) => Promise<void>;
  readonly readCapture: (artifactsDir: string) => Promise<Buffer>;
  readonly runScenario: (
    projectDir: string,
    scenario: string,
    artifactsDir: string,
  ) => Promise<IScenarioRun>;
  readonly scaffold: (template: string, root: string) => Promise<string>;
}

export interface IBakeDeleteTestOptions {
  readonly outputDirectory?: string;
  readonly root: string;
  readonly scenario: string;
  readonly template: string;
}

/**
 * Builds one template, proves it runs baked, deletes every baked file, and proves it runs again.
 *
 * The baked run is required to pass first. A gate whose first run is already failing would report
 * the deletion as the cause of a red it did not create, which is the attribution mistake this
 * repository has paid for more than once.
 */
export async function runBakeDeleteTest(
  options: IBakeDeleteTestOptions,
  dependencies: IBakeDeleteTestDependencies,
): Promise<IBakeDeleteTestReport> {
  const projectDir = await dependencies.scaffold(options.template, options.root);
  await dependencies.build(projectDir);
  await dependencies.disableWatcher(projectDir);

  const scenarioFile = path.join(projectDir, options.scenario);
  assertScenarioAsserts(JSON.parse(await readFile(scenarioFile, "utf8")), scenarioFile);

  const bakedA = path.join(projectDir, "artifacts", "delete-test-baked-a");
  const first = await dependencies.runScenario(projectDir, options.scenario, bakedA);
  if (!first.ok) {
    throw new Error(
      `TN_DELETE_TEST_BAKED_RUN_FAILED: '${options.template}' does not pass '${options.scenario}' even with its bake intact, so nothing this gate measures afterwards would mean anything: ${first.detail}`,
    );
  }
  const captureA = await dependencies.readCapture(bakedA);

  const bakedB = path.join(projectDir, "artifacts", "delete-test-baked-b");
  const second = await dependencies.runScenario(projectDir, options.scenario, bakedB);
  if (!second.ok) {
    throw new Error(`TN_DELETE_TEST_BAND_RUN_FAILED: ${second.detail}`);
  }
  // The same build, twice, is the noise floor. Nothing here assumes it is zero: on this hardware
  // two identical runs of the same template move most of their pixels by a small amount.
  const band = compareCaptures(captureA, await dependencies.readCapture(bakedB));

  const outputRoot = path.join(projectDir, options.outputDirectory ?? "public");
  const receipt = await readReceipt(outputRoot);
  const deleted = await deletePlan(deletionPlan(receipt, outputRoot));

  const unbaked = path.join(projectDir, "artifacts", "delete-test-unbaked");
  const third = await dependencies.runScenario(projectDir, options.scenario, unbaked);
  const reasons: string[] = [];
  if (!third.ok) {
    const relative = deleted.map((absolute) => path.relative(outputRoot, absolute));
    const named = relative.find((entry) => third.detail.includes(entry));
    reasons.push(
      `TN_DELETE_TEST_UNBAKED_RUN_FAILED: '${options.template}' could not complete '${options.scenario}' after ${deleted.length} baked file(s) were deleted. First file it asked for and did not find: ${named ?? relative[0] ?? "unknown"}. Runner said: ${third.detail}`,
    );
    return {
      band,
      change: { meanAbsolute: 0, movedRatio: 0 },
      deleted,
      pass: false,
      reasons,
      template: options.template,
    };
  }
  const change = compareCaptures(captureA, await dependencies.readCapture(unbaked));
  reasons.push(...judge(band, change));
  return { band, change, deleted, pass: reasons.length === 0, reasons, template: options.template };
}

export function formatReport(report: IBakeDeleteTestReport): string {
  const head = `${report.template}: deleted ${report.deleted.length} baked file(s); same-code band mean |Δ| ${report.band.meanAbsolute.toFixed(3)}/255, unbaked run ${report.change.meanAbsolute.toFixed(3)}/255`;
  return report.pass
    ? `${head} — the game runs identically without its bake`
    : [head, ...report.reasons].join("\n");
}

/** Build, capture and scenario execution against a project that already exists on disk. */
async function runnerDependencies(): Promise<Omit<IBakeDeleteTestDependencies, "scaffold">> {
  const { spawn } = await import("node:child_process");

  const execute = async (
    command: string,
    args: readonly string[],
    cwd: string,
  ): Promise<IScenarioRun> =>
    new Promise<IScenarioRun>((resolve) => {
      const output: string[] = [];
      const child = spawn(command, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout?.on("data", (chunk) => output.push(String(chunk)));
      child.stderr?.on("data", (chunk) => output.push(String(chunk)));
      child.once("error", (error) => resolve({ detail: error.message, ok: false }));
      child.once("exit", (code) =>
        resolve({ detail: output.join("").slice(-4000), ok: code === 0 }),
      );
    });

  return {
    build: async (projectDir) => {
      const result = await execute("pnpm", ["build"], projectDir);
      if (!result.ok) throw new Error(`TN_DELETE_TEST_BUILD_FAILED: ${result.detail}`);
    },
    disableWatcher: disableAssetWatcher,
    readCapture: async (artifactsDir) => {
      const frames = (await listFiles(artifactsDir)).filter((file) => file.endsWith(".png")).sort();
      const after = frames.at(-1);
      if (after === undefined) {
        throw new Error(
          `TN_DELETE_TEST_NO_CAPTURE: the runner wrote no frame into '${artifactsDir}', so there is nothing to compare.`,
        );
      }
      return readFile(path.join(artifactsDir, after));
    },
    runScenario: async (projectDir, scenario, artifactsDir) =>
      execute(
        "pnpm",
        [
          "exec",
          "threenative-playtest",
          "--scenario",
          scenario,
          "--browser-recipe",
          "webgpu",
          "--headed",
          "--artifacts",
          artifactsDir,
          "--server-command",
          "pnpm dev --host 127.0.0.1 --port $PORT --strictPort",
        ],
        projectDir,
      ),
  };
}

/** Adds a scaffold from locally packed tarballs — how a stranger's machine would install this. */
async function liveDependencies(repoRoot: string): Promise<IBakeDeleteTestDependencies> {
  const { createProject } = await import("../packages/create-threenative/src/index.js");
  const { packageLocalFramework } = await import("./visual-gate.js");
  const packages = (await packageLocalFramework(repoRoot)) as Record<string, string>;
  return {
    ...(await runnerDependencies()),
    scaffold: async (template, root) => {
      const created = await createProject(
        { install: true, packageSources: packages, target: template, template },
        root,
      );
      return created.target;
    },
  };
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
) {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  void (async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const os = await import("node:os");
    const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
    // One template per invocation by default: the existing templates gate aborts at its first
    // failure, and a red hidden behind another template's red is a red nobody reads.
    // `--all` is every shipped kit, derived from disk: a hand list of eight left the other eight
    // unproven, and the day a ninth shipped nobody would notice either.
    const templates = argv.includes("--all")
      ? [...templateNames()]
      : [flag("--template") ?? "starter"];
    const scenario = flag("--scenario") ?? "playtests/play.playtest.json";
    // `--project` runs against a project that is already scaffolded and built — the shape CI is
    // in, where the golden-path job has done both already and a second scaffold would only prove
    // the packer twice.
    const existing = flag("--project");
    const dependencies: IBakeDeleteTestDependencies =
      existing === undefined
        ? await liveDependencies(repoRoot)
        : {
            ...(await runnerDependencies()),
            build: async () => undefined,
            scaffold: async () => path.resolve(existing),
          };
    let failed = 0;
    for (const template of templates) {
      const root =
        existing === undefined
          ? await mkdtemp(path.join(os.tmpdir(), `threenative-delete-test-${template}-`))
          : path.resolve(existing);
      try {
        const report = await runBakeDeleteTest({ root, scenario, template }, dependencies);
        console.log(formatReport(report));
        if (!report.pass) failed += 1;
      } catch (error) {
        console.error(`${template}: ${error instanceof Error ? error.message : String(error)}`);
        failed += 1;
      } finally {
        // The gate owns the scaffold it created; the diagnosis it prints — which file the game
        // asked for and did not find — is what a reader needs, not the tree it was in.
        if (existing === undefined) await rm(root, { force: true, recursive: true });
      }
    }
    process.exitCode = failed === 0 ? 0 : 1;
  })();
}
