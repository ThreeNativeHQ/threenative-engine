/**
 * `tsx scripts/unreal-look/ratio.ts` — the scene-linear ratio of one ThreeNative frame to Unreal's (PRD-646).
 *
 *   pnpm unreal-look:ratio --scene gi:cornell,gi:sunlit-room --layer L1
 *   pnpm unreal-look:ratio --scene gi:cornell --layer L1 --threenative <capture> --unreal <capture> --selfcheck
 *
 * A display p50 in the filmic shoulder moves a few levels for a quarter stop of light, so the display
 * metric cannot name the size of a light gap. This tool reads the pixels instead: `lightOfLevel` inverts the
 * harness's own `filmicToneMap` (the same curve the capture drew with) back to the scene-linear light the
 * pixel was drawn from, and Unreal's `reference-stats.json` holds the same quantity as `2^ev50` from its
 * EXR. Both framebuffers are read after exposure and before the tone curve, so the ratio of the two is the
 * ratio of the light each engine put on that surface, with no exposure and no transfer function between them.
 *
 * `--selfcheck` proves that convention on Unreal's own frames: it inverts Unreal's PNG and divides by the
 * value its EXR holds, per region. One convention reads 1.00; a mixed one reads pi, 1/pi or an exposure
 * factor. It needs an Unreal capture (`--engine unreal --variants L1`), because the committed reference
 * statistics hold no PNG.
 *
 * Only a neutral region is a light row: a wall with a red albedo reflects a third of the blue light, so its
 * ratios are the material's, not the engine's. A row that saturates the curve or reads black in both frames
 * carries no light information and is counted out.
 */
import { existsSync, readFileSync } from "node:fs";
import { register } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { type IStats, decode, displayMedian, masks, measure } from "./compare.js";
import {
  type ISceneJson,
  familyOf,
  readScene,
  registry,
  sceneDir,
  sceneKey,
  sceneNames,
  unrealVariant,
} from "./gi.js";

const REFERENCE = path.resolve(import.meta.dirname, "../../tools/unreal-reference");
// The overlay imports `three`, which only the packages install: resolve it from core, as curve.ts does.
const core = pathToFileURL(path.resolve(import.meta.dirname, "../../packages/core/package.json"));
register(
  `data:text/javascript,${encodeURIComponent(
    `export const resolve = (s, c, n) => n(s, /^three(\\/|$)/.test(s) ? { ...c, parentURL: ${JSON.stringify(core.href)} } : c);`,
  )}`,
);
const { lightOfLevel, unrealCurve } = await import("./ratioCurve.js");

/** A region's albedo, when `scene.json` reports a neutral one: the rows a light ratio can be read on. */
export interface IAlbedo {
  readonly baseColor: readonly [number, number, number];
  /** The thinnest axis is Y, so the surface is a horizontal slab: its top face sees the sun at sin(elevation). */
  readonly upFacing: boolean;
}

/** Neutral: every channel within 2% of the albedo, so the light the surface reflects is the light it got. */
export const NEUTRAL_SPREAD = 0.02;
export function neutral(baseColor: readonly number[]): boolean {
  const [r = 1, g = 1, b = 1] = baseColor;
  const mean = (r + g + b) / 3;
  return mean > 0 && Math.max(r, g, b) - Math.min(r, g, b) <= NEUTRAL_SPREAD;
}

export interface IRatioRow {
  readonly scene: string;
  readonly layer: string;
  readonly pose: string;
  readonly region: string;
  /** The sub-level median of the display value each engine wrote, 0-255. */
  readonly unrealLevel: number;
  readonly threenativeLevel: number;
  /** The scene-linear light each level was drawn from, in the units the exposure put it in. */
  readonly unrealLight: number | null;
  readonly threenativeLight: number | null;
  /** ThreeNative over Unreal, in light. Null when either frame saturated or read black in both. */
  readonly ratio: number | null;
  /** Unreal's light against the ideal Lambertian source rule, on an up-facing neutral face: the exposure it implies. */
  readonly impliedExposure: number | null;
  readonly note: string | null;
}

export interface ISummary {
  readonly rows: readonly IRatioRow[];
  readonly neutralRows: number;
  readonly readRows: number;
  readonly median: number;
  readonly min: number;
  readonly max: number;
  readonly impliedExposure: readonly number[];
}

const median = (values: readonly number[]): number => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
};

/** The unexposed radiance of a Lambertian face lit by `lux` at `elevationDeg`, in the same units Unreal uses. */
export function lambertRadiance(albedo: number, lux: number, elevationDeg: number): number {
  return (albedo / Math.PI) * lux * Math.sin((elevationDeg * Math.PI) / 180);
}

/**
 * The ID frame that masks a pose: a live Unreal capture's own, or the committed one, which is the same frame
 * the sameness gate compares (a geometry ID does not change with the light).
 */
