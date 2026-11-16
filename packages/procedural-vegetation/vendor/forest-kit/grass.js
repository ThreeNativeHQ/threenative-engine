import { GeoBuilder, lin } from './GeoBuilder.js';
import { mulberry32, range } from './random.js';
import { addBlade, addStem, addSpindle, addTube } from './primitives.js';

/** root → mid → tip colour ramps (sRGB hex in, linear out). */
export const GRASS = {
  lush: { root: lin('#111c08'), mid: lin('#3b6220'), tip: lin('#7a9f3c') },
  meadow: { root: lin('#15210a'), mid: lin('#4a7224'), tip: lin('#91ab48') },
  deep: { root: lin('#0c1506'), mid: lin('#284816'), tip: lin('#4d7529') },
  sedge: { root: lin('#141f09'), mid: lin('#466d24'), tip: lin('#9db050') },
  reed: { root: lin('#2a3312'), mid: lin('#4b8026'), tip: lin('#83ad42') },
  straw: { root: lin('#2c2613'), mid: lin('#786d3e'), tip: lin('#b5a569') },
};

/**
 * A clump of blades. Returns a GeoBuilder so clumps can be composed.
 * Ranges are [min, max]; `outward` is how strongly blades lean away from the centre.
 */
export function grassClump(o = {}) {
  const {
    seed = 1, blades = 10, radius = 0.1, height = [0.25, 0.5], width = [0.012, 0.02], lean = [0.15, 0.6],
    curve = [1.6, 2.6], droop = [0, 0.12], segs = 3, pal = GRASS.meadow, outward = 0.7, flex = 1, twist = 0.7,
    bright = [0.72, 1.18], upBias = 0.5, dryTips = 0.2,
  } = o;
  const rand = mulberry32(seed), b = new GeoBuilder();
  for (let i = 0; i < blades; i++) {
    const a = rand() * Math.PI * 2, r = radius * Math.sqrt(rand());
    const yaw = rand() < outward ? a + range(rand, -0.7, 0.7) : rand() * Math.PI * 2;
    addBlade(b, {
      x: Math.cos(a) * r, z: Math.sin(a) * r, yaw,
      height: range(rand, height[0], height[1]) * (1 - 0.25 * (r / (radius || 1)) * rand()),
      width: range(rand, width[0], width[1]), lean: range(rand, lean[0], lean[1]),
      curve: range(rand, curve[0], curve[1]), droop: range(rand, droop[0], droop[1]),
      twist: range(rand, -twist, twist), segs, pal, flex, bright: range(rand, bright[0], bright[1]), upBias,
      dryTip: rand() < dryTips ? GRASS.straw.tip : null,
    });
  }
  return b;
}

/**
 * Three LODs of the same clump: full → half the blades, wider → a few very
 * wide single-segment blades. Wider blades keep the far field looking filled
 * after the scatter system has thinned the instances.
 */
export function grassLods(o) {
  const blades = o.blades ?? 10, width = o.width ?? [0.012, 0.02], segs = o.segs ?? 3;
  return [
    grassClump(o).build(),
    grassClump({ ...o, blades: Math.max(3, Math.round(blades * 0.55)), width: [width[0] * 1.6, width[1] * 1.6], segs: Math.max(2, segs - 1) }).build(),
    grassClump({ ...o, blades: Math.max(2, Math.round(blades * 0.34)), width: [width[0] * 2.7, width[1] * 2.7], segs: 1 }).build(),
  ];
}

/** Loose seed head: a few tiny spikelets up the last stretch of a stem. */
function addPanicle(b, base, dir, length, col, wind, lod) {
  if (lod === 2) return;
  if (lod === 1) return addSpindle(b, base, dir, length, length * 0.16, col, col, wind);
  const n = 6, light = [col[0] * 1.2, col[1] * 1.15, col[2] * 1.05];
  addStem(b, base, [base[0] + dir[0] * length, base[1] + dir[1] * length, base[2] + dir[2] * length], 0.0035, col, col, wind, wind);
  for (let k = 0; k < n; k++) {
    const u = (k + 0.5) / n, a = k * 2.4, out = 0.55 - u * 0.3;
    const sx = Math.cos(a) * out + dir[0], sy = dir[1] * (0.8 + u * 0.4), sz = Math.sin(a) * out + dir[2], sl = Math.hypot(sx, sy, sz);
    const size = length * (0.34 - u * 0.12);
    addSpindle(b, [base[0] + dir[0] * length * u, base[1] + dir[1] * length * u, base[2] + dir[2] * length * u], [sx / sl, sy / sl, sz / sl], size, size * 0.3, col, light, wind);
  }
}

