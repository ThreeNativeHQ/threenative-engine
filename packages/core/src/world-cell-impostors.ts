import {
  type BufferGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  type Material,
  Matrix4,
  type Object3D,
  Quaternion,
  Vector3,
} from "three";
import { dropPooledFor } from "./render/mesh-pool.js";
import {
  IMPOSTOR_FAR_CULL_ATTRIBUTE,
  WorldImpostorSurface,
} from "./render/world-impostor-surface.js";
import {
  type IImpostorPart,
  type IImpostorRawRenderer,
  IMPOSTOR_FRAME_PIXELS,
  IMPOSTOR_VIEWS,
  WORLD_IMPOSTOR_MARKER,
  type WorldImpostorAtlas,
  WorldImpostorBaker,
  impostorBounds,
} from "./render/world-impostor.js";
import type { IRendererLike } from "./renderer.js";
import { levelTriangles } from "./world-cell-chunks.js";
import { cellKey } from "./world-cell-data.js";
import type {
  IAssetPart,
  IResidentCell,
  IWorldCellsBudget,
  IWorldCellsStats,
} from "./world-cell-data.js";
import type { IAssetState } from "./world-cells.js";
import { VIRTUAL_SHADOW_WIDE_CASTER_LAYER } from "./world-chunk-shadow.js";
import {
  type IWorldAsset,
  type IWorldCell,
  type IWorldPackage,
  type IWorldRun,
  cellPlacements,
} from "./world-package.js";

/**
 * GPU bytes of completed impostor atlases one world admits, 128 MiB. A 128 px two-attachment RGBA8
 * atlas with mips is 2,796,160 B, so 48 fit and the 49th is refused before its atlas is allocated,
 * keeping its source LODs. An atlas a live asset still draws from is never evicted, so the active
 * record count is a hard admission cap rather than a target the cache trims toward — eviction only
 * ever drops an inactive record to make room for a new one.
 */
const DEFAULT_IMPOSTOR_ATLAS_BUDGET_BYTES = 128 * 1024 * 1024;

/**
 * The declared byte cost of one atlas at the bake's fixed frame, the same numbers
 * `WorldImpostorAtlas.bytes` reports: both RGBA8 attachments' mip chains, the logical colour atlas
 * cost rather than every physical GPU buffer a render target holds. Computed here so the cache
 * budget is enforced BEFORE `baker.begin` allocates the atlas, never after.
 */
const IMPOSTOR_ATLAS_BYTES = ((): number => {
  const levels = Math.floor(Math.log2(Math.max(1, IMPOSTOR_FRAME_PIXELS))) + 1;
  let bytes = 0;
  for (let level = 0; level < levels; level += 1) {
    const edge = Math.max(1, IMPOSTOR_FRAME_PIXELS >> level);
    bytes += edge * edge * IMPOSTOR_VIEWS * 4;
  }
  return 2 * bytes;
})();

/**
 * The far-residency diagnostic marker: one bounded line per whole-map aggregate built, naming the one
 * `InstancedMesh` per atlas cache key, its original placements, the live/near-owned split, its
 * physical instance bytes and how many times its instance buffer has been written.
 */
const WORLD_IMPOSTOR_FAR_MARKER = "TN_WORLD_IMPOSTOR_FAR";

/**
 * Bytes one far instance costs: its sixteen-float32 matrix plus the one-float per-instance cull the
 * shared far surface reads. Both are physical allocations the budget bounds; the cull is uploaded
 * once because the placement never moves.
 */
const FAR_INSTANCE_BYTES = 16 * 4 + 4;

/**
 * One completed whole-asset atlas, cached by its content key and its source cutout contract.
 *
 * Bounded, not a generic cache: the atlas is the one GPU resource a later far reference may want to
 * hold without keeping the full source GLB, and the CPU `center`/`radius` are the two scalars the
 * surface needs to project it. `users` counts the live assets drawing it; a record with no user is
 * inactive and evictable once the byte budget is over, and one with a user is never evicted.
 */
interface IImpostorRecord {
  readonly key: string;
  readonly atlas: WorldImpostorAtlas;
  readonly center: Vector3;
  readonly radius: number;
  readonly bytes: number;
  users: number;
}

/** The terminal LOD one asset appended once its bake landed; owned and released with the asset. */
export interface IImpostorState {
  readonly part: IAssetPart;
  readonly surface: WorldImpostorSurface;
  readonly record: IImpostorRecord;
}

/**
 * One `(cell, run)`'s slice of a whole-map far aggregate.
 *
 * The records are the run's ORIGINAL placement roots, composed once when the aggregate is built and
 * never rewritten while the camera moves. `live` is false while the near ring owns the run, which is
 * the atomic handoff: a run is drawn by exactly one of the two, never both and never neither.
 */
interface IFarSegment {
  readonly cell: IWorldCell;
  readonly run: IWorldRun;
  /** First instance record in the aggregate's buffer, and how many the run holds. */
  readonly start: number;
  readonly count: number;
  /** This run's own view-distance gate, `Infinity` when its asset authored no `maxDistance`. */
  readonly cull: number;
  live: boolean;
}

/**
 * One whole-map far aggregate per exact atlas cache key: a single `InstancedMesh` holding every
 * ORIGINAL placement root of every canonical asset that bakes to that key, independent of the near
 * full-geometry ring and of the near source GLBs.
 *
 * The surface is the aggregate's own, built from the record's atlas and the first source material
 * that baked to it, so disposing a near asset's surface cannot invalidate the far mesh. The atlas is
 * borrowed: `record.users` is incremented once for the aggregate and held until the world disposes,
 * which is what stops `#evictImpostors` dropping an atlas the far mesh still draws.
 */
interface IFarAggregate {
  readonly key: string;
  readonly surface: WorldImpostorSurface;
  readonly record: IImpostorRecord;
  mesh: InstancedMesh;
  capacity: number;
  /** Every original placement root the aggregate holds, live and near-owned. */
  readonly segments: Map<IWorldRun, IFarSegment>;
  /** How many times the instance buffer has been written, for the settled-frame check. */
  uploads: number;
}

/**
 * The metadata a refused far cohort is kept as, without its source GLB.
 *
 * A hard budget refusal releases the asset's geometry and materials the way any release does; the
 * atlas is pinned by one borrowed `users` and the aggregate's own surface is built once here, so a
 * later capacity release retries from this alone — no full model is held alive for a cohort that may
 * never fit. See `#deferFar`, `#retryFar`.
 */
interface IFarCohort {
  readonly id: string;
  readonly key: string;
  readonly record: IImpostorRecord;
  /** The alpha-foliage source material to twin; absent once a refused cohort has its surface built. */
  readonly source?: Material;
  readonly alphaTest: number;
  readonly cull: number;
  readonly runs: ReadonlyArray<{ cell: IWorldCell; run: IWorldRun }>;
}

/**
 * A refused far cohort kept without its source GLB: metadata plus the surface already built from the
 * source at refusal. No material, geometry or texture of the model survives here — only the surface,
 * which cleared its UV maps and borrows the pinned atlas.
 */
interface IFarRetryEntry {
  readonly id: string;
  readonly key: string;
  readonly record: IImpostorRecord;
  readonly alphaTest: number;
  readonly cull: number;
  readonly runs: ReadonlyArray<{ cell: IWorldCell; run: IWorldRun }>;
  readonly surface: WorldImpostorSurface;
}

