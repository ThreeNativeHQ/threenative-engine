import { describe, expect, it } from "vitest";
import { gully } from "../src/core/gully.js";
import { fbm } from "../src/core/math.js";
import { scree } from "../src/core/scree.js";
import { Terrain } from "../src/core/terrain.js";

const SIZE = 512;

/**
 * A ridge-noise hillside falling east, built straight on the grid the passes take.
 * `fbm` is the evaluator's own noise, so this is the shape every mountain recipe starts from:
 * a slope with sharp crests the two passes are supposed to weather.
 */
function hillside(n: number): Float32Array {
  const h = new Float32Array(n * n);
  for (let z = 0; z < n; z += 1)
    for (let x = 0; x < n; x += 1) {
      const u = x / (n - 1);
      const v = z / (n - 1);
      h[z * n + x] =
        260 * (1 - u) + 45 * fbm(u * 5.5, v * 5.5, { seed: 91, octaves: 5, mode: "ridged" });
    }
  return h;
}

/** FNV-1a over the raw words: "same seed and grid, same result twice", without a deep compare. */
function hash(h: Float32Array): string {
  const words = new Uint32Array(h.buffer, h.byteOffset, h.length);
  let value = 0x811c9dc5;
  for (const word of words) {
    value ^= word;
    value = Math.imul(value, 0x01000193);
  }
  return (value >>> 0).toString(16).padStart(8, "0");
}

const finite = (h: Float32Array): boolean => h.every((v) => Number.isFinite(v));

const mean = (h: Float32Array): number => {
  let total = 0;
  for (const v of h) total += v;
  return total / h.length;
};

/** Interior cells strictly below all four 4-neighbours: the floor of an incised channel. */
function hollows(h: Float32Array, n: number, epsilon = 1e-3): number {
  let count = 0;
  for (let z = 1; z < n - 1; z += 1)
    for (let x = 1; x < n - 1; x += 1) {
      const i = z * n + x;
      const v = (h[i] as number) + epsilon;
      if (
        v < (h[i - 1] as number) &&
        v < (h[i + 1] as number) &&
        v < (h[i - n] as number) &&
        v < (h[i + n] as number)
      )
        count += 1;
    }
  return count;
}

/** Variance of the 4-point Laplacian over the interior: how strongly the surface bends. */
function laplacianVariance(h: Float32Array, n: number): number {
  let sum = 0;
  let squares = 0;
  let count = 0;
  for (let z = 1; z < n - 1; z += 1)
    for (let x = 1; x < n - 1; x += 1) {
      const i = z * n + x;
      const lap =
        (h[i - 1] as number) +
        (h[i + 1] as number) +
        (h[i - n] as number) +
        (h[i + n] as number) -
        4 * (h[i] as number);
      sum += lap;
      squares += lap * lap;
      count += 1;
    }
  const average = sum / count;
  return squares / count - average * average;
}

/** Edge cells: every pass must leave the rim finite, never `undefined` or a spike of NaN. */
function edgesFinite(h: Float32Array, n: number): boolean {
  for (let a = 0; a < n; a += 1)
    if (
      !Number.isFinite(h[a] as number) ||
      !Number.isFinite(h[(n - 1) * n + a] as number) ||
      !Number.isFinite(h[a * n] as number) ||
      !Number.isFinite(h[a * n + n - 1] as number)
    )
      return false;
  return true;
}

