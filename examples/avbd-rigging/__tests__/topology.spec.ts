import { describe, expect, it } from "vitest";
import { buildRiggingTopology, referenceRigging } from "../src/physics/topology.js";

function first<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error("Rigging test fixture must not be empty.");
  return value;
}

describe("bounded rigging construction", () => {
  it("constructs the original workload deterministically with exact masses and pins", () => {
    const spec = referenceRigging();
    const a = buildRiggingTopology(spec);
    const b = buildRiggingTopology(spec);
    expect(a.positions).toEqual(b.positions);
    expect(a.edges).toEqual(b.edges);
    expect(a.ranges.map(({ name, count }) => [name, count])).toEqual([
      ["sail", 1024],
      ["flag", 256],
      ["rope-0", 65],
      ["rope-1", 65],
      ["rope-2", 65],
      ["rope-3", 65],
    ]);
    expect(a.positions.length / 3).toBe(1540);
    expect(a.edges.length / 2).toBe(5092);
    expect(a.anchors.length).toBe(56);
    expect(a.positions.every(Number.isFinite)).toBe(true);
    for (const range of a.ranges) {
      const mass = a.masses
        .subarray(range.offset, range.offset + range.count)
        .reduce((sum, value) => sum + value, 0);
      expect(mass).toBeCloseTo(range.totalMass, 5);
    }
    expect((a.positions[31 * 3] ?? Number.NaN) - (a.positions[0] ?? Number.NaN)).toBe(4);
    expect((a.positions[31 * 32 * 3 + 1] ?? Number.NaN) - (a.positions[1] ?? Number.NaN)).toBe(-4);
    expect(a.edges.every((index) => index < 1540)).toBe(true);
    expect(a.restLengths.every((length) => length > 0 && Number.isFinite(length))).toBe(true);
  });

  it("rejects oversized grids before allocation and names the affected count", () => {
    const spec = referenceRigging();
    first(spec.patches).columns = 100_000;
    expect(() => buildRiggingTopology(spec)).toThrow(/sail.*particles.*3200000.*2048/);
  });

  it("enforces cumulative particle and constraint capacities", () => {
    expect(() =>
      buildRiggingTopology(referenceRigging(), { particles: 1500, constraints: 8192 }),
    ).toThrow(/particles.*1540.*1500/);
    expect(() =>
      buildRiggingTopology(referenceRigging(), { particles: 2048, constraints: 5000 }),
    ).toThrow(/constraints.*5092.*5000/);
  });

  it.each([-1, 1024, 0.5, Number.NaN])("rejects invalid pin %s by patch name", (pin) => {
    const spec = referenceRigging();
    first(spec.patches).pinned = [pin];
    expect(() => buildRiggingTopology(spec)).toThrow(/sail.*pinned/);
  });

  it("rejects repeated pins and names rather than dropping data", () => {
    const spec = referenceRigging();
    first(spec.patches).pinned = [0, 0];
    expect(() => buildRiggingTopology(spec)).toThrow(/sail.*duplicate.*pin/);
    const duplicate = referenceRigging();
    first(duplicate.ropes).name = "sail";
    expect(() => buildRiggingTopology(duplicate)).toThrow(/duplicate.*sail/);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid mass %s", (mass) => {
    const spec = referenceRigging();
    first(spec.ropes).totalMass = mass;
    expect(() => buildRiggingTopology(spec)).toThrow(/rope-0.*totalMass/);
  });

  it("rejects nonfinite coordinates and zero-length ropes", () => {
    const spec = referenceRigging();
    first(spec.ropes).end[2] = Number.NaN;
    expect(() => buildRiggingTopology(spec)).toThrow(/rope-0.*end/);
    const zero = referenceRigging();
    first(zero.ropes).end = [...first(zero.ropes).start];
    expect(() => buildRiggingTopology(zero)).toThrow(/rope-0.*length/);
  });

  it("rejects invalid iteration, collider and catch-up limits without GPU allocation", () => {
    const spec = referenceRigging();
    for (const [field, value] of [
      ["iterations", 25],
      ["colliders", 17],
      ["catchUpSteps", 0],
    ] as const) {
      expect(() => buildRiggingTopology(spec, { [field]: value })).toThrow(new RegExp(field));
    }
  });
  it("rejects objects placed in the wrong topology collection", () => {
    const ropeAsPatch = referenceRigging();
    ropeAsPatch.patches = [
      first(ropeAsPatch.ropes) as unknown as (typeof ropeAsPatch.patches)[number],
    ];
    ropeAsPatch.ropes = [];
    expect(() => buildRiggingTopology(ropeAsPatch)).toThrow(/patches.*columns/);
    const patchAsRope = referenceRigging();
    patchAsRope.ropes = [
      first(patchAsRope.patches) as unknown as (typeof patchAsRope.ropes)[number],
    ];
    patchAsRope.patches = [];
    expect(() => buildRiggingTopology(patchAsRope)).toThrow(/ropes.*segments/);
  });

  it("rejects unknown limit fields rather than silently accepting an override", () => {
    expect(() => buildRiggingTopology(referenceRigging(), { unexpected: 4 } as never)).toThrow(
      /unknown.*unexpected/,
    );
  });

  it("maps every local pin to the exact global index", () => {
    const topology = buildRiggingTopology(referenceRigging());
    expect([...topology.anchors]).toEqual([
      ...Array.from({ length: 32 }, (_, i) => i),
      ...Array.from({ length: 16 }, (_, i) => 1024 + i * 16),
      1280,
      1344,
      1345,
      1409,
      1410,
      1474,
      1475,
      1539,
    ]);
  });

  it("names Float32 coordinate overflow, collapsed edges and mass underflow", () => {
    const overflow = referenceRigging();
    first(overflow.patches).origin[0] = 1e39;
    expect(() => buildRiggingTopology(overflow)).toThrow(/sail.*Float32/);
    const collapse = referenceRigging();
    first(collapse.patches).origin[0] = 1e20;
    expect(() => buildRiggingTopology(collapse)).toThrow(/sail.*restLength/);
    const underflow = referenceRigging();
    first(underflow.ropes).totalMass = 1e-50;
    expect(() => buildRiggingTopology(underflow)).toThrow(/rope-0.*mass.*Float32/);
  });
  it("names a finite total mass that overflows Float32 per-vertex storage", () => {
    const spec = referenceRigging();
    first(spec.patches).totalMass = Number.MAX_VALUE;
    expect(() => buildRiggingTopology(spec)).toThrow(/sail.*mass.*Float32/);
  });
});
