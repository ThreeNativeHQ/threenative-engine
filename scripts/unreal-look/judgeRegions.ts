/**
 * The measured half of the visual judge (judge.ts `--region-limit`): per region, how far AFTER sits from
 * Unreal in the PRD-631 relative median difference (dP50), taken from the same capture frames the judge
 * opens. The judge sees these numbers in its prompt, and a region past the limit caps its frame, and the
 * round, at FAR. A model that looks at pictures called four wildwood frames CLOSE while the tree crown
 * sat 0.38 to 0.87 above Unreal against a 0.25 limit (PR #541, comment 6329578609).
 */
import path from "node:path";
import { compareGiToUnreal } from "./gi.js";
import { type IFrame, type IJudgeRun, type Tier, fail } from "./judgeVerdict.js";

/** One region of one frame: Unreal's median and the dP50 of every run, BEFORE and AFTER. */
export interface IRegionMeasure {
  /** The frame id of the judge round. */
  frame: string;
  region: string;
  unrealP50: number;
  before: number[];
  after: number[];
}
export type IMeasure = (
  frames: readonly IFrame[],
  sets: { before: string[]; after: string[]; unreal: string },
  tier: Tier,
) => IRegionMeasure[];

const mean = (values: readonly number[]) =>
  values.reduce((sum, value) => sum + value, 0) / values.length;
const f2 = (value: number) => value.toFixed(2);

/** The scene id, layer folder and pose a capture file stands for: `<run>/shadow/wildwood/L7/pose.png`. */
export function sceneOfFrame(runDir: string, file: string) {
  const parts = path.relative(runDir, file).split(path.sep);
  const pose = (parts.pop() ?? "").replace(/\.png$/i, "");
  const layer = parts.pop() ?? "";
  if (parts.length === 0 || layer === "")
    return fail(
      "REGIONS_SCENE",
      `${file} is not <run>/<scene>/<layer>/<pose>.png, so its regions cannot be measured`,
    );
  const scene =
    parts[0] === "shadow" && parts.length === 2 ? `shadow:${parts[1]}` : parts.join("/");
  return { scene, layer, pose };
}

/** dP50 per region and run, from the same compare pipeline as `pnpm unreal-look:compare`. */
export const measureRegions: IMeasure = (frames, sets, tier) => {
  const cache = new Map<string, ReturnType<typeof compareGiToUnreal>>();
  // A GI tier picks the Unreal level it follows; the shadow family names its variants after the layers.
  const level = tier === "high" ? undefined : tier === "medium" ? 1 : 0;
  const dP50 = (runDir: string, file: string, frame: IFrame) => {
    const { scene, layer, pose } = sceneOfFrame(runDir, file);
    const key = `${runDir}\0${scene}\0${layer}`;
    if (!cache.has(key))
      cache.set(
        key,
        compareGiToUnreal(
          scene,
          [layer],
          { unreal: sets.unreal, threenative: runDir },
          scene.startsWith("shadow:") ? undefined : level,
        ),
      );
    const rows = (cache.get(key) ?? []).filter((r) => r.cell.endsWith(`/${pose}`));
    if (rows.length === 0)
      fail("REGIONS_MISSING", `${frame.id}: no region rows for ${scene} ${layer} ${pose}`);
    return rows;
  };
  const rows: IRegionMeasure[] = [];
  for (const frame of frames) {
    const run = (dirs: string[], files: string[]) =>
      files.map((file, i) => dP50(dirs[i] as string, file, frame));
    const before = run(sets.before, frame.before);
    const after = run(sets.after, frame.after);
    for (const first of after[0] ?? []) {
      const pick = (arm: ReturnType<typeof dP50>[]) =>
        arm.map((cell) => {
          const found = cell.find((r) => r.region === first.region)?.dP50;
          if (found === undefined || found === null)
            return fail("REGIONS_MISSING", `${frame.id}: no dP50 for region ${first.region}`);
          return found;
        });
      rows.push({
        frame: frame.id,
        region: first.region,
        unrealP50: first.unreal?.p50 ?? Number.NaN,
        before: pick(before),
        after: pick(after),
      });
    }
  }
  return rows;
};

/** The regions of a frame whose mean AFTER dP50 is past the limit. */
const overRegions = (rows: readonly IRegionMeasure[], frame: string, limit: number) =>
  rows.filter((r) => r.frame === frame && mean(r.after) > limit).map((r) => r.region);

/** The table the judge reads, and the report prints. */
export function regionTable(rows: readonly IRegionMeasure[], limit: number): string {
  const runs = (values: readonly number[]) => values.map(f2).join(" / ");
  return [
    `| frame | region | Unreal p50 | dP50 BEFORE runs | dP50 AFTER runs | limit ${limit} |`,
    "|---|---|---:|---:|---:|---|",
    ...rows.map(
      (r) =>
        `| ${r.frame} | ${r.region} | ${f2(r.unrealP50)} | ${runs(r.before)} | ${runs(r.after)} | ${mean(r.after) > limit ? "OVER" : "ok"} |`,
    ),
  ].join("\n");
}

/**
 * A region past the limit makes its frame FAR, and a round with such a frame FAR, whatever the judge
 * said from the pictures. Each frame needs measured regions with an AFTER run: no numbers is no verdict.
 */
export function capAtFar(
  run: IJudgeRun,
  rows: readonly IRegionMeasure[],
  limit: number,
): { judged: IJudgeRun; capped: Map<string, string[]> } {
  const capped = new Map<string, string[]>();
  const frames = run.frames.map((entry) => {
    const own = rows.filter((r) => r.frame === entry.id);
    if (own.length === 0 || own.some((r) => r.after.length === 0))
      fail("REGIONS_MISSING", `no measured regions with an AFTER run for ${entry.id}`);
    const over = overRegions(rows, entry.id, limit);
    if (over.length === 0) return entry;
    capped.set(entry.id, over);
    return { ...entry, vsUnreal: "FAR" as const };
  });
  const overall = capped.size > 0 ? { ...run.overall, vsUnreal: "FAR" as const } : run.overall;
  return { judged: { ...run, frames, overall }, capped };
}
