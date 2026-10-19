import { createRandom } from "@threenative/core";
// Where the Temperate starter's props go.
//
// The rule is short and it is the rule the rubric is written against: a spruce stands on grass, a
// boulder stands on grass or rock, grass grows on grass, poppies grow in patches on grass — and
// nothing stands on sand, on the road, on a cliff, or in the sea. Every placement here is read off
// the same baked data the ground material draws from, so the meadow and its trees agree about where
// the grass is instead of disagreeing.
//
// Placement is seeded and deterministic: the same world always grows the same forest, and a camera
// can walk through it twice without the trees moving. Nothing here reads the frame clock.
import type { Heightfield } from "@threenative/core/world";
import { type IPlacement, createSegmentIndex, slopeQuantile } from "@threenative/terrain";
import { ImprovedNoise } from "three/addons/math/ImprovedNoise.js";
import type { WorldName } from "./biomes.js";
import { type IBakedWorld, depositAtIndex } from "./terrain.js";

const tundraNoise = new ImprovedNoise();
const tundraCover = (x: number, z: number): number =>
  clamp01(
    0.52 +
      tundraNoise.noise(x * 0.043, 11, z * 0.043) * 0.85 +
      tundraNoise.noise(x * 0.11, 19, z * 0.11) * 0.15,
  );

/** A field the placement rule reads: the world's own baked colours plus its sampled geometry. */
export interface IPlacementField {
  readonly colors: readonly number[];
  readonly erosion?: IBakedWorld["erosion"];
  readonly field: Heightfield;
  readonly resolution: number;
  readonly size: number;
  readonly waterLevel: number | null;
  readonly world?: WorldName;
  /** Still water: nothing grows below a lake's level inside its reach. */
  readonly rivers?: readonly {
    readonly points: readonly (readonly number[])[];
    readonly width: number;
  }[];
  readonly lakes?: readonly {
    readonly at: readonly number[];
    readonly radius: number;
    readonly level: number;
  }[];
}

/**
 * What the ground is where a prop wants to stand.
 *
 * `grass` is how much of that sample is meadow, in 0..1. The bake painted its own palette into the
 * vertex colours, and the same signal the ground material uses to blend its layers is the signal
 * here: green over red is grass, red over green is the road, the dirt patch and the beach.
 */
export function grassWeight(data: IPlacementField, x: number, z: number): number {
  // terrain.ts now blends by actual landform, not the bake's old brown palette.
  // Match its meadow/rock/alpine and beach reaches so a green surface grows real cover.
  const height = clampedHeight(data, x, z);
  if (data.world === "coastal" && data.waterLevel !== null)
    return (
      clamp01((height - data.waterLevel - 1.8) / 5.7) *
      clamp01((42 - slopeDegrees(data, x, z)) / 20)
    );
  if (data.waterLevel !== null && height < data.waterLevel + 7.5) return 0;
  const slope = slopeDegrees(data, x, z);
  if (data.world === "alpine") return 0; // This 3690 m glacial shoulder is above the treeline.
  if (data.world === "desert") return clamp01((24 - slope) / 20) * 0.32;
  if (data.world === "tundra")
    return clamp01((30 - slope) / 22) * clamp01((forestWeight(x * 9.8, z * 8.7) - 0.47) / 0.3);
  return clamp01((42 - slope) / 20) * clamp01((66 - height) / 28);
}

/** A value clamped to 0..1, because a density is a probability and a probability above one is a bug. */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** The world's edge, clamped: a slope probe a metre outside the field is a probe of nothing. */
function clampedHeight(data: IPlacementField, x: number, z: number): number {
  const limit = data.size / 2 - 0.001;
  return data.field.heightAt(
    Math.min(limit, Math.max(-limit, x)),
    Math.min(limit, Math.max(-limit, z)),
  );
}

/** Slope at a sample, in degrees. A spruce will not stand on a cliff; grass will not either. */
export function slopeDegrees(data: IPlacementField, x: number, z: number): number {
  const step = data.size / (data.resolution - 1);
  const dx = clampedHeight(data, x + step, z) - clampedHeight(data, x - step, z);
  const dz = clampedHeight(data, x, z + step) - clampedHeight(data, x, z - step);
  return (Math.atan(Math.hypot(dx, dz) / (2 * step)) * 180) / Math.PI;
}

