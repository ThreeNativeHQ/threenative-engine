/**
 * Shadow-edge width on the floor, for `pnpm unreal-look:compare --metric penumbra` (PRD-634).
 *
 * Every 8th pixel row is cut into runs of floor pixels. In each run the sharpest lit-to-shadow step
 * is found by comparing the mean luminance 8 to 28 px either side; the width is the distance
 * between the 10 % and 90 % crossings of that step, on linear luminance. A row cut is not
 * perpendicular to the edge, so the width includes 1 / cos(edge angle). Both arms share the pose,
 * so the ratio between arms is the comparison. A step weaker than 35 % of the brighter side is not
 * a shadow edge and is skipped.
 */
export interface IEdge {
  row: number;
  x: number;
  width: number;
}

const WINDOW = 28;
const GAP = 8;
const MIN_STEP = 0.35;
const ROW_STEP = 8;
const MIN_RUN = 70;
// An edge wider than this is a surface boundary or a gradient, not a penumbra.
const MAX_WIDTH = 12;

const srgbToLinear = (v: number): number =>
  v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;

/** Linear luminance of an 8-bit sRGB RGBA image. */
export function linearLuminance(rgba: ArrayLike<number>, pixels: number): Float64Array {
  const out = new Float64Array(pixels);
  for (let i = 0; i < pixels; i++) {
    const [r, g, b] = [0, 1, 2].map((c) => srgbToLinear((rgba[i * 4 + c] ?? 0) / 255));
    out[i] = 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
  }
  return out;
}

const mean = (a: ArrayLike<number>, from: number, to: number): number => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += a[i] ?? 0;
  return sum / (to - from);
};

const median = (a: ArrayLike<number>, from: number, to: number): number =>
  [...Array.from(a).slice(from, to)].sort((x, y) => x - y)[Math.floor((to - from) / 2)] ?? 0;

function runEdge(segment: Float64Array): { at: number; width: number } | undefined {
  if (segment.length < MIN_RUN) return undefined;
  const smooth = segment.map((_, i) =>
    mean(segment, Math.max(0, i - 1), Math.min(segment.length, i + 2)),
  );
  let best = 0;
  let at = -1;
  for (let i = WINDOW; i < segment.length - WINDOW; i++) {
    const left = mean(smooth, i - WINDOW, i - GAP);
    const right = mean(smooth, i + GAP, i + WINDOW);
    const step = Math.abs(right - left) / Math.max(left, right, 1e-6);
    if (step > best) {
      best = step;
      at = i;
    }
  }
  if (at < 0 || best < MIN_STEP) return undefined;
  const left = median(segment, at - WINDOW, at - GAP);
  const right = median(segment, at + GAP, at + WINDOW);
  if (left === right) return undefined;
  const t = (i: number) => ((segment[i] ?? 0) - left) / (right - left);
  const cross = (level: number): number | undefined => {
    let found: number | undefined;
    for (let i = at - WINDOW; i < at + WINDOW - 1; i++) {
      const a = t(i);
      const b = t(i + 1);
      if (
        a < level &&
        b >= level &&
        (found === undefined || Math.abs(i - at) < Math.abs(found - at))
      )
        found = i + (level - a) / (b - a);
    }
    return found;
  };
  const lo = cross(0.1);
  const hi = cross(0.9);
  if (lo === undefined || hi === undefined) return undefined;
  return { at, width: hi - lo };
}

/** Shadow edges across the floor mask, one candidate per run per sampled row. */
export function floorEdges(
  lum: Float64Array,
  width: number,
  height: number,
  floor: ArrayLike<number>,
): IEdge[] {
  const edges: IEdge[] = [];
  for (let row = 0; row < height; row += ROW_STEP) {
    let x = 0;
    while (x < width) {
      if (!floor[row * width + x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < width && floor[row * width + x]) x++;
      const found = runEdge(lum.slice(row * width + start, row * width + x));
      if (found && found.width < MAX_WIDTH)
        edges.push({ row, x: start + found.at, width: found.width });
    }
  }
  return edges;
}

/** Edges both arms found on the same row within `tolerance` px of each other: their median widths. */
export function matchedWidths(
  unreal: readonly IEdge[],
  other: readonly IEdge[],
  tolerance = 14,
): { matched: number; unreal: number; other: number } {
  const a: number[] = [];
  const b: number[] = [];
  for (const edge of unreal) {
    const twin = other.find((o) => o.row === edge.row && Math.abs(o.x - edge.x) <= tolerance);
    if (!twin) continue;
    a.push(edge.width);
    b.push(twin.width);
  }
  const mid = (v: number[]) => [...v].sort((x, y) => x - y)[Math.floor(v.length / 2)] ?? Number.NaN;
  return { matched: a.length, unreal: mid(a), other: mid(b) };
}
