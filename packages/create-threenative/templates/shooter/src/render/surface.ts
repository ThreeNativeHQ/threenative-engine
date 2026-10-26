// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// Bayview's surfaces: five tiling textures generated for this kit (see `assets/bay-PROVENANCE.md`),
// loaded once in `Play.load()`. A surface keeps the colour `palette.ts` gives it and takes only the
// texture's structure: each sample is divided by the texture's own average (its last mip level), so
// the town's neutral whites and greys stay where the palette puts them. The town's geometry already
// carries world-metre UVs (`worldGridUVs`), so one sample is a fixed size on every face.
// - The same texture sampled again at a much larger, turned scale breaks the repeat at street distance.
// - A wall darkens towards the street, where dust and splash collect (`grime`).
// - Roughness follows the texture: a worn, lighter patch is smoother than a pit.
// - The fine detail fades out with distance, as a Megascans detail texture does in Unreal: past
//   `fade` metres a board joint is under a pixel and would only crawl.
import {
  type ColorRepresentation,
  type Material,
  RepeatWrapping,
  type Texture,
  Vector2,
} from "three";
import {
  cameraPosition,
  float,
  materialColor,
  materialRoughness,
  max,
  mix,
  positionWorld,
  smoothstep,
  texture,
  uv,
  vec2,
  vec3,
} from "three/tsl";
import { MeshStandardNodeMaterial, type Node } from "three/webgpu";

type TextureLoader = {
  texture(
    path: string,
    options?: { wrap?: number; anisotropy?: number; data?: boolean },
  ): Promise<Texture>;
};

// The files live once in the package's `template-assets/assets/`; the scaffolder copies each one
// named here, with `bay-PROVENANCE.md` (its generation record). The three most-seen surfaces also
// carry a normal map derived from their own light and dark: a joint, a gap or a trowel mark is a dent.
const FILES = {
  plaster: "bay-plaster.webp",
  pavement: "bay-pavement.webp",
  wood: "bay-wood.webp",
  metal: "bay-metal.webp",
  ground: "bay-ground.webp",
} as const;
export type Surface = keyof typeof FILES;
const NORMALS: Partial<Record<Surface, string>> = {
  plaster: "bay-plaster-normal.webp",
  pavement: "bay-pavement-normal.webp",
  wood: "bay-wood-normal.webp",
};
/** Metres per repeat of each tile. */
const TILE: Record<Surface, number> = {
  plaster: 3,
  pavement: 2.4,
  wood: 2.4,
  metal: 1.5,
  ground: 4,
};

let maps: Record<Surface, Texture> | undefined;
let normals: Partial<Record<Surface, Texture>> = {};

/** Loads the textures once: albedo in sRGB, normal maps as data, all repeating and anisotropic. */
export async function loadSurfaces(assets: TextureLoader): Promise<void> {
  const load = (file: string, data: boolean) =>
    assets.texture(file, { anisotropy: 8, data, wrap: RepeatWrapping });
  const names = Object.keys(FILES) as Surface[];
  const bumped = names.filter((name) => NORMALS[name] !== undefined);
  const [albedo, normal] = await Promise.all([
    Promise.all(names.map((name) => load(FILES[name], false))),
    Promise.all(bumped.map((name) => load(NORMALS[name] as string, true))),
  ]);
  maps = Object.fromEntries(names.map((name, i) => [name, albedo[i]])) as Record<Surface, Texture>;
  normals = Object.fromEntries(
    bumped.map((name, i) => {
      // The normal map rides the geometry's metre UVs, so its repeat sets the tile size.
      (normal[i] as Texture).repeat.setScalar(1 / TILE[name]);
      return [name, normal[i]];
    }),
  );
}

/** A sample over the texture's own average: about 1, darker in its pits, lighter on its ridges. */
function structure(map: Texture, at: Node<"vec2">, strength: Node<"float"> | number) {
  const mean = max(texture(map, vec2(0.5, 0.5)).level(float(16)).xyz, vec3(0.02, 0.02, 0.02));
  return mix(vec3(1, 1, 1), texture(map, at).xyz.div(mean), strength);
}

export interface ISurfaceOptions {
  readonly roughness: number;
  readonly metalness?: number;
  /** How much of the texture's light and dark shows, 0 to 1. */
  readonly strength?: number;
  /** How much darker the foot of a wall is than its top, 0 to 1. */
  readonly grime?: number;
  /** How deep the surface's normal map reads; 0 is flat. */
  readonly bump?: number;
  /** How much the large, turned copy of the texture shows, 0 to 1. */
  readonly patches?: number;
  /** Metres from the camera at which the fine detail has faded to a fifth. */
  readonly fade?: number;
}

/**
 * A lit surface in `color` carrying the structure of texture `surface`, or `undefined` before
 * `loadSurfaces` resolves (unit tests, a failed download): the caller keeps its plain material then.
 */
export function surfaced(
  color: ColorRepresentation,
  surface: Surface,
  options: ISurfaceOptions,
): Material | undefined {
  if (maps === undefined) return undefined;
  const map = maps[surface];
  const { strength = 0.8, grime = 0, metalness = 0, bump = 0, patches: wear = 0.45 } = options;
  const { fade = 40 } = options;
  const at = uv().div(TILE[surface]);
  const near = smoothstep(fade, fade * 0.25, positionWorld.distance(cameraPosition));
  const detail = structure(map, at, near.mul(0.8).add(0.2).mul(strength));
  // A turned, seven-times-larger copy: soft patches of wear that do not line up with the tile.
  const patches = structure(map, vec2(at.y.mul(-0.137), at.x.mul(0.141)), wear);
  const foot = mix(float(1 - grime), float(1), smoothstep(0, 1.4, positionWorld.y));
  const material = new MeshStandardNodeMaterial({ color, roughness: options.roughness, metalness });
  material.colorNode = materialColor.mul(detail).mul(patches).mul(foot);
  material.roughnessNode = materialRoughness.mul(float(2).sub(detail.x).clamp(0.7, 1.3));
  const normal = normals[surface];
  if (bump > 0 && normal !== undefined) {
    material.normalMap = normal;
    material.normalScale = new Vector2(bump, bump);
  }
  return material;
}
