import { requiredAt } from "../../required-at.js";
// Vector, quaternion and 3x3 helpers matching avbd-demo3d's maths.h operation for operation,
// so the f64 port reproduces the C++ (compiled in double) to round-off. Everything writes to
// an `out` argument (safe to alias with the inputs) to keep the solver loops allocation-free.
// Matrices are row-major Float64Array(9); quaternions are (x, y, z, w).
export type V3 = Float64Array;
export type Quat = Float64Array;
export type M3 = Float64Array;
export const vec3 = (x = 0, y = 0, z = 0): V3 => Float64Array.of(x, y, z);
export const quat = (x = 0, y = 0, z = 0, w = 1): Quat => Float64Array.of(x, y, z, w);
export const mat3 = (): M3 => new Float64Array(9);
export const rad = (deg: number): number => deg * 0.017453292519943295;
export const sign = (x: number): number => (x < 0 ? -1 : x > 0 ? 1 : 0);
export const min = (a: number, b: number): number => (a < b ? a : b);
export const max = (a: number, b: number): number => (a > b ? a : b);
export const clamp = (x: number, a: number, b: number): number => max(a, min(b, x));
// float3
export const dot = (a: ArrayLike<number>, b: ArrayLike<number>): number =>
  requiredAt(a, 0) * requiredAt(b, 0) +
  requiredAt(a, 1) * requiredAt(b, 1) +
  requiredAt(a, 2) * requiredAt(b, 2);
export const lengthSq = (v: ArrayLike<number>): number => dot(v, v);
export const length = (v: ArrayLike<number>): number => Math.sqrt(lengthSq(v));
export function set3(out: V3, x: number, y: number, z: number): V3 {
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}
export const add3 = (out: V3, a: ArrayLike<number>, b: ArrayLike<number>): V3 =>
  set3(
    out,
    requiredAt(a, 0) + requiredAt(b, 0),
    requiredAt(a, 1) + requiredAt(b, 1),
    requiredAt(a, 2) + requiredAt(b, 2),
  );
export const sub3 = (out: V3, a: ArrayLike<number>, b: ArrayLike<number>): V3 =>
  set3(
    out,
    requiredAt(a, 0) - requiredAt(b, 0),
    requiredAt(a, 1) - requiredAt(b, 1),
    requiredAt(a, 2) - requiredAt(b, 2),
  );
export const scale3 = (out: V3, a: ArrayLike<number>, s: number): V3 =>
  set3(out, requiredAt(a, 0) * s, requiredAt(a, 1) * s, requiredAt(a, 2) * s);
export const div3 = (out: V3, a: ArrayLike<number>, s: number): V3 =>
  set3(out, requiredAt(a, 0) / s, requiredAt(a, 1) / s, requiredAt(a, 2) / s);
export const neg3 = (out: V3, a: ArrayLike<number>): V3 =>
  set3(out, -requiredAt(a, 0), -requiredAt(a, 1), -requiredAt(a, 2));
export const abs3 = (out: V3, a: ArrayLike<number>): V3 =>
  set3(out, Math.abs(requiredAt(a, 0)), Math.abs(requiredAt(a, 1)), Math.abs(requiredAt(a, 2)));
/** out = a + b * s */
export const addScaled3 = (out: V3, a: ArrayLike<number>, b: ArrayLike<number>, s: number): V3 =>
  set3(
    out,
    requiredAt(a, 0) + requiredAt(b, 0) * s,
    requiredAt(a, 1) + requiredAt(b, 1) * s,
    requiredAt(a, 2) + requiredAt(b, 2) * s,
  );
export const normalize3 = (out: V3, v: ArrayLike<number>): V3 => div3(out, v, length(v));
export const cross = (out: V3, a: ArrayLike<number>, b: ArrayLike<number>): V3 =>
  set3(
    out,
    requiredAt(a, 1) * requiredAt(b, 2) - requiredAt(a, 2) * requiredAt(b, 1),
    requiredAt(a, 2) * requiredAt(b, 0) - requiredAt(a, 0) * requiredAt(b, 2),
    requiredAt(a, 0) * requiredAt(b, 1) - requiredAt(a, 1) * requiredAt(b, 0),
  );
// quat
export function set4(out: Quat, x: number, y: number, z: number, w: number): Quat {
  out[0] = x;
  out[1] = y;
  out[2] = z;
  out[3] = w;
  return out;
}
export function qmul(out: Quat, a: ArrayLike<number>, b: ArrayLike<number>): Quat {
  const ax = requiredAt(a, 0);
  const ay = requiredAt(a, 1);
  const az = requiredAt(a, 2);
  const aw = requiredAt(a, 3);
  const bx = requiredAt(b, 0);
  const by = requiredAt(b, 1);
  const bz = requiredAt(b, 2);
  const bw = requiredAt(b, 3);
  return set4(
    out,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  );
}
export const conjugate = (out: Quat, q: ArrayLike<number>): Quat =>
  set4(out, -requiredAt(q, 0), -requiredAt(q, 1), -requiredAt(q, 2), requiredAt(q, 3));
