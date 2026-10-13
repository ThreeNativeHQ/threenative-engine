import { describe, expect, it } from "vitest";
import { terrainHeight } from "../../../examples/abyss-framework/src/world/terrainSampler.js";
import { evaluateWorldTopology } from "../../playtest/src/evaluators/world-gameplay.js";
import { summarizeWorldTopology } from "../src/world-topology.js";
import { Heightfield } from "../src/world.js";

describe("summarizeWorldTopology", () => {
  it("the terrain probe's canonical kilometre field meets every landform floor", () => {
    const field = Heightfield.fromSampler({
      columns: 1025,
      rows: 1025,
      width: 1024,
      depth: 1024,
      origin: { x: 0, z: 0 },
      sampleHeight: terrainHeight,
      worldPasses: {
        gpu: false,
        dispatchBudget: 4,
        erosion: {
          depositionRate: 0.35,
          erosionRate: 0.22,
          evaporation: 0.04,
          iterations: 4,
          rainfall: 0.08,
          sedimentCapacity: 0.7,
          timeStep: 0.05,
        },
      },
    });
    try {
      const result = evaluateWorldTopology({
        columns: field.columns,
        rows: field.rows,
        width: field.width,
        depth: field.depth,
        heights: field.heights,
        flow: field.flow,
      });
      expect(result.failed, JSON.stringify(result.metrics)).toEqual([]);
    } finally {
      field.detach();
    }
  });

  it("orders a hand-computed ridge as 2, a flat field as 1", () => {
    // A 3x3 valley: both sides drain into the bottom-middle outlet, two first-order
    // tributaries meeting there raise its Horton-Strahler order to 2.
    const field = {
      rows: 3,
      columns: 3,
      width: 1024,
      depth: 1024,
      heights: [3, 2, 3, 2, 1, 2, 1, 0, 1],
      flow: [1, 1, 1, 1, 1, 1, 1, 1, 1],
    };
    const summary = summarizeWorldTopology(field);
    expect(summary.maxHortonStrahlerOrder).toBe(2);

    const flat = { ...field, heights: [1, 1, 1, 1, 1, 1, 1, 1, 1] };
    expect(summarizeWorldTopology(flat).maxHortonStrahlerOrder).toBe(1);
  });

  it("throws on every malformed field shape", () => {
    const good = {
      rows: 3,
      columns: 3,
      width: 1024,
      depth: 1024,
      heights: [3, 2, 3, 2, 1, 2, 1, 0, 1],
      flow: [1, 1, 1, 1, 1, 1, 1, 1, 1],
    };
    expect(() => summarizeWorldTopology({ ...good, rows: 1 })).toThrow(
      /rows must be integers of at least 2/,
    );
    expect(() => summarizeWorldTopology({ ...good, columns: 1 })).toThrow(
      /columns must be integers of at least 2/,
    );
    expect(() => summarizeWorldTopology({ ...good, heights: [1, 2, 3] })).toThrow(
      /heights must contain rows times columns samples/,
    );
    expect(() => summarizeWorldTopology({ ...good, flow: [1, 1] })).toThrow(
      /flow must contain rows times columns samples/,
    );
    expect(() =>
      summarizeWorldTopology({ ...good, flow: [1, 1, 1, 1, 1, 1, 1, 1, Number.NaN] }),
    ).toThrow(/flow samples must be finite values from 0 through 1/);
    expect(() => summarizeWorldTopology({ ...good, flow: [1, 1, 1, 1, 1, 1, 1, 1, 2] })).toThrow(
      /flow samples must be finite values from 0 through 1/,
    );
    expect(() =>
      summarizeWorldTopology({ ...good, heights: [3, 2, 3, 2, 1, 2, 1, 0, Number.NaN] }),
    ).toThrow(/height sample is missing or not finite/);
  });
});
