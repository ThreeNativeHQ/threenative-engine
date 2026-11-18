// Outcrop (rockgen.js), vendored from the Outcrop Rock Generator page under the MIT licence
// (LICENSES/Outcrop-MIT.txt). Changes from upstream: the page's IIFE over window.THREE is now an
// ES module that imports three, and `api` is the default export instead of window.Outcrop.
// The viewer UI is cut. The generator body below is verbatim.
import * as THREE from "three";
/**
 * rockgen.js — modular procedural rocks, cliffs and mountains for three.js
 *
 *   const gen  = new RockGenerator();
 *   const mesh = gen.build({ form: 'cliff', biome: 'coastal', seed: 7 });
 *   scene.add(mesh);
 *
 * Five layers, each a plain registry you can extend:
 *
 *   BASES      low-level topology builders (sphere, lathe, extrude, heightfield, tube)
 *   MODIFIERS  mesh operators (displace, cut, strata, fracture, smooth, terrace, settle)
 *   FORMS      a base + an ordered modifier pipeline driven by "traits" (boulder, cliff, arch ...)
 *   BIOMES     trait presets + surface colouring rules (desert, coastal, tundra ...)
 *   ROCK_TEXTURES  recipes for generated, seamless albedo / normal / roughness maps (granite, basalt ...)
 *
 * A build is resolved into a plain-JSON recipe (gen.resolve(opts)), so anything the
 * generator does can be inspected, saved, diffed and replayed.
 *
 * Units: 1 unit = 1 metre, Y up, rocks rest on y = 0.
 */

/* ────────────────────────────── helpers ────────────────────────────── */

const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Small, fast, seedable PRNG. Returns a function yielding floats in [0, 1). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
/** Recursive merge of plain objects. Arrays and scalars are replaced, not merged. */
function deepMerge(target, ...sources) {
  for (const src of sources) {
    if (!isObj(src)) continue;
    for (const k of Object.keys(src)) {
      if (src[k] === undefined) continue;
      target[k] = isObj(src[k]) ? deepMerge(isObj(target[k]) ? { ...target[k] } : {}, src[k]) : src[k];
    }
  }
  return target;
}

/* ────────────────────────────── noise ────────────────────────────── */

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
function grad(h, x, y, z) {
  h &= 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}

/** Seeded gradient + cellular noise. All sampling is in world space so modules can tile. */
class Noise {
  constructor(seed = 1) {
    const rnd = mulberry32(seed * 2654435761);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = (rnd() * (i + 1)) | 0;
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    this.perm = new Uint8Array(514);
    for (let i = 0; i < 514; i++) this.perm[i] = p[i & 255];
  }

  /** Perlin noise, roughly [-1, 1]. */
  perlin(x, y, z) {
    const P = this.perm;
    let X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
    x -= X; y -= Y; z -= Z; X &= 255; Y &= 255; Z &= 255;
    const u = fade(x), v = fade(y), w = fade(z);
    const A = P[X] + Y, AA = P[A] + Z, AB = P[A + 1] + Z;
    const B = P[X + 1] + Y, BA = P[B] + Z, BB = P[B + 1] + Z;
    return lerp(
      lerp(lerp(grad(P[AA], x, y, z), grad(P[BA], x - 1, y, z), u),
           lerp(grad(P[AB], x, y - 1, z), grad(P[BB], x - 1, y - 1, z), u), v),
      lerp(lerp(grad(P[AA + 1], x, y, z - 1), grad(P[BA + 1], x - 1, y, z - 1), u),
           lerp(grad(P[AB + 1], x, y - 1, z - 1), grad(P[BB + 1], x - 1, y - 1, z - 1), u), v), w);
  }

  /** Fractal Brownian motion, roughly [-1, 1]. */
  fbm(x, y, z, octaves = 4, lacunarity = 2, gain = 0.5) {
    let sum = 0, amp = 1, norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.perlin(x, y, z);
      norm += amp; amp *= gain;
      x = x * lacunarity + 17.3; y = y * lacunarity + 5.1; z = z * lacunarity + 9.7;
    }
    return sum / norm * 1.4;
  }

  /** Ridged multifractal, [0, 1]. Sharp crests — good for mountains and fine rock grain. */
  ridged(x, y, z, octaves = 5, lacunarity = 2.05, gain = 0.5) {
    let sum = 0, amp = 1, norm = 0, prev = 1;
    for (let i = 0; i < octaves; i++) {
      let n = 1 - Math.abs(this.perlin(x, y, z));
      n *= n;
      sum += n * amp * prev;
      norm += amp; prev = n; amp *= gain;
      x = x * lacunarity + 3.7; y = y * lacunarity + 11.9; z = z * lacunarity + 1.3;
    }
    return sum / norm;
  }

  /** Stable hash of an integer → [0, 1]. */
  hash(i) {
    const P = this.perm;
    return P[P[i & 255] + ((i >> 8) & 255)] / 255;
  }

  /** Cellular noise. Writes [F1, F2, cellHash] into `out` (distances in cell units). */
  worley(x, y, z, out) {
    const P = this.perm;
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    let f1 = 9, f2 = 9, id = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx, cy = yi + dy, cz = zi + dz;
      const h = P[P[P[cx & 255] + (cy & 255)] + (cz & 255)];
      const px = cx + P[h] / 255 - x, py = cy + P[h + 1] / 255 - y, pz = cz + P[h + 2] / 255 - z;
      const d = px * px + py * py + pz * pz;
      if (d < f1) { f2 = f1; f1 = d; id = h; } else if (d < f2) f2 = d;
    }
    out[0] = Math.sqrt(f1); out[1] = Math.sqrt(f2); out[2] = id / 255;
    return out;
  }
}

/* ────────────────────────────── working mesh ────────────────────────────── */

/**
 * Welded, indexed triangle soup that modifiers operate on.
 * Kept separate from THREE.BufferGeometry so vertices stay shared while the
 * surface is being deformed; converted to a render geometry at the very end.
 */
class RockMesh {
  constructor(pos, index) {
    this.pos = pos;                     // Float32Array xyz
    this.index = index;                 // Uint32Array
    this.count = pos.length / 3;
    this.cavity = new Float32Array(this.count); // 0..1, written by fracture → darkens cracks
    this.band = new Float32Array(this.count);   // -1..1, written by strata → colour banding
    this.lock = null;   // optional per-vertex weight; 0 shields a vertex from cut/smooth only
    this.pin = null;    // optional per-vertex weight; 0 keeps a vertex exactly where the base put it
    this.dir = null;    // optional fixed displacement directions (tileable forms)
    this.seam = null;   // optional { rings, perRing } for forms that tile along X
    this.finish = null; // optional hook run once after the pipeline (e.g. to add caps)
    this._nrm = new Float32Array(pos.length);
    this._adj = null;
  }

  /** Build from any BufferGeometry, welding coincident vertices. */
  static fromGeometry(geo, tol = 1e-4) {
    const src = geo.attributes.position.array, idx = geo.index ? geo.index.array : null;
    const n = src.length / 3, map = new Map(), remap = new Uint32Array(n), out = [];
    for (let i = 0; i < n; i++) {
      const x = src[i * 3], y = src[i * 3 + 1], z = src[i * 3 + 2];
      const key = Math.round(x / tol) + ',' + Math.round(y / tol) + ',' + Math.round(z / tol);
      let id = map.get(key);
      if (id === undefined) { id = out.length / 3; map.set(key, id); out.push(x, y, z); }
      remap[i] = id;
    }
    const total = idx ? idx.length : n, tris = [];
    for (let i = 0; i < total; i += 3) {
      const a = remap[idx ? idx[i] : i], b = remap[idx ? idx[i + 1] : i + 1], c = remap[idx ? idx[i + 2] : i + 2];
      if (a !== b && b !== c && c !== a) tris.push(a, b, c);
    }
    return new RockMesh(new Float32Array(out), new Uint32Array(tris));
  }

  /** Area-weighted smooth vertex normals, recomputed on every call. */
  normals() {
    const { pos, index } = this, N = this._nrm;
    N.fill(0);
    for (let i = 0; i < index.length; i += 3) {
      const a = index[i] * 3, b = index[i + 1] * 3, c = index[i + 2] * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      N[a] += nx; N[a + 1] += ny; N[a + 2] += nz;
      N[b] += nx; N[b + 1] += ny; N[b + 2] += nz;
      N[c] += nx; N[c + 1] += ny; N[c + 2] += nz;
    }
    for (let i = 0; i < N.length; i += 3) {
      const l = Math.hypot(N[i], N[i + 1], N[i + 2]) || 1;
      N[i] /= l; N[i + 1] /= l; N[i + 2] /= l;
    }
    return N;
  }

  /** Directions modifiers push along: fixed ones if the form set them, else live normals. */
  dirs() { return this.dir || this.normals(); }

  /** Vertex → neighbours in CSR form ({ start, list }). Cached; topology never changes. */
  adjacency() {
    if (this._adj) return this._adj;
    const { index, count } = this;
    const start = new Uint32Array(count + 1);
    for (let i = 0; i < index.length; i++) start[index[i] + 1] += 2;
    for (let i = 0; i < count; i++) start[i + 1] += start[i];
    const fill = start.slice(0, count), list = new Uint32Array(index.length * 2);
    for (let i = 0; i < index.length; i += 3) {
      const a = index[i], b = index[i + 1], c = index[i + 2];
      list[fill[a]++] = b; list[fill[a]++] = c;
      list[fill[b]++] = c; list[fill[b]++] = a;
      list[fill[c]++] = a; list[fill[c]++] = b;
    }
    return (this._adj = { start, list });
  }

  bounds() {
    const p = this.pos, min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) {
      if (p[i + k] < min[k]) min[k] = p[i + k];
      if (p[i + k] > max[k]) max[k] = p[i + k];
    }
    return {
      min, max,
      size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
      center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    };
  }
}

/* ────────────────────────────── bases ────────────────────────────── */

