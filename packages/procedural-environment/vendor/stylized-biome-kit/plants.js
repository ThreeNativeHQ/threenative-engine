// plants.js — grass, flowers, bushes, ferns, shrubs and cacti.
import * as THREE from 'three';
import { RNG, noise3, lerp, col, paintFaces, flat, xform, tube, blob, piece } from './core.js';
import { Tris, frond } from './foliage.js';
import { LEAF, GRASS } from './palettes.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

/** Clump of curved blades. Instance thousands of these with scatter(). */
export function grassTuft({ seed = 1, blades = 10, height = 0.5, spread = 0.3, palette = 'green', width = 0.07 } = {}) {
  const rng = new RNG(seed), pal = GRASS[palette], t = new Tris(), base = col(pal.base), tip = col(pal.tip);
  for (let i = 0; i < blades; i++) {
    const a = rng.range(0, 6.28), r = spread * Math.sqrt(rng.next()), h = height * rng.range(0.55, 1.15), w = width * rng.range(0.7, 1.2);
    const o = V(Math.cos(a) * r, 0, Math.sin(a) * r), la = rng.range(0, 6.28), lean = h * rng.range(0.1, 0.45);
    const dir = V(Math.cos(la), 0, Math.sin(la)), side = V(-dir.z, 0, dir.x);
    const c1 = base.clone().lerp(tip, rng.range(0.6, 1)), cm = base.clone().lerp(c1, 0.55);
    const m = o.clone().addScaledVector(dir, lean * 0.35).add(V(0, h * 0.55, 0)), top = o.clone().addScaledVector(dir, lean).add(V(0, h, 0));
    const a0 = o.clone().addScaledVector(side, w), b0 = o.clone().addScaledVector(side, -w);
    const a1 = m.clone().addScaledVector(side, w * 0.7), b1 = m.clone().addScaledVector(side, -w * 0.7);
    t.tri(a0, b0, a1, base, base, cm); t.tri(b0, b1, a1, base, cm, cm); t.tri(a1, b1, top, cm, cm, c1);
  }
  return piece('grassTuft', { grass: [t.build({ normalsUp: true })] });
}

/** Small clump of flowers on thin stems. */
export function flowers({ seed = 1, count = 7, spread = 0.45, height = 0.38, color = 0xffffff, heart = 0xf7c531 } = {}) {
  const rng = new RNG(seed), t = new Tris(), stem = col(0x4fa53c), pc = col(color), hc = col(heart);
  for (let i = 0; i < count; i++) {
    const a = rng.range(0, 6.28), r = spread * Math.sqrt(rng.next()), h = height * rng.range(0.6, 1.1);
    const o = V(Math.cos(a) * r, 0, Math.sin(a) * r), top = o.clone().add(V(rng.range(-0.05, 0.05), h, rng.range(-0.05, 0.05)));
    t.tri(o.clone().add(V(0.012, 0, 0)), o.clone().add(V(-0.012, 0, 0)), top, stem, stem, stem);
    const R = 0.085 * rng.range(0.8, 1.2), rot = rng.range(0, 6.28), petals = 6;
    for (let k = 0; k < petals; k++) {
      const a0 = rot + (k / petals) * 6.283, a1 = a0 + 6.283 / petals * 0.72;
      t.tri(top, top.clone().add(V(Math.cos(a0) * R, 0.012, Math.sin(a0) * R)), top.clone().add(V(Math.cos(a1) * R, 0.012, Math.sin(a1) * R)), hc, pc, pc);
    }
  }
  return piece('flowers', { grass: [t.build({ normalsUp: true })] });
}

function leafBlob(rng, r, pal, squash) {
  const dark = col(pal.dark), light = col(pal.light), s = rng.seed() % 997;
  return paintFaces(blob(rng, { r, detail: 1, squash, lumpy: 0.3 }), (c, n, o, f) => {
    o.copy(dark).lerp(light, Math.min(1, Math.max(0, n.y * 0.65 + 0.4)));
    o.multiplyScalar(0.92 + 0.16 * noise3(f * 0.43, s, 0, s));
  });
}

