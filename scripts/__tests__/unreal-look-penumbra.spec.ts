import { describe, expect, it } from "vitest";
import { floorEdges, matchedWidths } from "../unreal-look/penumbra.js";

const WIDTH = 160;
/** One row repeated, lit 1.0 on the left, 0.1 on the right, a linear ramp `ramp` px wide at x = 80. */
function image(ramp: number, lit = 1, dark = 0.1) {
  const row = Float64Array.from({ length: WIDTH }, (_, x) => {
    const t = Math.min(1, Math.max(0, (x - 80) / Math.max(ramp, 1e-6)));
    return lit + (dark - lit) * t;
  });
  const lum = new Float64Array(WIDTH * 16);
  for (let y = 0; y < 16; y++) lum.set(row, y * WIDTH);
  return { lum, floor: new Uint8Array(WIDTH * 16).fill(1) };
}

describe("floorEdges", () => {
  it("reads the 10 to 90 percent width of a linear ramp", () => {
    const { lum, floor } = image(5);
    const edges = floorEdges(lum, WIDTH, 16, floor);
    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges) expect(edge.width).toBeCloseTo(4, 0);
  });

  it("separates a soft edge from a hard one", () => {
    const hard = image(1);
    const soft = image(9);
    const a = floorEdges(hard.lum, WIDTH, 16, hard.floor);
    const b = floorEdges(soft.lum, WIDTH, 16, soft.floor);
    expect(matchedWidths(a, b).other / matchedWidths(a, b).unreal).toBeGreaterThan(5);
  });

  it("finds no edge in a flat floor or in a step weaker than 35 percent", () => {
    const flat = image(4, 1, 1);
    const weak = image(4, 1, 0.8);
    expect(floorEdges(flat.lum, WIDTH, 16, flat.floor)).toEqual([]);
    expect(floorEdges(weak.lum, WIDTH, 16, weak.floor)).toEqual([]);
  });

  it("ignores pixels outside the floor mask", () => {
    const { lum } = image(4);
    expect(floorEdges(lum, WIDTH, 16, new Uint8Array(WIDTH * 16))).toEqual([]);
  });
});
