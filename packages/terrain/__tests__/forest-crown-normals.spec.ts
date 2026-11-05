import { BufferGeometry, Float32BufferAttribute } from "three";
import { describe, expect, it } from "vitest";
import { CROWN_NORMAL_BEND, bendCrownNormals } from "../starter/forest/world.js";

/** One foliage card: a flat quad, every vertex facing its own +Z. */
function card(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new Float32BufferAttribute([-1, 0, 0.5, 1, 0, 0.5, -1, 2, 0.5, 1, 2, 0.5], 3),
  );
  geometry.setAttribute(
    "normal",
    new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3),
  );
  return geometry;
}

function normals(geometry: BufferGeometry): number[] {
  return [...geometry.getAttribute("normal").array];
}

describe("forest crown normals", () => {
  it("bends a cached prop geometry once, however many times the world is revisited", () => {
    const geometry = card();
    const flat = normals(geometry);
    bendCrownNormals(geometry, CROWN_NORMAL_BEND);
    const bent = normals(geometry);
    // Guard the guard: a bend that moved nothing would pass the revisit assertion for free.
    expect(bent).not.toEqual(flat);
    // The model cache hands the same geometry back on a second visit to the forest.
    bendCrownNormals(geometry, CROWN_NORMAL_BEND);
    expect(normals(geometry)).toEqual(bent);
  });
});
