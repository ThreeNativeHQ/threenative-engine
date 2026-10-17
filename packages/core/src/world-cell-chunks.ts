import {
  Box3,
  type BufferGeometry,
  type Camera,
  InstancedMesh,
  Material,
  Matrix4,
  Mesh,
  Object3D,
} from "three";
import { markEngineRenderHook } from "./engine-render-hook.js";
import { mergeByMaterial } from "./merge-parts.js";
import {
  conservativeViewDepth,
  isLodJoinProxy,
  lodChainOf,
  setModelLodLayers,
} from "./model-lod.js";
import { displacesVertices } from "./projection-plan.js";
import type { IRendererLike } from "./renderer.js";
import { markStatic } from "./static-transform.js";
import { addInSlices, loadAll } from "./streaming.js";
import { warmUpScene, yieldToHost } from "./warmup.js";
import type { SharedBatch } from "./world-cell-batches.js";
import type { ICellProxyState, IResidentCell } from "./world-cell-data.js";
import {
  CellProxySelection,
  cellProxyGeometrySafe,
  cellProxyMaterialMatches,
  cellProxyMaterialSafe,
  cellProxySourceSafe,
  cellProxyWorldScale,
  measureCellProxy,
  prepareCellProxy,
} from "./world-cell-proxy.js";
import type { IAssetState } from "./world-cells.js";
import {
  CHUNK_NAME,
  VIRTUAL_SHADOW_CASTER_LAYER,
  VIRTUAL_SHADOW_WIDE_CASTER_LAYER,
  buildChunkShadowProxies,
} from "./world-chunk-shadow.js";
import type { IWorldCell } from "./world-package.js";
import type { IAdmissionBudget } from "./world-tiles.js";

interface ICellChunksOptions {
  readonly loadModel: ((url: string) => Promise<Object3D>) | undefined;
  readonly byteBudget: number;
  readonly logicalBase: string;
  readonly receiveShadow: boolean;
  readonly placementReach: Float32Array | undefined;
  readonly autoLodMaxPixelError: number;
  readonly chunkMergeMaxTriangles: number;
  readonly castShadowLevels: number;
  readonly bundlesWanted: boolean;
}

export interface ICellChunksHost {
  disposeProxyModel(state: ICellProxyState): void;
  disposeLoaded(model: Object3D | undefined): number;
  releaseModelPaths(paths: string[]): void;
  retainModelPaths(paths: readonly string[], into: string[]): void;
  addFailures(count: number): void;
  sourceBytes(): number;
  load(path: string, wanted: () => boolean): Promise<Object3D | undefined>;
  cellLive(cell: IResidentCell, generation: number): boolean;
  add(object: Object3D): void;
  intersectsObject(mesh: Mesh): boolean;
  gpuSceneOn(): boolean;
  asset(id: string): IAssetState | undefined;
  invalidateBundles(key: string): void;
  worldSphere(
    bounds: Parameters<typeof import("./model-lod.js").worldSphere>[0],
  ): ReturnType<typeof import("./model-lod.js").worldSphere>;
  reportCellFailure(
    stage: "asset" | "attach" | "chunk",
    key: string,
    paths: readonly string[],
    error: unknown,
  ): void;
  parent(): Object3D | null;
  /** The scene this world sits in, or `undefined` while it is in none: nothing projects it then. */
  targetScene(): Object3D | undefined;
  addChunk(cell: IResidentCell, object: Object3D): void;
  publishChunkBounds(cell: IResidentCell, box: Box3 | undefined, proxies: number): void;
}

/**
 * Bytes one merged chunk group may hold: 4 MiB, which is where a single first-draw upload stops
 * being a few milliseconds and becomes a frame.
 *
 * The 228.8 MB of `createAttribute` buffers a browser walk measured — 826 buffers, 33 over 1 MB,
 * the largest 23.2 / 18.1 / 17.2 / 16.4 MB — all arrived on the first draw of a merged chunk mesh,
 * and that first draw took up to 230 ms. A group is split rather than grown, so each of those
 * uploads is bounded and none of them is a stall.
 */
const CHUNK_MERGE_MAX_BYTES = 4 * 1024 * 1024;
/** Position (12) + normal (12) + uv (8) in float32: the three channels a merged group keeps. */
const CHUNK_MERGE_BYTES_PER_VERTEX = 32;
/** Vertices in 4 MiB of the above. The budget a chunk's material group is split on. */
const CHUNK_MERGE_MAX_VERTICES = CHUNK_MERGE_MAX_BYTES / CHUNK_MERGE_BYTES_PER_VERTEX;
/**
 * Triangles a chunk's merged material group may reach before one of its `InstancedMesh` is left
 * instanced instead. A merged group is one draw; past this many triangles the instanced draw is the
 * cheaper of the two, so the mesh is kept rather than expanded. It is the same 4 MiB counted in the
 * worst case, a de-indexed triangle of three 32-byte vertices, so the cap and the vertex budget above
 * are the one size read in two units. See `IWorldCellsLoadOptions.chunkMergeMaxTriangles`.
 */
export const CHUNK_MERGE_MAX_TRIANGLES = Math.floor(
  CHUNK_MERGE_MAX_BYTES / (3 * CHUNK_MERGE_BYTES_PER_VERTEX),
);
/**
 * How long one chunk's warm-up may take before the chunk is attached uncompiled. The engine's own
 * loading-screen bound for a single pipeline is 2,000 ms, and a compile that outlives it is a
 * compile that is not coming back — which is a slow frame rather than a chunk that never appears.
 */
const CHUNK_WARM_TIMEOUT_MS = 2000;

/** GPU resources already handed to a `dispose`, so no second path can tear the same one down. */
const tornDown = new WeakSet<object>();