/** Rounded bush made of a few faceted blobs. palette: any LEAF palette. */
export function bush({ seed = 1, size = 1, palette = 'green', blobs = 5 } = {}) {
  const rng = new RNG(seed), pal = LEAF[palette], solid = [];
  for (let i = 0; i < blobs; i++) {
    const a = rng.range(0, 6.28), d = i ? size * rng.range(0.35, 0.7) : 0, r = size * (i ? rng.range(0.32, 0.5) : 0.6);
    solid.push(xform(leafBlob(rng, r, pal, [1, 0.78, 1]), { pos: [Math.cos(a) * d, r * 0.55, Math.sin(a) * d], rot: [0, rng.range(0, 6), 0] }));
  }
  return piece('bush', { solid });
}

/**
 * Rosette of leaves growing from the ground.
 * Narrow and serrated reads as a fern; wide and smooth as a broadleaf or agave.
 */
export function fern({ seed = 1, size = 0.8, fronds = 9, palette = 'green', serr = 0.5, wide = 0.22, upright = 0.9 } = {}) {
  const rng = new RNG(seed), pal = LEAF[palette], t = new Tris(), dark = col(pal.dark), light = col(pal.light);
  for (let i = 0; i < fronds; i++) {
    const len = size * rng.range(0.7, 1.15), s = rng.next();
    frond(t, {
      origin: V(0, 0.02, 0), yaw: (i / fronds) * 6.283 * 1.6 + rng.range(-0.3, 0.3), length: len, width: len * wide,
      rise: upright * rng.range(0.6, 1.3), droop: rng.range(0.6, 1.0), segs: serr ? 8 : 5, serr, fold: 0.35, taper: 0.7,
      c0: dark.clone().multiplyScalar(0.85), c1: dark.clone().lerp(light, 0.4 + 0.6 * s),
    });
  }
  return piece('fern', { foliage: [t.build()] });
}

/** Leafy ball of short fronds — the yellow desert scrub. */
export function shrub({ seed = 1, size = 0.9, palette = 'desert', leaves = 22 } = {}) {
  const rng = new RNG(seed), pal = LEAF[palette], t = new Tris(), dark = col(pal.dark), light = col(pal.light);
  for (let i = 0; i < leaves; i++) {
    const len = size * rng.range(0.45, 0.8), s = rng.next(), a = rng.range(0, 6.28), d = size * 0.3 * rng.next();
    frond(t, {
      origin: V(Math.cos(a) * d, size * rng.range(0, 0.35), Math.sin(a) * d), yaw: a + rng.range(-0.8, 0.8), length: len, width: len * 0.26,
      rise: rng.range(0.3, 1.5), droop: rng.range(0.3, 0.9), segs: 4, serr: 0, fold: 0.3, taper: 0.75,
      c0: dark.clone().multiplyScalar(0.8), c1: dark.clone().lerp(light, 0.3 + 0.7 * s),
    });
  }
  return piece('shrub', { foliage: [t.build()] });
}

// ───────────────────────────── cacti ─────────────────────────────

const CACTUS = { groove: 0x2f7347, ridge: 0x86c463, body: 0x4f9c4c };

function ribbed(body, r0, ribs = 9) {
  // Append a rounded head: four extra rings that close the tube into a dome.
  const m = body.length, end = body[m - 1], dir = end.clone().sub(body[m - 2]).normalize(), path = body.slice();
  for (let k = 1; k <= 4; k++) path.push(end.clone().addScaledVector(dir, r0 * 0.9 * Math.sin((k / 4) * Math.PI / 2)));
  const n = path.length, groove = col(CACTUS.groove), ridge = col(CACTUS.ridge);
  return flat(tube(path, (t, th) => {
    const i = t * (n - 1), dome = i > m - 1 ? Math.max(0.04, Math.cos(((i - (m - 1)) / 4) * Math.PI / 2)) : 1;
    return r0 * dome * (1 + 0.16 * Math.cos(ribs * th)) * (1 - 0.12 * t);
  }, { radial: ribs * 2, capEnd: true, color: (t, th, o) => o.copy(groove).lerp(ridge, (0.5 + 0.5 * Math.cos(ribs * th)) * (0.75 + 0.25 * t)) }));
}

