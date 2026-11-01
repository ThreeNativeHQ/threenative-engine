// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// The painted battlefield: one texture over the whole 224 m map, drawn once at boot on the CPU so it
// runs where there is no DOM canvas (the desktop and phone hosts). Noise ground, dirt roads with two
// wheel ruts, damp shorelines, a tiled apron under every base, an expansion ring on every free ore
// site and a scatter of fissures. Change a colour, a width or a road here; nothing else reads it.
import { DataTexture, LinearMipmapLinearFilter, RepeatWrapping, SRGBColorSpace } from "three";
import { HALF, POOLS, RESOURCE_SITES, STARTS, WORLD, terrainNoise } from "../sim/terrain.js";
import { seeded } from "../sim/types.js";

/** Dirt roads between the bases, as world `[x, z]` polylines. Art only: units do not prefer them. */
export const ROAD_PATHS: readonly (readonly (readonly [number, number])[])[] = [
  [
    [-58, 55],
    [-46, 42],
    [-37, 26],
    [-22, 17],
    [-9, 27],
    [19, 43],
    [38, 56],
    [69, 67],
  ],
  [
    [-70, 44],
    [-70, 22],
    [-60, 15],
    [-56, -8],
    [-55, -31],
    [-62, -53],
    [-70, -72],
  ],
  [
    [-70, -72],
    [-53, -63],
    [-38, -42],
    [-30, -20],
    [7, -20],
    [31, -31],
    [45, -42],
    [59, -53],
    [70, -68],
  ],
  [
    [-9, 27],
    [-8, 1],
    [-11, -6],
    [-12, -20],
  ],
  [
    [69, 67],
    [78, 46],
    [82, 27],
    [85, 0],
    [75, -19],
    [70, -42],
    [70, -68],
  ],
];

/** The base apron a start stands on, in world metres. Grass and rubble stay off it. */
export function padAt(x: number, z: number): boolean {
  return STARTS.some((s) => Math.abs(x - s.x) < 24 && Math.abs(z - s.z) < 23);
}

export function segmentDistance(
  x: number,
  z: number,
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const q = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(x - a[0] - dx * q, z - a[1] - dz * q);
}

/** RGBA, straight alpha, 0-255 colour and 0-1 alpha. */
type Paint = readonly [number, number, number, number];

/** Texels across the map: 2048 is 11 cm a texel, fine enough for a rivet at tactical zoom. */
const SIZE = 2048;
const SCALE = SIZE / WORLD;
const px = (metres: number): number => (metres + HALF) * SCALE;

/** A painter over the texture's own RGBA bytes: every stroke is source-over in sRGB, like a 2D canvas. */
class Canvas {
  readonly rgba = new Uint8ClampedArray(SIZE * SIZE * 4);
  /** Per-texel distance to the road being stroked, reset only where a road touched it. */
  readonly #distance = new Float32Array(SIZE * SIZE).fill(Number.POSITIVE_INFINITY);

  blend(index: number, c: Paint, coverage = 1): void {
    const a = c[3] * coverage;
    if (a <= 0) return;
    const rgba = this.rgba;
    const k = index * 4;
    rgba[k] = (rgba[k] ?? 0) + (c[0] - (rgba[k] ?? 0)) * a;
    rgba[k + 1] = (rgba[k + 1] ?? 0) + (c[1] - (rgba[k + 1] ?? 0)) * a;
    rgba[k + 2] = (rgba[k + 2] ?? 0) + (c[2] - (rgba[k + 2] ?? 0)) * a;
  }

  /** Visit every texel centre inside a pixel-space box, clamped to the map. */
  each(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    visit: (x: number, y: number, i: number) => void,
  ): void {
    const ax = Math.max(0, Math.floor(x0));
    const ay = Math.max(0, Math.floor(y0));
    const bx = Math.min(SIZE - 1, Math.ceil(x1));
    const by = Math.min(SIZE - 1, Math.ceil(y1));
    for (let y = ay; y <= by; y++)
      for (let x = ax; x <= bx; x++) visit(x + 0.5, y + 0.5, y * SIZE + x);
  }

