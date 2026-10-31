#!/usr/bin/env tsx

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type IPublishPackage,
  type RegistryLookup,
  checkPublishState,
  formatPublishReport,
  npmLookup,
  publishSet,
} from "./check-publish-state.js";
import { progressOf } from "./prd-progress.js";
import { provisionReleaseArtifacts, validateReleaseCohort } from "./release.js";

const REPO = path.resolve(import.meta.dirname, "..");
const TEMPLATE_ROOT = path.join(REPO, "packages", "create-threenative", "templates");

/**
 * The PRDs whose boxes must be closed before a cohort may claim `1.0.0`.
 *
 * 1.0.0 is the version that promises a game written against N keeps working on N+1, so the cohort
 * may not claim it while the proof of that promise is still open. PRD-446 owns it; a second cohort
 * that gates 1.0 adds its file here.
 */
export const RELEASE_1_0_0_GATES = [
  // PRD-446 was archived under `done/` when its proof landed, and the gate stays wired to it: an
  // unticked box there refuses a 1.0.0 cohort again, and a moved file still fails closed.
  "docs/PRDs/done/PRD-446-stable-api-and-upgrade-contract.md",
] as const;

/**
 * Refuse `1.0.0` while any gate PRD still has an unticked box, counting through the repository's
 * own box reader rather than a second one that would disagree with `pnpm prd:progress`.
 *
 * A gate file that has moved is a failure, not a pass: a renamed PRD must not quietly retire the
 * promise it was carrying.
 */
export function assertOneZeroGatesClosed(
  repo = REPO,
  files: readonly string[] = RELEASE_1_0_0_GATES,
): void {
  const open = files.flatMap((file) => {
    const source = path.join(repo, file);
    if (!existsSync(source))
      throw new Error(
        `TN_RELEASE_1_0_0_GATE_MISSING: ${source} is absent, so its open boxes are unknown.`,
      );
    const progress = progressOf(readFileSync(source, "utf8"));
    if (progress.phaseBoxes === 0)
      throw new Error(`TN_RELEASE_1_0_0_GATE_EMPTY: ${source} has no phase boxes to prove.`);
    const remaining =
      progress.phaseBoxes -
      progress.phaseBoxesTicked +
      progress.acceptanceTotal -
      progress.acceptanceTicked;
    return remaining === 0 ? [] : [`${file} (${remaining} open box(es), ${progress.label.name})`];
  });
  if (open.length > 0)
    throw new Error(
      `TN_RELEASE_1_0_0_GATES_OPEN: a 1.0.0 cohort promises a stable public API, and these are still open: ${open.join("; ")}. Nothing was written.`,
    );
}

