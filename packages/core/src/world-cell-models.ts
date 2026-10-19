import { type BufferGeometry, type Material, Matrix4, Mesh, Object3D, SkinnedMesh } from "three";
import { type IAssetLoader, createAssetLoader } from "./assets.js";
import { type ILodChain, lodChainOf } from "./model-lod.js";
import { displacesVertices } from "./projection-plan.js";
import { cutoutSurface } from "./render/foliage-alpha.js";
import { materialKey } from "./render/material-key.js";
import { dropPooledFor } from "./render/mesh-pool.js";
import { levelTriangles, release, resolveRelative } from "./world-cell-chunks.js";
import type { IAssetPart, IResidentCell, IWorldCellsLoadOptions } from "./world-cell-data.js";
import { positiveInteger } from "./world-cell-data.js";
import {
  DEFAULT_CUTOUT_ALPHA,
  type IImpostorState,
  cullDistance,
  isAlphaFoliage,
} from "./world-cell-impostors.js";
import { cellProxySourceSafe } from "./world-cell-proxy.js";
import { worldOwned } from "./world-chunk-shadow.js";
import { ModelLoadLimiter } from "./world-load-limiter.js";
import type { IWorldAsset, IWorldPackage, IWorldRun } from "./world-package.js";

/** A surface every part with the same material content draws with, and who still uses it. */
interface ISharedSurface {
  readonly material: Material;
  /** The canonical source and any cutout made from it, torn down with the last user. */
  readonly owned: readonly Material[];
  users: number;
}

export interface IAssetState {
  readonly id: string;
  readonly definition: IWorldAsset;
  /**
   * The distance at which each level takes over, index-aligned with `glbs`; level 0 never does.
   *
   * Mutable because a chain is only known once the asset's own model has loaded: an asset with no
   * authored `lods` is widened with the levels that model's baked chain carries, and every consumer
   * of this reads it at build time — after `#adoptAsset` — so nothing has to be rebuilt.
   */
  distances: readonly number[];
  /** The package-relative GLB per level, index-aligned with `distances`. */
  readonly glbs: readonly string[];
  /** Every distance the level or cull answer changes at, `threshold` being the nearest. */
  gates: readonly number[];
  /** The nearest distance this asset's batching can be crossed at, or `undefined` when it cannot. */
  threshold: number | undefined;
  refcount: number;
  hlodSafe: boolean;
  pending: boolean;
  failed: boolean;
  disposed: boolean;
  /**
   * The exact `assets.model` cache paths this state asked the loader for, held in `#modelPaths`
   * until the last state naming each one is released. Empty when `loadModel` bypasses the cache;
   * filled once per state, so a load retried after an empty answer does not count twice.
   */
  retainedPaths: string[];
  /**
   * One part list per entry in `glbs`, so a level that failed to load reuses the level below it and
   * the batch builder never has to know a level is missing.
   */
  levels: readonly (readonly IAssetPart[])[];
  /**
   * Parts taken out of DRAW but still owned here until teardown. Authored levels now keep their own
   * geometry, so this stays empty; it is drained once with the asset on release.
   */
  spilled: readonly IAssetPart[];
  /**
   * The loader's resolved cooked url for LOD0, recorded at load. It is the atlas cache key's model
   * half, so two package entries that fetch the same cooked bytes share one bake even when their
   * `lods`/`maxDistance` metadata stopped them aliasing. See `#impostorKey`.
   */
  resolvedGlb: string;
  /** The whole-asset impostor level this asset appended, once its bake landed. See `#finishImpostor`. */
  impostor?: IImpostorState;
}

export async function loadModelWith(assets: IAssetLoader, path: string): Promise<Object3D> {
  const gltf = await assets.model<{ scene?: Object3D }>(path);
  const scene = gltf?.scene;
  if (!(scene instanceof Object3D))
    throw new Error(`World asset '${path}' loaded without an Object3D scene.`);
  return scene;
}

/**
 * Mip compensation for scattered foliage. Golus's 0.25 suits dense cards; a needle atlas at ~9 %
 * coverage averages to ~0.09 alpha by mip 8, where a tree 150 m out samples, so 0.25 still drops
 * every needle. 0.75 keeps the cutoff under that average through mip 8.
 * ponytail: one tuned constant; coverage-preserving mips at cook time are the upgrade path.
 */
const SCATTER_MIP_ALPHA_SCALE = 0.75;

/**
 * The surface a scattered part draws with, and the cutout this class owns when it made one.
 *
 * An `InstancedMesh` cannot sort its instances, so a `transparent` material on scattered foliage
 * draws in submission order — wrong against itself, and overdraw on top of it. A cutout keeps the
 * part's own alpha shape, keeps the depth buffer, and lets the draw reject what is behind it. The
 * GLB's material is never mutated: the cutout is per asset part, so every cell batch of the asset
 * shares one and a game that still wants blending asks for it.
 *
 * The cutout itself is `cutoutSurface`, because a cutout that ignores the mip chain deletes itself
 * at distance: the needle card's mips average to a tenth, and every needle is discarded.
 */
function scatterMaterial(
  material: Material,
  transparentScatter: "cutout" | "blend",
): { readonly material: Material; readonly owned: readonly Material[] } {
  if (transparentScatter === "blend" || !material.transparent)
    return { material, owned: [material] };
  const cutout = cutoutSurface(
    material,
    material.alphaTest > 0 ? material.alphaTest : DEFAULT_CUTOUT_ALPHA,
    SCATTER_MIP_ALPHA_SCALE,
  );
  // The authored material is owned too: the batch draws the cutout, and the GLB's own surface is
  // still this asset's to hand back.
  worldOwned.add(cutout);
  return { material: cutout, owned: [material, cutout] };
}

