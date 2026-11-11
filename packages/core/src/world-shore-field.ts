/** How the shore field reads open water; every default is the Strata coastal world's. */
export interface IShoreFieldOptions {
  /** Water must be this many metres deep for open-sea exposure to flood through it. Default 2. */
  readonly openDepth?: number;
  /** Metres of shallow water that exposure still carries into, never across dry ground. Default 18. */
  readonly carry?: number;
}

/** Per grid node: metres to the nearest dry node, and 1 where the open sea reaches. */
export interface IShoreField {
  readonly distance: Float32Array;
  readonly exposed: Uint8Array;
}

/**
 * Distance to the shore and open-sea exposure for every node of a square height grid, measured once
 * from the bake. `distance` is a two-pass chamfer distance to the nearest node at or above `level`
 * (0 on dry ground). `exposed` floods from the grid's edge through water deeper than `openDepth`,
 * then `carry` metres further into shallow water, so a sheltered lagoon behind a sand bar stays out
 * of it. Both feed the game's surf and shore masks; neither decides a colour.
 *
 * @situation surf breaks only on water open to the sea, not in a sheltered lagoon
 * @situation distance from each water cell to the shore, for a foam or depth mask
 * @constraint heights are row-major, `resolution` by `resolution`, across `size` metres; measured once, never per frame
 * @example const { distance, exposed } = shoreField(world.heights, world.resolution, world.size, world.waterLevel);
 */
export function shoreField(
  heights: ArrayLike<number>,
  resolution: number,
  size: number,
  level: number,
  options: IShoreFieldOptions = {},
): IShoreField {
  const n = resolution;
  const openDepth = options.openDepth ?? 2;
  const carry = options.carry ?? 18;
  if (!Number.isInteger(n) || n < 2 || heights.length !== n * n)
    throw new Error(
      `TN_SHORE_FIELD_INVALID: heights must hold resolution² values, received ${heights.length} for ${n}.`,
    );
  if (!(size > 0) || !Number.isFinite(level) || !(openDepth >= 0) || !(carry >= 0))
    throw new Error(
      "TN_SHORE_FIELD_INVALID: size must be positive, level finite, openDepth and carry not negative.",
    );
  const cell = size / (n - 1);
  const height = (i: number): number => heights[i] ?? 0;
  const distance = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) distance[i] = height(i) >= level ? 0 : 1e4;
  const exposed = new Uint8Array(n * n);
  const queue: number[] = [];
  for (let i = 0; i < n * n; i++) {
    const row = Math.floor(i / n);
    const col = i % n;
    if (
      (row === 0 || col === 0 || row === n - 1 || col === n - 1) &&
      height(i) < level - openDepth
    ) {
      exposed[i] = 1;
      queue.push(i);
    }
    if (col > 0) distance[i] = Math.min(distance[i] ?? 0, (distance[i - 1] ?? 0) + cell);
    if (row > 0) distance[i] = Math.min(distance[i] ?? 0, (distance[i - n] ?? 0) + cell);
  }
  for (let i = n * n - 1; i >= 0; i--) {
    if (i % n < n - 1) distance[i] = Math.min(distance[i] ?? 0, (distance[i + 1] ?? 0) + cell);
    if (i < n * (n - 1)) distance[i] = Math.min(distance[i] ?? 0, (distance[i + n] ?? 0) + cell);
  }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head] ?? 0;
    for (const next of [i % n > 0 ? i - 1 : -1, i % n < n - 1 ? i + 1 : -1, i - n, i + n]) {
      if (next < 0 || next >= exposed.length || exposed[next] || height(next) >= level - openDepth)
        continue;
      exposed[next] = 1;
      queue.push(next);
    }
  }
  for (let pass = 0; pass < Math.ceil(carry / cell); pass++) {
    const previous = exposed.slice();
    for (let i = 0; i < exposed.length; i++) {
      if (height(i) >= level) continue;
      if (
        (i % n > 0 && previous[i - 1]) ||
        (i % n < n - 1 && previous[i + 1]) ||
        previous[i - n] ||
        previous[i + n]
      )
        exposed[i] = 1;
    }
  }
  return { distance, exposed };
}
