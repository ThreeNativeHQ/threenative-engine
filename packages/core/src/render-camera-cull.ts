import { type Camera, Frustum, Matrix4, type Object3D, Ray, Sphere, Vector3 } from "three";

import { isRenderable } from "./projection-plan.js";

/**
 * Do not submit what the render camera cannot resolve.
 *
 * Every 3D game eventually pays for the same mistake: a distant roster, a far hull, a prop that
 * projects to a fraction of a pixel still costs a full draw submission — measured at roughly 14 µs
 * per draw on the GPU-free CPU path — while contributing nothing a player can see. The engine
 * knows the render camera, the object's world bounds and the drawing-buffer height, so it can take
 * that draw without the game discovering the rule by hand.
 *
 * The rule is deliberately narrow, and it never acts on a bound it cannot trust. An object is
 * skipped only when its **world bounding sphere** projects to fewer pixels than
 * {@link DEFAULT_MINIMUM_PROJECTED_PIXELS} *in the camera about to render it*, and only when
 * nothing offers a reason to keep it: {@link alwaysRender}, a shadow caster, a camera-attached
 * object, an object that already set `frustumCulled = false`, or a bound that is absent,
 * degenerate (a zero or non-finite radius is not a size) or stale (the position buffer was
 * rewritten after the sphere was computed — a changed buffer is recomputed, never trusted). The
 * one flag it writes is `Object3D.visible`,
 * which three reads after batch grouping; `castShadow`, `layers` and `frustumCulled` are never
 * touched, because flipping those per frame churns the projection's batch key and can make the
 * whole scene decline.
 *
 * The default is conservative on purpose. An object whose projected diameter is below one pixel
 * cannot cover a whole pixel of the frame; **0.5 px** is half of that bound and four times more
 * conservative than the 2 px a shipped game tuned by a pixel-diff ladder. A game that measured its
 * own scenery and wants more names a larger `renderer.minimumProjectedPixels`.
 */

/**
 * The projected diameter, in raster pixels, below which an object is not submitted.
 *
 * Half a pixel is the conservative rung: it removes only objects that cannot light a full pixel,
 * rather than the objects a 2 px ladder removed. A game that wants the tuned cut sets
 * `renderer.minimumProjectedPixels` on the same object it would have hand-rolled.
 */
export const DEFAULT_MINIMUM_PROJECTED_PIXELS = 0.5;

/** The `userData` key {@link alwaysRender} writes, named so a report can tell what was overridden. */
export const ALWAYS_RENDER_KEY = "alwaysRender";

/** A sphere-like bound, structural so an `InstancedMesh`'s own bound and a geometry's both fit. */
interface IBoundingSphereLike {
  readonly center: Vector3;
  readonly radius: number;
}

interface ICullable {
  boundingSphere?: IBoundingSphereLike | null;
  geometry?: {
    boundingSphere?: IBoundingSphereLike | null;
    computeBoundingSphere?: () => void;
    /** Three bumps `version` whenever the buffer is re-uploaded; it is how a stale bound is told. */
    attributes?: { position?: { version?: number } };
  };
}

/** Sentinel: the position buffer is rewritten so often that its bound cannot be trusted cheaply. */
const DYNAMIC_BOUNDS = Symbol("render-camera-cull-dynamic-bounds");

/** What the gate remembers about a geometry's position buffer between consults. */
interface IPositionVersion {
  version: number;
  frame: number;
  /** True when the previous consult also saw a change, so this one is the second in a row. */
  changedLastConsult: boolean;
  /** True when a rewrite was exempted without a rescan, so the cached sphere is stale. */
  stale: boolean;
}

/** A sphere nearer than this to the camera would divide by zero; treat it as this far away. */
const MIN_DISTANCE = 1e-4;

/**
 * Internal mirror metadata: a projection stand-in or a skinned batch observes the authored rigs it
 * draws. A JS map, not `userData`: on the web engine every `userData` read crosses into Wasm, and the
 * camera pass asked every object in the scene for it.
 */
export const animationRateSources = new WeakMap<Object3D, ReadonlyMap<Object3D, unknown>>();

