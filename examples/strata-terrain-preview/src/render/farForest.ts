// The forest past the playable square: spruce across the surveyed valley and up its lower slopes.
//
// The bake plants only the 512 m square, so from the vista the surroundings read as a bare lawn
// around one square block of trees. This places spruce on the drawn collar (`horizon.ts`) by the
// rules UE's procedural foliage applies per foliage type, each a density in 0..1 multiplied together:
//   - altitude: none above the measured treeline band, the band the ground shader turns to rock at
//     (`Height` range, UE 5.8.3: Engine/Source/Editor/FoliageEdit/Private/FoliageEdMode.cpp:1033-1044);
//   - slope: none on cliffs, faded from 36 to 46 degrees around UE's default 45 degree limit
//     (`GroundSlopeAngle`, default 0-45 degrees, Engine/Source/Runtime/Foliage/Private/InstancedFoliage.cpp:596-597,
//     tested at FoliageEdMode.cpp:1025-1029); the collar's lower flanks average 35-42 degrees, so a lower
//     limit leaves the mountains bare above the valley floor;
//   - water: none in a river corridor or below a lake's level (UE refuses a trace that lands in a
//     blocking volume, Engine/Source/Runtime/Foliage/Private/InstancedFoliage.cpp:5247-5267);
//   - stands: the square's own stand noise (`forestWeight`), so stands run on across the edge, with
//     kilometre-scale meadows cut out of its gentle ground (a pasture lies on a bench, not a 40 degree flank);
//   - spacing: a keep probability that falls with distance past the walkable band, drawn from a
//     position-seeded stream (`FFoliageDensityFalloff::IsInstanceFiltered`, InstancedFoliage.cpp:547-573).
// Moisture and edge distance pick the stand structure: hollows hold dense, tall stands; a stand's
// edge and the treeline hold small trees (UE ages seeds and scales by age,
// Engine/Source/Runtime/Foliage/Private/ProceduralFoliageTile.cpp:96-110).
//
// Every tree is an ordinary `spruce` placement on the `far-forest` layer, so `propStreaming.ts` draws
// it through WorldCells with the cooked LOD chain and the engine's whole-asset impostor; the far
// bucket switches to the impostor sooner and casts no shadow, which is what keeps it cheap.
// `?farForest=off` is the named override: no trees past the square, the frame before this file.
import { createRandom } from "@threenative/core";
import type { HeightfieldCollar } from "@threenative/core/world";
import { type IPlacement, createSegmentIndex } from "@threenative/terrain";
import { type BufferAttribute, MathUtils } from "three";
import { ImprovedNoise } from "three/addons/math/ImprovedNoise.js";
import type { WorldName } from "./biomes.js";
import type { IBakedLake, IBakedRiver } from "./river.js";
import { forestWeight } from "./scatter.js";

export const FAR_FOREST =
  new URLSearchParams(globalThis.location?.search ?? "").get("farForest") === "on";

/** The worlds that plant the collar past the square: the forest's surveyed valley. */
export const FAR_FOREST_WORLDS: readonly WorldName[] = ["forest"];

/** The layer `propStreaming.ts` reads to put a placement in the far, shadowless bucket. */
export const FAR_FOREST_LAYER = "far-forest";

/**
 * Unit-scale metres at which a far-forest spruce becomes the engine's whole-asset impostor; WorldCells
 * scales it by each placement's own scale. The square's spruce switch at 150 m over their smallest
 * scale (`impostorDistanceForScale`), about 360 m, and a cooked far spruce is 4-20 k triangles, so
 * the same gate on the collar's ninety thousand trees would draw millions of them from the vista.
 * The world package rejects a gate inside the last authored step, so with the licensed spruce's
 * 80/150 m chain `propStreaming.ts` lifts it to just past 150 m.
 */
export const FAR_FOREST_IMPOSTOR = 110;