export const qlengthSq = (q: ArrayLike<number>): number =>
  lengthSq(q) + requiredAt(q, 3) * requiredAt(q, 3);
export function qinverse(out: Quat, q: ArrayLike<number>): Quat {
  const l = qlengthSq(q);
  return set4(
    out,
    -requiredAt(q, 0) / l,
    -requiredAt(q, 1) / l,
    -requiredAt(q, 2) / l,
    requiredAt(q, 3) / l,
  );
}
export function qnormalize(out: Quat, q: ArrayLike<number>): Quat {
  const l = Math.sqrt(qlengthSq(q));
  return set4(
    out,
    requiredAt(q, 0) / l,
    requiredAt(q, 1) / l,
    requiredAt(q, 2) / l,
    requiredAt(q, 3) / l,
  );
}
const qs = new Float64Array(4);
const qs2 = new Float64Array(4);
/** The demo's `quat - quat`: rotation vector (small angle) taking b to a, 2·vec(a·b⁻¹). */
export function qsub(out: V3, a: ArrayLike<number>, b: ArrayLike<number>): V3 {
  qmul(qs, a, qinverse(qs, b));
  return set3(out, requiredAt(qs, 0) * 2, requiredAt(qs, 1) * 2, requiredAt(qs, 2) * 2);
}
/** The demo's `quat + float3`: integrate a rotation vector, normalize(a + (b, 0)·a·½). */
export function qaddv(out: Quat, a: ArrayLike<number>, b: ArrayLike<number>): Quat {
  set4(qs2, requiredAt(b, 0), requiredAt(b, 1), requiredAt(b, 2), 0);
  qmul(qs2, qs2, a);
  return qnormalize(
    out,
    set4(
      out,
      requiredAt(a, 0) + requiredAt(qs2, 0) * 0.5,
      requiredAt(a, 1) + requiredAt(qs2, 1) * 0.5,
      requiredAt(a, 2) + requiredAt(qs2, 2) * 0.5,
      requiredAt(a, 3) + requiredAt(qs2, 3) * 0.5,
    ),
  );
}
export function rotate(out: V3, q: ArrayLike<number>, v: ArrayLike<number>): V3 {
  const ux = requiredAt(q, 0);
  const uy = requiredAt(q, 1);
  const uz = requiredAt(q, 2);
  const w = requiredAt(q, 3);
  const tx = (uy * requiredAt(v, 2) - uz * requiredAt(v, 1)) * 2;
  const ty = (uz * requiredAt(v, 0) - ux * requiredAt(v, 2)) * 2;
  const tz = (ux * requiredAt(v, 1) - uy * requiredAt(v, 0)) * 2;
  return set3(
    out,
    requiredAt(v, 0) + tx * w + (uy * tz - uz * ty),
    requiredAt(v, 1) + ty * w + (uz * tx - ux * tz),
    requiredAt(v, 2) + tz * w + (ux * ty - uy * tx),
  );
}
const ts = new Float64Array(3);
export function transform(
  out: V3,
  p: ArrayLike<number>,
  q: ArrayLike<number>,
  v: ArrayLike<number>,
): V3 {
  rotate(ts, q, v);
  return add3(out, ts, p);
}
/** Rotate by the conjugate of q (world to body-local for a unit quaternion). */
export function rotateInv(out: V3, q: ArrayLike<number>, v: ArrayLike<number>): V3 {
  return rotate(out, conjugate(qs, q), v);
}
// float3x3 (row-major)
export function diagonal(out: M3, a: number, b: number, c: number): M3 {
  out.fill(0);
  out[0] = a;
  out[4] = b;
  out[8] = c;
  return out;
}
export function skew(out: M3, r: ArrayLike<number>): M3 {
  out[0] = 0;
  out[1] = -requiredAt(r, 2);
  out[2] = requiredAt(r, 1);
  out[3] = requiredAt(r, 2);
  out[4] = 0;
  out[5] = -requiredAt(r, 0);
  out[6] = -requiredAt(r, 1);
  out[7] = requiredAt(r, 0);
  out[8] = 0;
  return out;
}
export function transpose(out: M3, a: M3): M3 {
  const a1 = requiredAt(a, 1);
  const a2 = requiredAt(a, 2);
  const a5 = requiredAt(a, 5);
  out[0] = requiredAt(a, 0);
  out[1] = requiredAt(a, 3);
  out[2] = requiredAt(a, 6);
  out[3] = a1;
  out[4] = requiredAt(a, 4);
  out[5] = requiredAt(a, 7);
  out[6] = a2;
  out[7] = a5;
  out[8] = requiredAt(a, 8);
  return out;
}
/** out = a · b, each entry dot(a.row(i), b.col(j)) as in maths.h. */
export function mul(out: M3, a: M3, b: M3): M3 {
  const a0 = requiredAt(a, 0);
  const a1 = requiredAt(a, 1);
  const a2 = requiredAt(a, 2);
  const a3 = requiredAt(a, 3);
  const a4 = requiredAt(a, 4);
  const a5 = requiredAt(a, 5);
  const a6 = requiredAt(a, 6);
  const a7 = requiredAt(a, 7);
  const a8 = requiredAt(a, 8);
  const b0 = requiredAt(b, 0);
  const b1 = requiredAt(b, 1);
  const b2 = requiredAt(b, 2);
  const b3 = requiredAt(b, 3);
  const b4 = requiredAt(b, 4);
  const b5 = requiredAt(b, 5);
  const b6 = requiredAt(b, 6);
  const b7 = requiredAt(b, 7);
  const b8 = requiredAt(b, 8);
  out[0] = a0 * b0 + a1 * b3 + a2 * b6;
  out[1] = a0 * b1 + a1 * b4 + a2 * b7;
  out[2] = a0 * b2 + a1 * b5 + a2 * b8;
  out[3] = a3 * b0 + a4 * b3 + a5 * b6;
  out[4] = a3 * b1 + a4 * b4 + a5 * b7;
  out[5] = a3 * b2 + a4 * b5 + a5 * b8;
  out[6] = a6 * b0 + a7 * b3 + a8 * b6;
  out[7] = a6 * b1 + a7 * b4 + a8 * b7;
  out[8] = a6 * b2 + a7 * b5 + a8 * b8;
  return out;
}
export function mulv(out: V3, a: M3, v: ArrayLike<number>): V3 {
  const x = requiredAt(v, 0);
  const y = requiredAt(v, 1);
  const z = requiredAt(v, 2);
  return set3(
    out,
    requiredAt(a, 0) * x + requiredAt(a, 1) * y + requiredAt(a, 2) * z,
    requiredAt(a, 3) * x + requiredAt(a, 4) * y + requiredAt(a, 5) * z,
    requiredAt(a, 6) * x + requiredAt(a, 7) * y + requiredAt(a, 8) * z,
  );
}
export function addm(out: M3, a: M3): M3 {
  for (let i = 0; i < 9; i++) out[i] = requiredAt(out, i) + requiredAt(a, i);
  return out;
}
export function scalem(out: M3, a: M3, s: number): M3 {
  for (let i = 0; i < 9; i++) out[i] = requiredAt(a, i) * s;
  return out;
}
export function negm(out: M3, a: M3): M3 {
  for (let i = 0; i < 9; i++) out[i] = -requiredAt(a, i);
  return out;
}
/** outer(a, b): rows b·a.x, b·a.y, b·a.z. */
export function outer(out: M3, a: ArrayLike<number>, b: ArrayLike<number>): M3 {
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) out[i * 3 + j] = requiredAt(b, j) * requiredAt(a, i);
  return out;
}
/** Diagonal of the column norms (the paper's lumped geometric stiffness, Sec. 3.5). */
export function diagonalize(out: M3, m: M3): M3 {
  const c0 = Math.sqrt(
    requiredAt(m, 0) * requiredAt(m, 0) +
      requiredAt(m, 3) * requiredAt(m, 3) +
      requiredAt(m, 6) * requiredAt(m, 6),
  );
  const c1 = Math.sqrt(
    requiredAt(m, 1) * requiredAt(m, 1) +
      requiredAt(m, 4) * requiredAt(m, 4) +
      requiredAt(m, 7) * requiredAt(m, 7),
  );
  const c2 = Math.sqrt(
    requiredAt(m, 2) * requiredAt(m, 2) +
      requiredAt(m, 5) * requiredAt(m, 5) +
      requiredAt(m, 8) * requiredAt(m, 8),
  );
  return diagonal(out, c0, c1, c2);
}
/** Rows (n, t1, t2): the contact basis with the normal first. */
export function orthonormal(out: M3, n: ArrayLike<number>): M3 {
  const t1 =
    Math.abs(requiredAt(n, 0)) > Math.abs(requiredAt(n, 2))
      ? vec3(-requiredAt(n, 1), requiredAt(n, 0), 0)
      : vec3(0, -requiredAt(n, 2), requiredAt(n, 1));
  normalize3(t1, t1);
  const t2 = cross(vec3(), n, t1);
  out[0] = requiredAt(n, 0);
  out[1] = requiredAt(n, 1);
  out[2] = requiredAt(n, 2);
  out.set(t1, 3);
  out.set(t2, 6);
  return out;
}
/**
 * Solve the 6x6 SPD system [aLin aCrossᵀ; aCross aAng]·x = b with an LDLᵀ decomposition
 * (maths.h `solve`). Only the lower triangle is read.
 */
