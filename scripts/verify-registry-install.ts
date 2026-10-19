#!/usr/bin/env tsx
/**
 * The clean-room gate: install ThreeNative the way a stranger does, from the public registry.
 *
 * No other gate in this repository exercises that path. `scripts/verify-golden-path.ts` resolves
 * `file:` tarballs *by design* — that is what makes it a packed-artifact gate — and the sandbox,
 * the sweeps and every consumer proof to date do the same. So the repository's own harness has
 * never once noticed that `create-threenative` 404s for every person on earth.
 *
 * The assertion that separates this from the packed gate is the **lockfile**: zero `file:` and
 * zero `link:` specifiers. A run that silently resolved back to this workspace would otherwise
 * look identical to a run that worked, which is the manufactured-evidence failure this repository
 * fails builds over.
 *
 * Fail closed: a step that does not run is a failure, not a skip. There is no flag that turns one
 * into a pass.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";
import { MCP_SERVERS } from "../packages/core/mcp/servers.mjs";
import {
  type IZipArchive,
  type IZipEntry,
  readZipEntries,
} from "../packages/runtime-native/scripts/check-android-16kb-alignment.mjs";

const REPO = path.resolve(import.meta.dirname, "..");

/** `link:` is pnpm's workspace link; `file:` is a local tarball or directory. Neither ships. */
const LOCAL_SPECIFIER = /(?:^|["'\s:])(?:file|link):/mu;

export const LOCKFILES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"] as const;

export const REGISTRY_PACKAGE_MANAGERS = ["npm", "pnpm"] as const;
export type RegistryPackageManager = (typeof REGISTRY_PACKAGE_MANAGERS)[number];

/**
 * The upgrade proof runs on one manager, and this is why.
 *
 * `pnpm-lock.yaml` records `resolution.integrity` for a `file:` tarball, so it is the lockfile that
 * can say *which bytes* the clean room installed; a second manager would re-prove the same tarball
 * at double the cost of every scaffold, build and playtest. The post-publish lane still runs npm and
 * pnpm, because that lane is about the published registry rather than about a candidate.
 */
export const UPGRADE_PACKAGE_MANAGERS: readonly RegistryPackageManager[] = ["pnpm"];

export interface IMcpRequest {
  readonly id?: number;
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface IRegistryInstallStep {
  readonly detail: string;
  readonly name: string;
  readonly ok: boolean;
}

/** One published prebuilt release key, and the APK archive entry that has to carry its bytes. */
export interface IAndroidPrebuiltProof {
  readonly entry: string;
  readonly key: string;
}

/**
 * PRD-366 phase 2: one qualified consumer gameplay row per distributed target and arm, carried
 * beside the clean-room steps. Its shape is the runtime-native verifier's `consumer-targets.json`,
 * which is what actually gates a target; this report threads the rows through so a cohort result
 * names the OS, architecture, session and artifact each claim was made on.
 */
export interface IConsumerTargetRow {
  readonly applicationId: string;
  readonly architecture: string;
  readonly artifactHash: string;
  readonly assertions: number;
  readonly failures: readonly string[];
  readonly os: string;
  readonly osVersion: string;
  readonly pass: boolean;
  readonly scenario: string;
  readonly session: string;
  readonly target: string;
}

export interface IRegistryInstallReport {
  /**
   * The qualified consumer arms, one per arm the cohort ran. `target` alone lost a row: phase 2 ran
   * a physical arm and an emulator arm on `android` and the second replaced the first, so a cohort
   * result could name only one machine. Array shape is unchanged; the composite key is internal, so
   * a caller reads each row's own `session`, `architecture` and `osVersion`.
   */
  readonly consumerTargets: readonly IConsumerTargetRow[];
  readonly exitCode: 0 | 1;
  readonly managers: readonly RegistryPackageManager[];
  readonly steps: readonly IRegistryInstallStep[];
}

/**
 * A lockfile naming a local path means the install fell back to this machine. It is the one
 * observation that distinguishes "installed from the registry" from "looked like it did".
 */
export function assertNoLocalSpecifiers(lockfile: string, contents: string): void {
  const offenders = contents
    .split(/\r?\n/u)
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter((entry) => LOCAL_SPECIFIER.test(entry.line));
  if (offenders.length > 0)
    throw new Error(
      `TN_REGISTRY_INSTALL_LOCAL_SPECIFIER: ${lockfile} resolves ${offenders.length} dependency(s) from this machine rather than the registry. First: line ${offenders[0]?.number}: ${offenders[0]?.line}`,
    );
}

/**
 * Refuses to report on a project with no lockfile. An install that produced none did not run, and
 * "no lockfile, no offenders, therefore pass" is exactly the vacuous green this gate exists to
 * prevent.
 */
export function checkLockfile(project: string): string {
  const found = LOCKFILES.map((name) => path.join(project, name)).filter((file) =>
    fs.existsSync(file),
  );
  if (found.length === 0)
    throw new Error(
      `TN_REGISTRY_INSTALL_NO_LOCKFILE: ${project} has none of ${LOCKFILES.join(", ")}, so the install cannot be shown to have come from the registry.`,
    );
  for (const file of found)
    assertNoLocalSpecifiers(path.basename(file), fs.readFileSync(file, "utf8"));
  return found.map((file) => path.basename(file)).join(", ");
}

export type CommandRunner = (command: string, args: readonly string[], cwd: string) => string;

export type McpRunner = (
  serverName: string,
  command: string,
  args: readonly string[],
  cwd: string,
  env?: Readonly<Record<string, string>>,
  requests?: string,
) => string;

/**
 * The invoking package manager's configuration, removed.
 *
 * This runs under pnpm, and pnpm exports its own settings as `npm_config_*` — `catalog`,
 * `patched-dependencies`, `verify-deps-before-run`, `_jsr-registry`. npm reads those as its own
 * config, warns "Unknown env config" about each, and then died on
 * `Cannot read properties of null (reading 'matches')`, which reported the published packages as
 * uninstallable when a plain `npm install` of the same project succeeds. A clean room that
 * inherits the caller's package-manager config is not a clean room.
 *
 * Everything else in the environment is kept: PATH, HOME and the rest are what make the run
 * possible at all.
 */
export function cleanRoomEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cleaned: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (/^npm_config_/iu.test(name)) continue;
    // `npm_package_*` and `npm_lifecycle_*` describe the script that launched this process, and
    // npm re-derives them for whatever it runs next.
    if (/^npm_(package|lifecycle|command)_?/iu.test(name)) continue;
    cleaned[name] = value;
  }
  return cleaned;
}

/** Build one package-manager environment without inheriting a caller's cache or pnpm store. */
export function registryEnvironment(
  base: NodeJS.ProcessEnv,
  manager: RegistryPackageManager,
  cache: string,
  store: string,
): NodeJS.ProcessEnv {
  return {
    ...cleanRoomEnvironment(base),
    NPM_CONFIG_CACHE: cache,
    npm_config_cache: cache,
    ...(manager === "pnpm" ? { npm_config_store_dir: store } : {}),
  };
}

/** Supported Node is a package contract, not a warning discovered halfway through installation. */
export function assertSupportedNodeVersion(version = process.versions.node): void {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version);
  const major = Number.parseInt(match?.[1] ?? "-1", 10);
  const minor = Number.parseInt(match?.[2] ?? "-1", 10);
  const patch = Number.parseInt(match?.[3] ?? "-1", 10);
  if (major < 20 || (major === 20 && (minor < 19 || (minor === 19 && patch < 0))))
    throw new Error(
      `TN_REGISTRY_INSTALL_NODE_UNSUPPORTED: Node ${version} is below the supported minimum 20.19.0. Install Node 20.19.0 or newer before qualifying a registry install.`,
    );
}

