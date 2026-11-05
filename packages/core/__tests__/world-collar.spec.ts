import { DoubleSide, Mesh, Raycaster, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import {
  HeightfieldCollar,
  type IHeightfieldCollarOptions,
  type IHeightfieldCollarSite,
} from "../src/world-collar.js";

/**
 * The game's `height` callback is the only source of collar relief, so every case states its answer
 * from that callback or from the drawn buffer — never from a second copy of the ring maths.
 */
const relief = (site: IHeightfieldCollarSite): number =>
  Math.sin(site.x * 0.01) * 5 + Math.cos(site.z * 0.013) * 4 + site.distance * 0.002;

function collar(options: Partial<IHeightfieldCollarOptions> = {}) {
  return new HeightfieldCollar({
    height: relief,
    resolution: 5,
    ringDistance: (ring) => ((ring / 4) ** 1.65 * 4000) as number,
    rings: 4,
    size: 16,
    walkBand: 200,
    ...options,
  });
}

describe("HeightfieldCollar", () => {
  it("draws one vertex per boundary sample per ring, and ring 0 on the square's own edge", () => {
    const built = collar();
    const segments = 4;
    expect(built.perimeter).toBe(segments * 4);
    const position = built.geometry.getAttribute("position");
    expect(position.count).toBe((built.rings + 1) * built.perimeter);
    expect(built.geometry.getIndex()?.count).toBe(built.rings * built.perimeter * 6);
    const half = 8;
    for (let ring = 0; ring <= built.rings; ring += 1) {
      const edge = half + (built.distance(ring) as number);
      for (let vertex = 0; vertex < built.perimeter; vertex += 1) {
        const index = built.index(ring, vertex);
        // A ring is a square: the farther axis sits on the ring's edge, the other slides along it,
        // and the drawn positions are float32.
        expect(
          Math.max(Math.abs(position.getX(index)), Math.abs(position.getZ(index))) / edge,
          `ring ${ring} vertex ${vertex} stands on the ring's edge`,
        ).toBeCloseTo(1, 5);
        // The drawn y is the callback's answer at the site; x and z come back as float32.
        expect(position.getY(index)).toBeCloseTo(
          relief({
            distance: built.distance(ring) as number,
            ring,
            vertex,
            x: position.getX(index),
            z: position.getZ(index),
          }),
          4,
        );
      }
    }
    // Ring 0 is the square's own boundary, where the terrain mesh meets the collar.
    for (let vertex = 0; vertex < built.perimeter; vertex += 1) {
      const index = built.index(0, vertex);
      expect(Math.max(Math.abs(position.getX(index)), Math.abs(position.getZ(index)))).toBeCloseTo(
        half,
        5,
      );
    }
  });

  it("walks the square's boundary once, from its (-x, -z) corner, for every ring", () => {
    const built = collar({ resolution: 5 });
    const segments = 4;
    expect(built.boundary(0)).toEqual({ column: 0, row: 0 });
    expect(built.boundary(segments)).toEqual({ column: segments, row: 0 });
    expect(built.boundary(segments * 2)).toEqual({ column: segments, row: segments });
    expect(built.boundary(segments * 3)).toEqual({ column: 0, row: segments });
    expect(() => built.boundary(built.perimeter)).toThrow("outside the ring");
    // The walk is the square's edge, one sample at a time, with no gaps and no repeats.
    const seen = new Set<string>();
    for (let vertex = 0; vertex < built.perimeter; vertex += 1) {
      const { column, row } = built.boundary(vertex);
      const onEdge = column === 0 || column === segments || row === 0 || row === segments;
      expect(onEdge, `vertex ${vertex} is on the square's edge`).toBe(true);
      seen.add(`${column},${row}`);
    }
    expect(seen.size).toBe(built.perimeter);
  });

  it("ends the walk band at the outermost ring inside it, sharing the collar's own buffer", () => {
    const built = collar({ walkBand: 200 });
    // Ring 1 stands 406 m past the edge, so only the square's own ring is inside a 200 m band.
    expect(built.walk.extent).toBe(0);
    expect(built.walk.geometry.getAttribute("position").count).toBe(built.perimeter);
    const inside = collar({ walkBand: 500 });
    expect(inside.walk.extent).toBeCloseTo((1 / 4) ** 1.65 * 4000, 9);
    expect(inside.walk.geometry.getAttribute("position").count).toBe(2 * inside.perimeter);
    expect(inside.walk.geometry.getIndex()?.count).toBe(inside.perimeter * 6);
    const source = built.geometry.getAttribute("position").array as Float32Array;
    const band = built.walk.geometry.getAttribute("position").array as Float32Array;
    expect(band.buffer).toBe(source.buffer);
    const whole = collar({ walkBand: 1e9 });
    expect(whole.walk.extent).toBeCloseTo(4000, 6);
    expect(whole.walk.geometry.getIndex()?.count).toBe(whole.rings * whole.perimeter * 6);
  });

  it("answers the drawn collar's own vertices and the shared edges between them", () => {
    const built = collar({ resolution: 9, rings: 6, walkBand: 1e9 });
    const position = built.geometry.getAttribute("position");
    for (let ring = 0; ring < built.rings; ring += 1) {
      for (let vertex = 0; vertex < built.perimeter; vertex += 1) {
        const index = built.index(ring, vertex);
        expect(
          built.heightAt(position.getX(index), position.getZ(index)),
          `vertex ${ring},${vertex}`,
        ).toBeCloseTo(position.getY(index), 4);
      }
    }
    // The centre of a drawn quad: the mean of its four vertices, which is what bilinear states.
    for (const [ring, vertex] of [
      [0, 0],
      [2, 5],
      [4, 30],
    ] as const) {
      const corners = [
        built.index(ring, vertex),
        built.index(ring, vertex + 1),
        built.index(ring + 1, vertex),
        built.index(ring + 1, vertex + 1),
      ];
      const x = corners.reduce((sum, at) => sum + position.getX(at), 0) / 4;
      const z = corners.reduce((sum, at) => sum + position.getZ(at), 0) / 4;
      const average = corners.reduce((sum, at) => sum + position.getY(at), 0) / 4;
      const quad = built.locate(x, z);
      expect(quad, `quad ${ring},${vertex}`).not.toBeUndefined();
      expect(built.heightAt(x, z)).toBeCloseTo(average, 6);
    }
  });

  it("answers null inside the square and past the outermost ring, and never guesses", () => {
    const built = collar();
    expect(built.heightAt(0, 0)).toBeNull();
    expect(built.heightAt(7.9, -3)).toBeNull();
    expect(built.locate(0, 0)).toBeUndefined();
    const outer = built.distance(built.rings) as number;
    expect(built.heightAt(8 + outer, 0)).toBeNull();
    expect(built.heightAt(8 + outer - 1, 0)).not.toBeNull();
    expect(() => built.heightAt(Number.NaN, 0)).toThrow("must be finite");
    expect(() => built.index(built.rings + 1, 0)).toThrow("outside the collar");
    expect(() => built.index(0, built.perimeter)).toThrow("outside the ring");
    expect(() => built.distance(-1)).toThrow("outside the collar");
  });

  it("draws the same surface a ray meets, so a collider on the ring is the ground the eye sees", () => {
    const built = collar({ resolution: 9, rings: 6, walkBand: 1e9 });
    const mesh = new Mesh(built.geometry);
    mesh.material.side = DoubleSide;
    mesh.updateMatrixWorld(true);
    const ray = new Raycaster();
    const position = built.geometry.getAttribute("position");
    for (const [ring, vertex] of [
      [0, 0],
      [1, 4],
      [3, 17],
      [5, 30],
    ] as const) {
      const index = built.index(ring, vertex);
      const x = position.getX(index);
      const z = position.getZ(index);
      ray.set(new Vector3(x, 10_000, z), new Vector3(0, -1, 0));
      const hit = ray.intersectObject(mesh, false)[0];
      expect(hit, `ray at ${x}, ${z}`).not.toBeUndefined();
      expect((hit?.point.y as number) - position.getY(index)).toBeLessThan(1e-3);
    }
  });

  it("refuses a framing curve that folds, and a ring that leaves the square's edge", () => {
    expect(() => collar({ resolution: 1 })).toThrow("at least 2 samples");
    expect(() => collar({ rings: 0 })).toThrow("at least 1 ring");
    expect(() => collar({ walkBand: -1 })).toThrow("must not be negative");
    expect(() => collar({ size: Number.NaN })).toThrow("must be finite");
    expect(() => collar({ size: 0 })).toThrow("must be positive");
    expect(() => collar({ ringDistance: () => 5 })).toThrow("reads 0");
    expect(() => collar({ ringDistance: (ring) => (ring === 3 ? 1 : ring * 10) })).toThrow(
      "closer than the ring inside it",
    );
    expect(() => collar({ ringDistance: () => Number.NaN })).toThrow("must be finite");
  });
});
