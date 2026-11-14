/*!
 * Arbor — procedural trees and ground vegetation.
 * One file, no dependencies. The generator is engine-agnostic (plain typed
 * arrays). Vendored from the owner's arbor.js 1.0.0 (MIT): the Arbor.three
 * adapter and the browser-only encodePNG are cut, because the engine bakes a
 * GLB and the game owns the look and the wind.
 *
 *   const t = Arbor.generate('oak', { seed: 7, lod: 0 });
 *   // t.bark / t.leaves = { position, normal, uv, color, wind, index }
 *   // Arbor.barkTexture(t.preset.bark), Arbor.leafTexture(t.preset) = RGBA8 buffers
 *   // Arbor.toGLB(t) = binary glTF for Unity / Unreal / Godot / Blender
 */
const Arbor = (() => {
'use strict';
// ───────────────────────────────────────────────────────────────────────────
// CORE — engine-agnostic. No dependencies. Produces plain typed arrays.
//   grow(preset, opts)  -> skeleton (branches + leaf placements)
//   mesh(skeleton, {lod}) -> { bark, leaves, bounds, triangles }
//   generate(preset, opts) = mesh(grow(...))
// Units are metres, +Y is up, the plant stands on the origin.
// ───────────────────────────────────────────────────────────────────────────

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; v[0] /= l; v[1] /= l; v[2] /= l; return v; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Deterministic PRNG (mulberry32) with a few helpers. */
function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  const f = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  f.range = (lo, hi) => lo + (hi - lo) * f();
  f.vary = (v, amt) => v * (1 + (f() * 2 - 1) * amt);
  f.fork = () => makeRng((f() * 4294967296) >>> 0);
  return f;
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Crown envelopes (after Weber & Penn). r = 1 at the bottom of the crown, 0 at the top. */
function shapeRatio(shape, r) {
  switch (shape) {
    case 'conical': return 0.12 + 0.88 * r;
    case 'spherical': return 0.2 + 0.8 * Math.sin(Math.PI * r);
    case 'hemispherical': return 0.2 + 0.8 * Math.sin(0.5 * Math.PI * r);
    case 'cylindrical': return 1;
    case 'tapered': return 0.5 + 0.5 * r;
    case 'flame': return r <= 0.7 ? r / 0.7 : (1 - r) / 0.3;
    case 'inverse': return 1 - 0.75 * r;
    case 'tendFlame': return r <= 0.7 ? 0.5 + 0.5 * r / 0.7 : 0.5 + 0.5 * (1 - r) / 0.3;
    case 'egg': return 0.3 + 0.7 * Math.sin(Math.PI * Math.pow(r, 0.7));
    case 'columnar': return 0.22 + 0.78 * smooth(0, 0.28, r);
    default: return 1 - 0.55 * (1 - r); // sub-branches: longer near the parent's base
  }
}

const LEVEL_DEF = {
  len: 0.5, rad: 0.5, taper: 0.92, segs: 6, curve: 0, curveSpan: 1, curveEnd: 0, gnarl: 8, up: 0,
  kids: 0, from: 0.2, to: 1, angle: [60, 40], angleVar: 8, spin: 137.5, whorl: 0, planar: 0, kidUp: 0.2,
  shape: null, lenVar: 0.15, cap: 0, bulge: 0, maxRadLen: 0.07,
};
const TRUNK_DEF = {
  len: 1, rad: 0.03, taper: 0.9, segs: 12, gnarl: 3, up: 0.25, kidUp: 0, shape: 'spherical',
  flare: 0.5, flareH: 5, lobes: 0, lean: 2,
};
const LEAF_DEF = {
  on: null, mode: 'along', kind: 'card', count: 6, from: 0.15, to: 1, size: [0.4, 0.4], sizeVar: 0.25,
  angle: [55, 35], angleVar: 12, roll: 55, droop: 0.15, flutter: 1, spin: 137.5, planar: 0, cells: null,
  segs: 6, fold: 0, taper: 0, face: null, tint: [[0.8, 0.8, 0.8], [1.08, 1.08, 1.02]], grad: null,
  lodSkip: null, cross: false, center: false, spread: 0, orient: null, terminal: false, upN: 0.75,
};

/** Fill in defaults. Accepts an id from PRESETS or a preset object. */
function resolvePreset(p) {
  if (typeof p === 'string') {
    const found = PRESETS[p];
    if (!found) throw new Error('Arbor: unknown preset "' + p + '"');
    p = found;
  }
  if (p._resolved) return p;
  const levels = (p.levels || [{}]).map((l, i) => Object.assign({}, LEVEL_DEF, i === 0 ? TRUNK_DEF : null, l));
  const tex = p.tex || { grid: [1, 1], cells: [{ type: 'sprig' }] };
  const nCells = tex.grid[0] * tex.grid[1];
  const leaves = (p.leaves || []).map((l) => {
    const o = Object.assign({}, LEAF_DEF, l);
    if (o.on == null) o.on = [levels.length - 1];
    if (!Array.isArray(o.on)) o.on = [o.on];
    if (!o.cells) o.cells = Array.from({ length: nCells }, (_, i) => i);
    if (!o.orient) o.orient = o.mode === 'tip' && o.kind === 'frond' ? 'radial' : 'spray';
    if (!o.lodSkip) o.lodSkip = o.kind === 'frond' ? [1, 1, 2] : [1, 2, 5];
    return o;
  });
  return Object.assign({ id: 'custom', name: 'Custom', height: [8, 10], puff: 0.7, ao: 0.45, sway: 1, barkScale: 0.9, bark: 'oak' }, p, { levels, leaves, tex, _resolved: true });
}

// ── skeleton ───────────────────────────────────────────────────────────────

const LEAF_STRIDE = 15; // pos3 dir3 side3 len wid windBranch phase rnd layer
const WIND_FLEX = [0, 0.03, 0.045, 0.06, 0.07];

function sampleBranch(b, t) {
  const f = clamp(t, 0, 1) * (b.n - 1);
  const i = Math.min(b.n - 2, Math.floor(f)), k = f - i, p = b.pts, a = i * 3;
  const pos = [lerp(p[a], p[a + 3], k), lerp(p[a + 1], p[a + 4], k), lerp(p[a + 2], p[a + 5], k)];
  const tan = norm([p[a + 3] - p[a], p[a + 4] - p[a + 1], p[a + 5] - p[a + 2]]);
  return { pos, tan, rad: lerp(b.rr[i], b.rr[i + 1], k), wb: lerp(b.wb[i], b.wb[i + 1], k) };
}

/** Rotate a direction towards +Y by `a` radians (negative droops). */
function pitch(d, a) {
  const h = Math.hypot(d[0], d[2]);
  if (h < 1e-5) return d;
  const e = clamp(Math.atan2(d[1], h) + a, -1.54, 1.54), c = Math.cos(e) / h;
  return [d[0] * c, Math.sin(e), d[2] * c];
}

function frameOf(T) {
  const ref = Math.abs(T[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
  const U = norm(cross(T, ref));
  return [U, cross(T, U)];
}

function aim(T, U, V, ang, phi) {
  const ca = Math.cos(ang), sa = Math.sin(ang), cp = Math.cos(phi) * sa, sp = Math.sin(phi) * sa;
  return norm([T[0] * ca + U[0] * cp + V[0] * sp, T[1] * ca + U[1] * cp + V[1] * sp, T[2] * ca + U[2] * cp + V[2] * sp]);
}

function pushLeaf(sk, R, lay, li, pos, T, dir, wb, phase, fixedRoll) {
  let s;
  if (lay.orient === 'radial') s = cross(T, dir);
  else { const k = dot(T, dir); s = [T[0] - dir[0] * k, T[1] - dir[1] * k, T[2] - dir[2] * k]; }
  if (Math.hypot(s[0], s[1], s[2]) < 1e-3) s = frameOf(dir)[0];
  norm(s);
  const roll = fixedRoll != null ? fixedRoll : (R() * 2 - 1) * lay.roll * DEG;
  if (roll) {
    const c = Math.cos(roll), sn = Math.sin(roll), q = cross(dir, s);
    s = [s[0] * c + q[0] * sn, s[1] * c + q[1] * sn, s[2] * c + q[2] * sn];
  }
  if (lay.face === 'up' && cross(dir, s)[1] < 0) s = [-s[0], -s[1], -s[2]];
  const k = R.vary(1, lay.sizeVar) * (sk.mods.leafSize || 1);
  const len = lay.size[0] * k, wid = lay.size[1] * k;
  if (lay.center) pos = [pos[0] - dir[0] * len * 0.5, pos[1] - dir[1] * len * 0.5, pos[2] - dir[2] * len * 0.5];
  sk.leaves.push(pos[0], pos[1], pos[2], dir[0], dir[1], dir[2], s[0], s[1], s[2], len, wid, wb, phase, R(), li);
}

function growBranch(sk, R, lvl, p0, d0, len, rad, ctx) {
  const P = sk.preset, M = sk.mods, L = P.levels[lvl];
  const segs = Math.max(2, Math.round(L.segs * (lvl === 0 ? 1 : clamp(0.5 + 0.5 * ctx.rel, 0.5, 1))));
  const n = segs + 1, segLen = len / segs;
  const pts = new Float32Array(n * 3), rr = new Float32Array(n), wb = new Float32Array(n);
  let p = p0.slice(), d = norm(d0.slice());
  const flex = WIND_FLEX[Math.min(lvl, 4)], gn = Math.tan(L.gnarl * M.gnarl * DEG);
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    pts[i * 3] = p[0]; pts[i * 3 + 1] = p[1]; pts[i * 3 + 2] = p[2];
    let r = rad * (1 - L.taper * t);
    if (L.bulge) r *= 1 + L.bulge * Math.sin(Math.PI * Math.min(1, t * 1.3));
    if (L.cap > 0 && t > 1 - L.cap) { const u = (t - (1 - L.cap)) / L.cap; r *= Math.sqrt(Math.max(0.02, 1 - u * u)); }
    rr[i] = Math.max(r, 0.0015);
    wb[i] = ctx.wb + (lvl === 0 ? 0 : flex * t * t * len);
    if (i === segs) break;
    let a = 0;
    if (L.curve && t < L.curveSpan) a += (L.curve * DEG) / (segs * L.curveSpan);
    if (L.curveEnd && t >= 0.55) a += (L.curveEnd * DEG) / (segs * 0.45);
    if (a) d = pitch(d, a);
    if (gn) { const g = gn * (lvl === 0 ? 0.4 + 0.6 * t : 1); d[0] += (R() * 2 - 1) * g; d[1] += (R() * 2 - 1) * g; d[2] += (R() * 2 - 1) * g; }
    if (L.up) d[1] += (L.up * 2) / segs;
    norm(d);
    p[0] += d[0] * segLen; p[1] += d[1] * segLen; p[2] += d[2] * segLen;
  }
  const b = { lvl, n, pts, rr, wb, len, rad, phase: ctx.phase, parent: ctx.parent };
  const idx = sk.branches.length;
  sk.branches.push(b);

  // ── children ──
  const C = P.levels[lvl + 1];
  let isEnd = true;
  if (C && L.kids > 0) {
    let cnt = L.kids * M.branching * (lvl === 0 ? 1 : 0.3 + 0.7 * ctx.rel);
    cnt = lvl === 0 ? Math.max(1, Math.round(cnt)) : Math.floor(cnt + R());
    const whorl = L.whorl | 0, nW = whorl > 1 ? Math.ceil(cnt / whorl) : 0;
    let az = R() * TAU;
    if (cnt > 0) isEnd = false;
    for (let k = 0; k < cnt; k++) {
      let f, phi;
      if (whorl > 1) {
        const w = Math.floor(k / whorl);
        f = (w + 0.5) / nW + (R() - 0.5) * 0.25 / nW;
        phi = w * 2.4 + ((k % whorl) * TAU) / whorl + (R() - 0.5) * 0.5;
      } else {
        f = (k + 0.5 + (R() - 0.5) * 0.8) / cnt;
        az += L.spin * DEG + (R() - 0.5) * 0.6;
        phi = az;
      }
      if (L.planar > 0) phi = (k % 2 ? 0 : Math.PI) + (R() - 0.5) * Math.PI * (1 - L.planar);
      const t = L.from + (L.to - L.from) * f;
      const s = sampleBranch(b, t), [U, V] = frameOf(s.tan);
      const ang = (lerp(L.angle[0], L.angle[1], f) + (R() * 2 - 1) * L.angleVar) * DEG;
      const dir = aim(s.tan, U, V, ang, phi);
      if (L.kidUp) { dir[1] += L.kidUp; norm(dir); }
      const rel = shapeRatio(lvl === 0 ? L.shape : L.shape || null, 1 - f);
      const cl = (lvl === 0 ? sk.height : len) * C.len * rel * R.vary(1, C.lenVar);
      let cr = Math.min(s.rad * C.rad, s.rad * 0.95, cl * C.maxRadLen);
      cr = Math.max(cr, 0.004);
      growBranch(sk, R, lvl + 1, s.pos, dir, cl, cr, { phase: lvl === 0 ? R() : ctx.phase, wb: s.wb, rel: clamp(rel, 0, 1), parent: idx });
    }
  }

  // ── foliage ──
  for (let li = 0; li < P.leaves.length; li++) {
    const lay = P.leaves[li];
    if (lay.ends ? !isEnd : lay.on.indexOf(lvl) < 0) continue;
    if (lay.mode === 'tip') {
      const cnt = Math.max(1, Math.round(lay.count * (lay.cross ? 1 : M.foliage)));
      const e = sampleBranch(b, 1), [U, V] = frameOf(e.tan);
      const ph0 = R() * TAU;
      for (let k = 0; k < cnt; k++) {
        const f = (k + 0.5) / cnt;
        const ang = (lerp(lay.angle[0], lay.angle[1], f) + (R() * 2 - 1) * lay.angleVar) * DEG;
        const phi = ph0 + k * 2.39996 + (R() - 0.5) * 0.4;
        const dir = aim(e.tan, U, V, ang, phi);
        const back = lay.spread ? R() * lay.spread * len : 0;
        const pos = [e.pos[0] - e.tan[0] * back, e.pos[1] - e.tan[1] * back, e.pos[2] - e.tan[2] * back];
        pushLeaf(sk, R, lay, li, pos, e.tan, dir, e.wb, b.phase, lay.cross ? (k * Math.PI) / cnt : null);
      }
    } else {
      let cnt = lay.count * M.foliage * (lvl === 0 ? 1 : 0.45 + 0.55 * ctx.rel);
      cnt = Math.floor(cnt + R());
      let az = R() * TAU;
      for (let k = 0; k < cnt; k++) {
        const f = (k + R()) / cnt, t = lay.from + (lay.to - lay.from) * f;
        const s = sampleBranch(b, t), [U, V] = frameOf(s.tan);
        az += lay.spin * DEG + (R() - 0.5) * 0.8;
        let phi = az;
        if (lay.planar > 0) phi = (k % 2 ? 0 : Math.PI) + (R() - 0.5) * Math.PI * (1 - lay.planar);
        const ang = (lerp(lay.angle[0], lay.angle[1], f) + (R() * 2 - 1) * lay.angleVar) * DEG;
        pushLeaf(sk, R, lay, li, s.pos, s.tan, aim(s.tan, U, V, ang, phi), s.wb, b.phase, null);
      }
      if (lay.terminal) {
        const e = sampleBranch(b, 1);
        pushLeaf(sk, R, lay, li, e.pos, e.tan, e.tan.slice(), e.wb, b.phase, null);
      }
    }
  }
}

/**
 * Grow a plant skeleton.
 * @param {string|object} preset  id from Arbor.PRESETS or a preset object
 * @param {{seed?:number, age?:number, branching?:number, foliage?:number, gnarl?:number, leafSize?:number}} [opts]
 */
function grow(preset, opts = {}) {
  const P = resolvePreset(preset);
  const seed = (opts.seed == null ? 1 : opts.seed) >>> 0;
  const R = makeRng(Math.imul(seed + 1, 2654435761) ^ hashString(P.id));
  const mods = {
    age: opts.age == null ? 1 : opts.age, branching: opts.branching == null ? 1 : opts.branching,
    foliage: opts.foliage == null ? 1 : opts.foliage, gnarl: opts.gnarl == null ? 1 : opts.gnarl,
    leafSize: opts.leafSize == null ? 1 : opts.leafSize,
  };
  const H = R.range(P.height[0], P.height[1]) * mods.age;
  const sk = { preset: P, seed, height: H, branches: [], leaves: [], mods };
  const L0 = P.levels[0];
  const stems = Array.isArray(P.stems) ? Math.round(R.range(P.stems[0], P.stems[1])) : P.stems || 1;
  const clump = P.clump == null ? 0.4 : P.clump;
  for (let s = 0; s < stems; s++) {
    const a = stems > 1 ? (s / stems) * TAU + R() * 1.2 : R() * TAU;
    const off = stems > 1 ? Math.sqrt((s + 0.5) / stems) * clump : 0;
    const lean = (L0.lean * R.range(0.3, 1) + (stems > 1 ? (P.clumpLean == null ? 8 : P.clumpLean) * (off / (clump || 1)) : 0)) * DEG;
    const dir = [Math.sin(lean) * Math.cos(a), Math.cos(lean), Math.sin(lean) * Math.sin(a)];
    const k = stems > 1 ? R.range(0.65, 1) : 1;
    growBranch(sk, R, 0, [Math.cos(a) * off, 0, Math.sin(a) * off], dir, H * L0.len * k, H * L0.rad * Math.sqrt(k), { phase: R(), wb: 0, rel: 1, parent: -1 });
  }
  return sk;
}

// ── meshing ────────────────────────────────────────────────────────────────

const LODS = [
  { radial: [14, 8, 5, 4, 3], step: [1, 1, 1, 1, 1], leafScale: 1, cardSegs: 2, frondDiv: 1 },
  { radial: [8, 5, 4, 3, 3], step: [1, 2, 2, 2, 2], leafScale: 1.38, cardSegs: 1, frondDiv: 2 },
  { radial: [5, 3, 3, 3, 3], step: [2, 3, 3, 3, 3], leafScale: 2.1, cardSegs: 1, frondDiv: 3 },
];

function newPart() { return { position: [], normal: [], uv: [], color: [], wind: [], index: [] }; }
function packPart(p) {
  const nv = p.position.length / 3;
  return {
    position: new Float32Array(p.position), normal: new Float32Array(p.normal), uv: new Float32Array(p.uv),
    color: new Float32Array(p.color), wind: new Float32Array(p.wind),
    index: nv > 65535 ? new Uint32Array(p.index) : new Uint16Array(p.index),
  };
}

function meshBranch(out, sk, b, Q, maxLvl) {
  const P = sk.preset, H = sk.height;
  if (b.lvl > maxLvl) return;
  let radial = Q.radial[Math.min(b.lvl, 4)];
  if (b.rad < 0.006) radial = 3; else if (b.rad < 0.02) radial = Math.min(radial, 5);
  const step = Q.step[Math.min(b.lvl, 4)];
  const ids = [];
  for (let i = 0; i < b.n - 1; i += step) ids.push(i);
  ids.push(b.n - 1);
  const p = b.pts, isTrunk = b.lvl === 0, L0 = P.levels[0];
  const circ = TAU * b.rad;
  const uRep = Math.max(1, Math.round(circ / P.barkScale));
  const tileW = Math.max(circ / uRep, 0.02);
  const vBase = out.position.length / 3;
  const swayK = H * 0.018 * P.sway;
  // parallel-transport frame
  let T = norm([p[3] - p[0], p[4] - p[1], p[5] - p[2]]);
  let N = frameOf(T)[0];
  let dist = 0, rings = 0;
  const lobePh = b.phase * TAU;
  const ring = (cx, cy, cz, r, v, wbv, flareW, shade) => {
    const B = cross(T, N);
    const sway = Math.pow(clamp(cy / H, 0, 1.3), 1.7) * swayK;
    for (let k = 0; k <= radial; k++) {
      const th = (k / radial) * TAU, c = Math.cos(th), s = Math.sin(th);
      const nx = N[0] * c + B[0] * s, ny = N[1] * c + B[1] * s, nz = N[2] * c + B[2] * s;
      let rk = r;
      if (flareW > 0) rk *= 1 + L0.flare * flareW * (L0.lobes ? 0.45 + 0.55 * Math.pow(0.5 + 0.5 * Math.sin(L0.lobes * th + lobePh), 1.5) * 1.6 : 1);
      out.position.push(cx + nx * rk, cy + ny * rk, cz + nz * rk);
      out.normal.push(nx, ny, nz);
      out.uv.push((k / radial) * uRep, v);
      out.color.push(shade, shade, shade);
      out.wind.push(sway, wbv, 0, b.phase);
    }
    rings++;
  };
  const flareLen = Math.max(b.rad * L0.flareH, 1e-3);
  if (isTrunk) { // buried skirt so the trunk meets sloped ground
    const d = b.rad * 2.5;
    ring(p[0] - T[0] * d, p[1] - T[1] * d, p[2] - T[2] * d, b.rr[0] * 1.08, -d / (2 * tileW), 0, L0.flare > 0 ? 1.15 : 0, 0.55);
  }
  for (let q = 0; q < ids.length; q++) {
    const i = ids[q], a = i * 3;
    if (q > 0) {
      const j = ids[q - 1] * 3;
      dist += Math.hypot(p[a] - p[j], p[a + 1] - p[j + 1], p[a + 2] - p[j + 2]);
    }
    const i0 = ids[Math.max(0, q - 1)] * 3, i1 = ids[Math.min(ids.length - 1, q + 1)] * 3;
    T = norm([p[i1] - p[i0], p[i1 + 1] - p[i0 + 1], p[i1 + 2] - p[i0 + 2]]);
    const k = dot(N, T);
    N = norm([N[0] - T[0] * k, N[1] - T[1] * k, N[2] - T[2] * k]);
    const fw = isTrunk && L0.flare > 0 ? Math.pow(Math.max(0, 1 - dist / flareLen), 2) : 0;
    const shade = isTrunk ? lerp(0.62, 1, smooth(0, Math.max(0.4, b.rad * 3), dist)) : b.lvl >= 2 ? 0.85 : 0.95;
    ring(p[a], p[a + 1], p[a + 2], b.rr[i], dist / (2 * tileW), b.wb[i], fw, shade);
  }
  const w = radial + 1;
  for (let q = 0; q < rings - 1; q++) {
    for (let k = 0; k < radial; k++) {
      const a = vBase + q * w + k, c = a + w;
      out.index.push(a, a + 1, c, a + 1, c + 1, c);
    }
  }
}

function meshLeaves(out, sk, Q, lod) {
  const P = sk.preset, H = sk.height, lv = sk.leaves, n = lv.length / LEAF_STRIDE;
  if (!n) return;
  // crown ellipsoid for soft normals + ambient occlusion
  let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (let i = 0; i < n; i++) {
    const o = i * LEAF_STRIDE;
    for (let a = 0; a < 3; a++) { const v = lv[o + a] + lv[o + 3 + a] * lv[o + 9] * 0.5; if (v < mn[a]) mn[a] = v; if (v > mx[a]) mx[a] = v; }
  }
  const cc = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
  const ce = [Math.max(0.2, (mx[0] - mn[0]) / 2), Math.max(0.2, (mx[1] - mn[1]) / 2), Math.max(0.2, (mx[2] - mn[2]) / 2)];
  const [cols, rows] = P.tex.grid, swayK = H * 0.018 * P.sway;
  const counters = new Int32Array(P.leaves.length);
  for (let i = 0; i < n; i++) {
    const o = i * LEAF_STRIDE, li = lv[o + 14] | 0, lay = P.leaves[li];
    const skip = lay.lodSkip[lod];
    if (counters[li]++ % skip !== 0) continue;
    const frond = lay.kind === 'frond', rnd = lv[o + 13];
    const scale = skip > 1 ? (frond ? 1.25 : Q.leafScale) : frond ? 1 : lod ? 1.15 : 1;
    const len = lv[o + 9] * scale, wid = lv[o + 10] * scale;
    const segs = frond ? Math.max(2, Math.round(lay.segs / Q.frondDiv)) : Q.cardSegs;
    const across = frond && lay.fold && lod === 0 ? 3 : 2;
    const cell = lay.cells[Math.floor(rnd * lay.cells.length) % lay.cells.length];
    const eu = 0.003, u0 = (cell % cols) / cols + eu, u1 = ((cell % cols) + 1) / cols - eu;
    const v0 = Math.floor(cell / cols) / rows + eu, v1 = (Math.floor(cell / cols) + 1) / rows - eu;
    const tr = (rnd * 7.31) % 1, t0 = lay.tint[0], t1 = lay.tint[1];
    const tint = [lerp(t0[0], t1[0], tr), lerp(t0[1], t1[1], tr), lerp(t0[2], t1[2], tr)];
    let p = [lv[o], lv[o + 1], lv[o + 2]], d = [lv[o + 3], lv[o + 4], lv[o + 5]];
    const s = [lv[o + 6], lv[o + 7], lv[o + 8]];
    const wbv = lv[o + 11], phase = lv[o + 12];
    const base = out.position.length / 3, segLen = len / segs;
    for (let j = 0; j <= segs; j++) {
      const v = j / segs;
      let nrm = norm(cross(d, s));
      // soft "puff" normal
      let pn;
      if (P.ground) pn = [0, 1, 0];
      else pn = norm([(p[0] - cc[0]) / ce[0], (p[1] - cc[1]) / ce[1] + 0.25, (p[2] - cc[2]) / ce[2]]);
      if (dot(nrm, pn) < 0) nrm = [-nrm[0], -nrm[1], -nrm[2]];
      const pf = P.ground ? lay.upN : P.puff;
      const N = norm([lerp(nrm[0], pn[0], pf), lerp(nrm[1], pn[1], pf), lerp(nrm[2], pn[2], pf)]);
      // occlusion: darker towards the crown core and underside
      let ao = 1;
      if (!P.ground) {
        const e = Math.hypot((p[0] - cc[0]) / ce[0], (p[1] - cc[1]) / ce[1], (p[2] - cc[2]) / ce[2]);
        ao = lerp(P.ao, 1, smooth(0.25, 0.95, e)) * lerp(0.82, 1, smooth(-0.8, 0.3, (p[1] - cc[1]) / ce[1]));
      }
      const g = lay.grad ? lerp(lay.grad[0], lay.grad[1], v) : 1;
      const w = (lay.taper ? wid * (1 - lay.taper * Math.pow(v, 1.6)) : wid) * 0.5;
      const sway = Math.pow(clamp(p[1] / H, 0, 1.3), 1.7) * swayK;
      const fl = lay.flutter * Math.pow(v, 1.5) * len * 0.05;
      for (let a = 0; a < across; a++) {
        const x = across === 3 ? a - 1 : a * 2 - 1; // -1, (0), 1
        const lift = across === 3 && a === 1 ? lay.fold * wid : 0;
        out.position.push(p[0] + s[0] * w * x + nrm[0] * lift, p[1] + s[1] * w * x + nrm[1] * lift, p[2] + s[2] * w * x + nrm[2] * lift);
        const tilt = across === 3 ? x * 0.45 : 0;
        const nn = tilt ? norm([N[0] + s[0] * tilt, N[1] + s[1] * tilt, N[2] + s[2] * tilt]) : N;
        out.normal.push(nn[0], nn[1], nn[2]);
        out.uv.push(lerp(u0, u1, (x + 1) / 2), lerp(v0, v1, v));
        out.color.push(tint[0] * ao * g, tint[1] * ao * g, tint[2] * ao * g);
        out.wind.push(sway, wbv, fl, phase);
      }
      if (j < segs) {
        d = norm([d[0], d[1] - lay.droop * (0.3 + 1.4 * v) * (frond ? 1 / segs : 0.5), d[2]]);
        p = [p[0] + d[0] * segLen, p[1] + d[1] * segLen, p[2] + d[2] * segLen];
      }
    }
    for (let j = 0; j < segs; j++) {
      for (let a = 0; a < across - 1; a++) {
        const q = base + j * across + a, r = q + across;
        out.index.push(q, q + 1, r, q + 1, r + 1, r);
      }
    }
  }
}

/**
 * Turn a skeleton into render-ready buffers.
 * @param {object} sk  result of grow()
 * @param {{lod?:0|1|2}} [opts]
 */
function mesh(sk, opts = {}) {
  const lod = clamp(opts.lod | 0, 0, 2), Q = LODS[lod], P = sk.preset, nLv = P.levels.length;
  const maxLvl = lod === 0 ? 9 : lod === 1 ? Math.max(1, nLv - 2) : nLv >= 4 ? 1 : Math.min(1, nLv - 1);
  const bark = newPart(), leaves = newPart();
  if (!P.noBark) for (const b of sk.branches) meshBranch(bark, sk, b, Q, maxLvl);
  meshLeaves(leaves, sk, Q, lod);
  const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (const part of [bark, leaves]) {
    const a = part.position;
    for (let i = 0; i < a.length; i += 3) for (let k = 0; k < 3; k++) { if (a[i + k] < mn[k]) mn[k] = a[i + k]; if (a[i + k] > mx[k]) mx[k] = a[i + k]; }
  }
  if (mn[0] > mx[0]) { mn.fill(0); mx.fill(0); }
  const center = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
  const radius = Math.hypot(mx[0] - center[0], mx[1] - center[1], mx[2] - center[2]);
  return {
    preset: P, seed: sk.seed, lod, height: sk.height,
    bark: packPart(bark), leaves: packPart(leaves),
    bounds: { min: mn, max: mx, center, radius },
    triangles: (bark.index.length + leaves.index.length) / 3,
  };
}

/** One call: skeleton + mesh. */
function generate(preset, opts = {}) { return mesh(grow(preset, opts), opts); }

/**
 * Scatter points on a disc. Returns Float32Array of [x, z, rotation, scale, rnd] per point.
 * `mask(x, z)` (optional) returns a 0..1 acceptance probability, `minDist` enforces spacing.
 */
function scatter({ radius = 20, count = 100, seed = 1, minDist = 0, mask = null, inner = 0, scale = [0.8, 1.2] } = {}) {
  const R = makeRng(seed), out = [], cell = minDist || 1, grid = new Map();
  const key = (x, z) => Math.floor(x / cell) + ':' + Math.floor(z / cell);
  let tries = count * 12;
  while (out.length / 5 < count && tries-- > 0) {
    const r = Math.sqrt(lerp((inner * inner) / (radius * radius), 1, R())) * radius, a = R() * TAU;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (mask && R() > mask(x, z)) continue;
    if (minDist > 0) {
      let ok = true;
      const gx = Math.floor(x / cell), gz = Math.floor(z / cell);
      for (let i = -1; i <= 1 && ok; i++) for (let j = -1; j <= 1 && ok; j++) {
        const list = grid.get(gx + i + ':' + (gz + j));
        if (list) for (const q of list) if (Math.hypot(q[0] - x, q[1] - z) < minDist) { ok = false; break; }
      }
      if (!ok) continue;
      const k = key(x, z);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push([x, z]);
    }
    out.push(x, z, R() * TAU, R.range(scale[0], scale[1]), R());
  }
  return new Float32Array(out);
}

// ───────────────────────────────────────────────────────────────────────────
// PRESETS — plain data. Trees and ground cover share one schema, so a custom
// species is just another object passed to grow()/generate().
// ───────────────────────────────────────────────────────────────────────────

const sprig = (leaf, colA, colB, o) => Object.assign({ type: 'sprig', leaf, colA, colB }, o);
const quad = (cell) => ({ grid: [2, 2], cells: Array.isArray(cell) ? cell : [cell] });
const BROWN = [0.24, 0.17, 0.1];

const PRESETS = {};
const def = (id, name, latin, o) => { PRESETS[id] = Object.assign({ id, name, latin, kind: 'tree' }, o); };

// ── Temperate Europe ───────────────────────────────────────────────────────
def('oak', 'English oak', 'Quercus robur', {
  height: [15, 19], bark: 'oak', barkScale: 1.0, sway: 0.6, puff: 0.72,
  levels: [
    { len: 0.78, rad: 0.036, taper: 0.8, gnarl: 5, flare: 0.7, lobes: 5, kids: 13, from: 0.26, to: 0.97, angle: [82, 25], angleVar: 10, shape: 'spherical' },
    { len: 0.56, rad: 0.6, taper: 0.9, segs: 9, gnarl: 12, curve: 14, kids: 8, from: 0.25, angle: [65, 40], kidUp: 0.25 },
    { len: 0.48, rad: 0.6, segs: 6, gnarl: 16, kids: 6, from: 0.2 },
    { len: 0.5, rad: 0.65, segs: 4, gnarl: 18 },
  ],
  leaves: [{ on: [2, 3], count: 10, size: [0.83, 0.83], angle: [60, 30], roll: 60 }],
  tex: quad(sprig('oak', [0.19, 0.32, 0.09], [0.33, 0.46, 0.14], { n: 8, len: 0.34, spread: 52 })),
});
def('beech', 'European beech', 'Fagus sylvatica', {
  height: [17, 22], bark: 'beech', barkScale: 1.2, sway: 0.7,
  levels: [
    { len: 0.9, rad: 0.026, taper: 0.85, gnarl: 2, flare: 0.45, lobes: 4, kids: 18, from: 0.28, angle: [72, 22], shape: 'egg' },
    { len: 0.42, rad: 0.5, segs: 8, gnarl: 7, curve: 10, kids: 8, planar: 0.5, angle: [55, 40] },
    { len: 0.45, rad: 0.55, segs: 5, gnarl: 10, kids: 5, planar: 0.6 },
    { len: 0.5, segs: 3, gnarl: 12 },
  ],
  leaves: [{ on: [2, 3], count: 10, size: [0.77, 0.77], planar: 0.5, roll: 40 }],
  tex: quad(sprig('ovate', [0.2, 0.38, 0.1], [0.36, 0.52, 0.15], { n: 9, len: 0.3, spread: 50 })),
});
def('birch', 'Silver birch', 'Betula pendula', {
  height: [12, 16], bark: 'birch', barkScale: 0.5, sway: 1.3, puff: 0.6, ao: 0.55,
  levels: [
    { len: 0.95, rad: 0.016, taper: 0.9, gnarl: 3, flare: 0.3, lean: 4, kids: 22, from: 0.3, angle: [55, 22], shape: 'tendFlame' },
    { len: 0.3, rad: 0.42, segs: 8, gnarl: 8, curve: -25, kids: 7, angle: [50, 35] },
    { len: 0.55, rad: 0.5, segs: 6, gnarl: 8, curve: -95, kids: 4, kidUp: 0 },
    { len: 0.6, rad: 0.6, segs: 5, gnarl: 5, curve: -120 },
  ],
  leaves: [{ on: [2, 3], count: 10, size: [0.58, 0.51], angle: [50, 30], flutter: 1.8, droop: 0.4 }],
  tex: quad(sprig('birch', [0.28, 0.44, 0.12], [0.46, 0.58, 0.18], { n: 11, len: 0.2, spread: 55 })),
});
def('spruce', 'Norway spruce', 'Picea abies', {
  height: [18, 24], bark: 'spruce', barkScale: 0.7, puff: 0.5, ao: 0.4,
  levels: [
    { len: 1, rad: 0.019, taper: 0.96, gnarl: 1, flare: 0.35, kids: 78, whorl: 5, from: 0.1, to: 0.985, angle: [105, 48], angleVar: 6, shape: 'conical' },
    { len: 0.3, rad: 0.32, taper: 0.95, segs: 8, gnarl: 3, curve: -12, curveEnd: 38 },
  ],
  leaves: [{ on: [1], count: 26, from: 0.08, size: [1.15, 0.7], angle: [70, 45], planar: 0.35, roll: 80, droop: 0.7, terminal: true, flutter: 0.5 }],
  tex: quad({ type: 'spray', aspect: 1.64, colA: [0.08, 0.19, 0.09], colB: [0.17, 0.31, 0.13], needle: 0.05, pairs: 7 }),
});

// ── Boreal ─────────────────────────────────────────────────────────────────
def('scotspine', 'Scots pine', 'Pinus sylvestris', {
  height: [14, 19], bark: 'pine', barkScale: 0.8, puff: 0.6, ao: 0.5,
  levels: [
    { len: 0.92, rad: 0.022, taper: 0.75, gnarl: 4, lean: 5, flare: 0.3, kids: 15, from: 0.52, to: 0.98, angle: [88, 40], shape: 'spherical' },
    { len: 0.36, rad: 0.5, segs: 8, gnarl: 14, curve: 18, kids: 7, from: 0.3, angle: [55, 35] },
    { len: 0.5, rad: 0.55, segs: 5, gnarl: 16, curve: 25, kids: 4, from: 0.35 },
    { len: 0.5, segs: 3, gnarl: 10, curve: 20 },
  ],
  leaves: [
    { on: [2, 3], mode: 'tip', count: 7, size: [0.9, 0.9], angle: [10, 70], roll: 180, orient: 'spray', flutter: 0.5 },
    { on: [2, 3], count: 4, size: [0.8, 0.8], roll: 180, flutter: 0.5 },
  ],
  tex: quad({ type: 'pine', colA: [0.14, 0.27, 0.17], colB: [0.26, 0.4, 0.25], needle: 0.36 }),
});
def('blackspruce', 'Black spruce', 'Picea mariana', {
  height: [9, 13], bark: 'spruce', barkScale: 0.5, puff: 0.5, ao: 0.4,
  levels: [
    { len: 1, rad: 0.014, taper: 0.95, gnarl: 1.5, flare: 0.25, kids: 68, whorl: 4, from: 0.07, to: 0.985, angle: [115, 60], shape: 'tapered' },
    { len: 0.1, rad: 0.3, segs: 5, gnarl: 4, curve: -10, curveEnd: 30 },
  ],
  leaves: [{ on: [1], count: 11, from: 0.05, size: [0.72, 0.52], angle: [70, 45], planar: 0.3, roll: 80, droop: 0.6, terminal: true, flutter: 0.5 }],
  tex: quad({ type: 'spray', aspect: 1.4, colA: [0.07, 0.16, 0.1], colB: [0.15, 0.27, 0.15], needle: 0.045, pairs: 6 }),
});
def('aspen', 'Quaking aspen', 'Populus tremuloides', {
  height: [13, 18], bark: 'aspen', barkScale: 0.5, sway: 1.3, puff: 0.6, ao: 0.55,
  levels: [
    { len: 0.95, rad: 0.015, taper: 0.88, gnarl: 2, flare: 0.25, kids: 18, from: 0.42, angle: [62, 28], shape: 'egg' },
    { len: 0.24, rad: 0.45, segs: 7, gnarl: 9, curve: 12, kids: 7 },
    { len: 0.5, rad: 0.55, segs: 5, gnarl: 12, kids: 4 },
    { len: 0.5, segs: 3, gnarl: 12 },
  ],
  leaves: [{ on: [2, 3], count: 10, size: [0.61, 0.61], flutter: 3.2 }],
  tex: quad(sprig('round', [0.34, 0.5, 0.14], [0.54, 0.64, 0.2], { n: 7, len: 0.23, spread: 58 })),
});

// ── Pacific Northwest ──────────────────────────────────────────────────────
def('douglasfir', 'Douglas fir', 'Pseudotsuga menziesii', {
  height: [24, 30], bark: 'fir', barkScale: 1.0, puff: 0.5, ao: 0.4, sway: 0.8,
  levels: [
    { len: 1, rad: 0.021, taper: 0.95, gnarl: 1.2, flare: 0.4, kids: 84, whorl: 5, from: 0.26, to: 0.985, angle: [102, 50], shape: 'conical' },
    { len: 0.22, rad: 0.3, segs: 8, gnarl: 5, curve: -10, curveEnd: 25 },
  ],
  leaves: [{ on: [1], count: 22, from: 0.08, size: [1.2, 0.78], angle: [62, 40], planar: 0.5, roll: 60, droop: 0.35, terminal: true, flutter: 0.5 }],
  tex: quad({ type: 'spray', aspect: 1.53, colA: [0.09, 0.21, 0.09], colB: [0.19, 0.34, 0.13], needle: 0.055, pairs: 6, flat: true }),
});
def('redcedar', 'Western red cedar', 'Thuja plicata', {
  height: [20, 26], bark: 'cedar', barkScale: 0.9, puff: 0.5, ao: 0.42, sway: 0.8,
  levels: [
    { len: 1, rad: 0.028, taper: 0.95, gnarl: 1.5, flare: 1.0, flareH: 7, lobes: 6, kids: 64, from: 0.14, to: 0.98, angle: [105, 55], shape: 'conical' },
    { len: 0.26, rad: 0.3, segs: 9, gnarl: 4, curve: -28, curveSpan: 0.6, curveEnd: 50 },
  ],
  leaves: [{ on: [1], count: 30, from: 0.06, size: [1.5, 0.95], angle: [75, 45], planar: 0.35, roll: 70, droop: 0.9, terminal: true, flutter: 0.6 }],
  tex: quad({ type: 'scale', aspect: 1.58, colA: [0.17, 0.31, 0.09], colB: [0.33, 0.46, 0.14] }),
});
def('bigleafmaple', 'Bigleaf maple', 'Acer macrophyllum', {
  height: [14, 19], bark: 'mossy', barkScale: 1.0, sway: 0.7,
  levels: [
    { len: 0.7, rad: 0.034, taper: 0.75, gnarl: 5, lean: 5, flare: 0.6, lobes: 4, kids: 11, from: 0.22, angle: [70, 25], shape: 'spherical' },
    { len: 0.55, rad: 0.58, segs: 9, gnarl: 11, curve: 14, kids: 8, from: 0.25 },
    { len: 0.48, rad: 0.6, segs: 6, gnarl: 13, kids: 5 },
    { len: 0.5, segs: 4, gnarl: 14 },
  ],
  leaves: [{ on: [2, 3], count: 9, size: [1.06, 1.06] }],
  tex: quad(sprig('maple', [0.22, 0.4, 0.09], [0.42, 0.57, 0.16], { n: 5, len: 0.4, spread: 62, opposite: true })),
});

// ── Mediterranean ──────────────────────────────────────────────────────────
def('cypress', 'Italian cypress', 'Cupressus sempervirens', {
  height: [12, 17], bark: 'cypress', barkScale: 0.5, puff: 0.8, ao: 0.4, sway: 1.1,
  levels: [
    { len: 1, rad: 0.014, taper: 0.92, gnarl: 1, flare: 0.2, kids: 100, from: 0.03, to: 0.99, angle: [27, 14], angleVar: 4, shape: 'columnar' },
    { len: 0.2, rad: 0.3, segs: 6, gnarl: 4, curve: 10 },
  ],
  leaves: [{ on: [1], count: 14, from: 0.05, size: [0.78, 0.47], angle: [30, 14], roll: 180, droop: 0, terminal: true, flutter: 0.5 }],
  tex: quad({ type: 'scale', aspect: 1.67, colA: [0.07, 0.17, 0.08], colB: [0.15, 0.28, 0.12], dense: true }),
});
def('olive', 'Olive', 'Olea europaea', {
  height: [5, 7.5], bark: 'olive', barkScale: 0.7, sway: 0.5, ao: 0.5,
  levels: [
    { len: 0.5, rad: 0.055, taper: 0.5, segs: 8, gnarl: 12, lean: 8, flare: 0.6, lobes: 5, kids: 6, from: 0.55, to: 1, angle: [48, 18], shape: 'cylindrical' },
    { len: 0.62, rad: 0.6, segs: 8, gnarl: 16, curve: 14, kids: 9, from: 0.25 },
    { len: 0.5, rad: 0.55, segs: 6, gnarl: 16, kids: 6 },
    { len: 0.5, segs: 4, gnarl: 14, curve: -25 },
  ],
  leaves: [{ on: [2, 3], count: 13, size: [0.66, 0.52] }],
  tex: quad(sprig('lance', [0.3, 0.38, 0.27], [0.55, 0.6, 0.48], { n: 13, len: 0.2, spread: 42, opposite: true })),
});
def('stonepine', 'Stone pine', 'Pinus pinea', {
  height: [12, 16], bark: 'stonepine', barkScale: 0.9, puff: 0.65, ao: 0.5, sway: 0.6,
  levels: [
    { len: 0.68, rad: 0.03, taper: 0.4, gnarl: 3, lean: 5, flare: 0.35, kids: 9, from: 0.72, to: 1, angle: [70, 28], shape: 'cylindrical' },
    { len: 0.4, rad: 0.6, segs: 9, gnarl: 9, curve: -22, curveEnd: 10, kids: 9, from: 0.3, angle: [50, 35], kidUp: 0.7 },
    { len: 0.36, rad: 0.55, segs: 5, gnarl: 12, curve: 30, kids: 5, from: 0.35, kidUp: 0.6 },
    { len: 0.5, segs: 3, gnarl: 10, curve: 25 },
  ],
  leaves: [{ on: [2, 3], mode: 'tip', count: 7, size: [0.95, 0.95], angle: [10, 65], roll: 180, orient: 'spray', flutter: 0.5 }, { on: [2, 3], count: 4, from: 0.3, size: [0.85, 0.85], roll: 180, flutter: 0.5 }],
  tex: quad({ type: 'pine', colA: [0.13, 0.27, 0.09], colB: [0.26, 0.42, 0.14], needle: 0.4 }),
});

// ── African savanna ────────────────────────────────────────────────────────
def('acacia', 'Umbrella thorn', 'Vachellia tortilis', {
  height: [6.5, 9], bark: 'acacia', barkScale: 0.7, sway: 0.7, puff: 0.5, ao: 0.6,
  levels: [
    { len: 0.52, rad: 0.03, taper: 0.4, segs: 8, gnarl: 8, lean: 5, flare: 0.3, kids: 6, from: 0.7, to: 1, angle: [52, 30], shape: 'cylindrical' },
    { len: 0.8, rad: 0.62, segs: 9, gnarl: 12, curve: -20, curveSpan: 0.8, kids: 10, from: 0.3, angle: [50, 40], kidUp: 0.5 },
    { len: 0.32, rad: 0.5, segs: 5, gnarl: 14, curve: -15, kids: 6, kidUp: 0.5 },
    { len: 0.5, segs: 3, gnarl: 14 },
  ],
  leaves: [{ on: [2, 3], count: 10, size: [0.83, 0.83], face: 'up', roll: 25, planar: 0.6, angle: [60, 40] }],
  tex: quad(sprig('bipinnate', [0.28, 0.37, 0.13], [0.46, 0.52, 0.2], { n: 7, len: 0.36, spread: 55 })),
});
def('baobab', 'Baobab', 'Adansonia digitata', {
  height: [11, 15], bark: 'baobab', barkScale: 1.6, sway: 0.3, ao: 0.6,
  levels: [
    { len: 0.55, rad: 0.11, taper: 0.3, segs: 10, gnarl: 2, bulge: 0.12, flare: 0.25, flareH: 3, kids: 8, from: 0.88, to: 1, angle: [75, 20], shape: 'cylindrical' },
    { len: 0.34, rad: 0.36, taper: 0.85, segs: 8, gnarl: 14, curve: 12, kids: 6, from: 0.3, maxRadLen: 0.12 },
    { len: 0.5, rad: 0.55, segs: 5, gnarl: 18, kids: 5, from: 0.3 },
    { len: 0.45, segs: 3, gnarl: 16 },
  ],
  leaves: [
    { on: [3], mode: 'tip', count: 3, size: [0.5, 0.5], angle: [20, 70], roll: 180, orient: 'spray' },
    { on: [3], count: 2, size: [0.45, 0.45] },
  ],
  tex: quad(sprig('elliptic', [0.24, 0.4, 0.12], [0.4, 0.54, 0.18], { n: 5, len: 0.36, spread: 60 })),
});

// ── Tropical ───────────────────────────────────────────────────────────────
def('coconut', 'Coconut palm', 'Cocos nucifera', {
  height: [13, 18], bark: 'palm', barkScale: 0.6, sway: 1.6, puff: 0.25, ao: 0.75,
  levels: [{ len: 1, rad: 0.012, taper: 0.3, segs: 14, gnarl: 1.5, lean: 14, up: 0.5, flare: 0.9, flareH: 6 }],
  leaves: [{ on: [0], mode: 'tip', kind: 'frond', count: 30, size: [5.2, 2.0], sizeVar: 0.15, angle: [12, 128], angleVar: 8, droop: 1.15, segs: 8, fold: 0.12, flutter: 1.6 }],
  tex: { grid: [2, 1], cells: [{ type: 'frond', aspect: 3.3, colA: [0.15, 0.35, 0.07], colB: [0.36, 0.54, 0.12] }] },
});
def('banana', 'Banana', 'Musa acuminata', {
  height: [3.2, 4.5], bark: 'banana', barkScale: 0.5, stems: [2, 3], clump: 0.5, clumpLean: 6, puff: 0.25, ao: 0.8,
  levels: [{ len: 0.55, rad: 0.035, taper: 0.35, segs: 6, gnarl: 1, flare: 0.3 }],
  leaves: [{ on: [0], mode: 'tip', kind: 'frond', count: 9, size: [2.4, 0.75], sizeVar: 0.2, angle: [10, 80], droop: 1.1, segs: 7, fold: 0.08, flutter: 1.2 }],
  tex: { grid: [2, 1], cells: [{ type: 'banana', aspect: 3.2, colA: [0.26, 0.48, 0.09], colB: [0.46, 0.65, 0.16] }] },
});
def('kapok', 'Kapok', 'Ceiba pentandra', {
  height: [26, 32], bark: 'kapok', barkScale: 1.6, sway: 0.5,
  levels: [
    { len: 0.86, rad: 0.028, taper: 0.6, gnarl: 1.5, flare: 1.8, flareH: 7, lobes: 5, kids: 12, from: 0.66, to: 0.98, angle: [88, 45], shape: 'cylindrical' },
    { len: 0.34, rad: 0.5, segs: 9, gnarl: 9, curve: 6, kids: 8, from: 0.3, kidUp: 0.35 },
    { len: 0.42, rad: 0.55, segs: 5, gnarl: 12, kids: 5 },
    { len: 0.5, segs: 3, gnarl: 12 },
  ],
  leaves: [{ on: [2, 3], count: 10, size: [1.20, 1.20] }],
  tex: quad(sprig('elliptic', [0.15, 0.35, 0.09], [0.3, 0.5, 0.14], { n: 9, len: 0.3, spread: 55 })),
});

// ── East Asia ──────────────────────────────────────────────────────────────
def('sakura', 'Yoshino cherry', 'Prunus × yedoensis', {
  height: [6, 8.5], bark: 'cherry', barkScale: 0.7, ao: 0.62, puff: 0.75,
  levels: [
    { len: 0.5, rad: 0.04, taper: 0.5, segs: 8, gnarl: 6, lean: 6, flare: 0.4, kids: 8, from: 0.5, to: 1, angle: [62, 25], shape: 'cylindrical' },
    { len: 0.75, rad: 0.6, segs: 9, gnarl: 10, curve: -12, kids: 9, from: 0.2, kidUp: 0.3 },
    { len: 0.42, rad: 0.55, segs: 6, gnarl: 12, kids: 6 },
    { len: 0.5, segs: 4, gnarl: 12 },
  ],
  leaves: [{ on: [2, 3], count: 12, size: [0.70, 0.70], tint: [[0.9, 0.88, 0.88], [1.1, 1.06, 1.06]] }],
  tex: quad(sprig('ovate', [0.3, 0.42, 0.16], [0.42, 0.52, 0.2], { n: 3, len: 0.16, spread: 50, flowers: { n: 26, size: 0.085, colA: [0.97, 0.78, 0.85], colB: [1, 0.93, 0.96], eye: [0.85, 0.35, 0.45] } })),
});
def('jmaple', 'Japanese maple', 'Acer palmatum', {
  height: [4, 5.5], bark: 'smoothgray', barkScale: 0.5, ao: 0.6, puff: 0.55,
  levels: [
    { len: 0.4, rad: 0.035, taper: 0.4, segs: 7, gnarl: 9, lean: 10, flare: 0.3, kids: 6, from: 0.5, to: 1, angle: [65, 35], shape: 'cylindrical' },
    { len: 0.85, rad: 0.6, segs: 9, gnarl: 13, curve: -25, kids: 9, from: 0.2, planar: 0.6, angle: [55, 40] },
    { len: 0.42, rad: 0.55, segs: 5, gnarl: 13, curve: -10, kids: 6, planar: 0.7 },
    { len: 0.5, segs: 3, gnarl: 12 },
  ],
  leaves: [{ on: [2, 3], count: 11, size: [0.51, 0.51], face: 'up', roll: 30, planar: 0.7, tint: [[0.85, 0.8, 0.8], [1.15, 1.05, 1]] }],
  tex: quad(sprig('jmaple', [0.52, 0.07, 0.05], [0.84, 0.22, 0.07], { n: 5, len: 0.36, spread: 58, opposite: true, stem: [0.35, 0.1, 0.08] })),
});
def('ginkgo', 'Ginkgo', 'Ginkgo biloba', {
  height: [14, 19], bark: 'ginkgo', barkScale: 0.9, ao: 0.6, sway: 0.8,
  levels: [
    { len: 0.95, rad: 0.024, taper: 0.9, gnarl: 2, flare: 0.35, kids: 18, from: 0.25, angle: [58, 30], shape: 'egg' },
    { len: 0.34, rad: 0.45, segs: 8, gnarl: 6, curve: 10, kids: 8 },
    { len: 0.4, rad: 0.55, segs: 5, gnarl: 8, kids: 5 },
    { len: 0.45, segs: 3, gnarl: 8 },
  ],
  leaves: [{ on: [1, 2, 3], count: 11, size: [0.6, 0.6], flutter: 1.6, tint: [[0.86, 0.84, 0.8], [1.1, 1.08, 1]] }],
  tex: quad(sprig('ginkgo', [0.84, 0.66, 0.08], [0.96, 0.84, 0.2], { n: 9, len: 0.22, spread: 60 })),
});
def('bamboo', 'Moso bamboo', 'Phyllostachys edulis', {
  height: [10, 14], bark: 'bamboo', barkScale: 0.2, stems: [7, 10], clump: 1.1, clumpLean: 7, sway: 2.2, puff: 0.5, ao: 0.6,
  levels: [
    { len: 1, rad: 0.0042, taper: 0.75, segs: 16, gnarl: 0.6, lean: 2, up: 0, curveEnd: -28, flare: 0, kids: 26, whorl: 2, from: 0.38, to: 0.98, angle: [62, 48], shape: 'cylindrical' },
    { len: 0.085, rad: 0.35, segs: 4, gnarl: 8, curve: -15 },
  ],
  leaves: [{ on: [1], count: 9, size: [0.7, 0.56], angle: [50, 30], droop: 0.4, flutter: 1.6, terminal: true }],
  tex: quad(sprig('lance', [0.28, 0.46, 0.1], [0.5, 0.64, 0.2], { n: 7, len: 0.32, spread: 40, stem: [0.45, 0.5, 0.2] })),
});

// ── Desert Southwest ───────────────────────────────────────────────────────
def('saguaro', 'Saguaro', 'Carnegiea gigantea', {
  height: [7, 10], bark: 'cactus', barkScale: 0.6, sway: 0.08,
  levels: [
    { len: 1, rad: 0.024, taper: 0.12, segs: 12, gnarl: 0.8, lean: 1, cap: 0.07, flare: 0, up: 0.2, kids: 3, from: 0.3, to: 0.55, angle: [85, 85], angleVar: 5, shape: 'cylindrical' },
    { len: 0.36, rad: 0.72, taper: 0.1, cap: 0.12, segs: 10, gnarl: 1, curve: 92, curveSpan: 0.35, lenVar: 0.35, maxRadLen: 0.2 },
  ],
  leaves: [],
});
def('joshua', 'Joshua tree', 'Yucca brevifolia', {
  height: [4, 6.5], bark: 'joshua', barkScale: 0.5, sway: 0.3, puff: 0.5, ao: 0.6,
  levels: [
    { len: 0.48, rad: 0.045, taper: 0.25, segs: 7, gnarl: 5, lean: 6, flare: 0.3, kids: 3, from: 0.9, to: 1, angle: [40, 30], shape: 'cylindrical' },
    { len: 0.42, rad: 0.72, taper: 0.2, segs: 6, gnarl: 8, kids: 2.4, from: 0.85, to: 1, angle: [45, 35], maxRadLen: 0.2 },
    { len: 0.6, rad: 0.75, taper: 0.2, segs: 5, gnarl: 8, kids: 1.8, from: 0.85, to: 1, angle: [45, 35], maxRadLen: 0.2 },
    { len: 0.7, rad: 0.78, taper: 0.2, segs: 4, gnarl: 8, maxRadLen: 0.2 },
  ],
  leaves: [{ ends: true, mode: 'tip', count: 9, size: [1.0, 1.0], angle: [10, 80], roll: 180, orient: 'spray', flutter: 0.2, lodSkip: [1, 2, 3] }],
  tex: quad({ type: 'yucca', colA: [0.28, 0.37, 0.18], colB: [0.47, 0.53, 0.28] }),
});
def('fanpalm', 'California fan palm', 'Washingtonia filifera', {
  height: [10, 14], bark: 'palm', barkScale: 0.7, sway: 1.0, puff: 0.25, ao: 0.75,
  levels: [{ len: 1, rad: 0.02, taper: 0.2, segs: 10, gnarl: 0.8, lean: 2, flare: 0.5, flareH: 4 }],
  leaves: [
    { on: [0], mode: 'tip', kind: 'frond', count: 30, size: [2.8, 2.8], sizeVar: 0.15, angle: [12, 105], droop: 0.5, segs: 4, fold: 0.06, cells: [0, 1], flutter: 1.2 },
    { on: [0], kind: 'frond', orient: 'radial', count: 36, from: 0.72, to: 0.985, size: [1.7, 1.7], angle: [150, 166], droop: 0.3, segs: 3, cells: [2, 3], flutter: 0.3, lodSkip: [1, 2, 3] },
  ],
  tex: { grid: [2, 2], cells: [
    { type: 'fan', colA: [0.19, 0.37, 0.11], colB: [0.38, 0.52, 0.18] }, { type: 'fan', colA: [0.19, 0.37, 0.11], colB: [0.38, 0.52, 0.18] },
    { type: 'fan', colA: [0.5, 0.4, 0.24], colB: [0.72, 0.62, 0.42] }, { type: 'fan', colA: [0.5, 0.4, 0.24], colB: [0.72, 0.62, 0.42] },
  ] },
});

// ── South America ──────────────────────────────────────────────────────────
def('araucaria', 'Paraná pine', 'Araucaria angustifolia', {
  height: [18, 24], bark: 'araucaria', barkScale: 0.9, puff: 0.55, ao: 0.45, sway: 0.6,
  levels: [
    { len: 1, rad: 0.02, taper: 0.7, gnarl: 1, flare: 0.3, kids: 30, whorl: 6, from: 0.7, to: 0.99, angle: [95, 62], shape: 'inverse' },
    { len: 0.3, rad: 0.4, taper: 0.6, segs: 9, gnarl: 3, curve: 45, kids: 11, from: 0.72, to: 1, angle: [40, 25], kidUp: 0.3 },
    { len: 0.22, rad: 0.6, segs: 4, gnarl: 8, curve: 25 },
  ],
  leaves: [
    { on: [2], count: 9, size: [1.0, 0.7], angle: [40, 20], roll: 180, terminal: true, flutter: 0.4 },
    { on: [1], count: 9, from: 0.62, size: [1.0, 0.7], angle: [50, 25], roll: 180, flutter: 0.4 },
  ],
  tex: quad({ type: 'scale', aspect: 1.44, colA: [0.07, 0.19, 0.09], colB: [0.16, 0.31, 0.13], dense: true, thick: true }),
});
def('ipe', 'Yellow ipê', 'Handroanthus albus', {
  height: [8, 12], bark: 'ipe', barkScale: 0.8, ao: 0.65, puff: 0.75,
  levels: [
    { len: 0.6, rad: 0.03, taper: 0.55, segs: 9, gnarl: 5, lean: 5, flare: 0.35, kids: 9, from: 0.45, to: 1, angle: [65, 25], shape: 'spherical' },
    { len: 0.5, rad: 0.58, segs: 8, gnarl: 11, curve: 10, kids: 8 },
    { len: 0.45, rad: 0.55, segs: 5, gnarl: 13, kids: 5 },
    { len: 0.5, segs: 3, gnarl: 12 },
  ],
  leaves: [{ on: [2, 3], count: 11, size: [0.83, 0.83], tint: [[0.9, 0.88, 0.85], [1.08, 1.06, 1]] }],
  tex: quad(sprig('elliptic', [0.3, 0.42, 0.14], [0.42, 0.52, 0.2], { n: 2, len: 0.16, spread: 50, flowers: { n: 30, size: 0.1, colA: [0.94, 0.72, 0.03], colB: [1, 0.88, 0.18], eye: [0.8, 0.5, 0.05] } })),
});
def('jacaranda', 'Jacaranda', 'Jacaranda mimosifolia', {
  height: [8, 12], bark: 'jacaranda', barkScale: 0.8, ao: 0.62, puff: 0.75,
  levels: [
    { len: 0.55, rad: 0.032, taper: 0.5, segs: 9, gnarl: 6, lean: 6, flare: 0.35, kids: 8, from: 0.5, to: 1, angle: [62, 25], shape: 'cylindrical' },
    { len: 0.7, rad: 0.6, segs: 9, gnarl: 11, curve: -8, kids: 8 },
    { len: 0.45, rad: 0.55, segs: 5, gnarl: 13, kids: 5 },
    { len: 0.5, segs: 3, gnarl: 12 },
  ],
  leaves: [{ on: [2, 3], count: 11, size: [0.90, 0.90] }],
  tex: quad([
    sprig('bipinnate', [0.22, 0.4, 0.12], [0.38, 0.54, 0.18], { n: 3, len: 0.3, spread: 55, flowers: { n: 30, size: 0.09, colA: [0.46, 0.36, 0.84], colB: [0.7, 0.6, 0.97], eye: [0.9, 0.85, 1] } }),
    sprig('bipinnate', [0.22, 0.4, 0.12], [0.38, 0.54, 0.18], { n: 7, len: 0.36, spread: 55 }),
  ]),
});

// ── Ground cover ───────────────────────────────────────────────────────────
const cover = (id, name, o) => { PRESETS[id] = Object.assign({ id, name, kind: 'cover', ground: true }, o); };

const grass = (id, name, len, wid, colA, colB, o = {}) => cover(id, name, Object.assign({
  height: [len, len], noBark: true, sway: o.sway || 14,
  levels: [{ len: 0.02, rad: 0.01, segs: 2, flare: 0, lean: 0, gnarl: 0 }],
  leaves: [{ on: [0], mode: 'tip', kind: 'frond', count: o.blades || 11, size: [len, wid], sizeVar: 0.45, angle: [3, o.splay || 46], angleVar: 8, droop: o.droop == null ? 0.9 : o.droop, segs: 3, taper: 0.93, grad: [0.5, 1.12], lodSkip: [1, 2, 3], tint: [[0.82, 0.86, 0.8], [1.12, 1.1, 1]] }],
  tex: { grid: [1, 1], cells: [{ type: 'blade', colA, colB }] },
}, o.extra));
grass('meadowgrass', 'Meadow grass', 0.42, 0.03, [0.2, 0.36, 0.08], [0.46, 0.6, 0.2]);
grass('lushgrass', 'Lush grass', 0.5, 0.036, [0.14, 0.36, 0.07], [0.38, 0.62, 0.16]);
grass('forestgrass', 'Woodland grass', 0.34, 0.026, [0.14, 0.28, 0.08], [0.32, 0.46, 0.16]);
grass('tundragrass', 'Sedge', 0.3, 0.022, [0.3, 0.36, 0.12], [0.58, 0.6, 0.26]);
grass('drygrass', 'Dry grass', 0.36, 0.022, [0.48, 0.42, 0.2], [0.8, 0.72, 0.42]);
grass('savannagrass', 'Red oat grass', 0.95, 0.03, [0.5, 0.4, 0.15], [0.86, 0.72, 0.36], { blades: 14, splay: 30, droop: 0.6, sway: 10 });
grass('bunchgrass', 'Desert bunchgrass', 0.4, 0.016, [0.5, 0.46, 0.26], [0.82, 0.78, 0.52], { blades: 18, splay: 55, droop: 0.5 });
grass('sasa', 'Sasa bamboo', 0.55, 0.07, [0.2, 0.4, 0.1], [0.44, 0.6, 0.2], { blades: 9, splay: 65, droop: 0.7, sway: 8 });

const fern = (id, name, len, colA, colB) => cover(id, name, {
  height: [len * 0.8, len * 0.8], noBark: true, sway: 8,
  levels: [{ len: 0.02, rad: 0.01, segs: 2, flare: 0, lean: 3, gnarl: 0 }],
  leaves: [{ on: [0], mode: 'tip', kind: 'frond', count: 10, size: [len, len * 0.36], sizeVar: 0.25, angle: [18, 72], droop: 1.0, segs: 6, fold: 0.05, lodSkip: [1, 1, 2], upN: 0.6 }],
  tex: { grid: [2, 1], cells: [{ type: 'fern', aspect: 2.78, colA, colB }] },
});
fern('bracken', 'Bracken', 1.0, [0.2, 0.4, 0.1], [0.4, 0.56, 0.16]);
fern('swordfern', 'Sword fern', 1.1, [0.1, 0.3, 0.09], [0.24, 0.46, 0.14]);
fern('treefernling', 'Forest fern', 0.9, [0.14, 0.38, 0.1], [0.3, 0.56, 0.16]);

const flower = (id, name, h, size, petals, colA, colB, eye, o = {}) => cover(id, name, {
  height: [h * 0.8, h * 1.1], stems: [3, 6], clump: 0.14, clumpLean: 16, sway: 12,
  levels: [{ len: 1, rad: 0.011, taper: 0.3, segs: 4, gnarl: 6, flare: 0, lean: 6, up: 0.1 }],
  leaves: [
    { on: [0], mode: 'tip', cross: true, count: 2, size: [size, size], sizeVar: 0.15, angle: [0, 0], angleVar: 0, cells: [0], droop: 0, flutter: 0.3, lodSkip: [1, 1, 2], tint: [[0.95, 0.95, 0.95], [1.08, 1.08, 1.08]] },
    { on: [0], mode: 'tip', count: 1, size: [size * 0.9, size * 0.9], angle: [88, 88], angleVar: 0, center: true, face: 'up', roll: 0, cells: [1], droop: 0, flutter: 0.3, lodSkip: [1, 1, 1], tint: [[0.95, 0.95, 0.95], [1.08, 1.08, 1.08]] },
  ],
  bark: 'stem', barkScale: 0.1,
  tex: { grid: [2, 1], cells: [{ type: 'flower', petals, colA, colB, eye, stem: true, cup: o.cup }, { type: 'flower', petals, colA, colB, eye, cup: o.cup }] },
});
flower('daisy', 'Oxeye daisy', 0.4, 0.11, 16, [0.92, 0.92, 0.88], [1, 1, 0.98], [0.95, 0.75, 0.1]);
flower('poppy', 'Field poppy', 0.5, 0.14, 5, [0.78, 0.08, 0.04], [0.95, 0.2, 0.08], [0.12, 0.1, 0.1], { cup: true });
flower('marigold', 'Desert marigold', 0.32, 0.1, 22, [0.92, 0.68, 0.04], [1, 0.86, 0.14], [0.86, 0.55, 0.04]);

const spike = (id, name, h, colA, colB, leaf) => cover(id, name, {
  height: [h * 0.85, h * 1.1], stems: [3, 5], clump: 0.16, clumpLean: 12, sway: 10,
  levels: [{ len: 0.4, rad: 0.009, taper: 0.3, segs: 3, gnarl: 4, flare: 0, lean: 5, up: 0.1 }],
  leaves: [{ on: [0], mode: 'tip', cross: true, count: 2, size: [h * 0.7, h * 0.25], sizeVar: 0.15, angle: [0, 0], angleVar: 0, droop: 0, flutter: 0.6, lodSkip: [1, 1, 2], tint: [[0.92, 0.92, 0.92], [1.1, 1.1, 1.1]] }],
  bark: 'stem', barkScale: 0.1,
  tex: { grid: [2, 1], cells: [{ type: 'spike', aspect: 2.8, colA, colB, leaf }] },
});
spike('fireweed', 'Fireweed', 0.9, [0.72, 0.2, 0.5], [0.92, 0.42, 0.7], [0.24, 0.4, 0.14]);
spike('lavender', 'Lavender', 0.55, [0.4, 0.3, 0.66], [0.62, 0.5, 0.86], [0.42, 0.5, 0.4]);
spike('bluebell', 'Bluebell', 0.38, [0.25, 0.28, 0.72], [0.46, 0.5, 0.9], [0.2, 0.42, 0.14]);

const shrub = (id, name, h, leafTex, o = {}) => cover(id, name, Object.assign({
  ground: false, height: [h * 0.8, h * 1.15], stems: [4, 6], clump: h * 0.16, clumpLean: 24, sway: 2.5, bark: 'twig', barkScale: 0.3, puff: 0.7, ao: 0.5,
  levels: [
    { len: 1, rad: 0.012, taper: 0.8, segs: 6, gnarl: 10, flare: 0, lean: 8, up: 0.15, kids: 7, from: 0.2, angle: [55, 35], shape: 'egg' },
    { len: 0.42, rad: 0.6, segs: 4, gnarl: 14, kidUp: 0.2 },
  ],
  leaves: [{ on: [0, 1], count: o.count || 9, from: 0.2, size: [h * 0.26, h * 0.26], roll: 70, lodSkip: [1, 2, 4] }],
  tex: quad(leafTex),
}, o.extra));
shrub('hazel', 'Hazel', 1.6, sprig('ovate', [0.2, 0.38, 0.1], [0.38, 0.54, 0.16], { n: 7, len: 0.32, spread: 55 }));
shrub('blueberry', 'Bog blueberry', 0.5, sprig('elliptic', [0.2, 0.34, 0.14], [0.4, 0.5, 0.22], { n: 10, len: 0.2, spread: 50 }));
shrub('salal', 'Salal', 1.0, sprig('ovate', [0.1, 0.27, 0.09], [0.24, 0.42, 0.14], { n: 8, len: 0.3, spread: 55 }));
shrub('rosemary', 'Rosemary', 0.8, sprig('lance', [0.24, 0.34, 0.24], [0.44, 0.52, 0.4], { n: 16, len: 0.16, spread: 45, opposite: true }), { count: 11 });
shrub('thornbush', 'Thorn scrub', 1.3, sprig('bipinnate', [0.3, 0.36, 0.14], [0.5, 0.52, 0.24], { n: 6, len: 0.3, spread: 55 }), { count: 6 });
shrub('creosote', 'Creosote bush', 1.2, sprig('elliptic', [0.3, 0.38, 0.14], [0.5, 0.54, 0.24], { n: 14, len: 0.12, spread: 50 }), { count: 7 });
shrub('azalea', 'Azalea', 0.9, sprig('elliptic', [0.16, 0.34, 0.1], [0.3, 0.48, 0.16], { n: 6, len: 0.22, spread: 50, flowers: { n: 12, size: 0.13, colA: [0.86, 0.2, 0.46], colB: [0.98, 0.5, 0.7], eye: [0.6, 0.1, 0.3] } }), { count: 10 });

const rosette = (id, name, len, wid, tex, o = {}) => cover(id, name, {
  height: [len, len], noBark: true, sway: o.sway || 1,
  levels: [{ len: 0.03, rad: 0.01, segs: 2, flare: 0, lean: 4, gnarl: 0 }],
  leaves: [Object.assign({ on: [0], mode: 'tip', kind: 'frond', count: 16, size: [len, wid], sizeVar: 0.2, angle: [8, 85], droop: 0.3, segs: 3, taper: 0.88, fold: 0.1, flutter: 0.2, lodSkip: [1, 1, 2], upN: 0.5 }, o.leaf)],
  tex,
});
rosette('agave', 'Agave', 0.6, 0.11, { grid: [1, 1], cells: [{ type: 'blade', colA: [0.3, 0.42, 0.36], colB: [0.52, 0.62, 0.56], edge: [0.78, 0.8, 0.66] }] });
rosette('bromeliad', 'Bromeliad', 0.55, 0.09, { grid: [1, 1], cells: [{ type: 'blade', colA: [0.5, 0.12, 0.14], colB: [0.3, 0.56, 0.16], edge: [0.2, 0.42, 0.12] }] }, { leaf: { droop: 0.7, count: 18 } });
rosette('elephantear', 'Elephant ear', 0.95, 0.7, { grid: [2, 1], cells: [{ type: 'heart', aspect: 1.36, colA: [0.12, 0.36, 0.1], colB: [0.3, 0.56, 0.16] }] }, { sway: 5, leaf: { count: 6, taper: 0, fold: 0.05, angle: [12, 62], droop: 0.8, segs: 4, flutter: 0.8 } });

// ── Regional packs ─────────────────────────────────────────────────────────
// trees: [id, weight]   cover: [id, plants per m², patchiness 0..1]
// ground: two soil/litter tones   light: suggested sun elevation (deg)
const PACKS = [
  { id: 'europe', name: 'Temperate Europe', note: 'Oak and beech woodland with meadow edges',
    trees: [['oak', 3], ['beech', 3], ['birch', 2], ['spruce', 2]],
    cover: [['meadowgrass', 5, 0.3], ['daisy', 0.18, 0.7], ['poppy', 0.06, 0.8], ['bracken', 0.08, 0.7], ['hazel', 0.01, 0.5]],
    ground: [[0.2, 0.25, 0.1], [0.32, 0.3, 0.16]], density: 85 },
  { id: 'boreal', name: 'Boreal taiga', note: 'Cold conifer forest across Canada, Scandinavia and Siberia',
    trees: [['blackspruce', 4], ['scotspine', 3], ['aspen', 3]],
    cover: [['tundragrass', 4, 0.5], ['fireweed', 0.12, 0.8], ['blueberry', 0.12, 0.6], ['bracken', 0.03, 0.8]],
    ground: [[0.2, 0.2, 0.1], [0.36, 0.33, 0.2]], density: 130 },
  { id: 'pnw', name: 'Pacific Northwest', note: 'Temperate rainforest from Oregon to British Columbia',
    trees: [['douglasfir', 4], ['redcedar', 3], ['bigleafmaple', 2]],
    cover: [['forestgrass', 2.2, 0.6], ['swordfern', 0.3, 0.4], ['salal', 0.05, 0.6]],
    ground: [[0.13, 0.17, 0.08], [0.26, 0.21, 0.13]], density: 110 },
  { id: 'mediterranean', name: 'Mediterranean', note: 'Dry hills of Italy, Greece and southern Spain',
    trees: [['cypress', 3], ['olive', 4], ['stonepine', 3]],
    cover: [['drygrass', 3.5, 0.5], ['lavender', 0.14, 0.7], ['rosemary', 0.04, 0.6], ['poppy', 0.05, 0.8]],
    ground: [[0.42, 0.36, 0.22], [0.6, 0.52, 0.36]], density: 45 },
  { id: 'savanna', name: 'African savanna', note: 'Open grassland of East and southern Africa',
    trees: [['acacia', 6], ['baobab', 1]],
    cover: [['savannagrass', 3.2, 0.3], ['thornbush', 0.012, 0.6]],
    ground: [[0.46, 0.36, 0.2], [0.66, 0.54, 0.32]], density: 16 },
  { id: 'tropical', name: 'Tropical rainforest', note: 'Humid lowlands of the equatorial belt',
    trees: [['coconut', 3], ['banana', 3], ['kapok', 2]],
    cover: [['lushgrass', 4, 0.3], ['elephantear', 0.12, 0.5], ['treefernling', 0.12, 0.5]],
    ground: [[0.14, 0.2, 0.08], [0.28, 0.24, 0.13]], density: 90 },
  { id: 'eastasia', name: 'East Asia', note: 'Gardens and hill forest of Japan, Korea and China',
    trees: [['sakura', 3], ['jmaple', 3], ['ginkgo', 2], ['bamboo', 2]],
    cover: [['lushgrass', 4.5, 0.25], ['azalea', 0.03, 0.6], ['sasa', 0.25, 0.7], ['treefernling', 0.04, 0.7]],
    ground: [[0.16, 0.24, 0.09], [0.3, 0.3, 0.16]], density: 70 },
  { id: 'desert', name: 'Desert Southwest', note: 'Sonoran and Mojave deserts',
    trees: [['saguaro', 4], ['joshua', 3], ['fanpalm', 1]],
    cover: [['bunchgrass', 0.5, 0.7], ['agave', 0.03, 0.5], ['creosote', 0.025, 0.4], ['marigold', 0.05, 0.8]],
    ground: [[0.6, 0.46, 0.32], [0.78, 0.64, 0.46]], density: 22 },
  { id: 'southamerica', name: 'South America', note: 'Atlantic forest and highlands of Brazil',
    trees: [['araucaria', 3], ['ipe', 3], ['jacaranda', 3]],
    cover: [['lushgrass', 4.5, 0.3], ['bromeliad', 0.06, 0.6], ['treefernling', 0.1, 0.5], ['elephantear', 0.04, 0.7]],
    ground: [[0.2, 0.24, 0.09], [0.4, 0.28, 0.15]], density: 60 },
];

// ───────────────────────────────────────────────────────────────────────────
// TEXTURES — everything is generated, nothing is downloaded.
//   barkTexture(id)    -> { width, height, color, normal }      (pure maths)
//   groundTexture(a,b) -> { width, height, color, normal }      (pure maths)
//   leafTexture(tex)   -> { width, height, data, mips }         (needs Canvas 2D)
// All buffers are RGBA8, row 0 = bottom (v = 0), ready for any GPU API.
// ───────────────────────────────────────────────────────────────────────────

function makeNoise(seed) {
  const R = makeRng(seed), p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) { const j = (R() * (i + 1)) | 0, t = p[i]; p[i] = p[j]; p[j] = t; }
  const wrap = (i, n) => ((i % n) + n) % n;
  const h = (ix, iy, px, py) => p[(p[wrap(ix, px) & 255] + wrap(iy, py)) & 255] / 255;
  const h2 = (ix, iy, px, py) => p[(p[(wrap(iy, py) + 91) & 255] + wrap(ix, px) + 37) & 255] / 255;
  const noise = (x, y, px, py) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    let fx = x - xi, fy = y - yi;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    const a = h(xi, yi, px, py), b = h(xi + 1, yi, px, py), c = h(xi, yi + 1, px, py), d = h(xi + 1, yi + 1, px, py);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
  /** Tileable fractal noise; (px, py) is the period in lattice cells. */
  const fbm = (x, y, px, py, oct) => {
    let s = 0, a = 0.5, n = 0;
    for (let o = 0; o < oct; o++) { s += a * noise(x, y, px, py); n += a; a *= 0.5; x *= 2; y *= 2; px *= 2; py *= 2; }
    return s / n;
  };
  /** Tileable cellular noise -> [F1, F2, cell id]. */
  const worley = (x, y, px, py) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    let f1 = 9, f2 = 9, id = 0;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const cx = xi + i, cy = yi + j;
      const dx = cx + h(cx, cy, px, py) - x, dy = cy + h2(cx, cy, px, py) - y, d = Math.hypot(dx, dy);
      if (d < f1) { f2 = f1; f1 = d; id = h2(cx + 5, cy + 3, px, py); } else if (d < f2) f2 = d;
    }
    return [f1, f2, id];
  };
  return { noise, fbm, worley };
}

