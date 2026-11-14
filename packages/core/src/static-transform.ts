/**
 * Authored static subtrees: stop recomposing transforms that nobody moves.
 *
 * The matrix walk is 2.22 ms of the reference game's 16.1 ms render phase, and almost none of what
 * it recomputes changed since the previous frame — island geometry, deck fittings, static props and
 * terrain are composed from the same position, quaternion and scale every frame, then multiplied
 * into the same world matrix, for as long as the game runs.
 *
 * **What this deletes, exactly, so the claim can be checked.** Three's `updateMatrixWorld` does
 * three things per object: `updateMatrix()` composes the local matrix when `matrixAutoUpdate`,
 * the world matrix is multiplied out when `matrixWorldNeedsUpdate || force`, and the walk recurses
 * into every child — the recursion is unconditional in three 0.185, so a frozen subtree still gets
 * visited. Freezing removes the two composes and keeps the visit. That is the honest bound: this
 * deletes arithmetic, not traversal, and the traversal is a separate lever with a separate PRD.
 *
 * **Staticness is authored, never guessed.** A heuristic that decides an object has "not moved in
 * 60 frames" is a correctness bug with no reproduction, so nothing here watches gameplay. What the
 * engine does do is check the promise where it is cheap to check it: the root's own local transform
 * and its parent's world matrix are compared against what was frozen, once per frame, and a root the author moved thaws and
 * refreezes itself. That is O(static roots), not O(objects), and it turns the most common way to
 * get this wrong into a non-event. Writes deeper inside a frozen subtree are the author's to
 * announce with `invalidateStatic`, and `TN_RENDERLIST_VALIDATE=1` is what proves they did.
 */

import type { Matrix4, Object3D, Quaternion, Vector3 } from "three";

/** Marker printed with the static census on each reported window. */
export const STATIC_TRANSFORM_MARKER = "TN_STATIC_TRANSFORMS";

/** What was frozen, and the authored transform it was frozen at. */
interface IFrozenRoot {
  readonly root: Object3D;
  /** Objects in the subtree at the time it was frozen, including the root. */
  readonly objects: number;
  /** The root's authored transform when it was frozen: position, quaternion, scale, matrix. */
  readonly snapshot: Float64Array;
  /** Bumped every time the subtree is re-armed; the contract a consumer checks, not the flag. */
  version: number;
}

/**
 * Frozen roots, in the order they were marked.
 *
 * A Map keyed by the object, because a root is unmarked by identity and the per-frame check needs
 * to iterate. Insertion order is the report's order, which makes two runs of the same scene produce
 * the same census line.
 */
const frozen = new Map<Object3D, IFrozenRoot>();

/** Position, quaternion, scale, local matrix, then the parent's world matrix (identity with none). */
const SNAPSHOT_LENGTH = 3 + 4 + 3 + 16 + 16;
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function writeSnapshot(root: Object3D, into: Float64Array): void {
  const position: Vector3 = root.position;
  const quaternion: Quaternion = root.quaternion;
  const scale: Vector3 = root.scale;
  // One read of each `elements`: on the owned engine it is an accessor that resolves a Wasm heap
  // view per read, and this runs for every frozen root every frame (PRD-887 AC-3).
  const matrix: Matrix4["elements"] = root.matrix.elements;
  into[0] = position.x;
  into[1] = position.y;
  into[2] = position.z;
  into[3] = quaternion.x;
  into[4] = quaternion.y;
  into[5] = quaternion.z;
  into[6] = quaternion.w;
  into[7] = scale.x;
  into[8] = scale.y;
  into[9] = scale.z;
  for (let element = 0; element < 16; element += 1)
    into[10 + element] = matrix[element] ?? 0;
  // The frozen world matrix is the parent's times the root's own, so a root attached after it froze,
  // or one whose ancestor moved, is as stale as one the author moved. A streamed world freezes each
  // draw before it joins the world root, and a seated world (`world.position.y = -ground`) drew
  // every tree at the package's absolute height.
  const parent = root.parent?.matrixWorld.elements ?? IDENTITY;
  for (let element = 0; element < 16; element += 1) into[26 + element] = parent[element] ?? 0;
}

