// core.js — shared building blocks for the stylized environment kit.
// Everything in the kit is plain BufferGeometry with vertex colours, so pieces
// need no textures and can be merged, cloned or instanced freely.
import * as THREE from 'three';
import { STRATA } from './palettes.js';

/** Shared uniforms. Advance `uTime.value` once per frame to animate water and wind. */
export const uniforms = { uTime: { value: 0 } };

// ───────────────────────────── random + noise ─────────────────────────────

export class RNG {
  constructor(seed = 1) { this.s = (seed * 2654435761) >>> 0 || 1; }
  next() {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) { return a + (b - a) * this.next(); }
  int(a, b) { return Math.floor(this.range(a, b + 1)); }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  chance(p) { return this.next() < p; }
  seed() { return Math.floor(this.next() * 1e9); }
}

function hash3(x, y, z, s) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1274126177) ^ Math.imul(s, 974711);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Value noise, returns -1..1 */
export function noise3(x, y, z, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const l = (a, b, t) => a + (b - a) * t;
  const c = (dx, dy, dz) => hash3(xi + dx, yi + dy, zi + dz, seed);
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v),
    l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v), w) * 2 - 1;
}

export function fbm(x, y, z, octaves = 3, seed = 0) {
  let a = 0.5, f = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += a * noise3(x * f, y * f, z * f, seed + i * 17);
    norm += a; a *= 0.5; f *= 2.03;
  }
  return sum / norm;
}

export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/** Piecewise smooth curve through [t, value] control points (t ascending, 0..1). */
export function profile(points) {
  return (t) => {
    if (t <= points[0][0]) return points[0][1];
    for (let i = 1; i < points.length; i++) {
      if (t <= points[i][0]) {
        const [t0, v0] = points[i - 1], [t1, v1] = points[i];
        return lerp(v0, v1, smoothstep(0, 1, (t - t0) / (t1 - t0)));
      }
    }
    return points[points.length - 1][1];
  };
}

// ───────────────────────────── colour ─────────────────────────────

export const col = (h) => new THREE.Color(h);
const _tmp = new THREE.Color();
/** out = lerp(a, b, t) without allocating. a/b may be hex numbers or Colors. */
export function mixc(out, a, b, t) {
  out.set(a); _tmp.set(b);
  return out.lerp(_tmp, clamp(t, 0, 1));
}

// ───────────────────────────── geometry helpers ─────────────────────────────

function ensureColor(geo) {
  if (!geo.attributes.color) {
    const n = geo.attributes.position.count;
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  }
  return geo;
}
function ensureSurf(geo) {
  if (!geo.attributes.surf) geo.setAttribute('surf', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 4), 4));
  return geo.attributes.surf;
}

function ensureCap(geo) {
  if (!geo.attributes.cap) geo.setAttribute('cap', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 4), 4));
  return geo.attributes.cap;
}

/**
 * Per-vertex colour. fn(position, normal, outColor, index, outSurf, outCap)
 * The last two are optional and feed the per-pixel shading of the solid material:
 *   outSurf  Vector4 (rock paint 0..1, sandstone bands 0..1, seed, worn-edge width in metres)
 *   outCap   Vector4 (r, g, b, mask 0..1) — a second colour such as grass or snow;
 *            the shader cuts the mask at 0.5 with noise, giving a crisp ragged edge.
 */
export function paint(geo, fn) {
  ensureColor(geo);
  const pos = geo.attributes.position, nor = geo.attributes.normal, c = geo.attributes.color;
  const sa = fn.length >= 5 ? ensureSurf(geo) : null, ca = fn.length >= 6 ? ensureCap(geo) : null;
  const p = new THREE.Vector3(), n = new THREE.Vector3(), o = new THREE.Color(), sv = new THREE.Vector4(), cv = new THREE.Vector4();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    if (nor) n.fromBufferAttribute(nor, i);
    o.setRGB(1, 1, 1); sv.set(0, 0, 0, 0); cv.set(1, 1, 1, 0);
    fn(p, n, o, i, sv, cv);
    c.setXYZ(i, o.r, o.g, o.b);
    if (sa) sa.setXYZW(i, sv.x, sv.y, sv.z, sv.w);
    if (ca) ca.setXYZW(i, cv.x, cv.y, cv.z, cv.w);
  }
  return geo;
}

