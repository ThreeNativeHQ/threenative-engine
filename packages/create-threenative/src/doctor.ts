import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  existsSync,
  constants as fsConstants,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Bundled into the CLI at build time, exactly like the MCP server table: `detect.ts` uses only
// node builtins, so inlining it adds no runtime dependency to the published `create-threenative`.
import { installCommandFor, resolveBlender } from "threenative-blender-mcp/bridge";

import { MCP_HOSTS } from "../../core/mcp/install.mjs";
import { resolveRuntimeAssetCapabilities } from "./build.js";
import { loadConfig } from "./config.js";
import {
  type IMcpPackage,
  MCP_PACKAGES,
  MCP_SERVERS,
  serverEntryPath,
  serverPackageKey,
} from "./mcp-servers.js";

/**
 * `threenative doctor` — check a generated project against the assumptions the build and the
 * native host make about it, before either of them fails in a way that reads as a game bug.
 *
 * Everything here is decided from a snapshot so the rules stay testable without a project on
 * disk; `readProject` is the only part that touches the filesystem.
 */

export type DoctorStatus = "ok" | "warn" | "fail";

/** The targets `threenative build --target` accepts; doctor scopes its diagnosis to the same set. */
export type DoctorTarget = "android" | "desktop" | "ios" | "web";

/** The build modes PRD-212 defines for `threenative build`; only release adds signing inputs. */
export type DoctorMode = "debug" | "release";

/**
 * What the developer said they are about to build. Absent means the legacy unscoped report: every
 * target is described, none of them decides the exit code.
 */
export interface IDoctorRequest {
  readonly mode?: DoctorMode;
  readonly target?: DoctorTarget;
}

/**
 * The Gradle project properties an Android *release* needs, in their environment transport spelling.
 * Release signing is owned by the game, never by the engine, so doctor only reports whether the
 * developer supplied them — it never reads a value, and never prints one.
 *
 * `packages/runtime-native/scripts/package-android.mjs` (PRD-212 phase 3) is the consumer that
 * must read the same four names; this constant is the single place they are spelled.
 *
 * **Nothing reads them yet.** On `main` the Android packager contains no `ORG_GRADLE_PROJECT_`
 * string and only runs `assembleDebug`, so today these are a forecast of PRD-212's contract, not a
 * description of a build that exists. When PRD-212 lands, either it reads exactly these four or
 * this constant changes with it in the same PR — the two drifting apart is how doctor would start
 * predicting a prerequisite no build has.
 */
export const ANDROID_RELEASE_SIGNING_ENV = [
  "ORG_GRADLE_PROJECT_threenativeKeystore",
  "ORG_GRADLE_PROJECT_threenativeKeystoreAlias",
  "ORG_GRADLE_PROJECT_threenativeKeystorePassword",
  "ORG_GRADLE_PROJECT_threenativeKeyPassword",
] as const;

export interface IDoctorCheck {
  readonly detail: string;
  readonly fix?: string;
  readonly name: string;
  readonly status: DoctorStatus;
}

export interface IDoctorReport {
  readonly checks: readonly IDoctorCheck[];
  readonly pass: boolean;
}

export interface IProjectSnapshot {
  /** Resolved TypeScript config, or the single sanctioned package.json `nativeEntry`
   *  fallback when TypeScript is absent — the same surfaces the build path reads. */
  readonly config: unknown;
  readonly files: ReadonlySet<string>;
  readonly installedVersions: ReadonlyMap<string, string>;
  readonly packageJson: unknown;
  /** Absolute project root, available to checks that validate recorded build evidence. */
  readonly projectRoot?: string;
  readonly readText: (relative: string) => string | undefined;
  /** Resolved package root and readers for the optional native runtime package. */
  readonly readRuntimeText?: (relative: string) => string | undefined;
  readonly runtimeFileExists?: (relative: string) => boolean;
  readonly runtimeManifestUrl?: string;
  readonly runtimeRoot?: string;
  /**
   * What the installed native host binary reports about itself, injected so the check is testable
   * on a machine either way. Absent means doctor runs the host's own `--version` itself.
   */
  readonly nativeHost?: INativeHostProbe;
  /** Desktop UI overlay preflight, when the machine exposes a display to probe. */
  readonly desktopOverlay?: IDesktopOverlayProbe;
  /** Optional seams used by the diagnostic checks and by deterministic unit fixtures. */
  readonly androidToolchain?: IAndroidToolchainProbe;
  /** The build environment, read only for the presence of declared signing property names. */
  readonly environment?: NodeJS.ProcessEnv;
  /** Blender discovery, injected so the check is testable on a machine either way. */
  readonly blender?: IBlenderProbe;
  readonly directoryWritable?: (relative: string) => boolean | undefined;
  readonly mcpServerHealth?: ReadonlyMap<string, IMcpServerHealth>;
  readonly playtestRunnerPath?: string;
  readonly resolvePackageDirectory?: (name: string) => string | undefined;
  /** Runs the same playtest doctor, optionally against the launch capture named by the CLI. */
  readonly runPlaytestDoctor?: (capturePath?: string) => string;
}

/** What `resolveBlender` answers, narrowed to what doctor reports. */
export interface IBlenderProbe {
  readonly available: boolean;
  readonly detail: string;
  readonly installCommand: string;
  readonly version?: string;
}

export interface IMcpServerHealth {
  readonly detail: string;
  readonly status: "fail" | "ok";
}

export interface IDesktopOverlayProbe {
  readonly detail: string;
  readonly fix: string;
  readonly status: DoctorStatus;
}

export interface IAndroidToolchainProbe {
  readonly jdkMajor?: number;
  readonly jdkVersion?: string;
  readonly sdkVersion?: string;
  readonly status?: DoctorStatus;
}

const DEFAULT_NATIVE_ENTRY = "src/game.ts";
const RUNTIME_PACKAGE = "@threenative/runtime-native";
const PLAYTEST_BINARY = "threenative-playtest";
const ANDROID_JDK_MAJOR = 17;
/**
 * The submission SDK doctor falls back to when the installed runtime package is unreadable.
 *
 * The requirement is not owned here: it lives in the runtime's own
 * `android/app/build.gradle.kts`, and doctor reads it from the installed package so a bundler
 * that ships a 36 and a doctor that still names 35 cannot both be true. Today it is API 36:
 * Google Play rejects new apps and updates below target API 36 from 2026-08-31.
 */
const DEFAULT_ANDROID_COMPILE_SDK = 36;

/** The SDK the shipped Gradle project declares, preferring the submission-required `targetSdk`. */
export function androidGradleSdk(source: string | undefined): number | undefined {
  if (source === undefined) return undefined;
  const target = /targetSdk\s*=\s*(\d+)/u.exec(source);
  const compile = /compileSdk\s*=\s*(\d+)/u.exec(source);
  const value = target?.[1] ?? compile?.[1];
  return value === undefined ? undefined : Number(value);
}

/** The submission SDK the installed runtime package asks for, or the documented fallback. */
function requiredAndroidSdk(snapshot: IProjectSnapshot): number {
  return (
    androidGradleSdk(snapshot.readRuntimeText?.("android/app/build.gradle.kts")) ??
    DEFAULT_ANDROID_COMPILE_SDK
  );
}

/** The same requirement read from a runtime package directory, for the live snapshot builder. */
function requiredAndroidSdkFromRoot(root: string | undefined): number {
  if (root === undefined) return DEFAULT_ANDROID_COMPILE_SDK;
  try {
    return (
      androidGradleSdk(
        readFileSync(path.join(root, "android", "app", "build.gradle.kts"), "utf8"),
      ) ?? DEFAULT_ANDROID_COMPILE_SDK
    );
  } catch {
    return DEFAULT_ANDROID_COMPILE_SDK;
  }
}

interface IMcpServerSpec {
  readonly configName: string;
  readonly expectedArgs: string;
  readonly packageName: string;
  readonly version: string;
}

/** The engine server resolves to `@threenative/core` itself, not to the package `MCP_PACKAGES`
 * names: core bundles engine discovery and only falls back to `threenative-engine-mcp` over npx in
 * a development checkout whose bundle has not been built. Doctor probes what the project actually
 * resolves, so it must name core — and core's own version, which `doctor.spec.ts` holds equal to
 * `packages/core/package.json`. */
const CORE_PACKAGE_NAME = "@threenative/core";
const CORE_PACKAGE_VERSION = "0.3.7";
const CORE_RESOLVED_SERVERS: ReadonlySet<string> = new Set([
  "threenative-engine",
  "threenative-blender",
  "threenative-animation",
]);

export const MCP_SERVER_SPECS: readonly IMcpServerSpec[] = Object.entries(MCP_SERVERS).map(
  ([configName, server]) => {
    const resolvesToCore = CORE_RESOLVED_SERVERS.has(configName);
    const key = serverPackageKey(server);
    const declared = MCP_PACKAGES[key];
    if (!resolvesToCore && declared === undefined) {
      throw new Error(
        `TN_DOCTOR_MCP_TABLE: MCP server '${configName}' launches '${key}.mjs', which MCP_PACKAGES does not declare.`,
      );
    }
    return {
      configName,
      expectedArgs: serverEntryPath(server),
      packageName: resolvesToCore ? CORE_PACKAGE_NAME : (declared as IMcpPackage).name,
      version: resolvesToCore ? CORE_PACKAGE_VERSION : (declared as IMcpPackage).version,
    };
  },
);

const ASSET_DOWNLOAD_DIRECTORIES = ["public/assets", "public/audio"] as const;
/** The model sources `blenderImportPass` owns; kept equal to `BLENDER_SOURCE_EXTENSIONS`. */
const BLENDER_SOURCE_SUFFIXES = [".fbx", ".blend", ".obj", ".dae"] as const;

/** The configured name of the server that drives Blender, derived from the one table rather than
 * spelled again: a renamed server must not leave the conversion check silently probing nothing. */
const BLENDER_PACKAGE = ((): IMcpPackage => {
  const declared = MCP_PACKAGES.blender;
  if (declared === undefined) {
    throw new Error("TN_DOCTOR_MCP_TABLE: MCP_PACKAGES declares no 'blender' package.");
  }
  return declared;
})();

/** The configured name of the server whose shim is `blender.mjs`, matched on the shim rather than
 * on the package name: this server resolves to `@threenative/core`, like the engine one, so the
 * package name identifies neither. Derived from the one table so a rename cannot leave the
 * conversion check silently probing a server that is no longer there. */
export const BLENDER_SERVER = ((): string => {
  const entry = Object.entries(MCP_SERVERS).find(
    ([, server]) => serverPackageKey(server) === "blender",
  );
  if (entry === undefined) {
    throw new Error("TN_DOCTOR_MCP_TABLE: no configured MCP server launches blender.mjs.");
  }
  return entry[0];
})();

/** The part of one installer host entry doctor reads. */
interface IMcpHost {
  readonly file: string;
  readonly format: string;
  readonly id: string;
  readonly label: string;
}

/**
 * The project-scoped hosts `@threenative/core`'s postinstall writes, read from the installer's own
 * table rather than retyped. Doctor used to inspect `.mcp.json` alone, so a game opened in VS
 * Code, Zed or opencode was told capability search was ready on the strength of a file that host
 * never reads.
 */
