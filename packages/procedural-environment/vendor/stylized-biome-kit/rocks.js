// rocks.js — chiseled cliffs, boulders and spires; layered sandstone mesas and arches.
import * as THREE from 'three';
import { RNG, noise3, fbm, lerp, clamp, smoothstep, profile, col, mixc, paint, displace, xform, weld, facet, strataField, tube, lathe, piece } from './core.js';
import { ROCK, STRATA } from './palettes.js';

// ───────────────────────────── sculpted rock ─────────────────────────────
// A rock is a union of "lumps". Each lump is a convex solid bounded by planes
// whose edges are rounded off, like clay cut with a knife and then thumbed
// smooth. Where lumps overlap you get the creases and ledges of a real outcrop.
// The mesh is made by shooting rays outwards and asking where they leave the union.

const TAU = Math.PI * 2;
const N3 = (x, y, z) => new THREE.Vector3(x, y, z).normalize();
const scratch = new Float64Array(96);

/** Where a ray leaves one lump (rounded), or -1 if it misses. */
function exitT(lump, ox, oy, oz, dx, dy, dz) {
  let tin = -1e9, tmin = 1e9, m = 0;
  for (const { n, d } of lump.planes) {
    const nd = n.x * dx + n.y * dy + n.z * dz, slack = d - (n.x * ox + n.y * oy + n.z * oz);
    if (Math.abs(nd) < 1e-6) { if (slack < 0) return -1; continue; }
    const t = slack / nd;
    if (nd > 0) { scratch[m++] = t; if (t < tmin) tmin = t; } else if (t > tin) tin = t;
  }
  if (!m) return -1;
  let sum = 0;
  for (let i = 0; i < m; i++) sum += Math.exp(-(scratch[i] - tmin) / lump.round); // soft minimum = rounded edges
  const tout = tmin - lump.round * Math.log(sum);
  return tout > Math.max(tin, 0) ? tout : -1;
}

function castOut(lumps, ox, oy, oz, dx, dy, dz, blend) {
  let best = -1;
  for (const lump of lumps) {
    const t = exitT(lump, ox, oy, oz, dx, dy, dz);
    if (t < 0) continue;
    best = best < 0 ? t : Math.max(best, t) + blend * Math.log(1 + Math.exp(-Math.abs(best - t) / blend)); // soft maximum = filled creases
  }
  return best;
}

/** Upright lump with a flat top: a cliff body, shoulder or step. */
function prismLump(rng, { cx = 0, cz = 0, a, b, top, taper = 0.9, walls = 8, chips = 4, round = 0.4 }) {
  const planes = [], cy = top / 2, spin = rng.range(0, TAU);
  const add = (n, d) => planes.push({ n, d: d + n.x * cx + n.y * cy + n.z * cz });
  for (let i = 0; i < walls; i++) {
    const phi = spin + ((i + rng.range(-0.32, 0.32)) / walls) * TAU, x = Math.cos(phi), z = Math.sin(phi);
    const R = Math.pow(Math.pow(Math.abs(a * x), 4 / 3) + Math.pow(Math.abs(b * z), 4 / 3), 3 / 4); // rounded-box support
    const n = N3(x, (R * (1 - taper)) / top + rng.range(-0.08, 0.08), z);
    add(n, R * (1 + taper) * 0.5 * Math.hypot(n.x, n.z) * rng.range(0.84, 1));
  }
  for (let i = 0; i < chips; i++) { // slanted cuts: mostly shoulders off the top, sometimes an undercut
    const phi = rng.range(0, TAU), n = N3(Math.cos(phi), rng.chance(0.55) ? rng.range(0.3, 0.9) : -rng.range(0.08, 0.25), Math.sin(phi));
    add(n, (a * Math.abs(n.x) + (top / 2) * Math.abs(n.y) + b * Math.abs(n.z)) * rng.range(0.8, 0.93));
  }
  planes.push({ n: new THREE.Vector3(0, 1, 0), d: top });
  return { planes, round };
}

