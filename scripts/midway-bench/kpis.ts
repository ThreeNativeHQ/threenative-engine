/**
 * PRD-610 scoring for the Midway tab: KPI progress from the first recorded run to the target,
 * trends with their target lines, A/B pairs with the keep rule, and the PRD's ticked AC boxes.
 * Fail closed: no data is `pending`, never `pass`, and a missing PRD file reports no progress.
 */
import { readFile } from "node:fs/promises";
import { type Arm, type IMidwayRun, finite, loadMidwayRuns, median, runsDir } from "./dashboard.js";

export const POSES = ["takeoff", "cockpit", "reargun"] as const;
/** PRD-610 targets. */
export const TARGETS = { cullPct: 2, hudP95Ms: 16.7, matrixVisited: 1500, ratio: 1 } as const;
const PRD = new URL(
  "../../docs/PRDs/performance/PRD-610-native-engine-wins-on-real-games.md",
  import.meta.url,
);

export type Verdict = "pass" | "fail" | "pending";

/** Main-thread ms per frame that every arm reports: desktop `cpuFrameCpuMs`, web `frame.p50`. */
export const mainThreadMs = (run: IMidwayRun) =>
  run.arm === "desktop" ? run.desktop?.medians.cpuFrameCpuMs : run.budget?.frameP50;

/** The legacy reference: median over every legacy run that has a frame time. */
export const legacyMs = (runs: readonly IMidwayRun[]) =>
  median(
    runs
      .filter((r) => r.arm === "legacy")
      .map(mainThreadMs)
      .filter(finite),
  );

/** `- [x] AC-n` against `- [ ] AC-n` in the PRD. No AC boxes at all means no progress, not 0 of 0. */
export function prdProgress(markdown: string) {
  const boxes = [...markdown.matchAll(/^- \[([ xX])\] (AC-\d+)/gm)];
  if (!boxes.length) return undefined;
  const ticked = boxes.filter((m) => m[1] !== " ").map((m) => m[2] as string);
  return {
    done: ticked.length,
    total: boxes.length,
    ticked,
    open: boxes.filter((m) => m[1] === " ").map((m) => m[2] as string),
  };
}

/** Fraction of the way from the baseline to the target; it works for lower- and higher-is-better alike. */
export function progressOf(baseline: number, current: number, target: number): number {
  return baseline === target
    ? current === target
      ? 1
      : 0
    : (current - baseline) / (target - baseline);
}

export interface IKpi {
  id: string;
  title: string;
  verdict: Verdict;
  better: "lower" | "higher";
  unit: string;
  target: number;
  current?: number;
  baseline?: number;
  /** 0 at the baseline, 1 at the target; below 0 is a regression and above 1 is past the target. */
  progress?: number;
  run?: string;
  baselineRun?: string;
  /** The PRD box for this AC is ticked. */
  ticked?: boolean;
  detail: string;
}

const parityNote = (run: IMidwayRun | undefined) =>
  !run?.parity
    ? "no parity.json"
    : run.parity.pass && POSES.every((p) => run.parity?.frames[p]?.pass)
      ? undefined
      : "parity FAIL";

interface IMeasure {
  run: IMidwayRun;
  value: number;
}

/** Oldest and newest run of an arm that carry a value. */
function ends(runs: readonly IMidwayRun[], arm: Arm, get: (r: IMidwayRun) => number | undefined) {
  const hits = runs.flatMap((run): IMeasure[] => {
    const value = run.arm === arm ? get(run) : undefined;
    return value === undefined ? [] : [{ run, value }];
  });
  return { first: hits[0], last: hits.at(-1) };
}

