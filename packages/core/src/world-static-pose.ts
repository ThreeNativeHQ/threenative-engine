import { type BufferGeometry, type Matrix4, Vector3 } from "three";

/** Ground height under a world point, or `null` where no ground answers. */
export type StaticGroundQuery = (x: number, z: number) => number | null;

const bottomFirst = new WeakMap<BufferGeometry, { xyz: Float32Array; reach: number }>();

function verticesBottomFirst(geometry: BufferGeometry): { xyz: Float32Array; reach: number } {
  const cached = bottomFirst.get(geometry);
  if (cached) return cached;
  const position = geometry.getAttribute("position");
  const order = Array.from({ length: position.count }, (_, i) => i).sort(
    (a, b) => position.getY(a) - position.getY(b),
  );
  const xyz = new Float32Array(position.count * 3);
  let reach = 0;
  order.forEach((i, k) => {
    xyz[k * 3] = position.getX(i);
    xyz[k * 3 + 1] = position.getY(i);
    xyz[k * 3 + 2] = position.getZ(i);
    reach = Math.max(reach, Math.hypot(position.getX(i), position.getZ(i)));
  });
  const entry = { xyz, reach };
  bottomFirst.set(geometry, entry);
  return entry;
}

/**
 * Exact lowest world Y of a static geometry under `matrix`, the precise measurement `GroundSnap`
 * audits against, cheap enough for a load that poses hundreds of thousands of props. An upright
 * pose reads the bounding box. A tilted pose scans the vertices bottom first (sorted once per
 * geometry) and stops once no later vertex can be lower: `|x e1 + z e9| <= reach * hypot(e1, e9)`.
 *
 * @situation stand a scattered rock, tree or crate on the ground by its lowest point, not its origin
 * @situation props hover or sink because their pivot is not at their base
 * @constraint static geometry only; a skinned model uses `GroundSnap`; the sort is cached per geometry, so do not mutate its positions
 * @example placed.position.y += ground - staticLowestY(geometry, matrix);
 */
export function staticLowestY(geometry: BufferGeometry, matrix: Matrix4): number {
  const e = matrix.elements;
  if (e[1] === 0 && e[9] === 0) {
    if (geometry.boundingBox === null) geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    if (box) return (e[5] < 0 ? box.max.y : box.min.y) * e[5] + e[13];
  }
  const { xyz, reach } = verticesBottomFirst(geometry);
  const tilt = reach * Math.hypot(e[1], e[9]);
  const upright = e[5] > 0;
  let lowest = Number.POSITIVE_INFINITY;
  for (let k = 0; k < xyz.length; k += 3) {
    const y = xyz[k + 1] as number;
    if (upright && y * e[5] + e[13] - tilt >= lowest) break;
    lowest = Math.min(
      lowest,
      (xyz[k] as number) * e[1] + y * e[5] + (xyz[k + 2] as number) * e[9] + e[13],
    );
  }
  return lowest;
}

/**
 * How far the flat underside of a static geometry rises above the ground at its highest point.
 * Snapping the lowest point leaves the downhill side of a flat-bottomed rock hanging; sinking the
 * pose by this much buries the whole footprint. Returns 0 when the footprint is already buried.
 *
 * @situation a rock snapped to a slope shows a lip or a gap under its downhill side
 * @constraint the footprint is every vertex at the geometry's lowest local y; throws `TN_STATIC_POSE_GROUND` where the ground does not answer
 * @example matrix.elements[13] -= footprintGap(geometry, matrix, ground, 0.08);
 */
export function footprintGap(
  geometry: BufferGeometry,
  matrix: Matrix4,
  ground: StaticGroundQuery,
  margin = 0,
): number {
  if (geometry.boundingBox === null) geometry.computeBoundingBox();
  const base = geometry.boundingBox?.min.y ?? Number.POSITIVE_INFINITY;
  const positions = geometry.getAttribute("position");
  const point = new Vector3();
  let gap = 0;
  for (let i = 0; i < positions.count; i++) {
    if (Math.abs(positions.getY(i) - base) > 1e-5) continue;
    point.fromBufferAttribute(positions, i).applyMatrix4(matrix);
    const height = ground(point.x, point.z);
    if (height === null)
      throw new Error(
        `TN_STATIC_POSE_GROUND: no ground under the footprint at ${point.x}, ${point.z}.`,
      );
    gap = Math.max(gap, point.y - height + margin);
  }
  return gap;
}

/** What `baseRingGap` measured around a wide static model. */
export interface IBaseRing {
  /** The largest height of a sector's lowest rim vertex above its ground, in metres. */
  readonly gap: number;
  /** Sectors that held a rim vertex. */
  readonly samples: number;
}

/**
 * The highest gap between a wide model's rim and the ground, one sample per angular sector: in
 * each sector, the lowest vertex beyond `rim` of that sector's reach. A narrow buried stem then
 * cannot hold a wide base up in the air on the downhill side. Sink the pose by `gap` (plus any
 * burial the game wants) to close it.
 *
 * @situation a cliff or crag model rests on a buried stem while its wide base hangs over the downhill ground
 * @constraint throws `TN_STATIC_POSE_GROUND` where the ground does not answer; check `samples` before trusting `gap`
 * @example const ring = baseRingGap(geometry, matrix, ground); if (ring.samples >= 4) matrix.elements[13] -= ring.gap + 0.5;
 */
export function baseRingGap(
  geometry: BufferGeometry,
  matrix: Matrix4,
  ground: StaticGroundQuery,
  options: { readonly sectors?: number; readonly rim?: number } = {},
): IBaseRing {
  const count = options.sectors ?? 16;
  const rim = options.rim ?? 0.75;
  if (!Number.isInteger(count) || count < 1 || !(rim >= 0 && rim <= 1))
    throw new Error(
      "TN_STATIC_POSE_INVALID: sectors must be a positive integer and rim within 0..1.",
    );
  if (geometry.boundingBox === null) geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box) throw new Error("TN_STATIC_POSE_INVALID: the geometry has no bounds.");
  const centre = box.getCenter(new Vector3()).applyMatrix4(matrix);
  const sectors = Array.from({ length: count }, () => ({ reach: 0, vertices: [] as Vector3[] }));
  const vertices = geometry.getAttribute("position");
  for (let i = 0; i < vertices.count; i++) {
    const point = new Vector3().fromBufferAttribute(vertices, i).applyMatrix4(matrix);
    const dx = point.x - centre.x;
    const dz = point.z - centre.z;
    const bin = Math.min(
      count - 1,
      Math.floor(((Math.atan2(dz, dx) + Math.PI) / (2 * Math.PI)) * count),
    );
    const sector = sectors[bin];
    if (!sector) continue;
    sector.reach = Math.max(sector.reach, Math.hypot(dx, dz));
    sector.vertices.push(point);
  }
  let gap = Number.NEGATIVE_INFINITY;
  let samples = 0;
  for (const sector of sectors) {
    let lowest: Vector3 | undefined;
    for (const point of sector.vertices)
      if (
        Math.hypot(point.x - centre.x, point.z - centre.z) >= sector.reach * rim &&
        (!lowest || point.y < lowest.y)
      )
        lowest = point;
    if (!lowest) continue;
    const contact = ground(lowest.x, lowest.z);
    if (contact === null)
      throw new Error(
        `TN_STATIC_POSE_GROUND: no ground under the base ring at ${lowest.x}, ${lowest.z}.`,
      );
    gap = Math.max(gap, lowest.y - contact);
    samples++;
  }
  return { gap, samples };
}