/** Rounded lump cut from an ellipsoid: boulders and spires. */
function blobLump(rng, { c = [0, 0, 0], r, count = 14, squashY = 1, round = 0.2, min = 0.82 }) {
  const planes = [], spin = rng.range(0, TAU);
  for (let i = 0; i < count; i++) {
    const yy = 1 - (2 * (i + 0.5)) / count, rr = Math.sqrt(1 - yy * yy), phi = i * 2.399963 + spin;
    const n = N3(Math.cos(phi) * rr + rng.range(-0.3, 0.3), (yy + rng.range(-0.3, 0.3)) * squashY, Math.sin(phi) * rr + rng.range(-0.3, 0.3));
    planes.push({ n, d: Math.hypot(r[0] * n.x, r[1] * n.y, r[2] * n.z) * rng.range(min, 1) + n.x * c[0] + n.y * c[1] + n.z * c[2] });
  }
  return { planes, round };
}

/** Surface relief added on top of the lumps: broad swelling, fine lumpiness, a few vertical gullies. */
function relief(S, s) {
  return (x, y, z) => {
    const big = S * 0.045 * fbm((x * 2.0) / S + s, (y * 1.3) / S, (z * 2.0) / S, 2, s);
    const fine = S * 0.014 * fbm((x * 6.5) / S, (y * 6.5) / S + s, (z * 6.5) / S, 2, s + 3);
    const where = smoothstep(0.05, 0.45, noise3((x * 0.5) / S, (y * 0.3) / S, (z * 0.5) / S + s, s + 9));
    const gully = S * 0.06 * where * (1 - smoothstep(0, 0.2, Math.abs(noise3((x * 1.5) / S, (y * 0.32) / S, (z * 1.5) / S, s + 5))));
    return big + fine - gully;
  };
}

/**
 * Mesh a lump union standing on a vertical axis: rings up the sides, then a fan
 * over the top. The mesh is deliberately coarse and jittered, so the rock is
 * made of a few hundred chunky, irregular facets.
 */
function axisMesh(rng, lumps, { top, fan, radial, seg, y0 = -1.5, blend = 0.3, bump, jitter = 0.3 }) {
  const P = [], I = [], rows = [], side = Math.max(2, Math.round((top - fan - y0) / seg)), nf = 3;
  for (let j = 0; j <= side; j++) rows.push([lerp(y0, top - fan, j / side), 0, j > 0 && j < side ? (top - fan - y0) / side : 0]);
  for (let j = 1; j < nf; j++) rows.push([top - fan, (j / nf) * Math.PI / 2, 0]);
  const put = (oy, dx, dy, dz) => {
    let t = castOut(lumps, 0, oy, 0, dx, dy, dz, blend); if (t < 0) t = 0.05;
    t += bump(dx * t, oy + dy * t, dz * t) * (1 - 0.85 * dy * dy); // keep the top fairly level
    P.push(dx * t, oy + dy * t, dz * t);
  };
  for (const [oy, phi, dy] of rows) for (let i = 0; i < radial; i++) {
    const th = ((i + rng.range(-jitter, jitter)) / radial) * TAU;
    put(oy + rng.range(-jitter, jitter) * dy, Math.cos(th) * Math.cos(phi), Math.sin(phi), Math.sin(th) * Math.cos(phi));
  }
  put(top - fan, 0, 1, 0);
  const pole = P.length / 3 - 1;
  for (let j = 0; j < rows.length - 1; j++) for (let i = 0; i < radial; i++) {
    const a = j * radial + i, b = j * radial + ((i + 1) % radial), c = a + radial, d = b + radial;
    if (rng.chance(0.5)) I.push(a, c, b, b, c, d); else I.push(a, c, d, a, d, b); // vary the diagonal
  }
  const last = (rows.length - 1) * radial;
  for (let i = 0; i < radial; i++) I.push(last + i, pole, last + ((i + 1) % radial));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setIndex(I);
  return facet(g);
}

/** Mesh a lump union around a point: rays through the (jittered) vertices of a coarse icosphere. */
function pointMesh(rng, lumps, { centre, detail, blend = 0.15, bump, jitter = 0.22 }) {
  const g = weld(new THREE.IcosahedronGeometry(1, detail)), j = jitter / (detail + 1);
  displace(g, (p) => {
    p.set(p.x + rng.range(-j, j), p.y + rng.range(-j, j), p.z + rng.range(-j, j)).normalize();
    let t = castOut(lumps, centre[0], centre[1], centre[2], p.x, p.y, p.z, blend); if (t < 0) t = 0.05;
    t += bump(centre[0] + p.x * t, centre[1] + p.y * t, centre[2] + p.z * t);
    p.set(centre[0] + p.x * t, centre[1] + p.y * t, centre[2] + p.z * t);
  });
  return facet(g);
}

