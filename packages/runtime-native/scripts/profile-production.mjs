#!/usr/bin/env node

import { createServer } from 'node:http';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { PNG } from 'pngjs';
import { readAndroidConfig } from './package-android.mjs';
import { suppressPlayProtectOnAdbInstalls } from './device-preflight.mjs';

import {
  PRODUCTION_EVIDENCE_VERSION,
  ProductionEvidenceError,
  REGRESSION_COLLECTION_PROFILE,
  meanFps,
  nearestRank,
  oneSecondFrameFloors,
  unmeasurableIntervalCount,
  sha256,
  writeProductionEvidence,
  sanitizeManifest,
} from './production-evidence.mjs';

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '../../..');
const inRepositoryCheckout = existsSync(join(repositoryRoot, 'pnpm-workspace.yaml'));
const commandRoot = inRepositoryCheckout ? repositoryRoot : process.cwd();
const packageRequire = createRequire(import.meta.url);
const platformerScenario = 'playtests/performance.playtest.json';
const nativeTargets = new Set(['android', 'android-physical', 'desktop', 'ios', 'ios-physical']);
const physicalTargets = new Set(['android-physical', 'ios-physical']);
const supportedTargets = new Set(['android', 'android-physical', 'desktop', 'desktop-pair', 'fixture', 'ios', 'ios-physical', 'web']);
const supportedControls = new Set([
  'claimed-audio-missing-evidence',
  'dirty-checkout',
  'disallowed-identifiers',
  'early-exit',
  'memory-growth',
  'missing-marker',
  'slow-native',
  'slow-path',
  'slow-startup',
  'stale-source-sha',
  'substitute-emulator-provenance',
]);
const SLOW_FRAME_DELAY_MS = 50;
const SLOW_FRAME_COUNT = 60;
const SLOW_STARTUP_DELAY_MS = 5_100;
const FRAME_SAMPLE_BATCH_SIZE = 30;
// Android logcat truncates long lines, so native samples use a smaller JSON batch.
const NATIVE_FRAME_SAMPLE_BATCH_SIZE = 5;
// The wall-clock a paced fixed step gives each tick, so a synthetic workload's tick budget stands
// in for the seconds it names and the host's render loop actually presents frames while it runs.
const PRODUCTION_TICK_INTERVAL_MS = 1_000 / 60;
const DESKTOP_SCREENSHOT_TIMEOUT_MS = 5_000;
const PRODUCTION_PROFILE = 'production';
const REGRESSION_PROFILE = 'regression';
// A selected scenario can be longer than the old fixed 30 s cap: the default scaffold alone runs
// a 60 s warmup plus a 60 s window. The budget grows with the frames the written workload asks
// for at the playtest runner's own per-tick allowance, and a base covers browser/host startup and
// first-use compilation instead of capping the run at an arbitrary 30 s.
const PLAYTEST_TIMEOUT_BASE_MS = 60_000;
const PLAYTEST_FRAME_BUDGET_MS = 250;
export function playtestTimeoutMs(scenario) {
  const frameCount = (value) => (Number.isFinite(value) && value > 0 ? value : 0);
  const warmupFrames = frameCount(scenario?.warmupFrames);
  const frames = (Array.isArray(scenario?.steps) ? scenario.steps : []).reduce(
    (total, step) => total
      + frameCount(step?.holdFrames)
      + frameCount(step?.waitFrames)
      + frameCount(step?.holdTicks)
      + frameCount(step?.waitTicks),
    0,
  );
  return PLAYTEST_TIMEOUT_BASE_MS + (warmupFrames + frames) * PLAYTEST_FRAME_BUDGET_MS;
}

function installedPackageFile(packageName, file) {
  try {
    return join(dirname(packageRequire.resolve(`${packageName}/package.json`)), file);
  } catch {
    return undefined;
  }
}

export function resolveProductionTools() {
  const localScaffold = join(repositoryRoot, 'packages/create-threenative/dist/index.js');
  const localPlaytest = join(repositoryRoot, 'packages/playtest/dist/runner/cli.js');
  const localRunner = join(repositoryRoot, 'packages/playtest/dist/runner/index.js');
  return {
    playtestCli: inRepositoryCheckout && existsSync(localPlaytest)
      ? localPlaytest
      : installedPackageFile('@threenative/playtest', 'dist/runner/cli.js'),
    playtestRunner: inRepositoryCheckout && existsSync(localRunner)
      ? localRunner
      : installedPackageFile('@threenative/playtest', 'dist/runner/index.js'),
    scaffoldCli: inRepositoryCheckout && existsSync(localScaffold)
      ? localScaffold
      : installedPackageFile('create-threenative', 'dist/index.js'),
  };
}

// The primary checkout that owns a checkout or linked worktree at `cwd`. Git's common directory is
// the one answer a linked worktree gives without being asked for a worktree: it names the primary
// `.git`, while the worktree's own parent directory is still inside the primary repository.
export function owningCheckout(cwd) {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return common.length > 0 ? dirname(common) : cwd;
  } catch {
    return cwd;
  }
}

// Beside the owning primary checkout, so the staged game shares its volume and inherits no
// pnpm-workspace.yaml; an ancestor that is itself a workspace is climbed past, because pnpm reads
// the nearest one upwards and would install the staged game into it.
export function stagingParentDirectory(primaryCheckout, workspaceExists = existsSync) {
  let parent = dirname(primaryCheckout);
  while (parent !== dirname(parent) && workspaceExists(join(parent, 'pnpm-workspace.yaml'))) {
    parent = dirname(parent);
  }
  return join(parent, '.threenative-profile-production');
}

export function parseProductionArgs(argv = process.argv.slice(2)) {
  const options = {
    audioEvidence: undefined,
    coldStarts: 1,
    config: undefined,
    control: undefined,
    device: undefined,
    duration: 60,
    hostedSoftware: false,
    liveClock: false,
    out: '.runtime/prd064/production',
    prebuiltArtifact: undefined,
    physicalEvidence: undefined,
    profile: PRODUCTION_PROFILE,
    project: undefined,
    renderSize: undefined,
    repetitions: 3,
    scenario: undefined,
    sourceSha: undefined,
    target: undefined,
    warmup: 60,
  };
  const explicit = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--') continue;
    if (flag === '--audio-evidence') { explicit.add('audioEvidence'); options.audioEvidence = nextValue(argv, ++index, flag); }
    else if (flag === '--cold-starts') { explicit.add('coldStarts'); options.coldStarts = positiveInteger(nextValue(argv, ++index, flag), flag); }
    else if (flag === '--config') { explicit.add('config'); options.config = nextValue(argv, ++index, flag); }
    else if (flag === '--control') { explicit.add('control'); options.control = nextValue(argv, ++index, flag); }
    else if (flag === '--device') { explicit.add('device'); options.device = nextValue(argv, ++index, flag); }
    else if (flag === '--duration') { explicit.add('duration'); options.duration = positiveNumber(nextValue(argv, ++index, flag), flag); }
    else if (flag === '--hosted-software') { options.hostedSoftware = true; }
    else if (flag === '--live-clock') { options.liveClock = true; }
    else if (flag === '--out') { explicit.add('out'); options.out = nextValue(argv, ++index, flag); }
    else if (flag === '--prebuilt-artifact') { explicit.add('prebuiltArtifact'); options.prebuiltArtifact = nextValue(argv, ++index, flag); }
    else if (flag === '--physical-evidence') { explicit.add('physicalEvidence'); options.physicalEvidence = nextValue(argv, ++index, flag); }
    else if (flag === '--profile') options.profile = nextValue(argv, ++index, flag);
    else if (flag === '--project') { explicit.add('project'); options.project = nextValue(argv, ++index, flag); }
    else if (flag === '--regression') options.profile = REGRESSION_PROFILE;
    else if (flag === '--render-size') { explicit.add('renderSize'); options.renderSize = parseRenderSize(nextValue(argv, ++index, flag)); }
    else if (flag === '--repetitions') { explicit.add('repetitions'); options.repetitions = positiveInteger(nextValue(argv, ++index, flag), flag); }
    else if (flag === '--scenario') { explicit.add('scenario'); options.scenario = nextValue(argv, ++index, flag); }
    else if (flag === '--source-sha') { explicit.add('sourceSha'); options.sourceSha = nextValue(argv, ++index, flag); }
    else if (flag === '--target') { explicit.add('target'); options.target = nextValue(argv, ++index, flag); }
    else if (flag === '--warmup') { explicit.add('warmup'); options.warmup = positiveNumber(nextValue(argv, ++index, flag), flag); }
    else if (flag === '--help') return { ...options, help: true };
    else throw new ProductionEvidenceError('TN_PROD_CLI_USAGE', `Unknown production profile option '${flag}'.`);
  }
  if (options.target === undefined) throw new ProductionEvidenceError('TN_PROD_CLI_USAGE', 'Production profile requires --target.');
  if (options.profile === REGRESSION_PROFILE) {
    if (!explicit.has('coldStarts')) options.coldStarts = REGRESSION_COLLECTION_PROFILE.coldStarts;
    if (!explicit.has('duration')) options.duration = REGRESSION_COLLECTION_PROFILE.durationSeconds;
    if (!explicit.has('out')) options.out = '.runtime/prd358/regression';
    if (!explicit.has('repetitions')) options.repetitions = 1;
    if (!explicit.has('warmup')) options.warmup = 5;
  }
  return validateProductionOptions(options);
}

