/**
 * Fluvial erosion: the stream-power law with tectonic uplift, solved implicitly in O(n) per step.
 *
 *   dh/dt = U - K * A^m * S          (n = 1 slope exponent, S = steepest-descent slope)
 *
 * Sources:
 * - Braun & Willett 2013, "A very efficient O(n), implicit and parallel method to solve the stream
 *   power equation governing fluvial incision and landscape evolution", Geomorphology 180-181.
 *   The implicit update h_i = (h_i + dt*U + F*h_rec) / (1 + F), F = K*dt*A^m / L, visits nodes
 *   from base level upstream, so it is unconditionally stable and needs no sub-stepping.
 * - Cordonnier et al. 2016, "Large Scale Terrain Generation from Tectonic Uplift and Fluvial
 *   Erosion", Computer Graphics Forum 35(2): an uplift map plus stream power is what turns a rough
 *   envelope into a dendritic drainage network with sharp divides.
 * - Barnes, Lehman & Mulla 2014, "Priority-Flood: An Optimal Depression-Filling and Watershed-
 *   Labeling Algorithm for Digital Elevation Models", Computers & Geosciences 62: fills pits once
 *   so every cell has a strictly lower receiver, which also rules out routing cycles.
 * - Defaults: concavity m/n = 0.45 (Whipple & Tucker 1999, JGR 104; Kirby & Whipple 2012 review),
 *   K ~ 1e-6..1e-5 m^(1-2m)/yr and U ~ 0.1..1 mm/yr for tectonically active ranges.
 */

const DX = Int8Array.of(-1, 0, 1, -1, 1, -1, 0, 1);
const DZ = Int8Array.of(-1, -1, -1, 0, 0, 1, 1, 1);
const DIST = Float64Array.from(DX, (dx, k) => Math.hypot(dx, DZ[k] as number));

/** Smallest rise a filled or routed cell keeps above its receiver, in metres. */
const EPSILON = 1e-3;

/** Priority-Flood with epsilon: raise every pit to its spill height plus a hair, in place. */
export function fillDepressions(h: Float64Array, n: number, epsilon = EPSILON): void {
  const total = n * n;
  const keys = new Float64Array(total);
  const cells = new Int32Array(total);
  const closed = new Uint8Array(total);
  let size = 0;
  const push = (key: number, cell: number): void => {
    let k = size++;
    while (k > 0) {
      const parent = (k - 1) >> 1;
      if ((keys[parent] as number) <= key) break;
      keys[k] = keys[parent] as number;
      cells[k] = cells[parent] as number;
      k = parent;
    }
    keys[k] = key;
    cells[k] = cell;
  };
  const pop = (): number => {
    const top = cells[0] as number;
    size -= 1;
    const key = keys[size] as number;
    const cell = cells[size] as number;
    let k = 0;
    for (;;) {
      let child = 2 * k + 1;
      if (child >= size) break;
      if (child + 1 < size && (keys[child + 1] as number) < (keys[child] as number)) child += 1;
      if ((keys[child] as number) >= key) break;
      keys[k] = keys[child] as number;
      cells[k] = cells[child] as number;
      k = child;
    }
    keys[k] = key;
    cells[k] = cell;
    return top;
  };
  for (let z = 0; z < n; z += 1) {
    for (let x = 0; x < n; x += 1) {
      if (x > 0 && x < n - 1 && z > 0 && z < n - 1) continue;
      const i = z * n + x;
      closed[i] = 1;
      push(h[i] as number, i);
    }
  }
  while (size > 0) {
    const c = pop();
    const cx = c % n;
    const cz = (c - cx) / n;
    const level = h[c] as number;
    for (let k = 0; k < 8; k += 1) {
      const x = cx + (DX[k] as number);
      const z = cz + (DZ[k] as number);
      if (x < 0 || z < 0 || x >= n || z >= n) continue;
      const j = z * n + x;
      if (closed[j]) continue;
      closed[j] = 1;
      if ((h[j] as number) <= level) h[j] = level + epsilon;
      push(h[j] as number, j);
    }
  }
}

export interface IFlow {
  /** Steepest-descent receiver per cell; -1 on the border (base level). */
  readonly receiver: Int32Array;
  /** Every cell, receivers before their donors. */
  readonly order: Int32Array;
  /** Upstream cell count including the cell itself. */
  readonly cells: Float64Array;
}

/** Reusable routing buffers, so a loop of steps allocates once. */
export function createFlow(n: number): IFlow {
  const total = n * n;
  return {
    receiver: new Int32Array(total),
    order: new Int32Array(total),
    cells: new Float64Array(total),
  };
}

