import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";
import { collectRegionalTone } from "../../packages/playtest/src/capture.js";
import { BenchError, type IRunReport, type RenderMode } from "./report.js";

/** Maximum 4x4 tile mean RGB/luminance delta / 255. Provisional: calibrate on GPU pairs.
 * L rungs have rigid cubes; R2 adds shadows, R3 animation, R4 particles, R5 post noise.
 * Tile means tolerate motion/noise while a locally blocked windscreen cannot hide in a global mean.
 */
export const VISUAL_THRESHOLDS: Record<RenderMode, number> = {
  L1: 0.12,
  L2: 0.12,
  L3: 0.12,
  L4: 0.12,
  R1: 0.12,
  R2: 0.15,
  R3: 0.18,
  R4: 0.2,
  R5: 0.22,
};

export interface IVisualParity {
  key: string;
  repeat: number;
  round: number;
  score: number | null;
  threshold: number;
  waived: boolean;
  error?: "TN_BENCH_VISUAL_MISSING" | "TN_BENCH_VISUAL_PARITY";
}

function tiles(file: string | undefined): number[] {
  if (file === undefined) throw new Error("frame path missing");
  const bytes = readFileSync(file);
  const image = PNG.sync.read(bytes);
  if (image.width < 4 || image.height < 4) throw new Error("frame smaller than tile grid");
  const assertions = Array.from({ length: 16 }, (_, i) => {
    const x = Math.floor(((i % 4) * image.width) / 4);
    const y = Math.floor((Math.floor(i / 4) * image.height) / 4);
    return {
      region: {
        x,
        y,
        width: Math.floor((((i % 4) + 1) * image.width) / 4) - x,
        height: Math.floor(((Math.floor(i / 4) + 1) * image.height) / 4) - y,
      },
    };
  });
  return collectRegionalTone(bytes, assertions, file).flatMap((tile, index) => {
    if (tile.error !== undefined || tile.mean === undefined || !Number.isFinite(tile.mean))
      throw new Error(tile.error ?? "missing tile mean");
    const region = assertions[index]?.region;
    if (region === undefined) throw new Error("missing tile bounds");
    const sums = [0, 0, 0];
    for (let y = region.y; y < region.y + region.height; y++)
      for (let x = region.x; x < region.x + region.width; x++)
        for (let channel = 0; channel < 3; channel++)
          sums[channel] =
            (sums[channel] as number) + (image.data[(y * image.width + x) * 4 + channel] as number);
    return [tile.mean / 255, ...sums.map((sum) => sum / (region.width * region.height * 255))];
  });
}

export function visualParity(
  left: readonly IRunReport[],
  right: readonly IRunReport[],
): IVisualParity[] {
  const waived = (process.env.TN_BENCH_WAIVE ?? "").split(",").includes("visual");
  return Array.from({ length: Math.max(left.length, right.length) }, (_, round) => {
    const from = left[round]?.rungs ?? [];
    const to = right[round]?.rungs ?? [];
    const matches = (a: IRunReport["rungs"][number], b: IRunReport["rungs"][number]): boolean =>
      a.mode === b.mode && a.objectCount === b.objectCount && a.repeat === b.repeat;
    return [
      ...from,
      ...to.filter((rung) => !from.some((candidate) => matches(candidate, rung))),
    ].map((rung) => {
      const source = from.find((candidate) => matches(candidate, rung));
      const other = to.find((candidate) => matches(candidate, rung));
      const result: IVisualParity = {
        key: `${rung.mode}@${rung.objectCount}`,
        repeat: rung.repeat,
        round: round + 1,
        score: null,
        threshold: VISUAL_THRESHOLDS[rung.mode],
        waived,
      };
      try {
        const a = tiles(source?.framePath);
        const b = tiles(other?.framePath);
        result.score = Math.max(...a.map((value, index) => Math.abs(value - (b[index] as number))));
        if (result.score > result.threshold) result.error = "TN_BENCH_VISUAL_PARITY";
      } catch {
        result.error = "TN_BENCH_VISUAL_MISSING";
      }
      return result;
    });
  }).flat();
}

/** Persist the existing screenshot/read-back beside its report; transport pixels never stay in JSON. */
export async function saveFrames(report: IRunReport, jsonFile: string): Promise<void> {
  for (const rung of report.rungs) {
    if (rung.framePng === undefined && rung.frameRgba === undefined) continue;
    const file = `${jsonFile.replace(/\.json$/u, "")}-${rung.mode}-${rung.objectCount}-r${rung.repeat}.png`;
    let bytes: Buffer;
    if (rung.framePng !== undefined) bytes = Buffer.from(rung.framePng, "base64");
    else {
      const frame = rung.frameRgba;
      if (frame === undefined)
        throw new BenchError("TN_BENCH_VISUAL_MISSING", "no frame transport");
      if (
        !Number.isSafeInteger(frame.width) ||
        !Number.isSafeInteger(frame.height) ||
        frame.width < 1 ||
        frame.height < 1 ||
        typeof frame.data !== "string" ||
        frame.data.length !== frame.width * frame.height * 8 ||
        /[^0-9a-f]/u.test(frame.data)
      )
        throw new BenchError("TN_BENCH_VISUAL_MISSING", "invalid frame read-back");
      const image = new PNG({ width: frame.width, height: frame.height });
      image.data = Buffer.from(frame.data, "hex");
      bytes = PNG.sync.write(image);
    }
    try {
      const image = PNG.sync.read(bytes);
      if (image.width > 160 || image.height > 90) throw new Error("frame exceeds 160x90");
    } catch {
      throw new BenchError("TN_BENCH_VISUAL_MISSING", "invalid PNG capture");
    }
    await writeFile(file, bytes);
    rung.framePath = path.resolve(file);
    rung.framePng = undefined;
    rung.frameRgba = undefined;
  }
}
