import { describe, expect, it } from "vitest";
import {
  type ISurfaceCacheMaterial,
  type ISurfaceLight,
  SurfaceCache,
  SurfaceLights,
} from "../src/render/surface-cache.js";

/** A 2 x 2 RGBA8 image: red and green on the top row, blue and white below. */
function quad(): { data: Uint8ClampedArray; width: number; height: number } {
  return {
    width: 2,
    height: 2,
    data: Uint8ClampedArray.from([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
    ]),
  };
}

const flat = (r: number, g: number, b: number): ISurfaceCacheMaterial => ({
  color: { r, g, b },
});

describe("SurfaceCache albedo (PRD-639 Phase 2)", () => {
  it("returns the atlas texel at the hit UV for a mapped material", () => {
    // flipY false (glTF): v = 0 is the top row.
    const mapped: ISurfaceCacheMaterial = {
      color: { r: 1, g: 1, b: 1 },
      map: { image: quad(), colorSpace: "srgb-linear", flipY: false },
    };
    const cache = SurfaceCache.from([mapped]);
    const out = [0, 0, 0];
    cache.albedo(0, 0.25, 0.25, out);
    expect(out).toEqual([1, 0, 0]);
    cache.albedo(0, 0.75, 0.25, out);
    expect(out).toEqual([0, 1, 0]);
    cache.albedo(0, 0.25, 0.75, out);
    expect(out).toEqual([0, 0, 1]);
    cache.albedo(0, 0.75, 0.75, out);
    expect(out).toEqual([1, 1, 1]);
  });

  it("reads v from the bottom row when the texture is flipped, as three's images are", () => {
    const cache = SurfaceCache.from([
      { map: { image: quad(), colorSpace: "srgb-linear", flipY: true } },
    ]);
    const out = [0, 0, 0];
    cache.albedo(0, 0.25, 0.25, out);
    expect(out).toEqual([0, 0, 1]);
  });

  it("returns the flat colour for a material without a map", () => {
    const cache = SurfaceCache.from([flat(0.2, 0.4, 0.6)]);
    const out = [0, 0, 0];
    cache.albedo(0, 0.9, 0.1, out);
    expect(out.map((v) => Number(v.toFixed(6)))).toEqual([0.2, 0.4, 0.6]);
    expect(cache.report.flatMaterials).toBe(1);
    expect(cache.report.mappedMaterials).toBe(0);
  });

  it("multiplies the map by the colour factor and takes metal out of the diffuse term", () => {
    const cache = SurfaceCache.from([
      {
        color: { r: 0.5, g: 0.5, b: 0.5 },
        metalness: 0.5,
        map: { image: quad(), colorSpace: "srgb-linear", flipY: false },
      },
    ]);
    const out = [0, 0, 0];
    cache.albedo(0, 0.75, 0.75, out);
    expect(out).toEqual([0.25, 0.25, 0.25]);
  });

  it("decodes an sRGB map to linear light", () => {
    const grey = { width: 1, height: 1, data: Uint8ClampedArray.from([128, 128, 128, 255]) };
    const cache = SurfaceCache.from([{ map: { image: grey, colorSpace: "srgb", flipY: false } }]);
    const out = [0, 0, 0];
    cache.albedo(0, 0.5, 0.5, out);
    expect(out[0]).toBeCloseTo(0.2158, 3);
  });

  it("reduces a large map to its mean, so a bounce carries the average albedo", () => {
    const size = 64;
    const data = new Uint8ClampedArray(size * size * 4);
    for (let i = 0; i < size * size; i += 1) {
      const lit = (i + Math.floor(i / size)) % 2 === 0 ? 255 : 0;
      data.set([lit, lit, lit, 255], i * 4);
    }
    const cache = SurfaceCache.from(
      [{ map: { image: { width: size, height: size, data }, colorSpace: "srgb-linear" } }],
      { atlasSize: 8 },
    );
    const out = [0, 0, 0];
    cache.albedo(0, 0.3, 0.7, out);
    expect(out[0]).toBeCloseTo(0.5, 2);
  });

  it("reads the emissive map times the intensity, and the flat emissive without one", () => {
    const cache = SurfaceCache.from([
      {
        emissive: { r: 1, g: 1, b: 1 },
        emissiveIntensity: 4,
        emissiveMap: { image: quad(), colorSpace: "srgb-linear", flipY: false },
      },
      { emissive: { r: 0.1, g: 0.2, b: 0.3 }, emissiveIntensity: 10 },
    ]);
    const out = [0, 0, 0];
    cache.emissive(0, 0.25, 0.25, out);
    expect(out).toEqual([4, 0, 0]);
    cache.emissive(1, 0.5, 0.5, out);
    expect(out.map((v) => Number(v.toFixed(6)))).toEqual([1, 2, 3]);
  });

  it("falls back to the flat colour for an image it cannot read, and says why", () => {
    const cache = SurfaceCache.from([
      { name: "Wall", color: { r: 0.3, g: 0.3, b: 0.3 }, map: { image: { width: 4, height: 4 } } },
    ]);
    const out = [0, 0, 0];
    cache.albedo(0, 0.5, 0.5, out);
    expect(out).toEqual([0.3, 0.3, 0.3]);
    expect(cache.report.fallbacks).toEqual([
      { material: "Wall", reason: "unreadable-image", detail: "Object 4x4, no OffscreenCanvas" },
    ]);
  });

  it("reads the image the game hands over for a map whose own image has no pixels", () => {
    // The owned engine decodes a glTF's maps itself: JS sees their size and nothing else.
    const engineTexture = {
      image: { width: 2, height: 2 },
      colorSpace: "srgb-linear",
      flipY: false,
    };
    const asked: string[] = [];
    const materials: ISurfaceCacheMaterial[] = [
      {
        name: "Brick",
        color: { r: 1, g: 1, b: 1 },
        map: engineTexture,
        emissiveMap: engineTexture,
      },
      { name: "Plain", color: { r: 0.3, g: 0.3, b: 0.3 } },
    ];
    const cache = SurfaceCache.from(materials, {
      images: (material, slot) => {
        asked.push(`${material.name}.${slot}`);
        return slot === "map" ? quad() : undefined;
      },
    });
    const out = [0, 0, 0];
    cache.albedo(0, 0.75, 0.25, out);
    expect(out).toEqual([0, 1, 0]);
    expect(asked).toEqual(["Brick.map", "Brick.emissiveMap"]);
    // `undefined` keeps the texture's own image, which here has no pixels: the flat colour and the reason.
    expect(cache.report.mappedMaterials).toBe(1);
    expect(cache.report.fallbacks).toEqual([
      { material: "Brick", reason: "unreadable-image", detail: "Object 2x2, no OffscreenCanvas" },
    ]);
  });

  it("reads an image whose data is a plain ArrayBuffer, and names an empty one a closed bitmap", () => {
    const bytes = Uint8Array.from([0, 255, 0, 255]).buffer;
    const cache = SurfaceCache.from([
      { map: { image: { width: 1, height: 1, data: bytes }, colorSpace: "srgb-linear" } },
      { name: "Gone", map: { image: { width: 0, height: 0 } } },
    ]);
    const out = [0, 0, 0];
    cache.albedo(0, 0.5, 0.5, out);
    expect(out).toEqual([0, 1, 0]);
    expect(cache.report.fallbacks[0]?.material).toBe("Gone");
    expect(cache.report.fallbacks[0]?.detail).toBe("Object 0x0, no OffscreenCanvas");
  });

  it("shrinks every tile until the materials fit the atlas, and reports the bytes", () => {
    const materials = Array.from({ length: 16 }, (_, i) => flat(i / 16, 0, 0));
    const cache = SurfaceCache.from(materials, { atlasSize: 128 });
    expect(cache.report.tileEdge).toBe(32);
    expect(cache.report.tilesInUse).toBe(16);
    expect(cache.report.atlasBytes).toBe(128 * 128 * 4 * 2);
    const roomy = SurfaceCache.from(materials, { atlasSize: 2048 });
    expect(roomy.report.tileEdge).toBe(64);
    expect(
      SurfaceCache.from(materials, { atlasSize: 2048, cardTexelDensityScale: 2 }).report.tileEdge,
    ).toBe(128);
  });

  it("refuses an empty material list, a non power-of-two atlas and a bad scale", () => {
    expect(() => SurfaceCache.from([])).toThrow(/at least one material/);
    expect(() => SurfaceCache.from([flat(1, 1, 1)], { atlasSize: 100 })).toThrow(/power of two/);
    expect(() => SurfaceCache.from([flat(1, 1, 1)], { cardTexelDensityScale: 0 })).toThrow(
      /cardTexelDensityScale/,
    );
    expect(() => SurfaceCache.from([flat(1, 1, 1)], { atlasSize: 1 })).toThrow(/materials/);
  });
});

