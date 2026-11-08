/**
 * Scree slide — the thermal (talus) kernel of the heightmap-level-generator GPU erosion pass,
 * ported to plain TypeScript over a `Float32Array` height grid.
 *
 * Ported from https://github.com/m-w-marker/heightmap-level-generator at commit
 * 43a525473f6ad070df4c46f34f701587a6059600, file `app/src/erosion.wgsl` (`thermal`), with its
 * uniforms from `app/src/uniforms.js` (`EROSION_FIELDS.talus`, `EROSION_FIELDS.thermal`).
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
 * The algorithm, one Jacobi step per pass: a cell above the scree angle of a neighbour sends it
 * `rate` of the excess, and receives the same from any neighbour above the angle towards it —
 *
 *   dh = Σ over the 8 neighbours of  rate · (max(h_n − h − lim, 0) − max(h − h_n − lim, 0))
 *   lim = tan(talus) · cell · |(dx, dz)|
 *
 * so a pair of cells moves equal mass and the total height is conserved (upstream: "Fluss a→b in a
 * und b gleich gerechnet"). Every cell is computed from the previous snapshot, never from a value
 * this pass already wrote, so the result does not depend on visit order.
 */

const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];
const DISTANCE = Float64Array.from(NEIGHBOURS, ([dx, dz]) => Math.hypot(dx, dz));

/** The recipe limit on `iterations` (`validation.ts`), shared with `thermal` and `fluvial`. */
const MAX_ITERATIONS = 200;

export interface IScreeOptions {
  /** Slide passes (default 200; upstream steps 300 by default, but every erode layer caps at 200). */
  iterations?: number;
  /** Scree angle in degrees; anything steeper sheds (default 35, the angle of loose rock). */
  talus?: number;
  /** Share of the excess a step moves (default 0.05, upstream `thermal`); above 1/16 it oscillates. */
  rate?: number;
}

/**
 * Scree slide: material steeper than the talus angle of its neighbours slides down onto them.
 *
 * Upstream ships `screeAngle: 90` (off) because its erosion is off by default; asking for
 * `method: "scree"` is the opt-in here, so the default is the 35° angle of repose instead.
 */
export function scree(
  height: Float32Array,
  n: number,
  size: number,
  { iterations = 200, talus = 35, rate = 0.05 }: IScreeOptions = {},
): Float32Array {
  if (!Number.isInteger(n) || n < 2)
    throw new RangeError("Scree slide requires grid resolution n >= 2");
  if (!Number.isInteger(iterations) || iterations < 0 || iterations > MAX_ITERATIONS)
    throw new RangeError(`Scree slide iterations must be between 0 and ${MAX_ITERATIONS}`);
  if (!Number.isFinite(talus) || talus < 0 || talus > 89.9)
    throw new RangeError("Scree slide talus must be between 0 and 89.9 degrees");
  if (!Number.isFinite(rate) || rate < 0 || rate > 1)
    throw new RangeError("Scree slide rate must be between 0 and 1");
  const cell = size / (n - 1);
  const limit = Float64Array.from(DISTANCE, (d) => Math.tan((talus * Math.PI) / 180) * cell * d);
  let source = Float64Array.from(height);
  let target = new Float64Array(source.length);
  for (let k = 0; k < iterations; k += 1) {
    for (let z = 0; z < n; z += 1) {
      for (let x = 0; x < n; x += 1) {
        const i = z * n + x;
        const here = source[i] as number;
        let received = 0;
        for (let d = 0; d < 8; d += 1) {
          const nx = x + (NEIGHBOURS[d] as readonly [number, number])[0];
          const nz = z + (NEIGHBOURS[d] as readonly [number, number])[1];
          if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
          const other = source[nz * n + nx] as number;
          const gap = limit[d] as number;
          // Material the neighbour sheds towards this cell, less the material this cell sheds to it.
          if (other - here > gap) received += other - here - gap;
          else if (here - other > gap) received -= here - other - gap;
        }
        // One Jacobi step per pass, as upstream: `b = bTmp + dh`.
        target[i] = here + rate * received;
      }
    }
    const swap = source;
    source = target;
    target = swap;
  }
  return Float32Array.from(source);
}
