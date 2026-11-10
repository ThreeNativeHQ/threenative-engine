import { describe, expect, it } from "vitest";
import { shoreField } from "../src/world.js";

/**
 * A 41-node strip, 1 m per cell, across x: open sea 5 m deep (x 0-14), a dry sand bar (x 15-16),
 * a lagoon 4 m deep (x 17-30) and a beach (x 31-40). Sea level 0.
 */
function coast(): Float32Array {
  const n = 41;
  const heights = new Float32Array(n * n);
  for (let row = 0; row < n; row++)
    for (let col = 0; col < n; col++)
      heights[row * n + col] = col <= 14 ? -5 : col <= 16 ? 1 : col <= 30 ? -4 : 2;
  return heights;
}

const at = (row: number, col: number) => row * 41 + col;

describe("shoreField", () => {
  it("exposes the open sea, never a lagoon behind a dry bar", () => {
    const { exposed } = shoreField(coast(), 41, 40, 0);
    expect(exposed[at(20, 5)]).toBe(1);
    expect(exposed[at(20, 14)]).toBe(1);
    expect(exposed[at(20, 15)]).toBe(0);
    // The lagoon reaches the grid's top and bottom rows, so it is open water there: only its
    // middle, behind the bar on every side, is measured.
    const sheltered = shoreField(coast(), 41, 40, 0, { openDepth: 4.5 });
    expect(sheltered.exposed[at(20, 24)]).toBe(0);
    expect(sheltered.exposed[at(20, 5)]).toBe(1);
  });

  it("measures metres to the nearest dry node", () => {
    const { distance } = shoreField(coast(), 41, 40, 0);
    expect(distance[at(20, 15)]).toBe(0);
    expect(distance[at(20, 14)]).toBe(1);
    expect(distance[at(20, 10)]).toBe(5);
    expect(distance[at(20, 23)]).toBe(7);
  });

  it("throws on a grid that does not match its resolution", () => {
    expect(() => shoreField(new Float32Array(10), 4, 3, 0)).toThrow("TN_SHORE_FIELD_INVALID");
    expect(() => shoreField(coast(), 41, 0, 0)).toThrow("TN_SHORE_FIELD_INVALID");
  });
});
