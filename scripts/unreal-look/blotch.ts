/**
 * Soft blotches on a flat surface, for `pnpm unreal-look:compare --metric blotch` (PRD-641).
 *
 * A grain measure (a pixel against its 9 x 9 box) cannot see a cloud 10 to 40 px across: the box follows
 * the cloud. This measure removes the smooth gradient first. Per region it keeps the display luma of the
 * region's own pixels and takes two bands of it:
 *
 *   grain   the luma minus its Gaussian blur at GRAIN_SIGMA: what is finer than about 5 px.
 *   blotch  the blur at BLOTCH_LOW minus the blur at BLOTCH_HIGH: what is 10 to 45 px across. The
 *           large blur is the gradient, so a lit wall under a window reads as flat, a cloud does not.
 *
 * A least-squares plane through the region is taken off first, so a linear ramp is exactly flat. Both
 * bands are the standard deviation over the region, as a share of the region's mean luma.
 * Every blur is renormalised inside the mask, so a neighbouring region never leaks in. The ratio of the
 * ThreeNative blotch to Unreal's, on the same region of the same pose, is the verdict: PRD-641 holds it
 * within BLOTCH_LIMIT.
 */
import type { IImage } from "./compare.js";

/** Gaussian sigma in px: below it is grain. */
export const GRAIN_SIGMA = 1.5;
/** The blotch band is the blur at BLOTCH_LOW minus the blur at BLOTCH_HIGH. */
export const BLOTCH_LOW = 3;
export const BLOTCH_HIGH = 14;
/** ThreeNative blotch over Unreal's that PRD-641 accepts (the owner's "within 1.2x"). */
export const BLOTCH_LIMIT = 1.2;
/** A band share below this reads as flat: it keeps the ratio finite where Unreal is flat to 8-bit rounding. */
export const BLOTCH_FLOOR = 0.002;
/**
 * Pixels this close to the region's border are left out (two sigma of the large blur): a corner darkens on
 * its own, a shaded frame is anti-aliased there and the ID frame is not. A blotch is an interior fault.
 */
const EDGE = 2 * BLOTCH_HIGH;
const MIN_PIXELS = 1500;

/**
 * The regions `--metric blotch` measures when `--regions` is not given: the walls and the ceiling. They are
 * plain, large and lit by bounce, which is where a blotch shows. A floor carries the sun patch, a sill or a
 * head is thin, and a brick wall or the ground is not a lighting question.
 */
export function isFlatRegion(name: string): boolean {
  return /^(Ceiling|Wall_|Back|Front_|Hall_)/.test(name) && !/Brick|Head|Sill/.test(name);
}

export interface IBlotchBands {
  /** Standard deviation of the grain band over the region's mean luma. */
  grain: number;
  /** Standard deviation of the blotch band over the region's mean luma. */
  blotch: number;
  /** Mean display luma (0 to 255) of the pixels measured. */
  mean: number;
  pixels: number;
}

/** Display luma (0 to 255, gamma encoded) of an 8-bit image: what the viewer sees. */
export function displayLuma(image: IImage): Float32Array {
  const { width, height, channels, data } = image;
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) {
    const at = i * channels;
    out[i] = 0.2126 * (data[at] ?? 0) + 0.7152 * (data[at + 1] ?? 0) + 0.0722 * (data[at + 2] ?? 0);
  }
  return out;
}

/** The Gaussian taps of `sigma`, cut at three sigma and summing to 1. */
function kernel(sigma: number): Float32Array {
  const radius = Math.ceil(3 * sigma);
  const taps = new Float32Array(2 * radius + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma));
    taps[i + radius] = w;
    sum += w;
  }
  return taps.map((w) => w / sum);
}

/** Separable Gaussian blur of a w x h plane. Outside the plane counts as zero. */
function blur(plane: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const taps = kernel(sigma);
  const radius = (taps.length - 1) / 2;
  const across = new Float32Array(plane.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = Math.max(-radius, -x); k <= Math.min(radius, w - 1 - x); k++)
        sum += (plane[y * w + x + k] ?? 0) * (taps[k + radius] ?? 0);
      across[y * w + x] = sum;
    }
  const out = new Float32Array(plane.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = Math.max(-radius, -y); k <= Math.min(radius, h - 1 - y); k++)
        sum += (across[(y + k) * w + x] ?? 0) * (taps[k + radius] ?? 0);
      out[y * w + x] = sum;
    }
  return out;
}

/** Blur of `luma` over the pixels where `weight` is 1 only: the blur of the product over the blur of the weight. */
function smooth(luma: Float32Array, weight: Float32Array, w: number, h: number, sigma: number) {
  const product = luma.map((v, i) => v * (weight[i] ?? 0));
  const top = blur(product, w, h, sigma);
  const bottom = blur(weight, w, h, sigma);
  return top.map((v, i) => v / Math.max(bottom[i] ?? 0, 1e-6));
}

