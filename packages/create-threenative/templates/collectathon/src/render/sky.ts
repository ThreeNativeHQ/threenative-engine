// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// A blue gradient with the sun's warm halo and a deck of big cumulus, painted per texel from seeded
// noise, is the background and, prefiltered by three, the environment: the sky lights every face
// the sun misses, which is the stock Unreal outdoor setup of one directional sun plus a sky light.
// Brightness is the tone curve's and the meter's business (`postprocessing.ts`); this file only
// decides colour, so a darker or warmer sky is an edit to `palette.ts`.
import {
  Color,
  DataTexture,
  EquirectangularReflectionMapping,
  FogExp2,
  LinearFilter,
  RGBAFormat,
  SRGBColorSpace,
  type Scene,
  UnsignedByteType,
  Vector3,
} from "three";
import { palette } from "./palette.js";

/**
 * Unit vector toward the sun: a low golden-hour sun about 22° up in the east, a little south, so it
 * rakes across the meadow from the right of a camera looking north to the castle, throws long
 * shadows to the left, rims the grass tips and the hero, and still grazes the castle's south front.
 */
export const SUN_DIRECTION = new Vector3(0.9, 0.38, 0.16).normalize();

/** A 256 x 256 lattice of seeded values: the noise reads a table, far cheaper than a hash per call. */
const LATTICE = (() => {
  let state = 9137;
  return Float32Array.from({ length: 256 * 256 }, () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  });
})();

/** Smooth 2D value noise on the lattice, for the cloud deck: deterministic, repeats every 256 units. */
function noise(x: number, y: number): number {
  const i = Math.floor(x);
  const j = Math.floor(y);
  const fx = (x - i) * (x - i) * (3 - 2 * (x - i));
  const fy = (y - j) * (y - j) * (3 - 2 * (y - j));
  const i0 = i & 255;
  const i1 = (i + 1) & 255;
  const j0 = (j & 255) << 8;
  const j1 = ((j + 1) & 255) << 8;
  const c00 = LATTICE[j0 + i0] as number;
  const c10 = LATTICE[j0 + i1] as number;
  const c01 = LATTICE[j1 + i0] as number;
  const c11 = LATTICE[j1 + i1] as number;
  const top = c00 + (c10 - c00) * fx;
  return top + (c01 + (c11 - c01) * fx - top) * fy;
}

function fbm(x0: number, y0: number, octaves = 5): number {
  let x = x0;
  let y = y0;
  let sum = 0;
  let amplitude = 0.5;
  for (let octave = 0; octave < octaves; octave += 1) {
    sum += amplitude * noise(x, y);
    x = x * 2.03 + 17.1;
    y = y * 2.03 + 9.7;
    amplitude *= 0.5;
  }
  return sum;
}

/**
 * Cloud density on a flat deck seen from below, at deck coordinates (x, y): a broad field of
 * heaps warped by a second noise, with billowed edges from the finer octaves.
 */
function density(x: number, y: number): number {
  const wx = x + 0.9 * fbm(x * 0.5 + 3.1, y * 0.5, 3);
  const wy = y + 0.9 * fbm(x * 0.5, y * 0.5 + 7.3, 3);
  return fbm(wx, wy);
}

const smooth = (from: number, to: number, value: number): number => {
  const t = Math.min(1, Math.max(0, (value - from) / (to - from)));
  return t * t * (3 - 2 * t);
};

/**
 * sRGB equirectangular radiance from the ground bounce through the horizon to the zenith.
 * `saturation` below 1 pulls every texel toward its own grey: the fill light uses a 30%-saturated
 * copy, because a real sky's shade light is greyed by haze and cloud, and the full blue of the
 * backdrop turns every shadow on the grass teal.
 *
 * The clouds are cumulus on a deck: (azimuth, elevation) projects onto it, so they bunch up and
 * flatten toward the horizon. Each is lit by where its density climbs: a texel whose deck is
 * denser toward the sun, or above it on screen, is on the cloud's shaded side or its flat base.
 */