/** Every placement, for one world, from one seed. */
export interface IPropScatter {
  readonly placements: IPlacement[];
  /** How many of each prop was accepted, for the report and the playtest's own state. */
  readonly counts: Record<string, number>;
}

/**
 * Stand density, 0..1, as value noise rather than a sum of sines.
 *
 * The old mask was `0.52 + 0.27·sin(0.035x + 0.018z) + …`: three plane waves, which is a stripe
 * generator. A threshold through it puts the trees on diagonals at one spacing and one height, and
 * that regularity — not the tree model — is what read as "Tree Tree Tree" from the air. Two octaves
 * of value noise give stands with lobed, irregular edges instead.
 */
const standNoise = new ImprovedNoise();
export function forestWeight(x: number, z: number): number {
  return clamp01(
    0.5 +
      0.3 * standNoise.noise(x * 0.0075, 3.1, z * 0.0075) +
      0.2 * standNoise.noise(x * 0.026, 8.7, z * 0.026),
  );
}
/** An independent field for anything that must not track the stand mask: age, moisture, gaps. */
const fieldNoise = new ImprovedNoise();
const sample01 = (x: number, y: number, z: number): number =>
  clamp01(fieldNoise.noise(x, y, z) * 0.5 + 0.5);

export const SCATTER = {
  spruceSpacing: 4.6,
  spruceCount: 3200,
  spruceAttempts: 80000,
  grassCell: 1.2,
  grassFull: 22,
  grassThin: 62,
  seed: 466_468,
} as const;

