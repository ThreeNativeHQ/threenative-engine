import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BLENDER_INSTALL_GUIDANCE,
  type IBlenderStatus,
  installCommandFor,
  resolveBlender,
} from "./detect.js";

/**
 * The one module in this repository that spawns Blender.
 *
 * Both callers go through it: the `blender_convert` / `blender_inspect` MCP tools, and
 * `blenderImportPass` in `@threenative/assets`, which runs on `pnpm build` with no agent present.
 * Two conversion implementations would be two sets of counts to reconcile and two places for the
 * fail-closed rules to drift, so there is exactly one.
 *
 * Every failure is a returned result with a named `cause`, never a rejected promise — except
 * malformed input, which throws. A missing Blender is not an exceptional condition on a machine
 * that never asked for one.
 */

export type BridgeCause =
  | "blender-missing"
  | "blender-too-old"
  | "blender-unreadable"
  | "convert-failed"
  | "no-meshes"
  | "no-output"
  | "script-missing"
  | "unreadable-result"
  | "timeout";

export interface IBlenderSummary {
  readonly blender: string;
  readonly bones: number;
  readonly clips: readonly string[];
  readonly images: readonly string[];
  readonly materials: readonly string[];
  readonly meshes: number;
  readonly mode: string;
  readonly out?: string;
  readonly outBytes?: number;
  readonly source: string;
  readonly triangles: number;
  readonly vertices: number;
}

export interface IBridgeFailure {
  readonly cause: BridgeCause;
  readonly detail: string;
  readonly install: typeof BLENDER_INSTALL_GUIDANCE;
  readonly installCommand: string;
  readonly ok: false;
  readonly stderr?: string;
}

export interface IBridgeSuccess {
  readonly ok: true;
  readonly summary: IBlenderSummary;
}

export type BridgeResult = IBridgeFailure | IBridgeSuccess;

/** The extensions the importer script knows. `KIND_BY_EXTENSION` in `@threenative/assets` must
 * agree with this list, and `blender-import.spec.ts` asserts it does. */
export const BLENDER_SOURCE_EXTENSIONS: readonly string[] = Object.freeze([
  "blend",
  "dae",
  "fbx",
  "obj",
]);

const RESULT_PREFIX = "TN_BLENDER_RESULT ";
const DEFAULT_TIMEOUT_MS = 300_000;

/** Where `gpl/convert.py` lives. `THREENATIVE_BLENDER_SCRIPTS` overrides it for a host that
 * relocated the package's data files. */
export function blenderScriptsDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  const override = environment.THREENATIVE_BLENDER_SCRIPTS;
  if (override !== undefined && override.trim().length > 0) return path.resolve(override.trim());
  // `dist/bridge.js` -> the package root -> `gpl/`. The scripts ship as package data, never bundled.
  return path.resolve(fileURLToPath(import.meta.url), "..", "..", "gpl");
}

function failure(cause: BridgeCause, detail: string, stderr?: string): IBridgeFailure {
  return {
    cause,
    detail,
    install: BLENDER_INSTALL_GUIDANCE,
    installCommand: installCommandFor(),
    ok: false,
    ...(stderr === undefined ? {} : { stderr }),
  };
}

/** Where the run's private temp directory is created: the caller's `TMPDIR` when it named one,
 * so a sandbox that redirects temp keeps its redirection, and the platform's otherwise. */
function temporaryRoot(environment: NodeJS.ProcessEnv): string {
  const named = environment.TMPDIR ?? environment.TEMP ?? environment.TMP;
  if (named !== undefined && named.trim().length > 0 && existsSync(named.trim())) {
    return path.resolve(named.trim());
  }
  return os.tmpdir();
}

function unavailable(status: IBlenderStatus): IBridgeFailure {
  const cause: BridgeCause =
    status.cause === "blender-too-old"
      ? "blender-too-old"
      : status.cause === "blender-unreadable"
        ? "blender-unreadable"
        : "blender-missing";
  return failure(cause, status.detail);
}

/** The summary the Python script printed, or `undefined` when it printed none. */
export function parseBlenderResult(stdout: string): IBlenderSummary | undefined {
  const line = stdout
    .split("\n")
    .reverse()
    .find((candidate) => candidate.startsWith(RESULT_PREFIX));
  if (line === undefined) return undefined;
  try {
    return JSON.parse(line.slice(RESULT_PREFIX.length)) as IBlenderSummary;
  } catch {
    return undefined;
  }
}

export interface IBlenderRunOptions {
  readonly environment?: NodeJS.ProcessEnv;
  /** An extra script to run instead of `gpl/convert.py`; the escape hatch's path. */
  readonly script?: string;
  /** Where `convert.py` lives, for a consumer that ships its own copy of `gpl/` — see
   * `packages/assets/scripts/bundle-blender-gpl.mjs`. Wins over the env override. */
  readonly scriptsDirectory?: string;
  readonly timeoutMs?: number;
}

interface ISpawnOutcome {
  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
}

