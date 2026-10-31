import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverKitManifests, templateRoot } from "../packages/create-threenative/src/index.js";
import { workspacePackageSourceFlag } from "./workspace-packages.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_FILE = "package.json";
const REQUIRED_DEPENDENCIES = ["vite", "create-threenative"] as const;
const MCP_PROTOCOL_VERSION = "2025-06-18";
// A cold MCP server start has to answer `initialize`, and on a loaded runner that start can
// outlive 30s through no fault of the server: four golden-path template legs across runs
// 33829801266, 33830264158 and 33831658062 timed `initialize` out at 30s at layer 'mcp' while
// the same legs passed on quieter runs. 60s, plus the one re-send in probeMcpServer, keeps a
// slow start from failing the lane without letting a server that will never answer fail slowly.
const MCP_REQUEST_TIMEOUT_MS = 60_000;
const SCULPT_RESOURCE_UNSAFE_BLOCK =
  /```(?:glsl|wgsl|(?:java|type)script|[jt]s)\b[\s\S]*?(?:ShaderMaterial|onBeforeCompile|diffuseColor|gl_FragColor|new\s+Mesh(?:Standard|Physical|Phong|Basic|Lambert|Toon)Material)/u;

export const MCP_SURFACES = [
  { name: "threenative-assets", file: "asset-mcp-tools.json" },
  { name: "threenative-sculpt", file: "sculpt-mcp-tools.json" },
  { name: "threenative-engine", file: "engine-mcp-tools.json" },
  { name: "threenative-animation", file: "animation-mcp-tools.json" },
  { name: "threenative-devtools", file: "devtools-mcp-tools.json" },
] as const;

const AUTHORING_CAPABILITIES = [
  "AudioBus",
  "FluidField2D",
  "GPUParticles3D",
  "GPUReadback",
  "Heightfield",
  "NavigationAgent3D",
  "RigidBody3D",
  "SoftBody3D",
  "SpectralOcean",
  "attachToBone",
] as const;

export const GOLDEN_PATH_STEPS = [
  "pack",
  "scaffold",
  "install",
  "mcp",
  "dev",
  "test",
  "build web",
  "assert artifact",
] as const;

export type GoldenPathStep = (typeof GOLDEN_PATH_STEPS)[number];
export type TemplateStep = Exclude<GoldenPathStep, "pack">;

interface IPackageManifest {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly name?: string;
  readonly optionalDependencies?: Record<string, string>;
  readonly version?: string;
}

interface IWorkspacePackage {
  readonly directory: string;
  readonly manifest: IPackageManifest & { readonly name: string };
}

export type PackageSources = Readonly<Record<string, string>>;

export interface ICorrectiveCommand {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd: string;
}

export interface IMcpServerConfig {
  readonly args: readonly string[];
  readonly command: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface IMcpSurface {
  readonly tools: readonly string[];
  readonly version: string;
}

export interface IGoldenPathTemplateActions {
  readonly assertArtifact: () => Promise<void>;
  readonly buildWeb: () => Promise<void>;
  readonly dev: () => Promise<void>;
  readonly install: () => Promise<void>;
  readonly mcp: () => Promise<void>;
  readonly scaffold: () => Promise<void>;
  readonly test: () => Promise<void>;
}

interface IMcpPendingRequest {
  readonly reject: (reason?: unknown) => void;
  readonly resolve: (value: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface IMcpOutputState {
  buffer: string;
}

export function assertGoldenPathSteps(steps: readonly string[]): void {
  const expected = JSON.stringify(GOLDEN_PATH_STEPS);
  const actual = JSON.stringify(steps);
  if (actual !== expected) {
    const missing = GOLDEN_PATH_STEPS.filter((step) => !steps.includes(step));
    throw new Error(
      `TN_GOLDEN_PATH_PLAN_INVALID: expected ${expected}; received ${actual}; missing ${
        missing.join(", ") || "none"
      }.`,
    );
  }
}

/**
 * Which templates this lane drives.
 *
 * The lane's subject is one sentence: *a stranger can scaffold a project, install it, build it and
 * play it.* One template proves that chain end to end. Running all of them re-proves the same
 * chain N times and, incidentally, runs every template's whole scenario suite on a machine with no
 * GPU — which is where this lane spent three hours failing on things that were true of a scenario
 * rather than of the golden path: a coyote window shorter than the wait that tested it, a template
 * whose every scenario needs pixels, an exact health at a labelled step.
 *
 * `TN_GOLDEN_PATH_TEMPLATES` narrows it. CI sets it to the default template, because the default
 * is what a stranger actually gets; the rest keep their proof in `pnpm test:templates`, which is
 * the gate that exists for per-template scenarios and has hardware.
 *
 * Unset, it still drives every template — a developer running this by hand gets the full sweep.
 */
export function discoverGoldenPathTemplates(root = templateRoot()): readonly string[] {
  const templates = discoverKitManifests(root).map(({ name }) => name);
  if (templates.length === 0) {
    throw new Error("TN_GOLDEN_PATH_TEMPLATES_EMPTY: no templates found.");
  }
  const requested = (process.env.TN_GOLDEN_PATH_TEMPLATES ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (requested.length === 0) return templates;
  const unknown = requested.filter((name) => !templates.includes(name));
  if (unknown.length > 0) {
    throw new Error(
      `TN_GOLDEN_PATH_TEMPLATE_UNKNOWN: ${unknown.join(", ")}. Known: ${templates.join(", ")}.`,
    );
  }
  return requested;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function commandLine(command: string, args: readonly string[]): string {
  return [command, ...args].map(shellQuote).join(" ");
}

export function formatCorrectiveCommand(command: ICorrectiveCommand): string {
  return `(cd ${shellQuote(command.cwd)} && ${commandLine(command.command, command.args)})`;
}

export function goldenPathCorrectiveCommands(
  project: string,
  devPort = 4173,
): Readonly<Record<TemplateStep, ICorrectiveCommand>> {
  const target = path.resolve(project);
  return {
    scaffold: {
      args: [path.basename(target)],
      command: "./scaffold.sh",
      cwd: path.dirname(target),
    },
    install: {
      args: ["install", "--reporter", "append-only"],
      command: "pnpm",
      cwd: target,
    },
    mcp: {
      args: ["install", "--reporter", "append-only"],
      command: "pnpm",
      cwd: target,
    },
    dev: {
      args: ["dev", "--host", "127.0.0.1", "--port", String(devPort), "--strictPort"],
      command: "pnpm",
      cwd: target,
    },
    test: goldenPathTestStep(target),
    "build web": {
      args: ["exec", "threenative", "build", "--target", "web"],
      command: "pnpm",
      cwd: target,
    },
    "assert artifact": {
      args: ["exec", "threenative", "build", "--target", "web"],
      command: "pnpm",
      cwd: target,
    },
  };
}

export async function runGoldenPathTemplate(
  template: string,
  actions: IGoldenPathTemplateActions,
  project = template,
  commands?: Readonly<Record<TemplateStep, ICorrectiveCommand>>,
): Promise<readonly TemplateStep[]> {
  const executed: TemplateStep[] = [];
  const correctiveCommands = commands ?? goldenPathCorrectiveCommands(project);
  const runStep = async (step: TemplateStep, action: () => Promise<void>): Promise<void> => {
    executed.push(step);
    process.stdout.write(`golden-path ${template}: ${step}\n`);
    try {
      await action();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `TN_GOLDEN_PATH_FAILED: template '${template}' at layer '${step}' in project '${project}'. Searched: project '${project}'. Corrective command: ${formatCorrectiveCommand(correctiveCommands[step])}. ${detail}`,
      );
    }
  };

  await runStep("scaffold", actions.scaffold);
  await runStep("install", actions.install);
  await runStep("mcp", actions.mcp);
  await runStep("dev", actions.dev);
  await runStep("test", actions.test);
  await runStep("build web", actions.buildWeb);
  await runStep("assert artifact", actions.assertArtifact);
  assertGoldenPathSteps(["pack", ...executed]);
  return executed;
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function readManifest(file: string): Promise<IPackageManifest> {
  return JSON.parse(await readFile(file, "utf8")) as IPackageManifest;
}

export async function workspacePackages(
  packagesRoot = path.join(REPO_ROOT, "packages"),
): Promise<readonly IWorkspacePackage[]> {
  const entries = await readdir(packagesRoot, { withFileTypes: true });
  const packages: IWorkspacePackage[] = [];
  const skipped: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(packagesRoot, entry.name);
    const manifestPath = path.join(directory, PACKAGE_FILE);
    // A directory under packages/ with no manifest is not a workspace package. Anyone with a
    // leftover build directory from another branch has one, and this used to fail the whole gate
    // with a raw ENOENT naming a file rather than the directory that caused it.
    if (!(await pathExists(manifestPath))) {
      skipped.push(entry.name);
      continue;
    }
    const manifest = await readManifest(manifestPath);
    if (typeof manifest.name !== "string" || manifest.name.length === 0) {
      throw new Error(`TN_GOLDEN_PATH_PACKAGE_INVALID: ${directory} has no package name.`);
    }
    packages.push({ directory, manifest: { ...manifest, name: manifest.name } });
  }
  if (skipped.length > 0) {
    process.stdout.write(
      `TN_GOLDEN_PATH_PACKAGE_SKIPPED: no ${PACKAGE_FILE} under packages/${skipped.join(", packages/")}; not a workspace package, skipping.\n`,
    );
  }
  if (packages.length === 0) {
    throw new Error("TN_GOLDEN_PATH_PACKAGES_EMPTY: no packages found.");
  }
  return packages.sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

async function readMcpSurface(file: string): Promise<IMcpSurface> {
  const value = JSON.parse(await readFile(file, "utf8")) as unknown;
  if (
    !isRecord(value) ||
    typeof value.version !== "string" ||
    !Array.isArray(value.tools) ||
    value.tools.some((tool) => typeof tool !== "string")
  ) {
    throw new Error(`TN_GOLDEN_PATH_MCP_SURFACE_INVALID: ${file}`);
  }
  return { tools: value.tools, version: value.version };
}

export function assertMcpToolSurface(
  serverName: string,
  expected: readonly string[],
  response: unknown,
): void {
  if (!isRecord(response) || !Array.isArray(response.tools)) {
    throw new Error(`TN_GOLDEN_PATH_MCP_TOOLS_INVALID: ${serverName} returned no tools list.`);
  }
  const actual = response.tools.map((tool) => {
    if (!isRecord(tool) || typeof tool.name !== "string") {
      throw new Error(`TN_GOLDEN_PATH_MCP_TOOL_INVALID: ${serverName} returned a nameless tool.`);
    }
    return tool.name;
  });
  const expectedNames = [...expected].sort();
  const actualNames = [...actual].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(
      `${serverName} surface drifted.\nexpected ${expectedNames.length}: ${expectedNames.join(
        ", ",
      )}\nactual ${actualNames.length}: ${actualNames.join(", ")}`,
    );
  }
}

async function assertSculptResources(
  request: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
): Promise<void> {
  const listed = await request("resources/list");
  if (!isRecord(listed) || !Array.isArray(listed.resources) || listed.resources.length === 0) {
    throw new Error("threenative-sculpt listed no technique resources.");
  }
  for (const resource of listed.resources) {
    if (!isRecord(resource) || typeof resource.uri !== "string") {
      throw new Error("threenative-sculpt returned a resource without a URI.");
    }
    const read = await request("resources/read", { uri: resource.uri });
    if (!isRecord(read) || !Array.isArray(read.contents)) {
      throw new Error(`threenative-sculpt resource '${resource.uri}' could not be read.`);
    }
    const text = read.contents
      .map((content) => (isRecord(content) && typeof content.text === "string" ? content.text : ""))
      .join("\n");
    if (text.trim().length === 0) {
      throw new Error(`threenative-sculpt resource '${resource.uri}' was empty.`);
    }
    if (SCULPT_RESOURCE_UNSAFE_BLOCK.test(text)) {
      throw new Error(`Sculpt grimoire resource owns the look: ${resource.uri}`);
    }
  }
}

function parseMcpToolPayload(value: unknown, operation: string): unknown {
  if (!isRecord(value) || !Array.isArray(value.content)) {
    throw new Error(`threenative-engine ${operation} returned no content.`);
  }
  const text = value.content
    .map((item) => (isRecord(item) && typeof item.text === "string" ? item.text : ""))
    .join("");
  if (text.trim().length === 0) {
    throw new Error(`threenative-engine ${operation} returned empty content.`);
  }
  return JSON.parse(text) as unknown;
}

function assertNetworkingSearch(value: unknown): void {
  if (
    !isRecord(value) ||
    value.verdict !== "matched" ||
    value.guidance !== "" ||
    !Array.isArray(value.results) ||
    !value.results.every(isRecord)
  ) {
    throw new Error("threenative-engine is missing portable networking transport metadata.");
  }
  const transport = value.results.find(
    (entry) => entry.symbol === "connect" && entry.importPath === "@threenative/core/net",
  );
  const constraints = transport?.constraints;
  if (
    !Array.isArray(constraints) ||
    !constraints.every((constraint) => typeof constraint === "string") ||
    !constraints.join(" ").includes("HTTPS") ||
    !constraints.join(" ").includes("queues")
  ) {
    throw new Error("threenative-engine is missing portable networking transport metadata.");
  }
}

function assertNetworkingDetail(value: unknown): void {
  if (
    !isRecord(value) ||
    value.symbol !== "connect" ||
    value.importPath !== "@threenative/core/net" ||
    !Array.isArray(value.constraints) ||
    !value.constraints.every((constraint) => typeof constraint === "string") ||
    !Array.isArray(value.overrides) ||
    !value.overrides.every((override) => typeof override === "string") ||
    !value.overrides.some((override) => override.includes("maxQueuedReliableBytes"))
  ) {
    throw new Error("threenative-engine returned incomplete portable networking detail.");
  }
}

export async function assertEngineCapabilityDiscovery(
  request: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
): Promise<void> {
  const called = await request("tools/call", {
    arguments: {
      scope: "request",
      situation:
        "sailing ship on ocean waves with buoyancy, cloth sails in wind, cannonball physics and smoke particles, crew navigating a deck with swords, islands and coastlines, and positional sound",
    },
    name: "engine_search_capabilities",
  });
  if (!isRecord(called) || !Array.isArray(called.content)) {
    throw new Error("threenative-engine returned no content for the authoring request.");
  }
  const text = called.content
    .map((item) => (isRecord(item) && typeof item.text === "string" ? item.text : ""))
    .join("");
  const parsed = JSON.parse(text) as unknown;
  if (
    !isRecord(parsed) ||
    (parsed.verdict !== "matched" && parsed.verdict !== "none") ||
    !Array.isArray(parsed.results) ||
    typeof parsed.guidance !== "string"
  ) {
    throw new Error("threenative-engine returned an invalid capability search response.");
  }
  if (parsed.verdict !== "matched" || parsed.results.length === 0 || parsed.guidance !== "") {
    throw new Error("threenative-engine authoring request did not return matched capabilities.");
  }
  if (!parsed.results.every(isRecord)) {
    throw new Error("threenative-engine returned a malformed capability result.");
  }
  const results = parsed.results;
  const symbols = results.flatMap((entry) =>
    typeof entry.symbol === "string" ? [entry.symbol] : [],
  );
  const missing = AUTHORING_CAPABILITIES.filter((symbol) => !symbols.includes(symbol));
  if (missing.length > 0) {
    throw new Error(`threenative-engine authoring request missed: ${missing.join(", ")}.`);
  }
  if (results.some((entry) => typeof entry.matchedSituation !== "string")) {
    throw new Error("threenative-engine returned a capability without matchedSituation evidence.");
  }

  const networkingCall = await request("tools/call", {
    arguments: {
      scope: "request",
      situation: "exchange authenticated multiplayer messages over WebTransport",
    },
    name: "engine_search_capabilities",
  });
  assertNetworkingSearch(parseMcpToolPayload(networkingCall, "networking search"));

  const detailCall = await request("tools/call", {
    arguments: { symbol: "connect" },
    name: "engine_capability_detail",
  });
  assertNetworkingDetail(parseMcpToolPayload(detailCall, "networking detail"));
}

function resolveMcpMessage(value: unknown, pending: Map<number, IMcpPendingRequest>): void {
  if (!isRecord(value) || typeof value.id !== "number") return;
  const waiter = pending.get(value.id);
  if (waiter === undefined) return;
  pending.delete(value.id);
  clearTimeout(waiter.timer);
  if (value.error !== undefined) waiter.reject(new Error(JSON.stringify(value.error)));
  else waiter.resolve(value.result);
}

function consumeMcpOutput(
  chunk: Buffer | string,
  state: IMcpOutputState,
  pending: Map<number, IMcpPendingRequest>,
): void {
  state.buffer += chunk.toString();
  const lines = state.buffer.split(/\r?\n/u);
  state.buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim().startsWith("{")) continue;
    try {
      resolveMcpMessage(JSON.parse(line) as unknown, pending);
    } catch {
      // MCP servers may log non-JSON lines to stdout; pending requests still time out.
    }
  }
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode === null) {
    if (process.platform === "win32" || child.pid === undefined) child.kill("SIGTERM");
    else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
  }
  const exited = child.exitCode === null ? once(child, "exit") : Promise.resolve();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

function assertInstalledNetworkingExport(cwd: string): void {
  try {
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import { connect } from "@threenative/core/net"; if (typeof connect !== "function") throw new Error("connect is not a function");',
      ],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    process.stdout.write(`threenative-engine installed @threenative/core/net: connect (${cwd})\n`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `threenative-engine installed @threenative/core/net import failed in '${cwd}': ${detail}`,
    );
  }
}

async function assertPackedEngineNetworking(
  request: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  cwd: string,
): Promise<void> {
  await assertEngineCapabilityDiscovery(request);
  assertInstalledNetworkingExport(cwd);
}

async function probeProjectManifestFallback(
  target: string,
  configPath: string,
  servers: Record<string, unknown>,
): Promise<void> {
  const projectManifest = path.join(target, "capabilities.json");
  const hiddenManifest = path.join(target, ".capabilities.golden-path-backup.json");
  const engine = servers["threenative-engine"];
  if (!isRecord(engine) || typeof engine.command !== "string" || !Array.isArray(engine.args)) {
    throw new Error(`TN_GOLDEN_PATH_MCP_SERVER_MISSING: ${configPath} lacks 'threenative-engine'.`);
  }
  // The scaffold ships no project copy, so the installed-core fallback is the only path there is.
  // A copy that does exist is still moved aside, so a project that grows one back cannot hide a
  // broken packaged manifest behind it.
  const hidden = existsSync(projectManifest);
  if (hidden) await rename(projectManifest, hiddenManifest);
  try {
    await probeMcpServer(
      "threenative-engine",
      {
        args: engine.args.filter((argument): argument is string => typeof argument === "string"),
        command: engine.command,
        ...(isStringRecord(engine.env) ? { env: engine.env } : {}),
      },
      await readMcpSurface(
        path.join(REPO_ROOT, "packages/create-threenative", "engine-mcp-tools.json"),
      ),
      target,
    );
  } finally {
    if (hidden) await rename(hiddenManifest, projectManifest);
  }
}

export async function probeMcpServer(
  serverName: string,
  server: IMcpServerConfig,
  surface: IMcpSurface,
  cwd: string,
): Promise<void> {
  const child = spawn(server.command, [...server.args], {
    cwd,
    env: { ...process.env, ...server.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const output: IMcpOutputState = { buffer: "" };
  let stderr = "";
  let terminalError: Error | undefined;
  const pending = new Map<number, IMcpPendingRequest>();
  const failPending = (error: Error): void => {
    terminalError = error;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  };
  child.stdout?.on("data", (chunk: Buffer | string) => consumeMcpOutput(chunk, output, pending));
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  child.once("error", (error) => {
    failPending(error instanceof Error ? error : new Error(String(error)));
  });
  child.once("exit", (code, signal) => {
    const detail = stderr.trim().slice(-500);
    failPending(
      new Error(
        `${serverName} exited before completing MCP requests (${code ?? `signal ${signal ?? "unknown"}`})${detail.length > 0 ? `: ${detail}` : ""}.`,
      ),
    );
  });

  let nextId = 1;
  const request = (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
    if (terminalError !== undefined) return Promise.reject(terminalError);
    const id = nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        const detail = stderr.trim().slice(-500);
        reject(
          new Error(
            `${serverName} ${method} timed out after ${MCP_REQUEST_TIMEOUT_MS}ms${detail.length > 0 ? `: ${detail}` : ""}.`,
          ),
        );
      }, MCP_REQUEST_TIMEOUT_MS);
      pending.set(id, { reject, resolve, timer });
      try {
        child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  };

  // One re-send, for `initialize` only: the timeout above fires while a cold server is still
  // starting, and the request that proves the server works is the one that pays for it. The
  // timed-out id is already deleted from `pending`, so a late first response resolves nothing
  // and cannot double-complete; a server that cannot answer twice will not answer at all.
  const requestWithOneRetry = async (
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> => {
    try {
      return await request(method, params);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("timed out")) throw error;
      return await request(method, params);
    }
  };

  try {
    await requestWithOneRetry("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "threenative-golden-path", version: "0" },
    });
    child.stdin?.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    const listed = await request("tools/list");
    assertMcpToolSurface(serverName, surface.tools, listed);
    if (serverName === "threenative-sculpt") await assertSculptResources(request);
    if (serverName === "threenative-engine") await assertPackedEngineNetworking(request, cwd);
    process.stdout.write(
      `${serverName} ok: ${surface.tools.length} tools from ${surface.version}\n`,
    );
  } finally {
    await stopProcess(child);
  }
}

export async function assertMcpServers(target: string): Promise<void> {
  const configPath = path.join(target, ".mcp.json");
  const parsed = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
    throw new Error(`TN_GOLDEN_PATH_MCP_CONFIG_INVALID: ${configPath} has no mcpServers.`);
  }
  for (const { file, name } of MCP_SURFACES) {
    const rawServer = parsed.mcpServers[name];
    if (!isRecord(rawServer) || typeof rawServer.command !== "string") {
      throw new Error(`TN_GOLDEN_PATH_MCP_SERVER_MISSING: ${configPath} lacks '${name}'.`);
    }
    const args = rawServer.args;
    if (
      !Array.isArray(args) ||
      !args.every((argument): argument is string => typeof argument === "string")
    ) {
      throw new Error(`TN_GOLDEN_PATH_MCP_ARGS_INVALID: ${configPath} has invalid '${name}' args.`);
    }
    const env = rawServer.env;
    if (env !== undefined && !isStringRecord(env)) {
      throw new Error(`TN_GOLDEN_PATH_MCP_ENV_INVALID: ${configPath} has invalid '${name}' env.`);
    }
    await probeMcpServer(
      name,
      {
        args,
        command: rawServer.command,
        ...(env === undefined ? {} : { env }),
      },
      await readMcpSurface(path.join(REPO_ROOT, "packages/create-threenative", file)),
      target,
    );
  }

  // No scaffold-owned capabilities.json exists to hide behind: prove the packed core shim answers
  // from the manifest inside its own tarball, which is the only surface a project has.
  await probeProjectManifestFallback(target, configPath, parsed.mcpServers);
}

export async function runCommand(
  layer: GoldenPathStep,
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<void> {
  const printable = commandLine(command, args);
  const correctiveCommand: ICorrectiveCommand = { args, command, cwd };
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, stdio: "inherit" });
    child.once("error", (error) => {
      reject(
        new Error(
          `TN_GOLDEN_PATH_COMMAND_FAILED: layer '${layer}' failed in project '${cwd}'. Searched: project '${cwd}' and PATH for '${command}'. Corrective command: ${formatCorrectiveCommand(correctiveCommand)}. ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    });
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `TN_GOLDEN_PATH_COMMAND_FAILED: layer '${layer}' failed in project '${cwd}'. Searched: project '${cwd}' and PATH for '${command}'. Corrective command: ${formatCorrectiveCommand(correctiveCommand)}. ${printable} exited ${code ?? `by ${signal ?? "unknown"}`}.`,
          ),
        );
      }
    });
  });
}

