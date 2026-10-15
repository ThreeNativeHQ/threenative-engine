/**
 * Midway frame parity: fail closed when a native frame is not the legacy frame of the same pose.
 *
 *   pnpm tsx scripts/midway-bench/parity.ts <native-run-dir> <legacy-run-dir> <legacy-run-dir> [...]
 *
 * Each frame is graded by SSIM on luma over a tile grid. A localized defect (a dead instrument
 * panel) moves one tile far more than the whole frame, so the verdict is the WORST tile, and the
 * whole-frame mean must hold too. Two legacy runs must agree with each other, or the reference is
 * unstable and the check fails. A missing frame or a size mismatch is a failure.
 *
 * Floors, calibrated 2026-10-13 on 1280x720 captures: legacy vs legacy worst tile 0.95 to 0.999;
 * broken native (every cockpit material merged into one) worst tile 0.257, mean 0.851; fixed native
 * worst tile 0.85 (0.97 with 4x MSAA), mean 0.971 (0.994). The floors sit between the broken and
 * fixed arms.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PNG } from "pngjs";

/** Frame name to the file a Midway flight run writes it to. */
export const FRAMES: Readonly<Record<string, string>> = {
  takeoff: "takeoff.png.png",
  cockpit: "cockpit.png.png",
  reargun: "reargun.png.png",
  after: "after.png",
};
export const GRID = { columns: 8, rows: 6 };
export const TILE_FLOOR = 0.7;
export const MEAN_FLOOR = 0.93;
const WINDOW = 7;

export interface ILuma {
  readonly width: number;
  readonly height: number;
  readonly data: Float64Array;
}

/** ITU-R 601 luma, as PIL's "L" mode, from a PNG file. */
export function readLuma(file: string): ILuma {
  const png = PNG.sync.read(readFileSync(file));
  const data = new Float64Array(png.width * png.height);
  for (let i = 0; i < data.length; i += 1) {
    const at = i * 4;
    data[i] =
      ((png.data[at] as number) * 299 +
        (png.data[at + 1] as number) * 587 +
        (png.data[at + 2] as number) * 114) /
      1000;
  }
  return { width: png.width, height: png.height, data };
}

/** Mean over every WINDOW x WINDOW window ('valid' region), by integral image. */
function windowMean(values: Float64Array, width: number, height: number): Float64Array {
  const stride = width + 1;
  const sum = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let row = 0;
    for (let x = 0; x < width; x += 1) {
      row += values[y * width + x] as number;
      sum[(y + 1) * stride + x + 1] = (sum[y * stride + x + 1] as number) + row;
    }
  }
  const outWidth = width - WINDOW + 1;
  const out = new Float64Array(outWidth * (height - WINDOW + 1));
  for (let y = 0; y + WINDOW <= height; y += 1)
    for (let x = 0; x + WINDOW <= width; x += 1)
      out[y * outWidth + x] =
        ((sum[(y + WINDOW) * stride + x + WINDOW] as number) -
          (sum[y * stride + x + WINDOW] as number) -
          (sum[(y + WINDOW) * stride + x] as number) +
          (sum[y * stride + x] as number)) /
        (WINDOW * WINDOW);
  return out;
}