/** Chaikin-smooth a 2D polyline, then resample it to `n` segments of equal arc length. */
function resamplePath(points, n, smooth = 1, closed = false) {
  let pts = points.map((p) => [p[0], p[1]]);
  for (let s = 0; s < smooth; s++) {
    const next = [];
    const m = pts.length, last = closed ? m : m - 1;
    if (!closed) next.push(pts[0]);
    for (let i = 0; i < last; i++) {
      const a = pts[i], b = pts[(i + 1) % m];
      next.push([lerp(a[0], b[0], 0.25), lerp(a[1], b[1], 0.25)], [lerp(a[0], b[0], 0.75), lerp(a[1], b[1], 0.75)]);
    }
    if (!closed) next.push(pts[m - 1]);
    pts = next;
  }
  if (closed) pts.push(pts[0]);
  const acc = [0];
  for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = acc[acc.length - 1], out = [];
  const samples = closed ? n : n + 1;
  for (let i = 0, j = 1; i < samples; i++) {
    const d = (i / n) * total;
    while (j < pts.length - 1 && acc[j] < d) j++;
    const t = (d - acc[j - 1]) / (acc[j] - acc[j - 1] || 1);
    out.push([lerp(pts[j - 1][0], pts[j][0], t), lerp(pts[j - 1][1], pts[j][1], t)]);
  }
  out.length_ = total;
  return out;
}

/**
 * Topology builders. Each returns a RockMesh; `tris` is a triangle budget so the
 * same form can be built at any level of detail.
 */
const BASES = {
  /** Unit icosphere. */
  sphere({ tris = 12000 }) {
    const detail = Math.max(2, Math.round(Math.sqrt(tris / 20) - 1));
    return RockMesh.fromGeometry(new THREE.IcosahedronGeometry(1, detail));
  },

  /**
   * Surface of revolution around Y. `path` is [[radius, y], ...] from the base
   * outward edge to the top; a radius of 0 at either end closes it with a pole.
   */
  lathe({ path, tris = 12000, smooth = 1 }) {
    const probe = resamplePath(path, 64, smooth);
    let meanR = 0;
    for (const p of probe) meanR += p[0];
    meanR = Math.max(meanR / probe.length, 1e-3);
    const ratio = probe.length_ / (2 * Math.PI * meanR);          // rings : segments
    const seg = Math.max(8, Math.round(Math.sqrt(tris / (2 * ratio))));
    const rings = Math.max(4, Math.round(seg * ratio));
    const pts = resamplePath(path, rings, smooth);
    const poleB = pts[0][0] < 1e-5, poleT = pts[rings][0] < 1e-5;
    const first = poleB ? 1 : 0, last = poleT ? rings - 1 : rings, nr = last - first + 1;
    const pos = [], idx = [];
    for (let i = first; i <= last; i++) for (let j = 0; j < seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      pos.push(pts[i][0] * Math.cos(a), pts[i][1], pts[i][0] * Math.sin(a));
    }
    for (let i = 0; i < nr - 1; i++) for (let j = 0; j < seg; j++) {
      const A = i * seg + j, B = i * seg + ((j + 1) % seg), C = A + seg, D = B + seg;
      idx.push(A, C, B, B, C, D);
    }
    if (poleT) {
      const T = pos.length / 3; pos.push(0, pts[rings][1], 0);
      for (let j = 0; j < seg; j++) idx.push((nr - 1) * seg + j, T, (nr - 1) * seg + ((j + 1) % seg));
    }
    if (poleB) {
      const Bp = pos.length / 3; pos.push(0, pts[0][1], 0);
      for (let j = 0; j < seg; j++) idx.push(Bp, j, (j + 1) % seg);
    }
    return new RockMesh(new Float32Array(pos), new Uint32Array(idx));
  },

  /**
   * Closed 2D profile [[z, y], ...] swept along X. The two X ends are pinned and
   * displacement directions stay in the YZ plane, so modules sharing a seed and
   * a world-space `offset` meet without a seam.
   */
  extrude({ path, width, tris = 16000, smooth = 1 }) {
    let area = 0;
    for (let i = 0; i < path.length; i++) {
      const a = path[i], b = path[(i + 1) % path.length];
      area += a[0] * b[1] - b[0] * a[1];
    }
    const src = area < 0 ? [...path].reverse() : path;
    const perimeter = resamplePath(src, 32, smooth, true).length_;
    const steps = Math.max(4, Math.round(Math.sqrt((tris / 2) * (width / perimeter))));
    const K = Math.max(8, Math.round(steps * (perimeter / width)));
    const ring = resamplePath(src, K, smooth, true);
    const count = (steps + 1) * K;
    const pos = new Float32Array(count * 3), dir = new Float32Array(count * 3), lock = new Float32Array(count);
    const fadeLen = Math.min(width * 0.18, perimeter * 0.08);
    for (let s = 0; s <= steps; s++) {
      const x = (s / steps - 0.5) * width;
      const edge = Math.min(x + width / 2, width / 2 - x);
      for (let k = 0; k < K; k++) {
        const v = s * K + k, p = ring[k], a = ring[(k + K - 1) % K], b = ring[(k + 1) % K];
        const tz = b[0] - a[0], ty = b[1] - a[1], l = Math.hypot(tz, ty) || 1;
        pos[v * 3] = x; pos[v * 3 + 1] = p[1]; pos[v * 3 + 2] = p[0];
        dir[v * 3 + 1] = -tz / l; dir[v * 3 + 2] = ty / l;
        lock[v] = smoothstep(0, fadeLen, edge);
      }
    }
    const idx = [];
    for (let s = 0; s < steps; s++) for (let k = 0; k < K; k++) {
      const A = s * K + k, B = s * K + ((k + 1) % K), C = A + K, D = B + K;
      idx.push(A, C, B, C, D, B);
    }
    const m = new RockMesh(pos, new Uint32Array(idx));
    m.dir = dir; m.lock = lock; m.seam = { rings: steps + 1, perRing: K };
    m.finish = () => {                              // cap both ends from the final outline
      const caps = [];
      for (const [first, sign] of [[0, -1], [steps * K, 1]]) {
        const outline = [];
        for (let k = 0; k < K; k++) outline.push(new THREE.Vector2(m.pos[(first + k) * 3 + 2], m.pos[(first + k) * 3 + 1]));
        for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(outline, [])) {
          const A = outline[a], B = outline[b], C = outline[c];
          const facing = (B.y - A.y) * (C.x - A.x) - (B.x - A.x) * (C.y - A.y);
          if (facing * sign > 0) caps.push(first + a, first + b, first + c); else caps.push(first + a, first + c, first + b);
        }
      }
      const index = new Uint32Array(m.index.length + caps.length);
      index.set(m.index); index.set(caps, m.index.length);
      m.index = index;
    };
    return m;
  },

  /** Square grid over XZ with y = height(x, z). Open underneath; faces at or below `trim` are dropped. */
  heightfield({ width, depth, height, tris = 30000, trim = -Infinity }) {
    const res = Math.max(8, Math.round(Math.sqrt(tris / 2)));
    const n = res + 1, pos = new Float32Array(n * n * 3), idx = new Uint32Array(res * res * 6);
    for (let j = 0, v = 0; j < n; j++) for (let i = 0; i < n; i++, v++) {
      const x = (i / res - 0.5) * width, z = (j / res - 0.5) * depth;
      pos[v * 3] = x; pos[v * 3 + 1] = height(x, z); pos[v * 3 + 2] = z;
    }
    let t = 0;
    for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      if (Math.max(pos[a * 3 + 1], pos[b * 3 + 1], pos[c * 3 + 1], pos[d * 3 + 1]) <= trim) continue;
      idx[t++] = a; idx[t++] = c; idx[t++] = b; idx[t++] = b; idx[t++] = c; idx[t++] = d;
    }
    return new RockMesh(pos, idx.slice(0, t));
  },

  /**
   * Tube along a planar (XY) centre line. `radius(t)` returns [inPlane, alongZ]
   * for t in 0..1 so the cross-section can vary and be elliptical. Ends are open.
   */
  tube({ points, radius, tris = 12000 }) {
    const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(p[0], p[1], p[2] || 0)));
    const len = curve.getLength();
    let meanR = 0;
    for (let i = 0; i <= 8; i++) { const r = radius(i / 8); meanR += (r[0] + r[1]) / 18; }
    const ratio = len / (2 * Math.PI * meanR);
    const R = Math.max(8, Math.round(Math.sqrt(tris / (2 * ratio))));
    const L = Math.max(6, Math.round(R * ratio));
    const centre = curve.getSpacedPoints(L);
    const pos = new Float32Array((L + 1) * R * 3), idx = [];
    for (let i = 0; i <= L; i++) {
      const t = i / L, T = curve.getTangentAt(t), r = radius(t), c = centre[i];
      const nx = T.y, ny = -T.x;                     // in-plane normal; binormal is +Z
      for (let j = 0; j < R; j++) {
        const a = (j / R) * Math.PI * 2, ca = Math.cos(a) * r[0], sa = Math.sin(a) * r[1], v = (i * R + j) * 3;
        pos[v] = c.x + nx * ca; pos[v + 1] = c.y + ny * ca; pos[v + 2] = c.z - sa;
      }
    }
    for (let i = 0; i < L; i++) for (let j = 0; j < R; j++) {
      const A = i * R + j, B = i * R + ((j + 1) % R), C = A + R, D = B + R;
      idx.push(A, B, C, B, D, C);
    }
    return new RockMesh(pos, new Uint32Array(idx));
  },
};

/* ────────────────────────────── modifiers ────────────────────────────── */

/**
 * Mesh operators: (mesh, params, ctx) => void.
 * ctx = { noise, rng, S, size, offset, traits } where S is the form's feature
 * scale in metres — amplitudes and frequencies below are expressed relative to
 * it, so a recipe keeps its character when the rock is resized.
 */
