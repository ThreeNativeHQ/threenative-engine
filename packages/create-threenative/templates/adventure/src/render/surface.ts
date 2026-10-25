// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// The vale's and the Hollow's surfaces: five tiling photo textures shared with the other kits (see
// `assets/tex-PROVENANCE.md`), loaded once in `Play.load()`. A surface keeps the colour and the
// vertex shading the scene paints and takes only the photo's structure: each sample is divided by
// the photo's own average (its last mip level), so grass blades, rock cracks, bark grooves and
// coursed stone show in the vale's palette. No surface samples a tile plainly:
// - `stochastic` (Inigo Quilez's "texture repetition" technique) shifts the floor's grass by a
//   random offset per noise patch and cross-fades two neighbouring offsets, so no two patches line
//   up. The mip level comes from the base UV's own derivatives, so the seams never pick a blurred mip.
// - `triplanar` maps from the three world axes, so stones, trunks and walls need no UVs and a tile
//   never stretches over a long face.
import {
  Color,
  type ColorRepresentation,
  DoubleSide,
  FrontSide,
  type Material,
  type Mesh,
  type MeshStandardMaterial,
  type Object3D,
  RepeatWrapping,
  type Texture,
} from "three";
import {
  abs,
  attribute,
  color as colorNode,
  cross,
  dFdx,
  dFdy,
  dot,
  float,
  floor,
  fract,
  log2,
  max,
  min,
  mix,
  normalWorldGeometry,
  positionWorld,
  sin,
  smoothstep,
  texture,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { MeshStandardNodeMaterial, type Node } from "three/webgpu";
import { detailTexture, lit } from "./materials.js";

type TextureLoader = {
  texture(path: string, options?: { wrap?: number; anisotropy?: number }): Promise<Texture>;
};

// The files live once in the package's `template-assets/assets/`; the scaffolder copies each one
// named here, with `tex-PROVENANCE.md` (its licence record).
const FILES = {
  bark: "tex-bark.webp",
  grass: "tex-grass.webp",
  planks: "tex-planks.webp",
  rock: "tex-rock.webp",
  "stone-wall": "tex-stone-wall.webp",
} as const;
export type Surface = keyof typeof FILES;
/** Metres per repeat of each tile. */
const TILE: Record<Surface, number> = {
  bark: 1.2,
  grass: 4,
  planks: 1,
  rock: 2.5,
  "stone-wall": 3,
};

let maps: Record<Surface, Texture> | undefined;
const cache = new Map<string, Material>();
/** Every colour a surface was asked for: wood, stone and bark tones. */
const surfaceColors = new Set<number>();

/** Loads the five textures once, in sRGB, repeating and anisotropic. */
export async function loadSurfaces(assets: TextureLoader): Promise<void> {
  const names = Object.keys(FILES) as Surface[];
  const loaded = await Promise.all(
    names.map((name) => assets.texture(FILES[name], { anisotropy: 8, wrap: RepeatWrapping })),
  );
  maps = Object.fromEntries(names.map((name, i) => [name, loaded[i]])) as Record<Surface, Texture>;
}

/**
 * `map` at `at` (in tiles), shifted by a random offset per noise patch and cross-faded between two
 * offsets. `size` is the texture's width in texels: the mip level is computed from it and the base
 * UV's derivatives (the geometric mean of the two axes, at most two levels finer than the long one).
 */
function stochastic(map: Texture, at: Node<"vec2">, size: number) {
  const dx = dFdx(at);
  const dy = dFdy(at);
  const long = max(dot(dx, dx), dot(dy, dy));
  const short = min(dot(dx, dx), dot(dy, dy));
  const level = max(log2(long).mul(0.5).sub(2), log2(long).add(log2(short)).mul(0.25))
    .add(Math.log2(size))
    .max(0);
  // The grain map spans 0.62 to 1: stretched to eight offsets per unit, one noise texel a tile.
  const index = texture(detailTexture(), at.mul(1 / 48))
    .x.sub(0.62)
    .mul(21);
  const i = floor(index);
  const f = fract(index);
  const a = texture(map, at.add(sin(vec2(3, 7).mul(i)))).level(level);
  const b = texture(map, at.add(sin(vec2(3, 7).mul(i.add(1))))).level(level);
  // Fade on the texels' own difference, so the switch follows the texture's features, not a line.
  const fade = smoothstep(0.2, 0.8, f.sub(dot(a.sub(b), vec4(0.1, 0.1, 0.1, 0))));
  return mix(a, b, fade).xyz;
}

/**
 * `map` projected from the three world axes, `tile` metres per repeat, blended by the normal. A
 * flat-shaded surface takes its face's own normal from the position's derivatives: the owned engine
 * gives a flat-shaded material no vertex normal, so `normalWorldGeometry` would stop the renderer.
 */
function triplanar(map: Texture, tile: number, flat: boolean) {
  const p = positionWorld.div(tile);
  const n = abs(
    flat ? cross(dFdx(positionWorld), dFdy(positionWorld)).normalize() : normalWorldGeometry,
  );
  const w = n.mul(n).mul(n).mul(n);
  const sum = w.x.add(w.y).add(w.z);
  return texture(map, p.zy)
    .xyz.mul(w.x)
    .add(texture(map, p.xz).xyz.mul(w.y))
    .add(texture(map, p.xy).xyz.mul(w.z))
    .div(sum);
}

/** A sample over the photo's own average colour: about 1, darker in its cracks, lighter on its ridges. */
function structure(map: Texture, sample: Node<"vec3">, strength: number | Node<"float">) {
  const mean = max(texture(map, vec2(0.5, 0.5)).level(float(16)).xyz, vec3(0.02, 0.02, 0.02));
  return mix(colorNode(1, 1, 1), sample.div(mean), strength);
}

/**
 * A lit, rough surface in `color` (times the vertex colours when `vertexColors`) carrying the
 * structure of photo `surface`. Before `loadSurfaces` resolves (the hero viewer, unit tests) it is
 * `lit` with the code-baked grain.
 */
export function surfaced(
  color: ColorRepresentation,
  surface: Surface,
  options: {
    roughness?: number;
    vertexColors?: boolean;
    flat?: boolean;
    doubleSided?: boolean;
    /** How much of the photo's light and dark shows, 0 to 1. */
    strength?: number;
  } = {},
): Material {
  const { strength = 0.9, ...shape } = options;
  surfaceColors.add(new Color(color).getHex());
  if (maps === undefined) return lit(color, { ...shape, detail: true });
  const key = `${String(color)}|${surface}|${JSON.stringify(options)}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const map = maps[surface];
  const material = new MeshStandardNodeMaterial({
    flatShading: options.flat ?? false,
    roughness: options.roughness ?? 0.85,
    side: options.doubleSided === true ? DoubleSide : FrontSide,
    vertexColors: options.vertexColors ?? false,
  });
  material.colorNode = structure(
    map,
    triplanar(map, TILE[surface], options.flat ?? false),
    strength,
  ).mul(colorNode(new Color(color)));
  cache.set(key, material);
  return material;
}

/**
 * Meshes under `root` painted in a surface's colour with a plain material and no photo: a chest or
 * a post built with `lit(C.wood)` where `surfaced(C.wood, "planks")` was meant. White is skipped,
 * as a white material takes its colours from the vertices. 0 when every wood, stone and bark tone
 * carries its photo; the whole set when the photos failed to load.
 */
export function untexturedSurfaces(root: Object3D): number {
  let count = 0;
  root.traverse((object) => {
    if (!(object as Mesh).isMesh) return;
    const materials = [(object as Mesh).material].flat();
    for (const material of materials) {
      const plain = material as MeshStandardMaterial | null;
      if (plain?.type !== "MeshStandardMaterial") continue;
      const hex = plain.color.getHex();
      if (hex !== 0xffffff && surfaceColors.has(hex)) count += 1;
    }
  });
  return count;
}

/**
 * The vale's floor: grass offset per patch on level ground, rock projected from three axes where
 * the ground is steeper than Wren can climb, under the colours `valeGround` paints. Blades show in
 * full only where that paint is green: on the dry, brown banks a grass photo reads as straw.
 */
export function groundSurface(): Material {
  if (maps === undefined) return lit(0xffffff, { detail: true, vertexColors: true });
  const material = new MeshStandardNodeMaterial({ roughness: 0.9, vertexColors: true });
  const paint = attribute<"vec3">("color", "vec3");
  const grass = structure(
    maps.grass,
    stochastic(maps.grass, positionWorld.xz.div(TILE.grass), 512),
    smoothstep(-0.02, 0.06, paint.y.sub(paint.x)).mul(0.6).add(0.3),
  );
  const rock = structure(maps.rock, triplanar(maps.rock, TILE.rock, false), 0.9);
  material.colorNode = mix(grass, rock, smoothstep(0.8, 0.68, normalWorldGeometry.y));
  return material;
}