export function solve6(
  aLin: M3,
  aAng: M3,
  aCross: M3,
  bLin: ArrayLike<number>,
  bAng: ArrayLike<number>,
  xLin: V3,
  xAng: V3,
): void {
  const A11 = requiredAt(aLin, 0);
  const A21 = requiredAt(aLin, 3);
  const A22 = requiredAt(aLin, 4);
  const A31 = requiredAt(aLin, 6);
  const A32 = requiredAt(aLin, 7);
  const A33 = requiredAt(aLin, 8);
  const A41 = requiredAt(aCross, 0);
  const A42 = requiredAt(aCross, 1);
  const A43 = requiredAt(aCross, 2);
  const A44 = requiredAt(aAng, 0);
  const A51 = requiredAt(aCross, 3);
  const A52 = requiredAt(aCross, 4);
  const A53 = requiredAt(aCross, 5);
  const A54 = requiredAt(aAng, 3);
  const A55 = requiredAt(aAng, 4);
  const A61 = requiredAt(aCross, 6);
  const A62 = requiredAt(aCross, 7);
  const A63 = requiredAt(aCross, 8);
  const A64 = requiredAt(aAng, 6);
  const A65 = requiredAt(aAng, 7);
  const A66 = requiredAt(aAng, 8);
  const L21 = A21 / A11;
  const L31 = A31 / A11;
  const L41 = A41 / A11;
  const L51 = A51 / A11;
  const L61 = A61 / A11;
  const D1 = A11;
  const D2 = A22 - L21 * L21 * D1;
  const L32 = (A32 - L21 * L31 * D1) / D2;
  const L42 = (A42 - L21 * L41 * D1) / D2;
  const L52 = (A52 - L21 * L51 * D1) / D2;
  const L62 = (A62 - L21 * L61 * D1) / D2;
  const D3 = A33 - (L31 * L31 * D1 + L32 * L32 * D2);
  const L43 = (A43 - L31 * L41 * D1 - L32 * L42 * D2) / D3;
  const L53 = (A53 - L31 * L51 * D1 - L32 * L52 * D2) / D3;
  const L63 = (A63 - L31 * L61 * D1 - L32 * L62 * D2) / D3;
  const D4 = A44 - (L41 * L41 * D1 + L42 * L42 * D2 + L43 * L43 * D3);
  const L54 = (A54 - L41 * L51 * D1 - L42 * L52 * D2 - L43 * L53 * D3) / D4;
  const L64 = (A64 - L41 * L61 * D1 - L42 * L62 * D2 - L43 * L63 * D3) / D4;
  const D5 = A55 - (L51 * L51 * D1 + L52 * L52 * D2 + L53 * L53 * D3 + L54 * L54 * D4);
  const L65 = (A65 - L51 * L61 * D1 - L52 * L62 * D2 - L53 * L63 * D3 - L54 * L64 * D4) / D5;
  const D6 =
    A66 - (L61 * L61 * D1 + L62 * L62 * D2 + L63 * L63 * D3 + L64 * L64 * D4 + L65 * L65 * D5);
  // Forward substitution: L·y = b
  const y1 = requiredAt(bLin, 0);
  const y2 = requiredAt(bLin, 1) - L21 * y1;
  const y3 = requiredAt(bLin, 2) - L31 * y1 - L32 * y2;
  const y4 = requiredAt(bAng, 0) - L41 * y1 - L42 * y2 - L43 * y3;
  const y5 = requiredAt(bAng, 1) - L51 * y1 - L52 * y2 - L53 * y3 - L54 * y4;
  const y6 = requiredAt(bAng, 2) - L61 * y1 - L62 * y2 - L63 * y3 - L64 * y4 - L65 * y5;
  // Diagonal solve: D·z = y
  const z1 = y1 / D1;
  const z2 = y2 / D2;
  const z3 = y3 / D3;
  const z4 = y4 / D4;
  const z5 = y5 / D5;
  const z6 = y6 / D6;
  // Backward substitution: Lᵀ·x = z
  xAng[2] = z6;
  xAng[1] = z5 - L65 * xAng[2];
  xAng[0] = z4 - L54 * xAng[1] - L64 * xAng[2];
  xLin[2] = z3 - L43 * xAng[0] - L53 * xAng[1] - L63 * xAng[2];
  xLin[1] = z2 - L32 * xLin[2] - L42 * xAng[0] - L52 * xAng[1] - L62 * xAng[2];
  xLin[0] = z1 - L21 * xLin[1] - L31 * xLin[2] - L41 * xAng[0] - L51 * xAng[1] - L61 * xAng[2];
}