/** Per-face colour on a non-indexed geometry. fn(centroid, faceNormal, outColor, faceIndex, outSurf) */
export function paintFaces(geo, fn) {
  ensureColor(geo);
  const pos = geo.attributes.position, c = geo.attributes.color, sa = fn.length >= 5 ? ensureSurf(geo) : null;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3();
  const cen = new THREE.Vector3(), n = new THREE.Vector3(), o = new THREE.Color(), sv = new THREE.Vector4();
  for (let f = 0; f < pos.count / 3; f++) {
    a.fromBufferAttribute(pos, f * 3); b.fromBufferAttribute(pos, f * 3 + 1); d.fromBufferAttribute(pos, f * 3 + 2);
    cen.copy(a).add(b).add(d).multiplyScalar(1 / 3);
    n.copy(b).sub(a).cross(d.sub(a)).normalize();
    o.setRGB(1, 1, 1); sv.set(0, 0, 0, 0);
    fn(cen, n, o, f, sv);
    for (let k = 0; k < 3; k++) { c.setXYZ(f * 3 + k, o.r, o.g, o.b); if (sa) sa.setXYZW(f * 3 + k, sv.x, sv.y, sv.z, sv.w); }
  }
  return geo;
}

/** Faceted shading: un-index and recompute normals per face. */
export function flat(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.computeVertexNormals();
  return g;
}

/** Move vertices in place. fn(position) mutates the vector. */
export function displace(geo, fn) {
  const pos = geo.attributes.position, p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i); fn(p, i); pos.setXYZ(i, p.x, p.y, p.z);
  }
  pos.needsUpdate = true;
  return geo;
}

/** Translate / rotate / scale a geometry in place. */
export function xform(geo, { pos = [0, 0, 0], rot = [0, 0, 0], scale = 1 } = {}) {
  const s = Array.isArray(scale) ? scale : [scale, scale, scale];
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(...pos),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot, 'YXZ')),
    new THREE.Vector3(...s));
  geo.applyMatrix4(m);
  return geo;
}

/** Merge geometries into one non-indexed geometry with position / normal / color (+ surf, cap and edge for solids). */
export function merge(geos, withSurf = false) {
  const list = geos.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    if (!n.attributes.normal) n.computeVertexNormals();
    return ensureColor(n);
  });
  const total = list.reduce((s, g) => s + g.attributes.position.count, 0);
  const P = new Float32Array(total * 3), N = new Float32Array(total * 3), C = new Float32Array(total * 3), S = withSurf ? new Float32Array(total * 4) : null, K = withSurf ? new Float32Array(total * 4) : null, G = withSurf ? new Float32Array(total * 3).fill(1e3) : null;
  let o = 0, so = 0;
  for (const g of list) {
    P.set(g.attributes.position.array, o); N.set(g.attributes.normal.array, o); C.set(g.attributes.color.array, o);
    if (S && g.attributes.surf) S.set(g.attributes.surf.array, so);
    if (K && g.attributes.cap) K.set(g.attributes.cap.array, so);
    if (G && g.attributes.edge) G.set(g.attributes.edge.array, o);
    o += g.attributes.position.count * 3; so += g.attributes.position.count * 4;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(P, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  out.setAttribute('color', new THREE.BufferAttribute(C, 3));
  if (S) { out.setAttribute('surf', new THREE.BufferAttribute(S, 4)); out.setAttribute('cap', new THREE.BufferAttribute(K, 4)); out.setAttribute('edge', new THREE.BufferAttribute(G, 3)); }
  out.computeBoundingSphere(); out.computeBoundingBox();
  return out;
}

/** Join vertices that share a position, so normals can be smoothed across them. */
export function weld(geo) {
  const pos = geo.attributes.position, map = new Map(), P = [], I = [];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i), key = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
    let id = map.get(key);
    if (id === undefined) { id = P.length / 3; map.set(key, id); P.push(x, y, z); }
    I.push(id);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setIndex(I);
  return g;
}

/**
 * Low-poly finish for an indexed mesh: every triangle gets its own flat normal,
 * and the `edge` attribute records each pixel's distance to the hard outward
 * edges of its triangle, so the material can paint a crisp worn line along them.
 */
