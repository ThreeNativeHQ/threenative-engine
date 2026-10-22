/**
 * `tsx scripts/unreal-look/stage-effect.ts --on <dir> --off <dir> --ue-on <dir> --ue-off <dir>` — what one
 * finishing stage adds to the frame in ThreeNative, against what it adds in Unreal (PRD-636).
 *
 * Each directory holds `L9/L9_<sun>_<pose>.png` cells. The effect of a stage in an engine is the log2 ratio of
 * the frame's luminance with the stage over the same cell without it, so exposure, sky and lights cancel and
 * what is left is the stage. Per cell this prints the mean effect of both engines, the mean absolute difference
 * of the two effect maps and their correlation. Stock bloom against Unreal's:
 *   pnpm unreal-look:stage-effect --on <fx-stock> --off <fx-nobloom> --ue-on <unreal-fx> --ue-off <unreal-fxnobloom>
 * The arms come from `pnpm unreal-look:capture --off <stage>` (ThreeNative) and a console variable per arm in
 * `tools/unreal-reference/build_level.py` (`TN_UE_OVERRIDE_CVARS`). Every missing cell fails the run.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { decode } from "./compare.js";
import { linearLuminance } from "./penumbra.js";

/** Keeps the log finite where a stage takes a pixel to black. */
const FLOOR = 1e-4;

export interface IStageEffect {
  /** Mean log2 effect in ThreeNative. */
  readonly tn: number;
  /** Mean log2 effect in Unreal. */
  readonly ue: number;
  /** Mean absolute difference of the two effect maps, in stops. */
  readonly mad: number;
  /** Pearson correlation of the two effect maps; NaN when either map is flat. */
  readonly corr: number;
}

/** log2 of the frame with the stage over the frame without it, per pixel. */
export function effectMap(on: ArrayLike<number>, off: ArrayLike<number>): Float64Array {
  if (on.length !== off.length)
    throw new Error(`STAGE_EFFECT_SIZE: ${on.length} versus ${off.length} pixels`);
  return Float64Array.from({ length: on.length }, (_, i) =>
    Math.log2(((on[i] ?? 0) + FLOOR) / ((off[i] ?? 0) + FLOOR)),
  );
}

const mean = (a: ArrayLike<number>): number => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] ?? 0;
  return sum / a.length;
};

/** The two effect maps side by side. */
export function compareEffects(tn: ArrayLike<number>, ue: ArrayLike<number>): IStageEffect {
  if (tn.length !== ue.length)
    throw new Error(`STAGE_EFFECT_SIZE: ${tn.length} versus ${ue.length} pixels`);
  if (tn.length === 0) throw new Error("STAGE_EFFECT_EMPTY: no pixels");
  const [mt, mu] = [mean(tn), mean(ue)];
  let abs = 0;
  let cross = 0;
  let vt = 0;
  let vu = 0;
  for (let i = 0; i < tn.length; i++) {
    const [dt, du] = [(tn[i] ?? 0) - mt, (ue[i] ?? 0) - mu];
    abs += Math.abs((tn[i] ?? 0) - (ue[i] ?? 0));
    cross += dt * du;
    vt += dt * dt;
    vu += du * du;
  }
  const flat = vt / tn.length < 1e-18 || vu / tn.length < 1e-18;
  return {
    tn: mt,
    ue: mu,
    mad: abs / tn.length,
    corr: flat ? Number.NaN : cross / Math.sqrt(vt * vu),
  };
}

function luminance(file: string): Float64Array {
  if (!existsSync(file)) throw new Error(`STAGE_EFFECT_MISSING_CELL: ${file}`);
  const image = decode(readFileSync(file));
  return linearLuminance(image.data, image.width * image.height);
}

export function main(args = process.argv.slice(2)): void {
  const flag = (name: string): string => {
    const at = args.indexOf(name);
    const value = at === -1 ? undefined : args[at + 1];
    if (value === undefined) throw new Error(`STAGE_EFFECT_USAGE: ${name} <dir> is required`);
    return path.resolve(value);
  };
  const [on, off, ueOn, ueOff] = [flag("--on"), flag("--off"), flag("--ue-on"), flag("--ue-off")];
  const cells = readdirSync(path.join(on, "L9"))
    .filter((f) => /^L9_.*\.png$/u.test(f))
    .sort();
  if (cells.length === 0) throw new Error(`STAGE_EFFECT_NO_CELLS: no L9 cells in ${on}`);
  const rows: Record<string, IStageEffect> = {};
  console.log(
    `${"cell".padEnd(24)} ${"TN".padStart(7)} ${"UE".padStart(7)} ${"|d|".padStart(7)} ${"corr".padStart(6)}`,
  );
  for (const cell of cells) {
    const at = (dir: string): Float64Array => luminance(path.join(dir, "L9", cell));
    const row = compareEffects(effectMap(at(on), at(off)), effectMap(at(ueOn), at(ueOff)));
    rows[cell.replace(/^L9_|\.png$/gu, "")] = row;
    console.log(
      `${cell.replace(/^L9_|\.png$/gu, "").padEnd(24)} ${row.tn.toFixed(3).padStart(7)} ${row.ue.toFixed(3).padStart(7)} ${row.mad.toFixed(3).padStart(7)} ${row.corr.toFixed(2).padStart(6)}`,
    );
  }
  const all = Object.values(rows);
  console.log(
    `${"mean".padEnd(24)} ${mean(all.map((r) => r.tn))
      .toFixed(3)
      .padStart(7)} ${mean(all.map((r) => r.ue))
      .toFixed(3)
      .padStart(7)} ${mean(all.map((r) => r.mad))
      .toFixed(3)
      .padStart(7)}`,
  );
  const json = args.indexOf("--json");
  if (json !== -1 && args[json + 1] !== undefined)
    writeFileSync(path.resolve(args[json + 1] as string), `${JSON.stringify(rows, null, 1)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
