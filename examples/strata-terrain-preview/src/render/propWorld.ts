// The game's prop worlds: the containers the bake wrote, posed on the ground and handed to WorldCells.
//
// What lives here and what does not:
//
//   - The bake compiles the placements (`@threenative/terrain`'s `compilePropBuckets`): which streamed
//     world each record draws in, its cell, and its position, authored quaternion and scale. The game
//     loads those files; it holds no compiler.
//   - The editor and the scripts hold their placements live, so they pass them here and the package
//     compiles them. One call, one implementation, one layout.
//   - The pose stays the game's: `preparePose` grounds every record on the foot geometry the machine
//     loaded, with the record's quaternion as its pose override, so the boulder burial, the flat
//     footprint sink and the mountain base ring run exactly as they did before the bake owned the
//     container.
//   - Everything below the pose is `WorldCells`' own: admission, residency, LOD and shadows.
import { type IAssetLoader, addInSlices, createAssetLoader } from "@threenative/core";
import {
  type IShadowRegion,
  type IWorldAsset,
  type IWorldCellsFollow,
  type IWorldPackage,
  WorldCells,
} from "@threenative/core/world";
import {
  type IPlacement,
  type IPropBucketEntry,
  type IPropBucketPackage,
  type IPropPackage,
  PROP_CELL_SIZE,
  compilePropBuckets,
  decodePropBucket,
  propAssetOf,
} from "@threenative/terrain";
import {
  Box3,
  type Camera,
  Group,
  InstancedMesh,
  type Material,
  Mesh,
  Quaternion,
  Vector3,
} from "three";
import { fetchBakedFile } from "./bakedFile.js";
import { FAR_FOREST_IMPOSTOR, FAR_FOREST_LAYER } from "./farForest.js";
import { standShaded } from "./propMaterials.js";
import type { IPropPreparationProgress } from "./propProgress.js";
import {
  type IPropInstance,
  type IPropMaterials,
  type IPropPart,
  LOD_BANDS,
  PROP_ASSETS,
  type PropGroundQuery,
  impostorDistanceForScale,
  lodSteps,
  preparePose,
  propKey,
  propRatio,
  spruceGateScales,
  streamedBucket,
  streamedReach,
  variantFor,
  withAuthoredPose,
} from "./props.js";

export interface IPropWorldOptions {
  /** The baked package, one streamed world per bucket. May be empty when every placement is live. */
  readonly package?: IPropPackage;
  /**
   * Placements the caller holds live, compiled here through `@threenative/terrain`.
   *
   * The game plants none: its records come from the bake. The editor compiles the placements it is
   * editing, and a script that proves one pose compiles the one it built.
   */
  readonly placements?: readonly IPlacement[];
  /** Which baked buckets this run keeps; the query flags answer it. Every bucket by default. */
  readonly buckets?: (bucket: IPropBucketPackage) => boolean;
  readonly groundAt: PropGroundQuery;
  readonly parts: Map<string, IPropPart[]>;
  readonly materials: IPropMaterials;
  readonly follow: IWorldCellsFollow;
  /** The world square the bake packaged; live placements use its bounds too. */
  readonly size: number;
  readonly horizonDistance?: number;
  readonly castShadows?: boolean;
  /** The biome row's `standShade`: the tint a spruce takes where no sun shadow is drawn on it. */
  readonly standShade?: readonly [number, number, number];
  /** The sun's outer shadow window, metres; a local spruce takes `standShade` past it. */
  readonly shadowReach?: number;
  readonly bundles?: boolean;
  readonly assets?: IAssetLoader;
  readonly whileCurrent: () => boolean;
  readonly invalidateShadows?: (region?: IShadowRegion) => void;
  readonly onProgress?: (progress: IPropPreparationProgress) => void;
  readonly onPublication?: (bounds: Box3) => void;
}