/** Tall flowering grass: a clump plus seed stems with loose panicles. */
export function seedGrass(o = {}) {
  const { seed = 1, stems = 4, stemHeight = [0.7, 1.15], head = [0.08, 0.15], headCol = lin('#9c8a55'), lod = 0, ...clump } = o;
  const b = lod < 2 ? grassClump({ seed, blades: lod ? 4 : 7, height: [0.35, 0.7], width: lod ? [0.018, 0.028] : [0.009, 0.015], lean: [0.2, 0.7], pal: GRASS.meadow, segs: lod ? 2 : 3, ...clump }) : new GeoBuilder();
  const rand = mulberry32(seed * 7 + 3), stemCol = lin('#5f7a33'), n = lod === 2 ? Math.max(2, stems >> 1) : stems;
  for (let i = 0; i < n; i++) {
    const a = rand() * 6.283, r = rand() * 0.06, h = range(rand, stemHeight[0], stemHeight[1]);
    const lx = Math.cos(a) * h * range(rand, 0.05, 0.22), lz = Math.sin(a) * h * range(rand, 0.05, 0.22);
    const p0 = [Math.cos(a) * r, 0, Math.sin(a) * r], p1 = [p0[0] + lx * 0.45, h * 0.55, p0[2] + lz * 0.45], p2 = [p0[0] + lx, h, p0[2] + lz];
    const w = [0.0045, 0.008, 0.016][lod], flex = 0.75;
    addStem(b, p0, p1, w, stemCol, stemCol, 0, h * 0.35 * flex);
    addStem(b, p1, p2, w * 0.8, stemCol, lod === 2 ? headCol : stemCol, h * 0.35 * flex, h * flex);
    const dl = Math.hypot(lx * 0.55, h * 0.45, lz * 0.55), dir = [(lx * 0.55) / dl, (h * 0.45) / dl, (lz * 0.55) / dl];
    addPanicle(b, p2, dir, range(rand, head[0], head[1]), headCol, h * flex * 1.1, lod);
  }
  return b;
}

/** Sedge tussock: a dense fountain of thin arching blades. */
export function tussock(o = {}) {
  const { seed = 1, lod = 0, pal = GRASS.sedge } = o;
  const cfg = [
    { blades: 64, width: [0.008, 0.014], segs: 4 },
    { blades: 30, width: [0.015, 0.024], segs: 3 },
    { blades: 13, width: [0.03, 0.045], segs: 2 },
  ][lod];
  return grassClump({ seed, radius: 0.16, height: [0.45, 0.95], lean: [0.45, 1.2], curve: [1.7, 2.4], droop: [0.12, 0.4], outward: 0.95, pal, flex: 0.8, ...cfg });
}

/** Reed stand: tall, stiff sword leaves with a few dead ones folded over. `cattails` adds brown seed spikes. */
export function reedClump(o = {}) {
  const { seed = 1, lod = 0, cattails = 0, pal = GRASS.reed } = o;
  const cfg = [
    { blades: 12, width: [0.014, 0.024], segs: 5 },
    { blades: 7, width: [0.024, 0.036], segs: 3 },
    { blades: 4, width: [0.045, 0.065], segs: 2 },
  ][lod];
  const b = grassClump({ seed, radius: 0.11, height: [1.2, 2.3], lean: [0.03, 0.28], curve: [2, 3.4], droop: [0, 0.16], outward: 0.6, pal, flex: 0.45, twist: 1.1, upBias: 0.3, dryTips: 0.55, bright: [0.6, 1.15], ...cfg });
  if (lod < 2) b.append(grassClump({ seed: seed + 5, blades: lod ? 2 : 4, radius: 0.12, height: [0.5, 1.2], width: [cfg.width[0], cfg.width[1]], lean: [0.8, 1.4], curve: [1.4, 2], droop: [0.3, 0.55], outward: 1, pal: GRASS.straw, flex: 0.3, segs: lod ? 2 : 4, upBias: 0.4 }));
  const rand = mulberry32(seed * 13 + 1), brown = lin('#4a2f1b'), stem = lin('#6b8a35');
  for (let i = 0; i < cattails; i++) {
    const a = rand() * 6.283, r = 0.03 + rand() * 0.07, h = range(rand, 1.4, 2.0), x = Math.cos(a) * r, z = Math.sin(a) * r;
    const lx = range(rand, -0.08, 0.08), lz = range(rand, -0.08, 0.08), flex = 0.35;
    addStem(b, [x, 0, z], [x + lx, h, z + lz], lod ? 0.014 : 0.008, stem, stem, 0, h * flex);
    const pts = [0, 0.03, 0.14, 0.17].map((t, k) => ({ x: x + lx, y: h + t, z: z + lz, r: [0.004, 0.013, 0.013, 0.003][k] }));
    addTube(b, pts, lod ? 4 : 6, { color: brown, windAt: () => h * flex });
    addStem(b, [x + lx, h + 0.17, z + lz], [x + lx, h + 0.3, z + lz], 0.004, stem, stem, h * flex, h * flex);
  }
  return b;
}