export interface IReleaseVersionState {
  readonly current: string;
  readonly next: string;
  readonly published: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function nextPatch(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (match === null) throw new Error(`TN_RELEASE_VERSION_MALFORMED: '${version}'.`);
  return `${match[1]}.${match[2]}.${Number.parseInt(match[3] as string, 10) + 1}`;
}

function registryState(
  packageName: string,
  version: string,
  lookup: RegistryLookup,
): "absent" | "present" {
  const facts = lookup(packageName, version);
  if (facts.state === "unreachable")
    throw new Error(
      `TN_RELEASE_REGISTRY_UNREACHABLE: could not determine whether ${packageName}@${version} exists.`,
    );
  return facts.state;
}

/**
 * Select one unused patch version for every public package. If the current set is already absent,
 * it is an idempotent prepared cohort; if any current version is published, move the whole set
 * together so a first release cannot leave the package graph split across old and new versions.
 */
export function selectReleaseVersions(
  packages: readonly Pick<IPublishPackage, "name" | "version">[],
  lookup: RegistryLookup,
): ReadonlyMap<string, IReleaseVersionState> {
  const states = packages.map((item) => ({
    item,
    state: registryState(item.name, item.version, lookup),
  }));
  const bump = states.some(({ state }) => state === "present");
  const selected = new Map<string, IReleaseVersionState>();
  for (const { item, state } of states) {
    let candidate = bump ? nextPatch(item.version) : item.version;
    while (registryState(item.name, candidate, lookup) === "present")
      candidate = nextPatch(candidate);
    selected.set(item.name, {
      current: item.version,
      next: candidate,
      published: state === "present",
    });
  }
  return selected;
}

function replaceFirst(source: string, needle: string, replacement: string, file: string): string {
  const index = source.indexOf(needle);
  if (index < 0)
    throw new Error(`TN_RELEASE_METADATA_MISSING: ${file} does not contain ${needle}.`);
  return `${source.slice(0, index)}${replacement}${source.slice(index + needle.length)}`;
}

function replacePattern(
  source: string,
  pattern: RegExp,
  replacement: string,
  file: string,
): string {
  if (!pattern.test(source)) throw new Error(`TN_RELEASE_METADATA_MISSING: ${file}.`);
  return source.replace(pattern, replacement);
}

function writeIfChanged(file: string, source: string): boolean {
  if (readFileSync(file, "utf8") === source) return false;
  writeFileSync(file, source);
  return true;
}

function syncTemplatePins(versions: ReadonlyMap<string, string>): number {
  let changed = 0;
  for (const entry of readdirSync(TEMPLATE_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(TEMPLATE_ROOT, entry.name, "package.json");
    let source = readFileSync(file, "utf8");
    for (const [name, version] of versions) {
      const pattern = new RegExp(`("${escapeRegExp(name)}"\\s*:\\s*")[^"]+("\\s*,?)`, "gu");
      source = source.replace(pattern, `$1${version}$2`);
    }
    if (writeIfChanged(file, source)) changed += 1;
  }
  return changed;
}

function syncDependencyRange(file: string, dependency: string, version: string): boolean {
  const source = readFileSync(file, "utf8");
  const pattern = new RegExp(
    `("${escapeRegExp(dependency)}"\\s*:\\s*")>=\\d+\\.\\d+\\.\\d+ <0\\.4\\.0("\\s*,?)`,
    "u",
  );
  const updated = replacePattern(source, pattern, `$1>=${version} <0.4.0$2`, file);
  return writeIfChanged(file, updated);
}

function syncPackageVersions(
  packages: readonly IPublishPackage[],
  selected: ReadonlyMap<string, IReleaseVersionState>,
): number {
  let changed = 0;
  for (const item of packages) {
    const state = selected.get(item.name);
    if (state === undefined) throw new Error(`TN_RELEASE_VERSION_MISSING: ${item.name}.`);
    const source = readFileSync(item.manifest, "utf8");
    const updated = replaceFirst(
      source,
      `"version": "${state.current}"`,
      `"version": "${state.next}"`,
      item.manifest,
    );
    if (writeIfChanged(item.manifest, updated)) changed += 1;
  }
  return changed;
}

function requiredVersion(versions: ReadonlyMap<string, string>, name: string): string {
  const version = versions.get(name);
  if (version === undefined) throw new Error(`TN_RELEASE_COHORT_INCOMPLETE: ${name} is missing.`);
  return version;
}

function syncPeerRanges(repo: string, versions: ReadonlyMap<string, string>): number {
  const coreVersion = requiredVersion(versions, "@threenative/core");
  const playtestVersion = requiredVersion(versions, "@threenative/playtest");
  const assetsVersion = requiredVersion(versions, "@threenative/assets");
  const ranges = {
    corePlaytest: [
      path.join(repo, "packages/core/package.json"),
      "@threenative/playtest",
      playtestVersion,
    ],
    physicsCore: [
      path.join(repo, "packages/physics/package.json"),
      "@threenative/core",
      coreVersion,
    ],
    uiCore: [path.join(repo, "packages/ui/package.json"), "@threenative/core", coreVersion],
    cliAssets: [
      path.join(repo, "packages/create-threenative/package.json"),
      "@threenative/assets",
      assetsVersion,
    ],
  } as const;
  let changed = 0;
  for (const [file, dependency, version] of Object.values(ranges)) {
    if (syncDependencyRange(file, dependency, version)) changed += 1;
  }
  return changed;
}

export function syncSourceVersions(repo: string, versions: ReadonlyMap<string, string>): number {
  const coreVersion = versions.get("@threenative/core");
  const engineVersion = versions.get("threenative-engine-mcp");
  if (coreVersion === undefined || engineVersion === undefined)
    throw new Error("TN_RELEASE_COHORT_INCOMPLETE: required release package is missing.");

  const sourceUpdates: readonly [string, RegExp, string][] = [
    [
      path.join(repo, "packages/core/src/index.ts"),
      /export const version = "[^"]+";/u,
      `export const version = ${JSON.stringify(coreVersion)};`,
    ],
    [
      path.join(repo, "packages/create-threenative/src/doctor.ts"),
      /const CORE_PACKAGE_VERSION = "[^"]+";/u,
      `const CORE_PACKAGE_VERSION = ${JSON.stringify(coreVersion)};`,
    ],
    [
      path.join(repo, "packages/create-threenative/src/doctor.ts"),
      /(clientInfo: \{ name: "threenative-doctor", version: ")[^"]+(" \})/u,
      `$1${coreVersion}$2`,
    ],
    [
      path.join(repo, "packages/engine-mcp/src/index.ts"),
      /(serverInfo: \{ name: "threenative-engine-mcp", version: ")[^"]+(",? \})/u,
      `$1${engineVersion}$2`,
    ],
    [
      path.join(repo, "packages/engine-mcp/__tests__/server.spec.ts"),
      /(serverInfo: \{ name: "threenative-engine-mcp", version: ")[^"]+(" \})/u,
      `$1${engineVersion}$2`,
    ],
    [
      path.join(repo, "packages/core/mcp/servers.mjs"),
      /(name: "threenative-engine-mcp", version: ")[^"]+(")/u,
      `$1${engineVersion}$2`,
    ],
    [
      path.join(repo, "packages/create-threenative/engine-mcp-tools.json"),
      /("version": ")[^"]+(")/u,
      `$1${engineVersion}$2`,
    ],
    [
      path.join(repo, "examples/abyss-framework/playtests/replay.playtest.json"),
      /("core": ")[^"]+(")/u,
      `$1${coreVersion}$2`,
    ],
  ];
  let changed = 0;
  for (const [file, pattern, replacement] of sourceUpdates) {
    const source = readFileSync(file, "utf8");
    const updated = replacePattern(source, pattern, replacement, file);
    if (writeIfChanged(file, updated)) changed += 1;
  }
  return changed;
}

function syncReleaseMetadata(
  repo: string,
  packages: readonly IPublishPackage[],
  selected: ReadonlyMap<string, IReleaseVersionState>,
): number {
  const versions = new Map([...selected].map(([name, state]) => [name, state.next]));
  return (
    syncPackageVersions(packages, selected) +
    syncTemplatePins(versions) +
    syncPeerRanges(repo, versions) +
    syncSourceVersions(repo, versions)
  );
}

function run(command: string, args: readonly string[], label: string): void {
  process.stdout.write(`\n▸ ${label}\n`);
  execFileSync(command, [...args], { cwd: REPO, stdio: "inherit" });
}

async function main(): Promise<void> {
  const packages = publishSet(REPO);
  const selected = selectReleaseVersions(packages, npmLookup(REPO));
  // Before a single file is written: 1.0.0 is refused while PRD-446's upgrade proof is still open,
  // so the version bump nobody wants to walk back never lands in the first place.
  if ([...selected.values()].some((state) => state.next === "1.0.0"))
    assertOneZeroGatesClosed(REPO);
  const changed = syncReleaseMetadata(REPO, packages, selected);
  process.stdout.write(
    `Prepared ${packages.length} package(s); synchronized ${changed} file(s).\nRelease cohort:\n${packages
      .map((item) => {
        const state = selected.get(item.name) as IReleaseVersionState;
        return `  ${item.name}: ${state.current} -> ${state.next}`;
      })
      .join("\n")}\n`,
  );

  run("pnpm", ["build"], "pnpm build");
  run("pnpm", ["tsx", "scripts/capture-mcp-tools.ts"], "capture animation MCP surface");

  await provisionReleaseArtifacts(REPO);
  const report = await checkPublishState({
    allowCurrentPublishSetPins: true,
    allowMissingPrebuilt: true,
    repo: REPO,
  });
  process.stdout.write(`\n${formatPublishReport(report)}`);
  if (report.exitCode !== 0)
    throw new Error("TN_RELEASE_PREPARE_RED: the candidate is not publishable.");

  const cohort = validateReleaseCohort(REPO, publishSet(REPO));
  process.stdout.write(
    `Prepared candidate at ${execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: REPO,
      encoding: "utf8",
    }).trim()}: ${cohort.order.length} package(s), ${cohort.bundledMcpServers.length} MCP server(s). Nothing was published.\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
