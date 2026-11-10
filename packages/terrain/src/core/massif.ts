import { clamp, random, sampleGrid, smoothstep } from "./math.js";
import type { Terrain } from "./terrain.js";

/** A whole mountain cut from a survey, foot to foot: row-major, north row first, +X east. */
export interface IMassifTile {
  readonly id: string;
  /** Side of the square in metres. */
  readonly size: number;
  /** Vertices per side. */
  readonly resolution: number;
  readonly heights: ArrayLike<number>;
}

export interface IPlaceMassifOptions {
  /** Picks the tile from a list, the pose, the mirror and the height. One seed is one mountain. */
  readonly seed: number;
  readonly tile: IMassifTile | readonly IMassifTile[];
  /** World x and z of the summit. Default: a seeded point on `bearing` and `distance`. */
  readonly at?: readonly [number, number];
  /** Degrees from +X toward +Z the summit may stand on. Default: all round. */
  readonly bearing?: readonly [number, number];
  /** Metres from the world centre to the summit. Default: from half the tile to the world edge. */
  readonly distance?: readonly [number, number];
  /** Summit height above the ground it stands on, in metres. Default: the tile's own, x 0.85 to 1.15. */
  readonly height?: readonly [number, number];
  /** Summit elevation in world metres; wins over `height`, so a world's relief stays bounded. */
  readonly top?: readonly [number, number];
  /** Half side of the centre square the massif leaves untouched (the playable ground). Default 320. */
  readonly keepOut?: number;
  /** Layer id. Default `massif`. */
  readonly id?: string;
}

/** Where the seed stood the mountain, and its heights at the tile's own spacing for relief maps. */
export interface IMassifPlacement {
  readonly tile: string;
  readonly at: readonly [number, number];
  /** Degrees the tile turned, counter-clockwise from +X toward +Z. */
  readonly rotation: number;
  readonly mirror: boolean;
  /** Summit height above its ground, in metres. */
  readonly height: number;
  /** World-aligned final heights over the footprint at the tile's spacing, clipped to the world. */
  readonly detail: {
    readonly origin: readonly [number, number];
    readonly spacing: number;
    readonly columns: number;
    readonly rows: number;
    readonly heights: Float32Array;
  };
}

/**
 * Edge-smoothed transfinite base through a grid's border: exact on the border, smooth inside.
 * The border is low-passed around its closed loop for the bilinear blend, and the high-frequency
 * remainder decays inward over `decay` cells, so a boulder on the edge is not dragged across the tile.
 */
function perimeterBase(n: number, edge: (i: number) => number, window: number, decay: number) {
  // The closed loop: top (row 0) west to east, right north to south, bottom east to west, left south to north.
  const loop = 4 * (n - 1);
  const at = (k: number): [number, number] => {
    const m = ((k % loop) + loop) % loop;
    const side = Math.floor(m / (n - 1));
    const t = m % (n - 1);
    return side === 0
      ? [0, t]
      : side === 1
        ? [t, n - 1]
        : side === 2
          ? [n - 1, n - 1 - t]
          : [n - 1 - t, 0];
  };
  const raw = Float64Array.from({ length: loop }, (_, k) => {
    const [row, column] = at(k);
    return edge(row * n + column);
  });
  // Box low-pass via a prefix sum over the closed loop.
  const prefix = new Float64Array(3 * loop + 1);
  for (let k = 0; k < 3 * loop; k++)
    prefix[k + 1] = (prefix[k] as number) + (raw[k % loop] as number);
  const half = Math.max(1, Math.round(window / 2));
  const smooth = Float64Array.from(
    { length: loop },
    (_, k) =>
      ((prefix[loop + k + half + 1] as number) - (prefix[loop + k - half] as number)) /
      (2 * half + 1),
  );
  const index = (row: number, column: number) => {
    if (row === 0) return column;
    if (column === n - 1) return n - 1 + row;
    if (row === n - 1) return 2 * (n - 1) + (n - 1 - column);
    return 3 * (n - 1) + (n - 1 - row);
  };
  const s = (row: number, column: number) => smooth[index(row, column) % loop] as number;
  const r = (row: number, column: number) =>
    (raw[index(row, column) % loop] as number) - (smooth[index(row, column) % loop] as number);
  const base = new Float32Array(n * n);
  const last = n - 1;
  for (let row = 0; row < n; row++) {
    const v = row / last;
    for (let column = 0; column < n; column++) {
      const u = column / last;
      // Coons patch of the smoothed loop.
      const coons =
        (1 - v) * s(0, column) +
        v * s(last, column) +
        (1 - u) * s(row, 0) +
        u * s(row, last) -
        ((1 - u) * (1 - v) * s(0, 0) +
          u * (1 - v) * s(0, last) +
          (1 - u) * v * s(last, 0) +
          u * v * s(last, last));
      const detail =
        r(0, column) * Math.exp(-row / decay) +
        r(last, column) * Math.exp(-(last - row) / decay) +
        r(row, 0) * Math.exp(-column / decay) +
        r(row, last) * Math.exp(-(last - column) / decay);
      base[row * n + column] = coons + detail;
    }
  }
  // Exact on the border.
  for (let k = 0; k < loop; k++) {
    const [row, column] = at(k);
    base[row * n + column] = raw[k] as number;
  }
  return base;
}