const MCP_HOST_TABLE: readonly IMcpHost[] = MCP_HOSTS as readonly IMcpHost[];

/** Hosts that read only a machine-wide config, so no project install can wire them. The installer
 * excludes them by rule; doctor names them so the gap is stated rather than silent. */
const MANUAL_GLOBAL_MCP_HOSTS: readonly string[] = Object.freeze([
  "Windsurf",
  "Cline",
  "Amp",
  "the JetBrains assistants",
]);

/** This list is prose in the installer, not data, so it is the one thing here that is retyped.
 * The guard is the compensation: the day core starts wiring one of these project-scoped, the
 * sentence doctor prints becomes false, and this throws instead of printing it. */
for (const host of MCP_HOSTS as readonly IMcpHost[]) {
  const claimed = MANUAL_GLOBAL_MCP_HOSTS.find(
    (name) => host.label.toLowerCase() === name.toLowerCase(),
  );
  if (claimed !== undefined) {
    throw new Error(
      `TN_DOCTOR_MCP_TABLE: '${claimed}' is wired project-scoped now, so doctor must stop calling it machine-wide only.`,
    );
  }
}

/**
 * The hosts whose config doctor can validate by shape, not merely by name.
 *
 * `mcpServerMatches` knows one server shape — the `mcpServers` table Claude Code, Cursor and the
 * Gemini CLI all read. VS Code, Zed, opencode and Codex each spell a server differently, and
 * reproducing those four here would be a second copy of the installer's `SERVER_FORMATS`. So the
 * per-server checks read the formats they can actually verify, and the ones they cannot are
 * reported by name presence in `editor activation` instead. Both facts are stated; neither is
 * inflated into the other.
 */
const SHAPE_VERIFIABLE_HOSTS: readonly IMcpHost[] = (MCP_HOSTS as readonly IMcpHost[]).filter(
  ({ format }) => format === "mcpServers",
);

type CompositorProbe = (environment: NodeJS.ProcessEnv) => boolean | undefined;

// `_NET_WM_CM_S0` is the X11 *selection* a compositing manager owns; `xprop -root` reads a root
// *property* of the same name and reports "not found" even while a compositor holds the selection,
// so it cannot answer this. Node has no X11 client, so this ctypes shim queries the selection owner
// exactly as the runtime's overlay guard does. It prints `unknown` rather than guessing when it
// cannot measure, and `detectX11Compositor` maps that to `undefined`.
const X11_COMPOSITOR_PROBE = [
  "import ctypes, ctypes.util, sys",
  'path = ctypes.util.find_library("X11")',
  "if not path:",
  "    print('unknown'); sys.exit(0)",
  "x = ctypes.CDLL(path)",
  "x.XOpenDisplay.restype = ctypes.c_void_p",
  "x.XOpenDisplay.argtypes = [ctypes.c_char_p]",
  "display = x.XOpenDisplay(None)",
  "if not display:",
  "    print('unknown'); sys.exit(0)",
  "x.XDefaultScreen.restype = ctypes.c_int",
  "x.XDefaultScreen.argtypes = [ctypes.c_void_p]",
  "screen = x.XDefaultScreen(display)",
  "x.XInternAtom.restype = ctypes.c_ulong",
  "x.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]",
  'atom = x.XInternAtom(display, ("_NET_WM_CM_S%d" % screen).encode(), 0)',
  "x.XGetSelectionOwner.restype = ctypes.c_ulong",
  "x.XGetSelectionOwner.argtypes = [ctypes.c_void_p, ctypes.c_ulong]",
  "owner = x.XGetSelectionOwner(display, atom)",
  "x.XCloseDisplay.argtypes = [ctypes.c_void_p]",
  "x.XCloseDisplay(display)",
  "print('1' if owner else '0')",
].join("\n");

