import { readFileSync } from "node:fs";
import { LANDFORMS, type LandformKind, validateBiome } from "@threenative/terrain";
import { describe, expect, it } from "vitest";
import { BENCHMARK } from "../src/render/benchmark.js";
import { BIOMES, type WorldName } from "../src/render/biomes.js";
import {
  FAR_FOREST_IMPOSTOR,
  FAR_FOREST_RULES,
  FAR_FOREST_WORLDS,
} from "../src/render/farForest.js";
import { speciesFor } from "../src/render/pack.js";
import { buildPropVariants } from "../src/render/props.js";
import { type IScatterRules, SCATTER, scatterRules } from "../src/render/scatter.js";
import type { IBakedWorld } from "../src/render/terrain.js";
import { SPAWN_CAMERA_OFFSET, SPAWN_POINTS } from "../src/render/worldData.js";

/**
 * Everything a biome decides, pinned for all five worlds.
 *
 * One row per world, written by hand from the numbers the code holds: the look it grades under, the
 * landform and seed it was baked from, the bands its ground shader reads, the trees and the grass it
 * grows, the water it floods, where it puts the player and the detail, and the words a request may
 * use for it. Every value here comes out of the game's own code (`BIOMES`, `scatterRules`,
 * `FAR_FOREST_RULES`, `BENCHMARK`, `speciesFor`, `SPAWN_POINTS`) or out of the committed bake, so a
 * change to any of them fails here first. `aliases` is the one row no code exports: the biome file is
 * its only owner, and the MCP's inline synonym table (`mcp/tools.ts`) hands it over in PRD-793.
 */

const WORLDS: readonly WorldName[] = ["forest", "coastal", "alpine", "desert", "tundra"];

type CollisionClass = "none" | "trunk" | "hull";

/** The collar past the square: what a far-field tree is and where it stops. */
interface IFarRule {
  readonly cell: number;
  readonly spacing: readonly [number, number];
  readonly slope: readonly [number, number];
  readonly reach: number;
  readonly impostor: number;
}

interface IFoliageRow {
  /** The art the game resolves to a model; a species is one placement rule. */
  readonly species: string;
  readonly density: number;
  readonly slope: readonly [number, number];
  readonly height: readonly [number, number] | null;
  readonly spacing: readonly [number, number];
  readonly collision: CollisionClass;
  readonly far: IFarRule | null;
}

interface IGrassRow {
  readonly species: string;
  readonly density: number;
  readonly slope: readonly [number, number];
  readonly height: readonly [number, number] | null;
  readonly spacing: number;
}

interface ILayerRow {
  readonly layer: string;
  readonly from: number;
  readonly to: number;
  readonly shedFrom?: number;
  readonly shedTo?: number;
}

interface IWaterRow {
  readonly kind: "river" | "lake" | "ocean";
  readonly width?: number;
  readonly radius?: number;
  readonly level?: number;
}

interface IWorldRows {
  readonly look: string;
  readonly landform: LandformKind;
  readonly sizeMeters: number;
  readonly seed: number;
  readonly layers: readonly ILayerRow[];
  readonly foliage: readonly IFoliageRow[];
  readonly grass: readonly IGrassRow[];
  readonly water: readonly IWaterRow[];
  readonly spawn: {
    readonly at: readonly [number, number];
    readonly cameraOffset: readonly [number, number, number];
    readonly focus: readonly [number, number];
  };
  readonly aliases: readonly string[];
  readonly species: Readonly<Record<string, number>>;
}