/** Every number the placement rule uses; the game's, so a retune is one edit here. */
export const FAR_FOREST_RULES = {
  /** Candidate grid, metres: at most one tree per cell. */
  cell: 6,
  /** Mean spacing just past the square, and where the far spacing is reached (metres past the edge). */
  spacingNear: 6.5,
  spacingFar: 13,
  spacingFrom: 150,
  spacingTo: 1500,
  /** Chebyshev distance from the origin beyond which nothing is planted. */
  reach: 2300,
  /** Slope fade, degrees, and the slopes over which a meadow clearing fades out. */
  slope: [36, 46],
  meadowSlope: [12, 24],
  /** How far the treeline wanders with noise, metres. */
  treelineJitter: 30,
  /** Stand noise threshold band; the square plants above 0.3. */
  stand: [0.26, 0.4],
  seed: 466_559,
} as const;

/**
 * The drawn collar's height at any (x, z), and a way to raise one of its per-vertex attributes at a
 * placement: both read the collar's own quad grid, so a lane that reshapes the collar moves the
 * trees with it.
 */
export function collarSampler(collar: HeightfieldCollar) {
  const at = (x: number, z: number): number | null => collar.heightAt(x, z);
  /** Raise the collar's per-vertex attribute to `value` at the four corners of (x, z)'s quad. */
  const paint = (attribute: BufferAttribute, x: number, z: number, value: number): void => {
    const quad = collar.locate(x, z);
    if (quad === undefined) return;
    for (const index of [
      collar.index(quad.lower, quad.from),
      collar.index(quad.lower, quad.to),
      collar.index(quad.upper, quad.from),
      collar.index(quad.upper, quad.to),
    ])
      attribute.setX(index, Math.max(attribute.getX(index), value));
  };
  return { at, paint };
}

const macroNoise = new ImprovedNoise();

interface IFarForestOptions {
  readonly size: number;
  readonly resolution: number;
  /** The world's far collar, as drawn. */
  readonly collar: HeightfieldCollar;
  /** The measured treeline band, metres (`IWorldBiome.heightBands.treeline`). */
  readonly treeline: readonly [number, number];
  readonly rivers?: readonly IBakedRiver[];
  readonly lakes?: readonly IBakedLake[];
  /** Circles kept open, [x, z, radius]: the vista's meadow. */
  readonly clear?: readonly (readonly [number, number, number])[];
}