/**
 * The raw renderer seam the impostor bake needs, or `undefined` when this backend does not expose it.
 *
 * `IRendererLike.raw` is `unknown` on purpose: it is whatever the running renderer is, and a backend
 * without layered render targets has no bake seam at all. The shape is checked rather than cast, so a
 * stub whose raw is not a renderer leaves the bake un-run instead of throwing inside a frame.
 *
 * A WebGL renderer is the reason the three-method shape alone is not enough: it carries `render`,
 * `setRenderTarget` and `initRenderTarget` and would pass, then fail mid-frame on the layered MRT
 * capture it cannot run. So the backend must declare itself WebGPU (`kind` and the renderer's own
 * `isWebGPURenderer`), which a WebGL fallback and an unsupported native backend do not, and the full
 * getter/setter seam the baker calls must be present before the cast — the ones the baker reaches
 * with `?.` still have to exist on a real backend, and a raw object missing them would be half-run,
 * not skipped cleanly.
 */
const REQUIRED_IMPOSTOR_METHODS = [
  "getActiveCubeFace",
  "getActiveMipmapLevel",
  "getClearAlpha",
  "getClearColor",
  "getMRT",
  "getRenderTarget",
  "initRenderTarget",
  "render",
  "setClearAlpha",
  "setClearColor",
  "setMRT",
  "setRenderTarget",
] as const;

function impostorRawRenderer(
  renderer: IRendererLike | undefined,
): IImpostorRawRenderer | undefined {
  if (renderer === undefined || renderer.kind !== "webgpu") return undefined;
  const raw = renderer.raw as
    | (Partial<IImpostorRawRenderer> & { isWebGPURenderer?: boolean })
    | null;
  if (raw === null || raw === undefined) return undefined;
  if (raw.isWebGPURenderer !== true) return undefined;
  // A `WebGPURenderer` can wrap the WebGL fallback backend and still report `kind: 'webgpu'` and
  // `isWebGPURenderer === true`; that backend cannot run a layered MRT capture, so the method shape
  // alone would accept it and fail mid-frame. The backend it actually wrapped is the honest answer.
  if ((raw as { backend?: { isWebGLBackend?: boolean } }).backend?.isWebGLBackend === true)
    return undefined;
  for (const method of REQUIRED_IMPOSTOR_METHODS)
    if (typeof raw[method] !== "function") return undefined;
  return raw as IImpostorRawRenderer;
}

/** The bake's view of one asset level: each part's geometry, transform and surface, by reference. */
function impostorParts(parts: readonly IAssetPart[]): IImpostorPart[] {
  const staged: IImpostorPart[] = [];
  for (const part of parts)
    staged.push({ geometry: part.geometry, local: part.local, material: part.material });
  return staged;
}

/**
 * The alpha threshold a cutout gets when the part's own material names none. ponytail: a fixed
 * 0.5, because the cutout point is authored data a GLB carries per texture and nothing reads it
 * here. A tree whose needles visibly dither at 0.5 wants a lower one — give
 * `transparentScatter` a third mode carrying a threshold when that is worth a knob.
 */
export const DEFAULT_CUTOUT_ALPHA = 0.5;

/** The one test that separates an alpha-cutout foliage part from an opaque one: MASK or BLEND. */
export function isAlphaFoliage(material: Material): boolean {
  return material.transparent || material.alphaTest > 0;
}
export interface ICellImpostorsHost {
  released(): boolean;
  renderer(): IRendererLike | undefined;
  asset(id: string): IAssetState | undefined;
  hasAsset(id: string): boolean;
  assets(): Iterable<IAssetState>;
  nearWorkPending(): boolean;
  newAsset(id: string, definition: IWorldAsset): IAssetState;
  startAssetLoad(asset: IAssetState): void;
  release(id: string): void;
  noteGate(gate: number): void;
  retargetWideCasters(asset: IAssetState): void;
  terminalLevelReady(asset: IAssetState): void;
  residentCell(key: string): IResidentCell | undefined;
  canonical(id: string): string;
  shadowRecordsMoved(): void;
  residency(): { readonly instances: number; readonly bytes: number; readonly hlodBytes: number };
  add(object: Object3D): void;
  remove(object: Object3D): void;
  addFailure(): void;
  markReleasedPart(part: IAssetPart): void;
}
export interface ICellImpostorsSettings {
  readonly enabled: boolean;
  readonly receiveShadow: boolean;
  readonly candidates: readonly string[];
  readonly cells: readonly IWorldCell[];
  readonly manifest: IWorldPackage;
  readonly placements: ArrayBuffer;
  readonly transparentScatter: "cutout" | "blend";
  readonly autoLodPixelsPerUnit: number;
  readonly castShadowLevels: number;
  readonly budgets: IWorldCellsBudget;
}
export class CellImpostors {
  readonly #host: ICellImpostorsHost;

  readonly #cells: readonly IWorldCell[];

  readonly #manifest: IWorldPackage;

  readonly #placements: ArrayBuffer;

  readonly #transparentScatter: "cutout" | "blend";

  /**
   * Pixels per world unit at unit depth, the scale a baked chain's level errors are divided by to
   * reach a switch distance. See `IWorldCellsLoadOptions.autoLod` and {@link chainLevels}.
   */
  readonly #autoLodPixelsPerUnit: number;

  /** How many of an asset's finest levels cast shadows; 0 when the game asked for none. */
  readonly #castShadowLevels: number;

  readonly #budgets: IWorldCellsBudget;

  readonly #position = new Vector3();

  readonly #rotation = new Quaternion();

  readonly #scale = new Vector3();

  readonly #matrix = new Matrix4();

  /** Whether alpha-foliage assets append a baked whole-asset terminal level; see the option. */
  readonly #impostors: boolean;
  readonly #receiveShadow: boolean;

  /** The baker one view per render-cadence update; see `#stepImpostor`. */
  readonly #baker = new WorldImpostorBaker();

  /** Assets whose bake is queued, in adoption order; `#impostorQueued` is the same set by id. */
  readonly #impostorQueue: IAssetState[] = [];

  readonly #impostorQueued = new Set<string>();

  /** The asset whose bake holds the baker right now, if any. */
  #impostorBaking: IAssetState | undefined;

  /**
   * Completed atlases by content key. An atlas a live asset draws from is active and never evicted;
   * one with no user is kept for a later reference until the byte budget needs the room.
   */
  readonly #impostorRecords = new Map<string, IImpostorRecord>();

  #impostorRecordBytes = 0;

  /** The declared bytes of the one bake in flight, held against the budget before `begin`. */
  #impostorReservedBytes = 0;

  readonly #impostorBudgetBytes: number;

  /** Assets whose `TN_WORLD_IMPOSTOR` line has printed, so the marker is one per asset. */
  readonly #impostorReported = new Set<string>();

  /**
   * Assets whose pre-bake wide segments are still waiting for a block in the one whole-asset mesh,
   * because the frame that handed the bake over had spent its fresh-mesh allowance. Retried on the
   * next update rather than left with no far shadow.
   */
  readonly #wideRetry = new Set<string>();

  /**
   * The whole-map far aggregates, one per exact atlas cache key, and the `run -> aggregate` index a
   * near-ready handoff and an eviction read to toggle a run's far segment without asking the asset.
   *
   * `#farInstances` and `#farBytes` are the physical allocations those meshes hold, charged against
   * the world's own instance and byte budgets beside the near ring's records.
   */
  readonly #far = new Map<string, IFarAggregate>();

