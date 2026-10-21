/**
 * The checks around the visual judge of `pnpm unreal-look:judge` (judge.ts), PRD-647.
 *
 * A round is three sets of frames: BEFORE and AFTER (one capture folder per run) and UNREAL. This file
 * pairs them, applies the layer rule, writes the judge's prompt and reads the judge's answer. Each of
 * them fails closed: a verdict that is incomplete, unparseable, or given without opening every image
 * is an error, never a pass. A frame's path names its layer (L9/L9_sun60_exterior.png, or
 * sunlit-room/L7/sun60-window.png), the way the capture folders do, and the layer must agree in all sets.
 */
import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export const VERDICTS = ["IMPROVEMENT", "NEUTRAL", "REGRESSION"] as const;
export const CLOSENESS = ["MATCH", "CLOSE", "FAR"] as const;
export type Verdict = (typeof VERDICTS)[number];
export type Closeness = (typeof CLOSENESS)[number];
/** `improvement`: the change promised a visible gain, so only an overall IMPROVEMENT passes. */
export type Expect = "preserve" | "improvement";

/** The judge opens five or more images per frame: a round beyond this is two rounds. */
export const MAX_FRAMES = 24;

export interface IFrame {
  /** The frame's path inside its set, layer spelled the ThreeNative way: sunlit-room/L7/sun60-window. */
  id: string;
  layer: string;
  /** One file per run. */
  before: string[];
  after: string[];
  unreal: string;
  /** How the Unreal set spells the layer of this frame, for example L7-Epic. */
  unrealName: string;
}
export interface IJudgement {
  id: string;
  verdict: Verdict;
  vsUnreal: Closeness;
  reasons: string;
  differences: string;
}
export interface IOverall {
  verdict: Verdict;
  vsUnreal: Closeness;
  reasons: string;
}
export interface IJudgeRun {
  frames: IJudgement[];
  overall: IOverall;
  model: string;
  sessionId: string;
  costUsd: number;
  durationMs: number;
  imagesRead: number;
}

export function fail(code: string, message: string): never {
  throw new Error(`TN_UNREAL_LOOK_JUDGE_${code}: ${message}`);
}

const LAYER = /(?<![A-Za-z0-9])(ID|L\d)(?:-(Epic|Medium|Low))?(?![A-Za-z0-9])/g;
/** ThreeNative's GI tiers; each is judged against one Unreal quality level (PRD-644). */
export type Tier = "low" | "medium" | "high";
export const UNREAL_LEVEL: Readonly<Record<Tier, string>> = {
  low: "Low",
  medium: "Medium",
  high: "Epic",
};
/**
 * The Unreal GI variants that pair with a ThreeNative layer at a tier (GI_LAYERS in
 * capture-gi-threenative.ts). ThreeNative L6 is shadows and AO without GI, which Unreal draws as L7 at
 * GI quality Low, so L7-Low pairs with L6 at every tier above low. Unreal has an L9 only at Epic. A
 * variant that is not listed pairs with nothing and is skipped.
 */
function unrealPairs(tier: Tier): Readonly<Record<string, string>> {
  return {
    ...(tier === "low" ? {} : { "L7-Low": "L6" }),
    [`L7-${UNREAL_LEVEL[tier]}`]: "L7",
    ...(tier === "high" ? { "L9-Epic": "L9" } : {}),
  };
}
const slug = (id: string) => id.replace(/(?<![A-Za-z0-9])(?:ID|L\d)(?![A-Za-z0-9])/g, "{L}");

interface IListed {
  layer: string;
  name: string;
  file: string;
}
type Listing = Map<string, IListed>;

const isPng = (entry: Dirent, file: string) =>
  /\.png$/i.test(entry.name) &&
  (entry.isFile() ||
    (entry.isSymbolicLink() && statSync(file, { throwIfNoEntry: false })?.isFile() === true));

