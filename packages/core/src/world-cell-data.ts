import type {
  Box3,
  BufferGeometry,
  Camera,
  InstancedMesh,
  Material,
  Matrix4,
  Mesh,
  Object3D,
} from "three";

import type { IAssetLoader } from "./assets.js";
import type { InstancedBatch } from "./instanced-batch.js";
import type { OcclusionMode } from "./render/depth-pyramid.js";
import type { SharedBatch } from "./world-cell-batches.js";
import type { CellProxySelection, IPreparedCellProxy } from "./world-cell-proxy.js";

import type { IAssetState } from "./world-cells.js";
import type { IWorldCell, IWorldPackage, IWorldRun } from "./world-package.js";

import type { IWorldTilesOptions } from "./world-tiles.js";

/** The point a streamed world follows; an `Object3D` satisfies this shape. */
export interface IWorldCellsFollow {
  readonly position: { readonly x: number; readonly y?: number; readonly z: number };
}

/** Hard caps on what stays resident. A cap that is reached reports pressure, it never throws. */
export interface IWorldCellsBudget {
  readonly residentCells: number;
  readonly instances: number;
  /** Placement-record bytes (`32` per instance) the resident cells are allowed to weigh. */
  readonly bytes: number;
}

/** Terrain options forwarded to the composed `TerrainTiles`; `tileSize` defaults to `cellSize`. */
export interface IWorldCellsTerrainOptions {
  readonly tileSize?: number;
  readonly tileResolution?: number;
  readonly lodFactors?: readonly number[];
  readonly lodDistances?: readonly number[];
  readonly skirtDepth?: number;
  /**
   * Tiles kept resident around the follow tile, independent of the cell `ring`: terrain can reach
   * to the horizon while props stay near. Defaults to `ring`, so raising only this widens the
   * ground without widening the props, and the far tiles take the coarser `lodDistances` levels.
   */
  readonly streamRadius?: number;
  /**
   * Tiles that get a `createCollider` body, by Chebyshev radius from the follow tile. Defaults to
   * `ring`. A tile entering or leaving it creates or disposes its collider, so a wide terrain
   * radius does not have to mean a physics body for every tile in it.
   */
  readonly colliderRadius?: number;
}

