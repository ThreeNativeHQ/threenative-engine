import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { type IImage, decode, luminance, masks } from "./compare.js";

/**
 * Motion runs of a GI calibration scene (PRD-638): a Level Sequence of 30 frames a second that pans the
 * camera or switches a light, captured as one PNG per frame, `<job>.NNNN.png`, plus a converged still per
 * listed frame, `still-NNNN.0000.png`. This file reads those frames and measures them. Every input that is
 * not what the run declares throws a TN_UNREAL_LOOK_* error: a missing frame, a frame count that differs
 * from the run, a region with too few pixels, a frame of another size.
 */

type Mask = Uint8Array;

export interface IFrameStore {
  /** The file names inside a directory, or an empty list when the directory does not exist. */
  list(dir: string): string[];
  /** The decoded image of `<dir>/<name>`. */
  read(file: string): IImage;
}
export interface IRegionSeries {
  /** Median display luminance of the region in each frame, or null when the frame shows too few pixels. */
  p50: (number | null)[];
  mean: (number | null)[];
  /** Pixels of the region in each frame, after erosion. */
  pixels: number[];
  /** Mean absolute luminance change of the region between the frame before and this one (null for frame 0). */
  diff: (number | null)[];
}
export interface IGhost {
  /** Mean absolute pixel gap to the converged still, over the still's mean level. */
  px: number;
  /** Gap between the region medians, over the still's median. */
  p50: number;
  pixels: number;
}
export interface IRunSeries {
  frames: number;
  regions: Record<string, IRegionSeries>;
  /** Per still frame, per region: null when the region is not in the camera's view in that frame. */
  stills: Record<number, Record<string, IGhost | null>>;
}
export interface IRunOptions {
  /** `pan`, `switch`: the file name stem of the run's frames. */
  job: string;
  /** The number of frames the run declares in scene.json. */
  frames: number;
  /** Directory of the colour frames and of the ID frames inside the store. */
  color: string;
  id: string;
  regions: Record<string, readonly number[]>;
  /** A frame shows a region when its mask holds at least this many pixels. */
  minPixels: number;
  /** A region must be shown in at least this many frames of the run. */
  minFrames: number;
  stills?: readonly number[];
  /** Pixels cut off the edge of every region mask before it is measured. */
  erode?: number;
}
export interface ISwitchOptions {
  /** The first frame without the light. */
  at: number;
  /** The value the region must reach (from another run). The default is this run's own final value. */
  target?: number;
  /** Frames before the switch that define the starting level. */
  lead?: number;
  /** Frames at the end of the run that define the final level. */
  tail?: number;
}
export interface ISwitchResponse {
  before: number;
  after: number;
  target: number;
  /** The switch changes the region by less than the noise floor: lag and settle are not defined. */
  flat: boolean;
  /** Frames after the switch until the region is within 10% of the change from the target; null when never. */
  lag90: number | null;
  /** Frames after the switch until the region stays within 5% of the change from the target; null when never. */
  settle: number | null;
  /** The largest excursion past the target, as a fraction of the change. */
  overshoot: number;
  /** The final level's distance from the target, as a fraction of the change. */
  residual: number;
}
export type IMotionCamera =
  | {
      kind: "pan";
      position: [number, number, number];
      hfovDeg: number;
      pitchDeg?: number;
      headingDeg: [number, number];
      sweepFrames: number;
    }
  | { kind: "pose"; pose: string };
export interface IMotionRun {
  frames: number;
  camera: IMotionCamera;
  /** Frames that are also rendered once, converged, at the pose of that frame. */
  stills?: number[];
  /** The light's intensity is the scene's intensity times `scale`, constant from each key to the next. */
  light?: { name: string; keys: [number, number][] };
  /** The regions the metric reads. The default is every region of the scene. */
  regions?: string[];
}

const REACH = 0.9;
const BAND = 0.05;
const LEAD = 10;
const TAIL = 15;
/** A switch that moves a region by less than this many display levels does not count as a change. */
const FLAT_LEVELS = 2;

function fail(code: string, message: string): never {
  throw new Error(`TN_UNREAL_LOOK_${code}: ${message}`);
}
const pad = (n: number) => String(n).padStart(4, "0");
export const frameFile = (job: string, frame: number) => `${job}.${pad(frame)}.png`;
export const stillJob = (frame: number) => `still-${pad(frame)}`;

