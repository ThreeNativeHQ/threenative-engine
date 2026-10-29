// The starter props of the Temperate world: three seeded spruce variants, three boulders, grass
// clumps and poppy patches. `propStreaming.ts` hands their draws to `WorldCells`.
//
// What lives here and what does not:
//
//   - The shapes, their variants, their materials and their placement rule are all this file's. They
//     are the picture, and the picture is the game's (AGENTS rule 3).
//   - GroundSnap measures ground contact; propStreaming.ts delegates instancing and LOD to WorldCells.
import { GroundSnap, createRandom } from "@threenative/core";
import type { IPlacement, IPlacementOverride } from "@threenative/terrain";
import {
  type BufferGeometry,
  DoubleSide,
  Euler,
  Group,
  type Material,
  type Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from "three";
import { boulder, fernClump, grassClump, poppyCluster } from "./cover.js";
import { ATLAS_CELLS, spruceFarCrown, spruceVariants } from "./spruce.js";

/** Which cell of the needle atlas the poppy petals sample. */
const POPPY_PETAL = { u0: 0.5, v0: 0, u1: 1, v1: 0.5 };

/** How many variants of each prop the starter builds, and the seed they are built from. */
export const VARIANTS = {
  boulder: 3,
  bush: 2,
  fern: 3,
  grass: 4,
  poppy: 4,
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
  scrub: 110,
  fern: 105,
  poppy: 65,
  sapling: 160,
  bush: 120,
  litter: 16,
  boulder: 170,
  riverrock: 100,
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
export const NO_SHADOW_ASSETS = new Set(["sapling", "scrub", "grass", "fern", "poppy", "litter"]);
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
export const LOD_BANDS = { far: 150, hysteresis: 0.2, mid: 60, near: 22 } as const;

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
  for (let i = 0; i < VARIANTS.grass; i += 1) {
    const ready = prepared?.get(`grass:${i}`);
    // Imported grass draws as imported: a darkened procedural clump under each photographed tuft
    // read as a black star at every root.
    variants.set(
      `grass:${i}`,
      ready ?? [
        {
          geometry: grassClump((VARIANTS.seed ^ (i * 0xc2b2ae35)) >>> 0, i),
          role: "grass",
          variant: i,
        },
      ],
    );
  }
  for (let i = 0; i < VARIANTS.poppy; i += 1) {
    const ready = prepared?.get(`poppy:${i}`);
    if (ready) {
      variants.set(`poppy:${i}`, [...ready]);
      continue;
    }
    const cluster = poppyCluster((VARIANTS.seed ^ (i * 0x27d4eb2f)) >>> 0, POPPY_PETAL);
    variants.set(`poppy:${i}`, [
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
  for (const asset of ["riverrock", "scree", "cliff", "mountain", "volcanic", "reveal"])
    for (
      let variant = 0;
      variant < (asset === "mountain" || asset === "reveal" ? 2 : asset === "volcanic" ? 4 : 1);
      variant++
    ) {
      const ready = prepared?.get(`${asset}:${variant}`);
      if (ready) {
        variants.set(`${asset}:${variant}`, ready);
        continue;
      }
      const fallback = boulder(VARIANTS.seed ^ variant);
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
  scree: 1,
  cliff: 1,
  mountain: 2,
  volcanic: 4,
  reveal: 2,
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
export function preparePose(
  geometry: BufferGeometry,
  material: Material,
  placement: IPlacement,
  transform: IPlacementOverride | undefined,
  groundAt: PropGroundQuery,
) {
  // This measurement mesh is never added to the scene; the actual draw stays instanced.
  const model = new Mesh(geometry, material);
  model.position.fromArray(transform?.position ?? placement.position);
  if (transform) {
    model.quaternion.fromArray(transform.quaternion);
    model.scale.fromArray(transform.scale);
  } else {
    const up = new Vector3(0, 1, 0);
    if (placement.alignToNormal)
      model.quaternion.setFromUnitVectors(up, new Vector3().fromArray(placement.normal));
    model.quaternion.multiply(new Quaternion().setFromAxisAngle(up, placement.rotation));
    model.scale.setScalar(placement.scale);
  }
  const grounding = transform?.grounding ?? true;
  const ground = groundAt(placement, model.position.toArray());
  const snap = new GroundSnap(model, { enabled: grounding });
  if (ground.height === null) {
    if (grounding)
      throw new Error(
        `Missing terrain ground for '${placement.id}' at ${JSON.stringify(model.position.toArray())}`,
      );
  } else {
    snap.apply(model, ground.height, 0);
    if (grounding && ground.offset !== 0) {
      model.position.y += ground.offset;
      snap.enabled = false;
      snap.apply(model, ground.height, 0);
    }
  }
  // A boulder is a rock that is part buried: GroundSnap puts its lowest point on the surface, and on a
  // slope the downhill side then hangs in the air. Sinking it by a share of its own height closes that.
  if (
    grounding &&
    !transform &&
    ["boulder", "riverrock", "scree", "cliff", "mountain", "volcanic", "reveal"].includes(
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
    const base = geometry.boundingBox?.min.y;
    const positions = geometry.getAttribute("position");
    const point = new Vector3();
    let gap = 0;
    model.updateMatrix();
    for (let i = 0; i < positions.count; i++) {
      if (Math.abs(positions.getY(i) - (base ?? Number.POSITIVE_INFINITY)) > 1e-5) continue;
      point.fromBufferAttribute(positions, i).applyMatrix4(model.matrix);
      const height = groundAt(placement, point.toArray()).height;
      if (height === null) throw new Error(`Missing ground under rock '${placement.id}'`);
      gap = Math.max(gap, point.y - height + 0.08);
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
    // Lowest peripheral vertex per angular sector: a narrow buried stem must not support
    // a wide scan collar hanging above the downhill ground.
    const box = geometry.boundingBox;
    if (!box) throw new Error(`Crag '${placement.id}' has no bounds`);
    model.updateMatrix();
    const centre = box.getCenter(new Vector3()).applyMatrix4(model.matrix);
    const sectors = Array.from({ length: 16 }, () => ({ reach: 0, vertices: [] as Vector3[] }));
    const vertices = geometry.getAttribute("position");
    for (let i = 0; i < vertices.count; i++) {
      const point = new Vector3().fromBufferAttribute(vertices, i).applyMatrix4(model.matrix);
      const dx = point.x - centre.x;
      const dz = point.z - centre.z;
      const bin = Math.min(15, Math.floor(((Math.atan2(dz, dx) + Math.PI) / (2 * Math.PI)) * 16));
      const sector = sectors[bin];
      if (!sector) continue;
      sector.reach = Math.max(sector.reach, Math.hypot(dx, dz));
      sector.vertices.push(point);
    }
    let highestGap = Number.NEGATIVE_INFINITY;
    cragRingSamples = 0;
    for (const sector of sectors) {
      let lowest: Vector3 | undefined;
      for (const point of sector.vertices)
        if (
          Math.hypot(point.x - centre.x, point.z - centre.z) >= sector.reach * 0.75 &&
          (!lowest || point.y < lowest.y)
        )
          lowest = point;
      if (!lowest) continue;
      const contact = groundAt(placement, lowest.toArray()).height;
      if (contact === null) throw new Error(`Missing ground under crag ring '${placement.id}'`);
      highestGap = Math.max(highestGap, lowest.y - contact);
      cragRingSamples++;
    }
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
    clearance: snap.clearance,
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