export interface IWorldCellsLoadOptions {
  /**
   * Logical path of `world.json` (`world/world.json`); every other path in the package resolves
   * against it. A leading `/` is accepted and stripped, so an uncompiled `public/world` keeps
   * working.
   */
  readonly url: string;
  /**
   * Loader the package's paths resolve through — its manifest, or the authored names when there is
   * none. Defaults to a fresh `createAssetLoader()`; inside a game, pass `ctx.assets` so the
   * package's compiled output and compressed textures reach the renderer the game booted with.
   *
   * The world releases the source models it asks this loader for only when it created the loader
   * itself: each asset's requested level paths are released through `release("model", path)` once
   * the last asset naming a path is gone, so a streamed package does not pin an internally owned
   * cache. An explicitly supplied loader is the caller's — the world never releases its cache, so a
   * second game or world holding the same model keeps it alive; the caller ends that lifetime with
   * its own `release`. The loader is never cleared, and a path this world never asked for is never
   * touched either way.
   */
  readonly assets?: IAssetLoader;
  /** Game-owned terrain surface, handed straight to `TerrainTiles`. */
  readonly surface: IWorldTilesOptions["surface"];
  /** Passed straight to `TerrainTiles` for per-tile colliders. */
  readonly createCollider?: IWorldTilesOptions["createCollider"];
  /** Read once per update; an `Object3D` works. */
  readonly follow: IWorldCellsFollow;
  /** Called when a nonempty cell batch becomes visible to the renderer. */
  readonly onPublication?: (bounds: Box3) => void;
  /** Chebyshev radius in cells to keep resident; a cell leaves only beyond `ring + 1`. */
  readonly ring: number;
  readonly budgets: IWorldCellsBudget;
  /** False streams props/chunks only; the caller owns terrain geometry and collision. */
  readonly terrain?: IWorldCellsTerrainOptions | false;
  /** Cooked cell proxies are considered by default; false retains source rendering. Static CPU
   * cells only, with strict measured triangle/draw savings and projected-error hysteresis.
   * Source collision and shadow representations stay resident; unsupported sources retain detail. */
  readonly hlod?: boolean;
  /** Optional immutable per-record 3D draw reach in metres, indexed like placements.
   * Nonnegative finite values or Infinity (no extra limit); combined with asset maxDistance.
   * Filtered by the existing admission/refilter budget, never by a separate culler.
   */
  readonly placementReach?: Float32Array;
  /** Inward return margin for authored CPU LODs, in [0, 1). Requires gpuScene:false; when
   * combined with automatic impostors, also requires preserveAuthoredParts and authored distances.
   * Omitted, selection uses the existing direct gates. State survives cell eviction/revisit. */
  readonly lodHysteresis?: number;
  /** Preserve supplied part/material identity and exact authored LOD membership, including shadow batches. Automatic impostors require each asset to author `impostorDistance`.
   * Default content sharing and missing-alpha-part coverage remain enabled when omitted. */
  readonly preserveAuthoredParts?: boolean;
  /** Already decoded immutable world-v1 data; URL still supplies the base for model paths. */
  readonly data?: {
    readonly manifest: IWorldPackage;
    readonly placements: ArrayBuffer;
    /** Omitted values load the manifest heightmap unless terrain is false. */
    readonly heightmap?: Uint16Array;
  };
  /**
   * How a scattered part whose own material is `transparent` is drawn. `"cutout"` (the default)
   * gives the part a clone of that material with `transparent: false` and an `alphaTest`, so the
   * instanced draw needs no per-instance sorting and the depth buffer rejects what is behind it;
   * `"blend"` draws the material as authored. One clone per asset part, never per cell.
   */
  readonly transparentScatter?: "cutout" | "blend";
  /**
   * Shadows for the streamed world, all off by default. `cast` makes scattered batches cast into
   * the scene's shadow map. Their `castLevels` finest distance levels (default 1: the near shape)
   * each cast their own shape; a placement drawn at a coarser level of a chain casts with the
   * coarsest of those, so it keeps its shadow without a caster mesh per level — every level casting
   * its own minted ~3x the casters and the churn showed as garbage collection on a walk (PRD-541).
   * Authored `lods` past `castLevels` cast nothing. `receive` lets scatter and terrain receive
   * shadows.
   */
  readonly shadows?: {
    readonly cast?: boolean;
    readonly castLevels?: number;
    readonly receive?: boolean;
    /**
     * @deprecated Accepted and ignored. Clusters replace it: what a shadow level submits is bounded
     * by the clusters its own window covers, not by a hand-tuned radius. It still validates, so a
     * game that set it keeps compiling and keeps loading.
     */
    readonly castDistance?: number;
    /**
     * Called in a batch at most once a second after streamed records changed, so the shadow levels
     * that read them redraw. A call with no region asks `VirtualShadowNode.invalidateAll`;
     * nothing changed means no call.
     *
     * Admissions and evictions are separate calls, each with the union of the bounds of the records
     * that changed — the placement position widened by the asset's own bounds, unioned over the
     * records of this update and nothing else, so a hook that forwards it to
     * `VirtualShadowNode.invalidateRegion` redraws the levels whose window covers them and leaves
     * the rest of the cascade holding its maps. A call with no region is still a blanket one: the
     * prewarm passes it while a caster's first draw is owed, and there is no region for that.
     */
    readonly invalidate?: (region?: IShadowRegion) => void;
    /**
     * An asset whose authored bounds are shorter than this casts into the finest shadow level only,
     * default 1.5 m. Ground cover below it — ferns, grass, bushes — casts a shadow that is sub-texel
     * noise at every range a wide level covers, and costs one draw per key per level there. Raise it
     * to draw everything at every range, lower it to cull more. Measured on the authored bounds, so
     * a package that scales a fern up four times is judged on the un-scaled fern.
     */
    readonly smallCasterMetres?: number;
  };
  /**
   * Triangles a hand-placed chunk's merged material group may reach before one of its
   * `InstancedMesh` is left instanced. Defaults to 43,690, the same 4 MiB
   * budget the merged buffers are split on counted in the worst case, a de-indexed triangle: a merged
   * group is a single draw, so expanding into it wins until the merged geometry is too big for the
   * frame, and above it the instanced draw is the cheaper of the two. A group that crosses the budget
   * is split into several meshes in traversal order rather than grown, and an instanced shape over
   * 2,048 triangles is never expanded. Everything else in a chunk merges regardless — one mesh per
   * material, in the main pass and in every shadow pass that redraws it.
   */
  readonly chunkMergeMaxTriangles?: number;
  /**
   * `(url) => Promise<Object3D>`, overriding `assets.model`; a raw `GLTFLoader` or a game's own
   * loader works. The url is the authored one, so a compiled package wants `assets` instead.
   */
  readonly loadModel?: (url: string) => Promise<Object3D>;
  /**
   * Model loads in flight at once, assets and chunks together. Defaults to `loadAll`'s
   * `concurrency`, six.
   */
  readonly concurrency?: number;
  /**
   * Cell-asset batches refiltered per `update`, nearest cell first. Defaults to 16. A cell that did
   * not get its turn keeps drawing the batches it has until a later update replaces them.
   */
  readonly rebuildsPerUpdate?: number;
  /**
   * Seconds of motion to stream ahead of, default 1.5: the ring centres on where the follow point
   * will be (`position + velocity * prefetchSeconds`), so a fast camera finds cells already loaded
   * instead of outrunning them. The lead is capped at three quarters of the ring, so the cell the
   * follow point is in always stays resident. `0` streams around the follow point itself.
   */
  readonly prefetchSeconds?: number;
  /**
   * New batch meshes created per update, default 2. On WebGPU each new InstancedMesh builds its
   * own shader the first frame it draws (~10-20 ms of main thread), so a burst of first-seen assets
   * is spread over frames instead of stacked into one; recycled meshes are not counted.
   */
  readonly freshMeshesPerUpdate?: number;
  /**
   * New batch meshes per update while the startup cover hides the world, default 8x
   * `freshMeshesPerUpdate`. The first-draw shader cost the default spreads is invisible behind an
   * opaque loading screen, and a canopy that needs fresh meshes otherwise trickles in two a frame.
   */
  readonly coveredFreshMeshesPerUpdate?: number;
  /**
   * Side of the world-grid square one shared batch's records are clustered into, in world units.
   * Defaults to the package's own `cellSize`, which is the square the placements are already cut
   * on. Each `(key, cluster)` is its own caster InstancedMesh with its own bounds on the shadow
   * caster layer, so a virtual-shadow level submits only the clusters its window covers. The main
   * pass keeps one mesh per `asset:level:part` whatever this is, so it costs main-pass draws
   * nothing. A larger square means fewer caster meshes and more of the world in every level render.
   */
  readonly clusterSize?: number;
  /**
   * Milliseconds one `update` may spend admitting streamed content — cell batches, terrain tiles,
   * colliders and `maxDistance`/`lods` refilters together. Defaults to 2, and `Infinity` opts out
   * of the ceiling entirely.
   *
   * The ceiling is a budget, not a promise: one unit of work always finishes, so a frame spends at
   * most this plus its last unit. Work that does not fit waits for the next `update` rather than
   * being dropped, and `stats().admission` reports what is waiting. A frame that admits nothing
   * costs nothing here.
   */
  readonly admissionBudgetMs?: number;
  /**
   * The admission budget while the startup cover hides the world and readiness is pending. Defaults
   * to 8x `admissionBudgetMs` (16 ms for the 2 ms default), so the spawn a loading screen waits on
   * is admitted in fewer frames. Set it equal to `admissionBudgetMs` to keep one budget throughout.
   */
  readonly coveredAdmissionBudgetMs?: number;
  /**
   * Milliseconds source for the admission budget, `performance.now` by default. Injectable so a
   * test can prove the ceiling instead of hoping a machine is slow enough to show it.
   */
  readonly admissionNow?: () => number;
  /**
   * The screen-space projection the extra levels of a baked AutoLOD chain are switched at, for an
   * asset whose `world.json` entry names no nonempty authored `lods` of its own. An explicit empty
   * list also uses the chain when prepared geometry and material still match its static contract.
   *
   * A chain measures its levels' geometric error in world units and the model runtime turns that
   * into pixels per frame; a batched draw cannot, so the same test is solved for distance once,
   * here, and every placement beyond it draws the next level. `fovY` is the vertical field of view
   * in degrees and `viewportHeight` the drawing-buffer height in raster pixels — a CSS height is the
   * wrong number, exactly as it is for the model runtime.
   *
   * Defaults are 60° over 1080 raster rows: a desktop view, and what the switch distance is a
   * function of. A world whose camera this class cannot see should pass its own, or a world with a
   * narrow field of view (a telephoto gun sight) or a tall window will switch earlier than its
   * pixels ask for. An asset with nonempty authored `lods` ignores all three numbers entirely: the package is
   * the authority on its own shape.
   *
   * `maxPixelError` is the error budget, in pixels, every synthesized level is selected against, and
   * it defaults to 4 rather than to the budget the asset's chain was registered with. The
   * registered budget is calibrated for a `ModelLod`, which picks a level for *one* mesh from where
   * that mesh is on screen; an instanced draw cannot, because every placement in the draw is at its
   * own distance and the draw is one call with one geometry. The batched answer has to be solved
   * once, for the whole key, which moves every switch distance outward by the ratio of the budgets —
   * and a 1 px budget is calibrated for a hero object filling the screen. At 1 px a tree's switches
   * land at 400–600 m on a 1080-row view, which on a 2 km map with a 640 m ring is past most of the
   * resident world: the levels are all there and none of them is ever selected, which is the same
   * full triangle bill the chain was added to remove. Four pixels puts the first switch inside the
   * ring, where it can actually do something.
   */
  readonly autoLod?: {
    readonly fovY?: number;
    readonly viewportHeight?: number;
    readonly maxPixelError?: number;
  };
  /**
   * The GPU-driven main pass: one compute dispatch culls and LOD-selects every resident placement
   * into a shared matrix buffer, and each main key draws its own region of it through an indirect
   * record. The CPU keeps only coarse per-cell visibility and admits the complete resident
   * `maxDistance` source set; a walking camera therefore costs no instance repack or cull/LOD
   * replacement. An explicit `placementReach` remains an admission boundary because it has no GPU
   * slot equivalent.
   *
   * `true` by default where the backend can run it: it needs compute, storage buffers and
   * `drawIndexedIndirect`, and a backend without them falls back to exactly this class's CPU path —
   * a lost saving, never a wrong picture. `gpuScene: false`, `TN_GPU_SCENE=0` or `?tnGpuScene=0`
   * turns it off, and `stats().gpuScene` and the `TN_WORLD_GPU_SCENE` line say which path a run
   * took.
   */
  readonly gpuScene?: boolean;
  /**
   * Hold every dispatch's indirect args against the pure `cullAndSelect` reference and print the keys
   * that disagree. `false` by default, and `TN_GPU_SCENE_VALIDATE=1` or `?tnGpuSceneValidate=1` turns
   * it on.
   *
   * A readback is a queue submission and a mapped buffer, so this is a mode for answering "which key
   * draws fewer instances than the CPU path" and never a walk to be measured with.
   * For a fixed-step diagnostic walk, call {@link validateGpuFrame} after the render and await its
   * promise before advancing the next frame; that opt-in fence checks every dispatch and replaces
   * the periodic samples for that world.
   */
  readonly gpuSceneValidate?: boolean;
  /**
   * Sample what the GPU actually selects in the main pass — a readback of the indirect args every
   * 30 dispatches — and report it as `stats().gpuScene` and on the `TN_WORLD_GPU_SCENE`
   * line. Off unless asked: the engine asks when the frame budget is on, and a validation turns it on
   * by itself, so `TN_FRAME_BUDGET`'s `mainGpuTriangles` is the GPU-selected count and not the mesh
   * capacity `tri=` reports. Set it explicitly when driving the world without a frame budget.
   */
  readonly gpuSceneTally?: boolean;
  /**
   * Run the hierarchical-depth occlusion test in the cull kernel and report what it would cull.
   *
   * `"measure"` (the default unless `?tnOcclusion=off`, `TN_OCCLUSION=off` or a caller's own value
   * says otherwise) builds a max-distance pyramid from the previous frame's scene-pass depth and
   * counts the placements the test hides **while drawing all of them**: a measured frame is the frame
   * an unmeasured run draws, so the only difference between the two runs is the count and the cost of
   * building the pyramid. `"off"` runs no test and allocates nothing. `stats().gpuScene.occlusion`
   * reports the counts, the pyramid's own cost, and `refused: no scene depth` when no render chain
   * installed a pass to take a depth from.
   *
   * See {@link occlusionMode} and `render/depth-pyramid.ts`.
   */
  readonly occlusion?: OcclusionMode;
  /**
   * Record every GPU-dressed main batch mesh and every resident cell's hand-placed chunks into
   * `BundleGroup`s, and replay the records instead of re-walking three's per-object path for each
   * draw. On by default: PRD-494 AC-2 measured the walking `draw` span at a 5.0 ms lower p95 than
   * develop over 3 interleaved runs with bundles on and a picture a blind world gate called equal,
   * which is the measurement the old opt-in default was decided without — so `bundles: false`,
   * `?tnBundles=0` or `TN_BUNDLES=0` is the way back to the per-object path, and `stats().bundle`
   * and the `TN_WORLD_BUNDLE` line say which way a run took and what asked for it.
   *
   * A record is an encoder, not a render pass, so only a draw that needs no live pass is recorded:
   * a framebuffer reader, a transmissive impostor, a skinned or morphed mesh and a per-object hook
   * all stay on the path they were already on. See `bundleSafe`.
   *
   * The render list inside a bundle is fixed when it is recorded, so a bundled mesh is never hidden:
   * the dispatch draws zero instances for a key the camera cannot see, and an indirect draw of zero
   * instances costs the GPU nothing. Toggling `visible` would force a re-record instead, and the
   * shadow node's texel gate skips a bundled mesh for the same reason.
   *
   * A chunk has no dispatch behind it, so the two answers it needs are its own: its meshes are never
   * culled by the record, because a mesh a record dropped is missing geometry the moment the camera
   * turns towards it, and each cell records into its own group whose `visible` is the main cull's
   * answer for that cell — the same coarse answer the scatter batches take, one cell wide. What that
   * costs is the price of the option: a cell the cull cannot see is not drawn at all, which takes its
   * chunk casters out of the shadow levels with it, and a cell it can only partly see draws the part
   * facing away. Both rasterize nothing or nearly so; the missing shadow is the real difference.
   */
  readonly bundles?: boolean;
  /**
   * Raise the LOD distance bias when the main pass is over its share of the frame's GPU budget, and
   * decay it back toward 1 when it is comfortably under, default true.
   *
   * The main pass is triangle-bound: a flyover's near and mid tree levels are millions of triangles
   * and the GPU time tracks that count. When `renderer.gpuMainMs()` — the smoothed main-pass GPU
   * time — exceeds `mainGpuShare` of a 60 fps frame, every LOD switch is crossed earlier by
   * multiplying the camera distance both selection paths compare by one shared multiplier, coarsening
   * the same placements the GPU is already struggling to draw. It rises in bounded steps, never in a
   * jump, so no level pops. `false` pins the bias at 1 for the whole run, which is byte-identical to
   * the selection before this feature existed: `?tnAdaptiveLod=0`, `TN_ADAPTIVE_LOD=0` or
   * `__tnAdaptiveLod = 0` also turns it off.
   */
  readonly adaptiveLod?: boolean;
  /**
   * The fraction of a frame's GPU time the main pass may take before the adaptive LOD bias rises,
   * `(0, 1]`, default 0.5.
   *
   * The budget is `mainGpuShare x min(deltaTime, 1/60 s)`: the frame cap keeps the budget honest the
   * same way the shadow refresh gate does, because the frame that draws an expensive main pass is
   * itself long and reading its own inflated delta would let the cost it judges pass its own test.
   * `?tnMainGpuShare=0.1`, `TN_MAIN_GPU_SHARE=0.1` or `__tnMainGpuShare = 0.1` forces adaptation on a
   * GPU that would otherwise never exceed the share.
   */
  readonly mainGpuShare?: number;
  /**
   * Bake a whole-asset octahedral impostor for every alpha-cutout foliage asset and append it as the
   * asset's terminal, two-triangle LOD. Default false: omission keeps the authored/generated source
   * levels, and `?tnImpostors=1` or `TN_IMPOSTORS=1` opts a launch in. It is opt-in until the judged
   * Machinefall capture passes (PRD-473 AC-3). With `preserveAuthoredParts`, an asset must author
   * `impostorDistance` to receive a terminal impostor.
   *
   * Set true to bake them, or leave it off to keep the source levels for a visual comparison.
   *
   * The bake runs inside the render cadence — one atlas view per `process` — so it costs a
   * slice of a frame rather than a hitch, and it starts only after the asset's own model has been
   * adopted. A seamless switch needs the impostor's atlas to cover the same cutout the source draws,
   * so an asset whose levels carry no alpha-cutout part is never baked. `false` drops only the atlas
   * terminal: every level the authored package and its baked chain give is kept, and the authored
   * middle-level cutout coverage a level would otherwise be missing its foliage at is still applied.
   */
  readonly impostors?: boolean;
}

