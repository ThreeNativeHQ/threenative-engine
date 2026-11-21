// scenes.js — three example biomes assembled from kit pieces.
// Nothing here is special: each scene is a height function, a colour function
// and a list of placements. Copy one as the starting point for your own level.
import * as THREE from 'three';
import { RNG, noise3, fbm, smoothstep, lerp, mixc, uniforms } from './core.js';
import { mountain } from './mountain.js';
import { GROUND } from './palettes.js';
import { cliff, boulder, pebbles, spires, mesa, arch } from './rocks.js';
import { pine, deadTree, roundTree, twistedTree, palm, log, stump } from './trees.js';
import { grassTuft, flowers, bush, fern, shrub, saguaro, columnCactus } from './plants.js';
import { water, waterfall } from './water.js';
import { terrain, groundPatch, cloud, scatter } from './ground.js';

const TAU = Math.PI * 2;

function samplePath(points, n) {
  const c = new THREE.CatmullRomCurve3(points.map(([x, z]) => new THREE.Vector3(x, 0, z)));
  return c.getPoints(n).map((p) => [p.x, p.z]);
}
function nearest(pts) {
  return (x, z) => { let m = 1e9; for (const [px, pz] of pts) { const d = (px - x) * (px - x) + (pz - z) * (pz - z); if (d < m) m = d; } return Math.sqrt(m); };
}

/** Groups placements per source piece so each piece becomes one instanced batch. */
class Batch {
  constructor(heightAt, rng) { this.rng = rng; this.map = new Map(); this.H = heightAt; this.taken = []; }
  add(src, x, z, { scale = 1, rot, y = null, sink = 0, tiltX = 0, tiltZ = 0 } = {}) {
    if (!this.map.has(src)) this.map.set(src, []);
    this.map.get(src).push({ x, z, y: (y ?? this.H(x, z)) - sink, rot: rot ?? this.rng.range(0, TAU), scale, tiltX, tiltZ });
  }
  /** Reserve a circle; returns false if it overlaps an earlier one. */
  claim(x, z, r) {
    for (const t of this.taken) if ((t.x - x) ** 2 + (t.z - z) ** 2 < (t.r + r) ** 2) return false;
    this.taken.push({ x, z, r }); return true;
  }
  /** Keep a camera position and its line of sight free of large pieces. */
  keepClear(from, to, r = 9) { for (let i = 0; i <= 6; i++) this.taken.push({ x: lerp(from[0], to[0], i / 9), z: lerp(from[2], to[2], i / 9), r: i ? r : r * 1.8 }); }
  build(root) { for (const [src, list] of this.map) root.add(scatter(src, list)); }
}

/** World positions on the flat top of a cliff or mesa. */
function onTop(obj, rng, n) {
  const top = obj.userData.top, th = obj.rotation.y, out = [];
  for (let i = 0; i < n; i++) {
    const a = rng.range(0, TAU), q = Math.sqrt(rng.next()), lx = Math.cos(a) * top.rx * q, lz = Math.sin(a) * top.rz * q;
    out.push({ x: obj.position.x + lx * Math.cos(th) + lz * Math.sin(th), y: obj.position.y + top.y, z: obj.position.z - lx * Math.sin(th) + lz * Math.cos(th) });
  }
  return out;
}

function ringOf(rng, root, H, { count, r0, r1, skip = () => false, make, sink = 2 }) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const a = ((i + rng.range(-0.3, 0.3)) / count) * TAU;
    if (skip(a)) continue;
    const r = rng.range(r0, r1), x = Math.cos(a) * r, z = Math.sin(a) * r, o = make(rng.seed(), a);
    o.position.set(x, H(x, z) - sink, z); o.rotation.y = a + Math.PI / 2 + rng.range(-0.35, 0.35);
    root.add(o); out.push(o);
  }
  return out;
}