// One even tone per facet (lighter facing up, darker underneath and towards the
// ground). Up-facing facets take the grass or snow colour outright; the facets
// just under a grassy rim get a ragged spill of it. Edges and cracks are painted
// by the material.
function shadeRock(geo, pal, { height, seed = 0, detail = 1, grass = 0, snowy = false, rim = 0.1 }) {
  const dark = col(pal.dark), capA = col(pal.capDark), capB = col(pal.cap), k = (seed % 97) / 9.7, tmp = new THREE.Color();
  return paint(geo, (p, n, o, i, surf, cap) => {
    if ((grass && n.y > 0.7) || (snowy && n.y > 0.55)) { o.copy(capA).lerp(capB, smoothstep(0.6, 0.95, n.y)); surf.set(0, 0, k, rim); return; }
    const t = clamp(p.y / height, 0, 1);
    mixc(o, pal.base, pal.light, clamp(n.y, 0, 1) * 0.6 + 0.3 * smoothstep(0.25, 1, t));
    o.lerp(dark, clamp(-n.y, 0, 1) * 0.5 + 0.4 * (1 - smoothstep(0, 0.5, t)));
    const h = Math.sin(Math.round(n.x * 40) * 12.9898 + Math.round(n.y * 40) * 78.233 + Math.round(n.z * 40) * 37.719) * 43758.5453;
    o.multiplyScalar(0.96 + 0.08 * (h - Math.floor(h))); // one tint per facet
    surf.set(detail, 0, k, rim);
    if (grass && n.y > -0.3) { tmp.copy(capA).lerp(capB, 0.6); cap.set(tmp.r, tmp.g, tmp.b, 0.9 * smoothstep(height - grass * 2.6, height - grass * 0.4, p.y)); }
  });
}

/**
 * Cliff: a chunky low-poly outcrop with a level top that can carry grass or snow.
 * It is one main mass plus `shoulders` (nearly as tall, leaving creases) and
 * `steps` (lower ledges). `detail` scales the facet count.
 * userData.top = { y, rx, rz } tells you where to stand things on it.
 */
export function cliff({ seed = 1, width = 12, depth = 9, height = 14, palette = 'alpine', taper = 0.88, cap = true, lip = 0.7, shoulders = 2, steps = 0, detail = 1 } = {}) {
  const rng = new RNG(seed), pal = ROCK[palette], s = rng.seed() % 997, a = width / 2, b = depth / 2, S = (a + b) / 2, H = height;
  const round = clamp(S * 0.02, 0.06, 0.4);
  const lumps = [prismLump(rng, { a: a * 0.82, b: b * 0.82, top: H, taper, walls: 8, chips: 4, round })];
  const around = (dist, size, top, n) => {
    const a0 = rng.range(0, TAU);
    for (let i = 0; i < n; i++) {
      const phi = a0 + (i / n) * TAU + rng.range(-0.6, 0.6), d = rng.range(...dist), k = rng.range(...size);
      lumps.push(prismLump(rng, { cx: Math.cos(phi) * a * d, cz: Math.sin(phi) * b * d, a: a * k, b: b * k, top: H * rng.range(...top), taper: rng.range(0.8, 1.02), walls: 7, chips: 3, round }));
    }
  };
  around([0.38, 0.55], [0.42, 0.62], [0.7, 0.96], shoulders);
  around([0.5, 0.7], [0.45, 0.7], [0.22, 0.6], steps);
  const radial = Math.max(14, Math.round(26 * detail));
  const g = axisMesh(rng, lumps, { top: H, fan: clamp(Math.min(a, b) * 0.7, 1.2, H * 0.5), radial, seg: ((TAU * S) / radial) * 1.15, blend: round, bump: relief(S, s) });
  shadeRock(g, pal, { height: H, seed: s, detail: 1, grass: cap && palette !== 'snow' ? lip : 0, snowy: cap && palette === 'snow', rim: clamp(S * 0.022, 0.06, 0.4) });
  return piece('cliff', { solid: [g] }, { top: { y: H, rx: a * taper * 0.48, rz: b * taper * 0.48 } });
}

