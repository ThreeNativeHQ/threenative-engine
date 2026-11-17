import { GeoBuilder, lin, mixc } from './GeoBuilder.js';
import { mulberry32, range, pick } from './random.js';
import { addBlade, addStem, addSpindle, addBloom, addLeaf } from './primitives.js';
import { GRASS } from './grass.js';

const STEM = lin('#587a2c'), STEM_DARK = lin('#34501b');

/**
 * Wildflower cluster. `kind` picks a bloom recipe; every kind shares the same
 * stem / foliage construction so new species are a few lines.
 */
export const BLOOMS = {
  cornflower: { h: [0.3, 0.55], r: [0.022, 0.03], petals: 8, cup: 0.35, pw: 0.75, petal: lin('#3e56c9'), tip: lin('#6d82f0'), centre: lin('#2a1d5c'), stems: [3, 6] },
  bellflower: { h: [0.2, 0.4], r: [0.02, 0.028], petals: 5, cup: 0.7, pw: 1.25, petal: lin('#5a4fd0'), tip: lin('#8f8af5'), centre: lin('#e8e2ff'), stems: [4, 8] },
  poppy: { h: [0.35, 0.6], r: [0.03, 0.042], petals: 4, cup: 0.55, pw: 1.7, petal: lin('#c7231a'), tip: lin('#e8452c'), centre: lin('#15100c'), stems: [2, 4] },
  daisy: { h: [0.18, 0.4], r: [0.016, 0.022], petals: 11, cup: 0.08, pw: 0.7, petal: lin('#ecebe2'), tip: lin('#ffffff'), centre: lin('#e2b91c'), stems: [4, 9] },
  buttercup: { h: [0.2, 0.45], r: [0.011, 0.015], petals: 5, cup: 0.5, pw: 1.5, petal: lin('#e9c81c'), tip: lin('#f7e04a'), centre: lin('#b98a12'), stems: [4, 8] },
};

export function flowerCluster(kind = 'cornflower', { seed = 1, lod = 0 } = {}) {
  const K = BLOOMS[kind], rand = mulberry32(seed), b = new GeoBuilder();
  const n = Math.max(1, Math.round(range(rand, K.stems[0], K.stems[1]) * (lod ? 0.6 : 1)));
  const spread = 0.1 + n * 0.022, big = lod ? 1.25 : 1;
  for (let i = 0; i < n; i++) {
    const a = rand() * 6.283, r = spread * Math.sqrt(rand()), h = range(rand, K.h[0], K.h[1]);
    const x = Math.cos(a) * r, z = Math.sin(a) * r, lx = Math.cos(a) * h * range(rand, 0, 0.25), lz = Math.sin(a) * h * range(rand, 0, 0.25);
    const top = [x + lx, h, z + lz], flex = 0.6;
    addStem(b, [x, 0, z], top, lod ? 0.008 : 0.0045, STEM_DARK, STEM, 0, h * flex);
    const fl = Math.hypot(lx, h * 0.9, lz), facing = [lx / fl + range(rand, -0.25, 0.25), (h * 0.9) / fl, lz / fl + range(rand, -0.25, 0.25)];
    const fn = Math.hypot(facing[0], facing[1], facing[2]); facing[0] /= fn; facing[1] /= fn; facing[2] /= fn;
    addBloom(b, top, facing, range(rand, K.r[0], K.r[1]) * big, lod ? Math.min(K.petals, 5) : K.petals, K.petal, K.tip, K.centre, { cup: K.cup, petalWidth: K.pw, wind: h * flex, phase: rand() * 6 });
    if (!lod && rand() < 0.7) { // a stem leaf
      const u = range(rand, 0.25, 0.6), la = rand() * 6.283;
      addLeaf(b, [x + lx * u, h * u, z + lz * u], norm3(Math.cos(la), 0.7, Math.sin(la)), [-Math.sin(la), 0, Math.cos(la)], range(rand, 0.04, 0.08), 0.014, STEM_DARK, STEM, { wind: h * u * flex });
    }
  }
  return b;
}

function norm3(x, y, z) { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; }