function snapshotMatches(root: Object3D, snapshot: Float64Array, scratch: Float64Array): boolean {
  writeSnapshot(root, scratch);
  for (let index = 0; index < SNAPSHOT_LENGTH; index += 1) {
    if (scratch[index] !== snapshot[index]) return false;
  }
  return true;
}

/** Reused by the per-frame check so a frozen scene allocates nothing while it stays frozen. */
const scratch = new Float64Array(SNAPSHOT_LENGTH);

/**
 * Three's own "nothing about me changes between frames" flag, read by its node material observer.
 *
 * A static object is redrawn every frame but skips the per-object work that cannot change: the
 * OBJECT node updates, the object uniform group upload and the attribute scan. Three only trusts it
 * while the world matrix, the material, the geometry and the scene environment are unchanged, so
 * this is the same promise the freeze already makes, said in three's own words.
 */
function setThreeStatic(object: Object3D, value: boolean): void {
  (object as Object3D & { static?: boolean }).static = value;
}

/**
 * Objects whose local compose *this* turned off, as opposed to a game that composes its own matrix
 * and turned `matrixAutoUpdate` off for its own reasons.
 *
 * The distinction is what lets the validator do its job. For an object the freeze silenced, the
 * authored `position`/`quaternion`/`scale` are still the truth and the frozen `matrix` is the
 * cache, so recomposing from the former is how a stale cache is caught. For an object the game
 * drives by writing `matrix`, the reverse is true and composing would invent a transform.
 */
const composeSilenced = new WeakSet<Object3D>();

/** Whether the static freeze is the reason this object stopped composing its own matrix. */
export function composeSilencedByFreeze(object: Object3D): boolean {
  return composeSilenced.has(object);
}

/**
 * Roots whose *world* compose the freeze turned off, as opposed to an object that owns its world
 * matrix because the game or the projection writes it directly.
 *
 * `matrixWorldAutoUpdate === false` means "I maintain this myself" in three, and the projection
 * sets it on its mirror as a matter of course. A validator that recomputed those from the parent
 * chain would report every one of them stale.
 */
const worldSilenced = new WeakSet<Object3D>();

/** Whether the static freeze is the reason this object's world matrix is no longer recomposed. */
export function worldSilencedByFreeze(object: Object3D): boolean {
  return worldSilenced.has(object);
}

/** Gives a frozen subtree its compose flags back, so the next update recomposes it. */
function thaw(root: Object3D): void {
  if (worldSilenced.delete(root)) root.matrixWorldAutoUpdate = true;
  root.traverse((child) => {
    if (composeSilenced.delete(child)) child.matrixAutoUpdate = true;
    child.matrixWorldNeedsUpdate = true;
  });
}

/** Freezes the subtree in place and answers how many objects stopped recomposing. */
function freeze(root: Object3D): number {
  root.updateMatrixWorld(true);
  let objects = 0;
  root.traverse((object) => {
    objects += 1;
    setThreeStatic(object, true);
    if (object.matrixAutoUpdate) composeSilenced.add(object);
    object.matrixAutoUpdate = false;
    object.matrixWorldNeedsUpdate = false;
  });
  // Only the root's own world matrix is a product of something outside the subtree, so only the
  // root needs its world compose suppressed; the children's are already suppressed by the two
  // flags above and would be recomposed identically anyway.
  if (root.matrixWorldAutoUpdate) worldSilenced.add(root);
  root.matrixWorldAutoUpdate = false;
  return objects;
}

/**
 * Marks a subtree static: its transforms are composed once here and never again until something
 * changes them.
 *
 * Idempotent, and it answers the version the subtree is now at, so a caller can assert on the
 * contract rather than on the flag. Marking a root twice re-arms it, which is the same thing
 * `invalidateStatic` does and the reason a generator can emit the call unconditionally.
 */