/** Internal observations shared with AnimationPlayer, owned by the root rather than the game. */
export interface IAnimationRateState {
  rate: number;
  /** Cadence actually selected by the player on its last update; absent metadata stays stock. */
  effectiveRate?: number;
  frame: number;
  source: RenderCameraCull | undefined;
  evaluated: boolean;
  evaluation: number;
  /** Set by the player from its `gpuPose` option; the skinned batch evaluates no other rig on the GPU. */
  gpuPoseEnabled?: boolean;
  /** Set by the skinned batch while the GPU evaluates this rig's pose from keyframes and time. */
  gpuPose?: boolean;
  /** Set by the player: brings the CPU bones to the current playhead now. */
  syncBones?: () => void;
}
export const animationRateStates = new WeakMap<Object3D, IAnimationRateState>();
/** The roots that may hold a rate state, so the camera pass walks the rigs instead of the scene. */
const animationRateRoots = new Set<WeakRef<Object3D>>();
const animationRateRootRefs = new WeakMap<Object3D, WeakRef<Object3D>>();
/** The stand-ins named in {@link animationRateSources}, so the pass can reach them without a scene walk. */
const animationRateCarriers = new Set<WeakRef<Object3D>>();

/** A projection stand-in or skinned batch names the rigs it draws (see {@link animationRateSources}). */
export function observeAnimationRates(
  carrier: Object3D,
  sources: ReadonlyMap<Object3D, unknown>,
): void {
  if (!animationRateSources.has(carrier)) animationRateCarriers.add(new WeakRef(carrier));
  animationRateSources.set(carrier, sources);
}

/** AnimationPlayer's registration: the state the camera pass writes, and the root it is found on. */
export function trackAnimationRate(root: Object3D, state: IAnimationRateState): void {
  animationRateStates.set(root, state);
  // One ref per root: a respawn's new player on the same root must not add a second walk of it.
  let ref = animationRateRootRefs.get(root);
  if (ref === undefined) {
    ref = new WeakRef(root);
    animationRateRootRefs.set(root, ref);
  }
  animationRateRoots.add(ref);
}

export interface IRenderCameraCullOptions {
  /**
   * Projected diameter in pixels below which an object is skipped, or `false` to leave every
   * object drawn. Defaults to {@link DEFAULT_MINIMUM_PROJECTED_PIXELS}.
   */
  readonly minimumPixels?: number | false;
}

/**
 * What the gate did on the last frame, in the shape a frame-budget window reports.
 *
 * `enabled: false` means the game declined the gate, and the counts are still measured — turning
 * the convention off must not turn its measurement off. Every exemption is named separately so an
 * override is visible rather than silent.
 */
export interface IRenderCameraCullReport {
  readonly schemaVersion: 1;
  readonly enabled: boolean;
  /**
   * False when the camera has no perspective distance term (orthographic) or no viewport to
   * project into; the gate then leaves the whole scene drawn rather than guessing.
   */
  readonly cameraResolved: boolean;
  readonly thresholdPixels: number;
  /** Renderables walked this frame. */
  readonly considered: number;
  /** Renderables hidden by this gate this frame. */
  readonly culled: number;
  readonly exemptCameraAttached: number;
  readonly exemptMarked: number;
  readonly exemptShadowCasters: number;
  readonly exemptWithoutBounds: number;
  /**
   * Objects whose position buffer is rewritten every frame, so the gate cannot trust a bound it
   * cannot afford to rescan. Kept drawn, like `frustumCulled = false`.
   */
  readonly exemptDynamicBounds: number;
  /** Objects that already set `frustumCulled = false`, and so never had trustworthy bounds. */
  readonly exemptFrustumCulled: number;
}

/**
 * Keep an object drawn regardless of how small the render camera resolves it.
 *
 * The named per-object override for the projected-size gate, which is on by default. Mark the
 * player's own cockpit, a nameplate, a quest marker, or anything a game never wants to pop out.
 * `alwaysRender(object, false)` removes the marker. The count of marked objects is reported beside
 * the cull, so an override is stated rather than hidden.
 *
 * @situation keep a small object drawn when the engine would skip it as too far to resolve
 * @situation stop my cockpit, marker or player model popping out at distance
 * @situation a tiny object disappeared at range and I need it always visible
 * @constraint the marker is per object and survives scene rebuilds only as long as the object does
 * @constraint disabling the gate (`renderer.minimumProjectedPixels: false`) keeps its measurement on
 * @example alwaysRender(ctx.camera.children[0]); // a camera-attached cockpit stays drawn
 */
export function alwaysRender(object: Object3D, enabled = true): void {
  object.userData[ALWAYS_RENDER_KEY] = enabled;
  // The native engine runs this cull itself and cannot read userData: it reads its own marker.
  if (ENGINE_MARKER in object)
    // quality-allow: the native engine player reads __alwaysRender directly off the object; not in Three.Object3D types.
    (object as unknown as Record<string, boolean>)[ENGINE_MARKER] = enabled;
}

/** The native engine's alwaysRender marker, mirrored by {@link alwaysRender}. */
const ENGINE_MARKER = "__alwaysRender";

