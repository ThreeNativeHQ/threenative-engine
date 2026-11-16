import { describe, expect, it } from "vitest";
import { skyVisibility } from "../src/render/sky/skyVisibility.js";

const RESOLUTION = 129;
const SIZE = 256;
const SPACING = SIZE / (RESOLUTION - 1);

function field(height: (x: number, z: number) => number): Float32Array {
  const heights = new Float32Array(RESOLUTION * RESOLUTION);
  for (let row = 0; row < RESOLUTION; row++)
    for (let column = 0; column < RESOLUTION; column++)
      heights[row * RESOLUTION + column] = height(
        column * SPACING - SIZE / 2,
        row * SPACING - SIZE / 2,
      );
  return heights;
}

const centre = (RESOLUTION - 1) / 2;
const at = (visibility: Float32Array, row: number, column: number): number =>
  visibility[row * RESOLUTION + column] ?? Number.NaN;

describe("skyVisibility", () => {
  it("sees the whole sky from flat ground", () => {
    const visibility = skyVisibility(
      field(() => 3),
      RESOLUTION,
      SIZE,
    );
    expect(visibility.length).toBe(RESOLUTION * RESOLUTION);
    expect(Math.min(...visibility)).toBe(1);
  });

  it("keeps a straight slope open: only ground above the tangent plane occludes", () => {
    const visibility = skyVisibility(
      field((x, z) => x * 0.6 + z * 0.2),
      RESOLUTION,
      SIZE,
    );
    expect(at(visibility, centre, centre)).toBeGreaterThan(0.99);
  });

  it("integrates cos² of the horizon: a 45° crater wall leaves half the sky", () => {
    // A flat floor 40 m across inside a 40 m high wall: the horizon is 45° in every azimuth.
    const visibility = skyVisibility(
      field((x, z) => (Math.hypot(x, z) < 20 ? 0 : 20)),
      RESOLUTION,
      SIZE,
    );
    expect(at(visibility, centre, centre)).toBeCloseTo(0.5, 1);
  });

  it("shades a valley floor below its open ridge", () => {
    // A V-shaped trench along z with 30° walls, 40 m deep.
    const visibility = skyVisibility(
      field((x) => Math.min(Math.abs(x) * Math.tan(Math.PI / 6), 40)),
      RESOLUTION,
      SIZE,
    );
    const floor = at(visibility, centre, centre);
    const rim = at(visibility, centre, centre + Math.round(80 / SPACING));
    expect(floor).toBeLessThan(0.9);
    expect(floor).toBeGreaterThan(0.6);
    expect(rim).toBeGreaterThan(0.97);
  });

  it("does not let the floor below a steep face occlude it: the lighting counts that ground", () => {
    // A 72° face from a flat floor at x < 0 to a plateau at x > 20; the vertex is halfway up.
    const visibility = skyVisibility(
      field((x) => Math.min(Math.max(x * 3, 0), 60)),
      RESOLUTION,
      SIZE,
    );
    expect(at(visibility, centre, centre + Math.round(10 / SPACING))).toBeGreaterThan(0.97);
  });

  it("refuses heights that do not match the grid", () => {
    expect(() => skyVisibility(new Float32Array(10), RESOLUTION, SIZE)).toThrow(RangeError);
  });
});
