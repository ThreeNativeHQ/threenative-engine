/**
 * PRD-638 motion runs, the command-line half: capture them in Unreal and measure them in either engine.
 *
 *   pnpm unreal-look:capture --engine unreal --scene gi:cornell --motion pan|switch      (called from gi.ts)
 *   pnpm unreal-look:capture --engine threenative --scene gi:cornell --motion pan|switch
 *   pnpm unreal-look:compare --scene gi|gi:cornell --metric motion [--engine unreal|threenative] [--run pan,switch]
 *     [--layer L7] [--unreal-variant L7-Epic-motion] [--tn-folder threenative] [--captures <dir>] [--json <file>]
 *     [--erode 2] [--min-pixels 200] [--gradual Ceiling]
 *
 * Both engines write captures/<engine>/<scene>/motion/<run>/<variant or layer>/<run>.NNNN.png and one
 * still-NNNN.0000.png per still. The ID frames come from Unreal: both engines draw the same camera.
 * The measures themselves are in motion.ts.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type IRegistry,
  type ISceneJson,
  REFERENCE_WARM_UP,
  checkReadback,
  folderName,
  readScene,
  registry,
  sceneKey,
  sceneNames,
} from "./gi.js";
import {
  type IFrameStore,
  type IGhost,
  type IMotionRun,
  type ISwitchResponse,
  checkRun,
  diskStore,
  flicker,
  runSeries,
  switchResponse,
} from "./motion.js";

const REFERENCE = path.resolve(import.meta.dirname, "../../tools/unreal-reference");
const UNREAL_MOTION_VARIANT = "L7-Epic-motion";
/** Pixel floor of a region in a frame (1280 x 720 frames). */
const MIN_PIXELS = 200;
/** The frames a panning region must be in view of: a sixth of the run. */
const MIN_PAN_FRAMES = 30;
/** Frames the light needs to be steady before the flicker window starts, and after a pan stops. */
const STEADY = 10;
const STEADY_AFTER_PAN = 30;
/** The edge of a region is cut off by this many pixels before it is measured. */
const ERODE = 2;

type RunUnreal = (mode: string, out: string, env?: Record<string, string>) => Promise<number>;

function fail(code: string, message: string): never {
  throw new Error(`TN_UNREAL_LOOK_${code}: ${message}`);
}
function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

/** The folder of one engine's frames for a run, relative to the captures folder. */
export const motionDir = (engine: string, sceneId: string, run: string, folder: string) =>
  path.join(engine, sceneKey(sceneId), "motion", run, folder);

export interface IMotionCapture {
  name: string;
  scene: ISceneJson;
  variants: IRegistry["variants"];
  out: string;
  warmUps: number[];
  runs: number;
  motion: string;
  log: string;
}

