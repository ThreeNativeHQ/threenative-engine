#!/usr/bin/env tsx
/**
 * `pnpm release` — one command that publishes the workspace, in the order that works.
 *
 * The 0.2.0 release took four publishes instead of one, and three of the four mistakes were
 * mechanical:
 *
 *  - `create-threenative` went out second, but its templates pin every other package, so it
 *    shipped pins to a `@threenative/physics` that was repaired minutes later. **Order matters,
 *    and it is not alphabetical.** This publishes in dependency order and puts the scaffolder
 *    last, always.
 *  - `@threenative/physics` and `@threenative/ui` shipped a peer range excluding the core beside
 *    them, so `npm install` died with ERESOLVE. `pnpm publish:check` catches that now, but only
 *    if somebody remembers to run it. This runs it, and refuses to publish when it is red.
 *  - The published CLI was a no-op and nothing noticed until a human tried it. This ends by
 *    installing from the registry in a clean room, so the run tells you whether what you shipped
 *    actually works.
 *
 * Dry by default. `--yes` is the only thing that publishes, because the one action here cannot
 * be undone: npm versions are immutable, and a broken publish can be deprecated but never
 * replaced.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MCP_SERVERS } from "../packages/core/mcp/servers.mjs";
import {
  type ICheckPublishOptions,
  type IPublishPackage,
  type RegistryLookup,
  checkPublishState,
  formatPublishReport,
  npmLookup,
  publishSet,
} from "./check-publish-state.js";
import {
  type INativeStaged,
  stageNativeRelease,
  uploadNativeRelease,
} from "./release-native-local.js";
import {
  type IRegistryInstallReport,
  type IVerifyRegistryInstallOptions,
  verifyRegistryInstall,
} from "./verify-registry-install.js";

const REPO = path.resolve(import.meta.dirname, "..");

/**
 * The templates PRD-446 phase 3 names. Each one is scaffolded from the previous registry `latest`,
 * upgraded onto the packed candidate and played on web, because an upgrade contract that only
 * covers one template is a contract about that template.
 */
export const UPGRADE_PROOF_TEMPLATES = ["starter", "platformer"] as const;

export interface IReleaseCohort {
  readonly bundledMcpServers: readonly string[];
  readonly order: readonly string[];
  readonly templatePins: readonly string[];
  readonly versions: ReadonlyMap<string, string>;
}

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

