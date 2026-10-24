// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// The island's surfaces: the eight tiling photo textures in `assets/textures/` (see its
// PROVENANCE.md), loaded once through `ctx.assets`, and the samplers that hide their tiling. A tile
// repeated over a field reads as wallpaper, so no surface here samples a texture plainly:
// - `stochastic` (Inigo Quilez's "texture repetition" technique) shifts the texture by a random
//   offset per patch of a low-frequency noise and cross-fades two neighbouring offsets, so no two
//   patches of grass or sand line up. The mip level comes from the base UV's own derivatives, so
//   the seams between offsets never pick a blurred mip.
// - `macro` multiplies a brightness and hue drift from two scales of world-space noise (9 m, 37 m),
//   which breaks up the repeat of the structured textures (stone, tiles) that cannot be offset.
// - `triplanar` maps the rock from three axes on cliffs and slopes, where a top-down UV stretches.
import {
  type DataTexture,
  LinearFilter,
  MeshStandardMaterial,
  RepeatWrapping,
  type Texture,
  Vector2,
} from "three";
import {
  abs,
  attribute,
  dFdx,
  dFdy,
  dot,
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
  uv,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { MeshStandardNodeMaterial, type Node } from "three/webgpu";
import { valueNoise } from "./ground.js";
import { paintedTexture } from "./materials.js";

type TextureLoader = {
  texture(
    path: string,
    options?: { data?: boolean; wrap?: number; anisotropy?: number },
  ): Promise<Texture>;
};

const ALBEDO = [
  "grass",
  "sand",
  "rock",
  "stone-wall",
  "roof-tiles",
  "bark",
  "birch-bark",
  "planks",
];
const NORMAL = ["sand", "rock", "stone-wall", "roof-tiles", "bark", "planks"];

export interface ISurfaces {
  readonly albedo: Readonly<Record<string, Texture>>;
  readonly normal: Readonly<Record<string, Texture>>;
  /** 64 x 64 tiling value noise, linear: the patches and the macro drift sample it. */
  readonly noise: DataTexture;
}

/** Loads every texture once: albedo in sRGB, normal maps as data, all repeating and anisotropic. */
export async function loadSurfaces(assets: TextureLoader): Promise<ISurfaces> {
  const load = (name: string, data: boolean) =>
    assets.texture(`textures/${name}.webp`, { anisotropy: 8, data, wrap: RepeatWrapping });
  const [albedo, normal] = await Promise.all([
    Promise.all(ALBEDO.map((name) => load(name, false))),
    Promise.all(NORMAL.map((name) => load(`${name}-normal`, true))),
  ]);
  const field = valueNoise(64, 5);
  const noise = paintedTexture(
    64,
    64,
    (x, y) => {
      const value = field(x / 64, y / 64);
      return [value, value, value];
    },
    false,
  );
  noise.generateMipmaps = false;
  noise.minFilter = LinearFilter;
  return {
    albedo: Object.fromEntries(ALBEDO.map((name, i) => [name, albedo[i] as Texture])),
    normal: Object.fromEntries(NORMAL.map((name, i) => [name, normal[i] as Texture])),
    noise,
  };
}

/**
 * `map` at `at` (in tiles), shifted by a random offset per noise patch and cross-faded between two
 * offsets. `size` is the texture's width in texels: the mip level is computed from it and the base
 * UV's derivatives (the geometric mean of the two axes, at most two levels finer than the long
 * one: an anisotropic filter's sharpness without its taps).
 */
export function stochastic(map: Texture, noise: Texture, at: Node<"vec2">, size: number) {
  const dx = dFdx(at);
  const dy = dFdy(at);
  const long = max(dot(dx, dx), dot(dy, dy));
  const short = min(dot(dx, dx), dot(dy, dy));
  const level = max(log2(long).mul(0.5).sub(2), log2(long).add(log2(short)).mul(0.25))
    .add(Math.log2(size))
    .max(0);
  // One noise texel spans about a tile; eight offsets per unit of noise.
  const index = texture(noise, at.mul(1 / 48)).x.mul(8);
  const i = floor(index);
  const f = fract(index);
  const offsetA = sin(vec2(3, 7).mul(i));
  const offsetB = sin(vec2(3, 7).mul(i.add(1)));
  const a = texture(map, at.add(offsetA)).level(level);
  const b = texture(map, at.add(offsetB)).level(level);
  // Fade on the texels' own difference, so the switch follows the texture's features, not a line.
  const fade = smoothstep(0.2, 0.8, f.sub(dot(a.sub(b), vec4(0.1, 0.1, 0.1, 0))));
  return mix(a, b, fade).xyz;
}

/** World-space brightness drift, about 0.84 to 1.12, from noise at 37 m and 9 m. */
export function macro(noise: Texture, xz: Node<"vec2">) {
  const broad = texture(noise, xz.mul(1 / (37 * 64))).x;
  const fine = texture(noise, xz.mul(1 / (9 * 64)).add(0.37)).x;
  return broad.mul(0.6).add(fine.mul(0.4)).mul(0.28).add(0.84);
}

/** `map` projected from the three world axes, `tile` metres per repeat, blended by the normal. */
export function triplanar(map: Texture, tile: number) {
  const p = positionWorld.div(tile);
  const n = abs(normalWorldGeometry);
  const w = n.mul(n).mul(n).mul(n);
  const sum = w.x.add(w.y).add(w.z);
  return texture(map, p.zy)
    .xyz.mul(w.x)
    .add(texture(map, p.xz).xyz.mul(w.y))
    .add(texture(map, p.xy).xyz.mul(w.z))
    .div(sum);
}

/**
 * The terrain: grass, sand and rock blended by the `layer` attribute `paintGround` writes (x sand,
 * y rock, z worn grass by the path), each edge broken up by noise so a path never ends on a ruled
 * line, then the macro drift. The vertex `tint` is the lawn's broad hue patches.
 */
export function groundMaterial(s: ISurfaces): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({ roughness: 0.94 });
  const xz = positionWorld.xz;
  const layer = attributeVec3("layer");
  const tint = attributeVec3("tint");
  // The photo tile is a dull olive: pushed toward the reference's vivid lawn green.
  const grass = stochastic(s.albedo.grass as Texture, s.noise, xz.div(4), 512)
    .mul(tint)
    .mul(vec3(0.9, 1.08, 0.55));
  // Warmed toward the reference's golden path sand; the photo tile is a pale grey-beige.
  const sand = stochastic(s.albedo.sand as Texture, s.noise, xz.div(3), 512).mul(
    vec3(1.05, 0.93, 0.72),
  );
  // Greyed: the photo tile is a warm brown that reads as straw on a sunlit cliff.
  const rock = triplanar(s.albedo.rock as Texture, 2.5).mul(vec3(0.82, 0.86, 0.95));
  const edge = texture(s.noise, xz.div(5 * 64)).x.sub(0.5);
  const worn = mix(grass, grass.mul(vec3(0.95, 0.85, 0.7)), layer.z);
  const sandy = smoothstep(0.3, 0.7, layer.x.add(edge.mul(0.7)));
  const rocky = smoothstep(0.35, 0.65, layer.y.add(edge.mul(0.4)));
  material.colorNode = mix(mix(worn, sand, sandy), rock, rocky).mul(macro(s.noise, xz));
  material.normalMap = s.normal.sand as Texture;
  material.normalScale = new Vector2(0.7, 0.7);
  return material;
}

