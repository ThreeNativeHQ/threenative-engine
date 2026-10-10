import { clamp, lerp, random } from "./math.js";
import type { IErosionMaps } from "./types.js";

export interface IThermalOptions {
  iterations?: number;
  /** Maximum stable slope in degrees. */
  talus?: number;
  rate?: number;
}

export interface IHydraulicOptions {
  droplets?: number;
  maxSteps?: number;
  inertia?: number;
  capacity?: number;
  erosion?: number;
  deposition?: number;
  evaporation?: number;
  seed?: number;
  /** Brush radius in cells: every gram moved lands spread over this disc, never on one cell. */
  brushRadius?: number;
}

/** Thermal erosion: material above the talus angle slides to its lowest neighbour. */
export function thermal(
  height: Float32Array,
  n: number,
  size: number,
  { iterations = 20, talus = 32, rate = 0.22 }: IThermalOptions = {},
  observations?: IErosionMaps,
): Float32Array {
  if (!Number.isInteger(n) || n < 2)
    throw RangeError("Thermal erosion requires grid resolution n >= 2");
  if (!Number.isInteger(iterations) || iterations < 0 || iterations > 200)
    throw RangeError("Thermal erosion iterations must be between 0 and 200");
  const h = height.slice();
  const delta = new Float64Array(h.length);
  const limit = Math.tan((talus * Math.PI) / 180) * (size / (n - 1));
  for (let k = 0; k < iterations; k += 1) {
    delta.fill(0);
    for (let z = 0; z < n; z += 1) {
      for (let x = 0; x < n; x += 1) {
        const i = z * n + x;
        const here = h[i] as number;
        let best = -1;
        let diff = limit;
        // The same four neighbours in the same order, without the per-cell array.
        if (x > 0 && here - (h[i - 1] as number) > diff) {
          diff = here - (h[i - 1] as number);
          best = i - 1;
        }
        if (x < n - 1 && here - (h[i + 1] as number) > diff) {
          diff = here - (h[i + 1] as number);
          best = i + 1;
        }
        if (z > 0 && here - (h[i - n] as number) > diff) {
          diff = here - (h[i - n] as number);
          best = i - n;
        }
        if (z < n - 1 && here - (h[i + n] as number) > diff) {
          diff = here - (h[i + n] as number);
          best = i + n;
        }
        if (best >= 0) {
          const transfer = (diff - limit) * rate;
          delta[i] = (delta[i] as number) - transfer;
          delta[best] = (delta[best] as number) + transfer;
          if (observations)
            observations.talus[best] = (observations.talus[best] as number) + transfer;
        }
      }
    }
    for (let i = 0; i < h.length; i += 1) h[i] = (h[i] as number) + (delta[i] as number);
  }
  return h;
}

interface IBrush {
  readonly dx: Int32Array;
  readonly dz: Int32Array;
  readonly weight: Float64Array;
  /** Sum of every normalised weight: the total for a brush fully inside the field. */
  readonly full: number;
  /** Largest offset on either axis, so a brush this far from an edge is fully inside. */
  readonly radius: number;
}

const brushes = new Map<number, IBrush>();

/** Erosion brush: normalised weights over a disc, so a droplet digs a dimple and not a single-cell pit. */
function brush(radius: number): IBrush {
  let cells = brushes.get(radius);
  if (!cells) {
    const dx: number[] = [];
    const dz: number[] = [];
    const raw: number[] = [];
    let total = 0;
    for (let z = -radius; z <= radius; z += 1) {
      for (let x = -radius; x <= radius; x += 1) {
        const d = Math.hypot(x, z);
        if (d > radius) continue;
        const weight = 1 - d / (radius + 1);
        dx.push(x);
        dz.push(z);
        raw.push(weight);
        total += weight;
      }
    }
    const weight = Float64Array.from(raw, (w) => w / total);
    let full = 0;
    for (let k = 0; k < weight.length; k += 1) full += weight[k] as number;
    cells = { dx: Int32Array.from(dx), dz: Int32Array.from(dz), full, radius, weight };
    brushes.set(radius, cells);
  }
  return cells;
}

interface IHydraulicProbe {
  value: number;
  dx: number;
  dz: number;
  ix: number;
  iz: number;
}

/** The largest supported grid resolution (`validation.ts` RESOLUTIONS): bounds the automatic default. */
const MAX_AUTOMATIC_DROPLETS = 1025 * 1025;
/** The explicit recipe limit on `droplets` (`validation.ts`), so a direct call cannot exceed it. */
const MAX_EXPLICIT_DROPLETS = 200_000;