const point = (x: number, intensity: number, distance = 0): ISurfaceLight => ({
  kind: "point",
  position: [x, 2, 0],
  color: [1, 1, 1],
  intensity,
  distance,
});

describe("SurfaceLights at a hit (PRD-639 Phase 3)", () => {
  it("lights the hit from a point lamp through its inverse square, cosine and shadow ray", () => {
    const lights = new SurfaceLights([point(0, Math.PI * 4)]);
    const out = [0, 0, 0];
    const shadowRays: number[] = [];
    lights.shade([0, 0, 0], [0, 1, 0], [1, 1, 1], out, (i) => {
      shadowRays.push(i);
      return true;
    });
    // albedo x intensity / pi / d^2 x cos = 1 x 4 / 4 x 1.
    expect(out).toEqual([1, 1, 1]);
    expect(shadowRays).toEqual([0]);
    const blocked = [0, 0, 0];
    lights.shade([0, 0, 0], [0, 1, 0], [1, 1, 1], blocked, () => false);
    expect(blocked).toEqual([0, 0, 0]);
  });

  it("casts no shadow ray at a light behind the surface or past its range", () => {
    const lights = new SurfaceLights([point(0, 100, 1.5)]);
    const out = [0, 0, 0];
    let rays = 0;
    lights.shade([0, 0, 0], [0, 1, 0], [1, 1, 1], out, () => {
      rays += 1;
      return true;
    });
    lights.shade([0, 4, 0], [0, 1, 0], [1, 1, 1], out, () => {
      rays += 1;
      return true;
    });
    expect(rays).toBe(0);
    expect(out).toEqual([0, 0, 0]);
  });

  it("keeps the 8 brightest lights at a hit, skips the 9th and counts it", () => {
    const lights = new SurfaceLights(Array.from({ length: 9 }, (_, i) => point(i * 0.01, 10 + i)));
    const out = [0, 0, 0];
    const asked: number[] = [];
    lights.shade([0, 0, 0], [0, 1, 0], [1, 1, 1], out, (i) => {
      asked.push(i);
      return true;
    });
    expect(asked.length).toBe(8);
    // Light 0 is the dimmest (intensity 10): it is the one skipped.
    expect(asked.includes(0)).toBe(false);
    expect(lights.skipped).toBe(1);
    lights.shade([0, 0, 0], [0, 1, 0], [1, 1, 1], out, () => true);
    expect(lights.skipped).toBe(2);
  });

  it("lights a spot only inside its cone", () => {
    const spot: ISurfaceLight = {
      kind: "spot",
      position: [0, 2, 0],
      direction: [0, -1, 0],
      angle: Math.PI / 8,
      penumbra: 0,
      color: [1, 1, 1],
      intensity: Math.PI * 4,
      distance: 0,
    };
    const lights = new SurfaceLights([spot]);
    const inside = [0, 0, 0];
    lights.shade([0, 0, 0], [0, 1, 0], [1, 1, 1], inside, () => true);
    expect(inside[0]).toBeGreaterThan(0);
    const outside = [0, 0, 0];
    lights.shade([3, 0, 0], [0, 1, 0], [1, 1, 1], outside, () => true);
    expect(outside).toEqual([0, 0, 0]);
  });

  it("rejects a cap below 1", () => {
    expect(() => new SurfaceLights([], { maxLights: 0 })).toThrow(/maxLights/);
  });
});