// Lexical containment: both paths were resolved from the same --project root in normalizeOptions,
// so a symlinked project still passes and the staging re-anchor stays inside the copy. A scenario
// that escapes (../outside.json or an absolute outside path) is refused before it can be read
// outside staging or overwrite a generated scenario path.
function scenarioInsideProject(project, scenario) {
  const rel = relative(project, scenario);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function validateProductionOptions(input) {
  const options = normalizeOptions(input);
  if (options.help) return options;
  if (options.profile === REGRESSION_PROFILE && (options.repetitions !== 1 || options.coldStarts !== 5 || options.duration < 30 || options.duration > 60 || options.warmup > 10)) {
    throw new ProductionEvidenceError('TN_PROD_PAIR_UNIT', 'Each regression arm requires one 30–60 second steady launch, five startup launches, and at most ten seconds warmup.');
  }
  if (options.profile !== PRODUCTION_PROFILE && options.profile !== REGRESSION_PROFILE) {
    throw new ProductionEvidenceError('TN_PROD_PROFILE_UNSUPPORTED', `Production profile '${options.profile}' is not supported.`);
  }
  if (!supportedTargets.has(options.target)) {
    throw new ProductionEvidenceError('TN_PROD_TARGET_UNSUPPORTED', `Production target '${options.target}' is not supported.`);
  }
  if (options.control !== undefined && !supportedControls.has(options.control)) {
    throw new ProductionEvidenceError('TN_PROD_CONTROL_UNSUPPORTED', `Production control '${options.control}' is not supported.`);
  }
  if (options.scenario !== undefined && options.project === undefined) {
    throw new ProductionEvidenceError('TN_PROD_CLI_USAGE', '--scenario requires --project so an existing project is measured against its own scenario.');
  }
  if (options.scenario !== undefined && !scenarioInsideProject(options.project, options.scenario)) {
    throw new ProductionEvidenceError('TN_PROD_SCENARIO_OUTSIDE_PROJECT', `--scenario '${basename(options.scenario)}' must live inside --project '${basename(options.project)}'.`);
  }
  if (options.target === 'fixture' && options.project !== undefined) {
    throw new ProductionEvidenceError('TN_PROD_CLI_USAGE', '--project is not valid for the fixture negative control.');
  }
  if (options.target === 'fixture' && options.control === undefined) {
    throw new ProductionEvidenceError('TN_PROD_FIXTURE_CONTROL_REQUIRED', 'The fixture target is available only as an explicit negative control.');
  }
  if (options.device !== undefined && !nativeTargets.has(options.target)) {
    throw new ProductionEvidenceError('TN_PROD_DEVICE_UNSUPPORTED', `--device is not valid for target '${options.target}'.`);
  }
  if ((options.target === 'android' || options.target === 'android-physical') && options.device === undefined) {
    throw new ProductionEvidenceError('TN_PROD_DEVICE_REQUIRED', `Target '${options.target}' requires --device so the selected device is recorded and driven.`);
  }
  if (physicalTargets.has(options.target) && options.device === undefined) {
    throw new ProductionEvidenceError('TN_PROD_DEVICE_REQUIRED', `Target '${options.target}' requires --device.`);
  }
  if (options.hostedSoftware && (physicalTargets.has(options.target) || options.target === 'fixture')) {
    throw new ProductionEvidenceError('TN_PROD_HOSTED_SOFTWARE_UNSUPPORTED', 'Hosted-software evaluation is only valid for non-physical platform probes.');
  }
  if (options.target === 'desktop-pair' && options.control === 'slow-native') return options;
  if (options.control === 'slow-native' && options.target !== 'desktop-pair') {
    throw new ProductionEvidenceError('TN_PROD_CONTROL_UNSUPPORTED', "The 'slow-native' control requires --target desktop-pair.");
  }
  if (options.target === 'fixture' && options.device !== undefined) {
    throw new ProductionEvidenceError('TN_PROD_DEVICE_UNSUPPORTED', 'Fixture controls cannot accept --device.');
  }
  if (nativeTargets.has(options.target) && options.target !== 'desktop' && options.target !== 'desktop-pair'
    && (options.renderSize.width !== 1920 || options.renderSize.height !== 1080)) {
    throw new ProductionEvidenceError('TN_PROD_RENDER_SIZE_UNSUPPORTED', `--render-size is not controllable for target '${options.target}'.`);
  }
  return options;
}

export async function runProductionProfile(input, dependencies = {}) {
  const options = validateProductionOptions(input);
  if (options.help) return { help: true, status: 'PASS', exitCode: 0 };
  const sourceState = await currentSourceState();
  const requiredSourceSha = sourceState.sha;
  const sourceSha = options.sourceSha ?? requiredSourceSha;
  options.sourceSha = sourceSha;
  const runId = `${options.target}-${Date.now()}`;
  const physicalEvidence = await readPhysicalEvidence(options.physicalEvidence);
  const audioEvidence = await readOptionalArtifact(options.audioEvidence);
  const context = { audioEvidence, physicalEvidence, requiredSourceSha, sourceSha, sourceState };
  const collected = options.target === 'fixture'
    ? await createFixtureControlEvidence(options, context, runId)
    : await (dependencies.collectProduction ?? collectProduction)(options, context, runId);
  const evidence = applyNegativeControl(collected, options.control);
  const result = await writeProductionEvidence(evidence, options.out, { requiredSourceSha });
  return { ...result.manifest, manifestPath: result.manifestPath };
}

export async function collectProduction(options, context, runId) {
  const tools = resolveProductionTools();
  if (options.project === undefined && (tools.scaffoldCli === undefined || !await fileExists(tools.scaffoldCli))) {
    throw new ProductionEvidenceError(
      'TN_PROD_SCAFFOLDER_UNAVAILABLE',
      "The installed 'create-threenative' package does not expose its built scaffolder; install it or run the repository build first.",
    );
  }
  if (tools.playtestCli === undefined || !await fileExists(tools.playtestCli)) {
    throw new ProductionEvidenceError(
      'TN_PROD_PLAYTEST_UNAVAILABLE',
      "The installed '@threenative/playtest' package does not expose its built runner; install it or run the repository build first.",
    );
  }

  // Resolved before the scaffold so a lane that cannot carry a frame rate costs a second, not the
  // three minutes it takes to pack the workspace and build a platformer nobody may judge.
  const webDisplay = webArmRequested(options) ? await rateBearingDisplay(tools) : undefined;

  // Keep staging on the checkout's volume (Windows packaging cannot cross volumes), but outside
  // every repository workspace. A project under repo/.runtime is discovered by pnpm as part of the
  // parent workspace, so its install populates the workspace root and leaves the staged project's
  // node_modules missing. A linked worktree's own parent is no better - <primary>/.worktrees is
  // still inside <primary> - so the parent of the *owning primary* checkout is the one directory
  // that is both same-volume and workspace-free.
  const stagingParent = inRepositoryCheckout
    ? stagingParentDirectory(owningCheckout(commandRoot))
    : tmpdir();
  await mkdir(stagingParent, { recursive: true });
  const temporaryRoot = await mkdtemp(join(stagingParent, 'threenative-production-'));
  const project = join(temporaryRoot, 'platformer');
  const startedAt = new Date().toISOString();
  try {
    await stageProductionProject(options, project, tools);
    tools.workloadSourceHash = await hashPath(join(project, 'src'));
    const scenarios = await writeRunScenarios(project, options);
    const artifactsRoot = join(project, 'artifacts', 'production');
    await mkdir(artifactsRoot, { recursive: true });
    const web = webDisplay === undefined ? undefined : await collectWeb(project, scenarios, artifactsRoot, options, tools, webDisplay);
    const native = nativeTargets.has(options.target) || options.target === 'desktop-pair'
      ? await collectNative(project, scenarios, artifactsRoot, options, tools)
      : undefined;
    const resolutionScaleSetting = native === undefined
      ? undefined
      : await readResolutionScaleSetting(project, options);
    return assembleEvidence({
      context,
      native,
      options,
      performanceBounds: scenarios.performanceBounds,
      project,
      resolutionScaleSetting,
      runId,
      startedAt,
      web,
    });
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

function normalizeOptions(input = {}) {
  const renderSize = typeof input.renderSize === 'string' ? parseRenderSize(input.renderSize) : input.renderSize;
  const target = input.target === 'desktop-web' ? 'web' : input.target;
  const profile = input.profile ?? PRODUCTION_PROFILE;
  const regression = profile === REGRESSION_PROFILE;
  const defaultRenderSize = input.hostedSoftware === true && target === 'desktop'
    ? { height: 720, width: 1280 }
    : { height: 1080, width: 1920 };
  const project = input.project === undefined ? undefined : resolve(input.project);
  const scenario = input.scenario === undefined
    ? undefined
    : project === undefined ? resolve(input.scenario) : resolve(project, input.scenario);
  return {
    audioEvidence: input.audioEvidence,
    coldStarts: input.coldStarts ?? (regression ? REGRESSION_COLLECTION_PROFILE.coldStarts : 1),
    control: input.control,
    device: input.device,
    duration: input.duration ?? (regression ? REGRESSION_COLLECTION_PROFILE.durationSeconds : 60),
    hostedSoftware: input.hostedSoftware === true,
    help: input.help,
    // Listed explicitly like every other option here: this function rebuilds the option set field by
    // field, so an unlisted one is dropped rather than defaulted, and a `--live-clock` that never
    // reached the instrumentation would quietly profile the frozen run it was asked to replace.
    liveClock: input.liveClock === true,
    out: input.out ?? (regression ? '.runtime/prd358/regression' : '.runtime/prd064/production'),
    prebuiltArtifact: input.prebuiltArtifact === undefined ? undefined : resolve(input.prebuiltArtifact),
    physicalEvidence: input.physicalEvidence,
    project,
    renderSize: renderSize ?? defaultRenderSize,
    profile,
    repetitions: input.repetitions ?? (regression ? 1 : 3),
    scenario,
    sourceSha: input.sourceSha,
    target,
    warmup: input.warmup ?? (regression ? 5 : 60),
  };
}

function warmupFramesFor(options) {
  return Math.max(0, Math.ceil((options.warmup ?? 0) * 60));
}

// Only the scaffolded default needs its ticks paced to wall time, because only it has no authored
// workload whose own step durations are the seconds the run means. A live-clock run needs it too, and
// not because it needs pacing twice: the wrapper is idempotent, so an `advance` that already spent
// the interval leaves a wait of zero or less and the pace adds nothing. Excluding it left the native
// host free to consume the frame-count workload faster than wall time, and the run published a
// measured window shorter than the `--duration` it was asked for.
function paceTicksFor(options) {
  return options.project === undefined;
}

// Directories the judge regenerates itself. Copying a previous build measures stale bytes and
// copying node_modules moves gigabytes; node_modules is linked into the staged copy instead.
const PROJECT_SKIP_ENTRIES = new Set(['.runtime-mailbox', '.threenative', 'artifacts', 'dist', 'dist-native', 'node_modules']);

// The default scaffold is built and thrown away. An existing project is copied first so every
// instrumented file, scenario and build output lands in the copy and the source is never touched.
export async function stageProductionProject(options, project, tools, dependencies = {}) {
  if (options.project === undefined) {
    await (dependencies.scaffoldPlatformer ?? scaffoldPlatformer)(project, tools);
    return project;
  }
  const copy = dependencies.cp ?? cp;
  const link = dependencies.symlink ?? symlink;
  // Realpath first: a symlinked --project must stage a copy of the target, never write through it.
  const source = await realpath(options.project).catch(() => undefined);
  const details = source === undefined ? undefined : await stat(source).catch(() => undefined);
  if (details === undefined || !details.isDirectory()) {
    throw new ProductionEvidenceError('TN_PROD_PROJECT_MISSING', `--project '${basename(options.project)}' is not an existing project directory.`);
  }
  await copy(source, project, {
    // Dereference so a nested symlink (for example src/main.ts into another checkout) becomes a
    // real staged file; instrumentation then writes the copy instead of through to its source.
    dereference: true,
    recursive: true,
    filter: (candidate) => {
      const top = relative(source, candidate).split(sep)[0];
      return top === '' || !PROJECT_SKIP_ENTRIES.has(top);
    },
  });
  // node_modules is skipped by the filter above and linked wholesale, never copied or instrumented.
  if (existsSync(join(source, 'node_modules'))) {
    await link(join(source, 'node_modules'), join(project, 'node_modules'));
  }
  if (options.scenario !== undefined) {
    // The staged copy is the only project the judge may read; re-anchor a scenario named inside
    // the source so runs measure the staged snapshot, not the file the developer may still edit.
    options.scenario = join(project, relative(options.project, options.scenario));
  }
  return project;
}

async function scaffoldPlatformer(project, tools) {
  const packageArchiveRoot = join(project, '..', 'package-archives');
  await mkdir(packageArchiveRoot, { recursive: true });
  const packageSource = async (name, directory) => [name, await packLocalPackage(directory, packageArchiveRoot)];
  const localSources = [];
  if (inRepositoryCheckout) {
    for (const workspacePackage of localWorkspacePackages()) {
      localSources.push(
        await packageSource(workspacePackage.name, join(repositoryRoot, workspacePackage.directory)),
      );
    }
    const studioDirectory = join(repositoryRoot, 'packages/studio');
    if (existsSync(join(studioDirectory, 'package.json'))) {
      // Studio is a private cross-checkout extra, not a workspace package in this repository.
      localSources.push(await packageSource('@threenative/studio', studioDirectory));
    }
  }
  const args = [
    tools.scaffoldCli,
    project,
    '--template', 'platformer',
    ...localSources.flatMap(([name, source]) => [packageSourceFlag(name), source]),
  ];
  // Scaffolding packs and installs the whole workspace, which is slow on hosted runners.
  const result = await runCommand(process.execPath, args, commandRoot, undefined, 600_000);
  if (result.status !== 0) {
    throw new ProductionEvidenceError('TN_PROD_SCAFFOLD_FAILED', `Scaffolding the production platformer failed.${failureSuffix(result)}`);
  }
}

function localWorkspacePackages() {
  const output = execFileSync(
    'pnpm',
    ['exec', 'tsx', join(repositoryRoot, 'scripts/workspace-packages.ts'), '--json'],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
  const packages = JSON.parse(output);
  if (!Array.isArray(packages)) throw new Error('TN_WORKSPACE_PACKAGE_DERIVATION_INVALID: expected an array.');
  return packages.filter((item) => item && typeof item.name === 'string' && typeof item.directory === 'string');
}

async function packLocalPackage(directory, destination) {
  const before = new Set(await readdir(destination));
  const result = await runCommand('pnpm', ['pack', '--pack-destination', destination], directory);
  if (result.status !== 0) throw new ProductionEvidenceError('TN_PROD_PACKAGE_ARCHIVE_FAILED', `Packing local package '${basename(directory)}' failed.${failureSuffix(result)}`);
  const archive = (await readdir(destination)).find((entry) => entry.endsWith('.tgz') && !before.has(entry));
  if (archive === undefined) throw new ProductionEvidenceError('TN_PROD_PACKAGE_ARCHIVE_FAILED', `Packing local package '${basename(directory)}' produced no archive.`);
  return join(destination, archive);
}

function packageSourceFlag(name) {
  if (name === 'create-threenative') return '--cli-package';
  if (name === 'threenative-blender-mcp') return '--blender-mcp-package';
  if (name === 'threenative-engine-mcp') return '--engine-mcp-package';
  if (name.startsWith('@threenative/')) {
    const suffix = name.slice('@threenative/'.length);
    return `--threenative-${suffix}-package`;
  }
  throw new Error(`TN_PROD_PACKAGE_FLAG_UNSUPPORTED: ${name}`);
}

function nativeAssertions(assertions, timeoutMs, hostedSoftware) {
  const { diagnostics: _browserOnly, ...supported } = assertions;
  return { ...supported, startup: supported.startup ?? (hostedSoftware
    ? { maxCompileSettledMs: timeoutMs }
    : { maxReadyMs: timeoutMs }) };
}

/**
 * What the collector ITSELF pinned, restated as the tier the run may be held to.
 *
 * `--hosted-software` is explicit policy configuration, not a claim about the machine: it writes
 * `__THREENATIVE_PROFILE__.hostedSoftware`, and the template's own render source answers that by
 * choosing the low preset. A hardware adapter that honours a pinned-low profile is the run working
 * as configured, so the expectation the collector writes has to be the tier it asked for.
 *
 * It removes `perAdapter` outright rather than leaving the branches beside the pinned tier. The
 * branches assert the tier an adapter *class* implies, and the collector's pin overrides the class's
 * preference on this run: a hardware adapter held to `low` would take the software branch's stages
 * and contributions and fail a workload that did exactly what it was configured to do. What stays
 * is the flat expectation at the pinned tier, and classification is untouched either way — the run
 * is still classified from its own `adapter.info` reading, and a hardware run with no profile input
 * is still held to the template's flat `high`.
 */
function hostedSoftwareAssertions(assertions, hostedSoftware) {
  if (!hostedSoftware || assertions?.renderChain === undefined) return assertions;
  const { perAdapter: _perAdapter, ...renderChain } = assertions.renderChain;
  return { ...assertions, renderChain: { ...renderChain, tier: 'low' } };
}

export async function writeRunScenarios(project, options) {
  const scenarioPath = options.scenario ?? join(project, platformerScenario);
  const source = JSON.parse(await readFile(scenarioPath, 'utf8').catch(() => {
    throw new ProductionEvidenceError('TN_PROD_SCENARIO_MISSING', `Production scenario '${basename(scenarioPath)}' was not found.`);
  }));
  const sourceAssertions = source.assert && typeof source.assert === 'object' && !Array.isArray(source.assert)
    ? source.assert
    : {};
  const { performance: performanceBounds, ...playtestAssertions } = sourceAssertions;
  const baseWorkloadAssertions = Object.keys(playtestAssertions).length === 0
    ? { diagnostics: { noConsoleErrors: true, runtimeReady: true } }
    : playtestAssertions;
  const workloadAssertions = options.profile === REGRESSION_PROFILE
    ? { ...baseWorkloadAssertions, movement: { entity: 'player', minDistance: 0.1 } }
    : baseWorkloadAssertions;
  const { assert: _sourceAssertions, ...scenarioSource } = source;
  const workloadFrames = Math.max(1, Math.ceil(options.duration * 60));
  const warmupFrames = Math.max(0, Math.ceil(options.warmup * 60));
  // An existing project's own scenario is the workload: its steps are what the game actually does
  // (a menu click, a flight), and replacing them with a forward run exercises nothing. The
  // scaffolded default has no authored workload, so it keeps the synthetic run the warmup and
  // duration size.
  const workloadSteps = options.project === undefined
    ? [
        { holdFrames: Math.min(60, workloadFrames), kind: 'input', press: 'ArrowRight', release: true },
        { kind: 'wait', release: true, waitFrames: workloadFrames },
      ]
    : scenarioSource.steps;
  if (!Array.isArray(workloadSteps) || workloadSteps.length === 0) {
    throw new ProductionEvidenceError('TN_PROD_SCENARIO_STEPS_MISSING', `Production scenario '${basename(scenarioPath)}' defines no workload steps.`);
  }
  const workload = {
    ...scenarioSource,
    assert: workloadAssertions,
    artifacts: { screenshots: 'after' },
    steps: workloadSteps,
    viewport: options.renderSize,
    warmupFrames,
  };
  const nativeTarget = options.target === 'desktop' || options.target === 'desktop-pair' ? 'desktop' : 'device';
  const nativeWorkloadSteps = nativeTarget === 'device'
    ? [
        { holdFrames: Math.min(60, workloadFrames), kind: 'input', press: 'ArrowRight', release: true },
        ...Array.from({ length: Math.max(0, workloadFrames - Math.min(60, workloadFrames)) }, () => ({
          kind: 'wait',
          release: true,
          waitFrames: 1,
        })),
      ]
    : workload.steps.map((step) => {
        if (step.kind !== 'click' || step.at === undefined || 'entity' in step.at) return step;
        const viewport = scenarioSource.viewport ?? options.renderSize;
        const { x, y } = step.at;
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(viewport.width)
          || !Number.isFinite(viewport.height) || viewport.width <= 0 || viewport.height <= 0
          || x < 0 || y < 0 || x > viewport.width || y > viewport.height) {
          throw new ProductionEvidenceError('TN_PROD_NATIVE_CLICK_INVALID', `Click step '${step.label ?? ''}' lies outside its source viewport.`);
        }
        const { at: _at, kind: _kind, ...pointerStep } = step;
        return { ...pointerStep, pointerPosition: { buttons: 1, x: x / viewport.width, y: y / viewport.height } };
      });
  const startup = {
    ...scenarioSource,
    assert: { diagnostics: { noConsoleErrors: true, runtimeReady: true } },
    artifacts: { screenshots: 'after' },
    steps: [{ kind: 'wait', release: true, waitFrames: 1 }],
    viewport: options.renderSize,
    warmupFrames: 0,
  };
  const timeoutMs = playtestTimeoutMs(workload);
  const nativeWorkload = {
    ...workload,
    assert: hostedSoftwareAssertions(nativeAssertions(workload.assert, timeoutMs, options.hostedSoftware), options.hostedSoftware),
    artifacts: {
      screenshots: options.profile === REGRESSION_PROFILE || nativeTarget === 'desktop'
        ? 'after'
        : false,
    },
    steps: nativeWorkloadSteps,
  };
  const nativeStartup = { ...startup, assert: nativeAssertions(startup.assert, timeoutMs, options.hostedSoftware), artifacts: { screenshots: 'after' } };
  const workloadPath = join(project, 'playtests/production-performance.run.playtest.json');
  const startupPath = join(project, 'playtests/production-startup.run.playtest.json');
  const nativeWorkloadPath = join(project, 'playtests/production-performance.native.playtest.json');
  const nativeStartupPath = join(project, 'playtests/production-startup.native.playtest.json');
  await writeFile(workloadPath, `${JSON.stringify(workload, null, 2)}\n`);
  await writeFile(startupPath, `${JSON.stringify(startup, null, 2)}\n`);
  await writeFile(nativeWorkloadPath, `${JSON.stringify(nativeWorkload, null, 2)}\n`);
  await writeFile(nativeStartupPath, `${JSON.stringify(nativeStartup, null, 2)}\n`);
  return {
    ...(performanceBounds === undefined ? {} : { performanceBounds }),
    nativeStartupPath,
    nativeWorkloadPath,
    startupPath,
    timeoutMs,
    workloadPath,
  };
}

/**
 * A production frame rate is only evidence from a display that can carry one. The runner provisions
 * a private software Xvfb by default, and this repository's own playtest contract says a rate read
 * there is wrong rather than missing. Two collections of the same built platformer at 1920x1080 on
 * this host agree: the private-display web arm reported 33.97 fps mean and a 117.1 ms p99
 * (`.runtime/prd064/control/web-baseline-paired/production-evidence.json`) where the session-display
 * arm reported 163.45 fps and a 19.6 ms p99
 * (`.runtime/prd064/production/desktop-pair-6/production-evidence.json`) — a 4.8x difference in the
 * number the gate reads. Judging the budget on the private lane measures the X server, so the run
 * refuses before it spends a collection on it.
 */
export function webRateDisplayFault(strategy) {
  if (strategy === undefined || strategy.kind !== 'private-xvfb') return undefined;
  return new ProductionEvidenceError(
    'TN_PROD_DISPLAY_UNTRUSTWORTHY',
    `A web frame-rate verdict needs a display that can carry one, and this run would be measured on a private software Xvfb (${strategy.screen}). Run it with TN_PLAYTEST_HOST_DISPLAY=1 on a machine with a live X display, or judge the native arm alone.`,
  );
}

function webArmRequested(options) {
  return options.target === 'web' || options.target === 'desktop-pair';
}

async function rateBearingDisplay(tools) {
  const { decideDisplayStrategy } = await import(pathToFileURL(tools.playtestRunner).href);
  const display = decideDisplayStrategy({ env: process.env, platform: process.platform });
  const fault = webRateDisplayFault(display);
  if (fault !== undefined) throw fault;
  return display;
}

async function collectWeb(project, scenarios, artifactsRoot, options, tools, display) {
  // The marker endpoint the judge is told to report its first frame to. The game's own samples ride
  // the console (a fetch from the page is an in-flight request Chromium reports as ERR_ABORTED at
  // teardown, which the scenario's own noNetworkErrors policy would fail the run for).
  const markerServer = await createFrameMarkerServer(options.profile === REGRESSION_PROFILE ? 41778 : 0);
  try {
    await installWebProfileEntry(project, options.control, warmupFramesFor(options), paceTicksFor(options), options.liveClock);
    // A production build can outlast the default timeout on slow hosted runners.
    const build = await runCommand('pnpm', ['run', 'build:web'], project, undefined, 300_000);
    if (build.status !== 0) throw new ProductionEvidenceError('TN_PROD_WEB_BUILD_FAILED', `The scaffolded platformer web build failed.${failureSuffix(build)}`);
    const artifactSha = await hashPath(join(project, 'dist'));
    const runs = [];
    const startups = [];
    for (let coldStart = 0; coldStart < options.coldStarts; coldStart += 1) {
      const startup = await runWebScenario(project, scenarios.startupPath, join(artifactsRoot, `web-startup-${coldStart + 1}`), markerServer, tools.playtestCli, scenarios.timeoutMs);
      startups.push(startup);
      for (let repetition = 0; repetition < steadyLaunchesAt(options, coldStart); repetition += 1) {
        runs.push(await runWebScenario(
          project,
          scenarios.workloadPath,
          join(artifactsRoot, `web-${coldStart + 1}-${repetition + 1}`),
          markerServer,
          tools.playtestCli,
          scenarios.timeoutMs,
        ));
      }
    }
    return {
      artifactSha,
      workloadHash: await workloadHashFor(project, tools.workloadSourceHash),
      applicationClass: 'platformer-web-build',
      driverClass: 'playwright-chromium-webgpu',
      kind: 'web',
      display,
      runs,
      startups,
    };
  } finally {
    await markerServer.close();
  }
}

/**
 * A display is the difference between the machine's GPU and SwiftShader. Headless Chromium serves
 * WebGPU from its CPU rasteriser even with the recipe's `--enable-features=Vulkan`, so a machine
 * that has a display must run the web arm headed: measured on one RTX 2080, headless reported
 * `google / swiftshader` and headed `nvidia / turing`. The scene-overview probe already makes the
 * same choice (`packages/playtest/src/runner/sceneOverview.ts`). The web arm is refused outright
 * when the runner would measure it on a private Xvfb (`webRateDisplayFault`), so an unconditional
 * `--headed` here costs no headless lane its frames.
 */
async function runWebScenario(project, scenarioPath, artifactDirectory, markerServer, playtestCli, timeoutMs) {
  await mkdir(artifactDirectory, { recursive: true });
  const port = await availablePort();
  const relativeArtifact = relative(project, artifactDirectory);
  const args = [
    playtestCli,
    relative(project, scenarioPath),
    '--artifacts', relativeArtifact,
    '--browser-recipe', 'webgpu',
    // The judge reports its first frame here, and the runner exempts that one request from the
    // network-failure policy. The game's own samples ride the console instead.
    '--judge-marker-url', markerServer.url,
    '--headed',
    '--project', project,
    '--server-command', `pnpm exec vite preview --host 127.0.0.1 --port ${port} --strictPort`,
    '--timeout', String(timeoutMs),
    '--url', `http://127.0.0.1:${port}`,
  ];
  const command = await browserCommand(args);
  // The game stamps its first frame with `Date.now()`, so the elapsed clock here is wall time.
  const startedAt = Date.now();
  // The outer process has to outlive the inner operation budget it hands the CLI, or a scenario
  // the CLI is still legitimately running would be killed from outside.
  const result = await runCommand(command.command, command.args, commandRoot, undefined, timeoutMs + PLAYTEST_TIMEOUT_BASE_MS);
  const report = parsePlaytestReport(result.stdout);
  return normalizeRun(
    result,
    artifactDirectory,
    'web',
    report,
    firstFrameMsFromReport(report, startedAt),
  );
}

async function collectNative(project, scenarios, artifactsRoot, options, tools) {
  const target = options.target === 'desktop-pair' || options.target === 'desktop' ? 'desktop' : options.target.startsWith('ios') ? 'ios' : 'android';
  await installNativeProfileEntry(project, target, options);
  const build = await prepareNativeWorkload(project, target, options);
  if (build.status !== 0) {
    const details = [build.stdout, build.stderr]
      .filter((value) => typeof value === 'string' && value.trim().length > 0)
      .join('\n')
      .trim();
    throw new ProductionEvidenceError(
      `TN_PROD_${target.toUpperCase()}_BUILD_FAILED`,
      `The scaffolded platformer ${target} build failed.${details.length === 0 ? '' : `\n${details.slice(-4_000)}`}`,
    );
  }
  // A desktop prebuilt artifact supplies the runtime used to build the game; launch the packaged
  // game executable, not the bare runtime CLI.
  const artifactPath = target !== 'desktop' && options.prebuiltArtifact !== undefined
    ? options.prebuiltArtifact
    : await nativeArtifactPath(project, target);
  const artifactSha = await hashPath(artifactPath);
  const runs = [];
  const startups = [];
  for (let coldStart = 0; coldStart < options.coldStarts; coldStart += 1) {
    const startup = await runNativeScenario(project, target, scenarios.nativeStartupPath, join(artifactsRoot, `native-startup-${coldStart + 1}`), options, artifactPath, tools, scenarios.timeoutMs);
    startups.push(startup);
    for (let repetition = 0; repetition < steadyLaunchesAt(options, coldStart); repetition += 1) {
      runs.push(await runNativeScenario(
        project,
        target,
        scenarios.nativeWorkloadPath,
        join(artifactsRoot, `native-${coldStart + 1}-${repetition + 1}`),
        options,
        artifactPath,
        tools,
        scenarios.timeoutMs,
      ));
    }
  }
  return {
    artifactSha,
    workloadHash: build.workloadHash ?? await workloadHashFor(project, tools.workloadSourceHash),
    bundleSha: build.bundleSha ?? await hashPath(join(project, '.threenative/build/game.js')),
    applicationClass: `platformer-${target}-build`,
    driverClass: `threenative-${target}-runtime`,
    kind: target,
    runs,
    startups,
  };
}

async function runNativeScenario(project, target, scenarioPath, artifactDirectory, options, artifactPath, tools, timeoutMs) {
  await mkdir(artifactDirectory, { recursive: true });
  if (target === 'desktop') {
    return await runDesktopBridgeScenario(project, scenarioPath, artifactDirectory, options, artifactPath, tools, timeoutMs);
  }
  const modulePath = await playtestRunnerPath(project, tools);
  if (modulePath === undefined) {
    return { elapsedMs: undefined, report: undefined, screenshot: undefined, series: undefined, status: 2 };
  }
  if (target === 'android') await installAndroidArtifact(artifactPath, options.device);
  // The game declares its identity in `threenative.config.ts` and packaging resolves it; profiling
  // launches whatever packaging shipped, so it reads the id from there instead of restating one.
  const appId = options.prebuiltArtifact === undefined
    ? readAndroidConfig(profileConfigPath(project, options.config)).app.id
    : (await readPrebuiltWorkload(options.prebuiltArtifact, target, options)).appId;
  const config = {
    android: { activity: 'com.threenative.runtime.MystralActivity', packageName: appId },
    allowSoftwareAdapter: options.hostedSoftware,
    artifactDirectory,
    device: options.device,
    headless: true,
    ios: {
      appPath: target === 'ios' ? artifactPath : undefined,
      bundleId: appId,
      transport: options.target === 'ios-physical' ? 'device' : 'simulator',
    },
    projectPath: project,
    scenarioPath: relative(project, scenarioPath),
    target,
    timeoutMs,
    trace: false,
    url: 'http://127.0.0.1:41777',
  };
  const runner = await import(pathToFileURL(modulePath).href);
  const started = performance.now();
  const startedAt = Date.now();
  try {
    const report = target === 'android'
      ? await runner.runAndroidPlaytest(config)
      : await runner.runIosPlaytest(config);
    return normalizeRun(
      { durationMs: performance.now() - started, status: report.pass ? 0 : 1 },
      artifactDirectory,
      target,
      report,
      firstFrameMsFromReport(report, startedAt),
      frameSeriesFromReport(report, target),
    );
  } catch {
    return { elapsedMs: performance.now() - started, report: undefined, screenshot: undefined, series: undefined, status: 2 };
  }
}

async function runDesktopBridgeScenario(project, scenarioPath, artifactDirectory, options, artifactPath, tools, timeoutMs) {
  const modulePath = await playtestRunnerPath(project, tools);
  if (modulePath === undefined) {
    return { elapsedMs: undefined, report: undefined, screenshot: undefined, series: undefined, status: 2 };
  }
  const mailboxRoot = join(project, '.runtime-mailbox');
  await mkdir(mailboxRoot, { recursive: true });
  await removeMailbox(mailboxRoot);
  const requestPath = join(mailboxRoot, 'tn-playtest-request.json');
  const responsePath = join(mailboxRoot, 'tn-playtest-response.json');
  const runner = await import(pathToFileURL(modulePath).href);
  const mailbox = new runner.LocalDeviceMailbox();
  const innerTransport = new runner.DeviceMailboxTransport(mailbox, { request: requestPath, response: responsePath });
  const driver = createDesktopDriver(artifactPath, project, options, mailboxRoot);
  const transport = {
    capabilities: innerTransport.capabilities,
    call: innerTransport.call.bind(innerTransport),
    close: innerTransport.close.bind(innerTransport),
    start: async () => {
      await innerTransport.start();
      await driver.launch();
    },
    waitForBridge: innerTransport.waitForBridge.bind(innerTransport),
  };
  const config = {
    allowSoftwareAdapter: options.hostedSoftware,
    artifactDirectory,
    headless: true,
    projectPath: project,
    scenarioPath: relative(project, scenarioPath),
    target: 'android',
    timeoutMs,
    trace: false,
    url: 'http://127.0.0.1:41777',
  };
  const started = performance.now();
  const startedAt = Date.now();
  try {
    const report = await runner.runDevicePlaytest(config, {
      driver,
      mailboxPaths: { request: requestPath, response: responsePath },
      name: 'desktop',
      processName: 'threenative-platformer-desktop',
      transport,
    });
    return normalizeRun(
      { durationMs: performance.now() - started, status: report.pass ? 0 : 1 },
      artifactDirectory,
      'desktop',
      report,
      firstFrameMsFromReport(report, startedAt),
    );
  } catch (error) {
    let cleanupError;
    try {
      await driver.stop();
    } catch (error) {
      cleanupError = error;
    }
    return desktopFailureRun(error, await driver.captureConsole(), performance.now() - started, cleanupError);
  }
}

export function desktopFailureRun(error, consoleOutput, elapsedMs, cleanupError = undefined) {
  const retain = (value, fallback) => {
    try { return sanitizeManifest(value); } catch { return fallback; }
  };
  const diagnostic = cleanupError?.diagnostic ?? error?.diagnostic;
  return {
    elapsedMs, status: 2, screenshot: undefined, series: undefined,
    report: {
      pass: false, target: 'desktop', assertionResults: [],
      diagnostics: [retain(diagnostic ?? {
        code: 'TN_PROD_PLAYTEST_FAILED', severity: 'error',
        message: error instanceof Error ? error.message : String(error),
      }, { code: 'TN_PROD_REDACTION', severity: 'error', message: 'Unsafe native error details withheld.' })],
      observations: { console: consoleOutput.map((entry) => retain(entry, {
        type: 'error', text: 'TN_PROD_REDACTION: unsafe native console entry withheld.',
      })) },
    },
  };
}

export function profileConfigPath(project, configPath = undefined) {
  return configPath ?? join(project, '.threenative', 'build', 'config.json');
}

export function rendererResolutionScaleSetting(config, target) {
  const renderer = config?.renderer ?? {};
  const scale = target.startsWith('android')
    ? renderer.android?.resolutionScale ?? renderer.resolutionScale
    : renderer.resolutionScale;
  if (scale === undefined) return 'unset';
  if (scale === 'auto') return scale;
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0 || scale > 1) {
    throw new ProductionEvidenceError('TN_PROD_RENDERER_SCALE_INVALID', 'Built config has an invalid renderer resolutionScale.');
  }
  return String(scale);
}

async function readResolutionScaleSetting(project, options) {
  let config;
  try {
    config = JSON.parse(await readFile(profileConfigPath(project, options.config), 'utf8'));
  } catch (error) {
    throw new ProductionEvidenceError(
      'TN_PROD_RENDERER_SCALE_MISSING',
      `Could not read the built renderer config: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return rendererResolutionScaleSetting(config, options.target);
}

function createDesktopDriver(artifactPath, project, options, mailboxRoot) {
  let child;
  let output = '';
  let stopping;
  const screenshotRequestPath = join(mailboxRoot, 'tn-playtest-screenshot-request.txt');
  return {
    // GLib supplies severity before its message, which can itself contain the word Error.
    captureConsole: async () => output.split(/\r?\n/u).filter(Boolean).map((text) => ({ text, type: /^\s*(?:\*\* \([^)]*\): WARNING \*\*:|\([^)]*\): dbind-WARNING \*\*:)/u.test(text) ? 'warning' : /\b(?:Error|FAILED|FATAL)\b/u.test(text) ? 'error' : 'log' })),
    isAlive: async () => child !== undefined && child.exitCode === null,
    launch: async () => {
      child = spawnNative(artifactPath, project, options, mailboxRoot);
      child.stdout?.on('data', (chunk) => { output += chunk.toString(); });
      child.stderr?.on('data', (chunk) => { output += chunk.toString(); });
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
    },
    prepare: async () => undefined,
    readFile: async (path) => readFile(path, 'utf8').catch((error) => error?.code === 'ENOENT' ? undefined : Promise.reject(error)),
    removeFile: async (path) => rm(path, { force: true }).catch(() => undefined),
    screenshot: async (path) => {
      const temporary = `${screenshotRequestPath}.tmp`;
      await writeFile(temporary, path, 'utf8');
      await rename(temporary, screenshotRequestPath);
      const deadline = Date.now() + DESKTOP_SCREENSHOT_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (await nonBlankPng(path)) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('TN_PROD_NATIVE_SCREENSHOT_UNAVAILABLE');
    },
    stop: async () => {
      if (stopping !== undefined) return stopping;
      stopping = (async () => {
        if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
        const cleanupTimeoutMs = options.desktopCleanupTimeoutMs ?? 10_000;
        const waitForExit = new Promise((resolve, reject) => {
          let timer;
          let settled = false;
          const finish = (exited) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            child.off('exit', onExit);
            resolve(exited);
          };
          const onExit = () => finish(true);
          child.once('exit', onExit);
          timer = setTimeout(() => finish(false), cleanupTimeoutMs);
          try {
            if (process.platform === 'win32') child.kill();
            else process.kill(-child.pid, 'SIGTERM');
          } catch (error) {
            if (error?.code === 'ESRCH') finish(true);
            else {
              settled = true;
              clearTimeout(timer);
              child.off('exit', onExit);
              reject(error);
            }
          }
          if (child.exitCode !== null || child.signalCode !== null) finish(true);
        });
        if (await waitForExit || child.exitCode !== null || child.signalCode !== null) return;
        const diagnostic = {
          code: 'TN_PROD_DESKTOP_CLEANUP_TIMEOUT',
          message: `Desktop cleanup phase 'desktop-stop' did not observe the process exit within ${cleanupTimeoutMs}ms; process was observed alive.`,
          observedAlive: true,
          observedExited: false,
          phase: 'desktop-stop',
          processState: 'alive',
          severity: 'error',
        };
        throw Object.assign(new Error(diagnostic.message), { diagnostic });
      })();
      return stopping;
    },
    writeFile: async (path, contents) => writeFile(path, contents, 'utf8'),
  };
}

// `xvfb-run` can replace a successful child's status with its cleanup failure. Use the
// repository wrapper in headless Linux and preserve the child's own status.
function privateDisplayCommand(executable, args) {
  if (process.platform !== 'linux' || process.env.DISPLAY !== undefined) {
    return { args, command: executable };
  }
  const wrapper = join(scriptDirectory, 'xvfb.sh');
  if (!existsSync(wrapper)) {
    throw new ProductionEvidenceError(
      'TN_PROD_XVFB_WRAPPER_UNAVAILABLE',
      `Headless Linux profiling needs the packaged display wrapper '${wrapper}', which is missing.`,
    );
  }
  return { args: [wrapper, executable, ...args], command: '/bin/sh' };
}

export function nativeLaunchesExternalBundle(artifactPath, options) {
  return options.prebuiltArtifact !== undefined && artifactPath === options.prebuiltArtifact;
}

function spawnNative(artifactPath, project, options, mailboxRoot) {
  const bundle = join(project, '.threenative/build/game.js');
  // A packaged desktop artifact embeds the instrumented game entry under its own module root, and
  // an explicit `run <absolute path>` is resolved against that root rather than the filesystem, so
  // the external bundle never loads and the run reports TN_PLAYTEST_BRIDGE_MISSING at zero frames.
  // Launch the embedded entry. A bare runtime supplied through `--prebuilt-artifact` carries no
  // embedded entry and still needs the external bundle named on the command line.
  const launchesExternalBundle = nativeLaunchesExternalBundle(artifactPath, options);
  const nativeArgs = [
    ...(launchesExternalBundle ? ['run', bundle] : []),
    '--width', String(options.renderSize.width),
    '--height', String(options.renderSize.height),
    '--headless',
  ];
  const command = privateDisplayCommand(artifactPath, nativeArgs);
  return spawn(command.command, command.args, {
    cwd: project,
    detached: process.platform !== 'win32',
    env: { ...process.env, TN_PLAYTEST_MAILBOX_ROOT: mailboxRoot, SDL_VIDEODRIVER: process.platform === 'linux' ? 'x11' : process.env.SDL_VIDEODRIVER },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export async function installNativeProfileEntry(project, target, options) {
  const entryPath = join(project, 'src/profile-native-entry.ts');
  const profileMarkerPath = join(project, 'src/profile-native-profile.ts');
  const mailboxRoot = '.runtime-mailbox';
  const profileMarker = `Object.assign(globalThis, { __THREENATIVE_PROFILE__: Object.freeze({ hostedSoftware: ${options.hostedSoftware === true} }) });\n`;
  const mailbox = target === 'desktop'
    ? `globalThis.TN_PLAYTEST_MAILBOX = ${JSON.stringify({ request: join(mailboxRoot, 'tn-playtest-request.json'), response: join(mailboxRoot, 'tn-playtest-response.json') })};\n`
    : '';
  const source = `import "./profile-native-profile.js";\nimport game from "./game.js";\n${nativeFrameInstrumentation(options.control, warmupFramesFor(options), paceTicksFor(options), options.liveClock)}\n${mailbox}export default game;\n`;
  await writeFile(profileMarkerPath, profileMarker);
  await writeFile(entryPath, source);
  await setNativeProfileEntry(project, 'src/profile-native-entry.ts', options.renderSize);
  if (target === 'desktop') await pinThreejsDesktopHost(project);
}

/**
 * A desktop profile launches the Three.js host's packaged executable (`mystral`), but a config that
 * sets no `engine` now builds a directory around the V8 engine player. Name the override in the
 * staged copy, once, and leave an `engine` the game declares as authored.
 */
export async function pinThreejsDesktopHost(project) {
  const configPath = join(project, 'threenative.config.ts');
  const config = await readFile(configPath, 'utf8').catch(() => undefined);
  if (config === undefined || /^\s*["']?engine["']?\s*:/mu.test(config)) return;
  const opening = /(?:=|export default)\s*\{/u;
  if (!opening.test(config)) {
    throw new ProductionEvidenceError('TN_PROD_ENGINE_PIN_FAILED', `${configPath} has no config object to pin engine: "threejs" into.`);
  }
  await writeFile(configPath, config.replace(opening, '$&\n  engine: "threejs",'));
}

export async function setNativeProfileEntry(project, entry, renderSize = undefined) {
  const configPath = join(project, 'threenative.config.ts');
  const packagePath = join(project, 'package.json');
  const config = await readFile(configPath, 'utf8').catch(() => undefined);
  if (config !== undefined) {
    // Whether the config declares the field at all is a different question from whether its value
    // changes, and only the first one decides where the entry lives. Reading it off `withEntry !==
    // config` conflates the two: a config already naming this entry left the value unchanged, fell
    // through to the package.json branch below, and declared `nativeEntry` in *both* files — which
    // the next `threenative build --target desktop` refuses with `TN_CONFIG_CONFLICT`. A project
    // profiled once could therefore never be profiled a second time.
    const entryPattern = /^(\s*nativeEntry\s*:\s*)["'][^"']*["'](,?.*)$/mu;
    const declaresEntry = entryPattern.test(config);
    const withEntry = config.replace(entryPattern, `$1"${entry}"$2`);
    // The packaged desktop artifact carries the game's config embedded, and the native host reads
    // its window size from there before any command-line flag, so the profiled surface is only the
    // requested render size when the config states it.
    const sized = renderSize === undefined ? withEntry : applyWindowSize(withEntry, renderSize);
    if (sized !== config) {
      await writeFile(configPath, sized);
    }
    if (declaresEntry) {
      // One declaration, in the file the config layer resolves first. Dropping a stale key is also
      // how a project already corrupted by the old fall-through is repaired on its next run.
      const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
      if (packageJson.threenative?.nativeEntry !== undefined) {
        delete packageJson.threenative.nativeEntry;
        if (Object.keys(packageJson.threenative).length === 0) delete packageJson.threenative;
        await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
      }
      return;
    }
  }
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  packageJson.threenative = { ...packageJson.threenative, nativeEntry: entry };
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

function applyWindowSize(config, renderSize) {
  return config
    .replace(/(\bwindow\s*:\s*\{[^}]*?\bwidth\s*:\s*)\d+/mu, `$1${renderSize.width}`)
    .replace(/(\bwindow\s*:\s*\{[^}]*?\bheight\s*:\s*)\d+/mu, `$1${renderSize.height}`);
}

function productionPerformanceReader() {
  return `
// The installed bridge answers through a promise: core's playtest plugin wraps sample() to merge
// its runtime observation contributions asynchronously, so reading the returned snapshot inline
// saw a thenable and dropped every draw-call and triangle reading. Keep the last resolved
// performance read and answer it on the next frame instead.
let tnProductionLastPerformance;
const tnProductionReadPerformance = () => {
  const bridge = globalThis.__THREENATIVE_PLAYTEST_BRIDGE__;
  if (typeof bridge?.sample === "function") {
    try {
      const snapshot = bridge.sample({});
      if (snapshot !== null && typeof snapshot === "object") {
        if (typeof snapshot.then === "function") {
          snapshot.then((resolved) => { tnProductionLastPerformance = resolved?.performance; }).catch(() => undefined);
        } else {
          tnProductionLastPerformance = snapshot.performance;
        }
      }
    } catch {
    }
  }
  const performance = tnProductionLastPerformance;
  return {
    ...(Number.isFinite(performance?.drawCalls) ? { drawCalls: performance.drawCalls } : {}),
    ...(performance?.phases !== undefined ? { phases: performance.phases } : {}),
    ...(Number.isFinite(performance?.triangles) ? { triangles: performance.triangles } : {}),
  };
};
`;
}

/**
 * Ask the game for the wall clock, so the profile measures a game playing.
 *
 * A profile run is a playtest run, and a playtest run freezes the live clock: the runner asks the
 * bridge for fixed steps and the loop simulates nothing else, so the frames the host presents while
 * a burst of ticks is delivered repeat one standing state. The browser reported ~60 fps of a
 * platformer whose movement was advancing in ten-tick jumps, and the frame samples the judge reads
 * described that, not the game. `__THREENATIVE_PLAYTEST_CLOCK__` is the framework's own switch for
 * the opposite, and it has to be set before the bundle evaluates — which is what the instrumentation
 * this rides in is.
 */
export function productionClockRequest(liveClock = false) {
  return liveClock === true ? 'globalThis.__THREENATIVE_PLAYTEST_CLOCK__ = "wall-clock";\n' : '';
}

/**
 * Pace the fixed step to wall time so a synthetic workload's tick budget is the seconds it names.
 *
 * The native device transport drives the simulation through `bridge.advance(ticks)`, and the host
 * runs that loop synchronously: a single `advance(3600)` finishes in milliseconds, so the host's
 * requestAnimationFrame loop never presents the 60 seconds of frames the scenario asked to warm up
 * or measure, and the warmup boundary is never reached. Wrapping `advance` to wait one display
 * interval per tick lets the host's own loop run during the wait, so the frames exist to be
 * measured.
 *
 * The same wrapper arms on the live clock, and it is idempotent there rather than a second wait: a
 * wall-clock `advance` spends the span its ticks name before the wrapper reads its own deadline, so
 * the remainder is zero or less and no wall-clock run is slowed. It is also the only thing that
 * makes the host present the frames on any host whose `advance` did not wait them, which is what a
 * short measured window is. Reading the live clock as "already paced, so skip the pacer" was the
 * defect: the native host consumed the frame-count workload at its own speed, and 60 requested
 * seconds published as a 1.5 s window.
 */
export function productionExecutionHold(paceTicks = false) {
  return `
const tnProductionPaceEnabled = ${paceTicks === true};
const tnProductionTickIntervalMs = ${PRODUCTION_TICK_INTERVAL_MS};
let tnProductionPaceAt;
let tnProductionPaceInstalled = false;
const tnProductionInstallPace = () => {
  if (!tnProductionPaceEnabled || tnProductionPaceInstalled) return;
  const tnProductionBridge = globalThis.__THREENATIVE_PLAYTEST_BRIDGE__;
  if (typeof tnProductionBridge?.advance !== "function") return;
  const tnProductionAdvance = tnProductionBridge.advance.bind(tnProductionBridge);
  tnProductionBridge.advance = async (ticks) => {
    const startedAt = performance.now();
    tnProductionPaceAt = Math.max(tnProductionPaceAt ?? startedAt, startedAt) + ticks * tnProductionTickIntervalMs;
    const result = await tnProductionAdvance(ticks);
    const waitMs = tnProductionPaceAt - performance.now();
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    return result;
  };
  tnProductionPaceInstalled = true;
};
tnProductionInstallPace();
`;
}

/**
 * The warmup boundary both arms share: the frame count *and* the wall time those frames were asked
 * to cover.
 *
 * A frame count only names a duration on a host that presents at 60 Hz, and neither host is one. The
 * native host ran 120 frames — the whole `--warmup 2` budget — in 1.18 s of a requested 2 s while it
 * booted at 100-170 Hz, so the measured window started at the last first-use pipeline compile and
 * published boot as a frame rate: native 26.29 mean fps, 306.04 ms p95, beside
 * `execution.warmupSeconds: 2`. The frame bound stays, because a host *slower* than 60 Hz needs it
 * more than a host that runs ahead, and the two are the same number on a 60 Hz browser.
 */
function productionWarmupBoundary(warmupFrames = 0) {
  return `
const tnProductionWarmupMs = ${Math.max(0, Math.floor(warmupFrames)) / 60 * 1_000};
let tnProductionStartedAtMs;
const tnProductionInWarmup = (frameIndex, now) => {
  tnProductionStartedAtMs ??= now;
  return frameIndex < tnProductionWarmupFrames || now - tnProductionStartedAtMs < tnProductionWarmupMs;
};
`;
}

/**
 * The measurement reset, on the transition rather than on the frame count the boundary also checks.
 *
 * The frame count is only one of the two bounds, and a host that presents slower than 60 Hz reaches
 * the wall time later. Clearing the carry on the frame count left the last warmup frame still holding
 * the previous frame's clock, so the first measured frame reported the interval that spanned the
 * boundary — the crossing stall, or the whole warmup tail — as gameplay. Both arms warm up
 * monotonically, so the transition happens once and the flag keeps it to once.
 */
function tnProductionMeasurementStart() {
  return `if (!inWarmup && !tnProductionMeasuring) {
  tnProductionMeasuring = true;
  tnProductionPreviousFrame = undefined;
  tnProductionSamples = [];
}`;
}

export function nativeFrameInstrumentation(control, warmupFrames = 0, paceTicks = false, liveClock = false) {
  return `
const tnProductionControl = ${JSON.stringify(control ?? '')};
const tnProductionWarmupFrames = ${Math.max(0, Math.floor(warmupFrames))};
const tnProductionRequestAnimationFrame = globalThis.requestAnimationFrame;
if (typeof tnProductionRequestAnimationFrame !== "function") {
  throw new Error("TN_PROD_NATIVE_RAF_UNAVAILABLE: native host did not provide requestAnimationFrame.");
}
${productionClockRequest(liveClock)}
let tnProductionFirstFrame = true;
let tnProductionFrameIndex = 0;
let tnProductionPreviousFrame;
let tnProductionPresentation;
let tnProductionSamples = [];
let tnProductionMeasuring = false;
let tnProductionSlowFramesRemaining = ${SLOW_FRAME_COUNT};
const tnProductionBusyWait = (milliseconds) => {
  const deadline = performance.now() + milliseconds;
  while (performance.now() < deadline) {}
};
${productionWarmupBoundary(warmupFrames)}
${productionPerformanceReader()}
${productionExecutionHold(paceTicks)}
globalThis.requestAnimationFrame = (callback) => tnProductionRequestAnimationFrame((timestamp) => {
  tnProductionInstallPace();
  const frameIndex = tnProductionFrameIndex++;
  if (tnProductionFirstFrame && tnProductionControl === "slow-startup") tnProductionBusyWait(${SLOW_STARTUP_DELAY_MS});
  const now = performance.now();
  const inWarmup = tnProductionInWarmup(frameIndex, now);
  ${tnProductionMeasurementStart()}
  const frameMs = inWarmup || tnProductionPreviousFrame === undefined ? undefined : now - tnProductionPreviousFrame;
  tnProductionPreviousFrame = now;
  callback(timestamp);
  if (tnProductionFirstFrame) {
    tnProductionFirstFrame = false;
    console.log("TN_PROD_FIRST_NONBLANK_FRAME:" + Date.now());
  }
  if (!inWarmup && frameMs !== undefined) {
    tnProductionSamples.push({
      ...tnProductionReadPerformance(),
      ...(Number.isFinite(timestamp) ? { presentationMs: timestamp } : {}),
      clockMs: now,
      frameIndex,
      frameMs,
    });
    if (tnProductionSamples.length >= ${NATIVE_FRAME_SAMPLE_BATCH_SIZE}) {
      console.log("TN_PROD_FRAME_SAMPLES:" + JSON.stringify(tnProductionSamples));
      tnProductionSamples = [];
    }
  }
  if (!inWarmup && tnProductionControl === "slow-native" && tnProductionSlowFramesRemaining > 0) {
    tnProductionBusyWait(${SLOW_FRAME_DELAY_MS});
    tnProductionSlowFramesRemaining -= 1;
  }
});
`;
}

/**
 * The web arm reports over the console, the same transport the native arm already uses, so one
 * parser and one clock serve both. It used to POST to a marker server, which the playtest's own
 * `noNetworkErrors` policy then failed the run for: Chromium reports every in-flight `fetch` as
 * `net::ERR_ABORTED` when the runner tears the page down, so the profile failed its own runs for
 * its own instrumentation. The judge still owns `--judge-marker-url`; only the game's samples moved.
 */
export function webFrameInstrumentation(control, warmupFrames = 0, paceTicks = false, liveClock = false) {
  return `
const tnProductionControl = ${JSON.stringify(control ?? '')};
const tnProductionWarmupFrames = ${Math.max(0, Math.floor(warmupFrames))};
const tnProductionRequestAnimationFrame = globalThis.requestAnimationFrame;
if (typeof tnProductionRequestAnimationFrame !== "function") {
  throw new Error("TN_PROD_WEB_RAF_UNAVAILABLE: browser host did not provide requestAnimationFrame.");
}
${productionClockRequest(liveClock)}
let tnProductionFirstFrame = true;
let tnProductionFrameIndex = 0;
let tnProductionPreviousFrame;
let tnProductionPresentation;
let tnProductionSamples = [];
let tnProductionMeasuring = false;
let tnProductionSlowFramesRemaining = ${SLOW_FRAME_COUNT};
const tnProductionBusyWait = (milliseconds) => {
  const deadline = performance.now() + milliseconds;
  while (performance.now() < deadline) {}
};
${productionWarmupBoundary(warmupFrames)}
${productionPerformanceReader()}
${productionExecutionHold(paceTicks)}
globalThis.requestAnimationFrame = (callback) => tnProductionRequestAnimationFrame((timestamp) => {
  tnProductionInstallPace();
  // One browser presentation can invoke every callback registered for it with the same
  // DOMHighResTimeStamp. Counting each callback would push a zero-length interval and make meanFps
  // indeterminate, so only the first callback for a presentation is the frame; the rest still run
  // their callback unchanged.
  if (Number.isFinite(timestamp) && timestamp === tnProductionPresentation) {
    callback(timestamp);
    return;
  }
  tnProductionPresentation = Number.isFinite(timestamp) ? timestamp : undefined;
  const frameIndex = tnProductionFrameIndex++;
  if (tnProductionFirstFrame && tnProductionControl === "slow-startup") tnProductionBusyWait(${SLOW_STARTUP_DELAY_MS});
  const now = performance.now();
  const inWarmup = tnProductionInWarmup(frameIndex, now);
  ${tnProductionMeasurementStart()}
  const frameMs = inWarmup || tnProductionPreviousFrame === undefined ? undefined : now - tnProductionPreviousFrame;
  tnProductionPreviousFrame = now;
  callback(timestamp);
  if (tnProductionFirstFrame) {
    tnProductionFirstFrame = false;
    console.log("TN_PROD_FIRST_NONBLANK_FRAME:" + Date.now());
  }
  if (!inWarmup && frameMs !== undefined) {
    tnProductionSamples.push({
      ...tnProductionReadPerformance(),
      ...(Number.isFinite(timestamp) ? { presentationMs: timestamp } : {}),
      clockMs: now,
      frameIndex,
      frameMs,
    });
    if (tnProductionSamples.length >= ${FRAME_SAMPLE_BATCH_SIZE}) {
      console.log("TN_PROD_FRAME_SAMPLES:" + JSON.stringify(tnProductionSamples));
      tnProductionSamples = [];
    }
  }
  if (!inWarmup && tnProductionControl === "slow-path" && tnProductionSlowFramesRemaining > 0) {
    tnProductionBusyWait(${SLOW_FRAME_DELAY_MS});
    tnProductionSlowFramesRemaining -= 1;
  }
});
`;
}

async function installWebProfileEntry(project, control, warmupFrames = 0, paceTicks = false, liveClock = false) {
  const markerPath = join(project, 'src/profile-production-marker.ts');
  const mainPath = join(project, 'src/main.ts');
  const markerImport = 'import "./profile-production-marker.js";';
  const main = await readFile(mainPath, 'utf8');
  const source = webFrameInstrumentation(control, warmupFrames, paceTicks, liveClock);
  await writeFile(markerPath, source);
  if (!main.includes(markerImport)) await writeFile(mainPath, `${markerImport}\n${main}`);
}


async function createFrameMarkerServer(port = 0) {
  const events = [];
  const waiters = [];
  const server = createServer((request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      let payload = {};
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        // The request is still a first-frame signal even if the optional batch is malformed.
      }
      const event = { ...payload, receivedAt: performance.now() };
      events.push(event);
      for (const waiter of waiters.splice(0)) waiter();
      response.setHeader('access-control-allow-origin', '*');
      response.writeHead(204).end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new ProductionEvidenceError('TN_PROD_MARKER_SERVER_FAILED', 'The first-frame marker server did not expose a TCP port.');
  return {
    close: () => new Promise((resolve) => server.close(() => resolve())),
    get length() { return events.length; },
    url: `http://127.0.0.1:${address.port}/first-frame`,
    waitFor: async (from, timeoutMs) => {
      if (events.length > from) return markerEvents(events.slice(from));
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        const waiter = () => {
          clearTimeout(timer);
          resolve();
        };
        waiters.push(waiter);
      });
      return markerEvents(events.slice(from));
    },
  };
}

function markerEvents(events) {
  const firstFrame = events.find(({ kind }) => kind === 'first-frame');
  const samples = events.flatMap(({ kind, samples: batch }) => kind === 'samples' && Array.isArray(batch) ? batch : []);
  return { firstFrame, samples };
}

export async function normalizeRun(
  result,
  artifactDirectory,
  kind,
  report = undefined,
  firstFrameMs = undefined,
  collectedSeries = [],
) {
  const reportSeries = report?.observations?.visual?.runtimeDiagnosticsSeries;
  const performanceSeries = report?.observations?.performanceSeries;
  const consoleSeries = frameSeriesFromReport(report, kind);
  const series = kind === 'desktop'
    ? consoleSeries
    : [collectedSeries, reportSeries, performanceSeries, consoleSeries]
      .find((candidate) => Array.isArray(candidate) && candidate.length > 0);
  const screenshotPath = join(artifactDirectory, 'after.png');
  const screenshot = await nonBlankPng(screenshotPath) ? await readFile(screenshotPath) : undefined;
  return {
    elapsedMs: result.durationMs,
    ...(Number.isFinite(firstFrameMs) ? { firstFrameMs } : {}),
    // A child that exits without a parseable report has no report and usually no screenshot, so
    // without this the whole run vanishes from the evidence and the failure is an absence.
    ...(report === undefined ? { failure: missingReportFailure(result) } : {}),
    kind,
    report: report === undefined ? undefined : safeReport(report),
    screenshot,
    series: Array.isArray(series) ? series : undefined,
    status: result.status,
  };
}

function missingReportFailure(result) {
  return sanitizeReportValue({
    code: 'TN_PROD_RUN_REPORT_MISSING',
    message: `The child run exited without a parseable report${failureSuffix(result).slice(-4_000)}`,
    severity: 'error',
    status: result.status,
    timedOut: result.timedOut === true,
  });
}

const REPORT_REDACTION_MESSAGE = 'TN_PROD_REDACTION: unsafe native report detail withheld.';

export function safeReport(report) {
  const safe = {
    assertionResults: report.assertionResults,
    diagnostics: report.diagnostics,
    observations: report.observations,
    pass: report.pass,
    scenario: report.scenario,
    target: report.target,
  };
  try {
    return sanitizeManifest(safe);
  } catch {
    return sanitizeReportValue(safe);
  }
}

function sanitizeReportValue(value) {
  if (value === undefined || value === null) return value;
  if (Array.isArray(value)) return value.map((nested) => sanitizeReportValue(nested));
  if (typeof value === 'object') {
    const sanitized = {};
    for (const [key, nested] of Object.entries(value)) {
      const candidate = sanitizeReportValue(nested);
      try {
        const checked = sanitizeManifest({ [key]: candidate });
        sanitized[key] = checked[key];
      } catch {
        // Privacy-sensitive fields are omitted from retained diagnostics; the verdict and safe
        // observations remain available for a fail-closed report.
      }
    }
    return sanitized;
  }
  try {
    return sanitizeManifest(value);
  } catch {
    return REPORT_REDACTION_MESSAGE;
  }
}

function parsePlaytestReport(stdout) {
  const text = typeof stdout === 'string' ? stdout.trim() : '';
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    for (const line of text.split(/\r?\n/u).reverse()) {
      if (!line.trim().startsWith('{')) continue;
      try {
        return JSON.parse(line);
      } catch {
      }
    }
  }
  return undefined;
}

function reportConsoleLines(report) {
  return (report?.observations?.console ?? [])
    .map((entry) => typeof entry?.text === 'string' ? entry.text : '')
    .filter(Boolean);
}

function firstFrameMsFromReport(report, startedAt) {
  const line = reportConsoleLines(report).find((entry) => entry.includes('TN_PROD_FIRST_NONBLANK_FRAME:'));
  const timestamp = line === undefined ? undefined : Number(line.split('TN_PROD_FIRST_NONBLANK_FRAME:').at(-1));
  if (!Number.isFinite(timestamp)) return undefined;
  const elapsed = timestamp - startedAt;
  return elapsed >= 0 ? elapsed : undefined;
}

/**
 * The desktop host takes its `after.png` inside its own frame loop, so the readback runs where a
 * frame runs and the frame that spans it reports the readback as its own `frameMs`. Both clean-HEAD
 * native collections at `f645e65c8` carry a 358.26 ms and a 312.72 ms gap in the batch logged after
 * the host's capture line, beside a `TN_SLOW_PHASE pollEvents` at 358.19 and 312.79 ms. The capture
 * line and the sample batches are both `std::cout` in that one process, so console order is write
 * order and the line is an exact boundary rather than a threshold: every batch logged at or after it
 * is dropped whole, because such a batch straddles the capture and dropping one is the direction
 * that cannot read the readback as gameplay. The capture is still requested and its artifact still
 * retained — this bounds the measured window, it does not remove the evidence.
 */
function frameSeriesFromReport(report, kind) {
  const lines = reportConsoleLines(report);
  // No capture line means no boundary, so a desktop report keeps nothing and fails closed rather than
  // publishing a window this parser cannot bound; every other arm keeps its whole console.
  const capture = kind === 'desktop'
    ? lines.findIndex((line) => line.includes('[Screenshot] First 16 bytes'))
    : lines.length;
  const series = [];
  for (const line of lines.slice(0, Math.max(capture, 0))) {
    const prefix = 'TN_PROD_FRAME_SAMPLES:';
    const offset = line.indexOf(prefix);
    if (offset === -1) continue;
    try {
      const batch = JSON.parse(line.slice(offset + prefix.length));
      if (Array.isArray(batch)) series.push(...batch);
    } catch {
    }
  }
  return series.length === 0 ? undefined : series;
}

export function assembleEvidence({ context, native, options, performanceBounds, project, resolutionScaleSetting, runId, startedAt, web }) {
  const arms = [web, native].filter((arm) => arm !== undefined);
  const regression = options.profile === REGRESSION_PROFILE;
  const expectedRuns = collectionLaunchPlan(options).filter((entry) => entry === 'steady').length;
  const codes = [];
  const rawArtifacts = [];
  for (const arm of arms) {
    if (arm.runs.some(({ series }) => !Array.isArray(series) || series.length === 0)) codes.push('TN_PROD_RENDER_SAMPLES_INCOMPLETE');
    if (arm.startups.length !== options.coldStarts || arm.startups.some((sample) => !isSuccessfulStartupSample(sample))) {
      codes.push('TN_PROD_STARTUP_SAMPLES_INCOMPLETE');
    }
    if (arm.runs.length !== expectedRuns || arm.runs.some(({ report, status }) => status !== 0 || report?.pass !== true)) {
      codes.push('TN_PROD_PLAYTEST_FAILED');
    }
    for (const [index, run] of arm.runs.entries()) {
      if (run.screenshot !== undefined) rawArtifacts.push({ content: run.screenshot, label: `production-render-${arm.kind}-${index + 1}` });
      if (run.report !== undefined) rawArtifacts.push({ content: JSON.stringify(run.report), label: `production-playtest-${arm.kind}-${index + 1}` });
      if (run.failure !== undefined) rawArtifacts.push({ content: JSON.stringify(run.failure), label: `production-run-failure-${arm.kind}-${index + 1}` });
    }
    for (const [index, startup] of arm.startups.entries()) {
      if (startup.screenshot !== undefined) rawArtifacts.push({ content: startup.screenshot, label: `production-first-frame-${arm.kind}-${index + 1}` });
      if (startup.report !== undefined) rawArtifacts.push({ content: JSON.stringify(startup.report), label: `production-startup-${arm.kind}-${index + 1}` });
      if (startup.failure !== undefined) rawArtifacts.push({ content: JSON.stringify(startup.failure), label: `production-startup-failure-${arm.kind}-${index + 1}` });
    }
  }
  const metricsByArm = new Map(arms.map((arm) => [arm.kind, aggregateMetrics(arm.runs, arm.startups, warmupFramesFor(options))]));
  const webMetrics = metricsByArm.get('web');
  const nativeMetrics = metricsByArm.get('desktop') ?? metricsByArm.get('android') ?? metricsByArm.get('ios');
  const metrics = {
    ...(webMetrics ?? nativeMetrics ?? emptyMetrics()),
    ...(webMetrics === undefined ? {} : { web: pairMetrics(webMetrics) }),
    ...(nativeMetrics === undefined ? {} : { native: pairMetrics(nativeMetrics) }),
  };
  const selectedMetrics = webMetrics ?? nativeMetrics ?? emptyMetrics();
  const readiness = regressionReadiness(arms, warmupFramesFor(options));
  const warmupReset = regressionWarmupReset(arms, warmupFramesFor(options));
  const motion = regressionMotion(arms);
  const pixels = regressionPixels(arms);
  if (regression) {
    metrics.clockSamplesMs = selectedMetrics.clockSamplesMs;
    metrics.clockSource = selectedMetrics.clockSource;
    metrics.hitchCount = selectedMetrics.hitchCount;
    metrics.presentationClockSource = selectedMetrics.presentationClockSource;
    metrics.presentationSamplesMs = selectedMetrics.presentationSamplesMs;
    metrics.sampleCount = selectedMetrics.sampleCount;
    metrics.worstFrameMs = selectedMetrics.worstFrameMs;
    metrics.motion = motion;
    metrics.pixels = pixels;
    const resources = resourceMetrics(arms);
    if (resources !== undefined) {
      metrics.battery = resources.battery;
      metrics.thermal = resources.thermal;
    }
    if (selectedMetrics.phaseP95Ms !== undefined) metrics.phaseP95Ms = selectedMetrics.phaseP95Ms;
  }
  const artifactHashes = arms.map(({ artifactSha, bundleSha }) => `${artifactSha}:${bundleSha ?? artifactSha}`);
  const target = options.target;
  const identity = identityFor(options, web, native, artifactHashes, resolutionScaleSetting);
  const evidence = {
    artifact: {
      applicationClass: target === 'desktop-pair' ? 'platformer-desktop-pair' : arms[0]?.applicationClass ?? 'platformer-production',
      sha256: sha256(Buffer.from(artifactHashes.join(':'))),
      signed: context.physicalEvidence.physicalEvidenceClass === 'physical-hardware',
    },
    artifacts: [],
    budget: {
      // The scaffolded platformer is judged by the default steady-state budget. An existing project
      // is judged only by the bounds its own scenario authors: a known ~40 fps game must not fail
      // before A/B on a default it never claimed.
      ...(options.project === undefined ? {
        maxP99FrameMs: 33,
        maxStartupMs: target.includes('physical') ? 8_000 : 5_000,
        minMeanFps: target.includes('physical') ? 59.4 : 60,
      } : {}),
      ...(regression ? {
        minDurationSeconds: REGRESSION_COLLECTION_PROFILE.durationSeconds,
        minFrameSamples: REGRESSION_COLLECTION_PROFILE.minFrameSamples,
      } : {}),
      ...productionPerformanceBudget(performanceBounds),
    },
    command: profileCommand(options),
    codes: [...new Set(codes)],
    evidenceClasses: ['production'],
    execution: {
      // Which clock the arms ran on, published because the two are not the same measurement: on a
      // frozen clock every presented frame repeats a standing state, so its rate is not a frame rate.
      clock: options.liveClock === true ? 'wall-clock' : 'fixed-step',
      coldStarts: options.coldStarts,
      ...(options.control === undefined ? {} : { control: options.control }),
      deviceSelected: options.device !== undefined,
      ...(options.hostedSoftware ? { performanceEvaluation: 'advisory' } : {}),
      profile: options.profile,
      ...(regression ? { readiness } : {}),
      renderSize: `${options.renderSize.width}x${options.renderSize.height}`,
      repetitions: options.repetitions,
      ...(regression ? { warmupReset } : {}),
      warmupSeconds: options.warmup,
    },
    identity,
    markers: markersFor(arms, codes),
    metrics,
    physical: physicalEvidenceFor(options, context),
    rawArtifacts,
    runId,
    source: {
      dirty: context.sourceState.dirty,
      ...(context.sourceState.diffSha === undefined ? {} : { diffSha: context.sourceState.diffSha }),
      sha: context.sourceSha,
      ...(context.sourceState.rawStatus === undefined ? {} : { snapshot: { rawStatus: context.sourceState.rawStatus, normalizedTrackedFiles: context.sourceState.normalizedTrackedFiles } }),
    },
    target,
    timestamps: { endedAt: new Date().toISOString(), startedAt },
    version: PRODUCTION_EVIDENCE_VERSION,
  };
  if (options.audioEvidence !== undefined) {
    evidence.audioClaim = 'claimed';
    if (context.audioEvidence.audioEvidenceHash !== undefined) evidence.audioEvidenceSha256 = context.audioEvidence.audioEvidenceHash;
  } else {
    evidence.audioClaim = 'excluded-by-target-support-matrix';
  }
  if (target.includes('physical')) evidence.evidenceClasses = ['production', context.physicalEvidence.physicalEvidenceClass ?? 'missing-physical-evidence'];
  return evidence;
}

function allProfileRuns(arms) {
  return arms.flatMap(({ runs }) => runs);
}

function passedAssertion(report, prefix) {
  return report?.assertionResults?.some(({ id, pass }) => id.startsWith(prefix) && pass === true) === true;
}

function passedRuntimeReadyAssertion(report) {
  return report?.assertionResults?.some(({ details, id, pass }) =>
    pass === true
      && (id === 'diagnostics.runtimeReady' || (id === 'diagnostics' && details?.policy?.runtimeReady === true))
  ) === true;
}

function regressionReadiness(arms, warmupFrames) {
  const reports = allProfileRuns(arms).map(({ report }) => report).filter(Boolean);
  const ready = reports.length > 0 && reports.every(passedRuntimeReadyAssertion);
  return { ready, sampleReset: regressionWarmupReset(arms, warmupFrames) };
}

function regressionWarmupReset(arms, warmupFrames) {
  const runs = allProfileRuns(arms);
  return runs.length > 0 && runs.every(({ series }) => {
    if (!Array.isArray(series) || series.length === 0) return false;
    if (warmupFrames === 0) return true;
    const first = series[0];
    return Number.isFinite(first?.frameIndex) && first.frameIndex > warmupFrames;
  });
}

function regressionMotion(arms) {
  const runs = allProfileRuns(arms);
  const moved = runs.length > 0 && runs.every(({ report }) =>
    (typeof report?.distance === 'number' && report.distance > 0)
      || (Array.isArray(report?.movementDelta) && report.movementDelta.some((value) => typeof value === 'number' && Math.abs(value) > 0))
      || passedAssertion(report, 'movement.'));
  return { moved, movingObjects: moved ? 1 : 0 };
}

function regressionPixels(arms) {
  const runs = allProfileRuns(arms);
  const nonBlank = runs.length > 0 && runs.every(({ screenshot }) => screenshot !== undefined && isNonBlankFrame(screenshot));
  const changed = arms.length > 0 && arms.every(({ runs: armRuns, startups }) => {
    const startupScreenshot = startups.find(({ screenshot }) => screenshot !== undefined)?.screenshot;
    return startupScreenshot !== undefined
      && armRuns.some(({ screenshot }) => screenshot !== undefined && screenshotsDiffer(startupScreenshot, screenshot));
  });
  return { changed, nonBlank };
}

function resourceMetrics(arms) {
  const observations = allProfileRuns(arms)
    .map(({ report }) => report?.observations?.deviceMetrics)
    .filter(Boolean);
  if (observations.length === 0) return undefined;
  const complete = observations.every((observation) =>
    observation.available === true
      && Array.isArray(observation.samples)
      && observation.samples.length >= 2
      && Array.isArray(observation.errors)
      && observation.errors.length === 0,
  );
  const verdicts = observations
    .map((observation) => observation.verdict)
    .filter((verdict) => verdict !== undefined);
  return {
    battery: {
      complete,
      samples: observations.reduce((count, observation) => count + (observation.samples?.length ?? 0), 0),
    },
    thermal: {
      complete,
      samples: observations.reduce((count, observation) => count + (observation.samples?.length ?? 0), 0),
      thermallyConfounded: verdicts.some((verdict) => verdict.thermallyConfounded === true),
    },
  };
}

function screenshotsDiffer(left, right) {
  if (!Buffer.isBuffer(left) || !Buffer.isBuffer(right) || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return true;
  return false;
}

function productionPerformanceBudget(bounds) {
  if (bounds === undefined) return {};
  if (typeof bounds !== 'object' || bounds === null || Array.isArray(bounds)) {
    throw new ProductionEvidenceError('TN_PROD_PERFORMANCE_BUDGET_INVALID', 'The source performance bounds must be an object.');
  }
  const keys = ['maxDrawCalls', 'maxFrameMsP95', 'maxTriangles', 'minFps'];
  const unknown = Object.keys(bounds).filter((key) => !keys.includes(key));
  if (unknown.length > 0) {
    throw new ProductionEvidenceError('TN_PROD_PERFORMANCE_BUDGET_INVALID', `The source performance bounds contain unsupported keys: ${unknown.join(', ')}.`);
  }
  return Object.fromEntries(keys.flatMap((key) => {
    const value = bounds[key];
    if (value === undefined) return [];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new ProductionEvidenceError('TN_PROD_PERFORMANCE_BUDGET_INVALID', `The source performance bound '${key}' must be a finite non-negative number.`);
    }
    return [[key, value]];
  }));
}

export function isSuccessfulStartupSample(sample) {
  return sample?.status === 0
    && sample?.report?.pass === true
    && isNonBlankFrame(sample.screenshot)
    && Number.isFinite(sample.firstFrameMs)
    && sample.firstFrameMs >= 0;
}

export function postWarmupFrameSamples(samples, warmupFrames = 0) {
  if (!Array.isArray(samples)) return [];
  const boundary = Math.max(0, Math.floor(warmupFrames));
  if (boundary === 0) return samples;
  if (!samples.some((sample) => Number.isFinite(sample?.frameIndex))) return samples.slice(boundary);
  return samples.filter((sample) => Number.isFinite(sample?.frameIndex) && sample.frameIndex > boundary);
}

export function aggregateMetrics(runs, startups, warmupFrames = 0) {
  const intervals = [];
  const callbackIntervalsMs = [];
  const presentedIntervalsMs = [];
  const presentedStampsMs = [];
  const clockSamplesMs = [];
  const presentationSamplesMs = [];
  const runWindows = [];
  const phaseSamples = {};
  const startupSamplesMs = startups
    .filter(isSuccessfulStartupSample)
    .map(({ firstFrameMs }) => firstFrameMs);
  let timestampMs = 0;
  let sequence = 1;
  let callbackCount = 0;
  let presentedElapsedMs = 0;
  let missingClock = false;
  let missingPresentationClock = false;
  let unmeasurablePresentation = false;
  for (const run of runs) {
    let clockOrigin;
    let presentationOrigin;
    let lastPresentedMs;
    const postWarmupSamples = postWarmupFrameSamples(run.series ?? [], warmupFrames);
    let runDurationMs = 0;
    let runSampleCount = 0;
    for (const sample of postWarmupSamples) {
      if (typeof sample?.frameMs !== 'number') {
        callbackIntervalsMs.push(sample?.frameMs);
        continue;
      }
      callbackIntervalsMs.push(sample.frameMs);
      callbackCount += 1;
      if (Number.isFinite(sample.clockMs)) {
        clockOrigin ??= sample.clockMs;
        clockSamplesMs.push(timestampMs + sample.clockMs - clockOrigin);
      } else {
        missingClock = true;
      }
      if (Number.isFinite(sample.presentationMs)) {
        // The frame interval the budget is about is the gap between presented frames, and the rAF
        // timestamp is the frame. Both arms run three rAF callbacks per presented frame — the
        // engine loop, the UI hit-test pump and this instrumentation each register one — so a
        // `performance.now()` callback delta measures how the host spread its callbacks inside a
        // fixed display period: at its 95th percentile it is the idle remainder of that period, and
        // the arm that spends less per callback is the one that reads worse. The presented series
        // therefore advances only when the presentation stamp changes, and one frame's callbacks
        // collapse into the single interval they belong to. Every quantity the frame budget counts —
        // the per-second floor, the window's sample count, the worst frame and the hitch count —
        // counts this series, because a callback count reads three frames for every frame presented.
        if (lastPresentedMs !== undefined && sample.presentationMs !== lastPresentedMs) {
          const presentedDeltaMs = sample.presentationMs - lastPresentedMs;
          if (presentedDeltaMs > 0) {
            presentedIntervalsMs.push(presentedDeltaMs);
            runSampleCount += 1;
            runDurationMs += presentedDeltaMs;
            presentedElapsedMs += presentedDeltaMs;
            presentedStampsMs.push(presentedElapsedMs);
          } else {
            unmeasurablePresentation = true;
          }
        }
        lastPresentedMs = sample.presentationMs;
        presentationOrigin ??= sample.presentationMs;
        presentationSamplesMs.push(timestampMs + sample.presentationMs - presentationOrigin);
      } else {
        missingPresentationClock = true;
        unmeasurablePresentation = true;
      }
      if (sample.phases !== undefined && typeof sample.phases === 'object' && sample.phases !== null) {
        for (const [phase, value] of Object.entries(sample.phases)) {
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
          const samples = phaseSamples[phase] ?? [];
          phaseSamples[phase] = samples;
          samples.push(value);
        }
      }
      intervals.push({
        ...(typeof sample.drawCalls === 'number' ? { drawCalls: sample.drawCalls } : {}),
        frameMs: sample.frameMs,
        ...(Number.isFinite(sample.clockMs) ? { clockMs: sample.clockMs } : {}),
        ...(Number.isFinite(sample.presentationMs) ? { presentationMs: sample.presentationMs } : {}),
        ...(sample.phases === undefined ? {} : { phases: sample.phases }),
        sequence: sequence++,
        timestampMs,
        ...(typeof sample.triangles === 'number' ? { triangles: sample.triangles } : {}),
      });
      timestampMs += sample.frameMs;
    }
    runWindows.push({ durationSeconds: runDurationMs / 1_000, sampleCount: runSampleCount });
  }
  // A sample the presentation clock could not place has no place in a cadence series, and a partial
  // one would publish a percentile of the frames that happened to survive. The series stays
  // unmeasured, which fails the timing budget and blocks a pair rather than judging a subset. The
  // windows go with it: a count of presented frames and a duration measured from the same voided
  // series are the same partial subset under two names.
  if (unmeasurablePresentation) presentedIntervalsMs.length = 0;
  const phaseP95ByName = Object.fromEntries(
    Object.entries(phaseSamples).map(([phase, samples]) => [phase, nearestRank(samples, 0.95)]),
  );
  const presentedFrames = presentedIntervalsMs.length;
  const presentedHitchCount = presentedIntervalsMs.filter((value) => value > 33.3).length;
  return {
    ...(clockSamplesMs.length === 0 ? {} : { clockSamplesMs }),
    ...(callbackCount === 0 ? {} : { clockSource: missingClock ? 'missing' : 'monotonic-performance' }),
    ...(presentedFrames === 0 ? {} : { frameIntervalsMs: presentedIntervalsMs }),
    ...(intervals.length === 0 ? {} : { intervals }),
    ...(Object.keys(phaseP95ByName).length === 0 ? {} : {
      phaseP95ByName,
      ...(phaseP95ByName.render === undefined ? {} : { phaseP95Ms: phaseP95ByName.render }),
    }),
    ...(presentationSamplesMs.length === 0 ? {} : { presentationSamplesMs }),
    ...(runWindows.length === 0 || unmeasurablePresentation ? {} : { runWindows }),
    ...(callbackCount === 0 ? {} : { presentationClockSource: missingPresentationClock ? 'missing' : 'raf-presentation' }),
    ...(startupSamplesMs.length === 0 ? {} : { startupSamplesMs, startupMs: startupSamplesMs[0] }),
    ...(timestampMs === 0 ? {} : { durationSeconds: timestampMs / 1_000 }),
    ...(startupSamplesMs.length === 0 ? {} : { startupP95Ms: nearestRank(startupSamplesMs, 0.95) }),
    // The presented-frame quantities publish together or not at all: a sample count beside a
    // percentile of a different series is how a 3x callback count reads as a collected window.
    ...(presentedFrames === 0 ? {} : {
      hitchCount: presentedHitchCount,
      oneSecondFps: oneSecondFrameFloors(presentedStampsMs),
      sampleCount: presentedFrames,
      worstFrameMs: Math.max(...presentedIntervalsMs),
    }),
    ...(presentedFrames === 0 ? {} : {
      meanFps: meanFps(presentedIntervalsMs),
      p50FrameMs: nearestRank(presentedIntervalsMs, 0.5),
      p95FrameMs: nearestRank(presentedIntervalsMs, 0.95),
      p99FrameMs: nearestRank(presentedIntervalsMs, 0.99),
    }),
    ...(unmeasurableIntervalCount(callbackIntervalsMs) === 0
      ? {}
      : { unmeasurableCallbackIntervals: unmeasurableIntervalCount(callbackIntervalsMs) }),
    ...(intervals.some(({ drawCalls }) => drawCalls !== undefined) ? { drawCalls: Math.max(...intervals.flatMap(({ drawCalls }) => drawCalls === undefined ? [] : [drawCalls])) } : {}),
    ...(intervals.some(({ triangles }) => triangles !== undefined) ? { triangles: Math.max(...intervals.flatMap(({ triangles }) => triangles === undefined ? [] : [triangles])) } : {}),
  };
}

function emptyMetrics() {
  return { frameIntervalsMs: [], intervals: [], startupSamplesMs: [] };
}

function pairMetrics(metrics) {
  return {
    meanFps: metrics.meanFps,
    p50FrameMs: nearestRank(metrics.frameIntervalsMs, 0.5),
    p95FrameMs: nearestRank(metrics.frameIntervalsMs, 0.95),
    p99FrameMs: metrics.p99FrameMs ?? nearestRank(metrics.frameIntervalsMs, 0.99),
  };
}

/**
 * The display a web frame rate was read from.
 *
 * `observations.hardwareIdentity` was the key this used to read and no producer has ever written it,
 * so every web artifact published an identity with no GPU in it. `webDisplay` is published from the
 * decision the runner itself made, and it is the field that separates this host's two web
 * collections: 33.97 fps on the private display, 163.45 fps on the session display.
 *
 * The playtest report retains its observed WebGPU adapter in the pipeline census. Repeated
 * workload runs must agree before one adapter can identify the whole rate sample.
 */
export function webRateIdentity(web) {
  const display = web?.display;
  const adapters = web?.runs?.map((run) => run?.report?.observations?.pipelineCensus?.adapter?.identity);
  const adapter = adapters?.length > 0 && adapters.every((identity) => typeof identity === 'string' && identity !== 'unavailable' && identity === adapters[0])
    ? adapters[0]
    : undefined;
  return {
    ...(display === undefined ? {} : { webDisplay: display.kind === 'existing' ? `session:${display.display}` : display.kind }),
    ...(adapter === undefined ? {} : { webAdapter: adapter }),
  };
}

function identityFor(options, web, native, artifactHashes, resolutionScaleSetting) {
  const common = {
    // Only observed hardware data may certify a promoted comparison. Missing fields remain absent.
    ...webRateIdentity(web),
    workloadHash: web?.workloadHash ?? native?.workloadHash,
    renderHeight: options.renderSize.height,
    renderWidth: options.renderSize.width,
    ...(resolutionScaleSetting === undefined ? {} : { resolutionScaleSetting }),
  };
  if (options.target === 'desktop-pair') {
    return {
      ...common,
      nativeArtifactSha256: native?.artifactSha,
      nativeProcess: native?.driverClass,
      webArtifactSha256: web?.artifactSha,
      webProcess: web?.driverClass,
    };
  }
  return {
    ...common,
    artifactSha256: artifactHashes[0],
    ...(native === undefined ? {} : { nativeBinarySha256: native.artifactSha }),
    executableClass: web?.driverClass ?? native?.driverClass,
  };
}

function steadyLaunchesAt(options, coldStart) {
  return options.profile === REGRESSION_PROFILE ? (coldStart === options.coldStarts - 1 ? 1 : 0) : options.repetitions;
}

export function collectionLaunchPlan(options) {
  return Array.from({ length: options.coldStarts }, (_, index) => ['startup', ...Array(steadyLaunchesAt(options, index)).fill('steady')]).flat();
}

export async function prepareNativeWorkload(project, target, options, execute = runCommand) {
  if (options.prebuiltArtifact !== undefined && target !== 'desktop') {
    const receipt = await readPrebuiltWorkload(options.prebuiltArtifact, target, options);
    return { status: 0, workloadHash: receipt.workloadHash, bundleSha: receipt.bundleSha256 };
  }
  // build:desktop compiles assets, the instrumented entry and UI, then packages the existing host.
  // THREENATIVE_RUNTIME_BINARY prevents a second native compile without omitting the game bundle.
  return execute('pnpm', ['run', `build:${target}`], project, {
    ...process.env,
    ...(options.prebuiltArtifact === undefined ? {} : { THREENATIVE_RUNTIME_BINARY: resolve(options.prebuiltArtifact) }),
  });
}

export async function readPrebuiltWorkload(artifact, target, options) {
  try {
    const receipt = JSON.parse(await readFile(`${artifact}.production.json`, 'utf8'));
    if (receipt.target !== target || receipt.workload !== 'platformer-production' || receipt.instrumentationRevision !== 'productionEvidenceV1'
      || receipt.sourceSha !== options.sourceSha || !receipt.appId || !receipt.workloadHash
      || receipt.artifactSha256 !== await hashPath(artifact)) throw new Error('receipt identity mismatch');
    const bundle = target === 'ios'
      ? await readFile(join(artifact, 'native-smoke.js'))
      : (await execFileAsync('unzip', ['-p', artifact, 'assets/scripts/main.js'], { encoding: 'buffer' })).stdout;
    const appId = target === 'ios'
      ? (await execFileAsync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(artifact, 'Info.plist')])).stdout.trim()
      : (await execFileAsync('aapt', ['dump', 'badging', artifact])).stdout.match(/package: name='([^']+)'/u)?.[1];
    if (appId !== receipt.appId || sha256(bundle) !== receipt.bundleSha256 || !bundle.includes('TN_PROD_FRAME_SAMPLES:')) throw new Error('packaged workload mismatch');
    return receipt;
  } catch (error) {
    throw new ProductionEvidenceError('TN_PROD_PREBUILT_WORKLOAD', `Prebuilt ${target} requires a matching instrumented platformer receipt and packaged application identity: ${error.message}`);
  }
}

