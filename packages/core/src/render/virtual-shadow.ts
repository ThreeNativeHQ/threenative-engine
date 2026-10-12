import {
  Box3,
  type BufferGeometry,
  type Camera,
  type DirectionalLight,
  Frustum,
  type InstancedMesh,
  Matrix4,
  type Mesh,
  Object3D,
  type OrthographicCamera,
  PCFShadowMap,
  PCFSoftShadowMap,
  type RenderTarget,
  Sphere,
  Vector3,
} from "three";
import {
  Fn,
  If,
  Stack,
  abs,
  and,
  dFdx,
  dFdy,
  float,
  getShadowMaterial,
  length,
  max,
  min,
  mix,
  positionWorld,
  property,
  reference,
  renderGroup,
  shadow,
  shadowPositionWorld,
  smoothstep,
  uniform,
  vec3,
  vec4,
} from "three/tsl";
import {
  AssignNode,
  type Node,
  type NodeBuilder,
  type NodeFrame,
  ShadowBaseNode,
  type UniformNode,
} from "three/webgpu";
import { lodChainOf } from "../model-lod.js";
import { shadowRedrawGpuMs } from "../render-pass-budget.js";
import { DEFAULT_TARGET_FPS } from "../target-fps.js";
import {
  DirectionalClipmap,
  type IBoundsLike,
  type IClipWindow,
  type IVector3Like,
  ShadowInvalidationTracker,
  projectBounds,
} from "./virtual-shadow-pages.js";

/** One clipmap axis' view of a world region, as the interval it covers in light space. */
type ILightAxisRange = { low: number; high: number };

/**
 * Why a level owes a render: not at all, a window that moved, or an invalidation that asked and
 * waited out its delay. The render it finally takes is counted against this, so a level the frame's
 * single budget passed over is not counted twice.
 */
type RenderReason = 0 | 1 | 2;
const REASON_NONE: RenderReason = 0;
const REASON_MOVE: RenderReason = 1;
const REASON_INVALIDATION: RenderReason = 2;

/**
 * Options for {@link VirtualShadowNode}. Every value is a mechanism parameter; the light's own
 * `shadow` keeps bias, normalBias, intensity, map type and filter, exactly as with a stock shadow.
 */
export interface IVirtualShadowOptions {
  /**
   * Half-width of each clip level's window in world units, finest first and strictly
   * increasing. Default `[16, 48, 144]`: three windows, each three times wider than the last.
   */
  readonly clipExtents?: readonly number[];
  /** Texels per level edge. Default: the light's `shadow.mapSize.width`. */
  readonly mapSize?: number;
  /**
   * Texels per edge of each level's mover map — the map tracked casters draw into every frame.
   * Default: `mapSize`, the cached levels' own density, so a caster keeps the edge it had at rest
   * while it moves and does not pop to a crisper one when it settles. Lower it to buy back fill
   * on a weak GPU; the soft edge it costs is on the mover only.
   */
  readonly moverMapSize?: number;
  /**
   * Fraction of a level's extent inside which a fragment still selects that level, `(0, 1]`,
   * default 0.9 — the outer ring falls through to the next level so the edge is never sampled.
   * `selectionGuard` minus `refreshStep`, since a window trails its centre by that much. One value
   * for every level, or one per level finest first, the last entry standing in for the rest.
   */
  readonly selectionGuard?: number | readonly number[];
  /**
   * Fraction of a level's extent its window may trail the followed centre by before it re-renders,
   * `[0, selectionGuard)`, default 0.125 — `refreshStep: 0` keeps the old one-texel step. The step
   * is rounded to a whole number of that level's texels, so a walking camera re-renders a level
   * ~`1/refreshStep` times less often while the shadow texels stay on one fixed world grid. Costs
   * that much of `selectionGuard`, which it is already reduced by, so a window never reaches past
   * the trailing edge of a map rendered before the centre moved. One value for every level, or one
   * per level finest first, the last entry standing in for the rest — the fine level is the one a
   * walking camera re-renders most, so it is the one that wants the larger step.
   */
  readonly refreshStep?: number | readonly number[];
  /**
   * Let a level buy itself a wider `refreshStep` out of what its own last render cost, default true.
   *
   * A level render is a whole scene draw, so the engine cannot know what one is worth until it has
   * paid for it: the node measures the draw it just took and smooths that reading, and a level whose
   * smoothed cost is a large share of the frame period is re-rendered less often. This is automatic
   * because the value it reacts to is a measurement, not a setting — a game sets nothing, and a
   * cheap level is never widened and behaves exactly as before. The widened trail is capped by the
   * window's own margin, so the camera stays inside the region that level serves and everything that
   * level serves stays inside the map; a level with no such margin is never widened at all.
   *
   * `false` puts every level back on the `refreshStep` it was given, which is also what a harness
   * that wants to count today's renders uses.
   * `?tnAdaptiveRefresh=0` in the page URL makes the default `false` from the node's first setup.
   */
  readonly adaptiveRefresh?: boolean;
  /**
   * Fraction of the display period a level's smoothed render cost may take before its refresh trail
   * widens, `(0, 1]`, default 0.4.
   *
   * The period is the frame's own `deltaTime`, capped at the 60 fps frame (16.7 ms). The cap is what
   * keeps the budget honest: the frame that renders an expensive level is itself long because of that
   * render, so reading the share against its own inflated delta would count the cost twice and let
   * the very level that needs adapting pass its own test. At 60 Hz the cap is the frame itself; on a
   * 120 Hz panel the same render is twice the share it is at 60; below 60 the cap holds the budget
   * at the 60 fps frame rather than growing with the stall. Below the share nothing changes at all,
   * and above it the trail widens in proportion to the overshoot,
   * because that is the ratio between what the level costs and what a frame can afford to spend on
   * it — a level four times over the share refreshs about four times less often, until the cap
   * below it runs out.
   */
  readonly expensiveRefreshShare?: number;
  /**
   * Raise the finest level's texel size gate while its own render is too expensive for the frame, default
   * true.
   *
   * The same measurement adaptive refresh reads — the smoothed cost of the level's own last render,
   * against the share of the frame it may take — drives a second, independent adaptation: a level
   * whose render is over budget sizes its gate up in steps of 1.5 until it is affordable again, up
   * to 8 times the configured gate, and halves it back toward 1 once the render is comfortably under
   * half the budget. The gate only ever judges a caster by its size (see `minCasterTexels`), so this
   * drops the tiniest props first and never a building, and a level that is cheap is never touched:
   * it stays at scale 1 and submits exactly what it did before.
   *
   * Coarse levels always stay at scale 1 so resolved casters survive the handover.
   * `false` pins every level at scale 1, which is also what a harness that wants today's draw
   * counts uses.
   */
  readonly adaptiveCasterGate?: boolean;
  /**
   * How long a level waits after its own last render before an invalidation may re-render it, in
   * seconds. One value for every level, or one per level finest first, the last entry standing in
   * for the rest. Default `0.25 * extent / finestExtent` — 0.25 s, 1 s and 3.33 s for extents
   * 24 / 96 / 320 — and `0` renders on the very next frame, which is what the node did before.
   *
   * A streamed world invalidates its shadows on every residency update, and a cell admitted at the
   * ring edge lands in the coarsest window: the level that redraws for it is the one paying for the
   * whole ring's wide casters, ten times a second where movement alone asks for two. A level
   * waiting out its delay keeps the map and window it has, which is already right for every static
   * caster in it, so only a newly streamed caster is missing — the trade is that a far tree's
   * shadow can appear up to the delay late (3.33 s at extent 320, invisible on a level whose texel
   * is wider than the tree). A window that moved is never delayed: that is a different reason, and
   * it is not this option's.
   */
  readonly invalidationDelay?: number | readonly number[];
  /**
   * How far behind the window centre each level camera sits, in world units. Default 200. An
   * explicit `lightDistance` *and* `depthRange` switch the level's light-space depth off the derived
   * span below and back onto this pair, so a game that knows its own world sizes can still say so.
   */
  readonly lightDistance?: number;
  /**
   * Depth range each level camera covers past its centre, in world units. Default 400. Read only
   * together with `lightDistance`; on its own the span is still derived.
   */
  readonly depthRange?: number;
  /**
   * Texels of a level a caster must cover before it draws into that level, default 1.5. A level's
   * texel is `2 * extent / mapSize`, so the finest levels keep everything and the coarse ones keep
   * only what they can resolve: a fern is a whole number of texels in a 48 m window and a fraction
   * of one in a 640 m window, so it stops being drawn there and the shadow it casts is the ground
   * cover's own, not its silhouette's. Set 0 to draw every caster into every level.
   */
  readonly minCasterTexels?: number;
  /** Follow the framed receiving surface when the eye is more than one fine extent above it.
   * Default true; false keeps eye follow for every camera. Walking cameras keep eye follow.
   */
  readonly followViewFocus?: boolean;
  /** Measure receiver-plane slope across each level's texel footprint to prevent coarse acne.
   * Default true; false preserves only the authored bias. Custom filterNode owns its footprint.
   */
  readonly receiverPlaneBias?: boolean;
  /**
   * Draw registered AutoLOD chains with their coarsest geometry past the finest level, default true.
   * Alpha-tested and transparent casters keep casting on every level that resolves their bounds;
   * dropping their whole shadow at the fine window edge loses canopy and fences.
   * Geometry swaps are restored before the next level, mover map and main pass.
   */
  readonly shadowLodBias?: boolean;
  /**
   * Quiet frames before an automatically detected mover goes back into the cached levels, default
   * 100 (Unreal's `FramesStaticThreshold`). A caster whose world matrix, instance matrix or
   * deformation changed is drawn through the mover maps without a `trackCaster` call; this is how
   * long it must hold still before its shadow is baked into the cache again. Positive integer.
   */
  readonly staticAfterFrames?: number;
  /** Print the `TN_VIRTUAL_SHADOW` line every `markerEvery` frames; `false` silences it. Default 300. */
  readonly marker?: boolean | number;
}

/** Per-frame counters, readable any time through {@link VirtualShadowNode.stats}. */
export interface IVirtualShadowStats {
  readonly frame: number;
  readonly levels: number;
  /** Levels whose window moved this frame and were re-rendered. */
  readonly moved: number;
  /** Levels re-rendered because `invalidateAll()` or explicit tracker invalidation asked for it. */
  readonly invalidated: number;
  /** Tracked casters, as of this frame. */
  readonly movers: number;
  /**
   * Casters the node classified as movers by measuring them, as of this frame: a world or instance
   * matrix that changed, or a deforming mesh. Counted apart from {@link movers}, which is `trackCaster`.
   */
  readonly autoMovers: number;
  /**
   * Static-to-mover and mover-to-static changes of those casters over the node's lifetime. Each one
   * asks the levels for one region redraw, never a full one.
   */
  readonly autoTransitions: number;
  /**
   * Mean JS time of the classification scan per frame, in milliseconds, over the node's lifetime.
   * It is the number the scan's 0.05 ms budget is judged against.
   */
  readonly autoScanMs: number;
  /** Mover maps rendered this frame: one per level when at least one caster is tracked. */
  readonly moverRenders: number;
  /** Levels served from their cached map this frame. */
  readonly cached: number;
  /** Levels rendered this frame, for any reason. */
  readonly rendered: number;
  /**
   * Levels that wanted a render this frame and did not get one, because the node renders at most
   * one level per frame. They keep the map they already have and come due again next frame.
   */
  readonly deferred: number;
  /**
   * Levels holding a redraw for an invalidation that is still inside its own `invalidationDelay`,
   * so this frame is not the frame they render on. They keep the map they have, which is right for
   * every static caster in it: only a caster streamed in since is missing, and the cumulative
   * `coalesced` below is what is being waited out.
   */
  readonly held: number;
  /** Fraction of levels served from cache over the node's lifetime. */
  readonly reuseRatio: number;
  /**
   * Level renders over the node's lifetime, for any reason. `byMove` and `byInvalidation` are the two
   * the node has — a window that moved, and an invalidation that asked and waited out its delay — and
   * they add up to this exactly, because a render the single per-frame budget defers is counted
   * against the reason that queued it and not again when it is finally taken.
   */
  readonly rendersTotal: number;
  /** Of those, the renders taken because a level's window moved. */
  readonly byMove: number;
  /**
   * Pages every level's window travelled between its renders, over the node's lifetime: the sum of
   * `|ΔminX| + |ΔminY|` at each render. Unlike `byMove` it does not depend on how many frames sampled
   * the path, so two runs of one route at different frame rates report the same number.
   */
  readonly windowSteps: number;
  /** Of those, the renders taken because an invalidation asked and its level's delay had passed. */
  readonly byInvalidation: number;
  /**
   * Invalidation asks that cost no render of their own, over the node's lifetime: absorbed by a
   * render the level was taking anyway for its window, or merged into an ask already waiting out
   * that level's delay. The two of these are the shape of the win — with the default delays a walk
   * asks once a second and renders about that often, and every ask in between is counted here.
   */
  readonly coalesced: number;
  /**
   * The same four counters per level, finest first: which window moved, which invalidation asked
   * for a redraw, which level took the frame's single render, and which wanted one and did not get
   * it. One entry per level per frame, so a harness reading this — or the `TN_VIRTUAL_SHADOW`
   * marker line, which carries it — can see which level a walk keeps re-rendering instead of only
   * how many.
   */
  readonly perLevel: readonly IVirtualShadowLevelStat[];
}

/** One level's row of {@link IVirtualShadowStats}: 1 or 0 per counter, per frame. */
export interface IVirtualShadowLevelStat {
  /** The level's clip extent, in world units. */
  readonly extent: number;
  readonly deferred: number;
  readonly invalidated: number;
  readonly moved: number;
  readonly rendered: number;
  /** Caster meshes this level's chosen camera layers submit this frame. Zero if it did not render. */
  readonly draws: number;
  /** The same bill split by kind; the five parts sum to {@link draws}. */
  readonly drawsBy: IVirtualShadowDraws;
  /** The adaptive caster gate's scale on this level, 1 when it is not shedding casters. */
  readonly gateScale: number;
  /** Casters the gate hid on the render this level took this frame; zero if it did not render. */
  readonly gateHidden: number;
}

/** One level's caster draws, by the kind of mesh that submitted them. */
export interface IVirtualShadowDraws {
  /** Caster batch meshes on the cluster layer, when the cluster half is the level's choice. */
  readonly cluster: number;
  /** Key-wide caster meshes on the wide layer, when the wide half is the level's choice. */
  readonly wide: number;
  /** Small casters, submitted by the finest level and by any level rendering a prewarm. */
  readonly small: number;
  /** Merged per-chunk shadow proxies (`<name>-shadow`), drawn with either caster half. */
  readonly chunkProxy: number;
  /** Everything else casting from layer 0 — terrain, props — which every level draws. */
  readonly layer0: number;
  /**
   * GPU-scene keys: one mesh per `asset:level:part` drawn from the level's own twin of the dispatch's
   * output, which is the whole of what a keyed map submits of the world. Zero unless a provider
   * registered and `?tnShadowGpuKeys=1` asked, and then it replaces {@link cluster} and {@link wide}
   * rather than adding to them: the keys draw the placements those two would have.
   */
  readonly keys: number;
}

/** The mutable tally `#probe` fills; the public row only ever reads it. */
interface IVirtualShadowDrawTally {
  cluster: number;
  wide: number;
  small: number;
  chunkProxy: number;
  layer0: number;
  keys: number;
}

export const VIRTUAL_SHADOW_MARKER = "TN_VIRTUAL_SHADOW";
/**
 * One line per level whose refresh trail adaptive refresh widened, at most once a second: the level,
 * the width of the window it re-renders, the smoothed cost of that render in ms, and the trail it
 * bought. A browser run can see which level is being throttled and by how much, which is the only
 * way to tell an expensive level from a slow frame.
 */
export const VIRTUAL_SHADOW_REFRESH_MARKER = "TN_SHADOW_REFRESH";
/** Seconds between two `TN_SHADOW_REFRESH` lines for the same level. */
const REFRESH_MARKER_SECONDS = 1;
/**
 * One line per level whose adaptive caster gate changed, at most once a second: the level, the width
 * of the window it re-renders, the smoothed cost of that render, the scale its gate bought, and how
 * many casters that gate hid on the render the change was read from. A browser run can see which
 * level is shedding its tiniest props and by how much.
 */
export const VIRTUAL_SHADOW_GATE_MARKER = "TN_SHADOW_GATE";
/** Seconds between two `TN_SHADOW_GATE` lines for the same level. */
const GATE_MARKER_SECONDS = 1;
/** How much a level's texel gate steps up per over-budget render. */
const GATE_SCALE_RISE = 1.5;
/** The most a level's texel gate may scale up, so a big building is never in reach. */
const GATE_SCALE_CAP = 8;
/** How much the gate steps back toward 1 once the render is comfortably under budget. */
const GATE_SCALE_DECAY = 0.5;
/** Below this share of the affordable budget a level's gate decays; between, it holds. */
const GATE_DECAY_SHARE = 0.5;
/**
 * How much of a level's last two render costs the smoothed cost keeps, `(0, 1]`. Half and half, so a
 * first draw with a cold pipeline is not the level's price for the rest of the session.
 */
const COST_SMOOTHING = 0.5;
/**
 * A level's first measured renders are thrown away before its cost is trusted. The first draw of a
 * map compiles its shaders and uploads its textures, so it reads tens of milliseconds however cheap
 * the level is; seeding the smoothed cost with that warm-up would widen the trail or raise the gate
 * for a level that is not actually expensive. Two renders is enough for the pipeline to be warm.
 */
