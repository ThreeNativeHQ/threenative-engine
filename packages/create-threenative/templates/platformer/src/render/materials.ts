// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// One material per colour, cached, because a level is thousands of small meshes sharing a dozen
// colours: a fresh material per mesh is a fresh shader compile per mesh. `flat` is the unlit
// variant for anything that must stay bright regardless of the sun (clouds, water, the goal
// cloth), and `mottle` is how a flat box becomes mottled stone with no texture at all.
import {
  BoxGeometry,
  BufferAttribute,
  type BufferGeometry,
  type ColorRepresentation,
  DoubleSide,
  type Material,
  MeshBasicMaterial,
  MeshStandardMaterial,
} from "three";
import { C, palette } from "./palette.js";

const cache = new Map<string, Material>();

function cached<T extends Material>(key: string, make: () => T): T {
  const hit = cache.get(key);
  if (hit !== undefined) return hit as T;
  const material = make();
  cache.set(key, material);
  return material;
}

/**
 * Lit surface. `flatShading` keeps the low-poly facets reading as facets under one sun, and
 * `vertexColors` is what makes `mottle`'s baked variation visible.
 *
 * The two flags are part of the cache key, so a mottled material and a plain one of the same
 * colour are different materials. That is what lets a whole scenery subtree be merged into one
 * draw per material: two meshes in one bucket must agree on every attribute, and a bucket that
 * half its pieces cannot see is a bucket that silently loses the mottle.
 */
export function toon(
  color: ColorRepresentation,
  options: { flat?: boolean; vertexColors?: boolean } = {},
): MeshStandardMaterial {
  return cached(
    `lit|${String(color)}|${String(options.flat ?? false)}|${String(options.vertexColors ?? false)}`,
    () =>
      new MeshStandardMaterial({
        color,
        flatShading: options.flat ?? false,
        metalness: 0,
        roughness: 0.82,
        vertexColors: options.vertexColors ?? false,
      }),
  );
}

/** Unlit, for things that stay bright whatever the sun does; opacity below 1 enables transparency. */
export function flat(
  color: ColorRepresentation,
  options: { depthWrite?: boolean; fog?: boolean; opacity?: number; side?: typeof DoubleSide } = {},
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
 * Bake a per-quad brightness variation into a geometry as vertex colours.
 *
 * Two triangles share one tint so a quad reads as a flat stone facet rather than a smooth
 * gradient, which is what turns a grey box into rock without a single texture.
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
    for (let v = 0; v < 6 && i + v < count; v += 1) {
      colors[(i + v) * 3] = k;
      colors[(i + v) * 3 + 1] = k;
      colors[(i + v) * 3 + 2] = k;
    }
  }
  g.setAttribute("color", new BufferAttribute(colors, 3));
  return g;
}

/** A box subdivided into rough facets, ready for `mottle`. */
export function rockBox(
  width: number,
  height: number,
  depth: number,
  rng: () => number = Math.random,
  variance = 0.2,
): BufferGeometry {
  const segments = (n: number): number => Math.max(1, Math.min(6, Math.round(n / 3)));
  return mottle(
    new BoxGeometry(width, height, depth, segments(width), segments(height), segments(depth)),
    variance,
    rng,
  );
}

/** The handful of surfaces this level is made of, resolved once. */
export function createMaterials() {
  return {
    accent: toon(palette.accent),
    cloth: flat(0xff5a4a, { side: DoubleSide }),
    dirt: toon(C.dirt),
    foliage: toon(C.grass),
    rock: toon(C.rock, { flat: true }),
    rockDark: toon(C.rockDark, { flat: true }),
    wood: toon(C.wood),
    woodDark: toon(C.woodDark),
  };
}
