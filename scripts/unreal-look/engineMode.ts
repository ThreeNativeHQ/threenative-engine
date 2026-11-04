/**
 * The engine a PRD-646 calibration capture draws on (PRD-646 `## Decisions`).
 *
 * A tuning frame is drawn on the owned C++ engine and names it (owner rule, PRD-631). Upstream three is
 * reachable only as a named diagnosis arm, `TN_UNREAL_LOOK_ENGINE=threejs`: the frames never feed a gate,
 * because a gate that reads them would tune the look to a renderer the game does not ship.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type CaptureEngine = "threenative" | "threejs";

/** A scaffold's config line: the engine a scene is drawn on (core's `IThreeNativeConfig.engine`). */
const ENGINE_LINE = /^ {2}engine: "(?:threenative|threejs)",\n/mu;
const ENGINE_ANCHOR = '  nativeEntry: "src/game.ts",';

/** `TN_UNREAL_LOOK_ENGINE`: the owned engine unless the run asks for the threejs diagnosis arm. */
export function selectedEngine(env: NodeJS.ProcessEnv = process.env): CaptureEngine {
  const value = env.TN_UNREAL_LOOK_ENGINE;
  if (value === undefined || value === "" || value === "threenative") return "threenative";
  if (value === "threejs") return "threejs";
  throw new Error(
    `TN_UNREAL_LOOK_ENGINE: '${value}' is not an engine; use threenative (default) or threejs (diagnosis only)`,
  );
}

/** What every report line and gi-capture.json says about the engine: a diagnosis frame says so. */
export function engineName(engine: CaptureEngine): string {
  return engine === "threejs" ? "threejs (diagnosis)" : "threenative";
}

/** The drawn engine must be the one the run asked for, or the capture fails closed. */
export function checkDrawnEngine(drawn: unknown, expected: CaptureEngine, where: string): void {
  if (drawn !== expected)
    throw new Error(`TN_UNREAL_LOOK_WRONG_ENGINE: ${where} drew on ${String(drawn)}`);
}

/**
 * The scaffold config with `engine` set as the run asks: threejs for the diagnosis arm, no line (core's
 * default, the owned engine) otherwise. A line a previous arm left is removed first, so the config says
 * what this run draws.
 */
export function withEngine(source: string, engine: CaptureEngine): string {
  const plain = source.replace(ENGINE_LINE, "");
  if (engine === "threenative") return plain;
  if (!plain.includes(ENGINE_ANCHOR))
    throw new Error(`TN_UNREAL_LOOK_PATCH: '${ENGINE_ANCHOR}' not in the scaffold config`);
  return plain.replace(ENGINE_ANCHOR, `${ENGINE_ANCHOR}\n  engine: "threejs",`);
}

/** The cells of a capture report that were drawn on the diagnosis arm. */
export function diagnosisCells(report: unknown): string[] {
  if (typeof report !== "object" || report === null) return [];
  return Object.entries(report as Record<string, unknown>)
    .filter(([, cell]) => (cell as { engine?: unknown } | null)?.engine === engineName("threejs"))
    .map(([key]) => key);
}

/** The diagnosis cells of one ThreeNative capture folder, by the report it wrote. */
export function diagnosisCellsIn(run: string): string[] {
  const file = path.join(run, "gi-capture.json");
  if (!existsSync(file)) return [];
  return diagnosisCells(JSON.parse(readFileSync(file, "utf8")));
}

/**
 * A gate refuses a diagnosis frame: `--write-stats`, a lock write, a lock check and every row verdict.
 * A diagnosis arm answers what a renderer draws; it never decides what the gate accepts.
 */
export function refuseDiagnosis(cells: readonly string[], what: string): void {
  if (cells.length === 0) return;
  throw new Error(
    `TN_UNREAL_LOOK_DIAGNOSIS_ONLY: ${what} would gate ${cells.length} cell(s) drawn on threejs (diagnosis): ${cells
      .slice(0, 3)
      .join(
        ", ",
      )}${cells.length > 3 ? ", ..." : ""}. Capture without TN_UNREAL_LOOK_ENGINE=threejs and gate that`,
  );
}