export function assertSupportedPackageManager(
  manager: string,
): asserts manager is RegistryPackageManager {
  if (!REGISTRY_PACKAGE_MANAGERS.includes(manager as RegistryPackageManager))
    throw new Error(
      `TN_REGISTRY_INSTALL_PACKAGE_MANAGER_UNSUPPORTED: '${manager}' is not supported; use npm or pnpm.`,
    );
}

/**
 * The tail of a failed child's own output, in the step report.
 *
 * `execFileSync` throws with `Command failed: <command>` and, at most, its stderr. pnpm reports
 * *resolution* failures on stdout, so a failed install used to report the command line and nothing
 * else — the one sentence a reader needs was thrown away. Bounded: an install prints megabytes.
 */
export function childOutputTail(error: unknown, limit = 2_000): string {
  if (typeof error !== "object" || error === null) return "";
  const { stderr, stdout } = error as { readonly stderr?: unknown; readonly stdout?: unknown };
  const text = [stdout, stderr]
    .map((stream) => (typeof stream === "string" ? stream : String(stream ?? "")))
    .join("\n")
    .trim();
  return text.length > limit ? `...\n${text.slice(-limit)}` : text;
}

export function realRunner(env: NodeJS.ProcessEnv): CommandRunner {
  return (command, args, cwd) => {
    try {
      return execFileSync(command, [...args], {
        cwd,
        encoding: "utf8",
        env,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 900_000,
      });
    } catch (error) {
      const tail = childOutputTail(error);
      if (tail.length > 0 && error instanceof Error) error.message = `${error.message}\n${tail}`;
      throw error;
    }
  };
}

interface IMcpFixturePaths {
  readonly source?: string;
  readonly out?: string;
}

const MCP_SAFE_TOOLS: Readonly<Record<string, string>> = {
  "threenative-assets": "asset_search_sources",
  "threenative-blender": "blender_status",
  "threenative-engine": "engine_search_capabilities",
  "threenative-sculpt": "sculpt_grimoire",
};

function safeOperation(
  serverName: string,
  fixture: IMcpFixturePaths,
): Readonly<Record<string, unknown>> {
  const name = MCP_SAFE_TOOLS[serverName];
  if (name === undefined)
    throw new Error(
      `TN_REGISTRY_INSTALL_MCP_OPERATION_UNDECLARED: server '${serverName}' is in the packed table but has no safe verification operation.`,
    );
  const argumentsValue: Record<string, unknown> =
    name === "asset_search_sources"
      ? { category: "all", query: "game" }
      : name === "sculpt_grimoire"
        ? { topic: "glossary/3d_vocabulary" }
        : name === "engine_search_capabilities"
          ? { scope: "mechanic", situation: "enemy walks around a wall" }
          : {};
  return { arguments: argumentsValue, name };
}

export function mcpRequests(
  serverName: string,
  fixture: IMcpFixturePaths = {},
  operation: Readonly<Record<string, unknown>> = safeOperation(serverName, fixture),
): string {
  const requests: IMcpRequest[] = [
    {
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "threenative-registry-install", version: "1.0.0" },
        protocolVersion: "2025-06-18",
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { id: 2, jsonrpc: "2.0", method: "tools/list", params: {} },
    { id: 3, jsonrpc: "2.0", method: "tools/call", params: operation },
  ];
  if (serverName === "threenative-blender" && operation.name === "blender_convert") {
    const argumentsValue = operation.arguments as Record<string, unknown>;
    argumentsValue.source = fixture.source;
    argumentsValue.out = fixture.out;
  }
  return `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`;
}

