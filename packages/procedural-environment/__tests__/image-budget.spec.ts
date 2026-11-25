import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

// Every image this package ships or the asset library serves is a lossy WebP of a modest size: the
// library loads them all, so one stray PNG, lossless encode or 4K map costs every visitor. Lossy
// WebP lands near 0.2-0.4 bytes per pixel (a lossless alpha cutout up to ~0.6); PNG is 2-4.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = /(^|\/)(node_modules|dist|\.cache)(\/|$)/;
const IMAGE = /\.(png|jpe?g|gif|bmp|tga|tiff?|exr|hdr|avif|ktx2|webp)$/i;
const MAX_SIDE = 2048;
const MAX_BYTES_PER_PIXEL = 0.65;

/** What is wrong with one image, or nothing. */
async function problem(file: string): Promise<string | undefined> {
  if (!file.toLowerCase().endsWith(".webp")) return `${file}: not WebP`;
  const full = path.join(root, file);
  const { width = 0, height = 0 } = await sharp(full).metadata();
  const perPixel = (await stat(full)).size / (width * height);
  if (Math.max(width, height) > MAX_SIDE) return `${file}: ${width}x${height} px`;
  if (perPixel > MAX_BYTES_PER_PIXEL) return `${file}: ${perPixel.toFixed(2)} bytes per pixel`;
}

describe("package images", () => {
  it("are WebP only, at most 2048 px and 0.65 bytes per pixel", async () => {
    const images = (await readdir(root, { recursive: true })).filter(
      (file) => IMAGE.test(file) && !SKIP.test(file),
    );
    expect(images.length).toBeGreaterThan(0);
    const bad = (await Promise.all(images.map(problem))).filter(Boolean);
    expect(bad).toEqual([]);
  });
});
