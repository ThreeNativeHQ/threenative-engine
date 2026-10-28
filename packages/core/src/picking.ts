import {
  type BufferGeometry,
  type Camera,
  type Intersection,
  Matrix3,
  Mesh,
  type Object3D,
  Raycaster,
  Vector2,
  type Vector3,
} from "three";
import { MeshBVH } from "three-mesh-bvh";
import { type IAutoBatchPick, autoBatchOf, isAutoBatchMerged } from "./auto-batch.js";
import { baseGeometryOf, isLodJoinProxy } from "./model-lod.js";
import type { Viewport } from "./viewport.js";

export interface IRaycastOptions {
  /** Screen point in canvas pixels. Mutually exclusive with `origin` and `direction`. */
  readonly screen?: Vector2;
  /** World-space ray origin. Requires `direction`. */
  readonly origin?: Vector3;
  /** World-space ray direction. The caller must provide a normalised vector. */
  readonly direction?: Vector3;
  /** Maximum distance. Defaults to unbounded. */
  readonly far?: number;
  /** What to test. Defaults to the whole scene. */
  readonly targets?: Object3D | readonly Object3D[];
  /** Subtrees never hit, whatever `targets` says. */
  readonly exclude?: Object3D | readonly Object3D[];
}

export interface IScenePickerOptions {
  readonly camera: Camera;
  readonly pointer: () => Vector2;
  readonly scene: Object3D;
  readonly viewport: Viewport;
}

interface ICachedTree {
  readonly tree: MeshBVH;
  readonly version: number;
}

type AcceleratedRaycaster = Raycaster & { firstHitOnly?: boolean };

/**
 * Ray queries against scene geometry, accelerated by a bounding volume hierarchy that is
 * built on first use and rebuilt when the geometry's positions change.
 *
 * The acceleration is an implementation detail: nothing about it reaches the caller, no
 * `three` prototype is patched, and a game that never calls `raycast` never builds a tree.
 * Skinned, instanced, batched and morphed meshes fall back to the stock `three` path,
 * because a hierarchy over their rest positions would report hits in the wrong place.
 */
/** True when `object` is `root` or sits somewhere under it. */
function isWithin(object: Object3D, root: Object3D): boolean {
  for (let node: Object3D | null = object; node !== null; node = node.parent) {
    if (node === root) return true;
  }
  return false;
}

export class ScenePicker {
  #camera: Camera;
  #pointer: () => Vector2;
  #scene: Object3D;
  #viewport: Viewport;
  #raycaster: AcceleratedRaycaster = new Raycaster();
  #ndc = new Vector2();
  #hits: Intersection[] = [];
  #objectHits: Intersection[] = [];
  #roots: Object3D[] = [];
  #excluded = new Set<Object3D>();
  #compareHits = (first: Intersection, second: Intersection): number =>
    first.distance - second.distance;
  #trees = new WeakMap<BufferGeometry, ICachedTree>();
  /** Merged meshes that answer for hidden sources a ray reached, with the target roots that reached them. */
  #batched = new Map<Mesh, { pick: IAutoBatchPick; roots: Object3D[] }>();
  #normalMatrix = new Matrix3();

  constructor(options: IScenePickerOptions) {
    this.#camera = options.camera;
    this.#pointer = options.pointer;
    this.#scene = options.scene;
    this.#viewport = options.viewport;
    this.#raycaster.firstHitOnly = false;
  }

  /**
   * The closest hit, or `undefined` when the ray hits nothing.
   *
   * Collects at most one hit per target: the traversal runs with `firstHitOnly` so BVH-backed
   * meshes stop at their own closest triangle (PRD-186 phase 1), and anything on the stock
   * fallback path — instanced, skinned, morphed — is reduced to its own nearest before it joins
   * the candidates. The winner is a running minimum, never a full sort: a game asking "what did
   * this round hit" should not pay for every wall behind the answer.
   */
  raycast(options?: IRaycastOptions): Intersection | undefined {
    this.#query(options, true);
    let nearest: Intersection | undefined;
    for (const hit of this.#hits) {
      if (nearest === undefined || hit.distance < nearest.distance) nearest = hit;
    }
    return nearest;
  }

