import { readFileSync } from "node:fs";
import { type IBiomeSpec, LANDFORMS, type LandformKind, validateBiome } from "@threenative/terrain";
import { describe, expect, it } from "vitest";
import { BENCHMARK } from "../src/render/benchmark.js";
import { biomeSpec } from "../src/render/biomeData.js";
import { BIOMES, type IVistaAim, type WorldName } from "../src/render/biomes.js";
import { FAR_FOREST_IMPOSTOR, FAR_FOREST_WORLDS } from "../src/render/farForest.js";
import { speciesFor } from "../src/render/pack.js";
import { buildPropVariants } from "../src/render/props.js";
import type { IBakedWorld } from "../src/render/terrain.js";

/**
 * Everything a biome decides, pinned for all five worlds.
 *
 * One row per world, written by hand: the look it grades under, the landform and seed it was baked
 * from, the bands its ground shader reads, the trees and the grass it grows, the water it floods,
 * where it puts the player and the detail, and the words a request may use for it. The scatter rules
 * came out of the code and into the file (`scatter-ordered.ts` runs them), so a row here pins what
 * the file says; the game's own look still owns its collisions, its far-field rule and its art. `aliases` is the one row no code exports: the biome file is
 * its only owner, and the MCP's inline synonym table (`mcp/tools.ts`) hands it over in PRD-793.
 */

const WORLDS: readonly WorldName[] = ["forest", "coastal", "alpine", "desert", "tundra"];

type CollisionClass = "none" | "trunk" | "hull";

/** The collar past the square: what a far-field tree is and where it stops. */
interface IFarRule {
  readonly cell: number;
  readonly spacing: readonly [number, number];
  readonly spacingAt: readonly [number, number];
  readonly slope: readonly [number, number];
  readonly meadowSlope: readonly [number, number];
  readonly reach: number;
  readonly treelineJitter: number;
  readonly stand: readonly [number, number];
  readonly seed: number;
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
  readonly stands: boolean;
  readonly grassThreshold: number;
  readonly standThreshold: number;
  readonly far: IFarRule | null;
}

