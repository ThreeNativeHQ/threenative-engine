import { describe, expect, it } from "vitest";
import { Heightfield, WATER_RIBBON_REACH, WaterBodies, riverRibbonGeometry } from "../src/world.js";

/** A river 2 m wide running north along x = 0 from z = 0 to z = -100, surface at 10 m. */
const RIVER = {
  flow: 1,
  points: [
    [0, 10, 0],
    [0, 10, -50],
    [0, 10, -100],
  ],
  width: 2,
};

/** Ground at 9 m within 4 m of x = 0 (the carved bed) and 12 m elsewhere (dry banks). */
function valley(): Heightfield {
  return Heightfield.fromSampler({
    columns: 161,
    depth: 400,
    origin: { x: 0, z: 0 },
    rows: 161,
    sampleHeight: (x: number) => (Math.abs(x) <= 4 ? 9 : 12),
    width: 400,
  });
}

/** Whether (x, z) lies inside a drawn triangle, seen from above. */
function drawnAt(geometry: ReturnType<typeof riverRibbonGeometry>, x: number, z: number): boolean {
  const position = geometry.getAttribute("position");
  const index = geometry.getIndex()?.array ?? [];
  const at = (i: number) => [position.getX(i), position.getZ(i)] as const;
  const side = (a: readonly number[], b: readonly number[]) =>
    ((b[0] ?? 0) - (a[0] ?? 0)) * (z - (a[1] ?? 0)) -
    ((b[1] ?? 0) - (a[1] ?? 0)) * (x - (a[0] ?? 0));
  for (let t = 0; t < index.length; t += 3) {
    const [a, b, c] = [at(index[t] ?? 0), at(index[t + 1] ?? 0), at(index[t + 2] ?? 0)];
    const s = [side(a, b), side(b, c), side(c, a)];
    if (s.every((v) => v >= 0) || s.every((v) => v <= 0)) return true;
  }
  return false;
}

describe("riverRibbonGeometry", () => {
  it("draws water past each end wherever WaterBodies floods it", () => {
    const field = valley();
    const geometry = riverRibbonGeometry([RIVER], field);
    const water = new WaterBodies({ field, ribbons: [RIVER] });
    const reach = RIVER.width * WATER_RIBBON_REACH;
    for (const [x, z] of [
      [0, reach * 0.5],
      [0, -100 - reach * 0.5],
      [1, 2],
    ] as const) {
      expect(water.surfaceAt(x, z)).toBe(10);
      expect(drawnAt(geometry, x, z)).toBe(true);
    }
  });

  it("drops quads dry on both rows and keeps a group per river", () => {
    const field = valley();
    const wide = riverRibbonGeometry(
      [RIVER, { ...RIVER, points: RIVER.points.map(([x = 0, y = 0, z = 0]) => [x, y, z - 160]) }],
      field,
      {
        reach: 8,
        columns: 33,
      },
    );
    expect(wide.groups).toHaveLength(2);
    // 8 widths reach 16 m out; the banks past 4 m stand above the surface and draw nothing.
    expect(drawnAt(wide, 12, -50)).toBe(false);
    expect(drawnAt(wide, 3, -50)).toBe(true);
    const depth = wide.getAttribute("metres");
    expect(Math.max(...Array.from(depth.array))).toBeLessThanOrEqual(1);
  });

  it("draws a river that ends at the field's edge, sampling the edge past it", () => {
    const geometry = riverRibbonGeometry(
      [
        {
          ...RIVER,
          points: [
            [0, 10, -150],
            [0, 10, -200],
          ],
        },
      ],
      valley(),
    );
    expect(drawnAt(geometry, 0, -199)).toBe(true);
  });

  it("refuses a river it cannot draw, by name", () => {
    expect(() => riverRibbonGeometry([{ points: [[0, 0, 0]], width: 2 }], valley())).toThrow(
      "TN_RIVER_RIBBON_INVALID",
    );
    expect(() => riverRibbonGeometry([RIVER], valley(), { columns: 1 })).toThrow(
      "TN_RIVER_RIBBON_INVALID",
    );
  });
});
