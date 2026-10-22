/** Hosted software regression contract only; never hardware qualification or a visual verdict. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { IStandalonePlaytestReport } from "../packages/playtest/src/runner/shared.js";

export const BASELINE_SHA = "88b988cd70d5db7266eb0281e5f74bd0e030b3e7";
const ORDER = ["before", "after", "after", "before", "before", "after"] as const;
const late = ["publishedBatchesInView", "shadowInvalidated", "impostorPendingPeak"].map(
  (key) => `component.props.reveal.${key}`,
);
type StartupReport = Pick<
  IStandalonePlaytestReport,
  "pass" | "capture" | "diagnostics" | "observations" | "assertionResults"
>;
interface IStartupRun {
  arm: "before" | "after";
  status: number | null;
  report: StartupReport;
}
interface IRuntimePackageIdentity {
  name: string;
  version: string;
}
interface IStartupBuildIdentity {
  gamePackage: Record<string, unknown>;
  bundledPackages: readonly IRuntimePackageIdentity[];
  compilerPackages: readonly string[];
  vitePatchSha256: string;
  workspaceLockSha256?: string;
}
interface IPnpmPackageNode {
  from: string;
  version: string;
  path: string;
  dependencies?: Record<string, IPnpmPackageNode>;
}

export function verifyStartupRuns(runs: readonly IStartupRun[]) {
  assert.deepEqual(
    runs.map(({ arm }) => arm),
    ORDER,
    "require three alternating pairs",
  );
  const times: { before: number[]; after: number[] } = { before: [], after: [] };
  let adapter: unknown;
  for (const { arm, status, report } of runs) {
    assert(status === 0 || (arm === "before" && status === 1), "subprocess failure");
    assert(
      Array.isArray(report.diagnostics) && report.diagnostics.length === 0,
      "diagnostics must be empty",
    );
    assert(Array.isArray(report.observations?.console), "console observations missing");
    assert(
      report.observations.console.every(
        (entry) =>
          entry.type !== "error" &&
          entry.source !== "page-error" &&
          entry.source !== "unhandled-rejection",
      ),
      "console diagnostics",
    );
    assert(
      typeof report.capture?.adapter?.vendor === "string" &&
        report.capture.adapter.vendor.trim() &&
        typeof report.capture.adapter.architecture === "string" &&
        report.capture.adapter.architecture.trim(),
      "adapter identity missing",
    );
    assert.equal(report.capture.rendererKind, "webgpu");
    assert.deepEqual(report.capture.viewport, { width: 1280, height: 720 });
    adapter ??= report.capture.adapter;
    assert.deepEqual(report.capture.adapter, adapter, "adapter changed between runs");
    assert(
      Array.isArray(report.assertionResults) && report.assertionResults.length > 0,
      "assertions missing",
    );
    const assertions = new Map(report.assertionResults.map((a) => [a.id, a]));
    assert.equal(assertions.size, report.assertionResults.length, "duplicate assertions");
    const value = (id: string): unknown => {
      const assertion = assertions.get(id);
      assert(assertion?.pass === true, `missing or failed ${id}`);
      return (assertion.details as { after?: unknown })?.after;
    };
    const positive = (id: string, minimum: number) => {
      const result = value(id);
      assert(
        typeof result === "number" && Number.isFinite(result) && result >= minimum,
        `invalid ${id}`,
      );
      return result;
    };
    value("diagnostics");
    assert.equal(value("component.props.reveal.complete"), true);
    const samples = positive("component.props.reveal.samples", 2);
    assert(Number.isInteger(samples), "malformed samples");
    positive("component.props.reveal.elapsedMs", 3000);
    times[arm].push(positive("resource.GameState.timeToReadyMs", Number.MIN_VALUE));
    for (const id of late) {
      const counter = assertions.get(id);
      const observed = (counter?.details as { after?: unknown })?.after;
      assert(
        typeof observed === "number" && Number.isFinite(observed) && observed >= 0,
        `missing or malformed ${id}`,
      );
      if (arm === "after") {
        assert.equal(counter?.pass, true, id);
        assert.equal(observed, 0, id);
      }
    }
    assert(
      report.assertionResults.every(
        (a) => a.pass === true || (arm === "before" && late.includes(a.id)),
      ),
      "unexpected assertion failure",
    );
    assert.equal(
      report.pass,
      report.assertionResults.every((a) => a.pass === true),
    );
    assert.equal(status, report.pass ? 0 : 1, "subprocess/report disagreement");
  }
  const median = (values: number[]) => {
    const value = values.sort((a, b) => a - b)[1];
    assert(value !== undefined, "median requires three observations");
    return value;
  };
  const before = median(times.before);
  const after = median(times.after);
  const ratio = after / before;
  assert(
    Number.isFinite(ratio) && after <= before * 1.25,
    `startup median ${after}/${before} = ${ratio} exceeds 1.25`,
  );
  return {
    before,
    after,
    ratio,
    times,
    adapter,
    qualification: "software regression contract; no hardware or visual qualification",
  };
}

export function parseStartupReport(log: string): StartupReport {
  for (const match of log.matchAll(/^\{/gm)) {
    try {
      const parsed = JSON.parse(log.slice(match.index));
      if (parsed.assertionResults) return parsed;
    } catch {
      /* Display/lock JSON precedes the final runner report. */
    }
  }
  throw new Error("missing or malformed startup report");
}

