import { describe, expect, it } from "vitest";
import { CURRENT_SAMPLE_POSITIONS } from "../templates/starter/src/render/temporalCurrentFootprintMath.js";
import { raw4FootprintWeights } from "./fixtures/temporal-footprint-oracle.js";

type Point = readonly [number, number];

/** Four periodic nearest candidates, preserving the exhaustive row/cell/sample tie order. */
function nearestCurrentSample(point: Point) {
  let best = { x: 0, y: 0, sample: 0, distance: Number.POSITIVE_INFINITY };
  for (let sample = 0; sample < 4; sample++) {
    const site = CURRENT_SAMPLE_POSITIONS[sample] as Point;
    const x = Math.ceil(point[0] - site[0] - 0.5) + 0;
    const y = Math.ceil(point[1] - site[1] - 0.5) + 0;
    const distance = (point[0] - x - site[0]) ** 2 + (point[1] - y - site[1]) ** 2;
    if (
      distance < best.distance ||
      (distance === best.distance &&
        (y < best.y || (y === best.y && (x < best.x || (x === best.x && sample < best.sample)))))
    )
      best = { x, y, sample, distance };
  }
  return best;
}

describe("finite raw4 current footprint", () => {
  it("matches exhaustive prior-site selection at random phases and exact cell/cross-site ties", () => {
    let state = 398;
    for (let index = 0; index < 8192; index++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const px = index < 4096 ? (index % 64) / 32 - 1 : (state / 2 ** 32) * 500 - 10;
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const py = index < 4096 ? Math.floor(index / 64) / 32 - 1 : (state / 2 ** 32) * 300 - 10;
      let expected = { x: 0, y: 0, sample: 0, distance: Number.POSITIVE_INFINITY };
      for (let y = Math.floor(py) - 1; y <= Math.floor(py) + 1; y++)
        for (let x = Math.floor(px) - 1; x <= Math.floor(px) + 1; x++)
          for (let sample = 0; sample < 4; sample++) {
            const site = defined(CURRENT_SAMPLE_POSITIONS[sample]);
            const distance = (px - x - site[0]) ** 2 + (py - y - site[1]) ** 2;
            if (distance < expected.distance) expected = { x, y, sample, distance };
          }
      expect(nearestCurrentSample([px, py])).toEqual(expected);
    }
  });
  it("partitions every original-raster destination footprint into nonnegative unique sample areas", () => {
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        const result = raw4FootprintWeights(
          [426, 240],
          [640, 360],
          [(200 + x / 16) / 426, (100 + y / 16) / 240],
          [0.25, -0.375],
        );
        expect(result).toBeDefined();
        const taps = defined(result);
        expect(taps.length).toBeLessThanOrEqual(36);
        expect(new Set(taps.map((t) => `${t.x},${t.y},${t.sample}`)).size).toBe(taps.length);
        expect(taps.every((t) => Number.isFinite(t.weight) && t.weight > 0)).toBe(true);
        expect(taps.reduce((sum, t) => sum + t.weight, 0)).toBeCloseTo(1, 10);
        // Constant HDR radiance and its moments stay constant, without luminance compression.
        expect(taps.reduce((sum, t) => sum + t.weight * 8, 0)).toBeCloseTo(8, 10);
        expect(taps.reduce((sum, t) => sum + t.weight * 64, 0)).toBeCloseTo(64, 10);
      }
  });

  it("matches an independent dense nearest-site area integral for a rotated binary cutout", () => {
    const input = [426, 240] as const;
    const display = [640, 360] as const;
    const uv = [200.37 / 426, 100.62 / 240] as const;
    const taps = defined(raw4FootprintWeights(input, display, uv, [0, 0]));
    for (const angle of [0, Math.PI / 4, Math.PI / 2]) {
      const foreground = (x: number, y: number) =>
        (x - 200.37) * Math.cos(angle) + (y - 100.62) * Math.sin(angle) < 0.12;
      const actual = taps.reduce((sum, t) => {
        const site = defined(CURRENT_SAMPLE_POSITIONS[t.sample]);
        return sum + t.weight * Number(foreground(t.x + site[0], t.y + site[1]));
      }, 0);
      let count = 0;
      const subdivisions = 192;
      for (let y = 0; y < subdivisions; y++)
        for (let x = 0; x < subdivisions; x++) {
          const px = 200.37 + (((x + 0.5) / subdivisions - 0.5) * 426) / 640;
          const py = 100.62 + (((y + 0.5) / subdivisions - 0.5) * 240) / 360;
          let best = Number.POSITIVE_INFINITY;
          let sx = 0;
          let sy = 0;
          for (let cy = 99; cy <= 101; cy++)
            for (let cx = 199; cx <= 201; cx++)
              for (const site of CURRENT_SAMPLE_POSITIONS) {
                const dx = px - cx - site[0];
                const dy = py - cy - site[1];
                const distance = dx * dx + dy * dy;
                if (distance < best) {
                  best = distance;
                  sx = cx + site[0];
                  sy = cy + site[1];
                }
              }
          count += Number(foreground(sx, sy));
        }
      expect(actual).toBeCloseTo(count / subdivisions ** 2, 2);
    }
  });

  it("falls back at physical edges instead of duplicating clamped sample mass", () => {
    expect(
      raw4FootprintWeights([426, 240], [640, 360], [0.5 / 640, 0.5 / 360], [0, 0]),
    ).toBeUndefined();
    expect(
      raw4FootprintWeights([426, 240], [640, 360], [639.5 / 640, 359.5 / 360], [0, 0]),
    ).toBeUndefined();
    expect(raw4FootprintWeights([640, 360], [640, 360], [0.5, 0.5], [0, 0])).toBeUndefined();
    expect(raw4FootprintWeights([426, 240], [320, 180], [0.5, 0.5], [0, 0])).toBeUndefined();
  });
});

function defined<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("Missing test fixture value.");
  return value;
}