function markersFor(arms, codes) {
  const allRuns = arms.flatMap(({ runs }) => runs);
  const allStartups = arms.flatMap(({ startups }) => startups);
  const workloadSamplesComplete = allRuns.length > 0 && allRuns.every(({ series }) => Array.isArray(series) && series.length > 0);
  const startupSamplesComplete = allStartups.length > 0 && allStartups.every(isSuccessfulStartupSample);
  const clean = allRuns.length > 0 && allRuns.every(({ status, report }) => status === 0 && report?.pass === true);
  return [
    'run-start',
    ...(workloadSamplesComplete && !codes.includes('TN_PROD_RENDER_SAMPLES_INCOMPLETE') ? ['first-workload-frame'] : []),
    ...(startupSamplesComplete && clean ? ['clean-end'] : []),
  ];
}

function physicalEvidenceFor(options, context) {
  if (!options.target.includes('physical')) return undefined;
  return {
    evidenceSha256: context.physicalEvidence.physicalEvidenceHash,
    modelClass: context.physicalEvidence.physicalEvidenceClass ?? 'missing-physical-evidence',
    provenance: context.physicalEvidence.physicalEvidenceClass ?? 'missing',
  };
}

function profileCommand(options) {
  return [
    'pnpm profile:production --',
    `--target ${options.target}`,
    `--render-size ${options.renderSize.width}x${options.renderSize.height}`,
    `--cold-starts ${options.coldStarts}`,
    `--warmup ${options.warmup}`,
    `--repetitions ${options.repetitions}`,
    ...(options.device === undefined ? [] : ['--device <selected>']),
    ...(options.hostedSoftware ? ['--hosted-software'] : []),
    ...(options.liveClock === true ? ['--live-clock'] : []),
    ...(options.prebuiltArtifact === undefined ? [] : ['--prebuilt-artifact <existing-build>']),
    ...(options.project === undefined ? [] : ['--project <existing-project>']),
    ...(options.scenario === undefined ? [] : ['--scenario <production-scenario>']),
  ].join(' ');
}