export function verifyStartupPackageIdentity(
  baseline: Record<string, unknown>,
  candidate: Record<string, unknown>,
) {
  for (const field of [
    "name",
    "version",
    "private",
    "type",
    "engines",
    "packageManager",
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ])
    assert.deepEqual(candidate[field], baseline[field], `incompatible package identity: ${field}`);
}

function normalizeBundledPackages(packages: readonly IRuntimePackageIdentity[]) {
  assert(
    Array.isArray(packages) && packages.length > 0,
    "missing emitted third-party package metadata",
  );
  return [
    ...new Map(
      packages.map(({ name, version }) => {
        assert(typeof name === "string" && name.trim(), "emitted package name metadata missing");
        assert(
          typeof version === "string" && version.trim(),
          `emitted package version metadata missing: ${name}`,
        );
        return [`${name}@${version}`, { name, version }] as const;
      }),
    ).values(),
  ].sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
  );
}

function normalizeCompilerPackages(packages: readonly string[]) {
  assert(Array.isArray(packages) && packages.length > 0, "missing Vite compiler package metadata");
  return [
    ...new Set(
      packages.map((item) => {
        assert(typeof item === "string" && item.trim(), "Vite compiler package metadata missing");
        return item;
      }),
    ),
  ].sort();
}

export function verifyStartupBuildIdentity(
  baseline: IStartupBuildIdentity,
  candidate: IStartupBuildIdentity,
) {
  verifyStartupPackageIdentity(baseline.gamePackage, candidate.gamePackage);
  assert.deepEqual(
    normalizeBundledPackages(candidate.bundledPackages),
    normalizeBundledPackages(baseline.bundledPackages),
    "bundled third-party package identity differs",
  );
  assert.deepEqual(
    normalizeCompilerPackages(candidate.compilerPackages),
    normalizeCompilerPackages(baseline.compilerPackages),
    "Vite compiler package identity differs",
  );
  assert.match(baseline.vitePatchSha256, /^[a-f0-9]{64}$/);
  assert.equal(candidate.vitePatchSha256, baseline.vitePatchSha256, "Vite patch digest differs");
}

