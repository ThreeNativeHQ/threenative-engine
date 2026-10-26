import { Matrix4, type Object3D, Vector3 } from "three";
import { measureThreePose, posedBounds } from "./pose-measure.js";

export interface IGroundSnapOptions {
  /** Whether to apply the correction. Measurement and `clearance` continue when this is false. */
  readonly enabled?: boolean;
  /**
   * Maximum downward correction speed in metres per second. Unset follows the authored pose
   * exactly. A pose below the surface is still raised at once: the rate stops the snap pulling a
   * run cycle's flight phase onto the floor, where the leading foot skates, and never lets a foot
   * sink through it.
   */
  readonly maxRate?: number;
  /** Visual meshes to measure. Defaults to every mesh below `model`. */
  readonly meshes?: readonly Object3D[];
}

/**
 * Keeps the lowest posed point of a rendered model on a surface.
 *
 * This is render grounding, not collider snap-to-ground. It uses a cached skin envelope so a
 * frame loop never runs the precise per-vertex bounds path. `enabled` is deliberately a range:
 * turning correction off still leaves `clearance` and `audit()` truthful.
 */
export class GroundSnap {
  readonly model: Object3D;
  readonly meshes: readonly Object3D[] | undefined;
  enabled: boolean;
  maxRate: number | undefined;
  clearance: number | null = null;
  private readonly parentInverse = new Matrix4();
  private readonly parentOrigin = new Vector3();
  private readonly parentTarget = new Vector3();

  constructor(model: Object3D, options: IGroundSnapOptions = {}) {
    this.model = model;
    this.meshes = options.meshes;
    this.enabled = options.enabled ?? true;
    this.maxRate = options.maxRate;
    validateMaxRate(this.maxRate);
  }

  /** Move `group` so its lowest posed point meets `surfaceY`, then report the real clearance. */
  apply(group: Object3D, surfaceY: number, dt: number): void {
    if (!Number.isFinite(surfaceY)) throw new Error("GroundSnap surfaceY must be finite.");
    if (!Number.isFinite(dt) || dt < 0)
      throw new Error("GroundSnap dt must be finite and non-negative.");
    validateMaxRate(this.maxRate);

    const before = posedBounds(this.model, this.meshes);
    if (!Number.isFinite(before.min[1])) {
      this.clearance = null;
      return;
    }

    const desired = surfaceY - before.min[1];
    const correction =
      this.maxRate === undefined || desired > 0 ? desired : Math.max(desired, -this.maxRate * dt);
    if (this.enabled) this.applyWorldCorrection(group, correction);

    // Re-read after the move. The group may be under a scaled or rotated parent, so the local
    // correction is not always one world metre for one local metre. posedBounds forces its own
    // whole-subtree matrix pass, so no explicit update here — that was a second full pass per
    // grounded character per frame buying nothing the measurement below does not redo.
    const after = posedBounds(this.model, this.meshes);
    this.clearance = after.min[1] - surfaceY;
  }

  private applyWorldCorrection(group: Object3D, correction: number): void {
    const parent = group.parent;
    if (parent === null) {
      group.position.y += correction;
      return;
    }

    parent.updateWorldMatrix(true, false);
    this.parentInverse.copy(parent.matrixWorld).invert();
    this.parentOrigin.set(0, 0, 0).applyMatrix4(this.parentInverse);
    this.parentTarget.set(0, correction, 0).applyMatrix4(this.parentInverse);
    group.position.add(this.parentTarget.sub(this.parentOrigin));
  }

  /**
   * Compare the cheap envelope's lower bound with a precise vertex measurement.
   *
   * This is intentionally opt-in: calling it in `apply()` would restore the frame-time defect
   * this class exists to remove. A negative result means the envelope is below the precise skin.
   */
  audit(): number | null {
    const estimate = posedBounds(this.model, this.meshes);
    const precise = measureThreePose(this.model, { bounds: this.meshes }).bounds;
    if (precise === null || !Number.isFinite(estimate.min[1])) return null;
    return estimate.min[1] - precise.min[1];
  }
}

function validateMaxRate(maxRate: number | undefined): void {
  if (maxRate !== undefined && (!Number.isFinite(maxRate) || maxRate < 0)) {
    throw new Error("GroundSnap maxRate must be finite and non-negative.");
  }
}
