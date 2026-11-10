// The starter props of the Temperate world: three seeded spruce variants, three boulders, grass
// clumps and poppy patches. `propWorld.ts` hands their draws to `WorldCells`.
//
// What lives here and what does not:
//
//   - The shapes, their variants, their materials and their placement rule are all this file's. They
//     are the picture, and the picture is the game's (AGENTS rule 3).
//   - preparePose grounds each pose on plain math; propWorld.ts delegates instancing and LOD to WorldCells.
import { createRandom } from "@threenative/core";
import { type IBaseRing, baseRingGap, footprintGap, staticLowestY } from "@threenative/core/world";
import type { IPlacement, IPlacementOverride } from "@threenative/terrain";
import {
  type BufferGeometry,
  DoubleSide,
  Euler,
  Group,
  type Material,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from "three";
import { boulder, fernClump, grassClump, poppyCluster } from "./cover.js";
import { FAR_FOREST_LAYER } from "./farForest.js";
import { ATLAS_CELLS, spruceFarCrown, spruceVariants } from "./spruce.js";

/** Which cell of the needle atlas the poppy petals sample. */
const POPPY_PETAL = { u0: 0.5, v0: 0, u1: 1, v1: 0.5 };

/** How many variants of each prop the starter builds, and the seed they are built from. */
export const VARIANTS = {
  boulder: 3,
  bush: 2,
  fern: 3,
  grass: 4,
  /** The open meadow's dense base layer (`meadowCover`). */
  meadow: 2,
  poppy: 4,
  /** The open meadow's white and violet wildflowers (`meadowCover`). */
  bloom: 4,
  sapling: 3,
  scrub: 3,
  spruce: 5,
  litter: 2,
  seed: 0x9e3779b9,
} as const;

/**
 * Metres at which a prepared prop steps down one detail level.
 *
 * `near` is 60, not the 22 the prepared pine was cut against: the only banded variants in the world
 * are the pack canopy's, and a twelve-metre pine at sixty metres is about eighty pixels tall in a
 * 1080-line frame — the same picture as its far level — while at twenty-two metres it is seven hundred
 * pixels tall and the swap is not a distance LOD at all, it is a visible substitution.
 */

/**
 * The assets whose draws skip the shadow pass.
 *
 * Seedlings and shrubs, and the reason is the cost rather than the look: a pine's shadow is a shape
 * on the meadow, and the shadow of a knee-high plant under a pine is already inside it. Wildwood's
 * `LAYERS` marks the same three layers `castShadows: false`, and its numbers agree.
 */
export const DRAW_REACH: Record<string, number> = {
  grass: 112,
  /** The vista meadow's base layer: `meadowCover` thins it with distance itself, so it is not faded. */
  meadow: 230,
  scrub: 110,
  fern: 105,
  poppy: 65,
  bloom: 65,
  sapling: 160,
  bush: 120,
  litter: 16,
  /** Fallen boughs and logs: metres long, so they read from across a clearing. */
  deadfall: 110,
  boulder: 170,
  riverrock: 100,
  /** River-bed cobbles: a 0.2 m stone under water is sub-pixel well before 45 m. */
  pebble: 45,
  scree: 190,
  cliff: 300,
  mountain: 650,
  volcanic: 400,
  reveal: 260,
};
/**
 * Variants whose own reach is shorter than their asset's.
 *
 * Empty on measurement: cutting the three low mats' reach bought nothing once the band stopped
 * rebuilding every third frame, and it cost the far meadow its grass. A variant named here draws
 * less far.
 */
export const VARIANT_REACH: Record<string, number> = {};
export const NO_SHADOW_ASSETS = new Set([
  "sapling",
  "scrub",
  "grass",
  "meadow",
  "fern",
  "poppy",
  "bloom",
  "litter",
  "pebble",
]);
/** The species whose cover thins out with distance instead of switching off at a fixed reach. */
export const FADED_ASSETS = new Set(["grass", "scrub", "fern"]);

/** One drawable piece of a prop: its geometry, and the role that decides its material. */
/** The share of a boulder's height that sits below the ground. */
const BOULDER_BURIAL = 0.32;

export type PropRole =
  | "bark"
  | "crown"
  | "fern"
  | "grass"
  | "impostor"
  | "needles"
  | "petal"
  | "pine"
  | "stem"
  | "stone";

/**
 * Metres at which a prepared prop steps down one detail level, and the slack that keeps a
 * camera walking the boundary from stepping it up and down again.
 *
 * The bands are the game's, because the triangle budget behind them is the game's: a prop is drawn
 * from its full prepared detail inside `near`, from the mid level past it, and from the far
 * engine impostor past that. The dither transition is a fifth of the band rather than a fixed number of
 * metres, so the same slack works for a two-metre rock, a fourteen-metre spruce and a
 * twenty-two-metre pine.
 */
export const LOD_BANDS = { far: 150, hysteresis: 0.2, mid: 80, near: 22 } as const;

/**
 * Species that step to their second and third prepared level nearer than `LOD_BANDS.mid` and `far`.
 *
 * A spruce 105 m out stands about 110 px tall on a 900 px frame, and from 80 m to 150 m it drew its
 * 10.7k-triangle middle level: two triangles a pixel, on every tree of the far bank. It takes the
 * level it already draws past `far` from 105 m. A grass tuft is under 25 px tall past 30 m and
 * under 10 px past 60 m, and it drew every blade to the end of its 112 m reach.
 * Forest, RTX 2080, 1600x900, four interleaved pairs against `?lodSteps=off`: main-pass triangles
 * fell from 21.2 M to 17.5 M at the player pose and from 36.4 M to 29.0 M at the overview, and the
 * GPU frame by a median 8% at the overview (the frame is bound by pixels, not triangles).
 */
export const LOD_STEPS: Record<string, readonly [number, number]> = {
  fern: [30, 60],
  grass: [30, 60],
  spruce: [LOD_BANDS.mid, 105],
};

/** The metres at which `asset` steps to its second and third prepared level. */
export function lodSteps(asset: string): readonly [number, number] {
  // `?lodSteps=off` is the named override: every species steps at `LOD_BANDS`, for the paired A/B.
  if (new URLSearchParams(globalThis.location?.search ?? "").get("lodSteps") === "off")
    return [LOD_BANDS.mid, LOD_BANDS.far];
  return LOD_STEPS[asset] ?? [LOD_BANDS.mid, LOD_BANDS.far];
}

/**
 * The draw reach a placement's variant gives it, shortened by its seeded fade for `FADED_ASSETS`.
 *
 * `variantIndex` counts the placements the bake drew before this one on the same variant, so the
 * fade is a stable number per blade: the bake writes the reach it computes into the package, and the
 * load path counts live placements on from there.
 */
export function streamedReach(placement: IPlacement, variantIndex: number): number {
  const variant = `${placement.asset}:${variantFor(placement, placement.asset)}`;
  const reach = VARIANT_REACH[variant] ?? DRAW_REACH[placement.asset] ?? Number.POSITIVE_INFINITY;
  if (!FADED_ASSETS.has(placement.asset)) return reach;
  const seed = (Math.imul(variantIndex + 1, 2654435761) >>> 0) / 4294967296;
  return 28 + (reach - 28) * (1 - Math.sqrt(seed));
}

/**
 * The streamed world a placement draws in: the far forest alone, or its reach and shadow policy.
 *
 * The bake writes one container per name, and the load path keeps or drops a container by kind, so
 * `?farForest=` and `?meadow=` answer the same question at load that they answered at compile.
 */
export function streamedBucket(placement: IPlacement, reach: number): string {
  if (placement.layer === FAR_FOREST_LAYER) return "far:false";
  return `${reach === Number.POSITIVE_INFINITY ? "horizon" : "local"}:${!NO_SHADOW_ASSETS.has(placement.asset)}`;
}

/**
 * The terminal gate a spruce variant switches to the engine's whole-asset impostor at.
 *
 * A scaled tree's gate divides by its scale, so the minimum scale of its variant is what keeps the
 * gate beyond the last authored level. A gate inside that step pops the whole tree at a distance the
 * player can see it.
 */
export function impostorDistanceForScale(minScale: number, lastLodDistance: number): number {
  if (!Number.isFinite(minScale) || minScale === 0)
    throw new Error("Spruce terminal distance requires a positive finite placement scale.");
  return Math.max(LOD_BANDS.far / Math.abs(minScale), lastLodDistance * (1 + Number.EPSILON));
}

/**
 * The scale each streamed spruce variant's terminal gate divides by: the smallest one it draws.
 *
 * The gate divides by a variant's minimum scale, so the minimum is taken over the placements that
 * actually draw it — every spruce the far forest does not own, keyed by the variant that draws it.
 * One bucket's minimum, or a far tree's, puts a gate inside a step the player sees pop.
 */
export function spruceGateScales(
  drawn: Iterable<{ readonly placement: IPlacement; readonly scale: number }>,
): Map<string, number> {
  const gates = new Map<string, number>();
  for (const { placement, scale } of drawn) {
    if (placement.asset !== "spruce" || placement.layer === FAR_FOREST_LAYER) continue;
    const variant = `${placement.asset}:${variantFor(placement, placement.asset)}`;
    gates.set(variant, Math.min(gates.get(variant) ?? Number.POSITIVE_INFINITY, Math.abs(scale)));
  }
  return gates;
}

export interface IPropPart {
  readonly geometry: BufferGeometry;
  /**
   * The surface this part draws with, when it is not one of the starter's.
   *
   * The CC0 prepared art and every procedural prop are re-dressed in the starter's own surfaces, so
   * a role decides them. A licensed pack species brings its own atlas and its own UVs and is not
   * re-dressed (`src/render/pack.ts`), so it carries the material it was authored with, and this
   * field is how the batch knows to leave that draw alone when the lit surfaces arrive.
   */
  readonly material?: Material;
  /** Which detail level this part is. `0` is the full one; a variant with only it never steps. */
  readonly level?: number;
  readonly role: PropRole;
  /** Which variant of the prop this part belongs to; parts of one variant always agree. */
  readonly variant: number;
}

/**
 * Build every variant of every prop, once, as flat parts.
 *
 * Building the whole set up front is what makes placement cheap and what keeps the draw count
 * bounded: three spruce variants times two parts is six draws for every tree in the world, not one
 * per tree. The caller decides which variant each placement gets.
 *
 * A `prepared` map replaces the variants it names: indices 0 and 1 of the spruce are the two
 * prepared CC0 firs and index 2 is the procedural one, so both sets are live at once and the
 * procedural tree stays a variant rather than becoming dead code. The indices it does not name
 * are still built, which is what the editor's own scene gets when it has no prepared art.
 */
export function buildPropVariants(
  prepared?: ReadonlyMap<string, IPropPart[]>,
  fallbackSaplingHeight?: number,
): Map<string, IPropPart[]> {
  if (
    fallbackSaplingHeight !== undefined &&
    (!Number.isFinite(fallbackSaplingHeight) || fallbackSaplingHeight <= 0)
  )
    throw new Error("Fallback sapling height must be positive and finite");
  const variants = new Map<string, IPropPart[]>();
  // Every index the layout knows about, so a prepared variant replaces the procedural one at the
  // same index rather than being appended: the placement hash is what picks a variant, and it
  // picks an index, so index 0 has to mean the pine on the machine that has the pine and the
  // procedural spruce on the machine that does not. The saplings' own variants come off the end of
  // the same seeded set, so a seedling and a tree are the same species at two sizes rather than two
  // unrelated shapes.
  const spruces = spruceVariants(PROP_COUNTS.spruce, VARIANTS.seed);
  const youngs = spruceVariants(PROP_COUNTS.sapling, VARIANTS.seed ^ 0x51ed3a7f);
  for (let index = 0; index < PROP_COUNTS.spruce; index += 1) {
    const ready = prepared?.get(`spruce:${index}`);
    if (ready) {
      variants.set(`spruce:${index}`, [...ready]);
      continue;
    }
    const spruce = spruces[index];
    if (spruce === undefined) continue;
    variants.set(`spruce:${index}`, [
      { geometry: spruce.trunk, role: "bark", variant: index },
      // Each variant leans on a different needle card, so three spruce silhouettes are three
      // textures rather than one texture at three sizes.
      { geometry: spruce.crown, role: "crown", variant: index },
      { geometry: spruce.trunk.clone(), role: "bark", variant: index, level: 1 },
      { geometry: spruceFarCrown(spruce.crown), role: "crown", variant: index, level: 1 },
    ]);
  }
  for (let i = 0; i < PROP_COUNTS.boulder; i += 1) {
    const ready = prepared?.get(`boulder:${i}`);
    if (ready) {
      variants.set(`boulder:${i}`, [...ready]);
      continue;
    }
    variants.set(`boulder:${i}`, [
      {
        geometry: boulder((VARIANTS.seed ^ (i * 0x85ebca6b)) >>> 0),
        role: "stone",
        variant: i,
      },
    ]);
  }
  for (let i = 0; i < VARIANTS.fern; i += 1)
    variants.set(
      `fern:${i}`,
      prepared?.get(`fern:${i}`) ?? [
        { geometry: fernClump((VARIANTS.seed ^ (i * 0x165667b1)) >>> 0), role: "fern", variant: i },
      ],
    );
  // The young generation and the two undergrowth niches, all three with the starter's own geometry
  // standing in: a machine with no licensed pack grows a small spruce, a fern-sized shrub and a
  // grass clump. That is a thinner wood, and it is never a broken one — which is the whole point of
  // the licensed art being optional rather than required.
  for (let i = 0; i < PROP_COUNTS.sapling; i += 1) {
    const ready = prepared?.get(`sapling:${i}`);
    if (ready) {
      variants.set(`sapling:${i}`, [...ready]);
      continue;
    }
    const young = youngs[i];
    if (young === undefined) continue;
    if (fallbackSaplingHeight !== undefined) {
      young.trunk.computeBoundingBox();
      young.crown.computeBoundingBox();
      const height = Math.max(
        young.trunk.boundingBox?.max.y ?? 0,
        young.crown.boundingBox?.max.y ?? 0,
      );
      if (!(height > 0)) throw new Error("Procedural sapling has no measurable height");
      const scale = fallbackSaplingHeight / height;
      young.trunk.scale(scale, scale, scale);
      young.crown.scale(scale, scale, scale);
    }
    variants.set(`sapling:${i}`, [
      { geometry: young.trunk, role: "bark", variant: i },
      { geometry: young.crown, role: "crown", variant: i },
      { geometry: young.trunk.clone(), role: "bark", variant: i, level: 1 },
      { geometry: spruceFarCrown(young.crown), role: "crown", variant: i, level: 1 },
    ]);
  }
  for (let i = 0; i < PROP_COUNTS.bush; i += 1) {
    const ready = prepared?.get(`bush:${i}`);
    if (ready) {
      variants.set(`bush:${i}`, [...ready]);
      continue;
    }
    variants.set(`bush:${i}`, [
      { geometry: fernClump((VARIANTS.seed ^ (i * 0x27d4eb2f)) >>> 0), role: "fern", variant: i },
    ]);
  }
  for (let i = 0; i < PROP_COUNTS.scrub; i += 1) {
    const ready = prepared?.get(`scrub:${i}`);
    if (ready) {
      variants.set(`scrub:${i}`, [...ready]);
      continue;
    }
    variants.set(`scrub:${i}`, [
      {
        geometry: grassClump((VARIANTS.seed ^ (i * 0x165667b1)) >>> 0, i),
        role: "grass",
        variant: i,
      },
    ]);
  }
  for (const [asset, i] of [
    ...Array.from({ length: VARIANTS.grass }, (_, i) => ["grass", i] as const),
    ...Array.from({ length: VARIANTS.meadow }, (_, i) => ["meadow", i] as const),
  ]) {
    const ready = prepared?.get(`${asset}:${i}`);
    // Imported grass draws as imported: a darkened procedural clump under each photographed tuft
    // read as a black star at every root.
    variants.set(
      `${asset}:${i}`,
      ready ?? [
        {
          geometry: grassClump((VARIANTS.seed ^ (i * 0xc2b2ae35)) >>> 0, i),
          role: "grass",
          variant: i,
        },
      ],
    );
  }
  for (const [asset, i] of [
    ...Array.from({ length: VARIANTS.poppy }, (_, i) => ["poppy", i] as const),
    ...Array.from({ length: VARIANTS.bloom }, (_, i) => ["bloom", i] as const),
  ]) {
    const ready = prepared?.get(`${asset}:${i}`);
    if (ready) {
      variants.set(`${asset}:${i}`, [...ready]);
      continue;
    }
    const cluster = poppyCluster((VARIANTS.seed ^ (i * 0x27d4eb2f)) >>> 0, POPPY_PETAL);
    variants.set(`${asset}:${i}`, [
      { geometry: cluster.stems, role: "stem", variant: i },
      { geometry: cluster.petals, role: "petal", variant: i },
    ]);
  }
  for (let i = 0; i < VARIANTS.litter; i += 1) {
    const ready = prepared?.get(`litter:${i}`);
    if (ready) {
      variants.set(`litter:${i}`, [...ready]);
      continue;
    }
    // Needle litter has no procedural model, and an empty part list throws away the whole prop
    // build: a machine without the licensed pack then draws no vegetation at all, because the
    // floor of the wood was the one layer with nothing behind it. A flattened clump stands in.
    const twig = grassClump((VARIANTS.seed ^ (i * 0x9e3779b1)) >>> 0);
    twig.scale(1.7, 0.22, 1.7);
    variants.set(`litter:${i}`, [{ geometry: twig, role: "grass", variant: i }]);
  }
  for (const asset of [
    "riverrock",
    "scree",
    "cliff",
    "mountain",
    "volcanic",
    "reveal",
    "pebble",
    "deadfall",
  ])
    for (
      let variant = 0;
      variant < (PROP_COUNTS[asset as keyof typeof PROP_COUNTS] ?? 1);
      variant++
    ) {
      const ready = prepared?.get(`${asset}:${variant}`);
      if (ready) {
        variants.set(`${asset}:${variant}`, ready);
        continue;
      }
      const fallback = boulder(
        asset === "pebble"
          ? (VARIANTS.seed ^ ((variant + 7) * 0x85ebca6b)) >>> 0
          : VARIANTS.seed ^ variant,
      );
      // Without the licensed pack a fallen log is a long low lump of the same generator.
      if (asset === "deadfall") fallback.scale(1.5, 0.22, 0.3);
      if (["mountain", "volcanic", "reveal"].includes(asset)) {
        if (asset === "mountain") fallback.scale(0.65, 1.45, 1.8);
        fallback.computeBoundingBox();
        const size = fallback.boundingBox?.getSize(new Vector3());
        const scale =
          (asset === "mountain" ? 24 : asset === "volcanic" ? 10 : 5) /
          Math.max(size?.x ?? 1, size?.y ?? 1, size?.z ?? 1);
        fallback.scale(scale, scale, scale);
      }
      variants.set(`${asset}:${variant}`, [{ geometry: fallback, role: "stone", variant }]);
    }
  return variants;
}

/**
 * The prop names this starter knows, and how many variants each has.
 *
 * A prepared variant is counted whether or not its model loaded: the count is the starter's
 * layout, and a game with no prepared art still hashes into the same five boulders.
 */
const PROP_COUNTS = {
  ...VARIANTS,
  riverrock: 1,
  /** River-bed cobbles: the boulder generator, three seeds. */
  pebble: 3,
  scree: 1,
  cliff: 1,
  mountain: 2,
  volcanic: 4,
  reveal: 2,
  /** Three fallen bough groups and one log. */
  deadfall: 4,
};

export const PROP_ASSETS: Record<string, number> = Object.fromEntries(
  Object.entries(PROP_COUNTS).filter(([name]) => name !== "seed"),
);

export type PropGroundQuery = (
  placement: IPlacement,
  position: [number, number, number],
) => { height: number | null; offset: number };
export interface IPropInstance {
  material: Material;
  onTransform?: (transform: IPlacementOverride | undefined) => void;
  placement: IPlacement;
  pose: Matrix4;
  geometry: BufferGeometry;
  grounding: boolean;
  clearance: number | null;
  cragBaseClearance?: number;
  cragRingSamples?: number;
}
/** Exact lowest world Y of a static geometry under `matrix`: core `staticLowestY`. */
export const lowestY = staticLowestY;

/**
 * The quaternion a placement's own scatter numbers describe: the normal tilt, then the yaw.
 *
 * The bake writes it into the record, and the load path hands it back to `preparePose` as the pose
 * override, so one rule composes the rotation and the record carries the result.
 */
export function authoredQuaternion(
  placement: IPlacement,
): readonly [number, number, number, number] {
  const up = new Vector3(0, 1, 0);
  const quaternion = new Quaternion();
  if (placement.alignToNormal)
    quaternion.setFromUnitVectors(up, new Vector3().fromArray(placement.normal));
  quaternion.multiply(new Quaternion().setFromAxisAngle(up, placement.rotation));
  return quaternion.toArray();
}

/**
 * A placement as a package record stores it: the authored pose becomes its transform, at one scale.
 *
 * A record holds position, quaternion and one uniform scale, so an edited placement's own transform
 * is folded down to the scale its record carries. The shape that scale removed is `propKey`'s ratio,
 * and the drawable model that ratio names carries it instead.
 */
export function withAuthoredPose(placement: IPlacement): IPlacement {
  const scale = placement.transform?.scale ?? [placement.scale, placement.scale, placement.scale];
  const scalar = scale[0] === 0 ? 1 : scale[0];
  return {
    ...placement,
    transform: {
      grounding: placement.transform?.grounding ?? true,
      position: placement.transform?.position ?? placement.position,
      quaternion: (placement.transform?.quaternion ?? authoredQuaternion(placement)) as [
        number,
        number,
        number,
        number,
      ],
      scale: [scalar, scalar, scalar],
    },
  };
}

/**
 * The model a record draws: its asset, its variant, and the shape a non-uniform edit gave it.
 *
 * `WorldCells` names the model through the run the record sits in, so this key is what the container
 * stores. A placement with one uniform scale draws its variant as authored (`spruce:2`); a placement
 * the editor scaled unevenly draws a model of that shape (`spruce:2@1,0.5,0.5`), so the record stays
 * one uniform scale and the picture keeps the edit.
 */
export function propKey(placement: IPlacement): string {
  const variant = `${placement.asset}:${variantFor(placement, placement.asset)}`;
  const scale = placement.transform?.scale ?? [placement.scale, placement.scale, placement.scale];
  const scalar = scale[0] === 0 ? 1 : scale[0];
  const ratio = scale.map((value) => value / scalar);
  const off = ratio.reduce((sum, value) => sum + (value - 1) ** 2, 0);
  return off < 1e-16 ? variant : `${variant}@${ratio.join(",")}`;
}

/** The shape `propKey` wrote, so the loader scales the model the record's one scale cannot carry. */
export function propRatio(key: string): [number, number, number] {
  const at = key.indexOf("@");
  if (at < 0) return [1, 1, 1];
  const ratio = key
    .slice(at + 1)
    .split(",")
    .map(Number);
  // A negative component is a mirror, which the renderer composes like any other shape.
  if (ratio.length !== 3 || ratio.some((value) => !Number.isFinite(value) || value === 0))
    throw new Error(`Prop key '${key}' does not name a usable shape.`);
  return [ratio[0] as number, ratio[1] as number, ratio[2] as number];
}

/**
 * The pose a baked package record carries: the quaternion the bake authored for the placement.
 *
 * A world-v1 record holds position, quaternion and scale, and nothing about `alignToNormal` or the
 * scatter yaw, so the load path hands the record's quaternion here. It replaces the rotation the
 * placement would compose, and every step below it — the ground snap, the boulder burial, the
 * four-footprint sink and the mountain base ring — still runs, because the record is a pose and not
 * an override of the pose.
 */
export interface IPropPoseOverride {
  readonly quaternion: readonly [number, number, number, number];
}

export function preparePose(
  geometry: BufferGeometry,
  _material: Material,
  placement: IPlacement,
  transform: IPlacementOverride | undefined,
  groundAt: PropGroundQuery,
  pose?: IPropPoseOverride,
) {
  // Plain math, not a Mesh: on the owned engine every Object3D is an engine object, and a detached
  // Mesh per placement cost 30 s of the forest's load (218,816 placements, 0.14 ms each).
  const model = {
    position: new Vector3(),
    quaternion: new Quaternion(),
    scale: new Vector3(1, 1, 1),
    matrix: new Matrix4(),
    updateMatrix() {
      this.matrix.compose(this.position, this.quaternion, this.scale);
    },
  };
  model.position.fromArray(transform?.position ?? placement.position);
  if (transform) {
    model.quaternion.fromArray(transform.quaternion);
    model.scale.fromArray(transform.scale);
  } else {
    model.quaternion.fromArray(pose?.quaternion ?? authoredQuaternion(placement));
    model.scale.setScalar(placement.scale);
  }
  const grounding = transform?.grounding ?? true;
  const ground = groundAt(placement, model.position.toArray());
  // GroundSnap's rule: the lowest posed point meets the surface, then the authored offset applies.
  let clearance: number | null = null;
  if (ground.height === null) {
    if (grounding)
      throw new Error(
        `Missing terrain ground for '${placement.id}' at ${JSON.stringify(model.position.toArray())}`,
      );
  } else {
    model.updateMatrix();
    clearance = lowestY(geometry, model.matrix) - ground.height;
    if (grounding) {
      model.position.y += ground.offset - clearance;
      clearance = ground.offset;
    }
  }
  // A boulder is a rock that is part buried: GroundSnap puts its lowest point on the surface, and on a
  // slope the downhill side then hangs in the air. Sinking it by a share of its own height closes that.
  if (
    grounding &&
    !transform &&
    ["boulder", "riverrock", "pebble", "scree", "cliff", "mountain", "volcanic", "reveal"].includes(
      placement.asset,
    ) &&
    ground.height !== null
  ) {
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    if (box) {
      model.updateMatrix();
      const crag = ["mountain", "volcanic", "reveal"].includes(placement.asset);
      const height = crag
        ? box.clone().applyMatrix4(model.matrix).getSize(new Vector3()).y
        : (box.max.y - box.min.y) * model.scale.y;
      model.position.y -=
        (placement.id.endsWith(":outcrop")
          ? 0.35
          : placement.asset === "mountain"
            ? 0.82
            : crag
              ? 0.55
              : BOULDER_BURIAL) * height;
    }
  }
  // Bury the flat footprint on the downhill side too; a centre-only snap leaves a visible lip.
  if (grounding && !transform && ["boulder", "riverrock", "scree"].includes(placement.asset)) {
    model.updateMatrix();
    let gap: number;
    try {
      gap = footprintGap(
        geometry,
        model.matrix,
        (x, z) => groundAt(placement, [x, 0, z]).height,
        0.08,
      );
    } catch (error) {
      throw new Error(`Missing ground under rock '${placement.id}'`, { cause: error });
    }
    model.position.y -= gap;
  }
  let cragBaseClearance: number | undefined;
  let cragRingSamples: number | undefined;
  if (
    grounding &&
    !transform &&
    placement.asset === "mountain" &&
    !placement.id.endsWith(":outcrop")
  ) {
    // Lowest rim vertex per angular sector: a narrow buried stem must not support a wide scan
    // collar hanging above the downhill ground.
    if (!geometry.boundingBox) throw new Error(`Crag '${placement.id}' has no bounds`);
    model.updateMatrix();
    let ring: IBaseRing;
    try {
      ring = baseRingGap(geometry, model.matrix, (x, z) => groundAt(placement, [x, 0, z]).height);
    } catch (error) {
      throw new Error(`Missing ground under crag ring '${placement.id}'`, { cause: error });
    }
    const highestGap = ring.gap;
    cragRingSamples = ring.samples;
    if (cragRingSamples < 4) throw new Error(`Incomplete base ring for crag '${placement.id}'`);
    const sink = Math.max(0, highestGap + 0.5);
    model.position.y -= sink;
    cragBaseClearance = highestGap - sink;
  }
  model.updateMatrix();
  if (!new Float32Array(model.matrix.elements).every(Number.isFinite))
    throw new Error(`Transform exceeds the renderer range for '${placement.id}'`);
  return {
    matrix: model.matrix.clone(),
    grounding,
    clearance,
    cragBaseClearance,
    cragRingSamples,
  };
}
export function preparePropTransform(
  instance: IPropInstance,
  transform: IPlacementOverride | undefined,
  groundAt: PropGroundQuery,
) {
  return {
    ...preparePose(instance.geometry, instance.material, instance.placement, transform, groundAt),
    transform,
  };
}
export function writePropTransform(
  instance: IPropInstance,
  prepared: ReturnType<typeof preparePropTransform>,
): void {
  const changed =
    !instance.pose.equals(prepared.matrix) || instance.grounding !== prepared.grounding;
  instance.pose.copy(prepared.matrix);
  instance.grounding = prepared.grounding;
  instance.clearance = prepared.clearance;
  instance.cragBaseClearance = prepared.cragBaseClearance;
  instance.cragRingSamples = prepared.cragRingSamples;
  if (changed) instance.onTransform?.(prepared.transform);
}
export function readPropTransform(instance: IPropInstance): IPlacementOverride {
  const matrix = instance.pose;
  const position = new Vector3();
  const quaternion = new Quaternion();
  const scale = new Vector3();
  matrix.decompose(position, quaternion, scale);
  return {
    position: position.toArray(),
    quaternion: quaternion.normalize().toArray(),
    scale: scale.toArray(),
    grounding: instance.grounding,
  };
}

/**
 * Assign every placement a variant, deterministically from its own id.
 *
 * The id rather than the array order, so re-baking the terrain and getting the same candidates back
 * gives the same trees in the same places, and the editor's saved override for one placement still
 * describes the same shape it did last time.
 */
export function variantFor(placement: IPlacement, asset: string): number {
  const count = PROP_ASSETS[asset];
  if (count === undefined) throw new Error(`Unregistered prop asset '${asset}'`);
  if (asset === "mountain" && placement.id.endsWith(":outcrop")) return 0;
  let hash = 0x811c9dc5;
  for (let i = 0; i < placement.id.length; i += 1) {
    hash ^= placement.id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Full trees dominate; the half-crown forms are occasional stand variation, and the mix leans on
  // the two Kite pines evenly — pack.ts reads the variant through `variant % 2`.
  return asset === "spruce" ? ([0, 1, 0, 1, 2, 0, 1, 0, 1, 3, 4][hash % 11] ?? 0) : hash % count;
}

export interface IPropMaterials {
  readonly bark: Material;
  readonly crown: Material;
  /** Bracken under the spruces, cut against Poly Haven's fern frond atlas. */
  readonly fern: Material;
  readonly grass: Material;
  /** The far cross-card: the whole tree past the last band, one card and eight triangles. */
  readonly impostor: Material;
  /** The prepared CC0 fir's own cutout, sampled against Poly Haven's twig atlas. */
  readonly needles: Material;
  readonly petal: Material;
  /** The prepared pine's own cutout, sampled against its own leaf atlas. */
  readonly pine: Material;
  readonly stem: Material;
  readonly stone: Material;
}

/**
 * A flat stand-in surface per role, drawn until the real ones arrive.
 *
 * The meshes exist on the first frame because `enter` is synchronous and the maps are not, and a
 * missing material has to mean "plain spruce" rather than "no forest". Vertex colours are on, so
 * grass and stems already read correctly from their own gradient.
 */
export function flatPropMaterials(): IPropMaterials & { dispose: () => void } {
  const materials: IPropMaterials = {
    bark: new MeshStandardMaterial({ color: 0x4a3428, roughness: 0.95 }),
    crown: new MeshStandardMaterial({ color: 0x2c4a2a, roughness: 0.9, side: DoubleSide }),
    fern: new MeshStandardMaterial({ color: 0x2f4d22, roughness: 0.9, side: DoubleSide }),
    grass: new MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.93,
      side: DoubleSide,
      vertexColors: true,
    }),
    // The far card and the pine's crown are the same green: one is a picture of the other, so a
    // tree that steps down a band does not change colour on the way.
    impostor: new MeshStandardMaterial({ color: 0x24401f, roughness: 0.94, side: DoubleSide }),
    needles: new MeshStandardMaterial({ color: 0x24401f, roughness: 0.94, side: DoubleSide }),
    petal: new MeshStandardMaterial({ color: 0xb8181a, roughness: 0.75, side: DoubleSide }),
    pine: new MeshStandardMaterial({ color: 0x24401f, roughness: 0.94, side: DoubleSide }),
    stem: new MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.9,
      side: DoubleSide,
      vertexColors: true,
    }),
    stone: new MeshStandardMaterial({ color: 0x6e6f62, roughness: 0.93 }),
  };
  return {
    ...materials,
    dispose: () => {
      for (const material of Object.values(materials)) material.dispose();
    },
  };
}