/**
 * What the GPU actually selected in the main pass, from the scene's last landed tally.
 *
 * `triangles` is the GPU-selected count (`instanceCount x indexCount / 3` summed over the indirect
 * records), never the mesh-capacity upper bound `renderer.info.render.triangles` reports, and it
 * covers the main pass only: shadow passes are not tallied. `ageFrames` is how many dispatches have
 * passed since those bytes were issued, so a caller never mistakes a stale sample for this frame's.
 */
export interface IWorldCellsGpuTally {
  readonly instances: number;
  readonly triangles: number;
  readonly ageFrames: number;
}

/** Local render coverage, independent of shader prewarm and distant admission. */
export interface IWorldRegionReadiness {
  readonly requiredCells: number;
  readonly loadedCells: number;
  readonly requiredTerrainTiles: number;
  readonly loadedTerrainTiles: number;
  readonly failures: number;
  readonly cancelled: boolean;
  readonly ready: boolean;
}

/** One `whenSpawnReady` caller: a fixed region snapshot, its deadline and its promise sinks. */
export interface ISpawnWaiter {
  readonly position: { readonly x: number; readonly z: number };
  readonly radius: number;
  readonly resolve: (readiness: IWorldRegionReadiness) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface ICellBatch {
  readonly asset: string;
  /**
   * The run these records came from. One cell can hold two runs of one canonical asset — two names
   * for the same model — and each builds its own, so a refilter and a rebuild have to know which of
   * the cell's entries belong to the run they are replacing.
   */
  readonly run: IWorldRun;
  readonly batch: InstancedBatch;
  /** Published adjacent LOD interval per instance, present only on the CPU dither path. */
  readonly lodRanges: Float32Array | undefined;
  readonly level: number;
  readonly part: number;
  /** How far the follow point has to move before this batch is refiltered, `undefined` never. */
  readonly threshold: number | undefined;
  /** The shared mesh this cell's instances are written into, and its segment there (-1: none). */
  shared: SharedBatch | undefined;
  segment: number;
  /**
   * The GPU scene's source records this entry draws from, shared by every part of its level, and
   * handed back by `#clearSegment`. `undefined` while the scene is off or the records are the
   * dispatches' own already — a record released twice is a no-op, which is what lets one list be
   * held by a whole level's parts.
   */
  gpu: number[] | undefined;
  /**
   * The shadow-caster cluster this cell's records also go into, and its segment there (-1: none).
   * The main mesh is one per key and casts nothing; the same records are written into one mesh per
   * `(key, cluster)` on the caster layer, which is what a virtual-shadow level culls.
   */
  caster: SharedBatch | undefined;
  casterSegment: number;
  /**
   * The wide-caster half, and its segment there (-1: none): the same records again, in one mesh per
   * key covering the whole ring, alone on the wide caster layer. A shadow level whose window covers
   * the ring would otherwise submit one cluster per square for the same pixels.
   */
  wide: SharedBatch | undefined;
  wideSegment: number;
  /**
   * The root-matrix records this entry's level put in the far shadow, when the asset has an
   * impostor: the placement transform alone, never `placement * part local`. The whole-asset impostor
   * bakes every LOD0 part's own transform into its atlas, so its quad is drawn at the placement root
   * and composing a source part's offset again would apply that part's transform twice. `undefined`
   * for a non-impostor asset, whose wide half keeps the per-part source records.
   */
  wideRoot: InstancedBatch | undefined;
  /**
   * The world bounds of the records this entry holds, from the filter that built it. The shadow
   * invalidation is the union of these over the entries a swap moved in and out, which is the point
   * of measuring them per record rather than per cell: a 48 m level's window is smaller than the
   * cell box, so the cell box always covered it and always redrew it.
   */
  shadowBounds: Box3 | undefined;
  lastFilterY: number;
  lastFilterX: number;
  lastFilterZ: number;
}

/** The geometry and material one batch draws; a part is one of these plus what it does not need. */
export type IBatchShape = Pick<IAssetPart, "geometry" | "material">;

/** Which GPU-scene key one main batch draws: `asset:level:part`, and the part's place in the model. */
export interface IKeyDescriptor {
  readonly asset: string;
  readonly key: string;
  readonly level: number;
  readonly part: number;
}

/** One key a loaded asset's levels contributed to the prewarm queue. */

/** One asset's placements, waiting to be built, or already holding their own cell's records. */
export interface IPrewarmEntry {
  readonly asset: string;
  /**
   * Which pass this mesh is: the main pass's key, its caster cluster, its wide, or the shadow twin
   * of the main key that a GPU-driven map draws instead of the two caster halves.
   */
  readonly role: "cluster" | "key" | "main" | "wide";
  readonly geometry: BufferGeometry;
  readonly key: string;
  readonly level: number;
  readonly material: Material;
  /** The part of the level, which is the third half of a key's name. */
  readonly part: number;
}

/**
 * A plain `{ min, max }` region, the shape a shadow level's invalidation reads and the shape a game
 * can be handed without importing three. Plain numbers, so the object a caller records its bounds
 * in is the object that crosses the boundary.
 */
export interface IShadowRegion {
  /** Only added casters; their redraw can retain the existing depth. */
  admission?: boolean;
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

/**
 * A camera, plus the one flag the exclusion rule reads. Three sets `isOrthographicCamera` on an
 * `OrthographicCamera` at runtime and declares it on no base camera type, so it is duck-typed here
 * the same way `ICasterScaleMesh` and `isInstancedMesh` are.
 */
export type ICamera = Camera & { readonly isOrthographicCamera?: boolean };

/**
 * The `@x,z` half of a cluster key, for a cell index. `cellsPerCluster` squares of cells per
 * cluster, so the answer is stable for as long as the grid is: placements never move, so a record is
 * only ever clustered when the cell holding it is admitted or evicted.
 */
export function clusterOf(cellX: number, cellZ: number, cellsPerCluster: number): string {
  return `${String(Math.floor(cellX / cellsPerCluster))},${String(Math.floor(cellZ / cellsPerCluster))}`;
}

/**
 * Whether any of `gates` — ascending — lies in `[low, high]`. One binary search for the first gate at
 * or past `low`, against the walk of every gate a scan does per cell: a follow point that has not
 * carried anything across a boundary is the common case, and the refilter runs it over every resident
 * cell every 2 m of travel. Ends included, so a placement exactly on a gate is one of the reasons to
 * rebuild.
 */
export function crossesGate(gates: readonly number[], low: number, high: number): boolean {
  let start = 0;
  let end = gates.length;
  while (start < end) {
    const middle = (start + end) >> 1;
    if ((gates[middle] as number) < low) start = middle + 1;
    else end = middle;
  }
  return start < gates.length && (gates[start] as number) <= high;
}

export interface ICellProxyState {
  readonly cell: IResidentCell;
  readonly selector: CellProxySelection;
  readonly retainedPaths: string[];
  pending: boolean;
  compiling: boolean;
  cancelled: boolean;
  compiled: boolean;
  active: boolean;
  bytes: number;
  model?: Object3D;
  prepared?: IPreparedCellProxy;
  readonly observed: Set<Mesh>;
  readonly hidden: Map<Mesh, boolean>;
  readonly mainMasks: Map<Mesh, number>;
}

export interface IResidentCell {
  proxy?: ICellProxyState;
  readonly mainChunkMeshes: Mesh[];
  readonly chunkInstances: Map<
    InstancedMesh,
    {
      readonly matrix: InstancedMesh["instanceMatrix"];
      readonly version: number;
      readonly count: number;
    }
  >;
  readonly completedRuns: Set<IWorldRun>;
  chunksLoaded: boolean;
  chunkFailed: boolean;
  readonly key: string;
  readonly x: number;
  readonly z: number;
  readonly cell: IWorldCell;
  /**
   * The union of the distances from every one of this cell's batches' own filter points to the cell's
   * rectangle, widened as batches are built and never narrowed; see `#staleIn`. Monotone on purpose:
   * too wide a range means a cell the gate test does not reject, and too narrow one would drop a
   * rebuild the pass owes.
   */
  filterNear: number;
  filterFar: number;
  readonly generation: number;
  readonly instances: number;
  readonly bytes: number;
  readonly batches: ICellBatch[];
  readonly chunks: Object3D[];
  /**
   * The exact `assets.model` cache paths this cell's chunks asked the loader for, held in
   * `#modelPaths` and handed back once the last cell naming a path is gone, exactly like an asset's
   * levels; see `#releaseModelPaths`. Empty for a cell with no chunks or a `loadModel` override.
   */
  readonly retainedModelPaths: string[];
}

/**
 * One cell's asset run waiting to be built, in units small enough to fit a frame's admission
 * budget: a slice of placements, or one mesh built.
 *
 * A job outlives the `update` that queued it, so every field it needs to resume is on the job and
 * not on the call stack — a streamed cell holds its residency slot while it waits, so the work is
 * never spent on a cell that has since left.
 */
export interface IBuildJob {
  readonly asset: IAssetState;
  readonly cell: IResidentCell;
  readonly run: IWorldRun;
  /** The follow snapshot taken at first admission, held fixed across every placement slice. */
  filterY: number;
  filterX: number;
  filterZ: number;
  /** A refilter's outgoing batches, drawn until this job's own batches are attached. */
  replaced: ICellBatch[];
  readonly replacement: boolean;
  /** This job's built batches, attached together when the last one is ready. */
  readonly fresh: ICellBatch[];
  /** The run's placement records, read once and kept across the slices that filter them. */
  records: Float32Array | undefined;
  /** Next placement to filter; the filter is complete when it reaches `run.count`. */
  next: number;
  batches: InstancedBatch[][] | undefined;
  /** Two published LOD bounds per `(level, part)` instance, in matrix append order. */
  lodRanges: number[][][] | undefined;
  /**
   * One root-matrix batch per level the filter reached, filled only when the asset can become a
   * whole-asset impostor: the placement transform with no part offset, which is what its far quad
   * needs. `undefined` for every other asset, so nothing pays for records the wide half never reads.
   */
  roots: (InstancedBatch | undefined)[] | undefined;
  /**
   * Bypass the refilter's identical-answer fast path. A handoff that changes what a wide segment must
   * hold is not an identical answer even when the level and records are, so the rebuild has to swap.
   */
  force: boolean;
  /** One world-bounds box per `(level, part)` batch, filled by `#addPlacements` and read on swap. */
  boxes: Box3[][] | undefined;
  /** How many of the (level, part) meshes have been built. */
  published: number;
  /**
   * The GPU scene's source records for the placements this filter kept, one per placement beside the
   * level it reached — filled by `#addPlacements` only while the scene is on, and read on the swap.
   */
  sources: IGpuSource[] | undefined;
  /** The records placed per level, so every part of a level shares one list; see `#placeSources`. */
  gpuByLevel: Map<number, number[]> | undefined;
}

/** One placement as the GPU scene's source buffer holds it: the placement's own transform, no part. */
export interface IGpuSource {
  readonly level: number;
  readonly matrix: Matrix4;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Half the diagonal of the asset's authored bounds at this placement's scale. */
  readonly radius: number;
  /** The placement's uniform scale, carried so the dispatch can scale a whole-asset impostor gate. */
  readonly scale: number;
}

/** One drawable part of one level, read out of the level's own GLB. */
export interface IAssetPart {
  readonly geometry: BufferGeometry;
  /** The mesh's transform relative to the model root, composed into every instance matrix. */
  readonly local: Matrix4;
  /** The surface the batch draws with: the shared surface for this part's material content. */
  readonly material: Material;
  /** The `materialKey` of that surface, released through the shared-surface registry. */
  readonly surface: string;
}

export function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`WorldCells ${name} must be a positive integer.`);
  return value;
}