function addClouds(root, rng, { count = 12, r0 = 260, r1 = 360, y0 = 70, y1 = 150 } = {}) {
  const kinds = [cloud({ seed: 1, size: 12 }), cloud({ seed: 2, size: 10 }), cloud({ seed: 5, size: 14 })], list = kinds.map(() => []);
  for (let i = 0; i < count; i++) {
    const a = ((i + rng.range(-0.4, 0.4)) / count) * TAU, r = rng.range(r0, r1);
    list[i % 3].push({ x: Math.cos(a) * r, y: rng.range(y0, y1), z: Math.sin(a) * r, rot: -a + Math.PI / 2, scale: rng.range(2.6, 4.6) });
  }
  kinds.forEach((k, i) => root.add(scatter(k, list[i])));
}

const angDist = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

// ───────────────────────────── Alpine forest ─────────────────────────────

export function forestScene({ seed = 5 } = {}) {
  const rng = new RNG(seed), root = new THREE.Group(), pal = GROUND.grass, tmp = new THREE.Color();
  const path = samplePath([[10, 66], [2, 42], [9, 22], [-3, 3], [-14, -17], [-8, -38], [3, -54]], 130), dPath = nearest(path);
  const H = (x, z) => {
    const r = Math.hypot(x, z), p = smoothstep(1.5, 8, dPath(x, z));
    return 0.9 + 1.7 * fbm(x * 0.02 + 3, 0, z * 0.02, 3, 11) + p * 0.3 * fbm(x * 0.09, 0, z * 0.09, 2, 5) + 18 * Math.pow(smoothstep(50, 125, r), 1.3);
  };
  root.add(terrain({
    size: 460, segments: 130, focus: 0.35, height: H,
    color: (x, z, y, n, o, blend) => {
      mixc(o, pal.a, pal.b, smoothstep(-0.35, 0.4, fbm(x * 0.045, 0, z * 0.045, 3, 21)));
      o.lerp(tmp.set(0x3f9a45), 0.45 * smoothstep(0.1, 0.5, fbm(x * 0.02 + 40, 0, z * 0.02, 2, 3)));
      blend.tint.set(pal.path).lerp(tmp.set(0xc4b088), 0.5 + 0.5 * noise3(x * 0.15, 0, z * 0.15, 9));
      blend.mask = 1 - smoothstep(0.5, 3.7, dPath(x, z));
    },
  }));
  const b = new Batch(H, new RNG(seed)), VIEW = { pos: [13, 11, 73], target: [-4, 8, 0] };
  b.keepClear(VIEW.pos, VIEW.target, 8);

  // Wooded cliffs frame two mountain tiers; the far range wears snow.
  const front = Math.PI / 2;
  const t1 = ringOf(rng, root, H, { count: 13, r0: 54, r1: 64, skip: (a) => angDist(a, front) < 0.5, make: (s) => cliff({ seed: s, width: rng.range(20, 30), depth: rng.range(12, 17), height: rng.range(10, 17), taper: rng.range(0.82, 0.98), steps: rng.int(1, 2), detail: 0.85 }) });
  ringOf(rng, root, H, { count: 9, r0: 82, r1: 102, sink: 4, skip: (a) => angDist(a, front) < 0.48, make: (seed) => mountain({ seed, width: rng.range(64, 91), depth: rng.range(42, 65), height: rng.range(27, 46), detail: 0.5 }) });
  ringOf(rng, root, H, { count: 8, r0: 128, r1: 153, sink: 5, make: (seed) => mountain({ seed, width: rng.range(91, 132), depth: rng.range(56, 81), height: rng.range(50, 75), palette: 'snow', detail: 0.4 }) });

  const pines = [pine({ seed: 1, height: 14 }), pine({ seed: 2, height: 11, palette: 'teal' }), pine({ seed: 3, height: 9 }), pine({ seed: 4, height: 12, palette: 'teal' }),
    pine({ seed: 6, height: 12, palette: 'olive' }), pine({ seed: 11, height: 11, density: 0.45, bare: 0.3 })];
  for (const c of t1) for (const p of onTop(c, rng, rng.int(1, 3))) b.add(rng.pick(pines), p.x, p.z, { y: p.y, sink: 0.2, scale: rng.range(0.55, 0.9) });

  // Meadow
  for (let i = 0, placed = 0; i < 900 && placed < 80; i++) {
    const a = rng.range(0, TAU), r = 52 * Math.sqrt(rng.next()), x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (dPath(x, z) < 7 || fbm(x * 0.03, 0, z * 0.03, 2, 77) < -0.12 || !b.claim(x, z, 2.6)) continue;
    b.add(rng.pick(pines), x, z, { scale: rng.range(0.7, 1.2), sink: 0.25 }); placed++;
  }
  const broad = [roundTree({ seed: 2, height: 7 }), roundTree({ seed: 5, height: 5.5, palette: 'deep' })];
  for (let i = 0, placed = 0; i < 200 && placed < 7; i++) {
    const x = rng.range(-45, 45), z = rng.range(-45, 45);
    if (dPath(x, z) < 4 || !b.claim(x, z, 3)) continue;
    b.add(rng.pick(broad), x, z, { scale: rng.range(0.9, 1.3), sink: 0.1 }); placed++;
  }
  const rocks = [boulder({ seed: 2, size: 2.4 }), boulder({ seed: 5, size: 1.6 }), boulder({ seed: 9, size: 1.1, squash: [1.2, 0.6, 0.9] })];
  for (let i = 0, placed = 0; i < 200 && placed < 20; i++) {
    const x = rng.range(-50, 50), z = rng.range(-50, 55);
    if (dPath(x, z) < 2.6 || !b.claim(x, z, 2)) continue;
    b.add(rng.pick(rocks), x, z, { scale: rng.range(0.6, 1.4) }); placed++;
  }
  const small = { bushes: [bush({ seed: 1, size: 1.2 }), bush({ seed: 4, size: 0.9, palette: 'deep' })], ferns: [fern({ seed: 1, size: 0.9 }), fern({ seed: 3, size: 0.7, palette: 'deep' })],
    stones: [pebbles({ seed: 4 }), pebbles({ seed: 7, count: 9, spread: 2.2 })], logs: [log({ seed: 1 }), log({ seed: 4, length: 2.4, radius: 0.26 })], stumps: [stump({ seed: 2 })],
    blooms: [flowers({ seed: 1 }), flowers({ seed: 2, count: 9 }), flowers({ seed: 3, color: 0xffe36b, heart: 0xf08a2b })] };
  const sprinkle = (kinds, n, { minPath = 2.4, R = 52, scale = [0.8, 1.3], nearPath = false } = {}) => {
    for (let i = 0, placed = 0; i < n * 12 && placed < n; i++) {
      const a = rng.range(0, TAU), r = R * Math.sqrt(rng.next()), x = Math.cos(a) * r, z = Math.sin(a) * r, d = dPath(x, z);
      if (d < minPath || (nearPath && d > 9)) continue;
      b.add(rng.pick(kinds), x, z, { scale: rng.range(...scale) }); placed++;
    }
  };
  sprinkle(small.bushes, 44); sprinkle(small.ferns, 70); sprinkle(small.stones, 26, { minPath: 1.6 }); sprinkle(small.logs, 7, { minPath: 3.5 }); sprinkle(small.stumps, 6);
  sprinkle(small.blooms, 90, { nearPath: true, minPath: 2.2 }); sprinkle(small.blooms, 60);
  const tufts = [grassTuft({ seed: 1 }), grassTuft({ seed: 2, height: 0.75, blades: 12, spread: 0.36 }), grassTuft({ seed: 3, height: 0.4, blades: 9 })];
  for (let i = 0; i < 11000; i++) {
    const a = rng.range(0, TAU), r = 60 * Math.pow(rng.next(), 0.62), x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (dPath(x, z) < 2.1) continue;
    b.add(tufts[i % 3], x, z, { scale: rng.range(0.6, 1.25) });
  }
  b.build(root); addClouds(root, rng);
  return {
    group: root,
    view: VIEW,
    env: { skyTop: 0x2a7de6, horizon: 0xbfe4ff, fog: [0xbfe1ff, 80, 380], sun: { dir: [-0.6, 0.72, 0.42], color: 0xfff1d6, intensity: 3.1 }, hemi: { sky: 0xcfe5ff, ground: 0x5d7fb0, intensity: 1.7 }, shadow: 85 },
  };
}