async function runRecordedGlobalStep(
  step: "pack",
  executed: GoldenPathStep[],
  action: () => Promise<void>,
): Promise<void> {
  executed.push(step);
  process.stdout.write(`golden-path all templates: ${step}\n`);
  try {
    await action();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `TN_GOLDEN_PATH_FAILED: all templates at layer '${step}' in project '${REPO_ROOT}'. Searched: repository '${REPO_ROOT}' and temporary package staging. Corrective command: ${formatCorrectiveCommand({ args: ["verify:golden-path"], command: "pnpm", cwd: REPO_ROOT })}. ${detail}`,
    );
  }
}

export async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(file));
  return hash.digest("hex");
}

async function packTarball(
  workspacePackage: IWorkspacePackage,
  staging: string,
  fromWorkspace: boolean,
): Promise<string> {
  await runCommand(
    "pack",
    "pnpm",
    fromWorkspace
      ? ["--filter", workspacePackage.manifest.name, "pack", "--pack-destination", staging]
      : ["pack", "--pack-destination", staging],
    fromWorkspace ? REPO_ROOT : workspacePackage.directory,
  );
  const prefix = workspacePackage.manifest.name.startsWith("@")
    ? workspacePackage.manifest.name.slice(1).replace("/", "-")
    : workspacePackage.manifest.name;
  const files = (await readdir(staging)).filter(
    (file) => file.startsWith(`${prefix}-`) && file.endsWith(".tgz"),
  );
  const tarball = files.sort().at(-1);
  if (tarball === undefined) {
    throw new Error(
      `TN_GOLDEN_PATH_PACK_MISSING: pnpm pack produced no tarball for ${workspacePackage.manifest.name}.`,
    );
  }
  const result = path.join(staging, tarball);
  process.stdout.write(
    `golden-path packed ${workspacePackage.manifest.name}: source '${workspacePackage.directory}' -> tarball '${result}' sha256:${await sha256(result)}\n`,
  );
  return result;
}