export function scatterProps(
  data: IPlacementField,
  focus: { x: number; z: number },
  clearings: readonly (readonly [number, number, number])[] = [],
): IPropScatter {
  const temperate = data.world === undefined || data.world === "forest" || data.world === "coastal";
  const desert = data.world === "desert";
  const tundra = data.world === "tundra";
  const alpine = data.world === "alpine";
  const treeLimit = temperate ? SCATTER.spruceCount : desert || alpine ? 0 : tundra ? 55 : 600;
  const placements: IPlacement[] = [];
  const counts: Record<string, number> = Object.fromEntries(
    [
      "boulder",
      "bush",
      "fern",
      "grass",
      "litter",
      "poppy",
      "sapling",
      "scrub",
      "spruce",
      "riverrock",
      "scree",
      "cliff",
      "mountain",
      "volcanic",
      "reveal",
    ].map((name) => [name, 0]),
  );
  const random = createRandom(SCATTER.seed);
  const half = data.size / 2;
  const inside = (x: number, z: number) => Math.abs(x) < half - 3 && Math.abs(z) < half - 3;
  // River segments indexed by their reach (`@threenative/terrain`), so a candidate tests only the
  // segments that can reach it rather than every segment of every river.
  const riverIndex = createSegmentIndex(
    tundra
      ? (data.rivers ?? []).flatMap((river) =>
          river.points.flatMap((b, index) => {
            const a = river.points[index - 1];
            return a
              ? [
                  {
                    a: [a[0] ?? 0, a[2] ?? 0] as const,
                    b: [b[0] ?? 0, b[2] ?? 0] as const,
                    reach: river.width * 2.5,
                    data: { a, b, reach: river.width * 2.5 },
                  },
                ]
              : [];
          }),
        )
      : [],
    32,
  );
  const nearRiver = (x: number, z: number): boolean =>
    riverIndex.nearby(x, z).some(({ a, b, reach }) => {
      const dx = (b[0] ?? 0) - (a[0] ?? 0);
      const dz = (b[2] ?? 0) - (a[2] ?? 0);
      const t = clamp01(
        ((x - (a[0] ?? 0)) * dx + (z - (a[2] ?? 0)) * dz) / (dx * dx + dz * dz || 1),
      );
      const distance = Math.hypot(x - (a[0] ?? 0) - t * dx, z - (a[2] ?? 0) - t * dz);
      const level = (a[1] ?? 0) + t * ((b[1] ?? 0) - (a[1] ?? 0));
      return distance < reach && clampedHeight(data, x, z) < level + 0.35;
    });
  const wet = (x: number, z: number) =>
    (data.waterLevel !== null && clampedHeight(data, x, z) < data.waterLevel + 0.35) ||
    (tundra && nearRiver(x, z)) ||
    (data.lakes ?? []).some(
      (lake) =>
        Math.hypot(x - (lake.at[0] ?? 0), z - (lake.at[1] ?? 0)) < lake.radius &&
        clampedHeight(data, x, z) < lake.level + 0.35,
    );
  const depositsAt = (x: number, z: number): number => {
    const column = Math.max(
      0,
      Math.min(data.resolution - 1, Math.round((x / data.size + 0.5) * (data.resolution - 1))),
    );
    const row = Math.max(
      0,
      Math.min(data.resolution - 1, Math.round((z / data.size + 0.5) * (data.resolution - 1))),
    );
    return depositAtIndex(data, row * data.resolution + column);
  };
  const put = (asset: string, x: number, z: number, scale: number, suffix = "") => {
    if (!inside(x, z) || (asset !== "riverrock" && wet(x, z))) return;
    if (data.erosion && asset === "scree" && depositsAt(x, z) < 0.08) {
      // The light DEM transport pass is bounded to <1 m. Existing surveyed talus remains scree
      // even when this tiny additional pass deposited almost nothing on it.
      const slope = slopeDegrees(data, x, z);
      if (!(alpine || desert) || slope < 18 || slope > 38) return;
    }
    if (asset === "cliff") {
      // Stones normalize their largest dimension to 18 m. This envelope covers every yaw.
      const reach = 18 * Math.SQRT1_2 * scale;
      if (
        data.waterLevel !== null ||
        [-reach, 0, reach].some((dx) =>
          [-reach, 0, reach].some(
            (dz) =>
              grassWeight(data, x + dx, z + dz) > 0.05 || slopeDegrees(data, x + dx, z + dz) < 43,
          ),
        )
      )
        return;
    }
    if (alpine && asset === "mountain" && (Math.abs(x) > half - 48 || Math.abs(z) > half - 48))
      return;
    if (desert && ["boulder", "scree", "volcanic", "reveal"].includes(asset)) {
      const height = clampedHeight(data, x, z);
      const slope = slopeDegrees(data, x, z);
      const neighbours = [
        [-18, 0],
        [18, 0],
        [0, -18],
        [0, 18],
      ].map(([dx, dz]) => clampedHeight(data, x + (dx ?? 0), z + (dz ?? 0)));
      const foot = slope < 35 && Math.max(...neighbours) > height + 8;
      const rim = slope < 24 && Math.min(...neighbours) < height - 8;
      if (!foot && !rim) return;
    }
    const index = counts[asset] ?? 0;
    const crag = asset === "mountain" || asset === "volcanic" || asset === "reveal";
    const bedded = temperate && ["boulder", "riverrock", "scree"].includes(asset);
    const normal = crag || bedded ? data.field.normalAt(x, z) : undefined;
    if (crag && normal) {
      normal.y += 0.65;
      normal.normalize();
    }
    placements.push({
      asset,
      id: `temperate-${asset}:${index}${suffix}`,
      layer: `temperate-${asset}`,
      alignToNormal: crag || bedded || (temperate && (asset === "spruce" || asset === "sapling")),
      normal:
        (crag || bedded) && normal
          ? normal.toArray()
          : temperate && (asset === "spruce" || asset === "sapling")
            ? [Math.sin(x * 1.17 + z) * 0.045, 1, Math.cos(z * 1.31 - x) * 0.045]
            : [0, 1, 0],
      position: [x, clampedHeight(data, x, z), z],
      rotation:
        crag && normal
          ? Math.atan2(normal.x, normal.z) + (random() - 0.5) * 0.6
          : random() * Math.PI * 2,
      scale,
    });
    counts[asset] = index + 1;
  };
  const nearEye = (x: number, z: number) =>
    clearings.some(([cx, cz, radius]) => Math.hypot(x - cx, z - cz) < radius * 1.6);
  const cells = new Map<string, [number, number, number][]>();
  const CELL = 7;
  // Poisson disc whose radius follows the stand mask: a closed core packs tight, an edge opens out.
  // There is no per-cell occupancy, because one tree per cell IS the lattice the old rule drew.
  const crowded = (x: number, z: number, reach: number) => {
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++)
        for (const [tx, tz, tr] of cells.get(`${cx + dx},${cz + dz}`) ?? [])
          if (Math.hypot(tx - x, tz - z) < Math.max(reach, tr)) return true;
    return false;
  };
  const treeAsset = temperate || alpine ? "spruce" : "sapling";
  // Moisture is measured, not painted: a hollow sits below its neighbours and holds water, and that
  // is where ferns, litter and the riparian species go.
  const hollow = (x: number, z: number): number => {
    const here = clampedHeight(data, x, z);
    const around = [-26, -13, 13, 26].map(
      (d) => (clampedHeight(data, x + d, z) + clampedHeight(data, x, z + d)) / 2,
    );
    return clamp01(((Math.max(...around) - here) / 3.5 + 0.15) * 0.5);
  };
  for (
    let tries = 0;
    (counts[treeAsset] ?? 0) < treeLimit && tries < SCATTER.spruceAttempts;
    tries++
  ) {
    const x = (random() - 0.5) * data.size;
    const z = (random() - 0.5) * data.size;
    if (
      !inside(x, z) ||
      wet(x, z) ||
      nearEye(x, z) ||
      slopeDegrees(data, x, z) > 32 ||
      (temperate &&
        data.waterLevel !== null &&
        clampedHeight(data, x, z) < data.waterLevel + 7.5) ||
      (data.world === "alpine" && clampedHeight(data, x, z) > 52) ||
      grassWeight(data, x, z) < (temperate ? 0.3 : 0.18) ||
      forestWeight(x, z) < (temperate ? 0.3 : 0.42)
    )
      continue;
    const stand = forestWeight(x, z);
    const reach = temperate ? 6.4 - 3.2 * clamp01((stand - 0.28) / 0.5) : 3.4;
    if (crowded(x, z, reach)) continue;
    const key = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
    const bucket = cells.get(key) ?? [];
    bucket.push([x, z, reach]);
    cells.set(key, bucket);
    // Age structure from its own field, so a dense core is not one height: most of a stand is
    // mid-sized, a few are veterans, and the young crowd the light gaps.
    const age = sample01(x * 0.021, 7, z * 0.021);
    put(
      treeAsset,
      x,
      z,
      temperate
        ? 0.42 + 1.18 * age ** 1.6 + random() * 0.16
        : (tundra ? 0.25 : 0.55) + random() * 0.35,
    );
    // Regeneration at stand edges; ferns stay under established crowns.
    const edge = stand < 0.57;
    for (let i = 0; i < (tundra ? 0 : edge ? 2 : 1); i++) {
      const angle = random() * Math.PI * 2;
      const reachOut = 2 + random() * 4;
      const sx = x + Math.cos(angle) * reachOut;
      const sz = z + Math.sin(angle) * reachOut;
      if (!nearEye(sx, sz) && grassWeight(data, sx, sz) > 0.25)
        put("sapling", sx, sz, 0.55 + random() * 0.9);
    }
    if (temperate)
      for (let i = 0; i < 2; i++)
        put("fern", x + (random() - 0.5) * 7, z + (random() - 0.5) * 7, 0.6 + random() * 0.75);
  }
  if (temperate) {
    // The understorey is the layer the wood was missing: bracken and needle litter under a closed
    // canopy, thickets in the light gaps and along the wet ground, all keyed to the same stand mask.
    // Needle litter is a half-metre twig: it is worth 9000 of them and no more, because past sixteen
    // metres it is sub-pixel and the count is pure host cost.
    for (let i = 0; i < 14000; i++) {
      const x = (random() - 0.5) * data.size;
      const z = (random() - 0.5) * data.size;
      if (!inside(x, z) || wet(x, z) || nearEye(x, z)) continue;
      if (slopeDegrees(data, x, z) > 30) continue;
      const stand = forestWeight(x, z);
      const damp = hollow(x, z);
      const open = grassWeight(data, x, z);
      if (open < 0.28) continue;
      // Litter: the floor of a closed stand, thickest where the canopy is and under the drip line.
      if (stand > 0.44 && random() < (stand - 0.4) * 1.9 + damp * 0.25)
        put("litter", x, z, 0.65 + random() * 1.1);
      // Bracken: shade and damp, not open meadow.
      if (stand > 0.4 && damp > 0.25 && random() < damp * 0.55)
        put("fern", x, z, 0.7 + random() * 0.8);
      // Thickets: the light gaps, the stand edge and the wet hollow — where a wood lets a bush in.
      if (stand < 0.66 && random() < 0.05 + damp * 0.16 + (stand < 0.5 ? 0.06 : 0))
        put("bush", x, z, 0.5 + random() * 1.1);
      // Meadow flowers want light and a little soil, so they take the gaps, not the canopy floor.
      if (stand < 0.58 && damp > 0.18 && random() < 0.02 + damp * 0.05)
        put("poppy", x, z, 0.75 + random() * 0.6);
    }
  }
  // Tundra and desert are not carpets. Both grow in clumps with bare ground between them, and both
  // read as a mown lawn when every plant sits on its own lattice point — so each grows a cluster of
  // tufts around a chosen centre instead of one plant per cell.
  if (tundra || desert) {
    for (let i = 0; i < (tundra ? 1100 : 900); i++) {
      const cx = (random() - 0.5) * data.size;
      const cz = (random() - 0.5) * data.size;
      if (!inside(cx, cz)) continue;
      // Tundra follows its own mat field; desert follows the washes, which are the low ground.
      const bias = tundra
        ? clamp01((tundraCover(cx, cz) - 0.42) / 0.3)
        : clamp01((hollow(cx, cz) - 0.1) * 1.5);
      if (random() > 0.3 + bias * 0.65) continue;
      const radius = tundra ? 1.2 + random() * 3 : 1.8 + random() * 4.5;
      const tufts = tundra ? 8 + Math.floor(random() * 14) : 5 + Math.floor(random() * 9);
      for (let k = 0; k < tufts; k++) {
        const angle = random() * Math.PI * 2;
        const out = radius * Math.sqrt(random());
        cover(cx + Math.cos(angle) * out, cz + Math.sin(angle) * out, 0.85);
      }
    }
  }
  // Metre-scale outcrops follow the surveyed walls; the DEM owns every ridge and couloir.
  if (alpine) {
    for (let z = -half + 48; z < half - 48; z += 24)
      for (let x = -half + 48; x < half - 48; x += 24) {
        const sx = x + (random() - 0.5) * 12;
        const sz = z + (random() - 0.5) * 12;
        if (slopeDegrees(data, sx, sz) < 40 || clampedHeight(data, sx, sz) < 65 || random() > 0.55)
          continue;
        const metres = 2 + random() * 3;
        put("mountain", sx, sz, metres / 24);
        const fall = data.field.normalAt(sx, sz);
        const length = Math.hypot(fall.x, fall.z) || 1;
        const overlapX = sx + (fall.x / length) * metres * 0.28;
        const overlapZ = sz + (fall.z / length) * metres * 0.28;
        if (
          clampedHeight(data, overlapX, overlapZ) > 42 &&
          slopeDegrees(data, overlapX, overlapZ) > 28
        )
          put("mountain", overlapX, overlapZ, (metres * 0.85) / 24);
        // A broad toe of small angular debris, widening downhill from each exposed wall.
        for (let k = 0; k < 28; k++) {
          const down = 16 + random() * 24;
          const across = (random() - 0.5) * down;
          const tx = sx + (fall.x * down - fall.z * across) / length;
          const tz = sz + (fall.z * down + fall.x * across) / length;
          if (slopeDegrees(data, tx, tz) < 38) put("scree", tx, tz, 0.08 + random() * 0.28);
        }
      }
  }
  if (desert) {
    for (let z = -half + 18; z < half - 18; z += 9)
      for (let x = -half + 18; x < half - 18; x += 9) {
        const sx = x + (random() - 0.5) * 7;
        const sz = z + (random() - 0.5) * 7;
        if (random() < 0.7) put("volcanic", sx, sz, 0.06 + random() * 0.12);
        if (random() < 0.5) put("reveal", sx, sz, 0.15 + random() * 0.2);
      }
  }
  // Rock clusters follow exposed slopes rather than evenly spaced lawn ornaments.
  for (let i = 0; i < (temperate ? 1100 : 2400); i++) {
    const x = (random() - 0.5) * data.size;
    const z = (random() - 0.5) * data.size;
    if (!inside(x, z) || wet(x, z)) continue;
    const slope = slopeDegrees(data, x, z);
    const deposits = depositsAt(x, z);
    if (
      (slope < (tundra ? 3 : desert ? 8 : 15) && deposits < 0.18) ||
      random() > 0.38 ||
      nearEye(x, z)
    )
      continue;
    if (slope > 43) {
      if (temperate && random() < 0.22) put("cliff", x, z, 0.65 + random() * 0.5);
      continue;
    }
    if (deposits > 0.12 && slope < 40 && random() < 0.65) {
      for (let k = 0; k < 3; k++)
        put("scree", x + (random() - 0.5) * 8, z + (random() - 0.5) * 8, 0.12 + random() * 0.3);
    }
    if (alpine && slope > 18 && slope < 38) {
      for (let k = 0; k < 8; k++) {
        const sx = x + (random() - 0.5) * 14;
        const sz = z + (random() - 0.5) * 14;
        if (slopeDegrees(data, sx, sz) < 42) put("scree", sx, sz, 0.12 + random() * 0.22);
      }
    }
    for (let k = 0; k < 2 + Math.floor(random() * 3); k++)
      put("boulder", x + (random() - 0.5) * 8, z + (random() - 0.5) * 8, 0.45 + random() * 0.8);
  }
  if (temperate && data.waterLevel !== null) {
    // Reuse the river stones for a broken rocky tide line, below the vegetation's beach exclusion.
    for (let i = 0; i < 2200; i++) {
      const x = (random() - 0.5) * data.size;
      const z = (random() - 0.5) * data.size;
      const above = clampedHeight(data, x, z) - data.waterLevel;
      if (above < 0.4 || above > 4.8 || slopeDegrees(data, x, z) > 38 || random() > 0.28) continue;
      put("riverrock", x, z, 0.8 + random() * 2.4);
      if (random() < 0.22) put("boulder", x + 1.2, z - 1.2, 0.3 + random() * 0.5);
    }
  }
  for (const river of data.rivers ?? []) {
    for (let i = 1; i < river.points.length; i++) {
      const a = river.points[i - 1];
      const b = river.points[i];
      if (!a || !b) continue;
      const dx = (b[0] ?? 0) - (a[0] ?? 0);
      const dz = (b[2] ?? 0) - (a[2] ?? 0);
      const length = Math.hypot(dx, dz);
      for (let at = 0; at < length; at += 2.4) {
        const side = random() < 0.5 ? -1 : 1;
        const reach = river.width * (0.42 + random() * 0.3) * side;
        put(
          "riverrock",
          (a[0] ?? 0) + (dx * at) / length - (dz / length) * reach,
          (a[2] ?? 0) + (dz * at) / length + (dx / length) * reach,
          0.5 + random() * 1.2,
        );
      }
    }
  }
  function cover(x: number, z: number, density: number): void {
    if (
      !inside(x, z) ||
      wet(x, z) ||
      slopeDegrees(data, x, z) > 34 ||
      (tundra ? clamp01((tundraCover(x, z) - 0.47) / 0.3) : grassWeight(data, x, z)) < 0.22
    )
      return;
    const drift = temperate
      ? 0.65 + 0.35 * forestWeight(x * 3.1, z * 2.7)
      : tundra
        ? clamp01((tundraCover(x, z) - 0.45) / 0.3)
        : desert
          ? 0.08 + 0.6 * clamp01((forestWeight(x * 6.3, z * 5.7) - 0.5) / 0.3)
          : clamp01((forestWeight(x * 2.1, z * 2.4) - 0.3) / 0.45);
    if (random() > density * drift) return;
    put(
      "grass",
      x,
      z,
      (data.world === "coastal" && clampedHeight(data, x, z) < (data.waterLevel ?? 0) + 7.5
        ? 2.2
        : temperate
          ? 0.8
          : tundra
            ? 0.45
            : desert
              ? 0.95
              : 0.55) +
        random() * (temperate ? 0.65 : tundra ? 0.3 : 0.5),
    );
    if (desert) {
      for (let tuft = 0; tuft < 3; tuft++)
        put(
          "grass",
          x + (random() - 0.5) * 1.4,
          z + (random() - 0.5) * 1.4,
          0.65 + random() * 0.55,
        );
    }
    if (random() < (desert ? 0.65 : tundra ? 0.22 : 0.3))
      put(
        "scrub",
        x + (random() - 0.5),
        z + (random() - 0.5),
        (desert ? 0.8 : tundra ? 0.55 : 0.9) + random() * (tundra ? 0.5 : 0.6),
      );
    if (tundra && random() < 0.02)
      put("bush", x + (random() - 0.5) * 2, z + (random() - 0.5) * 2, 0.6 + random() * 0.45);
  }
  // A cheap carpet on every grass cell; dense detail at all walking/benchmark eyes, not one disc.
  for (
    let z = -half + 3;
    z < half - 3;
    z += temperate ? SCATTER.grassCell : desert ? 7 : tundra ? 1.8 : 3.5
  )
    for (
      let x = -half + 3;
      x < half - 3;
      x += temperate ? SCATTER.grassCell : desert ? 7 : tundra ? 1.8 : 3.5
    )
      cover(
        x + (random() - 0.5) * (temperate ? 1.5 : desert ? 6 : tundra ? 1.7 : 3),
        z + (random() - 0.5) * (temperate ? 1.5 : desert ? 6 : tundra ? 1.7 : 3),
        0.7,
      );
  const eyes = [focus, ...clearings.map(([x, z]) => ({ x, z }))];
  for (const eye of eyes) {
    // The forest's thinned walking-eye carpet stays as tuned; other biomes take their own spacing.
    const eyeStep = temperate
      ? data.world === "coastal"
        ? 0.34
        : 0.5
      : desert
        ? 1.8
        : tundra
          ? 0.5
          : 0.6;
    const eyeReach = temperate ? SCATTER.grassThin : SCATTER.grassFull + 22;
    // Uniform rejection sampling in the eye disc avoids a carpet of parallel jittered rows.
    if (tundra) {
      for (let i = 0; i < Math.ceil((Math.PI * eyeReach ** 2) / eyeStep ** 2); i++) {
        const angle = random() * Math.PI * 2;
        const distance = Math.sqrt(random()) * eyeReach;
        const density = Math.max(
          0.08,
          1 - Math.max(0, distance - SCATTER.grassFull) / (eyeReach - SCATTER.grassFull),
        );
        cover(eye.x + Math.cos(angle) * distance, eye.z + Math.sin(angle) * distance, density);
      }
      continue;
    }
    for (let dz = -eyeReach; dz < eyeReach; dz += eyeStep)
      for (let dx = -eyeReach; dx < eyeReach; dx += eyeStep) {
        const distance = Math.hypot(dx, dz);
        if (distance > eyeReach) continue;
        const density = Math.max(
          0.08,
          1 - Math.max(0, distance - SCATTER.grassFull) / (eyeReach - SCATTER.grassFull),
        );
        cover(eye.x + dx + (random() - 0.5) * 0.6, eye.z + dz + (random() - 0.5) * 0.6, density);
      }
    for (let p = 0; p < (temperate ? 14 : 0); p++) {
      const angle = random() * Math.PI * 2;
      const reach = random() * 32;
      const px = eye.x + Math.cos(angle) * reach;
      const pz = eye.z + Math.sin(angle) * reach;
      if (forestWeight(px, pz) > 0.62 && !nearEye(px, pz)) continue;
      const radius = 2.5 + random() * 3.5;
      for (let k = 0; k < 100; k++) {
        const x = px + (random() - 0.5) * radius * 2;
        const z = pz + (random() - 0.5) * radius * 2;
        if (
          Math.hypot(x - px, z - pz) > radius ||
          slopeDegrees(data, x, z) > 28 ||
          grassWeight(data, x, z) < 0.4
        )
          continue;
        put("poppy", x, z, 0.8 + random() * 0.4);
      }
    }
  }
  if (temperate) {
    // Separate seed: dressing the rock/shore never reshuffles the established stands.
    const dressing = createRandom(SCATTER.seed + 12);
    // Rock outcrops take this terrain's own steepest ground: its steepest 2%, but never ground gentler
    // than 30 degrees would allow (`@threenative/terrain` slopeQuantile).
    const outcropSlope = Math.min(
      30,
      slopeQuantile(
        { height: data.field.heights, resolution: data.resolution, size: data.size },
        0.98,
      ),
    );
    for (let z = -half + 12; z < half - 12; z += 12)
      for (let x = -half + 12; x < half - 12; x += 12) {
        const sx = x + (dressing() - 0.5) * 10;
        const sz = z + (dressing() - 0.5) * 10;
        const slope = slopeDegrees(data, sx, sz);
        const height = clampedHeight(data, sx, sz);
        const shore =
          data.waterLevel !== null &&
          height > data.waterLevel + 0.4 &&
          height < data.waterLevel + 7;
        if (nearEye(sx, sz) || wet(sx, sz)) continue;
        if (shore && slope > 12 && dressing() < 0.65)
          put("mountain", sx, sz, (5 + dressing() * 10) / 24, ":outcrop");
        else if (slope > outcropSlope && slope < 64 && dressing() < 0.6)
          put("mountain", sx, sz, (10 + dressing() * 10) / 24, ":outcrop");
      }
  }
  return { counts, placements };
}
