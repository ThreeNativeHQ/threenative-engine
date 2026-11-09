/**
 * `three/addons/animation/CCDIKSolver.js` as the engine back ends provide it: three's CCD solver,
 * ported from three r187 examples/jsm/animation/CCDIKSolver.js (MIT), over whichever engine `three`
 * names in this build, the V8 facade or the Wasm entry. Every call it makes is a bound engine method.
 * The scratch values are per solver, not module-level, so importing the addon creates no engine object.
 * CCDIKHelper is not ported: `createHelper` refuses by name.
 */
import { type Bone, Matrix4, Quaternion, type SkinnedMesh, Vector3 } from "three";

export interface IIkLink {
  index: number;
  enabled?: boolean;
  limitation?: Vector3;
  rotationMin?: Vector3;
  rotationMax?: Vector3;
}

export interface IIkChain {
  target: number;
  effector: number;
  links: IIkLink[];
  iteration?: number;
  minAngle?: number;
  maxAngle?: number;
  blendFactor?: number;
}

// MathUtils.euclideanModulo.
const modulo = (n: number, m: number) => ((n % m) + m) % m;

export class CCDIKSolver {
  readonly #quaternion = new Quaternion();
  readonly #targetPos = new Vector3();
  readonly #targetVec = new Vector3();
  readonly #effectorPos = new Vector3();
  readonly #effectorVec = new Vector3();
  readonly #linkPos = new Vector3();
  readonly #invLinkQ = new Quaternion();
  readonly #linkScale = new Vector3();
  readonly #axis = new Vector3();
  readonly #vector = new Vector3();
  readonly #center = new Vector3();
  readonly #workingQuaternion = new Quaternion();
  readonly #initialQuaternions: Quaternion[][];

  constructor(
    readonly mesh: SkinnedMesh,
    readonly iks: IIkChain[] = [],
  ) {
    this.#initialQuaternions = iks.map((ik) => ik.links.map(() => new Quaternion()));
    this.#valid();
  }

  update(globalBlendFactor = 1.0): this {
    for (const ik of this.iks) this.updateOne(ik, globalBlendFactor);
    return this;
  }

