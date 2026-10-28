/**
 * `pnpm unreal-look:judge` — a fresh, read-only visual judge for one round (PRD-647).
 *
 *   pnpm unreal-look:judge --criteria criteria.md --out verdict.json \
 *     --before <run1> --before <run2> --after <run1> --after <run2> --unreal <folder>
 *
 * Each --before and --after is one capture folder (one run); --unreal is the Unreal reference tree.
 * Frames pair by path, and the path of every frame names its layer, which must be the same layer in
 * both engines (judgeVerdict.ts). The judge is `claude -p` on Sonnet with the Read tool only: it
 * opens every image, answers per frame and overall, and the answer is checked before it is written.
 *
 *   --min-runs 2           runs per arm the owner rule asks for; a lower number is written to the verdict
 *   --expect improvement   the change promised a visible gain: only an overall IMPROVEMENT passes
 *   --model sonnet --effort high --max-budget-usd 5 --timeout-min 20
 *   --region-limit 0.25    measure dP50 per region (judgeRegions.ts): the judge sees the numbers and a region past the limit caps its frame at FAR
 *   --dry-run              pair the frames and print them; start no session
 *
 * Exit 0: a complete verdict that blocks nothing. Exit 2: a complete verdict with a REGRESSION (or no
 * IMPROVEMENT when one was promised). Exit 1: no verdict; --out then holds `"status": "FAILED"`.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  type IMeasure,
  type IRegionMeasure,
  capAtFar,
  measureRegions,
  regionTable,
} from "./judgeRegions.js";
import {
  type Expect,
  type IFrame,
  type IJudgeRun,
  type Tier,
  UNREAL_LEVEL,
  VERDICT_SCHEMA,
  blockedBy,
  buildPrompt,
  collectFrames,
  fail,
  hasResult,
  readJudgeStream,
} from "./judgeVerdict.js";

const USAGE =
  "pnpm unreal-look:judge --criteria <file> --out <verdict.json> --before <dir> [--before <dir>] --after <dir> [--after <dir>] --unreal <dir> [--layer L7] [--tier high] [--min-runs 2] [--expect improvement] [--region-limit 0.25] [--model sonnet] [--effort high] [--max-budget-usd 5] [--timeout-min 20] [--dry-run]";
const HELP = `${USAGE}

A round is three sets of PNG frames, paired by their path inside each set:
  --before, --after  one folder per run, two runs per arm (--min-runs 1 writes the lower count to the verdict)
  --unreal           the Unreal reference tree; frames in it that the round does not need are ignored
  --layer L7         judge only the frames at this layer (repeat or use commas): a capture folder holds ID, L1 and L7 side by side
  --tier high        the ThreeNative GI tier, which picks the Unreal variant: high is Epic, medium is Medium, low is Low
The path of every frame names exactly one layer (L9/L9_sun60_exterior.png, sunlit-room/L7/sun60-window.png),
and the layer must be the same in all sets. At tier high the Unreal variants pair as L7-Epic with L7 and
L9-Epic with L9, at medium L7-Medium with L7, at low L7-Low with L7. ThreeNative L6 pairs with no Unreal
variant. A round holds at most 24 frames.
--region-limit 0.25 measures dP50 per region of the scene (the same numbers as unreal-look:compare), shows them to the judge and
caps a frame at FAR when any region is past the limit. Use the limit the criteria file states.
The judge returns IMPROVEMENT, NEUTRAL or REGRESSION per frame and overall (AFTER against BEFORE), and
MATCH, CLOSE or FAR (AFTER against UNREAL). The verdict goes to --out and to the terminal.
Exit 0: complete verdict, nothing blocked. Exit 2: complete verdict with a REGRESSION (or no overall
IMPROVEMENT under --expect improvement). Exit 1: no verdict, and --out says FAILED.`;

export type IRunner = (input: {
  prompt: string;
  args: string[];
  timeoutMs: number;
}) => Promise<string[]>;

/** Sonnet, the Read tool only, no customizations, no saved transcript: the judge looks and answers. */
export function claudeArgs(options: {
  model: string;
  effort: string;
  maxBudgetUsd: number;
  dirs: string[];
}): string[] {
  return [
    "-p",
    "--safe-mode",
    "--tools",
    "Read",
    "--allowedTools",
    "Read",
    "--permission-mode",
    "dontAsk",
    ...options.dirs.flatMap((dir) => ["--add-dir", dir]),
    "--model",
    options.model,
    "--effort",
    options.effort,
    "--max-budget-usd",
    String(options.maxBudgetUsd),
    "--no-session-persistence",
    "--output-format",
    "stream-json",
    "--verbose",
    "--json-schema",
    JSON.stringify(VERDICT_SCHEMA),
  ];
}

