#!/usr/bin/env tsx
/**
 * `pnpm publish:check` — the preflight that makes a stale publish impossible.
 *
 * Four packages went up by hand on 2026-08-09 and three never went up at all. Nothing computed a
 * version bump, nothing failed when a package was edited without one, and npm does not permit
 * republishing a version that exists — so the only way that ends well is a check that refuses the
 * tree before anybody runs `pnpm publish`.
 *
 * It answers four questions, and fails closed on each:
 *  - is every publishable workspace package in the publish set, or is one silently missing?
 *  - has any package's build source or declared publication input moved since the version it still
 *    carries was published?
 *  - did a `catalog:` or `workspace:` specifier survive into a manifest that ships?
 *  - does every publishable package carry a README that its own `files` list would include?
 *  - does every relative import of every shipped script resolve inside the packed tarball?
 *
 * A registry it cannot reach is not a pass. It exits `2` — `pnpm alpha:bar` uses the same rank,
 * where `2` means the question was never answered.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { init, parse } from "es-module-lexer";

const { platformKey, releaseManifestUrl } = (await import(
  new URL("../packages/runtime-native/scripts/install-prebuilt.mjs", import.meta.url).href
)) as {
  readonly platformKey: (platform?: string, arch?: string) => string;
  readonly releaseManifestUrl: (version?: string) => string;
};
import { publicWorkspacePackages, workspacePackages } from "./workspace-packages.js";

const REPO = path.resolve(import.meta.dirname, "..");

export interface IPublishPackage {
  readonly directory: string;
  readonly manifest: string;
  readonly name: string;
  readonly version: string;
}

export interface IPublishFinding {
  readonly detail: string;
  readonly package: string;
  /**
   * `blocked` means the question was not answered — never a pass, and never a plain failure.
   * `warn` is a finding the caller acknowledged on purpose: it is still printed, and the report
   * still says the tree is not clean, but it does not refuse the publish.
   */
  readonly severity: "blocked" | "fail" | "warn";
}

export interface IPublishReport {
  readonly checked: readonly string[];
  readonly exitCode: 0 | 1 | 2;
  readonly findings: readonly IPublishFinding[];
}

/** Every workspace package a stranger would have to install. `private` packages are not shipped. */
export function publishSet(repo: string): readonly IPublishPackage[] {
  const workspacePackages = (() => {
    try {
      return publicWorkspacePackages(repo);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "TN_WORKSPACE_PACKAGES_EMPTY: no package manifests were found."
      ) {
        throw new Error(
          "TN_PUBLISH_EMPTY_SET: no publishable package was found. Refusing to pass.",
        );
      }
      throw error;
    }
  })();
  const packages = workspacePackages.map((item) => ({
    directory: item.directory,
    manifest: path.join(item.directory, "package.json"),
    name: item.name,
    version: item.version,
  }));
  if (packages.length === 0) {
    throw new Error("TN_PUBLISH_EMPTY_SET: no publishable package was found. Refusing to pass.");
  }
  return packages;
}

export interface IRegistryFacts {
  /** ISO timestamp the current published version went up, if the package is on the registry. */
  readonly published?: string;
  readonly state: "absent" | "present" | "unreachable";
  readonly version?: string;
}

export type RegistryLookup = (packageName: string, version?: string) => IRegistryFacts;

export function npmLookup(repo: string): RegistryLookup {
  const userconfig = path.join(repo, ".npmrc");
  const config = fs.existsSync(userconfig) ? ["--userconfig", userconfig] : [];
  return (packageName, version) => {
    const requested = version === undefined ? packageName : `${packageName}@${version}`;
    try {
      const stdout = execFileSync(
        "npm",
        [...config, "view", requested, "version", "time", "--json"],
        { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 },
      );
      const parsed = JSON.parse(stdout) as { time?: Record<string, string>; version?: string };
      if (typeof parsed.version !== "string") return { state: "unreachable" };
      const published = parsed.time?.[parsed.version];
      return {
        state: "present",
        version: parsed.version,
        ...(published === undefined ? {} : { published }),
      };
    } catch (error) {
      const text = `${(error as { stderr?: unknown }).stderr ?? ""}${
        error instanceof Error ? error.message : String(error)
      }`;
      return /E404|404 Not Found/u.test(text) ? { state: "absent" } : { state: "unreachable" };
    }
  };
}

