// trees.js — pines, round trees, twisted desert trees, palms, logs and stumps.
import * as THREE from 'three';
import { RNG, noise3, lerp, col, paint, paintFaces, flat, xform, tube, blob, piece } from './core.js';
import { Tris, frond } from './foliage.js';
import { PINE, LEAF, BARK } from './palettes.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

function trunkGeo(path, r0, r1, color, radial = 6) {
  const c = col(color), d = c.clone().multiplyScalar(0.72);
  const g = tube(path, (t) => lerp(r0, r1, t), { radial, capEnd: true, color: (t, th, o) => o.copy(c).lerp(d, 0.5 + 0.5 * Math.sin(th * 3 + t * 9)) });
  return flat(g);
}

/**
 * Conifer built from tiers of drooping serrated boughs.
 * palette: 'forest' | 'teal' | 'olive' | 'snow'. density < 0.6 gives a sparse, half-bare tree.
 * lod: 1 builds a quarter-weight version for distant trees.
 */
export function pine({ seed = 1, height = 11, palette = 'forest', density = 1, bare = 0.18, spread = 0.25, lod = 0 } = {}) {
  const rng = new RNG(seed), pal = PINE[palette], H = height;
  const low = col(pal.low), mid = col(pal.mid), tip = col(pal.tip);
  const bend = rng.range(-0.02, 0.02) * H;
  const axis = (y) => V(bend * Math.sin((y / H) * 2.5), y, bend * 0.6 * Math.sin((y / H) * 1.7));
  const path = []; for (let i = 0; i <= 8; i++) path.push(axis((H * 0.98 * i) / 8));
  const solid = [trunkGeo(path, H * 0.03, H * 0.004, pal.trunk)];

  const t = new Tris(), sparse = density < 0.6;
  const tiers = Math.max(5, Math.round((H * 0.9 + 3) * Math.min(1, density + 0.25) * (lod ? 0.75 : 1)));
  for (let i = 0; i < tiers; i++) {
    const u = i / (tiers - 1), y = H * (bare + (0.95 - bare) * Math.pow(u, 0.92));
    const L = H * spread * Math.pow(1 - u, 0.8) + H * 0.045;
    const count = Math.max(4, Math.round(lerp(9, 5, u) * density)), off = rng.range(0, 6.28);
    if (!sparse) { // jagged skirt: gives each tier its volume and a dark underside
      const n = count + 2, apex = axis(y + L * 0.42), c = axis(y), rim = [], rc = [];
      const inner = low.clone().multiplyScalar(0.72), outer = low.clone().lerp(mid, 0.25 + 0.6 * u);
      for (let k = 0; k < n * 2; k++) {
        const a = off + (k / (n * 2)) * 6.283, point = k % 2 === 0, r = L * (point ? rng.range(0.74, 0.9) : 0.5);
        rim.push(V(c.x + Math.cos(a) * r, c.y - L * (point ? rng.range(0.5, 0.68) : 0.22), c.z + Math.sin(a) * r));
        rc.push(point ? outer : outer.clone().multiplyScalar(0.8));
      }
      for (let k = 0; k < n * 2; k++) t.tri(apex, rim[(k + 1) % (n * 2)], rim[k], inner, rc[(k + 1) % (n * 2)], rc[k]);
    }
    const boughs = lod ? Math.ceil(count * 0.6) : count;
    for (let j = 0; j < boughs; j++) {
      if (sparse && rng.chance(0.3)) continue;
      const len = L * rng.range(0.85, 1.15), shade = rng.range(0, 1);
      frond(t, {
        origin: axis(y + L * 0.12), yaw: off + 0.4 + (j / boughs) * 6.283 + rng.range(-0.25, 0.25),
        length: len, width: len * rng.range(0.4, 0.52), rise: lerp(0.1, 0.45, u) + rng.range(-0.08, 0.08), droop: lerp(0.78, 0.5, u) + rng.range(-0.1, 0.1),
        segs: lod ? 4 : 6, serr: 0.5, fold: 0.32,
        c0: low.clone().lerp(mid, 0.35 + 0.5 * u),
        c1: mid.clone().lerp(tip, (0.3 + 0.7 * Math.pow(u, 0.7)) * (0.5 + 0.5 * shade)),
      });
    }
  }
  const foliage = [t.build()];
  const top = new THREE.ConeGeometry(H * 0.03, H * 0.11, 5); top.translate(axis(H).x, H * 0.985, axis(H).z);
  foliage.push(paint(flat(top), (p, n, o) => o.copy(tip)));
  if (sparse) for (let i = 0; i < 6; i++) solid.push(stick(rng, axis(H * rng.range(0.15, 0.7)), H * rng.range(0.08, 0.16), pal.trunk));
  return piece('pine', { solid, foliage }, { height: H });
}