function emittedPackageForModule(moduleId: string): IRuntimePackageIdentity | undefined {
  if (moduleId.startsWith("\0")) return undefined;
  let file = moduleId.startsWith("file:") ? fileURLToPath(moduleId) : moduleId;
  file = file.split("?", 1)[0] ?? file;
  if (!path.isAbsolute(file)) return undefined;
  const resolved = realpathSync.native(file);
  if (!resolved.split(path.sep).includes("node_modules")) return undefined;
  const segments = resolved.split(path.sep);
  const nodeModulesIndex = segments.lastIndexOf("node_modules");
  const packageNameParts = segments[nodeModulesIndex + 1]?.startsWith("@")
    ? segments.slice(nodeModulesIndex + 1, nodeModulesIndex + 3)
    : segments.slice(nodeModulesIndex + 1, nodeModulesIndex + 2);
  const packageRoot = path.join(
    path.sep,
    ...segments.slice(1, nodeModulesIndex + 1 + packageNameParts.length),
  );
  const manifestPath = path.join(packageRoot, "package.json");
  assert(existsSync(manifestPath), `emitted package metadata missing: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  assert(
    typeof manifest.name === "string" && manifest.name.trim(),
    `emitted package name missing: ${manifestPath}`,
  );
  assert(
    typeof manifest.version === "string" && manifest.version.trim(),
    `emitted package version missing: ${manifestPath}`,
  );
  assert.equal(
    manifest.name,
    packageNameParts.join("/"),
    `emitted package name differs from path: ${manifestPath}`,
  );
  return { name: manifest.name, version: manifest.version };
}

export function collectBundledThirdPartyPackages(outputs: readonly unknown[]) {
  const moduleIds = outputs.flatMap((output) => {
    if (!output || typeof output !== "object" || (output as { type?: unknown }).type !== "chunk")
      return [];
    const modules = (output as { modules?: Record<string, unknown> }).modules;
    assert(modules && typeof modules === "object", "emitted chunk module metadata missing");
    return Object.keys(modules);
  });
  assert(moduleIds.length > 0, "emitted chunk module metadata missing");
  const packages = new Map<string, IRuntimePackageIdentity>();
  for (const moduleId of moduleIds) {
    const identity = emittedPackageForModule(moduleId);
    if (identity) packages.set(`${identity.name}@${identity.version}`, identity);
  }
  return normalizeBundledPackages([...packages.values()]);
}

function collectThreePatchDigests(worktreeRoot: string) {
  const files = [
    "packages/core/patches/three@0.185.1.patch",
    "packages/core/patches/three@0.185.1-prd269-upgrade.patch",
    "packages/core/three-patch/pin.json",
    "packages/core/three-patch/source-delta.patch",
  ];
  return Object.fromEntries(
    files
      .filter((file) => existsSync(path.join(worktreeRoot, file)))
      .map((file) => [
        file,
        createHash("sha256")
          .update(readFileSync(path.join(worktreeRoot, file)))
          .digest("hex"),
      ]),
  );
}

export async function collectViteBuildIdentity(worktreeRoot: string) {
  const exampleRoot = path.join(worktreeRoot, "examples/strata-terrain-preview");
  const require = createRequire(path.join(exampleRoot, "package.json"));
  const viteEntry = require.resolve("vite");
  const viteManifestPath = require.resolve("vite/package.json");
  const viteManifest = JSON.parse(readFileSync(viteManifestPath, "utf8")) as {
    version?: unknown;
    dependencies?: Record<string, unknown>;
  };
  const viteVersion = viteManifest.version;
  assert(
    typeof viteVersion === "string" && viteVersion,
    `Vite version metadata missing: ${viteManifestPath}`,
  );
  const vitePatch = path.join(worktreeRoot, `patches/vite@${viteVersion}.patch`);
  assert(existsSync(vitePatch), `Vite patch missing: ${vitePatch}`);
  const pnpmTree = JSON.parse(
    execFileSync(
      "pnpm",
      ["--filter", "strata-terrain-preview", "list", "--depth", "Infinity", "--json"],
      {
        cwd: exampleRoot,
        encoding: "utf8",
      },
    ),
  ) as Array<{ devDependencies?: Record<string, IPnpmPackageNode> }>;
  const viteNode = pnpmTree[0]?.devDependencies?.vite;
  assert(viteNode, "Vite dependency closure missing from pnpm tree");
  const compilerPackages = new Set<string>();
  const seenCompilerPaths = new Set<string>();
  const visitCompilerPackage = (node: IPnpmPackageNode, viteRoot = false) => {
    if (seenCompilerPaths.has(node.path)) return;
    seenCompilerPaths.add(node.path);
    assert(typeof node.from === "string" && node.from, "Vite compiler package name missing");
    assert(
      typeof node.version === "string" && node.version,
      `Vite compiler version missing: ${node.from}`,
    );
    assert(typeof node.path === "string", `Vite compiler package path missing: ${node.from}`);
    const storeMarker = `${path.sep}node_modules${path.sep}.pnpm${path.sep}`;
    const storeIndex = node.path.lastIndexOf(storeMarker);
    assert(storeIndex >= 0, `Vite compiler package is outside pnpm store: ${node.path}`);
    const storeKey = node.path
      .slice(storeIndex + storeMarker.length)
      .split(`${path.sep}node_modules`, 1)[0];
    const patchHash = /(?:^|_)patch_hash=([a-f0-9]{64})/.exec(storeKey ?? "")?.[1];
    compilerPackages.add(`${node.from}@${node.version}${patchHash ? `#patch=${patchHash}` : ""}`);
    for (const [name, dependency] of Object.entries(node.dependencies ?? {}))
      if (
        !viteRoot ||
        Object.hasOwn(viteManifest.dependencies ?? {}, name) ||
        name === "esbuild" ||
        name === "tsx"
      )
        visitCompilerPackage(dependency);
  };
  visitCompilerPackage(viteNode, true);
  const vite = (await import(pathToFileURL(viteEntry).href)) as {
    build?: (config: unknown) => Promise<unknown>;
  };
  assert(typeof vite.build === "function", `Vite build API missing: ${viteEntry}`);
  const previousCwd = process.cwd();
  process.chdir(exampleRoot);
  try {
    const result = await vite.build({
      configFile: path.join(exampleRoot, "vite.config.ts"),
      root: exampleRoot,
      logLevel: "error",
      build: { write: true },
    });
    const outputs = Array.isArray(result)
      ? result.flatMap((item) => (item as { output?: unknown[] }).output ?? [])
      : ((result as { output?: unknown[] }).output ?? []);
    const chunks = outputs.filter((item) => (item as { type?: unknown }).type === "chunk");
    return {
      bundledPackages: collectBundledThirdPartyPackages(chunks),
      compilerPackages: [...compilerPackages].sort(),
      vitePatchSha256: createHash("sha256").update(readFileSync(vitePatch)).digest("hex"),
      chunkCount: chunks.length,
      moduleCount: chunks.reduce<number>(
        (count, item) => count + Object.keys((item as { modules: object }).modules).length,
        0,
      ),
    };
  } finally {
    process.chdir(previousCwd);
  }
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const commonDirectory = execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: root, encoding: "utf8" },
  ).trim();
  const baseline = path.join(path.dirname(commonDirectory), ".worktrees/strata-startup-baseline");
  const output = path.join(root, "artifacts/strata-startup");
  mkdirSync(output, { recursive: true });
  const git = (cwd: string) =>
    execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  assert.equal(git(baseline), BASELINE_SHA, "baseline must remain reviewed source");
  assert.match(process.env.EXPECTED_SOURCE_SHA ?? "", /^[a-f0-9]{40}$/);
  assert.equal(git(root), process.env.EXPECTED_SOURCE_SHA, "candidate must match scoped source");
  const packageIdentity = (cwd: string) =>
    JSON.parse(
      readFileSync(path.join(cwd, "examples/strata-terrain-preview/package.json"), "utf8"),
    );
  verifyStartupPackageIdentity(packageIdentity(baseline), packageIdentity(root));
  for (const cwd of [root, baseline])
    assert.equal(
      realpathSync(
        path.join(cwd, "examples/strata-terrain-preview/node_modules/@threenative/core"),
      ),
      realpathSync(path.join(cwd, "packages/core")),
      "game must resolve its own core",
    );
  const scenario = JSON.parse(
    readFileSync(
      path.join(root, "examples/strata-terrain-preview/playtests/reveal.playtest.json"),
      "utf8",
    ),
  );
  assert.deepEqual(scenario.viewport, { width: 1280, height: 720 });
  // Drop only diagnostic images: hosted WebGPU screenshots can time out. Preserve every assertion.
  scenario.artifacts.screenshots = false;
  for (const step of scenario.steps) step.screenshot = undefined;
  const scenarioPath = path.join(output, "frozen.playtest.json");
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  const toolchain = (cwd: string) =>
    execFileSync("pnpm", ["exec", "vite", "--version"], {
      cwd: path.join(cwd, "examples/strata-terrain-preview"),
      encoding: "utf8",
    }).trim();
  const compiler = toolchain(root);
  assert.equal(toolchain(baseline), compiler, "compiler identity differs");
  const baselineViteBuild = await collectViteBuildIdentity(baseline);
  const candidateViteBuild = await collectViteBuildIdentity(root);
  const baselineIdentity = {
    gamePackage: packageIdentity(baseline),
    bundledPackages: baselineViteBuild.bundledPackages,
    compilerPackages: baselineViteBuild.compilerPackages,
    vitePatchSha256: baselineViteBuild.vitePatchSha256,
  };
  const candidateIdentity = {
    gamePackage: packageIdentity(root),
    bundledPackages: candidateViteBuild.bundledPackages,
    compilerPackages: candidateViteBuild.compilerPackages,
    vitePatchSha256: candidateViteBuild.vitePatchSha256,
  };
  const threePatchDigests = {
    baseline: collectThreePatchDigests(baseline),
    candidate: collectThreePatchDigests(root),
  };
  writeFileSync(
    path.join(output, "identity.json"),
    JSON.stringify({
      baseline: BASELINE_SHA,
      candidate: git(root),
      node: process.version,
      workload: createHash("sha256").update(JSON.stringify(scenario)).digest("hex"),
      browser: execFileSync("pnpm", ["exec", "playwright", "--version"], {
        cwd: root,
        encoding: "utf8",
      }),
      compiler,
      emittedBuildIdentity: {
        baseline: {
          ...baselineViteBuild,
          gamePackage: baselineIdentity.gamePackage,
          threePatchDigests: threePatchDigests.baseline,
        },
        candidate: {
          ...candidateViteBuild,
          gamePackage: candidateIdentity.gamePackage,
          threePatchDigests: threePatchDigests.candidate,
        },
      },
    }),
  );
  verifyStartupBuildIdentity(baselineIdentity, candidateIdentity);
  const runs: IStartupRun[] = [];
  const deadline = Date.now() + 8 * 60_000;
  for (const [index, arm] of ORDER.entries()) {
    const directory = path.join(output, `${index + 1}-${arm}`);
    mkdirSync(directory);
    const fd = openSync(path.join(directory, "run.log"), "w");
    const cwd = arm === "before" ? baseline : root;
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "packages/playtest/dist/runner/cli.js"),
        scenarioPath,
        "--url",
        "http://127.0.0.1:16181/?world=forest",
        "--server-command",
        "pnpm --filter strata-terrain-preview exec vite preview --host 127.0.0.1 --port 16181 --strictPort",
        "--browser-recipe",
        "webgpu",
        "--headed",
        "--no-screenshots",
        "--allow-software",
        "--timeout",
        "75000",
        "--artifacts",
        directory,
      ],
      {
        cwd,
        stdio: ["ignore", fd, fd],
        timeout: Math.max(1, Math.min(80_000, deadline - Date.now())),
        killSignal: "SIGKILL",
      },
    );
    closeSync(fd);
    assert(!result.error && !result.signal, `subprocess failed: ${result.error ?? result.signal}`);
    const log = readFileSync(path.join(directory, "run.log"), "utf8");
    const report = parseStartupReport(log);
    writeFileSync(path.join(directory, "report.json"), JSON.stringify(report));
    runs.push({ arm, status: result.status, report });
  }
  const summary = verifyStartupRuns(runs);
  writeFileSync(path.join(output, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
