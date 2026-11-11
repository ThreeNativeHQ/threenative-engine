import {
  type Box3,
  type Camera,
  type InstancedMesh,
  type Material,
  Matrix4,
  type Object3D,
  Vector3,
} from "three";
import { renderGroup, uniform } from "three/tsl";
import type { BundleGroup } from "three/webgpu";
import { lodChainOf } from "./model-lod.js";
import {
  VIRTUAL_SHADOW_KEY_LAYER,
  VIRTUAL_SHADOW_SMALL_CASTER_LAYER,
} from "./render/virtual-shadow-layers.js";
import {
  type ITemporalLod,
  advanceTemporalLod,
  worldLodMaterial,
} from "./render/world-impostor-surface.js";
import type { IRendererLike } from "./renderer.js";
import { markStatic } from "./static-transform.js";
import type { ICasterScaleMesh, SharedBatch } from "./world-cell-batches.js";
import { levelTriangles } from "./world-cell-chunks.js";
import type { IAssetPart, IBatchShape, ICellBatch, IKeyDescriptor } from "./world-cell-data.js";
import { cullDistance, isAlphaFoliage } from "./world-cell-impostors.js";
import type { IAssetState } from "./world-cell-models.js";
import {
  UNDITHERED_LOD_WIDTH,
  assertSlotFree,
  freshMeshFor,
  indirectView,
  redressMaterial,
} from "./world-cell-render-util.js";
import type { ICellRenderHost } from "./world-cell-render.js";
import {
  VIRTUAL_SHADOW_CASTER_LAYER,
  VIRTUAL_SHADOW_WIDE_CASTER_LAYER,
} from "./world-chunk-shadow.js";
import {
  DRAW_ARGS_BYTES,
  type IAssetSlot,
  type ILiveAsset,
  type IMeshDraw,
  type IShadowLevel,
  type WorldGpuScene,
  liveKeyInstances,
} from "./world-gpu-scene.js";
import { frustumPlanes } from "./world-gpu-types.js";
import { localClip, localPoint } from "./world-root-frame.js";

/**
 * The mesh a key draws: its shape, its level's material, and the dress that points it at the GPU
 * scene's own buffers once the scene can run.
 *
 * A key's mesh is a view over shared storage, not a copy of the world: the same attributes, a fresh
 * object (three binds the `instanceMatrix` an object held when it built its node), and an indirect
 * record that names the region the dispatch compacts into. Everything here is that translation, plus
 * the gate table the dispatch reads for the asset the key belongs to.
 */

/** The gate table one asset publishes to the dispatch: its slots plus the part offsets it draws. */
export interface IPublishedGpuGates extends IAssetSlot {
  readonly locals: readonly (readonly Float32Array[])[];
}

/** What a dress needs from the renderer it dresses for. */
export interface ICellGpuDressHost {
  // The render host, by the names this module calls.
  add(object: Object3D): void;
  asset(id: string): IAssetState | undefined;
  camera(): Camera | undefined;
  canonical(id: string): string;
  carryPrewarm(old: ICasterScaleMesh, next: ICasterScaleMesh): void;
  isBundleHome(shared: SharedBatch): boolean;
  renderer(): IRendererLike | undefined;
  /** The world root's own `matrixWorld`: the frame its placements are recorded in. */
  root(): Matrix4;

  // The batches, the scene and the state the dress shares with the rest of the renderer.
  shared(): Map<string, SharedBatch>;
  retired(): Map<string, SharedBatch>;
  resident(): Map<string, number>;
  gpuScene(): WorldGpuScene;
  lodMaterials(): Map<string, { readonly source: Material; readonly material: Material }>;
  /** The adaptive LOD bias the kernel and the materials scale distance by. */
  lodDistanceBias(): Parameters<typeof worldLodMaterial>[6];
  lodHysteresis(): number;
  lodTransition(): "band" | "none" | "temporal";
  lodSpatial(): boolean;
  receiveShadow(): boolean;
  preserveAuthoredParts(): boolean;
  freshCount(): number;
  extentBounds(): Box3;
  visibleSquares(): Set<string>;
  freshAllowance(): number;

