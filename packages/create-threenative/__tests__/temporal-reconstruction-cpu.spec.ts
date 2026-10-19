import { beforeEach, describe, expect, it, vi } from "vitest";
import { GridTexture, Value, cpuTSL } from "./temporal-resolve-cpu-grid.js";
const uvState = vi.hoisted(() => ({ position: [0.5, 0.5] }));
vi.mock("three/tsl", async () => ({ ...cpuTSL, uv: () => new Value(uvState.position) }));
beforeEach(() => {
  uvState.position = [0.5, 0.5];
});
import { createExperimentalTemporalResolve } from "../templates/starter/src/render/temporalResolve.js";

import { reconstructNeighbourhood } from "../templates/starter/src/render/temporalResolveMath.js";

describe("actual authored resolve over synthetic texture inputs", () => {
  for (const blend of ["ordinary", "luminance"] as const) {
    it(`clips removed bright centre history on a black neighborhood (${blend})`, () => {
      // Current centre is revealed background .9; its surviving black neighbour and prior bright
      // centre both have depth .2. The inherited donor predicate and canLock therefore accept.
      // This case isolates what the authored colour graph does after that accepted decision.
      const current = new GridTexture(4, 4, () => [0, 0, 0, 1]);
      const previous = new GridTexture(8, 8, () => [1, 1, 1, 1]);
      const source = {
        beautyNode: current,
        _historyRenderTarget: { texture: previous },
        maxVelocityLength: 128,
        useSubpixelCorrection: true,
      };
      const rejection = {
        historyValidity: () => ({
          get: (key: string) =>
            ({
              hasValidHistory: new Value([1]),
              canLock: new Value([1]),
              historyUV: new Value([0.5, 0.5]),
              offsetUV: new Value([0, 0]),
            })[key],
        }),
      };
      const output = createExperimentalTemporalResolve(
        source as never,
        {} as never,
        new Value([0, 0]) as never,
        "linear",
        blend,
        rejection as never,
      ) as unknown as Value;
      for (const channel of output.values.slice(0, 3)) expect(channel).toBeCloseTo(0, 6);
    });
  }
});

describe("accepted history colour support at an actual display pixel centre", () => {
  for (const blend of ["ordinary", "luminance"] as const) {
    for (const stable of [false, true]) {
      it(`${stable ? "preserves constant green" : "clips equal-luminance red history"} (${blend})`, () => {
        // Pixel (2,2) of a 4×4 display: this is a fragment centre, not the between-pixel UV .5.
        // Validity is injected to isolate colour support after acceptance, not to prove depth.
        uvState.position = [0.625, 0.625];
        const green = 0.2;
        const redWithSameLuminance = (green * 0.7152) / 0.2126;
        const current = new GridTexture(4, 4, (x, y) =>
          stable || (x === 2 && y === 2) ? [0, green, 0, 1] : [0, 0, 0, 1],
        );
        const history = new GridTexture(4, 4, () =>
          stable ? [0, green, 0, 1] : [redWithSameLuminance, 0, 0, 1],
        );
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
                hasValidHistory: new Value([1]),
                historyUV: new Value(uvState.position),
                offsetUV: new Value([0, 0]),
              })[key],
          }),
        };
        expect(current.sample(new Value(uvState.position)).values[1]).toBe(green);
        expect(redWithSameLuminance * 0.2126).toBeCloseTo(green * 0.7152, 12);
        const output = createExperimentalTemporalResolve(
          source as never,
          {} as never,
          new Value([0, 0]) as never,
          "linear",
          blend,
          rejection as never,
        ) as unknown as Value;
        expect(output.values.every(Number.isFinite)).toBe(true);
        // The raw current taps contain zero red. Scalar luminance agreement cannot expand RGB support.
        expect(output.values[0]).toBeLessThan(1e-6);
        expect(output.values[1]).toBeGreaterThan(0);
        if (stable) expect(output.values[1]).toBeCloseTo(green, 12);
      });
    }
  }
});

describe("raw reconstruction footprint", () => {
  it("preserves a constant at the input corner with clamp-to-edge colour support", () => {
    const source = new GridTexture(4, 4, () => [0.3, 0.3, 0.3, 1]);
    const sampled = reconstructNeighbourhood(
      source as never,
      new Value([0.0625, 0.0625]) as never,
      new Value([4, 4]) as never,
      new Value([0, 0]) as never,
    ) as unknown as { get(name: string): Value };
    for (const channel of sampled.get("color").values.slice(0, 3))
      expect(channel).toBeCloseTo(0.3, 12);
    for (const channel of sampled.get("mean").values.slice(0, 3))
      expect(channel).toBeCloseTo(0.3, 12);
    for (const channel of sampled.get("variance").values.slice(0, 3))
      expect(channel).toBeCloseTo(0, 8);
  });
  it("reconstructs the current colour when only the input height is reduced", () => {
    const current = new GridTexture(8, 4, (x, y) =>
      x === 4 && y === 2 ? [1, 1, 1, 1] : [0, 0, 0, 1],
    );
    const previous = new GridTexture(8, 8, () => [0, 0, 0, 1]);
    const source = {
      beautyNode: current,
      _historyRenderTarget: { texture: previous },
      maxVelocityLength: 128,
    };
    const rejection = {
      historyValidity: () => ({
        get: (key: string) =>
          ({
            hasValidHistory: new Value([0]),
            canLock: new Value([0]),
            historyUV: new Value([0.5, 0.5]),
            offsetUV: new Value([0, 0]),
          })[key],
      }),
    };
    const output = createExperimentalTemporalResolve(
      source as never,
      {} as never,
      new Value([0, 0.25]) as never,
      "linear",
      "ordinary",
      rejection as never,
    ) as unknown as Value;
    // The native width retains column4. Independently place its three vertical input samples:
    // the lit sample (4,2) is at physical y2.75, while the closest gather row is raw1.
    let total = 0;
    for (let y = 0; y <= 2; y++) total += Math.exp(-2.29 * (2 - (y + 0.75)) ** 2);
    const expected = Math.exp(-2.29 * 0.75 ** 2) / total;
    expect(current.sample(new Value([0.5, 0.5])).values[0]).toBe(0.25);
    expect(expected).not.toBeCloseTo(0.25, 3);
    for (const channel of output.values.slice(0, 3)) expect(channel).toBeCloseTo(expected, 12);
  });
  it("keeps stable constant coverage and ignores white history when history is invalid", () => {
    for (const valid of [0, 1]) {
      const current = new GridTexture(4, 4, () => [0.3, 0.3, 0.3, 1]);
      const previous = new GridTexture(8, 8, () => (valid ? [0.3, 0.3, 0.3, 1] : [1, 1, 1, 1]));
      const source = {
        beautyNode: current,
        _historyRenderTarget: { texture: previous },
        maxVelocityLength: 128,
      };
      const rejection = {
        historyValidity: () => ({
          get: (key: string) =>
            ({
              hasValidHistory: new Value([valid]),
              historyUV: new Value([0.5, 0.5]),
              offsetUV: new Value([0, 0]),
            })[key],
        }),
      };
      const result = createExperimentalTemporalResolve(
        source as never,
        {} as never,
        new Value([0, 0]) as never,
        "linear",
        "ordinary",
        rejection as never,
      ) as unknown as Value;
      for (const channel of result.values.slice(0, 3)) expect(channel).toBeCloseTo(0.3, 12);
    }
  });
});