export function kpisOf(runs: readonly IMidwayRun[], prd = prdProgress("")): IKpi[] {
  const legacy = legacyMs(runs);
  const ratio = (r: IMidwayRun) => {
    const ms = mainThreadMs(r);
    return legacy === undefined || ms === undefined ? undefined : legacy / ms;
  };
  const make = (
    id: string,
    title: string,
    better: IKpi["better"],
    unit: string,
    target: number,
    { first, last }: { first?: IMeasure; last?: IMeasure },
    detail: (last: IMeasure) => string,
    pass: (last: IMeasure) => boolean,
    why = "no samples",
  ): IKpi => {
    const base = { id, title, better, unit, target, ticked: prd?.ticked.includes(id) ?? false };
    if (!first || !last) return { ...base, verdict: "pending", detail: why };
    return {
      ...base,
      verdict: pass(last) ? "pass" : "fail",
      current: last.value,
      baseline: first.value,
      progress: progressOf(first.value, last.value, target),
      run: last.run.dir,
      baselineRun: first.run.dir,
      detail: detail(last),
    };
  };
  const ratioKpi = (id: string, title: string, arm: Arm, floor: "above" | "atLeast") => {
    const e = ends(runs, arm, ratio);
    const bad = parityNote(e.last?.run);
    return make(
      id,
      title,
      "higher",
      "x",
      TARGETS.ratio,
      e,
      (l) =>
        `${(mainThreadMs(l.run) as number).toFixed(2)} ms vs legacy ${(legacy as number).toFixed(2)} ms, ${bad ?? "parity PASS"}. Run level, poses are not separated in the logs.`,
      (l) =>
        bad === undefined &&
        (floor === "above" ? l.value > TARGETS.ratio : l.value >= TARGETS.ratio),
      `no samples: need a ${arm} run and a legacy run`,
    );
  };
  return [
    make(
      "AC-3",
      "Matrix walk",
      "lower",
      "nodes",
      TARGETS.matrixVisited,
      ends(runs, "desktop", (r) => r.matrix?.last),
      (l) => `last ${l.value}, max ${l.run.matrix?.max} over ${l.run.matrix?.n} projection lines`,
      (l) => l.value <= TARGETS.matrixVisited,
    ),
    make(
      "AC-4",
      "Cull share of main thread",
      "lower",
      "%",
      TARGETS.cullPct,
      ends(runs, "desktop", (r) => r.cullPct),
      () => "ProjectedCull::apply share, from cull.json",
      (l) => l.value < TARGETS.cullPct,
      'no samples: write cull.json {"sharePct": n} into a desktop run dir',
    ),
    make(
      "AC-5",
      "HUD round trip p95",
      "lower",
      "ms",
      TARGETS.hudP95Ms,
      ends(runs, "desktop", (r) => r.ui?.p95),
      (l) =>
        `p50 ${l.run.ui?.p50.toFixed(1)} ms, p95 ${l.value.toFixed(1)} ms over ${l.run.ui?.n} snapshots`,
      (l) => l.value < TARGETS.hudP95Ms,
    ),
    ratioKpi("AC-6", "Desktop vs three.js", "desktop", "above"),
    ratioKpi("AC-7", "Web Wasm vs three.js", "native", "atLeast"),
  ];
}

export interface ITrendPoint {
  dir: string;
  arm: Arm;
  v: number;
}
export interface ITrend {
  id: string;
  title: string;
  unit: string;
  target?: number;
  targetLabel: string;
  points: ITrendPoint[];
  /** Percent better than the first desktop point (positive is better; every trend is lower-is-better). */
  deltaPct?: number;
}

export function trendsOf(runs: readonly IMidwayRun[]): ITrend[] {
  const legacy = legacyMs(runs);
  const trend = (
    id: string,
    title: string,
    unit: string,
    target: number | undefined,
    targetLabel: string,
    get: (r: IMidwayRun) => number | undefined,
  ): ITrend => {
    const points = runs.flatMap((r): ITrendPoint[] => {
      const v = get(r);
      return v === undefined ? [] : [{ dir: r.dir, arm: r.arm, v }];
    });
    const desktop = points.filter((p) => p.arm === "desktop");
    const first = desktop[0]?.v;
    const last = desktop.at(-1)?.v;
    return {
      id,
      title,
      unit,
      targetLabel,
      points,
      ...(target === undefined ? {} : { target }),
      ...(first && last !== undefined && desktop.length > 1
        ? { deltaPct: ((first - last) / first) * 100 }
        : {}),
    };
  };
  return [
    trend("ms", "Main-thread ms per frame", "ms", legacy, "three.js", mainThreadMs),
    trend("hud", "HUD round trip p95", "ms", TARGETS.hudP95Ms, "target", (r) => r.ui?.p95),
    trend(
      "matrix",
      "Matrix walk visited",
      "nodes",
      TARGETS.matrixVisited,
      "target",
      (r) => r.matrix?.last,
    ),
  ];
}

export interface IAbPair {
  stem: string;
  arm: Arm;
  a: { dir: string; ms: number }[];
  b: { dir: string; ms: number }[];
  /** Keep rule: every B beats every A (lower ms per frame). */
  verdict: "keep" | "reject" | "pending";
  medianA?: number;
  medianB?: number;
}

