import { Object3D, type Object3D as Object3DType, Quaternion, Vector3 } from "three";

import { hasCopyMatrixWorldHook } from "./engine-hooks.js";
import { debugRequested, measureDebug } from "./profiling/debug-telemetry.js";

/**
 * The five engine-internal methods the owned engine puts on an `Object3D` for the C++ pose history
 * (PRD-877). Plain three.js has none of them, and the JavaScript loops below stay the path there.
 * `runtime-native/src/engine/abi/bindings_scene.cpp` defines these names; a rename on either side
 * takes every caller down the slow path, which the spec beside this one fails on.
 */
interface IPoseOwner {
  __tnPoseWatch(objects: Object3DType[]): number;
  __tnPoseReset(objects: Object3DType[]): void;
  __tnPoseTick(phase: number): void;
  __tnPoseBlend(alpha: number): void;
  __tnPoseRestore(): void;
}

type PoseOwnerCarrier = Object3DType & Partial<IPoseOwner>;

function poseOwnerOf(object: Object3DType): IPoseOwner | undefined {
  const candidate = object as PoseOwnerCarrier;
  return typeof candidate.__tnPoseTick === "function" &&
    typeof candidate.__tnPoseBlend === "function" &&
    typeof candidate.__tnPoseRestore === "function" &&
    typeof candidate.__tnPoseWatch === "function" &&
    typeof candidate.__tnPoseReset === "function"
    ? (candidate as IPoseOwner)
    : undefined;
}

interface ITransformHistory {
  readonly object: Object3D;
  readonly previousPosition: Vector3;
  readonly previousRotation: Quaternion;
  readonly currentPosition: Vector3;
  readonly currentRotation: Quaternion;
  readonly savedPosition: Vector3;
  readonly savedRotation: Quaternion;
  references: number;
}

/**
 * Arming the object's world-matrix recompose. The engine composes a node's own matrix from
 * `position`/`quaternion`/`scale` at its walk, whenever the world-matrix dirty flag is set — three's
 * `updateMatrix` for a `matrixAutoUpdate` node, done again one instant later. Core's restore used to cross
 * to request exactly that (one `Mesh.updateMatrix` a body a frame, 300 on the stress lab), so on the engine
 * it sets the flag the walk reads instead. The bridge writes that byte in place (`bindings_scene.cpp`
 * `matrixWorldNeedsUpdate`), so the whole restore crosses nothing. Plain three keeps the call, and so does
 * a node the walk will not compose.
 */
function recompose(object: Object3D): void {
  if (object.matrixAutoUpdate && hasCopyMatrixWorldHook(object)) {
    object.matrixWorldNeedsUpdate = true;
    return;
  }
  object.updateMatrix();
}

/** Draw-only transforms: simulation and queries always retain the solved tick pose. */
export class PhysicsInterpolation {
  readonly enabled: boolean;
  readonly overrideSource: "default" | "defineGame";
  readonly #objects = new Map<Object3DType, ITransformHistory>();
  readonly #debug = debugRequested();
  #lastReport = "";
  /** The engine object the C++ history lives on: created lazily, never added to a scene. */
  #ownerInjected: IPoseOwner | null = null;
  #ownerResolved: IPoseOwner | null | undefined;
  /** Bumped whenever the tracked set changes, so the engine is told only when it must be. */
  #membership = 0;
  #watchedMembership = -1;

  constructor(enabled?: boolean, poseOwner?: Object3DType) {
    if (enabled !== undefined && typeof enabled !== "boolean")
      throw new Error("physicsInterpolation must be a boolean.");
    this.enabled = enabled ?? true;
    this.overrideSource = enabled === undefined ? "default" : "defineGame";
    if (poseOwner !== undefined) {
      const owner = poseOwnerOf(poseOwner);
      if (owner === undefined)
        throw new Error("The pose owner must carry the engine's five pose methods.");
      this.#ownerInjected = owner;
    }
  }

  /**
   * The engine path, or null on plain three.js. Resolving it once and keeping the answer means a
   * frame never probes for methods it already knows are absent.
   */
  get #owner(): IPoseOwner | null {
    if (this.#ownerResolved === undefined) {
      if (this.#ownerInjected !== null) this.#ownerResolved = this.#ownerInjected;
      else {
        // The tracked bodies are the objects the host demonstrably built: a game body carries the
        // engine's methods when the host is the engine, and a detached `new Object3D()` created here
        // may not be engine-backed at all. The first body that answers is the owner for all of them.
        let found: IPoseOwner | null = null;
        for (const object of this.#objects.keys()) {
          const candidate = poseOwnerOf(object);
          if (candidate !== undefined) {
            found = candidate;
            break;
          }
        }
        this.#ownerResolved = found;
      }
    }
    return this.#ownerResolved;
  }

  /** Which path this instance took, reported on every membership change. */
  get path(): "engine" | "javascript" {
    return this.#owner === null ? "javascript" : "engine";
  }