// kind, dark tone, light tone, then kind-specific options
const BARKS = {
  oak: { kind: 'furrow', a: [0.17, 0.14, 0.11], b: [0.46, 0.41, 0.34], fx: 9, fy: 2, warp: 0.4 },
  fir: { kind: 'furrow', a: [0.14, 0.1, 0.08], b: [0.42, 0.33, 0.26], fx: 7, fy: 2, warp: 0.5 },
  olive: { kind: 'furrow', a: [0.2, 0.18, 0.15], b: [0.52, 0.49, 0.43], fx: 8, fy: 3, warp: 0.9 },
  acacia: { kind: 'furrow', a: [0.13, 0.11, 0.09], b: [0.38, 0.33, 0.27], fx: 10, fy: 2, warp: 0.4 },
  ginkgo: { kind: 'furrow', a: [0.2, 0.17, 0.13], b: [0.5, 0.45, 0.37], fx: 11, fy: 2, warp: 0.3 },
  ipe: { kind: 'furrow', a: [0.2, 0.17, 0.13], b: [0.5, 0.45, 0.38], fx: 12, fy: 3, warp: 0.3 },
  jacaranda: { kind: 'furrow', a: [0.22, 0.19, 0.16], b: [0.52, 0.48, 0.42], fx: 13, fy: 3, warp: 0.25 },
  mossy: { kind: 'furrow', a: [0.17, 0.14, 0.11], b: [0.44, 0.4, 0.33], fx: 9, fy: 2, warp: 0.4, moss: 0.6 },
  twig: { kind: 'furrow', a: [0.2, 0.15, 0.1], b: [0.42, 0.34, 0.25], fx: 5, fy: 2, warp: 0.2 },
  pine: { kind: 'plate', a: [0.2, 0.11, 0.07], b: [0.62, 0.38, 0.22], cx: 5, cy: 4 },
  stonepine: { kind: 'plate', a: [0.2, 0.1, 0.07], b: [0.6, 0.33, 0.2], cx: 4, cy: 3 },
  spruce: { kind: 'plate', a: [0.16, 0.12, 0.1], b: [0.42, 0.34, 0.28], cx: 9, cy: 9 },
  araucaria: { kind: 'plate', a: [0.16, 0.13, 0.12], b: [0.42, 0.37, 0.34], cx: 6, cy: 8 },
  beech: { kind: 'smooth', a: [0.36, 0.37, 0.35], b: [0.62, 0.63, 0.6] },
  smoothgray: { kind: 'smooth', a: [0.3, 0.3, 0.26], b: [0.54, 0.54, 0.47] },
  baobab: { kind: 'smooth', a: [0.4, 0.35, 0.33], b: [0.66, 0.59, 0.55], wrinkle: 1.6 },
  kapok: { kind: 'smooth', a: [0.36, 0.36, 0.32], b: [0.62, 0.62, 0.56], moss: 0.25 },
  banana: { kind: 'smooth', a: [0.3, 0.32, 0.12], b: [0.55, 0.56, 0.24], wrinkle: 0.6 },
  stem: { kind: 'smooth', a: [0.2, 0.34, 0.1], b: [0.36, 0.5, 0.16], wrinkle: 0.3 },
  birch: { kind: 'birch', a: [0.1, 0.09, 0.08], b: [0.9, 0.89, 0.84] },
  aspen: { kind: 'birch', a: [0.14, 0.13, 0.11], b: [0.78, 0.8, 0.7], soft: true },
  cherry: { kind: 'birch', a: [0.52, 0.45, 0.4], b: [0.26, 0.17, 0.15], cherry: true },
  palm: { kind: 'rings', a: [0.26, 0.22, 0.18], b: [0.56, 0.5, 0.42], rings: 9 },
  cedar: { kind: 'fibre', a: [0.2, 0.11, 0.08], b: [0.56, 0.36, 0.26] },
  cypress: { kind: 'fibre', a: [0.2, 0.16, 0.13], b: [0.5, 0.43, 0.36] },
  joshua: { kind: 'fibre', a: [0.17, 0.13, 0.1], b: [0.5, 0.42, 0.32], shaggy: true },
  cactus: { kind: 'cactus', a: [0.14, 0.26, 0.12], b: [0.36, 0.5, 0.24], ribs: 8 },
  bamboo: { kind: 'bamboo', a: [0.26, 0.4, 0.12], b: [0.5, 0.62, 0.22] },
};