export async function packPackageSource(packageRoot: string, staging: string): Promise<string> {
  const manifest = await readManifest(path.join(packageRoot, PACKAGE_FILE));
  if (typeof manifest.name !== "string" || manifest.name.length === 0) {
    throw new Error(`TN_GOLDEN_PATH_PACKAGE_INVALID: ${packageRoot} has no package name.`);
  }
  return packTarball(
    { directory: packageRoot, manifest: { ...manifest, name: manifest.name } },
    staging,
    false,
  );
}

export async function packWorkspace(staging: string, build = true): Promise<PackageSources> {
  if (build) {
    await runCommand("pack", "pnpm", ["--filter", "./packages/**", "build"], REPO_ROOT);
  }
  const packages = await workspacePackages();
  const sources: Record<string, string> = {};
  for (const workspacePackage of packages) {
    sources[workspacePackage.manifest.name] = await packTarball(workspacePackage, staging, true);
  }
  return sources;
}

/** The tarball `pnpm pack` writes for a package name, e.g. `@threenative/core` -> `threenative-core-`. */
export function packedArchivePrefix(packageName: string): string {
  return packageName.startsWith("@")
    ? `${packageName.slice(1).replace("/", "-")}-`
    : `${packageName}-`;
}

/**
 * Take the workspace tarballs someone else already packed, instead of packing them again.
 *
 * CI's `build` job compiles the workspace and packs every package, publishes the set as an
 * artifact, and the golden-path job downloads it before this script runs. Packing again here costs
 * the workspace `tsc` a second time plus ten `pnpm pack` runs — measured at 425s for the whole
 * `verify:golden-path` step on run 33710335121, against a 472s job on a 570s critical path.
 *
 * What the pack step proves is not lost by adopting: `build` runs the identical
 * `workspace-packages.ts` walk and `pnpm pack`, fails the run when it produces no files, and the
 * mutation control below still packs a deliberately-broken copy here and asserts its tarball
 * differs from the adopted one. What would be lost is *silence* — so this fails closed twice
 * over: every workspace package must resolve to exactly one archive, and an archive naming a
 * package the workspace no longer has is drift rather than a spare file.
 */
