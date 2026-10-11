import { type IAssetLoader, addInSlices, createAssetLoader } from "@threenative/core";
import {
  type IShadowRegion,
  type IWorldAsset,
  type IWorldCell,
  type IWorldCellsFollow,
  type IWorldPackage,
  WorldCells,
} from "@threenative/core/world";
import type { IPlacement } from "@threenative/terrain";
import { Box3, Group, InstancedMesh, Mesh, Quaternion, Vector3 } from "three";
import type { IPropPreparationProgress } from "./propProgress.js";
import {
  DRAW_REACH,
  FADED_ASSETS,
  type IPropMaterials,
  type IPropPart,
  LOD_BANDS,
  NO_SHADOW_ASSETS,
  type PropGroundQuery,
  VARIANT_REACH,
  preparePose,
  variantFor,
} from "./props.js";

export type { IPropPreparationProgress } from "./propProgress.js";

interface IStreamOptions {
  readonly placements: readonly IPlacement[];
  readonly groundAt: PropGroundQuery;
  readonly parts: Map<string, IPropPart[]>;
  readonly materials: IPropMaterials;
  readonly follow: IWorldCellsFollow;
  readonly size: number;
  readonly horizonDistance?: number;
  readonly assets?: IAssetLoader;
  readonly whileCurrent: () => boolean;
  readonly invalidateShadows?: (region?: IShadowRegion) => void;
  readonly onProgress?: (progress: IPropPreparationProgress) => void;
}

/** Keep WorldCells' changed caster bounds when forwarding to the existing shadow renderer. */
export function invalidatePropShadows(
  shadow: { invalidateRegion(region: IShadowRegion): void; invalidateAll(): void },
  region?: IShadowRegion,
): void {
  if (region === undefined) shadow.invalidateAll();
  else shadow.invalidateRegion(region);
}

interface IRecord {
  readonly key: string;
  readonly placement: IPlacement;
  readonly pose: ReturnType<typeof preparePose>;
  readonly reach: number;
  readonly ratio: Vector3;
  readonly position: Vector3;
  readonly quaternion: Quaternion;
  readonly scale: number;
}
// Coarse source cells bound admission jobs; WorldCells retains its own main-pass culling.
// Geometry, per-placement reach and LOD selection are independent of this export grouping.
const CELL_SIZE = 128;