// One shaded copy per source material and bucket kind: every tree of a variant shares its crown.
const standMaterials = {
  far: new WeakMap<Material, Material>(),
  local: new WeakMap<Material, Material>(),
};
function standMaterial(
  source: Material,
  shade: readonly [number, number, number],
  shadowReach?: number,
): Material {
  const copies = standMaterials[shadowReach === undefined ? "far" : "local"];
  let shaded = copies.get(source);
  if (!shaded) {
    shaded = standShaded(source, shade, shadowReach);
    copies.set(source, shaded);
  }
  return shaded;
}

/** Keep WorldCells' changed caster bounds when forwarding to the existing shadow renderer. */
export function invalidatePropShadows(
  shadow: { invalidateRegion(region: IShadowRegion): void; invalidateAll(): void },
  region?: IShadowRegion,
): void {
  if (region === undefined) shadow.invalidateAll();
  else shadow.invalidateRegion(region);
}

/** One placement as its container stores it: the record's numbers and the world it draws in. */
interface IRecord {
  /** The model the record's run names: `asset:variant`, with the shape a non-uniform edit gave it. */
  readonly key: string;
  readonly placement: IPlacement;
  /** The quaternion the bake authored; `preparePose` takes it as the pose override. */
  readonly quaternion: readonly [number, number, number, number];
  readonly reach: number;
}

/** One grounded placement: the pose the game draws, and the variant its asset resolved to. */
interface IGroundedRecord {
  readonly key: string;
  readonly placement: IPlacement;
  readonly pose: ReturnType<typeof preparePose>;
  readonly reach: number;
  readonly ratio: Vector3;
  readonly position: Vector3;
  readonly quaternion: Quaternion;
  readonly scale: number;
}

/** One world's baked props: the containers it streams, the canopy it shades and the counts it reports. */
export interface IScatter {
  readonly package: IPropPackage;
  readonly canopy: Float32Array;
  readonly counts: Readonly<Record<string, number>>;
}

/** Records per asset across the package's buckets: what the run report calls the scatter's counts. */
export function propCounts(pkg: IPropPackage): Record<string, number> {
  // Every asset the starter knows starts at 0. A world that places none of one still reports its
  // count, because the run report reads a fixed key per asset and an absent key is `undefined`,
  // which the playtest bridge refuses as an observation that is not JSON-safe.
  const counts: Record<string, number> = {};
  for (const asset of Object.keys(PROP_ASSETS)) counts[asset] = 0;
  for (const bucket of pkg.buckets)
    for (const cell of bucket.cells)
      for (const run of cell.runs) {
        const asset = propAssetOf(run.asset);
        counts[asset] = (counts[asset] ?? 0) + run.count;
      }
  return counts;
}

/** One bucket as the bake's manifest describes it: where its files are and what they hold. */
interface IPropBucketManifest {
  readonly bucket: string;
  readonly kind: IPropBucketPackage["kind"];
  readonly extent: IPropBucketPackage["extent"];
  readonly cells: IPropBucketPackage["cells"];
  readonly placements: string;
  readonly reach: string;
  readonly ids: string;
}

/**
 * The baked prop package of one world, fetched as the bake wrote it.
 *
 * The files are the bake's output, not the game's: the manifest names one container, one reach array
 * and one placement-ID list per streamed world, and nothing here derives a placement.
 */