export async function adoptPackedWorkspace(archives: string): Promise<PackageSources> {
  let entries: string[];
  try {
    entries = (await readdir(archives)).filter((file) => file.endsWith(".tgz"));
  } catch {
    throw new Error(
      `TN_GOLDEN_PATH_ARCHIVES_UNREADABLE: '${archives}' is not a readable directory of packed tarballs.`,
    );
  }
  const packages = await workspacePackages();
  const sources: Record<string, string> = {};
  const claimed = new Set<string>();
  for (const workspacePackage of packages) {
    const prefix = packedArchivePrefix(workspacePackage.manifest.name);
    const matches = entries.filter((file) => file.startsWith(prefix)).sort();
    const tarball = matches.at(-1);
    if (tarball === undefined) {
      throw new Error(
        `TN_GOLDEN_PATH_ARCHIVE_MISSING: no '${prefix}*.tgz' in '${archives}' for ${workspacePackage.manifest.name}.`,
      );
    }
    for (const match of matches) claimed.add(match);
    const resolved = path.join(archives, tarball);
    sources[workspacePackage.manifest.name] = resolved;
    process.stdout.write(
      `golden-path adopted ${workspacePackage.manifest.name}: tarball '${resolved}' sha256:${await sha256(resolved)}\n`,
    );
  }
  const unclaimed = entries.filter((file) => !claimed.has(file)).sort();
  if (unclaimed.length > 0) {
    throw new Error(
      `TN_GOLDEN_PATH_ARCHIVE_UNKNOWN: '${archives}' holds ${unclaimed.join(", ")}, which no workspace package claims.`,
    );
  }
  return sources;
}