const COST_WARMUP_RENDERS = 2;
/**
 * The object layer tracked casters are enabled on, so each level's mover camera sees only them.
 * Keep it free of other uses; the main camera never needs it (tracked objects keep layer 0).
 */
export const VIRTUAL_SHADOW_MOVER_LAYER = 29;
/**
 * The object layer a shadow-only caster is put on, so each level's own shadow camera renders it and
 * the main camera never sees it. The level cameras have it enabled already; an object that exists
 * only as a shadow caster calls `object.layers.set(VIRTUAL_SHADOW_CASTER_LAYER)`.
 */
// The layer a shadow-only object is put on: a level's own shadow camera renders it, the main
// camera never sees it. Three skips an object whose layers do not meet the camera's, and it
// overwrites a shadow camera's mask with the main camera's whenever that mask is layer 0 and
// nothing else — so enabling this bit on the level cameras is also what pins their mask, and a
// caster that lives only on it is reachable from the cascade and from nothing else. 28 is below the
// mover layer and off the main camera, which renders layer 0.
export const VIRTUAL_SHADOW_CASTER_LAYER = 28;
/**
 * The wide counterpart of {@link VIRTUAL_SHADOW_CASTER_LAYER}: one caster mesh per
 * `asset:level:part` holding every resident cell's records, for the levels whose window covers the
 * whole resident ring. A level renders exactly one of the two caster layers — whichever submits
 * fewer draws, counted off the meshes themselves, because a cluster per square is a draw per square
 * for the same pixels once the window holds the ring. `WorldCells` writes both halves of every key,
 * so whichever a level picks is there; the main camera renders neither.
 */
export const VIRTUAL_SHADOW_WIDE_CASTER_LAYER = 27;
/**
 * The wide half of short assets: ferns, grass and bushes. `WorldCells` classifies assets by
 * `shadows.smallCasterMetres`; every level then applies its measured texel gate, so a resolved
 * shadow survives the fine window's edge. The main camera never draws this internal layer.
 */
export const VIRTUAL_SHADOW_SMALL_CASTER_LAYER = 26;
/**
 * The counterpart of both caster layers for a GPU-driven map: one mesh per `asset:level:part`
 * drawing that key's shadow twin, so a level submits one indirect draw per key instead of one per
 * grid square. `WorldCells` mints these instead of the two caster halves when a shadow level draws
 * from the GPU scene (`?tnShadowGpuKeys=1`), and every level camera carries this bit, which is why
 * it is not one half of a choice: a key is the whole of what a keyed map draws of the world.
 */
export const VIRTUAL_SHADOW_KEY_LAYER = 25;
const DEFAULT_CLIP_EXTENTS: readonly number[] = [16, 48, 144];
const DEFAULT_MARKER_EVERY = 300;
/** Frames between markers while `?tnShadowStats=1` is on the URL: about a second a walk is long. */
const STATS_QUERY_EVERY = 60;
/**
 * The invalidation delay of the *finest* level, in seconds; every other level's is this times its
 * extent over the finest one. A burst of streamed invalidations is paid as one render, and the
 * level that pays it is the one whose window is widest.
 */
const BASE_INVALIDATION_DELAY = 0.25;
/**
 * Share of GPU time a level's invalidation redraws may take when the game left `invalidationDelay`
 * to the engine: a redraw that cost `c` ms waits at least `c / share` ms after the last one. A 5 ms
 * redraw never reaches the base delay; a 300 ms one on an integrated GPU waits 3 s instead of 0.25 s.
 */
const INVALIDATION_GPU_SHARE = 0.1;
const DEFAULT_MIN_CASTER_TEXELS = 1.5;
/** Unreal's `r.Shadow.Virtual.Cache.FramesStaticThreshold`: quiet frames before a mover is static. */
const DEFAULT_STATIC_AFTER_FRAMES = 100;
/**
 * The share of the display period a level's render may cost before adaptive refresh widens its
 * trail: two frames in five, 6.7 ms of a 60 Hz frame. A draw that big is worth a whole frame of its
 * own, and a share rather than a millisecond count is what makes the same number mean the same thing
 * on a 120 Hz panel.
 */
const DEFAULT_EXPENSIVE_REFRESH_SHARE = 0.4;
/**
 * The floor on a light's vertical magnitude: a horizontal window's height-to-depth conversion
 * grows without limit as the sun sets.
 */
const MIN_SUN_COSINE = 0.05;

/**
 * World spheres one level render collects: centre, radius, shadow flags, the box's own height
 * range, seven numbers each.
 */
const POOL_STRIDE = 7;
/**
 * How many window widths a caster may be before the window is cut out of it instead. One: an
 * object wider than the window it is in is a mass, and only its height reaches the frustum.
 */
const MAX_MASS_WINDOW_WIDTHS = 1;
const POOL_CASTERS = 1 << 0;

/**
 * A mesh in the caster table, with the three channels the probe reads off the object rather than off
 * the geometry: the bounds three's own cull would use, which `Mesh` does not declare, the
 * `casterPrewarmOwed` flag `WorldCells` writes (see `SharedBatch.awaitPrewarmDraw`), and the
 * `mainAdmitted` answer it publishes for a caster half (see `SharedBatch.setMainAdmitted`).
 */
interface ICasterMesh extends Mesh {
  boundingBox?: Box3 | null;
  boundingSphere?: Sphere | null;
  casterPrewarmOwed?: boolean;
  mainAdmitted?: boolean;
  chunkShadowProxy?: boolean;
  casterMinDiameter?: number;
  computeBoundingBox(): void;
  computeBoundingSphere(): void;
}

/**
 * One caster's memoised world values, and the inputs they were derived from.
 *
 * The key is the world matrix plus the local sphere and the local box's two Y values — everything
 * `Sphere.applyMatrix4` and `Box3.applyMatrix4` read, and nothing else. Twenty-two doubles compare
 * against the pair of matrix applies they replace, and a key that matches cannot have a different
 * answer, so this is a memo on the inputs rather than a guess about whether the mesh moved. A
 * caster under a frozen subtree, a streamed cell nobody touched and a walking stag are therefore
 * the same case: whichever of them changed its world matrix is recomputed, and the rest are not.
 *
 * A fresh slot is all zeros, which no world matrix can be — its last element is 1 — so the first
 * render of a caster always misses and always computes.
 */
const CASTER_KEY_STRIDE = 22;
/** World centre and radius, then the box's world height range: what the pool row is written from. */
const CASTER_WORLD_STRIDE = 6;
const CASTER_STRIDE = CASTER_KEY_STRIDE + CASTER_WORLD_STRIDE;

const MOTION_STATIC = 0;
/** Drawn through the mover maps and kept out of the cached levels. */
const MOTION_MOVER = 1;
/**
 * Back in the cached levels, still drawn through the mover maps until every level the redraw asked
 * has rendered it, so the shadow never drops out between the two.
 */
const MOTION_SETTLING = 2;

/** What the motion scan remembers of one caster mesh between frames. */
interface ICasterMotion {
  /** The 16 world-matrix elements at the last scan: where the cached levels last saw it. */
  readonly world: Float64Array;
  /** `instanceMatrix.version` at the last scan; unused on a plain mesh. */
  instanceVersion: number;
  phase: typeof MOTION_STATIC | typeof MOTION_MOVER | typeof MOTION_SETTLING;
  /** `pinStatic` named this mesh or an ancestor. */
  pinned: boolean;
  /** Consecutive scans without movement while a mover. */
  quiet: number;
}

/**
 * What a world publishes on its root for a shadow level to draw a map from GPU-scene keys:
 * `(renderer, level) => void`, the level's own three numbers and the scene that selects against them.
 *
 * Engine-internal and duck-typed. `WorldCells` publishes it as `tnShadowGpuKeys`; nothing in a
 * template or a manifest names it, and this module cannot import the world package to name the type,
 * so the contract is the call and the flag behind it.
 */
type IShadowKeyDispatch = (renderer: unknown, level: IShadowLevelNumbers) => void;

/**
 * One shadow map's own three numbers, duck-typed from `world-gpu-scene`'s `IShadowLevel`: the six
 * planes of this map's own shadow camera, its texel gate in world metres, and the chain level it
 * draws at. Typed here rather than imported for the
 * same reason as the dispatch above.
 */
interface IShadowLevelNumbers {
  readonly planes: Float32Array;
  readonly gate: number;
  readonly base: number;
}

/** A placeholder light per level: the stock shadow node reads position and target from it. */
class LevelLight extends Object3D {
  readonly target = new Object3D();
  shadow: DirectionalLight["shadow"];
  override castShadow = true;

  constructor(shadow: DirectionalLight["shadow"]) {
    super();
    this.shadow = shadow;
  }
}

interface ILevel {
  readonly light: LevelLight;
  readonly shadow: DirectionalLight["shadow"];
  readonly node: ReturnType<typeof shadow>;
  /** Same window and placement as `shadow`, rendered every frame with only the tracked casters. */
  readonly moverShadow: DirectionalLight["shadow"];
  readonly moverNode: ReturnType<typeof shadow>;
  readonly extent: number;
  readonly extentUniform: UniformNode<"float", number>;
  /**
   * The light-space depth this level's last render derived: how far behind its window centre the
   * camera sat, and the near/far it drew with. Held between renders, because a level that keeps its
   * map is placed with the same span it drew that map with.
   */
  eye: number;
  depthNear: number;
  depthFar: number;
  minX: number;
  minY: number;
  /** Light-space depth of the window centre when this level's map was last rendered. */
  centerW: number;
  /**
   * 1 once this level's map has been rendered at least once, 0 until then. A fragment never
   * samples a map this level has not drawn yet: with one render per frame the coarse levels are
   * behind on the frame the fine one comes due, and their targets have no depth in them yet.
   */
  readonly mapped: UniformNode<"float", number>;
  /**
   * Set when an invalidation asked for a redraw that has not been rendered yet, 0 until then. The
   * ask is held here instead of being consumed on the frame it arrives, so a level can wait out
   * `invalidationDelay` and still redraw; a render of any reason clears it.
   */
  dirty: boolean;
  /**
   * The engine frame clock's reading when this level last rendered, in seconds. A dirty level
   * re-renders for the invalidation no sooner than `invalidationDelay` after this. `-Infinity`
   * until the first render, so a level invalidated before it holds a map is due immediately.
   */
  lastRender: number;
  /**
   * Why this level owes a render the frame's single budget did not grant it: {@link REASON_NONE},
   * and the reason it was due otherwise. Sticky, so a level that was passed over stays due on the
   * next frame instead of waiting for its window to move again — and the render it eventually takes
   * is counted against the reason that queued it.
   */
  pending: RenderReason;
  /**
   * Smoothed cost of this level's own last render, in milliseconds, and 0 until it has rendered
   * once. This is the only measure of what a level's render is worth there is — a level render is a
   * whole scene draw — and what it buys is a wider refresh trail; see `adaptiveRefresh`.
   */
  costMs: number;
  /**
   * How many of this level's renders have been measured, warm-up included. The first
   * {@link COST_WARMUP_RENDERS} are compile and upload, not the level's price, so `costMs` stays 0
   * until the counter passes them and nothing adapts before it.
   */
  costReadings: number;
  /**
   * The trail this level is actually being stepped with, which is its configured `refreshStep`
   * until a measurement widens it. Held so a level that got cheap again is put back rather than
   * left on the trail it bought.
   */
  appliedStep: number;
  /** Engine clock of this level's last `TN_SHADOW_REFRESH` line, in seconds. */
  lastRefreshNote: number;
  /**
   * The adaptive caster gate's scale on this level: the factor `minCasterTexels` is multiplied by,
   * 1 until a render comes in over budget. See `adaptiveCasterGate`.
   */
  gateScale: number;
  /**
   * The texel gate `#probe` last computed for this level, in world metres. Held so the level's own
   * dispatch is handed the gate that render decided on, rather than recomputing it and risking the
   * two answering about different numbers. 0 until the level has been probed.
   */
  gateMetres: number;
  /**
   * Casters the adaptive gate hid on this level's last render, for the `TN_SHADOW_GATE` line. Not
   * reset by a frame that did not render: the line reports the render the change was read from.
   */
  gateHidden: number;
  /** Engine clock of this level's last `TN_SHADOW_GATE` line, in seconds. */
  lastGateNote: number;
  /**
   * Engine clock of the render whose cost the gate has already been adapted to. `#adaptiveTrails`
   * changes the scale at most once per render, never twice for the same measured cost.
   */
  gatedRender: number;
  /**
   * Where this level's *rendered* map sits, relative to the centre the fragment test measures
   * from. A level whose re-render was deferred still holds an older window, and its selection has
   * to be made against that window rather than the followed centre: the sampler reads through this
   * level's own camera, so testing against anything else is what makes a fragment reach past a
   * rendered map.
   */
  readonly offsetU: UniformNode<"float", number>;
  readonly offsetV: UniformNode<"float", number>;
  /** This level's own guarded extent fraction, for the same reason. */
  readonly guardUniform: UniformNode<"float", number>;
}

type ShadowWithFilter = DirectionalLight["shadow"] & { filterNode?: unknown };

const _direction = new Vector3();
const _center = new Vector3();
const _sphere = new Sphere();
const _box = new Box3();
const _size = new Vector3();
const _focus = new Vector3();
const _forward = new Vector3();
/** A level's own light frustum, read once per level render and handed to its dispatch. */
const _shadowProjection = new Matrix4();
const _oldWorld = new Matrix4();
const _shadowFrustum = new Frustum();
const _shadowPlanes = new Float32Array(24);
/**
 * `world-gpu-scene`'s `COARSEST_SHADOW_LEVEL`, duplicated rather than imported: this module must not
 * know the world package, and the value is a level index the far side clamps to each asset's own.
 */
const COARSEST_SHADOW_LEVEL = 1 << 20;

/** The state cached maps depend on: visible, casting, and admitted by the main pass. */
/** A skinned mesh, or one with a morph target weighted above zero: its pixels change with no matrix change. */
function deforms(mesh: Mesh): boolean {
  if ((mesh as { isSkinnedMesh?: boolean }).isSkinnedMesh === true) return true;
  const influences = mesh.morphTargetInfluences;
  if (influences === undefined) return false;
  for (const weight of influences) if (weight !== 0) return true;
  return false;
}

function casterFlag(mesh: {
  castShadow?: boolean;
  mainAdmitted?: boolean;
  userData?: { tnShadowSwap?: unknown };
  visible?: boolean;
}): number {
  // A mesh marked tnShadowSwap trades visibility with a twin over the same ground — terrain's
  // tile and merged block, or one LOD level for the next. That flip is not a change the cached map
  // must redraw for (it measured ~80 % of a walk's flips); castShadow and mainAdmitted still are,
  // and the next window move redraws whatever resolution difference a LOD step left behind.
  return (
    (mesh.visible === true || mesh.userData?.tnShadowSwap === true ? 1 : 0) |
    (mesh.castShadow === true ? 2 : 0) |
    (mesh.mainAdmitted === false ? 4 : 0)
  );
}

/** The per-level entry of a scalar-or-array option, the last entry standing in for the rest. */
function at(values: readonly number[], level: number): number {
  return values[Math.min(level, values.length - 1)] as number;
}

/**
 * The diameter a shadow level's texel gate judges one caster by: the part's own geometry radius
 * times the largest instance scale `WorldCells` placed into this batch, or the mesh's own sphere
 * when it publishes no scale (anything the world does not own).
 */
function instanceDiameter(mesh: Mesh, sphereRadius: number): number {
  const scale = (mesh as Mesh & { casterInstanceScale?: number }).casterInstanceScale;
  if (scale === undefined || scale <= 0) return sphereRadius * 2;
  const geometry = mesh.geometry;
  if (geometry.boundingSphere === null) geometry.computeBoundingSphere();
  const radius = geometry.boundingSphere?.radius;
  if (radius === undefined || radius <= 0) return sphereRadius * 2;
  return radius * 2 * scale;
}

/** Keep each stock node's source-owned settings aligned with the public light shadow. */
function syncShadowSettings(
  source: DirectionalLight["shadow"],
  target: DirectionalLight["shadow"],
): void {
  target.bias = source.bias;
  target.biasNode = source.biasNode;
  target.blurSamples = source.blurSamples;
  target.intensity = source.intensity;
  target.mapType = source.mapType;
  target.normalBias = source.normalBias;
  target.radius = source.radius;
  (target as ShadowWithFilter).filterNode = (source as ShadowWithFilter).filterNode;
}

function syncLevelShadowSettings(
  source: DirectionalLight["shadow"],
  levels: readonly ILevel[],
): void {
  for (const level of levels) {
    syncShadowSettings(source, level.shadow);
    syncShadowSettings(source, level.moverShadow);
  }
}

/** The stock node's target factory, which three calls once from `setupShadow`. */
interface IStockShadowTarget {
  setupRenderTarget(
    shadow: unknown,
    builder: NodeBuilder,
  ): { shadowMap: RenderTarget; depthTexture: unknown };
}

/**
 * Move a receiver input into the render group. The patched renderer skips object-group uploads for
 * a settled static object, so a value in that group freezes at whatever the receiver settled with.
 */
function rendered<T>(node: T): T {
  // quality-allow: three's ReferenceNode has setGroup at runtime; its declaration omits it
  return (node as unknown as { setGroup(group: typeof renderGroup): T }).setGroup(renderGroup);
}

