import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { playtestDiagnostic, type IPlaytestProtocolDiagnostic } from "../diagnostics.js";

/** The project's own scripts a scenario run waits on, in order. */
const CHECK_SCRIPTS = ["typecheck", "lint"] as const;
const OUTPUT_TAIL_BYTES = 4000;

function insideWorkspace(projectPath: string): boolean {
  for (let directory = projectPath; ; directory = dirname(directory)) {
    if (existsSync(join(directory, "pnpm-workspace.yaml"))) return true;
    if (dirname(directory) === directory) return false;
  }
}

/**
 * An installed game's typecheck and lint carry the framework's guardrails (hot-callback allocation,
 * hand-written engine seams, unselected UI state). An agent that only ever runs playtests skips them,
 * so a playtest of an installed project runs them first and a failure fails the run: a weak model
 * finished a "passing" game with two lint errors it never saw (wm-platformer-2, 2026-11-13).
 *
 * A project inside a pnpm workspace (this repository's examples) keeps its own gates, and a project
 * with neither script (plain Three.js) has nothing to run.
 */
export function runProjectCheck(projectPath: string): IPlaytestProtocolDiagnostic | undefined {
  if (insideWorkspace(projectPath)) return undefined;
  const manifestPath = join(projectPath, "package.json");
  if (!existsSync(manifestPath)) return undefined;
  const scripts = (JSON.parse(readFileSync(manifestPath, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
  const manager = existsSync(join(projectPath, "pnpm-lock.yaml")) ? "pnpm" : "npm";
  for (const script of CHECK_SCRIPTS) {
    if (scripts[script] === undefined) continue;
    const run = spawnSync(manager, ["run", "--silent", script], { cwd: projectPath, encoding: "utf8" });
    if (run.status === 0) continue;
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}${run.error === undefined ? "" : String(run.error)}`.trim();
    return playtestDiagnostic(
      "TN_PLAYTEST_CHECK_FAILED",
      `\`${manager} run ${script}\` failed (exit ${run.status ?? "none"}), so no scenario ran:\n${output.slice(-OUTPUT_TAIL_BYTES)}`,
      `Fix what \`${manager} run ${script}\` reports, then rerun. \`--skip-check\` skips this check and says so.`,
    );
  }
  return undefined;
}