/** A PNG's id and its one layer; undefined for an Unreal variant that pairs with nothing. */
function nameFrame(root: string, file: string, pairs?: Readonly<Record<string, string>>) {
  const seen = { layers: new Set<string>(), name: "", paired: true };
  const id = path
    .relative(root, file)
    .split(path.sep)
    .join("/")
    .replace(/\.png$/i, "")
    .replace(LAYER, (token, layer: string, variant?: string) => {
      const mapped = pairs && variant !== undefined ? pairs[token] : layer;
      if (mapped === undefined) seen.paired = false;
      else seen.layers.add(mapped);
      seen.name ||= token;
      return mapped ?? token;
    });
  if (!seen.paired) return undefined;
  const layers = [...seen.layers];
  if (layers.length !== 1)
    fail(
      layers.length === 0 ? "LAYER_UNKNOWN" : "LAYER_AMBIGUOUS",
      `${file} ${layers.length === 0 ? "names no layer" : `names ${layers.join(" and ")}`}: put exactly one layer (L0 to L9 or ID) in the path of every frame, as the capture folders do`,
    );
  return { id, frame: { layer: layers[0] as string, name: seen.name, file } };
}

function listFrames(root: string, pairs?: Readonly<Record<string, string>>): Listing {
  if (!existsSync(root) || !statSync(root).isDirectory())
    fail("BAD_INPUT", `${root} is not a folder`);
  const frames: Listing = new Map();
  let skipped = 0;
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    const file = path.join(entry.parentPath, entry.name);
    if (!isPng(entry, file)) continue;
    const named = nameFrame(root, file, pairs);
    if (named === undefined) skipped += 1;
    else if (frames.has(named.id))
      fail("AMBIGUOUS_FRAME", `${file} and ${frames.get(named.id)?.file} are one frame`);
    else frames.set(named.id, named.frame);
  }
  if (frames.size === 0)
    fail(
      "BAD_INPUT",
      skipped === 0
        ? `${root} holds no PNG frames`
        : `${root} holds ${skipped} PNG frame(s), and none pairs with a ThreeNative layer at this tier (${Object.keys(pairs ?? {}).join(", ")})`,
    );
  return frames;
}

function checkRuns(arm: string, dirs: readonly string[], minRuns: number): void {
  if (new Set(dirs.map((dir) => path.resolve(dir))).size !== dirs.length)
    fail("BAD_INPUT", `--${arm} names the same folder twice: each run is its own capture`);
  if (dirs.length < minRuns)
    fail(
      "TOO_FEW_RUNS",
      `--${arm} has ${dirs.length} run(s) and the visual judge rule asks for ${minRuns} per arm: capture another run, or pass --min-runs ${dirs.length} (the verdict file records it)`,
    );
}

/** A frame some set lacks. The same frame at another layer is a LAYER_MISMATCH, not a missing frame. */
function absent(arm: string, listed: Listing, id: string): { code: string; text: string } {
  const near = [...listed.keys()].find((other) => slug(other) === slug(id));
  if (near !== undefined)
    return {
      code: "LAYER_MISMATCH",
      text: `${arm} holds ${near}, not ${id}: compare the same layer in both engines`,
    };
  const hint =
    arm === "unreal"
      ? " (an Unreal variant pairs only with its own tier: L7-Epic and L9-Epic at high, L7-Medium at medium, L7-Low at low, and L7-Low with L6 above low)"
      : "";
  return { code: "MISSING_FRAME", text: `${arm} has no ${id}${hint}` };
}

export interface ICollectOptions {
  /** Runs per arm the owner rule asks for. */
  minRuns?: number;
  /** The tier decides which Unreal variant a layer pairs with. */
  tier?: Tier;
  /** Judge only the frames at these layers (a capture folder holds ID, L1 and L7 frames side by side). */
  layers?: readonly string[];
}

/**
 * Pairs the frames of BEFORE (one folder per run), AFTER and UNREAL by path. Every BEFORE or AFTER
 * frame needs the same frame in every run and in UNREAL at the same layer; extra UNREAL frames are
 * ignored, so UNREAL may point at the whole reference tree.
 */