const TABLE: Readonly<Record<WorldName, IWorldRows>> = {
  forest: {
    look: "forest",
    landform: "temperateMountains",
    sizeMeters: 512,
    seed: 73,
    layers: [
      { layer: "alpine", from: 0.95, to: 1.65 },
      { layer: "rock", from: 0.35, to: 1.8 },
      { layer: "treeline", from: 6.5, to: 10 },
      { layer: "cap", from: 14, to: 17 },
      { layer: "desertRock", from: 0.18, to: 0.48 },
      { layer: "alpineRock", from: 0.06, to: 0.14 },
      { layer: "alpineHollow", from: 0.05, to: 0.12 },
      { layer: "snow", from: 3.6, to: 4.8, shedFrom: 0.04, shedTo: 0.22 },
    ],
    foliage: [
      {
        species: "spruce",
        density: 3200,
        slope: [0, 32],
        height: null,
        spacing: [3.2, 6.4],
        collision: "trunk",
        far: { cell: 6, spacing: [6.5, 13], slope: [36, 46], reach: 2300, impostor: 110 },
      },
    ],
    grass: [{ species: "grass", density: 1, slope: [0, 42], height: [0, 66], spacing: 1.2 }],
    water: [
      { kind: "river", width: 5.32 },
      { kind: "lake", radius: 105 },
    ],
    spawn: { at: [-220, -165], cameraOffset: [28, 24, 42], focus: [150, -100] },
    aliases: ["forest", "pine", "pines", "woods", "woodland"],
    species: {
      boulder: 3,
      bush: 2,
      cliff: 1,
      fern: 3,
      grass: 4,
      litter: 2,
      meadow: 2,
      mountain: 2,
      poppy: 4,
      bloom: 4,
      riverrock: 1,
      sapling: 4,
      scree: 1,
      scrub: 3,
      spruce: 10,
    },
  },
  coastal: {
    look: "coastal",
    landform: "coastalCliffs",
    sizeMeters: 512,
    seed: 73,
    layers: [
      { layer: "alpine", from: 0.34, to: 0.6 },
      { layer: "rock", from: 0.12, to: 0.64 },
      { layer: "treeline", from: 1, to: 2.15 },
      { layer: "cap", from: 2, to: 2.8 },
      { layer: "desertRock", from: 0.18, to: 0.48 },
      { layer: "alpineRock", from: 0.06, to: 0.14 },
      { layer: "alpineHollow", from: 0.05, to: 0.12 },
      { layer: "snow", from: 1.3, to: 1.75, shedFrom: 0.04, shedTo: 0.22 },
    ],
    foliage: [
      {
        species: "spruce",
        density: 3200,
        slope: [0, 32],
        height: null,
        spacing: [3.2, 6.4],
        collision: "trunk",
        far: null,
      },
    ],
    grass: [{ species: "grass", density: 1, slope: [0, 42], height: null, spacing: 1.2 }],
    water: [{ kind: "ocean", level: 1.5 }],
    spawn: { at: [180, 65], cameraOffset: [28, 18, 34], focus: [80, 5] },
    aliases: ["coastal", "beach", "coast", "sea", "ocean"],
    species: {
      boulder: 3,
      bush: 2,
      cliff: 1,
      fern: 3,
      grass: 4,
      litter: 2,
      meadow: 2,
      mountain: 2,
      poppy: 4,
      bloom: 4,
      riverrock: 1,
      sapling: 4,
      scree: 1,
      scrub: 3,
      spruce: 10,
    },
  },
  alpine: {
    look: "alpine",
    landform: "alpine",
    sizeMeters: 512,
    seed: 41,
    layers: [
      { layer: "alpine", from: 0.06, to: 0.1 },
      { layer: "rock", from: 0.02, to: 0.11 },
      { layer: "treeline", from: 0.3, to: 0.55 },
      { layer: "cap", from: 0.82, to: 1 },
      { layer: "desertRock", from: 0.18, to: 0.48 },
      { layer: "alpineRock", from: 0.06, to: 0.14 },
      { layer: "alpineHollow", from: 0.05, to: 0.12 },
      { layer: "snow", from: 0.6, to: 0.85, shedFrom: 0.16, shedTo: 0.39 },
    ],
    foliage: [
      {
        species: "spruce",
        density: 0,
        slope: [0, 32],
        height: [0, 52],
        spacing: [3.4, 3.4],
        collision: "trunk",
        far: null,
      },
    ],
    grass: [{ species: "grass", density: 0, slope: [0, 0], height: null, spacing: 3.5 }],
    water: [],
    spawn: { at: [180, -190], cameraOffset: [28, 24, 42], focus: [180, -190] },
    aliases: ["alpine", "mountain", "mountains", "snowy", "peaks"],
    species: {
      boulder: 3,
      grass: 4,
      mountain: 2,
      riverrock: 1,
      sapling: 4,
      scree: 1,
      scrub: 3,
      spruce: 10,
    },
  },
  desert: {
    look: "desert",
    landform: "desertMesa",
    sizeMeters: 512,
    seed: 97,
    layers: [
      { layer: "alpine", from: 0.28, to: 0.49 },
      { layer: "rock", from: 0.08, to: 0.52 },
      { layer: "treeline", from: 0.8, to: 1.8 },
      { layer: "cap", from: 2, to: 2.8 },
      { layer: "desertRock", from: 0.18, to: 0.48 },
      { layer: "alpineRock", from: 0.06, to: 0.14 },
      { layer: "alpineHollow", from: 0.05, to: 0.12 },
      { layer: "snow", from: 2, to: 3, shedFrom: 0.04, shedTo: 0.22 },
    ],
    foliage: [
      {
        species: "sapling",
        density: 0,
        slope: [0, 32],
        height: null,
        spacing: [3.4, 3.4],
        collision: "trunk",
        far: null,
      },
    ],
    grass: [{ species: "grass", density: 0.32, slope: [0, 24], height: null, spacing: 7 }],
    water: [],
    spawn: { at: [180, 160], cameraOffset: [28, 24, 42], focus: [170, 180] },
    aliases: ["desert", "dune", "dunes", "sand"],
    species: {
      boulder: 3,
      grass: 4,
      reveal: 2,
      riverrock: 1,
      scree: 1,
      scrub: 3,
      volcanic: 4,
    },
  },
  tundra: {
    look: "tundra",
    landform: "tundra",
    sizeMeters: 512,
    seed: 131,
    layers: [
      { layer: "alpine", from: 0.6, to: 1.2 },
      { layer: "rock", from: 0.06, to: 1.25 },
      { layer: "treeline", from: 6.5, to: 10 },
      { layer: "cap", from: 14, to: 17 },
      { layer: "desertRock", from: 0.18, to: 0.48 },
      { layer: "alpineRock", from: 0.06, to: 0.14 },
      { layer: "alpineHollow", from: 0.05, to: 0.12 },
      { layer: "snow", from: 0.15, to: 0.45, shedFrom: 0.04, shedTo: 0.22 },
    ],
    foliage: [
      {
        species: "sapling",
        density: 55,
        slope: [0, 32],
        height: null,
        spacing: [3.4, 3.4],
        collision: "trunk",
        far: null,
      },
    ],
    grass: [{ species: "grass", density: 1, slope: [0, 30], height: null, spacing: 1.8 }],
    water: [
      { kind: "river", width: 5.32 },
      { kind: "river", width: 3.04 },
      { kind: "lake", radius: 34 },
      { kind: "lake", radius: 46 },
    ],
    spawn: { at: [180, 160], cameraOffset: [28, 24, 42], focus: [150, 160] },
    aliases: ["tundra", "arctic", "ice"],
    species: {
      boulder: 3,
      bush: 1,
      riverrock: 1,
      sapling: 4,
      scree: 1,
      scrub: 3,
    },
  },
};