  updateOne(ik: IIkChain, overrideBlend = 1.0): this {
    const chainBlend = ik.blendFactor ?? overrideBlend;
    const bones = this.mesh.skeleton.bones;
    const initialQuaternions = this.#initialQuaternions[this.iks.indexOf(ik)] ?? [];
    const effector = bones[ik.effector] as Bone;
    const target = bones[ik.target] as Bone;
    // three reads matrixWorld, not getWorldPosition(), which updates the world matrices first.
    this.#targetPos.setFromMatrixPosition(target.matrixWorld);
    const links = ik.links;
    if (chainBlend < 1.0)
      for (const [j, link] of links.entries())
        initialQuaternions[j]?.copy((bones[link.index] as Bone).quaternion);
    for (let i = 0; i < (ik.iteration ?? 1); i++) if (!this.#iterate(ik, bones, effector)) break;
    if (chainBlend < 1.0) this.#blend(links, bones, initialQuaternions, chainBlend);
    return this;
  }

  createHelper(): never {
    throw new Error(
      "TN_NATIVE_UNSUPPORTED_CCDIKHELPER: CCDIKSolver.createHelper needs three's CCDIKHelper, which the engine does not bind; draw the chain from skeleton.bones instead.",
    );
  }

  // One pass over the chain; false when no link turned, which ends the solve.
  #iterate(ik: IIkChain, bones: Bone[], effector: Bone): boolean {
    let rotated = false;
    for (const entry of ik.links) {
      // An off link stops the chain here.
      if (entry.enabled === false) break;
      if (this.#rotateLink(ik, entry, bones[entry.index] as Bone, effector)) rotated = true;
    }
    return rotated;
  }

  // A chain blend under 1 slerps each link from its pose before the solve toward the solved pose.
  #blend(links: IIkLink[], bones: Bone[], initial: Quaternion[], chainBlend: number): void {
    for (const [j, entry] of links.entries()) {
      const link = bones[entry.index] as Bone;
      this.#workingQuaternion.copy(initial[j] as Quaternion).slerp(link.quaternion, chainBlend);
      link.quaternion.copy(this.#workingQuaternion);
      link.updateMatrixWorld(true);
    }
  }

  // One CCD step on one link: rotate it so the effector points at the target. False when the angle
  // is too small to turn, which three skips to prevent bone vibration.
  #rotateLink(ik: IIkChain, entry: IIkLink, link: Bone, effector: Bone): boolean {
    link.matrixWorld.decompose(this.#linkPos, this.#invLinkQ, this.#linkScale);
    this.#invLinkQ.invert();
    this.#effectorPos.setFromMatrixPosition(effector.matrixWorld);
    // Work in the link's world frame.
    this.#effectorVec
      .subVectors(this.#effectorPos, this.#linkPos)
      .applyQuaternion(this.#invLinkQ)
      .normalize();
    this.#targetVec
      .subVectors(this.#targetPos, this.#linkPos)
      .applyQuaternion(this.#invLinkQ)
      .normalize();
    let angle = Math.acos(Math.min(1, Math.max(-1, this.#targetVec.dot(this.#effectorVec))));
    if (angle < 1e-5) return false;
    if (ik.minAngle !== undefined && angle < ik.minAngle) angle = ik.minAngle;
    if (ik.maxAngle !== undefined && angle > ik.maxAngle) angle = ik.maxAngle;
    this.#axis.crossVectors(this.#effectorVec, this.#targetVec).normalize();
    this.#quaternion.setFromAxisAngle(this.#axis, angle);
    link.quaternion.multiply(this.#quaternion);
    this.#limit(entry, link);
    link.updateMatrixWorld(true);
    return true;
  }

  // three's link limits: a hinge axis, then Euler angle bounds.
  #limit(entry: IIkLink, link: Bone): void {
    const { limitation, rotationMin, rotationMax } = entry;
    if (limitation !== undefined) {
      const q = link.quaternion;
      const c = Math.min(q.w, 1.0);
      // Keep the sign of the rotation along the limitation axis; else a negative turn mirrors.
      const dot = q.x * limitation.x + q.y * limitation.y + q.z * limitation.z;
      const c2 = (dot < 0 ? -1 : 1) * Math.sqrt(1 - c * c);
      q.set(limitation.x * c2, limitation.y * c2, limitation.z * c2, c);
    }
    if (rotationMin !== undefined || rotationMax !== undefined) {
      const v = this.#vector.setFromEuler(link.rotation);
      if (rotationMin !== undefined && rotationMax !== undefined) {
        // Wrap each angle to within pi of the limits' centre, so a range across +-pi clamps right.
        const c = this.#center.addVectors(rotationMin, rotationMax).multiplyScalar(0.5);
        v.x = c.x + modulo(v.x - c.x + Math.PI, 2 * Math.PI) - Math.PI;
        v.y = c.y + modulo(v.y - c.y + Math.PI, 2 * Math.PI) - Math.PI;
        v.z = c.z + modulo(v.z - c.z + Math.PI, 2 * Math.PI) - Math.PI;
      }
      if (rotationMin !== undefined) v.max(rotationMin);
      if (rotationMax !== undefined) v.min(rotationMax);
      link.rotation.setFromVector3(v);
    }
  }

  #valid(): void {
    const bones = this.mesh.skeleton.bones;
    for (const ik of this.iks) {
      let child = bones[ik.effector] as Bone;
      for (const entry of ik.links) {
        const parent = bones[entry.index] as Bone;
        if (child.parent !== parent)
          console.warn(
            `THREE.CCDIKSolver: bone ${child.name} is not the child of bone ${parent.name}`,
          );
        child = parent;
      }
    }
  }
}
