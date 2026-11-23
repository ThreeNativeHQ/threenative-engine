import { Object3D, Vector3 } from "three";

/**
 * A uniform wind, Unreal's WindDirectionalSource in its simplest form: one world velocity in metres per
 * second. A skinned `SoftBody3D` at the same scene root reads the sum of every `WindField3D` there each
 * step, unless its own `wind` option overrides it. `windAt` gives any other system (spring bones, grass)
 * the same value.
 * @situation make a cape or flag blow in the wind
 * @situation wind that moves cloth and hair
 * @override velocity; a SoftBody3D `wind` option replaces the scene's fields for that cloth
 * @example const wind = ctx.add(new WindField3D([4, 0, 0])); wind.velocity.set(6, 0, 1);
 */
export class WindField3D extends Object3D {
  readonly isWindField3D = true;
  /** World wind velocity, m/s. */
  readonly velocity: Vector3;

  constructor(velocity: readonly [number, number, number] = [0, 0, 0]) {
    super();
    if (!velocity.every(Number.isFinite)) throw new Error("WindField3D velocity must be finite.");
    this.velocity = new Vector3(...velocity);
  }
}

/**
 * Sum of the velocities of every `WindField3D` directly under `root` (the scene), into `out`.
 * @situation read the scene's wind for hair, grass or particles
 */
export function windAt(root: Object3D | null, out: Vector3): Vector3 {
  out.set(0, 0, 0);
  if (root === null) return out;
  for (const child of root.children)
    if ((child as Partial<WindField3D>).isWindField3D === true)
      out.add((child as WindField3D).velocity);
  return out;
}