function buildMaps(W, H, heightFn, colorFn, bump) {
  const hgt = new Float32Array(W * H), color = new Uint8Array(W * H * 4), normal = new Uint8Array(W * H * 4);
  const c = [0, 0, 0];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, u = x / W, v = y / H;
    const h = heightFn(u, v);
    hgt[i] = h;
    colorFn(u, v, h, c);
    color[i * 4] = clamp(c[0], 0, 1) * 255; color[i * 4 + 1] = clamp(c[1], 0, 1) * 255; color[i * 4 + 2] = clamp(c[2], 0, 1) * 255; color[i * 4 + 3] = 255;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const dx = (hgt[y * W + ((x + 1) % W)] - hgt[y * W + ((x + W - 1) % W)]) * bump;
    const dy = (hgt[((y + 1) % H) * W + x] - hgt[((y + H - 1) % H) * W + x]) * bump * (W / H) * 2;
    const l = 1 / Math.hypot(dx, dy, 1);
    normal[i * 4] = (-dx * l * 0.5 + 0.5) * 255; normal[i * 4 + 1] = (-dy * l * 0.5 + 0.5) * 255; normal[i * 4 + 2] = (l * 0.5 + 0.5) * 255; normal[i * 4 + 3] = 255;
  }
  return { width: W, height: H, color, normal };
}