export function facet(geo, { angle = 27 } = {}) {
  const pos = geo.attributes.position.array, idx = geo.index.array, nt = idx.length / 3, nv = pos.length / 3;
  const V = (i, out) => out.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), e = new THREE.Vector3();
  const FN = [], FC = [], edges = new Map(), key = (i, j) => (i < j ? i * nv + j : j * nv + i);
  for (let t = 0; t < nt; t++) {
    V(idx[t * 3], a); V(idx[t * 3 + 1], b); V(idx[t * 3 + 2], c);
    FC.push(a.clone().add(b).add(c).multiplyScalar(1 / 3));
    FN.push(b.clone().sub(a).cross(e.copy(c).sub(a)).normalize());
    for (let k = 0; k < 3; k++) { const kk = key(idx[t * 3 + k], idx[t * 3 + ((k + 1) % 3)]); if (!edges.has(kk)) edges.set(kk, []); edges.get(kk).push(t); }
  }
  const P = new Float32Array(nt * 9), N = new Float32Array(nt * 9), E = new Float32Array(nt * 9).fill(1e3), limit = Math.cos((angle * Math.PI) / 180);
  for (let t = 0; t < nt; t++) {
    const v = [idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]];
    for (let k = 0; k < 3; k++) {
      P.set([pos[v[k] * 3], pos[v[k] * 3 + 1], pos[v[k] * 3 + 2]], t * 9 + k * 3);
      N.set([FN[t].x, FN[t].y, FN[t].z], t * 9 + k * 3);
      // the edge opposite corner k
      const i = v[(k + 1) % 3], j = v[(k + 2) % 3], other = edges.get(key(i, j)).find((o) => o !== t);
      if (other === undefined || FN[t].dot(FN[other]) > limit || e.copy(FC[other]).sub(FC[t]).dot(FN[t]) > 0) continue; // flat, or an inward crease
      V(v[k], a); V(i, b); V(j, c);
      const height = e.copy(a).sub(b).cross(c.sub(b)).length() / c.length(); // corner-to-edge distance
      for (let m = 0; m < 3; m++) E[t * 9 + m * 3 + k] = m === k ? height : 0;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  g.setAttribute('edge', new THREE.BufferAttribute(E, 3));
  return g;
}

/**
 * Sandstone layering as a function of position. The same arithmetic runs in the
 * fragment shader (see STRATA_GLSL), so the ledges cut into the mesh line up
 * with the bands painted on it.
 */
export function strataField(k) {
  const gh = (i) => { const v = i * 0.61803398875 + k * 0.7548776662 + 0.31; return v - Math.floor(v); };
  const wob = (x, z) => 0.35 * Math.sin(x * 0.31 + k) + 0.3 * Math.sin(z * 0.27 + k * 2) + 0.15 * Math.sin((x + z) * 0.9 + k * 3);
  return {
    bulge(x, y, z) {
      const yy = y + wob(x, z), a = yy / 2.1 + k, ia = Math.floor(a), fa = a - ia;
      let v = lerp((gh(ia + 3) - 0.5) * 0.11, (gh(ia + 4) - 0.5) * 0.11, smoothstep(0.86, 1, fa));
      const b = yy / 0.8 + k * 1.7, ib = Math.floor(b), fb = b - ib;
      if (gh(ib + 17) >= 0.7) { const w = 0.28 + 0.25 * gh(ib + 5); v += 0.035 * smoothstep(0.2, 0.27, fb) * (1 - smoothstep(0.23 + w, 0.3 + w, fb)); }
      return v;
    },
  };
}

/**
 * Tube swept along a polyline, used for trunks, branches, cactus arms and arches.
 * radius(t, theta) -> number, color(t, theta, out) optional.
 */