/** Validate the structural identity of one candidate before any registry or publish command runs. */
export function validateTemplatePins(
  templateRoot: string,
  versions: ReadonlyMap<string, string>,
): readonly string[] {
  if (!fs.existsSync(templateRoot)) return [];
  const findings: string[] = [];
  for (const entry of fs.readdirSync(templateRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = path.join(templateRoot, entry.name, "package.json");
    if (!fs.existsSync(manifest)) continue;
    const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as Record<string, unknown>;
    for (const field of DEPENDENCY_FIELDS) {
      const block = parsed[field];
      if (typeof block !== "object" || block === null || Array.isArray(block)) continue;
      for (const [dependency, specifier] of Object.entries(block as Record<string, unknown>)) {
        const candidate = versions.get(dependency);
        if (candidate === undefined || specifier === candidate) continue;
        findings.push(
          `templates/${entry.name}/package.json ${field}.${dependency} pins '${String(specifier)}', but the candidate cohort carries '${candidate}'.`,
        );
      }
    }
  }
  return findings;
}

/** The release must carry the shims and the two bundled servers the public MCP table advertises. */
export function validateReleaseCohort(repo = REPO, packages = publishSet(repo)): IReleaseCohort {
  const versions = new Map(packages.map((item) => [item.name, item.version]));
  if (versions.size !== packages.length)
    throw new Error(
      "TN_RELEASE_COHORT_DUPLICATE: the publish set contains a duplicate package name.",
    );
  for (const [name, version] of versions) {
    if (!/^\d+\.\d+\.\d+$/u.test(version))
      throw new Error(`TN_RELEASE_COHORT_VERSION: ${name} has candidate version '${version}'.`);
  }
  const pinFindings = validateTemplatePins(
    path.join(repo, "packages", "create-threenative", "templates"),
    versions,
  );
  if (pinFindings.length > 0)
    throw new Error(`TN_RELEASE_COHORT_TEMPLATE_PINS: ${pinFindings.join(" | ")}`);

  const core = packages.find((item) => item.name === "@threenative/core");
  if (core === undefined)
    throw new Error("TN_RELEASE_COHORT_CORE_MISSING: @threenative/core is not in the publish set.");
  const coreMcp = path.join(core.directory, "mcp");
  const requiredBundles = ["engine-server.mjs", "blender-server.mjs"];
  for (const bundle of requiredBundles) {
    const file = path.join(coreMcp, bundle);
    if (!fs.existsSync(file) || fs.statSync(file).size === 0)
      throw new Error(`TN_RELEASE_COHORT_MCP_BUNDLE: ${file} is missing or empty.`);
  }
  const bundledMcpServers = Object.keys(MCP_SERVERS);
  if (bundledMcpServers.length === 0)
    throw new Error("TN_RELEASE_COHORT_MCP_TABLE: the public MCP table is empty.");
  return {
    bundledMcpServers,
    order: releaseOrder(packages),
    templatePins: pinFindings,
    versions,
  };
}

export interface IPrepareReleaseCohortOptions
  extends Pick<
    ICheckPublishOptions,
    | "allowCurrentPublishSetPins"
    | "allowMissingPrebuilt"
    | "lookup"
    | "prebuiltProbe"
    | "sourceCommits"
    | "tarballs"
  > {
  readonly repo?: string;
}

/** Run the immutable-version preflight against the exact structural cohort; never publishes. */
export async function prepareReleaseCohort(
  options: IPrepareReleaseCohortOptions = {},
): Promise<IReleaseCohort> {
  const repo = options.repo ?? REPO;
  const packages = publishSet(repo);
  const cohort = validateReleaseCohort(repo, packages);
  const report = await checkPublishState({ ...options, repo });
  if (report.exitCode !== 0)
    throw new Error(`TN_RELEASE_COHORT_RED: ${formatPublishReport(report).trim()}`);
  return cohort;
}

/**
 * Dependency order: a package goes out after everything it depends on.
 *
 * The instinct was "publish the scaffolder last, because its templates pin everything else". That
 * is not available in general — a package that depends on `create-threenative` gives the scaffolder
 * a dependent, so it cannot be last. Studio was that package until it moved to its own repository;
 * the ordering test keeps the case covered so the instinct cannot come back.
 *
 * What actually prevents the 0.2.0 mistake is not the order but publishing **one consistent
 * tree in one run**: the pins in `create-threenative`'s templates and the versions of the
 * packages they name come from the same working tree, so they cannot disagree the way they did
 * when the scaffolder was published on its own and its dependencies were repaired afterwards.
 */
export function releaseOrder(packages: readonly { name: string; manifest: string }[]): string[] {
  const names = new Set(packages.map((item) => item.name));
  const dependencies = new Map<string, Set<string>>();
  for (const item of packages) {
    const manifest = JSON.parse(fs.readFileSync(item.manifest, "utf8")) as Record<string, unknown>;
    const internal = new Set<string>();
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      const block = manifest[field];
      if (typeof block !== "object" || block === null) continue;
      for (const dependency of Object.keys(block as Record<string, unknown>))
        if (names.has(dependency) && dependency !== item.name) internal.add(dependency);
    }
    dependencies.set(item.name, internal);
  }
  const ordered: string[] = [];
  const visiting = new Set<string>();
  const visit = (name: string): void => {
    if (ordered.includes(name)) return;
    if (visiting.has(name))
      throw new Error(
        `TN_RELEASE_DEPENDENCY_CYCLE: ${[...visiting, name].join(" -> ")}. Publish order is undefined.`,
      );
    visiting.add(name);
    for (const dependency of dependencies.get(name) ?? []) visit(dependency);
    visiting.delete(name);
    ordered.push(name);
  };
  for (const item of packages) visit(item.name);
  return ordered;
}

export interface IReleaseArtifactSteps {
  /** True when both web engine modules exist and their stamps name this tree's sources. */
  readonly webEngineCurrent: (runtimeRoot: string) => boolean;
  readonly buildWebEngine: () => void;
  readonly ensureGradleWrapper: (output: string) => Promise<unknown>;
}