function runBlender(
  binary: string,
  script: string,
  request: Record<string, unknown>,
  timeoutMs: number,
  environment: NodeJS.ProcessEnv,
): Promise<ISpawnOutcome> {
  return new Promise((resolve) => {
    // `--factory-startup` so a user's own add-ons and preferences cannot change what a build
    // produces: the same source must compile to the same GLB on every machine.
    const args = [
      "--background",
      "--factory-startup",
      "--python-exit-code",
      "3",
      "--python",
      script,
      "--",
      JSON.stringify(request),
    ];
    execFile(
      binary,
      args,
      { encoding: "utf8", env: environment, maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs },
      (error, stdout, stderr) => {
        const killed = (error as { killed?: boolean } | null)?.killed === true;
        const code = (error as { code?: number } | null)?.code;
        resolve({
          code: error === null ? 0 : typeof code === "number" ? code : null,
          stderr,
          stdout,
          timedOut: killed,
        });
      },
    );
  });
}

function assertSourcePath(source: unknown): string {
  if (typeof source !== "string" || source.trim().length === 0) {
    throw new Error("TN_BLENDER_BRIDGE: 'source' must be a non-empty path.");
  }
  return path.resolve(source);
}

async function run(
  request: Record<string, unknown>,
  options: IBlenderRunOptions,
): Promise<BridgeResult> {
  const environment = options.environment ?? process.env;
  const status = resolveBlender(environment);
  if (!status.available || status.path === undefined) return unavailable(status);

  const scripts = options.scriptsDirectory ?? blenderScriptsDirectory(environment);
  const script = options.script ?? path.join(scripts, "convert.py");
  if (!existsSync(script)) {
    return failure(
      "script-missing",
      `The Blender script '${script}' is not on disk. Set THREENATIVE_BLENDER_SCRIPTS to the package's gpl/ directory.`,
    );
  }

  // Blender scatters scratch files through its temp directory — packed images, a quit.blend, a
  // render cache — and a build that runs it per asset would leave one set behind per asset. It
  // gets a private directory that goes away with the process, so nothing accumulates in the
  // caller's `TMPDIR` whether the run succeeded, failed or timed out.
  const temporary = await mkdtemp(path.join(temporaryRoot(environment), "tn-blender-"));
  let outcome: ISpawnOutcome;
  try {
    outcome = await runBlender(
      status.path,
      script,
      request,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      { ...environment, TEMP: temporary, TMP: temporary, TMPDIR: temporary },
    );
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
  if (outcome.timedOut) {
    return failure(
      "timeout",
      `Blender did not finish within ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms.`,
      outcome.stderr,
    );
  }
  const summary = parseBlenderResult(outcome.stdout);
  if (outcome.code !== 0) {
    // The script's own `TN_BLENDER_ERROR:` line is the readable half of a Blender stderr dump.
    const named = outcome.stderr.split("\n").find((line) => line.startsWith("TN_BLENDER_ERROR:"));
    const noMeshes = named?.includes("produced no meshes") === true;
    return failure(
      noMeshes ? "no-meshes" : "convert-failed",
      named ?? `Blender exited ${outcome.code ?? "by signal"} for '${String(request.source)}'.`,
      outcome.stderr,
    );
  }
  if (summary === undefined) {
    return failure(
      "unreadable-result",
      "Blender exited 0 but printed no readable result line; refusing to report a conversion that cannot be described.",
      outcome.stderr,
    );
  }
  if (summary.meshes === 0) {
    return failure("no-meshes", `'${summary.source}' produced no meshes.`, outcome.stderr);
  }
  if (request.mode === "convert") {
    const out = summary.out;
    if (out === undefined || !existsSync(out)) {
      return failure(
        "no-output",
        `Blender reported success but wrote no file at '${String(request.out)}'.`,
        outcome.stderr,
      );
    }
  }
  return { ok: true, summary };
}

/** What a source file contains, without writing anything. */
export async function inspectModel(
  source: string,
  options: IBlenderRunOptions = {},
): Promise<BridgeResult> {
  return run({ mode: "inspect", source: assertSourcePath(source) }, options);
}

/** Converts a source model to a GLB at `out`. Zero meshes out is a failure, never an empty GLB. */
export async function convertModel(
  source: string,
  out: string,
  options: IBlenderRunOptions = {},
): Promise<BridgeResult> {
  if (typeof out !== "string" || out.trim().length === 0) {
    throw new Error("TN_BLENDER_BRIDGE: 'out' must be a non-empty path.");
  }
  return run(
    { mode: "convert", out: path.resolve(out), source: assertSourcePath(source) },
    options,
  );
}

/** Runs a caller-supplied bpy script through the same spawn, timeout and fail-closed handling. */
export async function runBlenderScript(
  script: string,
  request: Record<string, unknown>,
  options: IBlenderRunOptions = {},
): Promise<BridgeResult> {
  if (typeof script !== "string" || script.trim().length === 0) {
    throw new Error("TN_BLENDER_BRIDGE: 'script' must be a non-empty path.");
  }
  return run(request, { ...options, script: path.resolve(script) });
}

export { resolveBlender, BLENDER_INSTALL_GUIDANCE, installCommandFor };
export type { IBlenderStatus };