const MODIFIERS = {
  /** Fractal displacement along the surface. `ridged` blends in sharp crests, `warp` bends the field. */
  displace(m, p, { noise, S, offset }) {
    const { amp = 0.1, freq = 1, octaves = 4, gain = 0.5, ridged = 0, warp = 0 } = p;
    if (amp === 0) return;
    const pos = m.pos, N = m.dirs(), f = freq / S, a = amp * S;
    for (let i = 0; i < pos.length; i += 3) {
      let x = (pos[i] + offset[0]) * f, y = (pos[i + 1] + offset[1]) * f, z = (pos[i + 2] + offset[2]) * f;
      if (warp) {
        const wx = noise.perlin(x * 0.5 + 40, y * 0.5, z * 0.5), wy = noise.perlin(x * 0.5, y * 0.5 + 40, z * 0.5);
        x += wx * warp; y += wy * warp; z += (wx - wy) * warp * 0.5;
      }
      let v = noise.fbm(x, y, z, octaves, 2, gain);
      if (ridged) v = lerp(v, noise.ridged(x, y, z, octaves) * 2 - 1, ridged);
      pos[i] += N[i] * a * v; pos[i + 1] += N[i + 1] * a * v; pos[i + 2] += N[i + 2] * a * v;
    }
  },

  /**
   * Planar cuts — the thing that makes a blob read as broken rock.
   * mode 'global': slice the whole shape with random planes (boulders).
   * mode 'local' : flatten patches of radius `radius` around random vertices (cliffs, peaks).
   */
  cut(m, p, { rng, S }) {
    const { count = 8, depth = 0.25, mode = 'global', radius = 0.8, jitter = 0.7 } = p;
    if (count <= 0 || depth <= 0) return;
    const pos = m.pos, lock = m.lock, n = m.count;
    if (mode === 'global') {
      const c = m.bounds().center;
      for (let k = 0; k < count; k++) {
        let dx, dy, dz, l;
        do { dx = rng() * 2 - 1; dy = rng() * 2 - 1; dz = rng() * 2 - 1; l = dx * dx + dy * dy + dz * dz; } while (l > 1 || l < 0.01);
        l = Math.sqrt(l); dx /= l; dy /= l; dz /= l;
        if (dy < -0.35) dy = -dy * 0.5;                                 // the buried side rarely fractures
        let support = 0;
        for (let i = 0; i < pos.length; i += 3) {
          const d = (pos[i] - c[0]) * dx + (pos[i + 1] - c[1]) * dy + (pos[i + 2] - c[2]) * dz;
          if (d > support) support = d;
        }
        const dist = support * (1 - depth * (0.3 + 0.7 * rng()));
        for (let i = 0, v = 0; i < pos.length; i += 3, v++) {
          const s = ((pos[i] - c[0]) * dx + (pos[i + 1] - c[1]) * dy + (pos[i + 2] - c[2]) * dz - dist) * (lock ? lock[v] : 1);
          if (s > 0) { pos[i] -= dx * s; pos[i + 1] -= dy * s; pos[i + 2] -= dz * s; }
        }
      }
      return;
    }
    const N = Float32Array.from(m.normals());
    for (let k = 0; k < count; k++) {
      const a = ((rng() * n) | 0) * 3;
      let dx = N[a] + (rng() * 2 - 1) * jitter, dy = N[a + 1] + (rng() * 2 - 1) * jitter, dz = N[a + 2] + (rng() * 2 - 1) * jitter;
      const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
      const R = radius * S * (0.45 + rng()), ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
      const dist = ax * dx + ay * dy + az * dz - depth * S * (0.2 + 0.8 * rng());
      for (let i = 0, v = 0; i < pos.length; i += 3, v++) {
        const s = pos[i] * dx + pos[i + 1] * dy + pos[i + 2] * dz - dist;
        if (s <= 0) continue;
        const r = Math.hypot(pos[i] - ax, pos[i + 1] - ay, pos[i + 2] - az);
        if (r >= R) continue;
        const w = (1 - smoothstep(0.65 * R, R, r)) * (lock ? lock[v] : 1) * s;
        pos[i] -= dx * w; pos[i + 1] -= dy * w; pos[i + 2] -= dz * w;
      }
    }
  },

  /**
   * Sedimentary layering: each bed sticks out or erodes back by a random amount.
   * Also records the bed value per vertex (mesh.band) for colour banding.
   */
  strata(m, p, { noise, S, offset, size }) {
    const { depth = 0.08, layers = 10, tilt = 0, warp = 0.35, sharp = 0.8 } = p;
    const pos = m.pos, N = m.dirs(), band = m.band, a = depth * S;
    const t = (tilt * Math.PI) / 180, ux = Math.sin(t), uy = Math.cos(t), uz = Math.sin(t * 0.37) * 0.3;
    const ul = Math.hypot(ux, uy, uz), U = [ux / ul, uy / ul, uz / ul];
    const k = layers / size[1], w = lerp(0.5, 0.06, sharp), wf = 0.35 / S;
    for (let i = 0, v = 0; i < pos.length; i += 3, v++) {
      const x = pos[i] + offset[0], y = pos[i + 1] + offset[1], z = pos[i + 2] + offset[2];
      const s = (x * U[0] + y * U[1] + z * U[2]) * k + warp * noise.perlin(x * wf, y * wf, z * wf) + 100;
      const li = Math.floor(s), f = s - li, e = smoothstep(1 - 2 * w, 1, f);
      const val = lerp(noise.hash(li) * 2 - 1, noise.hash(li + 1) * 2 - 1, e);
      band[v] = lerp(noise.hash(li + 71) * 2 - 1, noise.hash(li + 72) * 2 - 1, e);
      if (a === 0) continue;
      const d = N[i] * U[0] + N[i + 1] * U[1] + N[i + 2] * U[2];
      const hx = m.dir ? 0 : N[i] - U[0] * d, hy = N[i + 1] - U[1] * d, hz = N[i + 2] - U[2] * d;
      const hl = Math.hypot(hx, hy, hz);
      if (hl < 1e-4) continue;
      const g = (a * val * Math.min(1, hl * 1.6)) / hl;                 // fades out on bed tops
      pos[i] += hx * g; pos[i + 1] += hy * g; pos[i + 2] += hz * g;
    }
  },

  /**
   * Joints and cracks from cellular noise. `columnar` stretches the cells
   * vertically (0 = blocky, 1 = basalt columns); `block` steps whole cells in or out.
   */
  fracture(m, p, { noise, S, offset }) {
    const { depth = 0.05, scale = 2, columnar = 0, block = 0, width = 0.12 } = p;
    if (depth === 0 && block === 0) return;
    const pos = m.pos, N = m.dirs(), cav = m.cavity, out = [0, 0, 0];
    const f = scale / S, fy = f * lerp(1, 0.08, columnar), fh = f * lerp(1, 1.5, columnar);
    for (let i = 0, v = 0; i < pos.length; i += 3, v++) {
      noise.worley((pos[i] + offset[0]) * fh, (pos[i + 1] + offset[1]) * fy, (pos[i + 2] + offset[2]) * fh, out);
      const crack = 1 - smoothstep(0, width, out[1] - out[0]);
      const d = (block * (out[2] - 0.5) * 2 * (1 - crack) - depth * crack) * S;
      pos[i] += N[i] * d; pos[i + 1] += N[i + 1] * d; pos[i + 2] += N[i + 2] * d;
      if (crack > cav[v]) cav[v] = crack;
    }
  },

  /** Laplacian relaxation — rounds edges the way wind, water and time do. Give `radius` (× S) or raw `iterations`. */
  smooth(m, p, { S }) {
    const { radius, strength = 0.5 } = p;
    let { iterations = 2 } = p;
    const pos = m.pos;
    if (radius !== undefined) {                     // resolution-independent: same softness at any detail level
      let sum = 0, n = 0;
      const step = Math.max(3, Math.floor(m.index.length / 3000) * 3);
      for (let i = 0; i < m.index.length; i += step, n++) {
        const a = m.index[i] * 3, b = m.index[i + 1] * 3;
        sum += Math.hypot(pos[a] - pos[b], pos[a + 1] - pos[b + 1], pos[a + 2] - pos[b + 2]);
      }
      iterations = Math.min(40, Math.round(Math.pow((radius * S) / (sum / n), 2) / strength));
    }
    if (iterations <= 0 || strength <= 0) return;
    const { start, list } = m.adjacency(), lock = m.lock, tmp = new Float32Array(pos.length);
    for (let it = 0; it < iterations; it++) {
      for (let v = 0; v < m.count; v++) {
        let x = 0, y = 0, z = 0;
        const s = start[v], e = start[v + 1];
        for (let j = s; j < e; j++) { const q = list[j] * 3; x += pos[q]; y += pos[q + 1]; z += pos[q + 2]; }
        const c = e - s || 1, w = strength * (lock ? lock[v] : 1), i = v * 3;
        tmp[i] = lerp(pos[i], x / c, w); tmp[i + 1] = lerp(pos[i + 1], y / c, w); tmp[i + 2] = lerp(pos[i + 2], z / c, w);
      }
      pos.set(tmp);
    }
  },

  /** Quantise height into benches (badlands, stepped plateaus). */
  terrace(m, p, { size }) {
    const { steps = 6, strength = 0.5, sharp = 0.75 } = p;
    if (strength <= 0) return;
    const pos = m.pos, h = size[1] / steps;
    for (let i = 1; i < pos.length; i += 3) {
      const s = pos[i] / h, f = s - Math.floor(s);
      pos[i] = lerp(pos[i], (Math.floor(s) + smoothstep(sharp, 1, f)) * h, strength);
    }
  },

  /** Drop the rock so `sink` × its height is below y = 0. */
  settle(m, p) {
    const { sink = 0.1 } = p;
    const b = m.bounds(), dy = -b.min[1] - sink * b.size[1];
    for (let i = 1; i < m.pos.length; i += 3) m.pos[i] += dy;
  },
};

/* ────────────────────────────── traits & surface ────────────────────────────── */

/**
 * Traits are the shared vocabulary between biomes and forms: a biome says how
 * weathered / layered / fractured its rock is, a form decides what that means
 * for its own modifier pipeline.
 */
const DEFAULT_TRAITS = {
  roughness: 0.5,   // 0..1  lumpiness of the silhouette and surface
  chipping: 0.4,    // 0..1  number and depth of planar breaks
  strata: 0.2,      // 0..1  relief of sedimentary layers
  layers: 10,       // count of beds across the form's height
  tilt: 0,          // degrees the beds dip
  fracture: 0.3,    // 0..1  depth of joints and cracks
  columnar: 0,      // 0..1  blocky joints → vertical columns
  weathering: 0.3,  // 0..1  how far edges are rounded off
};

const DEFAULT_SURFACE = {
  texture: 'granite',                     // key into ROCK_TEXTURES: grain, cracks, pits, laminations
  rockA: '#6b665e', rockB: '#8f897d',     // base rock, mixed by low-frequency noise
  accent: '#a0583c', banding: 0,          // colour of alternate beds, and how visible they are
  edgeWear: 0.5, cavity: 0.6,             // lighten exposed edges, darken cracks and hollows
  snow: 0, snowColor: '#eef3f8',          // settles on up-facing surfaces (and at altitude)
  moss: 0, mossColor: '#5d6e33',          // up-facing, patchy; low slopes on mountains
  sand: 0, sandColor: '#c9a877',          // drifts at the base and on ledges
  lichen: 0, lichenColor: '#b9a24a',      // speckled patches
  tide: 0, algaeColor: '#39442a',         // 0..1 height of the wet line; algae just below it
};