  /**
   * One road: each stroke `[width, paint]` drawn over the whole polyline as one path, with round
   * joins and caps. Distances are measured once, only near each segment, then every stroke reads them.
   */
  road(
    points: readonly (readonly [number, number])[],
    strokes: readonly (readonly [number, Paint])[],
  ): void {
    const reach = Math.max(...strokes.map(([width]) => width)) / 2 + 1;
    const distance = this.#distance;
    const touched: number[] = [];
    for (let s = 1; s < points.length; s++) {
      const a = points[s - 1];
      const b = points[s];
      if (a === undefined || b === undefined) continue;
      this.each(
        Math.min(a[0], b[0]) - reach,
        Math.min(a[1], b[1]) - reach,
        Math.max(a[0], b[0]) + reach,
        Math.max(a[1], b[1]) + reach,
        (x, y, i) => {
          const d = segmentDistance(x, y, a, b);
          if (d >= reach) return;
          const was = distance[i] ?? Number.POSITIVE_INFINITY;
          if (was === Number.POSITIVE_INFINITY) touched.push(i);
          if (d < was) distance[i] = d;
        },
      );
    }
    for (const [width, paint] of strokes)
      for (const i of touched)
        this.blend(i, paint, Math.max(0, Math.min(1, width / 2 - (distance[i] ?? 0) + 0.5)));
    for (const i of touched) distance[i] = Number.POSITIVE_INFINITY;
  }

  /** A short polyline stroked at `width` pixels; fine for a few small marks. */
  polyline(points: readonly (readonly [number, number])[], width: number, c: Paint): void {
    this.road(points, [[width, c]]);
  }

  /** A straight dashed line, the dash restarting at `a` the way a canvas `moveTo` restarts it. */
  dashed(
    a: readonly [number, number],
    b: readonly [number, number],
    width: number,
    on: number,
    off: number,
    c: Paint,
  ): void {
    const half = width / 2;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    this.each(
      Math.min(a[0], b[0]) - half - 1,
      Math.min(a[1], b[1]) - half - 1,
      Math.max(a[0], b[0]) + half + 1,
      Math.max(a[1], b[1]) + half + 1,
      (x, y, i) => {
        const t = ((x - a[0]) * dx + (y - a[1]) * dy) / length;
        if (t < 0 || t > length || t % (on + off) > on) return;
        this.blend(i, c, Math.max(0, Math.min(1, half - segmentDistance(x, y, a, b) + 0.5)));
      },
    );
  }

  /** A dashed ring of `radius` pixels: the dash follows the arc length. */
  dashedRing(
    cx: number,
    cy: number,
    radius: number,
    width: number,
    on: number,
    off: number,
    c: Paint,
  ): void {
    const half = width / 2;
    this.each(
      cx - radius - half - 1,
      cy - radius - half - 1,
      cx + radius + half + 1,
      cy + radius + half + 1,
      (x, y, i) => {
        const d = Math.hypot(x - cx, y - cy);
        const arc = (Math.atan2(y - cy, x - cx) + Math.PI) * radius;
        if (arc % (on + off) > on) return;
        this.blend(i, c, Math.max(0, Math.min(1, half - Math.abs(d - radius) + 0.5)));
      },
    );
  }

  disc(cx: number, cy: number, radius: number, c: Paint): void {
    this.each(cx - radius - 1, cy - radius - 1, cx + radius + 1, cy + radius + 1, (x, y, i) => {
      this.blend(i, c, Math.max(0, Math.min(1, radius - Math.hypot(x - cx, y - cy) + 0.5)));
    });
  }
}

/** Linear stops of a canvas gradient: `[offset, r, g, b, a]`. */
function gradient(
  stops: readonly (readonly [number, number, number, number, number])[],
  t: number,
): Paint {
  let previous = stops[0];
  if (previous === undefined) throw new Error("A gradient needs at least one stop.");
  for (const stop of stops) {
    if (t <= stop[0]) {
      const f = stop[0] === previous[0] ? 1 : (t - previous[0]) / (stop[0] - previous[0]);
      return [
        previous[1] + (stop[1] - previous[1]) * f,
        previous[2] + (stop[2] - previous[2]) * f,
        previous[3] + (stop[3] - previous[3]) * f,
        previous[4] + (stop[4] - previous[4]) * f,
      ];
    }
    previous = stop;
  }
  return [previous[1], previous[2], previous[3], previous[4]];
}