/**
 * Register a stock shadow node's render target with the renderer the moment the node creates it,
 * inside the material build and before any bind group can sample its depth texture.
 *
 * three re-versions a target's depth texture on the target's *first* registration — the size
 * branch of `Textures.updateRenderTarget`, which finds no recorded size — and when a bind group
 * already holds that texture the re-version destroys its GPUTexture. Every submit through that bind
 * group then fails with `Destroyed texture [Texture "ShadowDepthTexture"] used in a submit`, and a
 * settled static object never rebuilds its bind group, so nothing is presented again. A level whose
 * first render comes after the main pass bound its map — every level but the one drawn in the first
 * frame, every mover map, and every level a warm-up compile binds — hit it once per scene.
 * Registering at creation makes that first registration happen before anything is bound.
 */
function registeredOnCreate<T>(node: T): T {
  // quality-allow: Three's public node type omits the target setup hook this wrapper must replace
  const stock = node as unknown as IStockShadowTarget;
  const create = stock.setupRenderTarget.bind(stock);
  stock.setupRenderTarget = (lightShadow, builder) => {
    const made = create(lightShadow, builder);
    // A renderer without three's texture manager (a test double) registers on first render.
    // quality-allow: Three's public renderer type hides the manager that must register this target early
    const host = builder.renderer as unknown as {
      _textures?: { updateRenderTarget?(target: RenderTarget): void };
    };
    host._textures?.updateRenderTarget?.(made.shadowMap);
    return made;
  };
  return node;
}

/** The stock node's render entry, called here so the mover exclusion brackets exactly one render. */
interface IRenderingShadowNode {
  updateShadow(frame: NodeFrame): void;
}

/**
 * One directional shadow for a whole open world: camera-centred clip levels, each snapped to its
 * own texel grid and re-rendered only when its window moves. Movers never touch that cache: a
 * tracked caster draws into a second, per-level mover map every frame, and a fragment takes the
 * darker of the two — so a walking stag costs one small render of itself, not a render of the wood.
 *
 * Plugs into three's own slot, so every material in the scene receives it with no other change:
 * `light.shadow.shadowNode = new VirtualShadowNode(light, { clipExtents: [16, 48, 144] })`.
 *
 * What it owns is mechanism: level windows, texel snapping, per-level caching, invalidation,
 * level selection and the statistics. The light's `shadow` keeps bias, normal bias, intensity,
 * map type and filter, and those source settings are mirrored into each stock level node before
 * rendering. Per-level map sizes, cameras, `autoUpdate` and `needsUpdate` are owned by this node.
 * Each level is rendered by the stock {@link ShadowNode} through the renderer's shadow-map type,
 * so the look is the same code path a plain shadow uses. At most one level renders per frame,
 * finest first — a level render is a whole scene draw, and a level passed over keeps the map and
 * window it has, so a fragment only ever samples a map that level drew.
 *
 * Ported from the virtual-shadow-map prototype's clipmap and invalidation; the sparse page atlas
 * is deliberately not the first cut — a page needs the scene rendered once per page, and on a
 * forest of hundreds of instanced meshes three level renders are cheaper than twenty-four page
 * renders. The page pool and demand pass in `virtual-shadow-pages.ts` stay ready for it.
 *
 * @situation crisp shadows close to the player across a large outdoor level
 * @situation shadow map too coarse over a big terrain
 * @situation one directional light shadow for a whole open world
 * @situation shadows shimmer when the camera moves
 * @constraint the light must be a DirectionalLight with `castShadow` and a target in the scene
 * @constraint clipExtents are half-widths in world units, finest first, strictly increasing
 * @constraint movers sort themselves: a layer-0 caster whose world matrix, instance matrix or deformation changed draws through the mover maps and leaves the cached levels, and returns to them after `staticAfterFrames` quiet frames; the cache redraws only the region it left
 * @constraint `trackCaster(object)` is the override that pins an object as a mover for good (it enables layer `VIRTUAL_SHADOW_MOVER_LAYER` on the object and its descendants), and `pinStatic(object)` opts an object out of detection; tracking or untracking refreshes only that object's region
 * @override bias, biasNode, normalBias, intensity, radius, blurSamples, mapType and filterNode stay on `light.shadow`; mapSize and the other options here have defaults
 * @override followViewFocus: false keeps eye follow; receiverPlaneBias: false uses only authored bias
 * @example
 * const sun = new DirectionalLight(0xffffff, 3);
 * sun.castShadow = true;
 * sun.shadow.shadowNode = new VirtualShadowNode(sun, { clipExtents: [12, 40, 120] });
 */
export class VirtualShadowNode extends ShadowBaseNode {
  static get type(): string {
    return "VirtualShadowNode";
  }

