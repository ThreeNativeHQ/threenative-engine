import { describe, expect, it } from "vitest";
import {
  Heightfield,
  WATER_RIBBON_REACH,
  WaterBodies,
  lakeSurfaceGeometry,
  riverRibbonGeometry,
} from "../src/world.js";

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
function drawnAt(
  geometry: NonNullable<ReturnType<typeof lakeSurfaceGeometry>>,
  x: number,
  z: number,
): boolean {
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
  it("draws no water past an end where the ground falls away from the bed", () => {
    // The bed is 9 m to the head at z = 0, then the ground falls 0.2 m per metre past it: water
    // standing there at the head's 10 m would hang over dry ground, as at the tundra meltwater head.
    const field = Heightfield.fromSampler({
      columns: 161,
      depth: 400,
      origin: { x: 0, z: 0 },
      rows: 161,
      sampleHeight: (x: number, z: number) => (Math.abs(x) <= 4 ? 9 : 12) - Math.max(0, z) * 0.2,
      width: 400,
    });
    const geometry = riverRibbonGeometry([RIVER], field);
    const reach = RIVER.width * WATER_RIBBON_REACH;
    expect(drawnAt(geometry, 0, reach * 0.5)).toBe(false);
    expect(drawnAt(geometry, 0, -1)).toBe(true);
    // The tail, where the bed carries on level, keeps its cap.
    expect(drawnAt(geometry, 0, -100 - reach * 0.5)).toBe(true);
  });

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

/** A bowl 40 m across: ground at 5 m in the middle, rising one metre per 4 m out, level at 8 m. */
function bowl(): Heightfield {
  return Heightfield.fromSampler({
    columns: 121,
    depth: 240,
    origin: { x: 0, z: 0 },
    rows: 121,
    sampleHeight: (x: number, z: number) => 5 + Math.hypot(x - 10, z + 6) / 4,
    width: 240,
  });
}

const LAKE = { at: [10, -6], level: 8, margin: 1.12, radius: 60 };

describe("lakeSurfaceGeometry", () => {
  it("draws water wherever WaterBodies floods the lake and the ground is under its level", () => {
    const field = bowl();
    const geometry = lakeSurfaceGeometry(LAKE, field);
    expect(geometry).toBeDefined();
    if (geometry === undefined) return;
    const water = new WaterBodies({ field, lakes: [LAKE] });
    let checked = 0;
    for (let x = -10; x <= 30; x += 1.5)
      for (let z = -26; z <= 14; z += 1.5) {
        if (water.footprintAt(x, z)?.kind !== "lake" || field.heightAt(x, z) >= LAKE.level)
          continue;
        checked += 1;
        expect(drawnAt(geometry, x, z), `(${x}, ${z})`).toBe(true);
      }
    expect(checked).toBeGreaterThan(100);
  });

  it("records each vertex's depth and stands every vertex at the level", () => {
    const field = bowl();
    const geometry = lakeSurfaceGeometry(LAKE, field, { maxDepth: 1.6, rings: 8, spokes: 12 });
    if (geometry === undefined) throw new Error("no lake");
    const position = geometry.getAttribute("position");
    const metres = geometry.getAttribute("metres");
    expect(metres.getX(0)).toBeCloseTo(1.6);
    for (let i = 0; i < position.count; i += 1) {
      expect(position.getY(i)).toBe(LAKE.level);
      const want = Math.min(
        1.6,
        Math.max(0, LAKE.level - field.heightAt(position.getX(i), position.getZ(i))),
      );
      expect(metres.getX(i)).toBeCloseTo(want, 5);
    }
  });

  it("returns nothing for a basin with no water at its level, and throws on bad options", () => {
    const field = bowl();
    expect(lakeSurfaceGeometry({ ...LAKE, level: 4 }, field)).toBeUndefined();
    expect(() => lakeSurfaceGeometry(LAKE, field, { spokes: 2 })).toThrow(
      "TN_LAKE_SURFACE_INVALID",
    );
    expect(() => lakeSurfaceGeometry(LAKE, field, { packing: 0 })).toThrow(
      "TN_LAKE_SURFACE_INVALID",
    );
  });
});