function jsonLines(output: string, serverName: string): readonly Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  for (const line of output.split(/\r?\n/u).filter((candidate) => candidate.trim().length > 0)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(
        `MCP server '${serverName}' emitted non-JSON stdout during initialize: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error(`MCP server '${serverName}' emitted a non-object JSON response.`);
    messages.push(parsed as Record<string, unknown>);
  }
  return messages;
}

function requireMcpResponse(
  messages: readonly Record<string, unknown>[],
  serverName: string,
  id: number,
): Record<string, unknown> {
  const response = messages.find((message) => message.id === id);
  if (response === undefined)
    throw new Error(`MCP server '${serverName}' never answered request ${id}.`);
  if (response.error !== undefined)
    throw new Error(
      `MCP server '${serverName}' request ${id} failed: ${JSON.stringify(response.error)}.`,
    );
  if (typeof response.result !== "object" || response.result === null)
    throw new Error(`MCP server '${serverName}' returned no result for request ${id}.`);
  return response;
}

interface ICapabilitySearchHit {
  readonly constraints: readonly string[];
  readonly example: string;
  readonly importPath: string;
  readonly summary: string;
  readonly symbol: string;
}

interface IMcpSession {
  readonly messages: readonly Record<string, unknown>[];
  readonly operation: Record<string, unknown>;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isCapabilitySearchHit(value: unknown): value is ICapabilitySearchHit {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const hit = value as Record<string, unknown>;
  return (
    isNonEmptyString(hit.symbol) &&
    isNonEmptyString(hit.importPath) &&
    isNonEmptyString(hit.summary) &&
    isNonEmptyString(hit.example) &&
    Array.isArray(hit.constraints) &&
    hit.constraints.every((constraint) => typeof constraint === "string")
  );
}

function toolText(response: Record<string, unknown>, serverName: string): string {
  const result = response.result as { content?: unknown; isError?: unknown };
  if (result.isError === true)
    throw new Error(`MCP server '${serverName}' returned an error from its safe operation.`);
  if (!Array.isArray(result.content))
    throw new Error(`MCP server '${serverName}' returned no tools/call content.`);
  const text = result.content.find(
    (entry): entry is { text: string } =>
      typeof entry === "object" &&
      entry !== null &&
      "text" in entry &&
      typeof entry.text === "string",
  )?.text;
  if (text === undefined)
    throw new Error(`MCP server '${serverName}' returned no text tool result.`);
  return text;
}

function parseToolPayload(response: Record<string, unknown>, serverName: string): unknown {
  const text = toolText(response, serverName);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `MCP server '${serverName}' returned malformed tool JSON: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
}

function assertMcpHandshake(serverName: string, output: string, expectedTool: string): IMcpSession {
  const messages = jsonLines(output, serverName);
  requireMcpResponse(messages, serverName, 1);
  const toolsResponse = requireMcpResponse(messages, serverName, 2);
  const tools = (toolsResponse.result as { tools?: unknown }).tools;
  if (!Array.isArray(tools))
    throw new Error(`MCP server '${serverName}' returned no tools/list array.`);
  const names = tools.flatMap((tool) =>
    typeof tool === "object" && tool !== null && "name" in tool && typeof tool.name === "string"
      ? [tool.name]
      : [],
  );
  if (!names.includes(expectedTool))
    throw new Error(`MCP server '${serverName}' tools/list does not advertise '${expectedTool}'.`);
  const operation = requireMcpResponse(messages, serverName, 3);
  return { messages, operation };
}

export function realMcpRunner(
  serverName: string,
  command: string,
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>> = {},
  requests?: string,
): string {
  return execFileSync(command, [...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    input: requests ?? mcpRequests(serverName),
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30_000,
  });
}

/**
 * PRD-366 phase 1. A consumer proof is only real if the installed game is edited and then *played*,
 * with observable state transitions. These three helpers are the parts of that claim a clean-room
 * job can check mechanically; the playtest run itself is the fourth.
 */
export const GAMEPLAY_SCENARIO = "playtests/production-readiness.playtest.json";

/**
 * PRD-446 phase 3. `starter` and `platformer` both ship this one with five non-empty assertion
 * families, so the upgrade proof drives the same real web scenario on either template instead of
 * carrying a per-template list that would drift from what the templates actually ship.
 */
export const UPGRADE_SCENARIO = "playtests/survives.playtest.json";

/**
 * The packed candidate cohort an N-1 install is upgraded onto, keyed by package name.
 *
 * Identity is carried by the tarballs, not by the versions. `release.ts` proves the exact cohort is
 * absent from npm before it packs anything, so a release cohort always has unique versions; a
 * development cohort may share the `latest` version it upgrades from, and there the lockfile's
 * recorded SHA-512 is the only claim that survives. Both run.
 */
export interface ICandidateCohort {
  readonly tarballs: Readonly<Record<string, string>>;
  readonly versions: ReadonlyMap<string, string>;
}

/** A marker appended to the game's portable entry, so a game-only edit is provably the consumer's. */
export const GAME_ONLY_EDIT_MARKER = "TN_REGISTRY_GAME_ONLY_EDIT";

/**
 * Append the marker to the scaffolded game's portable entry.
 *
 * Idempotent, and deliberately game-owned: `src/game.ts` is the consumer's file, not package code,
 * so a build that carries the marker proves the installed consumer's own edit reached its artifact.
 */
export function applyGameOnlyEdit(project: string): string {
  const entry = path.join(project, "src", "game.ts");
  if (!fs.existsSync(entry))
    throw new Error(
      `TN_REGISTRY_INSTALL_GAMEPLAY_ENTRY_MISSING: ${entry} does not exist, so a game-only edit cannot be made.`,
    );
  const source = fs.readFileSync(entry, "utf8");
  if (!source.includes(GAME_ONLY_EDIT_MARKER))
    // A side-effecting assignment, not a comment: Vite's minifier strips non-legal comments from the
    // built bundle, so a `// marker` would never be observable in `dist/` and this gate would fail
    // for the wrong reason.
    fs.writeFileSync(
      entry,
      `${source}\n(globalThis as Record<string, unknown>).__tnRegistryGameOnlyEdit = "${GAME_ONLY_EDIT_MARKER}";\n`,
    );
  return entry;
}

/**
 * Require the named scenario to exist with at least one non-empty assertion family.
 *
 * A scenario that asserts nothing, or a project that shipped without it, is the vacuous green this
 * phase exists to prevent — an installed runner that exits 0 having proven nothing.
 */
export function assertScenarioAssertions(file: string, subject = "the installed game"): string {
  if (!fs.existsSync(file))
    throw new Error(
      `TN_REGISTRY_INSTALL_GAMEPLAY_SCENARIO_MISSING: ${file} is absent, so ${subject} cannot be proven playable.`,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `TN_REGISTRY_INSTALL_GAMEPLAY_SCENARIO_INVALID: ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const assertion = objectRecord((parsed as { assert?: unknown } | undefined)?.assert);
  const families = (assertion === undefined ? [] : Object.keys(assertion)).filter((key) => {
    const value = assertion?.[key];
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "object" && value !== null) return Object.keys(value).length > 0;
    return value === true;
  });
  if (families.length === 0)
    throw new Error(
      `TN_REGISTRY_INSTALL_GAMEPLAY_NO_ASSERTIONS: ${file} declares no non-empty assertion family, so a passing run would prove nothing.`,
    );
  return families.join(", ");
}

/**
 * Require every candidate package to be installed at exactly the candidate version.
 *
 * The version is a *necessary* condition, never a sufficient one: a cohort in development can
 * legitimately carry the same version as the registry `latest` it upgrades from, so a tree reading
 * the right number may still be the old bytes. `assertCandidateIntegrity` is what settles that.
 */
export function assertCandidateInstalled(
  project: string,
  versions: ReadonlyMap<string, string>,
): string {
  if (versions.size === 0)
    throw new Error(
      "TN_REGISTRY_UPGRADE_NO_CANDIDATE: the upgrade proof was given no candidate cohort, so it would prove nothing about an upgrade.",
    );
  const installed: string[] = [];
  for (const [name, version] of versions) {
    const manifest = path.join(project, "node_modules", ...name.split("/"), "package.json");
    if (!fs.existsSync(manifest))
      throw new Error(
        `TN_REGISTRY_UPGRADE_NOT_INSTALLED: ${name} is absent from the upgraded project, so no candidate reached the consumer.`,
      );
    const found = (JSON.parse(fs.readFileSync(manifest, "utf8")) as { version?: unknown }).version;
    if (found !== version)
      throw new Error(
        `TN_REGISTRY_UPGRADE_VERSION_MISMATCH: the upgraded project resolved ${name}@${String(found)}, not the candidate ${version}.`,
      );
    installed.push(`${name}@${version}`);
  }
  return installed.join(", ");
}

/**
 * The `integrity` a package manager records for a tarball: the raw SHA-512, base64.
 *
 * Byte-for-byte what both managers write for a `file:` tarball — pnpm as
 * `packages.<name>.resolution.integrity`, npm as `packages["node_modules/<name>"].integrity` — so
 * the packed candidate and the installed resolution are compared as bytes, not as a version.
 */
export function tarballIntegrity(tarball: string): string {
  return `sha512-${createHash("sha512").update(fs.readFileSync(tarball)).digest("base64")}`;
}

/**
 * Every integrity the installed lockfile records for one packed tarball.
 *
 * A line-oriented read of the two shapes the managers actually write, each of which puts the
 * integrity within a line or two of the entry naming the tarball:
 *
 * ```yaml
 * '@threenative/core@file:../../core-0.3.3.tgz':
 *   resolution: {integrity: sha512-…, tarball: file:../../core-0.3.3.tgz}
 * ```
 * ```json
 * "resolved": "file:../core-0.3.3.tgz",
 * "integrity": "sha512-…"
 * ```
 *
 * A YAML dependency would be a second opinion on what pnpm's own lockfile means; this reads the
 * field pnpm writes and reports nothing when it is absent, so the caller fails closed.
 */
function lockfileIntegrities(lockfile: string, tarball: string): readonly string[] {
  const lines = lockfile.split(/\r?\n/u);
  const name = path.basename(tarball);
  const found: string[] = [];
  for (const [index, line] of lines.entries())
    if (line.includes(name))
      for (const near of lines.slice(index + 1, index + 4)) {
        const match = /integrity["']?\s*:\s*["']?(sha512-[A-Za-z0-9+/=]+)/u.exec(near);
        if (match?.[1] !== undefined) found.push(match[1]);
      }
  return found;
}

/**
 * Prove the installed tree resolved *these bytes*: the lockfile entry naming each packed tarball
 * must carry that tarball's SHA-512.
 *
 * This is the check a version cannot make, and the one that closes the case the release path can
 * actually hit — a development cohort sharing the registry `latest` version, where the "upgrade"
 * resolved the same package twice and proved nothing. The hash is over the tarball, so it survives
 * re-packing identical bytes and fails on any difference.
 */
export function assertCandidateIntegrity(
  project: string,
  tarballs: Readonly<Record<string, string>>,
): string {
  const lockfiles = LOCKFILES.map((file) => path.join(project, file)).filter((file) =>
    fs.existsSync(file),
  );
  if (lockfiles.length === 0)
    throw new Error(
      `TN_REGISTRY_UPGRADE_NO_LOCKFILE: ${project} has none of ${LOCKFILES.join(", ")}, so the installed bytes cannot be identified.`,
    );
  const proved: string[] = [];
  for (const [name, tarball] of Object.entries(tarballs)) {
    if (!fs.existsSync(tarball))
      throw new Error(
        `TN_REGISTRY_UPGRADE_TARBALL_MISSING: ${tarball} was packed for ${name} and is not there to hash.`,
      );
    const expected = tarballIntegrity(tarball);
    const observed = new Set(
      lockfiles.flatMap((file) => lockfileIntegrities(fs.readFileSync(file, "utf8"), tarball)),
    );
    if (!observed.has(expected))
      throw new Error(
        `TN_REGISTRY_UPGRADE_INTEGRITY_MISMATCH: the installed lockfile resolved ${name} to ${
          [...observed].join(", ") || "no recorded integrity"
        }, not the packed candidate's ${expected}. Those are not the candidate's bytes.`,
      );
    proved.push(`${name} ${expected}`);
  }
  return proved.join(", ");
}

/** Require the applied game-only edit to appear in the built output, not only in the source. */
export function assertEditedGameplayInBuild(
  project: string,
  marker = GAME_ONLY_EDIT_MARKER,
): string {
  const dist = path.join(project, "dist");
  const found = treeContains(dist, marker);
  if (found === undefined)
    throw new Error(
      `TN_REGISTRY_INSTALL_GAMEPLAY_EDIT_NOT_BUILT: the game-only edit '${marker}' is absent from ${dist}, so the consumer's edit did not reach the build.`,
    );
  return found;
}

function treeContains(root: string, needle: string): string | undefined {
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) stack.push(file);
      else if (entry.isFile()) {
        try {
          if (fs.readFileSync(file, "utf8").includes(needle)) return file;
        } catch {
          // A binary asset is not the portable entry; keep looking.
        }
      }
    }
  }
  return undefined;
}