function boulderGeo(rng, { size, squash, pal, snowy, detail }) {
  const s = rng.seed() % 997, r = [size * squash[0], size * squash[1], size * squash[2]], round = size * 0.03;
  const lumps = [blobLump(rng, { r, count: 15, round, min: 0.72 })];
  const phi = rng.range(0, TAU); // a second, smaller mass leaning on the first
  lumps.push(blobLump(rng, { c: [Math.cos(phi) * r[0] * 0.55, -r[1] * 0.25, Math.sin(phi) * r[2] * 0.55], r: [r[0] * 0.6, r[1] * 0.62, r[2] * 0.6], count: 11, round, min: 0.74 }));
  const g = pointMesh(rng, lumps, { centre: [0, 0, 0], detail, blend: round, bump: relief(size * 1.1, s) });
  g.computeBoundingBox();
  const h = g.boundingBox.max.y - g.boundingBox.min.y;
  g.translate(0, -g.boundingBox.min.y - h * 0.14, 0);
  return shadeRock(g, pal, { height: h * 0.86, seed: s, snowy, rim: clamp(size * 0.035, 0.012, 0.09) });
}

/** Chunky low-poly boulder: one mass with a smaller one leaning on it. `snowy` lays snow on top. */
export function boulder({ seed = 1, size = 2, palette = 'alpine', squash = [1, 0.72, 0.9], snowy = false, detail = 2 } = {}) {
  const rng = new RNG(seed), pal = ROCK[palette];
  return piece('boulder', { solid: [boulderGeo(rng, { size, squash, pal, snowy, detail })] });
}

/** A scatter of small stones. */
export function pebbles({ seed = 1, count = 6, size = 0.35, spread = 1.6, palette = 'alpine', snowy = false } = {}) {
  const rng = new RNG(seed), pal = ROCK[palette], parts = [];
  for (let i = 0; i < count; i++) {
    const g = boulderGeo(rng, { size: size * rng.range(0.5, 1.3), squash: [1, rng.range(0.5, 0.8), rng.range(0.7, 1)], pal, snowy, detail: 1 });
    const a = rng.range(0, TAU), r = spread * Math.sqrt(rng.next());
    parts.push(xform(g, { pos: [Math.cos(a) * r, 0, Math.sin(a) * r], rot: [0, rng.range(0, 6.28), 0] }));
  }
  return piece('pebbles', { solid: parts });
}

/** Cluster of tall faceted shards — the ice spires of the snow biome. */
export function spires({ seed = 1, count = 4, height = 14, radius = 2.4, palette = 'snow', snowy = true } = {}) {
  const rng = new RNG(seed), pal = ROCK[palette], parts = [];
  for (let i = 0; i < count; i++) {
    const s = rng.seed() % 997;
    const h = height * (i === 0 ? 1 : rng.range(0.45, 0.9)), r = radius * (i === 0 ? 1 : rng.range(0.6, 0.95));
    const lumps = [blobLump(rng, { c: [0, h * 0.42, 0], r: [r, h * 0.58, r], count: 16, squashY: 0.3, round: r * 0.04, min: 0.8 })];
    const g = axisMesh(rng, lumps, { top: h, fan: h * 0.42, radial: 9, seg: h / 5, blend: 0.1, bump: relief(r * 1.8, s) });
    const a = i === 0 ? 0 : rng.range(0, TAU), d = i === 0 ? 0 : radius * rng.range(1.0, 1.7);
    shadeRock(g, pal, { height: h, seed: s, snowy, rim: 0.1 });
    parts.push(xform(g, { pos: [Math.cos(a) * d, 0, Math.sin(a) * d], rot: [rng.range(-0.06, 0.06), rng.range(0, 6), rng.range(-0.06, 0.06)] }));
  }
  return piece('spires', { solid: parts });
}

// ───────────────────────────── layered sandstone ─────────────────────────────

const SHAPES = {
  pillar: [[0, 1.08], [0.12, 0.92], [0.45, 0.6], [0.72, 0.84], [0.88, 1.12], [0.96, 1.15], [1, 1.02]],
  block: [[0, 1.06], [0.2, 0.95], [0.6, 0.9], [0.85, 1.0], [0.96, 1.04], [1, 0.95]],
  hoodoo: [[0, 0.72], [0.3, 0.5], [0.7, 0.42], [0.82, 0.78], [0.93, 0.92], [1, 0.74]],
  shelf: [[0, 0.3], [0.35, 0.36], [0.68, 0.74], [0.88, 1.08], [0.97, 1.12], [1, 1.0]],
  butte: [[0, 1.2], [0.3, 1.0], [0.7, 0.9], [0.9, 0.93], [1, 0.84]],
};

/**
 * Layered sandstone formation. shape: 'pillar' | 'block' | 'hoodoo' | 'shelf' | 'butte'.
 * sx / sz stretch the footprint (use sx: 2.5 for a canyon wall).
 * Built like the rest of the kit: coarse flat facets, with the bands painted
 * crisply across them by the material. `detail` scales the facet count.
 */
