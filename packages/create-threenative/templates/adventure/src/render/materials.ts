// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// One material per colour, cached: the vale and the Hollow are hundreds of primitives sharing a
// few dozen colours, and a fresh material per mesh is a fresh shader per mesh. `lit` is the
// standard surface; `glow` is for what carries its own light (the lantern, the Warden's runes,
// the reticle), which an emissive keeps bright under any exposure the meter picks.
import {
  BufferAttribute,
  type BufferGeometry,
  type ColorRepresentation,
  DataTexture,
  DoubleSide,
  FrontSide,
  LinearFilter,
  LinearMipmapLinearFilter,
  type Material,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NoColorSpace,
  RGBAFormat,
  RepeatWrapping,
} from "three";
import { palette } from "./palette.js";

const cache = new Map<string, Material>();

function cached<T extends Material>(key: string, make: () => T): T {
  const hit = cache.get(key);
  if (hit !== undefined) return hit as T;
  const material = make();
  cache.set(key, material);
  return material;
}

let detailMap: DataTexture | undefined;

/**
 * A tiling grey grain, 128² fractal value noise baked in code: multiplied over a surface's colour it
 * breaks a flat vertex-coloured face into soil, bark or stone grain. No image file. Values sit
 * between 0.62 and 1, so it only darkens.
 */
export function detailTexture(): DataTexture {
  if (detailMap !== undefined) return detailMap;
  const size = 128;
  const lattice = (cells: number, seed: number): ((x: number, y: number) => number) => {
    const rng = (i: number): number => {
      const s = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453;
      return s - Math.floor(s);
    };
    return (x, y) => {
      const fx = (x / size) * cells;
      const fy = (y / size) * cells;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      const at = (i: number, j: number): number => rng(((j % cells) * cells + (i % cells)) * 1.37);
      const sx = tx * tx * (3 - 2 * tx);
      const sy = ty * ty * (3 - 2 * ty);
      const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
      const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
      return top + (bottom - top) * sy;
    };
  };
  const octaves = [lattice(4, 1), lattice(8, 2), lattice(16, 3), lattice(32, 4)];
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const n = octaves.reduce((sum, octave, i) => sum + octave(x, y) / 2 ** i, 0) / 1.875;
      const v = Math.round((0.62 + 0.38 * n) * 255);
      data.set([v, v, v, 255], (y * size + x) * 4);
    }
  }
  detailMap = new DataTexture(data, size, size, RGBAFormat);
  detailMap.wrapS = RepeatWrapping;
  detailMap.wrapT = RepeatWrapping;
  detailMap.magFilter = LinearFilter;
  detailMap.minFilter = LinearMipmapLinearFilter;
  detailMap.generateMipmaps = true;
  detailMap.colorSpace = NoColorSpace;
  detailMap.needsUpdate = true;
  return detailMap;
}

/**
 * A lit, rough surface. `vertexColors` shows the baked variation `mottle` writes; `detail` adds the
 * tiling grain of `detailTexture` (the geometry needs uvs).
 */
export function lit(
  color: ColorRepresentation,
  options: {
    roughness?: number;
    metalness?: number;
    vertexColors?: boolean;
    flat?: boolean;
    detail?: boolean;
    doubleSided?: boolean;
    /** A faint glow of the material's own, added in shade. */
    emissive?: ColorRepresentation;
  } = {},
): MeshStandardMaterial {
  return cached(
    `lit|${String(color)}|${JSON.stringify(options)}`,
    () =>
      new MeshStandardMaterial({
        color,
        emissive: options.emissive ?? 0x000000,
        flatShading: options.flat ?? false,
        map: options.detail === true ? detailTexture() : null,
        metalness: options.metalness ?? 0,
        roughness: options.roughness ?? 0.85,
        side: options.doubleSided === true ? DoubleSide : FrontSide,
        vertexColors: options.vertexColors ?? false,
      }),
  );
}

/** A surface that is its own light: the lantern flame, the runes, the reticle. */
export function glow(color: ColorRepresentation, strength = 4): MeshStandardMaterial {
  return cached(
    `glow|${String(color)}|${strength}`,
    () =>
      new MeshStandardMaterial({
        color: 0x000000,
        emissive: color,
        emissiveIntensity: strength,
        roughness: 1,
      }),
  );
}

/** Unlit and see-through, for the blob shadows and the reticle ring. */
export function flat(
  color: ColorRepresentation,
  opacity = 1,
  options: { depthTest?: boolean } = {},
): MeshBasicMaterial {
  return cached(
    `flat|${String(color)}|${opacity}|${JSON.stringify(options)}`,
    () =>
      new MeshBasicMaterial({
        color,
        depthTest: options.depthTest ?? true,
        depthWrite: opacity >= 1,
        opacity,
        transparent: opacity < 1,
      }),
  );
}

/**
 * Bakes a per-face brightness variation into vertex colours, so a box reads as cut stone and a
 * plane as uneven turf with no texture file. Two triangles share one tint: a quad stays a facet.
 */
export function mottle(
  geometry: BufferGeometry,
  variance = 0.18,
  rng: () => number = Math.random,
): BufferGeometry {
  const g = geometry.index === null ? geometry : geometry.toNonIndexed();
  const count = g.attributes.position?.count ?? 0;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 6) {
    const k = 1 - variance / 2 + rng() * variance;
    for (let v = 0; v < 6 && i + v < count; v += 1) colors.fill(k, (i + v) * 3, (i + v) * 3 + 3);
  }
  g.setAttribute("color", new BufferAttribute(colors, 3));
  return g;
}

/** The surfaces the world is built from, resolved once. */
export function worldMaterials() {
  return {
    accent: lit(palette.accent, { metalness: 0.6, roughness: 0.4 }),
    grass: lit(palette.grass, { vertexColors: true }),
    stone: lit(palette.stone, { flat: true, vertexColors: true }),
  };
}