export function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`WorldCells ${name} must be a non-negative integer.`);
  return value;
}

/** A metre threshold, unlike the counts above: 1.5 m is the whole point of the option. */
export function positiveMetres(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`WorldCells ${name} must be a finite number greater than 0.`);
  return value;
}

/**
 * The admission budget: a positive number of milliseconds, or `Infinity` for no ceiling at all —
 * which is what a game that wants one `update` to admit everything it can asks for. Zero is refused
 * rather than obeyed, because a world whose budget is spent before it starts never streams at all,
 * and that is never what anyone meant to write.
 */
export function admissionBudgetMs(value: number): number {
  if (Number.isNaN(value) || value <= 0)
    throw new Error("WorldCells admissionBudgetMs must be a positive number of milliseconds.");
  return value;
}

export function cellKey(x: number, z: number): string {
  return `${String(x)}:${String(z)}`;
}

export function sameLodRanges(a: Float32Array | undefined, b: Float32Array | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

import type { IWorldGpuSceneReport } from "./world-gpu-scene.js";

export interface IWorldCellsStats {
  readonly residentCells: number;
  /**
   * Placement bytes the resident cells hold. Admission adds them. Eviction removes them.
   * Far-impostor and HLOD bytes sit outside this figure, in `impostor.far.bytes` and `hlod.bytes`.
   * `budgets.bytes` caps the sum of all three.
   */
  readonly residentBytes: number;
  /** Resident cells whose initial placement runs and chunks have completed admission. */
  readonly loadedCells: number;
  readonly residentKeys: readonly string[];
  /** Terrain tiles drawn, out to `terrain.streamRadius`; independent of the props' `ring`. */
  readonly residentTiles: number;
  /** Tiles holding a `createCollider` body, inside `terrain.colliderRadius`; 0 with no factory. */
  readonly residentColliders: number;
  /** Placement instances the resident cells hold, before any `maxDistance` filter. */
  readonly instances: number;
  readonly loadsInFlight: number;
  /** Model loads waiting for a free lane; served nearest-cell first, in admission order. */
  readonly loadsQueued: number;
  /** Remaining placement slices and batch publications waiting for admission. */
  readonly admissionBacklog: number;
  /** Cumulative placement slices, mesh builds, and final run swaps completed by admission. */
  readonly admissionCompletedUnits: number;
  /**
   * Shared batches still to be minted, plus the ones minted and not yet drawn; `0` once
   * `prewarmed` has resolved.
   */
  readonly pendingPrewarm: number;
  /** Shared batches minted by the prewarm so far, cumulative. */
  readonly prewarmMinted: number;
  readonly evictions: number;
  /** Cumulative `maxDistance`/`lods` refilters performed, across every update. */
  readonly rebuilds: number;
  /**
   * Cumulative refilter *passes* run, whether or not they queued a rebuild. The pass walks every
   * resident cell, derives both distance brackets and sorts what it found, so this is what says
   * whether a follow point standing inside the 2 m step paid for it; `rebuilds` only says whether it
   * was worth anything. See `LEVEL_REFILTER_STEP_METRES`.
   */
  readonly refilters: number;
  readonly levelRefilters: number;
  /**
   * Cumulative stale cell-assets the refilter passes found, across every update. The pass walks every
   * resident cell and gates it as a whole before it looks at one batch, so a follow point that has
   * crossed nothing leaves this still — which is what says the walk cost brackets and comparisons and
   * not allocations.
   */
  readonly refilterEntries: number;
  /**
   * Cumulative refilters whose rebuild held the same records and were settled without a write,
   * clear or compaction. A rising share of `rebuilds` is a follow point crossing a cell's distance
   * bracket rather than any placement crossing a gate.
   */
  readonly unchanged: number;
  readonly failures: number;
  /**
   * What the main-pass cull cost, cumulative, and the evidence that a settled camera costs nothing.
   *
   * `frustums` is one a frame that had a perspective camera — it used to be one per main mesh, ~230
   * of them on a 2 km walk. `windows` is how many of those meshes had to re-derive their window at
   * all, and `repacks` how many copied records: both are 0 on a frame where the visible squares did
   * not change and no record joined or left, which is what the two integer comparisons in
   * `SharedBatch.cullFrom` buy.
   */
  readonly mainCull: {
    readonly frustums: number;
    readonly windows: number;
    readonly repacks: number;
    readonly visibleEpoch: number;
  };
  /**
   * What the GPU-driven main pass is doing, and why it is not: `on` is the answer, `reason` is the
   * one line `TN_WORLD_GPU_SCENE` printed, and `dispatches` is what the walk actually paid for its
   * per-instance work. `mainCull.repacks` and `refilters` stay at `0` while it is on — that is the
   * CPU work it replaced, counted by the same counters that report it when it is off. `dressed` over
   * `meshes` is the marker line's own pair, and it is the one that says the scene has meshes to draw
   * with: an `on` with `0` dressed is a ring the CPU path is still drawing.
   */
  readonly gpuScene: {
    readonly on: boolean;
    readonly reason: string;
    readonly dispatches: number;
    /** Resident source records: one per placement, shared by every part of the level it reached. */
    readonly instances: number;
    readonly keys: number;
    readonly dressed: number;
    readonly meshes: number;
    /**
     * Instances and triangles the GPU actually selected in the main pass, and the age of that
     * sample in dispatches. Absent until the first tally lands, never zero: the scene's own
     * `instances` above is what it holds, and `gpuInstances` is what the GPU drew.
     */
    readonly gpuInstances?: number;
    readonly gpuTriangles?: number;
    readonly gpuTallyAgeFrames?: number;
    /**
     * What the pyramid occlusion test would cull, when a launch asked it to measure. `share` is the
     * would-cull share of the main pass's GPU-selected triangles from the same landed readback, which
     * is the number the go/no-go multiplies by `gpuMain`; `reason` names why nothing was measured.
     */
    readonly occlusion?: NonNullable<IWorldGpuSceneReport["occlusion"]>;
  };
  /**
   * Main-pass bundle membership: `children` counts grouped roots — every recorded main mesh under one
   * of the main record's shards, plus every chunk of every resident cell under that cell's own group —
   * `cpuMeshes` and `gpuMeshes` count shared batch members, and `on` reports actual main/chunk
   * membership. These are membership counts, not observed backend draws. `records` counts
   * invalidations since load: membership, material or geometry changes and CPU window repacks
   * invalidate; GPU indirect count updates do not.
   *
   * `eligibility` counts CPU material checks, snapshot validations, fresh structural walks and
   * oversized or unsupported child output. Snapshots check own links and Three's child readers on
   * every check, detecting deep edits without requiring `needsUpdate`; child discovery still allocates.
   *
   * `reason` is who asked: `default` is a run that set nothing, `option` is a load that named
   * `bundles`, and `launch` is `?tnBundles` / `TN_BUNDLES` / `__tnBundles`. It is on the marker line
   * too, because a run that turns the default off is exactly the run a reader cannot tell from a
   * failing one without it.
   */
  readonly bundle: {
    readonly on: boolean;
    readonly children: number;
    readonly cpuMeshes: number;
    readonly gpuMeshes: number;
    readonly eligibility: {
      readonly checks: number;
      readonly refreshes: number;
      readonly validations: number;
      readonly uncached: number;
    };
    readonly reason: string;
    readonly records: number;
  };
  /**
   * The runtime impostor path: how many assets appended a terminal level, how many bakes are still
   * queued or in flight, the triangles all terminal levels submit together — the number the whole
   * feature exists to reduce — and the cache size: the logical colour atlas bytes held (each atlas's
   * RGBA8 colour and normal mip chains), not every physical GPU buffer a render target may own, and
   * the budget those bytes are enforced against.
   */
  readonly impostor: {
    readonly assets: number;
    readonly pending: number;
    readonly drawn: number;
    readonly atlasBytes: number;
    readonly budgetBytes: number;
    readonly terminalTriangles: number;
    /**
     * The whole-map far aggregates: one `InstancedMesh` per atlas cache key, the ORIGINAL placements
     * they hold (`instances`), how many of those the near ring has taken back (`nearOwned`), the
     * physical instance bytes, and how many times an aggregate's buffer has been written. Missing
     * measurements stay absent; a settled camera holds `uploads` still.
     */
    readonly far: {
      readonly aggregates: number;
      readonly instances: number;
      readonly live: number;
      readonly nearOwned: number;
      readonly bytes: number;
      readonly uploads: number;
    };
  };
  /** Cumulative rejected requests: cells skipped, instances or bytes refused, terrain retries. */
  /** Compilation and zero-count main backend submission are separate observations. These counts
   * do not prove GPU execution, image quality, or reduced frame time. bytes includes pending
   * reservation and decoded copies/textures, never a claim about physical driver allocation. */
  readonly hlod: {
    readonly on: boolean;
    readonly loaded: number;
    readonly compiled: number;
    readonly observed: number;
    readonly active: number;
    readonly pending: number;
    readonly bytes: number;
    readonly refused: number;
    readonly reason: string;
    readonly failures: number;
  };
  readonly pressure: { readonly cells: number; readonly instances: number; readonly bytes: number };
  /**
   * What the last `update` spent on admitting streamed content, and what it left behind.
   *
   * A rising `backlog` is the honest signal that admission is not keeping up with the follow point;
   * it is the one number that says a player is outrunning the world.
   */
  readonly admission: {
    /** Milliseconds the last `update` spent admitting; at most the budget plus its last unit. */
    readonly spentMs: number;
    /** Cell-asset builds the last `update` had no budget for, still queued for a later one. */
    readonly deferred: number;
    /** Placement slices and meshes left to publish, plus one unit while terrain admission is owed. */
    readonly backlog: number;
  };
}
