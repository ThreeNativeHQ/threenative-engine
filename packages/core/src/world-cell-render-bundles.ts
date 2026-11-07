import type { Object3D } from "three";
import type { Material } from "three";
import { BundleGroup } from "three/webgpu";
import { lodChainOf } from "./model-lod.js";
import { rendererFacts } from "./renderer-facts.js";
import type { IRendererLike } from "./renderer.js";
import { markStatic } from "./static-transform.js";
import { BundleSurfaceSafety, bundleSafe, ownHook } from "./world-bundle-safety.js";
import type { SharedBatch } from "./world-cell-batches.js";
import type { IWorldCellsStats } from "./world-cell-data.js";
import { type IResidentCell, clusterOf } from "./world-cell-data.js";
import { chunkDraws } from "./world-cell-render-util.js";
import { mainShard } from "./world-cell-render-util.js";
import { CHUNK_NAME } from "./world-chunk-shadow.js";

/**
 * The main pass's draw bundles: every recorded mesh parented under a shard's `BundleGroup`, every
 * resident cell's hand-placed chunks under one of their own, and the version bookkeeping that makes
 * a re-record a structural event and nothing else.
 *
 * A record is a render list three fixed when it made it, so this is the one part of the class that
 * answers "did the set of things drawn change" rather than "what is drawn this frame": streaming,
 * culling and LOD are the cull's and the dispatch's answer, and never bump a version.
 */

/** What a bundle record needs from the world it is recorded in. */
export interface ICellBundlesHost {
  /** Add a group or a mesh to the world, which is where a chunk's record hangs. */
  add(object: Object3D): void;
  /** Whether the world itself is this object's parent, so a refused mesh still draws. */
  isParent(object: Object3D): boolean;
  /** Every shared batch, for the membership counts a settled frame reports. */
  shared(): Map<string, SharedBatch>;
  /** The renderer the last frame handed over, or `undefined` before the first one. */
  renderer(): IRendererLike | undefined;
}

/** The three answers the load gave once, and every record reads. */
export interface ICellBundlesSettings {
  readonly bundlesWanted: boolean;
  readonly bundleReason: string;
  readonly cellsPerCullCell: number;
}

export class CellBundles {
  readonly #host: ICellBundlesHost;

  constructor(settings: ICellBundlesSettings, host: ICellBundlesHost) {
    this.#host = host;
    this.#bundlesWanted = settings.bundlesWanted;
    this.#bundleReason = settings.bundleReason;
    this.#cellsPerCullCell = settings.cellsPerCullCell;
  }

  /**
   * The `BundleGroup`s every recorded main batch mesh is parented under, one per shard of
   * {@link MAIN_BUNDLE_SHARDS}, and the number of times one has been re-recorded. A shard is minted by
   * the first mesh that lands in it, so a world that never dresses a mesh has no group to pay for.
   *
   * A re-record is a structural change and nothing else: see `IWorldCellsStats.bundle` and
   * {@link #bumpBundle}. Streaming, culling and LOD are GPU-side answers and never move it. A record
   * walks every draw its group holds, so a mint pays for its own shard and not the whole main pass.
   */
  readonly #bundleSafety = new BundleSurfaceSafety();

  #ownsBundles: boolean | undefined;

  readonly #bundles = new Map<number, BundleGroup>();

  #bundleRecords = 0;

  /**
   * Shards re-recorded while a compile was in flight, so they are re-recorded again once it settles.
   * Three encodes a draw only when its pipeline is ready, so a record cut during a `compileAsync`
   * silently leaves a not-yet-ready draw out, and the replay never re-checks it. Bumped from
   * {@link #bumpBundle} while {@link #compileBusy}, flushed at the top of the update that sees the
   * compile settle.
   */
  #compileSeen = 0;

  #compileBusy = false;

  /**
   * The patched renderer's count of PMREM swaps, as of the last flush. A record holds the bind
   * groups it was made with and a replay never refreshes them, so a sky that finishes after the
   * first record would leave every recorded draw sampling the placeholder until a walk re-records.
   */
  #pmremSwaps = 0;