const barkCache = new Map();
/** Tileable bark albedo + normal map. One repeat is 1 unit wide by 2 tall. */
function barkTexture(id, opts = {}) {
  const W = opts.width || 256, H = W * 2, key = id + ':' + W;
  if (barkCache.has(key)) return barkCache.get(key);
  const B = BARKS[id] || BARKS.oak, N = makeNoise(hashString(id) + 7), { fbm, worley } = N;
  let heightFn, bump = 6;
  let colorFn = (u, v, h, c) => {
    const t = clamp(h * 0.8 + (fbm(u * 6, v * 12, 6, 12, 3) - 0.5) * 0.5, 0, 1), ao = 0.5 + 0.5 * Math.min(1, h * 1.6);
    for (let k = 0; k < 3; k++) c[k] = lerp(B.a[k], B.b[k], t) * ao;
  };
  switch (B.kind) {
    case 'furrow':
      heightFn = (u, v) => {
        const w = fbm(u * 4, v * 4, 4, 4, 3) - 0.5;
        const r = fbm(u * B.fx + w * B.warp * 2, v * B.fy, B.fx, B.fy, 4);
        const crack = Math.pow(clamp(Math.abs(2 * r - 1) * 3.2, 0, 1), 0.6);
        return crack * 0.78 + fbm(u * 32, v * 48, 32, 48, 3) * 0.22;
      };
      bump = 7;
      break;
    case 'plate': {
      const cell = (u, v) => worley(u * B.cx + (fbm(u * 3, v * 3, 3, 3, 2) - 0.5) * 0.7, v * B.cy, B.cx, B.cy);
      heightFn = (u, v) => { const w = cell(u, v); return smooth(0.02, 0.2, w[1] - w[0]) * (0.6 + 0.4 * w[2]) + fbm(u * 40, v * 40, 40, 40, 2) * 0.12; };
      colorFn = (u, v, h, c) => {
        const w = cell(u, v), edge = smooth(0.0, 0.16, w[1] - w[0]);
        const t = clamp(w[2] * 0.7 + 0.3 * fbm(u * 24, v * 24, 24, 24, 3) + ((w[0] * 5) % 1) * 0.12, 0, 1);
        for (let k = 0; k < 3; k++) c[k] = lerp(B.a[k] * 0.6, lerp(B.a[k], B.b[k], t), edge);
      };
      bump = 8;
      break;
    }
    case 'smooth': {
      const wr = B.wrinkle || 1;
      heightFn = (u, v) => fbm(u * 5, v * 8, 5, 8, 4) * 0.5 + fbm(u * 3, v * 56, 3, 56, 2) * 0.22 * wr + fbm(u * 48, v * 48, 48, 48, 2) * 0.08;
      colorFn = (u, v, h, c) => {
        const t = clamp(smooth(0.3, 0.7, fbm(u * 3, v * 4, 3, 4, 4)) * 0.75 + fbm(u * 2, v * 40, 2, 40, 2) * 0.3, 0, 1);
        for (let k = 0; k < 3; k++) c[k] = lerp(B.a[k], B.b[k], t);
      };
      bump = 3 * wr;
      break;
    }
    case 'birch': {
      const mark = (u, v) => smooth(0.6, 0.7, fbm(u * 5, v * 44, 5, 44, 3)) * (B.cherry ? 1 : 0.9);
      const scar = (u, v) => (B.cherry ? 0 : smooth(B.soft ? 0.7 : 0.64, 0.76, fbm(u * 3 + 9, v * 3, 3, 3, 4)));
      heightFn = (u, v) => 0.6 - scar(u, v) * 0.5 + mark(u, v) * (B.cherry ? 0.3 : -0.15) + fbm(u * 4, v * 60, 4, 60, 2) * 0.12;
      colorFn = (u, v, h, c) => {
        const m = Math.max(mark(u, v), scar(u, v)), g = 0.88 + 0.24 * fbm(u * 2, v * 30, 2, 30, 3);
        for (let k = 0; k < 3; k++) c[k] = lerp(B.b[k] * g, B.a[k], m);
      };
      bump = 3;
      break;
    }
    case 'rings':
      heightFn = (u, v) => { const s = (v * B.rings + fbm(u * 4, v * 4, 4, 4, 2) * 0.5) % 1; return s * 0.75 + fbm(u * 40, v * 6, 40, 6, 2) * 0.25; };
      bump = 5;
      break;
    case 'fibre':
      heightFn = (u, v) => fbm(u * 36 + (fbm(u * 3, v * 3, 3, 3, 2) - 0.5) * 3, v * 3, 36, 3, 3) * 0.6 + fbm(u * 8, v * 2, 8, 2, 3) * (B.shaggy ? 0.6 : 0.4);
      bump = B.shaggy ? 9 : 6;
      break;
    case 'cactus':
      heightFn = (u) => Math.pow(Math.abs(Math.cos(Math.PI * u * B.ribs)), 0.7);
      colorFn = (u, v, h, c) => {
        const ridge = smooth(0.93, 1, h), dot = ridge * smooth(0.6, 0.9, Math.abs(Math.sin(Math.PI * v * 22)));
        const t = h * 0.8 + fbm(u * 8, v * 16, 8, 16, 3) * 0.3;
        for (let k = 0; k < 3; k++) c[k] = lerp(lerp(B.a[k], B.b[k], t), k === 2 ? 0.62 : 0.8, dot);
      };
      bump = 10;
      break;
    case 'bamboo':
      heightFn = (u, v) => 0.5 + smooth(0.06, 0, Math.abs(v - 0.5)) * 0.5 - smooth(0.012, 0, Math.abs(v - 0.47)) * 0.6;
      colorFn = (u, v, h, c) => {
        const node = smooth(0.02, 0, Math.abs(v - 0.47)), bloom = smooth(0.09, 0, Math.abs(v - 0.43)) * 0.45;
        const t = fbm(u * 24, v * 2, 24, 2, 2) * 0.6 + 0.3;
        for (let k = 0; k < 3; k++) c[k] = lerp(lerp(lerp(B.a[k], B.b[k], t), 0.82, bloom), 0.16, node);
      };
      bump = 4;
      break;
  }
  if (B.moss) {
    const base = colorFn, moss = [0.2, 0.34, 0.08];
    colorFn = (u, v, h, c) => {
      base(u, v, h, c);
      const m = smooth(0.48, 0.66, fbm(u * 3 + 4, v * 5, 3, 5, 4)) * B.moss * (0.6 + 0.4 * h);
      for (let k = 0; k < 3; k++) c[k] = lerp(c[k], moss[k] * (0.7 + 0.6 * fbm(u * 30, v * 60, 30, 60, 2)), m);
    };
  }
  const t = buildMaps(W, H, heightFn, colorFn, bump);
  barkCache.set(key, t);
  return t;
}