async function createFixtureControlEvidence(options, context, runId) {
  const intervals = await collectFixtureFrameSeries(options.control);
  const startups = [];
  for (let index = 0; index < options.coldStarts; index += 1) startups.push(await collectFixtureStartup(options.control));
  const run = { report: { pass: true }, screenshot: fixtureFrame(), series: intervals, status: 0 };
  const metrics = {
    ...aggregateMetrics([run], startups),
    durationSeconds: options.duration,
    memory: { complete: true, growthBytes: 0, highWaterBytes: 1, first15MedianBytes: 1, last15MedianBytes: 1, slopeBytesPerMinute: 0 },
    thermal: { complete: true, samples: 1 },
  };
  return {
    artifact: { applicationClass: 'fixture-negative-control', sha256: sha256(Buffer.from('fixture-negative-control')), signed: false },
    artifacts: [],
    budget: { maxP99FrameMs: 33, maxStartupMs: 5_000, minMeanFps: 60 },
    command: profileCommand(options),
    evidenceClasses: ['negative-control'],
    execution: {
      coldStarts: options.coldStarts,
      deviceSelected: false,
      fixtureControl: true,
      renderSize: `${options.renderSize.width}x${options.renderSize.height}`,
      repetitions: options.repetitions,
      warmupSeconds: options.warmup,
    },
    identity: { driverClass: 'fixture-control', hostClass: 'fixture-control', osClass: 'fixture-control' },
    markers: markersFor([{ runs: [run], startups }], []),
    metrics,
    rawArtifacts: [
      { content: fixtureFrame(), label: 'fixture-first-frame' },
      { content: JSON.stringify({ control: options.control, metrics }), label: 'explicit-negative-control' },
    ],
    runId,
    source: { dirty: context.sourceState.dirty, ...(context.sourceState.diffSha === undefined ? {} : { diffSha: context.sourceState.diffSha }), sha: context.sourceSha },
    target: 'fixture',
    timestamps: { endedAt: new Date().toISOString(), startedAt: new Date().toISOString() },
    version: PRODUCTION_EVIDENCE_VERSION,
  };
}

