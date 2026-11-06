/**
 * What a {@link VirtualShadowNode} is asked for, what it reports, and the default of every knob.
 *
 * Types and defaults only: the node owns the mechanism these describe.
 */

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
  /**
   * The widest step between two levels, default 2: where `clipExtents` jump further, levels are
   * inserted at even ratios, as UE 5.8.3 doubles every clipmap level (`GetLevelRadius`,
   * Engine/Source/Runtime/Renderer/Private/VirtualShadowMaps/VirtualShadowMapClipmap.cpp:175-179). A
   * receiver crossing a level edge then changes texel size by at most this ratio: across `[24, 320]`
   * the texel grew 13 times at once and every tree on the edge flipped from self-shadowed to flat
   * lit. Per-level lists (`mapSize`, `refreshStep`, `selectionGuard`, `invalidationDelay`) give an
   * inserted level the value of the authored level it leads into. `Infinity` keeps the authored
   * levels as they are, and `TN_VIRTUAL_SHADOW_OVERRIDE` reports it.
   */
  readonly maxLevelRatio?: number;
  /**
   * Resolution bias in stops, default 0. Mirrors Unreal's
   * `r.Shadow.Virtual.ResolutionLodBiasDirectional`; a quality tier sets it. With the default map
   * sizes each stop doubles every level's texel: `-1` halves it (twice the resolution), `-1.5` is
   * 2.83 times finer, a positive bias coarsens it. With an authored `mapSize` the finest window
   * scales by `2 ** bias` instead and every coarser level keeps its extent; a bias that would push
   * that window past the next level throws.
   */
  readonly resolutionLodBiasDirectional?: number;
  /**
   * Texels per level edge: one number for every level, or one per level, finest first. Default:
   * Unreal's clipmap rule, measured on the camera and viewport that first read the shadow, so a
   * receiver's texel is at most `2^(1 + bias)` of its own screen pixels (`clipmapMapSizes`). Set it to
   * hold fixed sizes.
   */
  readonly mapSize?: number | readonly number[];
  /**
   * The page budget of the default map sizes, in 128² pages over all levels, default 4096 (Unreal's
   * `r.Shadow.Virtual.MaxPhysicalPages` at Epic). Sizes over it raise the bias until they fit.
   */
  readonly maxPhysicalPages?: number;
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
  /**
   * The smallest ratio of a level's light-space height to its width, `(0, 1]`, default 1 (square levels).
   * A low sun stretches a shadow texel along the floor by `1 / sin(elevation)`. A value under 1 shrinks
   * the height to `sin(elevation)` times the width, never under this value, so a texel covers the same
   * floor area at any sun height. The costs: a wall taller than a level's height is read from a wider
   * level, a level centred on the eye holds the floor only about `eye height / tan(elevation)` from the
   * camera, and a wide filter disc (a source angle near 0.7 degrees) crosses the level's top and bottom
   * edge and leaves a lit patch in a thin shadow (PRD-634, sun 4 ramp), so it is an opt-in.
   */
  readonly minWindowAspect?: number;
  /** Measure receiver-plane slope across each level's texel footprint to prevent coarse acne.
   * Default true; false preserves only the authored bias. Custom filterNode owns its footprint.
   */
  readonly receiverPlaneBias?: boolean;
  /**
   * Draw registered AutoLOD chains with a coarser rung past the finest level, default true. A level
   * takes the coarsest rung whose geometric error is within one of its texels, and never a rung
   * finer than the main pass shows; where no rung is that accurate the caster keeps its geometry.
   * Alpha-tested and transparent casters keep casting on every level that resolves their bounds;
   * dropping their whole shadow at the fine window edge loses canopy and fences.
   * Geometry swaps are restored before the next level, mover map and main pass.
   */
  readonly shadowLodBias?: boolean;
  /**
   * The most error, in texels of a level, that a coarser rung may have on that level, default 1.
   * A rung within a texel is as good as the full mesh at that resolution; a larger budget draws
   * fewer triangles and shows facets on a shadow's edge, and `Infinity` draws the coarsest rung on
   * every level past the finest. Read only with `shadowLodBias`.
   */
  readonly shadowLodTexels?: number;
  /**
   * Redraw only the pages an invalidation dirtied, default true. A level whose window did not move
   * and whose asks named under half its pages renders those rectangles alone: pages casters were
   * removed from are put back to the far plane first, pages casters streamed into are just drawn.
   * `false` renders the whole level for every invalidation, as before. A VSM shadow map always
   * renders whole, because its blur pass reads the entire map.
   */
  readonly partialRedraw?: boolean;
  /**
   * Quiet frames an automatically detected mover must exceed before it goes back into the cached
   * levels, default 100 (Unreal's `FramesStaticThreshold`: it settles on quiet frame 101). A caster whose world matrix, instance matrix or
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
  /** Of the renders taken for an invalidation (`byInvalidation`), those whose dirty set held only streamed-in casters. */
  readonly byAdmission: number;
  /** Of the renders taken for an invalidation, those whose dirty set held anything else: a removed caster, a region-less ask, a caster flag change. */
  readonly byEviction: number;
  /** Pages the dirty set held at each render, summed over the node's lifetime. A window move counts the whole level. */
  readonly pagesDirty: number;
  /** Pages each render actually drew, summed over the node's lifetime. Equals pagesDirty once a partial redraw exists. */
  readonly pagesRedrawn: number;
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
export interface IVirtualShadowDrawTally {
  cluster: number;
  wide: number;
  small: number;
  chunkProxy: number;
  layer0: number;
  keys: number;
}

/** Square levels. A fit to the ground (`0.25`, a 14.5 degree sun is where it ends) is the named override. */
export const DEFAULT_MIN_WINDOW_ASPECT = 1;
export const DEFAULT_MARKER_EVERY = 300;
/**
 * The invalidation delay of the *finest* level, in seconds; every other level's is this times its
 * extent over the finest one. A burst of streamed invalidations is paid as one render, and the
 * level that pays it is the one whose window is widest.
 */
export const BASE_INVALIDATION_DELAY = 0.25;
export const DEFAULT_MIN_CASTER_TEXELS = 1.5;
/** Unreal's `r.Shadow.Virtual.Cache.FramesStaticThreshold`: quiet frames before a mover is static. */
export const DEFAULT_STATIC_AFTER_FRAMES = 100;
/**
 * The share of the display period a level's render may cost before adaptive refresh widens its
 * trail: two frames in five, 6.7 ms of a 60 Hz frame. A draw that big is worth a whole frame of its
 * own, and a share rather than a millisecond count is what makes the same number mean the same thing
 * on a 120 Hz panel.
 */
export const DEFAULT_EXPENSIVE_REFRESH_SHARE = 0.4;

/** The per-level entry of a scalar-or-array option, the last entry standing in for the rest. */
export function at(values: readonly number[], level: number): number {
  return values[Math.min(level, values.length - 1)] as number;
}