/**
 * Release one GPU resource: at most once per resource, and never by throwing.
 *
 * Exactly once is the streaming contract: an asset's geometry is shared by every cell batch drawn
 * from it, so several residency paths can reach the same object, and a second teardown is the
 * renderer's problem, not the game's.
 *
 * Never throwing is the other half. Three disposes a geometry by deleting each of its attributes,
 * and `WebGPUAttributeUtils.destroyAttribute` reads the GPU buffer off the attribute and calls
 * `destroy` on it with no guard — so disposing a geometry whose upload never produced that buffer
 * throws `TypeError: Cannot read properties of undefined (reading 'destroy')` from wherever the
 * teardown was called. A cell leaving range is the most ordinary thing a streaming world does, so
 * that has to land as a counted failure here, not as a dead frame.
 *
 * @returns `true` when the teardown itself threw, for the caller to count.
 */
export function release(target: { dispose: () => void } | undefined): boolean {
  if (target === undefined || tornDown.has(target)) return false;
  tornDown.add(target);
  try {
    target.dispose();
  } catch {
    return true;
  }
  return false;
}

export function resolveRelative(baseUrl: string, relative: string): string {
  if (/^(?:[a-z]+:)?\/\//iu.test(relative) || relative.startsWith("data:")) return relative;
  return `${baseUrl}${relative.replace(/^\//u, "")}`;
}

/** What one chunk's merge did, for `TN_WORLD_CHUNK_MERGE`. */
interface IChunkMerge {
  /** Meshes the chunk held before, and the ones its subtree submits after. */
  readonly meshes: number;
  readonly draws: number;
  /**
   * Bytes the merged groups hold: exactly what the first draw of those meshes uploads, and the
   * number this merge exists to keep small.
   */
  readonly bytes: number;
  /** Instanced meshes baked into a material's group, and the ones left instanced. */
  readonly expanded: number;
  readonly keptInstanced: number;
  /** Teardowns of the consumed shapes that threw, for the caller to count. */
  readonly failed: number;
  /** Shadow-only proxies, per side for merged and retained parts; 0 when nothing casts. */
  readonly shadowDraws: number;
  /**
   * The opaque meshes a proxy covers. They keep drawing the main pass and keep receiving, and
   * they stop casting: the depth pass reads positions, not materials, so it reads the proxy instead.
   */
  readonly shadowCovered: readonly Mesh[];
}

function meshesOf(root: Object3D): number {
  let meshes = 0;
  root.traverse((object) => {
    if ((object as Mesh).isMesh === true) meshes += 1;
  });
  return meshes;
}

/**
 * One chunk's static meshes merged by material, in place, before the chunk is added.
 *
 * A hand-placed chunk is a bridge or a yard, not a prop: its mesh nodes are packed a few dozen to a
 * few hundred per file over a handful of materials, and each one is its own draw — in the main pass
 * and again in every shadow level that redraws it. Merging by material is what the cook already did
 * for repeated meshes (hence the `InstancedMesh`es in a loaded chunk), so this is the same fix one
 * step further out: one draw per material per chunk instead of one per node.
 *
 * Nothing here decides how anything looks. The merged mesh draws the game's own material and holds
 * the geometry exactly as authored, baked into the chunk root's space; what changes is how many
 * calls it takes to draw. `mergeByMaterial` does the bake and owns the refusals, so a group it
 * cannot merge (a material whose meshes disagree about `uv`) leaves the whole chunk as it was and is
 * counted as a failure — a chunk never disappears over a draw-call saving.
 *
 * Left alone: a skinned mesh (posed per frame), one carrying morph targets (the bake drops them), a
 * multi-material mesh (one draw per material already), and anything carrying a baked AutoLOD chain,
 * whose own `ModelLod` swaps its geometry and would be swapped for nothing. No chunk node is
 * animation-targeted: the chunk path takes `gltf.scene` and never a clip list.
 *
 * `disposeSources` says who owns the shapes the bake consumed. The merged buffers are the chunk's
 * own and are released with it on eviction; a shape nothing draws any more is released here, unless
 * the loader cache still holds it — `createAssetLoader` keys models by path and hands the same scene
 * back on the next load, so a cached shape is not this world's to tear down. A geometry a kept mesh
 * still draws is never released either way.
 *
 * `castShadow` says the chunk's shadow bill exists at all — the same answer the caller hands the
 * chunk's nodes — and only then is it worth one position-only proxy per `side`. See
 * `buildChunkShadowProxies`, which draws every side of every chunk with the world's one material for
 * that side.
 *
 * @returns what the merge did, or `undefined` when the bake refused the whole chunk.
 */
function mergeChunk(
  chunk: Object3D,
  maxTriangles: number,
  disposeSources: boolean,
  castShadow: boolean,
  proxyMaterials: Map<number, Material>,
): IChunkMerge | undefined {
  chunk.updateMatrixWorld(true);
  const meshes: Mesh[] = [];
  const skipped = new Set<Mesh>();
  let instanced = 0;
  chunk.traverse((object) => {
    const mesh = object as Mesh & { isInstancedMesh?: boolean };
    if (mesh.isMesh !== true) return;
    meshes.push(mesh);
    // A chain is baked into the geometry the mesh draws, so a merged buffer would carry a `ModelLod`
    // that has nothing to swap: the mesh keeps its own geometry and its own level selection.
    if (lodChainOf(mesh.geometry) !== undefined) {
      skipped.add(mesh);
      return;
    }
    if (Object.keys(mesh.geometry.morphAttributes).length > 0) {
      skipped.add(mesh);
      return;
    }
    if (mesh.isInstancedMesh === true) instanced += 1;
  });
  const before = meshes.length;
  let result: Mesh[];
  try {
    result = mergeByMaterial(chunk, {
      expandInstancedUnderTriangles: maxTriangles,
      label: `world chunk ${chunk.name}`,
      maxGroupVertices: CHUNK_MERGE_MAX_VERTICES,
      skip: (mesh) => skipped.has(mesh),
    });
  } catch {
    return undefined;
  }
  const kept = new Set(skipped);
  let keptInstanced = 0;
  for (const mesh of result) {
    if ((mesh as Mesh & { isInstancedMesh?: boolean }).isInstancedMesh !== true) continue;
    kept.add(mesh);
    keptInstanced += 1;
  }
  const held = new Set<BufferGeometry>();
  for (const mesh of kept) held.add(mesh.geometry);
  let failed = 0;
  // Only what the bake consumed leaves its place; a kept mesh draws the same either way, so it is
  // not re-parented and the chunk's authored hierarchy survives around the merged groups.
  for (const mesh of meshes) {
    if (kept.has(mesh)) continue;
    if (disposeSources && !held.has(mesh.geometry) && release(mesh.geometry)) failed += 1;
    mesh.removeFromParent();
  }
  for (const mesh of result)
    if (!(mesh as Mesh & { isInstancedMesh?: boolean }).isInstancedMesh === true) chunk.add(mesh);
  // Only what the bake produced is covered: a kept mesh was never merged, so it still holds its own
  // per-material draw and its own materials the proxy knows nothing about.
  const shadow = castShadow
    ? buildChunkShadowProxies(
        chunk,
        result.filter((mesh) => !kept.has(mesh)),
        `world chunk ${chunk.name}`,
        proxyMaterials,
      )
    : undefined;
  // AutoLOD and morphs remain their own draws. Only unmodified static instance silhouettes qualify.
  const toRoot = chunk.matrixWorld.clone().invert();
  const retained = castShadow
    ? buildChunkShadowProxies(
        chunk,
        [...kept].filter(
          (mesh) =>
            mesh instanceof InstancedMesh &&
            mesh.count > 0 &&
            mesh.layers.isEnabled(0) &&
            lodChainOf(mesh.geometry) === undefined &&
            Object.keys(mesh.geometry.morphAttributes).length === 0 &&
            mesh.morphTexture === null &&
            mesh.customDepthMaterial === undefined &&
            mesh.customDistanceMaterial === undefined &&
            mesh.onBeforeRender === Object3D.prototype.onBeforeRender &&
            !Array.isArray(mesh.material) &&
            !displacesVertices(mesh.material) &&
            mesh.material.visible &&
            mesh.material.allowOverride &&
            mesh.material.onBeforeCompile === Material.prototype.onBeforeCompile &&
            Reflect.get(mesh.material, "isShaderMaterial") !== true &&
            mesh.material.shadowSide === null &&
            (mesh.material.clippingPlanes?.length ?? 0) === 0 &&
            Reflect.get(mesh.material, "vertexNode") == null &&
            Reflect.get(mesh.material, "depthNode") == null &&
            Reflect.get(mesh.material, "castShadowNode") == null &&
            Reflect.get(mesh.material, "wireframe") !== true &&
            Reflect.get(mesh.geometry, "indirect") == null &&
            Reflect.get(mesh, "casterInstanceScale") == null &&
            new Matrix4().multiplyMatrices(toRoot, mesh.matrixWorld).determinant() >= 0,
        ),
        `world chunk ${chunk.name} retained`,
        proxyMaterials,
        true,
      )
    : undefined;
  return {
    bytes: mergedBytes(result, kept),
    draws: meshesOf(chunk),
    expanded: instanced - keptInstanced,
    failed,
    keptInstanced,
    meshes: before,
    shadowCovered: [...(shadow?.covered ?? []), ...(retained?.covered ?? [])],
    shadowDraws: (shadow?.proxies.length ?? 0) + (retained?.proxies.length ?? 0),
  };
}

/**
 * Bytes the bake's own meshes hold, indices included: the upload their first draw would have paid.
 * A kept mesh is not one of them — it was never merged, and it draws the same either way.
 */
function mergedBytes(merged: readonly Mesh[], kept: ReadonlySet<Mesh>): number {
  let bytes = 0;
  for (const mesh of merged) {
    if (kept.has(mesh)) continue;
    for (const attribute of Object.values(mesh.geometry.attributes))
      bytes += attribute.array.byteLength;
    const index = mesh.geometry.getIndex();
    if (index !== null) bytes += index.array.byteLength;
  }
  return bytes;
}

/** Triangles one geometry submits; the count the `TN_WORLD_LOD_CHAIN` marker reports per level. */
export function levelTriangles(geometry: BufferGeometry): number {
  const drawn = geometry.index?.count ?? geometry.getAttribute("position")?.count ?? 0;
  return Math.floor(drawn / 3);
}

export class CellChunks {
  #camera: Camera | undefined;
  /**
   * The renderer and camera of the last frame that ran, kept so a chunk streamed in between frames
   * can be compiled before it is attached. `update(renderer, camera)` is the only place either is
   * known, and the admission that loads a chunk is not a place that has them.
   */
  #renderer: IRendererLike | undefined;

  readonly #hlod: boolean;
  readonly #cellProxies = new Set<ICellProxyState>();
  #hlodBytes = 0;
  #hlodRefused = 0;
  #hlodReason = "";
  #hlodFailures = 0;
  /**
   * Per-side surfaces shared world-wide, separately for merged and retained proxies. See
   * `worldOwned`: a chunk teardown must not release another chunk's shadow surface.
   */
  readonly #proxyMaterials = new Map<number, Material>();

  #proxyObserved(state: ICellProxyState): boolean {
    return state.prepared !== undefined && state.observed.size === state.prepared.meshes.length;
  }

  releaseCellProxy(state: ICellProxyState): void {
    if (!this.#cellProxies.delete(state)) return;
    state.prepared?.root.removeFromParent();
    for (const mesh of state.prepared?.meshes ?? []) {
      mesh.onBeforeRender = Mesh.prototype.onBeforeRender;
      mesh.onAfterRender = Mesh.prototype.onAfterRender;
      this.#host.addFailures(release(mesh.geometry) ? 1 : 0);
    }
    // Cached model ownership uses the same global path holders as chunks and source LODs.
    // A compilation never races this release: cancellation retains everything until settlement.
    this.#host.disposeProxyModel(state);
    this.#host.releaseModelPaths(state.retainedPaths);
    this.#hlodBytes -= state.bytes;
    state.bytes = 0;
  }

  #beginCellProxy(cell: IResidentCell): void {
    const proxy = cell.cell.proxy;
    if (proxy === undefined) return;
    // Reserve resident headroom before IO; decoded source and fixed copies must fit it.
    // Temporary pressure retries through the existing admission loop.
    const reserve = Math.min(
      CHUNK_MERGE_MAX_BYTES * 2,
      this.#byteBudget - this.#host.sourceBytes() - this.#hlodBytes,
    );
    if (reserve <= 0) return;
    const state: ICellProxyState = {
      cell,
      selector: new CellProxySelection(proxy),
      retainedPaths: [],
      pending: true,
      compiling: false,
      cancelled: false,
      compiled: false,
      active: false,
      bytes: 0,
      observed: new Set(),
      hidden: new Map(),
      mainMasks: new Map(),
    };
    const source = this.#cellProxySource(state);
    // A retained neighboring key or a cheaper source LOD cannot benefit. Reconsider after later
    // residency changes without allocating another copy or running a proxy load meanwhile.
    if (
      !source.compatible ||
      proxy.triangles >= source.triangles ||
      proxy.materialGroups > source.draws
    )
      return;
    cell.proxy = state;
    state.bytes = reserve;
    this.#hlodBytes += reserve;
    this.#cellProxies.add(state);
    const path = resolveRelative(this.#logicalBase, proxy.glb);
    if (this.#loadModel === undefined) this.#host.retainModelPaths([path], state.retainedPaths);
    void this.#host
      .load(path, () => this.#host.cellLive(cell, cell.generation))
      .then(
        (model) => {
          state.pending = false;
          state.model = model;
          if (
            !this.#host.cellLive(cell, cell.generation) ||
            state.cancelled ||
            model === undefined
          ) {
            state.cancelled = true;
            this.releaseCellProxy(state);
            return;
          }
          try {
            if (measureCellProxy(model, proxy, true) > state.bytes)
              throw new Error("Cell proxy exceeds its reserved decoded budget.");
          } catch (error) {
            this.#hlodReason = `${state.cell.key}: ${String(error instanceof Error ? error.message : error).slice(0, 160)}`;
            state.cancelled = true;
            this.#hlodRefused++;
            this.releaseCellProxy(state);
            return;
          }
          // Preparation waits for an admission unit on a rendered update.
        },
        () => {
          state.pending = false;
          state.cancelled = true;
          this.#hlodFailures++;
          this.releaseCellProxy(state);
        },
      );
  }

  #prepareCellProxy(state: ICellProxyState): void {
    try {
      const prepared = prepareCellProxy(
        state.model as Object3D,
        state.cell.cell.proxy as NonNullable<IWorldCell["proxy"]>,
        state.bytes,
      );
      state.prepared = prepared;
      if (prepared.bytes > state.bytes)
        throw new Error("Cell proxy exceeds its reserved decoded budget.");
      this.#hlodBytes += prepared.bytes - state.bytes;
      state.bytes = prepared.bytes;
      prepared.root.name = `world-cell-proxy:${state.cell.key}`;
      for (const mesh of prepared.meshes) mesh.receiveShadow = this.#receiveShadow;
      this.#host.add(prepared.root);
    } catch (error) {
      this.#hlodReason = `${state.cell.key}: ${String(error instanceof Error ? error.message : error).slice(0, 160)}`;
      state.cancelled = true;
      this.#hlodRefused++;
      this.releaseCellProxy(state);
    }
  }

  #compileCellProxy(state: ICellProxyState, renderer: IRendererLike, camera: Camera): void {
    const prepared = state.prepared;
    if (prepared === undefined) return;
    const targetScene = this.#host.targetScene();
    if (targetScene === undefined) return;
    state.compiling = true;
    // No timeout counts as cancellation. This original promise owns every staged resource until it
    // settles, even if the cell/world has already left. Refusal keeps source and releases afterward.
    void Promise.resolve()
      .then(() =>
        warmUpScene(renderer, prepared.root, camera, {
          budgetMs: CHUNK_WARM_TIMEOUT_MS,
          renderPasses: false,
          targetScene,
        }),
      )
      .then(
        (report) => {
          if (
            report.unsupported ||
            report.timedOut ||
            report.abandoned > 0 ||
            (renderer.warmUpWorldPass !== undefined && report.passes?.includes("main") !== true)
          )
            throw new Error("cell proxy warm-up incomplete");
          renderer.warmUpScopeSettled?.(
            `cell:${state.cell.key}:${String(state.cell.generation)}`,
            prepared.root,
          );
          state.compiling = false;
          if (state.cancelled || !this.#host.cellLive(state.cell, state.cell.generation)) {
            state.cancelled = true;
            this.releaseCellProxy(state);
            return;
          }
          this.#uploadAttributes(prepared.root);
          state.compiled = true;
          // Three calls render hooks during compile too, and may swallow pipeline errors. Observe a
          // matching main-camera backend submission only AFTER this compile settles. Zero-count
          // submission proves readiness of that route, not full-triangle execution or visual quality.
          for (const mesh of prepared.meshes) {
            let before: number | undefined;
            const calls = (): number | undefined => {
              try {
                const info = renderer.info as { render?: { drawCalls?: number; calls?: number } };
                const value = info.render?.drawCalls ?? info.render?.calls;
                return Number.isSafeInteger(value) && (value as number) >= 0 ? value : undefined;
              } catch {
                return undefined;
              }
            };
            mesh.onBeforeRender = (_raw, _scene, drawnCamera) => {
              before =
                drawnCamera === this.#camera && renderer.compiling !== true ? calls() : undefined;
            };
            markEngineRenderHook(mesh.onBeforeRender);
            mesh.onAfterRender = (_raw, _scene, drawnCamera) => {
              const after = calls();
              if (
                drawnCamera === this.#camera &&
                renderer.compiling !== true &&
                before !== undefined &&
                after !== undefined &&
                after > before
              )
                state.observed.add(mesh);
              before = undefined;
            };
            markEngineRenderHook(mesh.onAfterRender);
          }
        },
        () => {
          state.compiling = false;
          state.cancelled = true;
          this.#hlodFailures++;
          this.releaseCellProxy(state);
        },
      )
      .catch(() => {
        state.compiling = false;
        state.cancelled = true;
        this.#hlodFailures++;
        this.releaseCellProxy(state);
      });
  }

  #cellSourceDrawn(mesh: Mesh): boolean {
    if (
      this.#camera === undefined ||
      (mesh instanceof InstancedMesh && mesh.count === 0) ||
      !this.#camera.layers.test(mesh.layers) ||
      Array.isArray(mesh.material) ||
      !mesh.material.visible
    )
      return false;
    for (let object: Object3D | null = mesh; object !== null; object = object.parent)
      if (!object.visible) return false;
    if (mesh.frustumCulled && !this.#host.intersectsObject(mesh)) return false;
    return true;
  }

  #cellProxySource(state: ICellProxyState): {
    compatible: boolean;
    triangles: number;
    draws: number;
    meshes: Mesh[];
  } {
    const cell = state.cell;
    const meshes = [...cell.mainChunkMeshes];
    for (const chunk of cell.chunks)
      chunk.traverse((node) => {
        if (node instanceof Mesh && isLodJoinProxy(node)) meshes.push(node);
      });
    const materials = new Set<Material>();
    const staticInstances = new Set<Mesh>();
    for (const [mesh, baseline] of cell.chunkInstances)
      if (
        mesh.instanceMatrix === baseline.matrix &&
        mesh.instanceMatrix.version === baseline.version &&
        mesh.count === baseline.count
      )
        staticInstances.add(mesh);
    let triangles = 0;
    let draws = 0;
    let compatible =
      cellLoaded(cell) && (state.cell.cell.proxy?.scope !== "cell" || !this.#host.gpuSceneOn());
    for (const mesh of meshes) {
      if (
        !cellProxySourceSafe(mesh, staticInstances) ||
        Array.isArray(mesh.material) ||
        !cellProxyGeometrySafe(mesh.geometry) ||
        !cellProxyMaterialSafe(mesh.material as Material)
      )
        compatible = false;
      else materials.add(mesh.material as Material);
      if (this.#cellSourceDrawn(mesh)) {
        triangles +=
          levelTriangles(mesh.geometry) * (mesh instanceof InstancedMesh ? mesh.count : 1);
        draws++;
      }
    }
    if (state.cell.cell.proxy?.scope === "cell") {
      const counts = new Map<SharedBatch, number>();
      const costs = new Map<SharedBatch, number>();
      for (const run of cell.cell.runs) {
        const asset = this.#host.asset(run.asset);
        if (
          asset === undefined ||
          !asset.hlodSafe ||
          asset.impostor !== undefined ||
          asset.definition.maxDistance !== undefined ||
          this.#placementReach !== undefined
        ) {
          compatible = false;
          continue;
        }
        for (const [part, shape] of (asset.levels[0] ?? []).entries()) {
          const entries = cell.batches.filter((entry) => entry.run === run && entry.part === part);
          if (
            entries.length !== 1 ||
            entries[0]?.level !== 0 ||
            entries[0]?.batch.count !== run.count ||
            !cellProxyMaterialSafe(shape.material)
          ) {
            compatible = false;
            continue;
          }
          materials.add(shape.material);
        }
      }
      for (const entry of cell.batches) {
        if (entry.shared === undefined || entry.segment < 0 || entry.level !== 0) {
          compatible = false;
          continue;
        }
        counts.set(entry.shared, (counts.get(entry.shared) ?? 0) + entry.batch.count);
        costs.set(
          entry.shared,
          (costs.get(entry.shared) ?? 0) + levelTriangles(entry.batch.geometry) * entry.batch.count,
        );
      }
      for (const [shared, count] of counts) {
        // Retain the segment, hence near restoration is a flag write with no budget dependency.
        // A neighboring holder keeps this key drawn; such a key cannot be retired for this cell.
        if (shared.live !== count) compatible = false;
        else {
          if (this.#cellSourceDrawn(shared.mesh)) {
            draws++;
            triangles += costs.get(shared) ?? 0;
          }
          meshes.push(shared.mesh);
        }
      }
    }
    for (const mesh of state.prepared?.meshes ?? []) {
      if (
        ![...materials].some((material) =>
          cellProxyMaterialMatches(mesh.material as Material, material),
        )
      )
        compatible = false;
    }
    return { compatible, triangles, draws, meshes };
  }

  restoreCellProxySource(state: ICellProxyState): void {
    for (const [mesh, visible] of state.hidden) mesh.visible = visible;
    state.hidden.clear();
    for (const [mesh, mask] of state.mainMasks) setModelLodLayers(mesh, mask);
    state.mainMasks.clear();
  }

  showCellProxy(state: ICellProxyState, active: boolean, meshes?: readonly Mesh[]): void {
    const prepared = state.prepared;
    if (prepared === undefined) return;
    const changed = state.active !== active;
    // AutoLOD owns chunk visibility. Retire only its main pass, retaining the selected source
    // geometry as a caster; joined rungs inherit this same pass ownership on activation.
    this.restoreCellProxySource(state);
    if (active)
      for (const mesh of meshes ?? this.#cellProxySource(state).meshes) {
        if (mesh.layers.isEnabled(0)) {
          if (state.cell.mainChunkMeshes.includes(mesh) || isLodJoinProxy(mesh)) {
            state.mainMasks.set(mesh, mesh.layers.mask);
            let mask = mesh.layers.mask & ~1;
            if (mesh.castShadow)
              mask |= (1 << VIRTUAL_SHADOW_CASTER_LAYER) | (1 << VIRTUAL_SHADOW_WIDE_CASTER_LAYER);
            setModelLodLayers(mesh, mask);
          } else {
            state.hidden.set(mesh, mesh.visible);
            mesh.visible = false;
          }
        }
      }
    prepared.root.visible = active || !this.#proxyObserved(state);
    prepared.meshes.forEach((mesh, index) => {
      const range = prepared.ranges[index];
      if (range !== undefined) mesh.geometry.setDrawRange(range.start, active ? range.count : 0);
    });
    state.active = active;
    if (changed) {
      this.#host.invalidateBundles(state.cell.key);
    }
  }

  stepCellProxies(
    cells: Iterable<IResidentCell>,
    matrixWorld: Matrix4,
    budget: IAdmissionBudget,
    renderer?: IRendererLike,
    camera?: Camera,
  ): void {
    if (!this.#hlod) return;
    for (const cell of cells) {
      if (cell.cell.proxy === undefined) continue;
      if (cell.proxy === undefined) {
        if (cellLoaded(cell)) budget.admit(() => this.#beginCellProxy(cell));
        continue;
      }
      const state = cell.proxy;
      if (state.cancelled || state.pending) continue;
      if (state.model !== undefined && state.prepared === undefined)
        budget.admit(() => this.#prepareCellProxy(state));
      if (state.cancelled || state.prepared === undefined) continue;
      if (!state.compiled && !state.compiling && renderer !== undefined && camera !== undefined)
        budget.admit(() => this.#compileCellProxy(state, renderer, camera));
      this.restoreCellProxySource(state);
      const source = this.#cellProxySource(state);
      const scale = cellProxyWorldScale(matrixWorld);
      const sphere = this.#host.worldSphere(state.prepared.bounds);
      sphere.radius = state.prepared.bounds.radius * scale;
      const view =
        camera === undefined
          ? undefined
          : conservativeViewDepth(
              camera,
              sphere.center,
              sphere.radius,
              Reflect.get(camera, "near") ?? 0.1,
            );
      const height = renderer?.domElement.height;
      const selected = state.selector.select({
        sourceReady: cellLoaded(cell),
        proxyReady: state.compiled && this.#proxyObserved(state),
        sourceCompatible: source.compatible && scale > 0,
        sourceTriangles: source.triangles,
        replaceableSourceDraws: source.draws,
        views:
          camera !== undefined &&
          height !== undefined &&
          Number.isFinite(height) &&
          height > 0 &&
          view !== undefined
            ? [
                {
                  camera,
                  viewportHeight: height,
                  ...view,
                  finest: Reflect.get(camera, "isOrthographicCamera") === true || view.degenerate,
                },
              ]
            : [],
        // Collapsing a valid Three transform retains detail; a zero error scale cannot select LOD.
        errorScale: scale === 0 ? 1 : scale,
        maxPixelError: this.#autoLodMaxPixelError,
      });
      this.showCellProxy(state, selected === "proxy", source.meshes);
    }
  }

  startChunkLoad(cell: IResidentCell): void {
    const generation = cell.generation;
    const paths: string[] = [];
    for (const chunk of cell.cell.chunks ?? [])
      paths.push(resolveRelative(this.#logicalBase, chunk));
    // A chunk's source is the same loader cache entry an asset's level would be: held while this
    // cell is resident and handed back with the last cell naming the path, through the one
    // `#modelPaths` map. A `loadModel` override parses per load and reaches no cache, so it owns
    // nothing here either; see `#releaseModelPaths`.
    if (this.#loadModel === undefined) this.#host.retainModelPaths(paths, cell.retainedModelPaths);
    loadAll(paths, (path) => this.#host.load(path, () => this.#host.cellLive(cell, generation)), {
      marker: false,
    }).then(
      (models) => {
        void this.#attachChunks(
          cell,
          generation,
          models.filter((model): model is Object3D => model !== undefined),
        );
      },
      (error: unknown) => {
        cell.chunkFailed = true;
        this.#host.addFailures(1);
        this.#host.reportCellFailure("chunk", cell.key, paths, error);
      },
    );
  }

  /**
   * Hand the chunk's own buffers to the renderer now, and report how many it took.
   *
   * A compile builds pipelines, not geometry, so the bake's new attributes reached the device on
   * whichever frame first drew them — 826 buffers and 228.8 MB on an 8 s walk, 33 of them over a
   * megabyte, lining up exactly with the p95 and max frame spikes. The backend's own attribute
   * creation is idempotent, so this is a move rather than a second upload, and a renderer with no
   * such seam answers 0 and behaves as it did.
   */
  #uploadAttributes(chunk: Object3D): number {
    const upload = this.#renderer?.uploadAttributes;
    if (upload === undefined) return 0;
    const geometries = new Set<BufferGeometry>();
    chunk.traverse((object) => {
      const mesh = object as Mesh;
      if (mesh.isMesh === true) geometries.add(mesh.geometry);
    });
    return upload(geometries);
  }

  /**
   * Hand this chunk's own textures to the device now, and report how many it took.
   *
   * The same argument as the buffers above, one resource class over: a compile builds pipelines, not
   * pixels, so the bake's textures reached the device inside `_renderObjectDirect` on the frame the
   * chunk first drew — 87 ms of a 94 ms first draw in one frame of a Machinefall map-walk, and 79 ms
   * of 131 ms in another. A texture the world already shares with what is on screen is one early
   * return inside three and no work here.
   */
  #uploadTextures(chunk: Object3D): number {
    const upload = this.#renderer?.uploadTextures;
    if (upload === undefined) return 0;
    return upload(chunk);
  }

  /**
   * Compile a merged chunk before anything can draw it, and report whether the compile came back.
   *
   * A chunk's first draw is the most expensive frame a streaming world has: its own first draw built
   * nodes and a render pipeline synchronously, and one chunk cost **248 ms of a 291 ms walk** in the
   * census that found it. The engine already owns this work — `warmUpScene` drives the renderer's
   * own `compileAsync`, and this is that same call with the world as the target scene, so the chunk's
   * materials resolve the same lights, environment and clipping the real frame will resolve them
   * against. A pipeline compiled against no lights would be a different pipeline, and the frame would
   * still pay for it.
   *
   * It is bounded by `within`, the warm-up's own bound: a compile that never settles is abandoned and
   * the chunk is attached anyway, because a missing chunk is worse than a slow frame. A world that is
   * in no scene is skipped outright — nothing projects it, so a compile would build nothing, which is
   * the same answer `load()` gets, where the loading screen is about to draw it anyway.
   */
  async #warmChunk(chunk: Object3D, scopeLabel: string): Promise<boolean> {
    const renderer = this.#renderer;
    const camera = this.#camera;
    if (renderer === undefined || camera === undefined || this.#host.parent() === null)
      return false;
    const targetScene = this.#host.targetScene();
    if (targetScene === undefined) return false;
    // The rejected compile is a pipeline this warm-up could not build, not a reason to fail the
    // admission: the frame that needs it will try again and fail there, where the error belongs.
    return warmUpScene(renderer, chunk, camera, {
      budgetMs: CHUNK_WARM_TIMEOUT_MS,
      renderPasses: false,
      targetScene,
      yieldFrame: yieldToHost,
    }).then(
      (report) => {
        const settled =
          !report.unsupported &&
          report.observed.status === "complete" &&
          !report.timedOut &&
          report.abandoned === 0 &&
          (renderer.warmUpWorldPass === undefined || report.passes?.includes("main") === true);
        if (settled) renderer.warmUpScopeSettled?.(scopeLabel, chunk);
        return settled;
      },
      () => false,
    );
  }

  async #attachChunks(
    cell: IResidentCell,
    generation: number,
    models: readonly Object3D[],
  ): Promise<void> {
    const live = (): boolean => this.#host.cellLive(cell, generation);
    let attached = 0;
    // Merged and shaped, not yet in the world: the compile below runs between the two, and a cell
    // that left the ring in the middle takes its prepared chunks with it.
    const prepared: { readonly object: Object3D; readonly proxies: number }[] = [];
    try {
      const report = await addInSlices(
        models,
        (object) => {
          if (!live()) return;
          object.name = CHUNK_NAME;
          // One draw per material before the chunk is ever added, so the main pass and every shadow
          // level that redraws it submit the chunk's materials rather than its nodes. A refusal
          // leaves the chunk exactly as authored and is counted: it never costs the chunk itself.
          const merge = mergeChunk(
            object,
            this.#chunkMergeMaxTriangles,
            // A `loadModel` override parses per load, so a chunk's shapes are this world's to
            // release; `assets.model` caches by path and hands the same scene back, so they are not.
            this.#loadModel !== undefined,
            this.#castShadowLevels > 0,
            this.#proxyMaterials,
          );
          // Where the frame budget counts this chunk's main-pass draws (`RenderPassBudget`). Written
          // after the bake and over the whole subtree, because that is the only point where all three
          // outcomes exist at once: a merged group, an instanced mesh the bake kept, and a chunk it
          // refused whole are all one chunk's draws. The proxies the bake built are off layer 0 and
          // keep the `proxies` origin they were given.
          object.traverse((node) => {
            if ((node as Mesh).isMesh !== true || node.layers.isEnabled(0) === false) return;
            node.userData.tnDrawSource = "chunks";
          });
          // The buffers the bake just made, uploaded here rather than on the chunk's first draw,
          // which is the frame that uploads them today: 228.8 MB over 826 `createAttribute` calls
          // in a browser walk, and up to 230 ms inside the frames that first submitted them.
          // `addInSlices` is the admission budget, so this is one chunk per update, never a batch.
          const uploaded = this.#uploadAttributes(object);
          this.#uploadTextures(object);
          if (merge === undefined) this.#host.addFailures(1);
          else {
            this.#host.addFailures(merge.failed);
            console.info(
              `TN_WORLD_CHUNK_MERGE meshes=${String(merge.meshes)} draws=${String(merge.draws)} ` +
                `bytes=${String(merge.bytes)} uploaded=${String(uploaded)} ` +
                `instancedExpanded=${String(merge.expanded)} keptInstanced=${String(merge.keptInstanced)} ` +
                `shadowDraws=${String(merge.shadowDraws)}`,
            );
          }
          // Hand-placed chunks are the buildings and set dressing: full shape, so they cast with the
          // near scatter and receive like everything else when the game asks for shadows. A merged
          // opaque mesh the proxy covers keeps receiving and stops casting: the depth pass reads the
          // proxy, so casting from both would pay the bill the proxy was built to remove. The proxy
          // itself is off layer 0 and already carries what the level cameras need of it.
          if (this.#castShadowLevels > 0 || this.#receiveShadow) {
            const covered = new Set(merge?.shadowCovered);
            object.traverse((node) => {
              if (node.layers.isEnabled(0) === false) return;
              node.castShadow = this.#castShadowLevels > 0 && !covered.has(node as Mesh);
              node.receiveShadow = this.#receiveShadow;
            });
          }
          prepared.push({ object, proxies: merge?.shadowDraws ?? 0 });
        },
        { marker: false, while: live },
      );
      if (report.stopped)
        for (let i = report.added; i < models.length; i += 1)
          this.#host.addFailures(this.#host.disposeLoaded(models[i] as Object3D));
      for (const { object, proxies } of prepared) {
        // The compile is the whole point of the wait, and the wait is the only thing between the
        // merge and the attach. Everything the world does not own is released when the cell that
        // asked for the chunk is gone, so a chunk that arrives after its cell left is torn down here
        // rather than compiled and thrown at a world that is not looking.
        if (live())
          await this.#warmChunk(object, `chunk:${cell.key}:${String(cell.chunks.length)}`);
        if (!live()) {
          this.#host.addFailures(this.#host.disposeLoaded(object));
          continue;
        }
        cell.chunks.push(object);
        object.traverse((node) => {
          if (node instanceof Mesh && node.layers.isEnabled(0)) cell.mainChunkMeshes.push(node);
          if (node instanceof InstancedMesh && node.layers.isEnabled(0))
            cell.chunkInstances.set(node, {
              matrix: node.instanceMatrix,
              version: node.instanceMatrix.version,
              count: node.count,
            });
        });
        // The chunk's own box, from the merged geometry's boxes rather than its vertices: a chunk
        // is loaded once and both consumers of it are only asked to be no wider than the chunk. Read
        // before `#addChunk`, which may hand part of the subtree to a cell's record and leave the
        // rest behind, so the box is the chunk's whatever ends up where.
        const box =
          proxies > 0 || this.#bundlesWanted ? new Box3().setFromObject(object, false) : undefined;
        this.#host.addChunk(cell, object);
        // A loaded chunk is placed once and never rewritten: its transforms, geometry and material
        // are the ones the export gave it, so it is the one subtree here with nothing to announce.
        markStatic(object);
        // The proxies' shadow pipelines are the one thing a compile cannot build — three creates a
        // shadow variant on the first pass that draws the caster, and the pass is the levels'. So
        // the levels are told a caster arrived, exactly as a prewarmed caster cluster tells them:
        // the first level whose window covers the chunk submits the proxy and builds it. With one
        // material per `side` world-wide, that is one pipeline for the world's first chunk of each
        // side and a node binding for every chunk after it, not a compile per chunk.
        this.#host.publishChunkBounds(cell, box, proxies);
        attached += 1;
      }
    } catch (error) {
      cell.chunkFailed = true;
      this.#host.addFailures(1);
      this.#host.reportCellFailure(
        "attach",
        cell.key,
        Array.from(cell.cell.chunks ?? [], (chunk) => resolveRelative(this.#logicalBase, chunk)),
        error,
      );
      for (let i = attached; i < models.length; i += 1)
        this.#host.addFailures(this.#host.disposeLoaded(models[i] as Object3D));
    }
    if (this.#host.cellLive(cell, generation) && !cell.chunkFailed) cell.chunksLoaded = true;
  }
  get renderer(): IRendererLike | undefined {
    return this.#renderer;
  }
  set renderer(value: IRendererLike | undefined) {
    this.#renderer = value;
  }
  get camera(): Camera | undefined {
    return this.#camera;
  }
  set camera(value: Camera | undefined) {
    this.#camera = value;
  }
  readonly #host: ICellChunksHost;
  readonly #loadModel: ((url: string) => Promise<Object3D>) | undefined;
  readonly #byteBudget: number;
  readonly #logicalBase: string;
  readonly #receiveShadow: boolean;
  readonly #placementReach: Float32Array | undefined;
  readonly #autoLodMaxPixelError: number;
  readonly #chunkMergeMaxTriangles: number;
  readonly #castShadowLevels: number;
  readonly #bundlesWanted: boolean;
  constructor(hlod: boolean, options: ICellChunksOptions, host: ICellChunksHost) {
    this.#hlod = hlod;
    this.#host = host;
    this.#loadModel = options.loadModel;
    this.#byteBudget = options.byteBudget;
    this.#logicalBase = options.logicalBase;
    this.#receiveShadow = options.receiveShadow;
    this.#placementReach = options.placementReach;
    this.#autoLodMaxPixelError = options.autoLodMaxPixelError;
    this.#chunkMergeMaxTriangles = options.chunkMergeMaxTriangles;
    this.#castShadowLevels = options.castShadowLevels;
    this.#bundlesWanted = options.bundlesWanted;
  }
  get bytes(): number {
    return this.#hlodBytes;
  }
  restoreSources(): void {
    for (const state of this.#cellProxies) this.restoreCellProxySource(state);
  }
  releaseMaterials(): void {
    for (const material of this.#proxyMaterials.values())
      this.#host.addFailures(release(material) ? 1 : 0);
    this.#proxyMaterials.clear();
  }
  stats() {
    return {
      on: this.#hlod,
      loaded: [...this.#cellProxies].filter(
        (state) => state.prepared !== undefined && !state.cancelled,
      ).length,
      compiled: [...this.#cellProxies].filter((state) => state.compiled && !state.cancelled).length,
      observed: [...this.#cellProxies].filter(
        (state) => this.#proxyObserved(state) && !state.cancelled,
      ).length,
      active: [...this.#cellProxies].filter((state) => state.active).length,
      pending: [...this.#cellProxies].filter(
        (state) =>
          state.pending ||
          state.compiling ||
          (!state.cancelled && !state.compiled && state.prepared !== undefined),
      ).length,
      bytes: this.#hlodBytes,
      refused: this.#hlodRefused,
      reason: this.#hlodReason,
      failures: this.#hlodFailures,
    };
  }
  evictProxy(cell: IResidentCell): void {
    if (cell.proxy !== undefined) {
      this.showCellProxy(cell.proxy, false);
      cell.proxy.cancelled = true;
      cell.proxy.prepared?.root.removeFromParent();
      if (!cell.proxy.pending && !cell.proxy.compiling) this.releaseCellProxy(cell.proxy);
    }
  }
}

export function cellLoaded(cell: IResidentCell): boolean {
  return cell.chunksLoaded && cell.completedRuns.size === cell.cell.runs.length;
}
