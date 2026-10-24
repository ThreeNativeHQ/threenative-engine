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
  type Material,
  MeshBasicMaterial,
  MeshStandardMaterial,
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

/** A lit, rough surface. `vertexColors` shows the baked variation `mottle` writes. */
export function lit(
  color: ColorRepresentation,
  options: { roughness?: number; metalness?: number; vertexColors?: boolean; flat?: boolean } = {},
): MeshStandardMaterial {
  return cached(
    `lit|${String(color)}|${JSON.stringify(options)}`,
    () =>
      new MeshStandardMaterial({
        color,
        flatShading: options.flat ?? false,
        metalness: options.metalness ?? 0,
        roughness: options.roughness ?? 0.85,
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