export function diskStore(root: string): IFrameStore {
  return {
    list: (dir) => (existsSync(path.join(root, dir)) ? readdirSync(path.join(root, dir)) : []),
    read: (file) => decode(readFileSync(path.join(root, file))),
  };
}

/** Marks the centre of every run of `span` ones along one axis of the mask. */
function runCentres(
  mask: Mask,
  lines: number,
  length: number,
  lineStep: number,
  step: number,
  radius: number,
): Mask {
  const out = new Uint8Array(mask.length);
  for (let line = 0; line < lines; line++) {
    let run = 0;
    for (let i = 0; i < length; i++) {
      const at = line * lineStep + i * step;
      run = mask[at] ? run + 1 : 0;
      if (run >= 2 * radius + 1) out[at - radius * step] = 1;
    }
  }
  return out;
}

/** The pixels whose whole (2r+1) x (2r+1) window is inside the mask and inside the frame. */
export function erodeMask(mask: Mask, width: number, height: number, radius: number): Mask {
  if (!Number.isInteger(radius) || radius < 0) fail("BAD_INPUT", `erosion radius ${radius}`);
  if (mask.length !== width * height) fail("SIZE_MISMATCH", "mask and size differ");
  if (radius === 0) return mask.slice();
  const across = runCentres(mask, height, width, width, 1, radius);
  return runCentres(across, width, height, 1, width, radius);
}

/** Display luminance in byte bins, as measure() rounds it; -1 where the pixel is transparent. */
function lumaOf(image: IImage): Int16Array {
  const out = new Int16Array(image.width * image.height);
  for (let i = 0; i < out.length; i++)
    out[i] = image.data[i * image.channels + 3] === 0 ? -1 : Math.round(luminance(image, i));
  return out;
}
function histogram(luma: Int16Array, mask: Mask) {
  const bins = new Uint32Array(256);
  let count = 0;
  let sum = 0;
  for (let i = 0; i < mask.length; i++) {
    const v = luma[i] as number;
    if (mask[i] && v >= 0) {
      const bin = Math.min(255, v);
      bins[bin] = (bins[bin] ?? 0) + 1;
      count++;
      sum += v;
    }
  }
  return { bins, count, sum };
}
/** The nearest-rank median, the value quantiles() returns for 0.5. */
function median(bins: Uint32Array, count: number): number {
  const rank = Math.max(1, Math.ceil(count * 0.5));
  let seen = 0;
  for (let level = 0; level < 256; level++) {
    seen += bins[level] as number;
    if (seen >= rank) return level;
  }
  return 255;
}
function sameImage(a: IImage, b: IImage): boolean {
  if (a.width !== b.width || a.height !== b.height || a.data.length !== b.data.length) return false;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}

/** Frame numbers of the `<job>.NNNN.png` files in a directory, ascending. */
function framesOf(store: IFrameStore, dir: string, job: string): number[] {
  return store
    .list(dir)
    .flatMap((name) => {
      if (!name.startsWith(`${job}.`) || !name.endsWith(".png")) return [];
      const digits = name.slice(job.length + 1, -".png".length);
      return /^\d{4,}$/.test(digits) ? [Number(digits)] : [];
    })
    .sort((a, b) => a - b);
}
function checkFrames(store: IFrameStore, dir: string, job: string, frames: number) {
  const found = framesOf(store, dir, job);
  const have = new Set(found);
  const last = found.at(-1) ?? -1;
  for (let t = 0; t <= last; t++)
    if (!have.has(t))
      fail(
        "MISSING_FRAME",
        `${dir}/${frameFile(job, t)} is missing (frame ${t} of the ${frames}-frame run ${job})`,
      );
  if (found.length !== frames)
    fail(
      "FRAME_COUNT",
      `${dir} holds ${found.length} frames of run ${job}, the run declares ${frames}`,
    );
}
function checkStill(store: IFrameStore, dir: string, job: string, frame: number) {
  const file = frameFile(stillJob(frame), 0);
  if (!store.list(dir).includes(file))
    fail("MISSING_FRAME", `${dir}/${file} is missing (the still of frame ${frame} of run ${job})`);
}

/** The frames of one run and its stills are all there: nothing missing, nothing extra. */
export function checkRun(
  store: IFrameStore,
  dir: string,
  job: string,
  frames: number,
  stills: readonly number[],
) {
  checkFrames(store, dir, job, frames);
  for (const s of stills) checkStill(store, dir, job, s);
}

