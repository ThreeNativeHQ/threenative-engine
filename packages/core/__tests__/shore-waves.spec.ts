// PRD-766 P1.1: the shore-wave bake against an answer worked out on paper.
//
// A plane beach is the one bathymetry with a closed form: water depth grows linearly with distance
// offshore, so a first-order shallow-water front takes tau(x) = 2/sqrt(g s) * (sqrt(shore) -
// sqrt(shore - x)) seconds to reach x, its height follows Green's law as depth^-1/4, and it stops
// growing at 0.42 of the water under it. A bar that breaks the surface is the case with no answer
// on paper and one on the water: no front at all behind it.
import { describe, expect, it } from "vitest";
import { bakeShoreWaves } from "../src/ocean/shore.js";

const GRAVITY = 9.81;
const RESOLUTION = 257;
const SIZE = 512;
const CELL = SIZE / (RESOLUTION - 1);
const LEVEL = 0;
/** 5% beach: 20 m of water at the open-sea rim, dry land at column 200. */
const SLOPE = 0.05;
const SHORE_COLUMN = 200;
const INCIDENT = 1;

/**
 * A plane beach: water shallowing east from 20 m at the western rim to the waterline, dry land east
 * of it, and land along the north and south edges so the only way in is from open water to the west.
 */
function planeBeach(): Float32Array {
  const heights = new Float32Array(RESOLUTION * RESOLUTION);
  for (let row = 0; row < RESOLUTION; row += 1) {
    const wall = row === 0 || row === RESOLUTION - 1;
    for (let column = 0; column < RESOLUTION; column += 1) {
      const depth = column < SHORE_COLUMN ? SLOPE * (SHORE_COLUMN - column) * CELL : 0;
      heights[row * RESOLUTION + column] = wall ? 5 : LEVEL - depth;
    }
  }
  return heights;
}

/** tau at column `column` on that beach, worked out by integrating dx/sqrt(g h) from the rim. */
function analyticTravel(column: number): number {
  const shore = SHORE_COLUMN * CELL;
  const distance = column * CELL;
  return (2 / Math.sqrt(GRAVITY * SLOPE)) * (Math.sqrt(shore) - Math.sqrt(shore - distance));
}

function depthAt(column: number): number {
  return column < SHORE_COLUMN ? SLOPE * (SHORE_COLUMN - column) * CELL : 0;
}

/**
 * An enclosed lagoon: water everywhere inside a dry border, one gate in the western border to open
 * water, and a bar that breaks the surface running the full height of the field.
 */
function barredLagoon(): Float32Array {
  const bar = 128;
  const gate = Math.floor(RESOLUTION / 2);
  const heights = new Float32Array(RESOLUTION * RESOLUTION);
  for (let row = 0; row < RESOLUTION; row += 1) {
    for (let column = 0; column < RESOLUTION; column += 1) {
      const border =
        row === 0 || column === 0 || row === RESOLUTION - 1 || column === RESOLUTION - 1;
      const open = column === 0 && row === gate;
      heights[row * RESOLUTION + column] = column === bar || (border && !open) ? 2 : LEVEL - 5;
    }
  }
  return heights;
}

