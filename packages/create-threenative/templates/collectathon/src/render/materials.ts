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
 * the meter see a world of albedos rather than of glints. `emissive` is for the collectibles only:
 * a gold that glows a little reads as "take me" against grass at any exposure.
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

/** The surfaces the island is made of, resolved once. */
export function createMaterials() {
  return {
    grass: lit(palette.grass, { vertexColors: true }),
    rock: lit(palette.rock, { flat: true, vertexColors: true }),
  };
}