/**
 * The internal key an arm is recorded under: its target plus what the run itself named about the
 * machine.
 *
 * `session` is the qualifier's own physical/emulator distinction (`android-device` against
 * `android-emulator`), which is what this key is for — one target's phone and emulator no longer
 * overwrite each other. Architecture and OS version narrow it further, but two phones reporting the
 * same values are still one key, so this is **not** a device identity: only the row's own fields
 * say which machine ran.
 */
function consumerTargetKey(row: IConsumerTargetRow): string {
  return [row.target, row.session, row.architecture, row.osVersion].join(" ");
}

/**
 * What the run itself named, for an arm that evaluated zero assertions.
 *
 * `failureReport()` (`packages/playtest/src/runner/shared.ts`) is the generic pre-assertion abort
 * shape: a single unevaluated `diagnostics` result, so a row keeping only the verifier's message
 * ("assertion 'diagnostics' was not evaluated") never said what actually failed. That is why phase
 * 2's one physical arm64 abort is still unexplained. The runner's own stdout sits beside the row
 * file and holds the diagnostic, so read it back rather than re-running anything — and say so
 * plainly when it holds none, rather than passing the generic message off as the cause.
 */
function firstConsumerDiagnostic(project: string, target: string): string {
  const file = path.join(project, "artifacts", "native", `consumer-${target}.stdout.json`);
  const lost = (why: string): string =>
    `TN_REGISTRY_INSTALL_CONSUMER_DIAGNOSTIC_MISSING: ${file} ${why}, so the '${target}' arm that evaluated zero assertions retains no cause.`;
  if (!fs.existsSync(file)) return lost("is absent");
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    return `TN_REGISTRY_INSTALL_CONSUMER_DIAGNOSTIC_UNREADABLE: ${file} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
  const diagnostics = objectRecord(parsed)?.diagnostics;
  const first = Array.isArray(diagnostics) ? objectRecord(diagnostics[0]) : undefined;
  if (!isNonEmptyString(first?.code)) return lost("names no first diagnostic");
  const message = first?.message;
  return `${first.code}: ${isNonEmptyString(message) ? message : "(no message)"}`;
}

/**
 * Read the distributed-target gameplay rows the runtime-native verifier wrote for this consumer.
 *
 * Absent means the target lane has not run here (the desktop container lane is PRD-365, not on
 * develop); a present-but-malformed file is a failure rather than an empty list, because "no rows"
 * and "unreadable rows" must never read the same.
 */
export function readConsumerTargetRows(project: string): readonly IConsumerTargetRow[] {
  const file = path.join(project, "artifacts", "native", "consumer-targets.json");
  if (!fs.existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `TN_REGISTRY_INSTALL_CONSUMER_ROW_MALFORMED: ${file} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(parsed))
    throw new Error(`TN_REGISTRY_INSTALL_CONSUMER_ROW_MALFORMED: ${file} is not a row array.`);
  return parsed.map((row) => {
    const record = objectRecord(row);
    if (record === undefined)
      throw new Error(
        `TN_REGISTRY_INSTALL_CONSUMER_ROW_MALFORMED: ${file} holds a non-object row.`,
      );
    const text = (field: string): string => {
      const value = record[field];
      if (typeof value !== "string" || value.length === 0)
        throw new Error(
          `TN_REGISTRY_INSTALL_CONSUMER_ROW_MALFORMED: ${file} row field '${field}' is missing.`,
        );
      return value;
    };
    const assertions = record.assertions;
    if (typeof assertions !== "number" || !Number.isInteger(assertions) || assertions < 0)
      throw new Error(
        `TN_REGISTRY_INSTALL_CONSUMER_ROW_MALFORMED: ${file} row field 'assertions' is not a non-negative integer.`,
      );
    if (typeof record.pass !== "boolean")
      throw new Error(
        `TN_REGISTRY_INSTALL_CONSUMER_ROW_MALFORMED: ${file} row field 'pass' is not a boolean.`,
      );
    if (!Array.isArray(record.failures))
      throw new Error(
        `TN_REGISTRY_INSTALL_CONSUMER_ROW_MALFORMED: ${file} row field 'failures' is not an array.`,
      );
    const target = text("target");
    const failures = record.failures.map((failure) => String(failure));
    return {
      applicationId: text("applicationId"),
      architecture: text("architecture"),
      artifactHash: text("artifactHash"),
      assertions,
      // Zero assertions is the pre-assertion abort shape, so name what the run itself reported.
      failures:
        assertions === 0 ? [...failures, firstConsumerDiagnostic(project, target)] : failures,
      os: text("os"),
      osVersion: text("osVersion"),
      pass: record.pass,
      scenario: text("scenario"),
      session: text("session"),
      target,
    };
  });
}