/** Compile the game's poses/appearance into world-v1 records; WorldCells owns every streaming step. */
export async function createStreamedProps(options: IStreamOptions) {
  if (!options.whileCurrent()) return undefined;
  let compileSlices = 0;
  const worlds: WorldCells[] = [];
  const warmed = new Set<WorldCells>();
  let phase: IPropPreparationProgress["phase"] = "grounding";
  let currentBucket = "";
  function progress(added: number, total: number): void {
    options.onProgress?.({
      phase,
      bucket: currentBucket,
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
  const records: IRecord[] = [];
  const byId = new Map<
    string,
    ReturnType<typeof preparePose> & {
      placement: IPlacement;
      pose: ReturnType<typeof preparePose>["matrix"];
    }
  >();
  const variantIndices = new Map<string, number>();
  const shapes = new Map<string, { parts: IPropPart[]; ratio: Vector3 }>();
  startPhase("grounding", "", options.placements.length);
  const report = await addInSlices(
    options.placements,
    (placement) => {
      const variant = `${placement.asset}:${variantFor(placement, placement.asset)}`;
      const chosen = options.parts.get(variant);
      const foot =
        chosen?.find((part) => part.role === "bark" || part.role === "stone") ?? chosen?.[0];
      if (!chosen || !foot) throw new Error(`Prop asset '${variant}' has no parts`);
      const pose = preparePose(
        foot.geometry,
        options.materials[foot.role],
        placement,
        placement.transform,
        options.groundAt,
      );
      const position = new Vector3();
      const quaternion = new Quaternion();
      const scale = new Vector3();
      pose.matrix.decompose(position, quaternion, scale);
      const scalar = scale.x === 0 ? 1 : scale.x;
      const ratio = scale.clone().divideScalar(scalar);
      const key =
        ratio.distanceToSquared(new Vector3(1, 1, 1)) < 1e-16
          ? variant
          : `${variant}@${ratio.toArray().join(",")}`;
      shapes.set(key, { parts: chosen, ratio });
      // Preserve the original variant-group index BEFORE partitioning records into cells.
      const index = variantIndices.get(variant) ?? 0;
      variantIndices.set(variant, index + 1);
      let reach = VARIANT_REACH[variant] ?? DRAW_REACH[placement.asset] ?? Number.POSITIVE_INFINITY;
      if (FADED_ASSETS.has(placement.asset)) {
        const seed = (Math.imul(index + 1, 2654435761) >>> 0) / 4294967296;
        reach = 28 + (reach - 28) * (1 - Math.sqrt(seed));
      }
      records.push({ key, placement, pose, reach, ratio, position, quaternion, scale: scalar });
      byId.set(placement.id, { ...pose, pose: pose.matrix, placement });
    },
    {
      while: options.whileCurrent,
      onProgress: ({ added, total }) => progress(added, total),
    },
  );
  if (report.stopped || !options.whileCurrent()) return undefined;

  // Infinite-reach canopy retains the whole authored world. Local cover can evict cells beyond its
  // existing draw reach; shadow policy stays the game's existing policy, not a quality reduction.
  const buckets = new Map<string, IRecord[]>();
  startPhase("partition", "", records.length);
  if (
    !(await compile(records, (record) => {
      const bucket = `${record.reach === Number.POSITIVE_INFINITY ? "horizon" : "local"}:${!NO_SHADOW_ASSETS.has(record.placement.asset)}`;
      const list = buckets.get(bucket) ?? [];
      list.push(record);
      buckets.set(bucket, list);
    }))
  )
    return undefined;
  const assets = options.assets ?? createAssetLoader();
  try {
    for (const [bucket, list] of buckets) {
      if (!options.whileCurrent()) {
        for (const world of worlds) world.dispose();
        return undefined;
      }
      let minX = -options.size / 2;
      let minZ = minX;
      let maxX = options.size / 2;
      let maxZ = maxX;
      let minY = Number.POSITIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      let maxReach = 0;
      startPhase("bounds", bucket, list.length);
      if (
        !(await compile(list, (record) => {
          minX = Math.min(minX, record.position.x);
          minZ = Math.min(minZ, record.position.z);
          maxX = Math.max(maxX, record.position.x);
          maxZ = Math.max(maxZ, record.position.z);
          minY = Math.min(minY, record.position.y);
          maxY = Math.max(maxY, record.position.y);
          maxReach = Math.max(maxReach, record.reach);
        }))
      ) {
        for (const world of worlds) world.dispose();
        return undefined;
      }
      minX = Math.floor(minX / CELL_SIZE) * CELL_SIZE;
      minZ = Math.floor(minZ / CELL_SIZE) * CELL_SIZE;
      maxX = (Math.floor(maxX / CELL_SIZE) + 1) * CELL_SIZE;
      maxZ = (Math.floor(maxZ / CELL_SIZE) + 1) * CELL_SIZE;
      const extent = { minX, minZ, sizeX: maxX - minX, sizeZ: maxZ - minZ };
      const grouped = new Map<string, Map<string, IRecord[]>>();
      const definitions: Record<string, IWorldAsset> = {};
      const models = new Map<string, Group>();
      startPhase("models", bucket, list.length);
      if (
        !(await compile(list, (record) => {
          const x = Math.floor((record.position.x - minX) / CELL_SIZE);
          const z = Math.floor((record.position.z - minZ) / CELL_SIZE);
          const cellKey = `${x}:${z}`;
          const runs = grouped.get(cellKey) ?? new Map<string, IRecord[]>();
          const run = runs.get(record.key) ?? [];
          run.push(record);
          runs.set(record.key, run);
          grouped.set(cellKey, runs);
          if (definitions[record.key]) return;
          const shape = shapes.get(record.key);
          if (!shape) throw new Error(`Missing shape '${record.key}'`);
          const levels = [...new Set(shape.parts.map((part) => part.level ?? 0))].sort(
            (a, b) => a - b,
          );
          const bounds = new Box3();
          for (const level of levels) {
            const group = new Group();
            for (const part of shape.parts.filter((part) => (part.level ?? 0) === level)) {
              const mesh = new Mesh(part.geometry, part.material ?? options.materials[part.role]);
              mesh.scale.copy(shape.ratio);
              group.add(mesh);
            }
            group.updateMatrixWorld(true);
            bounds.union(new Box3().setFromObject(group)); // engine-override: measure generated LOD bounds for the streamed manifest
            models.set(`${record.key}/${level}.glb`, group);
          }
          definitions[record.key] = {
            glb: `${record.key}/0.glb`,
            bounds: { min: bounds.min.toArray(), max: bounds.max.toArray() },
            lods: levels.slice(1).map((level, i) => ({
              glb: `${record.key}/${level}.glb`,
              distance: i === 0 ? LOD_BANDS.mid : LOD_BANDS.far,
            })),
          };
        }))
      ) {
        for (const world of worlds) world.dispose();
        return undefined;
      }
      const placements = new Float32Array(list.length * 8);
      const placementReach = new Float32Array(list.length);
      const cells: IWorldCell[] = [];
      function* ordered() {
        let planned = 0;
        for (const [cellKey, runs] of grouped) {
          const [x, z] = cellKey.split(":").map(Number);
          const cellRuns = [];
          for (const [asset, run] of runs) {
            cellRuns.push({ asset, offset: planned, count: run.length });
            planned += run.length;
            yield* run;
          }
          if (x === undefined || z === undefined) throw new Error("Invalid placement cell key");
          cells.push({ x, z, runs: cellRuns });
        }
      }
      let offset = 0;
      startPhase("records", bucket, list.length);
      if (
        !(await compile(ordered(), (record) => {
          placements.set(
            [...record.position.toArray(), ...record.quaternion.toArray(), record.scale],
            offset * 8,
          );
          placementReach[offset] = record.reach;
          if ((placementReach[offset] as number) < record.reach)
            placementReach[offset] = record.reach * (1 + 2 ** -23);
          offset++;
        }))
      ) {
        for (const world of worlds) world.dispose();
        return undefined;
      }
      const manifest: IWorldPackage = {
        version: 1,
        extent,
        cellSize: CELL_SIZE,
        assets: definitions,
        cells,
        placements: "placements.bin",
        terrain: {
          heightmap: "unused.u16",
          columns: extent.sizeX / CELL_SIZE + 1,
          rows: extent.sizeZ / CELL_SIZE + 1,
          spacing: CELL_SIZE,
          heightMin: minY,
          heightMax: maxY,
        },
      };
      const ring = Number.isFinite(maxReach)
        ? Math.ceil(maxReach / CELL_SIZE) + 1
        : Math.ceil(
            (options.horizonDistance ?? Math.hypot(extent.sizeX, extent.sizeZ)) / CELL_SIZE,
          ) + 1;
      startPhase("world-load", bucket, list.length);
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
        data: { manifest, placements: placements.buffer },
        placementReach,
        gpuScene: false,
        adaptiveLod: false,
        preserveAuthoredParts: true,
        lodHysteresis: LOD_BANDS.hysteresis,
        transparentScatter: "blend",
        admissionBudgetMs: 2 / Math.max(1, buckets.size),
        budgets: {
          residentCells: Math.max(1, cells.length),
          instances: Math.max(1, list.length),
          bytes: Math.max(32, placements.byteLength),
        },
        shadows: {
          cast: bucket.endsWith(":true"),
          castLevels: 3,
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
      world.name = `strata-props:${bucket}`;
      worlds.push(world);
      void world.prewarmed.then(() => warmed.add(world));
    }
    phase = "complete";
    currentBucket = "";
    progress(options.placements.length, options.placements.length);
  } catch (error) {
    for (const world of worlds) world.dispose();
    throw error;
  }
  records.length = 0;
  buckets.clear();
  shapes.clear();
  variantIndices.clear();
  function stats() {
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
        admissionMs: 0,
        admissionBacklog: 0,
        admissionDeferred: 0,
      },
    );
  }
  return {
    worlds,
    byId,
    stats,
    compileSlices,
    readinessAt(position: { readonly x: number; readonly z: number }, radius = 60) {
      const regions = worlds.map((world) => world.readinessAt(position, radius));
      const required = regions.reduce((n, r) => n + r.requiredCells, 0);
      const loaded = regions.reduce((n, r) => n + r.loadedCells, 0);
      return {
        required,
        loaded,
        failures: regions.reduce((n, r) => n + r.failures, 0),
        ready: warmed.size === worlds.length && regions.every((r) => r.ready),
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
