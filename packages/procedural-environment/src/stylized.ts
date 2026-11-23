import { type Material, Mesh, type Object3D, PointLight } from "three";
import { BIOMES, CATALOG, build } from "../vendor/stylized-biome-kit/catalog.js";
import { type IStylizedScene, SCENES } from "../vendor/stylized-biome-kit/scenes.js";

import { materials } from "../vendor/stylized-biome-kit/core.js";
import { buildDungeonPart, dungeonEntries } from "./dungeon/catalog.js";
import { THEME_BIOMES, THEME_NAMES, dungeonMaterials } from "./dungeon/mesh.js";
import { buildDungeonScene, dungeonScenes } from "./dungeon/scene.js";
import { buildVillagePart, villageEntries } from "./village/catalog.js";
import { VILLAGE_BIOMES, VILLAGE_THEMES } from "./village/kit.js";
import { buildVillageScene, villageScenes } from "./village/scene.js";

export { uniforms as stylizedUniforms } from "../vendor/stylized-biome-kit/core.js";
export const stylizedMaterials: Record<string, Material> = { ...materials, ...dungeonMaterials };
export { scatter, sky, terrain } from "../vendor/stylized-biome-kit/ground.js";

export interface IStylizedAsset {
  id: string;
  name: string;
  kind: "stylized" | "dungeon" | "village";
  category: string;
  biomes: string[];
  variants: number;
  variantNames?: readonly string[];
}

export interface IStylizedAssetOptions {
  variant?: number;
  seed?: number;
  overrides?: Record<string, unknown>;
}

const dungeonRows = [
  ...Object.entries(dungeonScenes).map(([id, name]) => ({ id, name, category: "Scenes" })),
  ...dungeonEntries,
];

const villageRows = [
  ...Object.entries(villageScenes).map(([id, name]) => ({ id, name, category: "Scenes" })),
  ...villageEntries,
];

const biomeIds: Record<string, string[]> = {
  forest: ["alpine", "forest"],
  snow: ["alpine", "tundra"],
  desert: ["desert"],
  shared: ["alpine", "forest", "tundra", "desert"],
};

/**
 * List the Stylized Biome Kit pieces and scenes, including available variants.
 * @situation browse procedural stylized biome assets for alpine forest, snow peaks, or desert canyon
 * @situation browse modular dungeon walls, stone floors, arches, doors, props, fixtures, and assembled dungeon scenes
 * @situation browse stylized village houses, timber walls, fences, paths, props, and the assembled village green
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
    ...dungeonRows.map(
      ({ id, name, category }): IStylizedAsset => ({
        id: `dungeon-${id}`,
        name,
        category,
        kind: "dungeon",
        biomes: [...THEME_BIOMES],
        variants: THEME_NAMES.length,
        variantNames: THEME_NAMES,
      }),
    ),
    ...villageRows.map(
      ({ id, name, category }): IStylizedAsset => ({
        id: `village-${id}`,
        name,
        category,
        kind: "village",
        biomes: [...VILLAGE_BIOMES],
        variants: VILLAGE_THEMES.length,
        variantNames: VILLAGE_THEMES,
      }),
    ),
  ];
}

function themedAsset(id: string, { variant = 0, seed = 1, overrides }: IStylizedAssetOptions) {
  const village = id.startsWith("village-");
  const kit = village ? "Village" : "Dungeon";
  const themes = village ? VILLAGE_THEMES : THEME_NAMES;
  if (!Number.isInteger(variant) || variant < 0 || variant >= themes.length)
    throw new Error(`Invalid ${kit.toLowerCase()} theme variant ${variant}`);
  if (overrides) throw new Error(`${kit} assets accept a theme variant and seed`);
  const key = id.slice(id.indexOf("-") + 1);
  const scene = village
    ? Object.hasOwn(villageScenes, key)
      ? buildVillageScene(key as keyof typeof villageScenes, seed, variant)
      : undefined
    : key === "courtyard" || key === "assembly"
      ? buildDungeonScene(key, seed, variant)
      : undefined;
  const group =
    scene?.group ??
    (village ? buildVillagePart(key, seed, variant) : buildDungeonPart(key, seed, variant));
  const lights: PointLight[] = [];
  group.traverse((node) => {
    if (node instanceof PointLight && node.userData.fire) lights.push(node);
  });
  const animated =
    Boolean(scene) ||
    group.children.some(
      (node) => node instanceof Mesh && node.material === dungeonMaterials.dungeonGlow,
    );
  const update = lights.length
    ? (seconds: number) => {
        for (const light of lights) {
          const { intensity, phase } = light.userData.fire;
          light.intensity =
            intensity *
            (0.91 +
              0.07 * Math.sin(seconds * 9.1 + phase) +
              0.055 * Math.cos(seconds * 13.7 - phase));
        }
      }
    : undefined;
  return { ...scene, group, animated, update };
}

function biomeScene(id: string, { variant = 0, seed, overrides }: IStylizedAssetOptions) {
  const key = id.slice(6);
  const scene = id.startsWith("scene-") && Object.hasOwn(SCENES, key) ? SCENES[key] : undefined;
  if (!scene) throw new Error(`Unknown stylized asset "${id}"`);
  if (variant !== 0 || overrides) throw new Error("Stylized scenes accept only a seed");
  return { ...scene({ seed }), animated: true };
}

/**
 * Generate a Stylized Biome Kit, Dungeon or Village piece or scene with its Three.js materials.
 * @situation create stylized mountain ridges, snowy trees, sandstone formations, or animated water
 * @situation create modular dungeon walls, stairs, arches, dungeon props and fixtures in an overgrown, frozen, or volcanic theme
 * @situation create a stylized medieval village: cottages, tavern, barn, windmill, forge, market stall, well, fences and props in a meadow, snowy, or desert theme
 * @constraint the biome shaders, dungeon surface finish, and fire motion use Three.js WebGL materials
 * @requires npm i @threenative/procedural-environment
 * @example const { group } = createStylizedAsset("mountain-snow", { seed: 8, variant: 1 });
 */
export function createStylizedAsset(
  id: string,
  options: IStylizedAssetOptions = {},
): {
  group: Object3D;
  animated: boolean;
  update?: (seconds: number) => void;
  view?: IStylizedScene["view"];
  env?: IStylizedScene["env"];
} {
  const { variant = 0, seed, overrides } = options;
  if (seed !== undefined && !Number.isSafeInteger(seed))
    throw new Error("Stylized seed must be an integer");
  if (id.startsWith("dungeon-") || id.startsWith("village-")) return themedAsset(id, options);
  const entry = CATALOG.find((asset) => asset.id === id);
  if (!entry) return biomeScene(id, options);
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