export async function loadPropPackage(
  assets: Pick<IAssetLoader, "resolve">,
  world: string,
): Promise<IPropPackage> {
  const listing = (await (
    await fetchBakedFile(assets, `world/${world}.props.json`, "prop package")
  ).json()) as { version: 1; cellSize: number; buckets: IPropBucketManifest[] };
  if (listing.version !== 1)
    throw new Error(`Unsupported prop package: ${String(listing.version)}`);
  return {
    cellSize: listing.cellSize,
    buckets: await Promise.all(
      listing.buckets.map(async (bucket) => {
        const [records, reach, ids] = await Promise.all([
          fetchBakedFile(assets, `world/${bucket.placements}`, "prop records"),
          fetchBakedFile(assets, `world/${bucket.reach}`, "prop reach"),
          fetchBakedFile(assets, `world/${bucket.ids}`, "prop placement IDs"),
        ]);
        return {
          bucket: bucket.bucket,
          cells: bucket.cells,
          extent: bucket.extent,
          ids: (await ids.json()) as string[],
          kind: bucket.kind,
          placements: new Uint8Array(await records.arrayBuffer()),
          reach: new Float32Array(await reach.arrayBuffer()),
        };
      }),
    ),
  };
}

/** The canopy weight the ground shader reads, painted from the placements the bake drew. */
export async function loadCanopy(
  assets: Pick<IAssetLoader, "resolve">,
  world: string,
): Promise<Float32Array> {
  const response = await fetchBakedFile(assets, `world/${world}.canopy.bin`, "canopy map");
  return new Float32Array(await response.arrayBuffer());
}

/** The share of the sky each terrain vertex sees past the relief, as `skyVisibility` baked it. */
export async function loadSky(
  assets: Pick<IAssetLoader, "resolve">,
  world: string,
): Promise<Float32Array> {
  const response = await fetchBakedFile(assets, `world/${world}.sky.bin`, "sky visibility map");
  return Float32Array.from(new Uint8Array(await response.arrayBuffer()), (byte) => byte / 255);
}

/** The bucket's records as placements: the bake's own decode, with the record's model and pose. */
function recordsOf(bucket: IPropBucketPackage): IRecord[] {
  return decodePropBucket(bucket).map((record) => ({
    key: record.key,
    // A run names the model it draws: the asset, the variant, and the shape when one scale cannot
    // carry the placement. The asset alone is what `preparePose` grounds.
    placement: {
      alignToNormal: false,
      asset: record.asset,
      id: record.id,
      layer: `temperate-${record.asset}`,
      normal: [0, 1, 0],
      position: [...record.position],
      rotation: 0,
      scale: record.scale,
    },
    quaternion: record.quaternion,
    reach: record.reach,
  }));
}

/** The variant counters the bake left: a live placement's fade continues the stream it joined. */
function variantSeeds(records: readonly IRecord[]): Map<string, number> {
  const seeds = new Map<string, number>();
  for (const record of records) {
    const variant = `${record.placement.asset}:${variantFor(record.placement, record.placement.asset)}`;
    seeds.set(variant, (seeds.get(variant) ?? 0) + 1);
  }
  return seeds;
}

/** The streamed world a live placement joins, and how far it draws. */
function liveEntries(
  placements: readonly IPlacement[],
  seeds: Map<string, number>,
): IPropBucketEntry[] {
  const indices = new Map(seeds);
  return placements.map((placement) => {
    const variant = `${placement.asset}:${variantFor(placement, placement.asset)}`;
    const index = indices.get(variant) ?? 0;
    indices.set(variant, index + 1);
    const reach = streamedReach(placement, index);
    return {
      bucket: streamedBucket(placement, reach),
      key: propKey(placement),
      kind: placement.layer === FAR_FOREST_LAYER ? "far" : "local",
      placement,
      reach,
    };
  });
}