async function defaultArtifactSteps(): Promise<IReleaseArtifactSteps> {
  const stamp = (await import(
    new URL("../packages/runtime-native/scripts/web-engine-stamp.mjs", import.meta.url).href
  )) as {
    readonly MODULES: readonly string[];
    readonly assertEngineStampCurrent: (root: string) => void;
  };
  const android = (await import(
    new URL("../packages/runtime-native/scripts/package-android.mjs", import.meta.url).href
  )) as { readonly ensureGradleWrapper: (options: { output: string }) => Promise<string> };
  return {
    webEngineCurrent: (runtimeRoot) => {
      const built = stamp.MODULES.every((name) =>
        fs.existsSync(path.join(runtimeRoot, "build", "web", `${name}.wasm`)),
      );
      if (!built) return false;
      try {
        stamp.assertEngineStampCurrent(runtimeRoot);
        return true;
      } catch {
        return false;
      }
    },
    buildWebEngine: () => run("pnpm", ["wasm:build"], "pnpm wasm:build"),
    ensureGradleWrapper: (output) => android.ensureGradleWrapper({ output }),
  };
}

/**
 * Produce the runtime-native `files` entries git does not carry: the web Wasm engine pair and the
 * Gradle wrapper jar. A fresh checkout has neither, `pnpm pack` drops a missing entry without an
 * error, and the publish preflight then refused every release prep from a clean worktree until
 * someone built them by hand. The engine rebuilds only when absent or stale.
 */
export async function provisionReleaseArtifacts(
  repo = REPO,
  steps?: IReleaseArtifactSteps,
): Promise<void> {
  const resolved = steps ?? (await defaultArtifactSteps());
  const runtimeRoot = path.join(repo, "packages", "runtime-native");
  if (!resolved.webEngineCurrent(runtimeRoot)) resolved.buildWebEngine();
  await resolved.ensureGradleWrapper(
    path.join(runtimeRoot, "android", "gradle", "wrapper", "gradle-wrapper.jar"),
  );
}

function run(command: string, args: readonly string[], label: string): void {
  process.stdout.write(`\n▸ ${label}\n`);
  try {
    execFileSync(command, [...args], { cwd: REPO, stdio: "inherit" });
  } catch {
    throw new Error(`TN_RELEASE_STEP_FAILED: ${label}. Nothing further was published.`);
  }
}

