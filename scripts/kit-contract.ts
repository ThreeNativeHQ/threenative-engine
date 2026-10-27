import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createProject, templateRoot } from "../packages/create-threenative/src/index.js";
import {
  type IKitContractEntry,
  KIT_CONTRACT_ROW_IDS,
  type KitContractVerdict,
  planKitContract,
} from "../packages/playtest/src/kit-contract.js";

/**
 * The kit contract (PRD-749) as a sweep: every row on every kit, one scenario per row, so a bug
 * found in one kit reports every kit that has it in one run. The declarations live beside the
 * template playtests, so a generated game never carries them.
 */

export type KitContractStatus = "fail" | "opt-out" | "pass";

export interface IKitContractResult {
  readonly detail?: string;
  readonly kit: string;
  readonly row: string;
  readonly status: KitContractStatus;
}

export interface IKitContractDependencies {
  readonly entries?: Readonly<Record<string, IKitContractEntry>>;
  readonly runScenario?: (kit: string, target: string, scenarioPath: string) => Promise<IScenarioOutcome>;
  readonly scaffold?: (kit: string, target: string) => Promise<void>;
}

export interface IScenarioOutcome {
  readonly detail?: string;
  readonly pass: boolean;
}

const CONTRACT_FILE = path.resolve(templateRoot(), "..", "template-playtests", "contract.json");

export async function loadKitContract(file: string = CONTRACT_FILE): Promise<Record<string, IKitContractEntry>> {
  return JSON.parse(await readFile(file, "utf8")) as Record<string, IKitContractEntry>;
}

/**
 * Runs the planned rows for each kit. An undeclared row or a bad opt-out throws before anything is
 * scaffolded; a failing row is a result, so the rest of the sweep still reports.
 */
export async function runKitContract(
  kits: readonly string[],
  root: string,
  packageSources: Readonly<Record<string, string>>,
  dependencies: IKitContractDependencies = {},
  rows?: readonly string[],
): Promise<readonly IKitContractResult[]> {
  const entries = dependencies.entries ?? (await loadKitContract());
  const plan = planKitContract(entries, kits);
  const unknown = (rows ?? []).filter((row) => !KIT_CONTRACT_ROW_IDS.includes(row));
  if (unknown.length > 0) throw new Error(`TN_KIT_CONTRACT_ROWS names no such row: ${unknown.join(", ")}`);
  const results: IKitContractResult[] = [];
  for (const kit of kits) {
    const verdicts = plan.filter((verdict) => verdict.kit === kit && (rows === undefined || rows.includes(verdict.row)));
    for (const verdict of verdicts) {
      if (verdict.kind === "opt-out") results.push({ detail: verdict.reason, kit, row: verdict.row, status: "opt-out" });
    }
    const runs = verdicts.filter((verdict): verdict is Extract<KitContractVerdict, { kind: "run" }> => verdict.kind === "run");
    if (runs.length === 0) continue;
    const target = path.join(root, kit);
    try {
      await (dependencies.scaffold ?? scaffoldKit(packageSources))(kit, target);
    } catch (error) {
      for (const run of runs) results.push({ detail: `scaffold failed: ${errorDetail(error)}`, kit, row: run.row, status: "fail" });
      continue;
    }
    const directory = path.join(target, "playtests", "contract");
    await mkdir(directory, { recursive: true });
    for (const run of runs) {
      const scenarioPath = path.join(directory, `${run.row}.playtest.json`);
      await writeFile(scenarioPath, JSON.stringify(run.scenario, null, 2));
      try {
        const outcome = await (dependencies.runScenario ?? runScenario)(kit, target, scenarioPath);
        results.push({ ...(outcome.detail === undefined ? {} : { detail: outcome.detail }), kit, row: run.row, status: outcome.pass ? "pass" : "fail" });
      } catch (error) {
        results.push({ detail: errorDetail(error), kit, row: run.row, status: "fail" });
      }
    }
    await rm(directory, { force: true, recursive: true });
  }
  return results;
}

