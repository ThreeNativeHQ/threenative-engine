/**
 * Gully channels — the rain/gully (virtual-pipe hydraulic) kernels of the heightmap-level-generator
 * GPU erosion pass, ported to plain TypeScript over a `Float32Array` height grid.
 *
 * Ported from https://github.com/m-w-marker/heightmap-level-generator at commit
 * 43a525473f6ad070df4c46f34f701587a6059600, file `app/src/erosion.wgsl` (`fluxStep`, `water`,
 * `erode`, `carry`, `finish`), with its uniforms from `app/src/uniforms.js` (`EROSION_FIELDS`).
 *
 * MIT License — Copyright (c) 2026 Michael Marker
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 * associated documentation files (the "Software"), to deal in the Software without restriction,
 * including without limitation the rights to use, copy, modify, merge, publish, distribute,
 * sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or
 * substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
 * NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * One iteration, as upstream dispatches it (a whole-grid pass each, so every kernel reads the
 * surface the previous one finished):
 *
 * 1. `fluxStep` — virtual pipes (Mei 2007): each cell holds four pipes to its 4-neighbours, and a
 *    pipe carries `fluxKeep` of last step's flow plus the water-surface drop times `pipe`.
 * 2. `water` — water depth gains the net inflow, and speed is the net flow across the cell.
 * 3. `erode` — transport capacity `Kc · sin(slope) · |v| · depthFactor`; below capacity the water
 *    dissolves, above it the load deposits.
 * 4. `carry` — sediment leaves with the same share of the water that leaves, so material cannot
 *    vanish; anything carried past the open edge leaves the map.
 * 5. `finish` — the surface is the eroded terrain plus the load still suspended.
 *
 * Upstream runs its `thermal` kernel after `carry` in the same loop; that pass is `scree()` here, so
 * a recipe wanting upstream's coupled behaviour calls `gully` and then `scree`.
 */

/** Seconds per step (upstream `dt`), a fixed uniform upstream, not a slider. */
const STEP_SECONDS = 0.1;
/** Share of last step's pipe flow a step keeps (upstream `fluxKeep`). */
const FLUX_KEEP = 0.99;
/** Share of the free capacity cut per step (upstream `dissolve`). */
const DISSOLVE = 0.3;
/** Share of the excess load dropped per step (upstream `deposit`); slow, so load reaches the floors. */
const DEPOSIT = 0.02;
/** Evaporation per second (upstream `evaporate`). */
const EVAPORATE = 0.05;
/** Metres: a thinner film carries proportionally less (upstream `depthRef`). */
const DEPTH_REF = 0.01;
/** Metres: deeper water stops cutting, which is what keeps gullies on the slopes (upstream `depthMax`). */
const DEPTH_MAX = 0.3;
/** Sine of the shallowest slope that still carries sediment (upstream `MIN_TILT`). */
const MIN_TILT = 0.05;
/** Gravity: upstream `pipe` is A·g/l with A = l², so g·cell. */
const GRAVITY = 9.81;
/** The recipe limit on `iterations` (`validation.ts`), shared with `thermal` and `fluvial`. */
const MAX_ITERATIONS = 200;

export interface IGullyOptions {
  /** Rain steps (default 200; upstream steps 300 by default, but every erode layer caps at 200). */
  iterations?: number;
  /** Transport capacity Kc (default 0.05, upstream `EROSION_CAPACITY` at 100% strength). */
  capacity?: number;
  /** Metres of rain per step (default 0.0005, upstream `rain`). */
  rain?: number;
}

