import { type Camera, Matrix4, type Object3D, Quaternion, Vector3 as Vec3 } from "three";
import { billboardFace } from "./engine-hooks.js";

export type BillboardLockAxis = "x" | "y" | "z";

export interface IBillboard3DOptions {
  /** Camera whose view direction or position the object follows. */
  readonly camera: Camera;
  /** Restrict the facing rotation to one world axis, for example `"y"` for a tree. */
  readonly lockAxis?: BillboardLockAxis;
}

const EPSILON = 1e-12;
const LOCK_AXIS_CODE: Readonly<Record<BillboardLockAxis, number>> = { x: 1, y: 2, z: 3 };

/**
 * Orient one game-owned object toward a camera without owning its geometry or surface.
 *
 * The object is updated only when its owner calls {@link update}; there is no scene-wide registry
 * or per-frame traversal. Perspective cameras face from the object's world position toward the
 * camera, while orthographic cameras use their parallel view direction. The final world rotation
 * is converted back into the object's local space, so a rotated parent remains correct.
 */
export class Billboard3D {
  readonly object: Object3D;
  readonly camera: Camera;
  readonly lockAxis: BillboardLockAxis | undefined;
  readonly #cameraPosition = new Vec3();
  readonly #cameraQuaternion = new Quaternion();
  readonly #direction = new Vec3();
  readonly #objectPosition = new Vec3();
  readonly #objectQuaternion = new Quaternion();
  readonly #parentQuaternion = new Quaternion();
  readonly #screenUp = new Vec3();
  readonly #screenRight = new Vec3();
  readonly #basis = new Matrix4();

  constructor(object: Object3D, options: IBillboard3DOptions) {
    if (object === undefined || object === null)
      throw new Error("Billboard3D.object must be a Three.js object.");
    if (options === undefined || options === null || options.camera === undefined)
      throw new Error("Billboard3D.camera is required.");
    if (
      options.lockAxis !== undefined &&
      options.lockAxis !== "x" &&
      options.lockAxis !== "y" &&
      options.lockAxis !== "z"
    )
      throw new Error("Billboard3D.lockAxis must be 'x', 'y', or 'z'.");
    this.object = object;
    this.camera = options.camera;
    this.lockAxis = options.lockAxis;
  }

  /** Apply the current camera pose to the object and return this helper for fluent setup. */
  update(camera: Camera = this.camera): this {
    if (camera === undefined || camera === null) throw new Error("Billboard3D.camera is required.");
    if (
      billboardFace(
        this.object,
        camera,
        this.lockAxis === undefined ? 0 : LOCK_AXIS_CODE[this.lockAxis],
      )
    )
      return this;
    this.object.updateWorldMatrix(true, false);
    camera.updateWorldMatrix(true, false);
    this.object.getWorldPosition(this.#objectPosition);
    camera.getWorldQuaternion(this.#cameraQuaternion);

    if (camera.type === "OrthographicCamera") {
      this.#direction.set(0, 0, -1).applyQuaternion(this.#cameraQuaternion).negate();
    } else {
      camera.getWorldPosition(this.#cameraPosition);
      this.#direction.subVectors(this.#cameraPosition, this.#objectPosition);
      if (this.#direction.lengthSq() <= EPSILON)
        this.#direction.set(0, 0, -1).applyQuaternion(this.#cameraQuaternion).negate();
    }
    if (this.#direction.lengthSq() <= EPSILON) this.#direction.set(0, 0, 1);
    this.#lockDirection();
    this.#direction.normalize();
    if (this.lockAxis === undefined) {
      this.#setUnrestrictedOrientation();
    } else {
      this.#objectPosition.set(0, 0, 1);
      this.#objectQuaternion.setFromUnitVectors(this.#objectPosition, this.#direction);
    }

    const parent = this.object.parent;
    if (parent === null) {
      this.object.quaternion.copy(this.#objectQuaternion);
      return this;
    }
    parent.updateWorldMatrix(true, false);
    parent.getWorldQuaternion(this.#parentQuaternion);
    this.object.quaternion.copy(this.#parentQuaternion).invert().multiply(this.#objectQuaternion);
    return this;
  }

  #setUnrestrictedOrientation(): void {
    this.#screenUp
      .set(0, 1, 0)
      .applyQuaternion(this.#cameraQuaternion)
      .projectOnPlane(this.#direction);
    if (this.#screenUp.lengthSq() <= EPSILON) {
      this.#screenUp
        .set(1, 0, 0)
        .applyQuaternion(this.#cameraQuaternion)
        .projectOnPlane(this.#direction);
    }
    if (this.#screenUp.lengthSq() <= EPSILON) {
      this.#screenUp.set(0, 1, 0);
      if (Math.abs(this.#screenUp.dot(this.#direction)) >= 1 - EPSILON) this.#screenUp.set(1, 0, 0);
      this.#screenUp.projectOnPlane(this.#direction);
    }
    this.#screenUp.normalize();
    this.#screenRight.crossVectors(this.#screenUp, this.#direction).normalize();
    this.#basis.makeBasis(this.#screenRight, this.#screenUp, this.#direction);
    this.#objectQuaternion.setFromRotationMatrix(this.#basis);
  }

  #lockDirection(): void {
    if (this.lockAxis === undefined) return;
    if (this.lockAxis === "x") this.#direction.x = 0;
    if (this.lockAxis === "y") this.#direction.y = 0;
    if (this.lockAxis === "z") this.#direction.z = 0;
    if (this.#direction.lengthSq() > EPSILON) return;

    // A camera on the locked axis has no unique heading. Keep a stable valid heading in the
    // remaining plane rather than producing NaNs or allowing a one-frame roll.
    if (this.lockAxis === "z") this.#direction.set(1, 0, 0);
    else this.#direction.set(0, 0, 1);
  }
}