/** A drum's lawn: the terrain's grass, offset per patch, under the geometry's hue patches. */
export function lawnMaterial(s: ISurfaces): MeshStandardNodeMaterial {
  // vertexColors multiplies the colorNode by the geometry's `color` patches.
  const material = new MeshStandardNodeMaterial({ roughness: 0.94, vertexColors: true });
  const xz = positionWorld.xz;
  material.colorNode = stochastic(s.albedo.grass as Texture, s.noise, xz.div(4), 512).mul(
    macro(s.noise, xz),
  );
  return material;
}

/**
 * Coursed stone on the geometry's own UVs (`planarUv`, 3 m a tile), the macro drift, and grime: a
 * darker, greener band in the metre and a half above `foot` (world y), where rain splashes and moss
 * grows. Block colour already varies inside the texture.
 */
export function masonryMaterial(s: ISurfaces, foot: number): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({ roughness: 0.88 });
  const grime = smoothstep(foot, foot + 1.6, positionWorld.y).oneMinus();
  const stone = texture(s.albedo["stone-wall"] as Texture, uv()).xyz;
  material.colorNode = mix(stone, stone.mul(vec3(0.62, 0.66, 0.52)), grime.mul(0.7)).mul(
    macro(s.noise, positionWorld.xz.add(positionWorld.y)),
  );
  material.normalMap = s.normal["stone-wall"] as Texture;
  material.normalScale = new Vector2(1.3, 1.3);
  return material;
}

/** Natural rock (boulders): triplanar, so any shape takes it without UVs. */
export function rockMaterial(s: ISurfaces): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({ roughness: 0.9 });
  material.colorNode = triplanar(s.albedo.rock as Texture, 2.5).mul(
    macro(s.noise, positionWorld.xz),
  );
  return material;
}

/** A plain textured surface on the geometry's UVs: roof tiles, planks, bark. */
export function texturedMaterial(
  s: ISurfaces,
  name: string,
  options: { roughness?: number; normalScale?: number; doubleSided?: boolean } = {},
): MeshStandardMaterial {
  const normal = s.normal[name];
  return new MeshStandardMaterial({
    map: s.albedo[name] as Texture,
    normalMap: normal ?? null,
    normalScale: new Vector2(options.normalScale ?? 1, options.normalScale ?? 1),
    roughness: options.roughness ?? 0.85,
    side: options.doubleSided === true ? 2 : 0,
  });
}

/** A named vec3 vertex attribute as a node. */
function attributeVec3(name: string): Node<"vec3"> {
  return attribute<"vec3">(name, "vec3");
}
