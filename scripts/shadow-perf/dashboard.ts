/**
 * "Shadows vs Unreal" tab of `pnpm dashboard`: reads the lamp-shadow perf loop's results file
 * (PRD-650/652) and pairs each iteration's ThreeNative and Unreal GPU times per scene. It times
 * nothing itself and writes nothing.
 *
 * Fail closed: a missing file is `pending`, a malformed one is `invalid` with the reason, and a
 * missing time stays `undefined`, never a zero.
 */
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** The loop's results file; `SHADOW_PERF_RESULTS` overrides it. */
export const resultsFile = (env: NodeJS.ProcessEnv = process.env) =>
  env.SHADOW_PERF_RESULTS ??
  path.join(os.homedir(), ".cache", "tmp-tn", "shadow-perf", "results.json");

export interface ICell {
  readonly scene: string;
  readonly arm: "tn" | "unreal";
  readonly layer?: string;
  /** GPU ms per frame, median of the runs. */
  readonly totalMs?: number;
  /** GPU ms per frame in shadow depth and shadow projection/filter work. */
  readonly shadowMs?: number;
  readonly runs: number;
  readonly spreadMs?: number;
  readonly adapter?: string;
  /** Why a time is missing; a missing time without a reason is malformed. */
  readonly unavailable?: string;
}

export interface IIteration {
  readonly id: string;
  readonly lever: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly decision: "keep" | "reject" | "provisional" | "inconclusive" | "invalid" | "pending";
  readonly sha?: string;
  readonly note?: string;
  readonly cells: readonly ICell[];
}

export interface IScenePair {
  readonly scene: string;
  readonly tn?: ICell;
  readonly unreal?: ICell;
  /** TN / Unreal; below 1 means TN is faster. Undefined when either side lacks the time. */
  readonly totalRatio?: number;
  readonly shadowRatio?: number;
}

export type ShadowPerf =
  | { readonly status: "pending"; readonly file: string }
  | { readonly status: "invalid"; readonly file: string; readonly problem: string }
  | {
      readonly status: "ok";
      readonly file: string;
      readonly updatedAt: string;
      readonly heartbeatAt?: string;
      readonly phase: string;
      readonly next?: string;
      readonly iterations: readonly (IIteration & {
        readonly pairs: readonly IScenePair[];
        readonly cycleMinutes?: number;
      })[];
    };

const DECISIONS = new Set(["keep", "reject", "provisional", "inconclusive", "invalid", "pending"]);
const isTime = (v: unknown) =>
  v === undefined || (typeof v === "number" && Number.isFinite(v) && v >= 0);

function check(data: unknown): string | undefined {
  const d = data as {
    schema?: unknown;
    updatedAt?: unknown;
    phase?: unknown;
    iterations?: unknown;
  };
  if (d === null || typeof d !== "object") return "not an object";
  if (d.schema !== 1) return `schema must be 1, got ${String(d.schema)}`;
  if (typeof d.updatedAt !== "string" || Number.isNaN(Date.parse(d.updatedAt)))
    return "updatedAt must be an ISO time";
  if (typeof d.phase !== "string") return "phase must be a string";
  if (!Array.isArray(d.iterations)) return "iterations must be an array";
  for (const it of d.iterations as IIteration[]) {
    if (typeof it?.id !== "string" || typeof it.lever !== "string")
      return "an iteration lacks id or lever";
    if (Number.isNaN(Date.parse(it.startedAt))) return `${it.id}: startedAt must be an ISO time`;
    if (!DECISIONS.has(it.decision)) return `${it.id}: unknown decision ${String(it.decision)}`;
    if (!Array.isArray(it.cells)) return `${it.id}: cells must be an array`;
    for (const c of it.cells) {
      if (typeof c?.scene !== "string" || (c.arm !== "tn" && c.arm !== "unreal"))
        return `${it.id}: a cell lacks scene or arm`;
      if (!isTime(c.totalMs) || !isTime(c.shadowMs) || !isTime(c.spreadMs))
        return `${it.id} ${c.scene} ${c.arm}: a time is not a non-negative number`;
      if (!Number.isInteger(c.runs) || c.runs < 0)
        return `${it.id} ${c.scene} ${c.arm}: runs must be a count`;
      if (c.totalMs === undefined && !c.unavailable)
        return `${it.id} ${c.scene} ${c.arm}: totalMs missing without an unavailable reason`;
    }
  }
  return undefined;
}

const ratio = (a?: number, b?: number) =>
  a === undefined || b === undefined || b <= 0 ? undefined : a / b;

/** Pairs the TN and Unreal cells of one iteration by scene. */
export function pairsOf(cells: readonly ICell[]): IScenePair[] {
  const scenes = [...new Set(cells.map((c) => c.scene))];
  return scenes.map((scene) => {
    const tn = cells.find((c) => c.scene === scene && c.arm === "tn");
    const unreal = cells.find((c) => c.scene === scene && c.arm === "unreal");
    return {
      scene,
      ...(tn ? { tn } : {}),
      ...(unreal ? { unreal } : {}),
      ...(ratio(tn?.totalMs, unreal?.totalMs) === undefined
        ? {}
        : { totalRatio: ratio(tn?.totalMs, unreal?.totalMs) }),
      ...(ratio(tn?.shadowMs, unreal?.shadowMs) === undefined
        ? {}
        : { shadowRatio: ratio(tn?.shadowMs, unreal?.shadowMs) }),
    };
  });
}

export function shadowPerfOf(text: string | undefined, file: string): ShadowPerf {
  if (text === undefined) return { status: "pending", file };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return {
      status: "invalid",
      file,
      problem: `JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const problem = check(data);
  if (problem) return { status: "invalid", file, problem };
  const d = data as {
    updatedAt: string;
    heartbeatAt?: string;
    phase: string;
    next?: string;
    iterations: IIteration[];
  };
  return {
    status: "ok",
    file,
    updatedAt: d.updatedAt,
    ...(d.heartbeatAt ? { heartbeatAt: d.heartbeatAt } : {}),
    phase: d.phase,
    ...(d.next ? { next: d.next } : {}),
    iterations: d.iterations.map((it) => {
      const minutes = it.finishedAt
        ? (Date.parse(it.finishedAt) - Date.parse(it.startedAt)) / 60000
        : undefined;
      return {
        ...it,
        pairs: pairsOf(it.cells),
        ...(minutes !== undefined && minutes >= 0 ? { cycleMinutes: minutes } : {}),
      };
    }),
  };
}

export async function shadowPerfOnce(file = resultsFile()): Promise<ShadowPerf> {
  const text = await stat(file).then(
    () => readFile(file, "utf8"),
    () => undefined,
  );
  return shadowPerfOf(text, file);
}