/** Tileable soil / leaf-litter albedo + normal map from two tones. */
function groundTexture(a, b, opts = {}) {
  const S = opts.size || 512, { fbm, worley } = makeNoise(opts.seed || 11);
  return buildMaps(S, S,
    (u, v) => fbm(u * 8, v * 8, 8, 8, 5) * 0.7 + smooth(0.25, 0.05, worley(u * 28, v * 28, 28, 28)[0]) * 0.3,
    (u, v, h, c) => {
      const t = clamp(smooth(0.3, 0.72, fbm(u * 4 + 3, v * 4, 4, 4, 5)) * 0.8 + (fbm(u * 64, v * 64, 64, 64, 2) - 0.5) * 0.5, 0, 1);
      const peb = smooth(0.2, 0.08, worley(u * 28, v * 28, 28, 28)[0]) * 0.18, sh = 0.72 + 0.4 * h;
      for (let k = 0; k < 3; k++) c[k] = (lerp(a[k], b[k], t) + peb * 0.4) * sh;
    }, 4);
}

// ── foliage atlas painters (Canvas 2D) ─────────────────────────────────────
// Each painter draws in a space x∈[0,1], y∈[0,A] (y up), anchored at (0.5, 0),
// where A is the card's length/width ratio.

const css = (c, k = 1) => 'rgb(' + Math.round(clamp(c[0] * k, 0, 1) * 255) + ',' + Math.round(clamp(c[1] * k, 0, 1) * 255) + ',' + Math.round(clamp(c[2] * k, 0, 1) * 255) + ')';
const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const bell = (W, e, k) => (t) => W * Math.pow(Math.sin(Math.PI * Math.pow(t, e)), k);
const TWIG = [0.26, 0.19, 0.11];