/** Tall flower spike (loosestrife / foxglove-like): florets stacked up a stem. */
export function flowerSpike(o = {}) {
  const { seed = 1, lod = 0, stems = [1, 3], height = [0.7, 1.2], petal = lin('#a23d9a'), tip = lin('#d06bc4') } = o;
  const rand = mulberry32(seed), b = new GeoBuilder(), n = Math.round(range(rand, stems[0], stems[1]));
  for (let s = 0; s < n; s++) {
    const a = rand() * 6.283, r = rand() * 0.12, h = range(rand, height[0], height[1]), x = Math.cos(a) * r, z = Math.sin(a) * r;
    const lx = range(rand, -0.1, 0.1) * h, lz = range(rand, -0.1, 0.1) * h, flex = 0.55;
    addStem(b, [x, 0, z], [x + lx, h, z + lz], lod ? 0.012 : 0.007, STEM_DARK, STEM, 0, h * flex);
    const levels = lod ? 5 : 12, start = range(rand, 0.5, 0.62);
    for (let k = 0; k < levels; k++) {
      const u = start + ((1 - start) * (k + 0.5)) / levels, size = (lod ? 0.075 : 0.045) * (1.15 - (u - start) / (1 - start) * 0.75);
      const per = lod ? 2 : 3;
      for (let j = 0; j < per; j++) {
        const fa = k * 1.9 + (j / per) * 6.283, dir = norm3(Math.cos(fa), 0.45, Math.sin(fa));
        addSpindle(b, [x + lx * u, h * u, z + lz * u], dir, size, size * 0.62, petal, tip, h * u * flex);
      }
    }
    for (let k = 0; k < (lod ? 2 : 5); k++) { // lance leaves low on the stem
      const u = range(rand, 0.12, 0.5), la = rand() * 6.283;
      addLeaf(b, [x + lx * u, h * u, z + lz * u], norm3(Math.cos(la), 0.5, Math.sin(la)), [-Math.sin(la), 0, Math.cos(la)], range(rand, 0.09, 0.15), 0.028, STEM_DARK, GRASS.meadow.mid, { wind: h * u * flex });
    }
  }
  return b;
}

/** Feathery cream plume on a tall stalk (reed plume / meadowsweet). */
export function plumeStalk({ seed = 1, lod = 0 } = {}) {
  const rand = mulberry32(seed), b = new GeoBuilder(), cream = lin('#d8d2b4'), cream2 = lin('#f1eedb');
  const n = lod ? 1 : Math.round(range(rand, 1, 3));
  for (let s = 0; s < n; s++) {
    const a = rand() * 6.283, r = rand() * 0.1, h = range(rand, 1.3, 2.0), x = Math.cos(a) * r, z = Math.sin(a) * r;
    const lx = range(rand, -0.12, 0.12) * h, lz = range(rand, -0.12, 0.12) * h, flex = 0.5;
    addStem(b, [x, 0, z], [x + lx, h, z + lz], lod ? 0.014 : 0.008, STEM_DARK, lin('#8d9552'), 0, h * flex);
    const tufts = lod ? 5 : 7;
    for (let k = 0; k < tufts; k++) {
      const fa = k * 2.4, up = 0.55 + rand() * 0.6, dir = norm3(Math.cos(fa) * 0.5 + lx / h, up, Math.sin(fa) * 0.5 + lz / h);
      addSpindle(b, [x + lx, h - 0.05 + k * 0.012, z + lz], dir, range(rand, 0.16, 0.3), range(rand, 0.05, 0.085), cream, cream2, h * flex * 1.15);
    }
    for (let k = 0; k < (lod ? 2 : 4); k++) addBlade(b, { x, z, yaw: rand() * 6.283, height: range(rand, 0.6, 1.2), width: 0.022, lean: range(rand, 0.3, 0.7), curve: 2.2, droop: 0.2, segs: lod ? 2 : 3, pal: GRASS.reed, flex: 0.6 });
  }
  return b;
}

/** Red-brown dock / sorrel seed spike. */
export function dockSpike({ seed = 1, lod = 0 } = {}) {
  const rand = mulberry32(seed), b = new GeoBuilder(), rust = lin('#55291a'), rust2 = lin('#7a3d24');
  const n = Math.round(range(rand, 1, 3));
  for (let s = 0; s < n; s++) {
    const a = rand() * 6.283, r = rand() * 0.08, h = range(rand, 0.6, 1.05), x = Math.cos(a) * r, z = Math.sin(a) * r;
    const lx = range(rand, -0.08, 0.08) * h, lz = range(rand, -0.08, 0.08) * h, flex = 0.45;
    addStem(b, [x, 0, z], [x + lx, h, z + lz], lod ? 0.012 : 0.007, lin('#5a4a26'), rust, 0, h * flex);
    const levels = lod ? 4 : 9;
    for (let k = 0; k < levels; k++) {
      const u = 0.45 + (0.55 * (k + 0.5)) / levels, fa = k * 2.1;
      addSpindle(b, [x + lx * u, h * u, z + lz * u], norm3(Math.cos(fa) * 0.5, 1, Math.sin(fa) * 0.5), lod ? 0.12 : 0.07, lod ? 0.05 : 0.032, rust, rust2, h * u * flex);
    }
    for (let k = 0; k < (lod ? 1 : 3); k++) { // big basal leaves
      const la = rand() * 6.283;
      addLeaf(b, [x, 0.02, z], norm3(Math.cos(la), 0.55, Math.sin(la)), [-Math.sin(la), 0, Math.cos(la)], range(rand, 0.18, 0.3), 0.07, GRASS.deep.mid, GRASS.lush.mid, { wind: 0, wind1: 0.05 });
    }
  }
  return b;
}