/** The camera-independent stats the run report reads, summed over every streamed world. */
function statsOf(worlds: readonly WorldCells[]) {
  return worlds.reduce(
    (sum, world) => {
      const s = world.stats();
      return {
        residentCells: sum.residentCells + s.residentCells,
        loadedCells: sum.loadedCells + s.loadedCells,
        instances: sum.instances + s.instances,
        evictions: sum.evictions + s.evictions,
        failures: sum.failures + s.failures,
        loadsInFlight: sum.loadsInFlight + s.loadsInFlight,
        loadsQueued: sum.loadsQueued + s.loadsQueued,
        pendingPrewarm: sum.pendingPrewarm + s.pendingPrewarm,
        impostor: {
          pending: sum.impostor.pending + s.impostor.pending,
          drawn: sum.impostor.drawn + s.impostor.drawn,
        },
        admissionMs: sum.admissionMs + s.admission.spentMs,
        admissionBacklog: sum.admissionBacklog + s.admission.backlog,
        admissionDeferred: sum.admissionDeferred + s.admission.deferred,
      };
    },
    {
      residentCells: 0,
      loadedCells: 0,
      instances: 0,
      evictions: 0,
      failures: 0,
      loadsInFlight: 0,
      loadsQueued: 0,
      pendingPrewarm: 0,
      impostor: { pending: 0, drawn: 0 },
      admissionMs: 0,
      admissionBacklog: 0,
      admissionDeferred: 0,
    },
  );
}

/** The placement IDs the bake wrote: the load plants only the ground the bake left out. */
function bakedIds(plans: readonly IPropBucketPackage[]): Set<string> {
  const ids = new Set<string>();
  for (const plan of plans) for (const id of plan.ids) ids.add(id);
  return ids;
}

/**
 * Load the prop worlds, pose every record on the ground, and hand each bucket to `WorldCells`.
 *
 * The passes are short and yield between slices, because the whole point of streaming is that the
 * first frame does not wait for 200 000 records: the records are decoded and grounded in slices, and
 * each bucket loads as its own world.
 */