const LEAF_SHAPES = {
  ovate: { hw: bell(0.3, 0.72, 0.9), veins: 6 },
  elliptic: { hw: bell(0.23, 0.95, 0.85), veins: 6 },
  lance: { hw: bell(0.085, 0.8, 0.8), veins: 0, petiole: 0.04 },
  round: { hw: (t) => 0.44 * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.72)), 0.62), veins: 4, petiole: 0.32 },
  birch: { hw: (t) => 0.34 * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.55)), 0.95) * (1 + 0.07 * Math.sin(t * 70)), veins: 6, petiole: 0.2 },
  oak: { hw: (t) => 0.3 * Math.pow(Math.sin(Math.PI * Math.pow(t, 1.25)), 0.7) * (0.66 + 0.34 * Math.cos(t * TAU * 4.3)), veins: 5, petiole: 0.06 },
  maple: { lobes: [[0, 1, 0.21], [50, 0.84, 0.2], [-50, 0.84, 0.2], [104, 0.5, 0.2], [-104, 0.5, 0.2]], petiole: 0.3 },
  jmaple: { lobes: [[0, 1, 0.1], [36, 0.92, 0.1], [-36, 0.92, 0.1], [74, 0.72, 0.1], [-74, 0.72, 0.1], [116, 0.45, 0.1], [-116, 0.45, 0.1]], petiole: 0.25 },
  ginkgo: { fan: true, petiole: 0.3 },
  bipinnate: { compound: true, petiole: 0.05 },
};

function leafOutline(ctx, hw, L, steps) {
  ctx.beginPath();
  ctx.moveTo(0, 0);
  for (let i = 1; i <= steps; i++) { const t = i / steps; ctx.lineTo(hw(t) * L, t * L); }
  for (let i = steps - 1; i >= 0; i--) { const t = i / steps; ctx.lineTo(-hw(t) * L, t * L); }
  ctx.closePath();
}