  readonly #recordedWhileBusy = new Set<BundleGroup>();

  /**
   * One `BundleGroup` per resident cell that has chunks attached, keyed by cell key, each with the
   * main-cull cluster whose answer decides whether it is in the frame. Minted by the first chunk a
   * cell attaches, so a world with no chunks pays nothing; see the `bundles` option.
   *
   * Per cell and not one group for the whole world: a record is fixed when it is made, so a group's
   * own answer to "is this in view" cannot change without a re-record — which is the whole cost this
   * is removing. A cell is the granularity the coarse cull already answers at, so `visible` on the
   * group is a write rather than a record. See `#cullMainPass`.
   */
  readonly #chunkBundles = new Map<
    string,
    { readonly cluster: string; readonly group: BundleGroup }
  >();

  /** How many chunk roots those groups hold, so `stats().bundle.children` costs nothing to read. */
  #chunkBundleChildren = 0;

  /** `bundles` as the load asked for it, before the query string and the environment. */
  readonly #bundlesWanted: boolean;

  /**
   * Who decided that: the load that named `bundles`, the launch that asked for `off` or `on`, or
   * nothing at all — which is what the marker reports so a run on the default is never mistaken for
   * one a flag turned off. See {@link bundlesAsked}.
   */
  readonly #bundleReason: string;

  /** The square a cell's chunk record is answered at, which is the cull's own grid. */
  readonly #cellsPerCullCell: number;