  /** Every hit, sorted from the nearest to the farthest. */
  raycastAll(options?: IRaycastOptions, target?: Intersection[]): readonly Intersection[] {
    if (target !== undefined) target.length = 0;
    this.#query(options, false);
    if (target === undefined) return this.#hits.slice();
    for (const hit of this.#hits) target.push(hit);
    return target;
  }

  #query(options: IRaycastOptions | undefined, single: boolean): void {
    this.#setRay(options);
    this.#raycaster.far = options?.far ?? Number.POSITIVE_INFINITY;
    const targets = options?.targets ?? this.#scene;
    this.#roots.length = 0;
    if (Array.isArray(targets)) {
      for (const target of targets as readonly Object3D[]) this.#roots.push(target);
    } else {
      this.#roots.push(targets as Object3D);
    }
    this.#excluded.clear();
    const exclude = options?.exclude;
    if (exclude !== undefined) {
      if (Array.isArray(exclude)) {
        for (const object of exclude as readonly Object3D[]) this.#excluded.add(object);
      } else {
        this.#excluded.add(exclude as Object3D);
      }
    }
    this.#hits.length = 0;
    this.#batched.clear();
    this.#raycaster.firstHitOnly = single;
    try {
      for (const root of this.#roots) {
        root.updateMatrixWorld();
        this.#collect(root, this.#excluded, single, root);
      }
      for (const [merged, { pick, roots }] of this.#batched)
        this.#testBatched(merged, pick, roots, this.#excluded);
      if (!single) this.#hits.sort(this.#compareHits);
    } finally {
      this.#raycaster.firstHitOnly = false;
    }
  }

  /** Drops every cached hierarchy. The next `raycast` rebuilds what it needs. */
  dispose(): void {
    this.#trees = new WeakMap<BufferGeometry, ICachedTree>();
    this.#hits.length = 0;
    this.#roots.length = 0;
    this.#excluded.clear();
  }

  #setRay(options: IRaycastOptions | undefined): void {
    const hasScreen = options?.screen !== undefined;
    const hasOrigin = options?.origin !== undefined;
    const hasDirection = options?.direction !== undefined;
    if (hasScreen && (hasOrigin || hasDirection))
      throw new Error("ICtx.raycast screen cannot be combined with origin or direction.");
    if (hasDirection && !hasOrigin) throw new Error("ICtx.raycast direction requires origin.");
    if (hasOrigin && !hasDirection) throw new Error("ICtx.raycast origin requires direction.");
    if (hasOrigin) {
      this.#raycaster.camera = this.#camera;
      this.#raycaster.set(options?.origin as Vector3, options?.direction as Vector3);
      return;
    }

    const screen = options?.screen ?? this.#pointer();
    if (!Number.isFinite(screen.x) || !Number.isFinite(screen.y))
      throw new Error("ICtx.raycast screen point must be finite.");
    const { height, width } = this.#viewport.size;
    if (width <= 0 || height <= 0) throw new Error("ICtx.raycast needs a sized viewport.");
    this.#ndc.set((screen.x / width) * 2 - 1, -(screen.y / height) * 2 + 1);
    this.#raycaster.setFromCamera(this.#ndc, this.#camera);
  }