export function collectFrames(
  sets: { before: string[]; after: string[]; unreal: string },
  { minRuns = 2, tier = "high", layers }: ICollectOptions = {},
): IFrame[] {
  checkRuns("before", sets.before, minRuns);
  checkRuns("after", sets.after, minRuns);
  const before = sets.before.map((dir) => listFrames(dir));
  const after = sets.after.map((dir) => listFrames(dir));
  const unreal = listFrames(sets.unreal, unrealPairs(tier));
  const judged = (listed: IListed) => layers === undefined || layers.includes(listed.layer);
  const wanted = [
    ...new Set(
      [...before, ...after].flatMap((listed) =>
        [...listed].filter(([, frame]) => judged(frame)).map(([id]) => id),
      ),
    ),
  ].sort();
  if (wanted.length === 0)
    fail("BAD_INPUT", `no frame at layer ${layers?.join(" or ")} in the BEFORE and AFTER folders`);
  if (wanted.length > MAX_FRAMES)
    fail(
      "TOO_MANY_FRAMES",
      `${wanted.length} frames: a round judges at most ${MAX_FRAMES}, so judge each layer or scene on its own (--layer)`,
    );
  const arms: [string, Listing][] = [
    ...before.map((listed, i): [string, Listing] => [`before run ${i + 1}`, listed]),
    ...after.map((listed, i): [string, Listing] => [`after run ${i + 1}`, listed]),
    ["unreal", unreal],
  ];
  const problems = arms.flatMap(([arm, listed]) =>
    wanted.filter((id) => !listed.has(id)).map((id) => absent(arm, listed, id)),
  );
  if (problems.length > 0) {
    const shown = problems.slice(0, 8).map((problem) => problem.text);
    if (problems.length > shown.length) shown.push(`and ${problems.length - shown.length} more`);
    const first = problems.find((problem) => problem.code === "LAYER_MISMATCH") ?? problems[0];
    fail(first?.code as string, shown.join("\n"));
  }
  const files = (runs: Listing[], id: string) =>
    runs.map((listed) => (listed.get(id) as IListed).file);
  return wanted.map((id) => {
    const target = unreal.get(id) as IListed;
    return {
      id,
      layer: target.layer,
      before: files(before, id),
      after: files(after, id),
      unreal: target.file,
      unrealName: target.name,
    };
  });
}

export const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["frames", "overall", "unreadable"],
  properties: {
    frames: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "verdict", "vsUnreal", "reasons", "differences"],
        properties: {
          id: { type: "string" },
          verdict: { enum: VERDICTS },
          vsUnreal: { enum: CLOSENESS },
          reasons: { type: "string" },
          differences: { type: "string" },
        },
      },
    },
    overall: {
      type: "object",
      additionalProperties: false,
      required: ["verdict", "vsUnreal", "reasons"],
      properties: {
        verdict: { enum: VERDICTS },
        vsUnreal: { enum: CLOSENESS },
        reasons: { type: "string" },
      },
    },
    unreadable: { type: "array", items: { type: "string" } },
  },
} as const;