async function collectFixtureFrameSeries(control) {
  // The real producers stamp every sample with the rAF presentation timestamp, so the fixture that
  // stands in for them carries one too: the judge reads presented cadence, and a fixture without
  // presentation identity would now be (correctly) unmeasured rather than a passing control.
  const intervals = Array.from({ length: 120 }, (_, index) => ({
    frameMs: 16.5,
    presentationMs: index * 16.5,
    sequence: index + 1,
    timestampMs: index * 16.5,
  }));
  if (control !== 'slow-path') return intervals;
  for (const index of [intervals.length - 2, intervals.length - 1]) {
    const startedAt = performance.now();
    await new Promise((resolve) => setTimeout(resolve, SLOW_FRAME_DELAY_MS));
    const slowFrameMs = Math.max(SLOW_FRAME_DELAY_MS, performance.now() - startedAt);
    intervals[index].frameMs = slowFrameMs;
    intervals[index].presentationMs = intervals[index - 1].presentationMs + slowFrameMs;
    intervals[index].timestampMs = intervals[index - 1].timestampMs + intervals[index - 1].frameMs;
  }
  return intervals;
}

async function collectFixtureStartup(control) {
  const delayMs = control === 'slow-startup' ? SLOW_STARTUP_DELAY_MS : 120;
  const marker = 'TN_PROD_FIRST_NONBLANK_FRAME';
  const startedAt = performance.now();
  let firstFrameAt;
  let output = '';
  const child = spawn(process.execPath, ['-e', `setTimeout(() => process.stdout.write(${JSON.stringify(`${marker}\n`)}), ${delayMs})`], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  child.stdout?.on('data', (chunk) => {
    output += chunk.toString();
    if (firstFrameAt === undefined && output.includes(marker)) firstFrameAt = performance.now();
  });
  const status = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(2);
    }, delayMs + 2_000);
    child.once('error', () => {
      clearTimeout(timer);
      resolve(2);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? 2);
    });
  });
  const firstFrameMs = firstFrameAt === undefined ? undefined : firstFrameAt - startedAt;
  const report = status === 0 && output.includes(marker) ? { pass: true } : undefined;
  return {
    firstFrameMs,
    report,
    screenshot: report === undefined ? undefined : fixtureFrame(),
    status,
  };
}