export function tube(path, radius, { radial = 8, capStart = false, capEnd = true, color = null, flatten = 1 } = {}) {
  const n = path.length, P = [], C = [], I = [];
  const T = new THREE.Vector3(), N = new THREE.Vector3(), B = new THREE.Vector3(), p = new THREE.Vector3(), o = new THREE.Color();
  for (let i = 0; i < n; i++) {
    T.copy(path[Math.min(n - 1, i + 1)]).sub(path[Math.max(0, i - 1)]).normalize();
    if (i === 0) { N.set(1, 0, 0); if (Math.abs(T.x) > 0.9) N.set(0, 0, 1); }
    N.addScaledVector(T, -N.dot(T)).normalize();
    B.crossVectors(T, N);
    const t = i / (n - 1);
    for (let k = 0; k < radial; k++) {
      const th = (k / radial) * Math.PI * 2, r = radius(t, th);
      p.copy(path[i]).addScaledVector(N, Math.cos(th) * r).addScaledVector(B, Math.sin(th) * r * flatten);
      P.push(p.x, p.y, p.z);
      if (color) { o.setRGB(1, 1, 1); color(t, th, o); C.push(o.r, o.g, o.b); }
    }
  }
  for (let i = 0; i < n - 1; i++) for (let k = 0; k < radial; k++) {
    const a = i * radial + k, b = i * radial + ((k + 1) % radial), c = a + radial, d = b + radial;
    I.push(a, b, c, b, d, c);
  }
  const cap = (ring, pt, flip) => {
    const ci = P.length / 3; P.push(pt.x, pt.y, pt.z);
    if (color) { o.setRGB(1, 1, 1); color(flip ? 0 : 1, 0, o); C.push(o.r, o.g, o.b); }
    for (let k = 0; k < radial; k++) {
      const a = ring * radial + k, b = ring * radial + ((k + 1) % radial);
      if (flip) I.push(ci, b, a); else I.push(ci, a, b);
    }
  };
  if (capEnd) cap(n - 1, path[n - 1], false);
  if (capStart) cap(0, path[0], true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  if (color) g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  g.setIndex(I); g.computeVertexNormals();
  return g;
}

/**
 * Irregular lathe around +Y: rings of `radial` points whose radius comes from
 * radius(t, theta, y). Used for mesas, hoodoos and cliff cores.
 */
export function lathe({ height, rings = 20, radial = 24, radius, sx = 1, sz = 1, dome = 0.04, color = null }) {
  const P = [], C = [], I = [], o = new THREE.Color();
  for (let j = 0; j <= rings; j++) {
    const t = j / rings, y = t * height;
    for (let i = 0; i < radial; i++) {
      const th = (i / radial) * Math.PI * 2, r = radius(t, th, y);
      P.push(Math.cos(th) * r * sx, y, Math.sin(th) * r * sz);
      if (color) { o.setRGB(1, 1, 1); color(t, th, y, o, false); C.push(o.r, o.g, o.b); }
    }
  }
  for (let j = 0; j < rings; j++) for (let i = 0; i < radial; i++) {
    const a = j * radial + i, b = j * radial + ((i + 1) % radial), c = a + radial, d = b + radial;
    I.push(a, c, b, b, c, d);
  }
  // top cap: an inner ring then the centre, slightly domed
  const top = rings * radial, inner = P.length / 3;
  for (let i = 0; i < radial; i++) {
    P.push(P[(top + i) * 3] * 0.55, height * (1 + dome * 0.6), P[(top + i) * 3 + 2] * 0.55);
    if (color) { o.setRGB(1, 1, 1); color(1, 0, height, o, true); C.push(o.r, o.g, o.b); }
  }
  const centre = P.length / 3; P.push(0, height * (1 + dome), 0);
  if (color) { o.setRGB(1, 1, 1); color(1, 0, height, o, true); C.push(o.r, o.g, o.b); }
  for (let i = 0; i < radial; i++) {
    const a = top + i, b = top + ((i + 1) % radial), c = inner + i, d = inner + ((i + 1) % radial);
    I.push(a, c, b, b, c, d, c, centre, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  if (color) g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  g.setIndex(I); g.computeVertexNormals();
  return g;
}

/** Low-poly blob: a noisy icosphere, faceted. */
export function blob(rng, { r = 1, detail = 1, squash = [1, 1, 1], lumpy = 0.25 } = {}) {
  const g = new THREE.IcosahedronGeometry(r, detail), s = rng.seed() % 1000;
  displace(g, (p) => {
    const k = 1 + lumpy * noise3(p.x / r * 1.3 + s, p.y / r * 1.3, p.z / r * 1.3, s);
    p.multiplyScalar(k); p.x *= squash[0]; p.y *= squash[1]; p.z *= squash[2];
  });
  return flat(g);
}

// ───────────────────────────── materials ─────────────────────────────

const NOISE_GLSL = /* glsl */`
  float kh(vec3 p) { p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.x + p.y) * p.z); }
  float kn(vec3 p) { vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(kh(i), kh(i + vec3(1, 0, 0)), f.x), mix(kh(i + vec3(0, 1, 0)), kh(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(kh(i + vec3(0, 0, 1)), kh(i + vec3(1, 0, 1)), f.x), mix(kh(i + vec3(0, 1, 1)), kh(i + vec3(1, 1, 1)), f.x), f.y), f.z); }
  // crisp two-tone split of a noise value, antialiased with screen-space derivatives
  float cut(float v, float at) { float w = max(fwidth(v) * 1.2, 0.004); return smoothstep(at - w, at + w, v); }`;

// Painted-rock look, all hard-edged: a few flat brush strokes and the odd sharp crack. No soft noise.
const ROCK_GLSL = /* glsl */`
  float rockDetail(vec3 p, float k) {
    vec3 q = p + k * 7.31;
    float strokes = cut(kn(q * vec3(1.0, 0.15, 1.0)), 0.64);
    float blotch = cut(kn(q * vec3(0.3, 0.18, 0.3) + 4.0), 0.62);
    vec3 f = q * vec3(0.4, 0.13, 0.4) + 0.6 * vec3(kn(q * 0.28), 0.0, kn(q * 0.28 + 7.0));
    float ridge = abs(kn(f + 11.0) - 0.5), w = max(fwidth(ridge), 0.002);
    float crack = (1.0 - smoothstep(w * 0.7, w * 1.3, ridge)) * cut(kn(q * 0.15 + 5.0), 0.63);
    return (0.975 + 0.05 * strokes - 0.04 * blotch) * (1.0 - 0.2 * crack);
  }`;

// Sandstone bands. Mirrors strataField() above: same hash, same wobble, same band heights.
const STRATA_GLSL = /* glsl */`
  uniform vec3 uBands[6]; uniform vec3 uStreaks[3];
  float gh(float i, float k) { return fract(i * 0.61803398875 + k * 0.7548776662 + 0.31); }
  vec3 strata(vec3 p, float k) {
    float y = p.y + 0.35 * sin(p.x * 0.31 + k) + 0.3 * sin(p.z * 0.27 + k * 2.0) + 0.15 * sin((p.x + p.z) * 0.9 + k * 3.0);
    y += 0.1 * (kn(p * vec3(0.9, 0.4, 0.9) + k) - 0.5);                       // hand-drawn wobble on the edges
    float a = y / 2.1 + k, ia = floor(a), fa = fract(a), wa = max(fwidth(a) * 1.2, 0.01);
    vec3 c = mix(uBands[int(gh(ia, k) * 5.999)], uBands[int(gh(ia + 1.0, k) * 5.999)], smoothstep(1.0 - wa, 1.0, fa));
    c *= 0.9 + 0.15 * fa;                                                     // each layer is darker at its foot
    float b = y / 0.8 + k * 1.7, ib = floor(b), fb = fract(b), wb = max(fwidth(b) * 1.2, 0.012);
    float wd = 0.28 + 0.25 * gh(ib + 5.0, k);
    float streak = step(0.7, gh(ib + 17.0, k)) * smoothstep(0.25 - wb, 0.25 + wb, fb) * (1.0 - smoothstep(0.25 + wd - wb, 0.25 + wd + wb, fb));
    c = mix(c, uStreaks[int(gh(ib + 9.0, k) * 2.999)], streak * 0.92);
    float thin = y / 0.23 + k * 3.3;                                          // hairline layers
    c *= 1.0 - 0.07 * step(0.62, gh(floor(thin) + 31.0, k)) * cut(fract(thin), 0.55);
    return c * (0.97 + 0.06 * kn(vec3(p.x * 0.5, y * 6.0, p.z * 0.5)));
  }`;

const strataUniforms = {
  uBands: { value: STRATA.desert.bands.map((h) => new THREE.Color(h)) },
  uStreaks: { value: STRATA.desert.streaks.map((h) => new THREE.Color(h)) },
};

/** Per-pixel surface detail, driven by the `surf` and `cap` vertex attributes (see paint()). */
function surfacePatch(mat) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, strataUniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 surf; attribute vec4 cap; attribute vec3 edge; varying vec4 vSurf; varying vec4 vCap; varying vec3 vEdge; varying vec3 vObj;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSurf = surf; vCap = cap; vEdge = edge; vObj = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec4 vSurf; varying vec4 vCap; varying vec3 vEdge; varying vec3 vObj;${NOISE_GLSL}${ROCK_GLSL}${STRATA_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          float wRock = clamp(vSurf.x, 0.0, 1.0), wStrata = clamp(vSurf.y, 0.0, 1.0), wAny = max(wRock, wStrata);
          if (wStrata > 0.002) diffuseColor.rgb = mix(diffuseColor.rgb, strata(vObj, vSurf.z) * diffuseColor.rgb, wStrata);
          if (wRock > 0.002) {
            // worn edge: a crisp, slightly ragged light line along the hard outward edges
            float d = min(vEdge.x, min(vEdge.y, vEdge.z)) / max(vSurf.w, 0.001);
            float worn = 1.0 - cut(d + (kn(vObj * 2.3 + vSurf.z) - 0.5) * 0.6, 1.0);
            diffuseColor.rgb *= mix(1.0, rockDetail(vObj, vSurf.z) * (1.0 + 0.17 * worn), wRock);
          }
          if (vCap.a > 0.002) { // grass or snow lying on the rock, with a ragged edge and a shadow line under it
            float m = vCap.a + (kn(vObj * 1.1 + 3.0) - 0.5) * 0.5;
            float e = cut(m, 0.5);
            diffuseColor.rgb *= 1.0 - 0.2 * (cut(m, 0.4) - e);
            diffuseColor.rgb = mix(diffuseColor.rgb, vCap.rgb, e);
          }
        }`);
  };
  mat.customProgramCacheKey = () => 'surface';
  return mat;
}

/**
 * Terrain material. Two extra vertex attributes, `tint` and `mask`, describe a
 * second ground colour; the shader thresholds the mask with noise so paths and
 * shorelines get a crisp, irregular edge instead of a vertex-sized blur.
 */
function groundPatch(mat) {
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 tint; attribute float mask; varying vec3 vTint; varying float vMask; varying vec3 vObj;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTint = tint; vMask = mask; vObj = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vTint; varying float vMask; varying vec3 vObj;${NOISE_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 g = vec3(vObj.x, 0.0, vObj.z);
          float m = vMask + (kn(g * 0.8) - 0.5) * 0.3 + (kn(g * 3.3 + 9.0) - 0.5) * 0.12;
          float edge = cut(m, 0.5);
          diffuseColor.rgb = mix(diffuseColor.rgb, vTint, edge);
          // painted ground: broad two-tone patches plus a fine grain
          float patches = 0.6 * cut(kn(g * 0.22 + 4.0), 0.52) + 0.4 * cut(kn(g * 0.7 + 12.0), 0.58);
          diffuseColor.rgb *= (0.955 + 0.075 * patches) * (0.98 + 0.04 * kn(g * 4.0));
          diffuseColor.rgb *= 1.0 - 0.1 * edge * (1.0 - cut(m, 0.62));          // darker rim just inside the edge
        }`);
  };
  mat.customProgramCacheKey = () => 'ground';
  return mat;
}