export function buildPrompt(criteria: string, frames: readonly IFrame[]): string {
  const listing = frames.map((frame) =>
    [
      `### ${frame.id} (layer ${frame.layer})`,
      ...frame.before.map((file, i) => `BEFORE run ${i + 1}: ${file}`),
      ...frame.after.map((file, i) => `AFTER run ${i + 1}: ${file}`),
      `UNREAL (${frame.unrealName}): ${frame.unreal}`,
    ].join("\n"),
  );
  return `You are the visual judge of one round of the ThreeNative "Unreal look" work. You did not write the change under test. You have the Read tool and nothing else: look at the images, run no commands and edit no files.

## Criteria (written before any frame was seen)

${criteria.trim()}

## Frames

Every frame shows one pose at one layer in both engines. BEFORE and AFTER are the ThreeNative engine without and with the change. UNREAL is Unreal Engine 5.8.3 at the same layer, the target. BEFORE and AFTER each have several runs of one capture: a difference between two runs of one arm is capture noise, not a change.

${listing.join("\n\n")}

## How to judge

1. Open every image above with the Read tool before you answer. The answer is checked against the images you opened.
2. For every frame give two answers.
   - verdict: AFTER against BEFORE, by the criteria. IMPROVEMENT, NEUTRAL or REGRESSION. Look for what got worse as hard as for what got better: one broken criterion in one region is a REGRESSION, even when the rest improved. NEUTRAL means the arms cannot be told apart by the criteria. Judge what the images show, not what the change was meant to do.
   - vsUnreal: AFTER against UNREAL, MATCH, CLOSE or FAR. MATCH means no difference a player would notice. CLOSE means the same lighting with a named difference. FAR means a different lighting result. Name the differences in "differences".
3. In "reasons" name where you looked (wall, corner, seam, window edge, and so on) and what you saw there.
4. "overall" has one verdict and one vsUnreal for the whole round, weighed as the criteria say.
5. If you cannot read an image, put its path in "unreadable" and do not guess about it.

Answer with the structured output only. Use each frame id exactly as written above.
`;
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

function parseEvents(lines: readonly string[]): Json[] {
  const events: Json[] = [];
  for (const line of lines) {
    try {
      const event: unknown = JSON.parse(line);
      if (isRecord(event)) events.push(event);
    } catch {
      // A line that is not JSON carries no event.
    }
  }
  return events;
}
/** True once the session printed its final result: a non-zero exit before that is a crash. */
export function hasResult(lines: readonly string[]): boolean {
  return parseEvents(lines).some((event) => event.type === "result");
}
function fromText(text: unknown): unknown {
  if (typeof text !== "string") return undefined;
  const candidates = [text.trim(), /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1]?.trim()];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}
function answer<T extends string>(value: unknown, scale: readonly T[], where: string): T {
  if (!scale.includes(value as T))
    fail("BAD_VERDICT", `${where} is ${JSON.stringify(value)}, not one of ${scale.join(", ")}`);
  return value as T;
}
function reasoned(value: unknown, where: string): string {
  if (!isText(value)) fail("BAD_VERDICT", `${where} has no reasons`);
  return value;
}

const blocksOf = (event: Json): Json[] => {
  const content = isRecord(event.message) ? event.message.content : undefined;
  return Array.isArray(content) ? content.filter(isRecord) : [];
};

/** The files the judge opened with a Read that did not fail. */
function filesRead(events: readonly Json[]): Set<string> {
  const blocks = events.flatMap(blocksOf);
  const refused = new Set(
    blocks
      .filter((block) => block.type === "tool_result" && block.is_error === true)
      .map((block) => String(block.tool_use_id)),
  );
  const reads = blocks.filter(
    (block) => block.type === "tool_use" && block.name === "Read" && !refused.has(String(block.id)),
  );
  return new Set(
    reads.map((block) => path.resolve(String(isRecord(block.input) && block.input.file_path))),
  );
}

/** The answer's shape: every verdict on its scale, every reason given. */
function judgements(raw: Json): { frames: IJudgement[]; overall: IOverall } {
  if (!Array.isArray(raw.frames) || !isRecord(raw.overall))
    fail("BAD_VERDICT", "the answer needs a frames list and an overall verdict");
  const frames = raw.frames.map((entry: unknown, i): IJudgement => {
    if (!isRecord(entry) || typeof entry.id !== "string")
      fail("BAD_VERDICT", `frames[${i}] has no id`);
    const where = `frame ${entry.id}`;
    return {
      id: entry.id,
      verdict: answer(entry.verdict, VERDICTS, `${where} verdict`),
      vsUnreal: answer(entry.vsUnreal, CLOSENESS, `${where} vsUnreal`),
      reasons: reasoned(entry.reasons, where),
      differences: typeof entry.differences === "string" ? entry.differences : "",
    };
  });
  const overall: IOverall = {
    verdict: answer(raw.overall.verdict, VERDICTS, "overall verdict"),
    vsUnreal: answer(raw.overall.vsUnreal, CLOSENESS, "overall vsUnreal"),
    reasons: reasoned(raw.overall.reasons, "the overall verdict"),
  };
  return { frames, overall };
}