/* ────────────────────────────── forms ────────────────────────────── */

const jitterPath = (path, rng, amt) =>
  path.map((p, i) => (i === 0 || i === path.length - 1 ? p : [p[0] * (1 + (rng() - 0.5) * amt), p[1] + (rng() - 0.5) * amt * 0.12]));

/** Shared pipeline for compact, closed rocks. `k` scales the relief per form. */
const rockPipeline = (t, k = {}) => [
  ['displace', { amp: (0.06 + 0.22 * t.roughness) * (k.lumps ?? 1), freq: k.lumpFreq ?? 0.8, octaves: 3, warp: 0.4 }],
  ['strata', { depth: 0.11 * t.strata * (k.strata ?? 1), layers: t.layers, tilt: t.tilt, sharp: 0.85 }],
  ['cut', { mode: k.cut ?? 'global', count: Math.round((k.cuts ?? 18) * (0.15 + t.chipping)), depth: (k.cutDepth ?? 0.34) * (0.3 + t.chipping), radius: k.cutRadius ?? 0.8 }],
  ['fracture', { depth: 0.07 * t.fracture, scale: k.cells ?? 2.4, columnar: t.columnar, block: 0.05 * t.fracture }],
  ['smooth', { radius: 0.2 * t.weathering }],
  ['displace', { amp: 0.012 + 0.04 * t.roughness, freq: 5, octaves: 4, ridged: 0.6 }],
  ['settle', { sink: k.sink ?? 0.12 }],
];

const latheForm = (label, size, profile, extra = {}) => ({
  label, size,
  params: { profile, jitter: 0.25, smooth: 1, lean: 0.4, ...extra.params },
  scale: (s) => Math.min(s[0], s[2]) * 0.5,
  base({ size: s, tris, rng, noise, params }) {
    const m = BASES.lathe({ path: jitterPath(params.profile, rng, params.jitter), tris, smooth: params.smooth });
    const sway = params.lean * Math.min(s[0], s[2]) * 0.5, ph = rng() * 50;
    for (let i = 0; i < m.pos.length; i += 3) {
      const t = clamp(m.pos[i + 1]);                // the axis wanders as it climbs
      m.pos[i] = m.pos[i] * s[0] / 2 + noise.perlin(t * 1.6 + ph, 0.5, 0.5) * sway * t;
      m.pos[i + 2] = m.pos[i + 2] * s[2] / 2 + noise.perlin(0.5, t * 1.6 + ph, 0.5) * sway * t;
      m.pos[i + 1] *= s[1];
    }
    return m;
  },
  pipeline: (t) => rockPipeline(t, { lumps: 1.4, lumpFreq: 0.7, cut: 'local', cuts: 30, cutDepth: 0.12, cutRadius: 0.75, sink: 0, ...extra.k }),
});

/**
 * A form = { label, size [w,h,d], params, scale(size), base(ctx), pipeline(traits, ctx) }.
 * `pipeline` returns ordered [modifierName, params] steps; `altitude: 1` marks
 * forms tall enough that snow and vegetation should follow height.
 */
const FORMS = {
  boulder: {
    label: 'Boulder', size: [2.4, 1.8, 2.1], params: {},
    scale: (s) => Math.min(...s) * 0.5,
    base({ size: s, tris }) {
      const m = BASES.sphere({ tris });
      for (let i = 0; i < m.pos.length; i += 3) { m.pos[i] *= s[0] / 2; m.pos[i + 1] *= s[1] / 2; m.pos[i + 2] *= s[2] / 2; }
      return m;
    },
    pipeline: (t) => rockPipeline(t, { sink: 0.14, lumps: 1.25, cuts: 22 }),
  },

  slab: {
    label: 'Slab', size: [3.6, 0.8, 2.6], params: {},
    scale: (s) => Math.min(s[0], s[2]) * 0.3,
    base: (ctx) => FORMS.boulder.base(ctx),
    pipeline: (t) => rockPipeline(t, { lumps: 0.55, strata: 1.4, cuts: 14, cutDepth: 0.4, sink: 0.2 }),
  },

  spire: latheForm('Spire', [2.6, 7, 2.4],
    [[0.9, -0.08], [1, 0], [0.8, 0.14], [0.62, 0.38], [0.52, 0.6], [0.36, 0.8], [0.18, 0.94], [0, 1]]),

  hoodoo: latheForm('Hoodoo', [2.4, 6, 2.4],
    [[0.8, -0.08], [0.85, 0], [0.58, 0.16], [0.44, 0.38], [0.36, 0.56], [0.32, 0.68], [0.66, 0.74], [0.74, 0.83], [0.58, 0.93], [0.26, 0.99], [0, 1]],
    { k: { cuts: 20, cutDepth: 0.09, cutRadius: 0.6, lumps: 0.9 } }),

  stack: latheForm('Sea stack', [4.2, 6.5, 3.6],
    [[1, -0.08], [0.96, 0], [0.7, 0.07], [0.68, 0.17], [0.86, 0.3], [0.82, 0.58], [0.72, 0.84], [0.5, 0.96], [0, 1]]),

  mesa: latheForm('Mesa', [12, 6, 10],
    [[1.06, -0.04], [1, 0], [0.84, 0.22], [0.72, 0.44], [0.69, 0.5], [0.67, 0.9], [0.63, 0.985], [0.32, 1], [0, 1]],
    { params: { smooth: 0, jitter: 0.12, lean: 0.08 }, k: { cut: 'local', cuts: 40, cutDepth: 0.1, cutRadius: 0.35, lumps: 0.45, lumpFreq: 2.2, cells: 5 } }),

  arch: {
    label: 'Arch', size: [9, 6, 2.6], params: { asymmetry: 0.3 },
    scale: (s) => Math.min(s[1] * 0.2, s[2] * 0.5),
    base({ size: s, tris, rng, params }) {
      const skew = (rng() - 0.5) * params.asymmetry, w = s[0] / 2, h = s[1], pts = [];
      for (let i = 0; i <= 10; i++) {
        const a = Math.PI * (i / 10), lift = 1 + skew * Math.cos(a);
        pts.push([-Math.cos(a) * w * 0.82, Math.sin(a) * h * 0.86 * lift - (i === 0 || i === 10 ? h * 0.12 : 0), 0]);
      }
      const legR = h * 0.2, crown = h * (0.11 + rng() * 0.04);
      return BASES.tube({
        points: pts, tris,
        radius: (t) => { const k = Math.pow(Math.sin(Math.PI * t), 0.7); return [lerp(legR, crown, k), (s[2] / 2) * lerp(1, 0.72, k)]; },
      });
    },
    pipeline: (t) => rockPipeline(t, { cut: 'local', cuts: 30, cutDepth: 0.3, cutRadius: 1.3, lumps: 0.9, sink: 0 }).slice(0, -1),
  },

  cliff: {
    label: 'Cliff', size: [10, 7, 4], tileable: true,
    params: { profile: [[0.5, -0.1], [0.5, 0], [0.4, 0.34], [0.36, 0.7], [0.3, 0.955], [0.2, 1], [-0.5, 1], [-0.5, -0.1]] },
    scale: (s) => Math.min(s[1], s[0]) * 0.22,
    base({ size: s, tris, params }) {
      const m = BASES.extrude({ path: params.profile.map((p) => [p[0] * s[2], p[1] * s[1]]), width: s[0], tris, smooth: 1 });
      m.pin = new Float32Array(m.count);              // back and underside stay flat so modules sit against terrain
      for (let v = 0; v < m.count; v++) m.pin[v] = smoothstep(-0.5 * s[2], -0.15 * s[2], m.pos[v * 3 + 2]) * smoothstep(-0.1 * s[1], 0, m.pos[v * 3 + 1]);
      return m;
    },
    pipeline: (t) => [
      ['displace', { amp: 0.25 + 0.5 * t.roughness, freq: 0.45, octaves: 4, warp: 0.5 }],
      ['strata', { depth: 0.42 * t.strata, layers: t.layers, tilt: t.tilt, sharp: 0.9, warp: 0.5 }],
      ['fracture', { depth: 0.2 * t.fracture, scale: 1.1, columnar: t.columnar, block: 0.26 * t.fracture }],
      ['cut', { mode: 'local', count: Math.round(70 * t.chipping), depth: 0.15 + 0.3 * t.chipping, radius: 0.9 }],
      ['smooth', { radius: 0.2 * t.weathering }],
      ['displace', { amp: 0.03 + 0.07 * t.roughness, freq: 3.5, octaves: 4, ridged: 0.6 }],
    ],
  },

  mountain: {
    label: 'Mountain', size: [60, 26, 60], altitude: 1,
    params: { peakiness: 1.5, ridges: 0.6, ridgeFreq: 2.2 },
    scale: (s) => s[1] * 0.25,
    base({ size: s, tris, noise, offset, params, traits }) {
      const f = params.ridgeFreq / Math.max(s[0], s[2]);
      const m = BASES.heightfield({
        width: s[0], depth: s[2], tris, trim: 1e-4,
        height(x, z) {
          const u = x / (s[0] / 2), v = z / (s[2] / 2);
          const X = (x + offset[0]) * f, Z = (z + offset[2]) * f;
          const wx = noise.fbm(X + 9, 0.5, Z, 3), wz = noise.fbm(X, 7.5, Z + 9, 3);
          const r = Math.hypot(u, v) * (1 + 0.22 * wx);
          const cone = Math.pow(clamp(1 - r), params.peakiness);
          const ridge = noise.ridged(X + wx * 0.35, 1.7, Z + wz * 0.35, 6);
          const lumps = noise.fbm(X * 2, 3.1, Z * 2, 4) * 0.5 + 0.5;
          const body = cone * (1 - params.ridges) + (0.25 + cone) * params.ridges * lerp(lumps, ridge, 0.45 + 0.5 * traits.roughness);
          return body * smoothstep(1, 0.25, r);
        },
      });
      let top = 1e-6;
      for (let i = 1; i < m.pos.length; i += 3) top = Math.max(top, m.pos[i]);
      m.pin = new Float32Array(m.count);
      for (let i = 0, v = 0; i < m.pos.length; i += 3, v++) {
        m.pos[i + 1] *= s[1] / top;
        m.pin[v] = smoothstep(0, 0.07, m.pos[i + 1] / s[1]);            // the rim stays on the ground plane
      }
      return m;
    },
    pipeline: (t) => [
      ['terrace', { steps: Math.max(2, Math.round(t.layers * 0.6)), strength: 0.75 * t.strata }],
      ['strata', { depth: 0.1 * t.strata, layers: t.layers, tilt: t.tilt, sharp: 0.85 }],
      ['fracture', { depth: 0.07 * t.fracture, scale: 2.2, columnar: t.columnar * 0.6, block: 0.08 * t.fracture }],
      ['cut', { mode: 'local', count: Math.round(110 * t.chipping), depth: 0.1 + 0.25 * t.chipping, radius: 0.8, jitter: 0.45 }],
      ['smooth', { radius: 0.12 * t.weathering }],
      ['displace', { amp: 0.02 + 0.06 * t.roughness, freq: 5, octaves: 4, ridged: 0.7 }],
    ],
  },
};