  /** Tells the engine the current tracked set, only when it changed since the last time. */
  #watchIfDirty(owner: IPoseOwner): void {
    if (this.#watchedMembership === this.#membership) return;
    owner.__tnPoseWatch([...this.#objects.keys()]);
    this.#watchedMembership = this.#membership;
  }

  /** One region of a frame step, timed only when this launch asked for debug telemetry. */
  #measured<T>(name: string, caller: string, run: () => T): T {
    return this.#debug ? measureDebug(name, "update", caller, run) : run();
  }

  track(object: Object3D): () => void {
    if (object?.isObject3D !== true) throw new Error("interpolate requires a THREE.Object3D.");
    let history = this.#objects.get(object);
    if (history === undefined) {
      history = {
        object,
        previousPosition: object.position.clone(),
        previousRotation: object.quaternion.clone(),
        currentPosition: object.position.clone(),
        currentRotation: object.quaternion.clone(),
        savedPosition: new Vector3(),
        savedRotation: new Quaternion(),
        references: 0,
      };
      this.#objects.set(object, history);
      this.#membership += 1;
      // A body tracked after a plain one may be the first engine-backed object; ask again.
      if (this.#ownerResolved === null) this.#ownerResolved = undefined;
    }
    history.references += 1;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      history.references -= 1;
      if (history.references === 0 && this.#objects.get(object) === history) {
        this.#objects.delete(object);
        this.#membership += 1;
      }
    };
  }

  reset(object: Object3D): void {
    const history = this.#objects.get(object);
    if (history === undefined) return;
    this.#owner?.__tnPoseReset([object]);
    history.previousPosition.copy(object.position);
    history.previousRotation.copy(object.quaternion);
    history.currentPosition.copy(object.position);
    history.currentRotation.copy(object.quaternion);
  }

  clear(): void {
    this.#objects.clear();
    this.#membership += 1;
  }

  beginTick(): void {
    const owner = this.#owner;
    if (owner !== null) {
      this.#watchIfDirty(owner);
      this.#measured("interpolationTick", "PhysicsInterpolation.beginTick", () => owner.__tnPoseTick(0));
      return;
    }
    this.#measured("interpolationTick", "PhysicsInterpolation.beginTick", () => {
      for (const history of this.#objects.values()) {
        history.previousPosition.copy(history.object.position);
        history.previousRotation.copy(history.object.quaternion);
      }
    });
  }

  endTick(): void {
    const owner = this.#owner;
    if (owner !== null) {
      this.#measured("interpolationTick", "PhysicsInterpolation.endTick", () => owner.__tnPoseTick(1));
      return;
    }
    this.#measured("interpolationTick", "PhysicsInterpolation.endTick", () => {
      for (const history of this.#objects.values()) {
        history.currentPosition.copy(history.object.position);
        history.currentRotation.copy(history.object.quaternion);
      }
    });
  }

  render<T>(alpha: number, draw: () => T): T {
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1)
      throw new Error("Interpolation alpha must be in [0, 1].");
    const owner = this.#owner;
    const report = JSON.stringify({
      enabled: this.enabled,
      overrideSource: this.overrideSource,
      path: owner === null ? "javascript" : "engine",
      trackedObjects: this.#objects.size,
    });
    if (report !== this.#lastReport) {
      this.#lastReport = report;
      console.info(`TN_PHYSICS_INTERPOLATION:${report}`);
    }
    if (!this.enabled || alpha === 1) return draw();
    if (owner !== null) {
      // The reference counts, the early returns and the try/finally stay here; the poses move in C++.
      // The watch crosses only when the tracked set changed since the engine last heard of it.
      this.#watchIfDirty(owner);
      this.#measured("interpolationBlend", "PhysicsInterpolation.render", () => owner.__tnPoseBlend(alpha));
      try {
        return draw();
      } finally {
        this.#measured("interpolationRestore", "PhysicsInterpolation.render", () => owner.__tnPoseRestore());
      }
    }
    // Retain the exact participants even if Scene.render changes scenes or unregisters a body.
    const histories = [...this.#objects.values()];
    try {
      this.#measured("interpolationBlend", "PhysicsInterpolation.render", () => {
        for (const history of histories) {
          const { object } = history;
          // An edit outside the fixed update is a discontinuity, never a new tick to blend across.
          if (
            !object.position.equals(history.currentPosition) ||
            !object.quaternion.equals(history.currentRotation)
          )
            this.reset(object);
          history.savedPosition.copy(object.position);
          history.savedRotation.copy(object.quaternion);
          object.position.lerpVectors(history.previousPosition, history.currentPosition, alpha);
          object.quaternion.slerpQuaternions(
            history.previousRotation,
            history.currentRotation,
            alpha,
          );
        }
      });
      return draw();
    } finally {
      this.#measured("interpolationRestore", "PhysicsInterpolation.render", () => {
        for (const history of histories) {
          if (
            history.object.position.equals(history.savedPosition) &&
            history.object.quaternion.equals(history.savedRotation)
          )
            continue;
          history.object.position.copy(history.savedPosition);
          history.object.quaternion.copy(history.savedRotation);
          recompose(history.object);
        }
      });
    }
  }
}
