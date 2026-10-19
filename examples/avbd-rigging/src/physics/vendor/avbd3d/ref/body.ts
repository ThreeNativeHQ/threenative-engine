import { requiredAt } from "../../required-at.js";
// Rigid body and force base, ported from avbd-demo3d (solver.h, rigid.cpp, force.cpp).
// As in the 2D port, the C++ intrusive linked lists (head insertion, newest first) become
// arrays in creation order that the solver walks in reverse where order affects the result.
import { type M3, type V3, length, mat3, quat, vec3 } from "./math.js";
import type { Solver } from "./solver.js";
export const PENALTY_MIN = 1; // Minimum penalty parameter
export const PENALTY_MAX = 10000000000; // Maximum penalty parameter
export const COLLISION_MARGIN = 0.01; // Margin to avoid flickering contacts
export const STICK_THRESH = 0.00001; // Position threshold for sticking contacts (static friction)
export class Rigid {
  readonly solver: Solver;
  readonly forces: Force[] = [];
  readonly positionLin: V3;
  readonly positionAng = quat();
  readonly initialLin = vec3();
  readonly initialAng = quat();
  readonly inertialLin = vec3();
  readonly inertialAng = quat();
  readonly velocityLin: V3;
  readonly velocityAng = vec3();
  readonly prevVelocityLin: V3;
  /** Full widths along each local axis. */
  readonly size: V3;
  mass: number;
  readonly moment: V3;
  friction: number;
  radius: number;
  constructor(
    solver: Solver,
    size: ArrayLike<number>,
    density: number,
    friction: number,
    position: ArrayLike<number>,
    velocity: ArrayLike<number> = [0, 0, 0],
  ) {
    this.solver = solver;
    this.size = vec3(requiredAt(size, 0), requiredAt(size, 1), requiredAt(size, 2));
    this.friction = friction;
    this.positionLin = vec3(
      requiredAt(position, 0),
      requiredAt(position, 1),
      requiredAt(position, 2),
    );
    this.velocityLin = vec3(
      requiredAt(velocity, 0),
      requiredAt(velocity, 1),
      requiredAt(velocity, 2),
    );
    this.prevVelocityLin = vec3(
      requiredAt(velocity, 0),
      requiredAt(velocity, 1),
      requiredAt(velocity, 2),
    );
    // Mass properties and bounding radius
    const avbdTuple1992 = this.size;
    // Mass properties and bounding radius
    const sx = requiredAt(avbdTuple1992, 0);
    // Mass properties and bounding radius
    const sy = requiredAt(avbdTuple1992, 1);
    // Mass properties and bounding radius
    const sz = requiredAt(avbdTuple1992, 2);
    this.mass = sx * sy * sz * density;
    this.moment = vec3(
      ((sy * sy + sz * sz) / 12) * this.mass,
      ((sx * sx + sz * sz) / 12) * this.mass,
      ((sx * sx + sy * sy) / 12) * this.mass,
    );
    this.radius = length([sx * 0.5, sy * 0.5, sz * 0.5]);
    solver.bodies.push(this);
  }
  constrainedTo(other: Rigid): boolean {
    for (const f of this.forces) {
      if ((f.bodyA === this && f.bodyB === other) || (f.bodyA === other && f.bodyB === this))
        return true;
    }
    return false;
  }
}
/** The per-body 6x6 linear system (Eqs. 5, 6): [lin, crossᵀ; cross, ang]·dx = -rhs. */
export interface IBodySystem {
  lhsLin: M3;
  lhsAng: M3;
  lhsCross: M3;
  rhsLin: V3;
  rhsAng: V3;
}
export const bodySystem = (): IBodySystem => ({
  lhsLin: mat3(),
  lhsAng: mat3(),
  lhsCross: mat3(),
  rhsLin: vec3(),
  rhsAng: vec3(),
});
/** Common interface for all forces. When bodyA is null the force attaches bodyB to the world. */
export abstract class Force {
  readonly solver: Solver;
  readonly bodyA: Rigid | null;
  readonly bodyB: Rigid;
  constructor(solver: Solver, bodyA: Rigid | null, bodyB: Rigid) {
    this.solver = solver;
    this.bodyA = bodyA;
    this.bodyB = bodyB;
    solver.forces.push(this);
    bodyA?.forces.push(this);
    bodyB.forces.push(this);
  }
  /** Unlink from the solver and both bodies (the C++ destructor). */
  destroy(): void {
    const list = this.solver.forces;
    const i = list.indexOf(this);
    if (i >= 0) list.splice(i, 1);
    this.unlinkFromBodies();
  }
  /** Unlink from the bodies only; used when the solver rebuilds its own list in bulk. */
  unlinkFromBodies(): void {
    for (const body of [this.bodyA, this.bodyB]) {
      if (!body) continue;
      const i = body.forces.indexOf(this);
      if (i >= 0) body.forces.splice(i, 1);
    }
  }
  /** Cache anything constant over the step and warm-start. Returning false removes the force. */
  abstract initialize(): boolean;
  /** Stamp this force's gradient and Hessian for `body` into its linear system. */
  abstract updatePrimal(body: Rigid, alpha: number, sys: IBodySystem): void;
  abstract updateDual(alpha: number): void;
}
