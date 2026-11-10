import type { IHeightfieldCollarWalk } from "@threenative/core/world";
import { BufferAttribute, BufferGeometry } from "three";
import { describe, expect, it } from "vitest";
import { walkBandSlices } from "../src/world/walkBand.js";

const PERIMETER = 4;
const RINGS = 20;

/**
 * A band drawn the way the collar draws one: ring `r`'s quads are a contiguous run of the index
 * buffer, and they address the vertices of rings `r` and `r + 1`. Only the scale differs from the
 * survey's 1 024-sample perimeter.
 */
function ringGrid(): { band: IHeightfieldCollarWalk; geometry: BufferGeometry } {
  const positions = new Float32Array((RINGS + 1) * PERIMETER * 3);
  for (let ring = 0; ring <= RINGS; ring += 1)
    for (let vertex = 0; vertex < PERIMETER; vertex += 1) {
      const at = (ring * PERIMETER + vertex) * 3;
      positions[at] = vertex;
      positions[at + 1] = ring;
      positions[at + 2] = ring * 1000 + vertex;
    }
  const indices = new Uint32Array(RINGS * PERIMETER * 6);
  let at = 0;
  for (let ring = 0; ring < RINGS; ring += 1)
    for (let vertex = 0; vertex < PERIMETER; vertex += 1) {
      const a = ring * PERIMETER + vertex;
      const b = ring * PERIMETER + ((vertex + 1) % PERIMETER);
      indices[at] = a;
      indices[at + 1] = b;
      indices[at + 2] = a + PERIMETER;
      indices[at + 3] = b;
      indices[at + 4] = b + PERIMETER;
      indices[at + 5] = a + PERIMETER;
      at += 6;
    }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  return { band: { extent: 0, geometry }, geometry };
}

/** Every triangle a slice draws, named by its three vertices, so two runs can be compared as sets. */
function triangles(vertices: ArrayLike<number>, indices: ArrayLike<number>): string[] {
  const drawn: string[] = [];
  const corner = (vertex: number): string =>
    `${vertices[vertex * 3] as number},${vertices[vertex * 3 + 1] as number},${vertices[vertex * 3 + 2] as number}`;
  for (let at = 0; at < indices.length; at += 3)
    drawn.push(
      [indices[at] as number, indices[at + 1] as number, indices[at + 2] as number]
        .map(corner)
        .sort()
        .join(" | "),
    );
  return drawn.sort();
}

describe("walkBandSlices", () => {
  it("cuts the band into per-ring groups whose triangles together are the whole band", () => {
    const { band, geometry } = ringGrid();

    const slices = walkBandSlices(band, PERIMETER);

    expect(slices.map((slice) => slice.indices.length / 3)).toEqual([64, 64, 32]);
    const whole = triangles(
      geometry.getAttribute("position").array,
      geometry.getIndex()?.array as ArrayLike<number>,
    );
    // Sorted as one list: the slices are disjoint runs of the ring grid, not a global ordering.
    expect(slices.flatMap((slice) => triangles(slice.vertices, slice.indices)).sort()).toEqual(
      whole,
    );
  });

  it("addresses its own vertices only, so one slice can be one trimesh", () => {
    const { band } = ringGrid();

    for (const slice of walkBandSlices(band, PERIMETER)) {
      const count = slice.vertices.length / 3;
      for (const vertex of slice.indices) expect(vertex).toBeLessThan(count);
    }
  });

  // The gap a foot would fall through: both bodies must own the ring they meet on.
  it("gives the shared seam ring to both slices", () => {
    const { band } = ringGrid();

    const slices = walkBandSlices(band, PERIMETER);

    const rings = (slice: { readonly vertices: Float32Array }): [number, number] => [
      slice.vertices[1] as number,
      slice.vertices[slice.vertices.length - 2] as number,
    ];
    expect(slices.map(rings)).toEqual([
      [0, 8],
      [8, 16],
      [16, 20],
    ]);
  });
});