interface IGrassRow {
  readonly species: string;
  readonly density: number;
  readonly slope: readonly [number, number];
  readonly height: readonly [number, number] | null;
  readonly spacing: number;
  readonly slopeFalloff: number;
  readonly heightFalloff: number;
  /** The mat field's band the cover thins on, or null on ground without mats. */
  readonly mats: readonly [number, number] | null;
  readonly waterMargin: number;
  readonly beach: readonly [number, number] | null;
  readonly detailSpacing: number;
  readonly drift: {
    readonly field: "stand" | "mats";
    readonly frequency: readonly [number, number];
    readonly offset: number;
    readonly amplitude: number;
    readonly band: readonly [number, number];
  };
  readonly bladeScale: number;
  readonly bladeJitter: number;
  readonly scrubChance: number;
  readonly scrubScale: number;
  readonly scrubJitter: number;
  readonly scrubBush: boolean;
  readonly shoreGround: boolean;
  readonly cobbledBed: boolean;
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

/** The baked bundle a world is read from: its file under `world/`, and its key inside it. */
interface IBakeRow {
  readonly file: string;
  readonly key: string | null;
}

interface IWorldRows {
  readonly look: string;
  readonly bake: IBakeRow;
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
    bake: { file: "baked", key: "forest" },
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
        density: 7000,
        slope: [0, 32],
        height: null,
        spacing: [3.2, 6.4],
        collision: "trunk",
        stands: true,
        grassThreshold: 0.3,
        standThreshold: 0.16,
        far: {
          cell: 6,
          spacing: [6.5, 13],
          spacingAt: [150, 1500],
          slope: [36, 46],
          meadowSlope: [12, 24],
          reach: 2300,
          treelineJitter: 30,
          stand: [0.26, 0.4],
          seed: 466_559,
          impostor: 110,
        },
      },
    ],
    grass: [
      {
        species: "grass",
        density: 1,
        slope: [0, 42],
        height: [0, 66],
        spacing: 0.8,
        mats: null,
        slopeFalloff: 20,
        heightFalloff: 28,
        waterMargin: 7.5,
        beach: null,
        drift: {
          field: "stand",
          frequency: [3.1, 2.7],
          offset: 0.8,
          amplitude: 0.2,
          band: [0, 1],
        },
        bladeScale: 1,
        bladeJitter: 0.65,
        scrubChance: 0.3,
        scrubScale: 0.9,
        scrubJitter: 0.6,
        scrubBush: false,
        shoreGround: false,
        cobbledBed: true,
        detailSpacing: 0.5,
      },
    ],
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
    bake: { file: "baked", key: "coastal" },
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
        stands: true,
        grassThreshold: 0.3,
        standThreshold: 0.3,
        far: null,
      },
    ],
    grass: [
      {
        species: "grass",
        density: 1,
        slope: [0, 42],
        height: null,
        spacing: 1.2,
        mats: null,
        slopeFalloff: 20,
        heightFalloff: 28,
        waterMargin: 7.5,
        beach: [1.8, 5.7],
        drift: {
          field: "stand",
          frequency: [3.1, 2.7],
          offset: 0.65,
          amplitude: 0.35,
          band: [0, 1],
        },
        bladeScale: 0.8,
        bladeJitter: 0.65,
        scrubChance: 0.3,
        scrubScale: 0.9,
        scrubJitter: 0.6,
        scrubBush: false,
        shoreGround: true,
        cobbledBed: false,
        detailSpacing: 0.34,
      },
    ],
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
    bake: { file: "alpine", key: null },
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
        stands: false,
        grassThreshold: 0.18,
        standThreshold: 0.42,
        far: null,
      },
    ],
    grass: [
      {
        species: "grass",
        density: 0,
        slope: [0, 0],
        height: null,
        spacing: 3.5,
        mats: null,
        slopeFalloff: 0,
        heightFalloff: 28,
        waterMargin: 7.5,
        beach: null,
        drift: {
          field: "stand",
          frequency: [2.1, 2.4],
          offset: 0,
          amplitude: 1,
          band: [0.3, 0.45],
        },
        bladeScale: 0.55,
        bladeJitter: 0.5,
        scrubChance: 0.3,
        scrubScale: 0.9,
        scrubJitter: 0.6,
        scrubBush: false,
        shoreGround: false,
        cobbledBed: false,
        detailSpacing: 0.6,
      },
    ],
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
    bake: { file: "desert", key: null },
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
        stands: false,
        grassThreshold: 0.18,
        standThreshold: 0.42,
        far: null,
      },
    ],
    grass: [
      {
        species: "grass",
        density: 0.32,
        slope: [0, 24],
        height: null,
        spacing: 7,
        mats: null,
        slopeFalloff: 20,
        heightFalloff: 28,
        waterMargin: 7.5,
        beach: null,
        drift: {
          field: "stand",
          frequency: [6.3, 5.7],
          offset: 0.08,
          amplitude: 0.6,
          band: [0.5, 0.3],
        },
        bladeScale: 0.95,
        bladeJitter: 0.5,
        scrubChance: 0.65,
        scrubScale: 0.8,
        scrubJitter: 0.6,
        scrubBush: false,
        shoreGround: false,
        cobbledBed: false,
        detailSpacing: 1.8,
      },
    ],
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
    bake: { file: "tundra", key: null },
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
        stands: false,
        grassThreshold: 0.18,
        standThreshold: 0.42,
        far: null,
      },
    ],
    grass: [
      {
        species: "grass",
        density: 1,
        slope: [0, 30],
        height: null,
        spacing: 1.8,
        mats: [0.47, 0.3],
        slopeFalloff: 22,
        heightFalloff: 28,
        waterMargin: 7.5,
        beach: null,
        drift: { field: "mats", frequency: [1, 1], offset: 0, amplitude: 1, band: [0.45, 0.3] },
        bladeScale: 0.45,
        bladeJitter: 0.3,
        scrubChance: 0.22,
        scrubScale: 0.55,
        scrubJitter: 0.5,
        scrubBush: true,
        shoreGround: false,
        cobbledBed: false,
        detailSpacing: 0.5,
      },
    ],
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

/**
 * The bundle a world is drawn from, read from the bake's own files: `baked.json` holds the pair of
 * worlds that share one DEM, and every other world is written to a file of its own name.
 */