/**
 * Every drawable part of a loaded model: one per `Mesh`, each with its shape, its surface, and
 * where it sits relative to the model root.
 *
 * A GLB authored as a tree — bark `OPAQUE`, needles `BLEND` — is one node carrying one mesh with
 * two primitives, which three loads as a `Group` of one child `Mesh` per primitive. Taking only the
 * first of those drew 62k bare trunks, so every one of them is a part and each keeps its own
 * material.
 *
 * `SkinnedMesh` is skipped deliberately: its vertices are posed per frame from a skeleton, and one
 * `InstancedMesh` of the geometry would draw the rest pose once per placement. `Points` and
 * `LineSegments` are not `Mesh`es and are skipped with them.
 */
function renderableParts(
  model: Object3D,
  surfaceFor: (material: Material) => { readonly key: string; readonly material: Material },
): readonly IAssetPart[] {
  model.updateMatrixWorld(true);
  const rootInverse = new Matrix4().copy(model.matrixWorld).invert();
  const local = new Matrix4();
  const parts: IAssetPart[] = [];
  model.traverse((object: Object3D) => {
    if (object instanceof SkinnedMesh || !(object instanceof Mesh)) return;
    const material = Array.isArray(object.material) ? object.material[0] : object.material;
    if (object.geometry === undefined || material === undefined) return;
    const surface = surfaceFor(material);
    parts.push({
      geometry: object.geometry,
      local: local.multiplyMatrices(rootInverse, object.matrixWorld).clone(),
      material: surface.material,
      surface: surface.key,
    });
  });
  return parts;
}

function disposeModel(model: Object3D): number {
  let failed = 0;
  model.traverse((object: Object3D) => {
    if (!(object instanceof Mesh)) return;
    if (release(object.geometry)) failed += 1;
    const materials: Material[] = Array.isArray(object.material)
      ? object.material
      : [object.material];
    // A world-owned surface is one chunk's proxy material, and the next chunk's teardown would
    // otherwise release a material this world's remaining proxies are still drawing with. It is
    // released with the world that owns it; see `WorldCells#dispose`.
    for (const material of materials)
      if (!worldOwned.has(material) && release(material)) failed += 1;
  });
  return failed;
}

/**
 * The levels one asset is drawn at, and the distances its batching can be crossed at.
 *
 * Level 0 is the asset's own `glb` and never switches; `lods[i - 1].distance` is where an instance
 * that far out draws `lods[i]` instead. A `lods` entry at or beyond the cull distance is dropped:
 * an instance that far out is culled, so its shape can never be drawn. `gates` is every distance
 * the level or cull answer changes at — `threshold` is the nearest of them, so a follow point that
 * has moved an eighth of it may have moved an instance either way.
 */
function assetLevels(definition: IWorldAsset): {
  readonly distances: readonly number[];
  readonly gates: readonly number[];
  readonly glbs: readonly string[];
  readonly threshold: number | undefined;
} {
  const maxDistance = definition.maxDistance;
  const distances: number[] = [0];
  const glbs: string[] = [definition.glb];
  const gates: number[] = [];
  for (const lod of definition.lods ?? []) {
    // A level at or beyond the cull distance is never drawn: an instance that far out is gone by
    // the time the level would take over, so its GLB is never asked for.
    if (maxDistance !== undefined && lod.distance >= maxDistance) continue;
    distances.push(lod.distance);
    glbs.push(lod.glb);
    gates.push(lod.distance);
  }
  const cull = cullDistance(maxDistance);
  if (cull !== undefined) gates.push(cull);
  return {
    distances,
    gates,
    glbs,
    threshold: gates.length === 0 ? undefined : Math.min(...gates),
  };
}

/**
 * The batched shape of one definition, as the loader will actually fetch it: the url the manifest
 * gives its `glb`, the url and switch distance of every `lods` entry in order, its `maxDistance` and
 * its bounds. Two definitions that agree on all of it are the same draw — same geometry, same
 * materials, same levels, same gates — so one model serves both and their placements batch together.
 *
 * `undefined` when the loader cannot resolve a path at all: a path the manifest does not list makes
 * `resolve` throw, and the load that asks for it will say so. Such a definition never aliases,
 * which is the same behaviour it has today.
 */
async function assetSignature(
  assets: IAssetLoader,
  definition: IWorldAsset,
  logicalBase: string,
): Promise<string | undefined> {
  const url = async (glb: string): Promise<string> => {
    const candidates = await assets.resolve(resolveRelative(logicalBase, glb));
    return candidates[0] ?? glb;
  };
  try {
    const parts = [await url(definition.glb)];
    for (const lod of definition.lods ?? [])
      parts.push(`${await url(lod.glb)}@${String(lod.distance)}`);
    parts.push(
      definition.maxDistance === undefined ? "" : String(definition.maxDistance),
      definition.impostorDistance === undefined ? "" : String(definition.impostorDistance),
      definition.bounds.min.join(","),
      definition.bounds.max.join(","),
    );
    return parts.join("|");
  } catch {
    return undefined;
  }
}

/**
 * `alias id -> canonical id` for every definition that is another name for the same cooked model,
 * which is what a 374-asset package with 273 duplicates is: one model exported under many object
 * names, cooked once and fetched once.
 *
 * The canonical is the lexicographically smallest id of the group, so it does not depend on the
 * order the exporter happened to write them in. An empty map — every definition its own model, or a
 * package whose paths resolve to nothing — leaves the whole runtime exactly as it is.
 */