  // The bundle record and the shadow claims, asked through the facade.
  attach(shared: SharedBatch): void;
  bumpBundle(group: BundleGroup): void;
  bundleIn(shared: SharedBatch, reuseSafety?: boolean): void;
  bundleOut(shared: SharedBatch): void;
  shardOf(shared: SharedBatch): BundleGroup;
  shadowFloorOf(assetId: string): number;
  shadowKeyFor(key: IKeyDescriptor, part: IAssetPart): void;
}

/** The scratch a draw's own planes are built in, reused per frame. */
const _gpuEye = new Vector3();
const _cullProjScreen = new Matrix4();

export class CellGpuDress {
  readonly #host: ICellGpuDressHost;

  constructor(host: ICellGpuDressHost) {
    this.#host = host;
  }

  readonly #publishedGpuGates = new Map<string, IPublishedGpuGates>();
  readonly #gpuLevelKeys = new Map<string, Array<{ firstKey: number; parts: number }>>();
  readonly #gpuPlanes = new Float32Array(24);

  readonly #lodEye = uniform(new Vector3()).setGroup(renderGroup);

  /** UE's two lagged view origins and their blend, for `lodTransition: "temporal"`. */
  readonly #temporalLod: ITemporalLod = {
    from: new Vector3(),
    to: new Vector3(),
    fromTime: Number.NaN,
    toTime: Number.NaN,
    alpha: 1,
  };

  readonly #lodFrom = uniform(this.#temporalLod.from).setGroup(renderGroup);

  readonly #lodTo = uniform(this.#temporalLod.to).setGroup(renderGroup);

  readonly #lodAlpha = uniform(1).setGroup(renderGroup);

  /** Seconds since this renderer started; a swap stamps it so `worldLodMaterial` can fade the change. */
  readonly #lodClock = uniform(0).setGroup(renderGroup);

  readonly #lodClockOrigin = performance.now();

  /**
   * The shape the coarse wide half draws for one `(level, part)`, or `fallback` when the level has no
   * honest coarse counterpart. Shared by {@link #shapeFor} and the prewarm, so the mesh minted behind
   * the gate carries the same geometry the swap would later ask for — a prewarm built from the
   * coarsest level's part 0 and then handed back unchanged is the wrong shape for good.
   */
  wideShape(
    asset: IAssetState | undefined,
    level: number,
    part: number,
    fallback: IBatchShape,
  ): IBatchShape {
    if (this.#host.preserveAuthoredParts()) return fallback;
    const terminal = asset?.levels.at(-1);
    // The whole-asset impostor is the one case where a part index has no meaning: it is a single
    // representation of every LOD0 part, so every part routes through it. `terminal?.[0]` is only
    // that shape. On the source-only path the terminal must have a part at this index with the same
    // role — an alpha slot drawn with an opaque part's shape (or vice versa) is a different object,
    // and a terminal with fewer parts must not fall back to part 0's, which duplicates it.
    if (asset?.impostor !== undefined) {
      const coarse = terminal?.[0];
      if (coarse !== undefined) return coarse;
    }
    const coarse = terminal?.[part];
    const source = asset?.levels[level]?.[part];
    if (
      coarse !== undefined &&
      source !== undefined &&
      isAlphaFoliage(source.material) === isAlphaFoliage(coarse.material)
    )
      return coarse;
    return fallback;
  }

  shapeFor(
    entry: ICellBatch,
    role: "cluster" | "key" | "main" | "wide",
    level = entry.level,
  ): IBatchShape {
    // A batch cast at a finer level than its own (`#castLevelOf`) draws that level's part.
    const own =
      level === entry.level
        ? { geometry: entry.batch.geometry, material: entry.batch.material }
        : (this.#host.asset(entry.asset)?.levels[level]?.[entry.part] as IAssetPart);
    const shape =
      role === "wide"
        ? this.wideShape(this.#host.asset(entry.asset), level, entry.part, {
            geometry: own.geometry,
            material: own.material,
          })
        : { geometry: own.geometry, material: own.material };
    return {
      ...shape,
      material: this.#lodSurface(entry.asset, level, entry.part, shape.material),
    };
  }

  #lodSurface(assetId: string, level: number, partIndex: number, source: Material): Material {
    assertSlotFree(source, assetId);
    const asset = this.#host.asset(assetId);
    const part = asset?.levels[level]?.[partIndex];
    if (this.#host.lodHysteresis() <= 0 || !asset || !part || asset.distances.length < 2)
      return source;
    const publishedRanges = !this.#host.gpuScene().on;
    const floor = this.#host.shadowFloorOf(assetId);
    const key = `${assetId}:${level}:${partIndex}:${asset.distances.length}:${publishedRanges ? 1 : 0}:${floor}`;
    let cached = this.#host.lodMaterials().get(key);
    if (cached !== undefined && cached.source !== source) {
      cached.material.dispose();
      this.#host.lodMaterials().delete(key);
      cached = undefined;
    }
    if (cached === undefined) {
      const material = worldLodMaterial(
        source,
        part.local,
        asset.distances,
        level,
        // Outside "band" the gate is too thin to cover a pixel step: each placement takes one level.
        this.#host.lodTransition() === "band" ? this.#host.lodHysteresis() : UNDITHERED_LOD_WIDTH,
        this.#lodEye,
        this.#host.lodDistanceBias(),
        this.#host.lodSpatial(),
        publishedRanges,
        // "none" pops: no clock, so a late refilter does not dissolve either.
        this.#host.lodTransition() === "none" ? undefined : this.#lodClock,
        this.#host.lodTransition() === "temporal"
          ? { from: this.#lodFrom, to: this.#lodTo, alpha: this.#lodAlpha }
          : undefined,
        floor,
      );
      cached = { source, material };
      this.#host.lodMaterials().set(key, cached);
    }
    return cached.material;
  }

  updateLodEye(x: number, y: number, z: number): void {
    this.#lodEye.value.set(x, y, z);
    this.#lodClock.value = (performance.now() - this.#lodClockOrigin) / 1000;
    if (this.#host.lodTransition() !== "temporal") return;
    advanceTemporalLod(this.#temporalLod, this.#lodEye.value, this.#lodClock.value);
    this.#lodAlpha.value = this.#temporalLod.alpha;
  }

  refreshLodMaterials(asset: IAssetState): void {
    for (const shared of this.#host.shared().values()) {
      if (!shared.mesh.name.startsWith(`${asset.id}:`)) continue;
      const [levelText, partText] = shared.mesh.name.slice(asset.id.length + 1).split(":");
      const level = Number(levelText);
      const partIndex = Number(partText?.split("@")[0]);
      const part = asset.levels[level]?.[partIndex];
      if (part !== undefined) {
        const material = this.#lodSurface(asset.id, level, partIndex, part.material);
        if (
          material.userData.tnPublishedLodRange === true &&
          shared.mesh.geometry.getAttribute("tnPublishedLodRange") === undefined &&
          shared.mesh.count === 0
        )
          shared.rebind(part.geometry, material);
        else shared.surface(material);
        this.#host.bundleOut(shared);
        this.#host.bundleIn(shared);
      }
    }
  }

  impostorDrawn(): number {
    let drawn = 0;
    for (const shared of this.#host.shared().values()) {
      if (
        shared.role === "main" &&
        shared.mesh.visible &&
        Reflect.get(shared.mesh.material, "userData")?.tnWholeAssetImpostor === true
      )
        drawn += shared.live;
    }
    return drawn;
  }

  /**
   * The shadow half of the split, and the two granularities of it. A caster mesh lives alone on
   * `VIRTUAL_SHADOW_CASTER_LAYER` — one per world-grid square, which a level whose window is a
   * fraction of the ring culls down to the squares it covers — and a wide mesh alone on
   * `VIRTUAL_SHADOW_WIDE_CASTER_LAYER`, one per key, which a level whose window covers the ring
   * submits once. The level cameras draw one of the two layers and never both, so a key costs the
   * main pass one draw, a fine level a few and a wide level one. Neither receives: nothing but a
   * shadow level ever sees either. A main mesh keeps layer 0 and casts nothing, because its records
   * reach the shadow maps only through a caster half.
   */
  dressMesh(shared: SharedBatch, receiveShadow: boolean): void {
    const mesh = shared.mesh;
    const role = shared.role;
    // Every role's records are written into the instance buffer, never moved in the world, and the
    // mesh is created and released per role — so this is the one place that covers a fresh mesh, a
    // rebound one and the three roles. Static here is only safe because every write announces
    // itself: `instanceMatrix.needsUpdate` bumps the attribute's version, which is what a settled
    // draw watches to know it still has to scan.
    markStatic(mesh);
    if (role !== "main") {
      mesh.layers.set(
        role === "cluster"
          ? VIRTUAL_SHADOW_CASTER_LAYER
          : role === "key"
            ? VIRTUAL_SHADOW_KEY_LAYER
            : shared.smallCaster
              ? VIRTUAL_SHADOW_SMALL_CASTER_LAYER
              : VIRTUAL_SHADOW_WIDE_CASTER_LAYER,
      );
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      return;
    }
    mesh.layers.set(0);
    mesh.castShadow = false;
    mesh.receiveShadow = receiveShadow;
    // The origin a draw of this mesh is counted under until the GPU scene dresses it
    // (`RenderPassBudget`). `#dressGpu` runs straight after this and overwrites it with `gpuScene`
    // when the key really is dressed, so what survives here is a main batch the CPU path draws per
    // object — a backend with no compute, `gpuScene: false`, or a dress that gave up. A caster half
    // returns above and keeps no origin: it lives off layer 0, so the main pass never counts it.
    mesh.userData.tnDrawSource = "instanced";
    // Nothing to hang off a main mesh: the window is narrowed by `#cullMainPass` for the whole set,
    // because a batch that drew nothing is hidden and three never reaches an invisible mesh's own
    // hooks — a mesh that could only re-narrow itself in its `onBeforeRender` would stay hidden for
    // as long as the camera looked away. That leaves `onBeforeRender` to the prewarm borrow alone.
  }

  /**
   * Name one main key to the GPU scene, and dress its mesh against the scene's live buffers.
   *
   * A caster or wide key is named `@x,z` or `@*` and belongs to the shadow passes, which the GPU scene
   * does not touch, so those are left exactly as they were.
   *
   * The key is recorded whether or not the scene is on, because a prewarm mints a whole ring before
   * the first frame that can answer whether this backend can run the scene, and a key recorded only
   * when the dress happened is a key the scene is never told about. `#seedGpuKeys` comes back for
   * those; see there.
   */
  adoptGpu(shared: SharedBatch, assetId: string, key: string, level: number, part: number): void {
    if (shared.role !== "main") return;
    const named = { asset: this.#host.canonical(assetId), key, level, part };
    shared.main = named;
    if (this.#host.gpuScene().on === false) return;
    shared.gpu = named;
    this.dressGpu(shared, named);
  }

  /**
   * The coarse gate for the GPU-dressed main pass, computed per asset and reused across every level
   * and part of it.
   *
   * A key's own CPU squares are the level the follow point picked when it built them, and the
   * dispatch re-picks the level from the camera every frame — so a key the CPU never gave a cell to
   * can be exactly the one the dispatch draws, and a per-key answer hid it: a tree walked into at a
   * level it was not built at disappeared. One conservative answer per asset — any key holds a
   * visible cell, or still owes its prewarm draw — is what shows all of them, and the indirect
   * record decides what each one actually draws.
   */
  applyGpuMain(dressed: readonly { asset: string; shared: SharedBatch }[]): void {
    const shown = new Map<string, boolean>();
    for (const { asset, shared } of dressed) {
      if (shown.get(asset) === true || shared.seenIn(this.#host.visibleSquares()))
        shown.set(asset, true);
      else if (shown.has(asset) === false) shown.set(asset, false);
    }
    for (const { asset, shared } of dressed) shared.applyGpuVisible(shown.get(asset) === true);
  }

  /**
   * Point one main key's mesh at the GPU scene's buffers, and hand the asset's gate table over.
   *
   * The mesh's `instanceMatrix` becomes the shared compacted matrix buffer, its geometry a clone that
   * shares the part's own attributes and carries this key's indirect record, and its whole-mesh
   * frustum test is off — the dispatch already tested every instance against the camera's six
   * planes, and the mesh's own bounds are the whole resident ring. Idempotent: a settled frame's
   * buffers are the ones it was dressed against, and a regrow, a rebind or a `grow` replaces them,
   * which is the only thing that brings a dressed mesh back through here.
   *
   * A key whose placements outgrew its region is regrown here rather than silently dropping instances
   * against the capacity guard, which is what a fixed ceiling did to any key a walk filled past.
   *
   * The buffers are read after `scene.key` rather than before it, because minting the first key is
   * what allocates them: a dress that gave up on their absence was a dress that never happened, and
   * the only frame that would have retried it was one whose fast path had already found the mesh
   * dressed. A regrow replaces them, so the attribute handed to the mesh is the one a draw will read.
   */
  dressGpu(shared: SharedBatch, key: IKeyDescriptor): void {
    const scene = this.#host.gpuScene();
    const asset = this.#host.asset(key.asset);
    const part = asset?.levels[key.level]?.[key.part];
    if (asset === undefined || part === undefined) return;
    // The asset's own resident placements, not one level's share of them: a placement's level is
    // decided per frame from where the camera is, so every level's region has to hold all of them.
    const capacity = Math.max(shared.liveCeiling, this.#host.resident().get(key.asset) ?? 0);
    const settled = scene.drawn;
    const held = scene.regionOf(key.key);
    // The args buffer and the drawn buffer are allocated and grown independently: minting a key
    // grows `args` and leaves `drawn` the object it was, so the mesh's `instanceMatrix` and its
    // indirect record can point at two different generations. The fast path used to watch only
    // `drawn`, and a mesh left holding an old args record was one the dispatch no longer wrote —
    // a forest that drew nothing while the readback said the counts were correct.
    const geometry = shared.mesh.geometry;
    const liveArgs = scene.args;
    const bound =
      liveArgs !== undefined &&
      geometry.indirect === liveArgs &&
      geometry.indirectOffset === (held?.argsIndex ?? -1) * DRAW_ARGS_BYTES;
    if (
      settled !== undefined &&
      shared.mesh.instanceMatrix === settled &&
      shared.mesh.frustumCulled === false &&
      (held?.capacity ?? 0) >= capacity &&
      bound &&
      // Where the mesh hangs is part of what this pass owns: a batch that was retired and handed back
      // by a rebind is a child of the world again, and the bundle that last recorded it no longer
      // draws it. Without this the walk would re-mint a key into a bundle that is missing it.
      this.#host.isBundleHome(shared)
    ) {
      // A sibling may have grown the level's capacity without moving this mesh, so the submission
      // bound follows the live region rather than the dress that wrote it. See `gpuCount`.
      shared.gpuCount = held?.capacity ?? shared.gpuCount;
      this.#host.shadowKeyFor(key, part);
      return;
    }
    const region = scene.key(key.key, new Float32Array(part.local.elements), capacity, {
      group: `${key.asset}:${String(key.level)}`,
      part: key.part,
      // The whole run at once, so a part minted later lands in the slot `firstKey + part` names
      // rather than at the end of the key space, where another level's key is in between.
      parts: (asset.levels[key.level] as readonly IAssetPart[]).length,
    });
    if (region === undefined) return;
    const levels = this.#gpuLevelKeys.get(key.asset) ?? [];
    levels[key.level] = {
      firstKey: region - key.part,
      parts: asset.levels[key.level]?.length ?? 0,
    };
    this.#gpuLevelKeys.set(key.asset, levels);
    const drawn = scene.drawn;
    const args = scene.args;
    const args2 = scene.regionOf(key.key);
    if (drawn === undefined || args === undefined || args2 === undefined) return;
    // Before the mesh is dressed, so the republish a replacement does takes the dressed branch and
    // submits at this bound rather than at a zero the CPU never drew. See `gpuCount`.
    shared.gpuCount = args2.capacity;
    // Before the mesh is dressed, so the republish a replacement does takes the dressed branch: a
    // batch that draws from the scene's buffers is shown by the per-asset gate in `#cullMainPass`,
    // not by its own count.
    shared.gpu = key;
    const mesh = shared.mesh;
    // Its own geometry object, so the indirect record is this mesh's, over the SAME attributes: the
    // original is the shape the caster halves and a rebind still draw with. `clone()` would copy
    // every vertex buffer of every key a second time.
    const view = indirectView(mesh.geometry, args, args2.argsIndex * DRAW_ARGS_BYTES);
    // A mesh three has already compiled cannot be re-dressed by writing fields onto it: its node
    // binds the `instanceMatrix` the object held at that compile, and three keeps that binding for
    // the object's whole life. A regrow is the same case — a new `drawn` attribute is a new binding
    // for the same reason — so both take the same road: a fresh object carrying everything the old
    // one had, and the old one let go. Measured on machinefall, where the prewarm had compiled every
    // main batch on the CPU path: 3,724 indirect draws submitted in 2 s over records that were
    // correct at draw time, and a dressed forest that drew nothing, until the meshes were fresh
    // objects; a material of its own (below) never changed that on its own.
    if (mesh.instanceMatrix !== drawn) {
      const next = freshMeshFor(mesh, view, mesh.count) as ICasterScaleMesh;
      redressMaterial(next);
      this.#host.carryPrewarm(mesh, next);
      this.seat(shared.replaceMesh(next), next);
      next.instanceMatrix = drawn;
      next.frustumCulled = false;
    } else {
      mesh.geometry = view;
      mesh.instanceMatrix = drawn;
      mesh.frustumCulled = false;
    }
    // What the record has to say for the draw to name a triangle: the view's own index count, which
    // is the shape this key draws. The scene is told rather than left to guess, so its validation can
    // hold the record against it.
    scene.indexCount(key.key, view.index?.count ?? 0);
    // The asset's gate table is built from the keys minted so far, so a level whose key is not minted
    // yet carries no parts and the dispatch draws that level nowhere. Re-registering is a no-op while
    // the table holds, and a rewrite when a key joined it.
    scene.slot(key.asset, this.gatesOf(key.asset, asset));
    // The origin this key's main-pass draws are counted under, read off the object at the draw
    // (`RenderPassBudget`). Written after the mesh swap above, so a re-dressed fresh object carries
    // it, and before `#bundleIn`, which supersedes it with `tnBundled` for a world with bundles on.
    shared.mesh.userData.tnDrawSource = "gpuScene";
    // The bundle the last settled frame replayed is now wrong: this pass minted or regrown a key,
    // swapped the geometry, or took a fresh mesh object onto the scene's new buffers. Reaching here
    // is one of the three, which is why this is the only place a re-record happens — the fast path
    // above is every other frame of the walk.
    this.#host.bundleIn(shared);
    if (shared.bundled === true) this.#host.bumpBundle(this.#host.shardOf(shared));
    // The shadow twin of this key, minted and dressed on the same pass that named the main one: a
    // level that draws keys finds its mesh in the same frame the main pass found its buffer, and a
    // regrown twin is re-dressed here rather than left on the buffer the dispatch replaced.
    this.#host.shadowKeyFor(key, part);
  }

  /**
   * The replacement takes the old object's place, and the old one is let go: `InstancedMesh.dispose`
   * frees nothing the replacement shares — the vertex buffers and the part's own material belong to
   * the refcount path that made them.
   *
   * Through `add` and `removeFromParent` rather than by writing `parent` and `children`, because
   * three fires `childadded`/`childremoved` on the way and the clustered-mesh tracker answers the
   * world's arrivals and departures by those alone. The old slot is restored afterwards, so the
   * parent's traversal order — and so every draw's order within a frame — is what it was.
   */
  seat(old: InstancedMesh, next: InstancedMesh): void {
    const parent = old.parent;
    if (parent === null) this.#host.add(next);
    else {
      const at = parent.children.indexOf(old);
      old.removeFromParent();
      parent.add(next);
      const here = parent.children.indexOf(next);
      if (at >= 0 && here >= 0) {
        parent.children.splice(here, 1);
        parent.children.splice(at, 0, next);
      }
    }
    old.dispose();
  }

  /**
   * The asset's own gates, as the kernel reads them: the CPU path's switch distances and cull
   * distance, and the scene key each level's parts draw into. A level with no minted key has no parts,
   * so the dispatch draws nothing at that level rather than reading a key that is not there.
   */
  publishGpuGates(asset: IAssetState): void {
    const gates = this.gatesOf(asset.id, asset);
    this.#publishedGpuGates.set(asset.id, {
      cull: gates.cull,
      distances: [...gates.distances],
      impostor: gates.impostor,
      shadowFallback: gates.shadowFallback,
      levels: gates.levels.map((level) => ({ ...level })),
      locals: asset.levels.map((parts) =>
        parts.map((part) => Float32Array.from(part.local.elements)),
      ),
    });
  }

  gatesOf(id: string, asset: IAssetState): IAssetSlot {
    const gates: { firstKey: number; parts: number }[] = [];
    // The level's own contiguous run, which is what the kernel's `firstKey + part` addresses. The
    // owner records it when dressing the key; reading it back from the scene would make the mesh
    // check agree with a corrupted GPU gate table instead of checking that table independently.
    const keyed = this.#gpuLevelKeys.get(id);
    for (const [level] of asset.levels.entries())
      gates.push(keyed?.[level] ?? { firstKey: 0, parts: 0 });
    return {
      cull: cullDistance(asset.definition.maxDistance),
      distances: asset.distances,
      // A generated terminal gate is based on the unit asset sphere and scales per placement. An
      // authored impostorDistance is already a world-metre cutoff and stays fixed across scales.
      impostor: asset.impostor !== undefined && asset.definition.impostorDistance === undefined,
      shadowFallback: asset.definition.lods === undefined,
      levels: gates,
    };
  }

  /**
   * Dress every main batch the world already holds, the mirror of {@link #seedGpuSources} for the
   * keys rather than the sources: the keys a prewarm minted on the loading screen were minted with
   * the scene off, and a key is only named at mint time, so a ring built that way came up with an
   * empty region table and every batch still drawing from its own buffer. The dispatch was drawing
   * 21,094 placements into no region at all, and the validation marker said so — `compared=0` — for
   * a scene that reported itself on.
   *
   * The pool is seeded with the rest: a retained key's mesh is handed back by a rebind rather than
   * re-minted, and rebinding replaces the instance buffer, so a parked batch is undressed by the
   * park and dressing it here is what leaves the walk with a key that is already in the table. From
   * here every main batch carries `gpu`, which is what puts it on the dispatch's per-instance answer
   * and off the CPU repack and the refilter.
   */
  seedGpuKeys(): void {
    for (const shared of [...this.#host.shared().values()]) this.seedGpuKey(shared);
    for (const shared of this.#host.retired().values()) this.seedGpuKey(shared);
  }

  /** Dress one undressed main batch, or leave a batch the scene does not touch. */
  seedGpuKey(shared: SharedBatch): void {
    // `main` is the key; `gpu` is the mesh pointing at the scene's buffers. A dressed mesh is left
    // alone, and `#dressGpu` says so itself — it is idempotent against the buffers it was given.
    if (shared.main === undefined || shared.gpu !== undefined) return;
    this.dressGpu(shared, shared.main);
  }

  /**
   * The main meshes the scene owns and the main meshes the world holds, live and pooled, which is
   * the `dressed=N/M` the marker carries. A scene reporting itself on over a ring it never dressed
   * read `dressed=0/21094` on nothing, so the number is the owner's: the scene cannot see the meshes.
   */
  gpuCensus(): { readonly dressed: number; readonly meshes: number } {
    let dressed = 0;
    let meshes = 0;
    for (const batch of [...this.#host.shared().values(), ...this.#host.retired().values()]) {
      if (batch.role !== "main") continue;
      meshes += 1;
      if (batch.gpu !== undefined) dressed += 1;
    }
    return { dressed, meshes };
  }

  /**
   * Every dressed main mesh's own draw, and what this class's **live** state says it must be holding.
   *
   * The scene's own validation mirrors its own kernel, so a key, a record, a gate table and a mesh
   * that do not correspond are one both sides reproduce and a check that reports `ok` over a forest
   * drawn with another tree's geometry. These are the three numbers that are not the scene's: the
   * mesh's own name, the record its own geometry points at (`indirectOffset`, which a dress wrote),
   * and the instances the owner's own state selects for that name — `asset.distances` as
   * {@link levelAt} reads it right now, `cullDistance(definition.maxDistance)`, the camera's own six
   * planes over the scene's own placements, and each part's own offset composed in exactly as the
   * dispatch composes it.
   *
   * Not the per-cell records this path's own refilter left behind: the GPU scene bypasses that
   * refilter, so the moment it does, the records a mesh is checked against are a snapshot of a
   * level selection that no longer applies. A far placement is then compared against a set that
   * counted it at its near level, and the check reads `ok` over the picture it cannot see.
   */
  gpuDraws(): readonly IMeshDraw[] {
    const camera = this.#host.camera();
    if (camera === undefined) return [];
    const lives = this.liveGates();
    if (lives.size === 0) return [];
    // The dispatch's own camera, its own planes: this is asked for inside the dispatch that is
    // running, so the eye and the six planes are the ones the kernel is reading now — and, like the
    // dispatch's, in the root's frame, because that is the frame the placements are recorded in.
    const root = this.#host.root();
    const planes = this.#gpuPlanes;
    frustumPlanes(localClip(_cullProjScreen, camera, root), planes);
    localPoint(_gpuEye.setFromMatrixPosition(camera.matrixWorld), root);
    const expected = liveKeyInstances(
      this.#host.gpuScene().placements,
      (slot) => {
        const id = this.#host.gpuScene().slotAsset(slot);
        return id === undefined ? undefined : lives.get(id);
      },
      { planes, x: _gpuEye.x, y: _gpuEye.y, z: _gpuEye.z },
    );
    const draws: IMeshDraw[] = [];
    const args = this.#host.gpuScene().args;
    for (const shared of this.#host.shared().values()) {
      if (shared.role !== "main" || shared.gpu === undefined) continue;
      const geometry = shared.mesh.geometry;
      // `indirectOffset` is typed as an offset or a list of them; a scene's own record is one
      // number, and a list is not a record this check can name, so it is not compared.
      const offset = geometry.indirectOffset;
      if (geometry.indirect === undefined || typeof offset !== "number") continue;
      const region = this.#host.gpuScene().regionOf(shared.mesh.name);
      draws.push({
        // The actual binding, asked of the mesh and the scene at this turn, not the record number:
        // an offset can name the right record while the mesh reads an older args buffer with the
        // same layout, and the field is what lets the check see a stale binding at all.
        bound:
          args !== undefined &&
          geometry.indirect === args &&
          offset === (region?.argsIndex ?? -1) * DRAW_ARGS_BYTES,
        instances: expected.get(shared.mesh.name) ?? new Float32Array(0),
        name: shared.mesh.name,
        record: offset / DRAW_ARGS_BYTES,
      });
    }
    return draws;
  }

  /**
   * Every adopted asset's own gates as they stand right now, keyed by id.
   *
   * The part offsets are copied out of each part's `Matrix4` once per check, because the composition
   * reads them as `Float32Array`s and a part's matrix is what the dispatch already composed with.
   */
  liveGates(): Map<string, ILiveAsset> {
    const out = new Map<string, ILiveAsset>();
    const slots = this.#host.gpuScene().gates();
    for (const [slot] of slots.entries()) {
      const id = this.#host.gpuScene().slotAsset(slot);
      const asset = id === undefined ? undefined : this.#host.asset(id);
      const published = id === undefined ? undefined : this.#publishedGpuGates.get(id);
      if (asset === undefined || published === undefined) continue;
      out.set(asset.id, {
        cull: published.cull,
        distances: published.distances,
        id: asset.id,
        impostor: published.impostor,
        locals: published.locals,
      });
    }
    return out;
  }
  /** Give back the gate tables, which a lost device makes stale. */
  release(): void {
    this.#publishedGpuGates.clear();
    this.#gpuLevelKeys.clear();
  }

  /** The clock a swap stamps a rebuilt key's ranges with, in seconds since this renderer started. */
  get clockSeconds(): number {
    return this.#lodClock.value as number;
  }
}
