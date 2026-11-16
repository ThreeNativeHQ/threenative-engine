import { GeoBuilder, lin, mixc } from './GeoBuilder.js';
import { icosphere } from './icosphere.js';
import { mulberry32, range, pick, fbm } from './random.js';
import { addTube, addLeaf } from './primitives.js';

const WOOD = [lin('#4a3b2c'), lin('#5c4a38'), lin('#3a2e22'), lin('#6a5846')];
const MOSS = lin('#40601f');
const HEARTWOOD = lin('#b89a6a');

/** Path of points wandering along +X near the ground. */
function groundPath(rand, length, segs, r0, r1, wander, bump) {
  const pts = [];
  let x = -length / 2, y = r0, z = 0, yaw = range(rand, -0.2, 0.2);
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    pts.push({ x, y: y + Math.sin(t * Math.PI) * bump * rand(), z, r: r0 + (r1 - r0) * t });
    yaw += range(rand, -wander, wander);
    x += (Math.cos(yaw) * length) / segs; z += (Math.sin(yaw) * length) / segs;
  }
  return pts;
}

function sideShoots(b, rand, pts, count, len, radial, col, lift) {
  for (let i = 0; i < count; i++) {
    const p = pts[1 + Math.floor(rand() * (pts.length - 2))], a = range(rand, 0.5, 1.2) * (rand() < 0.5 ? -1 : 1) + range(rand, -0.2, 0.2);
    const L = range(rand, len[0], len[1]), up = range(rand, 0, lift), shoot = [];
    for (let k = 0; k <= 3; k++) {
      const t = k / 3;
      shoot.push({ x: p.x + Math.cos(a) * L * t, y: p.y + up * L * t, z: p.z + Math.sin(a) * L * t + range(rand, -0.02, 0.02) * L, r: p.r * 0.55 * (1 - t * 0.8) });
    }
    addTube(b, shoot, radial, { color: col, vScale: 3 });
  }
}

/** Fallen twig, 0.3–0.9 m. Lay it flat with `align: 1`. */
export function twig({ seed = 1, lod = 0 } = {}) {
  const rand = mulberry32(seed), b = new GeoBuilder(), col = pick(rand, WOOD), L = range(rand, 0.3, 0.9), r = range(rand, 0.005, 0.011) * (lod ? 1.5 : 1);
  const pts = groundPath(rand, L, lod ? 2 : 4, r, r * 0.35, 0.3, 0.03);
  addTube(b, pts, lod ? 3 : 4, { color: col, vScale: 3 });
  if (!lod) sideShoots(b, rand, pts, Math.floor(rand() * 3), [0.08, 0.25], 3, col, 0.5);
  return b;
}

/** Fallen branch, 1.5–3.5 m, propped up on its own side branches. */
export function branch({ seed = 1, lod = 0 } = {}) {
  const rand = mulberry32(seed), b = new GeoBuilder(), col = pick(rand, WOOD), L = range(rand, 1.5, 3.5), r = range(rand, 0.025, 0.05);
  const pts = groundPath(rand, L, lod ? 4 : 7, r, r * 0.3, 0.22, 0.16);
  addTube(b, pts, lod ? 4 : 6, { colorAt: (i, p, u, ny) => mixc(col, MOSS, ny > 0.3 ? 0.35 : 0), vScale: 1.5 });
  sideShoots(b, rand, pts, lod ? 2 : 5, [0.3, 0.9], lod ? 3 : 4, col, 0.7);
  return b;
}

/** Fallen log with mossy top, broken stubs and pale end grain. UV-mapped for bark. */
export function log({ seed = 1, lod = 0 } = {}) {
  const rand = mulberry32(seed), b = new GeoBuilder(), L = range(rand, 2.8, 5.5), r = range(rand, 0.16, 0.3);
  const segs = lod ? 3 : 7, pts = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    pts.push({ x: (t - 0.5) * L, y: r * 0.75 + Math.sin(t * 3 + seed) * 0.03, z: Math.sin(t * 2.2 + seed) * 0.12, r: r * (1 - t * 0.25) * (1 + (rand() - 0.5) * 0.08) });
  }
  const bark = lin('#8a7a66');
  addTube(b, pts, lod ? 7 : 12, {
    colorAt: (i, p, u, ny) => {
      const m = Math.max(0, ny - 0.15) * (0.5 + fbm(p.x * 2.1, u * 7, seed, 2));
      return mixc(bark, MOSS, Math.min(0.85, m * 1.3));
    },
    vScale: 0.7, uRepeat: 2, capStart: HEARTWOOD, capEnd: HEARTWOOD,
  });
  if (!lod) {
    for (let i = 0; i < 3; i++) { // snapped-off stubs
      const p = pts[1 + Math.floor(rand() * (segs - 1))], a = range(rand, 0.3, 2.8), l = range(rand, 0.15, 0.5), rr = p.r * range(rand, 0.2, 0.35);
      const stub = [0, 0.5, 1].map((t) => ({ x: p.x + range(rand, -0.05, 0.05) * t, y: p.y + Math.sin(a) * (p.r + l * t), z: p.z + Math.cos(a) * (p.r + l * t), r: rr * (1 - t * 0.35) }));
      addTube(b, stub, 6, { color: bark, vScale: 0.7, capEnd: HEARTWOOD });
    }
  }
  return b;
}