export async function assetAliases(
  assets: IAssetLoader,
  manifest: IWorldPackage,
  logicalBase: string,
): Promise<ReadonlyMap<string, string>> {
  const canonicalBySignature = new Map<string, string>();
  const aliases = new Map<string, string>();
  // Sorted, so the first id to claim a signature is the smallest one in its group.
  for (const id of Object.keys(manifest.assets).sort()) {
    const definition = manifest.assets[id];
    if (definition === undefined) continue;
    const signature = await assetSignature(assets, definition, logicalBase);
    if (signature === undefined) continue;
    const canonical = canonicalBySignature.get(signature);
    if (canonical === undefined) canonicalBySignature.set(signature, id);
    else aliases.set(id, canonical);
  }
  return aliases;
}

/** What a baked chain gives a batched draw: the extra levels, where they take over, what they cost. */
interface IChainLevels {
  /** Index-aligned with `distances`; index 0 is the parts the asset already had. */
  readonly levels: (readonly IAssetPart[])[];
  /** `distances[0]` is 0 and never switches; the rest are the synthesized switch distances. */
  readonly distances: number[];
  /** Triangles every level submits, all its parts together, index-aligned with `levels`. */
  readonly triangles: number[];
}

/**
 * The extra levels an asset's baked AutoLOD chain gives a batched draw, or `undefined` when none of
 * its parts carries a chain.
 *
 * A `ModelLod` swaps one mesh's geometry, so a world that batches thousands of placements of one
 * model into a handful of instanced draws never reaches that selection: every placement drew
 * LOD0, which on a 2 km map is the whole triangle bill at every distance. The chain already holds
 * the reduced shapes, so this derives the levels a batch can hold and the distance each one takes
 * over at — the same screen-space test `ModelLod` runs, solved for depth:
 * `error * pixelsPerUnit / maxPixelError`, with each part's own registered budget.
 *
 * Level `i` is `chain.levels[min(i, length - 1)]` per part, so a part without a chain — and one
 * whose chain ran out below `i` — keeps the shape above it. The switch distances come from the
 * parts that descend the furthest, the **max** across those at each level, so the deepest chain's
 * whole ladder survives. A part with a shallower chain clamps to its last level and does not set a
 * switch: it cannot be drawn finer there anyway, so its error must not push the switch past the
 * deepest chain's own last error and collapse the ladder to one far step.
 */
function chainDistances(
  chains: readonly (ILodChain | undefined)[],
  pixelsPerUnit: number,
  maxPixelError: number,
  maxDistance: number | undefined,
): number[] {
  let deepest = 1;
  for (const chain of chains)
    if (chain !== undefined) deepest = Math.max(deepest, chain.levels.length);
  const distances = [0];
  for (let level = 1; level < deepest; level += 1) {
    let error = 0;
    for (const chain of chains) {
      // Only the parts that descend the furthest set the schedule. A part whose chain ran out has
      // no finer shape to offer past its last level, so letting its — often terminal, and so huge —
      // error gate this switch cannot buy that part any detail back. It would only deny every
      // sibling the coarser level and collapse the chain to a single far switch, which is how a
      // bark primitive's 2-level chain truncated a pine's 4-level needles chain to two levels.
      if (chain === undefined || chain.levels.length !== deepest) continue;
      error = Math.max(error, chain.errors[level] ?? 0);
    }
    const at = (error * pixelsPerUnit) / maxPixelError;
    // A chain's errors only ascend, so a switch that does not move outward — or that lands at or
    // past the cull — ends the list: every level above it is further out still, and none of them
    // can be selected or drawn. That keeps the thresholds strictly increasing and inside
    // `maxDistance`, exactly as `assetLevels` keeps authored ones.
    if (at <= (distances[level - 1] as number)) break;
    if (maxDistance !== undefined && at >= maxDistance) break;
    distances.push(at);
  }
  return distances;
}

/** One level's parts, and what they submit: the chain's shape where it has one, the one above where not. */
function chainLevelParts(
  parts: readonly IAssetPart[],
  chains: readonly (ILodChain | undefined)[],
  level: number,
): { readonly parts: IAssetPart[]; readonly triangles: number } {
  const at: IAssetPart[] = [];
  let triangles = 0;
  for (const [index, part] of parts.entries()) {
    const chain = chains[index];
    // A part with no chain keeps its own shape, in its own slot: the batch builder and
    // `#addPlacements` index every level's parts by the same number.
    const geometry =
      chain === undefined
        ? part.geometry
        : (chain.levels[Math.min(level, chain.levels.length - 1)] as BufferGeometry);
    at.push(geometry === part.geometry ? part : { ...part, geometry });
    triangles += levelTriangles(geometry);
  }
  return { parts: at, triangles };
}

/**
 * The extra levels an asset's baked AutoLOD chain gives a batched draw, or `undefined` when none of
 * its parts carries a chain.
 *
 * A `ModelLod` swaps one mesh's geometry, so a world that batches thousands of placements of one
 * model into a handful of instanced draws never reaches that selection: every placement drew
 * LOD0, which on a 2 km map is the whole triangle bill at every distance. The chain already holds
 * the reduced shapes, so this derives the levels a batch can hold and the distance each one takes
 * over at — the same screen-space test `ModelLod` runs, solved for depth:
 * `error * pixelsPerUnit / maxPixelError`, over the world's own `autoLod.maxPixelError` rather than
 * the budget the loader registered the chain with. See
 * {@link IWorldCellsLoadOptions.autoLod} for why a batch cannot use the registered one.
 *
 * Level `i` is `chain.levels[min(i, length - 1)]` per part, so a part without a chain — and one
 * whose chain ran out below `i` — keeps the shape above it. The switch distances come from the
 * parts that descend the furthest, the **max** across those at each level, so the deepest chain's
 * whole ladder survives. A part with a shallower chain clamps to its last level and does not set a
 * switch: it cannot be drawn finer there anyway, so its error must not push the switch past the
 * deepest chain's own last error and collapse the ladder to one far step.
 */
