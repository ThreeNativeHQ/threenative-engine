import { requiredAt, requiredValue } from "../../required-at.js";
// Contact manifold between two boxes with up to eight frictional contacts, ported from
// avbd-demo3d manifold.cpp. Each contact has three rows (normal, two tangents) evaluated in
// the manifold basis, with Taylor-expanded constraints (Sec. 4) and a friction cone.
import {
  COLLISION_MARGIN,
  Force,
  type IBodySystem,
  PENALTY_MAX,
  PENALTY_MIN,
  type Rigid,
  STICK_THRESH,
} from "./body.js";
import { collide } from "./collide.js";
import {
  type M3,
  type V3,
  addScaled3,
  addm,
  clamp,
  cross,
  diagonal,
  mat3,
  min,
  mul,
  mulv,
  negm,
  qsub,
  rotate,
  scale3,
  sub3,
  transform,
  transpose,
  vec3,
} from "./math.js";
import type { Solver } from "./solver.js";
export interface IContact {
  feature: number;
  /** Contact offsets in each body's local frame. */
  rA: V3;
  rB: V3;
  /** Constraint at x- (normal, tangent1, tangent2), including the collision margin. */
  C0: V3;
  penalty: V3;
  lambda: V3;
  stick: boolean;
}
// Scratch shared by the (single-threaded) primal/dual updates
const dqALin = vec3();
const dqAAng = vec3();
const dqBLin = vec3();
const dqBAng = vec3();
const rAWorld = vec3();
const rBWorld = vec3();
const jBLin = mat3();
const jAAng = mat3();
const jBAng = mat3();
const K = mat3();
const jLinT = mat3();
const jAngT = mat3();
const jAngTk = mat3();
const tmp = mat3();
const C = vec3();
const F = vec3();
const v = vec3();
const row = vec3();
const xA = vec3();
const xB = vec3();
// Friction magnitude before the cone clamp, and the cone bound, from the last evaluate()
let frictionScale = 0;
let bounds = 0;
/** Rows cross(r, lin row k). */
function angularJacobian(out: M3, r: V3, lin: M3): M3 {
  for (let k = 0; k < 3; k++) {
    row[0] = requiredAt(lin, k * 3);
    row[1] = requiredAt(lin, k * 3 + 1);
    row[2] = requiredAt(lin, k * 3 + 2);
    cross(row, r, row);
    out[k * 3] = requiredAt(row, 0);
    out[k * 3 + 1] = requiredAt(row, 1);
    out[k * 3 + 2] = requiredAt(row, 2);
  }
  return out;
}
export class Manifold extends Force {
  contacts: IContact[] = [];
  /** Rows: normal (pointing from B to A), then the two tangents. */
  readonly basis = mat3();
  friction = 0;
  get numContacts(): number {
    return this.contacts.length;
  }
  initialize(): boolean {
    const bodyA = requiredValue(this.bodyA, "this.bodyA");
    const bodyB = this.bodyB;
    const { solver } = this;
    this.friction = Math.sqrt(bodyA.friction * bodyB.friction);
    // New contacts; carry over state from the previous step by matching feature keys
    const old = this.contacts;
    this.contacts = collide(bodyA, bodyB, this.basis).map((c) => {
      const prev = old.find((o) => o.feature === c.feature);
      if (!prev)
        return {
          feature: c.feature,
          rA: c.rA,
          rB: c.rB,
          C0: vec3(),
          penalty: vec3(),
          lambda: vec3(),
          stick: false,
        };
      // Keep the old anchors only while static friction held them in place
      return {
        feature: c.feature,
        rA: prev.stick ? prev.rA : c.rA,
        rB: prev.stick ? prev.rB : c.rB,
        C0: vec3(),
        penalty: prev.penalty.slice(),
        lambda: prev.lambda.slice(),
        stick: prev.stick,
      };
    });
    for (const c of this.contacts) {
      // Error at x-
      transform(xA, bodyA.positionLin, bodyA.positionAng, c.rA);
      transform(xB, bodyB.positionLin, bodyB.positionAng, c.rB);
      mulv(c.C0, this.basis, sub3(v, xA, xB));
      c.C0[0] = requiredAt(c.C0, 0) + COLLISION_MARGIN;
      // Warm-start the dual variables and penalty parameters (Eq. 19)
      for (let i = 0; i < 3; i++) {
        c.lambda[i] = requiredAt(c.lambda, i) * solver.alpha * solver.gamma;
        c.penalty[i] = clamp(requiredAt(c.penalty, i) * solver.gamma, PENALTY_MIN, PENALTY_MAX);
      }
    }
    return this.contacts.length > 0;
  }
  /**
   * Evaluate contact `c`: Jacobians into the scratch matrices, constraint into C and the
   * cone-clamped force into F, and the friction magnitude and bound into frictionScale/bounds.
   */
  private evaluate(c: IContact, alpha: number): void {
    const bodyA = requiredValue(this.bodyA, "this.bodyA");
    const bodyB = this.bodyB;
    const basis = this.basis;
    rotate(rAWorld, bodyA.positionAng, c.rA);
    rotate(rBWorld, bodyB.positionAng, c.rB);
    // Taylor series approximation of C(x) (Sec. 4)
    negm(jBLin, basis);
    angularJacobian(jAAng, rAWorld, basis);
    angularJacobian(jBAng, rBWorld, jBLin);
    diagonal(K, requiredAt(c.penalty, 0), requiredAt(c.penalty, 1), requiredAt(c.penalty, 2));
    scale3(C, c.C0, 1 - alpha);
    addScaled3(C, C, mulv(v, basis, dqALin), 1);
    addScaled3(C, C, mulv(v, jBLin, dqBLin), 1);
    addScaled3(C, C, mulv(v, jAAng, dqAAng), 1);
    addScaled3(C, C, mulv(v, jBAng, dqBAng), 1);
    // Force, with the normal clamped to push only and friction clamped to the cone
    mulv(F, K, C);
    addScaled3(F, F, c.lambda, 1);
    F[0] = min(requiredAt(F, 0), 0);
    bounds = Math.abs(F[0]) * this.friction;
    frictionScale = Math.sqrt(
      requiredAt(F, 1) * requiredAt(F, 1) + requiredAt(F, 2) * requiredAt(F, 2),
    );
    if (frictionScale > bounds && frictionScale > 0) {
      F[1] = requiredAt(F, 1) * (bounds / frictionScale);
      F[2] = requiredAt(F, 2) * (bounds / frictionScale);
    }
  }
  private computeDisplacements(): void {
    const bodyA = requiredValue(this.bodyA, "this.bodyA");
    const bodyB = this.bodyB;
    sub3(dqALin, bodyA.positionLin, bodyA.initialLin);
    qsub(dqAAng, bodyA.positionAng, bodyA.initialAng);
    sub3(dqBLin, bodyB.positionLin, bodyB.initialLin);
    qsub(dqBAng, bodyB.positionAng, bodyB.initialAng);
  }
  updatePrimal(body: Rigid, alpha: number, sys: IBodySystem): void {
    this.computeDisplacements();
    const isA = body === this.bodyA;
    for (const c of this.contacts) {
      this.evaluate(c, alpha);
      const jLin = isA ? this.basis : jBLin;
      const jAng = isA ? jAAng : jBAng;
      // Stamp into LHS
      transpose(jLinT, jLin);
      transpose(jAngT, jAng);
      mul(jAngTk, jAngT, K);
      addm(sys.lhsLin, mul(tmp, mul(tmp, jLinT, K), jLin));
      addm(sys.lhsAng, mul(tmp, jAngTk, jAng));
      addm(sys.lhsCross, mul(tmp, jAngTk, jLin));
      // Stamp into RHS
      addScaled3(sys.rhsLin, sys.rhsLin, mulv(v, jLinT, F), 1);
      addScaled3(sys.rhsAng, sys.rhsAng, mulv(v, jAngT, F), 1);
    }
  }
  updateDual(alpha: number): void {
    const { solver } = this;
    this.computeDisplacements();
    for (const c of this.contacts) {
      this.evaluate(c, alpha);
      c.lambda.set(F);
      // Ramp the penalty where the force is within its bounds (Eq. 16)
      if (requiredAt(F, 0) < 0)
        c.penalty[0] = min(
          requiredAt(c.penalty, 0) + solver.betaLin * Math.abs(requiredAt(C, 0)),
          PENALTY_MAX,
        );
      if (frictionScale <= bounds) {
        c.penalty[1] = min(
          requiredAt(c.penalty, 1) + solver.betaLin * Math.abs(requiredAt(C, 1)),
          PENALTY_MAX,
        );
        c.penalty[2] = min(
          requiredAt(c.penalty, 2) + solver.betaLin * Math.abs(requiredAt(C, 2)),
          PENALTY_MAX,
        );
        c.stick =
          Math.sqrt(requiredAt(C, 1) * requiredAt(C, 1) + requiredAt(C, 2) * requiredAt(C, 2)) <
          STICK_THRESH;
      }
    }
  }
}