function declaredDependencies(manifest: IPackageManifest): Set<string> {
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]);
}

export function assertTemplateDependencies(
  template: string,
  manifest: IPackageManifest,
  sources: PackageSources,
): Set<string> {
  const declared = declaredDependencies(manifest);
  for (const dependency of REQUIRED_DEPENDENCIES) {
    if (declared.has(dependency)) continue;
    throw new Error(
      `TN_GOLDEN_PATH_DEPENDENCY_MISSING: template '${template}' is missing dependency '${dependency}'. Add '${dependency}' to package.json and rerun pnpm verify:golden-path.`,
    );
  }
  for (const dependency of declared) {
    if (!dependency.startsWith("@threenative/") && dependency !== "create-threenative") continue;
    if (sources[dependency] !== undefined) continue;
    throw new Error(
      `TN_GOLDEN_PATH_PACK_MISSING: template '${template}' declares packed dependency '${dependency}', but no tarball was produced.`,
    );
  }
  return declared;
}

export async function writeScaffoldScript(
  directory: string,
  template: string,
  cliSource: string,
  packageArgs: readonly string[],
  options: {
    readonly cliRuntimePackages?: readonly string[];
    readonly ignoreInstallScripts?: boolean;
    readonly noInstall?: boolean;
  } = {},
): Promise<string> {
  const script = path.join(directory, "scaffold.sh");
  const target = '"${1:-game}"';
  const invocation = [
    ...(options.ignoreInstallScripts ? ["npm_config_ignore_scripts=true"] : []),
    "pnpm",
    "dlx",
    "--silent",
    "--package",
    cliSource,
    ...(options.cliRuntimePackages ?? []).flatMap((source) => ["--package", source]),
    "create-threenative",
    target,
    "--template",
    template,
    ...(options.noInstall ? ["--no-install"] : []),
    ...packageArgs,
  ]
    .map((argument) => (argument === target ? argument : shellQuote(argument)))
    .join(" ");
  await writeFile(script, `#!/bin/sh\nset -eu\n${invocation}\n`);
  await chmod(script, 0o755);
  return script;
}