/**
 * A tile's mountain above its own foot: the heights minus a smooth surface through its border, so
 * its edge is exactly zero and stands on any ground with no wall or ramp. Signed: a valley inside
 * the mountain cuts below the foot, as it does in the survey.
 * @requires npm i -D @threenative/terrain
 * @situation measure how tall a surveyed mountain stands above the valley floor around it
 * @constraint the tile must cover the whole mountain; a summit crop lifts as a cone
 * @example const lifted = liftMassif({ id: "hill", size: 400, resolution: 3, heights: [0, 0, 0, 0, 90, 0, 0, 0, 0] });
 */
export function liftMassif(tile: IMassifTile): Float32Array {
  const n = tile.resolution;
  if (tile.heights.length !== n * n)
    throw new RangeError(`Massif ${tile.id}: ${n}^2 heights expected`);
  const spacing = tile.size / (n - 1);
  const base = perimeterBase(n, (i) => tile.heights[i] as number, 200 / spacing, 50 / spacing);
  return Float32Array.from(
    { length: n * n },
    (_, i) => (tile.heights[i] as number) - (base[i] as number),
  );
}

const catmullRom = (a: number, b: number, c: number, d: number, t: number): number =>
  b + 0.5 * t * (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * (b - c) + d - a)));

/** Mean downhill direction of the steep faces, weighted by steepness squared, in tile radians. */
function faceDirection(lifted: Float32Array, n: number, spacing: number): number {
  let x = 0;
  let z = 0;
  const step = Math.max(1, Math.floor(n / 128));
  for (let row = step; row < n - step; row += step)
    for (let column = step; column < n - step; column += step) {
      if ((lifted[row * n + column] as number) < 50) continue;
      const dx =
        ((lifted[row * n + column + step] as number) -
          (lifted[row * n + column - step] as number)) /
        (2 * step * spacing);
      const dz =
        ((lifted[(row + step) * n + column] as number) -
          (lifted[(row - step) * n + column] as number)) /
        (2 * step * spacing);
      const g2 = dx * dx + dz * dz;
      if (g2 < 1) continue; // under 45 degrees
      const g = Math.sqrt(g2);
      x -= (dx / g) * g2;
      z -= (dz / g) * g2;
    }
  return Math.atan2(z, x);
}

/**
 * Stands one surveyed mountain behind a world, chosen and posed by a seed: the tile from a list, a
 * point on a bearing and distance, a turn that faces its steepest wall to the centre within 20
 * degrees, a mirror and a summit height. It stands on the host's own foot (a smooth surface through
 * the host under its border), replacing the host's hills inside its square, and leaves the centre
 * square untouched. Appends one `heightmap` layer; the placement carries the tile-spacing heights a
 * relief map reads.
 * @requires npm i -D @threenative/terrain
 * @situation put a real-shaped mountain behind a generated world, a different one per seed
 * @constraint the tile must be a whole mountain whose border is valley floor; erosion after it carves the survey
 * @example const { terrain, placement } = placeMassif(new Terrain({ size: 5000, resolution: 129 }), { seed: 3, tile: { id: "cone", size: 2000, resolution: 3, heights: [0, 0, 0, 0, 900, 0, 0, 0, 0] } });
 * @override `at`, `bearing`, `distance`, `height` and `keepOut` on the same call
 */