function fixtureFrame() {
  const png = new PNG({ height: 2, width: 2 });
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = index === 0 ? 255 : 32;
    png.data[index + 1] = index === 0 ? 255 : 64;
    png.data[index + 2] = index === 0 ? 255 : 96;
    png.data[index + 3] = 255;
  }
  return PNG.sync.write(png);
}

function applyNegativeControl(input, control) {
  if (control === undefined) return input;
  const evidence = {
    ...input,
    codes: [...(input.codes ?? [])],
    evidenceClasses: [...new Set([...(input.evidenceClasses ?? []), 'negative-control'])],
    execution: { ...input.execution, control },
    control,
  };
  if (control === 'missing-marker') evidence.markers = evidence.markers.filter((marker) => marker !== 'first-workload-frame');
  if (control === 'early-exit') evidence.markers = evidence.markers.filter((marker) => marker !== 'clean-end');
  if (control === 'stale-source-sha') evidence.source = { ...evidence.source, sha: 'e38439c' };
  if (control === 'dirty-checkout') {
    evidence.source = { ...evidence.source, dirty: true };
    delete evidence.source.diffSha;
  }
  if (control === 'memory-growth') {
    evidence.metrics = {
      ...evidence.metrics,
      memory: { first15MedianBytes: 100, last15MedianBytes: 200, growthBytes: 128, slopeBytesPerMinute: 512 * 1024 },
    };
  }
  if (control === 'substitute-emulator-provenance') {
    evidence.physical = { ...(evidence.physical ?? {}), provenance: 'android-emulator' };
  }
  if (control === 'claimed-audio-missing-evidence') {
    evidence.audioClaim = 'claimed';
    delete evidence.audioEvidenceSha256;
  }
  if (control === 'disallowed-identifiers') evidence.identity = { ...evidence.identity, serial: 'negative-control' };
  return evidence;
}