/**
 * A packed package installs its own `@threenative/*` dependencies too (the engine player's runtime
 * depends on three-native), and none of them is on the npm registry before a release. The scaffold
 * overrides those from the same packed set.
 */
async function withPackedDependencies(
  declared: ReadonlySet<string>,
  sources: PackageSources,
): Promise<ReadonlySet<string>> {
  const manifests = new Map(
    (await workspacePackages()).map(({ manifest }) => [manifest.name, manifest]),
  );
  const all = new Set(declared);
  for (const name of all) {
    const manifest = manifests.get(name);
    const dependencies = [
      ...Object.keys(manifest?.dependencies ?? {}),
      ...Object.keys(manifest?.optionalDependencies ?? {}),
    ];
    for (const dependency of dependencies)
      if (sources[dependency] !== undefined) all.add(dependency);
  }
  return all;
}

export async function scaffold(
  template: string,
  target: string,
  sources: PackageSources,
  templatesRoot: string,
  options: { readonly ignoreInstallScripts?: boolean; readonly noInstall?: boolean } = {},
): Promise<void> {
  const templateManifest = await readManifest(path.join(templatesRoot, template, PACKAGE_FILE));
  const declared = await withPackedDependencies(declaredDependencies(templateManifest), sources);
  const packageArgs: string[] = [];
  for (const dependency of declared) {
    const source = sources[dependency];
    if (source === undefined) continue;
    packageArgs.push(workspacePackageSourceFlag(dependency), source);
  }
  const cliSource = sources["create-threenative"];
  if (cliSource === undefined) {
    throw new Error("TN_GOLDEN_PATH_CLI_PACK_MISSING: create-threenative was not packed.");
  }
  const directory = path.dirname(target);
  const project = path.basename(target);
  const assetSource = sources["@threenative/assets"];
  await writeScaffoldScript(directory, template, cliSource, packageArgs, {
    ...options,
    ...(assetSource === undefined ? {} : { cliRuntimePackages: [assetSource] }),
  });
  assertTemplateDependencies(template, templateManifest, sources);
  process.stdout.write(`golden-path ${template}: ./scaffold.sh ${project}\n`);
  await runCommand("scaffold", "./scaffold.sh", [project], directory);
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (address === null || typeof address === "string") {
    throw new Error("TN_GOLDEN_PATH_PORT_INVALID");
  }
  return address.port;
}

async function waitForDevServer(
  child: ChildProcess,
  url: string,
  template: string,
  project: string,
  port: number,
): Promise<void> {
  const correctiveCommand = formatCorrectiveCommand(
    goldenPathCorrectiveCommands(project, port).dev,
  );
  // The dev server answers only after the cold asset cook. One ETC1S encode of a template's
  // 4096x2048 sky is 21 s on an idle desktop and passed 30 s on a loaded merge-queue runner (PR 473).
  const deadline = Date.now() + 90_000;
  let lastError = "no response";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `TN_GOLDEN_PATH_DEV_UNAVAILABLE: project '${project}' searched '${url}'; corrective command: ${correctiveCommand}. Dev server exited before responding with code ${child.exitCode}.`,
      );
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `TN_GOLDEN_PATH_DEV_UNAVAILABLE: project '${project}' searched '${url}'; corrective command: ${correctiveCommand}. Dev server for '${template}' did not answer: ${lastError}.`,
  );
}

async function runDev(target: string, template: string, port: number): Promise<void> {
  const child = spawn(
    "pnpm",
    ["dev", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd: target, detached: process.platform !== "win32", stdio: "inherit" },
  );
  const failed = new Promise<never>((_, reject) => {
    child.once("error", (error) => reject(error));
  });
  try {
    await Promise.race([
      waitForDevServer(child, `http://127.0.0.1:${port}/`, template, target, port),
      failed,
    ]);
  } finally {
    await stopProcess(child);
  }
}

async function assertArtifact(target: string, template: string): Promise<void> {
  const artifact = path.join(target, "dist", "index.html");
  const info = await stat(artifact).catch(() => undefined);
  if (info === undefined) {
    throw new Error(`template '${template}' produced no web artifact at '${artifact}'.`);
  }
  if (!info.isFile() || info.size === 0) {
    throw new Error(`template '${template}' produced an empty web artifact at '${artifact}'.`);
  }
}

async function runTemplate(
  template: string,
  target: string,
  sources: PackageSources,
  templatesRoot: string,
): Promise<readonly TemplateStep[]> {
  const port = await freePort();
  return runGoldenPathTemplate(
    template,
    {
      scaffold: async () => {
        await scaffold(template, target, sources, templatesRoot);
        await stat(target);
        // The starter ships three scenarios; the guards it no longer ships live beside the
        // templates (PRD-449). This lane is where starter's GPU scenarios run, so copy them back.
        const guards = path.resolve(templatesRoot, "..", "template-playtests", template);
        if (existsSync(guards)) {
          await cp(guards, path.join(target, "playtests"), { recursive: true });
        }
      },
      install: () =>
        runCommand("install", "pnpm", ["install", "--reporter", "append-only"], target),
      mcp: () => assertMcpServers(target),
      dev: () => runDev(target, template, port),
      test: () => {
        // `goldenPathTestStep` decides what "test" means on this machine: the project's own
        // `pnpm test` where there is a GPU, and only the scenarios that need no rendered frame
        // where TN_PLAYTEST_ALLOW_SOFTWARE says there is not. It was written for that and then
        // only ever used to build the corrective *message*, so the CI runner kept running the
        // full suite and died in a pixel scenario it cannot serve:
        //   locator.screenshot: Timeout 29970ms exceeded
        //     - attempting scroll into view action
        //     - waiting for element to be stable
        // A canvas that renders every frame is never "stable", so the element screenshot can only
        // ever time out there. Run what the step actually resolved to.
        const step = goldenPathTestStep(target);
        return runCommand("test", step.command, step.args, step.cwd);
      },
      buildWeb: () =>
        runCommand(
          "build web",
          "pnpm",
          ["exec", "threenative", "build", "--target", "web"],
          target,
        ),
      assertArtifact: () => assertArtifact(target, template),
    },
    target,
    goldenPathCorrectiveCommands(target, port),
  );
}

