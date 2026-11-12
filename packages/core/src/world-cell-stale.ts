/**
 * The refilter's stale scan over packed rows, run by one engine call a pass.
 *
 * `CellPlacements.refilter` asks which resident cell-assets the follow point or the LOD eye moved
 * across a gate of. That scan visited every batch entry of every resident cell in JS: 0.9 ms a frame
 * on the forest walk, where every cell carries a `placementReach`. The entries' state now lives in a
 * slab of rows, kept per cell and rebuilt only when a cell's batches change, and the scan runs on the
 * slab in the owned engine: `Object3D.__tnStaleRows(blocks, plan)` keeps it there, sent only when it
 * changes and then only the blocks that changed ({@link patchRows}), and `__tnStaleEntries(gates,
 * query)` scans it (`bindings_scene.cpp`). Upstream three runs {@link staleRows}, its twin.
 *
 * Slab: one block per resident cell, a header of {@link STALE_HEADER} numbers, then
 * {@link STALE_ENTRY} numbers per batch entry.
 * - header: cell left x, near z, size, filterNear, filterFar, has reach (0 or 1), entries, 0.
 * - entry: asset index, lastFilter x y z, lastLod x y z, threshold (NaN: none), reach min, max,
 *   minY, maxY (NaN: no reach).
 *
 * Gates: the asset count, then `[at, count]` per asset index into the values that follow (`at` -1:
 * the asset is gone), then the values.
 *
 * Query: follow x, follow y, follow z, eye x y z, GPU scene on (0 or 1), the world gate count, then
 * the world's gates ascending.
 *
 * Answer: `[cell block ordinal, asset index, eye distance]` per stale cell-asset, in scan order.
 */
export const STALE_HEADER = 8;
export const STALE_ENTRY = 12;
/** The query's fixed numbers, before the world's gates. */
export const STALE_QUERY = 8;

/** sqrt of the sum of squares, as the engine's twin computes it; `Math.hypot` costs more. */
function length(x: number, y: number, z = 0): number {
  return Math.sqrt(x * x + y * y + z * z);
}

function span(
  left: number,
  near: number,
  size: number,
  x: number,
  z: number,
): readonly [number, number] {
  const right = left + size;
  const far = near + size;
  return [
    length(Math.max(left - x, x - right, 0), Math.max(near - z, z - far, 0)),
    length(
      Math.max(Math.abs(x - left), Math.abs(x - right)),
      Math.max(Math.abs(z - near), Math.abs(z - far)),
    ),
  ];
}

/** The binary search of `crossesGate`, over the query's own gates. */
function crossesWorldGate(query: Float64Array, low: number, high: number): boolean {
  const count = query[7] as number;
  let start = 0;
  let end = count;
  while (start < end) {
    const middle = (start + end) >> 1;
    if ((query[STALE_QUERY + middle] as number) < low) start = middle + 1;
    else end = middle;
  }
  return start < count && (query[STALE_QUERY + start] as number) <= high;
}

function vertical(y: number, minY: number, maxY: number): readonly [number, number] {
  return [Math.max(minY - y, y - maxY, 0), Math.max(Math.abs(y - minY), Math.abs(y - maxY))];
}

/** Whether the follow point crossed the entry's `placementReach` range since its batch was built. */
function reachCrossed(
  slab: Float64Array,
  at: number,
  cell: number,
  followY: number,
  brackets: readonly [number, number, number, number],
): boolean {
  const minY = slab[at + 10] as number;
  const maxY = slab[at + 11] as number;
  const filterY = slab[at + 2] as number;
  const [reachBuiltNear, reachBuiltFar] = span(
    slab[cell] as number,
    slab[cell + 1] as number,
    slab[cell + 2] as number,
    slab[at + 1] as number,
    slab[at + 3] as number,
  );
  const current = vertical(followY, minY, maxY);
  const previous = vertical(filterY, minY, maxY);
  const reachLow = Math.min(length(brackets[2], current[0]), length(reachBuiltNear, previous[0]));
  const reachHigh = Math.max(length(brackets[3], current[1]), length(reachBuiltFar, previous[1]));
  return (slab[at + 8] as number) <= reachHigh && (slab[at + 9] as number) >= reachLow;
}

