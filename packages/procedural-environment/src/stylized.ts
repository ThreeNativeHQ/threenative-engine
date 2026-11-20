import type { Object3D } from "three";
import { BIOMES, CATALOG, build } from "../vendor/stylized-biome-kit/catalog.js";
import { type IStylizedScene, SCENES } from "../vendor/stylized-biome-kit/scenes.js";

export {
  materials as stylizedMaterials,
  uniforms as stylizedUniforms,
} from "../vendor/stylized-biome-kit/core.js";
export { scatter, sky, terrain } from "../vendor/stylized-biome-kit/ground.js";

export interface IStylizedAsset {
  id: string;
  name: string;
  kind: "stylized";
  category: string;
  biomes: string[];
  variants: number;
}

export interface IStylizedAssetOptions {
  variant?: number;
  seed?: number;
  overrides?: Record<string, unknown>;
}

const biomeIds: Record<string, string[]> = {
  forest: ["alpine", "forest"],
  snow: ["alpine", "tundra"],
  desert: ["desert"],
  shared: ["alpine", "forest", "tundra", "desert"],
};

/**
 * List the Stylized Biome Kit pieces and scenes, including available variants.
 * @situation browse procedural stylized biome assets for alpine forest, snow peaks, or desert canyon
 * @requires npm i @threenative/procedural-environment
 * @example const rows = stylizedAssets();
 */
export function stylizedAssets(): IStylizedAsset[] {
  return [
    ...Object.keys(SCENES).map(
      (biome): IStylizedAsset => ({
        id: `scene-${biome}`,
        name: BIOMES[biome] ?? biome,
        kind: "stylized",
        category: "Scenes",
        biomes: biomeIds[biome] ?? [],
        variants: 1,
      }),
    ),
    ...CATALOG.map(
      (entry): IStylizedAsset => ({
        id: entry.id,
        name: entry.name,
        kind: "stylized",
        category: BIOMES[entry.biome] ?? entry.biome,
        biomes: biomeIds[entry.biome] ?? [],
        variants: entry.variants.length,
      }),
    ),
  ];
}

/**
 * Generate a Stylized Biome Kit piece or scene with the kit's original Three.js materials.
 * @situation create stylized mountain ridges, snowy trees, sandstone formations, or animated water
 * @constraint the original shaders use Three.js WebGL materials
 * @requires npm i @threenative/procedural-environment
 * @example const { group } = createStylizedAsset("mountain-snow", { seed: 8, variant: 1 });
 */
export function createStylizedAsset(
  id: string,
  options: IStylizedAssetOptions = {},
): {
  group: Object3D;
  animated: boolean;
  view?: IStylizedScene["view"];
  env?: IStylizedScene["env"];
} {
  const { variant = 0, seed, overrides } = options;
  if (seed !== undefined && !Number.isSafeInteger(seed))
    throw new Error("Stylized seed must be an integer");
  const entry = CATALOG.find((asset) => asset.id === id);
  if (!entry) {
    const key = id.slice(6);
    const scene = id.startsWith("scene-") && Object.hasOwn(SCENES, key) ? SCENES[key] : undefined;
    if (!scene) throw new Error(`Unknown stylized asset "${id}"`);
    if (variant !== 0 || overrides) throw new Error("Stylized scenes accept only a seed");
    return { ...scene({ seed }), animated: true };
  }
  if (!Number.isInteger(variant) || variant < 0 || variant >= entry.variants.length) {
    throw new Error(`Invalid variant ${variant} for stylized asset "${id}"`);
  }
  const group = build(entry, variant, { ...overrides, ...(seed === undefined ? {} : { seed }) });
  if (entry.fn === "sky") {
    return { group, animated: false, view: { pos: [0, 0, 1], target: [0, 0.25, 0] } };
  }
  return {
    group,
    animated: [
      "water",
      "waterfall",
      "grassTuft",
      "pine",
      "roundTree",
      "twistedTree",
      "palm",
      "bush",
      "fern",
      "shrub",
      "flowers",
    ].includes(entry.fn),
  };
}