export interface IPackedMutationEvidence {
  readonly generatedManifest: string;
  readonly mutatedSha256: string;
  readonly mutatedTarball: string;
  readonly repositorySha256: string;
  readonly repositoryTarball: string;
}

async function materializeTemporaryPackageVersions(packageRoot: string): Promise<void> {
  const manifestPath = path.join(packageRoot, PACKAGE_FILE);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    const dependencies = manifest[field];
    if (!isRecord(dependencies)) continue;
    for (const [name, specifier] of Object.entries(dependencies)) {
      if (
        typeof specifier !== "string" ||
        (specifier !== "catalog:" && !specifier.startsWith("workspace:"))
      ) {
        continue;
      }
      const dependencyManifest = await readManifest(
        path.join(REPO_ROOT, "packages/create-threenative/node_modules", name, PACKAGE_FILE),
      );
      if (dependencyManifest.version === undefined) {
        throw new Error(
          `TN_GOLDEN_PATH_PACKAGE_VERSION_MISSING: cannot materialize '${name}' for '${packageRoot}'.`,
        );
      }
      dependencies[name] = dependencyManifest.version;
    }
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function verifyPackedMutationControl(
  sources: PackageSources,
  template = "starter",
): Promise<IPackedMutationEvidence> {
  const repositoryTarball = sources["create-threenative"];
  if (repositoryTarball === undefined) {
    throw new Error("TN_GOLDEN_PATH_CLI_PACK_MISSING: create-threenative was not packed.");
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "threenative-golden-path-mutated-"));
  try {
    const mutatedPackage = path.join(root, "packages", "create-threenative");
    const generatedPatches = path.join(
      REPO_ROOT,
      "packages/create-threenative/template-assets/patches",
    );
    await cp(path.join(REPO_ROOT, "packages/create-threenative"), mutatedPackage, {
      filter: (source) => path.basename(source) !== "node_modules" && source !== generatedPatches,
      recursive: true,
    });
    // Reproduce prepack's repository-relative inputs, including Vite and Tailwind's patches.
    await cp(
      path.join(REPO_ROOT, "packages/core/patches"),
      path.join(root, "packages/core/patches"),
      {
        recursive: true,
      },
    );
    await cp(path.join(REPO_ROOT, "patches"), path.join(root, "patches"), { recursive: true });
    await materializeTemporaryPackageVersions(mutatedPackage);
    const templateManifestPath = path.join(mutatedPackage, "templates", template, PACKAGE_FILE);
    const templateManifest = JSON.parse(await readFile(templateManifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    const devDependencies = templateManifest.devDependencies;
    if (!isRecord(devDependencies) || typeof devDependencies.vite !== "string") {
      throw new Error(
        `TN_GOLDEN_PATH_MUTATION_INVALID: template '${template}' does not declare vite in devDependencies.`,
      );
    }
    // A missing direct entry can be restored by a plugin's auto-installed Vite peer. A local
    // tarball that does not exist cannot be restored by a transitive dependency.
    const brokenVite = "file:./__threenative_missing_vite__.tgz";
    devDependencies.vite = brokenVite;
    await writeFile(templateManifestPath, `${JSON.stringify(templateManifest, null, 2)}\n`);

    const staging = path.join(root, "packages");
    await mkdir(staging, { recursive: true });
    const mutatedTarball = await packPackageSource(mutatedPackage, staging);
    const repositorySha256 = await sha256(repositoryTarball);
    const mutatedSha256 = await sha256(mutatedTarball);
    if (repositorySha256 === mutatedSha256) {
      throw new Error(
        `TN_GOLDEN_PATH_MUTATION_IDENTITY: mutated template packed to the repository tarball '${repositoryTarball}'.`,
      );
    }
    process.stdout.write(
      `golden-path alternate: repository '${repositoryTarball}' sha256:${repositorySha256}; mutated '${mutatedTarball}' sha256:${mutatedSha256}\n`,
    );

    const alternateSources = { ...sources, "create-threenative": mutatedTarball };
    const target = path.join(root, "mutated-project");
    await scaffold(template, target, alternateSources, templateRoot(), {
      ignoreInstallScripts: true,
      noInstall: true,
    });
    const generatedManifest = path.join(target, PACKAGE_FILE);
    const generated = await readManifest(generatedManifest);
    if (generated.devDependencies?.vite !== brokenVite) {
      throw new Error(
        `TN_GOLDEN_PATH_MUTATION_NOT_SCAFFOLDED: generated manifest '${generatedManifest}' lacks the broken vite dependency. Packed source '${mutatedTarball}' sha256:${mutatedSha256}.`,
      );
    }
    process.stdout.write(
      `golden-path alternate: generated manifest '${generatedManifest}' contains the broken vite dependency from '${mutatedTarball}'\n`,
    );

    let failed = false;
    try {
      await runCommand(
        "install",
        "pnpm",
        ["install", "--ignore-scripts", "--reporter", "append-only"],
        target,
      );
    } catch (error) {
      failed = true;
      process.stdout.write(
        `golden-path alternate: expected broken dependency failed from '${target}': ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    if (!failed) {
      throw new Error(
        `TN_GOLDEN_PATH_MUTATION_DEPENDENCY_RESTORED: mutated template '${template}' unexpectedly installed its missing vite tarball.`,
      );
    }
    return {
      generatedManifest,
      mutatedSha256,
      mutatedTarball,
      repositorySha256,
      repositoryTarball,
    };
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

export async function verifyGoldenPath(templatesRoot = templateRoot()): Promise<void> {
  const templates = discoverGoldenPathTemplates(templatesRoot);
  const root = await mkdtemp(path.join(os.tmpdir(), "threenative-golden-path-"));
  try {
    const staging = path.join(root, "packages");
    const executed: GoldenPathStep[] = [];
    let sources: PackageSources | undefined;
    // `TN_GOLDEN_PATH_ARCHIVES` names a directory of tarballs another job already packed from this
    // commit. Unset — which is every developer machine — this packs them here exactly as before.
    const archives = process.env.TN_GOLDEN_PATH_ARCHIVES?.trim();
    await runRecordedGlobalStep("pack", executed, async () => {
      await mkdir(staging, { recursive: true });
      sources =
        archives === undefined || archives === ""
          ? await packWorkspace(staging)
          : await adoptPackedWorkspace(archives);
    });
    if (sources === undefined) {
      throw new Error("TN_GOLDEN_PATH_PACK_EMPTY: no package sources.");
    }
    if (JSON.stringify(executed) !== JSON.stringify(["pack"])) {
      throw new Error(
        `TN_GOLDEN_PATH_PLAN_INVALID: recorded global steps were ${JSON.stringify(executed)}.`,
      );
    }
    for (const template of templates) {
      await runTemplate(template, path.join(root, template), sources, templatesRoot);
    }
    await verifyPackedMutationControl(sources);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function main(): Promise<void> {
  await verifyGoldenPath();
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

/**
 * The scaffold's own test command, or the part of it a machine without a GPU can run.
 *
 * A generated project's `pnpm test` drives every scenario it ships, and the ones that capture a
 * frame — screenshots, baselines, a `visual` assertion, a frame-time budget — cannot run where
 * WebGPU is a CPU rasteriser: Chromium never returns a composited frame and the run dies on
 * `page.screenshot: Timeout 120000ms exceeded`. On a machine with hardware this stays the full
 * command, because that is the proof a stranger's machine actually gives them.
 *
 * `TN_PLAYTEST_ALLOW_SOFTWARE=1` is the operator saying out loud that this machine has none.
 */

/**
 * How many of a template's non-visual scenarios the golden path drives itself.
 *
 * Unset means all of them, which is what a developer running `pnpm verify:golden-path` wants and
 * what this lane did before. CI sets it, because `template-nonvisual` already runs the whole list.
 * A value that is not a positive integer is a typo, not a request to run one scenario, so it
 * throws rather than quietly narrowing the layer to something nobody asked for.
 */
export function scenarioCap(available: number, raw = process.env.TN_GOLDEN_PATH_SCENARIOS): number {
  if (raw === undefined || raw.trim() === "") return available;
  if (!/^[1-9][0-9]*$/u.test(raw.trim())) {
    throw new Error(
      `TN_GOLDEN_PATH_SCENARIOS_INVALID: '${raw}' is not a positive integer count of scenarios.`,
    );
  }
  return Math.min(Number(raw.trim()), available);
}

function goldenPathTestStep(target: string): { args: string[]; command: string; cwd: string } {
  if (process.env.TN_PLAYTEST_ALLOW_SOFTWARE !== "1") {
    return { args: ["test"], command: "pnpm", cwd: target };
  }
  // This map is built before the run starts, which is before `scaffold` has created the project,
  // so on the first pass there is no `playtests/` to read. Listing scenarios then is not merely
  // premature — it threw ENOENT and failed the whole lane while printing an error about a
  // directory the lane was about to create. A corrective command is a message; it must never be
  // the thing that fails. Without scenarios the honest suggestion is the project's own test script.
  if (!existsSync(path.join(target, "playtests"))) {
    return { args: ["test"], command: "pnpm", cwd: target };
  }
  // A template whose every scenario captures a frame has nothing this lane can run. `minimal` is
  // that template: `atmosphere`, `play` and `survives` are all visual, so the splitter correctly
  // reports "every scenario is visual; nothing would run" and exits non-zero. That is right for a
  // direct caller and wrong here — it failed the whole lane over a template it simply cannot
  // prove without a GPU, which is a fact about the machine rather than about the scaffold.
  //
  // Say so and carry on. What must not happen is the opposite: running zero scenarios and
  // reporting the template proven, which is why the splitter still fails closed for anyone else.
  const listed = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts", "non-visual-scenarios.mjs"), target],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  if (listed.status !== 0) {
    process.stdout.write(
      `golden-path ${path.basename(target)}: every scenario needs a rendered frame, and this machine has no GPU (TN_PLAYTEST_ALLOW_SOFTWARE=1). Nothing is run and nothing is claimed for this template here; the lanes with hardware cover it.\n`,
    );
    return { args: ["--version"], command: "pnpm", cwd: target };
  }
  const scenarios = listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  // What this layer proves is that a stranger's `pnpm test` reaches a running scene and comes back
  // green — the golden path. What it does *not* have to prove is that every scenario in the
  // template passes, because `template-nonvisual` runs this exact list, through this exact
  // classifier and runner, with these exact flags, for all eight templates, in a job beside this
  // one. Running the whole sweep here cost 353s of a 375s step on run 33712230560 and proved
  // nothing the run did not already know.
  //
  // `TN_GOLDEN_PATH_SCENARIOS` caps how many of them this layer drives. Unset — every developer
  // machine — it runs all of them exactly as before. Whatever it runs, it says out loud what it
  // left to the other lane, because a layer that quietly narrowed itself would be indistinguishable
  // from one that had stopped working.
  const cap = scenarioCap(scenarios.length);
  const driven = scenarios.slice(0, cap);
  if (driven.length < scenarios.length) {
    process.stdout.write(
      `golden-path ${path.basename(target)}: driving ${driven.length} of ${scenarios.length} non-visual scenarios (${driven.join(", ")}); the remaining ${scenarios.length - driven.length} are template-nonvisual's, which runs this same list for every template.\n`,
    );
  }
  return {
    args: [
      "exec",
      "threenative-playtest",
      ...driven.flatMap((scenario) => ["--scenario", scenario]),
      "--browser-recipe",
      "webgpu",
      "--headed",
      "--no-screenshots",
      "--server-command",
      "pnpm dev --host 127.0.0.1 --port $PORT --strictPort",
    ],
    command: "pnpm",
    cwd: target,
  };
}