/** Leafy herb (nettle-like): square stems with opposite pairs of pointed leaves. */
export function herb({ seed = 1, lod = 0, height = [0.4, 0.9], leaf = [0.07, 0.12], dark = lin('#2a5219'), light = lin('#4f8a2c') } = {}) {
  const rand = mulberry32(seed), b = new GeoBuilder(), n = lod ? 2 : Math.round(range(rand, 2, 4));
  for (let s = 0; s < n; s++) {
    const a = rand() * 6.283, r = rand() * 0.14, h = range(rand, height[0], height[1]), x = Math.cos(a) * r, z = Math.sin(a) * r;
    const lx = Math.cos(a) * h * range(rand, 0, 0.2), lz = Math.sin(a) * h * range(rand, 0, 0.2), flex = 0.5;
    addStem(b, [x, 0, z], [x + lx, h, z + lz], lod ? 0.012 : 0.007, STEM_DARK, STEM, 0, h * flex);
    const pairs = lod ? 3 : Math.round(h / 0.11), size = range(rand, leaf[0], leaf[1]) * (lod ? 1.6 : 1);
    for (let k = 0; k < pairs; k++) {
      const u = (k + 1) / pairs, base = [x + lx * u, h * u, z + lz * u], la = a + (k % 2) * (Math.PI / 2) + range(rand, -0.3, 0.3);
      const ls = size * (0.65 + 0.5 * Math.sin(Math.PI * Math.min(u * 1.1, 1))), c1 = mixc(dark, light, u * range(rand, 0.6, 1));
      for (const sgn of [1, -1]) {
        const dir = norm3(Math.cos(la) * sgn, range(rand, -0.15, 0.25), Math.sin(la) * sgn);
        addLeaf(b, base, dir, [-Math.sin(la), 0, Math.cos(la)], ls, ls * 0.5, dark, c1, { fold: 0.3, wind: h * u * flex, wind1: h * u * flex + 0.03, detail: lod ? 0 : 1 });
      }
    }
    if (!lod) addLeaf(b, [x + lx, h, z + lz], norm3(lx, h, lz), [1, 0, 0], size * 0.6, size * 0.3, light, light, { wind: h * flex });
  }
  return b;
}

/** Butterbur / burdock: big rounded leaves on fleshy stalks. */
export function broadleaf({ seed = 1, lod = 0, leaves = [4, 8], size = [0.2, 0.4] } = {}) {
  const rand = mulberry32(seed), b = new GeoBuilder(), n = Math.max(3, Math.round(range(rand, leaves[0], leaves[1]) * (lod ? 0.6 : 1)));
  const dark = lin('#2f5a1e'), mid = lin('#57902f'), light = lin('#8fba4c'), stalk = lin('#6d8f3c');
  const ring = lod ? 7 : 11;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 6.283 + range(rand, -0.4, 0.4), R = range(rand, size[0], size[1]) * 0.5, h = range(rand, 0.12, 0.45);
    const reach = range(rand, 0.1, 0.42), cx = Math.cos(a) * reach, cz = Math.sin(a) * reach;
    addStem(b, [Math.cos(a) * 0.03, 0, Math.sin(a) * 0.03], [cx, h, cz], lod ? 0.02 : 0.012, stalk, stalk, 0, h * 0.4);
    // leaf blade: a cupped, slightly tilted disc with a heart notch at the stalk
    const tilt = range(rand, 0.15, 0.6), ca = Math.cos(a), sa = Math.sin(a), bright = range(rand, 0.85, 1.15);
    const nrm = norm3(ca * Math.sin(tilt) * 0.6, Math.cos(tilt) + 0.4, sa * Math.sin(tilt) * 0.6);
    const P = (ang, rr) => { // local polar → world; +u points outward along a
      const u = Math.cos(ang) * rr, v = Math.sin(ang) * rr;
      const out = u + R * 0.35, cup = (rr / R) ** 2 * R * 0.22;
      return [cx + ca * out * Math.cos(tilt) - sa * v, h - out * Math.sin(tilt) + cup, cz + sa * out * Math.cos(tilt) + ca * v];
    };
    const c0 = b.v(cx, h, cz, nrm[0], nrm[1], nrm[2], light[0] * bright, light[1] * bright, light[2] * bright, 0.5, 0.5, h * 0.4);
    const inner = [], outer = [];
    for (let k = 0; k <= ring; k++) {
      const ang = -Math.PI + (k / ring) * Math.PI * 2;
      const notch = 1 - 0.55 * Math.exp(-((Math.abs(ang) - Math.PI) ** 2) / 0.08), wav = 1 + 0.06 * Math.sin(ang * 5 + i);
      const pi = P(ang, R * 0.5 * notch), po = P(ang, R * notch * wav);
      inner.push(b.v(pi[0], pi[1], pi[2], nrm[0], nrm[1], nrm[2], mid[0] * bright, mid[1] * bright, mid[2] * bright, 0.5, 0.5, h * 0.4 + 0.02));
      const edge = mixc(mid, dark, 0.45);
      outer.push(b.v(po[0], po[1], po[2], nrm[0], nrm[1], nrm[2], edge[0] * bright, edge[1] * bright, edge[2] * bright, 0.5, 1, h * 0.4 + 0.05));
    }
    for (let k = 0; k < ring; k++) { b.tri(c0, inner[k], inner[k + 1]); b.quad(inner[k], outer[k], outer[k + 1], inner[k + 1]); }
  }
  return b;
}

