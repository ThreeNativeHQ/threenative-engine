import { type Object3D, Quaternion, Vector3 } from "three";

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
  const engine = object as Object3D & { __tnCopyMatrixWorld?: unknown };
  if (object.matrixAutoUpdate && engine.__tnCopyMatrixWorld !== undefined) {
    engine.matrixWorldNeedsUpdate = true;
    return;
  }
  object.updateMatrix();
}

/** Draw-only transforms: simulation and queries always retain the solved tick pose. */
export class PhysicsInterpolation {
  readonly enabled: boolean;
  readonly overrideSource: "default" | "defineGame";
  readonly #objects = new Map<Object3D, ITransformHistory>();
  #lastReport = "";

  constructor(enabled?: boolean) {
    if (enabled !== undefined && typeof enabled !== "boolean")
      throw new Error("physicsInterpolation must be a boolean.");
    this.enabled = enabled ?? true;
    this.overrideSource = enabled === undefined ? "default" : "defineGame";
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
    }
    history.references += 1;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      history.references -= 1;
      if (history.references === 0 && this.#objects.get(object) === history)
        this.#objects.delete(object);
    };
  }

  reset(object: Object3D): void {
    const history = this.#objects.get(object);
    if (history === undefined) return;
    history.previousPosition.copy(object.position);
    history.previousRotation.copy(object.quaternion);
    history.currentPosition.copy(object.position);
    history.currentRotation.copy(object.quaternion);
  }

  clear(): void {
    this.#objects.clear();
  }

  beginTick(): void {
    for (const history of this.#objects.values()) {
      history.previousPosition.copy(history.object.position);
      history.previousRotation.copy(history.object.quaternion);
    }
  }

  endTick(): void {
    for (const history of this.#objects.values()) {
      history.currentPosition.copy(history.object.position);
      history.currentRotation.copy(history.object.quaternion);
    }
  }

  render<T>(alpha: number, draw: () => T): T {
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1)
      throw new Error("Interpolation alpha must be in [0, 1].");
    const report = JSON.stringify({
      enabled: this.enabled,
      overrideSource: this.overrideSource,
      trackedObjects: this.#objects.size,
    });
    if (report !== this.#lastReport) {
      this.#lastReport = report;
      console.info(`TN_PHYSICS_INTERPOLATION:${report}`);
    }
    if (!this.enabled || alpha === 1) return draw();
    // Retain the exact participants even if Scene.render changes scenes or unregisters a body.
    const histories = [...this.#objects.values()];
    try {
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
      return draw();
    } finally {
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
    }
  }
}