function stick(rng, from, len, color, up = 0.25) {
  const a = rng.range(0, 6.28), dir = V(Math.cos(a), up + rng.range(-0.1, 0.25), Math.sin(a)).normalize();
  const mid = from.clone().addScaledVector(dir, len * 0.5).add(V(0, len * rng.range(-0.08, 0.1), 0));
  const end = from.clone().addScaledVector(dir, len).add(V(0, len * rng.range(0, 0.25), 0));
  return trunkGeo([from, mid, end], len * 0.045 + 0.015, 0.01, color, 4);
}

/** Leafless trunk with broken branches. */
export function deadTree({ seed = 1, height = 6, bark = 'grey', snow = false } = {}) {
  const rng = new RNG(seed), H = height, lean = rng.range(-0.08, 0.08) * H;
  const path = []; for (let i = 0; i <= 6; i++) { const u = i / 6; path.push(V(lean * u * u, H * u, lean * 0.5 * u)); }
  const solid = [trunkGeo(path, H * 0.035 + 0.04, 0.02, BARK[bark])];
  for (let i = 0; i < 7; i++) { const u = rng.range(0.3, 0.92); solid.push(stick(rng, V(lean * u * u, H * u, lean * 0.5 * u), H * rng.range(0.1, 0.26) * (1.1 - u * 0.5), BARK[bark], 0.35)); }
  if (snow) { const w = col(0xffffff); solid.forEach((g) => paint(g, (p, n, o, i) => { o.fromBufferAttribute(g.attributes.color, i); if (n.y > 0.45) o.lerp(w, 0.9); })); }
  return piece('deadTree', { solid }, { height: H });
}

function crownBlob(rng, r, pal, squash = [1, 0.8, 1]) {
  const dark = col(pal.dark), light = col(pal.light), s = rng.seed() % 997;
  return paintFaces(blob(rng, { r, detail: 2, squash, lumpy: 0.32 }), (c, n, o, f) => {
    o.copy(dark).lerp(light, Math.min(1, Math.max(0, n.y * 0.6 + 0.45)));
    o.multiplyScalar(0.93 + 0.14 * noise3(f * 0.31, s, c.y, s));
  });
}

/** Broadleaf tree with a crown of faceted blobs. palette: 'green' | 'deep' | 'autumn' | 'frost'. */
export function roundTree({ seed = 1, height = 6, palette = 'green', bark = 'brown' } = {}) {
  const rng = new RNG(seed), pal = LEAF[palette], H = height, solid = [];
  const lean = rng.range(-0.1, 0.1) * H, top = V(lean, H * 0.55, lean * 0.4);
  solid.push(trunkGeo([V(0, 0, 0), V(lean * 0.3, H * 0.28, 0), top], H * 0.05 + 0.05, H * 0.03, BARK[bark]));
  const tips = [top.clone().add(V(0, H * 0.2, 0))];
  const n = rng.int(2, 4), a0 = rng.range(0, 6.28);
  for (let i = 0; i < n; i++) {
    const a = a0 + (i / n) * 6.283 + rng.range(-0.3, 0.3), from = V(lean * 0.6, H * rng.range(0.34, 0.5), 0);
    const end = from.clone().add(V(Math.cos(a) * H * 0.3, H * rng.range(0.12, 0.3), Math.sin(a) * H * 0.3));
    solid.push(trunkGeo([from, from.clone().lerp(end, 0.5).add(V(0, H * 0.03, 0)), end], H * 0.03, H * 0.015, BARK[bark], 5));
    tips.push(end);
  }
  tips.forEach((p, i) => {
    solid.push(xform(crownBlob(rng, H * (i ? rng.range(0.17, 0.24) : 0.27), pal), { pos: [p.x, p.y + H * 0.05, p.z], rot: [0, rng.range(0, 6), 0] }));
    for (let k = 0; k < 2; k++) {
      const a = rng.range(0, 6.28), d = H * 0.17;
      solid.push(xform(crownBlob(rng, H * rng.range(0.09, 0.13), pal), { pos: [p.x + Math.cos(a) * d, p.y + H * rng.range(-0.02, 0.14), p.z + Math.sin(a) * d] }));
    }
  });
  return piece('roundTree', { solid }, { height: H });
}