export async function currentSourceState(root = commandRoot, execute = execFileAsync) {
  try {
    // Git can report an LF rewrite of a CRLF checkout as modified even though its
    // normalized candidate blob is identical. Preserve that raw status and prove
    // each byte identity explicitly; an empty diff alone never grants cleanliness.
    const git = async (...args) => (await execute('git', ['--literal-pathspecs', ...args], { cwd: root })).stdout;
    const sha = (await git('rev-parse', 'HEAD')).trim();
    const rawStatus = await git('status', '--porcelain=v1', '-z', '--untracked-files=all');
    const diff = await git('diff', '--no-ext-diff', '--no-textconv', 'HEAD');
    let dirty = rawStatus.length > 0;
    const normalizedTrackedFiles = [];
    const entries = rawStatus.split('\0').filter(Boolean);
    if (dirty && diff === '' && entries.every((entry) => entry.startsWith(' M '))) {
      for (const entry of entries) {
        const name = entry.slice(3);
        const file = join(root, name);
        if (!(await lstat(file)).isFile()) break;
        const head = /^(100644|100755) blob ([a-f0-9]{40,64})\t/u.exec(await git('ls-tree', '-z', 'HEAD', '--', name));
        const index = /^(100644|100755) ([a-f0-9]{40,64}) 0\t/u.exec(await git('ls-files', '--stage', '-z', '--', name));
        if (!head || !index || head[1] !== index[1] || head[2] !== index[2]) break;
        const raw = await readFile(file);
        const before = sha256(raw);
        const { stdout: headBytes } = await execute('git', ['cat-file', 'blob', head[2]], { cwd: root, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
        // Restrict the accepted transformation to line endings. Git clean filters
        // or working-tree encodings must never conceal executable byte changes.
        const lfBytes = Buffer.from(raw.toString('latin1').replace(/\r\n/gu, '\n'), 'latin1');
        if (!Buffer.isBuffer(headBytes) || !lfBytes.equals(headBytes)) break;
        const worktreeBlob = (await git('hash-object', `--path=${name}`, '--', name)).trim();
        if (worktreeBlob !== head[2] || sha256(await readFile(file)) !== before) break;
        normalizedTrackedFiles.push({ path: name, headBlob: head[2], worktreeBlob, rawSha256: before, normalization: 'crlf-to-lf-only' });
      }
      dirty = normalizedTrackedFiles.length !== entries.length;
    }
    // A changing tree or HEAD is never a coherent candidate snapshot.
    if ((await git('rev-parse', 'HEAD')).trim() !== sha ||
        (await git('status', '--porcelain=v1', '-z', '--untracked-files=all')) !== rawStatus) dirty = true;
    if (!dirty && normalizedTrackedFiles.length) {
      for (const proof of normalizedTrackedFiles) {
        const file = join(root, proof.path);
        if (!(await lstat(file)).isFile() || sha256(await readFile(file)) !== proof.rawSha256) dirty = true;
      }
      if ((await git('diff', '--no-ext-diff', '--no-textconv', 'HEAD')) !== '') dirty = true;
      if ((await git('rev-parse', 'HEAD')).trim() !== sha ||
          (await git('status', '--porcelain=v1', '-z', '--untracked-files=all')) !== rawStatus) dirty = true;
    }
    return { dirty, ...(dirty ? { diffSha: sha256(Buffer.from(diff)) } : {}), sha, rawStatus, normalizedTrackedFiles };
  } catch {
    return { dirty: true, diffSha: sha256(Buffer.from('source-state-unavailable')), sha: '0000000' };
  }
}

async function readPhysicalEvidence(path) {
  if (path === undefined) return {};
  try {
    const content = await readFile(path);
    const text = content.toString('utf8').toLowerCase();
    return {
      physicalEvidenceClass: /emulator|simulator/u.test(text) ? 'android-emulator' : 'physical-hardware',
      physicalEvidenceHash: sha256(content),
    };
  } catch {
    return { physicalEvidenceClass: 'missing', physicalEvidenceHash: undefined };
  }
}

async function readOptionalArtifact(path) {
  if (path === undefined) return {};
  try {
    return { audioEvidenceHash: sha256(await readFile(path)) };
  } catch {
    return {};
  }
}

export async function nativeArtifactPath(project, target) {
  const directory = join(project, 'dist-native');
  const entries = (await readdir(directory, { withFileTypes: true }))
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name));
  const candidate = target === 'ios'
    ? entries.find((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
    : target === 'android'
      ? entries.find((entry) => entry.isFile() && entry.name.endsWith('.apk'))
      : await desktopExecutableEntry(directory, entries);
  if (candidate === undefined) throw new ProductionEvidenceError('TN_PROD_NATIVE_ARTIFACT_MISSING', `The scaffolded ${target} build produced no native artifact.`);
  return join(directory, candidate.name);
}

// A desktop build stages the `ui/` web bundle beside the executable, so the artifact is the one
// regular file the host can run - never the first directory that happens to sort first.
async function desktopExecutableEntry(directory, entries) {
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (process.platform === 'win32') {
      if (entry.name.endsWith('.exe')) return entry;
      continue;
    }
    if (((await stat(join(directory, entry.name))).mode & 0o111) !== 0) return entry;
  }
  return undefined;
}

async function playtestRunnerPath(project, tools) {
  const candidates = [
    tools.playtestRunner,
    join(project, 'node_modules/@threenative/playtest/dist/runner/index.js'),
  ].filter(Boolean);
  for (const candidate of candidates) if (await fileExists(candidate)) return candidate;
  return undefined;
}

async function installAndroidArtifact(apk, device) {
  // The Play Protect verifier dialog is modal and swallows the install, so an unattended
  // lane behind it proves nothing. Suppress before the install, as every install lane must.
  const serial = device ?? String(execFileSync('adb', ['get-serialno'], { encoding: 'utf8' })).trim();
  suppressPlayProtectOnAdbInstalls(serial, {
    adb: (adbArgs) => String(execFileSync('adb', ['-s', serial, ...adbArgs], { encoding: 'utf8' })),
  });
  const args = [...(device === undefined ? [] : ['-s', device]), 'install', '-r', apk];
  const result = await runCommand('adb', args, commandRoot);
  if (result.status !== 0) throw new ProductionEvidenceError('TN_PROD_ANDROID_INSTALL_FAILED', `Installing the scaffolded Android platformer failed.${failureSuffix(result)}`);
}

async function hashPath(path) {
  const details = await stat(path).catch(() => undefined);
  if (details === undefined) throw new ProductionEvidenceError('TN_PROD_ARTIFACT_MISSING', `Production artifact '${basename(path)}' is missing.`);
  if (details.isFile()) return sha256(await readFile(path));
  const files = await listFiles(path);
  const hashInput = [];
  for (const file of files) hashInput.push(`${relative(path, file)}\0${sha256(await readFile(file))}`);
  return sha256(Buffer.from(hashInput.join('\n')));
}

async function workloadHashFor(project, sourceHash) {
  if (!sourceHash) throw new ProductionEvidenceError('TN_PROD_WORKLOAD_IDENTITY', 'The workload source tree was not hashed before instrumentation.');
  return sha256(Buffer.from(`${sourceHash}:${await hashPath(join(project, 'public'))}`));
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

async function nonBlankPng(path) {
  try {
    return isNonBlankFrame(await readFile(path));
  } catch {
    return false;
  }
}

function isNonBlankFrame(value) {
  if (!Buffer.isBuffer(value)) return false;
  try {
    const png = PNG.sync.read(value);
    const colors = new Set();
    let opaque = 0;
    for (let index = 0; index < png.data.length; index += 4) {
      if (png.data[index + 3] !== 0) opaque += 1;
      colors.add(`${png.data[index]},${png.data[index + 1]},${png.data[index + 2]},${png.data[index + 3]}`);
    }
    return opaque > 0 && colors.size > 1;
  } catch {
    return false;
  }
}

async function browserCommand(args) {
  return privateDisplayCommand(process.execPath, args);
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (address === null || typeof address === 'string') throw new ProductionEvidenceError('TN_PROD_PORT_UNAVAILABLE', 'Could not allocate a local playtest port.');
  return address.port;
}

export async function runCommand(command, args, cwd, env = undefined, timeout = 120_000) {
  const started = performance.now();
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      encoding: 'utf8',
      env: env ?? process.env,
      maxBuffer: 32 * 1024 * 1024,
      timeout,
    });
    return { durationMs: performance.now() - started, status: 0, stderr: result.stderr, stdout: result.stdout, timeout, timedOut: false };
  } catch (error) {
    return {
      durationMs: performance.now() - started,
      status: typeof error?.code === 'number' ? error.code : 2,
      stderr: error?.stderr ?? '',
      stdout: error?.stdout ?? '',
      timeout,
      timedOut: error?.killed === true,
    };
  }
}