export function placeMassif(
  terrain: Terrain,
  options: IPlaceMassifOptions,
): { terrain: Terrain; placement: IMassifPlacement } {
  const draw = random((options.seed * 2654435761) ^ 0x6d617373);
  const tiles = Array.isArray(options.tile) ? options.tile : [options.tile as IMassifTile];
  if (tiles.length === 0) throw new RangeError("placeMassif needs at least one tile");
  const tile = tiles[Math.floor(draw() * tiles.length) % tiles.length] as IMassifTile;
  const lifted = liftMassif(tile);
  const n = tile.resolution;
  const spacing = tile.size / (n - 1);
  let summit = 0;
  for (let i = 1; i < lifted.length; i++)
    if ((lifted[i] as number) > (lifted[summit] as number)) summit = i;
  const tall = lifted[summit] as number;
  if (!(tall > 0)) throw new RangeError(`Massif ${tile.id} has no relief above its border`);
  const mirror = draw() < 0.5;
  // Tile-local metres with the mirror applied: x east, z south.
  const local = (i: number): [number, number] => {
    const x = ((i % n) / (n - 1) - 0.5) * tile.size;
    return [mirror ? -x : x, (Math.floor(i / n) / (n - 1) - 0.5) * tile.size];
  };
  const [sx, sz] = local(summit);

  const state = terrain.evaluate();
  const N = state.resolution;
  const cell = state.size / (N - 1);
  const halfWorld = state.size / 2;
  const at: [number, number] =
    options.at !== undefined
      ? [options.at[0], options.at[1]]
      : (() => {
          const [b0, b1] = options.bearing ?? [0, 360];
          const [d0, d1] = options.distance ?? [tile.size / 2, halfWorld - tile.size / 4];
          const bearing = ((b0 + draw() * (b1 - b0)) * Math.PI) / 180;
          const distance = d0 + draw() * (d1 - d0);
          return [Math.cos(bearing) * distance, Math.sin(bearing) * distance];
        })();
  if (options.at !== undefined) {
    // The same draws either way, so `at` changes the pose of nothing else.
    draw();
    draw();
  }
  const faceTile = faceDirection(lifted, n, spacing);
  const face = mirror ? Math.PI - faceTile : faceTile;
  const toCentre = Math.atan2(-at[1], -at[0]);
  const jitter = ((draw() - 0.5) * 40 * Math.PI) / 180;
  const turn = toCentre + jitter - face;
  const pick = draw();
  const keepOut = options.keepOut ?? 320;
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  /** World point to tile (u, v) in [0, 1], and back. */
  const toTile = (x: number, z: number): [number, number] => {
    const dx = x - at[0];
    const dz = z - at[1];
    const mx = sx + dx * cos + dz * sin;
    const mz = sz - dx * sin + dz * cos;
    return [(mirror ? -mx : mx) / tile.size + 0.5, mz / tile.size + 0.5];
  };
  const toWorld = (u: number, v: number): [number, number] => {
    const mx = (mirror ? -1 : 1) * (u - 0.5) * tile.size - sx;
    const mz = (v - 0.5) * tile.size - sz;
    return [at[0] + mx * cos - mz * sin, at[1] + mx * sin + mz * cos];
  };
  const hostAt = (x: number, z: number) =>
    sampleGrid(state.height, N, N, (x + halfWorld) / state.size, (z + halfWorld) / state.size);
  /** Catmull-Rom host height: C1, so a relief map read off the detail grid shows no cell facets. */
  const hostSmooth = (x: number, z: number) => {
    const gx = clamp((x + halfWorld) / cell, 0, N - 1);
    const gz = clamp((z + halfWorld) / cell, 0, N - 1);
    const ix = Math.min(N - 2, Math.floor(gx));
    const iz = Math.min(N - 2, Math.floor(gz));
    const tx = gx - ix;
    const tz = gz - iz;
    const h = (r: number, c: number) =>
      state.height[clamp(r, 0, N - 1) * N + clamp(c, 0, N - 1)] as number;
    const row = (r: number) => catmullRom(h(r, ix - 1), h(r, ix), h(r, ix + 1), h(r, ix + 2), tx);
    return catmullRom(row(iz - 1), row(iz), row(iz + 1), row(iz + 2), tz);
  };
  // The host's foot under the footprint, through the host along the footprint's border.
  const B = 129;
  const hostEdge = new Float32Array(B * B);
  for (let row = 0; row < B; row++)
    for (let column = 0; column < B; column++)
      if (row === 0 || column === 0 || row === B - 1 || column === B - 1)
        hostEdge[row * B + column] = hostAt(...toWorld(column / (B - 1), row / (B - 1)));
  const hostBase = perimeterBase(
    B,
    (i) => hostEdge[i] as number,
    200 / (tile.size / (B - 1)),
    1e-6,
  );
  const foot = sampleGrid(hostBase, B, B, ...toTile(at[0], at[1]));
  let floor = Number.POSITIVE_INFINITY;
  for (let i = 0; i < B * B; i++) {
    const row = Math.floor(i / B);
    const column = i % B;
    if (row === 0 || column === 0 || row === B - 1 || column === B - 1)
      floor = Math.min(floor, hostEdge[i] as number);
  }
  let scale: number;
  if (options.top) {
    // The largest scale that keeps every point of the mountain under the picked top: a lesser peak
    // over higher ground is the bound as often as the summit is.
    const top = options.top[0] + pick * (options.top[1] - options.top[0]);
    scale = Number.POSITIVE_INFINITY;
    for (let row = 0; row < n; row += 4)
      for (let column = 0; column < n; column += 4) {
        const rise = lifted[row * n + column] as number;
        if (rise < 1) continue;
        const u = column / (n - 1);
        const v = row / (n - 1);
        scale = Math.min(scale, (top - sampleGrid(hostBase, B, B, u, v)) / rise);
      }
  } else {
    const [h0, h1] = options.height ?? [0.85 * tall, 1.15 * tall];
    scale = (h0 + pick * (h1 - h0)) / tall;
  }
  if (!(scale > 0))
    throw new RangeError(`Massif ${tile.id}: top under its foot at ${foot.toFixed(0)} m`);
  const height = scale * tall;
  // The tile prefiltered to about the host's spacing, for the host-grid layer.
  const factor = Math.max(1, Math.round(cell / spacing));
  const coarseN = Math.floor((n - 1) / factor) + 1;
  const coarse = new Float32Array(coarseN * coarseN);
  for (let row = 0; row < coarseN; row++)
    for (let column = 0; column < coarseN; column++) {
      let sum = 0;
      let count = 0;
      for (let dr = -(factor >> 1); dr <= factor >> 1; dr++)
        for (let dc = -(factor >> 1); dc <= factor >> 1; dc++) {
          const r = row * factor + dr;
          const c = column * factor + dc;
          if (r < 0 || c < 0 || r >= n || c >= n) continue;
          sum += lifted[r * n + c] as number;
          count++;
        }
      coarse[row * coarseN + column] = sum / count;
    }
  /** The final height at a world point, from a lifted grid, and its weight against the host. */
  const finalAt = (x: number, z: number, grid: Float32Array, gridN: number): [number, number] => {
    const [u, v] = toTile(x, z);
    if (u <= 0 || u >= 1 || v <= 0 || v >= 1) return [0, 0];
    const edge = Math.min(u, v, 1 - u, 1 - v);
    const reach = Math.max(Math.abs(x), Math.abs(z));
    const weight = smoothstep(0, 0.04, edge) * smoothstep(keepOut, keepOut + 160, reach);
    if (weight === 0) return [0, 0];
    const raw = sampleGrid(hostBase, B, B, u, v) + scale * sampleGrid(grid, gridN, gridN, u, v);
    // A valley inside the mountain fills to the lowest ground its border leaves by, as a real
    // valley floor does, instead of a pit below the world: a smooth max over 40 m.
    const value = (raw + floor + Math.sqrt((raw - floor) ** 2 + 40 ** 2)) / 2;
    return [value, weight];
  };
  const delta = new Float32Array(N * N);
  for (let row = 0; row < N; row++)
    for (let column = 0; column < N; column++) {
      const x = column * cell - halfWorld;
      const z = row * cell - halfWorld;
      const [value, weight] = finalAt(x, z, coarse, coarseN);
      if (weight > 0) {
        const host = state.height[row * N + column] as number;
        delta[row * N + column] = weight * (value - host);
      }
    }
  // The footprint's world box at tile spacing, clipped to the world.
  const corners = [toWorld(0, 0), toWorld(1, 0), toWorld(0, 1), toWorld(1, 1)];
  const x0 = clamp(Math.min(...corners.map((p) => p[0])), -halfWorld, halfWorld);
  const x1 = clamp(Math.max(...corners.map((p) => p[0])), -halfWorld, halfWorld);
  const z0 = clamp(Math.min(...corners.map((p) => p[1])), -halfWorld, halfWorld);
  const z1 = clamp(Math.max(...corners.map((p) => p[1])), -halfWorld, halfWorld);
  const columns = Math.floor((x1 - x0) / spacing) + 1;
  const rows = Math.floor((z1 - z0) / spacing) + 1;
  const detail = new Float32Array(columns * rows);
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++) {
      const x = x0 + column * spacing;
      const z = z0 + row * spacing;
      const host = hostSmooth(x, z);
      const [value, weight] = finalAt(x, z, lifted, n);
      detail[row * columns + column] = host + weight * (value - host);
    }
  const id = options.id ?? "massif";
  return {
    terrain: terrain.heightmap({
      id,
      data: { width: N, height: N, values: Array.from(delta) },
      blend: "add",
    }),
    placement: {
      tile: tile.id,
      at,
      rotation: (turn * 180) / Math.PI,
      mirror,
      height,
      detail: { origin: [x0, z0], spacing, columns, rows, heights: detail },
    },
  };
}