export function skyTexture(saturation = 1, width = 2048): DataTexture {
  // three's PMREM sizes its cube from width / 4 and needs at least 16: keep width >= 64.
  const height = width / 2;
  const data = new Uint8Array(width * height * 4);
  const high = new Color(palette.skyHigh);
  const low = new Color(palette.skyLow);
  const horizon = new Color(palette.horizon);
  const ground = new Color(palette.grass);
  const glow = new Color(0xffe2b8);
  const lit = new Color(1, 0.98, 0.94);
  const shade = new Color(0.56, 0.62, 0.74);
  const base = new Color();
  const texel = new Color();
  const cloud = new Color();
  // Pass 1: the deck's density under every cloud-band texel, once (the shading reads neighbours).
  const deck = new Float32Array(width * height);
  const bands = new Float32Array(height);
  for (let row = 0; row < height; row += 1) {
    const elevation = (row / (height - 1) - 0.5) * Math.PI;
    // Scattered heaps overhead, above the cumulus banks; thinning toward the zenith.
    bands[row] = smooth(0.22, 0.4, elevation) * (1 - 0.55 * smooth(0.5, 1.2, elevation));
    if ((bands[row] ?? 0) <= 0) continue;
    // Flattened less than a true deck would be: cumulus heaps stand tall, they are not a sheet.
    const reach = (1 / (Math.tan(elevation) + 0.1)) ** 0.7 * 0.75;
    for (let column = 0; column < width; column += 1) {
      const azimuth = (column / width - 0.5) * Math.PI * 2;
      deck[row * width + column] = density(Math.cos(azimuth) * reach, Math.sin(azimuth) * reach);
    }
  }
  // The cumulus banks over the far hills, per column: where a bank stands (`cluster`), its heaped
  // top and its flat base, in radians of elevation. Noise is read on a circle, so azimuth wraps.
  const tops = new Float32Array(width);
  const bases = new Float32Array(width);
  for (let column = 0; column < width; column += 1) {
    const azimuth = (column / width - 0.5) * Math.PI * 2;
    const px = Math.cos(azimuth) * 4;
    const py = Math.sin(azimuth) * 4;
    const cluster = smooth(0.3, 0.52, fbm(px * 0.6 + 31, py * 0.6 + 7, 3));
    const heap = smooth(0.3, 0.75, fbm(px * 1.6 + 3, py * 1.6 + 11, 2));
    bases[column] = 0.07 + 0.02 * noise(px * 2 + 5, py * 2);
    // Domed: the heap height falls off smoothly to nothing at a bank's ends.
    tops[column] = (bases[column] ?? 0) + (0.04 + 0.26 * heap) * Math.sqrt(cluster) - 0.02;
  }
  // Pass 2: colour. A step of about 0.7 degrees toward the sun and up the sky, in texels.
  const step = Math.max(1, Math.round(width / 512));
  const sunAzimuth = Math.atan2(SUN_DIRECTION.z, SUN_DIRECTION.x);
  const sunElevation = Math.asin(SUN_DIRECTION.y);
  for (let row = 0; row < height; row += 1) {
    const elevation = (row / (height - 1) - 0.5) * Math.PI;
    const up = Math.sin(elevation);
    const cosE = Math.cos(elevation);
    // A thin haze band, then blue deepening to the zenith; below, the haze over the ground.
    if (up < 0) base.copy(horizon).lerp(ground, Math.min(1, -up * 3));
    else if (up < 0.12) base.copy(horizon).lerp(low, up / 0.12);
    else base.copy(low).lerp(high, Math.min(1, (up - 0.12) / 0.55));
    const band = bands[row] ?? 0;
    const above = Math.min(height - 1, row + step);
    const towardRow = Math.min(
      height - 1,
      Math.max(0, row + (sunElevation > elevation ? step : -step)),
    );
    for (let column = 0; column < width; column += 1) {
      // three's equirectangular u: azimuth from +X toward +Z, u = 0.5 on +X.
      const azimuth = (column / width - 0.5) * Math.PI * 2;
      const tx = Math.cos(azimuth) * cosE;
      const tz = Math.sin(azimuth) * cosE;
      // The sun's halo: a warm glow round its direction, wider than the disc the lens never sees.
      const sun = Math.max(0, tx * SUN_DIRECTION.x + up * SUN_DIRECTION.y + tz * SUN_DIRECTION.z);
      texel.copy(base).lerp(glow, 0.6 * sun ** 32 + 0.22 * sun ** 5);
      const d = deck[row * width + column] ?? 0;
      const cover = band > 0 ? smooth(0.43, 0.54, d) * band : 0;
      if (cover > 0.002) {
        const turn = Math.sin(sunAzimuth - azimuth) > 0 ? step : -step;
        const towardColumn = (column + turn + width) % width;
        // Denser a step toward the sun: the far side of a heap. Denser a step up the sky: its base.
        const toward = (deck[towardRow * width + towardColumn] ?? 0) - d;
        const base01 = (deck[above * width + column] ?? 0) - d;
        // Thick middles go a little grey, as a real heap's core does.
        const light =
          smooth(-0.05, 0.05, -toward * 1.2 - base01 * 2) * (1 - 0.35 * smooth(0.6, 0.8, d));
        cloud.copy(shade).lerp(lit, light);
        // The edge facing the sun catches its warmth.
        cloud.lerp(glow, 0.4 * sun ** 3 * light);
        texel.lerp(cloud, cover);
      }
      const foot = bases[column] ?? 0;
      const top = tops[column] ?? 0;
      if (elevation > foot && elevation < top + 0.05) {
        // Billowed outline: finer noise lifts and bites the heap's top edge.
        // Elevation moves radially and azimuth round the circle: round puffs, and azimuth wraps.
        const puff = (e: number) =>
          fbm(Math.cos(azimuth) * (14 + e * 15), Math.sin(azimuth) * (14 + e * 15), 3);
        const lump = puff(elevation);
        const below = top + (lump - 0.5) * 0.11 - elevation;
        const inside = smooth(0, 0.02, below) * smooth(foot, foot + 0.012, elevation);
        if (inside > 0.002) {
          // Flat grey base, sunlit crowns, each lump shaded on its lower side.
          const height01 = smooth(foot, top, elevation);
          // A puff's crown is denser than the sky just above it: lit. Its underside is not: shaded.
          const crown = smooth(-0.03, 0.03, lump - puff(elevation + 0.015));
          const light = Math.min(
            1,
            (0.05 + 0.95 * height01 ** 1.2) * (0.5 + 0.65 * crown) +
              0.25 * (1 - smooth(0, 0.05, below)),
          );
          cloud.copy(shade).lerp(lit, light);
          cloud.lerp(glow, 0.45 * sun ** 2 * light);
          texel.lerp(cloud, inside);
        }
      }
      const grey = texel.r * 0.2126 + texel.g * 0.7152 + texel.b * 0.0722;
      const r = texel.r + (grey - texel.r) * (1 - saturation);
      const g = texel.g + (grey - texel.g) * (1 - saturation);
      const b = texel.b + (grey - texel.b) * (1 - saturation);
      const i = (row * width + column) * 4;
      data[i] = Math.round(255 * linearToSrgb(r));
      data[i + 1] = Math.round(255 * linearToSrgb(g));
      data[i + 2] = Math.round(255 * linearToSrgb(b));
      data[i + 3] = 255;
    }
  }
  const sky = new DataTexture(data, width, height, RGBAFormat, UnsignedByteType);
  sky.mapping = EquirectangularReflectionMapping;
  sky.colorSpace = SRGBColorSpace;
  sky.magFilter = LinearFilter;
  sky.minFilter = LinearFilter;
  sky.needsUpdate = true;
  return sky;
}

function linearToSrgb(value: number): number {
  const v = Math.min(1, Math.max(0, value));
  return v < 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
}

/** `fill` is the environment light: by default the sky itself, in this game `skyTexture(0.3, 128)`. */
export function setupSky(scene: Scene, sky: DataTexture, fill: DataTexture = sky): void {
  scene.background = sky;
  scene.backgroundIntensity = 1;
  scene.environment = fill;
  // The sky fills the shade above the background's own level, so a cast shadow reads as a
  // mid-tone of the ground's colour, not a near-black hole in it. Low enough that the low sun's
  // long shadows still read across the lawn.
  scene.environmentIntensity = 1.1;
  // Light haze: about 5% at the castle 70 m off, a third by the far hills at 200 m, so distance reads
  // as layers of paler blue-green, as aerial perspective does in a stock Unreal outdoor level.
  scene.fog = new FogExp2(palette.horizon, 0.0031);
}