/** Refuse to publish artifacts produced from package files that are not in the commit. */
export function assertCleanPackageTree(repo = REPO): void {
  const dirty = execFileSync("git", ["status", "--porcelain", "--", "packages"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
  if (dirty.length > 0)
    throw new Error(
      `TN_RELEASE_DIRTY_TREE: packages/ has uncommitted changes, so the published artifact would correspond to no commit:\n${dirty}\nCommit first, then release.`,
    );
}

/** Publish only a complete candidate cohort whose exact versions are absent from npm. */
export function unpublishedReleasePackages(
  packages: readonly IPublishPackage[],
  lookup: RegistryLookup,
): readonly IPublishPackage[] {
  const states = packages.map((item) => {
    let facts: ReturnType<RegistryLookup>;
    try {
      facts = lookup(item.name, item.version);
    } catch (error) {
      throw new Error(
        `TN_RELEASE_REGISTRY_LOOKUP: could not determine whether ${item.name}@${item.version} exists: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (facts.state === "unreachable")
      throw new Error(
        `TN_RELEASE_REGISTRY_UNREACHABLE: could not determine whether ${item.name}@${item.version} exists. Nothing will be published.`,
      );
    return { facts, item };
  });
  const present = states.filter(({ facts }) => facts.state === "present");
  if (present.length > 0) {
    const state = states
      .map(({ facts, item }) => `${item.name}@${item.version}=${facts.state}`)
      .join(", ");
    const code =
      present.length === states.length
        ? "TN_RELEASE_COHORT_ALREADY_PUBLISHED"
        : "TN_RELEASE_COHORT_PARTIAL";
    throw new Error(
      `${code}: the exact candidate cohort is ${state}. Refusing to republish an existing version or publish only part of a cohort.`,
    );
  }
  return states.map(({ item }) => item);
}

async function waitForRegistry(name: string, version: string): Promise<void> {
  // A brand-new scoped package is not readable the instant it is published, and publishing the
  // scaffolder before its dependencies are visible produces an install nobody can reproduce.
  // The version endpoint is served straight from publish rather than through the packument's CDN
  // cache, so it reflects a new version sooner; the deadline is generous because a real 0.3.1
  // publish aborted after 180s while npm was still propagating (npm itself said "a few minutes").
  const timeoutMs = 15 * 60_000;
  const deadline = Date.now() + timeoutMs;
  const url = `https://registry.npmjs.org/${name.replace("/", "%2f")}/${encodeURIComponent(version)}`;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not visible yet; the deadline is the only thing that ends this loop.
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(
    `TN_RELEASE_NOT_VISIBLE: ${name}@${version} did not become readable on the registry within ${Math.round(timeoutMs / 60_000)} minutes. Later packages would pin a version their consumers cannot resolve.`,
  );
}

/** What `pnpm pack` names a package's tarball, given its published name and candidate version. */
export function packedTarballName(name: string, version: string): string {
  const prefix = name.startsWith("@") ? `${name.slice(1).replace("/", "-")}-` : `${name}-`;
  return `${prefix}${version}.tgz`;
}

function packReleaseSet(
  packages: readonly IPublishPackage[],
  destination: string,
): Readonly<Record<string, string>> {
  const tarballs: Record<string, string> = {};
  for (const item of packages) {
    run(
      "pnpm",
      ["--filter", item.name, "pack", "--pack-destination", destination],
      `pack ${item.name}`,
    );
    tarballs[item.name] = path.join(destination, packedTarballName(item.name, item.version));
  }
  return tarballs;
}

/**
 * PRD-446 phase 3: prove a game written against the previous registry `latest` still upgrades onto
 * this packed candidate and still plays, before any cohort moves `latest`.
 *
 * The candidate is the packed tarballs rather than a tag, so the proof is available before anything
 * irreversible has happened — and once `latest` has moved there is no N-1 left to test, which is
 * exactly why this cannot run after the publish the clean-room lane already waits for.
 *
 * One package manager per template, the one whose lockfile records the packed tarball's SHA-512, so
 * the clean room can prove which bytes it installed; see `UPGRADE_PACKAGE_MANAGERS`.
 */
export async function proveUpgradeFromLatest(
  packages: readonly IPublishPackage[],
  tarballs: Readonly<Record<string, string>>,
  verify: (
    options: IVerifyRegistryInstallOptions,
  ) => Promise<IRegistryInstallReport> = verifyRegistryInstall,
): Promise<readonly IRegistryInstallReport[]> {
  const versions = new Map(packages.map((item) => [item.name, item.version]));
  return Promise.all(
    UPGRADE_PROOF_TEMPLATES.map((template) =>
      verify({ candidate: { tarballs, versions }, template }),
    ),
  );
}

/**
 * Answer the prebuilt-release question from a lock file instead of the public release URL.
 *
 * The release rehearsal (PRD-629) packs the npm cohort while the real `runtime-native-v<version>`
 * release does not exist yet. The lock it generated stands in for the one a consumer would read.
 */
export function prebuiltFromLock(
  lockPath: string,
): Pick<ICheckPublishOptions, "prebuiltLock" | "prebuiltProbe"> {
  const lock: unknown = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  return { prebuiltLock: () => lock, prebuiltProbe: () => "present" };
}

/** `--lock <file>` takes a value, so it is removed before unknown flags are rejected. */
function lockArgument(argv: readonly string[]): { lockPath?: string; rest: readonly string[] } {
  const index = argv.indexOf("--lock");
  if (index === -1) return { rest: argv };
  const lockPath = argv[index + 1];
  if (lockPath === undefined || lockPath.startsWith("--"))
    throw new Error("TN_RELEASE_LOCK_USAGE: --lock requires a prebuilt-lock.json path.");
  return {
    lockPath,
    rest: argv.filter((_, position) => position !== index && position !== index + 1),
  };
}

async function main(args: readonly string[]): Promise<void> {
  if (args[0] === "ship") {
    const { runShip } = await import("./release-ship.js");
    return runShip(args.slice(1));
  }
  const { lockPath, rest: argv } = lockArgument(args);
  const publish = argv.includes("--yes");
  const dryRun = argv.includes("--dry-run");
  if (publish && dryRun)
    throw new Error("TN_RELEASE_FLAGS_CONFLICT: --dry-run and --yes cannot be combined.");
  const lockOptions = lockPath === undefined ? {} : prebuiltFromLock(lockPath);
  const prepare = argv.includes("--prepare");
  const skipGates = argv.includes("--skip-gates");
  // Publish the runtime package before its prebuilt release exists. A deliberate, named decision:
  // `install-prebuilt.mjs` already treats a missing release as a packaging fact rather than a
  // broken download — it warns, the install finishes, the web half of a game works, and every
  // native lane fails closed later on the binary that is not there.
  const allowMissingPrebuilt = argv.includes("--allow-missing-prebuilt");
  const unknown = argv.filter(
    (arg) =>
      !["--yes", "--dry-run", "--prepare", "--skip-gates", "--allow-missing-prebuilt"].includes(
        arg,
      ),
  );
  if (unknown.length > 0) throw new Error(`TN_RELEASE_UNKNOWN_FLAG: ${unknown.join(", ")}`);
  // A `--yes` release that did not ask to publish ahead of its prebuilt payload produces that
  // payload itself, so the preflight may acknowledge its absence and the run finishes the job.
  // Never in CI: the npm-release lane runs on a binary-less runner against the release the native
  // lane already produced, and it holds no GitHub token here, so it must not try to stage one.
  const willCreateNativeRelease =
    publish && !allowMissingPrebuilt && process.env.GITHUB_ACTIONS !== "true";
  const prebuiltAcknowledged = allowMissingPrebuilt || willCreateNativeRelease;

  // Publish from a committed tree, always. The 0.2.x releases went out of a working tree and
  // were committed afterwards, so the artifacts on the registry correspond to no commit — and
  // `publish:check` then reports the package as needing a bump, because its source "moved"
  // after the publish. There is no way to tell, later, which source a published tarball was.
  if (publish) assertCleanPackageTree(REPO);
  await provisionReleaseArtifacts(REPO);

  const packages = publishSet(REPO);
  const cohort = validateReleaseCohort(REPO, packages);
  const order = [...cohort.order];
  const versions = new Map(packages.map((item) => [item.name, item.version]));

  process.stdout.write("Release order:\n");
  for (const [index, name] of order.entries())
    process.stdout.write(`  ${index + 1}. ${name}@${versions.get(name)}\n`);

  const report = await checkPublishState({
    allowCurrentPublishSetPins: true,
    allowMissingPrebuilt: prebuiltAcknowledged,
    repo: REPO,
    ...lockOptions,
  });
  process.stdout.write(`\n${formatPublishReport(report)}`);
  if (report.exitCode !== 0)
    throw new Error("TN_RELEASE_PREFLIGHT_RED: pnpm publish:check refused this tree.");

  if (prepare) {
    process.stdout.write(
      `\nPrepared candidate cohort at ${execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: REPO,
        encoding: "utf8",
      }).trim()}: ${cohort.bundledMcpServers.length} MCP server(s), ${packages.length} package(s). Nothing was published.\n`,
    );
    return;
  }

  if (!skipGates) {
    run("pnpm", ["typecheck"], "pnpm typecheck");
    run("pnpm", ["lint"], "pnpm lint");
    run("pnpm", ["test"], "pnpm test");
  }
  run("pnpm", ["build"], "pnpm build");

  // Assemble the native payload before any npm publish: a declared key with no staged binary must
  // refuse the whole release while nothing irreversible has happened, not after the cohort is up.
  // When the tag already exists — the CI npm lane runs against the native lane's release — this is
  // skipped, so a scoped host-only lock never clobbers the official full-cohort one.
  let native: INativeStaged | undefined;
  if (willCreateNativeRelease) {
    native = await stageNativeRelease({ repo: REPO, skipIfReleased: true });
    process.stdout.write(
      native === undefined
        ? "\nA native release already exists for this version; leaving it untouched.\n"
        : `\nStaged ${native.keys.length} native asset(s) for ${native.tag} in ${native.directory}.\n`,
    );
  }

  if (publish) {
    assertCleanPackageTree(REPO);
    const postBuildReport = await checkPublishState({
      allowCurrentPublishSetPins: true,
      allowMissingPrebuilt: prebuiltAcknowledged,
      repo: REPO,
      ...lockOptions,
    });
    process.stdout.write(
      `\nPost-build publish preflight:\n${formatPublishReport(postBuildReport)}`,
    );
    if (postBuildReport.exitCode !== 0)
      throw new Error("TN_RELEASE_POST_BUILD_PREFLIGHT_RED: the built tree is not publishable.");
  }

  // The exact cohort must be absent from the registry before anything is proved against it: the
  // upgrade proof installs these versions as tarballs, and a version npm already serves can resolve
  // from the registry instead, so the proof would credit the old bytes under the candidate's name.
  // Checked here, before the pack, and answered once — the publish loop below uses this answer.
  // A `--dry-run` packs and stops before the upgrade proof, so a cohort npm already serves is not a
  // hazard: the rehearsal answers "absent" and runs on any tree, even one whose version is published.
  const publishPackages = unpublishedReleasePackages(
    packages,
    dryRun ? () => ({ state: "absent" }) : npmLookup(REPO),
  );
  const publishNames = new Set(publishPackages.map((item) => item.name));

  // Pack the candidate, then prove the previous `latest` upgrades onto it. Both happen before the
  // first publish, because neither is possible afterwards: `latest` has moved, and the immutable
  // version is on npm.
  const packed = await mkdtemp(path.join(os.tmpdir(), "threenative-release-pack-"));
  try {
    const tarballs = packReleaseSet(packages, packed);
    // `--dry-run` stops at the pack: the upgrade proof needs the registry `latest` and a browser
    // lane, which the npm-release workflow's dry run and the real release already carry.
    if (dryRun) {
      process.stdout.write(
        `\nDry run packed ${Object.keys(tarballs).length} package(s). Nothing was published.\n`,
      );
      return;
    }
    const upgrades = await proveUpgradeFromLatest(packages, tarballs);
    for (const [index, report] of upgrades.entries()) {
      const template = UPGRADE_PROOF_TEMPLATES[index] as string;
      process.stdout.write(`\nUpgrade proof — ${template} (registry latest -> candidate):\n`);
      for (const item of report.steps)
        process.stdout.write(
          `  ${item.ok ? "pass" : "FAIL"}  ${item.name}\n        ${item.detail}\n`,
        );
    }
    if (upgrades.some((report) => report.exitCode !== 0))
      throw new Error(
        "TN_RELEASE_UPGRADE_RED: a game on the previous latest does not upgrade onto this candidate. Nothing was published.",
      );
  } finally {
    await rm(packed, { force: true, recursive: true });
  }

  if (!publish) {
    process.stdout.write(
      "\nDry run packed every publishable package. Nothing was published. Re-run with --yes to publish, which cannot be undone.\n",
    );
    return;
  }

  // `--provenance` asks npm to attest where the tarball was built, which it can only do from a
  // CI runner with an OIDC token. Passing it from a workstation fails the publish outright, so a
  // local release drops the flag and says so rather than dying on it. The attestation is a
  // property of where the release ran, not of the artifact's correctness — a locally published
  // version is a real version, it simply carries no provenance statement.
  const attestable = process.env.GITHUB_ACTIONS === "true";
  if (!attestable) {
    process.stdout.write(
      "\nPublishing without --provenance: npm can only attest a build from CI, and this is not CI.\n",
    );
  }
  for (const name of order) {
    if (!publishNames.has(name)) continue;
    const version = versions.get(name);
    if (version === undefined) throw new Error(`TN_RELEASE_NO_VERSION: ${name}`);
    run(
      "pnpm",
      [
        "--filter",
        name,
        "publish",
        "--no-git-checks",
        "--access",
        "public",
        ...(attestable ? ["--provenance"] : []),
      ],
      `publish ${name}@${version}`,
    );
    process.stdout.write(`  waiting for ${name}@${version} to be readable…\n`);
    await waitForRegistry(name, version);
  }

  // The npm cohort is up; now publish the payload the runtime package installs against. The lock
  // is uploaded last, so the clean-room install below reads a release whose advertised keys exist.
  if (native !== undefined) {
    const result = uploadNativeRelease({
      directory: native.directory,
      repository: native.repository,
      tag: native.tag,
    });
    process.stdout.write(`\nPublished ${result.tag} with ${result.uploaded.length} asset(s).\n`);
  }

  run(
    "pnpm",
    ["tsx", "scripts/verify-registry-install.ts"],
    "clean-room install from the registry",
  );
  process.stdout.write("\nPublished, and installable from the registry.\n");
}

if (import.meta.url === `file://${process.argv[1]}`)
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