/** Hydraulic erosion: seeded droplets carry sediment downhill, depositing where they slow. */
export function hydraulic(
  height: Float32Array,
  n: number,
  size: number,
  options: IHydraulicOptions = {},
  observations?: IErosionMaps,
): Float32Array {
  const {
    droplets: requestedDroplets,
    // A droplet has to be able to cross the world, so its step budget scales with the grid: a
    // fixed 40 barely leaves a 257 world while a 65 world would walk off it in a few steps.
    maxSteps = Math.round(Math.min(64, Math.max(24, n / 4))),
    inertia = 0.2,
    capacity = 4,
    // Each step takes a small bite of the sediment the droplet can carry. A big bite carves
    // fewer, deeper dimples that stand proud of their neighbours as spikes; many shallow bites
    // over the same lines incise the same drainage with a smooth surface.
    erosion = 0.03,
    deposition = 0.3,
    evaporation = 0.025,
    seed = 1,
    brushRadius = 3,
  } = options;
  if (!Number.isInteger(n) || n < 2)
    throw RangeError("Hydraulic erosion requires grid resolution n >= 2");
  // Roughly one droplet per cell. Incision saturates near here: more droplets keep cutting the
  // same drainage lines over, which deepens nothing and spends the bake time. A caller that
  // supplies a count is held to the recipe limit; the automatic default is bounded by the largest
  // supported grid, so leaving it out cannot request unbounded work.
  const droplets =
    requestedDroplets === undefined ? Math.min(n * n, MAX_AUTOMATIC_DROPLETS) : requestedDroplets;
  if (!Number.isSafeInteger(droplets) || droplets < 0)
    throw RangeError("Hydraulic erosion droplets must be a non-negative integer");
  if (requestedDroplets !== undefined && droplets > MAX_EXPLICIT_DROPLETS)
    throw RangeError(`Hydraulic erosion droplets must not exceed ${String(MAX_EXPLICIT_DROPLETS)}`);
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 128)
    throw RangeError("Hydraulic erosion maxSteps must be between 1 and 128");
  const h = Float64Array.from(height);
  const rnd = random(seed);
  const cell = size / (n - 1);
  const brushCells = brush(brushRadius);
  const brushDx = brushCells.dx;
  const brushDz = brushCells.dz;
  const brushWeight = brushCells.weight;
  const brushCount = brushDx.length;
  const brushFull = brushCells.full;
  const brushEdge = brushCells.radius;
  // The flat index offset `dz * n + dx` per brush cell for this grid. The interior loop adds it to
  // the centre index instead of multiplying two coordinates for every cell; integer-only, exact.
  const brushOffset = new Int32Array(brushCount);
  for (let k = 0; k < brushCount; k += 1)
    brushOffset[k] = (brushDz[k] as number) * n + (brushDx[k] as number);
  /** Adds `amount` over the brush around one cell, renormalised where the field ends. */
  const spread = (
    x: number,
    z: number,
    amount: number,
    floor = Number.NEGATIVE_INFINITY,
  ): number => {
    // A brush fully inside the field sums every weight; only a brush at the edge needs the
    // partial total, which the first pass computes in the same order as `full`.
    const interior = x >= brushEdge && x < n - brushEdge && z >= brushEdge && z < n - brushEdge;
    // Interior brushes cover the field bulk: no edge total scan, no bounds branch and no per-cell
    // `z * n + x` multiply. Same brush order, same weights and same arithmetic as the shared tail.
    if (interior) {
      const total = brushFull;
      if (total <= 0) return 0;
      let moved = 0;
      const base = z * n + x;
      const negative = amount < 0;
      const depositing = observations !== undefined && amount > 0;
      for (let k = 0; k < brushCount; k += 1) {
        const i = base + (brushOffset[k] as number);
        const share = (amount * (brushWeight[k] as number)) / total;
        // A brush cell below the downstream bed has no soil the droplet can pick up. Taking it
        // anyway digs pits deeper than the channel and leaves unsupported pillars between paths.
        const change = negative ? -Math.min(-share, Math.max(0, (h[i] as number) - floor)) : share;
        h[i] = (h[i] as number) + change;
        moved += change;
        if (depositing)
          (observations as IErosionMaps).deposition[i] =
            ((observations as IErosionMaps).deposition[i] as number) +
            (amount * (brushWeight[k] as number)) / total;
      }
      return moved;
    }
    let total = 0;
    for (let k = 0; k < brushCount; k += 1) {
      const ix = x + (brushDx[k] as number);
      const iz = z + (brushDz[k] as number);
      if (ix >= 0 && ix < n && iz >= 0 && iz < n) total += brushWeight[k] as number;
    }
    if (total <= 0) return 0;
    let moved = 0;
    const negative = amount < 0;
    const depositing = observations !== undefined && amount > 0;
    for (let k = 0; k < brushCount; k += 1) {
      const ix = x + (brushDx[k] as number);
      const iz = z + (brushDz[k] as number);
      if (ix < 0 || ix >= n || iz < 0 || iz >= n) continue;
      const i = iz * n + ix;
      const share = (amount * (brushWeight[k] as number)) / total;
      // A brush cell below the downstream bed has no soil the droplet can pick up. Taking it
      // anyway digs pits deeper than the channel and leaves unsupported pillars between paths.
      const change = negative ? -Math.min(-share, Math.max(0, (h[i] as number) - floor)) : share;
      h[i] = (h[i] as number) + change;
      moved += change;
      if (depositing)
        (observations as IErosionMaps).deposition[i] =
          ((observations as IErosionMaps).deposition[i] as number) +
          (amount * (brushWeight[k] as number)) / total;
    }
    return moved;
  };
  // Two reusable probes: `get` fills one instead of allocating a fresh object twice per step.
  const probeOld: IHydraulicProbe = { value: 0, dx: 0, dz: 0, ix: 0, iz: 0 };
  const probeNext: IHydraulicProbe = { value: 0, dx: 0, dz: 0, ix: 0, iz: 0 };
  const get = (x: number, z: number, out: IHydraulicProbe): IHydraulicProbe => {
    const ix = Math.min(n - 2, Math.floor(x));
    const iz = Math.min(n - 2, Math.floor(z));
    const tx = x - ix;
    const tz = z - iz;
    const i = iz * n + ix;
    out.value = lerp(
      lerp(h[i] as number, h[i + 1] as number, tx),
      lerp(h[i + n] as number, h[i + n + 1] as number, tx),
      tz,
    );
    out.dx =
      lerp(
        (h[i + 1] as number) - (h[i] as number),
        (h[i + n + 1] as number) - (h[i + n] as number),
        tz,
      ) / cell;
    out.dz =
      lerp(
        (h[i + n] as number) - (h[i] as number),
        (h[i + n + 1] as number) - (h[i + 1] as number),
        tx,
      ) / cell;
    out.ix = ix;
    out.iz = iz;
    return out;
  };
  for (let k = 0; k < droplets; k += 1) {
    let x = rnd() * (n - 1 - 0.001);
    let z = rnd() * (n - 1 - 0.001);
    let dx = 0;
    let dz = 0;
    let water = 1;
    let speed = 1;
    let sediment = 0;
    for (let step = 0; step < maxSteps; step += 1) {
      const old = get(x, z, probeOld);
      if (observations) {
        const tx = x - old.ix;
        const tz = z - old.iz;
        const i = old.iz * n + old.ix;
        for (let oz = 0; oz < 2; oz++) {
          for (let ox = 0; ox < 2; ox++) {
            const index = i + oz * n + ox;
            const weight = (ox ? tx : 1 - tx) * (oz ? tz : 1 - tz);
            observations.flow[index] = (observations.flow[index] as number) + water * weight;
            observations.sediment[index] =
              (observations.sediment[index] as number) + sediment * weight;
          }
        }
      }
      dx = dx * inertia - old.dx * (1 - inertia);
      dz = dz * inertia - old.dz * (1 - inertia);
      let length = Math.hypot(dx, dz);
      if (length < 1e-9) {
        const angle = rnd() * Math.PI * 2;
        dx = Math.cos(angle);
        dz = Math.sin(angle);
        length = 1;
      }
      dx /= length;
      dz /= length;
      const nx = x + dx;
      const nz = z + dz;
      if (nx < 0 || nx >= n - 1 || nz < 0 || nz >= n - 1) {
        sediment = 0;
        break;
      }
      const next = get(nx, nz, probeNext);
      const dh = next.value - old.value;
      const cap = Math.max(-dh, 0.005 * cell) * speed * water * capacity;
      if (dh > 0 || sediment > cap) {
        const amount = dh > 0 ? Math.min(dh, sediment) : (sediment - cap) * deposition;
        spread(old.ix, old.iz, amount);
        sediment -= amount;
      } else {
        const amount = Math.max(0, Math.min((cap - sediment) * erosion, -dh));
        sediment -= spread(old.ix, old.iz, -amount, next.value);
      }
      speed = Math.sqrt(Math.max(0.01, speed * speed - dh * 3));
      water *= 1 - evaporation;
      x = nx;
      z = nz;
      if (water < 0.02) break;
    }
    // A live droplet at the integration cutoff is still carrying its load. Dumping that entire
    // load here builds artificial sediment pillars; only evaporation settles the remainder.
    if (sediment > 0 && water < 0.02) {
      const end = get(clamp(x, 0, n - 1.001), clamp(z, 0, n - 1.001), probeOld);
      spread(end.ix, end.iz, sediment);
    }
  }
  return Float32Array.from(h);
}
