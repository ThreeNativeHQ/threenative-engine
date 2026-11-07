/**
 * The parity oracle for anything that stops recomputing a transform.
 *
 * A cache that is right on the scene you tested and wrong on the one you did not is worse than no
 * cache, because it ships as a visual bug nobody can reproduce. This is the instrument that makes
 * the difference falsifiable: with `TN_RENDERLIST_VALIDATE=1`, every frame recomputes every world
 * matrix from the authored transforms, the long way, and compares it elementwise against the one
 * the frame is about to draw with. The first disagreement throws, naming the object and the
 * element, because a validation mode that logs and continues is a validation mode nobody reads.
 *
 * It is a validation mode, not a proof: it proves the frames it ran on. Run it on the scenes you
 * care about, in CI, for as many frames as you can afford.
 *
 * Off by default and expensive by construction — it does the work it is checking, twice.
 */
import { readLaunchFlag } from "../debug.js";

import { Matrix4, type Object3D } from "three";
import { composeSilencedByFreeze, worldSilencedByFreeze } from "../static-transform.js";

/** Marker printed when the validator is installed, so a log says which mode produced it. */
export const RENDERLIST_VALIDATE_MARKER = "TN_RENDERLIST_VALIDATE";

/** The launch flag. */
export const RENDERLIST_VALIDATE_FLAG = "TN_RENDERLIST_VALIDATE";

/**
 * Elementwise tolerance.
 *
 * The recomputation multiplies the same matrices in the same order as three does, so an exact
 * match is what a correct cache produces; the tolerance exists for the case where a game composed
 * its own matrix in a different order and lands a unit in the last place away.
 */
const TOLERANCE = 1e-6;

/** Whether `TN_RENDERLIST_VALIDATE` asks for validation on this launch. */
export function renderListValidationRequested(): boolean {
  return readLaunchFlag({
    environment: RENDERLIST_VALIDATE_FLAG,
    global: "__tnRenderListValidate",
    query: "tnRenderListValidate",
  });
}

/** What one frame's check found. */
export interface IValidationReport {
  /** Objects whose world matrix was recomputed and compared. */
  readonly checked: number;
  /** Objects skipped because they own their own world matrix; reported, never counted as checked. */
  readonly gameOwned: number;
  /** Frames validated so far. */
  readonly frames: number;
}

const expected = new Matrix4();
const local = new Matrix4();

/**
 * Recomputes every world matrix under `root` and throws on the first that disagrees.
 *
 * The recomputation is deliberately independent of the flags a freeze sets: it composes the local
 * matrix from `position`/`quaternion`/`scale` when the object composes its own, uses the authored
 * `matrix` when it does not, and multiplies by the parent's *recomputed* world matrix rather than
 * the cached one — so an error at the top of a subtree cannot be hidden by a matching error
 * underneath it.
 */
export function validateWorldMatrices(root: Object3D): { checked: number; gameOwned: number } {
  let checked = 0;
  let gameOwned = 0;
  const walk = (object: Object3D, parentWorld: Matrix4 | undefined): void => {
    // An object that owns its own world matrix is not something this may recompute.
    // `matrixWorldAutoUpdate === false` is three's way of saying "I maintain this myself", and the
    // engine's own render projection sets it across its mirror. Recomputing those from the parent
    // chain reports every one of them stale — measured on a real game before this existed, as
    // `Mesh (id 19) has a stale world matrix at element 0: drawing 1 where a full recompute gives
    // 0.5695`. The static freeze is the one exception: it turned the compose off itself, so the
    // authored transform is still the truth and checking the frozen matrix against it is the point.
    const owned = !object.matrixWorldAutoUpdate && !worldSilencedByFreeze(object);
    let basis: Matrix4;
    if (owned) {
      gameOwned += 1;
      basis = object.matrixWorld;
    } else {
      // The authored transform is the reference for anything the freeze silenced, since a frozen
      // object's `matrix` *is* the cache under test. For an object the game drives by writing
      // `matrix`, the matrix is the authored transform.
      if (object.matrixAutoUpdate || composeSilencedByFreeze(object))
        local.compose(object.position, object.quaternion, object.scale);
      else local.copy(object.matrix);
      if (parentWorld === undefined) expected.copy(local);
      else expected.multiplyMatrices(parentWorld, local);
      const actual = object.matrixWorld.elements;
      const wanted = expected.elements;
      for (let element = 0; element < 16; element += 1) {
        const difference = Math.abs((actual[element] ?? 0) - (wanted[element] ?? 0));
        if (difference > TOLERANCE) {
          // Enough to act on. A divergence that names only an element number sends a reader back
          // to the debugger; the flags and the parent are what distinguish "the cache is stale"
          // from "this object is driven by something the walk does not own".
          const label = object.name === "" ? object.type : object.name;
          const parent = object.parent;
          const parentLabel =
            parent === null ? "<root>" : parent.name === "" ? parent.type : parent.name;
          throw new Error(
            `${RENDERLIST_VALIDATE_MARKER}: ${label} (id ${object.id}) has a stale world matrix at element ${element}: drawing ${String(actual[element])} where a full recompute gives ${String(wanted[element])}. matrixAutoUpdate=${String(object.matrixAutoUpdate)} matrixWorldAutoUpdate=${String(object.matrixWorldAutoUpdate)} matrixWorldNeedsUpdate=${String(object.matrixWorldNeedsUpdate)} position=[${object.position.x},${object.position.y},${object.position.z}] parent=${parentLabel} parentAuto=${parent === null ? "n/a" : String(parent.matrixWorldAutoUpdate)}`,
          );
        }
      }
      checked += 1;
      basis = expected;
    }
    if (object.children.length === 0) return;
    // The basis has to survive the recursion and there is one scratch matrix; copying it per level
    // costs 16 writes and keeps the check independent of the cache it is checking.
    const parentForChildren = new Matrix4().copy(basis);
    for (const child of object.children) walk(child, parentForChildren);
  };
  walk(root, root.parent === null ? undefined : root.parent.matrixWorld);
  return { checked, gameOwned };
}

/**
 * The per-frame validator, installed when the flag asks for it.
 *
 * Holds a frame counter so the marker can say how much was proven, which is the difference between
 * "validation passed" and "validation passed on 1,800 frames of the reference game".
 */
export class RenderListValidator {
  #frames = 0;
  #checked = 0;
  #gameOwned = 0;

  /**
   * Validates one frame. Throws on the first divergence.
   *
   * `roots` is the thing being drawn plus every frozen subtree. Those are not the same object
   * when the engine's projection is collapsing the scene: the draw root is then the mirror, and
   * validating only it reported three objects checked and zero divergences on a scene with two
   * hundred frozen meshes, one of which really was stale. A freeze is authored on the authored
   * scene, so the authored roots are checked whether or not they are what reaches the GPU.
   */
  frame(...roots: readonly Object3D[]): void {
    let checked = 0;
    let gameOwned = 0;
    const seen = new Set<Object3D>();
    for (const root of roots) {
      if (seen.has(root)) continue;
      seen.add(root);
      const result = validateWorldMatrices(root);
      checked += result.checked;
      gameOwned += result.gameOwned;
    }
    this.#checked = checked;
    this.#gameOwned = gameOwned;
    this.#frames += 1;
  }

  report(): IValidationReport {
    return { checked: this.#checked, frames: this.#frames, gameOwned: this.#gameOwned };
  }
}

/** The marker line for one reported window. */
export function formatValidationReport(report: IValidationReport): string {
  return `${RENDERLIST_VALIDATE_MARKER}:${JSON.stringify({ ...report, divergences: 0 })}`;
}