function baseNoise(canvas: Canvas): void {
  // The noise is painted at half resolution and stretched, as a 2D canvas `drawImage` would.
  const half = SIZE / 2;
  const small = new Float32Array(half * half * 3);
  const rng = seeded(951);
  for (let y = 0; y < half; y++)
    for (let x = 0; x < half; x++) {
      const wx = (x / half) * WORLD - HALF;
      const wz = (y / half) * WORLD - HALF;
      const broad = terrainNoise(wx * 0.032, wz * 0.032);
      const grain = terrainNoise(wx * 0.6, wz * 0.6);
      const cool = terrainNoise(wx * 0.08 + 17, wz * 0.08 + 13);
      const v = broad * 27 + grain * 10 + rng() * 5;
      const k = (y * half + x) * 3;
      small[k] = 82 + v - cool * 7;
      small[k + 1] = 78 + v - cool * 3;
      small[k + 2] = 62 + v + cool * 5;
    }
  for (let y = 0; y < SIZE; y++) {
    const sy = Math.min(half - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(half - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < SIZE; x++) {
      const sx = Math.min(half - 1, Math.max(0, (x + 0.5) / 2 - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(half - 1, x0 + 1);
      const fx = sx - x0;
      for (let c = 0; c < 3; c++) {
        const a =
          (small[(y0 * half + x0) * 3 + c] ?? 0) * (1 - fx) +
          (small[(y0 * half + x1) * 3 + c] ?? 0) * fx;
        const b =
          (small[(y1 * half + x0) * 3 + c] ?? 0) * (1 - fx) +
          (small[(y1 * half + x1) * 3 + c] ?? 0) * fx;
        canvas.rgba[(y * SIZE + x) * 4 + c] = a * (1 - fy) + b * fy;
      }
      canvas.rgba[(y * SIZE + x) * 4 + 3] = 255;
    }
  }
}

function roads(canvas: Canvas): void {
  for (const road of ROAD_PATHS) {
    const path = road.map(([x, z]) => [px(x), px(z)] as const);
    canvas.road(path, [
      [9 * SCALE, [149, 136, 105, 0.18]],
      [5.9 * SCALE, [142, 130, 99, 0.35]],
      [4.8 * SCALE, [92, 88, 72, 0.3]],
    ]);
    for (let i = 1; i < road.length; i++) {
      const a = road[i - 1];
      const b = road[i];
      if (a === undefined || b === undefined) continue;
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      for (const side of [-1, 1]) {
        const ox = (-(b[1] - a[1]) / d) * 1.1 * side;
        const oz = ((b[0] - a[0]) / d) * 1.1 * side;
        canvas.dashed(
          [px(a[0] + ox), px(a[1] + oz)],
          [px(b[0] + ox), px(b[1] + oz)],
          0.45 * SCALE,
          1.8 * SCALE,
          0.6 * SCALE,
          [52, 55, 45, 0.16],
        );
      }
    }
  }
}

function shorelines(canvas: Canvas): void {
  const stops = [
    [0, 40, 59, 52, 1],
    [0.58, 79, 95, 69, 1],
    [0.78, 115, 119, 75, 0.6],
    [1, 122, 124, 86, 0],
  ] as const;
  for (const p of POOLS) {
    const cx = px(p.x);
    const cy = px(p.z);
    const rx = p.rx * SCALE;
    const ry = p.rz * SCALE;
    canvas.each(cx - rx * 1.5, cy - ry * 1.5, cx + rx * 1.5, cy + ry * 1.5, (x, y, i) => {
      const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
      canvas.blend(i, gradient(stops, (d - 0.6) / 0.8));
    });
  }
}

function aprons(canvas: Canvas, rng: () => number): void {
  const tile = 4.4 * SCALE;
  for (const s of STARTS) {
    const x0 = px(s.x - 23);
    const y0 = px(s.z - 22);
    const w = 46 * SCALE;
    const h = 44 * SCALE;
    const cut = 2.5 * SCALE;
    // Inside the cut-corner octagon, with the 3-texel rim the canvas stroke would put on its edge.
    const inside = (x: number, y: number, grow = 0): boolean => {
      const lx = x - x0;
      const ly = y - y0;
      if (lx < -grow || ly < -grow || lx > w + grow || ly > h + grow) return false;
      const cx = Math.min(lx, w - lx) + grow;
      const cy = Math.min(ly, h - ly) + grow;
      return cx + cy >= cut;
    };
    const fill: Paint = s.team === 2 ? [88, 97, 108, 1] : [100, 114, 118, 1];
    canvas.each(x0 - 2, y0 - 2, x0 + w + 2, y0 + h + 2, (x, y, i) => {
      if (inside(x, y)) canvas.blend(i, fill);
      if (inside(x, y, 1.5) && !inside(x, y, -1.5)) canvas.blend(i, [137, 147, 141, 1]);
    });
    for (let ty = y0; ty < y0 + h; ty += tile)
      for (let tx = x0; tx < x0 + w; tx += tile) {
        const shade: Paint = [210, 223, 217, rng() * 0.045];
        canvas.each(tx, ty, tx + tile, ty + tile, (x, y, i) => {
          if (!inside(x, y)) return;
          const lx = x - tx;
          const ly = y - ty;
          if (lx < 0 || ly < 0 || lx >= tile || ly >= tile) return;
          if (lx > 1 && ly > 1 && lx < tile - 1 && ly < tile - 1) canvas.blend(i, shade);
          if (lx < 0.7 || ly < 0.7 || lx > tile - 0.7 || ly > tile - 0.7)
            canvas.blend(i, [18, 32, 36, 0.34]);
          for (const rx of [3, tile - 3])
            for (const ry of [3, tile - 3])
              if (lx >= rx && lx < rx + 1.6 && ly >= ry && ly < ry + 1.6)
                canvas.blend(i, [12, 22, 26, 0.34]);
        });
      }
    for (let i = 0; i < 450; i++) {
      const cx = x0 + rng() * w;
      const cy = y0 + rng() * h;
      const r = 2 + rng() * 16;
      canvas.each(cx - r, cy - r, cx + r, cy + r, (x, y, k) => {
        if (inside(x, y))
          canvas.blend(k, [17, 27, 26, 0.1 * Math.max(0, 1 - Math.hypot(x - cx, y - cy) / r)]);
      });
    }
    const border: Paint = [212, 210, 173, 0.6];
    const a = x0 + 8;
    const b = y0 + 8;
    const c = x0 + w - 8;
    const d = y0 + h - 8;
    canvas.dashed([a, b], [c, b], 2, 10, 7, border);
    canvas.dashed([c, b], [c, d], 2, 10, 7, border);
    canvas.dashed([c, d], [a, d], 2, 10, 7, border);
    canvas.dashed([a, d], [a, b], 2, 10, 7, border);
    // The chevron stack on the apron's right side: five small V's pointing down.
    for (let i = 0; i < 5; i++) {
      const vy = y0 + h * 0.4 + i * 8;
      canvas.polyline(
        [
          [x0 + w * 0.87, vy],
          [x0 + w * 0.89, vy + 5],
          [x0 + w * 0.91, vy],
        ],
        3,
        [220, 213, 161, 0.38],
      );
    }
  }
}

function expansions(canvas: Canvas): void {
  for (const site of RESOURCE_SITES.slice(3)) {
    const x = px(site.baseX);
    const y = px(site.baseZ);
    canvas.disc(x, y, 8 * SCALE, [57, 65, 63, 0.21]);
    canvas.dashedRing(x, y, 7 * SCALE, 1.5, 7, 6, [188, 179, 142, 0.48]);
  }
}

function fissures(canvas: Canvas, rng: () => number): void {
  for (let i = 0; i < 12000; i++) {
    const x = rng() * SIZE;
    const y = rng() * SIZE;
    const rx = 0.5 + rng() * 2;
    const ry = 0.5 + rng();
    const angle = rng() * 6;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const c: Paint = i % 2 ? [222, 212, 165, 0.06] : [21, 28, 23, 0.12];
    canvas.each(x - rx - 1, y - rx - 1, x + rx + 1, y + rx + 1, (sx, sy, k) => {
      const u = ((sx - x) * cos + (sy - y) * sin) / rx;
      const v = (-(sx - x) * sin + (sy - y) * cos) / ry;
      if (u * u + v * v <= 1) canvas.blend(k, c);
    });
  }
}

/**
 * The battlefield texture, `SIZE` texels across `WORLD` metres: sample it at
 * `(world.xz + HALF) / WORLD`, the same coordinates the fog of war uses.
 */
export function paintGround(): DataTexture {
  const canvas = new Canvas();
  const rng = seeded(951);
  baseNoise(canvas);
  roads(canvas);
  shorelines(canvas);
  aprons(canvas, rng);
  expansions(canvas);
  fissures(canvas, rng);
  const texture = new DataTexture(new Uint8Array(canvas.rgba.buffer), SIZE, SIZE);
  texture.colorSpace = SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

/** Horizontal bands of sandstone, wrapped around every mesa: 128 x 256, repeating across. */
export function sedimentTexture(): DataTexture {
  const w = 128;
  const h = 256;
  const bytes = new Uint8Array(w * h * 4);
  const rng = seeded(782);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v =
        142 +
        Math.sin(y * 0.13) * 10 +
        Math.sin(y * 0.52) * 5 +
        Math.sin(y * 0.029) * 20 +
        (rng() - 0.5) * 14 -
        Math.max(0, Math.sin(y * 0.31 + Math.sin(x * 0.07) * 0.6)) ** 14 * 32;
      const i = (y * w + x) * 4;
      bytes[i] = Math.min(255, v + 16);
      bytes[i + 1] = v + 5;
      bytes[i + 2] = v - 13;
      bytes[i + 3] = 255;
    }
  const texture = new DataTexture(bytes, w, h);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.needsUpdate = true;
  return texture;
}