function idFrame(name: string, pose: string, unrealRoot: string | undefined): string {
  const live =
    unrealRoot === undefined
      ? undefined
      : path.join(unrealRoot, sceneKey(name), "ID", `${pose}.png`);
  if (live !== undefined && existsSync(live)) return live;
  return path.join(sceneDir(name), "id", `${pose}.png`);
}

/** The sun a pose of a template scene is drawn under; a calibration scene has one sun or none. */
function sunOf(scene: ISceneJson, pose: string): { elevationDeg: number } | undefined {
  const named = scene.poses.find((p) => p.name === pose)?.sun;
  if (named !== undefined) return scene.suns?.find((sun) => sun.name === named);
  // Only a template scene runs one level per sun; a calibration scene's sun has no elevation in scene.json.
  return scene.suns?.length === 1 ? scene.suns[0] : undefined;
}

/** The albedo and the facing of every neutral region of a scene, by the region its meshes carry. */
export function albedosOf(scene: ISceneJson): Record<string, IAlbedo> {
  const out: Record<string, IAlbedo> = {};
  for (const mesh of scene.meshes) {
    const baseColor = mesh.material.baseColor;
    if (!neutral(baseColor)) continue;
    const [x, y, z] = mesh.size;
    out[mesh.region ?? mesh.name] = { baseColor, upFacing: y <= Math.min(x, z) };
  }
  return out;
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const sawFlag = (name: string): boolean => process.argv.includes(name);

/** One scene's rows: the committed Unreal statistics against one ThreeNative capture. */
export function ratioRows(
  name: string,
  layers: readonly string[],
  threenativeRoot: string,
  unrealRoot?: string,
): IRatioRow[] {
  const { scene } = readScene(name);
  const key = sceneKey(name);
  const albedos = albedosOf(scene);
  const stats = existsSync(path.join(sceneDir(name), "reference-stats.json"))
    ? (JSON.parse(readFileSync(path.join(sceneDir(name), "reference-stats.json"), "utf8")) as {
        cells: Record<string, Record<string, IStats>>;
      })
    : undefined;
  const rows: IRatioRow[] = [];
  for (const layer of layers) {
    const variant = unrealVariant(layer);
    for (const pose of scene.poses) {
      const ids = idFrame(name, pose.name, unrealRoot);
      const regions = masks(decode(readFileSync(ids)), scene.regions).regions;
      const tn = path.join(threenativeRoot, key, layer, `${pose.name}.png`);
      if (!existsSync(tn)) throw new Error(`TN_UNREAL_LOOK_MISSING_CELL: ${tn}`);
      const image = decode(readFileSync(tn), "png");
      const folder = path.join(unrealRoot ?? "", key, variant);
      const png = path.join(folder, `${pose.name}.png`);
      const exr = path.join(folder, `${pose.name}.exr`);
      const live = unrealRoot !== undefined && existsSync(png) && existsSync(exr);
      const unrealImage = live ? decode(readFileSync(png)) : undefined;
      const unrealExr = live ? decode(readFileSync(exr), "exr") : undefined;
      const sun = sunOf(scene, pose.name);
      for (const [region, mask] of Object.entries(regions)) {
        if (region === "Sky" || !mask.some(Boolean)) continue;
        const reference =
          unrealImage !== undefined
            ? measure(unrealImage, mask, unrealExr)
            : stats?.cells[`${variant}/${pose.name}`]?.[region];
        if (reference?.ev50 === null || reference === undefined) continue;
        const unrealLevel = reference.p50;
        const threenativeLevel = displayMedian(image, mask);
        const unrealLight = 2 ** (reference.ev50 as number);
        const threenativeLight = lightOfLevel(threenativeLevel, unrealCurve());
        const albedo = albedos[region];
        const lux = scene.sun?.intensityLux ?? 0;
        const flat = albedo?.upFacing === true && sun !== undefined && lux > 0;
        const impliedExposure =
          flat && albedo !== undefined
            ? unrealLight / lambertRadiance(albedo.baseColor[1], lux, sun.elevationDeg)
            : null;
        let ratio: number | null =
          threenativeLight === null ? null : threenativeLight / unrealLight;
        let note: string | null = albedo === undefined ? "not neutral" : null;
        if (ratio !== null && (threenativeLevel >= 252 || unrealLevel >= 252)) {
          note = "saturated";
          ratio = null;
        }
        if (
          ratio !== null &&
          threenativeLight !== null &&
          threenativeLevel <= 1 &&
          unrealLevel <= 1
        ) {
          note = "black in both";
          ratio = null;
        }
        rows.push({
          scene: name,
          layer,
          pose: pose.name,
          region,
          unrealLevel,
          threenativeLevel,
          unrealLight,
          threenativeLight,
          ratio,
          impliedExposure,
          note,
        });
      }
    }
  }
  return rows;
}

export function summarise(rows: readonly IRatioRow[]): ISummary {
  const neutralRows = rows.filter((row) => row.note !== "not neutral");
  const ratios = neutralRows.flatMap((row) => (row.ratio === null ? [] : [row.ratio]));
  const exposure = rows.flatMap((row) =>
    row.impliedExposure === null || row.note !== null ? [] : [row.impliedExposure],
  );
  return {
    rows,
    neutralRows: neutralRows.length,
    readRows: ratios.length,
    median: median(ratios),
    min: ratios.length ? Math.min(...ratios) : Number.NaN,
    max: ratios.length ? Math.max(...ratios) : Number.NaN,
    impliedExposure: exposure,
  };
}

function print(summary: ISummary): void {
  const f = (value: number | null, digits = 3) =>
    value === null || Number.isNaN(value) ? "—" : value.toFixed(digits);
  console.log(
    "| scene | layer | pose | region | UE level | TN level | UE light | TN light | TN/UE | note |\n|---|---|---|---|---:|---:|---:|---:|---:|---|",
  );
  for (const row of summary.rows)
    console.log(
      `| ${row.scene} | ${row.layer} | ${row.pose} | ${row.region} | ${f(row.unrealLevel, 1)} | ${f(row.threenativeLevel, 1)} | ${f(row.unrealLight, 4)} | ${f(row.threenativeLight, 4)} | ${f(row.ratio)} | ${row.note ?? ""} |`,
    );
  console.log(
    `\nneutral rows ${summary.neutralRows}, read ${summary.readRows}: median ${f(summary.median)}, min ${f(summary.min)}, max ${f(summary.max)}`,
  );
  if (summary.impliedExposure.length)
    console.log(
      `Unreal light over the ideal Lambertian rule on the up-facing rows (the exposure it implies): ${summary.impliedExposure.map((v) => f(v, 2)).join(", ")}`,
    );
}

/** `--selfcheck`: does the inversion of Unreal's own PNG reproduce the value of its own EXR? */
function selfCheck(name: string, layers: readonly string[], unrealRoot: string): number {
  const { scene } = readScene(name);
  const key = sceneKey(name);
  const albedos = albedosOf(scene);
  let worst = 0;
  let read = 0;
  console.log(
    "| scene | layer | pose | region | UE level | UE EXR light | inverted PNG light | inverted / EXR |\n|---|---|---|---|---:|---:|---:|---:|",
  );
  for (const layer of layers) {
    const variant = unrealVariant(layer);
    for (const pose of scene.poses) {
      const folder = path.join(unrealRoot, key, variant);
      const png = decode(readFileSync(path.join(folder, `${pose.name}.png`)));
      const exr = decode(readFileSync(path.join(folder, `${pose.name}.exr`)), "exr");
      const regions = masks(
        decode(readFileSync(idFrame(name, pose.name, unrealRoot))),
        scene.regions,
      ).regions;
      for (const [region, mask] of Object.entries(regions)) {
        if (albedos[region] === undefined || !mask.some(Boolean)) continue;
        const stats = measure(png, mask, exr);
        // A black region carries no light in either file, so its ratio says nothing about the convention.
        if (stats.ev50 === null || stats.p50 <= 1) continue;
        const light = lightOfLevel(stats.p50, unrealCurve());
        if (light === null) continue;
        const factor = light / 2 ** stats.ev50;
        read += 1;
        worst = Math.max(worst, Math.abs(factor - 1));
        console.log(
          `| ${name} | ${layer} | ${pose.name} | ${region} | ${stats.p50.toFixed(1)} | ${(2 ** stats.ev50).toFixed(4)} | ${light.toFixed(4)} | ${factor.toFixed(3)} |`,
        );
      }
    }
  }
  console.log(`\n${read} neutral row(s): worst |inverted/EXR - 1| = ${(worst * 100).toFixed(2)}%`);
  return read > 0 && worst <= 0.05 ? 0 : 1;
}

function main(): number {
  const value = flag("--scene") ?? "gi";
  const names = sceneNames(
    value,
    registry(familyOf(value)).scenes.map((s) => s.name),
  );
  const layers = (flag("--layer") ?? "L1").split(",");
  const unreal = flag("--unreal");
  if (sawFlag("--selfcheck")) {
    if (unreal === undefined)
      throw new Error("TN_UNREAL_LOOK_BAD_INPUT: --selfcheck needs --unreal <capture>");
    let code = 0;
    for (const name of names) code = Math.max(code, selfCheck(name, layers, path.resolve(unreal)));
    return code;
  }
  const threenative = path.resolve(
    flag("--threenative") ?? path.join(REFERENCE, "captures", "threenative"),
  );
  const summaries = names.map((name) => summarise(ratioRows(name, layers, threenative, unreal)));
  if (sawFlag("--json")) {
    console.log(JSON.stringify(summaries, null, 2));
    return 0;
  }
  for (const summary of summaries) print(summary);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main();
}