async function captureVariant(
  input: IMotionCapture,
  spec: IMotionRun,
  variant: IRegistry["variants"][number],
  take: { warmUp: number; run: number },
  runUnreal: RunUnreal,
): Promise<number> {
  const env = {
    TN_UE_SCENE: input.name,
    TN_UE_VARIANT: variant.name,
    TN_UE_WARMUP: String(take.warmUp),
    TN_UE_RUN: String(take.run),
    TN_UE_MOTION: input.motion,
  };
  if ((await runUnreal("capture", input.out, env)) !== 0) return -1;
  const stills = spec.stills ?? [];
  const jobs = (1 + stills.length) * variant.kinds.length;
  const problems = checkReadback(readFileSync(input.log, "utf8"), variant.expect, jobs);
  const folder = folderName(variant.name, take.warmUp, take.run);
  const dir = motionDir(path.basename(input.out), input.name, input.motion, folder);
  try {
    checkRun(diskStore(path.dirname(input.out)), dir, input.motion, spec.frames, stills);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  if (problems.length)
    fail("GI_READBACK", `${input.name} ${variant.name} ${input.motion}: ${problems.join("; ")}`);
  console.info(
    `TN_UNREAL_LOOK gi ${input.name} motion ${input.motion} ${folder} frames=${spec.frames} stills=${stills.length} readback ok`,
  );
  return jobs;
}

/** The takes of a variant: its warm-ups times its runs. The ID frames are one take, the region colours never move. */
function takes(input: IMotionCapture, variant: IRegistry["variants"][number]) {
  const id = variant.level === "id";
  return (id ? [REFERENCE_WARM_UP] : input.warmUps).flatMap((warmUp) =>
    Array.from({ length: id ? 1 : input.runs }, (_, i) => ({ warmUp, run: i + 1 })),
  );
}

/**
 * Renders one motion run for each variant in Unreal and checks what came out: every expected console
 * variable printed with its value, every frame and every still on disk, no frame extra. Returns the number
 * of Movie Render Queue jobs, or -1 when the editor reported a failure.
 */
export async function captureMotionRun(
  input: IMotionCapture,
  runUnreal: RunUnreal,
): Promise<number> {
  const spec = input.scene.motion?.[input.motion];
  if (!spec) fail("BAD_INPUT", `${input.name} has no motion run ${input.motion}`);
  if (!input.variants.length)
    fail("BAD_INPUT", "no variant says motion: true, name them with --variants");
  let cells = 0;
  for (const variant of input.variants)
    for (const take of takes(input, variant)) {
      const done = await captureVariant(input, spec, variant, take, runUnreal);
      if (done < 0) return -1;
      cells += done;
    }
  return cells;
}

// --- measure -----------------------------------------------------------------------------
export interface IMeasureInput {
  scene: ISceneJson;
  run: string;
  /** Directories of the colour frames and the ID frames inside the store. */
  color: string;
  id: string;
  /** Per region, the level this run must reach after its switch (another run's final level). */
  target?: Record<string, number>;
  erode?: number;
  minPixels?: number;
}
export interface IRegionReport {
  flicker: { px: number; p50: number; frames: number };
  response?: ISwitchResponse;
  ghost?: Record<number, IGhost | null>;
}

/** The first frame whose light scale differs from the key before it: the frame of the switch. */
export function switchFrame(run: IMotionRun): number | undefined {
  const keys = run.light?.keys ?? [];
  return keys.find((key, i) => i > 0 && key[1] !== keys[i - 1]?.[1])?.[0];
}

/** The frames over which a still camera's flicker is read: after the light is steady, or after the pan stops. */
function flickerWindow(spec: IMotionRun): [number, number] {
  if (spec.camera.kind === "pan")
    return [spec.camera.sweepFrames + STEADY_AFTER_PAN, spec.frames - 1];
  return [STEADY, (switchFrame(spec) ?? spec.frames) - 1];
}

export function measureRun(
  store: IFrameStore,
  input: IMeasureInput,
): Record<string, IRegionReport> {
  const spec = input.scene.motion?.[input.run];
  if (!spec) fail("BAD_INPUT", `${input.scene.scene} has no motion run ${input.run}`);
  const names = spec.regions ?? Object.keys(input.scene.regions);
  const stills = spec.stills ?? [];
  const series = runSeries(store, {
    job: input.run,
    frames: spec.frames,
    color: input.color,
    id: input.id,
    regions: Object.fromEntries(
      names.map((n) => [n, input.scene.regions[n] ?? fail("BAD_INPUT", `region ${n}`)]),
    ),
    minPixels: input.minPixels ?? MIN_PIXELS,
    minFrames: spec.camera.kind === "pan" ? MIN_PAN_FRAMES : spec.frames,
    stills,
    erode: input.erode ?? ERODE,
  });
  const at = switchFrame(spec);
  const [from, to] = flickerWindow(spec);
  const report: Record<string, IRegionReport> = {};
  for (const name of names) {
    const mine = series.regions[name] ?? fail("BAD_INPUT", `region ${name} has no series`);
    const target = input.target?.[name];
    report[name] = { flicker: flicker(mine, from, to) };
    if (at !== undefined)
      report[name].response = switchResponse(mine, {
        at,
        ...(target === undefined ? {} : { target }),
      });
    if (stills.length)
      report[name].ghost = Object.fromEntries(
        stills.map((s) => [s, series.stills[s]?.[name] ?? null]),
      );
  }
  return report;
}

// --- report ------------------------------------------------------------------------------
const pct = (v: number | undefined) => (v === undefined ? "-" : `${(v * 100).toFixed(2)}%`);
const count = (v: number | null | undefined) =>
  v === undefined || v === null ? "never" : String(v);
function table(head: string[], rows: string[][]): string {
  return [head, head.map(() => "---"), ...rows].map((r) => `| ${r.join(" | ")} |`).join("\n");
}

export interface IMotionReport {
  scene: string;
  run: string;
  engine: string;
  /** Where the frames were read from, inside the captures folder. */
  folder: string;
  regions: Record<string, IRegionReport>;
}

const SWITCH_HEAD = [
  "region",
  "engine",
  "lit p50",
  "flicker px",
  "flicker p50",
  "lag90",
  "settle",
  "overshoot",
  "residual",
];
function switchRow(name: string, engine: string, x: IRegionReport | undefined): string[] {
  const w = x?.response;
  const flat = (v: number | null | undefined) => (w?.flat ? "flat" : count(v));
  return [
    name,
    engine,
    w ? String(w.before) : "-",
    pct(x?.flicker.px),
    pct(x?.flicker.p50),
    flat(w?.lag90),
    flat(w?.settle),
    pct(w?.overshoot),
    pct(w?.residual),
  ];
}
function panRow(
  name: string,
  engine: string,
  x: IRegionReport | undefined,
  stills: string[],
): string[] {
  return [name, engine, pct(x?.flicker.px), ...stills.map((s) => pct(x?.ghost?.[Number(s)]?.px))];
}

function runTable(mine: readonly IMotionReport[]): string {
  const names = Object.keys(mine[0]?.regions ?? {});
  const first = Object.values(mine[0]?.regions ?? {})[0];
  if (first?.response)
    return table(
      SWITCH_HEAD,
      names.flatMap((n) => mine.map((r) => switchRow(n, r.engine, r.regions[n]))),
    );
  const stills = Object.keys(first?.ghost ?? {});
  return table(
    ["region", "engine", "held flicker px", ...stills.map((s) => `ghost@${s}`)],
    names.flatMap((n) => mine.map((r) => panRow(n, r.engine, r.regions[n], stills))),
  );
}

export function formatReports(reports: readonly IMotionReport[]): string {
  return [...new Set(reports.map((r) => r.run))]
    .map((run) => {
      const mine = reports.filter((r) => r.run === run);
      return `### ${mine[0]?.scene} / ${run}\n${runTable(mine)}\n`;
    })
    .join("\n");
}

// --- compare -----------------------------------------------------------------------------
interface IMotionArgs {
  scenes: { sceneId: string; scene: ISceneJson; runs: string[] }[];
  engine: string | undefined;
  store: IFrameStore;
  variant: string;
  layer: string;
  tnFolder: string;
  erode: number;
  minPixels: number;
}

/**
 * `--scene gi` reads every registered scene that has motion runs, `gi:a,gi:b` the named ones. `--run` picks
 * runs, by default all of a scene's. A named scene or run that does not exist is an error.
 */
function motionScenes(args: readonly string[]): IMotionArgs["scenes"] {
  const value = flag(args, "--scene") ?? fail("BAD_INPUT", "--scene gi or gi:<name>");
  const named = flag(args, "--run")?.split(",").filter(Boolean);
  const everyScene = value === "gi";
  const scenes = sceneNames(
    value,
    registry().scenes.map((s) => s.name),
  ).map((name) => ({ sceneId: `gi:${name}`, scene: readScene(`gi:${name}`).scene }));
  const chosen = scenes.flatMap(({ sceneId, scene }) => {
    const known = Object.keys(scene.motion ?? {});
    const runs = named ? named.filter((r) => known.includes(r)) : known;
    const missing = (named ?? []).filter((r) => !known.includes(r));
    if (!everyScene && (!known.length || missing.length))
      fail(
        "BAD_INPUT",
        `${sceneId} has the motion runs ${known.join(", ") || "none"}${missing.length ? `, not ${missing.join(", ")}` : ""}`,
      );
    return runs.length ? [{ sceneId, scene, runs }] : [];
  });
  if (!chosen.length) fail("BAD_INPUT", `--scene ${value}: no scene has a motion run to measure`);
  return chosen;
}

function motionArgs(args: readonly string[]): IMotionArgs {
  const engine = flag(args, "--engine");
  if (engine !== undefined && engine !== "unreal" && engine !== "threenative")
    fail("BAD_INPUT", "--engine unreal|threenative");
  return {
    scenes: motionScenes(args),
    engine,
    store: diskStore(path.resolve(flag(args, "--captures") ?? path.join(REFERENCE, "captures"))),
    variant: flag(args, "--unreal-variant") ?? UNREAL_MOTION_VARIANT,
    layer: flag(args, "--layer") ?? "L7",
    tnFolder: flag(args, "--tn-folder") ?? "threenative",
    erode: Number(flag(args, "--erode") ?? ERODE),
    minPixels: Number(flag(args, "--min-pixels") ?? MIN_PIXELS),
  };
}

/** The reports of one run: Unreal's own, and ThreeNative's held to the level Unreal reaches after the switch. */
function reportsFor(
  a: IMotionArgs,
  sceneId: string,
  scene: ISceneJson,
  run: string,
): IMotionReport[] {
  const shared = {
    scene,
    run,
    id: motionDir("unreal", sceneId, run, "ID"),
    erode: a.erode,
    minPixels: a.minPixels,
  };
  const unrealDir = motionDir("unreal", sceneId, run, a.variant);
  const unreal = measureRun(a.store, { ...shared, color: unrealDir });
  const reports: IMotionReport[] = [];
  const base = { scene: scene.scene, run };
  if (a.engine !== "threenative")
    reports.push({ ...base, engine: "unreal", folder: unrealDir, regions: unreal });
  if (a.engine !== "unreal") {
    const target = Object.fromEntries(
      Object.entries(unreal).flatMap(([n, r]) => (r.response ? [[n, r.response.target]] : [])),
    );
    const tnDir = motionDir(a.tnFolder, sceneId, run, a.layer);
    const regions = measureRun(a.store, { ...shared, color: tnDir, target });
    reports.push({ ...base, engine: "threenative", folder: tnDir, regions });
  }
  return reports;
}

/**
 * PRD-638: Lumen filters over time, so a region answers a switched light over more than one frame.
 * Returns 1 when Unreal's `region` answers in a frame or less, or never.
 */
export function checkGradual(reports: readonly IMotionReport[], region: string): number {
  let code = 0;
  for (const r of reports.filter((x) => x.engine === "unreal")) {
    const answer = r.regions[region]?.response;
    if (!answer) continue;
    const slow = answer.lag90 !== null && answer.lag90 > 1;
    console.info(
      `TN_UNREAL_LOOK motion ${r.run} unreal ${region}: lag90=${count(answer.lag90)} settle=${count(answer.settle)} ${slow ? "responds over more than 1 frame" : "does NOT respond over more than 1 frame"}`,
    );
    if (!slow) code = 1;
  }
  return code;
}

/**
 * `--metric motion`: the flicker, response and ghosting of each run, in Unreal and in ThreeNative.
 * ThreeNative is judged against Unreal: its ID frames, and the level each region must reach after a switch.
 */
export function compareMotion(args: readonly string[]): number {
  const a = motionArgs(args);
  const reports = a.scenes.flatMap(({ sceneId, scene, runs }) =>
    runs.flatMap((run) => reportsFor(a, sceneId, scene, run)),
  );
  console.info(formatReports(reports));
  const code = checkGradual(reports, flag(args, "--gradual") ?? "Ceiling");
  const json = flag(args, "--json");
  if (json) {
    mkdirSync(path.dirname(path.resolve(json)), { recursive: true });
    writeFileSync(json, `${JSON.stringify(reports, null, 2)}\n`);
    console.info(`TN_UNREAL_LOOK motion report ${json}`);
  }
  return code;
}