/** One answer for each frame of the round, no more and no fewer. */
function checkCoverage(judged: readonly IJudgement[], frames: readonly IFrame[]): void {
  const known = new Set(frames.map((frame) => frame.id));
  const seen = new Set<string>();
  for (const entry of judged) {
    if (!known.has(entry.id))
      fail("UNKNOWN_FRAME", `the judge answered for ${entry.id}, which is not in the round`);
    if (seen.has(entry.id)) fail("REPEATED_FRAME", `the judge answered twice for ${entry.id}`);
    seen.add(entry.id);
  }
  const missing = frames.filter((frame) => !seen.has(frame.id)).map((frame) => frame.id);
  if (missing.length > 0) fail("MISSING_VERDICT", `no verdict for ${missing.join(", ")}`);
}

/** Reads the NDJSON of `claude -p --output-format stream-json` and returns the checked verdict. */
export function readJudgeStream(lines: readonly string[], frames: readonly IFrame[]): IJudgeRun {
  const events = parseEvents(lines);
  const result = events.find((event) => event.type === "result");
  if (result === undefined)
    fail("NO_RESULT", "the judge session ended without a result, so there is no verdict");
  if (result.is_error === true || result.subtype !== "success")
    fail(
      "FAILED",
      `the judge session ended with ${String(result.subtype)} (${String(result.terminal_reason)}): ${String(result.result ?? "").slice(0, 300)}`,
    );
  const raw = result.structured_output ?? fromText(result.result);
  if (!isRecord(raw))
    fail(
      "UNPARSEABLE",
      `the judge's answer is not a JSON verdict: ${String(result.result).slice(0, 300)}`,
    );
  const { frames: judged, overall } = judgements(raw);
  checkCoverage(judged, frames);
  const unreadable = Array.isArray(raw.unreadable) ? raw.unreadable : [];
  if (unreadable.length > 0)
    fail("UNREADABLE", `the judge could not read ${unreadable.map(String).join(", ")}`);
  const read = filesRead(events);
  const images = frames.flatMap((frame) => [...frame.before, ...frame.after, frame.unreal]);
  const unread = images.filter((file) => !read.has(path.resolve(file)));
  if (unread.length > 0)
    fail(
      "UNREAD",
      `the judge never opened ${unread.length} of ${images.length} images, so its verdict is not about them: ${unread.slice(0, 5).join(", ")}`,
    );
  const order = new Map(frames.map((frame, i) => [frame.id, i]));
  const model = events.find((event) => event.type === "system" && event.model)?.model;
  return {
    frames: judged.sort((a, b) => (order.get(a.id) as number) - (order.get(b.id) as number)),
    overall,
    model: typeof model === "string" ? model : "unknown",
    sessionId: String(result.session_id ?? ""),
    costUsd: Number(result.total_cost_usd ?? 0),
    durationMs: Number(result.duration_ms ?? 0),
    imagesRead: images.length,
  };
}

/** What stops the change: any REGRESSION, and a missing IMPROVEMENT when one was promised. */
export function blockedBy(run: Pick<IJudgeRun, "frames" | "overall">, expect: Expect): string[] {
  const blocked = run.frames
    .filter((frame) => frame.verdict === "REGRESSION")
    .map((frame) => `frame ${frame.id} is a REGRESSION`);
  if (run.overall.verdict === "REGRESSION") blocked.push("the overall verdict is a REGRESSION");
  else if (expect === "improvement" && run.overall.verdict !== "IMPROVEMENT")
    blocked.push(`improvement was promised and the overall verdict is ${run.overall.verdict}`);
  return blocked;
}