/** Runs the session in a folder with no project files and returns the lines it printed. */
export const runClaude: IRunner = ({ prompt, args, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd: os.tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    const lines: string[] = [];
    let pending = "";
    let stderr = "";
    const stop = () => child.kill("SIGTERM");
    process.once("exit", stop);
    const timer = setTimeout(() => {
      stop();
      reject(
        new Error(
          `TN_UNREAL_LOOK_JUDGE_TIMEOUT: the judge session ran past ${timeoutMs / 60_000} minutes`,
        ),
      );
    }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      process.off("exit", stop);
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      const parts = (pending + chunk).split("\n");
      pending = parts.pop() ?? "";
      lines.push(...parts);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    child.stdin.on("error", () => undefined);
    child.once("error", (error) => {
      done();
      reject(new Error(`TN_UNREAL_LOOK_JUDGE_SESSION: cannot start claude: ${error.message}`));
    });
    child.once("close", (code) => {
      done();
      if (pending) lines.push(pending);
      if (code !== 0 && !hasResult(lines))
        reject(new Error(`TN_UNREAL_LOOK_JUDGE_SESSION: claude exited ${code}: ${stderr.trim()}`));
      else resolve(lines);
    });
    child.stdin.end(prompt);
  });

interface IOptions {
  criteria: string;
  out: string;
  before: string[];
  after: string[];
  unreal: string;
  minRuns: number;
  tier: Tier;
  layers?: string[];
  expect: Expect;
  model: string;
  effort: string;
  maxBudgetUsd: number;
  timeoutMin: number;
  regionLimit?: number;
  dryRun: boolean;
}

function parse(args: string[]): IOptions {
  let values: ReturnType<typeof parseArgs>["values"];
  try {
    values = parseArgs({
      args,
      strict: true,
      options: {
        criteria: { type: "string" },
        out: { type: "string" },
        before: { type: "string", multiple: true },
        after: { type: "string", multiple: true },
        unreal: { type: "string" },
        "min-runs": { type: "string" },
        tier: { type: "string" },
        layer: { type: "string", multiple: true },
        expect: { type: "string" },
        model: { type: "string" },
        effort: { type: "string" },
        "max-budget-usd": { type: "string" },
        "timeout-min": { type: "string" },
        "region-limit": { type: "string" },
        "dry-run": { type: "boolean" },
      },
    }).values;
  } catch (error) {
    return fail("BAD_INPUT", `${(error as Error).message}\n${USAGE}`);
  }
  const text = (name: string) => {
    const value = values[name];
    if (typeof value !== "string" || value === "")
      fail("BAD_INPUT", `--${name} is required\n${USAGE}`);
    return value;
  };
  const list = (name: string) => {
    const value = values[name];
    if (!Array.isArray(value) || value.length === 0)
      fail("BAD_INPUT", `--${name} is required\n${USAGE}`);
    return value.map(String);
  };
  const number = (name: string, fallback: number) => {
    const value = values[name] === undefined ? fallback : Number(values[name]);
    if (!Number.isFinite(value) || value <= 0)
      fail("BAD_INPUT", `--${name} must be a positive number`);
    return value;
  };
  const tier = String(values.tier ?? "high");
  if (!(tier in UNREAL_LEVEL)) fail("BAD_INPUT", "--tier is high, medium or low");
  const layers = (Array.isArray(values.layer) ? values.layer : []).flatMap((value) =>
    String(value).split(","),
  );
  const expect = values.expect ?? "preserve";
  if (expect !== "preserve" && expect !== "improvement")
    fail("BAD_INPUT", "--expect is improvement (or leave it out)");
  return {
    criteria: path.resolve(text("criteria")),
    out: path.resolve(text("out")),
    before: list("before").map((dir) => path.resolve(dir)),
    after: list("after").map((dir) => path.resolve(dir)),
    unreal: path.resolve(text("unreal")),
    minRuns: number("min-runs", 2),
    tier: tier as Tier,
    ...(layers.length > 0 ? { layers } : {}),
    expect,
    model: typeof values.model === "string" ? values.model : "sonnet",
    effort: typeof values.effort === "string" ? values.effort : "high",
    maxBudgetUsd: number("max-budget-usd", 5),
    timeoutMin: number("timeout-min", 20),
    ...(values["region-limit"] === undefined ? {} : { regionLimit: number("region-limit", 0) }),
    dryRun: values["dry-run"] === true,
  };
}

function frameTable(frames: readonly IFrame[]): string {
  return frames
    .map(
      (frame) =>
        `${frame.id}  layer ${frame.layer}  unreal ${frame.unrealName}  runs ${frame.before.length}+${frame.after.length}`,
    )
    .join("\n");
}

function show(verdict: Record<string, unknown>): string {
  const frames = verdict.frames as {
    id: string;
    layer: string;
    unreal: string;
    verdict: string;
    vsUnreal: string;
    reasons: string;
    differences: string;
    overRegions?: string[];
    judgedVsUnreal?: string;
  }[];
  const overall = verdict.overall as { verdict: string; vsUnreal: string; reasons: string };
  const blocked = verdict.blockedBy as string[];
  return [
    `JUDGE ${String(verdict.model)} · runs ${JSON.stringify(verdict.runs)} · ${String(verdict.imagesRead)} images read · $${Number(verdict.costUsd).toFixed(2)} · ${Math.round(Number(verdict.durationMs) / 1000)} s`,
    ...frames.flatMap((frame) => [
      `${frame.id} (${frame.layer}): ${frame.verdict}; vs UNREAL ${frame.unreal}: ${frame.vsUnreal}`,
      `  reasons: ${frame.reasons}`,
      ...(frame.overRegions
        ? [
            `  past the region limit: ${frame.overRegions.join(", ")}${frame.judgedVsUnreal ? ` (capped at FAR, the judge said ${frame.judgedVsUnreal})` : ""}`,
          ]
        : []),
      ...(frame.differences ? [`  differences: ${frame.differences}`] : []),
    ]),
    `OVERALL: ${overall.verdict}; vs UNREAL: ${overall.vsUnreal}`,
    `  reasons: ${overall.reasons}`,
    ...(blocked.length > 0 ? [`BLOCKED: ${blocked.join("; ")}`] : []),
    `verdict file: ${String(verdict.file)}`,
  ].join("\n");
}

function write(file: string, content: Record<string, unknown>): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(content, null, 2)}\n`);
}

async function judge(o: IOptions, run: IRunner, measure: IMeasure): Promise<number> {
  let criteria: string;
  try {
    criteria = readFileSync(o.criteria, "utf8");
  } catch {
    return fail("BAD_INPUT", `cannot read the criteria file ${o.criteria}`);
  }
  if (criteria.trim() === "")
    fail(
      "BAD_INPUT",
      `criteria file ${o.criteria} is empty: write the criteria before the judge sees a frame`,
    );
  const frames = collectFrames(
    { before: o.before, after: o.after, unreal: o.unreal },
    { minRuns: o.minRuns, tier: o.tier, ...(o.layers ? { layers: o.layers } : {}) },
  );
  if (o.dryRun) {
    console.log(
      `${frameTable(frames)}\ndry run: ${frames.length} frames paired, no judge session started`,
    );
    return 0;
  }
  // Measured before the session: a scene that cannot be measured fails the round without a model call.
  const regions: IRegionMeasure[] | undefined =
    o.regionLimit === undefined
      ? undefined
      : measure(frames, { before: o.before, after: o.after, unreal: o.unreal }, o.tier);
  const lines = await run({
    prompt: buildPrompt(
      criteria,
      frames,
      regions && o.regionLimit !== undefined ? regionTable(regions, o.regionLimit) : undefined,
    ),
    args: claudeArgs({
      model: o.model,
      effort: o.effort,
      maxBudgetUsd: o.maxBudgetUsd,
      dirs: [...o.before, ...o.after, o.unreal],
    }),
    timeoutMs: o.timeoutMin * 60_000,
  });
  const asked: IJudgeRun = readJudgeStream(lines, frames);
  const { judged, capped } =
    regions && o.regionLimit !== undefined
      ? capAtFar(asked, regions, o.regionLimit)
      : { judged: asked, capped: new Map<string, string[]>() };
  const judgedBefore = (id: string) => asked.frames.find((x) => x.id === id)?.vsUnreal;
  const verdict = {
    status: "COMPLETE",
    judgedAt: new Date().toISOString(),
    model: judged.model,
    effort: o.effort,
    sessionId: judged.sessionId,
    costUsd: judged.costUsd,
    durationMs: judged.durationMs,
    imagesRead: judged.imagesRead,
    criteria: { file: o.criteria, sha256: createHash("sha256").update(criteria).digest("hex") },
    expect: o.expect,
    tier: o.tier,
    ...(o.regionLimit === undefined ? {} : { regionLimit: o.regionLimit }),
    runs: { before: o.before.length, after: o.after.length },
    sets: { before: o.before, after: o.after, unreal: o.unreal },
    frames: judged.frames.map((entry) => {
      const frame = frames.find((candidate) => candidate.id === entry.id) as IFrame;
      return {
        ...entry,
        ...(regions
          ? {
              ...(capped.has(entry.id) ? { overRegions: capped.get(entry.id) } : {}),
              ...(judgedBefore(entry.id) !== entry.vsUnreal
                ? { judgedVsUnreal: judgedBefore(entry.id) }
                : {}),
              regions: regions.filter((r) => r.frame === entry.id),
            }
          : {}),
        layer: frame.layer,
        unreal: frame.unrealName,
        files: { before: frame.before, after: frame.after, unreal: frame.unreal },
      };
    }),
    overall: judged.overall,
    blockedBy: blockedBy(judged, o.expect),
    file: o.out,
  };
  write(o.out, verdict);
  console.log(show(verdict));
  return verdict.blockedBy.length > 0 ? 2 : 0;
}

export async function main(
  args = process.argv.slice(2),
  run: IRunner = runClaude,
  measure: IMeasure = measureRegions,
): Promise<number> {
  if (args.includes("--help")) {
    console.log(HELP);
    return 0;
  }
  const options = parse(args);
  try {
    return await judge(options, run, measure);
  } catch (error) {
    // The file at --out always says what the latest attempt did, so an old verdict cannot pass for this one.
    if (!options.dryRun)
      write(options.out, {
        status: "FAILED",
        failedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
