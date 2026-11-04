import { describe, expect, it } from "vitest";
import { bakeNoiseVolume, mxPerlin3, NOISE_PERIOD, NOISE_TEXELS } from "../src/world-noise.js";

const SIZE = NOISE_PERIOD * NOISE_TEXELS;

describe("baked MaterialX noise volume", () => {
  it("is zero on every lattice point and stays inside [-1, 1], as three's Perlin is", () => {
    for (let i = 0; i < 64; i += 1) expect(mxPerlin3(i * 3 - 40, i * 7 - 90, i * 11 + 5)).toBe(0);
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < 20000; i += 1) {
      const n = mxPerlin3(Math.sin(i) * 500, Math.cos(i * 1.3) * 500, i * 0.37);
      lo = Math.min(lo, n);
      hi = Math.max(hi, n);
    }
    expect(lo).toBeGreaterThan(-1);
    expect(hi).toBeLessThan(1);
    expect(hi - lo).toBeGreaterThan(1); // a field, not a constant
  });

  it("tiles: the wrapped lattice repeats every period and matches the unwrapped one inside it", () => {
    for (let i = 0; i < 200; i += 1) {
      const [x, y, z] = [(i * 0.731) % NOISE_PERIOD, (i * 0.377) % NOISE_PERIOD, (i * 0.913) % NOISE_PERIOD];
      expect(mxPerlin3(x + NOISE_PERIOD, y - NOISE_PERIOD, z + 2 * NOISE_PERIOD, NOISE_PERIOD)).toBeCloseTo(
        mxPerlin3(x, y, z, NOISE_PERIOD),
        5,
      );
      // Away from the last cell (whose far corners wrap to 0) the tile is three's own field.
      if (x < NOISE_PERIOD - 1 && y < NOISE_PERIOD - 1 && z < NOISE_PERIOD - 1)
        expect(mxPerlin3(x, y, z, NOISE_PERIOD)).toBeCloseTo(mxPerlin3(x, y, z), 6);
    }
  });

  it("stores each channel's field at the texel centres to within one byte", () => {
    const started = performance.now();
    const data = bakeNoiseVolume();
    const ms = performance.now() - started;
    expect(data.length).toBe(SIZE ** 3 * 4);
    for (let i = 0; i < 4000; i += 1) {
      const tx = (i * 97) % SIZE;
      const ty = (i * 61) % SIZE;
      const tz = (i * 29) % SIZE;
      const channel = i % 4;
      const decoded = ((data[((tz * SIZE + ty) * SIZE + tx) * 4 + channel] as number) / 255) * 2 - 1;
      const at = (t: number) => (t + 0.5) / NOISE_TEXELS;
      expect(Math.abs(decoded - mxPerlin3(at(tx), at(ty), at(tz), NOISE_PERIOD, channel * 1031))).toBeLessThan(
        1.01 / 255,
      );
    }
    // Baked once per page on the main thread: keep it a loading-screen cost, not a stall.
    expect(ms).toBeLessThan(3000);
  });
});
