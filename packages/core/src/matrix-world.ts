import { Object3D } from "three";
import { SPANS, beginSpan, endSpan } from "./profiling/Spans.js";
import { isStatic } from "./static-transform.js";

/**
 * The per-frame world-matrix walk, with a hidden subtree left where it stands.
 *
 * `three`'s `Object3D.updateMatrixWorld` recurses into every child of every node whatever its
 * `visible` flag, multiplying a world matrix for each. That is the correct default for a library
 * that cannot know what a game is doing, and it is the wrong one for a renderer that is about to
 * skip exactly those subtrees: a full-detail body while its merged stand-in draws, a hidden LOD
 * level, a parked or hangared model each pay the walk and none of them can draw.
 *
 * Native flight in `sandbox/midway-open-pacific` profiled `updateMatrixWorld` plus
 * `multiplyMatrices` at **29 % of all JavaScript ticks**, and the same scene's hand-rolled
 * visible-only pass walked **779 nodes per frame instead of 9,903**, 3.1 ms down to 0.3 ms. That
 * pass was the game's; this is the engine's, so the next game does not write it again.
 *
 * The pass mirrors three exactly for a visible node: `matrixAutoUpdate` -> `updateMatrix()`, then
 * the `matrixWorldNeedsUpdate || force` recompute honouring `matrixWorldAutoUpdate` and a null
 * parent, then force the children. A node with `visible === false` still composes its **own**
 * matrix — that is what makes the next part cheap — and is not recursed into; when it was forced
 * (or carried a dirty flag) it is remembered, so the first frame it is visible again its whole
 * subtree is recomputed with `force = true`.
 *
 * Two things are never dropped by the pruning, because both are read while nothing above them is
 * visible:
 *
 * - a class that overrides `updateMatrixWorld` runs its own — never a `Scene`, which three does not
 *   override and whose method only differs when something patched the prototype. `SkinnedMesh`
 *   refreshes `bindMatrixInverse`, `Camera` its `matrixWorldInverse`; re-implementing only the base
 *   walk left every deck-crew sailor that had moved since load drawing with a stale bind matrix and
 *   vanishing from the frame. Their subtrees are small, so walking them whole costs nothing;
 * - a hidden node that holds a `Bone` is walked, because a visible `SkinnedMesh` draws with its
 *   skeleton's matrices wherever the armature happens to sit. Whether bones sit below a node is
 *   decided once and remembered — a rig is built whole and does not grow.
 *
 * A third thing is dropped, and it is the walk's largest single share on a streamed world: a subtree
 * frozen with `markStatic`. `markStatic` composes the subtree once and turns off the two flags that
 * would recompose it, which until now still left three's unconditional recursion visiting every node
 * under it every frame. A frozen root that carries no dirty flag is a leaf here, and it is one
 * whether the walk was forced or not: `refreshStaticTransforms` re-arms a root whose own transform
 * moved, `invalidateStatic` re-arms one something wrote inside, and both compose the subtree once at
 * that moment. `isStatic` is what separates the engine's freeze from a game that turned the flags off
 * for its own reasons. See `static-transform.ts`.
 *
 * Where the root is a native-engine object it has its own walk, `__tnUpdateMatrixWorld(force, prune)`: this
 * pass run natively in one call, answering the nodes it visited. The pass calls that and nothing else, since the
 * walk above costs a bridge call per node read and written (about 16 to 25 thousand a frame at 4,096 cubes).
 * With `prune` (the `"visible"` mode) the native walk leaves a hidden subtree where it stands by the same rules,
 * bones included; `"all"` visits every node. A JS subclass of `Object3D` that overrides `updateMatrixWorld` is not
 * called from inside it; the engine's own `SkinnedMesh` and `Camera` keep their derived matrices. The web and the
 * legacy host have no such method and walk as above.
 *
 * A game that reads a **hidden** object's `matrixWorld` directly must not rely on this pass
 * having reached it: use `getWorldPosition`/`getWorldQuaternion`/`getWorldScale` (which update the
 * chain they need) or call `object.updateWorldMatrix(true, false)` first. The convention's named
 * override is `renderer.matrixWorld: "all"`, which visits every node exactly as three's own walk
 * does; `"visible"` is the default.
 */