/** Low ground cover: little trifoliate leaves hovering just above the soil. */
export function cloverPatch({ seed = 1, lod = 0, radius = 0.3 } = {}) {
  const rand = mulberry32(seed), b = new GeoBuilder(), n = lod ? 7 : 18;
  const cols = [lin('#3c6b22'), lin('#4c8029'), lin('#5d9432'), lin('#335a1d')];
  for (let i = 0; i < n; i++) {
    const a = rand() * 6.283, r = radius * Math.sqrt(rand()), x = Math.cos(a) * r, z = Math.sin(a) * r, y = range(rand, 0.03, 0.12);
    const s = range(rand, 0.025, 0.045) * (lod ? 1.7 : 1), c = pick(rand, cols), ph = rand() * 6.283;
    if (!lod) addStem(b, [x, 0, z], [x, y, z], 0.003, STEM_DARK, STEM, 0, y * 0.5);
    for (let k = 0; k < 3; k++) {
      const la = ph + (k / 3) * 6.283;
      addLeaf(b, [x, y, z], norm3(Math.cos(la), 0.12, Math.sin(la)), [-Math.sin(la), 0, Math.cos(la)], s, s * 0.95, mixc(c, [1, 1, 1], 0.08), c, { fold: 0.12, wind: y * 0.5, detail: lod ? 0 : 1 });
    }
  }
  return b;
}

/**
 * Fern: a rosette of arching fronds. UVs map each frond onto a frond cut-out
 * texture (v runs base → tip), so pair it with `fernFrondTexture()`.
 */
export function fern({ seed = 1, lod = 0, fronds = [8, 13], length = [0.55, 1.0] } = {}) {
  const rand = mulberry32(seed), b = new GeoBuilder();
  const n = Math.max(4, Math.round(range(rand, fronds[0], fronds[1]) * (lod === 2 ? 0.45 : lod ? 0.7 : 1)));
  const segs = lod === 2 ? 3 : lod ? 4 : 6, base = lin('#6f8f4a'), tip = lin('#ffffff');
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 6.283 + range(rand, -0.3, 0.3), L = range(rand, length[0], length[1]) * (lod === 2 ? 1.15 : 1), W = L * range(rand, 0.26, 0.34);
    const rise = range(rand, 0.55, 1.15), arch = range(rand, 0.9, 1.6), ca = Math.cos(a), sa = Math.sin(a), bright = range(rand, 0.8, 1.1);
    let px = ca * 0.03, py = 0.02, pz = sa * 0.03, ang = rise;
    let prev = null;
    for (let s = 0; s <= segs; s++) {
      const t = s / segs, c = mixc(base, tip, Math.min(1, t * 1.6));
      // V-shaped cross-section: centre vertex lower than the two edges
      const w = W * 0.5, sx = -sa, sz = ca, lift = W * 0.12;
      const nUp = norm3(ca * -Math.sin(ang) * 0.5, Math.cos(ang) * 0.5 + 0.7, sa * -Math.sin(ang) * 0.5);
      const wind = Math.pow(t, 1.4) * L * 0.55;
      const l = b.v(px - sx * w, py + lift, pz - sz * w, nUp[0], nUp[1], nUp[2], c[0] * bright, c[1] * bright, c[2] * bright, 0, t, wind);
      const m = b.v(px, py, pz, nUp[0], nUp[1], nUp[2], c[0] * bright, c[1] * bright, c[2] * bright, 0.5, t, wind);
      const r = b.v(px + sx * w, py + lift, pz + sz * w, nUp[0], nUp[1], nUp[2], c[0] * bright, c[1] * bright, c[2] * bright, 1, t, wind);
      if (prev) { b.quad(prev[0], prev[1], m, l); b.quad(prev[1], prev[2], r, m); }
      prev = [l, m, r];
      const step = L / segs;
      px += ca * Math.cos(ang) * step; py += Math.sin(ang) * step; pz += sa * Math.cos(ang) * step;
      ang -= (arch / segs) * (0.6 + t);
    }
  }
  return b;
}