export function mesa({ seed = 1, height = 18, radius = 6, shape = 'pillar', sx = 1, sz = 1, palette = 'desert', detail = 1 } = {}) {
  const rng = new RNG(seed), pal = STRATA[palette], s = rng.seed() % 997, k = rng.range(0, 10);
  const prof = profile(SHAPES[shape]), field = strataField(k), tmp = new THREE.Color();
  const g = facet(lathe({
    height, sx, sz, radial: Math.max(12, Math.round(22 * detail)), rings: clamp(Math.round((height / 1.05) * Math.sqrt(detail)), 10, 60), dome: 0.015,
    radius: (t, th, y) => {
      const r = radius * prof(t) * (1 + 0.17 * fbm(Math.cos(th) * 1.1 + s, y * 0.07, Math.sin(th) * 1.1, 3, s)) * (1 + 0.05 * noise3(Math.cos(th) * 6, y * 0.8, Math.sin(th) * 6, s));
      return r * (1 + 1.6 * field.bulge(Math.cos(th) * r * sx, y, Math.sin(th) * r * sz) * smoothstep(1, 0.9, t)); // ledges follow the bands
    },
  }));
  const rim = clamp(radius * 0.022, 0.06, 0.4);
  paint(g, (p, n, o, i, surf) => {
    if (n.y > 0.75 && p.y > height * 0.93) { mixc(o, pal.topDark, pal.top, 0.5 + 0.5 * noise3(p.x * 0.25, s, p.z * 0.25, s)); surf.set(0, 0, k, rim); return; }
    const shade = 0.86 + 0.14 * smoothstep(0, 0.25, p.y / height);
    o.setRGB(shade, shade, shade); surf.set(1, 1, k, rim);
  });
  return piece('mesa', { solid: [g] }, { top: { y: height, rx: radius * sx * 0.55, rz: radius * sz * 0.55 } });
}

/** Natural sandstone arch spanning `span` metres: two legs and a flat-topped bridge. */
export function arch({ seed = 1, span = 22, height = 13, thickness = 4.2, depth = 6.5, palette = 'desert' } = {}) {
  const rng = new RNG(seed), pal = STRATA[palette], s = rng.seed() % 997, k = rng.range(0, 10), S = span / 2, H = height;
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-S * 1.0, -1.5, 0), new THREE.Vector3(-S * 0.98, H * 0.5, 0), new THREE.Vector3(-S * 0.8, H * 0.92, 0),
    new THREE.Vector3(-S * 0.35, H * rng.range(1.0, 1.05), 0), new THREE.Vector3(S * 0.35, H * rng.range(1.0, 1.05), 0),
    new THREE.Vector3(S * 0.8, H * 0.92, 0), new THREE.Vector3(S * 0.98, H * 0.5, 0), new THREE.Vector3(S * 1.0, -1.5, 0),
  ], false, 'catmullrom', 0.5);
  const path = curve.getPoints(26), field = strataField(k), top = col(pal.top), rim = clamp(thickness * 0.03, 0.06, 0.3);
  const g = tube(path, (t, th) => {
    const leg = lerp(1.7, 1, smoothstep(0, 0.6, Math.sin(Math.PI * t)));
    const square = Math.pow(Math.pow(Math.abs(Math.cos(th)), 5) + Math.pow(Math.abs(Math.sin(th)), 5), -0.2); // squarer than a circle
    return (thickness / 2) * leg * square * (1 + 0.2 * noise3(t * 9 + s, Math.cos(th) * 1.8, Math.sin(th) * 1.8, s));
  }, { radial: 10, flatten: depth / thickness, capStart: true, capEnd: true });
  displace(g, (p) => { const b = 1 + 1.6 * field.bulge(p.x, p.y, p.z); p.z *= b; p.x += Math.sign(p.x) * (b - 1) * thickness * 0.5; });
  const f = facet(g);
  paint(f, (p, n, o, i, surf) => {
    if (n.y > 0.7 && p.y > H * 0.8) { o.copy(top); surf.set(0, 0, k, rim); return; }
    const shade = 0.86 + 0.14 * smoothstep(0, H * 0.3, p.y);
    o.setRGB(shade, shade, shade); surf.set(1, 1, k, rim);
  });
  return piece('arch', { solid: [f] });
}