describe("bakeShoreWaves", () => {
  const field = bakeShoreWaves(planeBeach(), RESOLUTION, SIZE, LEVEL, { incidentHeight: INCIDENT });
  const middle = Math.floor(RESOLUTION / 2);
  const at = (column: number): number => middle * RESOLUTION + column;

  it("arrives when the shallow-water integral says it does", () => {
    for (const column of [50, 100, 150]) {
      const mine = field.travel[at(column)] as number;
      const analytic = analyticTravel(column);
      expect(
        Math.abs(mine - analytic) / analytic,
        `column ${column}: ${mine.toFixed(3)} s against ${analytic.toFixed(3)} s`,
      ).toBeLessThan(0.02);
    }
    // The rim is open water, so a front is already there.
    expect(field.travel[at(0)]).toBe(0);
  });

  it("runs the front at the shore, not out to sea", () => {
    for (const column of [50, 100, 150]) {
      expect(field.directionX[at(column)] as number).toBeGreaterThan(0.99);
      expect(Math.abs(field.directionZ[at(column)] as number)).toBeLessThan(0.02);
      expect(field.fade[at(column)] as number).toBeGreaterThan(0.9);
    }
  });

  it("shoals by Green's law on a straight coast", () => {
    // The deepest water in the field is the reference: 20 m at the western rim.
    const reference = depthAt(0);
    for (const column of [100, 130, 150]) {
      const expected = ((depthAt(column) / reference) ** -0.25) as number;
      const mine = field.shoaling[at(column)] as number;
      expect(
        Math.abs(mine - expected) / expected,
        `column ${column}: ${mine.toFixed(4)} against ${expected.toFixed(4)}`,
      ).toBeLessThan(0.05);
    }
  });

  it("stops the crest at 0.42 of the water under it", () => {
    const heights = planeBeach();
    let capped = 0;
    for (let cell = 0; cell < field.height.length; cell += 1) {
      const depth = LEVEL - (heights[cell] as number);
      const height = field.height[cell] as number;
      expect(height).toBeLessThanOrEqual(Math.max(0, depth) * 0.42 + 1e-6);
      if (depth > 0 && Math.abs(height - depth * 0.42) < 1e-6) capped += 1;
    }
    // The shallow band is where the limit binds rather than the shoaling.
    expect(capped).toBeGreaterThan(0);
    // ... and it binds exactly where the shoaled crest would have stood taller than the water can.
    const shallow = at(SHORE_COLUMN - 4);
    expect(field.height[shallow] as number).toBeCloseTo(depthAt(SHORE_COLUMN - 4) * 0.42, 6);
  });

  it("gives land no front and no crest", () => {
    const dry = at(RESOLUTION - 2);
    expect(Number.isFinite(field.travel[dry] as number)).toBe(false);
    expect(field.height[dry]).toBe(0);
    expect(field.fade[dry]).toBe(0);
  });

  it("sends no front past a bar that breaks the surface", () => {
    const lagoon = bakeShoreWaves(barredLagoon(), RESOLUTION, SIZE, LEVEL, {
      incidentHeight: INCIDENT,
    });
    const middle = Math.floor(RESOLUTION / 2);
    // Open water west of the bar: the gate let a front in.
    expect(Number.isFinite(lagoon.travel[middle * RESOLUTION + 40] as number)).toBe(true);
    expect(lagoon.height[middle * RESOLUTION + 40] as number).toBeGreaterThan(0);
    // Behind it: no front, no crest, and a fade of zero rather than a front that died quietly.
    for (const column of [140, 180, 250]) {
      const cell = middle * RESOLUTION + column;
      expect(Number.isFinite(lagoon.travel[cell] as number), `column ${column}`).toBe(false);
      expect(lagoon.height[cell]).toBe(0);
      expect(lagoon.fade[cell]).toBe(0);
    }
  });

  it("refuses malformed input", () => {
    const heights = planeBeach();
    expect(() =>
      bakeShoreWaves(heights, RESOLUTION, SIZE, Number.NaN, { incidentHeight: 1 }),
    ).toThrow(/level/);
    expect(() => bakeShoreWaves(heights, 1, SIZE, LEVEL, { incidentHeight: 1 })).toThrow(
      /resolution/,
    );
    expect(() =>
      bakeShoreWaves(heights.subarray(0, 4), RESOLUTION, SIZE, LEVEL, { incidentHeight: 1 }),
    ).toThrow(/heights/);
    expect(() => bakeShoreWaves(heights, RESOLUTION, SIZE, LEVEL, { incidentHeight: 0 })).toThrow(
      /incidentHeight/,
    );
    const broken = new Float32Array(4);
    broken[2] = Number.NaN;
    expect(() => bakeShoreWaves(broken, 2, SIZE, LEVEL, { incidentHeight: 1 })).toThrow(/finite/);
  });
});