/** The mask shrunk by `edge` px (a pixel stays when every pixel within `edge` px along both axes is in the mask). */
function erode(mask: Uint8Array, w: number, h: number, edge: number): Uint8Array {
  const across = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let all = 1;
      for (let k = -edge; k <= edge && all; k++)
        all = x + k < 0 || x + k >= w ? 0 : (mask[y * w + x + k] ?? 0);
      across[y * w + x] = all;
    }
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let all = 1;
      for (let k = -edge; k <= edge && all; k++)
        all = y + k < 0 || y + k >= h ? 0 : (across[(y + k) * w + x] ?? 0);
      out[y * w + x] = all;
    }
  return out;
}

/** The luma of `crop` with the least-squares plane through its `inside` pixels taken off. */
function withoutPlane(crop: Float32Array, inside: Uint8Array, w: number, h: number): Float32Array {
  // Normal equations of z = a + b x + c y, with x and y centred on the crop.
  const [mx, my] = [(w - 1) / 2, (h - 1) / 2];
  let [n, sx, sy, sxx, sxy, syy, sz, sxz, syz] = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!inside[y * w + x]) continue;
      const [dx, dy, z] = [x - mx, y - my, crop[y * w + x] ?? 0];
      n += 1;
      sx += dx;
      sy += dy;
      sxx += dx * dx;
      sxy += dx * dy;
      syy += dy * dy;
      sz += z;
      sxz += dx * z;
      syz += dy * z;
    }
  const det = (a: number[]) =>
    (a[0] ?? 0) * ((a[4] ?? 0) * (a[8] ?? 0) - (a[5] ?? 0) * (a[7] ?? 0)) -
    (a[1] ?? 0) * ((a[3] ?? 0) * (a[8] ?? 0) - (a[5] ?? 0) * (a[6] ?? 0)) +
    (a[2] ?? 0) * ((a[3] ?? 0) * (a[7] ?? 0) - (a[4] ?? 0) * (a[6] ?? 0));
  const d = det([n, sx, sy, sx, sxx, sxy, sy, sxy, syy]);
  if (Math.abs(d) < 1e-9) return crop;
  // Cramer's rule, one column replaced by the right-hand side at a time.
  const a = det([sz, sx, sy, sxz, sxx, sxy, syz, sxy, syy]) / d;
  const b = det([n, sz, sy, sx, sxz, sxy, sy, syz, syy]) / d;
  const c = det([n, sx, sz, sx, sxx, sxz, sy, sxy, syz]) / d;
  return crop.map((z, i) => z - (a + b * ((i % w) - mx) + c * (Math.floor(i / w) - my)));
}

/**
 * The grain and blotch bands of `luma` inside `mask` (non-zero is in), or undefined when fewer than
 * MIN_PIXELS pixels are left after the border is cut. Only the mask's bounding box, grown by the large
 * blur's reach, is filtered.
 */
export function blotchBands(
  luma: Float32Array,
  width: number,
  height: number,
  mask: ArrayLike<number>,
): IBlotchBands | undefined {
  let [x0, y0, x1, y1] = [width, height, -1, -1];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (mask[y * width + x]) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
  if (x1 < x0) return undefined;
  const reach = Math.ceil(3 * BLOTCH_HIGH);
  const [cx0, cy0] = [Math.max(0, x0 - reach), Math.max(0, y0 - reach)];
  const [w, h] = [Math.min(width, x1 + reach + 1) - cx0, Math.min(height, y1 + reach + 1) - cy0];
  const inside = new Uint8Array(w * h);
  const crop = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const at = (y + cy0) * width + x + cx0;
      crop[y * w + x] = luma[at] ?? 0;
      inside[y * w + x] = mask[at] ? 1 : 0;
    }
  const weight = Float32Array.from(inside);
  const eval_ = erode(inside, w, h, EDGE);
  const flat = withoutPlane(crop, inside, w, h);
  const fine = smooth(flat, weight, w, h, GRAIN_SIGMA);
  const low = smooth(flat, weight, w, h, BLOTCH_LOW);
  const high = smooth(flat, weight, w, h, BLOTCH_HIGH);
  let [n, sum, grain, blotch] = [0, 0, 0, 0];
  for (let i = 0; i < eval_.length; i++) {
    if (!eval_[i]) continue;
    n += 1;
    sum += crop[i] ?? 0;
    const g = (flat[i] ?? 0) - (fine[i] ?? 0);
    const b = (low[i] ?? 0) - (high[i] ?? 0);
    grain += g * g;
    blotch += b * b;
  }
  if (n < MIN_PIXELS || sum <= 0) return undefined;
  const mean = sum / n;
  return {
    grain: Math.sqrt(grain / n) / mean,
    blotch: Math.sqrt(blotch / n) / mean,
    mean,
    pixels: n,
  };
}

export interface IBlotchVerdict {
  /** ThreeNative blotch over Unreal's, each floored at BLOTCH_FLOOR. */
  ratio: number;
  pass: boolean;
}

/** PRD-641: the ThreeNative blotch share is at most BLOTCH_LIMIT times Unreal's. */
export function blotchVerdict(threenative: IBlotchBands, unreal: IBlotchBands): IBlotchVerdict {
  const ratio = Math.max(threenative.blotch, BLOTCH_FLOOR) / Math.max(unreal.blotch, BLOTCH_FLOOR);
  return { ratio, pass: ratio <= BLOTCH_LIMIT };
}