/** How much of the scene graph the engine walks for world matrices each frame. */
export type MatrixWorldMode = "visible" | "all";

/** The shipping default: a hidden subtree is not walked. */
export const DEFAULT_MATRIX_WORLD_MODE: MatrixWorldMode = "visible";

/** What the pass did on the last frame, for the frame telemetry a window reports. */
export interface IMatrixWorldReport {
  readonly schemaVersion: 1;
  readonly mode: MatrixWorldMode;
  /**
   * Nodes the engine walked this frame, summed over every application (authored scene and a
   * projection mirror when one is in use). One number both ways, so `"all"` can be read as the
   * cost of the walk the convention just removed.
   */
  readonly visited: number;
}

export interface IMatrixWorldOptions {
  /** `"visible"` (default) skips a hidden subtree; `"all"` reproduces three's own walk. */
  readonly mode?: MatrixWorldMode;
}

/** What a native-engine root offers: the whole walk in one call, answering the nodes it covered. */
type NativeWalk = (this: Object3D, force: boolean, prune: boolean) => number;

/** The base walk, to tell a class that overrides `updateMatrixWorld` (SkinnedMesh, Camera) apart. */
const BASE_UPDATE_MATRIX_WORLD = Object3D.prototype.updateMatrixWorld;

/**
 * Whether this node's own `updateMatrixWorld` must run instead of this walk.
 *
 * A `Scene` never does: three does not override the walk on `Scene`, so a scene whose method is not
 * the base one has had its prototype patched — the frame spans time the render phase's walk by
 * wrapping `Scene.prototype.updateMatrixWorld` — or a game has subclassed `Scene`. Reading that as
 * "a class that owns its walk" handed the whole scene to three's own recursion, and three's
 * recursion prunes nothing: the visible-only pass and every frozen subtree stopped mattering for as
 * long as the frame spans were on, which is how they are measured. The trade is a game that
 * subclasses `Scene` *and* overrides the walk, which no template does; it is walked by this pass
 * instead, which is the same walk minus the pruning.
 */
function ownsItsWalk(root: Object3D): boolean {
  if ((root as Object3D & { isScene?: boolean }).isScene === true) return false;
  return root.updateMatrixWorld !== BASE_UPDATE_MATRIX_WORLD;
}

/**
 * `three`'s own world-matrix compose, verbatim: recompute when the node is dirty or the walk is
 * forced, honour `matrixWorldAutoUpdate` and a null parent, then clear the dirty flag.
 *
 * Answers whether the node's world matrix was recomposed, which is what makes its subtree dirty.
 */
function composeWorld(root: Object3D, force: boolean): boolean {
  if (!(root.matrixWorldNeedsUpdate || force)) return false;
  if (root.matrixWorldAutoUpdate === true) {
    if (root.parent === null) root.matrixWorld.copy(root.matrix);
    else root.matrixWorld.multiplyMatrices(root.parent.matrixWorld, root.matrix);
  }
  root.matrixWorldNeedsUpdate = false;
  return true;
}

/**
 * Whether the walk can stop here, because the subtree's world matrices were composed when the engine
 * placed it and only a write inside could change them.
 *
 * `isStatic` is what separates the engine's freeze from a game that turned the flags off itself, and
 * a dirty flag means someone has written to this node since. A forced walk does not change the
 * answer: `composeWorld` has already run, and a frozen root silences its own world compose, so three
 * would carry the force down the subtree and recompute nothing at the end of it.
 */
function frozenLeaf(root: Object3D): boolean {
  return root.matrixWorldNeedsUpdate === false && isStatic(root);
}

function resolveMode(mode: MatrixWorldMode | undefined): MatrixWorldMode {
  if (mode === undefined) return DEFAULT_MATRIX_WORLD_MODE;
  if (mode !== "visible" && mode !== "all")
    throw new Error(
      `renderer.matrixWorld must be "visible" or "all", received ${JSON.stringify(mode)}.`,
    );
  return mode;
}