/* ────────────────────────────── biomes ────────────────────────────── */

/**
 * A biome = { label, traits, surface, environment }.
 * `environment` is only a lighting suggestion for viewers; the generator ignores it.
 */
const BIOMES = {
  hills: {
    label: 'Hills',
    traits: { roughness: 0.5, chipping: 0.35, strata: 0.15, layers: 8, tilt: 8, fracture: 0.3, columnar: 0, weathering: 0.5 },
    surface: { texture: 'granite', rockA: '#5f5d57', rockB: '#8b877c', accent: '#75695a', banding: 0.15, moss: 0.52, mossColor: '#5a6e2e', lichen: 0.3, lichenColor: '#a9a97a' },
    environment: { skyTop: '#5d8fc4', skyHorizon: '#cfe0e6', ground: '#5e6c3c', sun: '#fff1d6', elevation: 42, azimuth: 35, water: null },
  },
  desert: {
    label: 'Desert',
    traits: { roughness: 0.35, chipping: 0.2, strata: 0.75, layers: 16, tilt: 3, fracture: 0.2, columnar: 0.3, weathering: 0.55 },
    surface: { texture: 'sandstone', rockA: '#a65a36', rockB: '#cf8a55', accent: '#e9c79a', banding: 0.75, sand: 0.45, sandColor: '#d7a56b', edgeWear: 0.35 },
    environment: { skyTop: '#4f8fcf', skyHorizon: '#f1d9b4', ground: '#cf9a62', sun: '#ffe2b0', elevation: 30, azimuth: 60, water: null },
  },
  coastal: {
    label: 'Coastal',
    traits: { roughness: 0.55, chipping: 0.45, strata: 0.4, layers: 12, tilt: 18, fracture: 0.45, columnar: 0.15, weathering: 0.45 },
    surface: { texture: 'slate', rockA: '#4a4d50', rockB: '#7c7a72', accent: '#958a76', banding: 0.3, tide: 0.26, algaeColor: '#39452a', lichen: 0.3, lichenColor: '#b39a5a', sand: 0.12, sandColor: '#cbb994' },
    environment: { skyTop: '#6f9cc0', skyHorizon: '#dbe6e6', ground: '#b9a983', sun: '#fff4e0', elevation: 38, azimuth: -40, water: '#2f6f7d' },
  },
  tundra: {
    label: 'Tundra',
    traits: { roughness: 0.5, chipping: 0.8, strata: 0.2, layers: 9, tilt: -12, fracture: 0.65, columnar: 0, weathering: 0.08 },
    surface: { texture: 'granite', rockA: '#55585c', rockB: '#868a8c', accent: '#6c6a66', banding: 0.15, snow: 0.5, lichen: 0.45, lichenColor: '#b6b25a', moss: 0.18, mossColor: '#6f6a3a' },
    environment: { skyTop: '#8ea9c2', skyHorizon: '#e6ebee', ground: '#d9e0e4', sun: '#f4f1ea', elevation: 20, azimuth: 25, water: null },
  },
  alpine: {
    label: 'Alpine',
    traits: { roughness: 0.65, chipping: 0.7, strata: 0.25, layers: 12, tilt: 24, fracture: 0.5, columnar: 0.1, weathering: 0.12 },
    surface: { texture: 'granite', rockA: '#575960', rockB: '#9a9a98', accent: '#7d7468', banding: 0.2, snow: 0.42, moss: 0.3, mossColor: '#4c5f33', lichen: 0.2, lichenColor: '#9aa06a' },
    environment: { skyTop: '#3f7fc9', skyHorizon: '#cfe1f1', ground: '#68754a', sun: '#fff6e6', elevation: 48, azimuth: 50, water: null },
  },
  volcanic: {
    label: 'Volcanic',
    traits: { roughness: 0.45, chipping: 0.5, strata: 0.05, layers: 6, tilt: 0, fracture: 0.9, columnar: 0.95, weathering: 0.15 },
    surface: { texture: 'basalt', rockA: '#37373c', rockB: '#5a5450', accent: '#7a3b24', banding: 0.25, sand: 0.25, sandColor: '#3b3837', lichen: 0.15, lichenColor: '#8a8f55', edgeWear: 0.7 },
    environment: { skyTop: '#6c7f96', skyHorizon: '#d9cfc6', ground: '#4b4745', sun: '#ffe7cf', elevation: 32, azimuth: -55, water: null },
  },
};

/* ────────────────────────────── surface painting ────────────────────────────── */

const linear = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };

/**
 * Bake biome colouring into per-vertex data (linear RGB). Runs after all modifiers.
 * Returns:
 *   rock   rgb   bare rock: base mix, bed banding, crevice darkening, edge wear
 *   cover  rgba  whatever lies on the rock (lichen, algae, moss, sand, snow) and how much
 *   wet    f     1 below the tide line
 *   color  rgb   rock and cover already blended — for plain vertex-colour materials and export
 */
function paint(m, s, { noise, S, offset, altitude = 0 }) {
  const n = m.count, pos = m.pos, N = m.normals(), { start, list } = m.adjacency();
  const rock = new Float32Array(n * 3), cover = new Float32Array(n * 4), wet = new Float32Array(n), color = new Float32Array(n * 3);
  if (m.seam) {                                   // seam vertices get a normal both neighbours agree on
    const { rings, perRing: K } = m.seam;
    for (const r of [0, rings - 1]) for (let k = 0; k < K; k++) {
      const v = (r * K + k) * 3, a = (r * K + ((k + K - 1) % K)) * 3, b = (r * K + ((k + 1) % K)) * 3;
      const tz = pos[b + 2] - pos[a + 2], ty = pos[b + 1] - pos[a + 1], l = Math.hypot(tz, ty) || 1;
      N[v] = 0; N[v + 1] = -tz / l; N[v + 2] = ty / l;
    }
  }
  const A = linear(s.rockA), B = linear(s.rockB), ACC = linear(s.accent);
  const SNOW = linear(s.snowColor), MOSS = linear(s.mossColor), SAND = linear(s.sandColor), LICH = linear(s.lichenColor), ALGAE = linear(s.algaeColor);
  const H = Math.max(m.bounds().max[1], 1e-3);
  const seamK = m.seam ? m.seam.perRing : 0, seamLast = m.seam ? (m.seam.rings - 1) * seamK : 0;
  const c = [0, 0, 0], cv = [0, 0, 0, 0], mossy = [0, 0, 0];
  const over = (t, k) => {                        // composite a cover layer over the ones below it
    if (k <= 0) return;
    const a = k + cv[3] * (1 - k);
    for (let j = 0; j < 3; j++) cv[j] = (t[j] * k + cv[j] * cv[3] * (1 - k)) / a;
    cv[3] = a;
  };
  const f1 = 0.7 / S, f2 = 4.5 / S, f3 = 7 / S;
  for (let v = 0, i = 0; v < n; v++, i += 3) {
    const y = pos[i + 1], ny = N[i + 1], h = clamp(y / H);
    const x = pos[i] + offset[0], wy = y + offset[1], z = pos[i + 2] + offset[2];
    const big = noise.fbm(x * f1 + 50, wy * f1, z * f1, 3), fine = noise.fbm(x * f2, wy * f2 + 50, z * f2, 3);

    const t = smoothstep(-0.6, 0.6, big + fine * 0.25);
    c[0] = lerp(A[0], B[0], t); c[1] = lerp(A[1], B[1], t); c[2] = lerp(A[2], B[2], t);
    if (s.banding > 0) {
      const b = m.band[v];
      if (b > 0) { const k = clamp(s.banding * b * 1.2); c[0] += (ACC[0] - c[0]) * k; c[1] += (ACC[1] - c[1]) * k; c[2] += (ACC[2] - c[2]) * k; }
      else { const k = 1 + s.banding * b * 0.45; c[0] *= k; c[1] *= k; c[2] *= k; }
    }

    // curvature from the neighbour ring: hollows darken, exposed edges lighten
    let ax = 0, ay = 0, az = 0, el = 0;
    const onSeam = seamK && (v < seamK || (v >= seamLast && v < seamLast + seamK));
    const s0 = onSeam ? 0 : start[v], s1 = onSeam ? 2 : start[v + 1];
    for (let j = s0; j < s1; j++) {
      const q = (onSeam ? v - (v % seamK) + ((v % seamK) + (j ? 1 : seamK - 1)) % seamK : list[j]) * 3;
      const dx = pos[q] - pos[i], dy = pos[q + 1] - y, dz = pos[q + 2] - pos[i + 2];
      ax += dx; ay += dy; az += dz; el += Math.hypot(dx, dy, dz);
    }
    const curv = el > 0 ? ((ax * N[i] + ay * ny + az * N[i + 2]) / el) * 6 : 0;
    const shade = (1 - s.cavity * 0.6 * clamp(Math.max(curv, 0) + m.cavity[v] * 0.7)) * lerp(0.8, 1, smoothstep(0, 0.1 * H, y));
    const wear = s.edgeWear * 0.3 * clamp(-curv);
    for (let j = 0; j < 3; j++) { c[j] *= shade; c[j] += (1 - c[j]) * wear; }

    cv[3] = 0;
    let wetness = 0;
    if (s.lichen > 0) {                            // broad crusty patches; the shader breaks up their edges
      const patch = noise.fbm(x * f3 * 0.3 + 9, wy * f3 * 0.3 + 4, z * f3 * 0.3, 3);
      over(LICH, smoothstep(0.75 - s.lichen, 1.05 - s.lichen, patch + fine * 0.2) * 0.5 * smoothstep(-0.4, 0.2, ny));
    }
    if (s.tide > 0) {
      const ty = (s.tide + fine * 0.035) * H;
      wetness = 1 - smoothstep(ty - 0.012 * H, ty + 0.012 * H, y);
      const salt = (1 - smoothstep(ty, ty + 0.07 * H, y)) * (1 - wetness) * 0.2;
      for (let j = 0; j < 3; j++) c[j] += (0.8 - c[j]) * salt;
      over(ALGAE, wetness * smoothstep(ty - 0.24 * H, ty - 0.02 * H, y) * (0.45 + 0.2 * big));
    }
    if (s.moss > 0) {
      const thr = lerp(1.15, 0.1, s.moss);
      let k = smoothstep(thr, thr + 0.28, ny + big * 0.3 + fine * 0.15);
      if (altitude) k = Math.max(k * (1 - smoothstep(0.3, 0.62, h + big * 0.08)), (1 - smoothstep(0.02, 0.09, h)) * Math.min(1, s.moss * 3));
      mossy[0] = MOSS[0] * (0.8 + fine * 0.3); mossy[1] = MOSS[1] * (0.85 + fine * 0.3); mossy[2] = MOSS[2] * 0.9;
      over(mossy, k * 0.95);
    }
    if (s.sand > 0) {
      const drift = 1 - smoothstep(0, (0.08 + 0.3 * s.sand) * H, y + fine * 0.04 * H);
      const ledge = smoothstep(0.6, 0.92, ny + fine * 0.1);
      over(SAND, clamp(s.sand * (ledge * 1.3 + drift * 1.5) + (drift - 0.5) * s.sand * 0.4));
    }
    if (s.snow > 0) {
      const thr = lerp(1.3, 0.05, s.snow);
      over(SNOW, smoothstep(thr, thr + 0.16, ny + big * 0.18 + fine * 0.1 + altitude * (h - 0.55) * 1.5));
    }

    const dim = lerp(1, 0.58, wetness);
    for (let j = 0; j < 3; j++) {
      rock[i + j] = c[j]; cover[v * 4 + j] = cv[j];
      color[i + j] = lerp(c[j] * dim, cv[j], cv[3]);
    }
    cover[v * 4 + 3] = cv[3]; wet[v] = wetness;
  }
  return { color, rock, cover, wet };
}