/** Tree stump with a jagged, snapped top. */
export function stump({ seed = 1 } = {}) {
  const rand = mulberry32(seed), b = new GeoBuilder(), r = range(rand, 0.2, 0.36), h = range(rand, 0.35, 0.8), bark = lin('#7d6e5c');
  const pts = [-0.15, 0, 0.12, 0.5, 1].map((t) => ({ x: 0, y: t * h, z: 0, r: r * (t < 0.05 ? 1.45 - t : 1 + 0.25 * Math.exp(-t * 6)) }));
  addTube(b, pts, 12, { colorAt: (i, p, u, ny) => mixc(bark, MOSS, i < 3 ? 0.55 * fbm(u * 6, p.y * 3, seed, 2) + 0.15 : 0.1), vScale: 0.8, uRepeat: 2 });
  // splintered top: a fan to a raised, off-centre point with a jagged rim
  const cx = range(rand, -0.3, 0.3) * r, cz = range(rand, -0.3, 0.3) * r;
  const c = b.v(cx, h * range(rand, 0.8, 1.15), cz, 0, 1, 0, HEARTWOOD[0], HEARTWOOD[1], HEARTWOOD[2], 0.5, 0.5, 0);
  const first = b.vertexCount;
  for (let k = 0; k <= 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    b.v(Math.cos(a) * r, h, Math.sin(a) * r, 0, 1, 0, HEARTWOOD[0] * 0.7, HEARTWOOD[1] * 0.7, HEARTWOOD[2] * 0.7, 0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5, 0);
  }
  for (let k = 0; k < 12; k++) b.tri(c, first + k + 1, first + k);
  return b;
}

const LEAF_COLS = ['#5b3f24', '#6f4a28', '#8a5a2c', '#9c6a30', '#b0803a', '#c79c48', '#4a3320', '#77623a', '#a8582a', '#d2a850', '#6d7a34'].map(lin);

/** A hand-width scatter of fallen leaves — real geometry on top of the ground texture. */
export function leafLitter({ seed = 1, lod = 0, radius = 0.4 } = {}) {
  const rand = mulberry32(seed), b = new GeoBuilder(), n = lod ? 6 : 13;
  for (let i = 0; i < n; i++) {
    const a = rand() * 6.283, r = radius * Math.sqrt(rand()), yaw = rand() * 6.283, len = range(rand, 0.045, 0.085) * (lod ? 1.5 : 1);
    const c = pick(rand, LEAF_COLS), f = range(rand, 0.55, 0.95), tiltUp = range(rand, -0.08, 0.3);
    const dl = Math.hypot(1, tiltUp), dir = [Math.cos(yaw) / dl, tiltUp / dl, Math.sin(yaw) / dl];
    addLeaf(b, [Math.cos(a) * r, range(rand, 0.006, 0.03), Math.sin(a) * r], dir, [-Math.sin(yaw), range(rand, -0.25, 0.25), Math.cos(yaw)], len, len * range(rand, 0.45, 0.62),
      [c[0] * f * 0.8, c[1] * f * 0.8, c[2] * f * 0.8], [c[0] * f, c[1] * f, c[2] * f], { fold: range(rand, -0.3, 0.45), normal: [0, 1, 0], detail: lod ? 0 : 1 });
  }
  return b;
}

/** Weathered boulder / stone: noisy, flattened icosphere, mossy on top, half buried. */
export function rock({ seed = 1, detail = 2 } = {}) {
  const src = icosphere(detail), count = src.length / 3, rand = mulberry32(seed);
  const sx = range(rand, 0.8, 1.3), sy = range(rand, 0.45, 0.75), sz = range(rand, 0.8, 1.3), ox = rand() * 50, oz = rand() * 50;
  const b = new GeoBuilder(), stone = lin('#8f8b80'), dark = lin('#5a574f');
  const P = [];
  for (let i = 0; i < count; i++) {
    const x = src[i * 3], y = src[i * 3 + 1], z = src[i * 3 + 2];
    const n = fbm(x * 1.3 + ox, y * 1.3 + z * 0.7 + oz, seed, 3), m = fbm(x * 3.1 + oz, z * 3.1 + y + ox, seed + 5, 2);
    const d = 0.72 + n * 0.45 + (m - 0.5) * 0.16;
    P.push([x * d * sx, y * d * sy + sy * 0.25, z * d * sz]);
  }
  for (let i = 0; i < count; i += 3) { // flat-ish facets with per-face normals softened toward the sphere
    const A = P[i], B = P[i + 1], C = P[i + 2];
    const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
    const ids = [];
    for (const [k, V] of [[i, A], [i + 1, B], [i + 2, C]]) {
      const sxn = src[k * 3], syn = src[k * 3 + 1], szn = src[k * 3 + 2];
      let mx = nx * 0.45 + sxn * 0.55, my = ny * 0.45 + syn * 0.55, mz = nz * 0.45 + szn * 0.55;
      const ml = Math.hypot(mx, my, mz); mx /= ml; my /= ml; mz /= ml;
      const moss = Math.max(0, my - 0.35) * 1.5 * fbm(V[0] * 2 + ox, V[2] * 2 + oz, seed + 9, 2);
      const ao = 0.55 + 0.45 * Math.min(1, V[1] / (sy * 0.9) + 0.2);
      const c = mixc(mixc(dark, stone, fbm(V[0] * 4, V[2] * 4 + V[1] * 3, seed + 3, 2)), MOSS, Math.min(0.9, moss * 1.6));
      ids.push(b.v(V[0], V[1], V[2], mx, my, mz, c[0] * ao, c[1] * ao, c[2] * ao, V[0] * 0.6 + V[1] * 0.3, V[2] * 0.6 + V[1] * 0.3, 0));
    }
    b.tri(ids[0], ids[1], ids[2]);
  }
  return b;
}