/**
 * One game's world-matrix walk, holding the state the pruning needs between frames.
 *
 * The stale set and the bone cache live on the instance rather than in module scope: two games,
 * two playtest scenarios or two roots in one process must not share "this subtree was skipped
 * while hidden", or one game's hidden node would be force-refreshed by the other's frame.
 */
export class MatrixWorldPass {
  readonly #mode: MatrixWorldMode;
  /** Hidden nodes whose own matrix was forced, waiting for the frame they show again. */
  readonly #stale = new WeakSet<Object3D>();
  /** Whether a `Bone` sits anywhere under a node, decided once and remembered. */
  readonly #bones = new WeakMap<Object3D, boolean>();
  #visited = 0;

  constructor(options: IMatrixWorldOptions = {}) {
    this.#mode = resolveMode(options.mode);
  }

  get mode(): MatrixWorldMode {
    return this.#mode;
  }

  /** What the current frame has walked so far, across every {@link apply} call. */
  get report(): IMatrixWorldReport {
    return { schemaVersion: 1, mode: this.#mode, visited: this.#visited };
  }

  /** Starts a frame's count. The pass's state (stale set, bone cache) is untouched. */
  beginFrame(): void {
    this.#visited = 0;
  }

  /**
   * Walks `root`, mirroring three for every node the mode visits.
   *
   * Returns the nodes this call visited, so a caller can report one application's cost without
   * also reporting the frame's total.
   */
  apply(root: Object3D, force = false): number {
    const before = this.#visited;
    beginSpan(SPANS.sceneUpdate);
    try {
      const native = (root as Object3D & { __tnUpdateMatrixWorld?: NativeWalk })
        .__tnUpdateMatrixWorld;
      if (typeof native === "function")
        this.#visited += native.call(root, force, this.#mode === "visible");
      else this.#step(root, force, this.#mode === "visible");
    } finally {
      endSpan(SPANS.sceneUpdate);
    }
    return this.#visited - before;
  }

  /** Forgets what was skipped. A whole-scene swap has no hidden ancestors left to refresh. */
  dispose(): void {
    this.#visited = 0;
  }

  #step(root: Object3D, force: boolean, prune: boolean): void {
    this.#visited += 1;
    // A class that extends the walk runs its own, so `SkinnedMesh.bindMatrixInverse` and
    // `Camera.matrixWorldInverse` stay as fresh as the world matrix they derive from.
    if (ownsItsWalk(root)) {
      const stale = this.#stale.delete(root);
      root.updateMatrixWorld(force || stale);
      return;
    }
    if (root.matrixAutoUpdate) root.updateMatrix();
    let childForce = composeWorld(root, force) || force;
    // The recompose cleared the flag, so `childForce` is now true exactly when this node's own
    // world matrix changed — and therefore when its subtree is dirty. Nothing under a hidden node
    // can draw, so defer the recursion; the node itself is already correct for the frame it shows.
    if (prune && root.visible === false && !this.#holdsBones(root)) {
      if (childForce) this.#stale.add(root);
      return;
    }
    if (this.#stale.delete(root)) childForce = true;
    // The frozen subtree's world matrices were composed when the engine placed it, and only a write
    // to something in it can change them: `refreshStaticTransforms` re-arms a frozen root whose own
    // transform moved, and `invalidateStatic` re-arms one something wrote inside. Both compose the
    // subtree once, at that moment, so the frames in between have nothing to recompute — which is
    // what makes the recursion here worth stopping.
    if (frozenLeaf(root)) return;
    const children = root.children;
    for (let index = 0, length = children.length; index < length; index += 1) {
      this.#step(children[index] as Object3D, childForce, prune);
    }
  }

  #holdsBones(node: Object3D): boolean {
    let known = this.#bones.get(node);
    if (known === undefined) {
      known = false;
      node.traverse((object) => {
        if ((object as Object3D & { isBone?: boolean }).isBone === true) known = true;
      });
      this.#bones.set(node, known);
    }
    return known;
  }
}