describe("scree slide", () => {
  it("is deterministic: the same grid twice gives the same hash", () => {
    const h = hillside(65);
    const first = scree(h, 65, SIZE);
    const second = scree(h, 65, SIZE);
    expect(hash(first)).toBe(hash(second));
    expect(first).not.toBe(second);
  });

  it("keeps total height within the stated tolerance (mass conserving)", () => {
    const h = hillside(65);
    const after = scree(h, 65, SIZE);
    const drift = Math.abs(mean(after) - mean(h));
    // Material only moves between neighbours, so the only loss is the float32 rounding of the
    // result: 1e-4 m of mean drift on a 300 m hillside is four orders of magnitude below relief.
    expect(drift, `mean drift ${drift}`).toBeLessThan(1e-4);
  });

  it("weathers a sloped noise terrain: the slide removes the sharp bends", () => {
    const n = 129;
    const h = hillside(n);
    const after = scree(h, n, SIZE, { iterations: 60, talus: 30 });
    const roughBefore = laplacianVariance(h, n);
    const roughAfter = laplacianVariance(after, n);
    let moved = 0;
    for (let i = 0; i < h.length; i += 1)
      moved += Math.abs((after[i] as number) - (h[i] as number));
    const movedMean = moved / h.length;
    // A slide is a diffusion: crests and pits lose their bend while the slope between them stands.
    expect(roughAfter, `laplacian ${roughBefore} -> ${roughAfter}`).toBeLessThan(
      roughBefore * 0.25,
    );
    expect(movedMean, `moved mean ${movedMean}`).toBeGreaterThan(0.02);
  });

  it("settles a spike into a cone at the scree angle, moving no material off the map", () => {
    const n = 17;
    const h = new Float32Array(n * n);
    h[8 * n + 8] = 20;
    const after = scree(h, n, 16, { iterations: 200, talus: 30 });
    const limit = Math.tan((30 * Math.PI) / 180);
    const drop = (after[8 * n + 8] as number) - (after[7 * n + 8] as number);
    const total = after.reduce((sum, v) => sum + v, 0);
    expect(drop, `drop ${drop}`).toBeLessThanOrEqual(limit * 1.001);
    expect(drop, `drop ${drop}`).toBeGreaterThan(limit * 0.9);
    expect(total).toBeCloseTo(20, 4);
  });

  it("leaves no NaN or dead edge at the defaults", () => {
    const after = scree(hillside(65), 65, SIZE);
    expect(finite(after)).toBe(true);
    expect(edgesFinite(after, 65)).toBe(true);
    expect(hash(after)).not.toBe(hash(hillside(65)));
  });

  it("rejects an invalid parameter with an error naming the field", () => {
    const h = hillside(17);
    expect(() => scree(h, 17, SIZE, { talus: 120 })).toThrow(/talus/);
    expect(() => scree(h, 17, SIZE, { iterations: 1.5 })).toThrow(/iterations/);
    expect(() => scree(h, 17, SIZE, { rate: -1 })).toThrow(/rate/);
    expect(() => scree(h, 1, SIZE)).toThrow(/resolution/);
  });
});

describe("gully channels", () => {
  it("is deterministic: the same grid twice gives the same hash", () => {
    const h = hillside(65);
    const first = gully(h, 65, SIZE);
    const second = gully(h, 65, SIZE);
    expect(hash(first)).toBe(hash(second));
    expect(first).not.toBe(second);
  });

  it("removes material from the map", () => {
    const h = hillside(65);
    const after = gully(h, 65, SIZE);
    const removed = mean(h) - mean(after);
    // Rain carries sediment off the open edge, so the total falls; a pass that deposited as much as
    // it cut would score zero here.
    expect(removed, `mean removed ${removed}`).toBeGreaterThan(1e-3);
  });

  it("cuts deeper channels into a sloped noise terrain", () => {
    const n = 129;
    const h = hillside(n);
    const after = gully(h, n, SIZE, { iterations: 120 });
    const before = hollows(h, n);
    const cut = hollows(after, n);
    const roughBefore = laplacianVariance(h, n);
    const roughAfter = laplacianVariance(after, n);
    expect(cut, `hollows ${before} -> ${cut}`).toBeGreaterThan(before * 1.5);
    expect(roughAfter, `laplacian ${roughBefore} -> ${roughAfter}`).toBeGreaterThan(
      roughBefore * 1.5,
    );
  });

  it("leaves no NaN or dead edge", () => {
    const h = hillside(65);
    const after = gully(h, 65, SIZE);
    expect(finite(after)).toBe(true);
    expect(edgesFinite(after, 65)).toBe(true);
  });

  it("is a no-op at zero iterations", () => {
    const h = hillside(17);
    expect(gully(h, 17, SIZE, { iterations: 0 })).toEqual(h);
  });

  it("rejects an invalid parameter with an error naming the field", () => {
    const h = hillside(17);
    expect(() => gully(h, 17, SIZE, { capacity: -1 })).toThrow(/capacity/);
    expect(() => gully(h, 17, SIZE, { rain: -0.1 })).toThrow(/rain/);
    expect(() => gully(h, 17, SIZE, { iterations: 1.5 })).toThrow(/iterations/);
    expect(() => gully(h, 1, SIZE)).toThrow(/resolution/);
  });
});

describe("the two passes as erode methods", () => {
  const recipe = (params: Record<string, unknown>): Terrain =>
    new Terrain({ size: SIZE, resolution: 65, seed: 5 })
      .noise({ id: "ground", base: 40, amplitude: 60, scale: 210, warp: 30, octaves: 4 })
      .erode({ id: "weathering", ...params } as never);

  it("bakes a scree layer and a gully layer", () => {
    const screeState = recipe({ method: "scree", iterations: 20 }).evaluate();
    const gullyState = recipe({ method: "gully", iterations: 20 }).evaluate();
    expect(finite(screeState.height)).toBe(true);
    expect(finite(gullyState.height)).toBe(true);
  });

  it("fails closed on a bad parameter, naming the field", () => {
    expect(() => recipe({ method: "gully", rain: -1 })).toThrow(/rain/);
    expect(() => recipe({ method: "scree", talus: 200 })).toThrow(/talus/);
    expect(() => recipe({ method: "rivers" })).toThrow(/gully/);
  });
});
