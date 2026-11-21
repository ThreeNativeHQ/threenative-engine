// foliage.js — the leaf primitive shared by pines, palms, ferns and shrubs.
import * as THREE from 'three';

/** Collects loose coloured triangles and turns them into a faceted geometry. */
export class Tris {
  constructor() { this.P = []; this.C = []; }
  tri(a, b, c, ca, cb, cc) {
    this.P.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    this.C.push(ca.r, ca.g, ca.b, cb.r, cb.g, cb.b, cc.r, cc.g, cc.b);
  }
  get count() { return this.P.length / 9; }
  build({ normalsUp = false } = {}) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.C, 3));
    if (normalsUp) {
      // Grass trick: every blade is lit like the ground it grows from.
      const n = new Float32Array(this.P.length);
      for (let i = 1; i < n.length; i += 3) n[i] = 1;
      g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
    } else g.computeVertexNormals();
    return g;
  }
}

const UP = new THREE.Vector3(0, 1, 0);

/**
 * One leaf / bough: a ribbon along an arching spine with a serrated edge and a
 * ridge down the middle. Pines, palms and ferns are all built from this.
 */
export function frond(tris, {
  origin, yaw = 0, length = 1, width = 0.3, rise = 0.2, droop = 0.6, segs = 7,
  serr = 0.45, fold = 0.25, c0, c1, taper = 0.6, edge = 0.82, roll = 0,
}) {
  const f = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw));
  const side = new THREE.Vector3(Math.sin(yaw), 0, -Math.cos(yaw));
  const S = [], L = [], R = [], CS = [], CE = [];
  for (let k = 0; k <= segs; k++) {
    const s = k / segs;
    const sp = origin.clone().addScaledVector(f, length * s).addScaledVector(UP, length * (rise * s - droop * s * s));
    let w = width * Math.pow(Math.sin(Math.PI * Math.pow(s, taper)), 0.9);
    if (serr && k % 2 === 0) w *= 1 - serr;
    const back = serr && k % 2 === 1 ? -0.35 * length / segs : 0; // barbs sweep backwards
    const down = fold * w;
    S.push(sp);
    L.push(sp.clone().addScaledVector(side, w).addScaledVector(UP, -down + roll * w).addScaledVector(f, back));
    R.push(sp.clone().addScaledVector(side, -w).addScaledVector(UP, -down - roll * w).addScaledVector(f, back));
    const c = c0.clone().lerp(c1, s);
    CS.push(c); CE.push(c.clone().multiplyScalar(edge));
  }
  for (let k = 0; k < segs; k++) {
    tris.tri(S[k], L[k], L[k + 1], CS[k], CE[k], CE[k + 1]);
    tris.tri(S[k], L[k + 1], S[k + 1], CS[k], CE[k + 1], CS[k + 1]);
    tris.tri(S[k], R[k + 1], R[k], CS[k], CE[k + 1], CE[k]);
    tris.tri(S[k], S[k + 1], R[k + 1], CS[k], CS[k + 1], CE[k + 1]);
  }
}
