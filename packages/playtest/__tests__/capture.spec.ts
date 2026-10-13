import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import { expect, test } from "vitest";

import {
  assertCaptureNotBlank,
  assertDesktopCaptureNotBlank,
  CAPTURE_GUARD_LIMITS,
  inspectFrame,
} from "../src/capture.js";

function image(colors: readonly (readonly [number, number, number, number])[]): Buffer {
  const png = new PNG({ height: 1, width: colors.length });
  colors.forEach(([red, green, blue, alpha], index) => {
    const offset = index * 4;
    png.data[offset] = red;
    png.data[offset + 1] = green;
    png.data[offset + 2] = blue;
    png.data[offset + 3] = alpha;
  });
  return PNG.sync.write(png);
}

function darkCloud(size: number): Buffer {
  const png = new PNG({ height: 128, width: 128 });
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const value = x < size && y < size ? 200 + ((x + y) % 56) : 4 + ((x + y) % 8);
      png.data.set([value, value, value, 255], (y * png.width + x) * 4);
    }
  }
  return PNG.sync.write(png);
}

test("desktop rejects a uniform frame with TN_CAPTURE_BLANK", () => {
  expect(() => assertDesktopCaptureNotBlank(image([[8, 8, 8, 255]]), "uniform.png"))
    .toThrow("TN_CAPTURE_BLANK");
});

test("desktop accepts a small bright cloud below the browser bright-pixel floor", () => {
  const stats = assertDesktopCaptureNotBlank(darkCloud(16), "cloud.png");
  expect(stats.maxLuminance).toBeGreaterThan(0.5);
  expect(stats.brightPixelRatio).toBeLessThan(0.05);
  expect(stats.contentRatio).toBe(256 / (128 * 128));
  expect(stats.contentRatio).toBeGreaterThan(CAPTURE_GUARD_LIMITS.desktopMinContentRatio);
});

test("browser still rejects the same small cloud with the bright-pixel message", () => {
  const png = darkCloud(16);
  expect(() => assertCaptureNotBlank(png, "cloud.png")).toThrow("bright pixel ratio");
});

test("desktop rejects a 2x2 bright spot below the content floor", () => {
  expect(() => assertDesktopCaptureNotBlank(darkCloud(2), "spot.png"))
    .toThrow("content ratio");
});

test.each([
  ["black", [0, 0, 0, 255]],
  ["white", [255, 255, 255, 255]],
  ["transparent", [0, 0, 0, 0]],
] as const)("assertCaptureNotBlank rejects uniform %s", (_label, color) => {
  expect(() => assertCaptureNotBlank(image([color]), "fixture.png")).toThrow("TN_CAPTURE_BLANK");
});

test("a blank capture raises the guard code before any visual assertion can consume it", () => {
  try {
    assertCaptureNotBlank(image([[0, 0, 0, 255]]), "after.png");
    throw new Error("expected blank capture to fail");
  } catch (error) {
    expect(error).toMatchObject({ code: "TN_CAPTURE_BLANK", label: "after.png" });
  }
});

test("inspectFrame keeps the stats used to diagnose a capture failure", () => {
  const stats = inspectFrame(image([
    [0, 0, 0, 255],
    [255, 255, 255, 255],
  ]));

  expect(stats).toMatchObject({ height: 1, width: 2 });
  expect(stats.distinctColors).toBe(2);
});

test("a real archived frame remains accepted by the package guard", async () => {
  const path = resolve(
    "docs/benchmark/sweeps/platformer-2026-08-06/captures/platformer-jump-proof-after.png",
  );
  const stats = assertCaptureNotBlank(await readFile(path), path);

  expect(stats.width).toBe(1280);
  expect(stats.height).toBe(720);
  expect(stats.distinctColors).toBeGreaterThanOrEqual(8);
});

test("a dark but varied game frame remains accepted below the bright-pixel threshold", () => {
  const colors: Array<readonly [number, number, number, number]> = Array.from(
    { length: 64 },
    (_, index) =>
      [index % 13, Math.floor(index / 13) % 13, 0, 255] as [number, number, number, number],
  );
  colors[62] = [80, 80, 80, 255];
  colors[63] = [100, 100, 100, 255];

  const stats = assertCaptureNotBlank(image(colors), "dark-scene.png");

  expect(stats.brightPixelRatio).toBeLessThan(0.05);
  expect(stats.distinctColors).toBeGreaterThanOrEqual(32);
  expect(stats.luminanceStdDev).toBeGreaterThanOrEqual(0.02);
  expect(stats.maxLuminance).toBeLessThanOrEqual(0.5);
});

test("tone reports all six statistics from a 256-bin display-luminance histogram", () => {
  const stats = inspectFrame(image(Array.from({ length: 256 }, (_, value) => [value, value, value, 255])));
  expect(stats.tone).toEqual({ mean: 127.5, p1: 2, p50: 127, p99: 253, clipFraction: 1 / 256, blackFraction: 1 / 256 });
});

test("tone uses Rec.709 luminance and ignores fully transparent pixels", () => {
  const stats = inspectFrame(image([[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 255, 0]]));
  expect(stats.tone).toEqual({ mean: (54 + 182 + 18) / 3, p1: 18, p50: 54, p99: 182, clipFraction: 0, blackFraction: 0 });
  expect(inspectFrame(image([[255, 255, 255, 0]])).tone).toBeUndefined();
});