export interface IVerifyRegistryInstallOptions {
  /**
   * The packed candidate to upgrade the registry `latest` install onto. Present turns this into the
   * PRD-446 phase 3 upgrade proof, which claims web only: the native and MCP steps below describe
   * what the *published* tree offers, and the published tree is proven by the post-publish lane.
   */
  readonly candidate?: ICandidateCohort;
  /** Where the clean room is created. Must have no workspace above it. */
  readonly parent?: string;
  readonly mcp?: McpRunner;
  readonly packageManagers?: readonly RegistryPackageManager[];
  readonly run?: CommandRunner;
  /** Runs `api:surface:check`; an unannounced break refuses the candidate before it is installed. */
  readonly surfaceCheck?: () => void;
  readonly template?: string;
}

/** Streams each finished step to stderr, so a job killed by its clock still names the slow step. */
function progress(item: IRegistryInstallStep, started: number): IRegistryInstallStep {
  const seconds = ((performance.now() - started) / 1000).toFixed(0);
  process.stderr.write(`${item.ok ? "pass" : "FAIL"}  ${item.name} (${seconds}s)\n`);
  return item;
}

function step(name: string, work: () => string): IRegistryInstallStep {
  const started = performance.now();
  try {
    return progress(
      { detail: work().trim().slice(-400) || "(no output)", name, ok: true },
      started,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return progress({ detail, name, ok: false }, started);
  }
}

/** Every step after `install`, in run order. The not-run bookkeeping is this list, not a copy. */
function stepPlan(upgrade: boolean): readonly string[] {
  return upgrade
    ? ["lockfile", "surface", "upgrade", "edit", "build", "test", "gameplay"]
    : ["lockfile", "edit", "build", "test", "gameplay", "doctor", "native", "android", "mcp"];
}

/** `step` for work that has to await: reading the installed package's ES modules cannot be sync. */
async function stepAsync(name: string, work: () => Promise<string>): Promise<IRegistryInstallStep> {
  const started = performance.now();
  try {
    const detail = (await work()).trim().slice(-400) || "(no output)";
    return progress({ detail, name, ok: true }, started);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return progress({ detail, name, ok: false }, started);
  }
}

function artifactName(project: string): string {
  const manifest = JSON.parse(fs.readFileSync(path.join(project, "package.json"), "utf8")) as {
    name?: unknown;
  };
  if (typeof manifest.name !== "string" || manifest.name.length === 0)
    throw new Error("Native build produced no project name to resolve its artifact.");
  return manifest.name.replace(/^@[^/]+\//u, "").replace(/[^a-zA-Z0-9._-]/gu, "-");
}

function nativeOutput(project: string): string {
  const executable = path.join(
    project,
    "dist-native",
    `${artifactName(project)}${process.platform === "win32" ? ".exe" : ""}`,
  );
  if (!fs.existsSync(executable))
    throw new Error(`Native build produced no executable at ${executable}.`);
  const mode = fs.statSync(executable).mode;
  if (process.platform !== "win32" && (mode & 0o111) === 0)
    throw new Error(`Native build output is not executable: ${executable}.`);
  return executable;
}

function androidOutput(project: string): string {
  const apk = path.join(project, "dist-native", `${artifactName(project)}.apk`);
  if (!fs.existsSync(apk)) throw new Error(`Android build produced no APK at ${apk}.`);
  if (fs.statSync(apk).size === 0)
    throw new Error(`Android build produced an empty APK at ${apk}.`);
  return apk;
}

/** The ABI this gate's Android criterion names, and the one the published cohort is proved on. */
export const ANDROID_PROOF_ABI = "arm64-v8a";

/**
 * The rows of the *installed* packager's prebuilt table this ABI must reach the APK as, named the
 * way the archive names them.
 *
 * Read from the installed package rather than restated here: that table is what the build staged
 * from, and a second copy of it here is a second thing to drift. A `jniLibs/` source directory
 * becomes `lib/` in the archive, while a staged asset keeps its own path. The `.aar` row is a build
 * input rather than an APK entry and names no ABI, so the ABI filter already excludes it.
 */
export function androidApkPrebuiltProofs(
  assets: Readonly<Record<string, string>>,
  abi: string = ANDROID_PROOF_ABI,
): readonly IAndroidPrebuiltProof[] {
  const proofs = Object.entries(assets)
    .filter(([, staged]) => staged.includes(`/${abi}/`))
    .map(([key, staged]) => ({
      entry: staged.startsWith("jniLibs/") ? `lib/${staged.slice("jniLibs/".length)}` : staged,
      key,
    }));
  if (proofs.length === 0)
    throw new Error(
      `TN_REGISTRY_INSTALL_ANDROID_NO_PREBUILT_ROWS: the installed packager stages no ${abi} library, so its APK cannot be checked against the published cohort.`,
    );
  return proofs;
}

/** A ZIP entry is either stored verbatim or deflated; both read without a dependency. */
const ZIP_STORED = 0;

function entrySha256(archive: IZipArchive, entry: IZipEntry): string {
  const raw = archive.bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  const contents = entry.compression === ZIP_STORED ? raw : inflateRawSync(raw);
  return createHash("sha256").update(contents).digest("hex");
}

/**
 * Require every named prebuilt to be inside the APK, byte-identical to what the release published.
 *
 * A stub key, a `.so` compiled on the machine instead of downloaded, or an APK missing one ABI's
 * runtime all fail here. `build --target android` exiting 0 says none of that: the claim is that
 * these are the published bytes, and only a checksum against the published release says so.
 */
export function assertPublishedApkPrebuilts(
  apk: string,
  archive: IZipArchive,
  artifacts: Readonly<Record<string, { readonly sha256: string }>>,
  proofs: readonly IAndroidPrebuiltProof[],
): string {
  const verified: string[] = [];
  for (const { entry, key } of proofs) {
    const expected = artifacts[key]?.sha256;
    if (typeof expected !== "string" || expected.length === 0)
      throw new Error(
        `TN_REGISTRY_INSTALL_ANDROID_NOT_PUBLISHED: the published release manifest carries no '${key}', so ${entry} in ${apk} cannot be proven published.`,
      );
    const stored = archive.entries.find((candidate) => candidate.name === entry);
    if (stored === undefined)
      throw new Error(
        `TN_REGISTRY_INSTALL_ANDROID_ENTRY_MISSING: ${apk} carries no ${entry} for prebuilt '${key}'.`,
      );
    const actual = entrySha256(archive, stored);
    if (actual !== expected)
      throw new Error(
        `TN_REGISTRY_INSTALL_ANDROID_PREBUILT_MISMATCH: ${entry} in ${apk} hashes to ${actual}, not the published ${expected} for '${key}'.`,
      );
    verified.push(`${key} -> ${entry}`);
  }
  return `Published ${verified.length} ${ANDROID_PROOF_ABI} prebuilt(s) verified byte-for-byte in ${apk}: ${verified.join(", ")}.`;
}

/**
 * Read the prebuilt table out of the installed package, the way a consumer's build read it.
 *
 * A gate that restates the table is a gate that checks last release's contract, and a gate that
 * imports this checkout's copy checks a package the consumer never installed. `curl` is the repo's
 * existing synchronous HTTP idiom (`check-publish-state.ts` heads every release URL with it).
 */
async function installedAndroidPrebuilts(
  project: string,
  run: CommandRunner,
): Promise<{
  artifacts: Record<string, { sha256: string }>;
  proofs: readonly IAndroidPrebuiltProof[];
}> {
  const root = path.join(project, "node_modules", "@threenative", "runtime-native");
  const scripts = path.join(root, "scripts");
  const read = async <T>(file: string): Promise<T> => {
    const modulePath = path.join(scripts, file);
    if (!fs.existsSync(modulePath))
      throw new Error(
        `TN_REGISTRY_INSTALL_ANDROID_NO_RUNTIME_SCRIPTS: the installed runtime-native ships no scripts/${file}, so the Android leg cannot read the prebuilt contract it built with.`,
      );
    return (await import(pathToFileURL(modulePath).href)) as T;
  };
  const version = (
    JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
      version?: unknown;
    }
  ).version;
  if (typeof version !== "string" || version.length === 0)
    throw new Error(
      "TN_REGISTRY_INSTALL_ANDROID_NO_RUNTIME_VERSION: the installed runtime-native has no version.",
    );
  const manifestUrl = (
    await read<{ releaseManifestUrl: (version?: string) => string }>("install-prebuilt.mjs")
  ).releaseManifestUrl(version);
  // `--fail`, so a version with no published release is reported as a missing release rather than as
  // the 404 page failing to parse. Both fail the step; only one of them says what to go and fix.
  const lock = run(
    "curl",
    ["--silent", "--show-error", "--fail", "--location", manifestUrl],
    project,
  );
  let manifest: { artifacts?: Record<string, { sha256?: unknown }> };
  try {
    manifest = JSON.parse(lock) as { artifacts?: Record<string, { sha256?: unknown }> };
  } catch (error) {
    throw new Error(
      `TN_REGISTRY_INSTALL_ANDROID_MANIFEST: the installed runtime-native ${version} published no readable prebuilt release at ${manifestUrl}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const artifacts = manifest.artifacts ?? {};
  const proofs = androidApkPrebuiltProofs(
    (await read<{ ANDROID_PREBUILT_V8_ASSETS: Record<string, string> }>("package-android.mjs"))
      .ANDROID_PREBUILT_V8_ASSETS,
  );
  return { artifacts: artifacts as Record<string, { sha256: string }>, proofs };
}

/**
 * The consumer's Android leg: build the APK, then prove it carries the published prebuilt cohort.
 *
 * No engine checkout, no `THREENATIVE_RUNTIME_SOURCE`, and the release URL comes from the installed
 * package's own function, so the step fails if the version a stranger installed has no published
 * Android arm64 prebuilt.
 */
export async function androidStep(
  project: string,
  run: CommandRunner,
  command: string,
  build: readonly string[],
): Promise<string> {
  const output = await run(command, build, project);
  const apk = androidOutput(project);
  const { artifacts, proofs } = await installedAndroidPrebuilts(project, run);
  return `${output}\nAPK: ${apk}\n${assertPublishedApkPrebuilts(apk, readZipEntries(apk), artifacts, proofs)}`;
}

function assertDoctorTargetCensus(output: string): string {
  for (const target of ["web", "desktop", "android", "ios"] as const) {
    const line = new RegExp(`^[✓!✗] target ${target}: (?:available|unavailable)`, "imu");
    if (!line.test(output))
      throw new Error(`Doctor text did not report target ${target} as available or unavailable.`);
  }
  return output;
}

function verifyNativeFrames(project: string, runner: CommandRunner): string {
  const verifier = path.join(
    project,
    "node_modules",
    "@threenative",
    "runtime-native",
    "scripts",
    "verify-starter-desktop.mjs",
  );
  const output = runner("node", [verifier], project);
  const reportPath = path.join(project, "artifacts", "native", "starter-desktop-report.json");
  if (!fs.existsSync(reportPath))
    throw new Error(`Native verifier produced no 300 frames report at ${reportPath}.`);
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as {
    frames?: unknown;
    pass?: unknown;
  };
  if (report.pass !== true || report.frames !== 300)
    throw new Error(
      `Native verifier did not prove 300 frames: pass=${String(report.pass)}, frames=${String(report.frames)}.`,
    );
  return `${output}\nVerified ${report.frames} rendered frames.`;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function mcpStep(project: string, runner: McpRunner): string {
  const configPath = path.join(project, ".mcp.json");
  if (!fs.existsSync(configPath)) throw new Error(`MCP configuration is missing: ${configPath}.`);
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
    mcpServers?: Record<string, { args?: unknown; command?: unknown; env?: unknown }>;
  };
  const servers = parsed.mcpServers;
  if (servers === undefined || Object.keys(servers).length === 0)
    throw new Error("MCP configuration declares no servers.");
  const expected = Object.keys(MCP_SERVERS);
  for (const name of expected) {
    if (servers[name] === undefined)
      throw new Error(`MCP configuration is missing required server '${name}'.`);
  }
  const results: string[] = [];
  for (const name of expected) {
    const server = servers[name];
    if (server === undefined) continue;
    if (typeof server.command !== "string" || !Array.isArray(server.args))
      throw new Error(`MCP server '${name}' has no executable command and argument list.`);
    if (!server.args.every((arg) => typeof arg === "string"))
      throw new Error(`MCP server '${name}' has a non-string argument.`);
    const env =
      typeof server.env === "object" && server.env !== null && !Array.isArray(server.env)
        ? Object.fromEntries(
            Object.entries(server.env as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          )
        : {};
    try {
      const fixture: IMcpFixturePaths =
        name === "threenative-blender"
          ? {
              out: path.join(project, ".registry-mcp", "triangle.glb"),
              source: path.join(project, ".registry-mcp", "triangle.obj"),
            }
          : {};
      if (fixture.source !== undefined && fixture.out !== undefined) {
        fs.mkdirSync(path.dirname(fixture.source), { recursive: true });
        fs.writeFileSync(
          fixture.source,
          "o registry-triangle\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n",
        );
      }
      const first = assertMcpHandshake(
        name,
        runner(
          name,
          server.command,
          server.args as string[],
          project,
          env,
          mcpRequests(name, fixture),
        ),
        MCP_SAFE_TOOLS[name] as string,
      );
      const payload = parseToolPayload(first.operation, name);
      const record = objectRecord(payload);
      if (name === "threenative-assets") {
        if (
          record === undefined ||
          !Array.isArray(record.sources) ||
          typeof record.total !== "number"
        )
          throw new Error(
            "asset_search_sources returned no source directory payload with sources and total.",
          );
        results.push(`${name}: initialize, tools/list and asset_search_sources ok`);
      } else if (name === "threenative-sculpt") {
        if (
          record === undefined ||
          !isNonEmptyString(record.topic) ||
          !isNonEmptyString(record.text)
        )
          throw new Error("sculpt_grimoire returned no technique-safe topic and text.");
        results.push(`${name}: initialize, tools/list and sculpt_grimoire ok`);
      } else if (name === "threenative-engine") {
        const searchRecord = objectRecord(payload);
        const hits = Array.isArray(payload)
          ? payload
          : Array.isArray(searchRecord?.results)
            ? searchRecord.results
            : undefined;
        if (hits === undefined || hits.length === 0)
          throw new Error(
            "engine_search_capabilities returned no capability hits for the plain-words query.",
          );
        const malformedIndex = hits.findIndex((hit) => !isCapabilitySearchHit(hit));
        if (malformedIndex !== -1)
          throw new Error(
            `engine_search_capabilities returned malformed capability hit at index ${malformedIndex}.`,
          );
        const hit = hits[0] as ICapabilitySearchHit;
        const detailOperation = {
          arguments: { symbol: hit.symbol },
          name: "engine_capability_detail",
        };
        const detail = assertMcpHandshake(
          name,
          runner(
            name,
            server.command,
            server.args as string[],
            project,
            env,
            mcpRequests(name, {}, detailOperation),
          ),
          "engine_capability_detail",
        );
        const detailPayload = objectRecord(parseToolPayload(detail.operation, name));
        if (
          detailPayload === undefined ||
          !isNonEmptyString(detailPayload.symbol) ||
          detailPayload.symbol !== hit.symbol
        )
          throw new Error(
            `engine_capability_detail did not return the searched capability '${hit.symbol}'.`,
          );
        results.push(
          `${name}: initialize, tools/list, search and detail ok (${hit.symbol}; ${hits.length} hit(s))`,
        );
      } else if (name === "threenative-blender") {
        if (record === undefined || record.available !== true) {
          const detail = isNonEmptyString(record?.detail)
            ? record.detail
            : "Blender is unavailable";
          const install = isNonEmptyString(record?.installCommand)
            ? ` Install it with: ${record.installCommand}`
            : "";
          throw new Error(`TN_REGISTRY_INSTALL_BLENDER_UNAVAILABLE: ${detail}.${install}`);
        }
        const conversion = assertMcpHandshake(
          name,
          runner(
            name,
            server.command,
            server.args as string[],
            project,
            env,
            mcpRequests(name, fixture, {
              arguments: { out: fixture.out, source: fixture.source },
              name: "blender_convert",
            }),
          ),
          "blender_convert",
        );
        const conversionPayload = objectRecord(parseToolPayload(conversion.operation, name));
        if (
          conversionPayload?.ok !== true ||
          fixture.out === undefined ||
          !fs.existsSync(fixture.out)
        )
          throw new Error("blender_convert did not produce a GLB from the owned OBJ fixture.");
        results.push(`${name}: initialize, tools/list, status and conversion ok`);
      }
    } catch (error) {
      throw new Error(
        `MCP server '${name}' verification failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  for (const [name, server] of Object.entries(servers)) {
    if (expected.includes(name)) continue;
    if (typeof server.command !== "string" || !Array.isArray(server.args))
      throw new Error(`MCP server '${name}' has no executable command and argument list.`);
    results.push(`${name}: preserved user server (not part of the ThreeNative table)`);
  }
  return results.join("; ");
}

export async function verifyRegistryInstall(
  options: IVerifyRegistryInstallOptions = {},
): Promise<IRegistryInstallReport> {
  const template = options.template ?? "starter";
  const candidate = options.candidate;
  const plan = stepPlan(candidate !== undefined);
  const scenario = candidate === undefined ? GAMEPLAY_SCENARIO : UPGRADE_SCENARIO;
  const managers = [
    ...new Set(
      options.packageManagers ??
        (candidate === undefined ? REGISTRY_PACKAGE_MANAGERS : UPGRADE_PACKAGE_MANAGERS),
    ),
  ];
  if (managers.length === 0)
    throw new Error(
      "TN_REGISTRY_INSTALL_NO_PACKAGE_MANAGERS: the clean-room matrix is empty; run npm and pnpm.",
    );
  for (const manager of managers) assertSupportedPackageManager(manager);
  assertSupportedNodeVersion();
  // A private cache and a private store per case, so a package cached from an earlier workspace
  // install cannot stand in for one the registry would have refused to serve.
  const parent = fs.mkdtempSync(
    path.join(options.parent ?? os.tmpdir(), "threenative-clean-room-"),
  );
  const mcp = options.mcp ?? realMcpRunner;
  const steps: IRegistryInstallStep[] = [];
  const consumerTargets = new Map<string, IConsumerTargetRow>();
  try {
    for (const manager of managers) {
      const caseRoot = path.join(parent, manager);
      const cache = path.join(caseRoot, "npm-cache");
      const store = path.join(caseRoot, "pnpm-store");
      const project = path.join(caseRoot, "my-game");
      fs.mkdirSync(caseRoot, { recursive: true });
      fs.mkdirSync(cache, { recursive: true });
      fs.mkdirSync(store, { recursive: true });
      const run =
        options.run ?? realRunner(registryEnvironment(process.env, manager, cache, store));
      const command = manager === "npm" ? "npm" : "pnpm";
      const scaffoldArgs =
        manager === "npm"
          ? [
              "create",
              "threenative@latest",
              "my-game",
              "--",
              "--template",
              template,
              "--no-install",
            ]
          : ["create", "threenative@latest", "my-game", "--template", template, "--no-install"];
      const installArgs =
        manager === "npm" ? ["install", "--cache", cache] : ["install", "--store-dir", store];
      const script = (name: string): readonly string[] =>
        manager === "npm" ? ["run", name] : ["run", name];
      const testCommand = manager === "npm" ? ["run", "test"] : ["test"];
      const doctorCommand =
        manager === "npm"
          ? ["npx", "--no-install", "threenative", "doctor", "--text"]
          : ["pnpm", "exec", "threenative", "doctor", "--text"];

      const prefix = (name: string): string => `${manager}:${name}`;
      const notRun = (name: string, reason: string): void => {
        steps.push({ detail: `Not run: ${reason}`, name: prefix(name), ok: false });
      };

      const scaffold = step(prefix("scaffold"), () => run(command, scaffoldArgs, caseRoot));
      steps.push(scaffold);
      if (!scaffold.ok) {
        for (const name of ["install", ...plan])
          notRun(name, "the scaffold step never produced a project.");
        continue;
      }
      const installed = step(prefix("install"), () => run(command, installArgs, project));
      steps.push(installed);
      if (!installed.ok) {
        for (const name of plan)
          notRun(
            name,
            "the install step failed to produce an installed project; no script-policy bypass was used.",
          );
        continue;
      }
      steps.push(
        step(prefix("lockfile"), () => `Checked ${checkLockfile(project)}; no file: or link:.`),
      );
      if (candidate !== undefined) {
        const surface = step(prefix("surface"), () => {
          (options.surfaceCheck ?? (() => void run("pnpm", ["api:surface:check"], REPO)))();
          return "No public symbol or subpath is removed without a Breaking migration note.";
        });
        steps.push(surface);
        if (!surface.ok) {
          // A candidate that breaks the published surface without saying so is not an upgrade, it
          // is a silent break. Nothing of it is installed, so nothing downstream can pass on it.
          for (const name of plan.slice(plan.indexOf("upgrade")))
            notRun(name, "the public-surface gate refused this candidate before it was installed.");
          continue;
        }
        const upgrade = step(prefix("upgrade"), () => {
          for (const [name, version] of candidate.versions)
            if (candidate.tarballs[name] === undefined)
              throw new Error(
                `TN_REGISTRY_UPGRADE_CANDIDATE_INCOMPLETE: ${name}@${version} has no packed tarball to upgrade onto.`,
              );
          const tarballs = Object.values(candidate.tarballs);
          run(command, [...installArgs, ...tarballs], project);
          // Version first because it names the consumer's mistake; bytes second because the version
          // cannot tell this candidate from the `latest` it was supposed to replace.
          const cohort = assertCandidateInstalled(project, candidate.versions);
          const bytes = assertCandidateIntegrity(project, candidate.tarballs);
          return `Upgraded ${tarballs.length} package(s) onto the candidate cohort: ${cohort}. Installed bytes: ${bytes}.`;
        });
        steps.push(upgrade);
        if (!upgrade.ok) {
          // The tree is on whatever the manager resolved, so building and playing it would prove
          // something about the wrong bytes. Nothing downstream runs.
          for (const name of plan.slice(plan.indexOf("upgrade") + 1))
            notRun(name, "the candidate install failed, so no candidate bytes reached this game.");
          continue;
        }
      }
      steps.push(
        step(prefix("edit"), () => `Applied the game-only edit to ${applyGameOnlyEdit(project)}.`),
      );
      steps.push(step(prefix("build"), () => run(command, script("build"), project)));
      steps.push(step(prefix("test"), () => run(command, testCommand, project)));
      steps.push(
        step(prefix("gameplay"), () => {
          const families = assertScenarioAssertions(
            path.join(project, scenario),
            candidate === undefined ? "the installed starter" : `the upgraded ${template}`,
          );
          const built = assertEditedGameplayInBuild(project);
          // The runner defaults to an already-running `http://127.0.0.1:5173`; nothing here starts
          // one, so the scenario must bring its own dev server the way the template's own test
          // script does. `--browser-recipe webgpu` is required so a SwiftShader run is not mistaken
          // for evidence.
          const serverCommand =
            manager === "npm"
              ? "npm run dev -- --host 127.0.0.1 --port $PORT --strictPort"
              : "pnpm dev --host 127.0.0.1 --port $PORT --strictPort";
          const playtestArgs = [
            "--scenario",
            scenario,
            "--browser-recipe",
            "webgpu",
            // A GPU-less clean room still has to let Chromium reach a driver: `--headed` under the
            // runner's private Xvfb, exactly how golden-path drives the same non-visual list, and
            // `--allow-software` acknowledges a CPU rasteriser rather than letting a hidden
            // SwiftShader run pass as hardware evidence.
            "--headed",
            "--no-screenshots",
            "--allow-software",
            "--server-command",
            serverCommand,
          ];
          // `npx --no-install` for npm, matching the doctor step: `npm exec --no-install` warns on
          // npm 11 and is slated to stop working.
          const output =
            manager === "npm"
              ? run("npx", ["--no-install", "threenative-playtest", ...playtestArgs], project)
              : run(command, ["exec", "threenative-playtest", ...playtestArgs], project);
          return `Ran ${scenario} (assertions: ${families}); edit present in ${built}. ${output}`;
        }),
      );
      // The upgrade claim stops at web; `doctor`, the native host and the MCP table describe the
      // published tree, which the post-publish clean-room lane still runs in full.
      if (candidate !== undefined) continue;
      steps.push(
        step(prefix("doctor"), () =>
          assertDoctorTargetCensus(
            run(doctorCommand[0] as string, doctorCommand.slice(1), project),
          ),
        ),
      );
      steps.push(
        step(prefix("native"), () => {
          const output = run(command, script("build:desktop"), project);
          const executable = nativeOutput(project);
          const proof = verifyNativeFrames(project, run);
          // The verifier records one qualified gameplay row per distributed target and arm it ran;
          // thread them through so each arm's machine and artifact identity survives instead of
          // collapsing a phone and an emulator of one target into a single row.
          const rows = readConsumerTargetRows(project);
          for (const row of rows) consumerTargets.set(consumerTargetKey(row), row);
          // Fail closed: the rows gate the target, so a row the verifier marked failed fails the
          // cohort — and so does one that asserted nothing, whatever `pass` says, because an empty
          // assertion set is a failure and a row that evaluated zero assertions proved nothing. The
          // rows are already in the map above, so the returned report still names the run's own
          // diagnostic rather than only this abort, which repeats it verbatim.
          const failed = rows.filter((row) => !row.pass || row.assertions === 0);
          if (failed.length > 0)
            throw new Error(
              `TN_REGISTRY_INSTALL_CONSUMER_TARGET_FAILED: ${failed
                .map(
                  (row) =>
                    `${consumerTargetKey(row)} — ${row.assertions === 0 ? "evaluated zero assertions: " : ""}${row.failures.join("; ") || "no failures recorded"}`,
                )
                .join(" | ")}`,
            );
          const targets = rows
            .map((row) => `${consumerTargetKey(row)} artifact ${row.artifactHash.slice(0, 12)}`)
            .join(", ");
          return `${output}\nExecutable: ${executable}\n${proof}${targets.length > 0 ? `\nConsumer targets: ${targets}` : ""}`;
        }),
      );
      steps.push(
        await stepAsync(prefix("android"), () =>
          androidStep(project, run, command, script("build:android")),
        ),
      );
      steps.push(step(prefix("mcp"), () => mcpStep(project, mcp)));
    }
  } finally {
    fs.rmSync(parent, { force: true, recursive: true });
  }
  return {
    consumerTargets: [...consumerTargets.values()],
    exitCode: steps.every((item) => item.ok) ? 0 : 1,
    managers,
    steps,
  };
}

async function main(): Promise<void> {
  const report = await verifyRegistryInstall();
  for (const item of report.steps)
    process.stdout.write(`${item.ok ? "pass" : "FAIL"}  ${item.name}\n      ${item.detail}\n`);
  process.stdout.write(
    report.exitCode === 0
      ? "A stranger can install ThreeNative from the registry and build a game.\n"
      : "The registry install path is broken. This is alpha row A1.\n",
  );
  process.exitCode = report.exitCode;
}

// `void`, not a top-level `await`: this file is also loaded as CommonJS by a scoped caller, and
// esbuild refuses top-level await in that output format. The process stays alive until the promise
// settles, and every await inside is a resolved module read rather than an open handle.
if (import.meta.url === `file://${process.argv[1]}`) void main();