/* ────────────────────────────── geometry output ────────────────────────────── */

/** Painted arrays → attribute names the rock material reads. */
const SURFACE_ATTRS = { color: ['color', 3], rock: ['aRock', 3], cover: ['aCover', 4], wet: ['aWet', 1] };

/**
 * RockMesh → BufferGeometry. Faces meeting at more than `crease` degrees get a
 * hard edge, so chips stay crisp while weathered areas stay soft.
 * crease 0 = fully faceted, 180 = fully smooth (indexed, a third of the vertices).
 * `painted` is the object returned by paint() (or null for bare geometry).
 */
function toGeometry(m, painted, crease = 40) {
  const { pos, index } = m, geo = new THREE.BufferGeometry();
  const layers = Object.entries(painted || {}).filter(([k]) => SURFACE_ATTRS[k]).map(([k, src]) => ({ src, name: SURFACE_ATTRS[k][0], size: SURFACE_ATTRS[k][1] }));
  if (crease >= 180) {
    geo.setAttribute('position', new THREE.BufferAttribute(pos.slice(), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(m.normals().slice(), 3));
    for (const l of layers) geo.setAttribute(l.name, new THREE.BufferAttribute(l.src, l.size));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.computeBoundingSphere(); geo.computeBoundingBox();
    return geo;
  }
  const F = index.length / 3, fw = new Float32Array(F * 3), fu = new Float32Array(F * 3);
  const start = new Uint32Array(m.count + 1);
  for (let f = 0; f < F; f++) {
    const a = index[f * 3] * 3, b = index[f * 3 + 1] * 3, c = index[f * 3 + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz) || 1;
    fw.set([nx, ny, nz], f * 3); fu.set([nx / l, ny / l, nz / l], f * 3);
    start[index[f * 3] + 1]++; start[index[f * 3 + 1] + 1]++; start[index[f * 3 + 2] + 1]++;
  }
  for (let i = 0; i < m.count; i++) start[i + 1] += start[i];
  const fill = start.slice(0, m.count), faces = new Uint32Array(index.length);
  for (let f = 0; f < F; f++) for (let k = 0; k < 3; k++) faces[fill[index[f * 3 + k]]++] = f;

  const P = new Float32Array(F * 9), Nn = new Float32Array(F * 9);
  for (const l of layers) l.out = new Float32Array(F * 3 * l.size);
  const cosT = Math.cos((crease * Math.PI) / 180);
  for (let f = 0; f < F; f++) for (let k = 0; k < 3; k++) {
    const v = index[f * 3 + k], c = f * 3 + k, o = c * 3;
    let nx = 0, ny = 0, nz = 0;
    if (crease <= 0) { nx = fu[f * 3]; ny = fu[f * 3 + 1]; nz = fu[f * 3 + 2]; }
    else {
      for (let j = start[v]; j < start[v + 1]; j++) {
        const g = faces[j] * 3;
        if (fu[g] * fu[f * 3] + fu[g + 1] * fu[f * 3 + 1] + fu[g + 2] * fu[f * 3 + 2] >= cosT) { nx += fw[g]; ny += fw[g + 1]; nz += fw[g + 2]; }
      }
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    }
    P[o] = pos[v * 3]; P[o + 1] = pos[v * 3 + 1]; P[o + 2] = pos[v * 3 + 2];
    Nn[o] = nx; Nn[o + 1] = ny; Nn[o + 2] = nz;
    for (const l of layers) for (let j = 0; j < l.size; j++) l.out[c * l.size + j] = l.src[v * l.size + j];
  }
  geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(Nn, 3));
  for (const l of layers) geo.setAttribute(l.name, new THREE.BufferAttribute(l.out, l.size));
  geo.computeBoundingSphere(); geo.computeBoundingBox();
  return geo;
}

/* ────────────────────────────── rock textures ────────────────────────────── */

/**
 * Texture recipes. Each one drives createRockTextures(), which synthesises a
 * seamless height field and derives albedo detail, roughness and a normal map
 * from it — no image files. All weights are 0..1 unless noted.
 */
const ROCK_TEXTURES = {
  granite:   { bumps: 0.55, grain: 0.9, speckle: 1.0, cracks: 0.4, crackCells: 5, plates: 0.45, pits: 0.15, pitCells: 30, streaks: 0, tint: [0.06, 0.0, -0.06], roughness: [0.72, 0.98], relief: 1 },
  sandstone: { bumps: 0.6, grain: 0.75, speckle: 0.2, cracks: 0.3, crackCells: 4, plates: 0.2, pits: 0.6, pitCells: 22, streaks: 1.0, tint: [0.1, 0.0, -0.12], roughness: [0.86, 1.0], relief: 1 },
  basalt:    { bumps: 0.4, grain: 0.55, speckle: 0.15, cracks: 0.95, crackCells: 6, plates: 0.8, pits: 0.85, pitCells: 36, streaks: 0, tint: [0.1, 0.02, -0.04], roughness: [0.55, 0.95], relief: 1.15 },
  slate:     { bumps: 0.35, grain: 0.55, speckle: 0.2, cracks: 0.7, crackCells: 5, plates: 0.7, pits: 0.2, pitCells: 26, streaks: 0.85, tint: [0.04, 0.02, -0.03], roughness: [0.58, 0.95], relief: 1 },
};

/**
 * Build the two seamless maps a rock material needs.
 *   detail  rgb = albedo multiplier (0.5 is neutral), a = roughness
 *   normal  rgb = tangent-space normal,               a = height
 * `profile` is a ROCK_TEXTURES name or an object of the same shape.
 */