// ───────────────────────────── Snow peaks ─────────────────────────────

function snowfall(count = 2600, area = 150, height = 60) {
  const g = new THREE.BufferGeometry(), P = new Float32Array(count * 3), rng = new RNG(99);
  for (let i = 0; i < count; i++) P.set([rng.range(-area, area), rng.range(0, height), rng.range(-area, area)], i * 3);
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  const m = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, uniforms: { uTime: uniforms.uTime, uHeight: { value: height } },
    vertexShader: `uniform float uTime, uHeight; void main(){ vec3 p = position; float k = fract(position.x * 0.37);
      p.y = mod(position.y - uTime * (2.2 + k * 1.8), uHeight); p.x += sin(uTime * 0.7 + position.z) * 0.9; p.z += cos(uTime * 0.5 + position.x) * 0.9;
      vec4 mv = modelViewMatrix * vec4(p, 1.0); gl_PointSize = (1.6 + k * 1.6) * 110.0 / -mv.z; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: 'void main(){ float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard; gl_FragColor = vec4(1.0, 1.0, 1.0, 0.9 * (1.0 - smoothstep(0.2, 0.5, d))); }',
  });
  const pts = new THREE.Points(g, m); pts.frustumCulled = false; pts.name = 'snowfall'; pts.renderOrder = 5;
  return pts;
}

export function snowScene({ seed = 9 } = {}) {
  const rng = new RNG(seed), root = new THREE.Group(), pal = GROUND.snow, tmp = new THREE.Color();
  const lake = [-9, 10], dLake = (x, z) => Math.hypot(x - lake[0], (z - lake[1]) * 1.25) + 3 * noise3(x * 0.07, 0, z * 0.07, 4);
  const H = (x, z) => {
    const r = Math.hypot(x, z);
    const land = Math.max(0.45, 1.5 + 2.0 * fbm(x * 0.022 + 9, 0, z * 0.022, 3, 41)) + 0.25 * fbm(x * 0.1, 0, z * 0.1, 2, 6) + 18 * Math.pow(smoothstep(50, 125, r), 1.3);
    return land - 4.4 * smoothstep(20, 9, dLake(x, z));
  };
  root.add(terrain({
    size: 460, segments: 130, focus: 0.35, height: H,
    color: (x, z, y, n, o) => {
      mixc(o, pal.a, pal.b, smoothstep(-0.3, 0.35, fbm(x * 0.05, 0, z * 0.05, 3, 13)) * smoothstep(0.82, 0.98, n.y));
      o.lerp(tmp.set(0xb4cdf0), smoothstep(1.2, -0.6, y) * 0.8);
    },
  }));
  root.add(water({ width: 64, length: 64, segments: 72, x: lake[0], z: lake[1], palette: 'ice', depth: (x, z) => -H(x, z), depthRange: 2.4 }));
  const b = new Batch(H, new RNG(seed)), front = Math.PI / 2, dry = (x, z) => dLake(x, z) > 22, VIEW = { pos: [17, 10, 70], target: [-8, 5, 0] };
  b.keepClear(VIEW.pos, VIEW.target, 8);

  const range = (w, d, h, detail) => (seed) => mountain({ seed, width: rng.range(...w), depth: rng.range(...d), height: rng.range(...h), palette: 'snow', detail });
  ringOf(rng, root, H, { count: 10, r0: 57, r1: 74, sink: 3, skip: (a) => angDist(a, front) < 0.57, make: range([36, 52], [27, 40], [13, 26], 0.65) });
  ringOf(rng, root, H, { count: 9, r0: 90, r1: 106, sink: 5, skip: (a) => angDist(a, front) < 0.46, make: range([61, 87], [41, 60], [29, 51], 0.55) });
  ringOf(rng, root, H, { count: 8, r0: 133, r1: 155, sink: 7, make: range([94, 135], [65, 88], [55, 81], 0.45) });
  for (let i = 0; i < 9; i++) {
    const a = rng.range(0, TAU), r = rng.range(30, 50), x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (!dry(x, z) || angDist(a, front) < 0.35 || !b.claim(x, z, 6)) continue;
    const s = spires({ seed: rng.seed(), height: rng.range(10, 22), count: rng.int(3, 5), radius: rng.range(1.8, 2.8) });
    s.position.set(x, H(x, z) - 1, z); s.rotation.y = rng.range(0, TAU); root.add(s);
  }

  const pines = [pine({ seed: 31, height: 13, palette: 'snow' }), pine({ seed: 32, height: 9, palette: 'snow' }), pine({ seed: 33, height: 5, palette: 'snow' }), pine({ seed: 35, height: 10, palette: 'snow', density: 0.5, bare: 0.3 })];
  const place = (kinds, n, { R = 52, r = 2.2, scale = [0.8, 1.3], sink = 0.15, gap = 22 } = {}) => {
    for (let i = 0, placed = 0; i < n * 14 && placed < n; i++) {
      const a = rng.range(0, TAU), q = R * Math.sqrt(rng.next()), x = Math.cos(a) * q, z = Math.sin(a) * q;
      if (dLake(x, z) < gap || (r && !b.claim(x, z, r))) continue;
      b.add(rng.pick(kinds), x, z, { scale: rng.range(...scale), sink }); placed++;
    }
  };
  place(pines, 70, { sink: 0.25 });
  place([roundTree({ seed: 41, height: 7, palette: 'frost', bark: 'dark' }), roundTree({ seed: 44, height: 5, palette: 'frost', bark: 'dark' }), roundTree({ seed: 47, height: 6, palette: 'frost', bark: 'dark' })], 24, { r: 2.6 });
  place([deadTree({ seed: 9, height: 6, snow: true }), deadTree({ seed: 12, height: 4.5, snow: true })], 9);
  place([boulder({ seed: 3, size: 2.4, palette: 'snow', snowy: true }), boulder({ seed: 6, size: 1.5, palette: 'snow', snowy: true }), boulder({ seed: 8, size: 1.1, palette: 'alpine', snowy: true })], 22, { r: 2, gap: 20, scale: [0.6, 1.5] });
  place([groundPatch({ seed: 4, radius: 6, palette: 'snow', bump: 1.3 }), groundPatch({ seed: 8, radius: 4.5, palette: 'snow', bump: 1.0 })], 14, { r: 0, gap: 26, sink: 0.25 });
  place([bush({ seed: 7, palette: 'frost' }), bush({ seed: 9, size: 0.7, palette: 'frost' })], 40, { r: 0 });
  place([pebbles({ seed: 5, palette: 'snow', snowy: true, size: 0.45 })], 18, { r: 0, gap: 19 });
  place([log({ seed: 6, snow: true, bark: 'grey' }), stump({ seed: 3, snow: true, bark: 'grey' })], 9, { r: 0 });
  const tufts = [grassTuft({ seed: 5, palette: 'frost', height: 0.45 }), grassTuft({ seed: 6, palette: 'frost', height: 0.3, blades: 7 })];
  for (let i = 0; i < 2600; i++) {
    const a = rng.range(0, TAU), q = 56 * Math.sqrt(rng.next()), x = Math.cos(a) * q, z = Math.sin(a) * q;
    if (dLake(x, z) < 20.5 || fbm(x * 0.06, 0, z * 0.06, 2, 5) < 0) continue;
    b.add(tufts[i % 2], x, z, { scale: rng.range(0.6, 1.1) });
  }
  b.build(root); addClouds(root, rng, { count: 10 }); root.add(snowfall());
  return {
    group: root,
    view: VIEW,
    env: { skyTop: 0x3a8be8, horizon: 0xe2f1ff, fog: [0xdcecff, 70, 340], sun: { dir: [0.55, 0.7, 0.45], color: 0xfff6ea, intensity: 2.7 }, hemi: { sky: 0xdcecff, ground: 0x7d9fd8, intensity: 2.0 }, shadow: 85 },
  };
}

// ───────────────────────────── Desert canyon ─────────────────────────────

export function desertScene({ seed = 4 } = {}) {
  const rng = new RNG(seed), root = new THREE.Group(), pal = GROUND.sand, tmp = new THREE.Color();
  const river = samplePath([[18, 82], [9, 48], [-4, 24], [2, 3], [8, -16], [5, -34]], 110), dRiver = nearest(river);
  const isle = [1, 4], dIsle = (x, z) => Math.hypot(x - isle[0], z - isle[1]), LIP = -34.4, UPPER = 7.3;
  const dunes = (x, z) => 1.3 + 2.4 * Math.abs(fbm(x * 0.022 + 7, 0, z * 0.022, 3, 31)) + 0.22 * fbm(x * 0.12, 0, z * 0.12, 2, 8) + 12 * Math.pow(smoothstep(55, 125, Math.hypot(x, z)), 1.2);
  const H = (x, z) => {
    const land = dunes(x, z);
    const d = dRiver(x, z) - 9 * smoothstep(21, 3, dIsle(x, z)) + 1.3 * noise3(x * 0.11, 0, z * 0.11, 3);
    let h = lerp(-2.4, land, smoothstep(2.5, 9.5, d));
    h = Math.max(h, lerp(-9, 1.2 + 0.25 * fbm(x * 0.2, 0, z * 0.2, 2, 2), smoothstep(9, 4.5, dIsle(x, z))));
    const back = smoothstep(LIP + 2.4, LIP - 2.6, z);
    if (back > 0) {
      const d2 = Math.abs(x - 5 - 1.5 * Math.sin(z * 0.08));
      h = lerp(h, lerp(UPPER - 1.3, 8.2 + land * 0.8, smoothstep(2.6, 7, d2)), back);
    }
    return h;
  };
  root.add(terrain({
    size: 460, segments: 130, focus: 0.35, height: H,
    color: (x, z, y, n, o, blend) => {
      mixc(o, pal.a, pal.b, smoothstep(-0.4, 0.4, fbm(x * 0.04, 0, z * 0.04, 3, 5)));
      o.lerp(tmp.set(pal.path), 0.55 * smoothstep(0.92, 0.7, n.y));
      if (z > LIP - 3) o.lerp(tmp.set(pal.wet), smoothstep(0.8, 0.0, y) * 0.75);
      const lawn = smoothstep(9.5, 4.5, dIsle(x, z)) * smoothstep(0.1, 0.8, y);
      const banks = smoothstep(-0.1, 0.5, fbm(x * 0.05 + 20, 0, z * 0.05, 2, 9)) * smoothstep(0.2, 1.1, y) * smoothstep(3.2, 1.6, y) * smoothstep(38, 22, dRiver(x, z));
      mixc(blend.tint, 0x6fbd3f, 0x9bd64a, 0.5 + 0.5 * noise3(x * 0.2, 0, z * 0.2, 7));
      blend.mask = Math.max(lawn, banks);
    },
  }));
  root.add(water({ width: 150, length: 190, segments: 120, x: 4, z: 32, palette: 'river', depth: (x, z) => (z < LIP - 0.4 ? -1 : -H(x, z)), depthRange: 3.2 }));
  root.add(water({ width: 26, length: 70, segments: 26, x: 5, y: UPPER, z: LIP - 35, palette: 'river', depth: (x, z) => UPPER - H(x, Math.min(z, LIP - 2.6)), depthRange: 1.4 }));
  const fall = waterfall({ seed: 3, width: 6.4, height: UPPER, throwDist: 1.6 }); fall.position.set(5, 0, LIP + 1.6); root.add(fall);

  const b = new Batch(H, new RNG(seed)), front = Math.PI / 2, VIEW = { pos: [7, 8.5, 56], target: [3, 4, -12] };
  b.keepClear(VIEW.pos, VIEW.target, 7);
  const formation = (shapes, h, r, sx = [1, 1.6], detail = 1) => (s) => mesa({ seed: s, shape: rng.pick(shapes), height: rng.range(...h), radius: rng.range(...r), sx: rng.range(...sx), sz: rng.range(0.9, 1.2), detail });
  // Walls and mesas frame the falls; sandstone ridges sit behind them.
  for (const [x, z, sx, h] of [[-9, -41, 1.5, 17], [20, -41, 1.6, 19], [-27, -44, 1.3, 15], [37, -45, 1.2, 17]]) {
    const m = mesa({ seed: rng.seed(), shape: 'block', height: h, radius: 7.5, sx, sz: 1.1 }); m.position.set(x, H(x, z) - 9, z); m.rotation.y = rng.range(-0.2, 0.2); root.add(m); b.claim(x, z, 9);
  }
  const span = arch({ seed: 7, span: 38, height: 24, thickness: 6, depth: 9 }); span.position.set(5, H(5, -60) + 1, -60); root.add(span);
  const r1 = ringOf(rng, root, H, { count: 15, r0: 62, r1: 78, sink: 3, skip: (a) => angDist(a, front) < 0.42 || angDist(a, -front) < 0.3, make: formation(['pillar', 'block', 'butte', 'pillar'], [20, 36], [8, 12], [1, 1.6], 0.8) });
  ringOf(rng, root, H, { count: 9, r0: 109, r1: 138, sink: 6, make: (seed) => mountain({ seed, width: rng.range(77, 117), depth: rng.range(42, 64), height: rng.range(34, 57), palette: 'desert', detail: 0.45 }) });
  const mid = [];
  for (let i = 0; i < 60 && mid.length < 9; i++) {
    const a = rng.range(0, TAU), r = rng.range(26, 52), x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (dRiver(x, z) < 15 || dIsle(x, z) < 24 || z < LIP + 6 || angDist(a, front) < 0.3 || !b.claim(x, z, 8)) continue;
    const m = mesa({ seed: rng.seed(), shape: rng.pick(['shelf', 'hoodoo', 'shelf', 'pillar']), height: rng.range(7, 15), radius: rng.range(3, 6), sx: rng.range(1, 1.4) });
    m.position.set(x, H(x, z) - 1.5, z); m.rotation.y = rng.range(0, TAU); root.add(m); mid.push(m);
  }

  const palms = [palm({ seed: 1, height: 9 }), palm({ seed: 3, height: 6.5, lean: 0.3 }), palm({ seed: 5, height: 4, lean: 0.14, coconuts: false }), palm({ seed: 8, height: 7.5, lean: 0.18 })];
  const cacti = [saguaro({ seed: 1, height: 5.5, arms: 2 }), saguaro({ seed: 4, height: 4, arms: 3 }), saguaro({ seed: 6, height: 2.8, arms: 1 })];
  const columns = [columnCactus({ seed: 2, count: 5, height: 3.6 }), columnCactus({ seed: 5, count: 3, height: 2.4 })];
  const gnarled = [twistedTree({ seed: 2, height: 4.5 }), twistedTree({ seed: 6, height: 3.4 })];
  for (const m of [...r1, ...mid]) for (const p of onTop(m, rng, rng.int(0, 3))) b.add(rng.pick([...cacti, ...gnarled, palms[2], palms[1]]), p.x, p.z, { y: p.y, sink: 0.15, scale: rng.range(0.8, 1.3) });
  for (const [dx, dz, k] of [[0, 0, 0], [-2.6, 1.6, 1], [2.2, -2.2, 2], [1.5, 2.8, 2]]) b.add(palms[k], isle[0] + dx, isle[1] + dz, { sink: 0.2, scale: rng.range(0.85, 1.05) });

  const where = (test, n, fn, tries = 30) => { for (let i = 0, placed = 0; i < n * tries && placed < n; i++) { const a = rng.range(0, TAU), q = 56 * Math.sqrt(rng.next()), x = Math.cos(a) * q, z = Math.sin(a) * q; if (z < LIP + 3 || !test(x, z, H(x, z))) continue; fn(x, z); placed++; } };
  const bank = (x, z, y) => y > 0.45 && y < 2.2 && dRiver(x, z) < 30, sand = (x, z, y) => y > 1.4 && dIsle(x, z) > 12;
  where((x, z, y) => bank(x, z, y) && b.claim(x, z, 2.4), 16, (x, z) => b.add(rng.pick(palms), x, z, { sink: 0.2, scale: rng.range(0.8, 1.15) }));
  where((x, z, y) => sand(x, z, y) && y > 2 && b.claim(x, z, 2), 18, (x, z) => b.add(rng.pick(cacti), x, z, { scale: rng.range(0.8, 1.3) }));
  where((x, z, y) => sand(x, z, y) && b.claim(x, z, 2), 12, (x, z) => b.add(rng.pick(columns), x, z, { scale: rng.range(0.8, 1.3) }));
  where((x, z, y) => sand(x, z, y) && b.claim(x, z, 2.5), 5, (x, z) => b.add(rng.pick(gnarled), x, z, { scale: rng.range(0.9, 1.3) }));
  const leafy = [fern({ seed: 4, size: 1.1, palette: 'palm', serr: 0, wide: 0.3, fronds: 8 }), fern({ seed: 7, size: 0.8, palette: 'desert', serr: 0, wide: 0.3, fronds: 7 }), bush({ seed: 3, size: 0.8, palette: 'green' })];
  where(bank, 70, (x, z) => b.add(rng.pick(leafy), x, z, { scale: rng.range(0.8, 1.5) }));
  where((x, z, y) => dIsle(x, z) < 6.5 && y > 0.6, 14, (x, z) => b.add(rng.pick(leafy), x, z, { scale: rng.range(0.7, 1.2) }), 200);
  const scrub = [shrub({ seed: 1 }), shrub({ seed: 3, size: 0.6 }), bush({ seed: 6, size: 0.7, palette: 'desert' })];
  where(sand, 90, (x, z) => b.add(rng.pick(scrub), x, z, { scale: rng.range(0.7, 1.4) }));
  const stones = [boulder({ seed: 2, size: 2, palette: 'desert', squash: [1.2, 0.6, 1] }), boulder({ seed: 6, size: 1.2, palette: 'desert' }), pebbles({ seed: 3, palette: 'desert' }), pebbles({ seed: 8, palette: 'desert', count: 8, spread: 2 })];
  where((x, z, y) => y > 0.2, 46, (x, z) => b.add(rng.pick(stones), x, z, { scale: rng.range(0.6, 1.4) }));
  const dry = [grassTuft({ seed: 3, palette: 'dry', height: 0.45 }), grassTuft({ seed: 4, palette: 'dry', height: 0.3, blades: 7 })], green = [grassTuft({ seed: 1 }), grassTuft({ seed: 3, height: 0.4, blades: 9 })];
  where((x, z, y) => sand(x, z, y) && fbm(x * 0.05, 0, z * 0.05, 2, 12) > -0.05, 2600, (x, z) => b.add(rng.pick(dry), x, z, { scale: rng.range(0.6, 1.1) }), 6);
  where((x, z, y) => (dIsle(x, z) < 7 && y > 0.5) || (bank(x, z, y) && y > 0.7 && fbm(x * 0.05 + 20, 0, z * 0.05, 2, 9) > 0.22), 1300, (x, z) => b.add(rng.pick(green), x, z, { scale: rng.range(0.6, 1.1) }), 40);
  b.build(root); addClouds(root, rng, { count: 11 });
  return {
    group: root,
    view: VIEW,
    env: { skyTop: 0x2488ea, horizon: 0xd9ecff, fog: [0xe6cfd0, 90, 420], sun: { dir: [-0.5, 0.74, 0.45], color: 0xffedd0, intensity: 3.2 }, hemi: { sky: 0xd4e6ff, ground: 0xa97c92, intensity: 1.7 }, shadow: 85 },
  };
}

export const SCENES = { forest: forestScene, snow: snowScene, desert: desertScene };