function column(from, h, wob) {
  const pts = [];
  for (let i = 0; i <= 5; i++) { const u = i / 5; pts.push(from.clone().add(V(wob * Math.sin(u * 2.4), h * u, wob * (Math.cos(u * 1.9) - 1)))); }
  return pts;
}

function blossom(t, at, R = 0.24) {
  const white = col(0xffffff), heart = col(0xffd84a), petals = 7, c = at.clone().add(V(0, 0.03, 0));
  for (let k = 0; k < petals; k++) {
    const a0 = (k / petals) * 6.283, a1 = a0 + (6.283 / petals) * 0.8;
    t.tri(c, c.clone().add(V(Math.cos(a0) * R, 0.07, Math.sin(a0) * R)), c.clone().add(V(Math.cos(a1) * R, 0.07, Math.sin(a1) * R)), heart, white, white);
  }
}

/** Saguaro with upturned arms and optional white blossoms. */
export function saguaro({ seed = 1, height = 5, arms = 2, flower = true } = {}) {
  const rng = new RNG(seed), H = height, r = 0.3 + H * 0.035, solid = [], t = new Tris();
  const main = column(V(0, -0.1, 0), H, rng.range(-0.12, 0.12));
  solid.push(ribbed(main, r));
  const tops = [[main[main.length - 1], r]], a0 = rng.range(0, 6.28);
  for (let i = 0; i < arms; i++) {
    const a = a0 + (i / arms) * 6.283 + rng.range(-0.5, 0.5), dir = V(Math.cos(a), 0, Math.sin(a));
    const y0 = H * rng.range(0.3, 0.55), out = r * rng.range(2.2, 3.2), up = H * rng.range(0.25, 0.45), pts = [];
    for (let k = 0; k <= 3; k++) { const q = (k / 3) * Math.PI / 2; pts.push(V(0, y0, 0).addScaledVector(dir, out * Math.sin(q)).add(V(0, out * 0.7 * (1 - Math.cos(q)), 0))); }
    const elbow = pts[pts.length - 1];
    for (let k = 1; k <= 3; k++) pts.push(elbow.clone().add(V(0, (up * k) / 3, 0)));
    solid.push(ribbed(pts, r * 0.68, 7)); tops.push([pts[pts.length - 1], r * 0.68]);
  }
  if (flower) tops.forEach(([p, rr]) => rng.chance(0.75) && blossom(t, p.clone().add(V(0, rr * 0.8, 0))));
  return piece('saguaro', { solid, foliage: t.count ? [t.build()] : [] }, { height: H });
}

/** Cluster of straight columns of different heights. */
export function columnCactus({ seed = 1, count = 4, height = 3.2, flower = true } = {}) {
  const rng = new RNG(seed), solid = [], t = new Tris();
  for (let i = 0; i < count; i++) {
    const a = rng.range(0, 6.28), d = i ? rng.range(0.4, 0.9) : 0, h = height * (i ? rng.range(0.35, 0.9) : 1);
    const pts = column(V(Math.cos(a) * d, -0.1, Math.sin(a) * d), h, rng.range(-0.08, 0.08));
    solid.push(ribbed(pts, 0.2 + h * 0.03, 8));
    if (flower && rng.chance(0.7)) blossom(t, pts[pts.length - 1].clone().add(V(0, (0.2 + h * 0.03) * 0.8, 0)), 0.19);
  }
  return piece('columnCactus', { solid, foliage: t.count ? [t.build()] : [] }, { height });
}