export function markStatic(root: Object3D): number {
  const existing = frozen.get(root);
  // A second mark re-arms: thaw first, or `freeze`'s update skips the root's own world compose (the
  // first freeze turned it off) and the subtree keeps the world matrix of its first parent.
  if (existing !== undefined) thaw(root);
  const objects = freeze(root);
  const snapshot = existing?.snapshot ?? new Float64Array(SNAPSHOT_LENGTH);
  writeSnapshot(root, snapshot);
  const version = (existing?.version ?? 0) + 1;
  frozen.set(root, { objects, root, snapshot, version });
  return version;
}

/**
 * Thaws a subtree: every object composes again from the next walk.
 *
 * The flags are restored to three's defaults rather than to whatever they were before, because a
 * game that had already turned `matrixAutoUpdate` off for its own reasons and then marked the
 * subtree static is asking for the same behaviour either way.
 */
export function unmarkStatic(root: Object3D): void {
  if (!frozen.delete(root)) return;
  if (worldSilenced.delete(root)) root.matrixWorldAutoUpdate = true;
  root.traverse((object) => {
    if (composeSilenced.delete(object)) object.matrixAutoUpdate = true;
    setThreeStatic(object, false);
    object.matrixWorldNeedsUpdate = true;
  });
}

/**
 * Announces that something inside a frozen subtree moved. The subtree recomposes once and refreezes
 * at its new transform.
 *
 * Takes the object that moved, or the root; either way the root that owns it is what re-arms, since
 * a world matrix deeper in the subtree is a product of everything above it.
 */
export function invalidateStatic(object: Object3D): number | undefined {
  let node: Object3D | null = object;
  while (node !== null) {
    // `markStatic` thaws a frozen root before it freezes it again.
    if (frozen.has(node)) return markStatic(node);
    node = node.parent;
  }
  return undefined;
}

/** Whether this object is a frozen root. */
export function isStatic(root: Object3D): boolean {
  return frozen.has(root);
}

/**
 * The frozen roots, for the divergence oracle to check directly.
 *
 * The oracle validates what the frame draws, and when the engine's projection is collapsing the
 * scene that is the mirror rather than the authored subtree — which reported three objects
 * checked and zero divergences on a scene with two hundred frozen meshes, one of them genuinely
 * stale. A freeze is authored on the authored scene, so the oracle has to be handed those roots
 * explicitly or it reassures without looking.
 */
export function staticRoots(): readonly Object3D[] {
  return [...frozen.keys()];
}

/** One window's census of what is frozen and what had to thaw. */
export interface IStaticTransformCensus {
  /** Subtrees currently frozen. */
  readonly roots: number;
  /** Objects inside them, which is the count that stopped recomposing. */
  readonly objects: number;
  /** Roots the per-frame check found moved, and re-armed, since the previous census. */
  readonly rearmed: number;
}

let rearmedSinceCensus = 0;

/**
 * Re-arms any frozen root whose authored transform has changed since it was frozen.
 *
 * Called once per render phase, before the walk. It reads 26 numbers per frozen root and writes
 * nothing when nothing moved, so a scene that stays still pays a comparison per subtree and no
 * allocation at all. It cannot see a write deeper inside the subtree — that is `invalidateStatic`'s
 * job and `TN_RENDERLIST_VALIDATE=1`'s proof — and it does not pretend to.
 */
export function refreshStaticTransforms(): void {
  if (frozen.size === 0) return;
  for (const entry of frozen.values()) {
    if (snapshotMatches(entry.root, entry.snapshot, scratch)) continue;
    markStatic(entry.root);
    rearmedSinceCensus += 1;
  }
}

/** The census, and the re-arm counter it resets. */
export function staticTransformCensus(): IStaticTransformCensus {
  let objects = 0;
  for (const entry of frozen.values()) objects += entry.objects;
  const census: IStaticTransformCensus = {
    objects,
    rearmed: rearmedSinceCensus,
    roots: frozen.size,
  };
  rearmedSinceCensus = 0;
  return census;
}

/** Drops every registration. A game that tore down its scene must not keep its roots alive. */
export function resetStaticTransforms(): void {
  frozen.clear();
  rearmedSinceCensus = 0;
}