/**
 * A scene root the native engine walks itself (scene/projected_cull.h): the same rule in one call
 * instead of a walk that reads every object's bounds, matrices and flags across the boundary.
 * Optional: a root without these members takes the JS walk below, unchanged.
 */
interface IEngineCullRoot {
  __cullProjected(
    camera: Camera,
    cameraResolved: boolean,
    scale: number,
    minimumPixels: number,
    enabled: boolean,
  ): readonly number[];
  __restoreCull(): void;
}

/**
 * The native engine counts every add, remove, attach and destroy in the process (scene/object3d.h).
 * While it holds still, no subtree changed, so a walk that only finds who is under whom can be kept.
 * Plain three has no such count, and its walks run every frame as before.
 */
function hierarchyRevision(object: Object3D): number | undefined {
  const revision = (object as { __hierarchyRevision?: unknown }).__hierarchyRevision;
  return typeof revision === "number" ? revision : undefined;
}

/**
 * Counts one costly step by name in `globalThis.__tnEngineCost`, the bag a playtest reads per frame
 * (three-native reports it as TN_ENGINE_COST), so a kit that brings back a per-frame walk fails its bound.
 */
function countEngineCost(name: string): void {
  const host = globalThis as { __tnEngineCost?: Record<string, number> };
  host.__tnEngineCost ??= {};
  host.__tnEngineCost[name] = (host.__tnEngineCost[name] ?? 0) + 1;
}

/** The native engine's one-call answer to "is it and every parent visible" (bindings_scene.cpp). */
function visibleInWorld(object: unknown): boolean | undefined {
  const host = (object as { __tnVisibleInWorld?: () => boolean }).__tnVisibleInWorld;
  return typeof host === "function" ? host.call(object) : undefined;
}

function engineCullRoot(root: unknown): IEngineCullRoot | undefined {
  const candidate = root as Partial<IEngineCullRoot> | null;
  return typeof candidate?.__cullProjected === "function" &&
    typeof candidate.__restoreCull === "function"
    ? (candidate as IEngineCullRoot)
    : undefined;
}

/**
 * The per-frame projected-size gate. One instance lives for the life of a game.
 *
 * `apply` hides this frame's sub-threshold objects and `restore` puts them back once the renderer
 * has drawn, so the authored scene is exactly as the game left it between frames. Neither call
 * allocates per object: the traversal callback, the scratch vector and the hidden-object list are
 * all owned by the instance.
 */
export class RenderCameraCull {
  #animationFrame = 0;
  #animationPrepared = false;
  readonly #animationSphere = new Sphere();
  readonly #enabled: boolean;
  readonly #minimumPixels: number;
  readonly #center = new Vector3();
  readonly #frustum = new Frustum();
  readonly #projectionScreen = new Matrix4();
  readonly #hidden: Object3D[] = [];
  readonly #animationVisitor: (object: Object3D) => void;
  readonly #visitor: (object: Object3D) => void;
  /**
   * Every object under a live rate root this frame, with the states of the roots above it: only
   * these can change a rate, and their states need no walk up the parents.
   */
  readonly #animated = new Map<Object3D, readonly IAnimationRateState[]>();
  #collecting: readonly IAnimationRateState[] = [];
  /** Each root, its state and the engine's hierarchy count read off it, as {@link #animated} was built. */
  readonly #animatedFrom: (Object3D | IAnimationRateState | number | undefined)[] = [];
  /** The renderables under each rate root, in walk order, from the same walk as {@link #animated}. */
  readonly #rigParts = new Map<Object3D, Object3D[]>();
  #collectingParts: Object3D[] = [];
  readonly #collectAnimated: (object: Object3D) => void;
  /** The camera's descendants this frame, so camera attachment needs no walk up the parents. */
  readonly #cameraParts = new Set<Object3D>();
  readonly #collectCameraPart: (object: Object3D) => void;
  #cameraPartsOf: Camera | undefined;
  #cameraPartsRevision: number | undefined;
  /** Last position-buffer version seen per geometry, so a rewritten dynamic bound is recomputed. */
  readonly #positionVersions = new WeakMap<object, IPositionVersion>();
  #hiddenCount = 0;
  #camera: Camera | undefined;
  #cameraX = 0;
  #cameraY = 0;
  #cameraZ = 0;
  #scale = 0;
  #cameraResolved = true;
  readonly #animationRay = new Ray();
  /** Per rig: [frame, x, y, z, radius] of the union of its parts' spheres so far this frame. */
  readonly #rigSpheres = new WeakMap<IAnimationRateState, Float64Array>();
  #considered = 0;
  #culled = 0;
  #exemptCameraAttached = 0;
  #exemptMarked = 0;
  #exemptShadowCasters = 0;
  #exemptWithoutBounds = 0;
  #exemptDynamicBounds = 0;
  #exemptFrustumCulled = 0;
  /** The engine root the last apply() culled through, restored by restore(). */
  #engineRoot: IEngineCullRoot | undefined;

