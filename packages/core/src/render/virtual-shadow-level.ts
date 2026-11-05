/**
 * A level's record, its placeholder light and the stock shadow node it draws through: the settings
 * mirrored into that node, and the registration that keeps its depth texture alive.
 */
import { type DirectionalLight, Object3D, type RenderTarget } from "three";
import { renderGroup, type shadow } from "three/tsl";
import type { NodeBuilder, UniformNode } from "three/webgpu";
import type { IPageRect } from "./virtual-shadow-pages.js";
import type { IPartialPass } from "./virtual-shadow-partial.js";

/** One clipmap axis' view of a world region, as the interval it covers in light space. */
export type ILightAxisRange = { low: number; high: number };

/**
 * Why a level owes a render: not at all, a window that moved, or an invalidation that asked and
 * waited out its delay. The render it finally takes is counted against this, so a level the frame's
 * single budget passed over is not counted twice.
 */
export type RenderReason = 0 | 1 | 2;
export const REASON_NONE: RenderReason = 0;
export const REASON_MOVE: RenderReason = 1;
export const REASON_INVALIDATION: RenderReason = 2;
/** A placeholder light per level: the stock shadow node reads position and target from it. */
export class LevelLight extends Object3D {
  readonly target = new Object3D();
  shadow: DirectionalLight["shadow"];
  override castShadow = true;

  constructor(shadow: DirectionalLight["shadow"]) {
    super();
    this.shadow = shadow;
  }
}

export interface ILevel {
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
   * The pages casters streamed into since this level's last render, in the clipmap's absolute page
   * coordinates, or undefined while none did. An added caster only brings depth closer, so these
   * pages need no clear. Meaningless while {@link dirtyAll} is set.
   */
  dirtyAdmit: IPageRect | undefined;
  /**
   * The pages any other ask touched: a removed caster, a flag change, the tracker's pages. The old
   * depth in them can be wrong, so they are put back to the far plane before they are redrawn.
   */
  dirtyEvict: IPageRect | undefined;
  /** An ask named no pages, or none inside the window, so the whole level is dirty. */
  dirtyAll: boolean;
  /** The rectangle this level is rendering now, set only around a partial redraw. */
  pass: IPartialPass | undefined;
  /** The caster interval along the light, from the centre, that the derived depth was drawn for. */
  drawnSpan: ILightAxisRange;
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
export type ShadowWithFilter = DirectionalLight["shadow"] & { filterNode?: unknown };
/** Keep each stock node's source-owned settings aligned with the public light shadow. */
export function syncShadowSettings(
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

export function syncLevelShadowSettings(
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
export function rendered<T>(node: T): T {
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
export function registeredOnCreate<T>(node: T): T {
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