/** D8 routing on a surface with no interior pits: receivers, a topological order, upstream counts. */
export function routeFlow(h: ArrayLike<number>, n: number, flow: IFlow): void {
  const { receiver, order, cells } = flow;
  const total = n * n;
  const head = new Int32Array(total).fill(-1);
  const next = new Int32Array(total);
  let roots = 0;
  for (let z = 0; z < n; z += 1) {
    for (let x = 0; x < n; x += 1) {
      const i = z * n + x;
      let best = -1;
      if (x > 0 && x < n - 1 && z > 0 && z < n - 1) {
        const here = h[i] as number;
        let bestSlope = 0;
        for (let k = 0; k < 8; k += 1) {
          const j = i + (DZ[k] as number) * n + (DX[k] as number);
          const slope = (here - (h[j] as number)) / (DIST[k] as number);
          if (slope > bestSlope) {
            bestSlope = slope;
            best = j;
          }
        }
      }
      receiver[i] = best;
      if (best < 0) order[roots++] = i;
      else {
        next[i] = head[best] as number;
        head[best] = i;
      }
    }
  }
  // Breadth-first from the roots: a node always lands after its receiver.
  for (let k = 0; k < total; k += 1) {
    const i = order[k] as number;
    for (let d = head[i] as number; d >= 0; d = next[d] as number) order[roots++] = d;
  }
  cells.fill(1);
  for (let k = total - 1; k >= 0; k -= 1) {
    const i = order[k] as number;
    const r = receiver[i] as number;
    if (r >= 0) cells[r] = (cells[r] as number) + (cells[i] as number);
  }
}

export interface IFluvialOptions {
  iterations?: number;
  /** Rock uplift at the highest point of the input, metres per year; it falls to zero at the lowest. */
  uplift?: number;
  /** Erodibility K, m^(1-2m) per year. */
  erodibility?: number;
  /** Years per step; the implicit solver stays stable at any value. */
  timeStep?: number;
  /** Drainage-area exponent m (slope exponent n is 1), so m is also the profile concavity. */
  concavity?: number;
  /** Landslide threshold in degrees: no cell stays steeper than this above its receiver. */
  talus?: number;
  /** Metres: rescale the result so highest minus lowest equals this, keeping the lowest point. */
  relief?: number;
}

/** Fluvial erosion of `height`: the input is the uplift envelope, the result a dissected landscape. */
export function fluvial(
  height: Float32Array,
  n: number,
  size: number,
  {
    iterations = 40,
    uplift = 1e-3,
    erodibility = 5e-6,
    timeStep = 2e4,
    concavity = 0.45,
    talus = 35,
    relief,
  }: IFluvialOptions = {},
): Float32Array {
  const total = n * n;
  const spacing = size / (n - 1);
  const h = Float64Array.from(height);
  // The border is base level and never erodes, so a border peak would stay the tallest point of
  // the world. Drop it to the lowest ground within a few cells inward: the world drains off every edge.
  const band = Math.min(4, n - 1);
  for (let a = 0; a < n; a += 1)
    for (let d = 1; d <= band; d += 1) {
      h[a] = Math.min(h[a] as number, h[d * n + a] as number); // top edge
      h[(n - 1) * n + a] = Math.min(h[(n - 1) * n + a] as number, h[(n - 1 - d) * n + a] as number);
      h[a * n] = Math.min(h[a * n] as number, h[a * n + d] as number);
      h[a * n + n - 1] = Math.min(h[a * n + n - 1] as number, h[a * n + n - 1 - d] as number);
    }
  fillDepressions(h, n, Math.tan((Number(process.env.FILL_DEG ?? 0.06) * Math.PI) / 180) * spacing);
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < total; i += 1) {
    low = Math.min(low, h[i] as number);
    high = Math.max(high, h[i] as number);
  }
  const range = high - low || 1;
  // Uplift follows the envelope: the massif the earlier layers drew is the part that is rising.
  const rise = Float64Array.from(h, (v) => (uplift * timeStep * (v - low)) / range);
  const flow = createFlow(n);
  const kdt = erodibility * timeStep;
  const maxRise = Math.tan((talus * Math.PI) / 180) * spacing;
  // A^m for every possible upstream count, once: a pow per cell per step would dominate the loop.
  const power = Float64Array.from(
    { length: total + 1 },
    (_, c) => (c * spacing * spacing) ** concavity,
  );
  for (let step = 0; step < iterations; step += 1) {
    routeFlow(h, n, flow);
    const { order, receiver, cells } = flow;
    for (let k = 0; k < total; k += 1) {
      const i = order[k] as number;
      const r = receiver[i] as number;
      if (r < 0) continue;
      const delta = Math.abs(r - i);
      const run = delta === 1 || delta === n ? 1 : Math.SQRT2;
      const factor = (kdt * (power[cells[i] as number] as number)) / (spacing * run);
      const below = h[r] as number;
      const solved = ((h[i] as number) + (rise[i] as number) + factor * below) / (1 + factor);
      // Upstream order means the receiver is final, so the threshold slope can be enforced here.
      // Ending strictly above the receiver keeps the next routing free of pits and cycles.
      h[i] = Math.max(Math.min(solved, below + maxRise * run), below + EPSILON);
    }
  }
  // The border only anchored the solve; copy the ground just inside it so no border cell is a spike.
  for (let a = 0; a < n; a += 1) {
    h[a] = h[n + a] as number;
    h[(n - 1) * n + a] = h[(n - 2) * n + a] as number;
  }
  for (let a = 0; a < n; a += 1) {
    h[a * n] = h[a * n + 1] as number;
    h[a * n + n - 1] = h[a * n + n - 2] as number;
  }
  if (relief !== undefined) {
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const v of h) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    const gain = relief / (hi - lo || 1);
    for (let i = 0; i < total; i += 1) h[i] = lo + ((h[i] as number) - lo) * gain;
  }
  return Float32Array.from(h);
}
