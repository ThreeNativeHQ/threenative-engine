import { createRandom } from "@threenative/core";
import type { HeightfieldCollar } from "@threenative/core/world";
import { type BufferAttribute, MathUtils } from "three";
import { ImprovedNoise } from "three/addons/math/ImprovedNoise.js";
import type { IFarFieldRule } from "../biome/biome.js";
import type { IPlacement } from "../core/types.js";
import { STAND_FIELD, fieldWeight } from "../population/cover-field.js";
import { createSegmentIndex } from "../water/water.js";

/**
 * The far field: spruce on the collar past the playable square, by a rule of densities.
 *
 * The bake plants the square; a game draws its whole valley, so the ground past the edge would read
 * as a bare lawn around one block of trees. This places the far stand on the drawn collar by the
 * rules UE's procedural foliage applies per foliage type, each a density in 0..1 multiplied together
 * (UE 5.8.3: altitude, slope, water, stands and spacing; `InstancedFoliage.cpp`, `FoliageEdMode.cpp`
 * and `ProceduralFoliageTile.cpp`, cited on each test below). Every number is the biome row's `far`
 * block, so a sixth biome tunes its own collar without a branch here.
 *
 * The mechanism is the package's; the game supplies its collar, its treeline band and its cameras.
 */

/** What a far-field tree is: the tessellated collar and the layer the game draws it on. */
export interface IFarFieldOptions {
  readonly size: number;
  readonly resolution: number;
  /** The world's far collar, as drawn. */
  readonly collar: HeightfieldCollar;
  /** The measured treeline band, metres (`IWorldBiome.heightBands.treeline`). */
  readonly treeline: readonly [number, number];
  /** The biome's far-field row: spacing, fades, reach and seed. */
  readonly rules: IFarFieldRule;
  /** The asset a far tree is stamped as, and the layer a game's streaming buckets it under. */
  readonly asset: string;
  readonly layer: string;
  readonly rivers?: readonly {
    readonly points: readonly (readonly number[])[];
    readonly width: number;
  }[];
  readonly lakes?: readonly {
    readonly at: readonly number[];
    readonly radius: number;
    readonly level: number;
  }[];
  /** Circles kept open, [x, z, radius]: the vista's meadow. */
  readonly clear?: readonly (readonly [number, number, number])[];
  /** The sea's surface height, metres, when the world has one: no tree stands under it. */
  readonly seaLevel?: number | null;
}

/**
 * The collar's height at any (x, z), and a way to raise one of its per-vertex attributes at a
 * placement: both read the collar's own quad grid, so a lane that reshapes the collar moves the
 * trees with it.
 *
 * @requires npm i -D @threenative/terrain
 * @situation plant a far field on a drawn collar and paint the canopy its crowns cover
 * @constraint the collar decides where a tree stands; this sampler never resamples the square
 * @example const sampler = collarSampler(collar); const height = sampler.at(x, z);
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

/**
 * Far-field placements on the collar; also paints the collar's `canopy` attribute under each crown.
 *
 * @requires npm i -D @threenative/terrain
 * @situation plant the stand past a game's playable square, out to the drawn collar
 * @constraint the row's `far` block decides every density; the caller supplies the collar and layer
 * @example const trees = farForestPlacements({ size, resolution, collar, treeline, rules, asset, layer });
 */
export function farForestPlacements(options: IFarFieldOptions): IPlacement[] {
  const rules = options.rules;
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
  // A sea draws as one plane at its level, so any ground under it is under water, flooded or not.
  const sea = options.seaLevel ?? Number.NEGATIVE_INFINITY;
  const wet = (x: number, z: number, height: number): boolean =>
    height < sea + 0.35 ||
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
        rules.spacing[0],
        rules.spacing[1],
        MathUtils.smoothstep(past, rules.spacingAt[0], rules.spacingAt[1]),
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
        fieldWeight(STAND_FIELD, x, z) + (damp - 0.3) * 0.2,
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
        asset: options.asset,
        id: `temperate-${options.asset}:far-${index}`,
        layer: options.layer,
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