/** Mean SSIM of the whole frame and of its worst tile. */
export function ssim(a: ILuma, b: ILuma): { mean: number; worstTile: number } {
  if (a.width !== b.width || a.height !== b.height) return { mean: -1, worstTile: -1 };
  const { width, height } = a;
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  const product = (x: Float64Array, y: Float64Array) => x.map((v, i) => v * (y[i] as number));
  const ma = windowMean(a.data, width, height);
  const mb = windowMean(b.data, width, height);
  const aa = windowMean(product(a.data, a.data), width, height);
  const bb = windowMean(product(b.data, b.data), width, height);
  const ab = windowMean(product(a.data, b.data), width, height);
  const outWidth = width - WINDOW + 1;
  const outHeight = height - WINDOW + 1;
  const tileSum = new Float64Array(GRID.columns * GRID.rows);
  const tileCount = new Float64Array(GRID.columns * GRID.rows);
  let total = 0;
  for (let y = 0; y < outHeight; y += 1)
    for (let x = 0; x < outWidth; x += 1) {
      const i = y * outWidth + x;
      const [mx, my] = [ma[i] as number, mb[i] as number];
      const varA = (aa[i] as number) - mx * mx;
      const varB = (bb[i] as number) - my * my;
      const cov = (ab[i] as number) - mx * my;
      const value =
        ((2 * mx * my + c1) * (2 * cov + c2)) / ((mx * mx + my * my + c1) * (varA + varB + c2));
      total += value;
      const tile =
        Math.floor((y * GRID.rows) / outHeight) * GRID.columns +
        Math.floor((x * GRID.columns) / outWidth);
      tileSum[tile] = (tileSum[tile] as number) + value;
      tileCount[tile] = (tileCount[tile] as number) + 1;
    }
  let worstTile = Number.POSITIVE_INFINITY;
  tileSum.forEach((s, t) => {
    if ((tileCount[t] as number) > 0) worstTile = Math.min(worstTile, s / (tileCount[t] as number));
  });
  return { mean: total / (outWidth * outHeight), worstTile };
}

export interface IFrameParity {
  readonly legacySpreadWorstTile: number[];
  readonly nativeMeanSsim: number[];
  readonly nativeWorstTile: number;
  readonly pass: boolean;
  readonly error?: string;
}

export interface IParityReport {
  readonly pass: boolean;
  readonly floors: { readonly tile: number; readonly mean: number };
  readonly frames: Record<string, IFrameParity>;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/** Grades `native` against every legacy run, for each frame in `frames`. Never throws on a bad frame. */
export function compareRuns(
  native: string,
  legacy: readonly string[],
  frames: Readonly<Record<string, string>> = FRAMES,
): IParityReport {
  if (legacy.length < 2)
    throw new Error("TN_MIDWAY_PARITY_REFERENCES: need two legacy runs to check the reference");
  const report: Record<string, IFrameParity> = {};
  for (const [frame, file] of Object.entries(frames)) {
    const missing = [native, ...legacy].map((d) => path.join(d, file)).find((f) => !existsSync(f));
    if (missing !== undefined) {
      report[frame] = {
        legacySpreadWorstTile: [],
        nativeMeanSsim: [],
        nativeWorstTile: -1,
        pass: false,
        error: `TN_MIDWAY_PARITY_MISSING: ${missing}`,
      };
      continue;
    }
    const refs = legacy.map((d) => readLuma(path.join(d, file)));
    const got = readLuma(path.join(native, file));
    const spread = refs.flatMap((a, i) => refs.slice(i + 1).map((b) => ssim(a, b).worstTile));
    const scores = refs.map((r) => ssim(got, r));
    const worst = Math.min(...scores.map((s) => s.worstTile));
    const mean = Math.min(...scores.map((s) => s.mean));
    report[frame] = {
      legacySpreadWorstTile: spread.map(round),
      nativeMeanSsim: scores.map((s) => round(s.mean)),
      nativeWorstTile: round(worst),
      pass: worst >= TILE_FLOOR && mean >= MEAN_FLOOR && Math.min(...spread) >= TILE_FLOOR,
    };
  }
  return {
    pass: Object.values(report).every((f) => f.pass),
    floors: { tile: TILE_FLOOR, mean: MEAN_FLOOR },
    frames: report,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [native, ...legacy] = process.argv.slice(2);
  if (native === undefined) {
    console.error("usage: parity.ts <native-run-dir> <legacy-run-dir> <legacy-run-dir> [...]");
    process.exit(2);
  }
  const report = compareRuns(native, legacy);
  console.log(JSON.stringify(report, null, 1));
  console.log(report.pass ? "PARITY PASS" : "PARITY FAIL");
  process.exit(report.pass ? 0 : 1);
}