export async function streamProps(options: IPropWorldOptions) {
  if (!options.whileCurrent()) return undefined;
  let compileSlices = 0;
  const worlds: WorldCells[] = [];
  const warmed = new Set<WorldCells>();
  let phase: IPropPreparationProgress["phase"] = "grounding";
  let currentBucket = "";
  function progress(added: number, total: number): void {
    options.onProgress?.({
      bucket: currentBucket,
      phase,
      added,
      total,
      worlds,
      get prewarmedWorlds() {
        return warmed.size;
      },
    });
  }
  function startPhase(next: IPropPreparationProgress["phase"], bucket = "", total = 0): void {
    phase = next;
    currentBucket = bucket;
    progress(0, total);
  }
  async function compile<T>(items: Iterable<T>, visit: (item: T) => void): Promise<boolean> {
    const report = await addInSlices(items, visit, {
      while: options.whileCurrent,
      onProgress: ({ added, total }) => progress(added, total),
    });
    compileSlices += report.slices;
    // Separate short dependent passes too: their combined work must not become one host task.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    return !report.stopped && options.whileCurrent();
  }
  // The containers the run streams: the baked buckets it keeps, then the caller's live placements
  // compiled through the package. A live placement the bake already wrote is dropped, so a bake
  // that gains the far field needs no change here. The bake wins on a placement, not on a
  // container: the meadow a view plants off the square streams beside the bake's own `local:false`
  // container, which holds the square's scatter and nothing of that meadow.
  const plans = [...(options.package?.buckets ?? [])].filter(
    (bucket: IPropBucketPackage) => options.buckets?.(bucket) ?? true,
  );
  const decoded = plans.map(recordsOf);
  let live: Array<{ plan: IPropBucketPackage; records: IRecord[] }> = [];
  const placements = options.placements ?? [];
  if (placements.length > 0) {
    const baked = bakedIds(plans);
    const seeds = variantSeeds(decoded.flat());
    const entries = liveEntries(
      placements.filter((placement) => !baked.has(placement.id)),
      seeds,
    );
    const compiled = compilePropBuckets(
      entries.map((entry) => ({ ...entry, placement: withAuthoredPose(entry.placement) })),
      {
        cellSize: options.package?.cellSize ?? PROP_CELL_SIZE,
        bounds: {
          minX: -options.size / 2,
          minZ: -options.size / 2,
          sizeX: options.size,
          sizeZ: options.size,
        },
      },
    );
    // The container's records carry one uniform scale, so the source placement is what the pose
    // reads: an edited placement draws the shape its own transform names.
    const source = new Map(entries.map((entry) => [entry.placement.id, entry.placement]));
    live = compiled.buckets.map((plan) => ({
      plan,
      records: recordsOf(plan).map((record) => ({
        ...record,
        placement: source.get(record.placement.id) ?? record.placement,
      })),
    }));
  }
  const buckets = [
    ...plans.map((plan, index) => ({ plan, records: decoded[index] as IRecord[] })),
    ...live,
  ];
  const total = buckets.reduce((sum, bucket) => sum + bucket.records.length, 0);

  const grouped = new Map<IPropBucketPackage, IGroundedRecord[]>(
    buckets.map((bucket) => [bucket.plan, []]),
  );
  const byId = new Map<string, IPropInstance>();
  const shapes = new Map<string, { parts: IPropPart[]; ratio: Vector3 }>();
  startPhase("grounding", "", total);
  const report = await addInSlices(
    buckets.flatMap((bucket) => bucket.records.map((record) => ({ bucket: bucket.plan, record }))),
    ({ bucket, record }) => {
      const variant = `${record.placement.asset}:${variantFor(record.placement, record.placement.asset)}`;
      const chosen = options.parts.get(variant);
      const foot =
        chosen?.find((part) => part.role === "bark" || part.role === "stone") ?? chosen?.[0];
      if (!chosen || !foot) throw new Error(`Prop asset '${variant}' has no parts`);
      // A record's own pose is the authored one, which the bake stored; a live placement the editor
      // edited carries its transform, and the pose steps that burial owns run on the authored one.
      const pose = preparePose(
        foot.geometry,
        options.materials[foot.role],
        record.placement,
        record.placement.transform,
        options.groundAt,
        { quaternion: record.quaternion },
      );
      const position = new Vector3();
      const quaternion = new Quaternion();
      const scale = new Vector3();
      pose.matrix.decompose(position, quaternion, scale);
      const scalar = scale.x === 0 ? 1 : scale.x;
      // The container names one model per shape; the variant's own parts are what draw it.
      const ratio = new Vector3().fromArray(propRatio(record.key));
      shapes.set(record.key, { parts: chosen, ratio });
      const key = record.key;
      const list = grouped.get(bucket);
      if (!list) throw new Error(`Prop bucket '${bucket.bucket}' was not planned`);
      list.push({
        key,
        placement: record.placement,
        pose,
        reach: record.reach,
        ratio,
        position,
        quaternion,
        scale: scalar,
      });
      byId.set(record.placement.id, {
        ...pose,
        pose: pose.matrix,
        placement: record.placement,
        geometry: foot.geometry,
        material: foot.material ?? options.materials[foot.role],
      });
    },
    {
      while: options.whileCurrent,
      onProgress: ({ added, total: count }) => progress(added, count),
    },
  );
  if (report.stopped || !options.whileCurrent()) return undefined;
  const minSpruceScaleByVariant = spruceGateScales([...grouped.values()].flat());

  const cellSize = options.package?.cellSize ?? PROP_CELL_SIZE;
  const assets = options.assets ?? createAssetLoader();
  try {
    for (const [plan, list] of grouped) {
      if (!options.whileCurrent()) {
        for (const world of worlds) world.dispose();
        return undefined;
      }
      let minY = Number.POSITIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      let maxReach = 0;
      startPhase("models", plan.bucket, list.length);
      const definitions: Record<string, IWorldAsset> = {};
      const models = new Map<string, Group>();
      if (
        !(await compile(list, (record) => {
          minY = Math.min(minY, record.position.y);
          maxY = Math.max(maxY, record.position.y);
          maxReach = Math.max(maxReach, record.reach);
          if (definitions[record.key]) return;
          const shape = shapes.get(record.key);
          if (!shape) throw new Error(`Missing shape '${record.key}'`);
          const levels = [...new Set(shape.parts.map((part) => part.level ?? 0))].sort(
            (a, b) => a - b,
          );
          // A far spruce stands 55 m or more from any eye (`clear` around the vista): it draws its
          // coarsest cooked level until the impostor. Its full chain put 14 M triangles in the vista.
          const far = plan.bucket.startsWith("far:") && record.key.startsWith("spruce:");
          const lods = (far ? [] : levels.slice(1)).map((level, i) => ({
            glb: `${record.key}/${level}.glb`,
            distance: lodSteps(record.placement.asset)[i === 0 ? 0 : 1],
          }));
          const bounds = new Box3();
          for (const level of levels) {
            const group = new Group();
            for (const part of shape.parts.filter((part) => (part.level ?? 0) === level)) {
              const own = part.material ?? options.materials[part.role];
              const mesh = new Mesh(
                part.geometry,
                options.standShade && record.key.startsWith("spruce:")
                  ? standMaterial(
                      own,
                      options.standShade,
                      plan.bucket.startsWith("far:") ? undefined : options.shadowReach,
                    )
                  : own,
              );
              mesh.scale.copy(shape.ratio);
              group.add(mesh);
            }
            group.updateMatrixWorld(true);
            bounds.union(new Box3().setFromObject(group)); // engine-override: measure generated LOD bounds for the streamed manifest
            models.set(`${record.key}/${level}.glb`, group);
          }
          definitions[record.key] = {
            glb: `${record.key}/${far ? levels.at(-1) : 0}.glb`,
            ...(record.key.startsWith("spruce:")
              ? {
                  // The package rejects a terminal gate at or inside the last authored step.
                  impostorDistance: plan.bucket.startsWith("far:")
                    ? Math.max(
                        FAR_FOREST_IMPOSTOR,
                        (lods.at(-1)?.distance ?? 0) * (1 + Number.EPSILON),
                      )
                    : impostorDistanceForScale(
                        minSpruceScaleByVariant.get(
                          `${record.placement.asset}:${variantFor(record.placement, record.placement.asset)}`,
                        ) ?? record.scale,
                        lods.at(-1)?.distance ?? 0,
                      ),
                }
              : {}),
            bounds: { min: bounds.min.toArray(), max: bounds.max.toArray() },
            lods,
          };
        }))
      ) {
        for (const world of worlds) world.dispose();
        return undefined;
      }
      // The container holds the authored pose; the ground the props meet is this machine's, and the
      // look steps that sink a stone into a slope are `preparePose`'s. So the record the engine
      // draws is the grounded one, written in the container's own record order.
      const placements = new Float32Array(list.length * 8);
      for (const [index, record] of list.entries())
        placements.set(
          [...record.position.toArray(), ...record.quaternion.toArray(), record.scale],
          index * 8,
        );
      const manifest: IWorldPackage = {
        version: 1,
        extent: plan.extent,
        cellSize,
        assets: definitions,
        cells: [...plan.cells],
        placements: "placements.bin",
        terrain: {
          heightmap: "unused.u16",
          columns: plan.extent.sizeX / cellSize + 1,
          rows: plan.extent.sizeZ / cellSize + 1,
          spacing: cellSize,
          heightMin: minY,
          heightMax: maxY,
        },
      };
      const farInstances = list.reduce(
        (count, record) =>
          count + (definitions[record.key]?.impostorDistance === undefined ? 0 : 1),
        0,
      );
      // Two CPU-admitted levels need at most 16 bytes of published-range bounds per root.
      const rangeRoots = LOD_BANDS.hysteresis > 0 ? list.length : 0;
      const ring = Number.isFinite(maxReach)
        ? Math.ceil(maxReach / manifest.cellSize) + 1
        : Math.ceil(
            (options.horizonDistance ?? Math.hypot(plan.extent.sizeX, plan.extent.sizeZ)) /
              manifest.cellSize,
          ) + 1;
      startPhase("world-load", plan.bucket, list.length);
      const world = await WorldCells.load({
        url: "world.json",
        assets,
        surface: options.materials.bark,
        follow: options.follow,
        ring,
        // Models are already decoded; the reach ring includes a cell of admission headroom.
        // Predictive centring can otherwise evict visible placements after camera jumps.
        prefetchSeconds: 0,
        terrain: false,
        data: { manifest, placements: placements.buffer as ArrayBuffer },
        placementReach: plan.reach,
        gpuScene: false,
        bundles: options.bundles,
        onPublication: options.onPublication,
        // A whole-asset impostor is only authored for spruce. Other buckets retain their
        // authored scatter LODs without asking WorldCells to build a terminal atlas.
        impostors: farInstances > 0,
        adaptiveLod: false,
        preserveAuthoredParts: true,
        lodHysteresis: LOD_BANDS.hysteresis,
        // A tree standing in a dithered distance band crawled under 4x MSAA as the player walked;
        // UE's temporal swap finishes each tree's change in half a second instead.
        lodTransition: "temporal",
        transparentScatter: "blend",
        admissionBudgetMs: 2 / Math.max(1, grouped.size),
        budgets: {
          residentCells: Math.max(1, plan.cells.length),
          instances: Math.max(1, list.length + farInstances),
          bytes: Math.max(
            32,
            placements.byteLength + rangeRoots * 16 + farInstances * (16 * 4 + 4),
          ),
        },
        shadows: {
          cast: plan.bucket.endsWith(":true") && options.castShadows !== false,
          castLevels: 3,
          // Shadows keep the mid spruce at every distance under the far band: a cached shadow page
          // redraws once a second and showed every near/mid swap since in one batch.
          minLevel: 1,
          receive: true,
          smallCasterMetres: 0.0001,
          invalidate: options.invalidateShadows,
        },
        loadModel: async (path) => {
          const model = models.get(path);
          if (!model) throw new Error(`Missing streamed model '${path}'`);
          return model;
        },
      });
      world.name = `strata-props:${plan.bucket}`;
      worlds.push(world);
      void world.prewarmed.then(() => warmed.add(world));
    }
    phase = "complete";
    currentBucket = "";
    progress(total, total);
  } catch (error) {
    for (const world of worlds) world.dispose();
    throw error;
  }
  grouped.clear();
  shapes.clear();
  function stats() {
    return statsOf(worlds);
  }
  return {
    worlds,
    byId,
    stats,
    compileSlices,
    readinessAt(camera: Camera) {
      const regions = worlds.map((world) => world.readinessAt(camera));
      const required = regions.reduce((n, r) => n + r.requiredCells, 0);
      const loaded = regions.reduce((n, r) => n + r.loadedCells, 0);
      return {
        required,
        loaded,
        failures: regions.reduce((n, r) => n + r.failures, 0),
        ready:
          warmed.size === worlds.length &&
          regions.every((r) => r.ready) &&
          worlds.every((world) => {
            const state = world.stats();
            return state.impostor.pending === 0 && state.pendingPrewarm === 0;
          }),
      };
    },
    get ready() {
      const s = stats();
      return (
        warmed.size === worlds.length &&
        s.loadsInFlight === 0 &&
        s.loadsQueued === 0 &&
        s.admissionBacklog === 0 &&
        s.pendingPrewarm === 0 &&
        s.impostor.pending === 0 &&
        s.failures === 0
      );
    },
    get meshes() {
      const meshes: InstancedMesh[] = [];
      for (const world of worlds)
        world.traverse((node) => {
          if (node instanceof InstancedMesh && node.layers.isEnabled(0) && node.visible)
            meshes.push(node);
        });
      return meshes;
    },
    dispose() {
      for (const world of worlds) world.dispose();
      byId.clear();
    },
  };
}