function scaffoldKit(packageSources: Readonly<Record<string, string>>) {
  return async (kit: string, target: string): Promise<void> => {
    const built = await access(path.join(target, "node_modules")).then(
      () => true,
      () => false,
    );
    // The ordinary playtest sweep already scaffolded and installed this kit; reuse it.
    if (!built) await createProject({ install: true, packageSources, target, template: kit });
  };
}

/** One scenario, one browser run: a failure then names its row, and a runner error cannot hide the others. */
async function runScenario(_kit: string, target: string, scenarioPath: string): Promise<IScenarioOutcome> {
  const built = await access(path.join(target, "dist")).then(
    () => true,
    () => false,
  );
  if (!built) await exec("pnpm", ["build:web"], target);
  const { code, stdout, stderr } = await exec(
    "pnpm",
    [
      "exec",
      "threenative-playtest",
      "--scenario",
      path.relative(target, scenarioPath),
      "--browser-recipe",
      "webgpu",
      "--headed",
      "--server-command",
      "pnpm exec vite preview --host 127.0.0.1 --port $PORT --strictPort",
    ],
    target,
    true,
  );
  return { detail: summarizeReport(stdout, stderr), pass: code === 0 };
}

/** The failing assertion ids and the diagnostic codes, or the stderr tail when no report arrived. */
export function summarizeReport(stdout: string, stderr: string): string | undefined {
  const start = stdout.indexOf("{");
  if (start >= 0) {
    try {
      const report = JSON.parse(stdout.slice(start)) as {
        assertions?: ReadonlyArray<{ id: string; pass: boolean }>;
        diagnostics?: ReadonlyArray<{ code: string }>;
      };
      const failed = (report.assertions ?? []).filter(({ pass }) => !pass).map(({ id }) => id);
      const codes = [...new Set((report.diagnostics ?? []).map(({ code }) => code))];
      const parts = [failed.length > 0 ? `failed ${failed.join(", ")}` : "", codes.length > 0 ? codes.join(" ") : ""];
      const text = parts.filter((part) => part !== "").join("; ");
      if (text !== "") return text;
    } catch {
      // Fall through to the stderr tail.
    }
  }
  const tail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400);
  return tail === "" ? undefined : tail;
}

export function formatKitContractMatrix(results: readonly IKitContractResult[]): string {
  const kits = [...new Set(results.map(({ kit }) => kit))];
  const symbol: Record<KitContractStatus, string> = { fail: "FAIL", "opt-out": "opt-out", pass: "ok" };
  const lines = [`kit contract: ${KIT_CONTRACT_ROW_IDS.join(" | ")}`];
  for (const kit of kits) {
    const cells = KIT_CONTRACT_ROW_IDS.map((row) => {
      const found = results.find((result) => result.kit === kit && result.row === row);
      return found === undefined ? "-" : symbol[found.status];
    });
    lines.push(`${kit.padEnd(14)} ${cells.join(" | ")}`);
  }
  for (const result of results.filter(({ status }) => status === "fail"))
    lines.push(`FAIL ${result.kit} ${result.row}: ${result.detail ?? "no detail"}`);
  return lines.join("\n");
}

export function assertKitContractPassed(results: readonly IKitContractResult[]): void {
  const failed = results.filter(({ status }) => status === "fail");
  if (failed.length > 0)
    throw new Error(`TN_KIT_CONTRACT_FAILED: ${failed.map(({ kit, row }) => `${kit}/${row}`).join(", ")}`);
}

interface IExecResult {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}

function exec(command: string, args: readonly string[], cwd: string, capture = false): Promise<IExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!capture && code !== 0) reject(new Error(`${command} ${args.join(" ")} exited ${code ?? "unknown"}.`));
      else resolve({ code: code ?? 1, stderr, stdout });
    });
  });
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