/** Prepared sources may have replaced attributes or cut a material section after cloning. */
function preparedChainSafe(part: IAssetPart): boolean {
  const base = part.geometry;
  const chain = lodChainOf(base);
  if (chain === undefined) return true;
  if (
    base.drawRange.start !== 0 ||
    base.drawRange.count !== Number.POSITIVE_INFINITY ||
    base.groups.length > 0 ||
    part.material.transparent ||
    part.material.alphaTest > 0 ||
    displacesVertices(part.material) ||
    Reflect.get(part.material, "vertexNode") != null
  )
    return false;
  const names = Object.keys(base.attributes);
  return chain.levels.every(
    (level) =>
      Object.keys(level.attributes).length === names.length &&
      names.every((name) => level.getAttribute(name) === base.getAttribute(name)),
  );
}

function chainLevels(
  parts: readonly IAssetPart[],
  pixelsPerUnit: number,
  maxPixelError: number,
  maxDistance: number | undefined,
): IChainLevels | undefined {
  const chains: (ILodChain | undefined)[] = [];
  for (const part of parts) chains.push(lodChainOf(part.geometry));
  const distances = chainDistances(chains, pixelsPerUnit, maxPixelError, maxDistance);
  if (distances.length === 1) return undefined;
  const levels: (readonly IAssetPart[])[] = [parts];
  // Level 0 leads, so the marker opens with what the asset submits today.
  const triangles: number[] = [parts.reduce((sum, part) => sum + levelTriangles(part.geometry), 0)];
  for (let level = 1; level < distances.length; level += 1) {
    const at = chainLevelParts(parts, chains, level);
    levels.push(at.parts);
    triangles.push(at.triangles);
  }
  return { distances, levels, triangles };
}

/**
 * The DRAW levels an authored asset gets: every level keeps the geometry, transform and surface it
 * authored, and the root LOD0's alpha-cutout parts are appended to a level that authored fewer alpha
 * slots than the root carries, so no middle level loses leaves its reduced card cannot honestly
 * represent.
 *
 * An authored reduced foliage card has no honest twin — the automatic reducer's error metric cannot
 * see the holes a cutout silhouette is made of — but a level that authored such a card keeps it:
 * only the slots a level carries none of fall back to the root, in the root's own per-role order, so
 * a middle with one reduced card and a root with two gets its own card plus the root's second. The
 * fallback parts are appended after the level's authored parts, never reordered, so each level keeps
 * its own part indices and counts. Nothing is spilled: a fallback shares the root part by reference,
 * so one resource is still one teardown.
 */
function coverAuthoredLevels(
  levels: readonly (readonly IAssetPart[])[],
): readonly (readonly IAssetPart[])[] {
  const rootAlpha = (levels[0] ?? []).filter((part) => isAlphaFoliage(part.material));
  if (rootAlpha.length === 0 || levels.length < 2) return levels;
  const covered: (readonly IAssetPart[])[] = [levels[0] as readonly IAssetPart[]];
  for (const parts of levels.slice(1)) {
    let authoredAlpha = 0;
    for (const part of parts) if (isAlphaFoliage(part.material)) authoredAlpha += 1;
    if (authoredAlpha >= rootAlpha.length) {
      covered.push(parts);
      continue;
    }
    const mapped: IAssetPart[] = [...parts];
    for (let slot = authoredAlpha; slot < rootAlpha.length; slot += 1)
      mapped.push(rootAlpha[slot] as IAssetPart);
    covered.push(mapped);
  }
  return covered;
}

/**
 * Model loads in flight for a streamed world. `loadAll`'s six suits a scene's one-off load; a
 * world crossing new asset types as it moves spends most of each load waiting on the network and
 * the transcoder workers, so more in flight keeps the ring ahead of a fast camera.
 */
const WORLD_LOAD_CONCURRENCY = 12;

/**
 * Assets reported one by one before the `TN_WORLD_LOD_CHAIN` marker collapses into a single line.
 * A 2 km package carries hundreds of chained assets, and a console line each is a wall of text that
 * buries the one that matters.
 */
const CHAIN_LOD_MARKER_LIMIT = 20;
export interface ICellModelsHost {
  canonical(id: string): string;
  noteGate(gate: number): void;
  queueBuild(asset: IAssetState, cell: IResidentCell, run: IWorldRun, force?: boolean): void;
  released(): boolean;
  failures(): number;
  setFailures(count: number): void;
  reportCellFailure(
    stage: "asset" | "attach" | "chunk",
    key: string,
    paths: readonly string[],
    error: unknown,
  ): void;
  drainShared(assetId: string): number;
  residentCells(): Iterable<IResidentCell>;
  queuePrewarm(asset: IAssetState): void;
  hasFarTemp(id: string): boolean;
  releaseFarTemp(id: string): void;
  maybeQueueImpostor(asset: IAssetState): void;
  hasQueuedImpostor(id: string): boolean;
  cancelImpostor(asset: IAssetState): void;
  releaseImpostor(asset: IAssetState): void;
}
export interface ICellModelsSettings {
  readonly lodHysteresis: number;
  readonly manifest: IWorldPackage;
  readonly baseUrl: string;
  readonly logicalBase: string;
  readonly preserveAuthoredParts: boolean;
  readonly autoLodPixelsPerUnit: number;
  readonly autoLodMaxPixelError: number;
  readonly transparentScatter: "cutout" | "blend";
}

export class CellModels {
  readonly #host: ICellModelsHost;

  /** Parts already handed back, so a level that fell back to the one above releases it once. */
  static readonly #releasedParts = new WeakSet<IAssetPart>();

  readonly #loader: IAssetLoader;