function absDiff(a: Int16Array, b: Int16Array, ma: Mask, mb: Mask) {
  let count = 0;
  let sum = 0;
  for (let i = 0; i < ma.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    if (ma[i] && mb[i] && x >= 0 && y >= 0) {
      sum += Math.abs(x - y);
      count++;
    }
  }
  return { count, sum };
}
/** How far the moving frame is from the converged still, inside the mask. */
function ghost(moving: Int16Array, still: Int16Array, mask: Mask): IGhost {
  const gap = absDiff(moving, still, mask, mask);
  const a = histogram(moving, mask);
  const b = histogram(still, mask);
  const n = Math.max(gap.count, 1);
  const level = median(b.bins, b.count);
  return {
    px: gap.sum / n / Math.max(b.sum / Math.max(b.count, 1), 1),
    p50: Math.abs(median(a.bins, a.count) - level) / Math.max(level, 1),
    pixels: gap.count,
  };
}

type Eroded = Record<string, Mask>;
interface ICursor {
  luma: Int16Array;
  eroded: Eroded;
}

/** The eroded region masks of an ID frame. The last frame's are kept: a still camera repeats its ID frame. */
function masker(regions: IRunOptions["regions"], radius: number) {
  let kept: { image: IImage; eroded: Eroded } | null = null;
  return (image: IImage): Eroded => {
    if (kept && sameImage(kept.image, image)) return kept.eroded;
    const found = masks(image, regions);
    const eroded = Object.fromEntries(
      Object.keys(regions).map((name) => [
        name,
        erodeMask(found.regions[name] as Mask, image.width, image.height, radius),
      ]),
    ) as Eroded;
    kept = { image, eroded };
    return eroded;
  };
}

/** Adds one frame to every region's series. */
function addFrame(
  series: Record<string, IRegionSeries>,
  now: ICursor,
  before: ICursor | null,
  minPixels: number,
) {
  for (const [name, mine] of Object.entries(series)) {
    const mask = now.eroded[name] as Mask;
    const here = histogram(now.luma, mask);
    const seen = here.count >= minPixels;
    mine.pixels.push(here.count);
    mine.p50.push(seen ? median(here.bins, here.count) : null);
    mine.mean.push(seen ? here.sum / here.count : null);
    const gap = before ? absDiff(now.luma, before.luma, mask, before.eroded[name] as Mask) : null;
    mine.diff.push(gap && gap.count >= minPixels ? gap.sum / gap.count : null);
  }
}

/**
 * The ghosting of one moving frame against its converged still, per region. A region the moving frame does
 * not show is null; one the still lacks, or shares too few pixels with the moving frame, throws.
 */
function ghostRow(
  now: ICursor,
  still: ICursor,
  minPixels: number,
  where: string,
): Record<string, IGhost | null> {
  const row: Record<string, IGhost | null> = {};
  for (const name of Object.keys(now.eroded)) {
    const moving = now.eroded[name] as Mask;
    const fixed = still.eroded[name] as Mask;
    if (histogram(now.luma, moving).count < minPixels) {
      row[name] = null;
      continue;
    }
    const found = ghost(
      now.luma,
      still.luma,
      moving.map((v, i) => (v && fixed[i] ? 1 : 0)) as Mask,
    );
    if (found.pixels < minPixels)
      fail(
        "EMPTY_MASK",
        `region ${name} has ${found.pixels} pixels in both frames of ${where}, the run needs ${minPixels}`,
      );
    row[name] = found;
  }
  return row;
}

/** Every region is in enough frames, and in at least one still. */
function checkRegions(
  series: Record<string, IRegionSeries>,
  ghosts: IRunSeries["stills"],
  options: IRunOptions,
) {
  const { job, frames, minPixels, minFrames } = options;
  for (const [name, mine] of Object.entries(series)) {
    const shown = mine.p50.filter((v) => v !== null).length;
    if (shown < minFrames || shown === 0)
      fail(
        "EMPTY_MASK",
        `region ${name} has at least ${minPixels} pixels in ${shown} of ${frames} frames, the run needs ${minFrames}`,
      );
    const rows = Object.values(ghosts);
    if (rows.length && rows.every((row) => row[name] === null))
      fail("EMPTY_MASK", `region ${name} is in none of the ${rows.length} stills of run ${job}`);
  }
}

/**
 * The per-frame series of every region of one run, and the ghosting of every still. Throws on a missing
 * frame, a frame count that differs from the run, a frame of another size and a region that too few frames show.
 */