function bakeOf(world: WorldName): IBakeRow {
  const shared = JSON.parse(
    readFileSync(new URL("../src/world/baked.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
  return world in shared ? { file: "baked", key: world } : { file: world, key: null };
}

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
  spec: IBiomeSpec,
  collisions: Readonly<Record<string, CollisionClass>>,
): readonly IFoliageRow[] {
  const row = spec.foliage[0];
  if (row === undefined) throw new Error(`${spec.look}: the file carries no tree row`);
  const collision = collisions[row.species];
  if (collision === undefined) throw new Error(`Species ${row.species} has no prop parts`);
  // A world that plants a collar carries the rule's row; the streaming gate is the game's constant.
  const far = FAR_FOREST_WORLDS.includes(world) ? row.far : null;
  if (far !== null)
    expect({ world, impostor: far.impostor }).toEqual({ world, impostor: FAR_FOREST_IMPOSTOR });
  return [
    {
      species: row.species,
      density: row.density,
      slope: row.slope,
      height: row.height,
      spacing: row.spacing,
      collision,
      stands: row.stands,
      grassThreshold: row.grassThreshold,
      standThreshold: row.standThreshold,
      far,
    },
  ];
}

function grassOf(spec: IBiomeSpec): readonly IGrassRow[] {
  return [spec.grass[0] as IGrassRow];
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
      const spec = biomeSpec(world);
      expect({ world, look: biome.world }).toEqual({ world, look: expected.look });
      expect({ world, bake: bakeOf(world) }).toEqual({ world, bake: expected.bake });
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
      expect({ world, foliage: foliageOf(world, spec, collisions) }).toEqual({
        world,
        foliage: expected.foliage,
      });
      expect({ world, grass: grassOf(spec) }).toEqual({ world, grass: expected.grass });
      expect({ world, water: waterOf(world, data) }).toEqual({ world, water: expected.water });
      expect({
        world,
        spawn: {
          at: biomeSpec(world).spawn.at,
          cameraOffset: biomeSpec(world).spawn.cameraOffset,
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

  it("share one ordered stream: one seed and one candidate budget, on every biome", () => {
    // One stream per biome means one seed and one attempt budget. The seed is the game's on all
    // five files; the forest grew its own candidate budget with the wood, and the other four keep
    // the graded one. A sixth biome may name its own; these five must not drift apart unseen.
    for (const world of WORLDS)
      expect({ world, ...biomeSpec(world).cover }).toMatchObject({
        world,
        seed: 466_468,
        attempts: world === "forest" ? 240_000 : 80_000,
        stoneRadius: 1.9,
        ground: expect.any(String),
        clearings: expect.any(Array),
      });
    // Two cover switches the ground material also draws by: the file's row and the look must agree,
    // or the blades and the shader would disagree about the same shore and the same bush.
    for (const world of WORLDS) {
      const row = biomeSpec(world).grass[0];
      expect({ world, shoreGround: row?.shoreGround }).toEqual({
        world,
        shoreGround: BIOMES[world].shoreGround,
      });
      expect({ world, scrubBush: row?.scrubBush }).toEqual({
        world,
        scrubBush: BIOMES[world].scrubBush,
      });
    }
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
      expect({ world, bake: spec.bake }).toEqual({ world, bake: expected.bake });
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
      expect({ world, species: [...spec.species].sort() }).toEqual({
        world,
        species: Object.keys(expected.species).sort(),
      });
      expect({ world, aliases: spec.aliases }).toEqual({ world, aliases: expected.aliases });
    }
  });
});

/**
 * What the game's own look table holds, for the values that used to be a branch in the code.
 *
 * These are not the biome file's: the camera a vista is framed from, the art a fallback pack stands
 * in, the stone grading's shape, and the one curve the ground cover drifts on are all the game's
 * look, so this is where they are pinned. Every one of them came out of a `world ===` comparison in
 * `game.ts` or a four-way ternary in `scatter.ts`, and the numbers are the ones it carried.
 */
interface ILookRow {
  readonly vistaAim: IVistaAim | null;
  readonly saplingHeight: number | null;
  readonly stoneSinkShare: number | null;
  readonly stoneScans: number;
  readonly riverMirrorsPonds: boolean;
  readonly stageArm: boolean;
}

const LOOKS: Readonly<Record<WorldName, ILookRow>> = {
  forest: {
    vistaAim: null,
    saplingHeight: null,
    stoneSinkShare: 0.12,
    stoneScans: 1,
    riverMirrorsPonds: false,
    stageArm: true,
  },
  coastal: {
    vistaAim: { at: [80, 190], rise: null },
    saplingHeight: null,
    stoneSinkShare: 0.12,
    stoneScans: 1,
    riverMirrorsPonds: false,
    stageArm: false,
  },
  alpine: {
    vistaAim: { at: [-200, 170], rise: 170 },
    saplingHeight: 2,
    stoneSinkShare: null,
    stoneScans: 1,
    riverMirrorsPonds: false,
    stageArm: false,
  },
  desert: {
    vistaAim: { at: [-180, -160], rise: 30 },
    saplingHeight: null,
    stoneSinkShare: null,
    stoneScans: 2,
    riverMirrorsPonds: false,
    stageArm: false,
  },
  tundra: {
    vistaAim: null,
    saplingHeight: 1.4,
    stoneSinkShare: null,
    stoneScans: 1,
    riverMirrorsPonds: true,
    stageArm: false,
  },
};

describe("a biome's look", () => {
  it("carries the values its branches used to compute", () => {
    for (const world of WORLDS) {
      const look = BIOMES[world];
      const expected = LOOKS[world];
      expect({
        world,
        vistaAim: look.vistaAim,
        saplingHeight: look.saplingHeight,
        stoneSinkShare: look.stoneSinkShare,
        stoneScans: look.stoneScans,
        riverMirrorsPonds: look.riverMirrorsPonds,
        stageArm: look.stageArm,
      }).toEqual({ world, ...expected });
    }
  });
});

/**
 * The rock grading a world's ground resolves, and the grading its props resolve beside it.
 *
 * `terrain.ts` grades ground stone with `stoneColor` (a grey mix and a tint) and fades it to a distant
 * tone at `distantStoneShare` of the view distance. A lawn world (forest and the coast) resolved the
 * neutral group and the other three read their own; the crag and the mesa replace the plain formula
 * outright. The numbers are the pre-batch tree's (`git show 0d4d08596:.../render/terrain.ts` and its
 * `biomes.ts`), so a ground value that starts reading a prop value fails here, world by world.
 *
 * `propStoneTint` is the props' own key, and it is separate for a reason: a boulder on the coast keeps
 * its photographed grey while the ground beneath it is graded, so a merge of the two keys is a
 * regression this row catches.
 */
interface IGroundRockRow {
  /** The formula the world's rock runs; the crag and the mesa ignore the plain group. */
  readonly formula: "ground" | "crag" | "mesa";
  /** The plain group's grey mix and tint, or null where the world's formula is not the plain one. */
  readonly plain: { readonly grey: number; readonly tint: readonly number[] } | null;
  readonly distant: readonly number[];
  readonly distantShare: number;
  readonly propStoneTint: readonly number[] | null;
}

const GROUND_ROCK: Readonly<Record<WorldName, IGroundRockRow>> = {
  forest: {
    formula: "ground",
    plain: { grey: 0.35, tint: [0.44, 0.46, 0.42] },
    distant: [0.16, 0.17, 0.155],
    distantShare: 0.65,
    propStoneTint: null,
  },
  coastal: {
    formula: "ground",
    plain: { grey: 0.35, tint: [0.44, 0.46, 0.42] },
    distant: [0.16, 0.17, 0.155],
    distantShare: 0.65,
    propStoneTint: [1, 1, 1],
  },
  alpine: {
    formula: "crag",
    plain: null,
    distant: [0.23, 0.225, 0.215],
    distantShare: 0.28,
    propStoneTint: null,
  },
  desert: {
    formula: "mesa",
    plain: null,
    distant: [0.31, 0.205, 0.12],
    distantShare: 0.32,
    propStoneTint: [1.08, 0.85, 0.64],
  },
  tundra: {
    formula: "ground",
    plain: { grey: 0.25, tint: [0.7, 0.74, 0.77] },
    distant: [0.18, 0.2, 0.21],
    distantShare: 0.32,
    propStoneTint: null,
  },
};

describe("a biome's ground rock", () => {
  it("grades its own stone, and the props keep theirs", () => {
    for (const world of WORLDS) {
      const look = BIOMES[world];
      const expected = GROUND_ROCK[world];
      const formula = look.crestRock ? "crag" : look.mesaRock ? "mesa" : "ground";
      expect({ world, formula }).toEqual({ world, formula: expected.formula });
      expect({
        world,
        plain: formula === "ground" ? { grey: look.stoneGrey, tint: look.stoneTint } : null,
        distant: look.groundDistantStone ?? look.distantStone,
        distantShare: look.distantStoneShare,
        propStoneTint: look.propStoneTint ?? null,
      }).toEqual({
        world,
        plain: expected.plain,
        distant: expected.distant,
        distantShare: expected.distantShare,
        propStoneTint: expected.propStoneTint,
      });
    }
  });
});
