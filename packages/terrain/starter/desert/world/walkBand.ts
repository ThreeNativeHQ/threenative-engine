import type { IHeightfieldCollarWalk } from "@threenative/core/world";

/**
 * Triangle pairs a slice spans: the survey's 1024-sample perimeter makes eight rings 16 384
 * triangles, about one frame's worth of collider build behind the loading curtain.
 */
const RINGS_PER_SLICE = 8;

/** One fixed trimesh's worth of the walk band: its own vertices, and indices rebased onto them. */
export interface IWalkBandSlice {
  /** Vertex triples at the collar's own heights: a view of the drawn buffer, not a resample. */
  readonly vertices: Float32Array;
  /** The triangles of the rings this slice covers, addressing `vertices` from zero. */
  readonly indices: Uint32Array;
}

/**
 * The walk band's drawn triangles, cut into per-ring groups that each become one fixed body.
 *
 * The collar builds `walk` as a ring grid, so the triangles of ring `r` are one contiguous run of
 * its index buffer and they address the two rings either side of it: every slice is a view of the
 * buffers the collar already drew, and nothing is rebuilt. The last ring of a slice is the first
 * ring of the next one — the same heights, duplicated into both — because two bodies that met over
 * a gap instead of a shared edge would be a hole a foot falls through.
 */
export function walkBandSlices(band: IHeightfieldCollarWalk, perimeter: number): IWalkBandSlice[] {
  const index = band.geometry.getIndex();
  if (index === null)
    throw new Error("TN_WALK_BAND_INDEX: the collar's walk band has no index buffer.");
  const positions = band.geometry.getAttribute("position").array;
  const indices = index.array;
  if (!(positions instanceof Float32Array) || !(indices instanceof Uint32Array))
    throw new Error("TN_WALK_BAND_BUFFER: the collar's walk band is not a Float32/Uint32 grid.");
  const rings = indices.length / (perimeter * 6);
  const slices: IWalkBandSlice[] = [];
  for (let ring = 0; ring < rings; ring += RINGS_PER_SLICE) {
    const last = Math.min(ring + RINGS_PER_SLICE, rings);
    const base = ring * perimeter;
    slices.push({
      // Rings `ring` to `last` inclusive: one more than the triangle pairs, so both bodies own the seam.
      vertices: positions.subarray(base * 3, (last + 1) * perimeter * 3),
      // Rebasing copies, because this runs over a view of the collar's drawn triangles.
      indices: indices.subarray(base * 6, last * perimeter * 6).map((vertex) => vertex - base),
    });
  }
  return slices;
}