function createRockTextures(profile = 'granite', { size = 512, seed = 1 } = {}) {
  const p = { ...ROCK_TEXTURES.granite, ...(typeof profile === 'string' ? ROCK_TEXTURES[profile] : profile) };
  const noise = new Noise(seed + 101), Pm = noise.perm, n = size;
  const mod = (a, b) => ((a % b) + b) % b;
  const G = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7071, 0.7071], [-0.7071, 0.7071], [0.7071, -0.7071], [-0.7071, -0.7071]];
  const dot2 = (h, x, y) => { const g = G[h & 7]; return g[0] * x + g[1] * y; };
  const pnoise = (x, y, px, py) => {                    // gradient noise that repeats every (px, py)
    const X = Math.floor(x), Y = Math.floor(y), fx = x - X, fy = y - Y;
    const x0 = mod(X, px), x1 = (x0 + 1) % px, y0 = mod(Y, py), y1 = (y0 + 1) % py, u = fade(fx), v = fade(fy);
    return lerp(lerp(dot2(Pm[Pm[x0] + (y0 & 255)], fx, fy), dot2(Pm[Pm[x1] + (y0 & 255)], fx - 1, fy), u),
                lerp(dot2(Pm[Pm[x0] + (y1 & 255)], fx, fy - 1), dot2(Pm[Pm[x1] + (y1 & 255)], fx - 1, fy - 1), u), v) * 1.5;
  };
  const pfbm = (u, v, fx, fy, octaves, gain = 0.5) => {
    let sum = 0, amp = 1, norm = 0;
    for (let o = 0; o < octaves; o++) { sum += amp * pnoise(u * fx + o * 0.37, v * fy + o * 0.71, fx, fy); norm += amp; amp *= gain; fx *= 2; fy *= 2; }
    return sum / norm;
  };
  const pworley = (x, y, cells, out) => {               // cellular noise that repeats every `cells`
    const xi = Math.floor(x), yi = Math.floor(y);
    let d1 = 9, d2 = 9, id = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx, cy = yi + dy, h = Pm[Pm[mod(cx, cells) & 255] + (mod(cy, cells) & 255)];
      const qx = cx + Pm[h] / 255 - x, qy = cy + Pm[h + 1] / 255 - y, d = qx * qx + qy * qy;
      if (d < d1) { d2 = d1; d1 = d; id = h; } else if (d < d2) d2 = d;
    }
    out[0] = Math.sqrt(d1); out[1] = Math.sqrt(d2); out[2] = id / 255;
  };

  const Hf = new Float32Array(n * n), detail = new Uint8Array(n * n * 4), normal = new Uint8Array(n * n * 4);
  const w1 = [0, 0, 0], w2 = [0, 0, 0], cc = p.crackCells, pc = p.pitCells;
  for (let j = 0, k = 0; j < n; j++) for (let i = 0; i < n; i++, k++) {
    const u = (i + 0.5) / n, v = (j + 0.5) / n;
    const broad = pfbm(u, v, 3, 3, 5), fine = pfbm(u, v, 24, 24, 4, 0.62);
    const lam = p.streaks ? pfbm(u, v, 2, 28, 4, 0.6) : 0;                       // laminations run along u
    const wu = u + 0.035 * pfbm(u, v + 0.5, 5, 5, 3), wv = v + 0.035 * pfbm(u + 0.5, v, 5, 5, 3);
    pworley(wu * cc, wv * cc, cc, w1);
    const crack = (1 - smoothstep(0, 0.035 + 0.05 * w1[2], w1[1] - w1[0])) * (0.08 + 0.92 * smoothstep(-0.12, 0.35, pfbm(u + 0.3, v + 0.7, 3, 3, 3)));
    pworley(wu * pc, wv * pc, pc, w2);
    const pit = w2[2] < 0.08 + 0.5 * p.pits ? 1 - smoothstep(0.06 + w2[2] * 0.2, 0.2 + w2[2] * 0.3, w2[0]) : 0;

    const h = 0.5 + 0.2 * p.bumps * broad + 0.075 * p.grain * fine + 0.13 * p.streaks * lam
      + 0.12 * p.plates * (w1[2] - 0.5) * (1 - crack) - 0.42 * p.cracks * crack - 0.3 * p.pits * pit;
    Hf[k] = h;

    const g = Pm[Pm[(i >> 1) & 255] + ((j >> 1) & 255)] / 255;                   // mineral grains, 2 px wide
    const mineral = g < 0.1 ? -0.34 : g > 0.88 ? 0.26 : (g - 0.5) * 0.16;
    let L = (0.72 + 0.56 * clamp(h)) * (1 - 0.5 * p.cracks * crack) * (1 - 0.28 * p.pits * pit);
    L *= 1 + p.speckle * mineral + 0.12 * p.streaks * lam + 0.05 * p.grain * fine;
    const stain = pfbm(u + 0.5, v + 0.25, 2, 2, 4) * 1.6;
    for (let c = 0; c < 3; c++) detail[k * 4 + c] = clamp(L * (1 + p.tint[c] * stain) * 0.5) * 255;
    const rough = lerp(p.roughness[0], p.roughness[1], clamp(0.55 + 0.6 * fine + 0.4 * crack - (g > 0.88 ? 0.5 * p.speckle : 0)));
    detail[k * 4 + 3] = clamp(rough) * 255;
  }
  const slope = 0.03 * n * p.relief;
  for (let j = 0, k = 0; j < n; j++) for (let i = 0; i < n; i++, k++) {
    const dx = (Hf[j * n + ((i + 1) % n)] - Hf[j * n + ((i + n - 1) % n)]) * slope;
    const dy = (Hf[((j + 1) % n) * n + i] - Hf[((j + n - 1) % n) * n + i]) * slope;
    const l = Math.hypot(dx, dy, 1);
    normal[k * 4] = (-dx / l * 0.5 + 0.5) * 255; normal[k * 4 + 1] = (-dy / l * 0.5 + 0.5) * 255;
    normal[k * 4 + 2] = (1 / l * 0.5 + 0.5) * 255; normal[k * 4 + 3] = clamp(Hf[k]) * 255;
  }
  const wrap = (data) => {
    const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true; t.anisotropy = 8; t.needsUpdate = true;
    return t;
  };
  return { detail: wrap(detail), normal: wrap(normal) };
}

/**
 * PBR rock material. Projects the generated maps from three axes (triplanar)
 * at three scales, so rocks need no UVs, the tiling never shows and there is
 * detail both from across a valley and with the camera against the stone; snow, moss
 * and sand are blended per pixel using the texture's height, which is what
 * gives them a crisp, settled-in-the-crevices edge.
 *
 *   textures  { detail, normal } from createRockTextures()
 *   tile      metres per texture repeat
 *   relief    normal-map strength
 *   macro     0..1 weight of the 4× larger projection (breaks up repetition at distance)
 *   micro     0..1 weight of the 4× finer projection (grain when the camera is close)
 */
