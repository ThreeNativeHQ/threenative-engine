// The saguaro's skin: photographed succulent flesh under the ribs and areoles a saguaro reads by.
//
// `bakeVegetation({ preset: "saguaro", barkImage, barkNormalImage })` paints this instead of Arbor's
// drawn cactus bark, which is a flat 256x512 pinstripe: at five metres the column read as a striped
// stick. Its rib relief lives in the normal map, because a smooth 12-sided column has no ribs of its
// own to shade — albedo alone can only paint lines on it.
//
// The flesh is Poly Haven's CC0 `crystalline_iceplant` scan (a Karoo succulent, 1K diffuse), and the
// ribs, areoles and spines are drawn here, because no CC0 scan of a saguaro exists on Poly Haven —
// the succulent models there are groundcovers. One repeat is 0.6 m of trunk (the preset's own
// `barkScale`), so eight ribs and thirteen areole rows tile the trunk's own circumference.
//
//     node packages/terrain/scripts/make-cactus-skin.mjs --source <crystalline_iceplant_diff_1k.jpg>
//
// The same source writes the same bytes; the two outputs are committed beside the other starter art.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FOLDER = path.join(HERE, "../starter-assets/desert_flora");
const OUT = path.join(FOLDER, "saguaro-skin.png");
const OUT_NORMAL = path.join(FOLDER, "saguaro-skin-nor.png");
const WIDTH = 256;
const HEIGHT = 512;
/** Ribs around the trunk in one repeat: a 40 cm saguaro has 16, and a repeat is half a metre. */
const RIBS = 8;
/** Areoles are about 1.4 cm apart on a real rib, and one repeat is 0.6 m of trunk. */
const AROLE_ROWS = 13;
const SEED = 892_031;
/** An interior patch of one photographed leaf: its edge is a hard cut against the atlas's alpha. */
const PATCH = { left: 560, top: 230, size: 192 };
/** How far a rib's relief answers the sun, in the normal map's own tangent space. */
const RELIEF = 5;

const args = process.argv.slice(2);
const sourceIndex = args.indexOf("--source");
const source = sourceIndex < 0 ? undefined : args[sourceIndex + 1];
if (source === undefined || source.startsWith("--"))
  throw new Error(
    "make-cactus-skin: pass --source <path> to Poly Haven's crystalline_iceplant_diff_1k.jpg " +
      "(CC0, https://polyhaven.com/a/crystalline_iceplant); raw downloads are never committed",
  );

/** mulberry32: one uint32 seed, the same output on every platform and Node version. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = random(SEED);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smooth = (lo, hi, v) => {
  const t = clamp((v - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
};
const frac = (v) => v - Math.floor(v);

/** 2D value noise on a wrapped lattice, so the flesh modulates without a visible seam. */
function noise2(seed) {
  const size = 256;
  const r = random(seed);
  const lattice = Float32Array.from({ length: size * size }, r);
  const at = (ix, iy) =>
    lattice[(((iy % size) + size) % size) * size + (((ix % size) + size) % size)] ?? 0;
  return (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const tx = x - xi;
    const ty = y - yi;
    return lerp(
      lerp(at(xi, yi), at(xi + 1, yi), tx),
      lerp(at(xi, yi + 1), at(xi + 1, yi + 1), tx),
      ty,
    );
  };
}
const n1 = noise2(SEED + 1);
const n2 = noise2(SEED + 2);
const fbm = (x, y) =>
  n1(x, y) * 0.55 + n2(x * 2.7 + 13, y * 2.7 + 7) * 0.3 + n2(x * 6.1, y * 6.1) * 0.15;

/** The photographed flesh, mirrored into one 512 px tile. */
const flesh = await sharp(source)
  .extract({ left: PATCH.left, top: PATCH.top, width: PATCH.size, height: PATCH.size })
  .resize(WIDTH, WIDTH, { kernel: "mitchell" })
  .blur(0.6)
  .raw()
  .toBuffer({ resolveWithObject: true });