/** Gnarled dark tree with sparse bright leaves, for ledges and canyon rims. */
export function twistedTree({ seed = 1, height = 4, palette = 'autumn', bark = 'dark' } = {}) {
  const rng = new RNG(seed), pal = LEAF[palette], H = height, solid = [], t = new Tris();
  const dark = col(pal.dark), light = col(pal.light);
  const grow = (from, dir, len, r, depth) => {
    const pts = [from.clone()], p = from.clone(), d = dir.clone();
    for (let i = 0; i < 4; i++) {
      d.add(V(rng.range(-0.5, 0.5), rng.range(-0.15, 0.35), rng.range(-0.5, 0.5))).normalize();
      p.addScaledVector(d, len / 4); pts.push(p.clone());
    }
    solid.push(trunkGeo(pts, r, r * 0.45, BARK[bark], depth ? 5 : 6));
    if (depth < 2) for (let i = 0; i < 2; i++) grow(pts[2 + i], d.clone().add(V(rng.range(-0.9, 0.9), rng.range(0, 0.5), rng.range(-0.9, 0.9))).normalize(), len * 0.62, r * 0.5, depth + 1);
    if (depth > 0) for (let i = 0; i < 13; i++) {
      const o = pts[rng.int(2, 4)].clone().add(V(rng.range(-0.25, 0.25), rng.range(-0.05, 0.25), rng.range(-0.25, 0.25)).multiplyScalar(H * 0.3));
      const s = rng.next();
      frond(t, { origin: o, yaw: rng.range(0, 6.28), length: H * rng.range(0.1, 0.16), width: H * 0.05, rise: rng.range(0.2, 0.9), droop: 0.5, segs: 2, serr: 0, fold: 0.2, c0: dark.clone().lerp(light, s * 0.5), c1: dark.clone().lerp(light, 0.4 + s * 0.6) });
    }
  };
  grow(V(0, 0, 0), V(rng.range(-0.5, 0.5), 1, rng.range(-0.5, 0.5)).normalize(), H * 0.75, H * 0.055 + 0.03, 0);
  return piece('twistedTree', { solid, foliage: [t.build()] }, { height: H });
}