function drawLeaf(ctx, S, R, x, y, ang, L) {
  const sh = LEAF_SHAPES[S.leaf] || LEAF_SHAPES.ovate;
  const col = mix3(S.colA, S.colB, R()), k = R.range(0.9, 1.1), stem = S.stem || TWIG;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  const pet = (sh.petiole == null ? 0.12 : sh.petiole) * L;
  ctx.strokeStyle = css(stem); ctx.lineWidth = Math.max(0.004, L * 0.03); ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, pet); ctx.stroke();
  ctx.translate(0, pet);
  const grad = ctx.createLinearGradient(0, 0, 0, L);
  grad.addColorStop(0, css(col, 0.78 * k)); grad.addColorStop(1, css(col, 1.12 * k));
  const vein = css(mix3(col, [0.75, 0.8, 0.45], 0.4), k);
  if (sh.compound) { // feathery bipinnate leaf: rachis, pinnae, tiny leaflets as strokes
    ctx.strokeStyle = css(stem, 1.3); ctx.lineWidth = L * 0.014;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, L); ctx.stroke();
    const pairs = 6;
    for (let i = 0; i < pairs; i++) {
      const t = 0.14 + (0.82 * i) / (pairs - 1), pl = L * 0.5 * Math.sin(Math.PI * Math.pow(t, 0.6)) + L * 0.08;
      for (const sd of [-1, 1]) {
        ctx.save(); ctx.translate(0, t * L); ctx.rotate(sd * (1.05 - t * 0.45));
        ctx.strokeStyle = css(col, k * R.range(0.8, 1.15)); ctx.lineWidth = L * 0.02; ctx.lineCap = 'round';
        ctx.beginPath();
        const n = Math.max(5, Math.round(pl / (L * 0.035)));
        for (let j = 1; j <= n; j++) { const yy = (j / n) * pl, w = L * 0.055 * Math.sin(Math.PI * Math.pow(j / n, 0.7)) + L * 0.012; ctx.moveTo(-w, yy - w * 0.5); ctx.lineTo(0, yy); ctx.lineTo(w, yy - w * 0.5); }
        ctx.stroke(); ctx.restore();
      }
    }
  } else if (sh.fan) { // ginkgo
    ctx.fillStyle = grad; ctx.beginPath(); ctx.moveTo(0, 0);
    for (let i = 0; i <= 28; i++) {
      const th = (-1 + (2 * i) / 28) * 1.02, r = L * (0.92 + 0.08 * Math.cos(th * 9)) * (1 - 0.28 * Math.exp(-(th * th) / 0.008));
      ctx.lineTo(Math.sin(th) * r, Math.cos(th) * r);
    }
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = vein; ctx.lineWidth = L * 0.008; ctx.beginPath();
    for (let i = -5; i <= 5; i++) { const th = i * 0.17; ctx.moveTo(0, 0); ctx.lineTo(Math.sin(th) * L * 0.85, Math.cos(th) * L * 0.85); }
    ctx.stroke();
  } else if (sh.lobes) { // palmate
    ctx.fillStyle = grad;
    for (const lb of sh.lobes) {
      ctx.save(); ctx.rotate(lb[0] * DEG);
      leafOutline(ctx, (t) => lb[2] * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.62)), 0.8) * (1 + 0.16 * Math.sin(t * 34)), L * lb[1], 22);
      ctx.fill();
      ctx.strokeStyle = vein; ctx.lineWidth = L * 0.012; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, L * lb[1] * 0.9); ctx.stroke();
      ctx.restore();
    }
  } else {
    leafOutline(ctx, sh.hw, L, 26);
    ctx.fillStyle = grad; ctx.fill();
    ctx.save(); ctx.clip(); // one half slightly darker: reads as a fold
    ctx.fillStyle = 'rgba(0,0,0,0.13)'; ctx.fillRect(0, 0, L, L);
    ctx.restore();
    ctx.strokeStyle = vein; ctx.lineWidth = L * 0.016; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, L * 0.94);
    for (let i = 1; i <= (sh.veins || 0); i++) {
      const t = i / (sh.veins + 1.5), t2 = Math.min(0.98, t + 0.16), w = sh.hw(t2) * L * 0.86;
      ctx.moveTo(0, t * L); ctx.lineTo(w, t2 * L); ctx.moveTo(0, t * L); ctx.lineTo(-w, t2 * L);
    }
    ctx.lineWidth = L * 0.01; ctx.stroke();
  }
  ctx.restore();
}

function drawBlossom(ctx, F, R, x, y, r) {
  const col = mix3(F.colA, F.colB, R()), rot = R() * TAU;
  ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
  for (let i = 0; i < 5; i++) {
    ctx.rotate(TAU / 5);
    const g = ctx.createLinearGradient(0, 0, 0, r);
    g.addColorStop(0, css(mix3(col, F.eye, 0.5))); g.addColorStop(0.5, css(col)); g.addColorStop(1, css(col, 1.06));
    ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(0, r * 0.56, r * 0.36, r * 0.48, 0, 0, TAU); ctx.fill();
  }
  ctx.fillStyle = css(F.eye); ctx.beginPath(); ctx.arc(0, 0, r * 0.14, 0, TAU); ctx.fill();
  ctx.restore();
}

const PAINT = {
  // leafy branchlet: a twig with side shoots, leaves along all of them, optional blossoms
  sprig(ctx, S, R, A) {
    const n = S.n || 7, len = S.len || 0.3, stem = S.stem || TWIG, pts = [];
    const shoot = (x0, y0, ang, length, count, k, width) => {
      const bend = (R() - 0.5) * 0.5, at = (t) => { const a = ang + bend * t; return [x0 + Math.sin(a) * length * t, y0 + Math.cos(a) * length * t]; };
      ctx.strokeStyle = css(stem); ctx.lineWidth = width; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(x0, y0);
      for (let i = 1; i <= 8; i++) { const q = at(i / 8); ctx.lineTo(q[0], q[1]); pts.push(q); }
      ctx.stroke();
      for (let i = 0; i < count; i++) {
        const t = count > 1 ? 0.1 + (0.9 * i) / (count - 1) : 1, q = at(t), last = i === count - 1;
        const L = len * k * (1 - 0.2 * t) * R.range(0.85, 1.1), a = ((S.spread || 50) + R.range(-12, 12)) * DEG, dir = ang + bend * t;
        if (last) drawLeaf(ctx, S, R, q[0], q[1], -dir + (R() - 0.5) * 0.4, L);
        else if (S.opposite) { drawLeaf(ctx, S, R, q[0], q[1], -dir + a, L); drawLeaf(ctx, S, R, q[0], q[1], -dir - a, L); }
        else drawLeaf(ctx, S, R, q[0], q[1], -dir + (i % 2 ? a : -a), L);
      }
      return at;
    };
    const top = A * (1 - len * 0.62) * 0.94, sides = S.sides == null ? (n >= 5 ? 2 : 1) : S.sides;
    const main = (t) => [0.5, t * top];
    for (let i = 0; i < sides; i++) {
      const t = 0.16 + (0.36 * i) / Math.max(1, sides - 1 || 1) + R() * 0.06, q = main(t), sd = (i % 2 ? 1 : -1) * (R() < 0.5 || sides > 1 ? 1 : -1);
      shoot(q[0], q[1], sd * R.range(0.62, 0.85), Math.min(0.4, (top - q[1]) * 0.7), Math.max(2, Math.round(n * 0.55)), 0.82, 0.011);
    }
    shoot(0.5, 0, (R() - 0.5) * 0.12, top, n, 1, 0.015);
    if (S.flowers) {
      const F = S.flowers;
      for (let i = 0; i < F.n; i++) {
        const q = pts[(R() * pts.length) | 0];
        drawBlossom(ctx, F, R, clamp(q[0] + R.range(-0.13, 0.13), 0.07, 0.93), clamp(q[1] + R.range(-0.1, 0.14), 0.06, A - 0.07), F.size * R.range(0.8, 1.15));
      }
    }
  },

  // spruce / fir branchlet: twig, paired side shoots, dense short needles
  spray(ctx, S, R, A) {
    const segs = [], top = A * 0.96, droop = (R() - 0.5) * 0.06, pairs = S.pairs || 6;
    const axis = (t) => [0.5 + droop * t * t * 4, t * top];
    for (let i = 0; i < 10; i++) segs.push([axis(i / 10), axis((i + 1) / 10)]);
    for (let i = 0; i < pairs; i++) {
      const t = 0.06 + (0.78 * i) / pairs + R() * 0.03, p = axis(t), L = Math.min(0.5, (S.flat ? 0.6 : 0.54) * (1 - t * 0.7) * R.range(0.88, 1.08));
      for (const sd of [-1, 1]) {
        const a = (S.flat ? 62 : 54) * DEG * R.range(0.9, 1.1), e = [clamp(p[0] + sd * Math.sin(a) * L, 0.06, 0.94), p[1] + Math.cos(a) * L * R.range(0.8, 1)];
        const m = [(p[0] + e[0]) / 2, (p[1] + e[1]) / 2 - 0.02];
        segs.push([p, m], [m, e]);
        if (L > 0.2) { const s2 = [m[0] + sd * 0.03, m[1] + L * 0.45], s3 = [clamp(e[0] + sd * 0.01, 0.05, 0.95), e[1] + L * 0.3], m2 = [(p[0] * 0.3 + e[0] * 0.7), (p[1] * 0.3 + e[1] * 0.7)]; segs.push([m, s2], [m2, s3]); }
      }
    }
    const buckets = [[], [], []], nl = S.needle || 0.05;
    for (const [a, b] of segs) {
      const dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy), n = Math.max(3, Math.round(d * 150)), base = Math.atan2(dx, dy);
      for (let i = 0; i < n; i++) for (const sd of [-1, 1]) {
        const t = (i + R()) / n, x = a[0] + dx * t, y = a[1] + dy * t, an = base + sd * R.range(0.6, 1.15), l = nl * R.range(0.7, 1.15);
        buckets[(R() * 3) | 0].push(x, y, x + Math.sin(an) * l, y + Math.cos(an) * l);
      }
    }
    ctx.lineCap = 'round';
    buckets.forEach((b, k) => {
      ctx.strokeStyle = css(mix3(S.colA, S.colB, k / 2)); ctx.lineWidth = 0.0105;
      ctx.beginPath(); for (let i = 0; i < b.length; i += 4) { ctx.moveTo(b[i], b[i + 1]); ctx.lineTo(b[i + 2], b[i + 3]); } ctx.stroke();
    });
    ctx.strokeStyle = css(TWIG, 0.9); ctx.lineWidth = 0.009;
    ctx.beginPath(); for (const [a, b] of segs) { ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); } ctx.stroke();
  },

  // cedar / cypress / araucaria: flattened, repeatedly forking scale-leaf sprays
  scale(ctx, S, R, A) {
    const thick = S.thick ? 1.6 : 1;
    const frond = (x, y, ang, L, depth) => {
      const ex = x + Math.sin(ang) * L, ey = y + Math.cos(ang) * L;
      ctx.strokeStyle = css(mix3(S.colA, S.colB, clamp(depth * 0.4 + R() * 0.35, 0, 1)));
      ctx.lineWidth = (depth === 0 ? 0.026 : depth === 1 ? 0.034 : 0.036) * thick;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(ex, ey); ctx.stroke();
      if (depth >= 2 || L < 0.05) return;
      const n = depth === 0 ? (S.dense ? 12 : 9) : 7;
      for (let i = 0; i < n; i++) {
        const t = 0.12 + (0.84 * i) / n, sd = i % 2 ? 1 : -1;
        frond(x + (ex - x) * t, y + (ey - y) * t, ang + sd * (S.dense ? 0.6 : 0.78) * R.range(0.8, 1.2), L * (depth === 0 ? 0.42 : 0.4) * (1 - t * 0.55) * R.range(0.8, 1.15), depth + 1);
      }
    };
    ctx.lineCap = 'round';
    frond(0.5, 0, (R() - 0.5) * 0.1, A * 0.94, 0);
  },

  // pine: bare woody twig ending in tufts of long needles
  pine(ctx, S, R, A) {
    const tufts = [[0.5, 0.44 * A, 0, 1]];
    if (R() < 0.8) tufts.push([0.5 - 0.15, 0.3 * A, -0.7, 0.75]);
    if (R() < 0.8) tufts.push([0.5 + 0.15, 0.26 * A, 0.7, 0.75]);
    ctx.lineCap = 'round'; ctx.strokeStyle = css(TWIG); ctx.lineWidth = 0.022;
    ctx.beginPath(); ctx.moveTo(0.5, 0); ctx.lineTo(0.5, 0.44 * A);
    for (let i = 1; i < tufts.length; i++) { ctx.moveTo(0.5, 0.12 * A); ctx.lineTo(tufts[i][0], tufts[i][1]); }
    ctx.stroke();
    const nl = S.needle || 0.36;
    for (const [x, y, dir, k] of tufts) for (let pass = 0; pass < 3; pass++) {
      ctx.strokeStyle = css(mix3(S.colA, S.colB, pass / 2)); ctx.lineWidth = 0.0065;
      ctx.beginPath();
      for (let i = 0; i < 34; i++) {
        const a = dir + R.range(-1.35, 1.35), l = nl * k * R.range(0.7, 1.05) * (1 - Math.abs(a - dir) * 0.16), c = R.range(-0.2, 0.2);
        ctx.moveTo(x, y);
        ctx.quadraticCurveTo(x + Math.sin(a + c) * l * 0.5, y + Math.cos(a + c) * l * 0.5, clamp(x + Math.sin(a) * l, 0.02, 0.98), y + Math.cos(a) * l);
      }
      ctx.stroke();
    }
  },

  // yucca / Joshua tree: stiff dagger rosette with a skirt of dead leaves
  yucca(ctx, S, R, A) {
    const cx = 0.5, cy = 0.36 * A, dead = [0.56, 0.47, 0.3];
    const dagger = (a, L, col) => {
      const ex = cx + Math.sin(a) * L, ey = cy + Math.cos(a) * L, w = 0.03;
      ctx.fillStyle = css(col); ctx.beginPath();
      ctx.moveTo(cx - Math.cos(a) * w, cy + Math.sin(a) * w); ctx.lineTo(ex, ey); ctx.lineTo(cx + Math.cos(a) * w, cy - Math.sin(a) * w); ctx.closePath(); ctx.fill();
    };
    for (let i = 0; i < 16; i++) { const a = R.range(1.9, 2.9) * (i % 2 ? 1 : -1); dagger(a, R.range(0.26, 0.36), mix3(dead, [0.4, 0.33, 0.22], R())); }
    for (let i = 0; i < 44; i++) { const a = R.range(-1.75, 1.75); dagger(a, R.range(0.38, 0.6) * (1 - Math.abs(a) * 0.12), mix3(S.colA, S.colB, R())); }
  },

  // pinnate palm frond
  frond(ctx, S, R, A) {
    const n = 46, top = A * 0.98;
    for (let i = 0; i < n; i++) {
      const t = 0.1 + (0.89 * i) / (n - 1), y = t * top;
      const L = 0.47 * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.62)), 0.55) * R.range(0.9, 1), a = lerp(72, 30, t) * DEG;
      for (const sd of [-1, 1]) {
        const ex = 0.5 + sd * Math.sin(a) * L, ey = Math.min(top, y + Math.cos(a) * L * 1.5), w = 0.05;
        ctx.fillStyle = css(mix3(S.colA, S.colB, R()));
        ctx.beginPath(); ctx.moveTo(0.5, y - w); ctx.lineTo(ex, ey); ctx.lineTo(0.5, y + w * 1.6); ctx.closePath(); ctx.fill();
      }
    }
    ctx.strokeStyle = css(mix3(S.colB, [0.7, 0.68, 0.3], 0.5)); ctx.lineWidth = 0.022; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(0.5, 0); ctx.lineTo(0.5, top * 0.97); ctx.stroke();
  },

  // costapalmate fan leaf on a bare petiole
  fan(ctx, S, R, A) {
    const hy = 0.3 * A, n = 36;
    ctx.strokeStyle = css(mix3(S.colA, [0.5, 0.45, 0.25], 0.5)); ctx.lineWidth = 0.022; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(0.5, 0); ctx.lineTo(0.5, hy); ctx.stroke();
    for (let i = 0; i < n; i++) {
      const a = -2.0 + (4.0 * i) / (n - 1), sa = Math.sin(a), ca = Math.cos(a);
      let L = 0.66 * R.range(0.9, 1);
      L = Math.min(L, 0.48 / Math.max(0.05, Math.abs(sa)), ca > 0 ? (A - hy - 0.02) / Math.max(0.05, ca) : (hy - 0.02) / Math.max(0.05, -ca));
      const w = L * 0.062, mx = 0.5 + sa * L * 0.55, my = hy + ca * L * 0.55;
      ctx.fillStyle = css(mix3(S.colA, S.colB, R()));
      ctx.beginPath(); ctx.moveTo(0.5, hy); ctx.lineTo(mx - ca * w, my + sa * w); ctx.lineTo(0.5 + sa * L, hy + ca * L); ctx.lineTo(mx + ca * w, my - sa * w); ctx.closePath(); ctx.fill();
    }
  },

  // banana: broad blade, pale midrib, parallel veins, wind tears
  banana(ctx, S, R, A) {
    const L = A * 0.97, hw = (t) => 0.46 * Math.pow(Math.sin(Math.PI * Math.pow(clamp((t - 0.1) / 0.9, 0, 1), 0.75)), 0.42);
    const g = ctx.createLinearGradient(0, 0, 0, L); g.addColorStop(0, css(S.colA)); g.addColorStop(1, css(S.colB));
    ctx.save(); ctx.translate(0.5, 0);
    leafOutline(ctx, hw, L, 40); ctx.fillStyle = g; ctx.fill();
    ctx.save(); ctx.clip();
    ctx.fillStyle = 'rgba(0,0,0,0.1)'; ctx.fillRect(0, 0, 1, L);
    ctx.strokeStyle = css(S.colB, 1.12); ctx.lineWidth = 0.004; ctx.beginPath();
    for (let i = 0; i < 70; i++) { const y = L * (0.1 + (0.88 * i) / 70); ctx.moveTo(0, y); ctx.lineTo(0.5, y + 0.16); ctx.moveTo(0, y); ctx.lineTo(-0.5, y + 0.16); }
    ctx.stroke(); ctx.restore();
    ctx.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 9; i++) {
      const t = R.range(0.2, 0.92), sd = R() < 0.5 ? -1 : 1, y = t * L, w = R.range(0.008, 0.03), d = R.range(0.35, 0.95) * hw(t);
      ctx.beginPath(); ctx.moveTo(sd * 0.6, y + 0.2 - w); ctx.lineTo(sd * (hw(t) - d), y); ctx.lineTo(sd * 0.6, y + 0.2 + w * 3); ctx.closePath(); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = css(mix3(S.colB, [0.8, 0.85, 0.5], 0.5)); ctx.lineWidth = 0.03; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, L * 0.97); ctx.stroke();
    ctx.restore();
  },

  // fern frond: tapering pairs of toothed pinnae
  fern(ctx, S, R, A) {
    const top = A * 0.98, n = 26;
    ctx.save(); ctx.translate(0.5, 0);
    for (let i = 0; i < n; i++) {
      const t = 0.1 + (0.9 * i) / n, y = t * top, L = 0.47 * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.5)), 0.9) * (1 - 0.1 * t), a = lerp(80, 52, t) * DEG;
      for (const sd of [-1, 1]) {
        ctx.save(); ctx.translate(0, y); ctx.rotate(-sd * a);
        ctx.fillStyle = css(mix3(S.colA, S.colB, R()));
        leafOutline(ctx, (q) => 0.13 * Math.pow(1 - q, 0.6) * (0.72 + 0.28 * Math.abs(Math.sin(q * 26))) + 0.012, L, 30); ctx.fill();
        ctx.restore();
      }
    }
    ctx.strokeStyle = css(mix3(S.colA, TWIG, 0.5)); ctx.lineWidth = 0.02; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, top); ctx.stroke();
    ctx.restore();
  },

  // arrowhead / heart leaf on a long petiole
  heart(ctx, S, R, A) {
    const py = 0.3 * A, L = A * 0.98 - py;
    ctx.strokeStyle = css(S.colA, 1.2); ctx.lineWidth = 0.03; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(0.5, 0); ctx.lineTo(0.5, py + L * 0.2); ctx.stroke();
    ctx.save(); ctx.translate(0.5, py);
    const g = ctx.createLinearGradient(0, 0, 0, L); g.addColorStop(0, css(S.colA)); g.addColorStop(1, css(S.colB));
    ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(0, L * 0.2);
    ctx.bezierCurveTo(0.1, -L * 0.12, 0.52, -L * 0.05, 0.47, L * 0.34); ctx.bezierCurveTo(0.42, L * 0.7, 0.14, L * 0.88, 0, L);
    ctx.bezierCurveTo(-0.14, L * 0.88, -0.42, L * 0.7, -0.47, L * 0.34); ctx.bezierCurveTo(-0.52, -L * 0.05, -0.1, -L * 0.12, 0, L * 0.2);
    ctx.fill();
    ctx.strokeStyle = css(mix3(S.colB, [0.8, 0.9, 0.55], 0.5)); ctx.lineWidth = 0.012; ctx.beginPath();
    ctx.moveTo(0, L * 0.2); ctx.lineTo(0, L * 0.95);
    for (let i = 0; i < 5; i++) for (const sd of [-1, 1]) { const y = L * (0.22 + i * 0.13); ctx.moveTo(0, y); ctx.lineTo(sd * (0.4 - i * 0.07), y + L * (i ? 0.16 : -0.1)); }
    ctx.stroke(); ctx.restore();
  },

  // opaque strip for geometric blades (grass, agave); fills the whole cell
  blade(ctx, S, R, A) {
    const g = ctx.createLinearGradient(0, 0, 0, A); g.addColorStop(0, css(S.colA)); g.addColorStop(1, css(S.colB));
    ctx.fillStyle = g; ctx.fillRect(-0.1, -0.1, 1.2, A + 0.2);
    ctx.fillStyle = S.edge ? css(S.edge) : 'rgba(255,255,220,0.12)';
    if (S.edge) { ctx.fillRect(-0.1, -0.1, 0.18, A + 0.2); ctx.fillRect(0.92, -0.1, 0.18, A + 0.2); } else ctx.fillRect(0.44, 0, 0.12, A);
  },

  // face-on flower head, optionally on a stem
  flower(ctx, S, R, A) {
    const cy = S.stem ? 0.6 * A : 0.5 * A, r = S.stem ? 0.36 : 0.46, n = S.petals;
    if (S.stem) { ctx.strokeStyle = css([0.25, 0.42, 0.14]); ctx.lineWidth = 0.035; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(0.5, 0); ctx.lineTo(0.5, cy); ctx.stroke(); }
    ctx.save(); ctx.translate(0.5, cy);
    for (let i = 0; i < n; i++) {
      ctx.save(); ctx.rotate((i / n) * TAU + R() * 0.1);
      const col = mix3(S.colA, S.colB, R()), g = ctx.createLinearGradient(0, 0, 0, r);
      g.addColorStop(0, css(col, 0.75)); g.addColorStop(1, css(col, 1.05));
      ctx.fillStyle = g; ctx.beginPath();
      if (S.cup) ctx.ellipse(0, r * 0.5, r * 0.5, r * 0.52, 0, 0, TAU); else ctx.ellipse(0, r * 0.56, (r * 2.2) / n + 0.02, r * 0.45, 0, 0, TAU);
      ctx.fill(); ctx.restore();
    }
    ctx.fillStyle = css(S.eye); ctx.beginPath(); ctx.arc(0, 0, r * (S.cup ? 0.2 : 0.26), 0, TAU); ctx.fill();
    ctx.restore();
  },

  // upright raceme of small florets with a few stem leaves
  spike(ctx, S, R, A) {
    ctx.strokeStyle = css(S.leaf, 0.9); ctx.lineWidth = 0.035; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(0.5, 0); ctx.lineTo(0.5, A * 0.95); ctx.stroke();
    for (let i = 0; i < 9; i++) drawLeaf(ctx, { leaf: 'lance', colA: S.leaf, colB: mix3(S.leaf, [0.6, 0.7, 0.3], 0.3), stem: S.leaf }, R, 0.5, A * (0.03 + i * 0.045), (i % 2 ? 1 : -1) * R.range(0.7, 1.2), R.range(0.32, 0.46));
    for (let i = 0; i < 90; i++) {
      const t = R(), y = A * (0.42 + 0.55 * t), w = 0.36 * (1 - t * 0.85) + 0.03;
      ctx.fillStyle = css(mix3(S.colA, S.colB, R()));
      ctx.beginPath(); ctx.ellipse(0.5 + R.range(-w, w), y, 0.06, 0.075, R() * 3, 0, TAU); ctx.fill();
    }
  },
};

