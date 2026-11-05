import { describe, expect, it } from "vitest";
import { Heightfield, WATER_RIBBON_REACH, WaterBodies } from "../src/world.js";

/** A straight river running north to south through (0, -50): surface 10 m, 2 m wide, 3 m/s. */
const RIVER = {
  flow: 3,
  points: [
    [0, 10, 0],
    [0, 10, -100],
  ] as const,
  width: 2,
};

/** A ground that rises `rise` metres per metre away from `centre`: a cone to measure a basin in. */
function cone(centre: readonly [number, number], rise: number): Heightfield {
  return Heightfield.fromSampler({
    columns: 81,
    depth: 400,
    origin: { x: 0, z: 0 },
    rows: 81,
    sampleHeight: (x, z) => Math.hypot(x - centre[0], z - centre[1]) * rise,
    width: 400,
  });
}

describe("WaterBodies", () => {
  it("stands a river across `WATER_RIBBON_REACH` widths of its own bed, and stops there", () => {
    const bodies = new WaterBodies({ ribbons: [RIVER] });
    const reach = RIVER.width * WATER_RIBBON_REACH;
    expect(bodies.surfaceAt(0, -50)).toBe(10);
    expect(bodies.surfaceAt(reach - 0.1, -50)).toBe(10);
    expect(bodies.surfaceAt(reach + 0.1, -50)).toBeUndefined();
    expect(bodies.footprintAt(reach, -50)).toEqual({ kind: "river", level: 10 });
    expect(bodies.footprintAt(reach + 0.1, -50)).toBeUndefined();
  });

  it("carries a swimmer downstream at the ribbon's flow, writing into the caller's object", () => {
    const bodies = new WaterBodies({ ribbons: [RIVER] });
    const out = { x: Number.NaN, z: Number.NaN };
    const current = bodies.currentAt(0, -50, out);
    expect(current).toBe(out);
    expect(out).toEqual({ x: 0, z: -3 });
    expect(bodies.currentAt(40, -50, out)).toBeUndefined();
  });

  it("lets a lake's higher surface beat the river at its last station, and stands still there", () => {
    const bodies = new WaterBodies({
      field: cone([0, -100], 0.1),
      lakes: [{ at: [0, -100], level: 12, margin: 1.12, radius: 30 }],
      ribbons: [RIVER],
    });
    expect(bodies.footprintAt(0, -100)).toEqual({ kind: "lake", level: 12 });
    expect(bodies.surfaceAt(0, -100)).toBe(12);
    expect(bodies.currentAt(0, -100)).toEqual({ x: 0, z: 0 });
    // Upstream of the lake the river still flows at its own height.
    expect(bodies.footprintAt(0, -50)).toEqual({ kind: "river", level: 10 });
  });

  it("caps a lake's footprint at the radius its row names", () => {
    const bodies = new WaterBodies({
      field: cone([0, -100], 0.1),
      lakes: [{ at: [0, -100], level: 12, margin: 1.12, radius: 30 }],
    });
    expect(bodies.surfaceAt(0, -130)).toBe(12);
    expect(bodies.surfaceAt(0, -130.1)).toBeUndefined();
  });

  it("measures a lake's footprint from its basin when the cap is further out", () => {
    // The cone crosses 12 m at 120 m out, so the water reaches 120 * 1.12 = 134.4 m, under a cap of 200.
    const bodies = new WaterBodies({
      field: cone([0, -100], 0.1),
      lakes: [{ at: [0, -100], level: 12, margin: 1.12, radius: 200 }],
    });
    expect(bodies.surfaceAt(0, -234)).toBe(12);
    expect(bodies.surfaceAt(0, -234.5)).toBeUndefined();
  });

  it("stands a sea still at its level, and stops it at its extent", () => {
    const bodies = new WaterBodies({ ocean: { extent: 100, level: 1.5 } });
    expect(bodies.surfaceAt(99, -99)).toBe(1.5);
    expect(bodies.currentAt(0, 0)).toEqual({ x: 0, z: 0 });
    expect(bodies.footprintAt(-100, 100)).toEqual({ kind: "ocean", level: 1.5 });
    expect(bodies.surfaceAt(100.5, 0)).toBeUndefined();
    expect(bodies.footprintAt(0, -100.5)).toBeUndefined();
  });

  it("throws on a row it cannot answer from", () => {
    const rows = (patch: Record<string, unknown>): WaterBodies =>
      new WaterBodies({ ribbons: [RIVER], ...patch });
    expect(() => rows({ ribbons: [{ ...RIVER, points: [[0, 10, 0]] }] })).toThrow();
    expect(() => rows({ ribbons: [{ ...RIVER, width: 0 }] })).toThrow();
    expect(() => rows({ ribbons: [{ ...RIVER, flow: Number.NaN }] })).toThrow();
    expect(() =>
      rows({
        ribbons: [
          {
            ...RIVER,
            points: [
              [0, 10, 0],
              [Number.NaN, 10, -100],
            ],
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      rows({ lakes: [{ at: [0, -100], level: 12, margin: 1.12, radius: 30 }] }),
    ).toThrow();
    expect(() =>
      rows({
        field: cone([0, -100], 0.1),
        lakes: [{ at: [0, -100], level: 12, margin: 1.12, radius: 0 }],
      }),
    ).toThrow();
    expect(() =>
      rows({
        field: cone([0, -100], 0.1),
        lakes: [{ at: [0, -100], level: Number.NaN, margin: 1.12, radius: 30 }],
      }),
    ).toThrow();
    expect(() => rows({ ocean: { extent: 0, level: 1.5 } })).toThrow();
    expect(() => rows({ ocean: { extent: 100, level: Number.NaN } })).toThrow();
  });
});