/** Gully erosion: rain routes off the open edge and cuts channels into anything but a flat. */
export function gully(
  height: Float32Array,
  n: number,
  size: number,
  { iterations = 200, capacity = 0.05, rain = 0.0005 }: IGullyOptions = {},
): Float32Array {
  if (!Number.isInteger(n) || n < 2)
    throw new RangeError("Gully erosion requires grid resolution n >= 2");
  if (!Number.isInteger(iterations) || iterations < 0 || iterations > MAX_ITERATIONS)
    throw new RangeError(`Gully erosion iterations must be between 0 and ${MAX_ITERATIONS}`);
  if (!Number.isFinite(capacity) || capacity < 0 || capacity > 1e6)
    throw new RangeError("Gully erosion capacity must be between 0 and 1000000");
  if (!Number.isFinite(rain) || rain < 0 || rain > 1)
    throw new RangeError("Gully erosion rain must be between 0 and 1 metres per step");
  const total = n * n;
  let h = Float64Array.from(height);
  let hTmp = new Float64Array(total);
  // Per cell: water depth after the step, depth before it, flow speed, the load it carries, and the
  // load the erosion step wrote — upstream's `state` (vec4) and `sedTmp`.
  const water = new Float64Array(total);
  const waterBefore = new Float64Array(total);
  const speed = new Float64Array(total);
  const sediment = new Float64Array(total);
  const sedTmp = new Float64Array(total);
  // Four pipes per cell: −x, +x, −y, +y. Upstream's `flux` vec4, unrolled so a step reads arrays.
  const fluxL = new Float64Array(total);
  const fluxR = new Float64Array(total);
  const fluxT = new Float64Array(total);
  const fluxB = new Float64Array(total);
  const cell = size / (n - 1);
  const cellArea = cell * cell;
  // Upstream `pipe`: A·g/l with A = l², so g·l; a pipe gains that times the surface drop per second.
  const gain = STEP_SECONDS * GRAVITY * cell;
  const evaporateKeep = Math.max(1 - EVAPORATE * STEP_SECONDS, 0);
  /** Share of a cell's water that leaves over one pipe, at most 1 by the flux scaling above. */
  const share = (flow: number, depth: number): number =>
    depth > 0 ? (flow * STEP_SECONDS) / (depth * cellArea) : 0;
  for (let step = 0; step < iterations; step += 1) {
    for (let z = 0; z < n; z += 1) {
      for (let x = 0; x < n; x += 1) {
        const i = z * n + x;
        const depth = (water[i] as number) + rain;
        const surface = (h[i] as number) + depth;
        // Outside the grid reads the cell's own terrain: dry ground at the same height, an open edge.
        const ground = h[i] as number;
        const left = x > 0 ? (h[i - 1] as number) + (water[i - 1] as number) + rain : ground;
        const right = x < n - 1 ? (h[i + 1] as number) + (water[i + 1] as number) + rain : ground;
        const top = z > 0 ? (h[i - n] as number) + (water[i - n] as number) + rain : ground;
        const bottom = z < n - 1 ? (h[i + n] as number) + (water[i + n] as number) + rain : ground;
        let l = (fluxL[i] as number) * FLUX_KEEP + gain * (surface - left);
        let r = (fluxR[i] as number) * FLUX_KEEP + gain * (surface - right);
        let t = (fluxT[i] as number) * FLUX_KEEP + gain * (surface - top);
        let b = (fluxB[i] as number) * FLUX_KEEP + gain * (surface - bottom);
        if (l < 0) l = 0;
        if (r < 0) r = 0;
        if (t < 0) t = 0;
        if (b < 0) b = 0;
        // A cell never gives away more water than it holds, so every pipe share stays at or below 1.
        const sum = l + r + t + b;
        if (sum > 0) {
          const keep = Math.min(1, (depth * cellArea) / (sum * STEP_SECONDS));
          l *= keep;
          r *= keep;
          t *= keep;
          b *= keep;
        }
        fluxL[i] = l;
        fluxR[i] = r;
        fluxT[i] = t;
        fluxB[i] = b;
      }
    }
    for (let z = 0; z < n; z += 1) {
      for (let x = 0; x < n; x += 1) {
        const i = z * n + x;
        const inL = x > 0 ? (fluxR[i - 1] as number) : 0;
        const inR = x < n - 1 ? (fluxL[i + 1] as number) : 0;
        const inT = z > 0 ? (fluxB[i - n] as number) : 0;
        const inB = z < n - 1 ? (fluxT[i + n] as number) : 0;
        const before = (water[i] as number) + rain;
        const after = Math.max(
          0,
          before +
            (STEP_SECONDS *
              (inL +
                inR +
                inT +
                inB -
                (fluxL[i] as number) -
                (fluxR[i] as number) -
                (fluxT[i] as number) -
                (fluxB[i] as number))) /
              cellArea,
        );
        const depth = 0.5 * (before + after);
        const acrossX = inL - (fluxL[i] as number) + (fluxR[i] as number) - inR;
        const acrossZ = inT - (fluxT[i] as number) + (fluxB[i] as number) - inB;
        speed[i] =
          depth > 1e-4
            ? (Math.sqrt(acrossX * acrossX + acrossZ * acrossZ) * 0.5) / (cell * depth)
            : 0;
        water[i] = after;
        waterBefore[i] = before;
      }
    }
    for (let z = 0; z < n; z += 1) {
      for (let x = 0; x < n; x += 1) {
        const i = z * n + x;
        const gx =
          ((h[z * n + Math.min(x + 1, n - 1)] as number) -
            (h[z * n + Math.max(x - 1, 0)] as number)) /
          (2 * cell);
        const gy =
          ((h[Math.min(z + 1, n - 1) * n + x] as number) -
            (h[Math.max(z - 1, 0) * n + x] as number)) /
          (2 * cell);
        const squared = gx * gx + gy * gy;
        const sine = Math.max(Math.sqrt(squared / (1 + squared)), MIN_TILT);
        const depth = water[i] as number;
        const transport =
          capacity *
          sine *
          (speed[i] as number) *
          Math.min(depth / DEPTH_REF, 1) *
          Math.max(1 - depth / DEPTH_MAX, 0);
        let surface = h[i] as number;
        let load = sediment[i] as number;
        if (transport > load) {
          const cut = DISSOLVE * (transport - load);
          surface -= cut;
          load += cut;
        } else {
          const drop = DEPOSIT * (load - transport);
          surface += drop;
          load -= drop;
        }
        hTmp[i] = surface;
        sedTmp[i] = load;
      }
    }
    // Upstream commits `bTmp` into `b` in its thermal kernel; without it, the next step's pipes
    // would read a surface no erosion reached. The two arrays swap, so the commit costs nothing.
    const passed = h;
    h = hTmp;
    hTmp = passed;
    for (let z = 0; z < n; z += 1) {
      for (let x = 0; x < n; x += 1) {
        const i = z * n + x;
        let load =
          (sedTmp[i] as number) *
          (1 -
            share(
              (fluxL[i] as number) +
                (fluxR[i] as number) +
                (fluxT[i] as number) +
                (fluxB[i] as number),
              waterBefore[i] as number,
            ));
        if (x > 0)
          load +=
            (sedTmp[i - 1] as number) * share(fluxR[i - 1] as number, waterBefore[i - 1] as number);
        if (x < n - 1)
          load +=
            (sedTmp[i + 1] as number) * share(fluxL[i + 1] as number, waterBefore[i + 1] as number);
        if (z > 0)
          load +=
            (sedTmp[i - n] as number) * share(fluxB[i - n] as number, waterBefore[i - n] as number);
        if (z < n - 1)
          load +=
            (sedTmp[i + n] as number) * share(fluxT[i + n] as number, waterBefore[i + n] as number);
        sediment[i] = load;
        water[i] = (water[i] as number) * evaporateKeep;
      }
    }
  }
  // Upstream `finish`: the load still in suspension settles where the run ended.
  return Float32Array.from(h, (surface, i) => surface + (sediment[i] as number));
}