const [FLESH_WIDTH, FLESH_HEIGHT, FLESH_CHANNELS] = [
  flesh.info.width,
  flesh.info.height,
  flesh.info.channels,
];
if (FLESH_CHANNELS < 3) throw new Error("make-cactus-skin: the source patch is not RGB");
/** The mirrored tile samples a quarter: `x` past the middle reads back towards the left edge. */
const fleshAt = (x, y) => {
  const mx = x < FLESH_WIDTH / 2 ? x : FLESH_WIDTH - 1 - x;
  const my = y < FLESH_HEIGHT / 2 ? y : FLESH_HEIGHT - 1 - y;
  const i = (my * FLESH_WIDTH + mx) * FLESH_CHANNELS;
  return [
    (flesh.data[i] ?? 0) / 255,
    (flesh.data[i + 1] ?? 0) / 255,
    (flesh.data[i + 2] ?? 0) / 255,
  ];
};
/** The photograph's own brightness about its own mean: the mottle the ribs are painted over. */
const mottle = (x, y) => {
  const [r, g, b] = fleshAt(x, Math.floor((y * WIDTH) / HEIGHT));
  return clamp((0.2126 * r + 0.7152 * g + 0.0722 * b) / 0.36, 0.4, 1.6);
};

// Eight identical grooves tile into corduroy, so every rib leans, widens and takes its own tone.
const ribLean = Array.from({ length: RIBS }, () => (rnd() - 0.5) * 0.06);
const ribWidth = Array.from({ length: RIBS }, () => 0.7 + rnd() * 0.5);
const ribTone = Array.from({ length: RIBS }, () => 0.94 + rnd() * 0.12);
// An areole sits on its own rib's crown, and each one is stamped on its own line.
const areoles = [];
for (let rib = 0; rib < RIBS; rib += 1)
  for (let row = 0; row < AROLE_ROWS; row += 1) {
    const u = (rib + 0.5 + (rnd() - 0.5) * 0.34) / RIBS;
    const v = (row + 0.5 + (rnd() - 0.5) * 0.8) / AROLE_ROWS;
    areoles.push({ u, v, lean: (rnd() - 0.5) * 1.1, size: 0.85 + rnd() * 0.4 });
  }

const albedo = Buffer.alloc(WIDTH * HEIGHT * 3);
const height = new Float32Array(WIDTH * HEIGHT);
const put = (x, y, r, g, b) => {
  const i = (y * WIDTH + x) * 3;
  albedo[i] = Math.round(clamp(r, 0, 1) * 255);
  albedo[i + 1] = Math.round(clamp(g, 0, 1) * 255);
  albedo[i + 2] = Math.round(clamp(b, 0, 1) * 255);
};
for (let y = 0; y < HEIGHT; y += 1) {
  const v = y / HEIGHT;
  for (let x = 0; x < WIDTH; x += 1) {
    const u = x / WIDTH;
    const rib = Math.floor(u * RIBS) % RIBS;
    const phase = frac(u * RIBS + ribLean[rib] * Math.sin(v * Math.PI * 2));
    // A saguaro's rib is a lobe, not a groove: the valley is a soft shadow, never a black line.
    const taper = ribWidth[rib] * (0.55 + 0.12 * Math.sin(v * 3.1 + rib));
    const ridge = smooth(0, 1, 1 - Math.abs(phase - 0.5) * 2) ** taper;
    // A wax streak runs along a rib, never across it, so the fine noise is stretched in v only.
    const streak = fbm(u * 26, v * 3.2) - 0.5;
    const fleck = mottle(x, y);
    const drift = 1 + 0.07 * Math.sin(v * 6.283 * (0.4 + rib * 0.17) + rib * 2.3);
    const tone = lerp(0.9, 1.1, fleck) * (1 + streak * 0.05) * ribTone[rib] * drift;
    // A saguaro is a dusty blue-green, not a leaf's vivid green: the red channel carries the dust.
    // The cuticle is what a saguaro shows the sun: pale, dusty and a stop lighter than a leaf's
    // flesh, because a dark column disappears against iron-red sand at forty metres.
    let r = lerp(0.33, 0.46, ridge) * tone;
    let g = lerp(0.39, 0.54, ridge) * tone;
    let b = lerp(0.26, 0.35, ridge) * tone;
    const wax = smooth(0.6, 1, ridge) * lerp(0.4, 1, fbm(u * 5, v * 3)) * 0.5;
    r = lerp(r, 0.62, wax);
    g = lerp(g, 0.68, wax);
    b = lerp(b, 0.5, wax);
    put(x, y, r, g, b);
    // Only the rib's own relief: the photograph's grain belongs in the albedo, because a height
    // field that repeats it turns each 2 px texel into a ridge and the trunk into corduroy.
    height[y * WIDTH + x] = ridge * 0.6;
  }
}

