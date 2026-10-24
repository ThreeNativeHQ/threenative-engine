// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// One material per colour, cached: the island is hundreds of small meshes sharing a dozen colours,
// and a fresh material per mesh is a fresh shader compile per mesh. `lit` is the physically based
// surface the sun and the sky light; `flat` is the unlit variant for the water sheen and the
// contact shadow; `mottle` bakes per-facet brightness so a box reads as stone with no texture.
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

/**
 * Lit surface. Rough and non-metal, like the stock Unreal default material, so the tone curve and
 * the meter see a world of albedos rather than of glints. `emissive` is for the collectibles and the
 * hero's eye whites: a gold that glows a little reads as "take me" against grass at any exposure.
 */
export function lit(
  color: ColorRepresentation,
  options: {
    flat?: boolean;
    vertexColors?: boolean;
    roughness?: number;
    metalness?: number;
    emissive?: number;
  } = {},
): MeshStandardMaterial {
  return cached(
    `lit|${String(color)}|${JSON.stringify(options)}`,
    () =>
      new MeshStandardMaterial({
        color,
        emissive: options.emissive === undefined ? 0x000000 : color,
        emissiveIntensity: options.emissive ?? 0,
        flatShading: options.flat ?? false,
        metalness: options.metalness ?? 0,
        roughness: options.roughness ?? 0.8,
        vertexColors: options.vertexColors ?? false,
      }),
  );
}

/** Unlit; opacity below 1 enables transparency. */
export function flat(
  color: ColorRepresentation,
  options: { depthWrite?: boolean; opacity?: number } = {},
): MeshBasicMaterial {
  return cached(
    `flat|${String(color)}|${JSON.stringify(options)}`,
    () =>
      new MeshBasicMaterial({
        color,
        ...options,
        transparent: options.opacity !== undefined && options.opacity < 1,
      }),
  );
}

/**
 * Bake a per-facet brightness variation into a geometry as vertex colours: two triangles share one
 * tint, so a quad reads as a flat stone facet rather than a smooth gradient.
 */
export function mottle(
  geometry: BufferGeometry,
  variance: number,
  rng: () => number,
  /** Darken the first metre above the ground, where stone meets grass and the sky light is low. */
  footing = false,
): BufferGeometry {
  const g = geometry.index === null ? geometry : geometry.toNonIndexed();
  const position = g.attributes.position;
  const count = position?.count ?? 0;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 6) {
    const k = 1 - variance / 2 + rng() * variance;
    for (let v = 0; v < 6 && i + v < count; v += 1) {
      const y = position?.getY(i + v) ?? 1;
      const foot = footing ? 0.62 + 0.38 * Math.min(1, Math.max(0, y / 1.2)) : 1;
      colors.fill(k * foot, (i + v) * 3, (i + v) * 3 + 3);
    }
  }
  g.setAttribute("color", new BufferAttribute(colors, 3));
  return g;
}

/**
 * Bake broad lawn patches into a grass geometry as vertex colours: about ±6% in sRGB value (±15%
 * linear, which is what a vertex colour multiplies; more reads as dark smudges), drifting between a yellow-green and a
 * blue-green over 10–30 m, from the world position, so a mown field reads as ground rather than
 * one flat colour. Smooth per vertex, so the geometry needs interior vertices (a fan shows its
 * spokes).
 */
export function patches(geometry: BufferGeometry): BufferGeometry {
  const position = geometry.attributes.position;
  const count = position?.count ?? 0;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const x = position?.getX(i) ?? 0;
    const z = position?.getZ(i) ?? 0;
    const value =
      1 + 0.15 * Math.sin(x * 0.31 + Math.sin(z * 0.23) * 2) * Math.cos(z * 0.27 - x * 0.09);
    const hue = 0.5 + 0.5 * Math.sin(x * 0.13 - z * 0.17 + 1.3);
    // Yellow-green (warm, less blue) to blue-green (cool, less red).
    colors[i * 3] = value * (1.15 - 0.35 * hue);
    colors[i * 3 + 1] = value;
    colors[i * 3 + 2] = value * (0.7 + 0.6 * hue);
  }
  geometry.setAttribute("color", new BufferAttribute(colors, 3));
  return geometry;
}

/** The surfaces the island is made of, resolved once. */
export function createMaterials() {
  return {
    grass: lit(palette.grass, { vertexColors: true }),
    rock: lit(palette.rock, { flat: true, vertexColors: true }),
  };
}