export function detectX11Compositor(
  environment: NodeJS.ProcessEnv = process.env,
): boolean | undefined {
  if (environment.DISPLAY === undefined) return undefined;
  try {
    const output = execFileSync("python3", ["-c", X11_COMPOSITOR_PROBE], {
      encoding: "utf8",
      env: { ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const answer = output.trim();
    if (answer === "1") return true;
    if (answer === "0") return false;
    return undefined;
  } catch {
    // python3 missing, or the shim could not run: the answer is unknown, never a false "no
    // compositor" that would veto a build the session supports.
    return undefined;
  }
}

export function probeDesktopOverlay(
  environment: NodeJS.ProcessEnv = process.env,
  compositor: CompositorProbe = detectX11Compositor,
): IDesktopOverlayProbe {
  const wayland =
    environment.WAYLAND_DISPLAY !== undefined || environment.XDG_SESSION_TYPE === "wayland";
  // A Wayland session never runs the overlay natively: the host selects SDL's X11 driver and
  // `GDK_BACKEND=x11`, so the web view is an Xwayland window and the Wayland compositor, which a
  // Wayland session always has, blends its alpha. There is no separate compositor to find — only
  // Xwayland, without which the game window itself could not be created.
  if (wayland) {
    if (environment.DISPLAY === undefined) {
      return {
        detail:
          "a Wayland session without an X11 display (Xwayland) cannot host the desktop overlay",
        fix: "Enable Xwayland for this session or use the web UI target.",
        status: "fail",
      };
    }
    return {
      detail:
        "the runtime selects Xwayland (SDL x11, GDK_BACKEND=x11) and the Wayland compositor blends the overlay's alpha",
      fix: "",
      status: "ok",
    };
  }
  if (environment.DISPLAY === undefined) {
    return {
      detail: "no display is available, so the desktop overlay could not be probed",
      fix: "Run doctor in the display session that will host the desktop target.",
      status: "warn",
    };
  }
  const present = compositor(environment);
  if (present === true) {
    return {
      detail: "an X11 compositing manager owns _NET_WM_CM_S0; transparent overlay alpha can blend",
      fix: "",
      status: "ok",
    };
  }
  if (present === false) {
    return {
      detail: "no compositing manager is running, so nothing would blend the overlay",
      fix: "Start a compositing manager (xcompmgr -n, picom or compton -- the three the repository's own private displays borrow) or run the desktop target under a composited X11 session.",
      status: "fail",
    };
  }
  return {
    detail: "the X11 compositor probe could not run, so overlay transparency is unknown",
    fix: "Install python3 and rerun doctor in the desktop display session.",
    status: "warn",
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function declaredDependencies(packageJson: unknown): readonly string[] {
  const manifest = record(packageJson);
  if (manifest === undefined) return [];
  const names = new Set<string>();
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    for (const name of Object.keys(record(manifest[field]) ?? {})) {
      if (name.startsWith("@threenative/")) names.add(name);
    }
  }
  return [...names].sort();
}

function nativeEntryFrom(config: unknown): string {
  const configured = record(config)?.nativeEntry;
  return typeof configured === "string" && configured.length > 0
    ? configured
    : DEFAULT_NATIVE_ENTRY;
}

function usesDesktopOverlay(config: unknown): boolean {
  return record(record(config)?.ui)?.renderer === "web";
}

/** Builds resolve only the TypeScript config plus the single sanctioned package.json
 *  `nativeEntry` fallback, so doctor reports no other legacy surface as the config. */
function nativeEntryCompat(value: unknown): { nativeEntry: string } | undefined {
  const entry = record(value)?.nativeEntry;
  return typeof entry === "string" && entry.length > 0 ? { nativeEntry: entry } : undefined;
}

function resolvePackageDirectoryFrom(start: string, name: string): string | undefined {
  let directory = path.resolve(start);
  while (true) {
    const candidate = path.join(directory, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function resolvePackageDirectory(snapshot: IProjectSnapshot, name: string): string | undefined {
  if (snapshot.resolvePackageDirectory !== undefined) {
    return snapshot.resolvePackageDirectory(name);
  }
  if (snapshot.projectRoot === undefined) return undefined;
  const direct = resolvePackageDirectoryFrom(snapshot.projectRoot, name);
  if (direct !== undefined) return direct;
  const core = resolvePackageDirectoryFrom(snapshot.projectRoot, "@threenative/core");
  if (core === undefined) return undefined;
  try {
    return resolvePackageDirectoryFrom(realpathSync(core), name);
  } catch {
    return undefined;
  }
}

function resolveBinaryFrom(start: string, name: string): string | undefined {
  let directory = path.resolve(start);
  while (true) {
    const binDirectory = path.join(directory, "node_modules", ".bin");
    const candidates =
      process.platform === "win32"
        ? [path.join(binDirectory, `${name}.cmd`), path.join(binDirectory, name)]
        : [path.join(binDirectory, name)];
    const found = candidates.find((candidate) => existsSync(candidate));
    if (found !== undefined) return found;
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function expectedMcpServer(spec: IMcpServerSpec): Record<string, unknown> {
  return {
    command: "node",
    args: [spec.expectedArgs],
    ...(spec.configName === "threenative-assets"
      ? {
          env: Object.fromEntries([
            ["ASSET_DOWNLOAD_DIR", "./public/assets"],
            ["AUDIO_DOWNLOAD_DIR", "./public/audio"],
          ]),
        }
      : {}),
  };
}

function mcpServerMatches(spec: IMcpServerSpec, value: unknown): boolean {
  const server = record(value);
  if (server === undefined || server.command !== "node") return false;
  if (
    !Array.isArray(server.args) ||
    server.args.length !== 1 ||
    server.args[0] !== spec.expectedArgs
  )
    return false;
  if (spec.configName !== "threenative-assets") return true;
  const env = record(server.env);
  return (
    env?.ASSET_DOWNLOAD_DIR === "./public/assets" && env.AUDIO_DOWNLOAD_DIR === "./public/audio"
  );
}

function readServerTable(
  snapshot: IProjectSnapshot,
  host: IMcpHost,
): { readonly detail: string } | { readonly servers: Record<string, unknown> } {
  const source = snapshot.readText(host.file);
  if (source === undefined) return { detail: `${host.file} could not be read` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    return {
      detail: `${host.file} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const servers = record(record(parsed)?.mcpServers);
  return servers === undefined
    ? { detail: `${host.file} is missing an object-valued mcpServers property` }
    : { servers };
}

/**
 * The server table to diagnose, from whichever supported host config carries one.
 *
 * Keyed to `.mcp.json` alone, this failed a correctly wired Cursor-only project: `capability
 * search` reported "no .mcp.json" and exited 1 beside an `editor activation` line that had just
 * found the servers in `.cursor/mcp.json`. Two checks contradicting each other about the same
 * project. It now reads every host whose format this file can actually validate, in the
 * installer's own order, and takes the one carrying the most ThreeNative servers — not merely the
 * first that parses, which reported "0 of 4 servers resolve" on a project whose other six configs
 * were correctly wired and whose `.mcp.json` held the user's own unrelated table.
 */
function mcpConfig(
  snapshot: IProjectSnapshot,
):
  | { readonly kind: "missing" }
  | { readonly kind: "malformed"; readonly detail: string }
  | { readonly kind: "ready"; readonly host: IMcpHost; readonly servers: Record<string, unknown> } {
  const present = SHAPE_VERIFIABLE_HOSTS.filter(({ file }) => snapshot.files.has(file));
  if (present.length === 0) return { kind: "missing" };
  const malformed: string[] = [];
  const parsed: { host: IMcpHost; servers: Record<string, unknown> }[] = [];
  for (const host of present) {
    const result = readServerTable(snapshot, host);
    if ("servers" in result) parsed.push({ host, servers: result.servers });
    else malformed.push(result.detail);
  }
  if (parsed.length === 0) return { detail: malformed.join("; "), kind: "malformed" };
  const wired = ({ servers }: { servers: Record<string, unknown> }): number =>
    MCP_SERVER_SPECS.filter(({ configName }) => servers[configName] !== undefined).length;
  // First by how many ThreeNative servers the table actually carries, then by the installer's own
  // host order, which `present` preserves.
  const best = parsed.reduce((left, right) => (wired(right) > wired(left) ? right : left));
  return { host: best.host, kind: "ready", servers: best.servers };
}

function mcpServerCheck(
  snapshot: IProjectSnapshot,
  spec: IMcpServerSpec,
  value: unknown,
  file: string,
): IDoctorCheck {
  const name = `capability search: ${spec.packageName}`;
  if (value === undefined) {
    return {
      detail: `${spec.configName} is missing from ${file}; expected ${spec.packageName}@${spec.version}`,
      fix: `Restore the server entry in ${file}, which @threenative/core generates.`,
      name,
      status: "fail",
    };
  }
  if (!mcpServerMatches(spec, value)) {
    return {
      detail: `${spec.configName} is hand-edited or malformed; expected ${JSON.stringify(expectedMcpServer(spec))}`,
      fix: `Restore the generated ${file} entry so the ThreeNative shim and asset directories remain wired.`,
      name,
      status: "fail",
    };
  }
  if (
    snapshot.projectRoot !== undefined &&
    !existsSync(path.resolve(snapshot.projectRoot, spec.expectedArgs))
  ) {
    return {
      detail: `${spec.configName} points at missing ${spec.expectedArgs}; @threenative/core is not providing the configured server shim`,
      fix: "Install @threenative/core again so the generated MCP server entry exists.",
      name,
      status: "fail",
    };
  }
  const health = snapshot.mcpServerHealth?.get(spec.configName);
  if (health?.status === "fail") {
    return {
      detail: `${spec.configName} is configured, but ${health.detail}`,
      fix: `Reinstall @threenative/core and ${spec.packageName}, then rerun doctor.`,
      name,
      status: "fail",
    };
  }
  const packageDirectory = resolvePackageDirectory(snapshot, spec.packageName);
  if (packageDirectory === undefined) {
    return {
      detail: `${spec.configName} is reachable by npx only: ${spec.packageName}@${spec.version} is not installed (npx --yes ${spec.packageName}@${spec.version})`,
      fix: `Install ${spec.packageName}@${spec.version} when this server is needed, or use the npx fallback named above.`,
      name,
      status: "warn",
    };
  }
  const manifest = readJsonSync(path.join(packageDirectory, "package.json"));
  const installedVersion = record(manifest)?.version;
  if (typeof installedVersion !== "string") {
    return {
      detail: `${spec.configName} resolves ${spec.packageName}, but its package.json has no version`,
      fix: `Reinstall ${spec.packageName}@${spec.version}.`,
      name,
      status: "fail",
    };
  }
  if (installedVersion !== spec.version) {
    return {
      detail: `${spec.configName} resolves ${spec.packageName}@${installedVersion}; the ${file} fallback is ${spec.packageName}@${spec.version}`,
      fix: `Install ${spec.packageName}@${spec.version} so the capability contract is version-matched.`,
      name,
      status: "warn",
    };
  }
  return {
    detail: `${spec.configName} resolves ${spec.packageName}@${installedVersion}${health === undefined ? "" : `; ${health.detail}`}`,
    name,
    status: "ok",
  };
}

function probeMcpServer(projectRoot: string, spec: IMcpServerSpec): IMcpServerHealth {
  const initialize = JSON.stringify({
    id: 1,
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      capabilities: {},
      clientInfo: { name: "threenative-doctor", version: "0.3.7" },
      protocolVersion: "2025-06-18",
    },
  });
  const initialized = JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  const list = JSON.stringify({ id: 2, jsonrpc: "2.0", method: "tools/list", params: {} });
  const result = spawnSync("node", [spec.expectedArgs], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...(spec.configName === "threenative-assets"
        ? Object.fromEntries([
            ["ASSET_DOWNLOAD_DIR", "./public/assets"],
            ["AUDIO_DOWNLOAD_DIR", "./public/audio"],
          ])
        : {}),
    },
    input: `${initialize}\n${initialized}\n${list}\n`,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 5_000,
  });
  if (result.error !== undefined || result.status !== 0) {
    const stderr = result.stderr.trim();
    const reason =
      result.error?.message ?? (stderr.length > 0 ? stderr : `exited ${result.status}`);
    return { detail: `its MCP transport failed to start: ${reason}`, status: "fail" };
  }
  const responses = result.stdout
    .split(/\r?\n/u)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    })
    .map(record)
    .filter((value): value is Record<string, unknown> => value !== undefined);
  const initializeResponse = responses.find(({ id }) => id === 1);
  const listResponse = responses.find(({ id }) => id === 2);
  const tools = record(listResponse?.result)?.tools;
  if (
    record(initializeResponse?.result) === undefined ||
    !Array.isArray(tools) ||
    tools.length === 0
  ) {
    return {
      detail: "its MCP transport did not complete initialize and advertise tools",
      status: "fail",
    };
  }
  return { detail: `transport initialized and advertised ${tools.length} tool(s)`, status: "ok" };
}

function mcpSummary(serverChecks: readonly IDoctorCheck[], host: IMcpHost): IDoctorCheck {
  const failed = serverChecks.filter(({ status }) => status === "fail").length;
  const warned = serverChecks.filter(({ status }) => status === "warn").length;
  const status: DoctorStatus = failed > 0 ? "fail" : warned > 0 ? "warn" : "ok";
  return {
    // Transport, and only transport. A server that starts is a server that answers `tools/list`;
    // whether the application one of its tools drives is installed is a separate fact, reported by
    // `model conversion`. The old wording — "all three configured MCP servers resolve" — claimed a
    // complete authoring toolchain, and had also been wrong about the count since the fourth
    // server landed.
    detail:
      status === "ok"
        ? `all ${serverChecks.length} servers in ${host.file} resolve; transport only, external applications are reported separately`
        : `${serverChecks.length - failed - warned} of ${serverChecks.length} server(s) in ${host.file} resolve; ${warned} reachable by npx only; ${failed} malformed or missing; transport only, external applications are reported separately`,
    fix: status === "ok" ? undefined : "Inspect the per-server capability search checks below.",
    name: "capability search",
    status,
  };
}

function capabilitySearchChecks(snapshot: IProjectSnapshot): readonly IDoctorCheck[] {
  const config = mcpConfig(snapshot);
  const verifiable = SHAPE_VERIFIABLE_HOSTS.map(({ file }) => file).join(", ");
  if (config.kind === "missing" || config.kind === "malformed") {
    // A host doctor cannot validate by shape may still be wired; `editor activation` is the check
    // that can see it, and saying so beats a bare "no .mcp.json" on a working Zed project. This
    // rescue applies to an unreadable table as much as to an absent one — a single corrupt
    // .mcp.json must not hard-fail a project whose other hosts carry the servers.
    const elsewhere = MCP_HOST_TABLE.filter((host) => hostWiring(snapshot, host) === "wired").map(
      ({ label }) => label,
    );
    const cause =
      config.kind === "missing"
        ? `no server table this check can validate (${verifiable})`
        : `no readable server table: ${config.detail}`;
    if (elsewhere.length > 0) {
      return [
        {
          detail: `${cause}; ${elsewhere.join(", ")} carry the servers in a format only 'editor activation' reads`,
          fix: `Reinstall @threenative/core if you also want ${verifiable} wired; an agent in ${elsewhere[0]} already has capability search.`,
          name: "capability search",
          status: "warn",
        },
      ];
    }
    return [
      {
        detail:
          config.kind === "missing"
            ? `no ${verifiable}, so an agent here cannot search engine capabilities and will hand-write what exists`
            : cause,
        fix:
          config.kind === "missing"
            ? "Restore the .mcp.json a scaffolded project ships, which wires the ThreeNative MCP servers."
            : "Restore a valid generated config, preserving any unrelated servers.",
        name: "capability search",
        status: "fail",
      },
    ];
  }
  const serverChecks = MCP_SERVER_SPECS.map((spec) =>
    mcpServerCheck(snapshot, spec, config.servers[spec.configName], config.host.file),
  );
  return [mcpSummary(serverChecks, config.host), ...serverChecks];
}

function readJsonSync(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function addCommandTargets(targets: Set<string>, value: unknown): void {
  if (typeof value !== "string") return;
  for (const match of value.matchAll(/--target(?:=|\s+)(web|desktop|android|ios)\b/gu)) {
    const target = match[1];
    if (target !== undefined) targets.add(target);
  }
}

function addConfiguredTargets(targets: Set<string>, value: unknown): void {
  if (Array.isArray(value)) {
    for (const target of value) if (typeof target === "string") targets.add(target);
  } else if (typeof value === "string") {
    targets.add(value);
  }
}

function configuredTargets(snapshot: IProjectSnapshot): readonly string[] {
  const targets = new Set<string>();
  const packageScripts = record(record(snapshot.packageJson)?.scripts);
  for (const value of Object.values(packageScripts ?? {})) addCommandTargets(targets, value);
  const configRecord = record(snapshot.config);
  for (const key of ["targets", "nativeTargets"] as const)
    addConfiguredTargets(targets, configRecord?.[key]);
  return [...targets];
}

function directoryCanBeWritten(snapshot: IProjectSnapshot, relative: string): boolean | undefined {
  if (snapshot.directoryWritable !== undefined) return snapshot.directoryWritable(relative);
  if (snapshot.projectRoot === undefined) return undefined;
  const root = path.resolve(snapshot.projectRoot);
  let candidate = path.resolve(root, relative);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return false;
  while (candidate !== root && !existsSync(candidate)) candidate = path.dirname(candidate);
  if (!existsSync(candidate)) return false;
  try {
    if (!statSync(candidate).isDirectory()) return false;
    accessSync(candidate, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function assetPipelineCheck(snapshot: IProjectSnapshot): IDoctorCheck {
  const details: string[] = [];
  let status: DoctorStatus = "ok";
  for (const directory of ASSET_DOWNLOAD_DIRECTORIES) {
    const writable = directoryCanBeWritten(snapshot, directory);
    if (writable === false) {
      details.push(`${directory} is not writable and cannot receive MCP downloads`);
      status = "warn";
    } else if (writable === true) {
      details.push(`${directory} exists or can be created`);
    } else {
      details.push(`${directory} was not probed in this in-memory snapshot`);
    }
  }

  const assets = record(record(snapshot.config)?.assets) ?? {};
  const mobileTargets = configuredTargets(snapshot).filter(
    (target) => target === "android" || target === "ios",
  );
  // Android V8 admits KTX2 and Meshopt (the same resolution `threenative build` makes).
  const lacking = (codec: "ktx2" | "meshopt") =>
    mobileTargets.filter((target) => !resolveRuntimeAssetCapabilities(target).decoders[codec]);
  const noKtx2 = lacking("ktx2");
  if (noKtx2.length > 0 && assets.textures !== "none") {
    details.push(
      `TN_NATIVE_KTX2_UNSUPPORTED: assets.textures compiles textures for ${noKtx2.join("/")}; that runtime requires assets.textures to be "none"`,
    );
    status = "warn";
  }
  const noMeshopt = lacking("meshopt");
  if (noMeshopt.length > 0 && assets.models !== "none") {
    details.push(
      `TN_NATIVE_MESH_COMPRESSION_UNSUPPORTED: assets.models compiles model geometry for ${noMeshopt.join("/")}; that runtime requires assets.models to be "none"`,
    );
    status = "warn";
  }
  return {
    detail: details.join("; "),
    ...(status === "ok"
      ? {}
      : {
          fix: "Make public/assets and public/audio writable, and disable compiled assets for Android/iOS native builds.",
        }),
    name: "asset pipeline",
    status,
  };
}

/**
 * The toolchain report, with its met and unmet requirements kept apart.
 *
 * `details` is everything, for the standing `android toolchain` line. `blockers` is only what
 * would stop a build, because a prediction that lists `Android SDK platform android-35 2 found`
 * among the reasons a build cannot start is not a prediction anyone can act on.
 */
function androidToolchainFacts(
  probe: IAndroidToolchainProbe,
  requiredSdk: number = DEFAULT_ANDROID_COMPILE_SDK,
): {
  readonly blockers: readonly string[];
  readonly details: readonly string[];
  readonly status: DoctorStatus;
} {
  const details: string[] = [];
  const blockers: string[] = [];
  let status: DoctorStatus = probe.status ?? "ok";
  if (probe.jdkVersion === undefined || probe.jdkMajor === undefined) {
    const blocker = `JDK not found; Android builds require JDK ${ANDROID_JDK_MAJOR}`;
    details.push(blocker);
    blockers.push(blocker);
    status = "warn";
  } else if (probe.jdkMajor !== ANDROID_JDK_MAJOR) {
    const blocker = `JDK ${probe.jdkVersion} found; Android builds support JDK ${ANDROID_JDK_MAJOR} only`;
    details.push(blocker);
    blockers.push(blocker);
    status = "warn";
  } else {
    details.push(`JDK ${probe.jdkVersion} found (supported JDK ${ANDROID_JDK_MAJOR})`);
  }
  if (probe.sdkVersion === undefined) {
    const blocker = `Android SDK platform android-${requiredSdk} not found`;
    details.push(blocker);
    blockers.push(blocker);
    status = "warn";
  } else {
    details.push(`Android SDK platform android-${requiredSdk} ${probe.sdkVersion} found`);
  }
  return { blockers, details, status };
}

function androidToolchainStatus(
  probe: IAndroidToolchainProbe,
  requiredSdk: number = DEFAULT_ANDROID_COMPILE_SDK,
): IDoctorCheck {
  const { details, status } = androidToolchainFacts(probe, requiredSdk);
  return {
    detail: details.join("; "),
    fix:
      status === "ok"
        ? undefined
        : `Install Android SDK platform android-${requiredSdk} and JDK ${ANDROID_JDK_MAJOR}, or set ANDROID_HOME or ANDROID_SDK_ROOT and JAVA_HOME (or put JDK ${ANDROID_JDK_MAJOR} on PATH).`,
    name: "android toolchain",
    status,
  };
}

function playtestRunner(snapshot: IProjectSnapshot): string | undefined {
  if (snapshot.playtestRunnerPath !== undefined) return snapshot.playtestRunnerPath;
  return snapshot.projectRoot === undefined
    ? undefined
    : resolveBinaryFrom(snapshot.projectRoot, PLAYTEST_BINARY);
}

function missingPlaytestCheck(snapshot: IProjectSnapshot): IDoctorCheck {
  return {
    detail:
      snapshot.projectRoot === undefined
        ? "runner was not probed in this in-memory snapshot"
        : "threenative-playtest is missing from node_modules/.bin",
    fix: "Install the test runner: npm install -D @threenative/playtest, then rerun doctor.",
    name: "playtest",
    status: snapshot.projectRoot === undefined ? "warn" : "fail",
  };
}

function childOutput(value: unknown): string | undefined {
  const text =
    typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString("utf8") : undefined;
  const trimmed = text?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function playtestFailureDetail(error: unknown): string {
  const fields = record(error);
  const output = [childOutput(fields?.stderr), childOutput(fields?.stdout)]
    .filter((value): value is string => value !== undefined)
    .join("\n");
  return output.length > 0 ? output : error instanceof Error ? error.message : String(error);
}

function playtestInvocation(
  runner: string,
  capturePath?: string,
): {
  readonly args: readonly string[];
  readonly command: string;
} {
  if (process.platform !== "win32" || !/\.cmd$/iu.test(runner)) {
    return {
      args: ["doctor", "--text", ...(capturePath === undefined ? [] : ["--capture", capturePath])],
      command: runner,
    };
  }
  const command = process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe";
  const capture =
    capturePath === undefined ? "" : ` --capture "${capturePath.replaceAll('"', '\\"')}"`;
  return {
    args: ["/d", "/s", "/c", `"${runner}" doctor --text${capture}`],
    command,
  };
}

function executePlaytestDoctor(
  runner: string,
  projectRoot: string | undefined,
  capturePath?: string,
): string {
  const invocation = playtestInvocation(runner, capturePath);
  return execFileSync(invocation.command, invocation.args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
}

/** The marker the engine prints when a frame's shape, not its device, is what costs the frame. */
const SCENE_WARNING_MARKER = "TN_SCENE_WARNING";

/**
 * The engine's last scene-shape verdict, read out of whatever this project has already recorded.
 *
 * The verdict is produced by the running game and printed once per frame-budget window. An agent
 * that has just run the game should not have to know which log line carries it, so doctor reads the
 * recorded output and repeats the most recent one. No recorded run is an `ok` with a reason, never
 * a failure: a project that has not been run yet has nothing wrong with it.
 */
function sceneShapeCheck(snapshot: IProjectSnapshot): IDoctorCheck {
  let latest: string | undefined;
  for (const file of snapshot.files) {
    if (!file.endsWith(".log") && !file.endsWith(".txt") && !file.endsWith(".json")) continue;
    const text = snapshot.readText(file);
    if (text === undefined || !text.includes(SCENE_WARNING_MARKER)) continue;
    for (const line of text.split("\n")) {
      const at = line.indexOf(`${SCENE_WARNING_MARKER}:`);
      if (at >= 0) latest = line.slice(at + SCENE_WARNING_MARKER.length + 1).trim();
    }
  }
  if (latest === undefined) {
    return {
      detail: "no recorded run carries a scene verdict yet",
      name: "scene shape",
      status: "ok",
    };
  }
  let verdict: unknown;
  try {
    verdict = JSON.parse(latest);
  } catch {
    return {
      detail: `a ${SCENE_WARNING_MARKER} line was recorded but could not be read: ${latest.slice(0, 120)}`,
      fix: "Re-run the game and keep its stdout; the marker is one JSON object on one line.",
      name: "scene shape",
      status: "warn",
    };
  }
  if (typeof verdict !== "object" || verdict === null || !("dominantTerm" in verdict)) {
    return {
      detail: `a ${SCENE_WARNING_MARKER} line was recorded without a verdict in it`,
      name: "scene shape",
      status: "warn",
    };
  }
  const term = String(verdict.dominantTerm);
  const renderMs = "renderMs" in verdict ? String(verdict.renderMs) : "?";
  const gpuShare = "gpuShare" in verdict ? String(verdict.gpuShare) : "?";
  return {
    detail: `the last window was CPU-bound on scene shape: render ${renderMs} ms with the GPU at ${gpuShare} of the frame, dominated by ${term}`,
    fix: "Reduce the dominant term before tuning the renderer: fewer objects and fewer draws, not different render settings.",
    name: "scene shape",
    status: "warn",
  };
}

function playtestCheck(snapshot: IProjectSnapshot, capturePath?: string): IDoctorCheck {
  const runner = playtestRunner(snapshot);
  if (runner === undefined) return missingPlaytestCheck(snapshot);
  try {
    const output =
      snapshot.runPlaytestDoctor?.(capturePath) ??
      executePlaytestDoctor(runner, snapshot.projectRoot, capturePath);
    const detail = output.trim();
    return {
      detail:
        detail.length === 0
          ? "threenative-playtest doctor completed"
          : `threenative-playtest doctor completed:\n${detail}`,
      name: "playtest",
      status: "ok",
    };
  } catch (error) {
    return {
      detail: `threenative-playtest doctor failed: ${playtestFailureDetail(error)}`,
      fix: "Run npx @threenative/playtest doctor --text directly and fix the first reported machine or browser blocker.",
      name: "playtest",
      status: "fail",
    };
  }
}

const APK_SIZE_RECORD = /^docs\/verification\/apk-size-(\d{4}-\d{2}-\d{2})\.md$/u;

interface IApkSizeRecord {
  readonly artifact: string;
  readonly buildDirectory: string;
  readonly bytes: number;
  readonly sha256: string;
}

function parseApkSizeRecord(source: string): IApkSizeRecord | undefined {
  const bytesMatch = source.match(/^\s*-\s*Rebuilt APK bytes:\s*\*\*(\d[\d,]*)\*\*\s*$/mu);
  const artifactMatch = source.match(/^\s*-\s*APK artifact:\s*`([^`]+)`\s*$/mu);
  const buildDirectoryMatch = source.match(/^\s*-\s*Build directory:\s*`([^`]+)`\s*$/mu);
  const sha256Match = source.match(/^\s*-\s*APK SHA-256:\s*`([0-9a-f]{64})`\s*$/imu);
  if (
    bytesMatch === null ||
    artifactMatch === null ||
    buildDirectoryMatch === null ||
    sha256Match === null
  )
    return undefined;
  const bytesText = bytesMatch[1];
  const artifact = artifactMatch[1];
  const buildDirectory = buildDirectoryMatch[1];
  const sha256 = sha256Match[1];
  if (
    bytesText === undefined ||
    artifact === undefined ||
    buildDirectory === undefined ||
    sha256 === undefined
  )
    return undefined;
  const bytes = Number(bytesText.replaceAll(",", ""));
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return undefined;
  if (artifact.length === 0 || buildDirectory.length === 0) return undefined;
  return { artifact, buildDirectory, bytes, sha256: sha256.toLowerCase() };
}

function sha256File(file: string): string {
  const hash = createHash("sha256");
  const descriptor = openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
    return hash.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}

function evidencePath(snapshot: IProjectSnapshot, relative: string): string | undefined {
  if (snapshot.projectRoot === undefined || path.isAbsolute(relative)) return undefined;
  const root = path.resolve(snapshot.projectRoot);
  const resolved = path.resolve(root, relative);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`) ? resolved : undefined;
}

function evidenceExists(snapshot: IProjectSnapshot, relative: string, directory: boolean): boolean {
  const absolute = evidencePath(snapshot, relative);
  if (absolute !== undefined) {
    try {
      const stats = statSync(absolute);
      return directory ? stats.isDirectory() : stats.isFile();
    } catch {
      return false;
    }
  }
  return snapshot.files.has(relative);
}

function apkSizeCheck(snapshot: IProjectSnapshot): IDoctorCheck | undefined {
  const recordPath = [...snapshot.files]
    .filter((file) => APK_SIZE_RECORD.test(file))
    .sort()
    .at(-1);
  if (recordPath === undefined) return undefined;
  const source = snapshot.readText(recordPath);
  const record = source === undefined ? undefined : parseApkSizeRecord(source);
  if (record === undefined) {
    return {
      detail: `attribution record ${recordPath} is malformed; no APK total was trusted`,
      fix: "Regenerate the record with the APK artifact, SHA-256, build directory, and rebuilt byte total.",
      name: "APK size",
      status: "warn",
    };
  }
  if (!evidenceExists(snapshot, record.buildDirectory, true)) {
    return {
      detail: `missing evidence — attribution record ${recordPath} names build directory ${record.buildDirectory}, which is missing`,
      fix: "Rebuild the recorded Android variant before using its attribution total.",
      name: "APK size",
      status: "warn",
    };
  }
  const artifact = evidencePath(snapshot, record.artifact);
  if (!evidenceExists(snapshot, record.artifact, false) || artifact === undefined) {
    return {
      detail: `missing evidence — attribution record ${recordPath} names APK artifact ${record.artifact}, which is missing`,
      fix: "Rebuild the recorded Android variant before using its attribution total.",
      name: "APK size",
      status: "warn",
    };
  }
  let actualBytes: number;
  let actualSha256: string;
  try {
    actualBytes = statSync(artifact).size;
    actualSha256 = sha256File(artifact);
  } catch {
    return {
      detail: `missing evidence — APK artifact ${record.artifact} could not be read`,
      fix: "Rebuild the recorded Android variant before using its attribution total.",
      name: "APK size",
      status: "warn",
    };
  }
  if (actualBytes !== record.bytes) {
    return {
      detail: `evidence differs — ${record.artifact} is ${actualBytes.toLocaleString("en-US")} bytes, but ${recordPath} records a different total`,
      fix: "Regenerate the attribution record from this APK before trusting its rows.",
      name: "APK size",
      status: "warn",
    };
  }
  if (actualSha256 !== record.sha256) {
    return {
      detail: `evidence differs — ${record.artifact} has SHA-256 ${actualSha256}, but ${recordPath} records ${record.sha256}`,
      fix: "Regenerate the attribution record from this APK before trusting its rows.",
      name: "APK size",
      status: "warn",
    };
  }
  return {
    detail: `last attributed APK: ${record.bytes.toLocaleString("en-US")} bytes (${recordPath})`,
    name: "APK size",
    status: "ok",
  };
}

function dependencyChecks(snapshot: IProjectSnapshot): IDoctorCheck[] {
  const declared = declaredDependencies(snapshot.packageJson);
  const missing = declared.filter((name) => !snapshot.installedVersions.has(name));
  const installed = [...snapshot.installedVersions].sort(([a], [b]) => a.localeCompare(b));
  // The cohort versions per package, so a patch may differ (assets 0.3.5 beside core 0.3.4); on
  // 0.x the minor is the compatibility boundary, which is what the peer ranges name.
  const series = new Set(installed.map(([, version]) => version.split(".").slice(0, 2).join(".")));
  const versions = new Set(installed.map(([, version]) => version));
  return [
    missing.length > 0
      ? {
          detail: `declared but not installed: ${missing.join(", ")}`,
          fix: "Install dependencies: 'npm install' (or the package manager this project uses).",
          name: "dependencies",
          status: "fail",
        }
      : {
          detail:
            declared.length === 0
              ? "no @threenative packages declared"
              : `${declared.length} installed`,
          name: "dependencies",
          status: "ok",
        },
    series.size > 1
      ? {
          detail: `@threenative packages disagree on version: ${installed
            .map(([name, version]) => `${name}@${version}`)
            .join(", ")}`,
          fix: "Install one version across all @threenative packages; mixed versions break at the package boundary.",
          name: "versions",
          status: "fail",
        }
      : {
          detail:
            versions.size === 0
              ? "nothing installed to compare"
              : versions.size === 1
                ? `all at ${[...versions][0]}`
                : `all on the ${[...series][0]} series (${installed.map(([name, version]) => `${name}@${version}`).join(", ")})`,
          name: "versions",
          status: "ok",
        },
  ];
}

function nativeEntryCheck(snapshot: IProjectSnapshot): IDoctorCheck {
  const entry = nativeEntryFrom(snapshot.config);
  if (!snapshot.files.has(entry)) {
    return {
      detail: `the portable entry ${entry} does not exist, so a native build has nothing to start`,
      fix: `Create ${entry} with a default game export, or point threenative.nativeEntry at the file that has one.`,
      name: "native entry",
      status: "fail",
    };
  }
  const source = snapshot.readText(entry) ?? "";
  if (!/export\s+default\b/u.test(source)) {
    return {
      detail: `${entry} has no default export; the native host rejects it with TN_NATIVE_ENTRY_NO_DEFAULT`,
      fix: `Add 'export default' to the game defined in ${entry}.`,
      name: "native entry",
      status: "fail",
    };
  }
  return { detail: `${entry} default-exports a game`, name: "native entry", status: "ok" };
}

interface IInstallStatus {
  readonly key?: unknown;
  readonly ok?: unknown;
  readonly reason?: unknown;
  readonly url?: unknown;
  readonly version?: unknown;
}

function nativeRuntimeKey(): string {
  return `${process.platform}-${process.arch}`;
}

function nativeRuntimeFilename(): string {
  return process.platform === "win32" ? "threenative-runtime.exe" : "threenative-runtime";
}

/**
 * What the installed host binary says it is.
 *
 * The prebuilt is not the package: a release tarball can ship a host older than the version on its
 * own `package.json`, and its install status describes the download rather than the binary. The
 * published `runtime-native-v0.3.2` prebuilt answers `Mystral Native Runtime v0.3.0`, which built
 * every desktop binary whose UI never appeared (PRD-394 phase 4). Asking the host is the only
 * reading that does not trust metadata about a binary it never ran.
 */
export interface INativeHostProbe {
  /** Why the host could not be read, for the failure detail. */
  readonly reason?: string;
  /** The runtime version the host reports, absent when it did not name one. */
  readonly runtimeVersion?: string;
}

/** How long the host's own `--version` may take. It answers without opening a window. */
const NATIVE_HOST_PROBE_TIMEOUT_MS = 20_000;

/** Runs the host's `--version`. Exported so a test can prove the failure shapes without a binary. */
export function probeNativeHost(binary: string): INativeHostProbe {
  try {
    const output = execFileSync(binary, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: NATIVE_HOST_PROBE_TIMEOUT_MS,
    });
    const runtimeVersion = output.match(/Native Runtime v(\d+\.\d+(?:\.\d+)?)/u)?.[1];
    return runtimeVersion === undefined
      ? { reason: "the host did not name its runtime version" }
      : { runtimeVersion };
  } catch (error) {
    return { reason: error instanceof Error ? error.message : String(error) };
  }
}

export function nativeRuntimeCheck(snapshot: IProjectSnapshot): IDoctorCheck {
  const key = nativeRuntimeKey();
  if (snapshot.runtimeRoot === undefined || snapshot.readRuntimeText === undefined) {
    return snapshot.installedVersions.has(RUNTIME_PACKAGE)
      ? {
          detail: `unavailable — ${RUNTIME_PACKAGE} is installed but its package root could not be resolved`,
          fix: "Reinstall dependencies so the native runtime package resolves from node_modules.",
          name: "native runtime",
          status: "fail",
        }
      : {
          detail: "unknown — no install status recorded",
          fix: "Install @threenative/runtime-native before building a native target.",
          name: "native runtime",
          status: "warn",
        };
  }

  const statusText = snapshot.readRuntimeText("prebuilt/install-status.json");
  if (statusText === undefined) {
    return {
      detail: "unknown — no install status recorded",
      fix: "Run npm install so the runtime install hook can record its result.",
      name: "native runtime",
      status: "warn",
    };
  }

  let status: IInstallStatus;
  try {
    const parsed: unknown = JSON.parse(statusText);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error("status is not an object");
    status = parsed as IInstallStatus;
  } catch (error) {
    return {
      detail: `unavailable — install status is malformed: ${error instanceof Error ? error.message : String(error)}`,
      fix: "Remove node_modules/@threenative/runtime-native and run npm install again.",
      name: "native runtime",
      status: "fail",
    };
  }

  if (status.ok !== true) {
    const reason =
      typeof status.reason === "string" ? status.reason : "the install hook recorded no reason";
    return {
      detail: `unavailable — ${key}: ${reason}`,
      fix: "Fix the recorded prebuilt download failure, then run npm install again.",
      name: "native runtime",
      status: "fail",
    };
  }
  if (status.key !== key) {
    return {
      detail: `unavailable — install status is for ${String(status.key ?? "an unknown target")}, not ${key}`,
      fix: "Remove the runtime package and run npm install on this platform.",
      name: "native runtime",
      status: "fail",
    };
  }
  const installedVersion = snapshot.installedVersions.get(RUNTIME_PACKAGE);
  if (status.version !== installedVersion) {
    return {
      detail: `unavailable — install status version ${String(status.version ?? "is missing")} does not match installed runtime ${String(installedVersion ?? "with no version")}`,
      fix: "Remove the runtime package and run npm install to refresh its prebuilt status.",
      name: "native runtime",
      status: "fail",
    };
  }
  if (snapshot.runtimeManifestUrl === undefined) {
    return {
      detail: "unavailable — the installed runtime release URL contract could not be loaded",
      fix: "Reinstall @threenative/runtime-native so scripts/install-prebuilt.mjs is present.",
      name: "native runtime",
      status: "fail",
    };
  }
  if (status.url !== snapshot.runtimeManifestUrl) {
    return {
      detail: `unavailable — install status release URL ${String(status.url ?? "is missing")} does not match ${snapshot.runtimeManifestUrl}`,
      fix: "Remove the runtime package and run npm install to fetch the current release manifest.",
      name: "native runtime",
      status: "fail",
    };
  }

  const binary = `prebuilt/${key}/${nativeRuntimeFilename()}`;
  const exists =
    snapshot.runtimeFileExists?.(binary) ?? existsSync(path.join(snapshot.runtimeRoot, binary));
  if (!exists) {
    return {
      detail: `unavailable — ${key} prebuilt binary is missing`,
      fix: "Run npm install again to restore the native runtime prebuilt.",
      name: "native runtime",
      status: "fail",
    };
  }
  // The package version is not the host's version, and only the host knows its own. This is the
  // check that catches the stale published prebuilt: `runtime-native-v0.3.2` answered
  // `Mystral Native Runtime v0.3.0`, its install status said 0.3.2, and every game built with it
  // produced a desktop binary whose UI never appeared.
  const host = snapshot.nativeHost ?? probeNativeHost(path.join(snapshot.runtimeRoot, binary));
  const reported = host.runtimeVersion;
  if (reported === undefined) {
    return {
      detail: `unavailable — the ${key} host did not report a runtime version (${host.reason ?? "no reason given"})`,
      fix: "Reinstall the native runtime, or build it from source with `pnpm --filter @threenative/runtime-native native:build`: doctor cannot vouch for a host it cannot identify.",
      name: "native runtime",
      status: "fail",
    };
  }
  const required = newestVersion([
    snapshot.installedVersions.get(RUNTIME_PACKAGE),
    snapshot.installedVersions.get(CORE_PACKAGE_NAME),
  ]);
  const lags = required === undefined ? undefined : hostIsOlder(reported, required);
  if (lags !== false) {
    return {
      detail:
        lags === true
          ? `unavailable — the ${key} host reports runtime v${reported}, older than the installed engine ${String(required)}`
          : `unavailable — the ${key} host reports runtime v${reported}, which cannot be compared with the installed engine ${String(required)}`,
      fix: "Install a native runtime at least as new as the engine, or build one from source with `pnpm --filter @threenative/runtime-native native:build`. A host older than the engine builds a desktop binary whose UI never appears.",
      name: "native runtime",
      status: "fail",
    };
  }
  return {
    detail: `available (${key}, host runtime v${reported})`,
    name: "native runtime",
    status: "ok",
  };
}

/** `major.minor.patch`, with any prerelease or build suffix, as numbers; `undefined` otherwise. */
function versionParts(value: string): readonly [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(value.trim());
  if (match === null) return undefined;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return parts.every(Number.isSafeInteger) ? parts : undefined;
}

/** The newest of the versions that are present, or `undefined` when none are readable. */
function newestVersion(versions: readonly (string | undefined)[]): string | undefined {
  let best: string | undefined;
  let bestParts: readonly [number, number, number] | undefined;
  for (const candidate of versions) {
    if (candidate === undefined) continue;
    const parts = versionParts(candidate);
    if (parts === undefined) continue;
    if (bestParts === undefined || isNewer(parts, bestParts)) {
      best = candidate;
      bestParts = parts;
    }
  }
  return best;
}

function isNewer(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): boolean {
  const [leftMajor, leftMinor, leftPatch] = left;
  const [rightMajor, rightMinor, rightPatch] = right;
  if (leftMajor !== rightMajor) return leftMajor > rightMajor;
  if (leftMinor !== rightMinor) return leftMinor > rightMinor;
  return leftPatch > rightPatch;
}

/**
 * Whether the host is older than what the engine requires.
 *
 * `undefined` when either side cannot be read as a version — a caller that cannot compare cannot
 * pass, because the one release this check exists for reported a version the package metadata did
 * not.
 */
function hostIsOlder(host: string, required: string): boolean | undefined {
  const hostParts = versionParts(host);
  const requiredParts = versionParts(required);
  if (hostParts === undefined || requiredParts === undefined) return undefined;
  const [hostMajor, hostMinor, hostPatch] = hostParts;
  const [requiredMajor, requiredMinor, requiredPatch] = requiredParts;
  if (hostMajor !== requiredMajor) return hostMajor < requiredMajor;
  if (hostMinor !== requiredMinor) return hostMinor < requiredMinor;
  if (hostPatch !== requiredPatch) return hostPatch < requiredPatch;
  // Same release: a prerelease host is older than the release it precedes.
  return /[-+]/u.test(host.trim()) && !/[-+]/u.test(required.trim());
}

function javaVersion(
  output: string,
): { readonly major: number; readonly version: string } | undefined {
  const match = output.match(/version\s+["']([^"']+)["']/iu);
  const version = match?.[1];
  if (version === undefined) return undefined;
  const majorMatch = version.startsWith("1.")
    ? version.match(/^1\.(\d+)/u)
    : version.match(/^(\d+)/u);
  const majorText = majorMatch?.[1];
  const major = majorText === undefined ? Number.NaN : Number(majorText);
  return Number.isSafeInteger(major) ? { major, version } : undefined;
}

function androidSdkVersion(root: string, requiredSdk: number): string | undefined {
  const sourceProperties = path.join(
    root,
    "platforms",
    `android-${requiredSdk}`,
    "source.properties",
  );
  try {
    const source = readFileSync(sourceProperties, "utf8");
    const match = source.match(/^Pkg\.Revision\s*=\s*(\S+)/mu);
    return match?.[1];
  } catch {
    return undefined;
  }
}

export function probeAndroidToolchain(
  environment: NodeJS.ProcessEnv = process.env,
  requiredSdk: number = DEFAULT_ANDROID_COMPILE_SDK,
): IAndroidToolchainProbe {
  const javaHome = environment.JAVA_HOME?.trim() || undefined;
  const java =
    javaHome === undefined
      ? "java"
      : path.join(javaHome, "bin", process.platform === "win32" ? "java.exe" : "java");
  let jdkMajor: number | undefined;
  let jdkVersion: string | undefined;
  try {
    const result = spawnSync(java, ["-version"], {
      encoding: "utf8",
      env: { ...environment },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    });
    const parsed = javaVersion(`${result.stdout ?? ""}${result.stderr ?? ""}`);
    jdkMajor = parsed?.major;
    jdkVersion = parsed?.version;
  } catch {
    // The doctor reports the missing version below; probing must not turn an absent toolchain into
    // an opaque process exception.
  }

  const sdkCandidates = [
    environment.ANDROID_HOME,
    environment.ANDROID_SDK_ROOT,
    path.join(homedir(), "Android", "Sdk"),
  ]
    .map((candidate) => candidate?.trim())
    .filter((candidate): candidate is string => candidate !== undefined && candidate.length > 0);
  const sdkRoot = sdkCandidates.find((candidate) => existsSync(candidate));
  return {
    ...(jdkMajor === undefined ? {} : { jdkMajor }),
    ...(jdkVersion === undefined ? {} : { jdkVersion }),
    ...(sdkRoot === undefined ? {} : { sdkVersion: androidSdkVersion(sdkRoot, requiredSdk) }),
  };
}

function runtimeFileAvailable(snapshot: IProjectSnapshot, relative: string): boolean {
  if (snapshot.runtimeRoot === undefined) return false;
  return (
    snapshot.runtimeFileExists?.(relative) ?? existsSync(path.join(snapshot.runtimeRoot, relative))
  );
}

function androidTargetCheck(snapshot: IProjectSnapshot): IDoctorCheck {
  if (!runtimeFileAvailable(snapshot, "scripts/package-android.mjs")) {
    return {
      detail: "unavailable — @threenative/runtime-native has no Android packager",
      name: "target android",
      status: snapshot.runtimeRoot === undefined ? "warn" : "fail",
    };
  }
  const requiredSdk = requiredAndroidSdk(snapshot);
  const androidToolchain =
    snapshot.androidToolchain ??
    (snapshot.projectRoot === undefined
      ? undefined
      : probeAndroidToolchain(process.env, requiredSdk));
  const toolchain =
    androidToolchain === undefined
      ? undefined
      : androidToolchainStatus(androidToolchain, requiredSdk);
  return {
    detail:
      toolchain === undefined
        ? "available — runtime packager installed; Android toolchain was not probed in this in-memory snapshot"
        : `available — runtime packager installed; ${toolchain.detail}`,
    ...(toolchain?.fix === undefined ? {} : { fix: toolchain.fix }),
    name: "target android",
    status: toolchain?.status ?? "ok",
  };
}

function iosTargetCheck(snapshot: IProjectSnapshot): IDoctorCheck {
  const iosPackager = runtimeFileAvailable(snapshot, "scripts/package-ios.mjs");
  const iosHost = process.platform === "darwin" && process.arch === "arm64";
  if (iosHost && iosPackager) {
    return {
      detail: "available — darwin-arm64 simulator packager installed",
      name: "target ios",
      status: "ok",
    };
  }
  return {
    detail: iosHost
      ? "unavailable — @threenative/runtime-native has no iOS packager"
      : `unavailable — iOS simulator packaging requires darwin-arm64; received ${process.platform}-${process.arch}`,
    name: "target ios",
    status: iosHost ? "fail" : "warn",
  };
}

/**
 * Why a requested build cannot start, in the order the build itself would hit it.
 *
 * The defect this closes: every target check answered "is the packager installed?", so a project
 * whose runtime download 404'd and whose only JDK was unsupported still read `available` with a
 * warning beside it. A warning is not a prediction. When the developer names the build they are
 * about to run, a missing prerequisite for *that* build is a failure.
 */
function requestedBuildBlockers(
  snapshot: IProjectSnapshot,
  request: Required<Pick<IDoctorRequest, "target">> & IDoctorRequest,
  nativeRuntime: IDoctorCheck,
): readonly string[] {
  const blockers: string[] = [];
  if (request.target === "web") {
    if (!snapshot.files.has("src/main.ts")) blockers.push("src/main.ts is missing");
    return blockers;
  }
  // Every native target ships the downloaded runtime; its install status is the download's receipt.
  if (nativeRuntime.status !== "ok")
    blockers.push(nativeRuntime.detail.replace(/^(?:unavailable|unknown) — /u, ""));
  // The thing the native host actually starts. Left out, a project with no portable entry read
  // `buildable — android` on a supported JDK while the build it predicted cannot start at all.
  const nativeEntry = nativeEntryCheck(snapshot);
  if (nativeEntry.status === "fail") blockers.push(nativeEntry.detail);
  if (request.target === "desktop") {
    // The phase names overlay capability among the prerequisites that must prevent a buildable
    // result. A desktop game whose overlay cannot start is not a desktop build that works.
    const overlay = snapshot.desktopOverlay;
    if (overlay?.status === "fail") blockers.push(overlay.detail);
    return blockers;
  }
  if (request.target === "ios") {
    if (process.platform !== "darwin" || process.arch !== "arm64")
      blockers.push(
        `iOS packaging requires darwin-arm64; this host is ${process.platform}-${process.arch}`,
      );
    else if (!runtimeFileAvailable(snapshot, "scripts/package-ios.mjs"))
      blockers.push(`${RUNTIME_PACKAGE} has no iOS packager`);
    return blockers;
  }
  if (!runtimeFileAvailable(snapshot, "scripts/package-android.mjs"))
    blockers.push(`${RUNTIME_PACKAGE} has no Android packager`);
  const requiredSdk = requiredAndroidSdk(snapshot);
  const androidToolchain =
    snapshot.androidToolchain ??
    (snapshot.projectRoot === undefined
      ? undefined
      : probeAndroidToolchain(process.env, requiredSdk));
  if (androidToolchain === undefined) blockers.push("the Android toolchain was not probed");
  else blockers.push(...androidToolchainFacts(androidToolchain, requiredSdk).blockers);
  if (request.mode === "release") {
    // Presence only: doctor never reads a signing value, so a wrong password is the build's red,
    // not a diagnosis this command can honestly make.
    const environment = snapshot.environment ?? {};
    const missing = ANDROID_RELEASE_SIGNING_ENV.filter(
      (name) => (environment[name] ?? "").trim().length === 0,
    );
    if (missing.length > 0)
      blockers.push(`release signing inputs are not set: ${missing.join(", ")}`);
  }
  return blockers;
}

function requestedBuildCheck(
  snapshot: IProjectSnapshot,
  request: IDoctorRequest,
  nativeRuntime: IDoctorCheck,
): IDoctorCheck | undefined {
  const { target } = request;
  if (target === undefined) return undefined;
  const scope = `${target}${request.mode === undefined ? "" : ` ${request.mode}`}`;
  const blockers = requestedBuildBlockers(snapshot, { ...request, target }, nativeRuntime);
  if (blockers.length === 0)
    return { detail: `buildable — ${scope}`, name: "requested build", status: "ok" };
  const requiredSdk = requiredAndroidSdk(snapshot);
  return {
    detail: `not buildable — ${scope}: ${blockers.join("; ")}`,
    fix:
      target === "android"
        ? `Install JDK ${ANDROID_JDK_MAJOR} and Android SDK platform android-${requiredSdk}, reinstall ${RUNTIME_PACKAGE} so its prebuilt downloads${request.mode === "release" ? `, and export ${ANDROID_RELEASE_SIGNING_ENV.join(", ")} from the game's build environment` : ""}.`
        : `Resolve the cause above, then run 'threenative doctor --target ${target}' again.`,
    name: "requested build",
    status: "fail",
  };
}

/**
 * A named target's own prerequisites never veto a build of a different target: an Android request
 * must not demand iOS evidence, and a broken desktop runtime must not fail a web build. Unrequested
 * targets stay in the report — they are still useful — but they stop voting on the exit code.
 */

/**
 * Which build each standing prerequisite check belongs to, for the same reason `unrequestedTarget`
 * exists: a request narrows what decides the exit code. `native runtime` is a prerequisite of
 * every native target and of none of the web one; `desktop overlay` is desktop's alone. A check
 * absent from this table belongs to the project rather than to a target, and always votes.
 */
const TARGET_PREREQUISITE_OWNERS: Readonly<Record<string, readonly DoctorTarget[]>> = Object.freeze(
  {
    "desktop overlay": Object.freeze(["desktop"] as const),
    // Its own words are "so a native build has nothing to start"; a web build starts src/main.ts.
    "native entry": Object.freeze(["android", "desktop", "ios"] as const),
    "native runtime": Object.freeze(["android", "desktop", "ios"] as const),
  },
);

function unrequestedTarget(check: IDoctorCheck): IDoctorCheck {
  return check.status === "fail" ? { ...check, status: "warn" } : check;
}

/**
 * The requested target may not describe itself as `available` while the build of it cannot start.
 *
 * A target line says "is the packager installed?", which is a true and much weaker fact than "can
 * this build run?". Beside an explicit `--target android` that answer still *appears* ready, which
 * is the exact wording the acceptance criteria forbid, so the requested target borrows the
 * verdict's word. Unrequested targets keep the weaker fact: nobody asked them to predict anything.
 */
function requestedTarget(
  check: IDoctorCheck,
  requestedBuild: IDoctorCheck | undefined,
): IDoctorCheck {
  if (requestedBuild?.status !== "fail") return check;
  // Two shapes say "available": `available — <facts>` for web, Android and iOS, and
  // `available (linux-x64)` for desktop, which borrows the native runtime's own line. Matching
  // only the first left `✓ target desktop: available (linux-x64)` standing beside
  // `✗ requested build: not buildable — desktop: no compositor is running` — the exact
  // contradiction this function exists to remove, on the one target whose prerequisite (the
  // overlay) fails most often.
  // `available (linux-x64)` keeps its parentheses through a naive capture, so the desktop line read
  // `probed: (linux-x64)` — a truncation rather than a fact. Unwrap that shape.
  const probed = /^available(?: — (?<facts>.+)| \((?<key>[^)]+)\))$/su.exec(check.detail)?.groups;
  const facts = probed?.facts ?? probed?.key;
  if (facts === undefined) return check;
  // The blockers lead. This line's own facts are what was *probed*, met and unmet alike, so
  // "not buildable — JDK 17.0.19 found; android-35 found" reads as a prediction nobody can act
  // on: every reason it names is satisfied. They stay, behind the word `probed`, because the
  // standing report of what was seen is still useful. `requestedBuild.detail` is
  // `not buildable — <scope>: <blockers>`.
  const blockers =
    /^not buildable — [^:]*: (?<why>.+)$/su.exec(requestedBuild.detail)?.groups?.why ??
    requestedBuild.detail;
  return {
    ...check,
    detail: `not buildable — ${blockers}; probed: ${facts}`,
    fix: requestedBuild.fix ?? check.fix,
    status: "fail",
  };
}

function targetChecks(
  snapshot: IProjectSnapshot,
  nativeRuntime: IDoctorCheck,
  request: IDoctorRequest,
  requestedBuild?: IDoctorCheck,
): readonly IDoctorCheck[] {
  const webAvailable = snapshot.files.has("src/main.ts");
  const desktopDetail =
    nativeRuntime.status === "ok"
      ? nativeRuntime.detail
      : `unavailable — ${nativeRuntime.detail.replace(/^(?:unavailable|unknown) — /u, "")}`;
  const checks: readonly IDoctorCheck[] = [
    webAvailable
      ? { detail: "available — src/main.ts", name: "target web", status: "ok" }
      : {
          detail: "unavailable — src/main.ts is missing",
          name: "target web",
          status: "warn",
        },
    {
      detail: desktopDetail,
      name: "target desktop",
      status: nativeRuntime.status,
    },
    androidTargetCheck(snapshot),
    iosTargetCheck(snapshot),
  ];
  if (request.target === undefined) return checks;
  return checks.map((check) =>
    check.name === `target ${request.target}`
      ? requestedTarget(check, requestedBuild)
      : unrequestedTarget(check),
  );
}

function desktopOverlayCheck(probe: IDesktopOverlayProbe): IDoctorCheck {
  return {
    detail: probe.detail,
    fix: probe.fix,
    name: "desktop overlay",
    status: probe.status,
  };
}

/** One project-scoped host config, as doctor found it on disk. */
type HostWiring = "absent" | "incomplete" | "unreadable" | "wired";

/** The manifest the asset pipeline writes beside its outputs; its entries record what was
 * converted rather than authored, which is the only honest proof a conversion ever ran. */
const ASSET_MANIFEST = "public/assets.manifest.json";

function hostWiring(snapshot: IProjectSnapshot, host: IMcpHost): HostWiring {
  if (!snapshot.files.has(host.file)) return "absent";
  const source = snapshot.readText(host.file);
  if (source === undefined) return "unreadable";
  if (host.file.endsWith(".json")) {
    try {
      const parsed: unknown = JSON.parse(source);
      if (record(parsed) === undefined) return "unreadable";
    } catch {
      return "unreadable";
    }
  }
  // Every host format writes each server under its own name, so the names are what is looked for.
  // Reproducing five config shapes here would be a second copy of `SERVER_FORMATS` to keep in step.
  const missing = MCP_SERVER_SPECS.filter(({ configName }) => !source.includes(configName));
  return missing.length === 0 ? "wired" : "incomplete";
}

/**
 * Which agent hosts this project is wired for — a different fact from whether a server starts.
 *
 * `@threenative/core`'s postinstall writes seven project-scoped configs; doctor used to read
 * `.mcp.json` alone, so a game opened in VS Code, Zed or opencode was told capability search was
 * ready on the strength of a file that host never reads. Activation itself is not observable from
 * here — no probe can tell whether an editor loaded a config it found — so this check reports the
 * configuration it can see and says plainly that it stops there.
 */
function editorActivationCheck(snapshot: IProjectSnapshot): IDoctorCheck {
  const wirings = MCP_HOST_TABLE.map((host) => ({ host, wiring: hostWiring(snapshot, host) }));
  const broken = wirings.filter(({ wiring }) => wiring === "incomplete" || wiring === "unreadable");
  const wired = wirings.filter(({ wiring }) => wiring === "wired");
  const manual = `${MANUAL_GLOBAL_MCP_HOSTS.join(", ")} read a machine-wide config only and are wired by hand`;
  const named = broken
    .map(
      ({ host, wiring }) =>
        `${host.file} is ${wiring === "unreadable" ? "unreadable" : "missing ThreeNative servers"}`,
    )
    .join("; ");
  // Nothing wired is the hard failure, and it is tested first. Ordered the other way, corrupting a
  // config *downgraded* the report: a project where no host worked said `warn`, because its broken
  // files were counted before its zero working ones.
  if (wired.length === 0) {
    return {
      detail: `no project-scoped host config carries the ThreeNative servers (looked for ${MCP_HOST_TABLE.map(({ file }) => file).join(", ")})${named === "" ? "" : `; ${named}`}. ${manual}`,
      fix: "Reinstall @threenative/core in this project; its postinstall writes every project-scoped host config.",
      name: "editor activation",
      status: "fail",
    };
  }
  if (broken.length > 0) {
    return {
      // The file is the user's: doctor names it and never rewrites it.
      detail: `${named} — ${wired.length} of ${MCP_HOST_TABLE.length} host configs are complete. ${manual}`,
      fix: "Reinstall @threenative/core to rewrite the host configs it owns, or restore the listed file by hand; doctor never edits it.",
      name: "editor activation",
      status: "warn",
    };
  }
  // One wired host is enough for the agent working in it, so this is `ok` below seven — said out
  // loud, because a green tick at 1 of 7 that does not explain itself reads like a miscount.
  return {
    detail: `${wired.length} of ${MCP_HOST_TABLE.length} host configs carry the servers (${wired
      .map(({ host }) => host.label)
      .join(
        ", ",
      )}); one is enough for the host you work in. Whether an editor loaded it is not observable from here. ${manual}`,
    name: "editor activation",
    status: "ok",
  };
}

/** Whether the asset pipeline has actually converted a model here, read from its own manifest. */
function conversionsExecuted(snapshot: IProjectSnapshot): number | undefined {
  const source = snapshot.readText(ASSET_MANIFEST);
  if (source === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return undefined;
  }
  const entries = record(parsed)?.entries;
  if (!Array.isArray(entries)) return undefined;
  return entries.filter((entry) => typeof record(entry)?.importedFrom === "string").length;
}

/**
 * Model conversion: four facts, never folded into one.
 *
 * The Blender MCP server starting is not the same fact as Blender being installed, which is not
 * the same fact as a conversion having run. A server that advertises `blender_convert` over a
 * healthy transport on a machine with no Blender will fail the first time a tool is called, and
 * before this check the report said "transport initialized and advertised 3 tool(s)" and nothing
 * else — a complete authoring toolchain claimed on the strength of a process that started.
 *
 * **`warn`, never `fail` for a missing application.** A game with no `.fbx`, `.blend`, `.obj` or
 * `.dae` in it needs no Blender and must stay green — a doctor that failed on a 350 MB dependency
 * the project does not use would be a doctor people stop running. A game that *does* carry one of
 * those sources gets a hard failure where it belongs: in the build, from `blenderImportPass`,
 * naming the same command. A broken transport is a different matter and does fail: that is the
 * package this project installed, not an application it chose not to have.
 */
function modelConversionCheck(snapshot: IProjectSnapshot): IDoctorCheck | undefined {
  const probe = snapshot.blender;
  if (probe === undefined) return undefined;
  const name = "model conversion";
  const sources = [...snapshot.files].filter((file) =>
    BLENDER_SOURCE_SUFFIXES.some((suffix) => file.toLowerCase().endsWith(suffix)),
  );
  const executed = conversionsExecuted(snapshot);
  const ran =
    executed === undefined
      ? "no bake manifest here, so no conversion is proven"
      : executed === 0
        ? "the bake manifest records no converted model"
        : `the bake manifest records ${executed} converted model(s)`;
  const transport = snapshot.mcpServerHealth?.get(BLENDER_SERVER);
  if (transport?.status === "fail") {
    return {
      detail: `${BLENDER_SERVER} is configured, but ${transport.detail}; no conversion tool is reachable — ${ran}`,
      fix: `Reinstall @threenative/core and ${BLENDER_PACKAGE.name}, then rerun doctor.`,
      name,
      status: "fail",
    };
  }
  const reachable =
    transport === undefined
      ? `${BLENDER_SERVER} was not probed`
      : `${BLENDER_SERVER} transport is up`;
  if (!probe.available) {
    const carried =
      sources.length === 0
        ? "no .fbx, .blend, .obj or .dae in this project, so nothing needs it yet"
        : `${sources.length} source(s) in this project need it: ${sources.slice(0, 3).join(", ")}`;
    return {
      detail: `${reachable}, but conversion is unavailable: ${probe.detail} — ${carried}; ${ran}`,
      fix: `Install Blender when you want to convert those formats: ${probe.installCommand}`,
      name,
      status: "warn",
    };
  }
  return {
    detail: `${reachable} and Blender ${probe.version ?? "(version unreported)"} converts .fbx, .blend, .obj and .dae on this machine; ${ran}`,
    name,
    status: "ok",
  };
}

export function diagnoseProject(
  snapshot: IProjectSnapshot,
  options: IDoctorRequest & { readonly capturePath?: string } = {},
): IDoctorReport {
  if (record(snapshot.packageJson) === undefined) {
    return {
      checks: [
        {
          detail: "no readable package.json in this directory",
          fix: "Run this inside a generated project, or scaffold one with 'npm create threenative@latest'.",
          name: "package.json",
          status: "fail",
        },
      ],
      pass: false,
    };
  }
  const hasPlaytests = [...snapshot.files].some((file) => file.endsWith(".playtest.json"));
  const blender = modelConversionCheck(snapshot);
  const nativeRuntime = nativeRuntimeCheck(snapshot);
  const apkSize = apkSizeCheck(snapshot);
  const playtest = playtestCheck(snapshot, options.capturePath);
  const requestedBuild = requestedBuildCheck(snapshot, options, nativeRuntime);
  const checks: IDoctorCheck[] = [
    { detail: "readable", name: "package.json", status: "ok" },
    ...dependencyChecks(snapshot),
    nativeEntryCheck(snapshot),
    nativeRuntime,
    assetPipelineCheck(snapshot),
    ...(apkSize === undefined ? [] : [apkSize]),
    ...(!usesDesktopOverlay(snapshot.config) || snapshot.desktopOverlay === undefined
      ? []
      : [desktopOverlayCheck(snapshot.desktopOverlay)]),
    ...targetChecks(snapshot, nativeRuntime, options, requestedBuild),
    ...(requestedBuild === undefined ? [] : [requestedBuild]),
    snapshot.files.has("src/main.ts")
      ? { detail: "src/main.ts is the web entry", name: "web entry", status: "ok" }
      : {
          detail: "no src/main.ts, so 'threenative build' has no web entry to bundle",
          fix: "Add src/main.ts, which mounts the game and any browser-only UI.",
          name: "web entry",
          status: "warn",
        },
    playtest,
    hasPlaytests
      ? { detail: "at least one scenario can prove this game", name: "playtests", status: "ok" }
      : {
          detail: "no *.playtest.json scenario, so nothing here proves the game runs",
          fix: "Create one: 'npx @threenative/playtest init'.",
          name: "playtests",
          status: "warn",
        },
    sceneShapeCheck(snapshot),
    ...capabilitySearchChecks(snapshot),
    editorActivationCheck(snapshot),
    ...(blender === undefined ? [] : [blender]),
  ];
  // A target line is not the only thing that votes. `native runtime` and `desktop overlay` carry
  // the same facts one level down, and demoting only the `target *` checks left `--target web`
  // exiting 1 on a 404 desktop prebuilt and on a missing compositor — both prerequisites of a
  // build nobody asked for, and neither one something a web build can fail on. The help text
  // promises the exit code follows the request, so the prerequisites have to follow it too.
  const scoped =
    options.target === undefined
      ? checks
      : checks.map((check) => {
          const owners = TARGET_PREREQUISITE_OWNERS[check.name];
          return owners === undefined || owners.includes(options.target as DoctorTarget)
            ? check
            : unrequestedTarget(check);
        });
  return { checks: scoped, pass: scoped.every(({ status }) => status !== "fail") };
}

async function collectFiles(root: string, relative = "", depth = 0): Promise<string[]> {
  if (depth > 3) return [];
  const absolute = path.join(root, relative);
  if (!existsSync(absolute)) return [];
  const entries = await readdir(absolute, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".git")) continue;
    const next = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await collectFiles(root, next, depth + 1)));
    else files.push(next);
  }
  return files;
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

async function runtimeReleaseManifestUrl(
  runtimeRoot: string,
  version: string,
): Promise<string | undefined> {
  try {
    const module: unknown = await import(
      pathToFileURL(path.join(runtimeRoot, "scripts", "install-prebuilt.mjs")).href
    );
    const releaseUrl = record(module)?.releaseManifestUrl;
    if (typeof releaseUrl !== "function") return undefined;
    const result: unknown = releaseUrl(version);
    return typeof result === "string" ? result : undefined;
  } catch {
    return undefined;
  }
}

export async function readProject(root: string): Promise<IProjectSnapshot> {
  const projectRoot = path.resolve(root);
  const packageJson = await readJson(path.join(projectRoot, "package.json"));
  const typeScriptConfig = path.join(projectRoot, "threenative.config.ts");
  const config = existsSync(typeScriptConfig)
    ? await readTypeScriptConfig(projectRoot)
    : nativeEntryCompat(record(packageJson)?.threenative);
  const files = new Set(await collectFiles(projectRoot));
  const installedVersions = new Map<string, string>();
  for (const name of declaredDependencies(packageJson)) {
    const manifest = await readJson(path.join(projectRoot, "node_modules", name, "package.json"));
    const version = record(manifest)?.version;
    if (typeof version === "string") installedVersions.set(name, version);
  }
  const runtimeRoot = installedVersions.has(RUNTIME_PACKAGE)
    ? (() => {
        const candidate = path.join(projectRoot, "node_modules", RUNTIME_PACKAGE);
        try {
          return realpathSync(candidate);
        } catch {
          return undefined;
        }
      })()
    : undefined;
  const runtimeVersion = installedVersions.get(RUNTIME_PACKAGE);
  const runtimeManifestUrl =
    runtimeRoot === undefined || runtimeVersion === undefined
      ? undefined
      : await runtimeReleaseManifestUrl(runtimeRoot, runtimeVersion);
  const playtestRunnerPath = resolveBinaryFrom(projectRoot, PLAYTEST_BINARY);
  const mcpServerHealth = new Map<string, IMcpServerHealth>();
  if (SHAPE_VERIFIABLE_HOSTS.some(({ file }) => files.has(file))) {
    for (const spec of MCP_SERVER_SPECS) {
      if (existsSync(path.resolve(projectRoot, spec.expectedArgs))) {
        mcpServerHealth.set(spec.configName, probeMcpServer(projectRoot, spec));
      }
    }
  }
  return {
    config,
    files,
    installedVersions,
    mcpServerHealth,
    packageJson,
    projectRoot,
    readText: (relative) => {
      const file = path.join(projectRoot, relative);
      try {
        return existsSync(file) ? readFileSync(file, "utf8") : undefined;
      } catch {
        return undefined;
      }
    },
    androidToolchain: probeAndroidToolchain(process.env, requiredAndroidSdkFromRoot(runtimeRoot)),
    blender: (() => {
      const status = resolveBlender();
      return {
        available: status.available,
        detail: status.detail,
        installCommand: installCommandFor(),
        ...(status.version === undefined ? {} : { version: status.version }),
      };
    })(),
    ...(usesDesktopOverlay(config) ? { desktopOverlay: probeDesktopOverlay() } : {}),
    environment: process.env,
    ...(playtestRunnerPath === undefined
      ? {}
      : {
          playtestRunnerPath,
          runPlaytestDoctor: (capturePath) =>
            executePlaytestDoctor(playtestRunnerPath, projectRoot, capturePath),
        }),
    ...(runtimeRoot === undefined
      ? {}
      : {
          readRuntimeText: (relative: string) => {
            try {
              return readFileSync(path.join(runtimeRoot, relative), "utf8");
            } catch {
              return undefined;
            }
          },
          runtimeFileExists: (relative: string) => existsSync(path.join(runtimeRoot, relative)),
          nativeHost: probeNativeHost(
            path.join(runtimeRoot, "prebuilt", nativeRuntimeKey(), nativeRuntimeFilename()),
          ),
          ...(runtimeManifestUrl === undefined ? {} : { runtimeManifestUrl }),
          runtimeRoot,
        }),
  };
}

async function readTypeScriptConfig(root: string): Promise<unknown> {
  try {
    return await loadConfig(root);
  } catch {
    // Doctor still reports the independent package, entry, and runtime checks when config
    // validation is already failing; the build path owns the detailed config error.
    return undefined;
  }
}

export function formatDoctorReport(report: IDoctorReport): string {
  const symbols: Record<DoctorStatus, string> = { fail: "✗", ok: "✓", warn: "!" };
  const isBaseline = (name: string): boolean =>
    ["package.json", "dependencies", "versions"].includes(name);
  const isCraft = (name: string): boolean => name.startsWith("capability search");
  const isTest = (name: string): boolean => name === "playtest" || name === "playtests";
  const groups: readonly [string, (name: string) => boolean][] = [
    ["Baseline", isBaseline],
    ["Craft", isCraft],
    ["Test", isTest],
    ["Ship", (name) => !isBaseline(name) && !isCraft(name) && !isTest(name)],
  ];
  const lines: string[] = [];
  for (const [group, belongs] of groups) {
    const checks = report.checks.filter(({ name }) => belongs(name));
    if (checks.length === 0) continue;
    lines.push(`${group}:`);
    lines.push(
      ...checks.map(
        ({ detail, fix, name, status }) =>
          `${symbols[status]} ${name}: ${detail}${fix === undefined || status === "ok" ? "" : `\n    fix: ${fix}`}`,
      ),
    );
  }
  if (!report.pass) lines.push("\nAt least one check failed; fix it before trusting a build here.");
  return `${lines.join("\n")}\n`;
}