/** Spruce placements on the collar; also paints the collar's `canopy` attribute under each crown. */
export function farForestPlacements(options: IFarForestOptions): IPlacement[] {
  const rules = FAR_FOREST_RULES;
  const half = options.size / 2;
  const collar = collarSampler(options.collar);
  const random = createRandom(rules.seed);
  // River corridors, as the square's scatter keeps them: the index finds candidates, the exact
  // distance to each segment decides.
  const rivers = createSegmentIndex(
    (options.rivers ?? []).flatMap((river) =>
      river.points.flatMap((to, index) => {
        const from = river.points[index - 1];
        if (!from) return [];
        const a = [from[0] ?? 0, from[2] ?? 0] as const;
        const b = [to[0] ?? 0, to[2] ?? 0] as const;
        const reach = river.width * 2.5;
        return [{ a, b, reach, data: { a, b, reach } }];
      }),
    ),
    32,
  );
  const inRiver = (x: number, z: number): boolean =>
    rivers.nearby(x, z).some(({ a, b, reach }) => {
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const t = MathUtils.clamp(
        ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz || 1),
        0,
        1,
      );
      return Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz) < reach;
    });
  const wet = (x: number, z: number, height: number): boolean =>
    inRiver(x, z) ||
    (options.lakes ?? []).some(
      (lake) =>
        Math.hypot(x - (lake.at[0] ?? 0), z - (lake.at[1] ?? 0)) < lake.radius &&
        height < lake.level + 0.35,
    );
  const canopy = options.collar.geometry.getAttribute("canopy") as BufferAttribute | undefined;
  const placements: IPlacement[] = [];
  const [slopeFrom, slopeTo] = rules.slope;
  const [standFrom, standTo] = rules.stand;
  const [treeFrom, treeTo] = options.treeline;
  for (let gz = -rules.reach; gz < rules.reach; gz += rules.cell)
    for (let gx = -rules.reach; gx < rules.reach; gx += rules.cell) {
      const x = gx + (0.1 + 0.8 * random()) * rules.cell;
      const z = gz + (0.1 + 0.8 * random()) * rules.cell;
      const keep = random();
      const past = Math.max(Math.abs(x), Math.abs(z)) - half;
      if (past < 2) continue;
      // Spacing first: the cheapest test, and the one that culls most candidates far out.
      const spacing = MathUtils.lerp(
        rules.spacingNear,
        rules.spacingFar,
        MathUtils.smoothstep(past, rules.spacingFrom, rules.spacingTo),
      );
      const spaced = Math.min(1, (rules.cell / spacing) ** 2);
      if (keep >= spaced) continue;
      if ((options.clear ?? []).some(([cx, cz, r]) => Math.hypot(x - cx, z - cz) < r)) continue;
      const height = collar.at(x, z);
      if (height === null) continue;
      const step = 4;
      const dx = (collar.at(x + step, z) ?? height) - (collar.at(x - step, z) ?? height);
      const dz = (collar.at(x, z + step) ?? height) - (collar.at(x, z - step) ?? height);
      const slope = MathUtils.radToDeg(Math.atan(Math.hypot(dx, dz) / (2 * step)));
      const flat = 1 - MathUtils.smoothstep(slope, slopeFrom, slopeTo);
      if (flat <= 0) continue;
      // Kilometre-scale meadows on gentle ground, then the square's stands running on past its edge.
      const meadow =
        1 -
        (1 - MathUtils.smoothstep(macroNoise.noise(x * 0.0021, 5.3, z * 0.0021), -0.3, -0.12)) *
          (1 - MathUtils.smoothstep(slope, rules.meadowSlope[0], rules.meadowSlope[1]));
      if (meadow <= 0) continue;
      // Moisture is the ground's own shape: a hollow sits below its surroundings and holds water.
      const around =
        ((collar.at(x + 40, z) ?? height) +
          (collar.at(x - 40, z) ?? height) +
          (collar.at(x, z + 40) ?? height) +
          (collar.at(x, z - 40) ?? height)) /
        4;
      const damp = MathUtils.clamp((around - height) / 8 + 0.3, 0, 1);
      const stand = MathUtils.smoothstep(
        forestWeight(x, z) + (damp - 0.3) * 0.2,
        standFrom,
        standTo,
      );
      if (stand <= 0) continue;
      const jitter = macroNoise.noise(x * 0.011, 17.7, z * 0.011) * rules.treelineJitter;
      const alpine = 1 - MathUtils.smoothstep(height + jitter, treeFrom, treeTo);
      if (alpine <= 0 || wet(x, z, height)) continue;
      // The tests above are densities; the keep draw already passed the spacing share of it.
      if (random() >= meadow * stand * alpine * flat) continue;
      const age = MathUtils.clamp(macroNoise.noise(x * 0.021, 7, z * 0.021) * 0.5 + 0.5, 0, 1);
      const scale =
        (0.55 + 1.05 * age ** 1.6 + random() * 0.16) *
        (0.6 + 0.4 * Math.min(stand, alpine)) *
        (1 + 0.25 * damp);
      const index = placements.length;
      placements.push({
        asset: "spruce",
        id: `temperate-spruce:far-${index}`,
        layer: FAR_FOREST_LAYER,
        alignToNormal: false,
        normal: [0, 1, 0],
        position: [x, 0, z],
        rotation: random() * Math.PI * 2,
        scale,
      });
      if (canopy) collar.paint(canopy, x, z, 1);
    }
  if (canopy) canopy.needsUpdate = true;
  return placements;
}
