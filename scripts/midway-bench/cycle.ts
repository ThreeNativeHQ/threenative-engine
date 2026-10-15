/**
 * Iteration-cycle ledger for the Midway tab: `cycles.jsonl` in the runs dir, append-only.
 * A cycle runs from `start <lever>` (optimization begins) to `end <lever> <verdict>` (results are in);
 * the goal is under 30 minutes. Fail closed: `end` without an open `start`, or a second `start` for an
 * open lever, exits 2 and writes nothing.
 *
 *   node --import tsx scripts/midway-bench/cycle.ts start <lever> [--note "..."] [--arm desktop|native]
 *   node --import tsx scripts/midway-bench/cycle.ts end <lever> <keep|reject|inconclusive> [--runs a,b] [--note "..."]
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runsDir } from "./dashboard.js";

export const CYCLE_TARGET_MIN = 30;
export const VERDICTS = ["keep", "reject", "inconclusive"] as const;
const ARMS = ["desktop", "native"] as const;

interface IEntry {
  lever: string;
  event: "start" | "end";
  at: string;
  arm?: string;
  verdict?: string;
  runs?: string[];
  note?: string;
  engineCommit?: string;
}

export interface ICycle {
  lever: string;
  arm?: string;
  startedAt: string;
  endedAt: string;
  minutes: number;
  verdict: string;
  runs: string[];
  note?: string;
  engineCommit?: string;
}

/** Reads the ledger. Lines that do not parse, or that break the start/end order, are skipped and counted. */
export function cyclesOf(text: string | undefined, now = Date.now()) {
  const open = new Map<string, IEntry>();
  const closed: ICycle[] = [];
  let skipped = 0;
  for (const line of (text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let e: IEntry;
    try {
      e = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    const at = Date.parse(e?.at);
    if (
      typeof e?.lever !== "string" ||
      !e.lever ||
      (e.event !== "start" && e.event !== "end") ||
      Number.isNaN(at)
    ) {
      skipped++;
      continue;
    }
    if (e.event === "start") {
      if (open.has(e.lever)) skipped++;
      else open.set(e.lever, e);
      continue;
    }
    const start = open.get(e.lever);
    if (!start || at < Date.parse(start.at) || !VERDICTS.includes(e.verdict as never)) {
      skipped++;
      continue;
    }
    open.delete(e.lever);
    closed.push({
      lever: e.lever,
      ...(start.arm ? { arm: start.arm } : {}),
      startedAt: start.at,
      endedAt: e.at,
      minutes: (at - Date.parse(start.at)) / 60000,
      verdict: e.verdict as string,
      runs: Array.isArray(e.runs) ? e.runs.filter((r) => typeof r === "string") : [],
      ...(e.note ? { note: e.note } : start.note ? { note: start.note } : {}),
      ...(start.engineCommit ? { engineCommit: start.engineCommit } : {}),
    });
  }
  closed.sort((a, b) => Date.parse(a.endedAt) - Date.parse(b.endedAt));
  const sorted = closed.map((c) => c.minutes).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return {
    targetMin: CYCLE_TARGET_MIN,
    count: closed.length,
    skipped,
    medianMin: sorted.length
      ? sorted.length % 2
        ? (sorted[mid] as number)
        : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
      : undefined,
    pctUnder: closed.length
      ? (closed.filter((c) => c.minutes < CYCLE_TARGET_MIN).length / closed.length) * 100
      : undefined,
    last: closed.slice(-10),
    open: [...open.values()].map((e) => ({
      lever: e.lever,
      ...(e.arm ? { arm: e.arm } : {}),
      startedAt: e.at,
      elapsedMin: Math.max(0, (now - Date.parse(e.at)) / 60000),
      ...(e.note ? { note: e.note } : {}),
    })),
  };
}

function options(args: string[]) {
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (!a.startsWith("--")) rest.push(a);
    else if (["--note", "--arm", "--runs"].includes(a) && args[i + 1] !== undefined)
      flags[a.slice(2)] = args[++i] as string;
    else throw new Error(`unknown or incomplete option ${a}`);
  }
  return { flags, rest };
}

/** Runs one CLI call; returns the exit code (0 written, 2 refused) and a message. Exported for tests. */
export function runCycleCli(
  argv: string[],
  { dir = runsDir(), now = new Date(), commit }: { dir?: string; now?: Date; commit?: string } = {},
): { code: 0 | 2; message: string } {
  const refuse = (message: string) => ({ code: 2 as const, message });
  try {
    const [command, ...args] = argv;
    const { flags, rest } = options(args);
    const [lever, verdict] = rest;
    if (command !== "start" && command !== "end") return refuse("usage: start|end <lever> ...");
    if (!lever?.trim()) return refuse("a lever name is required");
    if (flags.arm && !ARMS.includes(flags.arm as never))
      return refuse("--arm is desktop or native");
    if (command === "start" ? rest.length !== 1 : rest.length !== 2)
      return refuse(
        command === "start" ? "start takes only a lever" : "end takes a lever and a verdict",
      );
    if (command === "end" && !VERDICTS.includes(verdict as never))
      return refuse(`verdict is one of ${VERDICTS.join(", ")}`);
    if (command === "start" && flags.runs) return refuse("--runs belongs to end");
    if (command === "end" && flags.arm) return refuse("--arm belongs to start");
    const file = path.join(dir, "cycles.jsonl");
    const text = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    const isOpen = cyclesOf(text, now.getTime()).open.some((c) => c.lever === lever);
    if (command === "start" && isOpen) return refuse(`a cycle for ${lever} is already open`);
    if (command === "end" && !isOpen) return refuse(`no open cycle for ${lever}`);
    const entry: IEntry = {
      lever,
      event: command,
      at: now.toISOString(),
      ...(flags.arm ? { arm: flags.arm } : {}),
      ...(command === "end" ? { verdict } : {}),
      ...(flags.runs
        ? {
            runs: flags.runs
              .split(",")
              .map((r) => r.trim())
              .filter(Boolean),
          }
        : {}),
      ...(flags.note ? { note: flags.note } : {}),
      ...(commit ? { engineCommit: commit } : {}),
    };
    mkdirSync(dir, { recursive: true });
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
    return { code: 0, message: `${command} ${lever} at ${entry.at}` };
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }
}

const head = () => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      encoding: "utf8",
    }).trim();
  } catch {
    return undefined;
  }
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, message } = runCycleCli(process.argv.slice(2), { commit: head() });
  (code ? console.error : console.log)(message);
  process.exit(code);
}