  /**
   * Whether {@link #loader} was created here rather than supplied by the game. Only an internally
   * owned loader may have its `model` cache released when this world's last cell stops naming a
   * path: an explicitly supplied loader is the caller's, another world may hold the same cached
   * model, and its own `release` is the caller's to call. See `#releaseModelPaths`.
   */
  readonly #ownsLoader: boolean;

  readonly #loadModel: ((url: string) => Promise<Object3D>) | undefined;

  readonly #limiter: ModelLoadLimiter;

  readonly #assets = new Map<string, IAssetState>();

  /**
   * Exact `assets.model` cache paths this world holds, and how many of its asset states ask for
   * each. Two distinct canonical assets can name the same path when their `lods`/`maxDistance`
   * differ — the package's own aliasing leaves them separate — so the loader entry is released only
   * when the last state naming the path goes. Keyed on the logical path requested, which is what the
   * loader caches by, not the cooked url it resolves to. Empty under a `loadModel` override, which
   * reaches no cache.
   */
  readonly #modelPaths = new Map<string, number>();

  /** Surfaces shared by material content across every asset part; see `materialKey`. */
  readonly #surfaces = new Map<string, ISharedSurface>();

  /** Assets widened by their own chain so far, and whether the marker has already collapsed. */
  #chainLodAssets = 0;

  #chainLodSummarised = false;

  readonly #lodHysteresis: number;

  readonly #manifest: IWorldPackage;

  readonly #baseUrl: string;

  readonly #logicalBase: string;

  readonly #preserveAuthoredParts: boolean;

  /**
   * Pixels per world unit at unit depth, the scale a baked chain's level errors are divided by to
   * reach a switch distance. See `IWorldCellsLoadOptions.autoLod` and {@link chainLevels}.
   */
  readonly #autoLodPixelsPerUnit: number;

  /** The screen-space error budget a synthesized level is switched at; see `autoLod`. */
  readonly #autoLodMaxPixelError: number;