  /**
   * Parent one dressed main mesh under the world's single `BundleGroup`, so a settled frame replays
   * its draw instead of re-walking three's per-object path for it.
   *
   * A mesh is shown once, here, and never hidden again: the bundle's render list is fixed when it is
   * recorded, the dispatch already decided which instances each key draws, and an indirect draw of
   * zero instances is close to free on the GPU — where a `visible` write would force the whole group
   * to be recorded again. The prewarm draw this batch may still owe comes out of that same record.
   *
   * CPU joins and changed material revisions invalidate the record here, including a repaired mesh
   * joining on a settled frame. GPU dressing invalidates its completed record at the caller.
   *
   * A mesh whose draw needs a live pass is refused rather than recorded — a transmissive impostor or
   * a GPU batch reaching the framebuffer, the same answer a chunk's draws get. It keeps the per-object
   * path and the coarse gate that hides it, which is the path it was already on. See `bundleSafe`.
   */
  bundleIn(shared: SharedBatch, reuseSafety = false): void {
    if (this.#bundlesWanted === false) return;
    // Shared batches normally carry one material. A mutable array keeps the existing per-object path
    // rather than compressing several material identities/revisions into an incomplete signature.
    const arrayMaterial = Array.isArray(shared.mesh.material);
    const checked =
      reuseSafety && !arrayMaterial
        ? this.#bundleSafety.test(shared.mesh.material as Material, !this.ownsBundles())
        : undefined;
    shared.bundlable =
      lodChainOf(shared.mesh.geometry) === undefined &&
      (reuseSafety
        ? checked !== undefined &&
          !ownHook(shared.mesh, "onBeforeRender") &&
          !ownHook(shared.mesh, "onAfterRender") &&
          Reflect.get(shared.mesh, "isSkinnedMesh") !== true &&
          shared.mesh.morphTargetInfluences === undefined &&
          checked.safe
        : bundleSafe(shared.mesh));
    if (shared.bundlable === false) {
      if (shared.bundled) this.bundleOut(shared);
      // A previously culled key may already be detached. Refusal still owes its live source draw.
      if (!this.#host.isParent(shared.mesh)) this.#host.add(shared.mesh);
      return;
    }
    const group = this.shardOf(shared);
    if (checked !== undefined) {
      if (shared.bundled && shared.bundleMaterialRevision !== checked.revision)
        this.bumpBundle(group);
      shared.bundleMaterialRevision = checked.revision;
    }
    if (shared.mesh.parent !== group) {
      group.add(shared.mesh);
      if (reuseSafety) this.bumpBundle(group);
    }
    shared.bundled = true;
    shared.bundledCount = shared.mesh.count;
    // A recorded draw was cut from this camera's frustum, so the mesh's own whole-mesh test would drop
    // it the moment the camera turned away from a window the record still holds. Off, like a chunk's.
    shared.mesh.frustumCulled = false;
    shared.mesh.visible = true;
    // Read by `VirtualShadowNode#probe`, which must not hide a bundled mesh: the render list a bundle
    // recorded is fixed, and `visible = false` would take the mesh out of every record after the next
    // re-record. See `bundled`.
    shared.mesh.userData.tnBundled = true;
  }

  /**
   * Take a mesh back out of the group, because the key it was minted under is leaving the world.
   *
   * A retire is a structural change — the recorded bundle still holds this render object, and
   * replaying it would draw a key nothing owns — so it is one of the two events that re-records.
   */
  bundleOut(shared: SharedBatch): void {
    if (shared.bundled === false) return;
    shared.bundled = false;
    shared.bundledCount = -1;
    shared.mesh.userData.tnBundled = false;
    // Back on the per-object path, so the mesh's own whole-mesh test is its gate again.
    shared.mesh.frustumCulled = true;
    const group = this.#bundles.get(mainShard(shared.mesh.name));
    if (group === undefined) return;
    if (shared.mesh.parent === group) group.remove(shared.mesh);
    this.bumpBundle(group);
  }

  /**
   * Whether the renderer records its own bundles from each frame's draws, as the owned engine does
   * (`info.engine`, the same check `game.ts` makes). Decided once a renderer is attached.
   */
  ownsBundles(): boolean {
    if (this.#ownsBundles !== undefined) return this.#ownsBundles;
    const renderer = this.#host.renderer();
    if (renderer === undefined) return false;
    this.#ownsBundles = rendererFacts(renderer).ownedEngine;
    return this.#ownsBundles;
  }

  /** One re-record, counted: `BundleGroup.needsUpdate` is a version bump, and nothing else. */
  bumpBundle(group: BundleGroup): void {
    this.#bundleRecords += 1;
    group.needsUpdate = true;
    if (this.#compileBusy) this.#recordedWhileBusy.add(group);
  }

  /**
   * Put one CPU-path main batch into the world's record, or take it out, by the coarse gate's answer.
   *
   * A main batch the GPU scene dresses is recorded from `#dressGpu`, because its submission bound is
   * its key's region capacity — a number only the dress writes, so the entry cannot go stale. A batch
   * the scene does not own submits its own CPU window instead, and that window is per frame: the gate
   * narrows it, a residency change repacks it, and a batch it narrows to nothing must draw nothing.
   * A record fixes its render list, so all three are the record's business rather than a `visible`
   * write the replay ignores. Hence this: the gate's answer is a join or a leave, a window that moved
   * or a count that changed is one more record, and `frustumCulled` is off because the record's own
   * list was cut by the same frustum when it was made.
   *
   * The trade is the one a cell's chunk record already makes and the visual A/B already judged: a
   * batch whose window is half the view draws the half that faced the camera when the record was cut.
   */
  recordCpuMain(shared: SharedBatch, outcome: "settled" | "narrowed" | "repacked"): void {
    if (this.#bundlesWanted === false) return;
    // `#publish` has just written this frame's answer onto the mesh, which is the only place it is.
    if (shared.mesh.visible === false) {
      this.bundleOut(shared);
      return;
    }
    this.bundleIn(shared, true);
    if (shared.bundled === false) return;
    // The count a record freezes, and the layout behind it: a repack moves records inside the window
    // without moving its length, so the epoch answer and the count are both read here.
    if (outcome === "settled" && shared.mesh.count === shared.bundledCount) return;
    shared.bundledCount = shared.mesh.count;
    this.bumpBundle(this.shardOf(shared));
  }

  /**
   * Attach one prepared chunk: to its cell's own record, or to the world when `bundles` is off.
   *
   * The group is minted with the first chunk the cell attaches, and a chunk added to it is a
   * structural change — the recorded list does not hold this render object and the replay would draw
   * the cell's chunks without it — so this is also the one re-record. See the `bundles` option for
   * why the group is per cell.
   *
   * Only the draws a bundle can replay are recorded, and they carry the `tnBundled` marker and the
   * frozen cull with them; the rest keep the per-object path. See `bundleSafe`.
   */
  addChunk(cell: IResidentCell, chunk: Object3D): void {
    if (this.#bundlesWanted === false) {
      this.#host.add(chunk);
      return;
    }
    // What the record can hold, and whether anything had to be left behind. A chunk whose every draw
    // is recorded goes in whole, which is one entry per chunk; a chunk holding a draw a bundle cannot
    // replay stays in the world and hands its safe draws to the record on their own, so one glass
    // window does not put the whole building back on the per-object path. See `bundleSafe`.
    const draws = chunkDraws(chunk);
    const recorded = draws.filter(
      (mesh) => lodChainOf(mesh.geometry) === undefined && bundleSafe(mesh),
    );
    if (recorded.length === 0) {
      this.#host.add(chunk);
      return;
    }
    let entry = this.#chunkBundles.get(cell.key);
    if (entry === undefined) {
      const group = new BundleGroup();
      group.name = `${CHUNK_NAME}-bundles:${cell.key}`;
      this.#host.add(group);
      entry = { cluster: clusterOf(cell.x, cell.z, this.#cellsPerCullCell), group };
      this.#chunkBundles.set(cell.key, entry);
    }
    const whole = recorded.length === draws.length;
    if (whole) entry.group.add(chunk);
    else {
      // The chunk keeps its own hierarchy around whatever it could not record, and each recorded
      // draw is attached rather than added so it keeps the world transform it was merged at. The root
      // it came out of travels with it, because that is what releases the draw again.
      this.#host.add(chunk);
      for (const mesh of recorded) {
        mesh.userData.tnChunkRoot = chunk;
        entry.group.attach(mesh);
      }
    }
    // A recorded draw is frozen where it stands: the group is a child of the world at identity, so
    // its matrix will never move, and the freeze is what lets three's settled-object path skip the
    // per-object work for the draw a frame is not re-recording anyway. See `markStatic`.
    for (const mesh of recorded) {
      mesh.userData.tnBundled = true;
      mesh.frustumCulled = false;
      if (whole === false) markStatic(mesh);
    }
    this.#chunkBundleChildren += whole ? 1 : recorded.length;
    this.bumpBundle(entry.group);
  }

  /**
   * Take a cell's chunk record out of the world, because the cell that owned every chunk in it has
   * left: a record nothing owns must not be replayed, and the cell coming back mints its own.
   *
   * A chunk the bake split left its recorded draws in the group rather than under their own root, so
   * each goes back to the root it came out of first: the caller's own disposal walk finds them there,
   * and a draw released by neither is a buffer nothing ever asks for again.
   */
  dropChunkBundles(cell: IResidentCell): void {
    const entry = this.#chunkBundles.get(cell.key);
    if (entry === undefined) return;
    this.#chunkBundles.delete(cell.key);
    const roots = new Set(cell.chunks);
    // Counted before anything leaves the group, because that is what it is holding.
    this.#chunkBundleChildren -= entry.group.children.length;
    for (const child of entry.group.children) {
      const root = child.userData.tnChunkRoot as Object3D | undefined;
      if (roots.has(child) === false && root !== undefined) {
        child.userData.tnChunkRoot = undefined;
        root.attach(child);
      }
    }
    entry.group.removeFromParent();
    this.bumpBundle(entry.group);
  }

  /** The main-record shard a batch's key lands in, minted as a child of the world on first use. */
  shardOf(shared: SharedBatch): BundleGroup {
    const shard = mainShard(shared.mesh.name);
    let group = this.#bundles.get(shard);
    if (group === undefined) {
      group = new BundleGroup();
      group.name = "world-main-bundles";
      this.#host.add(group);
      this.#bundles.set(shard, group);
    }
    return group;
  }

  /** The recorded main batches, over every shard. */
  mainBundleChildren(): number {
    let children = 0;
    for (const group of this.#bundles.values()) children += group.children.length;
    return children;
  }

  /**
   * Where a freshly bound or grown main batch's mesh goes: the bundle group when it has been dressed
   * into one, the world otherwise. Three re-parents on `add`, so a bundled mesh has to be asked for
   * or it silently leaves the group it was recorded in.
   */
  attach(shared: SharedBatch): void {
    // A grow replaces the mesh object, so the marker `#bundleIn` set has to follow the batch's own
    // flag onto it. See `bundled`.
    shared.mesh.userData.tnBundled = shared.bundled;
    if (shared.bundled === true) this.shardOf(shared).add(shared.mesh);
    else this.#host.add(shared.mesh);
    // A record holds the object it was cut from, so a mesh that arrived by a rebind or a grow is not
    // the one the last record named: one re-record, and the record counts this mesh from here.
    if (shared.bundled === true) {
      shared.mesh.frustumCulled = false;
      shared.bundledCount = shared.mesh.count;
      this.bumpBundle(this.shardOf(shared));
    }
  }

  bundleGroup(shard: number): BundleGroup | undefined {
    return this.#bundles.get(shard);
  }

  clearCompileRecords(): void {
    this.#recordedWhileBusy.clear();
  }

  invalidateBundles(key: string): void {
    for (const group of this.#bundles.values()) this.bumpBundle(group);
    const chunks = this.#chunkBundles.get(key)?.group;
    if (chunks !== undefined) this.bumpBundle(chunks);
  }

  bundleStats(): IWorldCellsStats["bundle"] {
    return {
      children: this.mainBundleChildren() + this.#chunkBundleChildren,
      on: this.#bundlesWanted && (this.mainBundleChildren() > 0 || this.#chunkBundleChildren > 0),
      cpuMeshes: [...this.#host.shared().values()].filter(
        (shared) => shared.bundled && shared.gpu === undefined,
      ).length,
      gpuMeshes: [...this.#host.shared().values()].filter(
        (shared) => shared.bundled && shared.gpu !== undefined,
      ).length,
      eligibility: { ...this.#bundleSafety.stats },
      reason: this.#bundleReason,
      records: this.#bundleRecords,
    };
  }

  #rerecordOnPmremSwap(raw: unknown): void {
    const swaps = typeof raw === "object" && raw !== null ? Reflect.get(raw, "_tnPmremSwaps") : 0;
    if (typeof swaps !== "number" || swaps === this.#pmremSwaps) return;
    this.#pmremSwaps = swaps;
    for (const group of this.#bundles.values()) this.bumpBundle(group);
    for (const { group } of this.#chunkBundles.values()) this.bumpBundle(group);
  }

  flushCompiles(renderer: IRendererLike | undefined): void {
    // A bundle recorded while a compile was in flight left out every draw whose pipeline was not
    // ready, and the replay never re-checks; re-record those shards now that it has settled. Set
    // `#compileBusy` first, so this flush's own bumps are not added back to the set.
    const compiles = renderer?.compileCount ?? 0;
    const busy = renderer?.compiling === true || compiles !== this.#compileSeen;
    this.#compileSeen = compiles;
    this.#compileBusy = busy;
    this.#rerecordOnPmremSwap(renderer?.raw);
    if (!busy && this.#recordedWhileBusy.size > 0) {
      const recorded = [...this.#recordedWhileBusy];
      this.#recordedWhileBusy.clear();
      for (const group of recorded) if (group.parent !== null) this.bumpBundle(group);
    }
  }

  /** Whether the load asked for bundles at all, before a flag or a backend answered. */
  get wanted(): boolean {
    return this.#bundlesWanted;
  }

  /** Who decided that: the load's own option, a launch flag, or the default. */
  get reason(): string {
    return this.#bundleReason;
  }

  /** Every resident cell's chunk record, with the cull square whose answer shows or hides it. */
  chunkGroups(): Map<string, { readonly cluster: string; readonly group: BundleGroup }> {
    return this.#chunkBundles;
  }

  /** Reset the per-frame eligibility counters at the top of a cull pass. */
  beginFrame(): void {
    this.#bundleSafety.beginFrame();
  }

  /** Drop the surface-safety proofs, which a lost device makes stale. */
  release(): void {
    this.#bundleSafety.clear();
  }
}
