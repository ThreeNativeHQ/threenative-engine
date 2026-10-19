/**
 * three's math value classes in JavaScript (three r185's Vector3, MIT), for the browser back end.
 *
 * A `new Vector3()` is a plain JS value: its arithmetic never calls the engine, which cost Midway
 * hundreds of thousands of engine calls at load. A vector the engine owns (`mesh.position`) is the
 * same class over the engine's memory (see `defineBrowserClasses`), so `copy`, `add` and the rest run
 * the same code on both. A value crosses to the engine by value only when an engine call takes it.
 */

interface IVec3 {
  x: number;
  y: number;
  z: number;
}
interface IQuat extends IVec3 {
  w: number;
}
// A Matrix3 reads the first nine.
type Elements = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];
interface IElements {
  readonly elements: Elements;
}
interface IQuaternionScratch extends IQuat {
  setFromEuler(euler: unknown): IQuat;
  setFromAxisAngle(axis: IVec3, angle: number): IQuat;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

/** The JS classes; `quaternion` makes the engine Quaternion `applyEuler` and `applyAxisAngle` use. */
export function defineMath(quaternion: () => IQuaternionScratch) {
  let rotation: IQuaternionScratch | undefined;
  const scratchQuaternion = (): IQuaternionScratch => {
    rotation ??= quaternion();
    return rotation;
  };

  class Vector3 implements IVec3 {
    declare x: number;
    declare y: number;
    declare z: number;
    constructor(x = 0, y = 0, z = 0) {
      this.x = x;
      this.y = y;
      this.z = z;
    }
    set(x: number, y: number, z?: number): this {
      this.x = x;
      this.y = y;
      this.z = z === undefined ? this.z : z;
      return this;
    }
    setScalar(scalar: number): this {
      this.x = scalar;
      this.y = scalar;
      this.z = scalar;
      return this;
    }
    setX(x: number): this {
      this.x = x;
      return this;
    }
    setY(y: number): this {
      this.y = y;
      return this;
    }
    setZ(z: number): this {
      this.z = z;
      return this;
    }
    setComponent(index: number, value: number): this {
      if (index === 0) this.x = value;
      else if (index === 1) this.y = value;
      else if (index === 2) this.z = value;
      else throw new Error(`THREE.Vector3: index is out of range: ${index}`);
      return this;
    }
    getComponent(index: number): number {
      if (index === 0) return this.x;
      if (index === 1) return this.y;
      if (index === 2) return this.z;
      throw new Error(`THREE.Vector3: index is out of range: ${index}`);
    }
    clone(): Vector3 {
      return new Vector3(this.x, this.y, this.z);
    }
    copy(v: IVec3): this {
      this.x = v.x;
      this.y = v.y;
      this.z = v.z;
      return this;
    }
    add(v: IVec3): this {
      this.x += v.x;
      this.y += v.y;
      this.z += v.z;
      return this;
    }
    addScalar(s: number): this {
      this.x += s;
      this.y += s;
      this.z += s;
      return this;
    }
    addVectors(a: IVec3, b: IVec3): this {
      this.x = a.x + b.x;
      this.y = a.y + b.y;
      this.z = a.z + b.z;
      return this;
    }
    addScaledVector(v: IVec3, s: number): this {
      this.x += v.x * s;
      this.y += v.y * s;
      this.z += v.z * s;
      return this;
    }
    sub(v: IVec3): this {
      this.x -= v.x;
      this.y -= v.y;
      this.z -= v.z;
      return this;
    }
    subScalar(s: number): this {
      this.x -= s;
      this.y -= s;
      this.z -= s;
      return this;
    }
    subVectors(a: IVec3, b: IVec3): this {
      this.x = a.x - b.x;
      this.y = a.y - b.y;
      this.z = a.z - b.z;
      return this;
    }
    multiply(v: IVec3): this {
      this.x *= v.x;
      this.y *= v.y;
      this.z *= v.z;
      return this;
    }
    multiplyScalar(scalar: number): this {
      this.x *= scalar;
      this.y *= scalar;
      this.z *= scalar;
      return this;
    }
    multiplyVectors(a: IVec3, b: IVec3): this {
      this.x = a.x * b.x;
      this.y = a.y * b.y;
      this.z = a.z * b.z;
      return this;
    }
    applyEuler(euler: unknown): this {
      return this.applyQuaternion(scratchQuaternion().setFromEuler(euler));
    }
    applyAxisAngle(axis: IVec3, angle: number): this {
      return this.applyQuaternion(scratchQuaternion().setFromAxisAngle(axis, angle));
    }
    applyMatrix3(m: IElements): this {
      const { x, y, z } = this;
      const e = m.elements;
      this.x = e[0] * x + e[3] * y + e[6] * z;
      this.y = e[1] * x + e[4] * y + e[7] * z;
      this.z = e[2] * x + e[5] * y + e[8] * z;
      return this;
    }
    applyNormalMatrix(m: IElements): this {
      return this.applyMatrix3(m).normalize();
    }
    applyMatrix4(m: IElements): this {
      const { x, y, z } = this;
      const e = m.elements;
      const w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
      this.x = (e[0] * x + e[4] * y + e[8] * z + e[12]) * w;
      this.y = (e[1] * x + e[5] * y + e[9] * z + e[13]) * w;
      this.z = (e[2] * x + e[6] * y + e[10] * z + e[14]) * w;
      return this;
    }
    applyQuaternion(q: IQuat): this {
      const vx = this.x;
      const vy = this.y;
      const vz = this.z;
      const { x: qx, y: qy, z: qz, w: qw } = q;
      const tx = 2 * (qy * vz - qz * vy);
      const ty = 2 * (qz * vx - qx * vz);
      const tz = 2 * (qx * vy - qy * vx);
      this.x = vx + qw * tx + qy * tz - qz * ty;
      this.y = vy + qw * ty + qz * tx - qx * tz;
      this.z = vz + qw * tz + qx * ty - qy * tx;
      return this;
    }
    project(camera: { matrixWorldInverse: IElements; projectionMatrix: IElements }): this {
      return this.applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix);
    }
    unproject(camera: { projectionMatrixInverse: IElements; matrixWorld: IElements }): this {
      return this.applyMatrix4(camera.projectionMatrixInverse).applyMatrix4(camera.matrixWorld);
    }
    transformDirection(m: IElements): this {
      const { x, y, z } = this;
      const e = m.elements;
      this.x = e[0] * x + e[4] * y + e[8] * z;
      this.y = e[1] * x + e[5] * y + e[9] * z;
      this.z = e[2] * x + e[6] * y + e[10] * z;
      return this.normalize();
    }
    divide(v: IVec3): this {
      this.x /= v.x;
      this.y /= v.y;
      this.z /= v.z;
      return this;
    }
    divideScalar(scalar: number): this {
      return this.multiplyScalar(1 / scalar);
    }
    min(v: IVec3): this {
      this.x = Math.min(this.x, v.x);
      this.y = Math.min(this.y, v.y);
      this.z = Math.min(this.z, v.z);
      return this;
    }
    max(v: IVec3): this {
      this.x = Math.max(this.x, v.x);
      this.y = Math.max(this.y, v.y);
      this.z = Math.max(this.z, v.z);
      return this;
    }
    clamp(min: IVec3, max: IVec3): this {
      this.x = clamp(this.x, min.x, max.x);
      this.y = clamp(this.y, min.y, max.y);
      this.z = clamp(this.z, min.z, max.z);
      return this;
    }
    clampScalar(minVal: number, maxVal: number): this {
      this.x = clamp(this.x, minVal, maxVal);
      this.y = clamp(this.y, minVal, maxVal);
      this.z = clamp(this.z, minVal, maxVal);
      return this;
    }
    clampLength(min: number, max: number): this {
      const length = this.length();
      return this.divideScalar(length || 1).multiplyScalar(clamp(length, min, max));
    }
    floor(): this {
      this.x = Math.floor(this.x);
      this.y = Math.floor(this.y);
      this.z = Math.floor(this.z);
      return this;
    }
    ceil(): this {
      this.x = Math.ceil(this.x);
      this.y = Math.ceil(this.y);
      this.z = Math.ceil(this.z);
      return this;
    }
    round(): this {
      this.x = Math.round(this.x);
      this.y = Math.round(this.y);
      this.z = Math.round(this.z);
      return this;
    }
    roundToZero(): this {
      this.x = Math.trunc(this.x);
      this.y = Math.trunc(this.y);
      this.z = Math.trunc(this.z);
      return this;
    }
    negate(): this {
      this.x = -this.x;
      this.y = -this.y;
      this.z = -this.z;
      return this;
    }
    dot(v: IVec3): number {
      return this.x * v.x + this.y * v.y + this.z * v.z;
    }
    lengthSq(): number {
      return this.x * this.x + this.y * this.y + this.z * this.z;
    }
    length(): number {
      return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);
    }
    manhattanLength(): number {
      return Math.abs(this.x) + Math.abs(this.y) + Math.abs(this.z);
    }
    normalize(): this {
      return this.divideScalar(this.length() || 1);
    }
    setLength(length: number): this {
      return this.normalize().multiplyScalar(length);
    }
    lerp(v: IVec3, alpha: number): this {
      this.x += (v.x - this.x) * alpha;
      this.y += (v.y - this.y) * alpha;
      this.z += (v.z - this.z) * alpha;
      return this;
    }
    lerpVectors(v1: IVec3, v2: IVec3, alpha: number): this {
      this.x = v1.x + (v2.x - v1.x) * alpha;
      this.y = v1.y + (v2.y - v1.y) * alpha;
      this.z = v1.z + (v2.z - v1.z) * alpha;
      return this;
    }
    cross(v: IVec3): this {
      return this.crossVectors(this, v);
    }
    crossVectors(a: IVec3, b: IVec3): this {
      const { x: ax, y: ay, z: az } = a;
      const { x: bx, y: by, z: bz } = b;
      this.x = ay * bz - az * by;
      this.y = az * bx - ax * bz;
      this.z = ax * by - ay * bx;
      return this;
    }
    projectOnVector(v: Vector3): this {
      const denominator = v.lengthSq();
      if (denominator === 0) return this.set(0, 0, 0);
      const scalar = v.dot(this) / denominator;
      return this.copy(v).multiplyScalar(scalar);
    }
    projectOnPlane(planeNormal: Vector3): this {
      return this.sub(new Vector3().copy(this).projectOnVector(planeNormal));
    }
    reflect(normal: IVec3): this {
      return this.sub(new Vector3().copy(normal).multiplyScalar(2 * this.dot(normal)));
    }
    angleTo(v: Vector3): number {
      const denominator = Math.sqrt(this.lengthSq() * v.lengthSq());
      if (denominator === 0) return Math.PI / 2;
      return Math.acos(clamp(this.dot(v) / denominator, -1, 1));
    }
    distanceTo(v: IVec3): number {
      return Math.sqrt(this.distanceToSquared(v));
    }
    distanceToSquared(v: IVec3): number {
      const dx = this.x - v.x;
      const dy = this.y - v.y;
      const dz = this.z - v.z;
      return dx * dx + dy * dy + dz * dz;
    }
    manhattanDistanceTo(v: IVec3): number {
      return Math.abs(this.x - v.x) + Math.abs(this.y - v.y) + Math.abs(this.z - v.z);
    }
    setFromSphericalCoords(radius: number, phi: number, theta: number): this {
      const sinPhiRadius = Math.sin(phi) * radius;
      this.x = sinPhiRadius * Math.sin(theta);
      this.y = Math.cos(phi) * radius;
      this.z = sinPhiRadius * Math.cos(theta);
      return this;
    }
    setFromCylindricalCoords(radius: number, theta: number, y: number): this {
      this.x = radius * Math.sin(theta);
      this.y = y;
      this.z = radius * Math.cos(theta);
      return this;
    }
    setFromMatrixPosition(m: IElements): this {
      const e = m.elements;
      this.x = e[12];
      this.y = e[13];
      this.z = e[14];
      return this;
    }
    setFromMatrixScale(m: IElements): this {
      const e = m.elements;
      const sx = Math.sqrt(e[0] * e[0] + e[1] * e[1] + e[2] * e[2]);
      const sy = Math.sqrt(e[4] * e[4] + e[5] * e[5] + e[6] * e[6]);
      const sz = Math.sqrt(e[8] * e[8] + e[9] * e[9] + e[10] * e[10]);
      return this.set(sx, sy, sz);
    }
    setFromMatrixColumn(m: IElements, index: number): this {
      return this.fromArray(m.elements, index * 4);
    }
    setFromMatrix3Column(m: IElements, index: number): this {
      return this.fromArray(m.elements, index * 3);
    }
    setFromEuler(e: IVec3): this {
      return this.copy(e);
    }
    setFromColor(c: { r: number; g: number; b: number }): this {
      return this.set(c.r, c.g, c.b);
    }
    equals(v: IVec3): boolean {
      return v.x === this.x && v.y === this.y && v.z === this.z;
    }
    fromArray(array: ArrayLike<number>, offset = 0): this {
      this.x = array[offset] as number;
      this.y = array[offset + 1] as number;
      this.z = array[offset + 2] as number;
      return this;
    }
    toArray(array: number[] = [], offset = 0): number[] {
      array[offset] = this.x;
      array[offset + 1] = this.y;
      array[offset + 2] = this.z;
      return array;
    }
    fromBufferAttribute(
      attribute: { getX(i: number): number; getY(i: number): number; getZ(i: number): number },
      index: number,
    ): this {
      this.x = attribute.getX(index);
      this.y = attribute.getY(index);
      this.z = attribute.getZ(index);
      return this;
    }
    *[Symbol.iterator](): Generator<number> {
      yield this.x;
      yield this.y;
      yield this.z;
    }
  }

  /** three's MathUtils functions the engine binds, as JS: a clamp is not worth an engine call. */
  class MathUtils {
    clamp(value: number, min: number, max: number): number {
      return clamp(value, min, max);
    }
    degToRad(degrees: number): number {
      return degrees * (Math.PI / 180);
    }
    euclideanModulo(n: number, m: number): number {
      return ((n % m) + m) % m;
    }
    lerp(x: number, y: number, t: number): number {
      return (1 - t) * x + t * y;
    }
  }

  return { Vector3, MathUtils };
}