/** Pairs groups named `<stem>-a` and `<stem>-b` of the same arm. */
export function abPairsOf(runs: readonly IMidwayRun[]): IAbPair[] {
  const sides = new Map<string, { stem: string; arm: Arm; a: IAbPair["a"]; b: IAbPair["b"] }>();
  for (const r of runs) {
    const m = /^(.+)-([ab])$/.exec(r.group);
    const ms = mainThreadMs(r);
    if (!m || ms === undefined) continue;
    const key = `${m[1]}\0${r.arm}`;
    const entry = sides.get(key) ?? { stem: m[1] as string, arm: r.arm, a: [], b: [] };
    entry[m[2] as "a" | "b"].push({ dir: r.dir, ms });
    sides.set(key, entry);
  }
  return [...sides.values()]
    .filter((s) => s.a.length || s.b.length)
    .map((s) => {
      const [a, b] = [s.a.map((x) => x.ms), s.b.map((x) => x.ms)];
      const ready = a.length > 0 && b.length > 0;
      const mA = median(a);
      const mB = median(b);
      return {
        ...s,
        verdict: !ready ? "pending" : Math.max(...b) < Math.min(...a) ? "keep" : "reject",
        ...(mA === undefined ? {} : { medianA: mA }),
        ...(mB === undefined ? {} : { medianB: mB }),
      };
    });
}

export interface IGroup {
  group: string;
  arm: Arm;
  runs: number;
  cpuFrameMs?: number;
  frameP95?: number;
  hudP95?: number;
  matrixLast?: number;
  parityPass: number;
}

/** A/B grouping by tag prefix and arm: `walk-a1..a3` against `walk-b1..b3`. */
export function groupsOf(runs: readonly IMidwayRun[]): IGroup[] {
  const by = new Map<string, IMidwayRun[]>();
  for (const r of runs)
    by.set(`${r.group}\0${r.arm}`, [...(by.get(`${r.group}\0${r.arm}`) ?? []), r]);
  const med = (list: readonly IMidwayRun[], get: (r: IMidwayRun) => number | undefined) =>
    median(list.map(get).filter(finite));
  return [...by.values()].map((list) => {
    const first = list[0] as IMidwayRun;
    const opt = <K extends string>(key: K, value: number | undefined) =>
      value === undefined ? {} : { [key]: value };
    return {
      group: first.group,
      arm: first.arm,
      runs: list.length,
      parityPass: list.filter((r) => r.parity?.pass).length,
      ...opt("cpuFrameMs", med(list, mainThreadMs)),
      ...opt(
        "frameP95",
        med(list, (r) => r.desktop?.frameP95 ?? r.budget?.frameP95),
      ),
      ...opt(
        "hudP95",
        med(list, (r) => r.ui?.p95),
      ),
      ...opt(
        "matrixLast",
        med(list, (r) => r.matrix?.last),
      ),
    };
  });
}

/** Latest desktop run's frame split: game JS, render, other main-thread work, and the present call. */
export function breakdownOf(runs: readonly IMidwayRun[]) {
  const run = runs
    .filter((r) => r.arm === "desktop" && r.desktop?.medians.cpuFrameCpuMs !== undefined)
    .at(-1);
  const m = run?.desktop?.medians;
  if (!run || !m || m.cpuFrameCpuMs === undefined) return undefined;
  const gameJs = m.gameJsCpuMs ?? 0;
  const render = m.renderCpuMs ?? 0;
  return {
    dir: run.dir,
    gameJs,
    render,
    other: Math.max(0, m.cpuFrameCpuMs - gameJs - render),
    present: m.presentCpuMs ?? 0,
  };
}

export function midwayOf(runs: readonly IMidwayRun[], prdText?: string) {
  const prd = prdText === undefined ? undefined : prdProgress(prdText);
  return {
    kpis: kpisOf(runs, prd),
    prd,
    trends: trendsOf(runs),
    abPairs: abPairsOf(runs),
    breakdown: breakdownOf(runs),
    groups: groupsOf(runs),
    legacyMs: legacyMs(runs),
    runs,
    skipped: runs.reduce((n, r) => n + r.skipped, 0),
    dir: runsDir(),
  };
}

/** Everything the tab shows, read fresh. */
export async function midwayState() {
  return midwayOf(await loadMidwayRuns(), await readFile(PRD, "utf8").catch(() => undefined));
}