function windPatch(mat, strength, keepNormals = false) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uniforms.uTime;
    // Grass is lit like the ground under it, so its back faces must not flip their normals.
    if (keepNormals) sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n normal = normalize(vNormal);');
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          #ifdef USE_INSTANCING
            vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
          #else
            vec4 wp = modelMatrix * vec4(position, 1.0);
          #endif
          float sway = sin(uTime * 1.6 + wp.x * 0.35 + wp.z * 0.27) + 0.5 * sin(uTime * 2.7 + wp.x * 0.9);
          float w = ${strength.toFixed(3)} * max(position.y, 0.0);
          transformed.x += sway * w; transformed.z += sway * w * 0.6;
        }`);
  };
  mat.customProgramCacheKey = () => 'wind' + strength + keepNormals;
  return mat;
}

/** A handful of shared materials cover every piece in the kit. */
export const materials = {
  solid: surfacePatch(new THREE.MeshLambertMaterial({ vertexColors: true })),
  ground: groundPatch(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })),
  foliage: windPatch(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), 0.004),
  grass: windPatch(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), 0.12, true),
  cloud: new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0xffffff, emissiveIntensity: 0.35, fog: false }),
};

/**
 * Assemble a piece. Geometry goes into buckets by material so each piece is at
 * most a few draw calls. Origin is the centre of the base, +Y up, units = metres.
 */
export function piece(name, parts, meta = {}) {
  const g = new THREE.Group(); g.name = name;
  for (const key of ['solid', 'foliage', 'grass', 'cloud']) {
    if (!parts[key] || !parts[key].length) continue;
    const m = new THREE.Mesh(merge(parts[key], key === 'solid'), materials[key]);
    m.name = `${name}:${key}`;
    m.castShadow = key !== 'grass' && key !== 'cloud';
    m.receiveShadow = key !== 'cloud';
    g.add(m);
  }
  g.userData = { kit: name, ...meta };
  return g;
}

export { THREE };
