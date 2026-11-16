import { HeightfieldCollar } from "@threenative/core/world";
import { expect, it, vi } from "vitest";
import {
  addStreamedGround,
  collarArithmeticHeight,
  collarDrawnHeight,
  collarSeamGap,
  createMorphedHeight,
} from "../src/starter.js";

/** The forest kit's own ring shape (2.1 km at 384 rings, spread 1.65), on a synthetic survey. */
const SIZE = 512;
const RESOLUTION = 257;
const RINGS = 384;
const CURVE = { power: 1.65, reach: 2100 } as const;
const HALF = SIZE / 2;

function collar(): HeightfieldCollar {
  return new HeightfieldCollar({
    resolution: RESOLUTION,
    size: SIZE,
    rings: RINGS,
    ringDistance: (ring) => (ring / RINGS) ** CURVE.power * CURVE.reach,
    walkBand: 200,
    height: ({ x, z }) => 4 + Math.sin(x / 47) * 2 + Math.cos(z / 61) * 1.5,
  });
}

/** The ground function the collar is built from; the square's survey joins it at the edge. */
const base = (x: number, z: number): number => 4 + Math.sin(x / 47) * 2 + Math.cos(z / 61) * 1.5;

/** The survey inside the square (it meets the collar at the edge), the collar's own surface past it. */
function survey(grid: HeightfieldCollar): (x: number, z: number) => number {
  return (x, z) => {
    const chebyshev = Math.max(Math.abs(x), Math.abs(z));
    if (chebyshev > HALF) return collarArithmeticHeight(grid, CURVE, x, z);
    // A dome that vanishes on the square's edge, so the survey meets the collar and still differs.
    return base(x, z) + 3 * (1 - (chebyshev / HALF) ** 2);
  };
}

/**
 * PRD-790: streamed tiles stand on the height the square and the collar draw. The tile shader finds
 * its collar triangle by arithmetic, so that arithmetic must agree with the drawn triangles it is a
 * stand-in for, everywhere a tile can stand.
 */
it("finds the collar's drawn triangle by arithmetic, as the tile shader does", () => {
  const grid = collar();
  let worst = 0;
  // A spiral from the square's edge out to the collar's rim, every heading.
  for (let i = 0; i < 20000; i += 1) {
    const angle = i * 2.399963;
    const reach = HALF + 1 + (i / 20000) * (CURVE.reach - 2);
    const x = Math.cos(angle) * reach;
    const z = Math.sin(angle) * reach;
    const drawn = collarDrawnHeight(grid, x, z);
    if (drawn === null) continue;
    worst = Math.max(worst, Math.abs(collarArithmeticHeight(grid, CURVE, x, z) - drawn));
  }
  expect(worst).toBeGreaterThan(0);
  expect(worst).toBeLessThanOrEqual(0.001);
});

/**
 * PRD-790 box 2: only the outermost tile of the streamed block slides onto the collar. Inside the
 * band the survey stands untouched; at the block's edge the tile vertex stands on the collar.
 */
it("slides the outer tile onto the collar only over its own band", () => {
  const grid = collar();
  const fine = survey(grid);
  const morphed = createMorphedHeight(grid, CURVE, fine, 0, 0, 288, 64);
  // Inside the square and inside the band: the survey, untouched.
  expect(morphed(64, 64)).toBe(fine(64, 64));
  expect(morphed(-200, 100)).toBe(fine(-200, 100));
  // At the band's inner edge the weight is still 0; at the block's edge it is 1.
  expect(morphed(224, 0)).toBe(fine(224, 0));
  for (const [x, z] of [
    [288, 0],
    [0, -288],
    [288, 288],
    [-288, 96],
  ] as const) {
    expect(morphed(x, z)).toBe(collarArithmeticHeight(grid, CURVE, x, z));
  }
});

/**
 * PRD-790: the tiles' square edge and the collar's coarser triangles must meet without a step. The
 * morph moves the tile vertices onto the collar; between them a collar fold can still cross a 2 m
 * edge, and that residual is what the scene reports, not hides.
 */
it("meets the collar with no step where the streamed tiles hand over", () => {
  const grid = collar();
  const fine = survey(grid);
  for (const [centreX, centreZ, half] of [
    [0, 0, 288],
    [64, 64, 128],
    [-128, 96, 192],
    [192, -192, 256],
  ] as const) {
    const morphed = createMorphedHeight(grid, CURVE, fine, centreX, centreZ, half, 64);
    const seam = collarSeamGap(grid, morphed, centreX, centreZ, half, 2);
    expect(seam.gap).toBeLessThanOrEqual(0.01);
    expect(seam.fold).toBeLessThanOrEqual(0.5);
  }
});

/**
 * The mechanism fails closed when a kit hands it no heightfield to stream: a one-sample grid or a
 * non-positive square cannot tile, and a silent fallback would draw a plane over the world.
 */
it("refuses a kit with no heightfield to stream, by name", () => {
  const options = {
    ctx: {} as never,
    name: "test",
    size: SIZE,
    resolution: RESOLUTION,
    height: () => 0,
    collar: collar(),
    curve: CURVE,
    reach: CURVE.reach,
    stream: {} as never,
    surface: {} as never,
    follow: {} as never,
    report: () => undefined,
  };
  for (const [size, resolution] of [
    [SIZE, 1],
    [SIZE, 0],
    [0, RESOLUTION],
    [-1, RESOLUTION],
  ] as const) {
    expect(() => addStreamedGround({ ...options, size, resolution })).toThrowError(
      /TN_STARTER_GROUND_DATA: test world: a .* grid over .* m cannot stream ground\./,
    );
  }
});

it("disposes nothing it never created when the grid is refused", () => {
  const dispose = vi.fn();
  const options = {
    ctx: { add: dispose } as never,
    name: "test",
    size: SIZE,
    resolution: 1,
    height: () => 0,
    collar: collar(),
    curve: CURVE,
    reach: CURVE.reach,
    stream: {} as never,
    surface: { dispose } as never,
    follow: {} as never,
    report: () => undefined,
  };
  expect(() => addStreamedGround(options)).toThrow();
  expect(dispose).not.toHaveBeenCalled();
});