const SCRIPT_FILE =
  /(?:^|[\s"'`])((?:\.\.?\/)*[\w.-]+(?:\/[\w.-]+)*\.(?:[cm]?[jt]sx?|json|mjs|cjs|py|sh))/gu;

function addPackageScriptInputs(directory: string, scripts: unknown, targets: Set<string>): void {
  const scriptDirectory = path.join(directory, "scripts");
  if (fs.existsSync(scriptDirectory)) targets.add(scriptDirectory);
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) return;
  for (const command of Object.values(scripts as Record<string, unknown>)) {
    if (typeof command !== "string") continue;
    for (const match of command.matchAll(SCRIPT_FILE)) {
      const relative = match[1];
      if (relative === undefined) continue;
      const absolute = path.resolve(directory, relative);
      if (!absolute.startsWith(`${directory}${path.sep}`) || !fs.existsSync(absolute)) continue;
      targets.add(absolute);
    }
  }
}

const TSCONFIG_FILE = /^tsconfig(?:\.[^/]+)?\.json$/u;
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

function addPackageConfigInputs(directory: string, targets: Set<string>): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (
      !entry.isFile() ||
      (!TSCONFIG_FILE.test(entry.name) &&
        !/(?:^|\.)config\.(?:[cm]?[jt]sx?|json)$/u.test(entry.name))
    )
      continue;
    targets.add(path.join(directory, entry.name));
  }
}

function addSharedBuildInputs(repo: string, targets: Set<string>): void {
  for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
    const file = path.join(repo, name);
    if (fs.existsSync(file)) targets.add(file);
  }
  for (const entry of fs.readdirSync(repo, { withFileTypes: true })) {
    if (entry.isFile() && TSCONFIG_FILE.test(entry.name)) targets.add(path.join(repo, entry.name));
  }
  const patches = path.join(repo, "patches");
  if (fs.existsSync(patches)) targets.add(patches);
}

function addWorkspaceDependencyInputs(
  repo: string,
  directory: string,
  manifest: Record<string, unknown>,
  targets: Set<string>,
): void {
  const packageDirectories = new Map(
    workspacePackages(repo).map((item) => [item.name, item.directory]),
  );
  for (const field of DEPENDENCY_FIELDS) {
    const block = manifest[field];
    if (typeof block !== "object" || block === null || Array.isArray(block)) continue;
    for (const [name, specifier] of Object.entries(block as Record<string, unknown>)) {
      if (typeof specifier !== "string" || !specifier.startsWith("workspace:")) continue;
      const sibling = packageDirectories.get(name);
      if (sibling === undefined || sibling === directory) continue;
      // A workspace dependency can be a build input even when it is only a devDependency: assets
      // and core copy sibling MCP output into their own published tarballs.
      targets.add(sibling);
    }
  }
}

function addPackageDocuments(directory: string, targets: Set<string>): void {
  for (const name of ["README.md", "LICENSE", "LICENCE", "NOTICE"]) {
    const file = path.join(directory, name);
    if (fs.existsSync(file)) targets.add(file);
  }
}

function addPackageFiles(
  directory: string,
  manifest: string,
  files: unknown,
  targets: Set<string>,
): void {
  if (files === undefined) {
    // Without a files list npm's default allowlist is broad. Watching the package directory is
    // safer than guessing which default inclusion rule a future npm version will apply.
    targets.add(directory);
    return;
  }
  if (!Array.isArray(files) || !files.every((entry) => typeof entry === "string"))
    throw new Error(`TN_PUBLISH_FILES_MALFORMED: ${manifest} has a non-string files list.`);
  for (const entry of files) targets.add(path.join(directory, entry));
}

/** Paths that can change the package artifact or the metadata a consumer receives. */
function publicationInputTargets(repo: string, directory: string): readonly string[] {
  const manifest = path.join(directory, "package.json");
  if (!fs.existsSync(manifest))
    throw new Error(`TN_PUBLISH_MANIFEST_MISSING: ${manifest} does not exist.`);
  const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as Record<string, unknown>;
  const targets = new Set<string>([manifest]);
  const source = path.join(directory, "src");
  if (fs.existsSync(source)) targets.add(source);
  const templates = path.join(directory, "templates");
  if (fs.existsSync(templates)) targets.add(templates);
  addPackageScriptInputs(directory, parsed.scripts, targets);
  addPackageConfigInputs(directory, targets);
  addSharedBuildInputs(repo, targets);
  addWorkspaceDependencyInputs(repo, directory, parsed, targets);

  // npm always includes these package documents when they exist. Explicit `files` entries are
  // added below, including non-src bundles such as core/gpl and core/mcp.
  addPackageDocuments(directory, targets);
  addPackageFiles(directory, manifest, parsed.files, targets);
  return [...targets];
}

/** Commits touching a package's build source or publication inputs since a timestamp. */
export type SourceCommits = (directory: string, since: string) => number;

