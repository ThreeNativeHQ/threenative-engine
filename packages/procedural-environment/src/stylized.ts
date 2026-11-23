import { type Material, Mesh, type Object3D, PointLight } from "three";
import { BIOMES, CATALOG, build } from "../vendor/stylized-biome-kit/catalog.js";
import { type IStylizedScene, SCENES } from "../vendor/stylized-biome-kit/scenes.js";

import { materials } from "../vendor/stylized-biome-kit/core.js";
import { buildDungeonPart, dungeonEntries } from "./dungeon/catalog.js";
import { THEME_BIOMES, THEME_NAMES, dungeonMaterials } from "./dungeon/mesh.js";
import { buildDungeonScene, dungeonScenes } from "./dungeon/scene.js";
import {
  buildToyboxPart,
  buildToyboxScene,
  toyboxEntries,
  toyboxEnv,
  toyboxScenes,
} from "./toybox/catalog.js";
import { TOYBOX_BIOMES, TOYBOX_THEMES, loadToyboxScans, toyboxMaterials } from "./toybox/kit.js";
import { buildVillagePart, villageEntries } from "./village/catalog.js";
import { VILLAGE_BIOMES, VILLAGE_THEMES } from "./village/kit.js";
import { buildVillageScene, villageScenes } from "./village/scene.js";

export {
  /**
   * Push Toybox grass and leaves aside round a sphere, such as the player or a ball.
   * @situation make toybox grass, flowers and trees bend away from the player as it walks through them
   * @constraint four pushers (index 0 to 3); radius 0 turns one off
   * @requires npm i @threenative/procedural-environment
   * @example toyboxPush(0, player.position.x, player.position.y, player.position.z, 0.7);
   */
  toyboxPush,
} from "./toybox/kit.js";
export { uniforms as stylizedUniforms } from "../vendor/stylized-biome-kit/core.js";
export const stylizedMaterials: Record<string, Material> = {
  ...materials,
  ...dungeonMaterials,
  ...toyboxMaterials,
};
export { scatter, sky, terrain } from "../vendor/stylized-biome-kit/ground.js";

export interface IStylizedAsset {
  id: string;
  name: string;
  kind: "stylized" | "dungeon" | "village" | "toybox";
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

// The Toybox kit's triplanar rock, soil, wood and metal scans ship beside dist/ in scans/.
loadToyboxScans((file) => new URL(`../scans/${file}`, import.meta.url).href);
const BACKDROPS = ["garden", "frost", "sand"] as const;

const toyboxRows = [
  ...Object.entries(toyboxScenes).map(([id, name]) => ({ id, name, category: "Scenes" })),
  ...toyboxEntries,
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
 * @situation browse toybox platformer modules: grass blocks, cliffs, ramps, deck panels, bounce pads, coins, cannons, floating islands, palms, crates, cut-stone ruins, spinners, spike traps, a goal gate, open sea with shore foam, and assembled garden, obstacle-course and island-cove scenes
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
    ...toyboxRows.map(
      ({ id, name, category }): IStylizedAsset => ({
        id: `toybox-${id}`,
        name,
        category,
        kind: "toybox",
        biomes: [...TOYBOX_BIOMES],
        variants: TOYBOX_THEMES.length,
        variantNames: TOYBOX_THEMES,
      }),
    ),
  ];
}

function toyboxAsset(id: string, { variant = 0, seed = 1, overrides }: IStylizedAssetOptions) {
  if (!Number.isInteger(variant) || variant < 0 || variant >= TOYBOX_THEMES.length)
    throw new Error(`Invalid toybox theme variant ${variant}`);
  if (overrides) throw new Error("Toybox assets accept a theme variant and seed");
  const key = id.slice(7);
  const scene = Object.hasOwn(toyboxScenes, key)
    ? buildToyboxScene(key as keyof typeof toyboxScenes, seed, variant)
    : undefined;
  const group = scene?.group ?? buildToyboxPart(key, seed, variant);
  const moving: Object3D[] = [];
  group.traverse((node) => node.userData.animate && moving.push(node));
  const update = moving.length
    ? (seconds: number) => {
        for (const node of moving) node.userData.animate(node, seconds);
      }
    : undefined;
  const sways =
    group.getObjectByProperty("material", toyboxMaterials.grass) ??
    group.getObjectByProperty("material", toyboxMaterials.leaf);
  return {
    group,
    view: scene?.view,
    env: toyboxEnv[variant],
    backdrop: new URL(`../scans/toybox_backdrop-${BACKDROPS[variant]}.webp`, import.meta.url).href,
    update,
    animated: Boolean(
      update ||
        sways ||
        group.getObjectByProperty("material", toyboxMaterials.glow) ||
        group.getObjectByProperty("material", toyboxMaterials.water),
    ),
  };
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
 * Generate a Stylized Biome Kit, Dungeon, Village or Toybox piece or scene with its Three.js materials.
 * @situation create stylized mountain ridges, snowy trees, sandstone formations, or animated water
 * @situation create modular dungeon walls, stairs, arches, dungeon props and fixtures in an overgrown, frozen, or volcanic theme
 * @situation create a stylized medieval village: cottages, tavern, barn, windmill, forge, market stall, well, fences and props in a meadow, snowy, or desert theme
 * @situation build a 3D platformer level from modular toy-like pieces with realistic materials: snap-together 2 m grass blocks, spinning coins, a jumping bounce pad, hover platforms, and a blurred sky backdrop
 * @constraint the biome shaders, dungeon surface finish, and fire motion use Three.js WebGL materials
 * @constraint toybox pieces animate only when the game sets `stylizedUniforms.uTime` and calls `update(seconds)` each frame; `backdrop` is an image URL the game shows behind the scene
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
  /** Toybox: a blurred backdrop image URL to show behind the scene. */
  backdrop?: string;
} {
  const { variant = 0, seed, overrides } = options;
  if (seed !== undefined && !Number.isSafeInteger(seed))
    throw new Error("Stylized seed must be an integer");
  if (id.startsWith("toybox-")) return toyboxAsset(id, options);
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