function createRockMaterial({ textures, tile = 2.5, relief = 1, macro = 0.7, micro = 0.55, ...rest } = {}) {
  const tex = textures || createRockTextures();
  const mat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, ...rest });
  mat.userData.uniforms = {
    tRockDetail: { value: tex.detail }, tRockNormal: { value: tex.normal },
    uTile: { value: 1 / tile }, uRelief: { value: relief }, uMacro: { value: macro }, uMicro: { value: micro },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, mat.userData.uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 aRock; attribute vec4 aCover; attribute float aWet;
        varying vec3 vRockPos, vRockNrm, vRock; varying vec4 vCover; varying float vWet;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vRockPos = position; vRockNrm = normal; vRock = aRock; vCover = aCover; vWet = aWet;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vRockPos, vRockNrm, vRock; varying vec4 vCover; varying float vWet;
        uniform sampler2D tRockDetail, tRockNormal;
        uniform float uTile, uRelief, uMacro, uMicro;
        uniform highp mat3 normalMatrix;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 rkN = normalize(vRockNrm);
        vec3 rkW = pow(abs(rkN), vec3(4.0)); rkW /= rkW.x + rkW.y + rkW.z;
        vec3 rkP = vRockPos * uTile, rkQ = rkP * 0.23 + 0.37, rkF = rkP * 4.3 + 0.61;
        vec4 rkD = texture2D(tRockDetail, rkP.zy) * rkW.x + texture2D(tRockDetail, rkP.xz) * rkW.y + texture2D(tRockDetail, rkP.xy) * rkW.z;
        vec4 rkDf = texture2D(tRockDetail, rkF.zy) * rkW.x + texture2D(tRockDetail, rkF.xz) * rkW.y + texture2D(tRockDetail, rkF.xy) * rkW.z;
        vec4 rkXf = texture2D(tRockNormal, rkF.zy), rkYf = texture2D(tRockNormal, rkF.xz), rkZf = texture2D(tRockNormal, rkF.xy);
        vec4 rkDm = texture2D(tRockDetail, rkQ.zy) * rkW.x + texture2D(tRockDetail, rkQ.xz) * rkW.y + texture2D(tRockDetail, rkQ.xy) * rkW.z;
        vec4 rkX = texture2D(tRockNormal, rkP.zy), rkY = texture2D(tRockNormal, rkP.xz), rkZ = texture2D(tRockNormal, rkP.xy);
        vec4 rkXm = texture2D(tRockNormal, rkQ.zy), rkYm = texture2D(tRockNormal, rkQ.xz), rkZm = texture2D(tRockNormal, rkQ.xy);
        float rkH = dot(vec3(rkX.a, rkY.a, rkZ.a), rkW), rkHm = dot(vec3(rkXm.a, rkYm.a, rkZm.a), rkW);
        // cover settles into the low parts of the texture first
        float rkK = smoothstep(0.36, 0.64, vCover.a + (0.5 - mix(rkH, rkHm, 0.2)) * 1.1) * step(0.003, vCover.a);
        vec3 rkRock = vRock * rkD.rgb * 2.0 * mix(vec3(1.0), rkDm.rgb * 2.0, uMacro) * mix(vec3(1.0), rkDf.rgb * 2.0, uMicro) * mix(1.0, 0.55, vWet);
        vec3 rkCov = vCover.rgb * (0.72 + 0.56 * rkH) * mix(vec3(1.0), rkD.rgb * 2.0, 0.5);
        diffuseColor.rgb *= mix(rkRock, rkCov, rkK);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = clamp(mix(rkD.a * mix(1.0, 0.42, vWet), 0.9, rkK), 0.05, 1.0);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          float s = uRelief * (1.0 - 0.75 * rkK);
          vec2 ax = ((rkX.xy * 2.0 - 1.0) + (rkXm.xy * 2.0 - 1.0) * uMacro + (rkXf.xy * 2.0 - 1.0) * uMicro) * s;
          vec2 ay = ((rkY.xy * 2.0 - 1.0) + (rkYm.xy * 2.0 - 1.0) * uMacro + (rkYf.xy * 2.0 - 1.0) * uMicro) * s;
          vec2 az = ((rkZ.xy * 2.0 - 1.0) + (rkZm.xy * 2.0 - 1.0) * uMacro + (rkZf.xy * 2.0 - 1.0) * uMicro) * s;
          vec3 n = vec3(rkN.x, rkN.y + ax.y, rkN.z + ax.x) * rkW.x
                 + vec3(rkN.x + ay.x, rkN.y, rkN.z + ay.y) * rkW.y
                 + vec3(rkN.x + az.x, rkN.y + az.y, rkN.z) * rkW.z;
          normal = normalize(normalMatrix * normalize(n));
        }`);
  };
  return mat;
}

/* ────────────────────────────── generator ────────────────────────────── */

const hashOffset = (o) => (Math.imul(Math.round(o[0] * 16), 73856093) ^ Math.imul(Math.round(o[1] * 16), 19349663) ^ Math.imul(Math.round(o[2] * 16), 83492791)) >>> 0;

class RockGenerator {
  /**
   * Registries start as copies of the built-ins; add or replace entries freely:
   *   gen.biomes.jungle = { label: 'Jungle', traits: {...}, surface: {...} };
   *   gen.modifiers.twist = (mesh, params, ctx) => { ... };
   */
  constructor({ material, textureSize = 512 } = {}) {
    this.bases = { ...BASES };
    this.modifiers = { ...MODIFIERS };
    this.forms = { ...FORMS };
    this.biomes = { ...BIOMES };
    this.rockTextures = { ...ROCK_TEXTURES };
    this.material = material || null;   // set to force one material on everything
    this.textureSize = textureSize;
    this._textures = new Map();
    this.materials = new Map();         // every material handed out so far, keyed by texture + tile
  }

  /** Generated maps for a ROCK_TEXTURES entry (built once, then cached). */
  textures(name) {
    if (!this._textures.has(name)) {
      if (!this.rockTextures[name]) throw new Error(`Unknown texture "${name}". Known: ${Object.keys(this.rockTextures).join(', ')}`);
      this._textures.set(name, createRockTextures(this.rockTextures[name], { size: this.textureSize }));
    }
    return this._textures.get(name);
  }

  /** Shared material for a recipe: one per rock texture and (rounded) feature scale. */
  materialFor(recipe) {
    if (this.material) return this.material;
    const tile = Math.pow(2, Math.round(Math.log2(this.forms[recipe.form].scale(recipe.size) * 2.4) * 2) / 2);
    const key = recipe.surface.texture + '@' + tile.toFixed(2);
    if (!this.materials.has(key)) this.materials.set(key, createRockMaterial({ textures: this.textures(recipe.surface.texture), tile }));
    return this.materials.get(key);
  }

  /**
   * Turn loose options into a complete, serialisable recipe.
   * opts: { form, biome, seed, size, detail (0..1), offset, traits, surface, params, crease,
   *         pipeline: [[name, params], ...] | (steps, traits) => steps }
   */
  resolve(opts = {}) {
    const formName = opts.form || 'boulder', biomeName = opts.biome || 'hills';
    const form = this.forms[formName], biome = this.biomes[biomeName];
    if (!form) throw new Error(`Unknown form "${formName}". Known: ${Object.keys(this.forms).join(', ')}`);
    if (!biome) throw new Error(`Unknown biome "${biomeName}". Known: ${Object.keys(this.biomes).join(', ')}`);
    const traits = { ...DEFAULT_TRAITS, ...biome.traits, ...form.traits, ...opts.traits };
    const size = (opts.size || form.size).slice();
    let steps = form.pipeline(traits, { size });
    if (typeof opts.pipeline === 'function') steps = opts.pipeline(steps, traits);
    else if (Array.isArray(opts.pipeline)) steps = opts.pipeline;
    return {
      form: formName, biome: biomeName,
      seed: opts.seed ?? 1, size, detail: opts.detail ?? 0.5,
      offset: (opts.offset || [0, 0, 0]).slice(),
      crease: opts.crease ?? 42,
      traits,
      surface: { ...DEFAULT_SURFACE, ...biome.surface, ...opts.surface },
      params: deepMerge({}, form.params, opts.params),
      pipeline: steps.map(([name, p]) => [name, { ...p }]),
    };
  }

  /** Run a recipe as far as the deformed, painted RockMesh (no THREE objects). */
  sculpt(recipe) {
    const form = this.forms[recipe.form];
    const noise = new Noise(recipe.seed);
    const rng = mulberry32((recipe.seed * 9301 + 49297) ^ hashOffset(recipe.offset));
    const ctx = {
      noise, rng, size: recipe.size, offset: recipe.offset, traits: recipe.traits, params: recipe.params,
      S: form.scale(recipe.size), altitude: form.altitude || 0,
      tris: Math.round(lerp(1500, 70000, Math.pow(clamp(recipe.detail), 1.6))),
    };
    const mesh = form.base(ctx);
    const rest = mesh.pin ? mesh.pos.slice() : null;
    for (const [name, params] of recipe.pipeline) {
      const fn = this.modifiers[name];
      if (!fn) throw new Error(`Unknown modifier "${name}". Known: ${Object.keys(this.modifiers).join(', ')}`);
      fn(mesh, params, ctx);
    }
    if (rest) for (let i = 0; i < rest.length; i++) mesh.pos[i] = lerp(rest[i], mesh.pos[i], mesh.pin[(i / 3) | 0]);
    if (mesh.finish) mesh.finish();
    return { mesh, painted: paint(mesh, recipe.surface, ctx) };
  }

  /** Options (or a recipe from resolve) → BufferGeometry: position, normal, color + the rock material's aRock / aCover / aWet. */
  geometry(opts) {
    const recipe = opts.pipeline && opts.traits && opts.surface && Array.isArray(opts.pipeline) && opts.params ? opts : this.resolve(opts);
    const { mesh, painted } = this.sculpt(recipe);
    const geo = toGeometry(mesh, painted, recipe.crease);
    geo.userData.recipe = recipe;
    return geo;
  }

  /** Options → ready-to-add THREE.Mesh. The recipe is kept on mesh.userData.recipe. */
  build(opts = {}) {
    const geo = this.geometry(opts);
    const mesh = new THREE.Mesh(geo, this.materialFor(geo.userData.recipe));
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.name = `${geo.userData.recipe.form}-${geo.userData.recipe.biome}-${geo.userData.recipe.seed}`;
    mesh.userData.recipe = geo.userData.recipe;
    return mesh;
  }

  /**
   * Build `count` modules that continue each other along X (forms with `tileable: true`).
   * Every module shares the seed and differs only by its world-space offset.
   */
  tile(opts = {}, count = 3) {
    const group = new THREE.Group(), width = (opts.size || this.forms[opts.form || 'cliff'].size)[0];
    for (let i = 0; i < count; i++) {
      const x = (i - (count - 1) / 2) * width;
      const mesh = this.build({ ...opts, offset: [x, 0, 0] });
      mesh.position.x = x;
      group.add(mesh);
    }
    return group;
  }

  /**
   * Scatter debris: a few geometry variants, instanced many times with random
   * yaw, scale and position inside a ring (inner..radius) on the XZ plane.
   * opts: { biome, seed, count, radius, inner, forms, size: [min, max], variants, detail, traits, surface }
   */
  scatter(opts = {}) {
    const { biome = 'hills', seed = 1, count = 24, radius = 8, inner = 0, forms = ['boulder', 'slab'], size = [0.25, 1.4], variants = 5, detail = 0.22 } = opts;
    const rng = mulberry32(seed * 7919 + 13), group = new THREE.Group(), geos = [];
    for (let i = 0; i < variants; i++) {
      const form = forms[i % forms.length], fs = this.forms[form].size, top = Math.max(...fs);
      geos.push(this.geometry({
        form, biome, seed: seed * 31 + i, detail, traits: opts.traits, crease: opts.crease,
        surface: { ...opts.surface, tide: 0 },
        size: fs.map((v) => (v / top) * (0.8 + rng() * 0.4)),
      }));
    }
    const placed = [];
    for (let i = 0, tries = 0; i < count && tries < count * 30; tries++) {
      const r = Math.sqrt(lerp((inner * inner) / (radius * radius), 1, rng())) * radius, a = rng() * Math.PI * 2;
      const s = lerp(size[0], size[1], Math.pow(rng(), 1.9)), x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (placed.some((p) => Math.hypot(p[0] - x, p[1] - z) < (p[2] + s) * 0.55)) continue;
      placed.push([x, z, s]);
      const geo = geos[(rng() * geos.length) | 0];
      const mesh = new THREE.Mesh(geo, this.materialFor(geo.userData.recipe));
      mesh.position.set(x, 0, z);
      mesh.rotation.set((rng() - 0.5) * 0.3, rng() * Math.PI * 2, (rng() - 0.5) * 0.3);
      mesh.scale.setScalar(s);
      mesh.castShadow = mesh.receiveShadow = true;
      group.add(mesh);
      i++;
    }
    return group;
  }
}

/* ────────────────────────────── export ────────────────────────────── */

/**
 * Minimal binary glTF writer for anything this library builds (positions,
 * normals, blended vertex colours, node transforms). Returns an ArrayBuffer (.glb).
 * The generated textures live in the shader and are not part of the file.
 */
function exportGLB(root) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert(), rel = new THREE.Matrix4();
  const json = {
    asset: { version: '2.0', generator: 'rockgen.js' }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [],
    materials: [{ name: 'rock', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.94 } }],
    accessors: [], bufferViews: [], buffers: [{ byteLength: 0 }],
  };
  const chunks = [], seen = new Map();
  let offset = 0;
  const view = (array, target) => {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength), pad = (4 - (bytes.byteLength % 4)) % 4;
    json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength, target });
    chunks.push(bytes); if (pad) chunks.push(new Uint8Array(pad));
    offset += bytes.byteLength + pad;
    return json.bufferViews.length - 1;
  };
  const accessor = (attr, extra = {}) => {
    json.accessors.push({ bufferView: view(attr.array, 34962), componentType: 5126, count: attr.count, type: 'VEC3', ...extra });
    return json.accessors.length - 1;
  };
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry.attributes.position) return;
    let mi = seen.get(o.geometry);
    if (mi === undefined) {
      const g = o.geometry; g.computeBoundingBox();
      const attributes = { POSITION: accessor(g.attributes.position, { min: g.boundingBox.min.toArray(), max: g.boundingBox.max.toArray() }) };
      if (g.attributes.normal) attributes.NORMAL = accessor(g.attributes.normal);
      if (g.attributes.color) attributes.COLOR_0 = accessor(g.attributes.color);
      const prim = { attributes, material: 0 };
      if (g.index) {
        const idx = g.index.array instanceof Uint32Array ? g.index.array : Uint32Array.from(g.index.array);
        json.accessors.push({ bufferView: view(idx, 34963), componentType: 5125, count: idx.length, type: 'SCALAR' });
        prim.indices = json.accessors.length - 1;
      }
      mi = json.meshes.length; json.meshes.push({ name: o.name || 'rock', primitives: [prim] }); seen.set(g, mi);
    }
    rel.multiplyMatrices(inv, o.matrixWorld);
    json.scenes[0].nodes.push(json.nodes.length);
    json.nodes.push({ name: o.name || 'rock', mesh: mi, matrix: rel.toArray() });
  });
  json.buffers[0].byteLength = offset;
  let text = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (text.byteLength % 4)) % 4;
  const total = 12 + 8 + text.byteLength + jsonPad + 8 + offset;
  const out = new Uint8Array(total), dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, text.byteLength + jsonPad, true); dv.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20); out.fill(0x20, 20 + text.byteLength, 20 + text.byteLength + jsonPad);
  let p = 20 + text.byteLength + jsonPad;
  dv.setUint32(p, offset, true); dv.setUint32(p + 4, 0x004e4942, true); p += 8;
  for (const c of chunks) { out.set(c, p); p += c.byteLength; }
  return out.buffer;
}

const api = {
  RockGenerator, RockMesh, Noise, BASES, MODIFIERS, FORMS, BIOMES, DEFAULT_TRAITS, DEFAULT_SURFACE,
  ROCK_TEXTURES, paint, toGeometry, createRockTextures, createRockMaterial, exportGLB, mulberry32, deepMerge, clamp, lerp, smoothstep,
};
export default api;