  readonly #farSegments = new Map<IWorldRun, IFarAggregate>();

  #farInstances = 0;

  #farBytes = 0;

  /** Atlas keys whose `TN_WORLD_IMPOSTOR_FAR` line has printed, so the marker is one per aggregate. */
  readonly #farReported = new Set<string>();

  /**
   * Cohorts whose far aggregate a full budget refused, as metadata plus a built surface and never
   * the source GLB. Retried when a near cell releases its allocation — an event, not a per-frame
   * scan — so a walk away from the ring makes room and the refused species appears without holding
   * a full model alive; see {@link IFarRetryEntry}, `#retryFar` and `#deferFar`.
   */
  readonly #farRetry = new Map<string, IFarRetryEntry>();

  /**
   * Canonical asset ids placed anywhere in the map, adopted on idle frames so a species that never
   * enters the near ring still bakes its atlas and appears on the far mesh. Enumerated once from the
   * static placements; see `#pumpFarAcquisition`.
   */
  readonly #farCandidateIds: readonly string[];

  /** The rotating cursor over `#farCandidateIds`, so the map is walked a bounded step per idle frame. */
  #farCursor = 0;

  /** Canonical ids whose far handling has settled: baked and built, or classified with no atlas. */
  readonly #farSeen = new Set<string>();

  /** Canonical ids acquired for the far half alone, held until their aggregate lands or is refused. */
  readonly #farTemp = new Set<string>();

  /** Every candidate is settled, so the idle pump can stop scanning the map; see `#pumpFarAcquisition`. */
  #farExhausted = false;
  constructor(settings: ICellImpostorsSettings, host: ICellImpostorsHost) {
    this.#host = host;
    this.#impostors = settings.enabled;
    this.#receiveShadow = settings.receiveShadow;
    this.#farCandidateIds = settings.candidates;
    this.#impostorBudgetBytes = DEFAULT_IMPOSTOR_ATLAS_BUDGET_BYTES;
    this.#cells = settings.cells;
    this.#manifest = settings.manifest;
    this.#placements = settings.placements;
    this.#transparentScatter = settings.transparentScatter;
    this.#autoLodPixelsPerUnit = settings.autoLodPixelsPerUnit;
    this.#castShadowLevels = settings.castShadowLevels;
    this.#budgets = settings.budgets;
  }
  get farBytes(): number {
    return this.#farBytes;
  }
  get farInstances(): number {
    return this.#farInstances;
  }
  hasFarTemp(id: string): boolean {
    return this.#farTemp.has(id);
  }
  hasQueued(id: string): boolean {
    return this.#impostorQueued.has(id);
  }
  deferWide(id: string): void {
    this.#wideRetry.add(id);
  }

  /**
   * Whether this asset can append a whole-asset impostor, so its builds keep the placement-root
   * records the far quad draws from. The same test `#maybeQueueImpostor` makes, minus the cache: an
   * asset with no alpha-cutout LOD0 part never bakes, so it never needs the extra records.
   */
  rootsNeeded(asset: IAssetState): boolean {
    if (this.#impostors === false) return false;
    const parts = asset.levels[0];
    return parts !== undefined && this.#impostorSource(parts) !== undefined;
  }

  /**
   * The first LOD0 part that is alpha foliage, and the cutoff its own material authored — or
   * `undefined` when no part is. A BLEND part carries `alphaTest 0`, and the scatter path draws it
   * through the same cutout a MASK part gets, so the contract records that default rather than a
   * zero that would bake a solid impostor.
   */
  #impostorSource(
    parts: readonly IAssetPart[],
  ): { readonly source: Material; readonly alphaTest: number } | undefined {
    for (const part of parts) {
      const material = part.material;
      if (!isAlphaFoliage(material)) continue;
      return {
        source: material,
        alphaTest: material.alphaTest > 0 ? material.alphaTest : DEFAULT_CUTOUT_ALPHA,
      };
    }
    return undefined;
  }