export function runSeries(store: IFrameStore, options: IRunOptions): IRunSeries {
  const { job, frames, color, id, regions, minPixels } = options;
  const stills = options.stills ?? [];
  if (!Number.isInteger(frames) || frames < 2)
    fail("BAD_INPUT", `run ${job} declares ${frames} frames, it needs a whole number of 2 or more`);
  checkRun(store, color, job, frames, stills);
  checkRun(store, id, job, frames, stills);
  const series: Record<string, IRegionSeries> = Object.fromEntries(
    Object.keys(regions).map((name) => [name, { p50: [], mean: [], pixels: [], diff: [] }]),
  );
  const ghosts: IRunSeries["stills"] = {};
  const read = (dir: string, file: string, expect?: IImage) => {
    const image = store.read(`${dir}/${file}`);
    if (expect && (image.width !== expect.width || image.height !== expect.height))
      fail(
        "SIZE_MISMATCH",
        `${dir}/${file} is ${image.width}x${image.height}, the run is ${expect.width}x${expect.height}`,
      );
    return image;
  };
  const movingMasks = masker(regions, options.erode ?? 0);
  const stillMasks = masker(regions, options.erode ?? 0);
  let before: ICursor | null = null;
  let size: IImage | undefined;
  for (let t = 0; t < frames; t++) {
    const file = frameFile(job, t);
    const idImage = read(id, file, size);
    size = idImage;
    const now = { luma: lumaOf(read(color, file, idImage)), eroded: movingMasks(idImage) };
    addFrame(series, now, before, minPixels);
    if (stills.includes(t)) {
      const stillFile = frameFile(stillJob(t), 0);
      const still = {
        luma: lumaOf(read(color, stillFile, idImage)),
        eroded: stillMasks(read(id, stillFile, idImage)),
      };
      ghosts[t] = ghostRow(now, still, minPixels, `${file} and ${id}/${stillFile}`);
    }
    before = now;
  }
  checkRegions(series, ghosts, options);
  return { frames, regions: series, stills: ghosts };
}

function mean(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}
/**
 * Flicker of a region over the frames `from` to `to` (inclusive) of a still camera: the change from each
 * frame to the next, over the region's level. `px` reads every pixel, `p50` reads the region median.
 * `frames` is the number of frame pairs measured.
 */
export function flicker(series: IRegionSeries, from: number, to: number) {
  const length = series.diff.length;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to >= length)
    fail("BAD_INPUT", `flicker window ${from}..${to} is outside the ${length} frames of the run`);
  const px: number[] = [];
  const p50: number[] = [];
  const levelPx: number[] = [];
  const levelP50: number[] = [];
  for (let t = from + 1; t <= to; t++) {
    const d = series.diff[t];
    const [a, b] = [series.p50[t], series.p50[t - 1]];
    const [ma, mb] = [series.mean[t], series.mean[t - 1]];
    if (d == null || a == null || b == null || ma == null || mb == null) continue;
    px.push(d);
    p50.push(Math.abs(a - b));
    levelPx.push((ma + mb) / 2);
    levelP50.push((a + b) / 2);
  }
  if (!px.length)
    fail("EMPTY_MASK", `the region has no measurable frame pair in frames ${from}..${to}`);
  return {
    px: mean(px) / Math.max(mean(levelPx), 1),
    p50: mean(p50) / Math.max(mean(levelP50), 1),
    frames: px.length,
  };
}

function lowMedian(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length / 2) - 1)] as number;
}
/**
 * How a region answers a light that is switched at frame `at`: the frames to 90% of the change from the
 * region's level before the switch to its target, the frames until it stays within 5% of that change, the
 * excursion past the target and the distance it ends from the target. Frames count from the switch.
 */
export function switchResponse(series: IRegionSeries, options: ISwitchOptions): ISwitchResponse {
  const { at, lead = LEAD, tail = TAIL } = options;
  const level = series.p50;
  if (!Number.isInteger(at) || at < lead || level.length - at < tail)
    fail(
      "BAD_INPUT",
      `a switch at frame ${at} needs ${lead} frames before it and ${tail} after it, the run has ${level.length}`,
    );
  const window = level.slice(at - lead);
  const blind = window.findIndex((v) => v === null);
  if (blind >= 0) fail("EMPTY_MASK", `the region has too few pixels in frame ${at - lead + blind}`);
  const values = level as number[];
  const before = lowMedian(values.slice(at - lead, at));
  const after = lowMedian(values.slice(-tail));
  const target = options.target ?? after;
  const change = before - target;
  const size = Math.abs(change);
  const flat = size <= Math.max(FLAT_LEVELS, 0.02 * Math.max(before, target));
  if (flat)
    return { before, after, target, flat, lag90: null, settle: null, overshoot: 0, residual: 0 };
  const run = values.slice(at);
  const within = (v: number, fraction: number) => Math.abs(v - target) <= fraction * size + 1e-9;
  const reached = run.findIndex((v) => within(v, 1 - REACH));
  let settle: number | null = null;
  for (let t = run.length - 1; t >= 0 && within(run[t] as number, BAND); t--) settle = t;
  const past = change > 0 ? target - Math.min(...run) : Math.max(...run) - target;
  return {
    before,
    after,
    target,
    flat,
    lag90: reached >= 0 ? reached : null,
    settle,
    overshoot: Math.max(0, past) / size,
    residual: Math.abs(after - target) / size,
  };
}