/** Palm with a leaning ringed trunk and a crown of arching fronds. */
export function palm({ seed = 1, height = 8, lean = 0.22, fronds = 18, palette = 'palm', coconuts = true } = {}) {
  const rng = new RNG(seed), pal = LEAF[palette], H = height, a = rng.range(0, 6.28), k = Math.min(1.25, Math.max(0.55, H / 8));
  const at = (u) => V(Math.cos(a) * lean * H * Math.pow(u, 1.8), H * u, Math.sin(a) * lean * H * Math.pow(u, 1.8));
  const path = []; for (let i = 0; i <= 9; i++) path.push(at(i / 9));
  const bark = col(BARK.palm), ring = bark.clone().multiplyScalar(0.7);
  const trunk = flat(tube(path, (u) => (lerp(0.3, 0.18, u) * k + 0.04 * Math.exp(-u * 14)) * (1 + 0.14 * (Math.round(u * 9) % 2)), {
    radial: 6, color: (u, th, o) => o.copy(bark).lerp(ring, Math.round(u * 9) % 2 ? 0 : 0.55),
  }));
  const solid = [trunk], crown = at(1), t = new Tris();
  const dark = col(pal.dark), light = col(pal.light), dry = col(0xb99a3a);
  for (let i = 0; i < fronds; i++) {
    const old = i >= fronds - 2, len = rng.range(2.9, 3.9) * k, rise = old ? rng.range(-0.25, 0) : rng.range(0.25, 1.25), shade = rng.next();
    frond(t, {
      origin: crown.clone().add(V(0, 0.1 * k, 0)), yaw: (i / fronds) * 6.283 * 1.9 + rng.range(-0.2, 0.2), length: len, width: len * 0.33,
      rise, droop: old ? 0.6 : rise * 0.85 + rng.range(0.2, 0.5), segs: 14, serr: 0.6, fold: 0.3, taper: 0.5, edge: 0.75,
      c0: old ? dry.clone().multiplyScalar(0.8) : dark.clone(), c1: old ? dry.clone() : dark.clone().lerp(light, 0.45 + 0.55 * shade),
    });
  }
  solid.push(xform(paintFaces(blob(rng, { r: 0.3 * k, detail: 1 }), (c, n, o) => o.copy(bark).multiplyScalar(0.8)), { pos: [crown.x, crown.y - 0.05, crown.z] }));
  if (coconuts) for (let i = 0; i < 3; i++) {
    const b = rng.range(0, 6.28);
    solid.push(xform(paintFaces(blob(rng, { r: 0.17 * k, detail: 1, lumpy: 0.05 }), (c, n, o) => o.set(0x5a3b28)), { pos: [crown.x + Math.cos(b) * 0.28 * k, crown.y - 0.28 * k, crown.z + Math.sin(b) * 0.28 * k] }));
  }
  return piece('palm', { solid, foliage: [t.build()] }, { height: H });
}

/** Fallen log. `snow` lays snow on the top faces. */
export function log({ seed = 1, length = 3.2, radius = 0.3, bark = 'brown', snow = false } = {}) {
  const rng = new RNG(seed), L = length, s = rng.seed() % 997;
  const path = []; for (let i = 0; i <= 5; i++) path.push(V(-L / 2 + (L * i) / 5, radius * 0.82, rng.range(-0.04, 0.04) * L));
  const g = flat(tube(path, (t, th) => radius * (1 + 0.1 * noise3(t * 4 + s, Math.cos(th), Math.sin(th), s)), { radial: 8, capStart: true, capEnd: true }));
  const b = col(BARK[bark]), wood = col(0xdcbd8c), white = col(0xffffff);
  paintFaces(g, (c, n, o, f) => {
    if (Math.abs(n.x) > 0.85) { o.copy(wood); return; }
    o.copy(b).multiplyScalar(0.85 + 0.25 * noise3(f * 0.7, s, 0, s));
    if (snow && n.y > 0.35) o.lerp(white, 0.95);
  });
  const solid = [g, stick(rng, V(rng.range(-0.3, 0.3) * L, radius * 1.2, 0), radius * 2.4, BARK[bark], 0.8)];
  return piece('log', { solid });
}

/** Tree stump with root flares. */
export function stump({ seed = 1, radius = 0.42, height = 0.6, bark = 'brown', snow = false } = {}) {
  const rng = new RNG(seed), s = rng.seed() % 997, b = col(BARK[bark]), wood = col(0xdcbd8c), white = col(0xffffff);
  const g = flat(tube([V(0, -0.1, 0), V(0, height * 0.4, 0), V(0, height, 0)], (t, th) => radius * (1.25 - 0.3 * t) * (1 + 0.14 * Math.cos(th * 4 + s) * (1 - t)), { radial: 10 }));
  paintFaces(g, (c, n, o, f) => { if (n.y > 0.8) o.copy(snow ? white : wood); else o.copy(b).multiplyScalar(0.85 + 0.25 * noise3(f * 0.7, s, 0, s)); });
  return piece('stump', { solid: [g] });
}