function makeCanvas(w, h, factory) {
  if (factory) return factory(w, h);
  if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  throw new Error('Arbor: leafTexture needs a Canvas 2D implementation (pass opts.createCanvas)');
}

/** Box-filtered mip chain whose alpha is rescaled so cut-out coverage stays constant with distance. */
function coverageMips(data, W, H, cutoff) {
  const cover = (d, scale) => { let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] * scale >= cutoff) n++; return n / (d.length / 4); };
  const target = cover(data, 1), mips = [{ width: W, height: H, data }];
  let src = data, w = W, h = H;
  while (w > 1 || h > 1) {
    const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1), dst = new Uint8Array(nw * nh * 4);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      const x0 = Math.min(w - 1, x * 2), x1 = Math.min(w - 1, x * 2 + 1), y0 = Math.min(h - 1, y * 2), y1 = Math.min(h - 1, y * 2 + 1);
      const a = (y0 * w + x0) * 4, b = (y0 * w + x1) * 4, c = (y1 * w + x0) * 4, d = (y1 * w + x1) * 4, o = (y * nw + x) * 4;
      for (let k = 0; k < 4; k++) dst[o + k] = (src[a + k] + src[b + k] + src[c + k] + src[d + k] + 2) >> 2;
    }
    if (target > 0.002 && target < 0.998) {
      let lo = 0.5, hi = 8;
      for (let it = 0; it < 10; it++) { const m = (lo + hi) / 2; if (cover(dst, m) < target) lo = m; else hi = m; }
      const s = (lo + hi) / 2;
      for (let i = 3; i < dst.length; i += 4) dst[i] = Math.min(255, dst[i] * s);
    }
    mips.push({ width: nw, height: nh, data: dst });
    src = dst; w = nw; h = nh;
  }
  return mips;
}

/**
 * Paint a preset's foliage atlas.
 * @param {object} preset  preset (or id); uses preset.tex
 * @param {{size?:number, createCanvas?:(w:number,h:number)=>any}} [opts]
 */
function leafTexture(preset, opts = {}) {
  const P = resolvePreset(preset), spec = P.tex, size = opts.size || 1024;
  const [cols, rows] = spec.grid, cw = size / cols, ch = size / rows;
  const canvas = makeCanvas(size, size, opts.createCanvas), ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, size, size);
  const R = makeRng(hashString(P.id) + 99);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const S = spec.cells[(r * cols + c) % spec.cells.length], A = S.aspect || 1, pad = S.type === 'blade' ? 0 : Math.max(2, size / 256);
    ctx.save();
    ctx.beginPath(); ctx.rect(c * cw + pad, size - (r + 1) * ch + pad, cw - pad * 2, ch - pad * 2); ctx.clip();
    ctx.transform(cw, 0, 0, -ch / A, c * cw, size - r * ch);
    PAINT[S.type](ctx, S, R.fork(), A);
    ctx.restore();
  }
  const img = ctx.getImageData(0, 0, size, size).data, data = new Uint8Array(size * size * 4);
  let sr = 0, sg = 0, sb = 0, sn = 0;
  for (let i = 0; i < img.length; i += 4) if (img[i + 3] > 200) { sr += img[i]; sg += img[i + 1]; sb += img[i + 2]; sn++; }
  sn = sn || 1; sr /= sn; sg /= sn; sb /= sn;
  for (let y = 0; y < size; y++) { // flip to bottom-up, flood empty texels with the mean colour (no dark fringes)
    const s = (size - 1 - y) * size * 4, d = y * size * 4;
    for (let x = 0; x < size * 4; x += 4) {
      const a = img[s + x + 3];
      if (a < 8) { data[d + x] = sr; data[d + x + 1] = sg; data[d + x + 2] = sb; data[d + x + 3] = 0; }
      else { const k = a / 255; data[d + x] = lerp(sr, img[s + x], k); data[d + x + 1] = lerp(sg, img[s + x + 1], k); data[d + x + 2] = lerp(sb, img[s + x + 2], k); data[d + x + 3] = a; }
    }
  }
  const t = { width: size, height: size, data, mips: coverageMips(data, size, size, 128), mean: [sr / 255, sg / 255, sb / 255] };
  return t;
}

// ───────────────────────────────────────────────────────────────────────────
// GLB EXPORT — for engines that don't run JavaScript (Unity, Unreal, Godot,
// Blender). Wind weights travel along as the custom attribute _WIND.
// ───────────────────────────────────────────────────────────────────────────

/**
 * @param {object} tree  result of generate()/mesh()
 * @param {{bark?:Uint8Array, barkNormal?:Uint8Array, leaf?:Uint8Array}} [png]  optional PNG bytes
 * @returns {Uint8Array} binary glTF 2.0
 */
function toGLB(tree, png = {}) {
  const chunks = [], views = [], accessors = [];
  let offset = 0;
  const pushBytes = (bytes, target) => {
    const pad = (4 - (bytes.byteLength % 4)) % 4;
    views.push(Object.assign({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength }, target ? { target } : null));
    chunks.push(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    if (pad) chunks.push(new Uint8Array(pad));
    offset += bytes.byteLength + pad;
    return views.length - 1;
  };
  const acc = (arr, type, comp, extra) => {
    const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type];
    accessors.push(Object.assign({ bufferView: pushBytes(arr, comp === 5126 ? 34962 : 34963), componentType: comp, count: arr.length / size, type }, extra));
    return accessors.length - 1;
  };
  const images = [], textures = [], materials = [], prims = [];
  const texOf = (bytes) => {
    if (!bytes) return null;
    images.push({ bufferView: pushBytes(bytes), mimeType: 'image/png' });
    textures.push({ source: images.length - 1, sampler: 0 });
    return { index: textures.length - 1 };
  };
  const part = (p, material) => {
    if (!p.index.length) return;
    const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    for (let i = 0; i < p.position.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p.position[i + k]); mx[k] = Math.max(mx[k], p.position[i + k]); }
    const uv = new Float32Array(p.uv.length);
    for (let i = 0; i < uv.length; i += 2) { uv[i] = p.uv[i]; uv[i + 1] = 1 - p.uv[i + 1]; }
    const idx = p.index instanceof Uint32Array ? p.index : new Uint32Array(p.index);
    materials.push(material);
    prims.push({
      attributes: { POSITION: acc(p.position, 'VEC3', 5126, { min: mn, max: mx }), NORMAL: acc(p.normal, 'VEC3', 5126), TEXCOORD_0: acc(uv, 'VEC2', 5126), COLOR_0: acc(p.color, 'VEC3', 5126), _WIND: acc(p.wind, 'VEC4', 5126) },
      indices: acc(idx, 'SCALAR', 5125), material: materials.length - 1,
    });
  };
  const bt = texOf(png.bark), bn = texOf(png.barkNormal), lt = texOf(png.leaf);
  part(tree.bark, Object.assign({ name: 'bark', pbrMetallicRoughness: Object.assign({ metallicFactor: 0, roughnessFactor: 0.92 }, bt ? { baseColorTexture: bt } : { baseColorFactor: [0.35, 0.28, 0.22, 1] }) }, bn ? { normalTexture: bn } : null));
  part(tree.leaves, { name: 'foliage', alphaMode: 'MASK', alphaCutoff: 0.5, doubleSided: true, pbrMetallicRoughness: Object.assign({ metallicFactor: 0, roughnessFactor: 0.6 }, lt ? { baseColorTexture: lt } : { baseColorFactor: [0.25, 0.4, 0.12, 1] }) });
  const json = {
    asset: { version: '2.0', generator: 'Arbor' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: tree.preset.id }], meshes: [{ name: tree.preset.name, primitives: prims }],
    materials, accessors, bufferViews: views, buffers: [{ byteLength: offset }],
  };
  if (images.length) { json.images = images; json.textures = textures; json.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }]; }
  let jb = new TextEncoder().encode(JSON.stringify(json));
  if (jb.length % 4) { const padded = new Uint8Array(jb.length + 4 - (jb.length % 4)).fill(32); padded.set(jb); jb = padded; }
  const out = new Uint8Array(12 + 8 + jb.length + 8 + offset), dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, out.length, true);
  dv.setUint32(12, jb.length, true); dv.setUint32(16, 0x4e4f534a, true); out.set(jb, 20);
  let p = 20 + jb.length;
  dv.setUint32(p, offset, true); dv.setUint32(p + 4, 0x004e4942, true); p += 8;
  for (const c of chunks) { out.set(c, p); p += c.byteLength; }
  return out;
}

return {
  VERSION: '1.0.0',
  grow, mesh, generate, scatter, resolvePreset, makeRng, makeNoise,
  PRESETS, PACKS, BARKS, LEAF_SHAPES,
  barkTexture, groundTexture, leafTexture,
  toGLB,
};
})();
export default Arbor;