  readonly #transparentScatter: "cutout" | "blend";
  constructor(
    init: Pick<IWorldCellsLoadOptions, "assets" | "loadModel" | "concurrency"> & {
      readonly ownsAssets?: boolean;
    },
    settings: ICellModelsSettings,
    host: ICellModelsHost,
  ) {
    this.#host = host;
    this.#lodHysteresis = settings.lodHysteresis;
    this.#manifest = settings.manifest;
    this.#baseUrl = settings.baseUrl;
    this.#logicalBase = settings.logicalBase;
    this.#preserveAuthoredParts = settings.preserveAuthoredParts;
    this.#autoLodPixelsPerUnit = settings.autoLodPixelsPerUnit;
    this.#autoLodMaxPixelError = settings.autoLodMaxPixelError;
    this.#transparentScatter = settings.transparentScatter;
    this.#loader = init.assets ?? createAssetLoader();
    this.#ownsLoader = init.ownsAssets ?? init.assets === undefined;
    this.#loadModel = init.loadModel;
    this.#limiter = new ModelLoadLimiter(
      positiveInteger(init.concurrency ?? WORLD_LOAD_CONCURRENCY, "concurrency"),
    );
  }
  get loadModel(): ((url: string) => Promise<Object3D>) | undefined {
    return this.#loadModel;
  }

  cloneAssets(): { readonly assets: IAssetLoader; readonly ownsAssets: boolean } {
    return {
      assets: this.#ownsLoader ? createAssetLoader() : this.#loader,
      ownsAssets: this.#ownsLoader,
    };
  }
  get loadsInFlight(): number {
    return this.#limiter.inFlight;
  }
  get loadsQueued(): number {
    return this.#limiter.queued;
  }
  load(path: string, wanted: () => boolean): Promise<Object3D | undefined> {
    return this.#limiter.load(() => this.model(path), wanted);
  }
  asset(id: string): IAssetState | undefined {
    return this.#assets.get(id);
  }
  hasAsset(id: string): boolean {
    return this.#assets.has(id);
  }
  assets(): Iterable<IAssetState> {
    return this.#assets.values();
  }
  entries(): Iterable<[string, IAssetState]> {
    return this.#assets.entries();
  }
  pathUsers(path: string): number {
    return this.#modelPaths.get(path) ?? 0;
  }
  markReleasedPart(part: IAssetPart): void {
    CellModels.#releasedParts.add(part);
  }

  /** One fresh asset state for a definition, registered and its gates noted. */
  newAsset(id: string, definition: IWorldAsset): IAssetState {
    const asset: IAssetState = {
      ...assetLevels(definition),
      definition,
      disposed: false,
      id,
      levels: [],
      pending: false,
      failed: false,
      refcount: 0,
      hlodSafe: false,
      retainedPaths: [],
      resolvedGlb: "",
      spilled: [],
    };
    this.ditherGates(asset);
    this.#assets.set(id, asset);
    for (const gate of asset.gates) this.#host.noteGate(gate);
    return asset;
  }

  acquire(run: IWorldRun, cell: IResidentCell): void {
    const id = this.#host.canonical(run.asset);
    let asset = this.#assets.get(id);
    if (asset === undefined) {
      const definition = this.#manifest.assets[id];
      if (definition === undefined) return;
      asset = this.newAsset(id, definition);
    }
    asset.refcount += 1;
    if (asset.levels.length > 0) {
      this.#host.queueBuild(asset, cell, run);
      return;
    }
    if (!asset.pending) this.startAssetLoad(asset);
  }

  /**
   * One model, from the loader the package was given. `loadModel` keeps the override and takes the
   * authored url, so a game's own GLB loader is unchanged; without it the logical path goes to
   * `assets.model`, which is what makes a compiled package and its KTX2 textures work.
   */
  model(path: string): Promise<Object3D> {
    return this.#loadModel === undefined
      ? loadModelWith(this.#loader, path)
      : this.#loadModel(resolveRelative(this.#baseUrl, path));
  }

  /**
   * Every level of one asset, through the same limiter and the same resolution as `lod0`, so a
   * package's compiled output and compressed textures reach the renderer the game booted with. One
   * level refusing is not the asset refusing: it is counted and `#adoptAsset` falls back to the
   * level below it, so the far placements still draw.
   */
  startAssetLoad(asset: IAssetState): void {
    asset.pending = true;
    // The source models this state asks `assets.model` for are this world's to hand back; the
    // loader caches by logical path and would otherwise pin every texture for the world's life.
    // Counted once per state, so a load retried after an empty answer does not double-count.
    // `loadModel` overrides the cache entirely, so it retains nothing.
    if (this.#loadModel === undefined && asset.retainedPaths.length === 0) {
      this.retainModelPaths(
        Array.from(asset.glbs, (glb) => resolveRelative(this.#logicalBase, glb)),
        asset.retainedPaths,
      );
    }
    const wanted = (): boolean =>
      !this.#host.released() && this.#assets.get(asset.id) === asset && !asset.disposed;
    // `Promise.all` hands back the levels in `glbs` order, and the limiter is what bounds them: it
    // already caps every load in flight across the resident cells, assets and chunks together.
    const loads: Array<Promise<Object3D | undefined>> = [];
    for (const glb of asset.glbs) {
      const path = resolveRelative(this.#logicalBase, glb);
      loads.push(
        this.#limiter
          .load(() => this.model(path), wanted)
          .catch((error: unknown) => {
            asset.failed = true;
            this.#host.setFailures(this.#host.failures() + 1);
            this.#host.reportCellFailure("asset", asset.id, [path], error);
            return undefined;
          }),
      );
    }
    // The cooked url LOD0 was actually fetched from, resolved the same way `assetSignature` does,
    // so the atlas key names the bytes rather than the package entry. It is needed before adoption,
    // so the two promises are awaited together; a path the loader cannot resolve falls back to the
    // logical url, exactly as `assetSignature`'s caller does.
    const lod0 = resolveRelative(this.#logicalBase, asset.glbs[0] as string);
    const resolved = this.#loader
      .resolve(lod0)
      .then((candidates) => candidates[0] ?? lod0)
      .catch(() => lod0);
    void Promise.all([Promise.all(loads), resolved]).then(([models, url]) => {
      // The state stays, refcount and all, whatever the loads answered: cells still resident are
      // holding it, and the next acquire retries. Dropping it here would let a later cell refcount
      // from zero and hand an eviction of an old cell the geometry a still-resident cell draws.
      asset.resolvedGlb = url;
      asset.pending = false;
      this.#adoptAsset(asset, models);
    });
  }

  /** One loaded model's drawable parts, or `undefined` when it carries nothing to draw. */
  #partsOf(model: Object3D | undefined): readonly IAssetPart[] | undefined {
    if (model === undefined) return undefined;
    const parts = renderableParts(model, (material) => this.#surfaceFor(material));
    if (parts.length === 0) {
      // Same as a refused load: counted, released, and the next acquire retries.
      this.#host.setFailures(this.#host.failures() + 1);
      this.#host.setFailures(this.#host.failures() + this.disposeLoaded(model));
      return undefined;
    }
    return parts;
  }

  /**
   * One part list per loaded model: level 0 is the asset's own shape, and every level below it
   * falls back to the one above when it did not load. `undefined` is the asset refusing to exist —
   * no `lod0` to fall back to — and the levels that did load are released rather than held by an
   * asset that draws nothing, cutout clones included. The refcounted state stays either way, so the
   * next acquire retries.
   */
  #adoptLevels(
    models: readonly (Object3D | undefined)[],
  ): readonly (readonly IAssetPart[])[] | undefined {
    const levels: (readonly IAssetPart[])[] = [];
    for (const [index, model] of models.entries()) {
      const level = this.#partsOf(model) ?? levels[index - 1];
      if (level === undefined) {
        for (const model of models.slice(index))
          this.#host.setFailures(this.#host.failures() + this.disposeLoaded(model));
        for (const parts of levels)
          this.#host.setFailures(this.#host.failures() + this.#releaseParts(parts));
        return undefined;
      }
      levels.push(level);
    }
    return levels;
  }

  /**
   * An asset's levels are in, so every resident cell holding it needs its batches — queued, not
   * built. This is the path that used to be worst: adopting one asset rebuilt every resident cell's
   * batches for it in a single frame, and a 218-asset package pays it over and over as the ring
   * moves. The queue turns it into the same per-frame allowance every other admission path gets.
   */
  #adoptAsset(asset: IAssetState, models: readonly (Object3D | undefined)[]): void {
    if (this.#host.released() || this.#assets.get(asset.id) !== asset || asset.disposed) {
      for (const model of models)
        this.#host.setFailures(this.#host.failures() + this.disposeLoaded(model));
      return;
    }
    asset.hlodSafe = models[0] !== undefined && cellProxySourceSafe(models[0]);
    const adopted = this.#adoptLevels(models);
    if (adopted === undefined) {
      // A far-only asset that would not load has nothing to bake; drop the temporary reference so
      // the source it did fetch is not held for the world's whole life.
      if (this.#host.hasFarTemp(asset.id)) this.#host.releaseFarTemp(asset.id);
      return;
    }
    // Before the prewarm and the queued builds, both of which read the levels, the distances and
    // the gates: an asset whose chain widened it is batched at those levels from its first build.
    asset.levels = this.#widenWithChain(asset, adopted);
    // A far-only asset is drawn by no near run, so it takes no prewarm and queues no cell build:
    // its whole job is the atlas behind the aggregate, and its source is released once that lands.
    if (this.#host.hasFarTemp(asset.id)) {
      this.#host.maybeQueueImpostor(asset);
      // Nothing to bake (no alpha-cutout LOD0) and nothing queued: release the source now.
      if (asset.impostor === undefined && !this.#host.hasQueuedImpostor(asset.id))
        this.#host.releaseFarTemp(asset.id);
      return;
    }
    // After the chain, so the impostor's switch sits beyond every synthesized gate; before the
    // prewarm, so a cached atlas appends its level in this same admission.
    this.#host.maybeQueueImpostor(asset);
    // Every level and part of the asset now, before any of them is asked for. A level with no
    // placement in it is not drawn and would otherwise mint its mesh — and pay its node build — on
    // the frame a walk first moves far enough to switch into it.
    this.#host.queuePrewarm(asset);
    for (const cell of [...this.#host.residentCells()]) {
      for (const run of cell.cell.runs) {
        if (this.#host.canonical(run.asset) === asset.id) this.#host.queueBuild(asset, cell, run);
      }
    }
  }

  /**
   * An asset's loaded levels, widened with the ones its model's baked AutoLOD chain carries.
   *
   * An asset with authored `lods` keeps its own switch distances and its own middle geometry: each
   * level draws the shape the pipeline authored for it, with the root LOD0's alpha cutouts appended
   * to any level that authored fewer of them so no middle loses its leaves; see
   * `coverAuthoredLevels`. A chain the loader also happens to have registered is a fallback for a
   * package that named no `lods`, not a second opinion over one that did. Everything downstream is
   * unchanged either way — a level is a level, and its switch is a gate like any other — so the
   * batch keys, the prewarm, the caster clusters and the retire/rebind pool all see the derived
   * levels as ordinary ones.
   */
  #widenWithChain(
    asset: IAssetState,
    levels: readonly (readonly IAssetPart[])[],
  ): readonly (readonly IAssetPart[])[] {
    if ((asset.definition.lods?.length ?? 0) > 0)
      return this.#preserveAuthoredParts ? levels : coverAuthoredLevels(levels);
    // An empty list names no authored rung. Prepared static parts can use their existing chain,
    // while sectioned/deforming or replaced-attribute copies keep their supplied source shape.
    if (asset.definition.lods !== undefined && !(levels[0] ?? []).every(preparedChainSafe))
      return levels;
    const chained = chainLevels(
      levels[0] as readonly IAssetPart[],
      this.#autoLodPixelsPerUnit,
      this.#autoLodMaxPixelError,
      asset.definition.maxDistance,
    );
    if (chained === undefined) return levels;
    asset.distances = chained.distances;
    asset.gates = [...chained.distances.slice(1), ...asset.gates];
    this.ditherGates(asset);
    this.#reportChainLod(asset.id, chained);
    return chained.levels;
  }

  ditherGates(asset: IAssetState): void {
    const gates = new Set(asset.gates);
    if (this.#lodHysteresis > 0) {
      for (let level = 0; level < asset.distances.length; level += 1) {
        const near = asset.distances[level] ?? 0;
        const far = asset.distances[level + 1] ?? Number.POSITIVE_INFINITY;
        const slack =
          Math.max(near, Number.isFinite(far) ? far : near) * this.#lodHysteresis +
          (asset.distances[1] ?? 6) / 8;
        if (near > slack) gates.add(near - slack);
        if (Number.isFinite(far)) gates.add(far + slack);
      }
    }
    asset.gates = [...gates];
    asset.threshold = asset.gates.length === 0 ? undefined : Math.min(...asset.gates);
    for (const gate of asset.gates) this.#host.noteGate(gate);
  }

  /**
   * `TN_WORLD_LOD_CHAIN`, one line per asset that was widened: how many levels it is now drawn at,
   * where each takes over in metres to one decimal, and what each submits in triangles. Level 0
   * leads, so the first triangle count is what the asset submits today and the last is what it
   * submits past the last switch: the reduction is the whole point of the line.
   */
  #reportChainLod(id: string, chained: IChainLevels): void {
    this.#chainLodAssets += 1;
    if (this.#chainLodAssets > CHAIN_LOD_MARKER_LIMIT) {
      if (this.#chainLodSummarised) return;
      this.#chainLodSummarised = true;
      console.info(
        `TN_WORLD_LOD_CHAIN more than ${String(CHAIN_LOD_MARKER_LIMIT)} assets carry a chain; ` +
          `the rest are one line: assets=${String(this.#chainLodAssets)}`,
      );
      return;
    }
    const listed: string[] = [];
    for (const distance of chained.distances) listed.push(distance.toFixed(1));
    console.info(
      `TN_WORLD_LOD_CHAIN ${id}: levels=${String(chained.levels.length)} ` +
        `distances=${listed.join(",")} tris=${chained.triangles.join(",")}`,
    );
  }

  /**
   * Release every part's shape and every surface it owns — its own material and, for a scattered
   * transparent part, the cutout clone made for it.
   *
   * At most once per resource, the same contract `release` gives the single-shape case: two parts
   * of one GLB routinely share a material, a level that fell back shares the level below's whole
   * part list, and every cell batch of the asset drew the same one. A clone is a resource this
   * class made, so it is released here and nowhere else.
   *
   * @returns how many teardowns threw, for the caller to count.
   */
  /**
   * Tear down a model the loader handed this world, respecting who owns the loader.
   *
   * A model from the loader this world created is the world's to dispose. A model from an
   * explicitly supplied loader is the caller's — another world or game may hold the same cached
   * scene — so this world drops its batches but leaves the shapes and surfaces alone; the caller's
   * own `release` ends that lifetime. See `#releaseModelPaths`.
   */
  disposeLoaded(model: Object3D | undefined): number {
    if (model === undefined) return 0;
    return this.#ownsLoader ? disposeModel(model) : 0;
  }

  /**
   * Release an adopted source shape or authored surface, unless a caller-supplied loader owns it.
   * The caller's cache holds another world's copy too, so only a world-owned loader disposes what
   * it adopted; a cutout this world built is always its own. See `#disposeLoaded`.
   */
  releaseSource(target: { dispose: () => void } | undefined): boolean {
    return this.#ownsLoader && release(target);
  }

  #releaseParts(parts: readonly IAssetPart[]): number {
    let failed = 0;
    for (const part of parts) {
      if (CellModels.#releasedParts.has(part)) continue;
      CellModels.#releasedParts.add(part);
      // A parked mesh holds the part's own geometry and material, so once those are released the
      // parked mesh can never be handed out again — it would give the next cell that asks for one a
      // buffer waiting on a disposed resource. Dropped here, so it does not sit in the pool counting
      // against the meshes a walk can park.
      dropPooledFor(part.geometry, part.material);
      if (this.releaseSource(part.geometry)) failed += 1;
      failed += this.#releaseSurface(part.surface);
    }
    return failed;
  }

  /**
   * The shared surface for a material's content: the first material seen for a key becomes the
   * canonical one (converted to a cutout when it is transparent scatter), and every later material
   * with the same content is released on arrival and draws with it instead.
   */
  #surfaceFor(source: Material): { readonly key: string; readonly material: Material } {
    const key = this.#preserveAuthoredParts ? source.uuid : materialKey(source);
    const shared = this.#surfaces.get(key);
    if (shared !== undefined) {
      shared.users += 1;
      if (!shared.owned.includes(source) && this.releaseSource(source))
        this.#host.setFailures(this.#host.failures() + 1);
      return { key, material: shared.material };
    }
    const drawn = scatterMaterial(source, this.#transparentScatter);
    this.#surfaces.set(key, { material: drawn.material, owned: drawn.owned, users: 1 });
    return { key, material: drawn.material };
  }

  /** One user gone; the last one tears the shared surface down. Returns teardowns that threw. */
  #releaseSurface(key: string): number {
    const shared = this.#surfaces.get(key);
    if (shared === undefined) return 0;
    shared.users -= 1;
    if (shared.users > 0) return 0;
    this.#surfaces.delete(key);
    let failed = 0;
    // A caller-supplied loader's authored surfaces belong to the caller's cache, like its shapes.
    // The cutout clones this world built are still the world's to release — `worldOwned` is the
    // marker. See `#releaseSource`.
    for (const material of shared.owned)
      if ((this.#ownsLoader || worldOwned.has(material)) && release(material)) failed += 1;
    return failed;
  }

  release(id: string): void {
    const asset = this.#assets.get(id);
    if (asset === undefined) return;
    asset.refcount -= 1;
    if (asset.refcount > 0) return;
    this.#assets.delete(id);
    asset.disposed = true;
    // Before anything is released: a pending bake stages this asset's borrowed geometry, and a view
    // drawn after the teardown reads a disposed buffer. Then the terminal level's own surface, whose
    // geometry and material `#releaseParts` must skip; see `#releaseImpostor`.
    this.#host.cancelImpostor(asset);
    this.#host.releaseImpostor(asset);
    // The last cell drawing this asset is gone, so this is the one teardown its levels get. It is
    // also the one a lost device makes expensive, which is why every part goes through `release`:
    // at most once per resource, and a level that fell back shares the level below's parts, so one
    // shape is torn down once however many levels point at it. One refusal is counted per asset,
    // the way one refused `lod0` load was.
    const levels = asset.levels;
    const spilled = asset.spilled;
    asset.levels = [];
    asset.spilled = [];
    let failed = 0;
    failed += this.#host.drainShared(id);
    for (const parts of levels) failed += this.#releaseParts(parts);
    // The middle levels' own reduced foliage cards, taken out of DRAW but still owned here. The
    // released-parts set makes the ones a draw level also holds single-teardown, so a shared surface
    // is never dropped early.
    failed += this.#releaseParts(spilled);
    if (failed > 0) this.#host.setFailures(this.#host.failures() + 1);
    this.releaseModelPaths(asset.retainedPaths);
  }

  /**
   * Note the exact `assets.model` cache paths an owner (an asset's levels, a cell's chunks) asks the
   * loader for, in the one world-wide `#modelPaths` map, so the last owner to let a path go can hand
   * it back. Both owners share the map, so an asset and a chunk that name the same bytes keep the
   * entry alive until neither holds it.
   */
  retainModelPaths(paths: readonly string[], into: string[]): void {
    for (const path of paths) {
      this.#modelPaths.set(path, (this.#modelPaths.get(path) ?? 0) + 1);
      into.push(path);
    }
  }

  /**
   * Hand back the exact `assets.model` cache paths this owner requested, so the loader drops the
   * source scenes and their textures instead of pinning them for the world's whole life.
   *
   * A path another owner still names is not released: two definitions that fetch the same bytes but
   * carry different `lods`/`maxDistance` are distinct assets, and the one leaving the ring must not
   * tear out a cached source the other still draws with. Keyed on the requested logical path, so a
   * path this world never asked for is never touched.
   *
   * Only the loader this world created is released. An explicitly supplied `assets` loader is the
   * caller's: another game or world may hold the same cached model, so this world never drops a
   * cache entry it does not own — the caller's own `release` is where that lifetime ends.
   */
  releaseModelPaths(paths: string[]): void {
    for (const path of paths) {
      const holders = (this.#modelPaths.get(path) ?? 1) - 1;
      if (holders > 0) {
        this.#modelPaths.set(path, holders);
        continue;
      }
      this.#modelPaths.delete(path);
      if (this.#ownsLoader) this.#loader.release("model", path);
    }
    paths.length = 0;
  }
}