  /**
   * The content key one impostor atlas is cached under: the loader's resolved cooked url of LOD0,
   * plus every LOD0 source part's surface/content key and its exact cutout contract. Two package
   * entries that fetch the same cooked model and draw the same parts with the same cutoffs are one
   * bake, which is the canonical-asset idea applied to the atlas rather than to the levels — the
   * package's own `lods`/`maxDistance` metadata may have stopped the two entries aliasing, but the
   * atlas is built from LOD0 alone, so it must be shared anyway.
   *
   * The cutoff is the exact number the bake uses, never a rounded one: `0.42` and `0.420001` are
   * different silhouettes and must not collide in the cache.
   */
  #impostorKey(asset: IAssetState): string {
    const parts = asset.levels[0] ?? [];
    const contract: string[] = [];
    for (const part of parts) {
      const cutoff = isAlphaFoliage(part.material)
        ? part.material.alphaTest > 0
          ? part.material.alphaTest
          : DEFAULT_CUTOUT_ALPHA
        : 0;
      contract.push(`${part.surface}@${String(cutoff)}`);
    }
    return `${asset.resolvedGlb}|${this.#transparentScatter}|${contract.join(",")}`;
  }

  /** Mark a cached atlas touched, so the least recently used inactive record is the one evicted. */
  #touchImpostor(key: string, record: IImpostorRecord): void {
    this.#impostorRecords.delete(key);
    this.#impostorRecords.set(key, record);
  }

  /**
   * Queue one adopted asset's whole-asset impostor, or append it at once from a cached atlas.
   *
   * Called after `#widenWithChain` and before the prewarm, so the terminal level is known to the same
   * prewarm and rebuild machinery every adoption uses. An asset with no alpha-cutout LOD0 part is
   * never baked: a solid impostor is not the thing it replaces.
   */
  maybeQueueImpostor(asset: IAssetState): void {
    if (this.#impostors === false || asset.impostor !== undefined) return;
    const parts = asset.levels[0];
    if (parts === undefined) return;
    const source = this.#impostorSource(parts);
    if (source === undefined) return;
    const key = this.#impostorKey(asset);
    const cached = this.#impostorRecords.get(key);
    if (cached !== undefined) {
      this.#touchImpostor(key, cached);
      this.#finishImpostor(asset, cached);
      return;
    }
    if (this.#impostorQueued.has(asset.id)) return;
    this.#impostorQueued.add(asset.id);
    this.#impostorQueue.push(asset);
  }

  /**
   * One view of the bake per render-cadence update, then the terminal level when it completes.
   *
   * The renderer is asked for its raw seam and the bake waits for one that can run it: a world that
   * has no renderer yet — or a backend whose raw seam is not the layered-target API — simply does
   * not advance, and nothing downstream of the bake is owed until it does. No landmark is already
   * waited on, so a bake that never runs never deadlocks a loading screen.
   */
  stepImpostor(renderer: IRendererLike | undefined): void {
    if (this.#impostors === false || this.#host.released()) return;
    // A renderer that exists but carries no layered bake seam is a real answer, not a delay. Waiting
    // on it would leave every queued asset pending and its atlas bytes reserved for the world's whole
    // life, so the bake is cancelled, the reservation and queue dropped, and each asset reported:
    // the source LODs stay, which is the documented fallback. A world with no renderer yet keeps
    // waiting — that is the loading-screen case the wait exists for.
    const current = renderer ?? this.#host.renderer();
    if (current !== undefined && impostorRawRenderer(current) === undefined) {
      this.#dropUnsupportedImpostors();
      return;
    }
    if (this.#impostorBaking === undefined) {
      while (this.#impostorQueue.length > 0) {
        const asset = this.#impostorQueue.shift() as IAssetState;
        this.#impostorQueued.delete(asset.id);
        if (this.#host.asset(asset.id) !== asset || asset.disposed || asset.impostor !== undefined)
          continue;
        const parts = asset.levels[0];
        if (parts === undefined || this.#impostorSource(parts) === undefined) continue;
        // Re-check the completed cache when DEQUEUED, not only when queued: two entries whose bake
        // was queued before either finished share one atlas instead of baking it twice.
        const key = this.#impostorKey(asset);
        const cached = this.#impostorRecords.get(key);
        if (cached !== undefined) {
          this.#touchImpostor(key, cached);
          this.#finishImpostor(asset, cached);
          continue;
        }
        // Enforce the declared colour+mip budget BEFORE the atlas is allocated, and never at the
        // cost of an atlas a live asset draws from: inactive LRU records make room first.
        if (
          this.#impostorRecordBytes + this.#impostorReservedBytes + IMPOSTOR_ATLAS_BYTES >
          this.#impostorBudgetBytes
        )
          this.#evictImpostors(IMPOSTOR_ATLAS_BYTES);
        if (this.#impostorRecordBytes + IMPOSTOR_ATLAS_BYTES > this.#impostorBudgetBytes) {
          // Out of room: keep the source LODs and say why, rather than overrun the budget with one
          // more atlas or evict one still in use.
          this.#reportImpostor(asset, "budget");
          // A far-only species fetched for the far half alone has no near run to fall back on, and
          // nothing here retries an atlas-budget refusal, so keeping its source GLB alive buys
          // nothing. Release it; the near path re-acquires it normally if the follow point reaches it.
          if (this.#farTemp.has(asset.id)) this.releaseFarTemp(asset.id);
          continue;
        }
        const staged: IImpostorPart[] = impostorParts(parts);
        try {
          this.#baker.begin(asset.id, staged, { pixels: IMPOSTOR_FRAME_PIXELS });
        } catch {
          this.#host.addFailure();
          this.#reportImpostor(asset, "begin-failed");
          continue;
        }
        this.#impostorReservedBytes = IMPOSTOR_ATLAS_BYTES;
        this.#impostorBaking = asset;
        break;
      }
    }
    const baking = this.#impostorBaking;
    if (baking === undefined) return;
    const raw = impostorRawRenderer(renderer);
    if (raw === undefined) return;
    let atlas: WorldImpostorAtlas | undefined;
    try {
      atlas = this.#baker.step(raw);
    } catch {
      this.#host.addFailure();
      this.#impostorBaking = undefined;
      this.#impostorReservedBytes = 0;
      this.#reportImpostor(baking, "bake-failed");
      return;
    }
    if (atlas === undefined) return;
    this.#impostorBaking = undefined;
    this.#adoptImpostorAtlas(baking, atlas);
  }

  /**
   * Drop every queued and in-flight bake because the renderer cannot run the layered capture, and
   * report each asset once. The reservation is released with the abort, so a later supported renderer
   * (a device swap, a backend that only comes up after a frame) can still bake: the queue is empty,
   * but a fresh adoption re-queues, and an asset already refused here is left with its source LODs.
   */
  #dropUnsupportedImpostors(): void {
    if (this.#impostorQueue.length === 0 && this.#impostorBaking === undefined) return;
    const dropped: IAssetState[] = [];
    if (this.#impostorBaking !== undefined) {
      dropped.push(this.#impostorBaking);
      this.#reportImpostor(this.#impostorBaking, "unsupported");
      this.#baker.abort();
      this.#impostorBaking = undefined;
      this.#impostorReservedBytes = 0;
    }
    const queued = this.#impostorQueue.splice(0, this.#impostorQueue.length);
    this.#impostorQueued.clear();
    dropped.push(...queued);
    for (const asset of queued) this.#reportImpostor(asset, "unsupported");
    // A far-only species cannot bake on a backend that has none, so it must not keep holding the
    // source it fetched for a bake that will never land. Its atlas cache key stays for a later backend.
    for (const asset of dropped) if (this.#farTemp.has(asset.id)) this.releaseFarTemp(asset.id);
  }

  /** Store a finished atlas and hand the asset its terminal level. */ #adoptImpostorAtlas(
    asset: IAssetState,
    atlas: WorldImpostorAtlas,
  ): void {
    this.#impostorReservedBytes = 0;
    const parts = asset.levels[0];
    const source = parts === undefined ? undefined : this.#impostorSource(parts);
    if (parts === undefined || source === undefined || asset.impostor !== undefined) {
      atlas.dispose();
      return;
    }
    const key = this.#impostorKey(asset);
    const existing = this.#impostorRecords.get(key);
    if (existing !== undefined) {
      atlas.dispose();
      this.#touchImpostor(key, existing);
      this.#finishImpostor(asset, existing);
      return;
    }
    const staged: IImpostorPart[] = impostorParts(parts);
    const bounds = impostorBounds(staged);
    const record: IImpostorRecord = {
      atlas,
      bytes: atlas.bytes,
      center: bounds.center,
      key,
      radius: bounds.radius,
      users: 0,
    };
    this.#impostorRecords.set(key, record);
    this.#impostorRecordBytes += record.bytes;
    // Acquire the active user BEFORE any eviction, so the fresh record cannot be the eviction
    // victim and `#finishImpostor` never builds a surface that borrows a disposed atlas. Admission
    // already reserved this record's bytes, so the trim below only drops older inactive records.
    this.#finishImpostor(asset, record);
    this.#evictImpostors();
  }

  /**
   * Append the whole-asset terminal level: one part, identity local, two triangles, and a switch at
   * the projection the 128 px atlas sphere reaches — never a fixed metre, and strictly beyond the
   * last authored or chain gate so `levelAt` cannot pick it before the level that gate named.
   *
   * The surface's own geometry and material are the part's, so the level is a normal level to every
   * consumer downstream: the prewarm mints its keys, the swap rebuilds the resident runs, and the
   * caster halves read it through `#shapeFor` like any other. The atlas is borrowed and released by
   * the record; see `#releaseImpostor`.
   */
  #finishImpostor(asset: IAssetState, record: IImpostorRecord): void {
    if (asset.impostor !== undefined || asset.disposed) return;
    if (this.#host.asset(asset.id) !== asset) return;
    const parts = asset.levels[0];
    if (parts === undefined) return;
    const source = this.#impostorSource(parts);
    if (source === undefined) return;
    let surface: WorldImpostorSurface;
    try {
      surface = new WorldImpostorSurface({
        alphaTest: source.alphaTest,
        atlas: record.atlas,
        center: record.center,
        radius: record.radius,
        source: source.source,
      });
    } catch {
      this.#host.addFailure();
      this.#reportImpostor(asset, "surface-failed");
      return;
    }
    // The terminal gate is stored as the BASE-sphere projected distance — the distance at which the
    // asset's own LOD0 sphere, at scale 1, covers the 128 px atlas — and the placement's own scale is
    // applied per placement at selection (`levelAtGates`). A placement scaled 8-12x therefore reaches
    // the atlas 8-12x as far instead of switching at the unit-scale distance. There is no fixed
    // margin: `levelAtGates` floors the terminal one representable Float32 step past the last source
    // gate, so the source level keeps a window while the ordering survives the f32 store.
    const switchAt = (2 * record.radius * this.#autoLodPixelsPerUnit) / IMPOSTOR_FRAME_PIXELS;
    if (!Number.isFinite(switchAt) || switchAt <= 0) {
      surface.dispose();
      return;
    }
    const part: IAssetPart = {
      geometry: surface.geometry,
      local: new Matrix4(),
      material: surface.material,
      surface: "",
    };
    asset.levels = [...asset.levels, [part]];
    asset.distances = [...asset.distances, switchAt];
    asset.gates = [...asset.gates, switchAt];
    this.#host.noteGate(switchAt);
    asset.threshold = asset.gates.length === 0 ? undefined : Math.min(...asset.gates);
    asset.impostor = { part, record, surface };
    record.users += 1;
    // The whole-map far aggregate for this atlas key, before the rebuild loop below: its segments
    // exist when the swaps land, and any run already near-ready is handed over immediately. A budget
    // refusal keeps only the far cohort's metadata and surface in `#farRetry`; see `#buildFar`.
    this.#buildFar(asset, record);
    this.#reportImpostor(asset, "ready");
    // A far-only asset has no near batches or casters to hand over; once its aggregate is up its
    // temporary source has done its job and goes, while the atlas the aggregate borrows stays. A
    // refusal releases the source too — the deferred cohort in `#farRetry` holds only metadata and a
    // surface, never the GLB — so a far species that cannot fit is not kept alive wholesale.
    if (this.#farTemp.has(asset.id)) {
      this.releaseFarTemp(asset.id);
      return;
    }
    // The far casters of the levels that were already built: part 0's key is re-pointed at the one
    // whole-asset shape, and the per-part keys the terminal level has no counterpart for are dropped,
    // so the far shadow draws one quad per placement rather than a duplicate per bark/needle part.
    this.#host.retargetWideCasters(asset);
    // The terminal level's keys and every resident run of this asset, through the same prewarm and
    // swap the first build took: no active job array is mutated halfway.
    this.#host.terminalLevelReady(asset);
  }

  /**
   * The whole-map far aggregate for one exact atlas cache key: every ORIGINAL placement root of every
   * canonical asset that bakes to that key, in one `InstancedMesh`, independent of the near ring and
   * of the near source GLBs.
   *
   * One aggregate per EXACT atlas key, never one per `maxDistance`: a shared atlas can back assets
   * with different authored cutoffs, and each placement's own value rides the instance buffer (see
   * {@link IFarSegment.cull}) rather than splitting the key into a second aggregate — the exact key
   * is what the atlas cache already bounds, and a split would build a second surface for one atlas.
   * The first asset to bake a key builds the aggregate's own surface and instance buffer; a later
   * canonical asset that shares the key appends its own runs to the same mesh, growing the buffer at
   * most once per asset. A key already carrying every one of this asset's runs is left untouched, so
   * re-adopting an asset from the cached atlas after its near source was released rebuilds nothing.
   * Never `part.local`: the atlas bakes each part's own transform, so the far quad is the placement
   * root alone.
   */
  #buildFar(asset: IAssetState, record: IImpostorRecord): boolean {
    const parts = asset.levels[0];
    const source = parts === undefined ? undefined : this.#impostorSource(parts);
    if (parts === undefined || source === undefined) return false;
    // Every run this asset owns anywhere in the map: the far half covers the whole map, not the ring.
    const runs = this.#farRuns(asset.id);
    if (runs.length === 0) return true;
    return this.#buildFarCohort({
      alphaTest: source.alphaTest,
      cull: cullDistance(asset.definition.maxDistance) ?? Number.POSITIVE_INFINITY,
      id: asset.id,
      key: record.key,
      record,
      runs,
      source: source.source,
    });
  }

  /** Every run of one canonical asset anywhere in the map, the whole set a far aggregate holds. */
  #farRuns(id: string): Array<{ cell: IWorldCell; run: IWorldRun }> {
    const runs: Array<{ cell: IWorldCell; run: IWorldRun }> = [];
    for (const held of this.#cells)
      for (const run of held.runs) {
        if (this.#host.canonical(run.asset) !== id || run.count <= 0) continue;
        runs.push({ cell: held, run });
      }
    return runs;
  }

  /**
   * Build or grow one far cohort's aggregate, or defer it against the hard budget.
   *
   * The budget check counts the growth transient, not the net new count: a grow allocates the new
   * larger buffer while the old one is still alive, so the peak is the new buffer's size — the old
   * buffer is already charged in `#farBytes`. See {@link #farBudgetRefuses}. A refusal is remembered
   * as metadata plus a built surface, never the source GLB; see {@link #deferFar}.
   */
  #buildFarCohort(cohort: IFarCohort): boolean {
    const key = cohort.key;
    const aggregate = this.#far.get(key);
    const missing =
      aggregate === undefined
        ? cohort.runs
        : cohort.runs.filter((entry) => !(aggregate as IFarAggregate).segments.has(entry.run));
    if (missing.length === 0) {
      this.#dropFarRetry(cohort.id);
      return true;
    }
    const extra = missing.reduce((total, entry) => total + entry.run.count, 0);
    const peak = aggregate === undefined ? extra : (aggregate as IFarAggregate).capacity + extra;
    if (this.#farBudgetRefuses(peak)) {
      // Hard finite budget: say why rather than overrun it, and keep only the metadata the retry
      // needs. Never the full source GLB; see `#deferFar`.
      this.#reportFarBudget(key, cohort.id, extra);
      this.#deferFar(cohort);
      return false;
    }
    let built = aggregate as IFarAggregate | undefined;
    const deferred = this.#farRetry.get(cohort.id);
    // The surface actually drawn by the aggregate after this call. A new aggregate adopts the
    // deferred surface; a grow reuses the aggregate's own and leaves the deferred one unused.
    let usedSurface: WorldImpostorSurface | undefined;
    if (built === undefined) {
      usedSurface = deferred?.surface ?? this.#makeFarSurface(cohort);
      if (usedSurface === undefined) return false;
      built = {
        capacity: extra,
        key,
        mesh: this.#newFarMesh(usedSurface, extra, cohort.id),
        record: cohort.record,
        segments: new Map<IWorldRun, IFarSegment>(),
        surface: usedSurface,
        uploads: 0,
      };
      cohort.record.users += 1;
      this.#far.set(key, built);
      this.#farInstances += extra;
      this.#farBytes += extra * FAR_INSTANCE_BYTES;
    } else {
      this.#growFar(built, extra);
    }
    this.#dropFarRetry(cohort.id, usedSurface);
    let at = this.#farAllocated(built);
    for (const { cell: held, run } of missing) {
      const segment: IFarSegment = {
        cell: held,
        count: run.count,
        cull: cohort.cull,
        live: true,
        run,
        start: at,
      };
      at += run.count;
      built.segments.set(run, segment);
      this.#farSegments.set(run, built);
      this.#writeFarSegment(built, segment);
    }
    this.#syncFarSegments(built);
    // The far half just gained records, so the shadow levels drawing the ground they stand on are
    // stale; the same blanket tell a near swap makes. See `#shadowRecordsMoved`.
    this.#host.shadowRecordsMoved();
    if (!this.#farReported.has(key)) {
      this.#farReported.add(key);
      const split = this.#farSplit(built);
      console.info(
        `${WORLD_IMPOSTOR_FAR_MARKER} key=${key} asset=${cohort.id} ` +
          `instances=${String(built.capacity)} live=${String(split.live)} ` +
          `nearOwned=${String(split.nearOwned)} bytes=${String(built.capacity * FAR_INSTANCE_BYTES)} ` +
          `uploads=${String(built.uploads)}`,
      );
    }
    return true;
  }

  /** The aggregate's own far surface: the record's atlas, the cohort's material twin, per-instance cull. */
  #makeFarSurface(cohort: IFarCohort): WorldImpostorSurface | undefined {
    if (cohort.source === undefined) return undefined;
    try {
      return new WorldImpostorSurface({
        alphaTest: cohort.alphaTest,
        atlas: cohort.record.atlas,
        center: cohort.record.center,
        cull: true,
        radius: cohort.record.radius,
        source: cohort.source,
      });
    } catch {
      this.#host.addFailure();
      return undefined;
    }
  }

  /**
   * Keep a refused far cohort as metadata alone: the atlas pinned by one borrowed user, the runs, and
   * a built surface. The asset's own geometry and materials are released by the caller, so a refused
   * far species never holds a full GLB alive; `#retryFar` rebuilds from this when a near release frees
   * room. Idempotent: a repeat refusal keeps the surface already built.
   */
  #deferFar(cohort: IFarCohort): void {
    if (this.#farRetry.has(cohort.id)) return;
    const surface = this.#makeFarSurface(cohort);
    if (surface === undefined) return;
    cohort.record.users += 1;
    this.#farRetry.set(cohort.id, {
      alphaTest: cohort.alphaTest,
      cull: cohort.cull,
      id: cohort.id,
      key: cohort.key,
      record: cohort.record,
      runs: cohort.runs,
      surface,
    });
  }

  /** Drop a deferred cohort, releasing its surface and the atlas user it pinned. */
  #dropFarRetry(id: string, consumedSurface?: WorldImpostorSurface): void {
    const entry = this.#farRetry.get(id);
    if (entry === undefined) return;
    this.#farRetry.delete(id);
    if (consumedSurface !== entry.surface) entry.surface.dispose();
    entry.record.users = Math.max(0, entry.record.users - 1);
    this.#evictImpostors();
  }

  /** Retry the far aggregates a full budget refused, when a near cell freed its allocation. */
  retryFar(): void {
    if (this.#farRetry.size === 0) return;
    for (const entry of [...this.#farRetry.values()]) this.#buildFarCohort(entry);
  }

  /**
   * Adopt one far-only species per idle frame: a canonical asset the map places but no resident run
   * has asked for yet. Its LOD0 is loaded through the same limiter, classified by its actual
   * materials, baked on the same queue, and its source released once the aggregate lands. Gated on an
   * empty near queue so loading the unseen never delays the near ring or holds its overlay open.
   */
  pumpFarAcquisition(): void {
    if (this.#impostors === false || this.#host.released() || this.#farExhausted) return;
    if (this.#farCandidateIds.length === 0) return;
    // Near work first: a queued build, an in-flight near load, a bake in flight or waiting. Only a
    // settled frame spends itself on the unseen far half.
    if (
      this.#host.nearWorkPending() ||
      this.#impostorQueue.length > 0 ||
      this.#impostorBaking !== undefined
    )
      return;
    // The bake needs a renderer that can run it; acquiring before one exists would hold source GLBs
    // for a bake with no way to land. A renderer that is present but unsupported is the same answer.
    const renderer = this.#host.renderer();
    if (renderer === undefined || impostorRawRenderer(renderer) === undefined) return;
    const count = this.#farCandidateIds.length;
    for (let step = 0; step < count; step += 1) {
      const at = (this.#farCursor + step) % count;
      const id = this.#farCandidateIds[at] as string;
      if (this.#farSeen.has(id) || this.#host.hasAsset(id) || this.#farRetry.has(id)) continue;
      this.#farCursor = (at + 1) % count;
      const definition = this.#manifest.assets[id];
      if (definition === undefined) {
        this.#farSeen.add(id);
        continue;
      }
      const asset = this.#host.newAsset(id, definition);
      asset.refcount += 1;
      this.#farTemp.add(id);
      this.#host.startAssetLoad(asset);
      return;
    }
    // A full pass with nothing startable means every species is either baked, held for a retry, or
    // classified as having no atlas. Static placements add none later, so the scan stops here.
    this.#farExhausted = true;
  }

  /**
   * Drop a far-only asset's temporary reference once its atlas is held by an aggregate or has been
   * deferred. The deferred cohort keeps its own pinned atlas user, so it is not dropped here.
   */
  releaseFarTemp(id: string): void {
    this.#farTemp.delete(id);
    this.#farSeen.add(id);
    this.#host.release(id);
  }

  /**
   * Whether an incoming far allocation would overrun the world's instance or byte budget.
   *
   * `count` is the peak, not the net: a grow allocates the new larger buffer while the old one is
   * still alive, so the caller passes the new buffer's full size — the old buffer is already inside
   * `#farInstances`/`#farBytes`. A net-new count would understate the transient a resize holds.
   */
  #farBudgetRefuses(count: number): boolean {
    return (
      this.#host.residency().instances + this.#farInstances + count > this.#budgets.instances ||
      this.#host.residency().bytes +
        this.#farBytes +
        this.#host.residency().hlodBytes +
        count * FAR_INSTANCE_BYTES >
        this.#budgets.bytes
    );
  }

  /** One bounded line for a far aggregate the world's own budgets refused, once per atlas key. */
  #reportFarBudget(key: string, assetId: string, count: number): void {
    if (this.#farReported.has(key)) return;
    this.#farReported.add(key);
    console.info(
      `${WORLD_IMPOSTOR_FAR_MARKER} key=${key} asset=${assetId} ` +
        `instances=${String(count)} reason=budget`,
    );
  }

  /**
   * One far mesh: the whole-asset quad, every original root, drawn regardless of how far the camera
   * resolves it. `frustumCulled = false` is what keeps the draw: the projected-size gate exempts it
   * before it ever reads bounds, so no `alwaysRender` marker is needed when a game configured no
   * shadows to exempt it under `renderer.minimumProjectedPixels`. The per-placement cull rides the
   * geometry's instance attribute, one static value per placement; see
   * {@link IMPOSTOR_FAR_CULL_ATTRIBUTE}.
   */
  #newFarMesh(surface: WorldImpostorSurface, capacity: number, assetId: string): InstancedMesh {
    const mesh = new InstancedMesh(surface.geometry, surface.material, capacity);
    mesh.count = capacity;
    mesh.frustumCulled = false;
    // Three's default usage uploads by version; grow/write/zero announce every matrix change through
    // needsUpdate. DynamicDrawUsage would upload the same whole-map buffer on every settled draw.
    mesh.name = `tn-far:${assetId}`;
    // Drawn on layer 0, so this is a main-pass draw the frame budget counts under the impostor
    // aggregate's own source rather than under `other` (`RenderPassBudget`).
    mesh.userData.tnDrawSource = "proxies";
    if (surface.cull) this.#attachFarCull(surface.geometry, capacity);
    // Far trees cast like near ones, into the coarse wide caster layer. The same mesh draws the main
    // pass (layer 0) and the virtual-shadow levels (wide layer), so one representation covers both
    // and a run hands its far segment over to the near ring exactly once; see `#disableFar`. The
    // per-asset maxDistance gate is a main-pass shader gate, so the shadow half still reaches the map.
    if (this.#castShadowLevels > 0) {
      mesh.layers.enable(VIRTUAL_SHADOW_WIDE_CASTER_LAYER);
      mesh.castShadow = true;
    }
    mesh.receiveShadow = this.#receiveShadow;
    this.#host.add(mesh);
    return mesh;
  }

  /** Install a fresh per-instance cull buffer on the aggregate's shared geometry, all gates open. */
  #attachFarCull(geometry: BufferGeometry, capacity: number): void {
    geometry.setAttribute(
      IMPOSTOR_FAR_CULL_ATTRIBUTE,
      new InstancedBufferAttribute(new Float32Array(capacity).fill(Number.POSITIVE_INFINITY), 1),
    );
  }

  /** Append `extra` instance slots to an aggregate, one mesh swap, charged to the budgets. */
  #growFar(aggregate: IFarAggregate, extra: number): void {
    const old = aggregate.mesh;
    const capacity = aggregate.capacity + extra;
    // Capture the cull values before the replacement mesh attaches a fresh buffer to the SHARED
    // geometry; the old attribute object is replaced in place there.
    const oldCull = aggregate.surface.cull
      ? (
          aggregate.surface.geometry.getAttribute(IMPOSTOR_FAR_CULL_ATTRIBUTE)?.array as
            | Float32Array
            | undefined
        )?.slice(0, aggregate.capacity)
      : undefined;
    const next = this.#newFarMesh(aggregate.surface, capacity, old.name.replace(/^tn-far:/u, ""));
    (next.instanceMatrix.array as Float32Array).set(
      (old.instanceMatrix.array as Float32Array).subarray(0, aggregate.capacity * 16),
    );
    next.instanceMatrix.needsUpdate = true;
    if (oldCull !== undefined) {
      const attribute = next.geometry.getAttribute(IMPOSTOR_FAR_CULL_ATTRIBUTE) as
        | InstancedBufferAttribute
        | undefined;
      if (attribute !== undefined) (attribute.array as Float32Array).set(oldCull, 0);
    }
    this.#host.remove(old);
    old.dispose();
    aggregate.mesh = next;
    aggregate.capacity = capacity;
    aggregate.uploads += 1;
    this.#farInstances += extra;
    this.#farBytes += extra * FAR_INSTANCE_BYTES;
  }

  /** Slots allocated in an aggregate: the sum of its segment counts, the offset the next one takes. */
  #farAllocated(aggregate: IFarAggregate): number {
    let at = 0;
    for (const segment of aggregate.segments.values()) at += segment.count;
    return at;
  }

  /** Compose one run's ORIGINAL placement roots into its segment, exactly as `#addPlacements` does. */
  #writeFarSegment(aggregate: IFarAggregate, segment: IFarSegment): void {
    const records = cellPlacements(this.#placements, segment.run);
    const array = aggregate.mesh.instanceMatrix.array as Float32Array;
    const base = segment.start * 16;
    for (let index = 0; index < segment.count; index += 1) {
      const at = index * PLACEMENT_RECORD_FLOATS;
      this.#position.set(
        records[at] as number,
        records[at + 1] as number,
        records[at + 2] as number,
      );
      this.#rotation.set(
        records[at + 3] as number,
        records[at + 4] as number,
        records[at + 5] as number,
        records[at + 6] as number,
      );
      this.#scale.setScalar(records[at + 7] as number);
      this.#matrix.compose(this.#position, this.#rotation, this.#scale);
      this.#matrix.toArray(array, base + index * 16);
    }
    aggregate.mesh.instanceMatrix.needsUpdate = true;
    // The per-placement gate is static, so it is written with the matrices and re-uploaded only when
    // a handoff rewrites this segment. A whole-map surface reads it so every canonical asset keeps
    // its own authored cutoff over the shared atlas. See {@link IFarSegment.cull}.
    const cull = aggregate.mesh.geometry.getAttribute(IMPOSTOR_FAR_CULL_ATTRIBUTE) as
      | InstancedBufferAttribute
      | undefined;
    if (cull !== undefined) {
      (cull.array as Float32Array).fill(segment.cull, segment.start, segment.start + segment.count);
      cull.needsUpdate = true;
    }
    aggregate.uploads += 1;
    this.#farBoundsStale(aggregate);
  }

  /**
   * Zero one segment's records: the run is drawn by the near ring now, not the far mesh. Each record
   * keeps a homogeneous `w` of 1 while its xyz/scale terms collapse to 0, so the instance projects
   * to the origin and draws nothing. An all-zero record would leave `w = 0`, and Three's
   * `Box3.applyMatrix4` divides by it, so `computeBoundingBox` over the shared buffer would return
   * NaN and every caster in the aggregate would be dropped by the shadow levels.
   */
  #zeroFarSegment(aggregate: IFarAggregate, segment: IFarSegment): void {
    const array = aggregate.mesh.instanceMatrix.array as Float32Array;
    const from = segment.start * 16;
    const to = (segment.start + segment.count) * 16;
    array.fill(0, from, to);
    for (let at = from; at < to; at += 16) array[at + 15] = 1;
    aggregate.mesh.instanceMatrix.needsUpdate = true;
    aggregate.uploads += 1;
    this.#farBoundsStale(aggregate);
  }

  /**
   * A far matrix write changes the mesh's instance extent, so drop the cached pair and let Three
   * rebuild it on the next read; this is the native `null` convention `computeBoundingBox` honors.
   */
  #farBoundsStale(aggregate: IFarAggregate): void {
    aggregate.mesh.boundingBox = null;
    aggregate.mesh.boundingSphere = null;
  }

  /** The near ring has attached this run's full representation; the far mesh stops drawing it. */
  disableFar(run: IWorldRun): void {
    const aggregate = this.#farSegments.get(run);
    if (aggregate === undefined) return;
    const segment = aggregate.segments.get(run);
    if (segment === undefined || segment.live === false) return;
    this.#zeroFarSegment(aggregate, segment);
    segment.live = false;
  }

  /** This run is leaving the ring; the far mesh draws it again before the near batches are cleared. */
  restoreFar(run: IWorldRun): void {
    const aggregate = this.#farSegments.get(run);
    if (aggregate === undefined) return;
    const segment = aggregate.segments.get(run);
    if (segment === undefined || segment.live === true) return;
    this.#writeFarSegment(aggregate, segment);
    segment.live = true;
  }

  /**
   * Hand over every run of an aggregate a resident cell already draws. A run is near-ready exactly
   * when the cell holds one of its batches; the whole job is attached in one swap, so presence is the
   * answer. This is the build-time half of the atomic handoff; `#swap` is the per-frame half.
   */
  #syncFarSegments(aggregate: IFarAggregate): void {
    for (const segment of aggregate.segments.values()) {
      if (segment.live === false) continue;
      const resident = this.#host.residentCell(cellKey(segment.cell.x, segment.cell.z));
      if (resident === undefined) continue;
      if (!resident.batches.some((entry) => entry.run === segment.run)) continue;
      this.#zeroFarSegment(aggregate, segment);
      segment.live = false;
    }
  }

  /** An aggregate's live and near-owned instance counts. */
  #farSplit(aggregate: IFarAggregate): { live: number; nearOwned: number } {
    let live = 0;
    let nearOwned = 0;
    for (const segment of aggregate.segments.values()) {
      if (segment.live) live += segment.count;
      else nearOwned += segment.count;
    }
    return { live, nearOwned };
  }

  /** The far block {@link stats} reports: aggregates, physical instances/bytes and their split. */
  #farStats(): IWorldCellsStats["impostor"]["far"] {
    let instances = 0;
    let live = 0;
    let nearOwned = 0;
    let uploads = 0;
    for (const aggregate of this.#far.values()) {
      instances += aggregate.capacity;
      uploads += aggregate.uploads;
      const split = this.#farSplit(aggregate);
      live += split.live;
      nearOwned += split.nearOwned;
    }
    return {
      aggregates: this.#far.size,
      bytes: this.#farBytes,
      instances,
      live,
      nearOwned,
      uploads,
    };
  }

  /** Dispose every far aggregate: its own mesh and surface, and its borrowed atlas user. */
  #drainFar(): void {
    for (const aggregate of this.#far.values()) {
      aggregate.mesh.removeFromParent();
      aggregate.mesh.dispose();
      aggregate.surface.dispose();
      aggregate.record.users = Math.max(0, aggregate.record.users - 1);
    }
    this.#far.clear();
    this.#farSegments.clear();
    this.#farInstances = 0;
    this.#farBytes = 0;
  }

  /** Retry the handoffs a frame's fresh-mesh allowance deferred; one bounded pass per update. */
  retryWide(): void {
    if (this.#wideRetry.size === 0) return;
    const ids = [...this.#wideRetry];
    this.#wideRetry.clear();
    for (const id of ids) {
      const asset = this.#host.asset(id);
      if (asset === undefined || asset.impostor === undefined) continue;
      this.#host.retargetWideCasters(asset);
    }
  }

  /** The impostor block {@link stats} reports: assets landed, bakes pending, atlas bytes, terminal tris. */
  impostorStats(): IWorldCellsStats["impostor"] {
    let assets = 0;
    let terminalTriangles = 0;
    for (const asset of this.#host.assets()) {
      if (asset.impostor === undefined) continue;
      assets += 1;
      terminalTriangles += levelTriangles(asset.impostor.part.geometry);
    }
    return {
      assets,
      atlasBytes: this.#impostorRecordBytes,
      budgetBytes: this.#impostorBudgetBytes,
      far: this.#farStats(),
      pending: this.#impostorQueue.length + (this.#impostorBaking === undefined ? 0 : 1),
      terminalTriangles,
    };
  }

  /** Drop queued/baking work for an asset whose source geometry is about to be released. */
  cancelImpostor(asset: IAssetState): void {
    this.#impostorQueued.delete(asset.id);
    const at = this.#impostorQueue.indexOf(asset);
    if (at >= 0) this.#impostorQueue.splice(at, 1);
    if (this.#impostorBaking === asset) {
      // Before the borrowed source geometry is released: the baker stages it, and a view drawn after
      // the teardown reads a disposed buffer.
      this.#baker.abort();
      this.#impostorBaking = undefined;
      this.#impostorReservedBytes = 0;
    }
  }

  /** Release an asset's terminal level and give its atlas back to the cache; see `#release`. */
  releaseImpostor(asset: IAssetState): void {
    const impostor = asset.impostor;
    if (impostor === undefined) return;
    asset.impostor = undefined;
    // Marked first, so `#releaseParts` skips the part whose geometry and material the surface owns.
    this.#host.markReleasedPart(impostor.part);
    dropPooledFor(impostor.part.geometry, impostor.part.material);
    impostor.surface.dispose();
    impostor.record.users = Math.max(0, impostor.record.users - 1);
    this.#evictImpostors();
  }

  /**
   * Drop the oldest inactive atlases until the cache is back under budget; active ones are kept.
   *
   * `reserve` is the declared bytes of a bake about to start: the caller asks whether evicting
   * inactive records can make room for it. A record with a live user is never dropped, so a full
   * cache of active atlases simply leaves the reservation unmet and the caller refuses the bake.
   */
  #evictImpostors(reserve = 0): void {
    if (this.#impostorRecordBytes + reserve <= this.#impostorBudgetBytes) return;
    for (const [key, record] of [...this.#impostorRecords]) {
      if (this.#impostorRecordBytes + reserve <= this.#impostorBudgetBytes) break;
      if (record.users > 0) continue;
      this.#impostorRecords.delete(key);
      this.#impostorRecordBytes -= record.bytes;
      record.atlas.dispose();
    }
  }

  /** Dispose every cached atlas and any in-flight bake; the world's teardown path calls it once. */
  drainImpostors(): void {
    // Far-only sources no cell run owns would otherwise never reach `#evict`; release them here so
    // their geometry goes the way every near asset's does.
    for (const id of [...this.#farTemp]) this.#host.release(id);
    this.#farTemp.clear();
    // Deferred far cohorts own a surface and pin an atlas user; release both before the records are
    // disposed below, so no surface is left pointing at a disposed atlas.
    for (const entry of this.#farRetry.values()) {
      entry.surface.dispose();
      entry.record.users = Math.max(0, entry.record.users - 1);
    }
    this.#farRetry.clear();
    this.#farSeen.clear();
    // The far aggregates own surfaces over these atlases and hold a user on their records; they go
    // first, so no far surface is left pointing at an atlas disposed below it.
    this.#drainFar();
    this.#impostorQueue.length = 0;
    this.#impostorQueued.clear();
    this.#impostorBaking = undefined;
    this.#impostorReservedBytes = 0;
    this.#baker.dispose();
    for (const record of this.#impostorRecords.values()) record.atlas.dispose();
    this.#impostorRecords.clear();
    this.#impostorRecordBytes = 0;
  }

  /**
   * `TN_WORLD_IMPOSTOR`, one bounded line per asset: its terminal level, the metres it takes over at,
   * the views the atlas holds, its GPU bytes, and — when the world can name it — why it did not land.
   */
  #reportImpostor(asset: IAssetState, reason: string): void {
    if (this.#impostorReported.has(asset.id)) return;
    this.#impostorReported.add(asset.id);
    const impostor = asset.impostor;
    const atlas = impostor?.record.atlas ?? this.#baker.pending?.atlas;
    console.info(
      `${WORLD_IMPOSTOR_MARKER} asset=${asset.id} level=${String(asset.levels.length - 1)} ` +
        `switch=${(asset.distances.at(-1) ?? 0).toFixed(1)} ` +
        `views=${String(atlas === undefined ? 0 : IMPOSTOR_VIEWS)} ` +
        `bytes=${String(atlas?.bytes ?? 0)} reason=${reason}`,
    );
  }
}

export const PLACEMENT_RECORD_BYTES = 32;

export const PLACEMENT_RECORD_FLOATS = 8;

/**
 * The distance a `maxDistance` prop actually culls at, one eighth short of itself: the slack
 * `#addPlacements` leaves, so a follow point that has not moved a whole eighth of the cull distance
 * cannot have culled a placement it had not already culled.
 */
export function cullDistance(maxDistance: number | undefined): number | undefined {
  return maxDistance === undefined ? undefined : maxDistance - maxDistance / 8;
}
