import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { sampleClip } from "../ops/sample.js";
import { encodePng } from "./png.js";

export interface FilmstripOptions {
  readonly clip: string;
  readonly columns?: number;
  readonly file: string;
  readonly fps?: number;
  readonly height?: number;
  readonly output: string;
}

const BACKGROUND = [9, 13, 11] as const;
const BONE = [183, 243, 74] as const;
const FLOOR = [39, 48, 44] as const;

interface Canvas {
  readonly data: Uint8Array;
  readonly height: number;
  readonly width: number;
}

function line(
  canvas: Canvas,
  from: [number, number],
  to: [number, number],
  colour: readonly number[],
): void {
  const [x0, y0] = from;
  const [x1, y1] = to;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
  for (let step = 0; step <= steps; step += 1) {
    const x = Math.round(x0 + ((x1 - x0) * step) / steps);
    const y = Math.round(y0 + ((y1 - y0) * step) / steps);
    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) continue;
    const offset = (canvas.width * y + x) << 2;
    canvas.data[offset] = colour[0] ?? 0;
    canvas.data[offset + 1] = colour[1] ?? 0;
    canvas.data[offset + 2] = colour[2] ?? 0;
    canvas.data[offset + 3] = 255;
  }
}

/**
 * A contact sheet of the motion, drawn from the sampled bones rather than rendered: every frame is
 * a side-on stick figure, one column each, so an agent that cannot watch a clip can still see it.
 * No GPU and no mesh — the point is the pose, not the shading.
 */
export async function writeFilmstrip(
  options: FilmstripOptions,
): Promise<{ readonly bytes: number; readonly columns: number; readonly frames: number }> {
  const samples = await sampleClip(options.file, options.clip, options.fps ?? 30);
  const columns = Math.max(1, options.columns ?? 6);
  const cell = Math.max(48, options.height ?? 160);
  const shown = Math.min(columns, samples.frames.length);
  const step = Math.max(1, Math.floor((samples.frames.length - 1) / Math.max(1, shown - 1)));
  const chosen = Array.from({ length: shown }, (_, index) =>
    Math.min(samples.frames.length - 1, index * step),
  );

  const png: Canvas = {
    data: new Uint8Array(cell * shown * cell * 4),
    height: cell,
    width: cell * shown,
  };
  for (let pixel = 0; pixel < png.width * png.height; pixel += 1) {
    const offset = pixel << 2;
    png.data[offset] = BACKGROUND[0];
    png.data[offset + 1] = BACKGROUND[1];
    png.data[offset + 2] = BACKGROUND[2];
    png.data[offset + 3] = 255;
  }

  // One scale and one origin for the whole strip, so a frame that moves reads as movement.
  const points = chosen.flatMap((index) =>
    samples.bones
      .map((bone) => samples.frames[index]?.positions[bone])
      .filter((value): value is [number, number, number] => value !== undefined),
  );
  const xs = points.map((value) => value[0]);
  const ys = points.map((value) => value[1]);
  const minX = Math.min(...xs, 0);
  const maxX = Math.max(...xs, 1);
  const minY = Math.min(...ys, 0);
  const maxY = Math.max(...ys, 1);
  const span = Math.max(1e-6, Math.max(maxX - minX, maxY - minY));
  const margin = cell * 0.12;
  const project = (x: number, y: number, column: number): [number, number] => [
    Math.round(column * cell + margin + ((x - minX) / span) * (cell - margin * 2)),
    Math.round(cell - margin - ((y - minY) / span) * (cell - margin * 2)),
  ];

  chosen.forEach((frameIndex, column) => {
    const frame = samples.frames[frameIndex];
    if (frame === undefined) return;
    line(png, project(minX, minY, column), project(maxX, minY, column), FLOOR);
    for (const bone of samples.bones) {
      const position = frame.positions[bone];
      if (position === undefined) continue;
      line(png, project(position[0], 0, column), project(position[0], position[1], column), BONE);
    }
  });

  const bytes = encodePng(png.width, png.height, png.data);
  await mkdir(path.dirname(path.resolve(options.output)), { recursive: true });
  await writeFile(options.output, bytes);
  return { bytes: bytes.length, columns: shown, frames: samples.frames.length };
}