  readonly options: Required<
    Omit<IVirtualShadowOptions, "marker" | "refreshStep" | "selectionGuard" | "invalidationDelay">
  > & {
    readonly markerEvery: number;
    /** Per level, finest first; the last entry stands in for every level past it. */
    readonly refreshStep: readonly number[];
    /** The per-level `selectionGuard` each level's own window is drawn with. */
    readonly selectionGuard: readonly number[];
    /**
     * Per level, finest first: the seconds a dirty level waits after its own last render before an
     * invalidation may re-render it. Already scaled by that level's extent, so the fine levels
     * answer a streamed caster promptly and the coarse ones let a burst merge into one render.
     */
    readonly invalidationDelay: readonly number[];
  };
  readonly clipmap: DirectionalClipmap;
  /**
   * Compatibility handle for explicit page invalidation. Automatic caster motion uses mover maps;
   * callers that already update this tracker still invalidate the affected cached levels.
   */
  readonly tracker: ShadowInvalidationTracker;
  #levels: ILevel[] = [];
  #invalidateAll = false;
  /** Regions handed to `invalidateRegion`, read and cleared by the next `updateBefore`. */
  #regions: Array<IBoundsLike & { urgent?: true }> = [];
  /** The same regions, resolved onto the clipmap's axes; scratch, so a frame allocates nothing. */
  #projectedRegions: { u: ILightAxisRange; urgent: boolean; v: ILightAxisRange }[] | undefined;
  #casters = new Map<string, Object3D>();
  #casterChildren = new Map<string, Set<Object3D>>();
  /** Per caster mesh, what the motion scan remembers; entries live as long as the mesh does. */
  #motionOf = new WeakMap<Object3D, ICasterMotion>();
  /** Parallel to `#casterTable`, so the per-frame scan indexes an array rather than a map. */
  #motion: ICasterMotion[] = [];
  /** Meshes in `MOTION_MOVER`: drawn through the mover maps, kept out of the cached levels. */
  #autoMovers = new Set<ICasterMesh>();
  /** Meshes in `MOTION_SETTLING`, waiting for the levels their return redraw asked. */
  #autoSettling = new Set<ICasterMesh>();
  /** Roots `pinStatic` was called on; resolved onto their meshes whenever the table is rebuilt. */
  #pinnedRoots = new Set<Object3D>();
  #autoTransitions = 0;
  #autoScanTotalMs = 0;
  #moverLayerStates = new Map<Object3D, { originallyEnabled: boolean; references: number }>();
  #centerU: UniformNode<"float", number> = uniform(0).setGroup(renderGroup);
  #centerV: UniformNode<"float", number> = uniform(0).setGroup(renderGroup);
  #moversActive: UniformNode<"float", number> = uniform(0).setGroup(renderGroup);
  #basisU: UniformNode<"vec3", Vector3> = uniform(new Vector3(1, 0, 0)).setGroup(renderGroup);
  #basisV: UniformNode<"vec3", Vector3> = uniform(new Vector3(0, 0, 1)).setGroup(renderGroup);
  #basisW: UniformNode<"vec3", Vector3> = uniform(new Vector3(0, 1, 0)).setGroup(renderGroup);
  #receiverSlope = property("float", `virtualShadowReceiverSlope${String(this.id)}`);
  #frame = 0;
  /** 1 while this node is inside `#updateFrame`; a level render re-enters `updateBefore`. */
  #updating = false;
  /** Per-level counters, rebuilt each frame; see `IVirtualShadowStats.perLevel`. */
  #perLevel: IVirtualShadowLevelStat[] = [];
  #rendered = 0;
  #served = 0;
  /** Cumulative level renders and the reason each took one; see `IVirtualShadowStats`. */
  #rendersTotal = 0;
  #byMove = 0;
  #windowSteps = 0;
  #byInvalidation = 0;
  #coalesced = 0;
  /** Read from the URL once, for the `?tnShadowStats=1` marker cadence. */
  #statsRequested: boolean | undefined;
  /** URL-only, web-only diagnostic; native hosts have no URL switch or alternate path. */
  #levelsRequested: boolean | undefined;
  /** The game's own `adaptiveRefresh`, so the URL switch read at setup never overrides it. */
  readonly #adaptiveRefreshGiven: boolean | undefined;
  /** Whether the game set `invalidationDelay`; only an engine-chosen delay stretches with GPU cost. */
  readonly #invalidationDelayGiven: boolean;
  /**
   * The diagnostic's tint, one per material build, keyed weakly by the builder that owns it.
   *
   * It cannot live on the builder's own node cache: three replaces that cache for the duration of
   * every `flowStagesNode` build, so a tint written during `setup` and read while the stock
   * samplers run would be two different objects. Nor can it live on this node — one shadow node
   * feeds every material compiled against it, and a `var` the first material declared is not the
   * next one's.
   */
  #levelTints = new WeakMap<NodeBuilder, Node<"vec3">>();
  #stats: IVirtualShadowStats;
  #initialised = false;
  #onLightRemoved = (): void => this.dispose();
  /** 1 when each level derives its own light-space depth, 0 when `lightDistance`/`depthRange` pin it. */
  #autoDepth = true;
  /**
   * Every shadow-relevant world sphere one level render collected, seven numbers each. The depth
   * derivation reads it in two passes after the one pass that filled it, and it is reused
   * between renders, so a level render allocates nothing for it.
   */
  #pool = new Float64Array(POOL_STRIDE * 256);
  #poolCount = 0;
  /**
   * The meshes under the light's root, in the order the tree walks them. Rebuilt only when the tree
   * itself changed (see `#ensureCasters`); `castShadow`, the layers and `visible` are re-read on
   * every render, because a game flips those without touching the tree.
   */
  #casterTable: ICasterMesh[] = [];
  /** Every object the table was built over, so its tree listeners can come off on the next build. */
  #casterObjects: Object3D[] = [];
  #heightSources: (Object3D & { heightAt(x: number, z: number): number })[] = [];
  /**
   * The world that can hand this node a set of keys to draw instead of its caster meshes, found on
   * the caster walk and read on the render. `undefined` unless something published
   * `tnShadowGpuKeys`, which only happens with `?tnShadowGpuKeys=1`; every level below then reads
   * exactly what it read before.
   */
  #gpuKeys: IShadowKeyDispatch | undefined;
  /** The root `#casterTable` was walked from; a re-parented light changes it. */
  #casterRoot: Object3D | null = null;
  /** Set by `childadded` / `childremoved`, which three dispatches on the object that changed. */
  #casterStale = false;
  /** The memo described by `CASTER_KEY_STRIDE`: per caster, the key it was computed from and the answer. */
  #casterMemo = new Float64Array(CASTER_STRIDE * 128);
  /**
   * What `#pollCasters` last read off each table entry: 1 for `visible`, 2 for `castShadow`,
   * 4 for withheld admission. Filled by `#ensureCasters` after polling the old table.
   */
  #casterFlags = new Uint8Array(0);
  /**
   * `childadded` and `childremoved` on every object the table was built over, which is how the table
   * learns the tree changed without walking it to find out. Shared by every object so the build
   * allocates one listener rather than one per mesh.
   *
   * The change is also an ask, not only a rebuild: a level that keeps its map across a caster
   * arriving or leaving keeps the shadow of geometry the world no longer holds, which is the ghost a
   * camera jump leaves behind when the cells under it were evicted. Marking the table stale only
   * decides what the *next* render reads, and a level that never renders is the whole problem. So the
   * child is measured and the levels covering it are asked, on the same event.
   */
  #onTreeChanged = (event: { child?: Object3D; type?: string }): void => {
    this.#casterStale = true;
    const child = event.child;
    if (child === undefined) return;
    // A removed caster's world matrix is the one it last drew with — the one the stale maps hold —
    // so it is read as it stands. An added one has not been composed into its parent yet.
    if (event.type !== "childremoved") child.updateWorldMatrix(true, false);
    // A mesh that casts nothing cannot change a map by arriving or leaving, and terrain's swap twin
    // (`tnShadowSwap`) only replaces ground already drawn. A streamed world adds and removes both on
    // every rebuild: on one walk they were most of the region invalidations that redrew the level
    // four times a second. A later `castShadow` flip is still the poll's to see.
    const mesh = child as {
      isMesh?: boolean;
      castShadow?: boolean;
      userData?: { tnShadowSwap?: unknown };
    };
    if (mesh.isMesh === true && (mesh.castShadow !== true || mesh.userData?.tnShadowSwap === true))
      return;
    this.#askAboutCaster(child);
  };
  /** Casters the current level's size gate hid, restored the moment that render is over. */
  #hidden: Object3D[] = [];
  /** Chained meshes `#probe` put on their coarsest chain level, and the geometry each was holding. */
  #coarsened: { mesh: Mesh; geometry: BufferGeometry }[] = [];

  constructor(light: DirectionalLight, options: IVirtualShadowOptions = {}) {
    super(light);
    const clipExtents = options.clipExtents ?? DEFAULT_CLIP_EXTENTS;
    const mapSize = options.mapSize ?? light.shadow.mapSize.width;
    if (!Number.isInteger(mapSize) || mapSize <= 0) {
      throw new RangeError(
        `TN_VIRTUAL_SHADOW_INVALID: mapSize must be a positive integer, got ${String(mapSize)}.`,
      );
    }
    const moverMapSize = options.moverMapSize ?? mapSize;
    if (!Number.isInteger(moverMapSize) || moverMapSize <= 0) {
      throw new RangeError(
        `TN_VIRTUAL_SHADOW_INVALID: moverMapSize must be a positive integer, got ${String(moverMapSize)}.`,
      );
    }
    for (const [name, value] of [
      ["lightDistance", options.lightDistance ?? 200],
      ["depthRange", options.depthRange ?? 400],
    ] as const) {
      if (!Number.isFinite(value) || value <= 0) {
        throw new RangeError(
          `TN_VIRTUAL_SHADOW_INVALID: ${name} must be positive, got ${String(value)}.`,
        );
      }
    }
    const minCasterTexels = options.minCasterTexels ?? DEFAULT_MIN_CASTER_TEXELS;
    if (!Number.isFinite(minCasterTexels) || minCasterTexels < 0) {
      throw new RangeError(
        `TN_VIRTUAL_SHADOW_INVALID: minCasterTexels must be zero or positive, got ${String(minCasterTexels)}.`,
      );
    }
    const staticAfterFrames = options.staticAfterFrames ?? DEFAULT_STATIC_AFTER_FRAMES;
    if (!Number.isInteger(staticAfterFrames) || staticAfterFrames <= 0) {
      throw new RangeError(
        `TN_VIRTUAL_SHADOW_INVALID: staticAfterFrames must be a positive integer, got ${String(staticAfterFrames)}.`,
      );
    }
    const expensiveRefreshShare = options.expensiveRefreshShare ?? DEFAULT_EXPENSIVE_REFRESH_SHARE;
    if (
      !Number.isFinite(expensiveRefreshShare) ||
      expensiveRefreshShare <= 0 ||
      expensiveRefreshShare > 1
    ) {
      throw new RangeError(
        `TN_VIRTUAL_SHADOW_INVALID: expensiveRefreshShare must be in the range (0, 1], got ${String(expensiveRefreshShare)}.`,
      );
    }
    // Both halves or neither: one of the two alone cannot place a camera, so a half-specified
    // override is read as no override at all and the span is derived.
    this.#autoDepth = options.lightDistance === undefined || options.depthRange === undefined;
    // A page is a texel here: the clipmap's page snapping is exactly texel snapping.
    // The window now trails its followed centre by up to `refreshStep` extents, so the selection
    // guard gives exactly that much back: a window only reaches `1 - refreshStep` extents past the
    // centre, and `selectionGuard - refreshStep <= 1 - refreshStep` always holds.
    // Both are scalar-or-per-level, finest first, the last entry standing in for every level past
    // it — one level re-rendering on a different cadence is the whole point.
    const perLevel = (
      value: number | readonly number[],
      valid: (v: number) => boolean,
      complaint: string,
    ): number[] => {
      const values = Array.isArray(value) ? [...(value as readonly number[])] : [value as number];
      for (const entry of values) {
        if (!valid(entry)) {
          throw new RangeError(`TN_VIRTUAL_SHADOW_INVALID: ${complaint}, got ${String(entry)}.`);
        }
      }
      // One value for every level, filled in: what the node keeps is one entry per level whatever
      // the game handed it, so a caller reading `options` back sees the level it asked for.
      return values.length === 1
        ? Array.from({ length: clipExtents.length }, () => values[0] as number)
        : values;
    };
    const steps = perLevel(
      options.refreshStep ?? 0.125,
      (v) => Number.isFinite(v) && v >= 0 && v < 1,
      "refreshStep must be in the range [0, 1)",
    );
    const guards = perLevel(
      options.selectionGuard ?? 0.9,
      (v) => Number.isFinite(v) && v > 0 && v <= 1,
      "selectionGuard must be in the range (0, 1]",
    );
    for (let level = 0; level < steps.length; level += 1) {
      if ((steps[level] as number) >= (guards[level] as number)) {
        throw new RangeError(
          `TN_VIRTUAL_SHADOW_INVALID: refreshStep must be in the range [0, ${String(guards[level])}), got ${String(steps[level])}.`,
        );
      }
    }
    // The finest level's delay is the unit the rest are multiples of: a level whose window is `n`
    // times wider redraws `n` times more of the world, so it is the one that merges the most asks
    // into one render. 0.25 s on the fine levels keeps a streamed tree's shadow arriving with the
    // player; 3.33 s on the coarsest is invisible, because a texel there is wider than the tree.
    // One number is the finest level's delay and every level scales it by its own extent; a
    // per-level list is each level's own seconds, taken as it stands.
    const finest = clipExtents[0] as number;
    const validDelay = (v: number): boolean => Number.isFinite(v) && v >= 0;
    const asked = options.invalidationDelay;
    const invalidationDelay = Array.isArray(asked)
      ? perLevel(
          asked as readonly number[],
          validDelay,
          "invalidationDelay must be zero or positive",
        )
      : clipExtents.map(
          (extent) =>
            ((asked as number | undefined) ?? BASE_INVALIDATION_DELAY) * (extent / finest),
        );
    const at = (values: readonly number[], level: number): number =>
      values[Math.min(level, values.length - 1)] as number;
    const guardedExtent = clipExtents.map((_, level) => at(guards, level) - at(steps, level));
    this.clipmap = new DirectionalClipmap({
      clipExtents,
      direction: { x: 0, y: 1, z: 0 },
      pagesPerAxis: mapSize,
      refreshStep: steps,
      selectionGuard: guardedExtent,
    });
    this.tracker = new ShadowInvalidationTracker(this.clipmap);
    const marker = options.marker ?? DEFAULT_MARKER_EVERY;
    this.#adaptiveRefreshGiven = options.adaptiveRefresh;
    this.#invalidationDelayGiven = options.invalidationDelay !== undefined;
    this.options = {
      adaptiveCasterGate: options.adaptiveCasterGate ?? true,
      adaptiveRefresh: options.adaptiveRefresh ?? true,
      clipExtents: [...clipExtents],
      depthRange: options.depthRange ?? 400,
      expensiveRefreshShare,
      invalidationDelay,
      lightDistance: options.lightDistance ?? 200,
      mapSize,
      minCasterTexels,
      moverMapSize,
      markerEvery: marker === false ? 0 : marker === true ? DEFAULT_MARKER_EVERY : marker,
      refreshStep: steps,
      selectionGuard: guardedExtent,
      shadowLodBias: options.shadowLodBias ?? true,
      staticAfterFrames,
      followViewFocus: options.followViewFocus ?? true,
      receiverPlaneBias: options.receiverPlaneBias ?? true,
    };
    this.#stats = {
      byInvalidation: 0,
      byMove: 0,
      cached: 0,
      coalesced: 0,
      deferred: 0,
      frame: 0,
      held: 0,
      invalidated: 0,
      levels: clipExtents.length,
      moved: 0,
      moverRenders: 0,
      movers: 0,
      autoMovers: 0,
      autoScanMs: 0,
      autoTransitions: 0,
      perLevel: this.#perLevel,
      rendered: 0,
      rendersTotal: 0,
      reuseRatio: 1,
      windowSteps: 0,
    };
  }

  /** The per-frame counters, as of the last `updateBefore`. */
  get stats(): IVirtualShadowStats {
    return this.#stats;
  }

  /** The stock shadow nodes behind each level, for diagnostics. */
  get levelNodes(): readonly Node[] {
    return this.#levels.map((level) => level.node);
  }

  /** The stock shadow nodes behind each level's mover map, for diagnostics. */
  get moverNodes(): readonly Node[] {
    return this.#levels.map((level) => level.moverNode);
  }

  /** The placeholder lights, one per level; exposed for tests and debug views. */
  get levelLights(): readonly Object3D[] {
    return this.#levels.map((level) => level.light);
  }

  #rememberMoverChildren(object: Object3D): void {
    let children = this.#casterChildren.get(object.uuid);
    if (children === undefined) {
      children = new Set<Object3D>();
      this.#casterChildren.set(object.uuid, children);
    }
    object.traverse((child) => {
      if (children.has(child)) return;
      children.add(child);
      this.#holdMoverLayer(child);
    });
  }

  /** One more reason for `object` to be on the mover layer; the layer's first state is restored on the last. */
  #holdMoverLayer(object: Object3D): void {
    const state = this.#moverLayerStates.get(object);
    if (state === undefined) {
      this.#moverLayerStates.set(object, {
        originallyEnabled: object.layers.isEnabled(VIRTUAL_SHADOW_MOVER_LAYER),
        references: 1,
      });
    } else {
      state.references += 1;
    }
    object.layers.enable(VIRTUAL_SHADOW_MOVER_LAYER);
  }

  #dropMoverLayer(object: Object3D): void {
    const state = this.#moverLayerStates.get(object);
    if (state === undefined) return;
    state.references -= 1;
    if (state.references > 0) return;
    if (state.originallyEnabled) object.layers.enable(VIRTUAL_SHADOW_MOVER_LAYER);
    else object.layers.disable(VIRTUAL_SHADOW_MOVER_LAYER);
    this.#moverLayerStates.delete(object);
  }

  #restoreMoverChildren(id: string): void {
    const children = this.#casterChildren.get(id);
    if (children === undefined) return;
    for (const child of children) this.#dropMoverLayer(child);
    this.#casterChildren.delete(id);
  }

  /**
   * Make an object a mover: it leaves the cached level maps and draws into every level's mover
   * map each frame, so its shadow follows it without a level render. Static geometry never
   * needs this — a level re-renders whenever its window moves anyway.
   */
  trackCaster(object: Object3D): string {
    const previous = this.#casters.get(object.uuid);
    if (previous === object) {
      this.#rememberMoverChildren(object);
      return object.uuid;
    }
    if (previous !== undefined && previous !== object) this.#restoreMoverChildren(object.uuid);
    this.#casters.set(object.uuid, object);
    this.#rememberMoverChildren(object);
    // It leaves the cached levels from here on: only the ones around it redraw without it.
    this.#askAboutCaster(object);
    return object.uuid;
  }

  untrackCaster(objectOrId: Object3D | string): boolean {
    const id = typeof objectOrId === "string" ? objectOrId : objectOrId.uuid;
    const object = this.#casters.get(id);
    if (object === undefined) return false;
    this.#restoreMoverChildren(id);
    this.tracker.remove(id);
    const removed = this.#casters.delete(id);
    if (removed) this.#askAboutCaster(object);
    return removed;
  }

  /**
   * Keep an object and its descendants out of automatic mover detection: they are static casters
   * whatever their transforms do, so a game that moves one takes on the stale shadow itself, or
   * calls `invalidateRegion`. Takes effect from the next frame.
   */
  pinStatic(object: Object3D): void {
    this.#pinnedRoots.add(object);
    // The table is rebuilt on the next frame, which is where the pin reaches each mesh.
    this.#casterStale = true;
  }

  /** Force every level to re-render on the next frame — a tree fell, a door opened. */
  invalidateAll(): void {
    this.#invalidateAll = true;
    this.#regions.length = 0;
    this.tracker.invalidateAll();
  }

  /**
   * Force only the levels whose current window covers `bounds`, on the next frame. A streamed world
   * that hands its shadow casters over has a moving near set, and a blanket `invalidateAll()` on
   * every refresh redrew all three levels for a change that lands in one corner of one of them. A
   * level whose window does not cover the region draws the same thing either way, so skipping it is
   * the same frame with fewer draws in it.
   *
   * `bounds` is `{ min: {x,y,z}, max: {x,y,z} }`, a plain object so a game can hand one over without
   * importing three. Regions are consumed by the next `updateBefore`; one that arrives before the
   * levels exist is dropped, because their first frame renders all of them anyway.
   */
  invalidateRegion(bounds: IBoundsLike): void {
    if (this.#levels.length === 0) return;
    this.#regions.push({
      max: { x: bounds.max.x, y: bounds.max.y, z: bounds.max.z },
      min: { x: bounds.min.x, y: bounds.min.y, z: bounds.min.z },
    });
  }

  /**
   * The topmost object above the light: the scene it is lit in, whatever the game nested it under.
   * Walked per level render, so a `Daylight` group between the sun and the world is not the boundary
   * that hides every tree from the span below.
   */
  #root(): Object3D {
    let root = this.light as Object3D;
    while (root.parent !== null) root = root.parent;
    return root;
  }

  /**
   * The caster set this render reads, rebuilt only when the tree it came from changed.
   *
   * `childadded` and `childremoved` are three's own events, dispatched on the parent that gained or
   * lost the object, so this is told when the tree changed rather than guessing from a version or a
   * child count — a streamed cell admitted and an evicted one in the same frame cancel out in any
   * checksum, and the shadow a level then derives is a shadow cast by geometry it never saw. A
   * re-parented light changes the root, which is compared outright. Everything a game can change
   * about a caster *without* touching the tree — `visible`, `castShadow`, the layers, its material,
   * and where it stands — is re-read on the render itself rather than held here.
   *
   * The listeners come off the previous walk before the new one starts, so an object that has left
   * the tree cannot keep marking this stale for whatever it is parented to now.
   */
  #ensureCasters(): void {
    const root = this.#root();
    if (this.#casterRoot === root && this.#casterStale === false) return;
    // A streaming arrival can coincide with an older half's admission flip. Poll the old
    // table before reseeding its flags, or that change disappears without invalidating its map.
    this.#pollCasters();
    this.#casterRoot = root;
    this.#casterStale = false;
    for (const object of this.#casterObjects) {
      object.removeEventListener("childadded", this.#onTreeChanged);
      object.removeEventListener("childremoved", this.#onTreeChanged);
    }
    this.#casterObjects.length = 0;
    this.#heightSources.length = 0;
    this.#casterTable.length = 0;
    this.#gpuKeys = undefined;
    root.traverse((object) => {
      object.addEventListener("childadded", this.#onTreeChanged);
      object.addEventListener("childremoved", this.#onTreeChanged);
      this.#casterObjects.push(object);
      if (typeof (object as { heightAt?: unknown }).heightAt === "function")
        this.#heightSources.push(object as Object3D & { heightAt(x: number, z: number): number });
      // The one place a shadow level learns that a world in this scene can hand it a set of keys to
      // draw instead of its caster meshes: a function published on the world's own root, read off
      // the same walk and on the same cadence as everything else here. Duck-typed rather than
      // imported — this module must not know the world package, and no template or manifest names it.
      // The last publisher wins, as the last height source does.
      const keys = (object as { tnShadowGpuKeys?: unknown }).tnShadowGpuKeys;
      if (typeof keys === "function") this.#gpuKeys = keys as IShadowKeyDispatch;
      if ((object as { isMesh?: unknown }).isMesh === true)
        this.#casterTable.push(object as ICasterMesh);
    });
    const wanted = this.#casterTable.length * CASTER_STRIDE;
    if (wanted > this.#casterMemo.length) {
      let size = this.#casterMemo.length;
      while (size < wanted) size *= 2;
      const grown = new Float64Array(size);
      grown.set(this.#casterMemo);
      this.#casterMemo = grown;
    }
    // Filled from what the build just read, so the first `#pollCasters` after it reports only what
    // changed since — a caster that arrived asked already, on the event that added it.
    this.#casterFlags = new Uint8Array(this.#casterTable.length);
    for (let entry = 0; entry < this.#casterTable.length; entry += 1) {
      const mesh = this.#casterTable[entry];
      if (mesh === undefined) continue;
      this.#casterFlags[entry] = casterFlag(mesh);
    }
    this.#rebuildMotion();
  }

  /** One motion record per table entry, carried over for every mesh the previous table held. */
  #rebuildMotion(): void {
    const table = this.#casterTable;
    this.#motion.length = 0;
    for (const mesh of table) {
      let state = this.#motionOf.get(mesh);
      if (state === undefined) {
        // Seeded from where the mesh stands now: an arrival is asked about by the event that added
        // it, so its first scan has to report no movement.
        state = {
          instanceVersion: (mesh as Partial<InstancedMesh>).instanceMatrix?.version ?? 0,
          phase: MOTION_STATIC,
          pinned: false,
          quiet: 0,
          world: Float64Array.from(mesh.matrixWorld.elements),
        };
        this.#motionOf.set(mesh, state);
      }
      state.pinned = false;
      this.#motion.push(state);
    }
    for (const root of this.#pinnedRoots) {
      root.traverse((child) => {
        const state = this.#motionOf.get(child);
        if (state !== undefined) state.pinned = true;
      });
    }
    if (this.#autoMovers.size + this.#autoSettling.size === 0) return;
    // A mover whose mesh left the tree is a removed primitive: its state resets, as Unreal's does.
    const present = new Set<Object3D>(table);
    for (const set of [this.#autoMovers, this.#autoSettling]) {
      for (const mesh of set) {
        if (present.has(mesh)) continue;
        set.delete(mesh);
        this.#dropMoverLayer(mesh);
        this.#motionOf.delete(mesh);
      }
    }
  }

  /**
   * Sort every layer-0 caster into static and moving by measuring it, once a frame, after three has
   * composed the world matrices. Movement is exact: the 16 world-matrix elements, an instance
   * matrix's version, or a deforming mesh. A wrong answer costs one region redraw — the next frame
   * that moves a caster makes it a mover again in that same frame — never a stale shadow.
   *
   * A caster that moved leaves the cached levels (the mover exclusion in `#updateFrame` reads
   * `#autoMovers`) and the levels around where they last saw it redraw at once. A mover that held
   * still for `staticAfterFrames` goes back into them with one ordinary redraw, and keeps its mover
   * map draw until every level that redraw asked has taken it, so its shadow does not drop out.
   */
  #classifyCasters(): void {
    const started = performance.now();
    this.#ensureCasters();
    const table = this.#casterTable;
    const motion = this.#motion;
    const quietFrames = this.options.staticAfterFrames;
    for (let entry = 0; entry < table.length; entry += 1) {
      const mesh = table[entry];
      const state = motion[entry];
      if (mesh === undefined || state === undefined) continue;
      if (state.pinned) {
        if (state.phase === MOTION_MOVER) this.#settle(mesh, state);
        continue;
      }
      // A caster that casts nothing, is not drawn, or is not a layer-0 object is no business of
      // this scan: the world's own batches reach the levels through `invalidateRegion` instead.
      if (!mesh.castShadow || !mesh.visible || (mesh.layers.mask & 1) === 0) continue;
      // `trackCaster` — or the game — put it on the mover layer itself, which pins it as a mover.
      if (state.phase === MOTION_STATIC && mesh.layers.isEnabled(VIRTUAL_SHADOW_MOVER_LAYER))
        continue;
      const world = state.world;
      const elements = mesh.matrixWorld.elements;
      let moved = false;
      for (let at = 0; at < 16; at += 1) {
        if (world[at] !== elements[at]) {
          moved = true;
          break;
        }
      }
      const instanced = (mesh as { isInstancedMesh?: boolean }).isInstancedMesh === true;
      if (instanced) {
        const version = (mesh as Partial<InstancedMesh>).instanceMatrix?.version ?? 0;
        if (version !== state.instanceVersion) {
          moved = true;
          state.instanceVersion = version;
        }
      }
      if (!moved && !deforms(mesh)) {
        if (state.phase === MOTION_MOVER) {
          state.quiet += 1;
          if (state.quiet >= quietFrames) this.#settle(mesh, state);
        }
        continue;
      }
      state.quiet = 0;
      if (state.phase !== MOTION_MOVER) {
        // Where the cached levels last saw it, and so what must redraw without it. An instanced
        // mesh's instances have already moved with no old extents to read, so it asks for all.
        let bounds: IBoundsLike | undefined;
        if (!instanced) {
          if (mesh.geometry.boundingSphere === null) mesh.geometry.computeBoundingSphere();
          _oldWorld.fromArray(world);
          bounds = this.#casterBounds(mesh, _oldWorld);
        }
        // Urgent: this ask is made once per caster and not by a streamed burst, so the level does
        // not wait out `invalidationDelay` with the old shadow still standing in its map.
        if (this.#levels.length === 0) {
          // The first render draws every level anyway.
        } else if (bounds === undefined) {
          this.invalidateAll();
        } else {
          this.#regions.push({ ...bounds, urgent: true });
        }
        if (state.phase === MOTION_STATIC) this.#holdMoverLayer(mesh);
        else this.#autoSettling.delete(mesh);
        state.phase = MOTION_MOVER;
        this.#autoMovers.add(mesh);
        this.#autoTransitions += 1;
      }
      world.set(elements);
    }
    this.#autoScanTotalMs += performance.now() - started;
  }

  /** A mover goes back into the cached levels: one redraw around where it stands now. */
  #settle(mesh: ICasterMesh, state: ICasterMotion): void {
    state.phase = MOTION_SETTLING;
    state.quiet = 0;
    this.#autoMovers.delete(mesh);
    this.#autoSettling.add(mesh);
    this.#autoTransitions += 1;
    this.#askAboutCaster(mesh);
  }

  /**
   * The world box a changed caster occupies, in the shape `invalidateRegion` takes. Its own bounds
   * where it publishes any — a world cluster's sphere is its whole grid square, which is the only
   * thing that measures where an evicted cell's instances stood — and its geometry's otherwise. A
   * caster that measures as nothing (a bare group) has no region to name, and asks every level.
   */
  #casterBounds(object: Object3D, world?: Matrix4): IBoundsLike | undefined {
    const mesh = object as ICasterMesh;
    const own = mesh.isMesh === true ? mesh.boundingSphere : undefined;
    const sphere = own ?? (mesh as Partial<Mesh>).geometry?.boundingSphere;
    if (sphere === null || sphere === undefined) {
      // A group, or a mesh whose geometry nobody measured: the long way, once per change.
      _box.setFromObject(object, false);
      if (_box.isEmpty()) return undefined;
    } else {
      _sphere.copy(sphere).applyMatrix4(world ?? mesh.matrixWorld);
      // The sphere's *diameter* is the box, not its radius: a half-radius box stops at the sphere's
      // own centre, so a caster straddling a level edge drew nothing of it into the level whose
      // window the far half of the sphere reaches, and that level kept the shadow of geometry the
      // world had just dropped.
      _box.setFromCenterAndSize(_sphere.center, _size.setScalar(_sphere.radius * 2));
    }
    return {
      max: { x: _box.max.x, y: _box.max.y, z: _box.max.z },
      min: { x: _box.min.x, y: _box.min.y, z: _box.min.z },
    };
  }

  /** Ask the levels covering one changed caster to redraw. */
  #askAboutCaster(object: Object3D): void {
    if (this.#levels.length === 0) return;
    // Nothing that casts: the level lights this node parents into the scene are `Object3D`s with a
    // shadow slot and no geometry, and asking for all three levels redraws on their arrival. A group
    // is asked — its children arrive on their own events, so a group added empty and filled after is
    // still asked about each mesh that lands in it.
    if ((object as { isMesh?: boolean }).isMesh !== true && object.children.length === 0) return;
    const bounds = this.#casterBounds(object);
    if (bounds === undefined) this.invalidateAll();
    else this.invalidateRegion(bounds);
  }

  /**
   * A caster can change visibility, casting or main-pass admission without touching the tree.
   * A cached map must redraw when any of them flips, or it retains a removed shadow or omits a
   * newly admitted one. Read per frame off the memoised table — one flag word per caster, no
   * matrix and no bounds —
   * and a change asks for the levels covering that caster. The table is what cut 2 made cheap; this
   * reads it, it does not walk the world.
   *
   * It runs before `#probe`'s own writes (`#restoreHidden` and the mover exclusion both set these
   * flags and put them back inside the same call), so what it compares is what the game last said.
   */
  #pollCasters(): void {
    const table = this.#casterTable;
    const flags = this.#casterFlags;
    if (flags.length !== table.length) return;
    for (let entry = 0; entry < table.length; entry += 1) {
      const mesh = table[entry];
      if (mesh === undefined) continue;
      const flag = casterFlag(mesh);
      if (flags[entry] === flag) continue;
      flags[entry] = flag;
      this.#askAboutCaster(mesh);
    }
  }

  /** Drops the table and its listeners, which is what a disposed node owes the scene it read. */
  #dropCasters(): void {
    for (const object of this.#casterObjects) {
      object.removeEventListener("childadded", this.#onTreeChanged);
      object.removeEventListener("childremoved", this.#onTreeChanged);
    }
    this.#casterObjects.length = 0;
    this.#heightSources.length = 0;
    this.#casterTable.length = 0;
    this.#casterFlags = new Uint8Array(0);
    this.#casterRoot = null;
    this.#casterStale = false;
  }

  /**
   * One pass over the caster set for four automatic fixes: the world bounding sphere of every
   * shadow-relevant mesh goes into the pool, every caster too small for this level's texel grid is
   * hidden until the level's render is over, every level past the finest one draws less of what it
   * can (see `shadowLodBias`), and the level's caster granularity is chosen from the two bills it
   * could pay. Mirrors the sphere three's own cull reads, so the gate drops exactly the volumes that
   * cull would have kept and the depth below measures the same boxes it will draw.
   *
   * It is a pass over the memoised caster set rather than a walk of the world: the set is rebuilt
   * only when the tree changed (see `#ensureCasters`) and each caster's world sphere is derived
   * again only when the numbers it is derived from changed (see `CASTER_KEY_STRIDE`). On the
   * reference game's map-walk that walk was 3.9% of the CPU render phase, spent re-deriving a caster
   * set that a walking camera does not change.
   *
   * Both halves of every key are on the caster-only layers, so the bill is counted off the meshes
   * themselves rather than configured: the clusters whose square the level's window holds, against
   * the key-wide meshes waiting for it. A cluster's own sphere is its whole grid square, so the
   * window test is on its centre, which is where the records actually are.
   */
  #probe(
    level: ILevel,
    centre: IVector3Like,
    index: number,
    stat: { draws: number; drawsBy: IVirtualShadowDrawTally; gateHidden: number },
  ): void {
    // The base texel gate, times the level's own adaptive scale: a level whose render is over
    // budget raises the size a caster must be before it draws here, so it sheds its tiniest props
    // first. The scale starts and usually stays at 1, so a cheap level's gate — and every count
    // taken through it — is byte-identical to the configured one.
    const gate =
      ((this.options.minCasterTexels * 2 * level.extent) / this.options.mapSize) * level.gateScale;
    let gateHidden = 0;
    const clusterLayer = 1 << VIRTUAL_SHADOW_CASTER_LAYER;
    const wideLayer = 1 << VIRTUAL_SHADOW_WIDE_CASTER_LAYER;
    const smallLayer = 1 << VIRTUAL_SHADOW_SMALL_CASTER_LAYER;
    // A square inside the level's window is within a half-diagonal of its centre whichever way the
    // light is turned, so this is the bound that holds for every sun angle.
    const window = level.extent * Math.SQRT2;
    this.#poolCount = 0;
    this.#hidden.length = 0;
    this.#coarsened.length = 0;
    // Past the finest level, every level draws less of what it can. Set on the world here, on the
    // pass that is already reading this window's casters, and put back by `#restoreHidden` when
    // the render is over — so the mover maps and the main pass see every mesh as it was authored.
    const biased = index >= 1 && this.options.shadowLodBias;
    let clusterDraws = 0;
    let wideDraws = 0;
    // The level's bill by kind, tallied on the same pass and summed by the chosen halves once the
    // choice is known. Numbers, not objects: a frame allocates nothing for this.
    let nCluster = 0;
    let nWide = 0;
    let nSmall = 0;
    let nChunk = 0;
    let nChunkBoth = 0;
    let nLayer0 = 0;
    // A world that hands this node its GPU-scene keys draws them, not its caster meshes: one mesh
    // per key for every placement the two halves would have drawn between them. The gate below, the
    // halves' choice and their bills are the cluster path's own and do not apply — the per-placement
    // decisions are the dispatch's, made in the twin buffers this render is about to submit.
    let nKeys = 0;
    // A caster still owed its prewarm draw (see `SharedBatch.awaitPrewarmDraw`): its shadow-context
    // node is built by the next shadow render that draws it, so the level that draws it here is
    // what moves the build off the render. Both layers are therefore rendered while one is owed, since
    // the choice below would leave the other half's casters unbuilt until the level's own window
    // move. The flag is on the mesh rather than a module-level signal because the world chunk does
    // not import this one — the same channel as the `casterInstanceScale` read below.
    let prewarming = false;
    this.#ensureCasters();
    const table = this.#casterTable;
    // A launch flag can publish a provider before the backend can mint any keys. Keep the
    // fallback's wide/small layers until there are actual key meshes to replace them.
    const keyed =
      this.#gpuKeys !== undefined &&
      table.some(
        (mesh) =>
          mesh.visible &&
          mesh.castShadow &&
          (mesh.layers.mask & (1 << VIRTUAL_SHADOW_KEY_LAYER)) !== 0,
      );
    const memo = this.#casterMemo;
    for (let entry = 0; entry < table.length; entry += 1) {
      const mesh = table[entry];
      if (mesh === undefined) continue;
      if (mesh.visible !== true) continue;
      // Admission must gate the render, not just its bill: three still traverses a visible
      // caster omitted below. Reuse the texel gate's restore buffer for each level render.
      // This is placement admission, so an admitted off-frustum caster still casts.
      if (mesh.mainAdmitted === false) {
        mesh.visible = false;
        this.#hidden.push(mesh);
        continue;
      }
      // A retained-part proxy applies this gate to each original source at the draw boundary.
      if (mesh.chunkShadowProxy === true) mesh.casterMinDiameter = gate;
      // Read before the gates below: the level is going to render both caster layers either way, and
      // a caster too small for this level's texels is still one the prewarm owes a draw.
      if (mesh.casterPrewarmOwed === true) prewarming = true;
      // Reduce geometry, never the caster's presence: alpha cutouts carry canopy and fences.
      if (biased && mesh.castShadow === true) {
        const chain = lodChainOf(mesh.geometry);
        const coarsest = chain?.levels[chain.levels.length - 1];
        if (coarsest !== undefined && coarsest !== mesh.geometry) {
          this.#coarsened.push({ geometry: mesh.geometry, mesh });
          mesh.geometry = coarsest;
        }
      }
      // The same two spheres three's cull uses: an instanced mesh's own, over its instances, or the
      // geometry's. `boundingSphere` is `null` on a fresh instanced mesh and undefined on a `Mesh`.
      const own = mesh.boundingSphere;
      let sphere: Sphere | null | undefined;
      if (own === undefined) {
        if (mesh.geometry.boundingSphere === null) mesh.geometry.computeBoundingSphere();
        sphere = mesh.geometry.boundingSphere;
      } else if (own === null || own.radius < 0) {
        mesh.computeBoundingSphere();
        sphere = mesh.boundingSphere;
      } else {
        sphere = own;
      }
      if (sphere === null || sphere === undefined) continue;
      // The box too, and for the same reason: a sphere has to cover a 128 m tile's diagonal, so its
      // height range is the tile's diagonal rather than the tile's relief, and the window's ground
      // is then read as 180 m of cliff.
      const ownBox = mesh.boundingBox;
      let box: Box3 | null | undefined;
      if (ownBox === undefined) {
        if (mesh.geometry.boundingBox === null) mesh.geometry.computeBoundingBox();
        box = mesh.geometry.boundingBox;
      } else if (ownBox === null) {
        mesh.computeBoundingBox();
        box = mesh.boundingBox;
      } else {
        box = ownBox;
      }
      // A mesh with no box of its own stands in its world sphere, which the world matrix and the
      // sphere already determine, so its two placeholders are never compared against anything.
      const boxYLow = box === null || box === undefined ? 0 : box.min.y;
      const boxYHigh = box === null || box === undefined ? 0 : box.max.y;
      // Two matrix applies per caster per render is what this memo replaces, and what it is keyed
      // on is what those two read: the world matrix, the local sphere, and the local box's height
      // range. A key that matches cannot have a different answer, so a mesh under a frozen subtree
      // and a stag that walked all skip and compute respectively — with nothing in the memo deciding
      // which is which. Only the box's Y is kept: `#probe` reads no other component of it, and the
      // two world spheres it does read are put back whole.
      const memoAt = entry * CASTER_STRIDE;
      const elements = mesh.matrixWorld.elements;
      let memoised = true;
      for (let e = 0; e < 16; e += 1) {
        if (memo[memoAt + e] !== elements[e]) {
          memoised = false;
          break;
        }
      }
      if (
        memoised &&
        (memo[memoAt + 16] !== sphere.center.x ||
          memo[memoAt + 17] !== sphere.center.y ||
          memo[memoAt + 18] !== sphere.center.z ||
          memo[memoAt + 19] !== sphere.radius ||
          memo[memoAt + 20] !== boxYLow ||
          memo[memoAt + 21] !== boxYHigh)
      )
        memoised = false;
      if (memoised) {
        _sphere.center.set(
          memo[memoAt + 22] as number,
          memo[memoAt + 23] as number,
          memo[memoAt + 24] as number,
        );
        _sphere.radius = memo[memoAt + 25] as number;
        _box.min.y = memo[memoAt + 26] as number;
        _box.max.y = memo[memoAt + 27] as number;
      } else {
        _sphere.copy(sphere).applyMatrix4(mesh.matrixWorld);
        if (box === null || box === undefined) {
          _box.min.set(_sphere.center.x, _sphere.center.y - _sphere.radius, _sphere.center.z);
          _box.max.set(_sphere.center.x, _sphere.center.y + _sphere.radius, _sphere.center.z);
        } else {
          _box.copy(box).applyMatrix4(mesh.matrixWorld);
        }
        for (let e = 0; e < 16; e += 1) memo[memoAt + e] = elements[e] as number;
        memo[memoAt + 16] = sphere.center.x;
        memo[memoAt + 17] = sphere.center.y;
        memo[memoAt + 18] = sphere.center.z;
        memo[memoAt + 19] = sphere.radius;
        memo[memoAt + 20] = boxYLow;
        memo[memoAt + 21] = boxYHigh;
        memo[memoAt + 22] = _sphere.center.x;
        memo[memoAt + 23] = _sphere.center.y;
        memo[memoAt + 24] = _sphere.center.z;
        memo[memoAt + 25] = _sphere.radius;
        memo[memoAt + 26] = _box.min.y;
        memo[memoAt + 27] = _box.max.y;
      }
      const at = this.#poolCount * POOL_STRIDE;
      if (at + POOL_STRIDE > this.#pool.length) {
        const grown = new Float64Array(this.#pool.length * 2);
        grown.set(this.#pool);
        this.#pool = grown;
      }
      const pool = this.#pool;
      pool[at] = _sphere.center.x;
      pool[at + 1] = _sphere.center.y;
      pool[at + 2] = _sphere.center.z;
      pool[at + 3] = _sphere.radius;
      pool[at + 4] = mesh.castShadow ? POOL_CASTERS : 0;
      pool[at + 5] = _box.min.y;
      pool[at + 6] = _box.max.y;
      this.#poolCount += 1;
      // A key is one submission for the whole world-grid square the two caster halves split into,
      // so every per-mesh decision below is the wrong unit for it: the texel gate would hide the
      // world's entire forest because the key's own geometry is small, and the halves' bills count
      // meshes this level does not draw at all. The dispatch applies this level's own gate per
      // placement, which is the decision that has an instance to make it about. Pooled like any
      // other caster — its bounds are the resident ring, exactly as a wide half's are — so the depth
      // span this level derives still covers what the keys can cast.
      if (keyed && (mesh.layers.mask & (1 << VIRTUAL_SHADOW_KEY_LAYER)) !== 0) {
        nKeys += 1;
        continue;
      }
      // Sub-texel: a caster the level cannot resolve draws no shadow a fragment could tell from
      // ground cover, so it is hidden for this render and put back immediately after it.
      //
      // On the part's own radius, not the cluster's. A world batch is one `InstancedMesh` per grid
      // square, so its sphere is ~24 m of square whatever it holds and every cluster cleared every
      // level's texel budget — the gate dropped nothing at all. `WorldCells` publishes the largest
      // instance scale it actually placed (`casterInstanceScale`), and the part's geometry radius
      // times that is the diameter a shadow map really has to resolve. A mesh without it — anything
      // but a world batch — is gated on its own sphere, exactly as before.
      // A bundled mesh is skipped by the gate: its render list is fixed when the bundle records it,
      // and a `visible = false` here would take it out of every record after the next re-record
      // while the replay still drew it this frame. See WorldCells `bundled`.
      if (
        mesh.castShadow &&
        mesh.chunkShadowProxy !== true &&
        mesh.userData.tnBundled !== true &&
        instanceDiameter(mesh, _sphere.radius) < gate
      ) {
        mesh.visible = false;
        this.#hidden.push(mesh);
        gateHidden += 1;
        continue;
      }
      // What this level would submit from each half, counted as it goes: a hidden caster submits
      // nothing, so it is not in either bill. A key-wide mesh spans the whole ring, so the level
      // keeps it whether or not the window reaches it — the cull, not the choice, decides that one.
      // A retained chunk proxy belongs to both halves and costs the same whichever one is chosen.
      const bothHalves =
        (mesh.layers.mask & (clusterLayer | wideLayer)) === (clusterLayer | wideLayer);
      if (!bothHalves && (mesh.layers.mask & clusterLayer) !== 0) {
        if (Math.hypot(_sphere.center.x - centre.x, _sphere.center.z - centre.z) <= window)
          clusterDraws += 1;
      } else if (!bothHalves && (mesh.layers.mask & wideLayer) !== 0) {
        wideDraws += 1;
      }
      // The same bill by kind, for what the level's chosen layers end up submitting. Only a caster
      // counts, and the per-chunk proxies — named `<name>-shadow`, on both caster halves —
      // are bucketed apart from the batches they stand in for so they are not counted twice. The
      // small layer and layer 0's own casters take no part in the cluster/wide choice above.
      if (mesh.castShadow === true) {
        if (mesh.name.endsWith("-shadow")) {
          if (bothHalves) nChunkBoth += 1;
          else nChunk += 1;
        } else if ((mesh.layers.mask & smallLayer) !== 0) nSmall += 1;
        else if ((mesh.layers.mask & clusterLayer) !== 0) nCluster += 1;
        else if ((mesh.layers.mask & wideLayer) !== 0) nWide += 1;
        else if ((mesh.layers.mask & 1) !== 0) nLayer0 += 1;
      }
    }
    // One of the two caster layers, never both, and the cheaper bill: clusters when the squares the
    // window covers are fewer than the keys waiting on the wide layer, one mesh per key when they are
    // not. A fraction of the ring's radius was the rule before, and a 192 m window over a 640 m ring
    // is 36% of it — clustered, at one draw per square where one per key would do. Layer 0 stays on,
    // because the terrain and everything else in the world casts from it, and a world with no caster
    // batch at all counts zero of both and takes the wide layer for nothing. A level rendering while
    // a caster is still owed its prewarm draw takes both, which is the only way the half it did not
    // pick gets its node built before the pass.
    const clustered = clusterDraws < wideDraws;
    level.shadow.camera.layers.set(0);
    // A keyed world draws its keys on their own layer, which every level camera carries: there is no
    // half to choose and no small-caster layer, because the dispatch's per-placement selection
    // answers both questions in the twin buffers this render is about to submit. The cluster layer
    // stays on for what is not the world's own keys — merged chunk proxies, and any caster a game put
    // on the caster layer itself, neither of which the GPU scene knows about.
    if (keyed) {
      level.shadow.camera.layers.enable(VIRTUAL_SHADOW_KEY_LAYER);
      level.shadow.camera.layers.enable(VIRTUAL_SHADOW_CASTER_LAYER);
    } else {
      level.shadow.camera.layers.enable(
        clustered || prewarming ? VIRTUAL_SHADOW_CASTER_LAYER : VIRTUAL_SHADOW_WIDE_CASTER_LAYER,
      );
      if (prewarming) level.shadow.camera.layers.enable(VIRTUAL_SHADOW_WIDE_CASTER_LAYER);
      // Small casters use the same texel gate as every other layer; their authored height is
      // not a reason to lose a resolved shadow when the fine window ends.
      level.shadow.camera.layers.enable(VIRTUAL_SHADOW_SMALL_CASTER_LAYER);
    }
    // Proxies belong to both halves: their covered originals no longer cast.
    // A keyed level's camera carries the key layer *and* the cluster layer, so the cluster bill is what
    // it submits from that layer whether or not the world minted keys: a keyed world mints no caster
    // half and counts zero, and a world whose keys the GPU scene could not mint keeps the halves it did
    // mint — and zeroing that bill is how a level reported 330 draws while submitting the forest's
    // cluster meshes as well. The wide and small layers are not carried by a keyed camera, so their
    // meshes are not submitted and stay at zero.
    const chosenCluster = keyed === false ? clustered || prewarming : true;
    const chosenWide = keyed === false && (!clustered || prewarming);
    const chosenSmall = keyed === false;
    const by = stat.drawsBy;
    by.cluster = chosenCluster ? nCluster : 0;
    by.chunkProxy = nChunkBoth + (chosenCluster || keyed ? nChunk : 0);
    by.wide = chosenWide ? nWide : 0;
    by.small = chosenSmall ? nSmall : 0;
    by.layer0 = nLayer0;
    by.keys = nKeys;
    stat.draws = by.cluster + by.wide + by.small + by.chunkProxy + by.layer0 + by.keys;
    stat.gateHidden = gateHidden;
    level.gateHidden = gateHidden;
    level.gateMetres = gate;
  }

  /**
   * Put back every caster `#probe` changed: the ones its texel gate hid and the geometry
   * it swapped for a coarser chain level. The next camera
   * — the next level's map, a mover map, the main pass — sees the world as it was authored.
   */
  #restoreHidden(): void {
    for (const object of this.#hidden) object.visible = true;
    for (const held of this.#coarsened) held.mesh.geometry = held.geometry;
    this.#hidden.length = 0;
    this.#coarsened.length = 0;
  }

  /**
   * Render one level's map — cached or mover — as the stock shadow node draws it. What a coarse
   * level draws less of is set on the world by `#probe` and put back by `#restoreHidden`, which is
   * the same seam the texel gate has always used: three hands `renderObject` the geometry but the
   * cached render object re-reads `object.geometry` itself, so only what the object holds can change
   * what a draw submits, and the renderer's own per-draw function is not ours to wrap.
   */
  #renderLevel(frame: NodeFrame, level: ILevel, mover: boolean, index = 0): void {
    // quality-allow: Three exposes updateShadow only on its internal rendering shadow node.
    const node = (mover ? level.moverNode : level.node) as unknown as IRenderingShadowNode;
    // The level's own keys, selected against this map's own three numbers, before the render that
    // submits them. A mover map is never keyed: it draws the tracked casters and nothing else, so
    // a dispatch there would put the whole world into a 256² map of one moving object.
    if (mover === false) this.#dispatchKeys(frame, level, index);
    // What a level's own render costs, measured around the draw and smoothed over the reading
    // before it. A mover map is a handful of tracked casters and is never scheduled against, so it
    // is not measured, and with both adaptive refresh and the adaptive caster gate off nothing is:
    // the reading buys a wider trail and a raised gate, and is what those two switches gate. What
    // the reading buys is set on the next frame, by `#adaptiveTrails`.
    if (mover || !(this.options.adaptiveRefresh || this.options.adaptiveCasterGate)) {
      node.updateShadow(frame);
      return;
    }
    const started = performance.now();
    try {
      node.updateShadow(frame);
    } finally {
      const measured = performance.now() - started;
      level.costReadings += 1;
      // A level's first renders carry shader compilation and texture upload, not the level's
      // ongoing price; trusting them would widen a cheap level's trail or raise its gate before the
      // pipeline is warm. The cost stays 0 until the counter passes them, so nothing adapts yet.
      if (level.costReadings > COST_WARMUP_RENDERS) {
        level.costMs =
          level.costMs <= 0 ? measured : level.costMs + (measured - level.costMs) * COST_SMOOTHING;
      }
    }
  }

  /**
   * Hand this level's set to whatever published keys on the world's root, in the three numbers that
   * are the map's own and not the main camera's: its own light frustum, the window centre its map
   * was rendered with, the texel gate `#probe` just decided on, and the chain level it draws at.
   *
   * A no-op without a publisher, which is the flag's whole off state. The frustum comes from
   * `updateMatrices`, which is what the stock node calls inside `updateShadow` and which positions
   * this level's own shadow camera from its light — so the planes are the ones the render about to
   * happen is made with, rather than last render's, and are read before it rather than after.
   *
   * `base` mirrors `#probe`: past the finest level every caster here is drawn coarsened, so the
   * dispatch floors every asset at its own coarsest chain level. Past-the-end is clamped per asset
   * on the far side, because no asset in this scene has told this node how long its chain is.
   */
  #dispatchKeys(frame: NodeFrame, level: ILevel, index: number): void {
    const keys = this.#gpuKeys;
    if (keys === undefined) return;
    const shadow = level.shadow;
    // quality-allow: the light's own shadow owns this update, and the stock node calls it too.
    shadow.updateMatrices(level.light as unknown as DirectionalLight);
    _shadowProjection.multiplyMatrices(
      shadow.camera.projectionMatrix,
      shadow.camera.matrixWorldInverse,
    );
    _shadowFrustum.setFromProjectionMatrix(_shadowProjection);
    const planes = _shadowPlanes;
    for (const [at, plane] of _shadowFrustum.planes.entries()) {
      const offset = at * 4;
      planes[offset] = plane.normal.x;
      planes[offset + 1] = plane.normal.y;
      planes[offset + 2] = plane.normal.z;
      planes[offset + 3] = plane.constant;
    }
    // Every compute leaves the one node frame every node shares with its fields at their bare
    // defaults — `scene` among them, which `Nodes.getNodeFrame()` sets with no arguments
    // (three.webgpu.js:56215, reached from `Renderer.compute` at 62235) and nothing puts back; the
    // restore at 62249 is `renderId` and nothing else. Three re-establishes that frame per draw
    // (56224), which is why a compute *outside* a render is harmless — but this one is inside the
    // draw `updateShadow` is about to run in, and it reads the scene off the frame it is handed
    // (45602) to save the scene state before rendering it. So the render's own frame is put back
    // around the dispatch, which is all the kernel needed it for.
    const { camera, material, object, scene } = frame;
    try {
      keys(frame.renderer, {
        base: index >= 1 && this.options.shadowLodBias ? COARSEST_SHADOW_LEVEL : 0,
        gate: level.gateMetres,
        planes,
      });
    } finally {
      frame.camera = camera;
      frame.material = material;
      frame.object = object;
      frame.scene = scene;
    }
  }

  /**
   * Step each level's window with the trail its own render cost can afford, before the clipmap
   * computes this frame's windows. Nothing here runs unless adaptive refresh is on, and a level
   * under the share comes out of it with the step it was configured with — the same number, so the
   * same window, so the same counts.
   *
   * The widening is proportional to the overshoot: a level costing `n` times the share refreshs
   * about `n` times less often, because that is the ratio between what the level costs and what a
   * frame can afford to spend on it. It is then capped by the window's own margin, which is what
   * makes it safe rather than merely useful:
   *
   * ```
   * trail ≤ extent − extent × guard = extent × (1 − guard)
   * ```
   *
   * `extent` is the rendered window's half-width, and `extent × guard` is the half-width around that
   * window's own centre within which a fragment is served by this level at all — the camera's own
   * surroundings, measured from the map rather than from the centre being followed, which is what
   * the selection's offsets are for. The inequality says the window may trail the camera by
   * everything that region does not already use, so the camera stays inside the region its own level
   * serves, and everything the level serves stays inside the map it is served from. A level with no
   * margin left (`guard: 1`, or a step already at it) is never widened at all.
   */
  #adaptiveTrails(frame: NodeFrame, now: number): void {
    const trails = this.options.adaptiveRefresh;
    const gates = this.options.adaptiveCasterGate;
    if (!trails && !gates) return;
    // The period is the frame's own, so the share is read against the panel this is running on —
    // but never longer than the 60 fps frame. The frame that renders a costly level is long because
    // of that very render, so its own delta would inflate the budget by the cost being judged and
    // the level would pass its own test; capping at 16.7 ms keeps a 120 Hz frame stricter and stops
    // a stall from widening the budget with it. A frame that carries no clock — a harness, a held
    // frame — is just the cap.
    const delta = (frame as { deltaTime?: number }).deltaTime ?? 0;
    const periodMs = Math.min(
      delta > 0 ? delta * 1000 : Number.POSITIVE_INFINITY,
      1000 / DEFAULT_TARGET_FPS,
    );
    const affordableMs = this.options.expensiveRefreshShare * periodMs;
    this.#levels.forEach((level, index) => {
      if (trails) {
        const base = at(this.options.refreshStep, index);
        // What is left of that margin once the clipmap has rounded the step to a whole number of
        // texels: it rounds up by at most half of one, and one of those is `extent / mapSize` of
        // extent, so the trail it actually steps by is still inside the margin. A level with no such
        // margin left is held at the step it was given and is not widened at all.
        const margin = Math.max(
          base,
          1 - at(this.options.selectionGuard, index) - 1 / this.options.mapSize,
        );
        const step = Math.min(base * Math.max(1, level.costMs / affordableMs), margin);
        if (step !== level.appliedStep) {
          this.clipmap.setRefreshStep(index, step);
          level.appliedStep = step;
          if (step > base && now - level.lastRefreshNote >= REFRESH_MARKER_SECONDS) {
            level.lastRefreshNote = now;
            console.info(
              `${VIRTUAL_SHADOW_REFRESH_MARKER} level=${String(index)} width=${String(2 * level.extent)} ms=${level.costMs.toFixed(1)} trail=${step.toFixed(3)}`,
            );
          }
        }
      }
      if (gates) this.#adaptGate(level, index, affordableMs, now);
    });
  }

  /**
   * Step one level's adaptive caster gate from the cost of the render it just took, at most once per
   * render. A level over the affordable share raises its gate by half until it is affordable or the
   * cap is reached; one comfortably under half the share halves its gate back toward 1. Between the
   * two it holds — that band is the hysteresis, so a level on the budget does not oscillate. A level
   * that has not rendered has no reading and is never touched.
   */
  #adaptGate(level: ILevel, index: number, affordableMs: number, now: number): void {
    // A coarse texel is already the resolution gate. Cost must not raise it to 12 texels
    // (15 m at 320@512), which erases resolved canopy when the fine map hands over.
    if (index > 0) return;
    if (level.lastRender === Number.NEGATIVE_INFINITY) return;
    if (level.gatedRender === level.lastRender) return;
    level.gatedRender = level.lastRender;
    if (level.costMs <= 0) return;
    let scale = level.gateScale;
    if (level.costMs > affordableMs) {
      scale = Math.min(GATE_SCALE_CAP, scale * GATE_SCALE_RISE);
    } else if (level.costMs < affordableMs * GATE_DECAY_SHARE) {
      scale = Math.max(1, scale * GATE_SCALE_DECAY);
    }
    if (scale === level.gateScale) return;
    level.gateScale = scale;
    if (now - level.lastGateNote < GATE_MARKER_SECONDS) return;
    level.lastGateNote = now;
    console.info(
      `${VIRTUAL_SHADOW_GATE_MARKER} level=${String(index)} width=${String(2 * level.extent)} ms=${level.costMs.toFixed(1)} scale=${scale.toFixed(3)} hidden=${String(level.gateHidden)}`,
    );
  }

  /**
   * The light-space depth one level needs, from what can actually shadow its window: every caster
   * whose own extent reaches the window, turned into light space along the sun. A caster and its
   * receiver share u/v, so overlap on those axes is sufficient, regardless of the centre's depth.
   *
   * The u/v box is what bounds the window sideways, so the depth is the only free axis, and every
   * object that overlaps that box has already been found: the pool is the whole candidate set and
   * this pass over it costs no second walk of the world. The height comes from each box rather than each
   * sphere, because a sphere has to cover a 128 m tile's diagonal and would report 180 m of cliff
   * where the tile has 15 m of it.
   */
  #deriveDepth(level: ILevel, centre: IVector3Like): void {
    const pool = this.#pool;
    const count = this.#poolCount;
    const { basisU, basisV, basisW } = this.clipmap;
    const extent = level.extent;
    // The box's own reach, in each of the three light axes: sideways is bounded, so a point in the
    // window is at most this far along either of them.
    const side = extent * Math.SQRT2;
    // A caster wider than the window is not standing in it, it is a mass the window is cut out of:
    // its own span along the light is the whole world's, and the only part of it this frustum can
    // ever hold is the height of its box.
    const fits = extent * 2 * MAX_MASS_WINDOW_WIDTHS;
    const sin = basisW.y;
    // A sun on or below the horizon needs the fallback span rather than division by almost zero.
    if (sin < MIN_SUN_COSINE) return;
    const heightReach = extent * (Math.abs(basisU.y) + Math.abs(basisV.y));
    // Everything that writes depth: the casters whose bounding sphere reaches into the window's
    // u/v box. A receiver writes no depth, so a piece of ground that only receives is not in the
    // frustum at all, however tall it is — that is the whole reason this is not a fixed range.
    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < count; index += 1) {
      const at = index * POOL_STRIDE;
      if (((pool[at + 4] as number) & POOL_CASTERS) === 0) continue;
      const radius = pool[at + 3] as number;
      const dx = (pool[at] as number) - centre.x;
      const dy = (pool[at + 1] as number) - centre.y;
      const dz = (pool[at + 2] as number) - centre.z;
      const u = Math.abs(dx * basisU.x + dy * basisU.y + dz * basisU.z);
      const v = Math.abs(dx * basisV.x + dy * basisV.y + dz * basisV.z);
      if (u > side + radius || v > side + radius) continue;
      const along = dx * basisW.x + dy * basisW.y + dz * basisW.z;
      const boxLow = pool[at + 5] as number;
      const boxHigh = pool[at + 6] as number;
      if (radius * 2 > fits) {
        // A mass, not a caster in the window: the only part of it this frustum can hold is the
        // height of its box. Solve y = centre.y + u*U.y + v*V.y + w*W.y across the window;
        // multiplying by W.y instead clips tall instances inside a wide batch at low sun angles.
        const from = (boxLow - centre.y - heightReach) / sin;
        const to = (boxHigh - centre.y + heightReach) / sin;
        if (from < low) low = from;
        if (to > high) high = to;
        continue;
      }
      // The u/v overlap already includes every caster in a receiver's light-space column.
      if (along - radius < low) low = along - radius;
      if (along + radius > high) high = along + radius;
    }
    if (!Number.isFinite(low)) return;
    const span = high - low;
    if (!(span > 0)) return;
    // Two per cent of slack, and never less than a metre: the pool holds bounding spheres, which
    // round up, and a caster a shadow-map texel taller than the window's own ground must still draw.
    const margin = Math.max(1, span * 0.02);
    level.eye = high + margin;
    level.depthNear = margin;
    level.depthFar = margin + span;
  }

  /** Put a level's camera on its window with the depth it last derived, and hold both maps to it. */
  #place(level: ILevel, centre: IVector3Like): void {
    const { basisW } = this.clipmap;
    level.light.position.set(
      centre.x + basisW.x * level.eye,
      centre.y + basisW.y * level.eye,
      centre.z + basisW.z * level.eye,
    );
    level.light.updateMatrixWorld(true);
    this.#setDepth(level.shadow.camera, level);
    // The mover map is the same window with the tracked casters in it, so it is the same column.
    this.#setDepth(level.moverShadow.camera, level);
  }

  /** Hand a level's own cameras the depth it derived, when it is not the depth they already hold. */
  #setDepth(camera: OrthographicCamera, level: ILevel): void {
    if (camera.near === level.depthNear && camera.far === level.depthFar) return;
    camera.near = level.depthNear;
    camera.far = level.depthFar;
    camera.updateProjectionMatrix();
  }

  #init(): void {
    if (this.#initialised) return;
    this.#initialised = true;
    const source = this.light as DirectionalLight;
    source.addEventListener("removed", this.#onLightRemoved);
    let shadowColor: ReturnType<typeof getShadowMaterial>["colorNode"] = null;
    this.options.clipExtents.forEach((extent, index) => {
      const levelShadow = source.shadow.clone();
      syncShadowSettings(source.shadow, levelShadow);
      levelShadow.mapSize.set(this.options.mapSize, this.options.mapSize);
      levelShadow.camera.left = -extent;
      levelShadow.camera.right = extent;
      levelShadow.camera.top = extent;
      levelShadow.camera.bottom = -extent;
      levelShadow.camera.near = 1;
      levelShadow.camera.far = this.options.lightDistance + this.options.depthRange;
      levelShadow.camera.updateProjectionMatrix();
      // The caster-only layer, so a mesh that exists to be a shadow caster draws into this level's
      // map and not into the main pass. It also fixes this camera's layer mask, which three would
      // otherwise take from the main camera.
      levelShadow.camera.layers.enable(VIRTUAL_SHADOW_CASTER_LAYER);
      // The same pin for the key layer a GPU-driven map draws on, which `#probe` re-asserts on
      // every render it takes; enabling it here means a level's mask is never layer 0 alone, which
      // three overwrites with the main camera's.
      levelShadow.camera.layers.enable(VIRTUAL_SHADOW_KEY_LAYER);
      // Cached: the stock node renders only when asked — and not before this node has placed
      // the level, which happens in `updateBefore`. A render requested here would run on the
      // first frame from an unplaced light, and three's per-frame guard would then keep that
      // blank map as the frame's answer.
      levelShadow.autoUpdate = false;
      levelShadow.needsUpdate = false;
      const moverShadow = levelShadow.clone();
      syncShadowSettings(source.shadow, moverShadow);
      moverShadow.mapSize.set(this.options.moverMapSize, this.options.moverMapSize);
      moverShadow.camera.updateProjectionMatrix();
      moverShadow.autoUpdate = false;
      moverShadow.needsUpdate = false;
      // Only the tracked casters: the stock node keeps a camera's own layer mask when it names
      // any layer but the default.
      moverShadow.camera.layers.set(VIRTUAL_SHADOW_MOVER_LAYER);
      const light = new LevelLight(levelShadow);
      light.name = `VirtualShadowLevel${String(index)}`;
      // quality-allow: the stock shadow node reads only position, target and shadow off its light
      const node = registeredOnCreate(shadow(light as unknown as DirectionalLight, levelShadow));
      const moverNode = registeredOnCreate(
        shadow(light as unknown as DirectionalLight, moverShadow), // quality-allow: the stock node reads only position, target and shadow
      );
      if (this.options.receiverPlaneBias) {
        for (const entry of [
          { node, map: levelShadow },
          { node: moverNode, map: moverShadow },
        ]) {
          const stock = entry.node as typeof node & {
            setupShadowFilter: (
              builder: NodeBuilder,
              inputs: { shadowCoord: ReturnType<typeof vec3> },
            ) => Node;
          };
          const filter = stock.setupShadowFilter;
          stock.setupShadowFilter = (builder, inputs) => {
            // A custom filter owns its sampling footprint; leave it and all authored biases intact.
            if ((entry.map as ShadowWithFilter).filterNode)
              return filter.call(stock, builder, inputs);
            const type = builder.renderer.shadowMap.type;
            const footprint =
              type === PCFSoftShadowMap
                ? float(2)
                : type === PCFShadowMap
                  ? max(rendered(reference("radius", "float", entry.map)), 0).add(1)
                  : float(0.5);
            const span = rendered(reference("far", "float", entry.map.camera)).sub(
              rendered(reference("near", "float", entry.map.camera)),
            );
            const bias = this.#receiverSlope
              .mul(2 * extent)
              .div(rendered(reference("mapSize", "vec2", entry.map)).x)
              .div(span)
              .mul(footprint);
            const coord = inputs.shadowCoord;
            return filter.call(stock, builder, {
              ...inputs,
              shadowCoord: vec3(
                coord.xy,
                builder.renderer.reversedDepthBuffer ? coord.z.add(bias) : coord.z.sub(bias),
              ),
            });
          };
        }
      }
      if (this.#levelsRequested) {
        // Observe the stock sampler's actual coordinate, including normal bias and any received
        // shadow position override. Selection-space u/v cannot diagnose a projection mismatch.
        const stock = node as typeof node & {
          setupShadowFilter: (
            builder: NodeBuilder,
            inputs: { shadowCoord: ReturnType<typeof vec3> },
          ) => Node;
        };
        const filter = stock.setupShadowFilter;
        stock.setupShadowFilter = (builder, inputs) => {
          const levelTint = this.#levelTints.get(builder);
          const uv = inputs.shadowCoord;
          const inside = and(
            and(uv.x.greaterThanEqual(0), uv.x.lessThanEqual(1)),
            and(uv.y.greaterThanEqual(0), uv.y.lessThanEqual(1)),
          );
          const colour =
            index === 0
              ? vec3(1, 0, 0)
              : index === 1
                ? vec3(0, 1, 0)
                : index === 2
                  ? vec3(0, 0, 1)
                  : vec3(1, 1, 0);
          // No tint recorded yet means this build is not one the diagnostic set up; the stock
          // shadow then stands alone rather than reading a declaration that is not there.
          if (levelTint === undefined) return filter.call(stock, builder, inputs);
          Stack(new AssignNode(levelTint, inside.select(colour, vec3(1, 0, 1))));
          return filter.call(stock, builder, inputs);
        };
      }
      // Stock shadow colours are identical, but their node identities split the shader cache.
      // Share only that constant; each level keeps its material, camera and render bindings.
      const material = getShadowMaterial(node.light);
      shadowColor ??= material.colorNode;
      material.colorNode = shadowColor;
      this.#levels.push({
        appliedStep: at(this.options.refreshStep, index),
        costMs: 0,
        costReadings: 0,
        gatedRender: Number.NEGATIVE_INFINITY,
        gateHidden: 0,
        gateScale: 1,
        gateMetres: 0,
        lastGateNote: Number.NEGATIVE_INFINITY,
        depthFar: this.options.lightDistance + this.options.depthRange,
        depthNear: 1,
        dirty: false,
        eye: this.options.lightDistance,
        extent,
        extentUniform: uniform(extent).setGroup(renderGroup),
        lastRender: Number.NEGATIVE_INFINITY,
        lastRefreshNote: Number.NEGATIVE_INFINITY,
        light,
        mapped: uniform(0).setGroup(renderGroup),
        minX: Number.NaN,
        minY: Number.NaN,
        centerW: Number.NaN,
        pending: REASON_NONE,
        offsetU: uniform(0).setGroup(renderGroup),
        offsetV: uniform(0).setGroup(renderGroup),
        guardUniform: uniform(
          this.options.selectionGuard[index] ?? this.options.selectionGuard.at(-1) ?? 0,
        ).setGroup(renderGroup),
        moverShadow,
        // One placeholder light serves both maps: the stock node reads only its placement.
        moverNode,
        node,
        shadow: levelShadow,
      });
    });
  }

  override setup(builder: NodeBuilder): Node | null | undefined {
    if (builder.renderer.shadowMap.enabled === false) return null;
    // Read once, like tnShadowStats. Build no diagnostic nodes unless the URL switch is on.
    if (this.#levelsRequested === undefined) {
      const search = globalThis.location?.search ?? "";
      this.#levelsRequested = /[?&]tnShadowLevels=(?!0(?:&|$))(?!false(?:&|$))[^&]/u.test(search);
      // Counter runs: a fixed refreshStep, since the adaptive step follows measured render cost and
      // two runs of one route would move their windows at different ticks. Set once, before a frame.
      if (
        this.#adaptiveRefreshGiven === undefined &&
        /[?&]tnAdaptiveRefresh=(?:0|false)(?:&|$)/u.test(search)
      ) {
        (this.options as { adaptiveRefresh: boolean }).adaptiveRefresh = false;
      }
    }
    this.#init();
    const levels = this.#levels;
    const centerU = this.#centerU;
    const centerV = this.#centerV;
    const moversActive = this.#moversActive;
    const basisU = this.#basisU;
    const basisV = this.#basisV;
    let tint: Node<"vec3"> | undefined;
    if (this.#levelsRequested) {
      // Declared here, outside the returned function, because three runs that function's body at
      // the setup stage — which is the only stage at which the lighting stack below is still
      // accepting nodes. A `var` declared inside it lands after every use of it.
      tint = vec3(0, 1, 1).toVar(`virtualShadowLevelTint${String(this.id)}`);
      this.#levelTints.set(builder, tint);
      const outgoing = (builder.context as { outgoingLight?: Node<"vec3"> }).outgoingLight;
      if (outgoing !== undefined) {
        // Three has assembled the lighting stack before building this shadow dependency. Append
        // after its final assignments so the overlay retains every light and the shadow result.
        const stack = (
          builder as NodeBuilder & { getActiveStack(): { nodes: Node[] } | undefined }
        ).getActiveStack();
        stack?.nodes.push(new AssignNode(outgoing, mix(outgoing, tint, 0.5)));
      }
    }
    return Fn(() => {
      this.setupShadowPosition(builder);
      if (this.options.receiverPlaneBias) {
        // Derivatives must execute before the non-uniform level branches. A shared geometric
        // receiver plane supplies world-depth slope; each map scales it by its own texel and span.
        const received = vec3(shadowPositionWorld as never);
        const normal = dFdx(received).cross(dFdy(received)).toVar();
        const along = max(abs(normal.dot(this.#basisW)), max(length(normal).mul(0.0001), 1e-12));
        this.#receiverSlope.assign(
          abs(normal.dot(basisU))
            .add(abs(normal.dot(basisV)))
            .div(along),
        );
      }
      const u = positionWorld.dot(vec3(basisU as never)).sub(centerU as never);
      const v = positionWorld.dot(vec3(basisV as never)).sub(centerV as never);
      const coarsest = levels[levels.length - 1];
      if (coarsest === undefined) return vec4(1, 1, 1, 1);
      const moverResult = (level: ILevel) =>
        moversActive.greaterThan(0).select(vec4(level.moverNode as never), vec4(1, 1, 1, 1));
      // Cyan is the answer for a fragment no level sampled, so the default is written here rather
      // than left to whichever level branch a fragment happens to take.
      if (tint !== undefined) tint.assign(vec3(0, 1, 1));
      // The coarsest fallback can be unmapped; finer unmapped levels never win selection.
      // Every level is read through its own `mapped` gate. A level whose map this node has not
      // drawn yet contributes nothing rather than being sampled: with one level rendered per frame
      // the coarse levels trail the fine one, and their targets hold nothing to compare against.
      const result = vec4(1, 1, 1, 1).toVar("virtualShadowValue");
      If(coarsest.mapped.greaterThan(0), () => {
        result.assign(min(vec4(coarsest.node as never), moverResult(coarsest)));
      });
      // Coarse to fine, so the finest containing level assigns last and wins.
      for (let index = levels.length - 2; index >= 0; index -= 1) {
        const level = levels[index];
        if (level === undefined) continue;
        // This level's own window, so a level holding an older window still selects the map it
        // actually has. `u`/`v` are measured from the followed centre; `offsetU`/`offsetV` carry the
        // difference back to the rendered window's centre.
        const distance = max(abs(u.add(level.offsetU)), abs(v.add(level.offsetV))).toVar(
          `virtualShadowDistance${String(index)}`,
        );
        If(
          and(
            level.mapped.greaterThan(0),
            distance.lessThanEqual(level.extentUniform.mul(level.guardUniform)),
          ),
          () => {
            const edge = level.extentUniform.mul(level.guardUniform);
            // Use the existing unused map margin, with at least two texels for guard=1.
            const band = max(
              level.extentUniform.sub(edge),
              level.extentUniform.mul(4 / this.options.mapSize),
            );
            const weight = smoothstep(edge.sub(band), edge, distance).oneMinus();
            result.assign(mix(result, min(vec4(level.node as never), moverResult(level)), weight));
          },
        );
      }
      return result;
      // quality-allow: Three's Fn invocation loses the concrete node type.
    })() as unknown as Node;
  }

  override updateBefore(frame: NodeFrame): undefined {
    // Three calls this once per `render()`, and a level render *is* a `render()`: the draw the
    // budget grants below re-enters this method with a new render id. Without this guard the
    // one-level-per-frame budget resets on that re-entry, so a frame with every level due draws
    // all of them — measured on `?scene=map-walk`, where the levels are re-rendered as a group
    // every time a residency update invalidates them.
    if (this.#updating) return undefined;
    this.#updating = true;
    // Three runs this from the draw of the first object that uses the node, and that draw can be the
    // first object of a `BundleGroup` the main pass is recording. Three keeps that bundle in
    // `_currentRenderBundle` and does not save it across the nested `render()` a level is: the
    // level's draws would be filed under the main bundle, and the level's own bundles leave the
    // field `null`, so the main bundle's remaining draws are recorded but never listed — a replay
    // refreshes only listed draws, so those keep the camera they were recorded with. On Machinefall
    // that froze a cell's chunk forest on screen for twenty walk steps. The levels render outside
    // the record, and the record gets its bundle back.
    // quality-allow: three 0.185 does not expose the bundle it is recording.
    const host = frame.renderer as unknown as { _currentRenderBundle?: unknown };
    const recording = host._currentRenderBundle;
    if (recording !== undefined) host._currentRenderBundle = null;
    try {
      this.#updateFrame(frame);
    } finally {
      this.#updating = false;
      if (recording !== undefined) host._currentRenderBundle = recording;
    }
    return undefined;
  }

  /** Resident numerical terrain owns elevation; an unloaded region is not a zero-height plane. */
  #heightAt(x: number, z: number): number | undefined {
    for (const source of this.#heightSources) {
      try {
        const height = source.heightAt(x, z);
        if (!Number.isFinite(height))
          throw new Error("Virtual shadow focus received non-finite terrain height.");
        return height;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.endsWith("is outside its resident region."))
          throw error;
      }
    }
    return undefined;
  }

  /** Aerial windows follow the forward ray's received surface, without changing walking follow. */
  #viewFocus(camera: Camera, eye: Vector3): Vector3 {
    _focus.copy(eye);
    if (!this.options.followViewFocus) return _focus;
    camera.getWorldDirection(_forward);
    if (_forward.y >= 0) return _focus;
    this.#ensureCasters();
    let height = this.#heightAt(eye.x, eye.z);
    // Generic received geometry has no numerical height API. Bounds only decide whether the
    // camera is aerial; the forward ray below measures its actual surface, not a box plane.
    if (height === undefined) {
      for (const mesh of this.#casterTable) {
        if (!mesh.visible || !mesh.receiveShadow) continue;
        if (mesh.geometry.boundingBox === null) mesh.geometry.computeBoundingBox();
        if (mesh.geometry.boundingBox === null) continue;
        _box.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
        if (eye.x < _box.min.x || eye.x > _box.max.x || eye.z < _box.min.z || eye.z > _box.max.z)
          continue;
        height = Math.max(height ?? Number.NEGATIVE_INFINITY, _box.max.y);
      }
    }
    if (height === undefined || eye.y - height <= (this.options.clipExtents[0] ?? 0)) return _focus;
    const far = (camera as Camera & { far?: number }).far ?? Number.POSITIVE_INFINITY;
    // Solve against the stored height, including terrain relief along the ray. Flat terrain
    // converges in one query; a bounded iteration avoids scanning terrain triangles every frame.
    // Never raycast received triangles here: a streamed world holds thousands of receiving
    // meshes, and a per-frame scan of them blocked the main thread for seconds. The windows carry
    // guard bands, so the ray's hit on the received height (or the plane under the eye where no
    // numerical height exists) is focus enough.
    let distance = Math.min((height - eye.y) / _forward.y, far);
    if (!(distance > 0)) return _focus;
    _focus.copy(eye).addScaledVector(_forward, distance);
    for (let step = 0; step < 16; step += 1) {
      const received = this.#heightAt(_focus.x, _focus.z);
      if (received === undefined || Math.abs(_focus.y - received) <= 0.001) break;
      const next = (received - eye.y) / _forward.y;
      if (!(next > 0) || next > far) break;
      distance = next;
      _focus.copy(eye).addScaledVector(_forward, distance);
    }
    return _focus;
  }

  #updateFrame(frame: NodeFrame): undefined {
    if (!this.#initialised) return undefined;
    const camera = frame.camera as Camera | null;
    if (camera === null) return undefined;
    const source = this.light as DirectionalLight;
    syncLevelShadowSettings(source.shadow, this.#levels);
    const parent = source.parent;
    for (const level of this.#levels) {
      if (level.light.parent === null && parent !== null) {
        parent.add(level.light.target);
        parent.add(level.light);
      }
    }
    source.updateWorldMatrix(true, false);
    source.target.updateWorldMatrix(true, false);
    // Toward the source: the clipmap's W axis points at the light.
    _direction
      .setFromMatrixPosition(source.matrixWorld)
      .sub(source.target.getWorldPosition(_center));
    if (_direction.lengthSq() === 0) _direction.set(0, 1, 0);
    const directionChanged = this.clipmap.setDirection({
      x: _direction.x,
      y: _direction.y,
      z: _direction.z,
    });
    camera.updateMatrixWorld(true);
    const cameraPosition = _center.setFromMatrixPosition(camera.matrixWorld);
    // The engine's own frame clock, in seconds. This is what a level's invalidation delay is
    // measured against, so a test drives time instead of frames and a 3.33 s delay means 3.33 s
    // whatever the frame rate is. Read once, here, because the levels below all measure against it.
    const now = (frame as { time?: number }).time ?? 0;
    this.#adaptiveTrails(frame, now);
    const windows = this.clipmap.updateCenter(this.#viewFocus(camera, cameraPosition));
    this.#centerU.value = this.clipmap.centerLight.u;
    this.#centerV.value = this.clipmap.centerLight.v;
    this.#basisU.value.set(this.clipmap.basisU.x, this.clipmap.basisU.y, this.clipmap.basisU.z);
    this.#basisV.value.set(this.clipmap.basisV.x, this.clipmap.basisV.y, this.clipmap.basisV.z);
    this.#basisW.value.set(this.clipmap.basisW.x, this.clipmap.basisW.y, this.clipmap.basisW.z);
    // A caster that stopped casting, or stopped being visible, changed what the levels hold without
    // changing the tree, so nothing else on the frame would say so. Asked here, before this frame's
    // own writes to those flags, which is what `#probe` and the mover exclusion below both do.
    this.#pollCasters();
    this.#classifyCasters();
    const moverSources = this.#casters.size + this.#autoMovers.size + this.#autoSettling.size;
    this.#moversActive.value = moverSources > 0 ? 1 : 0;

    // Movers leave the cached maps and are drawn into the mover maps below. A child attached
    // after `trackCaster` — a loaded mesh under a placeholder group — picks up the layer here.
    const excluded: Array<{ object: Object3D; castShadow: boolean }> = [];
    if (this.#casters.size > 0) {
      for (const object of this.#casters.values()) {
        this.#rememberMoverChildren(object);
        object.traverse((child) => {
          if (child.castShadow) {
            excluded.push({ castShadow: child.castShadow, object: child });
            child.castShadow = false;
          }
        });
      }
    }
    // The ones the scan measured moving are out of the cached levels the same way.
    for (const mesh of this.#autoMovers) {
      if (!mesh.castShadow) continue;
      excluded.push({ castShadow: true, object: mesh });
      mesh.castShadow = false;
    }
    const invalidateAll = this.#invalidateAll;
    const invalidatedKeys = this.tracker.consumeInvalidatedKeys();
    const invalidatedLevels = new Set<number>();
    for (const key of invalidatedKeys) invalidatedLevels.add(Number(key.split(":")[0]));
    // The regions `invalidateRegion` was handed, resolved once onto the two axes every level's
    // window is built on. The per-level test below is then four comparisons, not a projection per
    // level per region per frame.
    this.#projectedRegions ??= [];
    const projected = this.#projectedRegions;
    projected.length = 0;
    for (const region of this.#regions) {
      projected.push({
        u: projectBounds(region, this.clipmap.basisU),
        urgent: region.urgent === true,
        v: projectBounds(region, this.clipmap.basisV),
      });
    }
    this.#regions.length = 0;
    const canRender = (frame as { renderer?: unknown }).renderer !== undefined;
    // An engine-chosen delay also waits out the GPU cost of the last redraw, so a redraw that is a
    // visible stall on a weak GPU is spaced to a share of the time instead of queued behind every
    // streamed cell. Measured, so a fast GPU never reaches it; off with adaptive refresh.
    const redrawMs =
      this.#invalidationDelayGiven || !this.options.adaptiveRefresh
        ? undefined
        : shadowRedrawGpuMs((frame as { renderer?: unknown }).renderer);
    const gpuDelay = redrawMs === undefined ? 0 : redrawMs / INVALIDATION_GPU_SHARE / 1000;

    let moved = 0;
    let invalidated = 0;
    let rendered = 0;
    let deferred = 0;
    let waiting = 0;
    // Per level, finest first: which window moved, which invalidation asked, and which of the four
    // took the frame's single render. One object per level per frame, so a harness reading the
    // marker can see *which* level a walk keeps re-rendering.
    const perLevel = this.#perLevel;
    perLevel.length = 0;
    // One level render per frame, finest first: a level render is a whole scene draw, and three of
    // them in one frame is the long task a fly-through cannot absorb. A level the budget skipped
    // holds the map it has and is due again on the next frame.
    let budgetSpent = false;
    try {
      const half = this.clipmap.pagesPerAxis / 2;
      // The window each level's map was actually rendered with. A level that does not get this
      // frame's window keeps this one, and `level.minX/minY` stays put, so it is still "moved" next
      // frame and still due.
      const centreOf = (window: IClipWindow): { cu: number; cv: number } => ({
        cu: (window.minX + half) * window.pageWorldSize,
        cv: (window.minY + half) * window.pageWorldSize,
      });
      const finer: { cu: number; cv: number; half: number }[] = [];
      this.#levels.forEach((level, index) => {
        const window = windows[index];
        if (window === undefined) return;
        const windowMoved =
          directionChanged || window.minX !== level.minX || window.minY !== level.minY;
        const { cu, cv } = centreOf(window);
        // This level's own window against the regions handed to `invalidateRegion`. A window that
        // does not reach a region draws the same shadow either way.
        let regionDirty = false;
        // An ask the node made about a caster it just measured moving, which no delay should hold.
        let urgent = false;
        // The same ask, when a fragment of the old spot is read from *this* level: a finer level's
        // guarded window did not take all of it, so the finer map being redrawn does not clear it.
        let urgentSelected = false;
        for (const region of projected) {
          if (
            region.u.low <= cu + level.extent &&
            region.u.high >= cu - level.extent &&
            region.v.low <= cv + level.extent &&
            region.v.high >= cv - level.extent
          ) {
            regionDirty = true;
            if (region.urgent) {
              urgent = true;
              urgentSelected ||= !finer.some(
                (held) =>
                  region.u.low >= held.cu - held.half &&
                  region.u.high <= held.cu + held.half &&
                  region.v.low >= held.cv - held.half &&
                  region.v.high <= held.cv + held.half,
              );
            }
          }
        }
        finer.push({
          cu,
          cv,
          half: level.extent * (this.options.selectionGuard[index] ?? 0),
        });
        const asked =
          invalidateAll || invalidatedLevels.has(index) || regionDirty || source.shadow.needsUpdate;
        if (windowMoved) moved += 1;
        if (asked) {
          invalidated += 1;
          // An ask that lands on a level already dirty merges into the one waiting out that
          // level's delay instead of queueing a render of its own. This is the counter that says
          // how much a streaming world's once-a-second invalidation actually cost.
          if (level.dirty) this.#coalesced += 1;
          level.dirty = true;
        }
        // A window that moved is never delayed. A dirty level waits `invalidationDelay` after its
        // *own* last render, so a burst spanning that delay is one render and a lone ask is one
        // render, and the level keeps the map and window it has in between — already right for
        // every static caster in it, missing only what streamed in since.
        const delay = Math.max(this.options.invalidationDelay[index] ?? 0, gpuDelay);
        const matured = level.dirty && (urgent || now - level.lastRender >= delay);
        let reason: RenderReason = REASON_NONE;
        if (windowMoved) reason = REASON_MOVE;
        else if (matured) reason = REASON_INVALIDATION;
        else if (level.pending !== REASON_NONE) reason = level.pending;
        else if (level.dirty) waiting += 1;
        const due = canRender && reason !== REASON_NONE;
        // Finest first: the loop walks the levels in that order, so the first due level takes the
        // frame's single render and every other due level is deferred behind it.
        // One exception: a caster that has just been measured moving leaves its old shadow in every
        // map that selects it, and the frame's first mover render is the only one the mover layer
        // can hide it from. A level that reads part of that spot draws on this frame too, so the
        // blob never stands next to the mover's new shadow. It fires once per caster, on the frame
        // the node classifies it, and at most one render per level.
        const grant = due && (!budgetSpent || (urgentSelected && matured));
        if (grant) {
          // A level's first render places its window; only later renders are travel.
          if (Number.isFinite(level.minX)) {
            this.#windowSteps +=
              Math.abs(window.minX - level.minX) + Math.abs(window.minY - level.minY);
          }
          level.minX = window.minX;
          level.minY = window.minY;
          level.centerW = this.clipmap.centerLight.w;
          level.mapped.value = 1;
          level.pending = REASON_NONE;
          level.lastRender = now;
          this.#rendersTotal += 1;
          if (reason === REASON_MOVE) {
            this.#byMove += 1;
            // The render was already going to happen for the window, so the invalidation rode
            // along on it: one ask, one render, and it is counted as absorbed.
            if (level.dirty) this.#coalesced += 1;
          } else {
            this.#byInvalidation += 1;
          }
          // A render of any reason answers whatever asked, so a movement render clears the dirty
          // flag too and the coalesced level is not redrawn a frame later for nothing.
          level.dirty = false;
          rendered += 1;
          budgetSpent = true;
        } else if (due) {
          deferred += 1;
          level.pending = reason;
        } else {
          level.pending = REASON_NONE;
        }
        const stat = {
          deferred: due && !grant ? 1 : 0,
          // Filled by `#probe` on the frame's granted render, from the meshes it read; a level
          // that keeps its map submits no caster draws of its own, so it reports none.
          draws: 0,
          drawsBy: { chunkProxy: 0, cluster: 0, keys: 0, layer0: 0, small: 0, wide: 0 },
          extent: level.extent,
          gateHidden: 0,
          gateScale: level.gateScale,
          invalidated: asked ? 1 : 0,
          moved: windowMoved ? 1 : 0,
          rendered: grant ? 1 : 0,
        };
        perLevel.push(stat);
        // The level camera sits on the window its map was rendered with, deferred or not. A level
        // that has never rendered takes this frame's: it has no map to hold, and `mapped` keeps
        // every fragment out of it until it does.
        const held =
          level.mapped.value === 1 && !grant
            ? { minX: level.minX, minY: level.minY, pageWorldSize: window.pageWorldSize }
            : window;
        const { cu: hu, cv: hv } = centreOf(held as IClipWindow);
        // Hold all three coordinates of the rendered centre: its derived depth and the mover
        // map's shared sampling matrix are relative to this depth, not the followed camera's.
        const centre = this.clipmap.unproject({
          u: hu,
          v: hv,
          w: level.mapped.value === 1 ? level.centerW : this.clipmap.centerLight.w,
        });
        level.offsetU.value = this.clipmap.centerLight.u - hu;
        level.offsetV.value = this.clipmap.centerLight.v - hv;
        level.light.target.position.set(centre.x, centre.y, centre.z);
        level.light.target.updateMatrixWorld(true);
        if (grant) {
          // The two automatic fixes, off one pass over the world this window can see: the depth
          // the level needs to cover what can actually shadow it, and the casters too small for its
          // texels. Both are undone the moment the render is over — by `#restoreHidden`, which the
          // mover maps and the main pass both need back.
          this.#probe(level, centre, index, stat);
          if (this.#autoDepth) this.#deriveDepth(level, centre);
          this.#place(level, centre);
          try {
            // Rendered here, not by flagging `needsUpdate`, so the mover exclusion above brackets it.
            this.#renderLevel(frame, level, false, index);
          } finally {
            this.#restoreHidden();
          }
        } else {
          // A level that keeps its map is placed with the span that map was drawn with, so the next
          // fragment it is sampled through reads the depth it actually holds.
          this.#place(level, centre);
        }
      });
      source.shadow.needsUpdate = false;
      this.#invalidateAll = false;
    } finally {
      for (const { castShadow, object } of excluded) object.castShadow = castShadow;
    }
    // Every level the return redraw asked has rendered the caster, so its mover map draw can go.
    if (
      this.#autoSettling.size > 0 &&
      this.#levels.every((level) => !level.dirty && level.pending === REASON_NONE)
    ) {
      for (const mesh of this.#autoSettling) {
        this.#dropMoverLayer(mesh);
        const state = this.#motionOf.get(mesh);
        if (state !== undefined) state.phase = MOTION_STATIC;
      }
      this.#autoSettling.clear();
    }
    // An untracked node keeps a neutral mover contribution in the shader and does no mover work.
    let moverRenders = 0;
    if (this.#casters.size + this.#autoMovers.size + this.#autoSettling.size > 0) {
      for (const level of this.#levels) {
        // A mover map draws only the tracked casters on layer 29, in a 256² map over the level's own
        // window, so it keeps full detail: every level's world changes were already put back above.
        if (canRender) this.#renderLevel(frame, level, true);
        moverRenders += 1;
      }
    }
    this.#frame += 1;
    this.#rendered += rendered;
    this.#served += this.#levels.length - rendered;
    const total = this.#rendered + this.#served;
    this.#stats = {
      byInvalidation: this.#byInvalidation,
      byMove: this.#byMove,
      cached: this.#levels.length - rendered,
      coalesced: this.#coalesced,
      deferred,
      frame: this.#frame,
      held: waiting,
      invalidated,
      levels: this.#levels.length,
      moved,
      moverRenders,
      movers: this.#casters.size,
      autoMovers: this.#autoMovers.size,
      autoScanMs: this.#autoScanTotalMs / this.#frame,
      autoTransitions: this.#autoTransitions,
      perLevel: this.#perLevel,
      rendered,
      rendersTotal: this.#rendersTotal,
      reuseRatio: total === 0 ? 1 : this.#served / total,
      windowSteps: this.#windowSteps,
    };
    const every = this.options.markerEvery;
    // `?tnShadowStats=1` is the walk's own switch: a 10 s walk is ~600 frames, and a marker every
    // 60 of them is a hundred lines that say which level is re-rendering and why. It prints on top
    // of `markerEvery` rather than instead of it, so a run can turn it on without a rebuild.
    const walk = this.#statsWalkRequested() ? STATS_QUERY_EVERY : 0;
    if (
      (every > 0 && (this.#frame === 1 || this.#frame % every === 0)) ||
      (walk > 0 && this.#frame % walk === 0)
    ) {
      console.info(`${VIRTUAL_SHADOW_MARKER}:${JSON.stringify(this.#stats)}`);
    }
    return undefined;
  }

  /** Whether `?tnShadowStats=1` is on this launch's URL, read once. */
  #statsWalkRequested(): boolean {
    this.#statsRequested ??= /[?&]tnShadowStats=(?!0(?:&|$))(?!false(?:&|$))[^&]/u.test(
      globalThis.location?.search ?? "",
    );
    return this.#statsRequested;
  }

  override dispose(): void {
    this.light.removeEventListener("removed", this.#onLightRemoved);
    this.#regions.length = 0;
    this.#dropCasters();
    for (const level of this.#levels) {
      level.light.removeFromParent();
      level.light.target.removeFromParent();
      for (const entry of [
        { node: level.node, map: level.shadow },
        { node: level.moverNode, map: level.moverShadow },
      ]) {
        const stock = entry.node as typeof entry.node & {
          shadowMap?: RenderTarget | null;
          vsmShadowMapVertical?: RenderTarget | null;
          vsmShadowMapHorizontal?: RenderTarget | null;
        };
        // Stock setup aliases shadow.map to node.shadowMap. The node owns that target and
        // its VSM passes; LightShadow only owns any remaining non-aliased map/mapPass.
        const owned = [stock.shadowMap, stock.vsmShadowMapVertical, stock.vsmShadowMapHorizontal];
        entry.node.dispose();
        if (owned.includes(entry.map.map)) entry.map.map = null;
        if (owned.includes(entry.map.mapPass)) entry.map.mapPass = null;
        entry.map.dispose();
        entry.map.map = null;
        entry.map.mapPass = null;
      }
    }
    this.#levels = [];
    for (const mesh of this.#autoMovers) this.#dropMoverLayer(mesh);
    for (const mesh of this.#autoSettling) this.#dropMoverLayer(mesh);
    this.#autoMovers.clear();
    this.#autoSettling.clear();
    this.#motion.length = 0;
    this.#pinnedRoots.clear();
    for (const id of this.#casters.keys()) this.#restoreMoverChildren(id);
    for (const object of this.#casters.values()) {
      this.tracker.remove(object.uuid);
    }
    this.#casters.clear();
    this.tracker.clear();
    this.#initialised = false;
    super.dispose();
  }
}

const VIRTUAL_SHADOW_STAT_FIELDS = [
  "autoMovers",
  "autoScanMs",
  "autoTransitions",
  "byInvalidation",
  "byMove",
  "cached",
  "coalesced",
  "deferred",
  "frame",
  "held",
  "invalidated",
  "levels",
  "moved",
  "moverRenders",
  "movers",
  "rendered",
  "rendersTotal",
  "reuseRatio",
] as const;

function isVirtualShadowStats(value: unknown): value is IVirtualShadowStats {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const stats = value as Record<string, unknown>;
  if (
    VIRTUAL_SHADOW_STAT_FIELDS.some(
      (field) => typeof stats[field] !== "number" || !Number.isFinite(stats[field]),
    )
  ) {
    return false;
  }
  // Two fields are measurements, not counts: a ratio and a mean in milliseconds.
  const countFields = VIRTUAL_SHADOW_STAT_FIELDS.filter(
    (field) => field !== "reuseRatio" && field !== "autoScanMs",
  );
  if (
    countFields.some((field) => !Number.isInteger(stats[field]) || (stats[field] as number) < 0)
  ) {
    return false;
  }
  const reuseRatio = stats.reuseRatio as number;
  return reuseRatio >= 0 && reuseRatio <= 1 && (stats.autoScanMs as number) >= 0;
}

/**
 * Parse a `TN_VIRTUAL_SHADOW` console line back into its complete stats, or `undefined`.
 *
 * @situation inspect virtual shadow cache and mover counters from a renderer log
 * @constraint non-marker lines and markers with incomplete or non-numeric stats return `undefined`
 * @example
 * const stats = readVirtualShadowMarker(line);
 * if (stats !== undefined) console.log(stats.reuseRatio);
 */
export function readVirtualShadowMarker(line: string): IVirtualShadowStats | undefined {
  if (!line.startsWith(`${VIRTUAL_SHADOW_MARKER}:`)) return undefined;
  try {
    const value: unknown = JSON.parse(line.slice(VIRTUAL_SHADOW_MARKER.length + 1));
    return isVirtualShadowStats(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