export function failureSuffix(result) {
  if (result.timedOut === true) return `: timed out after ${Math.round(result.timeout / 1_000)} s`;
  const lines = [result.stderr, result.stdout]
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .join('\n')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .slice(-20);
  return lines.length === 0 ? '' : `\n${lines.join('\n')}`;
}

async function removeMailbox(root) {
  await Promise.all([
    rm(join(root, 'tn-playtest-request.json'), { force: true }),
    rm(join(root, 'tn-playtest-response.json'), { force: true }),
    rm(join(root, 'tn-playtest-screenshot-request.txt'), { force: true }),
  ]);
}

async function fileExists(path) {
  return await stat(path).then(() => true).catch(() => false);
}

function parseRenderSize(value) {
  const match = /^(\d+)x(\d+)$/u.exec(value);
  if (match === null) throw new ProductionEvidenceError('TN_PROD_RENDER_SIZE_INVALID', `--render-size must use WIDTHxHEIGHT, received '${value}'.`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new ProductionEvidenceError('TN_PROD_RENDER_SIZE_INVALID', `--render-size must contain positive dimensions, received '${value}'.`);
  }
  return { height, width };
}

function nextValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) throw new ProductionEvidenceError('TN_PROD_CLI_USAGE', `${flag} requires a value.`);
  return value;
}

function positiveNumber(value, flag) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new ProductionEvidenceError('TN_PROD_CLI_USAGE', `${flag} requires a positive number.`);
  return parsed;
}

function positiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new ProductionEvidenceError('TN_PROD_CLI_USAGE', `${flag} requires a positive integer.`);
  return parsed;
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).pathname === new URL(import.meta.url).pathname) {
  // Gate records are an engine-repository artefact, not something a published install owns. A
  // package-relative specifier here would ship inside the tarball and die ERR_MODULE_NOT_FOUND on
  // an installed copy, so the path is resolved against the checkout and its absence is named.
  const gateRecords = resolve(scriptDirectory, '../../../scripts/gate-records.mjs');
  if (!existsSync(gateRecords)) {
    throw new ProductionEvidenceError(
      'TN_PROD_GATE_RECORDS_MISSING',
      `pnpm profile:production records its gate phases through ${gateRecords}, which does not exist. This command runs from a ThreeNative engine checkout, not from an installed @threenative/runtime-native.`,
    );
  }
  const { createGateRecorder } = await import(pathToFileURL(gateRecords).href);
  const gateRecorder = await createGateRecorder({
    phase: 'profile-production',
    command: ['pnpm profile:production', ...process.argv.slice(2)].join(' '),
  });
  try {
    const result = await runProductionProfile(parseProductionArgs());
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.exitCode ?? 0;
  } catch (error) {
    const code = error instanceof ProductionEvidenceError ? error.code : 'TN_PROD_EVIDENCE_INVALID';
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ codes: [code], message, status: 'BLOCKED', exitCode: 2 }, null, 2)}\n`);
    process.exitCode = 2;
  } finally {
    // main() communicates its own result through process.exitCode; record what actually ran.
    await gateRecorder.finish(process.exitCode ?? 0);
  }
}