const NAME = /^[a-z][a-z0-9-]*$/;
type Bad = (message: string) => never;
interface IMotionScene {
  lights: readonly { name: string }[];
  poses: readonly { name: string }[];
  regions: Record<string, unknown>;
}

function checkPan(camera: Extract<IMotionCamera, { kind: "pan" }>, frames: number, bad: Bad) {
  const finite = (list: readonly number[]) => list.every(Number.isFinite);
  if (camera.position.length !== 3 || !finite(camera.position)) bad("pan position needs 3 numbers");
  if (!(camera.hfovDeg > 0 && camera.hfovDeg < 180))
    bad(`hfovDeg ${camera.hfovDeg} is outside 0..180`);
  const pitch = camera.pitchDeg ?? 0;
  if (!(Math.abs(pitch) < 90)) bad(`pitchDeg ${pitch} is outside -90..90`);
  if (camera.headingDeg.length !== 2 || !finite(camera.headingDeg))
    bad("headingDeg needs 2 numbers");
  if (
    !Number.isInteger(camera.sweepFrames) ||
    camera.sweepFrames < 1 ||
    camera.sweepFrames > frames - 1
  )
    bad(`sweepFrames ${camera.sweepFrames} is outside 1..${frames - 1}`);
}
function checkCamera(camera: IMotionCamera, frames: number, scene: IMotionScene, bad: Bad) {
  if (camera.kind === "pan") checkPan(camera, frames, bad);
  else if (!scene.poses.some((p) => p.name === camera.pose))
    bad(`pose ${camera.pose} is not a pose of the scene`);
}
function checkStills(stills: readonly number[], frames: number, bad: Bad) {
  let previous = -1;
  for (const still of stills) {
    if (!Number.isInteger(still) || still < 0 || still >= frames)
      bad(`still ${still} is outside 0..${frames - 1}`);
    if (still <= previous) bad(`still ${still} is not above the one before`);
    previous = still;
  }
}
function checkLight(
  light: NonNullable<IMotionRun["light"]>,
  frames: number,
  scene: IMotionScene,
  bad: Bad,
) {
  if (!scene.lights.some((l) => l.name === light.name))
    bad(`light ${light.name} is not a light of the scene`);
  if (!light.keys.length || light.keys[0]?.[0] !== 0) bad("the first key must be at frame 0");
  let last = -1;
  for (const [frame, scale] of light.keys) {
    if (!Number.isInteger(frame) || frame < 0 || frame >= frames)
      bad(`key frame ${frame} is outside 0..${frames - 1}`);
    if (frame <= last) bad("key frames must be in ascending order");
    if (!Number.isFinite(scale) || scale < 0) bad(`scale ${scale} must be 0 or more`);
    last = frame;
  }
}

/** The motion record of a scene.json, checked against the scene it belongs to. Throws on the first fault. */
export function validateMotion(motion: Record<string, IMotionRun>, scene: IMotionScene): void {
  for (const [name, run] of Object.entries(motion)) {
    const bad: Bad = (message) => fail("BAD_INPUT", `run ${name}: ${message}`);
    if (!NAME.test(name))
      fail("BAD_INPUT", `run name ${name} must be lowercase letters, digits and dashes`);
    if (!Number.isInteger(run.frames) || run.frames < 2)
      bad(`frames must be a whole number of 2 or more, got ${run.frames}`);
    checkCamera(run.camera, run.frames, scene, bad);
    checkStills(run.stills ?? [], run.frames, bad);
    if (run.light) checkLight(run.light, run.frames, scene, bad);
    for (const region of run.regions ?? [])
      if (!(region in scene.regions)) bad(`region ${region} is not a region of the scene`);
  }
}
