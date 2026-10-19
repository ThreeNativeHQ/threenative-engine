import { describe, expect, it } from "vitest";
import { hangingRigging } from "../src/game.js";
import { AvbdRigging } from "../src/physics/avbd-adapter.js";
import { riggingComparison } from "../src/physics/benchmark.js";
import { buildRiggingModel } from "../src/physics/model.js";
import { referenceRigging } from "../src/physics/topology.js";

describe("pinned secondary rigging construction", () => {
  it("constructs the actual game hanging-load path with four free rope ends", () => {
    const input = hangingRigging();
    const rigging = new AvbdRigging({
      input,
      proxies: [],
      snapshot: () => ({ anchors: [], proxies: [] }),
    });
    expect(input.ropes.map((rope) => rope.pinned)).toEqual([[0], [0], [0], [0]]);
    expect(rigging.model.solver.bodies).toHaveLength(1536);
    expect(rigging.model.anchors).toHaveLength(100);
    expect(rigging.model.solver.forces).toHaveLength(5188);
    expect(rigging.model.solver.bodies.reduce((sum, body) => sum + body.mass, 0)).toBeCloseTo(
      11.8,
      6,
    );
    expect(
      () =>
        new AvbdRigging({
          input,
          proxies: [],
          limits: { constraints: 5187 },
          snapshot: () => ({ anchors: [], proxies: [] }),
        }),
    ).toThrow(/constraints count 5188.*5187/);
  });

  it("applies pinned Windward stabilization to the real game with the required 60Hz clock", () => {
    const model = buildRiggingModel(hangingRigging(), []);
    const expected = {
      dt: 1 / 60,
      gravity: -9.81,
      iterations: 12,
      alpha: 0.95,
      betaLin: 10000,
      betaAng: 100,
      gamma: 0.999,
    };
    expect(model.solver).toMatchObject(expected);
    expect(riggingComparison.candidateParameters).toEqual(expected);
  });

  it("maps the frozen resolution to 1536 rigid pieces and preserves authored mass", () => {
    const model = buildRiggingModel(referenceRigging(), []);
    expect(model.solver.bodies).toHaveLength(1536);
    expect(model.anchors).toHaveLength(104);
    expect(model.solver.forces).toHaveLength(5192);
    expect(model.solver.bodies.reduce((n, b) => n + b.mass, 0)).toBeCloseTo(11.8, 6);
    expect(model.bodyIndices).toHaveLength(1540);
    expect(model.localPositions).toHaveLength(1540 * 3);
  });

  it("keeps the pinned donor z-up wind frame while round-tripping authored y-up points", () => {
    const model = buildRiggingModel(referenceRigging(), []);
    expect(Array.from(model.solver.bodies[0]?.positionLin ?? [])).toEqual([-2, -0, 7]);
    const first = model.solver.bodies[0];
    if (first === undefined) throw new Error("test sail body missing");
    expect(Array.from(first.positionAng)).toEqual([Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
  });

  it.each([
    { width: 1e10, totalMass: 1e38 },
    { width: 1, totalMass: 1e38 },
    { width: 1e20, totalMass: 1e-20 },
    { width: 1, totalMass: 1e-42 },
  ])("rejects derived Float32 overflow before storage allocation (%j)", ({ width, totalMass }) => {
    expect(() =>
      buildRiggingModel(
        {
          patches: [
            {
              name: "sail",
              columns: 2,
              rows: 2,
              width,
              height: width,
              origin: [0, 0, 0],
              totalMass,
              pinned: [],
            },
          ],
          ropes: [],
        },
        [],
      ),
    ).toThrow(/Rigging\.(body|joint)\[/);
  });

  it("rejects proxy capacity before any donor body is constructed", () => {
    const proxies = Array.from({ length: 17 }, (_, i) => ({
      name: `proxy-${i}`,
      size: [1, 1, 1] as [number, number, number],
      position: [0, 0, 0] as [number, number, number],
    }));
    expect(() => buildRiggingModel(referenceRigging(), proxies)).toThrow(/colliders count 17.*16/);
  });

  it("rejects invalid proxy dimensions, pose and colliding topology names", () => {
    for (const proxy of [
      { name: "wall", size: [0, 1, 1], position: [0, 0, 0] },
      { name: "wall", size: [1, 1, 1], position: [0, Number.NaN, 0] },
      { name: "sail", size: [1, 1, 1], position: [0, 0, 0] },
    ])
      expect(() =>
        buildRiggingModel(referenceRigging(), [
          proxy as {
            name: string;
            size: [number, number, number];
            position: [number, number, number];
          },
        ]),
      ).toThrow(/Rigging/);
  });

  it.each([
    { position: ["1", null, true] },
    { position: new Array(3) },
    { position: [false, 0, 0] },
  ])(
    "rejects coercible or sparse proxy coordinates before body construction (%j)",
    ({ position }) => {
      expect(() =>
        buildRiggingModel(referenceRigging(), [
          {
            name: "wall",
            size: [1, 1, 1],
            position: position as unknown as [number, number, number],
          },
        ]),
      ).toThrow(/Rigging.wall.position/);
    },
  );

  it("bounds actual joints including pins before GPU allocation", () => {
    expect(() => buildRiggingModel(referenceRigging(), [], { constraints: 5100 })).toThrow(
      /constraints count 5192.*5100/,
    );
  });
});