// The areoles last, so a spine draws over whatever hairline it crosses.
for (const areole of areoles) {
  const cx = areole.u * WIDTH;
  const cy = areole.v * HEIGHT;
  const radius = 5.2 * areole.size;
  const left = Math.max(0, Math.floor(cx - 16));
  const right = Math.min(WIDTH - 1, Math.ceil(cx + 16));
  const top = Math.max(0, Math.floor(cy - 18));
  const bottom = Math.min(HEIGHT - 1, Math.ceil(cy + 18));
  for (let y = top; y <= bottom; y += 1)
    for (let x = left; x <= right; x += 1) {
      const dx = (x - cx) / radius;
      const dy = (y - cy) / (radius * 0.8);
      const felt = smooth(1.3, 0.55, Math.hypot(dx, dy));
      // Five short needles fan up and out of each areole, as a saguaro's clusters do.
      let needle = 0;
      let along = 0;
      for (let s = 0; s < 3; s += 1) {
        const angle = -Math.PI / 2 + (s - 1) * 0.5 + areole.lean;
        const length = 8 + (s % 2) * 4;
        const ex = Math.cos(angle);
        const ey = Math.sin(angle);
        const reach = (x - cx) * ex + (y - cy) * ey;
        if (reach < 1 || reach > length) continue;
        const across = Math.abs((x - cx) * ey - (y - cy) * ex);
        if (across > 0.7) continue;
        needle = Math.max(needle, 1 - reach / length);
        along = Math.max(along, reach);
      }
      if (felt <= 0 && needle <= 0) continue;
      const i = (y * WIDTH + x) * 3;
      const base = [albedo[i] / 255, albedo[i + 1] / 255, albedo[i + 2] / 255];
      const feltTone = [0.46, 0.4, 0.26];
      const spineTone = [0.72, 0.68, 0.52];
      const withFelt = base.map((c, k) => lerp(c, feltTone[k], felt));
      put(
        x,
        y,
        lerp(withFelt[0], spineTone[0], needle * 0.85),
        lerp(withFelt[1], spineTone[1], needle * 0.85),
        lerp(withFelt[2], spineTone[2], needle * 0.8),
      );
      // A felted areole sits a little proud of its rib; a spine is thinner than a texel here and
      // only ever appears in the albedo.
      height[y * WIDTH + x] += felt * 0.05;
    }
}

/** The relief as a glTF tangent-space normal map: ridge slopes across u, areoles and spines in v. */
const normal = Buffer.alloc(WIDTH * HEIGHT * 3);
const at = (x, y) => height[((y + HEIGHT) % HEIGHT) * WIDTH + ((x + WIDTH) % WIDTH)] ?? 0;
for (let y = 0; y < HEIGHT; y += 1)
  for (let x = 0; x < WIDTH; x += 1) {
    const dx = (at(x + 1, y) - at(x - 1, y)) * RELIEF;
    const dy = (at(x, y + 1) - at(x, y - 1)) * RELIEF;
    const length = Math.hypot(dx, dy, 1);
    const i = (y * WIDTH + x) * 3;
    normal[i] = Math.round(((-dx / length) * 0.5 + 0.5) * 255);
    normal[i + 1] = Math.round(((-dy / length) * 0.5 + 0.5) * 255);
    normal[i + 2] = Math.round((1 / length) * 0.5 * 255 + 127);
  }

const encode = (raw) =>
  sharp(raw, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } })
    .png({ compressionLevel: 9, palette: true, colours: 128, dither: 1 })
    .toBuffer();
await mkdir(FOLDER, { recursive: true });
const [albedoPng, normalPng] = [await encode(albedo), await encode(normal)];
await writeFile(OUT, albedoPng);
await writeFile(OUT_NORMAL, normalPng);
console.log(
  `make-cactus-skin: ${path.relative(process.cwd(), OUT)} ${albedoPng.length} bytes, ` +
    `${path.relative(process.cwd(), OUT_NORMAL)} ${normalPng.length} bytes`,
);