const ELEVATION_LAYERS = [
  "alpine",
  "rock",
  "treeline",
  "cap",
  "desertRock",
  "alpineRock",
  "alpineHollow",
] as const;

/** The bake a world is drawn from: `baked.json` carries the pair that share one DEM bundle. */
function baked(world: WorldName): IBakedWorld {
  const read = (name: string) =>
    JSON.parse(readFileSync(new URL(`../src/world/${name}.json`, import.meta.url), "utf8"));
  const shared = read("baked") as Record<string, IBakedWorld>;
  return (shared[world] ?? read(world)) as IBakedWorld;
}

/** The kit a world is a copy of: its recipe carries the seed and the size it was generated at. */
function recipe(world: WorldName): { size: number; seed: number } {
  return JSON.parse(
    readFileSync(
      new URL(`../../../packages/terrain/starter/${world}/recipe.json`, import.meta.url),
      "utf8",
    ),
  ).recipe.config;
}

/**
 * The landform a world is: the preset calibrated against that world's own DEM crop, named in its
 * reference landscape. One kind names each crop, and this fails if that stops being true.
 */
function landformOf(world: WorldName): LandformKind {
  const kinds = (Object.keys(LANDFORMS) as LandformKind[]).filter((kind) =>
    LANDFORMS[kind].reference.includes(`DEM crop \`${world}\``),
  );
  if (kinds.length !== 1)
    throw new Error(`Expected one landform calibrated on the ${world} crop, found ${kinds.length}`);
  return kinds[0] as LandformKind;
}

