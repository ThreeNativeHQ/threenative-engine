/**
 * A spatial index for water proximity: river segments, river stations and lake shores.
 *
 * Every caller that asks "is this point near water?" over a whole heightfield or a scatter pass
 * otherwise scans every segment per point. In the Strata preview that cost 3.4 s (scatter) and
 * 2.3 s (ground curvature) of a synchronous scene entry on a 612-station river (PRD-466, PRD-541).
 * Each segment is registered in every grid cell its bounding box covers once grown by its own reach,
 * so `nearby` returns a superset of the segments within reach of the point. The caller keeps its own
 * exact distance and level test on that short list.
 */
export interface IWaterSegment<T> {
  /** One end, `[x, z]` in world metres. A station or a lake centre passes the same point twice. */
  readonly a: readonly [number, number];
  readonly b: readonly [number, number];
  /** How far from the segment the caller's test can still answer true, in metres. */
  readonly reach: number;
  readonly data: T;
}

export interface ISegmentIndex<T> {
  /** Every segment whose reach may cover `(x, z)`. Never misses one; may include farther ones. */
  nearby(x: number, z: number): readonly T[];
}

const EMPTY: readonly never[] = [];

/**
 * Build the index once per world; ask `nearby` per scatter candidate or heightfield vertex.
 *
 * @requires npm i @threenative/terrain
 * @situation test scatter candidates or terrain vertices against rivers and lakes without scanning every segment
 * @situation find which river stations can reach a heightfield vertex when baking a wet margin
 * @constraint returns candidates only; the caller applies its own exact distance and level test
 * @example const rivers = createSegmentIndex(segments, 32); const wet = rivers.nearby(x, z).some(isWet);
 */
export function createSegmentIndex<T>(
  segments: readonly IWaterSegment<T>[],
  cellSize: number,
): ISegmentIndex<T> {
  if (!(cellSize > 0) || !Number.isFinite(cellSize))
    throw new Error(
      `TN_TERRAIN_WATER_CELL_INVALID: cellSize must be a positive finite number, received ${String(cellSize)}.`,
    );
  const cells = new Map<string, T[]>();
  for (const segment of segments) {
    const { a, b, reach } = segment;
    if (!(reach >= 0) || !Number.isFinite(reach))
      throw new Error(
        `TN_TERRAIN_WATER_REACH_INVALID: reach must be a non-negative finite number, received ${String(reach)}.`,
      );
    const fromX = Math.floor((Math.min(a[0], b[0]) - reach) / cellSize);
    const toX = Math.floor((Math.max(a[0], b[0]) + reach) / cellSize);
    const fromZ = Math.floor((Math.min(a[1], b[1]) - reach) / cellSize);
    const toZ = Math.floor((Math.max(a[1], b[1]) + reach) / cellSize);
    for (let cx = fromX; cx <= toX; cx++)
      for (let cz = fromZ; cz <= toZ; cz++) {
        const key = `${cx}:${cz}`;
        const list = cells.get(key);
        if (list) list.push(segment.data);
        else cells.set(key, [segment.data]);
      }
  }
  return {
    nearby: (x, z) => cells.get(`${Math.floor(x / cellSize)}:${Math.floor(z / cellSize)}`) ?? EMPTY,
  };
}