  #collect(
    object: Object3D,
    excluded: ReadonlySet<Object3D>,
    single: boolean,
    root: Object3D,
  ): void {
    if (excluded.size !== 0 && this.#isExcluded(object, excluded)) return;
    const pick = autoBatchOf(object);
    if (pick !== undefined) {
      // A source the engine merged and hid: its merged mesh answers for it, once per ray.
      if (object.layers.test(this.#raycaster.layers)) this.#reach(pick, root);
    } else if (object.layers.test(this.#raycaster.layers)) {
      if (single) {
        // The stock fallback ignores `firstHitOnly`, so one object can still push several
        // intersections; only that object's own nearest survives. The global answer can only
        // ever be some object's nearest hit, so nothing behind it is ever needed.
        this.#objectHits.length = 0;
        this.#hitTest(object, this.#objectHits);
        let best = this.#objectHits[0];
        for (let index = 1; index < this.#objectHits.length; index += 1) {
          const candidate = this.#objectHits[index];
          if (candidate !== undefined && (best === undefined || candidate.distance < best.distance))
            best = candidate;
        }
        if (best !== undefined) this.#hits.push(best);
      } else {
        this.#hitTest(object, this.#hits);
      }
    }
    for (const child of object.children) this.#collect(child, excluded, single, root);
  }

  #reach(pick: IAutoBatchPick, root: Object3D): void {
    const entry = this.#batched.get(pick.merged);
    if (entry === undefined) this.#batched.set(pick.merged, { pick, roots: [root] });
    else if (!entry.roots.includes(root)) entry.roots.push(root);
  }

  /**
   * One hierarchy test on a merged mesh, answered with the authored sources the ray was asked about.
   *
   * Every hit along the ray is read, not only the nearest: the nearest triangle may belong to a
   * source outside the target set, and a farther one inside it must still be found.
   */
  #testBatched(
    merged: Mesh,
    pick: IAutoBatchPick,
    roots: readonly Object3D[],
    excluded: ReadonlySet<Object3D>,
  ): void {
    const tree = this.#treeFor(merged);
    if (tree === undefined) return;
    const found: Intersection[] = [];
    this.#raycaster.firstHitOnly = false;
    tree.raycastObject3D(merged, this.#raycaster, found);
    for (const hit of found) {
      const source =
        hit.face === null || hit.face === undefined ? undefined : pick.sourceAt(hit.face.a);
      if (source === undefined || !roots.some((root) => isWithin(source, root))) continue;
      if (excluded.size !== 0 && this.#isExcluded(source, excluded)) continue;
      this.#hits.push(this.#asSource(hit, source));
    }
  }

  /** The hit as the authored source reports it: its object, and a normal in its own space. */
  #asSource(hit: Intersection, source: Object3D): Intersection {
    const face = hit.face as NonNullable<Intersection["face"]>;
    const normal = face.normal
      .clone()
      .applyMatrix3(this.#normalMatrix.getNormalMatrix(source.matrixWorld).invert())
      .normalize();
    return { ...hit, face: { ...face, normal }, faceIndex: undefined, object: source };
  }

  #hitTest(object: Object3D, into: Intersection[]): void {
    // A joined rung inserts a proxy object carrying the collapsed geometry but none of the authored
    // node identity. Authored primitives are hidden from the render, never from a ray test, so the
    // proxy must be skipped or a pick at distance would answer with an object the game never added.
    if (isLodJoinProxy(object) || isAutoBatchMerged(object)) return;
    const tree = this.#treeFor(object);
    if (tree === undefined) {
      object.raycast(this.#raycaster, into);
      return;
    }
    if (!(object instanceof Mesh)) {
      tree.raycastObject3D(object, this.#raycaster, into);
      return;
    }
    // A mesh the loader gave an automatic LOD chain swaps its `geometry` with the camera. Picking
    // must not: the tree is built from LOD0, and the object is put back on LOD0 for the test so the
    // hit is the authored surface whatever detail is currently drawn.
    const base = baseGeometryOf(object);
    const restore = base === object.geometry ? undefined : object.geometry;
    if (restore !== undefined) object.geometry = base;
    try {
      tree.raycastObject3D(object, this.#raycaster, into);
    } finally {
      if (restore !== undefined) object.geometry = restore;
    }
  }

  #isExcluded(object: Object3D, excluded: ReadonlySet<Object3D>): boolean {
    let current: Object3D | null = object;
    while (current !== null) {
      if (excluded.has(current)) return true;
      current = current.parent;
    }
    return false;
  }

  #treeFor(object: Object3D): MeshBVH | undefined {
    if (!(object instanceof Mesh)) return undefined;
    const deformed = object as Mesh & {
      isBatchedMesh?: boolean;
      isInstancedMesh?: boolean;
      isSkinnedMesh?: boolean;
    };
    if (
      deformed.isSkinnedMesh === true ||
      deformed.isInstancedMesh === true ||
      deformed.isBatchedMesh === true ||
      (object.morphTargetInfluences?.length ?? 0) > 0
    )
      return undefined;
    // The tree is built from the authored LOD0, never from whichever level the camera selected;
    // the position attribute is shared across levels, so its version still tracks source changes.
    const geometry = baseGeometryOf(object);
    const position = object.geometry.attributes.position;
    if (position === undefined || position.count === 0) return undefined;
    const cached = this.#trees.get(geometry);
    if (cached !== undefined && cached.version === position.version) return cached.tree;
    const tree = new MeshBVH(geometry);
    this.#trees.set(geometry, { tree, version: position.version });
    return tree;
  }
}