export function gitSourceCommits(repo: string): SourceCommits {
  return (directory, since) => {
    const targets = publicationInputTargets(repo, directory);
    const stdout = execFileSync(
      "git",
      [
        "log",
        "--oneline",
        `--since=${since}`,
        "--",
        ...targets.map((target) => path.relative(repo, target)),
      ],
      { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return stdout.split("\n").filter((line) => line.trim().length > 0).length;
  };
}

const UNRESOLVED = /^(?:catalog:|workspace:)/u;
const TEMPLATE_DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

/**
 * A template manifest ships to a user's disk verbatim. `catalog:` and `workspace:` are pnpm
 * workspace protocols with no meaning outside this repository, so one surviving into a scaffolded
 * project is an install that fails on the stranger's machine and nowhere else.
 */
export function unresolvedTemplateSpecifiers(repo: string): readonly IPublishFinding[] {
  const root = path.join(repo, "packages", "create-threenative", "templates");
  if (!fs.existsSync(root)) return [];
  const findings: IPublishFinding[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = path.join(root, entry.name, "package.json");
    if (!fs.existsSync(manifest)) continue;
    const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as Record<string, unknown>;
    for (const field of TEMPLATE_DEPENDENCY_FIELDS) {
      const block = parsed[field];
      if (typeof block !== "object" || block === null) continue;
      for (const [dependency, specifier] of Object.entries(block as Record<string, unknown>))
        if (typeof specifier === "string" && UNRESOLVED.test(specifier))
          findings.push({
            detail: `templates/${entry.name}/package.json ${field}.${dependency} is '${specifier}', which has no meaning outside this workspace.`,
            package: `template:${entry.name}`,
            severity: "fail",
          });
    }
  }
  return findings;
}

/** Every package specifier copied to a stranger's project must be portable and resolvable. */
export function templatePinCensus(
  repo: string,
  lookup: RegistryLookup = npmLookup(repo),
  options: { readonly allowCurrentPublishSetPins?: boolean } = {},
): readonly IPublishFinding[] {
  const root = path.join(repo, "packages", "create-threenative", "templates");
  if (!fs.existsSync(root)) return [];
  const findings: IPublishFinding[] = [...unresolvedTemplateSpecifiers(repo)];
  const currentPublishPins = options.allowCurrentPublishSetPins
    ? new Set(publishSet(repo).map((item) => `${item.name}@${item.version}`))
    : new Set<string>();
  const seen = new Map<string, IRegistryFacts>();
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = path.join(root, entry.name, "package.json");
    if (!fs.existsSync(manifest)) continue;
    const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as Record<string, unknown>;
    for (const field of TEMPLATE_DEPENDENCY_FIELDS) {
      const block = parsed[field];
      if (typeof block !== "object" || block === null || Array.isArray(block)) continue;
      for (const [dependency, specifier] of Object.entries(block as Record<string, unknown>)) {
        if (typeof specifier !== "string" || UNRESOLVED.test(specifier)) continue;
        const pin = `${dependency}@${specifier}`;
        let facts = seen.get(pin);
        if (facts === undefined) {
          try {
            facts = lookup(dependency, specifier);
          } catch {
            facts = { state: "unreachable" };
          }
          seen.set(pin, facts);
        }
        if (facts.state === "present") continue;
        if (
          options.allowCurrentPublishSetPins &&
          facts.state === "absent" &&
          currentPublishPins.has(pin)
        )
          continue;
        findings.push({
          detail:
            facts.state === "absent"
              ? `templates/${entry.name}/package.json pins ${pin}, but the registry has no resolvable version.`
              : `The registry could not be reached while resolving templates/${entry.name}/package.json pin ${pin}.`,
          package: `template:${entry.name}`,
          severity: facts.state === "absent" ? "fail" : "blocked",
        });
      }
    }
  }
  return findings;
}

export type PrebuiltReleaseProbe = (url: string) => "absent" | "present" | "unreachable";

/** The parsed lock at a present release URL, or undefined when it cannot be read. */
export type PrebuiltLockProvider = (url: string) => unknown;

/**
 * Accept a scoped lock for the key this workstation installs, and refuse one that omits it.
 *
 * A locally published release advertises only the platform matrices this host built. The preflight
 * only ever asked whether the lock exists, so a scoped lock that omits the runtime this checkout
 * would install was indistinguishable from a complete one. The key is present or it is not.
 */
export function scopedPrebuiltLockFindings(lock: unknown, url: string): readonly IPublishFinding[] {
  let key: string;
  try {
    key = platformKey();
  } catch {
    // A host without a published runtime row cannot ask this question; the strict default still runs.
    return [];
  }
  const blocked = { package: "@threenative/runtime-native", severity: "blocked" as const };
  if (typeof lock !== "object" || lock === null || Array.isArray(lock))
    return [
      {
        ...blocked,
        detail: `The prebuilt lock at ${url} could not be read, so whether it advertises '${key}' is unknown.`,
      },
    ];
  const artifacts = (lock as { artifacts?: unknown }).artifacts;
  if (typeof artifacts !== "object" || artifacts === null || Array.isArray(artifacts))
    return [
      { ...blocked, detail: `The prebuilt lock at ${url} carries no readable artifacts object.` },
    ];
  if (Object.hasOwn(artifacts, key)) return [];
  return [
    {
      detail: `The prebuilt lock at ${url} does not advertise '${key}', the runtime this workstation installs. Publish a lock that carries it.`,
      package: "@threenative/runtime-native",
      severity: "fail",
    },
  ];
}

function fetchPrebuiltLock(url: string): unknown {
  try {
    const stdout = execFileSync("curl", ["--silent", "--show-error", "--location", url], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

function headPrebuiltRelease(url: string): ReturnType<PrebuiltReleaseProbe> {
  try {
    const status = execFileSync(
      "curl",
      [
        "--silent",
        "--show-error",
        "--location",
        "--head",
        "--output",
        "/dev/null",
        "--write-out",
        "%{http_code}",
        url,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 },
    ).trim();
    if (/^2\d\d$/u.test(status)) return "present";
    if (status === "404") return "absent";
    return "unreachable";
  } catch {
    return "unreachable";
  }
}

function runtimePackageVersion(repo: string): string | undefined {
  const manifest = path.join(repo, "packages", "runtime-native", "package.json");
  if (!fs.existsSync(manifest)) return undefined;
  const version = (JSON.parse(fs.readFileSync(manifest, "utf8")) as { version?: unknown }).version;
  if (typeof version !== "string" || version.length === 0)
    throw new Error(`TN_PUBLISH_VERSION_MALFORMED: ${manifest} has no version.`);
  return version;
}

/** The runtime package and its public prebuilt lock must move together. */
export function prebuiltReleaseCensus(
  repo: string,
  probe: PrebuiltReleaseProbe = headPrebuiltRelease,
  version = runtimePackageVersion(repo),
  acknowledged = false,
  lockProvider?: PrebuiltLockProvider,
): readonly IPublishFinding[] {
  if (version === undefined) return [];
  const url = releaseManifestUrl(version);
  let state: ReturnType<PrebuiltReleaseProbe>;
  try {
    state = probe(url);
  } catch {
    state = "unreachable";
  }
  if (state === "present")
    return lockProvider === undefined ? [] : scopedPrebuiltLockFindings(lockProvider(url), url);
  if (state === "absent") {
    return [
      {
        detail: acknowledged
          ? `No prebuilt release exists at ${url}. Publishing anyway, acknowledged with ${ALLOW_MISSING_PREBUILT}: installs will warn and continue, and every native lane fails closed on the missing binary until runtime-native-v${version} is published.`
          : `No prebuilt release exists at ${url}; publish runtime-native-v${version} before publishing the runtime package.`,
        package: "@threenative/runtime-native",
        severity: acknowledged ? "warn" : "fail",
      },
    ];
  }
  return [
    {
      detail: `The prebuilt release could not be reached at ${url}; its existence is unknown.`,
      package: "@threenative/runtime-native",
      severity: "blocked",
    },
  ];
}

/**
 * A package page is only useful when its README exists and the package's own `files` list carries
 * it. Packages without an explicit list use npm's default inclusion rules, so existence is enough
 * for them. This stays manifest-based; `unresolvableTarballImports` proves the packed contract.
 */
export function missingPackageReadmes(
  packages: readonly IPublishPackage[],
): readonly IPublishFinding[] {
  const findings: IPublishFinding[] = [];
  for (const item of packages) {
    const readme = path.join(item.directory, "README.md");
    if (!fs.existsSync(readme)) {
      findings.push({
        detail: `${item.name} is missing README.md, so its npm page would have no package documentation.`,
        package: item.name,
        severity: "fail",
      });
      continue;
    }

    const parsed = JSON.parse(fs.readFileSync(item.manifest, "utf8")) as { files?: unknown };
    if (parsed.files === undefined) continue;
    if (!Array.isArray(parsed.files) || !parsed.files.every((entry) => typeof entry === "string"))
      throw new Error(`TN_PUBLISH_FILES_MALFORMED: ${item.manifest} has a non-string files list.`);
    if (parsed.files.includes("README.md")) continue;
    findings.push({
      detail: `${item.name} has a files list ${JSON.stringify(parsed.files)} that does not include README.md, so npm would omit it.`,
      package: item.name,
      severity: "fail",
    });
  }
  return findings;
}

function versionParts(version: string): readonly number[] {
  const parts = version.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 3 || parts.some(Number.isNaN))
    throw new Error(`TN_PUBLISH_VERSION_MALFORMED: '${version}' is not a three-part version.`);
  return parts;
}

function compareVersions(left: string, right: string): number {
  const [a, b] = [versionParts(left), versionParts(right)];
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Whether a version satisfies a range, for the comparator forms this repository actually writes:
 * `>=X <Y`, `^X`, `~X`, `X` and `*`. Anything else is refused rather than guessed at — a range
 * this cannot read is a range nobody should be relying on a preflight to check.
 */
export function satisfiesRange(version: string, range: string): boolean {
  const trimmed = range.trim();
  if (trimmed === "*" || trimmed === "") return true;
  if (/^\d+\.\d+\.\d+$/u.test(trimmed)) return compareVersions(version, trimmed) === 0;
  if (/^[\^~]\d+\.\d+\.\d+$/u.test(trimmed)) {
    const floor = trimmed.slice(1);
    const [major, minor] = versionParts(floor);
    if (compareVersions(version, floor) < 0) return false;
    const [candidateMajor, candidateMinor] = versionParts(version);
    // npm's caret is special below 1.0.0: ^0.2.0 means >=0.2.0 <0.3.0, not <1.0.0, because a
    // 0.x minor bump is treated as breaking. Getting this wrong would let the preflight bless a
    // range that npm then refuses at install time — the exact failure it exists to prevent.
    if (trimmed.startsWith("^"))
      return major === 0
        ? candidateMajor === 0 && candidateMinor === minor
        : candidateMajor === major;
    return candidateMajor === major && candidateMinor === minor;
  }
  const comparators = trimmed.split(/\s+/u);
  if (!comparators.every((item) => /^(?:>=|<=|>|<|=)\d+\.\d+\.\d+$/u.test(item)))
    throw new Error(
      `TN_PUBLISH_RANGE_UNREADABLE: '${range}' uses a form this preflight cannot evaluate. Rewrite it as >=X <Y, ^X, ~X or an exact version.`,
    );
  return comparators.every((item) => {
    const operator = /^(?:>=|<=|>|<|=)/u.exec(item)?.[0] ?? "=";
    const bound = item.slice(operator.length);
    const order = compareVersions(version, bound);
    if (operator === ">=") return order >= 0;
    if (operator === "<=") return order <= 0;
    if (operator === ">") return order > 0;
    if (operator === "<") return order < 0;
    return order === 0;
  });
}

/**
 * A peer range on a sibling package must admit the version that sibling is about to publish.
 *
 * `@threenative/physics@0.2.0` and `@threenative/ui@0.2.0` shipped declaring
 * `@threenative/core@">=0.1.0 <0.2.0"` — a range excluding the core released beside them — so
 * `npm install` in a scaffolded project failed with ERESOLVE and no project could be built. The
 * range is hand-maintained and had to move with the release; nothing made it.
 */
export function staleInternalPeerRanges(
  packages: readonly IPublishPackage[],
): readonly IPublishFinding[] {
  const versions = new Map(packages.map((item) => [item.name, item.version]));
  const findings: IPublishFinding[] = [];
  for (const item of packages) {
    const manifest = JSON.parse(fs.readFileSync(item.manifest, "utf8")) as {
      peerDependencies?: Record<string, string>;
    };
    for (const [dependency, range] of Object.entries(manifest.peerDependencies ?? {})) {
      const sibling = versions.get(dependency);
      if (sibling === undefined) continue;
      if (satisfiesRange(sibling, range)) continue;
      findings.push({
        detail: `${item.name} declares peer ${dependency}@'${range}', which excludes the ${sibling} being published beside it. Installing both fails with ERESOLVE.`,
        package: item.name,
        severity: "fail",
      });
    }
  }
  return findings;
}

/**
 * A packed tarball is what a stranger actually installs. `files` lists are hand-maintained and
 * drift from the imports the scripts really make: HEAD ships `package-android.mjs`, which imports
 * `./asset-preflight.mjs`, and that file is not in the list — so `build --target android` from a
 * published install dies `ERR_MODULE_NOT_FOUND` before it reaches a single fetch. Nothing in the
 * workspace can see that, because in the workspace the file is simply there.
 */
export interface ITarballContents {
  /** Every shipped path, relative to the package root. */
  readonly entries: readonly string[];
  /** Contents of the shipped paths these gates read; binary and asset entries are not read. */
  readonly text: ReadonlyMap<string, string>;
}

export type TarballReader = (item: IPublishPackage) => ITarballContents;

const READABLE = /\.(?:mjs|cjs|js|json)$/u;

/** Packs a package exactly as `pnpm publish` would and reads back what came out. */
export function pnpmPackReader(): TarballReader {
  return (item) => {
    const destination = fs.mkdtempSync(path.join(os.tmpdir(), "threenative-pack-"));
    try {
      execFileSync("pnpm", ["pack", "--pack-destination", destination], {
        cwd: item.directory,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const packed = fs.readdirSync(destination).filter((name) => name.endsWith(".tgz"));
      if (packed.length !== 1)
        throw new Error(
          `TN_PUBLISH_PACK_FAILED: packing ${item.name} produced ${packed.length} tarball(s); expected exactly one.`,
        );
      const extracted = path.join(destination, "extracted");
      fs.mkdirSync(extracted);
      execFileSync("tar", ["-xzf", path.join(destination, packed[0] as string), "-C", extracted], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return readPackageTree(path.join(extracted, "package"));
    } finally {
      fs.rmSync(destination, { force: true, recursive: true });
    }
  };
}

function readPackageTree(root: string): ITarballContents {
  const entries: string[] = [];
  const text = new Map<string, string>();
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      entries.push(relative);
      if (READABLE.test(relative)) text.set(relative, fs.readFileSync(absolute, "utf8"));
    }
  };
  walk(root);
  return { entries: entries.sort(), text };
}

/**
 * `pnpm pack` rewrites `catalog:` and `workspace:` into real ranges; `npm pack` does not, and the
 * tarball it produces installs nowhere — `EUNSUPPORTEDPROTOCOL` on the stranger's machine and
 * nowhere else. CI only ever runs `pnpm -r publish`, so this cannot detect a policy breach in
 * advance; it makes one visible in the artifact instead of in a user's install log.
 */
export function unresolvedTarballSpecifiers(
  item: IPublishPackage,
  contents: ITarballContents,
): readonly IPublishFinding[] {
  const manifest = contents.text.get("package.json");
  if (manifest === undefined)
    return [
      {
        detail: `${item.name} packs a tarball with no package.json, so what it would publish cannot be read.`,
        package: item.name,
        severity: "blocked",
      },
    ];
  const parsed = JSON.parse(manifest) as Record<string, unknown>;
  const findings: IPublishFinding[] = [];
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const block = parsed[field];
    if (typeof block !== "object" || block === null) continue;
    for (const [dependency, specifier] of Object.entries(block as Record<string, unknown>))
      if (typeof specifier === "string" && UNRESOLVED.test(specifier))
        findings.push({
          detail: `${item.name} packs ${field}.${dependency} as '${specifier}', a workspace protocol npm cannot install. The tarball was not produced by \`pnpm pack\`.`,
          package: item.name,
          severity: "fail",
        });
  }
  return findings;
}

/**
 * Relative specifiers a shipped script imports. Parsed rather than pattern-matched: this file's
 * first draft used regexes and reported `./game.js` as missing from the runtime-native tarball,
 * because `profile-production.mjs` writes that import *into a generated bundle* as a string. A
 * gate whose failures are half fiction gets suppressed rather than fixed.
 *
 * Dynamic forms count. `profile-production.mjs` reaches `../../../scripts/gate-records.mjs` from
 * under a CLI guard; that still fails on an installed copy, just later and further from the cause.
 */
export async function relativeSpecifiers(file: string, source: string): Promise<readonly string[]> {
  await init;
  let parsed: ReturnType<typeof parse>[0];
  try {
    [parsed] = parse(source, file);
  } catch (error) {
    throw new Error(
      `TN_PUBLISH_MODULE_UNREADABLE: ${file} is shipped but could not be parsed as a module, so its imports cannot be checked: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const found = new Set<string>();
  for (const item of parsed) if (item.n?.startsWith(".") === true) found.add(item.n);
  return [...found].sort();
}

/**
 * `pnpm pack` drops a `files` entry that does not exist without a word, so a release packed before
 * a build step publishes a package without the built file. Every literal `files` entry must be in
 * the tarball. Glob entries are skipped: a glob that matches nothing is legitimate.
 */
export function missingPackedFiles(
  item: IPublishPackage,
  contents: ITarballContents,
): readonly IPublishFinding[] {
  const manifest = contents.text.get("package.json");
  const files =
    manifest === undefined ? undefined : (JSON.parse(manifest) as { files?: unknown }).files;
  if (!Array.isArray(files)) return [];
  return files
    .filter((entry): entry is string => typeof entry === "string" && !/[*?[\]{}!]/u.test(entry))
    .map((entry) => entry.replace(/^\.\//u, "").replace(/\/$/u, ""))
    .filter(
      (entry) => !contents.entries.some((file) => file === entry || file.startsWith(`${entry}/`)),
    )
    .map((entry) => ({
      detail: `${item.name} lists '${entry}' in files, but its tarball does not hold it. pnpm pack drops a missing entry without an error, so the release would publish the package without it. Build it before packing.`,
      package: item.name,
      severity: "fail" as const,
    }));
}

/**
 * The engine player sources share files with the sibling core and three-native packages by relative
 * path. `bundle-native-engine.mjs` resolves those imports to the installed packages, so they are
 * not an installed copy reaching a sibling checkout.
 */
function resolvedByEngineBundler(file: string, specifier: string): boolean {
  return (
    file.startsWith("src/engine/player/") &&
    /^\.\.\/\.\.\/\.\.\/\.\.\/(?:three-native|core)\/src\//u.test(specifier)
  );
}

/** Every relative import of every shipped script must resolve to something else that shipped. */
export async function unresolvableTarballImports(
  item: IPublishPackage,
  contents: ITarballContents,
): Promise<readonly IPublishFinding[]> {
  const shipped = new Set(contents.entries);
  const findings: IPublishFinding[] = [];
  for (const [file, source] of contents.text) {
    if (file.endsWith(".json")) continue;
    for (const specifier of await relativeSpecifiers(file, source)) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      if (shipped.has(resolved) || resolvedByEngineBundler(file, specifier)) continue;
      const escaped = resolved === ".." || resolved.startsWith("../");
      findings.push({
        detail: escaped
          ? `${item.name} ships ${file}, which imports '${specifier}' outside the package tarball (${resolved}). An installed copy cannot reach a sibling checkout.`
          : `${item.name} ships ${file}, which imports '${specifier}', but ${resolved} is not in the tarball. Loading it fails ERR_MODULE_NOT_FOUND on an installed copy.`,
        package: item.name,
        severity: "fail",
      });
    }
  }
  return findings;
}

export const RELEASE_WORKFLOW = ".github/workflows/npm-release.yml";

/**
 * The publish set is the workflow's list, not this script's. A package that exists, is not
 * private, and is missing from that list is the failure mode that produced three 404s: nobody
 * decided not to publish it, it was simply never named anywhere.
 */
export function missingFromReleaseWorkflow(
  repo: string,
  packages: readonly IPublishPackage[],
): readonly IPublishFinding[] {
  const workflow = path.join(repo, RELEASE_WORKFLOW);
  if (!fs.existsSync(workflow))
    return [
      {
        detail: `${RELEASE_WORKFLOW} does not exist, so there is no publish set to check against.`,
        package: "release-workflow",
        severity: "blocked",
      },
    ];
  const text = fs.readFileSync(workflow, "utf8");
  return packages
    .filter((item) => !text.includes(item.name))
    .map((item) => ({
      detail: `${item.name} is publishable but is not named in ${RELEASE_WORKFLOW}, so a release would silently skip it.`,
      package: item.name,
      severity: "fail" as const,
    }));
}

export interface ICheckPublishOptions {
  readonly allowCurrentPublishSetPins?: boolean;
  /**
   * Publish the runtime package even though its prebuilt release does not exist yet.
   *
   * The absence is a real, named state rather than a broken download: `install-prebuilt.mjs`
   * treats `PREBUILT_RELEASE_MISSING` as a packaging fact, warns, and lets the install finish, so
   * the web half of a game works and the native lanes fail closed later on the missing binary.
   * `@threenative/runtime-native@0.2.0` is on the registry in exactly this state today.
   *
   * It stays a deliberate, named decision rather than a default: without this flag the finding is
   * still `fail`, and with it the report says out loud what was accepted.
   */
  readonly allowMissingPrebuilt?: boolean;
  readonly lookup?: RegistryLookup;
  /**
   * The parsed lock at a present release URL. Defaults to a real fetch unless the caller injected a
   * `prebuiltProbe`, which is how tests answer the existence question without the network.
   */
  readonly prebuiltLock?: PrebuiltLockProvider;
  readonly prebuiltProbe?: PrebuiltReleaseProbe;
  readonly repo?: string;
  readonly sourceCommits?: SourceCommits;
  readonly tarballs?: TarballReader;
}

function versionFinding(
  item: IPublishPackage,
  facts: IRegistryFacts,
  commits: SourceCommits,
): IPublishFinding | undefined {
  if (facts.state === "unreachable")
    return {
      detail: `The registry could not be reached, so it is unknown whether ${item.version} is already published.`,
      package: item.name,
      severity: "blocked",
    };
  // Never published is not a defect here: publishing it is the whole point. The defect is a
  // version that cannot go up because the same string is already on the registry.
  if (facts.state === "absent") return undefined;
  if (facts.version !== item.version) return undefined;
  if (facts.published === undefined)
    return {
      detail: `${item.name}@${item.version} is already published and the registry reported no publish time, so drift cannot be measured.`,
      package: item.name,
      severity: "blocked",
    };
  const moved = commits(item.directory, facts.published);
  if (moved === 0) return undefined;
  return {
    detail: `${item.name} still declares ${item.version}, which was published ${facts.published}, and its source has ${moved} commit(s) since. npm cannot republish a version that exists — bump it.`,
    package: item.name,
    severity: "fail",
  };
}

export async function checkPublishState(
  options: ICheckPublishOptions = {},
): Promise<IPublishReport> {
  const repo = options.repo ?? REPO;
  const lookup = options.lookup ?? npmLookup(repo);
  const commits = options.sourceCommits ?? gitSourceCommits(repo);
  const packages = publishSet(repo);
  const findings: IPublishFinding[] = [];
  for (const item of packages) {
    const finding = versionFinding(item, lookup(item.name), commits);
    if (finding !== undefined) findings.push(finding);
  }
  findings.push(...missingPackageReadmes(packages));
  findings.push(...staleInternalPeerRanges(packages));
  findings.push(...missingFromReleaseWorkflow(repo, packages));
  findings.push(
    ...templatePinCensus(repo, lookup, {
      allowCurrentPublishSetPins: options.allowCurrentPublishSetPins,
    }),
  );
  // A real run reads the lock to accept a scoped release for this host's key; an injected probe
  // means the caller is answering the question itself, so the network is never touched.
  const prebuiltLock =
    options.prebuiltLock ?? (options.prebuiltProbe === undefined ? fetchPrebuiltLock : undefined);
  findings.push(
    ...prebuiltReleaseCensus(
      repo,
      options.prebuiltProbe,
      undefined,
      options.allowMissingPrebuilt === true,
      prebuiltLock,
    ),
  );
  const readTarball = options.tarballs ?? pnpmPackReader();
  for (const item of packages) {
    const contents = readTarball(item);
    findings.push(...unresolvedTarballSpecifiers(item, contents));
    findings.push(...(await unresolvableTarballImports(item, contents)));
    findings.push(...missingPackedFiles(item, contents));
  }
  const blocked = findings.some((finding) => finding.severity === "blocked");
  return {
    checked: packages.map((item) => item.name),
    // An acknowledged finding is reported but does not refuse: the caller already said, by name,
    // that it accepts this exact state.
    exitCode: blocked ? 2 : findings.some((finding) => finding.severity !== "warn") ? 1 : 0,
    findings,
  };
}

export function formatPublishReport(report: IPublishReport): string {
  const lines = [`Checked ${report.checked.length} package(s): ${report.checked.join(", ")}`];
  for (const finding of report.findings)
    lines.push(`${finding.severity.toUpperCase()}  ${finding.package}: ${finding.detail}`);
  const refusing = report.findings.filter((finding) => finding.severity !== "warn").length;
  lines.push(
    refusing > 0
      ? `${report.findings.length} finding(s). This tree must not be published as it stands.`
      : report.findings.length > 0
        ? `Ready to publish with ${report.findings.length} acknowledged finding(s) above.`
        : "Every package is ready to publish.",
  );
  return `${lines.join("\n")}\n`;
}

const ALLOW_CURRENT_PUBLISH_SET_PINS = "--allow-current-publish-set-pins";
const ALLOW_MISSING_PREBUILT = "--allow-missing-prebuilt";

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const supported = new Set([ALLOW_CURRENT_PUBLISH_SET_PINS, ALLOW_MISSING_PREBUILT]);
  const unknown = argv.filter((argument) => !supported.has(argument));
  if (unknown.length > 0) {
    process.stderr.write(
      `TN_PUBLISH_UNKNOWN_FLAG: ${unknown.join(", ")}. Supported flags: ${[...supported].join(", ")}\n`,
    );
    process.exitCode = 1;
    return;
  }
  const report = await checkPublishState({
    allowCurrentPublishSetPins: argv.includes(ALLOW_CURRENT_PUBLISH_SET_PINS),
    allowMissingPrebuilt: argv.includes(ALLOW_MISSING_PREBUILT),
  });
  process.stdout.write(formatPublishReport(report));
  process.exitCode = report.exitCode;
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    // A question this preflight could not answer is never a pass; 2 is the blocked rank.
    process.exitCode = 2;
  });
