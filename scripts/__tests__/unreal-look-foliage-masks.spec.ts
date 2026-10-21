import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decode } from "../unreal-look/compare.js";

const FOLIAGE = path.resolve(import.meta.dirname, "../../tools/unreal-reference/shadow/foliage");

/** The share of pixels cut in (alpha over 127), and the share that is neither cut in nor out. */
function coverage(file: string): {
  size: [number, number];
  cutIn: number;
  soft: number;
  white: boolean;
} {
  const image = decode(readFileSync(path.join(FOLIAGE, file)), "png");
  let cutIn = 0;
  let soft = 0;
  let white = true;
  for (let i = 0; i < image.width * image.height; i++) {
    const alpha = image.data[i * 4 + 3] ?? 0;
    if (alpha > 127) cutIn++;
    if (alpha > 0 && alpha < 255) soft++;
    if (image.data[i * 4] !== 255 || image.data[i * 4 + 1] !== 255 || image.data[i * 4 + 2] !== 255)
      white = false;
  }
  const pixels = image.width * image.height;
  return { size: [image.width, image.height], cutIn: cutIn / pixels, soft: soft / pixels, white };
}

describe("PRD-649 foliage masks (make_leaf.py)", () => {
  it("leaf.png is a 256 px cluster with about 55% of its pixels cut in", () => {
    const leaf = coverage("leaf.png");
    expect(leaf.size).toEqual([256, 256]);
    expect(leaf.cutIn).toBeGreaterThan(0.5);
    expect(leaf.cutIn).toBeLessThan(0.6);
    // Binary alpha with a one pixel soft edge: nothing mid-grey inside a leaflet.
    expect(leaf.soft).toBeLessThan(0.06);
    // White RGB: the material colour tints it, and the ID level reuses its alpha as a flat colour.
    expect(leaf.white).toBe(true);
  });

  it("grass.png is a 256 px card with about 40% of its pixels cut in", () => {
    const grass = coverage("grass.png");
    expect(grass.size).toEqual([256, 256]);
    expect(grass.cutIn).toBeGreaterThan(0.35);
    expect(grass.cutIn).toBeLessThan(0.45);
    expect(grass.soft).toBeLessThan(0.06);
    expect(grass.white).toBe(true);
  });
});