/**
 * What stops the player at a placement: the roles `game.ts` collides, read off the prop parts the
 * game builds when no licensed pack is installed. A bark part is a trunk, a stone part a hull.
 */
function collisionClasses(): Readonly<Record<string, CollisionClass>> {
  const variants = buildPropVariants();
  const classes: Record<string, CollisionClass> = {};
  try {
    for (const [key, parts] of variants) {
      const asset = key.replace(/:\d+$/u, "");
      const roles = new Set(parts.map((part) => part.role));
      const found: CollisionClass = roles.has("bark")
        ? "trunk"
        : roles.has("stone")
          ? "hull"
          : "none";
      const previous = classes[asset];
      if (previous !== undefined && previous !== found)
        throw new Error(`Species ${asset} collides as both ${previous} and ${found}`);
      classes[asset] = found;
    }
  } finally {
    for (const parts of variants.values()) for (const part of parts) part.geometry.dispose();
  }
  return classes;
}

/** The species one world draws, as asset id to how many variants of it the pack holds. */
function speciesCounts(world: WorldName): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const one of speciesFor(world)) counts[one.asset] = (counts[one.asset] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function layersOf(world: WorldName): readonly ILayerRow[] {
  const biome = BIOMES[world];
  return [
    ...ELEVATION_LAYERS.map((layer) => ({
      layer,
      from: biome.heightFractions[layer][0],
      to: biome.heightFractions[layer][1],
    })),
    {
      layer: "snow",
      from: biome.snowFractions[0],
      to: biome.snowFractions[1],
      // A dense snowpack sheds later than a thin one, and a glacier shoulder starts shedding sooner.
      shedFrom: world === "alpine" ? 0.16 : 0.04,
      shedTo: biome.snowFractions[2],
    },
  ];
}

function foliageOf(
  world: WorldName,
  rules: IScatterRules,
  collisions: Readonly<Record<string, CollisionClass>>,
): readonly IFoliageRow[] {
  const collision = collisions[rules.treeAsset];
  if (collision === undefined) throw new Error(`Species ${rules.treeAsset} has no prop parts`);
  const far = FAR_FOREST_WORLDS.includes(world)
    ? {
        cell: FAR_FOREST_RULES.cell,
        spacing: [FAR_FOREST_RULES.spacingNear, FAR_FOREST_RULES.spacingFar] as const,
        slope: FAR_FOREST_RULES.slope,
        reach: FAR_FOREST_RULES.reach,
        impostor: FAR_FOREST_IMPOSTOR,
      }
    : null;
  return [
    {
      species: rules.treeAsset,
      density: rules.treeCount,
      slope: [0, rules.treeSlopeLimit],
      height: rules.treeHeightCeiling === null ? null : [0, rules.treeHeightCeiling],
      spacing: rules.treeSpacing,
      collision,
      far,
    },
  ];
}

function grassOf(rules: IScatterRules): readonly IGrassRow[] {
  return [
    {
      species: "grass",
      density: rules.grassDensity,
      slope: [0, rules.grassSlopeLimit],
      height: rules.grassHeight === null ? null : [0, rules.grassHeight[0]],
      spacing: rules.grassCell,
    },
  ];
}

function waterOf(world: WorldName, data: IBakedWorld): readonly IWaterRow[] {
  const rivers = (data.rivers ?? []).map((river) => ({
    kind: "river" as const,
    width: river.width,
  }));
  if (data.waterLevel !== null) return [...rivers, { kind: "ocean", level: data.waterLevel }];
  return [
    ...rivers,
    ...(data.lakes ?? []).map((lake) => ({ kind: "lake" as const, radius: lake.radius })),
  ];
}

describe("a biome's values", () => {
  const collisions = collisionClasses();

  it("are the table's, for every world", () => {
    for (const world of WORLDS) {
      const expected = TABLE[world];
      const data = baked(world);
      const generated = recipe(world);
      const biome = BIOMES[world];
      const rules = scatterRules(world);
      expect({ world, look: biome.world }).toEqual({ world, look: expected.look });
      expect({ world, landform: landformOf(world) }).toEqual({
        world,
        landform: expected.landform,
      });
      expect({ world, sizeMeters: data.size, seed: generated.seed }).toEqual({
        world,
        sizeMeters: expected.sizeMeters,
        seed: expected.seed,
      });
      expect({ world, size: generated.size }).toEqual({ world, size: expected.sizeMeters });
      expect({ world, layers: layersOf(world) }).toEqual({ world, layers: expected.layers });
      expect({ world, foliage: foliageOf(world, rules, collisions) }).toEqual({
        world,
        foliage: expected.foliage,
      });
      expect({ world, grass: grassOf(rules) }).toEqual({ world, grass: expected.grass });
      expect({ world, water: waterOf(world, data) }).toEqual({ world, water: expected.water });
      expect({
        world,
        spawn: {
          at: SPAWN_POINTS[world],
          cameraOffset: SPAWN_CAMERA_OFFSET[world],
          focus: [BENCHMARK[world].focus.x, BENCHMARK[world].focus.z],
        },
      }).toEqual({ world, spawn: expected.spawn });
      // The aliases' only owner is the biome file (asserted below): the MCP's inline synonym table
      // is still the words a request may use, and `terrain_generate` reads the file in PRD-793.
      expect({ world, species: speciesCounts(world) }).toEqual({
        world,
        species: expected.species,
      });
    }
  });

  it("are the scatter tuning every world shares, in one place", () => {
    expect(SCATTER.spruceAttempts).toBe(80_000);
    expect(SCATTER.grassFull).toBe(22);
    expect(SCATTER.grassThin).toBe(62);
    expect(SCATTER.seed).toBe(466_468);
  });
});

/** One world's copy-out file, read the way a game or the MCP reads it. */
function biomeFile(world: WorldName) {
  return validateBiome(
    JSON.parse(
      readFileSync(
        new URL(`../../../packages/terrain/starter/${world}/biome.data.json`, import.meta.url),
        "utf8",
      ),
    ),
    world,
  );
}

describe("a biome's file", () => {
  it("carries the same table", () => {
    for (const world of WORLDS) {
      const spec = biomeFile(world);
      const expected = TABLE[world];
      expect({
        world,
        look: spec.look,
        landform: spec.landform,
        sizeMeters: spec.sizeMeters,
        seed: spec.seed,
      }).toEqual({
        world,
        look: expected.look,
        landform: expected.landform,
        sizeMeters: expected.sizeMeters,
        seed: expected.seed,
      });
      expect({ world, layers: spec.layers }).toEqual({ world, layers: expected.layers });
      expect({ world, foliage: spec.foliage }).toEqual({ world, foliage: expected.foliage });
      expect({ world, grass: spec.grass }).toEqual({ world, grass: expected.grass });
      expect({ world, water: spec.water }).toEqual({ world, water: expected.water });
      expect({ world, spawn: spec.spawn }).toEqual({ world, spawn: expected.spawn });
      expect({ world, aliases: spec.aliases }).toEqual({ world, aliases: expected.aliases });
    }
  });
});
