import { beforeEach, describe, expect, it, vi } from "vitest";
import { GridTexture, Value, cpuTSL } from "./temporal-resolve-cpu-grid.js";
const state = vi.hoisted(() => ({ uv: [0.5625, 0.5625] }));
vi.mock("three/tsl", async () => ({ ...cpuTSL, uv: () => new Value(state.uv) }));
import { createExperimentalTemporalResolve } from "../templates/starter/src/render/temporalResolve.js";
import { reconstructNeighbourhood } from "../templates/starter/src/render/temporalResolveMath.js";

beforeEach(() => {
  state.uv = [0.5625, 0.5625];
});

function coldResolve(
  width: number,
  height: number,
  current: GridTexture,
  blend: "ordinary" | "luminance",
) {
  const history = new GridTexture(8, 8, () => [1, 0, 0, 1]);
  expect(current.width).toBe(width);
  expect(current.height).toBe(height);
  const source = {
    beautyNode: current,
    _historyRenderTarget: { texture: history },
    maxVelocityLength: 128,
    useSubpixelCorrection: true,
  };
  const rejection = {
    historyValidity: () => ({
      get: (key: string) =>
        ({
          hasValidHistory: new Value([0]),
          historyUV: new Value(state.uv),
          offsetUV: new Value([0, 0]),
        })[key],
    }),
  };
  return createExperimentalTemporalResolve(
    source as never,
    {} as never,
    new Value([0.25, -1 / 6]) as never,
    "linear",
    blend,
    rejection as never,
  ) as unknown as Value;
}

describe("current reconstruction at a native display axis", () => {
  it("retains the four-argument Gaussian helper contract and both-reduced weights", () => {
    const current = new GridTexture(8, 4, (x) =>
      x === 4 ? [0.2, 0.4, 0.6, 1] : x === 3 ? [4, 2, 1, 1] : [0, 0, 0, 1],
    );
    const sample = (display?: Value) =>
      (
        reconstructNeighbourhood(
          current as never,
          new Value(state.uv) as never,
          new Value([8, 4]) as never,
          new Value([0.25, -1 / 6]) as never,
          display as never,
        ) as unknown as {
          get(name: string): Value;
        }
      ).get("color").values;
    const weight = (delta: number) => Math.exp(-2.29 * delta ** 2);
    const expected =
      (4 * weight(0.75) + 0.2 * weight(-0.25)) / (weight(0.75) + weight(-0.25) + weight(-1.25));
    expect(sample()[0]).toBeCloseTo(expected, 12);
    expect(sample(new Value([16, 8]))).toEqual(sample());
    // A larger axis is a resampling axis too, rather than silently treated as native.
    expect(sample(new Value([4, 8]))).toEqual(sample());
  });
  for (const blend of ["ordinary", "luminance"] as const) {
    it(`does not import a neighbouring native column (${blend})`, () => {
      // Pixel4 owns its jittered point4.75. Column3's lit point3.75 belongs to pixel3;
      // reducing height does not license horizontal current-colour reconstruction.
      const current = new GridTexture(8, 4, (x) => (x === 3 ? [4, 2, 1, 1] : [0, 0, 0, 1]));
      for (const channel of coldResolve(8, 4, current, blend).values.slice(0, 3))
        expect(channel).toBeCloseTo(0, 8);
    });
    it(`does not import a neighbouring native row (${blend})`, () => {
      const current = new GridTexture(4, 8, (_x, y) => (y === 3 ? [1, 2, 4, 1] : [0, 0, 0, 1]));
      for (const channel of coldResolve(4, 8, current, blend).values.slice(0, 3))
        expect(channel).toBeCloseTo(0, 8);
    });
    it(`retains a current native column beside an HDR neighbour (${blend})`, () => {
      const current = new GridTexture(8, 4, (x) =>
        x === 4 ? [0.2, 0.4, 0.6, 1] : x === 3 ? [4, 2, 1, 1] : [0, 0, 0, 1],
      );
      const output = coldResolve(8, 4, current, blend).values;
      for (const [index, expected] of [0.2, 0.4, 0.6].entries())
        expect(output[index]).toBeCloseTo(expected, 8);
    });
  }
});