  constructor(options: IRenderCameraCullOptions = {}) {
    const requested = options.minimumPixels ?? DEFAULT_MINIMUM_PROJECTED_PIXELS;
    if (requested !== false && (!Number.isFinite(requested) || requested <= 0)) {
      throw new Error(
        `renderer.minimumProjectedPixels must be false or a finite number greater than zero, received ${String(requested)}.`,
      );
    }
    this.#enabled = requested !== false;
    this.#minimumPixels = requested === false ? DEFAULT_MINIMUM_PROJECTED_PIXELS : requested;
    this.#animationVisitor = (object) => this.#visitAnimation(object);
    this.#visitor = (object) => this.#visit(object);
    this.#collectAnimated = (object) => {
      if (isRenderable(object)) this.#collectingParts.push(object);
      const outer = this.#animated.get(object);
      // A rig nested in another rig answers to both roots.
      this.#animated.set(
        object,
        outer === undefined ? this.#collecting : [...outer, ...this.#collecting],
      );
    };
    this.#collectCameraPart = (object) => this.#cameraParts.add(object);
  }

  /**
   * Rebuilds {@link #animated} from the live rate roots; false when no rig can take a rate. The
   * roots and states are JS objects; only the walk under them crosses into the engine, so it is
   * kept while the same roots hold the same states and the engine's hierarchy has not moved.
   */
  #prepareAnimated(): boolean {
    let same = true;
    let at = 0;
    for (const ref of animationRateRoots) {
      const root = ref.deref();
      const state = root === undefined ? undefined : animationRateStates.get(root);
      if (root === undefined || state === undefined) {
        animationRateRoots.delete(ref);
        continue;
      }
      if (same) {
        const revision = hierarchyRevision(root);
        same =
          revision !== undefined &&
          this.#animatedFrom[at] === root &&
          this.#animatedFrom[at + 1] === state &&
          this.#animatedFrom[at + 2] === revision;
      }
      at += 3;
    }
    if (same && at === this.#animatedFrom.length) return this.#animated.size > 0;
    countEngineCost("cullRigRebuilds");
    this.#animated.clear();
    this.#animatedFrom.length = 0;
    this.#rigParts.clear();
    for (const ref of animationRateRoots) {
      const root = ref.deref() as Object3D;
      const state = animationRateStates.get(root) as IAnimationRateState;
      this.#animatedFrom.push(root, state, hierarchyRevision(root));
      this.#collecting = [state];
      this.#collectingParts = [];
      root.traverse(this.#collectAnimated);
      this.#rigParts.set(root, this.#collectingParts);
    }
    return this.#animated.size > 0;
  }

  get report(): IRenderCameraCullReport {
    return {
      schemaVersion: 1,
      enabled: this.#enabled,
      cameraResolved: this.#cameraResolved,
      thresholdPixels: this.#minimumPixels,
      considered: this.#considered,
      culled: this.#culled,
      exemptCameraAttached: this.#exemptCameraAttached,
      exemptMarked: this.#exemptMarked,
      exemptShadowCasters: this.#exemptShadowCasters,
      exemptWithoutBounds: this.#exemptWithoutBounds,
      exemptDynamicBounds: this.#exemptDynamicBounds,
      exemptFrustumCulled: this.#exemptFrustumCulled,
    };
  }

  get animationFrame(): number {
    return this.#animationFrame;
  }

  /**
   * Publishes camera-driven animation metadata without changing draw visibility.
   *
   * The game calls this before scene `beforeRender` callbacks and projection packing, then calls
   * {@link apply} after those phases for the one visibility cull that feeds the draw.
   */
  prepareAnimation(
    root: { traverseVisible(callback: (object: Object3D) => void): void },
    camera: Camera,
    viewportHeight: number,
  ): void {
    this.restore();
    this.#animationFrame += 1;
    this.#animationPrepared = true;
    this.#prepareCamera(camera, viewportHeight);
    if (!this.#prepareAnimated()) return;
    // Start at each rig and each stand-in that observes one, never at the scene: the walk then visits
    // the same objects a scene walk would have acted on, and nothing else.
    const rootShown = visibleInWorld(root) === true;
    for (const ref of animationRateRoots) {
      const rig = ref.deref();
      if (rig !== undefined && this.#reaches(rig, root)) this.#visitRig(rig, rootShown);
    }
    for (const ref of animationRateCarriers) {
      const carrier = ref.deref();
      const sources = carrier === undefined ? undefined : animationRateSources.get(carrier);
      if (carrier === undefined || sources === undefined) {
        animationRateCarriers.delete(ref);
        continue;
      }
      // A carrier inside a rig is visited by that rig's walk.
      if (this.#animated.has(carrier)) continue;
      let observes = false;
      for (const source of sources.keys()) observes ||= this.#animated.has(source);
      if (observes && this.#reaches(carrier, root)) carrier.traverseVisible(this.#animationVisitor);
    }
  }

  /**
   * The rig's visible walk, as `traverseVisible` would make it. Only its renderables act, so on the
   * native engine, with the walk's root shown, each kept part asks once whether it is shown, rather
   * than the walk wrapping every bone across the boundary. A rig that reaches a shown root is itself
   * shown, so a part shown in the world is exactly a part its rig's walk reaches.
   */
  #visitRig(rig: Object3D, rootShown: boolean): void {
    const parts = rootShown ? this.#rigParts.get(rig) : undefined;
    if (
      parts === undefined ||
      typeof (rig as { __tnVisibleInWorld?: unknown }).__tnVisibleInWorld !== "function"
    ) {
      countEngineCost("cullRigWalks");
      rig.traverseVisible(this.#animationVisitor);
      return;
    }
    for (const part of parts) if (visibleInWorld(part) === true) this.#visitAnimation(part);
  }

  /**
   * True when a scene walk from `root` would visit `object`: it and every parent up to `root` are
   * visible. A rate root above it answers false, since that root's own walk covers it.
   */
  #reaches(object: Object3D, root: unknown): boolean {
    if (!object.visible) return false;
    for (let node = object.parent; node !== null; node = node.parent) {
      if (animationRateStates.has(node)) return false;
      if (!node.visible) return false;
      if (node === root) return true;
    }
    return object === root;
  }

  /**
   * Hides every renderable under `root` that this camera resolves to fewer than the threshold,
   * then calls `restore` implicitly on the next call. Call {@link restore} after the render.
   *
   * The walk visits only visible subtrees — a game-hidden LOD level or stand-in is already not
   * submitted, so descending into it would waste the walk and could hide/restore a node the game
   * deliberately left out.
   */
  apply(
    root: { traverseVisible(callback: (object: Object3D) => void): void },
    camera: Camera,
    viewportHeight: number,
  ): void {
    this.restore();
    if (!this.#animationPrepared) {
      this.#animationFrame += 1;
      this.#prepareAnimated();
    }
    this.#animationPrepared = false;
    this.#considered = 0;
    this.#culled = 0;
    this.#exemptCameraAttached = 0;
    this.#exemptMarked = 0;
    this.#exemptShadowCasters = 0;
    this.#exemptWithoutBounds = 0;
    this.#exemptDynamicBounds = 0;
    this.#exemptFrustumCulled = 0;
    if (this.#prepareCamera(camera, viewportHeight, root)) return;
    root.traverseVisible(this.#visitor);
  }

  /** Undoes every hide this gate made, leaving the authored scene as the game left it. */
  restore(): void {
    this.#engineRoot?.__restoreCull();
    this.#engineRoot = undefined;
    for (let index = 0; index < this.#hiddenCount; index += 1) {
      (this.#hidden[index] as Object3D).visible = true;
    }
    this.#hiddenCount = 0;
  }

  dispose(): void {
    this.restore();
    this.#animationPrepared = false;
    this.#camera = undefined;
    this.#animated.clear();
    this.#animatedFrom.length = 0;
    this.#rigParts.clear();
    this.#cameraParts.clear();
    this.#cameraPartsOf = undefined;
  }

  /** Resolves the camera; returns true when the engine walked `root` itself and answered the counters. */
  #prepareCamera(camera: Camera, viewportHeight: number, root?: unknown): boolean {
    this.#cameraResolved = true;
    this.#camera = undefined;
    // The walk runs whether or not the gate is enabled: turning the convention off must not turn
    // its measurement off, so a disabled gate still reports what it considered and would have
    // skipped. Only the hide below is gated by `#enabled`.
    const perspective = camera as Camera & { isPerspectiveCamera?: boolean; fov?: number };
    const engine = root === undefined ? undefined : engineCullRoot(root);
    if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) {
      this.#cameraResolved = false;
    } else if (
      perspective.isPerspectiveCamera !== true ||
      typeof perspective.fov !== "number" ||
      !(perspective.fov > 0 && perspective.fov < 180)
    ) {
      // An orthographic camera has no distance term, so a projected size has no meaning. Leave the
      // whole scene drawn rather than guessing; a game that wants the cut there names a threshold
      // on the camera itself.
      this.#cameraResolved = false;
    } else {
      if (camera.matrixWorldAutoUpdate === true) camera.updateMatrixWorld();
      this.#camera = camera;
      if (engine === undefined) {
        // The engine finds what hangs from the camera itself; this set serves only the JS walk.
        this.#findCameraParts(camera);
      }
      this.#scale = viewportHeight / (2 * Math.tan((perspective.fov * Math.PI) / 360));
    }
    if (engine !== undefined) {
      // The engine walks with its own camera position and frustum; it answers the eight counters.
      const counts = engine.__cullProjected(
        camera,
        this.#cameraResolved,
        this.#scale,
        this.#minimumPixels,
        this.#enabled,
      );
      // Indexed, not destructured: a destructuring assignment runs the iterator protocol.
      this.#considered = counts[0] as number;
      this.#culled = counts[1] as number;
      this.#exemptCameraAttached = counts[2] as number;
      this.#exemptMarked = counts[3] as number;
      this.#exemptShadowCasters = counts[4] as number;
      this.#exemptWithoutBounds = counts[5] as number;
      this.#exemptDynamicBounds = counts[6] as number;
      this.#exemptFrustumCulled = counts[7] as number;
      this.#engineRoot = engine;
      return true;
    }
    if (this.#camera !== undefined) {
      const elements = camera.matrixWorld.elements;
      this.#cameraX = elements[12] as number;
      this.#cameraY = elements[13] as number;
      this.#cameraZ = elements[14] as number;
      this.#animationRay.origin.set(this.#cameraX, this.#cameraY, this.#cameraZ);
      this.#animationRay.direction
        .set(-(elements[8] as number), -(elements[9] as number), -(elements[10] as number))
        .normalize();
      // The main frustum is what tells an off-camera shadow caster from a visible but unresolvable
      // one. Perspective cameras keep `matrixWorldInverse` in step inside `updateMatrixWorld`.
      this.#projectionScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      this.#frustum.setFromProjectionMatrix(this.#projectionScreen);
    }
    return false;
  }

  #visitAnimation(object: Object3D): void {
    // Only a rig's own parts and the stand-ins that observe rigs can change a rate; everything else
    // is left unread (each read is an engine crossing on the web engine).
    const animated = this.#animated.has(object);
    if (!animated && !animationRateSources.has(object)) return;
    if (!isRenderable(object)) return;
    this.#observeAnimationSources(object);
    if (!animated) return;
    if (this.#isCameraAttached(object)) {
      this.#observeAnimation(object, undefined);
      return;
    }
    if (object.userData[ALWAYS_RENDER_KEY] === true) {
      this.#observeAnimation(object, undefined);
      return;
    }
    if (object.frustumCulled === false) {
      this.#observeAnimation(object, undefined);
      return;
    }
    this.#observeAnimation(object, boundsOf(object, this.#positionVersions, this.#animationFrame));
  }

  #visit(object: Object3D): void {
    if (!isRenderable(object)) return;
    this.#considered += 1;
    this.#observeAnimationSources(object);
    if (this.#isCameraAttached(object)) {
      this.#observeAnimation(object, undefined);
      this.#exemptCameraAttached += 1;
      return;
    }
    if (object.userData[ALWAYS_RENDER_KEY] === true) {
      this.#observeAnimation(object, undefined);
      this.#exemptMarked += 1;
      return;
    }
    // `frustumCulled = false` is the game's standing instruction that its bounds cannot be
    // trusted — the pooled tracer, particle and whitewater batches set it for exactly that
    // reason. A second, stricter cull does not get to override the opt-out.
    if (object.frustumCulled === false) {
      this.#observeAnimation(object, undefined);
      this.#exemptFrustumCulled += 1;
      return;
    }
    // A shadow can be cast from far outside the main view, so a caster off the main camera is
    // never dropped on the main camera's projection alone. This is the most-permissive
    // multi-camera rule the engine can apply: the per-light shadow cameras are three's own and not
    // cheaply enumerable here, so where the gate cannot know, it keeps the caster. A caster the
    // main camera *can* see is ordinary geometry — its shadow is in view with it, and a
    // sub-resolution object casts a sub-resolution shadow.
    const sphere = boundsOf(object, this.#positionVersions, this.#animationFrame);
    this.#observeAnimation(object, sphere);
    // A buffer rewritten every frame has extents the gate cannot know without a full scan each
    // frame, which costs more than the draw it might remove. Keep it drawn, like an opt-out.
    if (sphere === DYNAMIC_BOUNDS) {
      this.#exemptDynamicBounds += 1;
      return;
    }
    // A zero or non-finite radius is not a size: a point has no projected diameter, and a pooled
    // buffer whose first compute saw it empty caches exactly that. Read it as "no usable bounds"
    // and keep the object, never as "infinitely small" and delete it.
    if (sphere === undefined || !(Number.isFinite(sphere.radius) && sphere.radius > 0)) {
      this.#exemptWithoutBounds += 1;
      return;
    }
    this.#center.copy(sphere.center).applyMatrix4(object.matrixWorld);
    if (
      object.castShadow === true &&
      (!this.#cameraResolved || !this.#frustum.containsPoint(this.#center))
    ) {
      this.#exemptShadowCasters += 1;
      return;
    }
    if (!this.#enabled || !this.#cameraResolved) return;
    const dx = this.#center.x - this.#cameraX;
    const dy = this.#center.y - this.#cameraY;
    const dz = this.#center.z - this.#cameraZ;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const worldRadius = sphere.radius * object.matrixWorld.getMaxScaleOnAxis();
    const projectedDiameter = projectedDiameterPixels(worldRadius, distance, this.#scale);
    if (projectedDiameter >= this.#minimumPixels) return;
    object.visible = false;
    this.#hidden[this.#hiddenCount] = object;
    this.#hiddenCount += 1;
    this.#culled += 1;
  }

  #observeAnimation(
    object: Object3D,
    sphere: IBoundingSphereLike | typeof DYNAMIC_BOUNDS | undefined,
    notRendered = false,
  ): void {
    // An object under no live rate root has no state above it.
    const states = this.#animated.get(object);
    if (states === undefined) return;
    let rate = notRendered ? 8 : 1;
    let radius = 0;
    let banded = false;
    if (
      !notRendered &&
      this.#cameraResolved &&
      sphere !== undefined &&
      sphere !== DYNAMIC_BOUNDS &&
      Number.isFinite(sphere.radius) &&
      sphere.radius > 0
    ) {
      this.#center.copy(sphere.center).applyMatrix4(object.matrixWorld);
      radius = sphere.radius * object.matrixWorld.getMaxScaleOnAxis();
      // A known bound on the camera's forward centre ray is the conservative observable target
      // signal. Test each source independently so a nearer bound cannot hide a farther target.
      banded = !this.#animationRay.intersectsSphere(
        this.#animationSphere.set(this.#center, radius),
      );
    }
    const { x, y, z } = this.#center;
    for (const state of states) {
      // The pixel band reads the whole rig this frame, not this part: Lantern Vale's hero is 51 rigid
      // parts, the largest 80 px at 720p while the hero stands 170 px, and per part it held every
      // other pose. A one-mesh rig's union is its own sphere.
      // A part scaled to nothing projects 0 px: it leaves the rig to its other parts.
      if (banded) rate = radius > 0 ? this.#bandRate(this.#rigSphere(state, x, y, z, radius)) : 8;
      if (state.source === this && state.frame === this.#animationFrame)
        state.rate = Math.min(state.rate, rate);
      else state.rate = rate;
      state.source = this;
      state.frame = this.#animationFrame;
    }
  }

  /** Grows `state`'s sphere for this frame to hold the part at `x, y, z` and `radius`, into `#animationSphere`. */
  #rigSphere(state: IAnimationRateState, x: number, y: number, z: number, radius: number): Sphere {
    let union = this.#rigSpheres.get(state);
    if (union === undefined) {
      union = new Float64Array(5);
      this.#rigSpheres.set(state, union);
    }
    // In place, a part at a time each frame: no array literal and no typed-array destructuring.
    if (union[0] !== this.#animationFrame) {
      union[0] = this.#animationFrame;
      union[1] = x;
      union[2] = y;
      union[3] = z;
      union[4] = radius;
    } else {
      const ux = union[1] as number;
      const uy = union[2] as number;
      const uz = union[3] as number;
      const ur = union[4] as number;
      const distance = Math.hypot(x - ux, y - uy, z - uz);
      if (distance + radius > ur) {
        if (distance + ur <= radius) {
          union[1] = x;
          union[2] = y;
          union[3] = z;
          union[4] = radius;
        } else {
          const grown = (distance + ur + radius) / 2;
          const shift = (grown - ur) / distance;
          union[1] = ux + (x - ux) * shift;
          union[2] = uy + (y - uy) * shift;
          union[3] = uz + (z - uz) * shift;
          union[4] = grown;
        }
      }
    }
    this.#center.set(union[1] as number, union[2] as number, union[3] as number);
    return this.#animationSphere.set(this.#center, union[4] as number);
  }

  #bandRate(sphere: Sphere): number {
    if (!this.#frustum.intersectsSphere(sphere)) return 8;
    const { x, y, z } = sphere.center;
    const distance = Math.hypot(x - this.#cameraX, y - this.#cameraY, z - this.#cameraZ);
    const pixels = projectedDiameterPixels(sphere.radius, distance, this.#scale);
    // PRD-570's provisional pixel bands; the visual gate still has to earn these thresholds.
    return pixels >= 128 ? 1 : pixels >= 32 ? 2 : pixels >= 8 ? 4 : 8;
  }

  #observeAnimationSources(object: Object3D): void {
    const sources = animationRateSources.get(object);
    if (sources === undefined) return;
    for (const source of sources.keys()) {
      if (!this.#animated.has(source)) continue;
      const visible = this.#isVisibleInWorld(source);
      if (this.#isCameraAttached(source)) {
        this.#observeAnimation(source, undefined);
        continue;
      }
      this.#observeAnimation(
        source,
        visible ? boundsOf(source, this.#positionVersions, this.#animationFrame) : undefined,
        !visible,
      );
    }
  }

  /** Rebuilds {@link #cameraParts}, unless the engine's hierarchy has held still since. */
  #findCameraParts(camera: Camera): void {
    const revision = hierarchyRevision(camera);
    if (
      revision !== undefined &&
      revision === this.#cameraPartsRevision &&
      camera === this.#cameraPartsOf
    )
      return;
    this.#cameraParts.clear();
    camera.traverse(this.#collectCameraPart);
    this.#cameraParts.delete(camera);
    this.#cameraPartsOf = camera;
    this.#cameraPartsRevision = revision;
  }

  #isVisibleInWorld(object: Object3D): boolean {
    for (let node: Object3D | null = object; node !== null; node = node.parent) {
      if (!node.visible) return false;
    }
    return true;
  }

  #isCameraAttached(object: Object3D): boolean {
    return this.#camera !== undefined && this.#cameraParts.has(object);
  }
}

/** Pure projected-diameter formula shared by the draw gate and per-rig animation policy. */
export function projectedDiameterPixels(
  radius: number,
  distance: number,
  pixelsPerWorldUnit: number,
): number {
  return (2 * radius * pixelsPerWorldUnit) / Math.max(distance - radius, MIN_DISTANCE);
}

function boundsOf(
  object: Object3D,
  versions: WeakMap<object, IPositionVersion>,
  frame: number,
): IBoundingSphereLike | typeof DYNAMIC_BOUNDS | undefined {
  const cullable = object as ICullable;
  // An `InstancedMesh` carries its own instance-aware bound; the geometry one is not it.
  if (cullable.boundingSphere != null) return cullable.boundingSphere;
  const geometry = cullable.geometry;
  if (geometry === undefined) return undefined;
  const version = geometry.attributes?.position?.version;
  if (geometry.boundingSphere == null) {
    geometry.computeBoundingSphere?.();
    if (version !== undefined)
      versions.set(geometry, { version, frame, changedLastConsult: false, stale: false });
    return geometry.boundingSphere ?? undefined;
  }
  if (version === undefined) return geometry.boundingSphere ?? undefined;
  const known = versions.get(geometry);
  if (known === undefined) {
    versions.set(geometry, { version, frame, changedLastConsult: false, stale: false });
    return geometry.boundingSphere ?? undefined;
  }
  const sameFrame = known.frame === frame;
  known.frame = frame;
  if (known.version === version) {
    // Animation preparation and draw culling share one frame's observation.
    if (sameFrame) return known.stale ? DYNAMIC_BOUNDS : (geometry.boundingSphere ?? undefined);
    // A buffer that settled after a per-frame rewrite has knowable extents again: scan it once and
    // cull it like any other, rather than exempting it for the rest of the run. Settling also lets
    // the next change count as a fresh one rather than as the second frame of a rewrite.
    if (known.stale) geometry.computeBoundingSphere?.();
    known.changedLastConsult = false;
    known.stale = false;
    return geometry.boundingSphere ?? undefined;
  }
  known.version = version;
  if (known.changedLastConsult) {
    // The buffer moved again on the very next consult: it is rewritten every frame. A full
    // vertex/instance scan per frame costs more than the draw it might remove, and the extents are
    // not knowable without it — so treat the bound like `frustumCulled = false` and keep drawing.
    known.stale = true;
    return DYNAMIC_BOUNDS;
  }
  // The buffer was rewritten under a cached sphere, which is now a stale size that *looks* valid.
  // Recompute rather than trust it. Only a changed buffer pays this, so a static scene computes
  // once and a dynamic one pays only where its bounds are actually consulted.
  geometry.computeBoundingSphere?.();
  known.changedLastConsult = true;
  return geometry.boundingSphere ?? undefined;
}