/** The scan of one entry at `at`; true when its asset is stale. */
function entryStale(
  slab: Float64Array,
  at: number,
  cell: number,
  gates: Float64Array,
  query: Float64Array,
  brackets: readonly [number, number, number, number],
): boolean {
  const x = query[0] as number;
  const followY = query[1] as number;
  const z = query[2] as number;
  const eyeX = query[3] as number;
  const eyeY = query[4] as number;
  const eyeZ = query[5] as number;
  const gpuOn = query[6] as number;
  const left = slab[cell] as number;
  const nearZ = slab[cell + 1] as number;
  const size = slab[cell + 2] as number;
  const [eyeNear, eyeFar] = brackets;
  const threshold = slab[at + 7] as number;
  const reachMin = slab[at + 8] as number;
  const reach = !Number.isNaN(reachMin);
  if (!reach && (gpuOn === 1 || Number.isNaN(threshold))) return false;
  const step = (Number.isNaN(threshold) ? 6 : threshold) / 8;
  const filterX = slab[at + 1] as number;
  const filterY = slab[at + 2] as number;
  const filterZ = slab[at + 3] as number;
  const lodX = slab[at + 4] as number;
  const lodY = slab[at + 5] as number;
  const lodZ = slab[at + 6] as number;
  if (
    length(x - filterX, followY - filterY, z - filterZ) <= step &&
    length(eyeX - lodX, eyeY - lodY, eyeZ - lodZ) <= step
  )
    return false;
  const asset = slab[at] as number;
  const gateAt = gates[1 + asset * 2] as number;
  if (gateAt < 0) return false;
  const gateCount = gpuOn === 1 ? 0 : (gates[2 + asset * 2] as number);
  const [builtNear, builtFar] = span(left, nearZ, size, lodX, lodZ);
  let low = Math.min(eyeNear, builtNear);
  let high = Math.max(eyeFar, builtFar);
  if (reach) {
    const minY = slab[at + 10] as number;
    const maxY = slab[at + 11] as number;
    const eyeNow = vertical(eyeY, minY, maxY);
    const eyeBefore = vertical(lodY, minY, maxY);
    low = Math.min(length(eyeNear, eyeNow[0]), length(builtNear, eyeBefore[0]));
    high = Math.max(length(eyeFar, eyeNow[1]), length(builtFar, eyeBefore[1]));
    if (reachCrossed(slab, at, cell, followY, brackets)) return true;
  }
  for (let gate = 0; gate < gateCount; gate += 1) {
    const value = gates[gateAt + gate] as number;
    if (value >= low && value <= high) return true;
  }
  return false;
}

/**
 * The upstream-three twin of the engine's `__tnStaleEntries`: every cell-asset whose follow point or
 * LOD eye crossed a gate or a `placementReach` boundary since its batch was built.
 */
export function staleRows(slab: Float64Array, gates: Float64Array, query: Float64Array): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const x = query[0] as number;
  const z = query[2] as number;
  const eyeX = query[3] as number;
  const eyeZ = query[5] as number;
  const gpuOn = query[6] as number;
  let ordinal = 0;
  for (let cell = 0; cell < slab.length; ordinal += 1) {
    const entries = slab[cell + 6] as number;
    const next = cell + STALE_HEADER + entries * STALE_ENTRY;
    const left = slab[cell] as number;
    const nearZ = slab[cell + 1] as number;
    const size = slab[cell + 2] as number;
    const hasReach = slab[cell + 5] === 1;
    const [eyeNear, eyeFar] = span(left, nearZ, size, eyeX, eyeZ);
    const low = Math.min(eyeNear, slab[cell + 3] as number);
    const high = Math.max(eyeFar, slab[cell + 4] as number);
    if ((gpuOn === 1 && !hasReach) || (!hasReach && !crossesWorldGate(query, low, high))) {
      cell = next;
      continue;
    }
    const [near, far] = span(left, nearZ, size, x, z);
    seen.clear();
    for (let at = cell + STALE_HEADER; at < next; at += STALE_ENTRY) {
      const asset = slab[at] as number;
      if (seen.has(asset)) continue;
      if (!entryStale(slab, at, cell, gates, query, [eyeNear, eyeFar, near, far])) continue;
      seen.add(asset);
      out.push(ordinal, asset, eyeNear);
    }
    cell = next;
  }
  return out;
}

/**
 * The upstream-three twin of the engine's `__tnStaleRows(blocks, plan)`: the next slab, built from the
 * one held and the blocks that changed. A refilter rebuilds one cell's block, so re-sending the whole
 * slab cost 0.30 ms a swap frame on the forest walk for numbers the engine already held.
 *
 * `plan` is `[source, count]` pairs in slab order: `source` 0 or more keeps `count` numbers of the
 * held slab from `source`, and -1 takes the next `count` numbers of `blocks`.
 */
export function patchRows(
  held: Float64Array,
  blocks: Float64Array,
  plan: ArrayLike<number>,
): Float64Array<ArrayBuffer> {
  let length = 0;
  for (let at = 1; at < plan.length; at += 2) length += plan[at] as number;
  const next = new Float64Array(length);
  let written = 0;
  let taken = 0;
  for (let at = 0; at + 1 < plan.length; at += 2) {
    const source = plan[at] as number;
    const count = plan[at + 1] as number;
    const from = source === -1 ? blocks : held;
    const start = source === -1 ? taken : source;
    if (
      !(
        Number.isInteger(start) &&
        Number.isInteger(count) &&
        start >= 0 &&
        count >= 0 &&
        start + count <= from.length
      )
    )
      throw new RangeError(
        `TN_WORLD_STALE: a plan run [${String(source)}, ${String(count)}] is outside its rows`,
      );
    next.set(from.subarray(start, start + count), written);
    written += count;
    if (source === -1) taken += count;
  }
  if (taken !== blocks.length)
    throw new RangeError("TN_WORLD_STALE: the plan leaves changed blocks unread");
  return next;
}
