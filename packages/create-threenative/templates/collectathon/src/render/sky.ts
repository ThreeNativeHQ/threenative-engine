// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// A blue gradient with the sun's warm halo and a deck of cumulus, painted per texel from seeded
// noise, is the background and, prefiltered by three, the environment: the sky
// lights every face the sun misses, which is the stock Unreal outdoor setup of one directional sun
// plus a sky light. Brightness is the tone curve's and the meter's business (`postprocessing.ts`);
// this file only decides colour, so a darker or warmer sky is an edit to `palette.ts`.
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
 * Unit vector toward the sun: a low late-morning sun, about 26° up in the east and a little south,
 * so it rakes across the hills from the right of a camera looking north to the castle and throws
 * long shadows to the left, and still lights the castle's south front.
 */
export const SUN_DIRECTION = new Vector3(0.8, 0.45, 0.28).normalize();

function gradientColor(row: number, height: number): Color {
  const high = new Color(palette.skyHigh);
  const low = new Color(palette.skyLow);
  const horizon = new Color(palette.horizon);
  // DataTexture rows start at v=0 (nadir); equirectangular v=0.5 is the horizon.
  const elevation = Math.sin((row / (height - 1) - 0.5) * Math.PI);
  if (elevation < 0) return horizon.clone().lerp(new Color(palette.grass), Math.min(1, -elevation));
  // A thin haze band, then blue: a third-person camera sees the sky only up to about 30°.
  return elevation < 0.15
    ? horizon.clone().lerp(low, elevation / 0.15)
    : low.clone().lerp(high, Math.min(1, (elevation - 0.15) / 0.5));
}

/** Smooth 2D value noise from a sine hash, for the cloud deck: unbounded, deterministic. */
function noise(x: number, y: number): number {
  const cell = (i: number, j: number): number => {
    const h = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
    return h - Math.floor(h);
  };
  const i = Math.floor(x);
  const j = Math.floor(y);
  const fx = (x - i) * (x - i) * (3 - 2 * (x - i));
  const fy = (y - j) * (y - j) * (3 - 2 * (y - j));
  const top = cell(i, j) + (cell(i + 1, j) - cell(i, j)) * fx;
  const bottom = cell(i, j + 1) + (cell(i + 1, j + 1) - cell(i, j + 1)) * fx;
  return top + (bottom - top) * fy;
}

function fbm(x0: number, y0: number): number {
  let [x, y, sum, amplitude] = [x0, y0, 0, 0.5];
  for (let octave = 0; octave < 5; octave += 1) {
    sum += amplitude * noise(x, y);
    x = x * 2.03 + 17.1;
    y = y * 2.03 + 9.7;
    amplitude *= 0.5;
  }
  return sum;
}

/**
 * Cumulus on a flat deck seen from below: (azimuth, elevation) is projected onto the deck, so the
 * clouds bunch up and flatten toward the horizon as real ones do. Returns cover 0..1 and a light
 * term: a cloud's sun-facing top is bright, its flat base a cool grey.
 */
function cumulus(azimuth: number, elevation: number): { cover: number; light: number } {
  if (elevation <= 0.01) return { cover: 0, light: 1 };
  const reach = 1 / (Math.tan(elevation) + 0.12);
  const x = Math.cos(azimuth) * reach * 1.6;
  const y = Math.sin(azimuth) * reach * 1.6;
  const n = fbm(x, y);
  // Thicker low in the sky, thinning toward the zenith, gone on the horizon line.
  const band = Math.min(1, elevation / 0.06) * (1 - 0.55 * Math.min(1, elevation / 1.1));
  const cover = Math.min(1, Math.max(0, (n - 0.5) / 0.16)) * band;
  // Where the deck gets denser toward the horizon (lower on screen) is the cloud's base.
  const below = fbm(x * 1.04, y * 1.04);
  const light = Math.min(1.15, Math.max(0.55, 0.85 + (n - below) * 6 + (n - 0.5) * 0.8));
  return { cover, light };
}

/**
 * sRGB equirectangular radiance from the ground bounce through the horizon to the zenith.
 * `saturation` below 1 pulls every texel toward its own grey: the fill light uses a 30%-saturated
 * copy, because a real sky's shade light is greyed by haze and cloud, and the full blue of the
 * backdrop turns every shadow on the grass teal.
 */
export function skyTexture(saturation = 1, width = 1024): DataTexture {
  // three's PMREM sizes its cube from width / 4 and needs at least 16: keep width >= 64.
  const height = width / 2;
  const data = new Uint8Array(width * height * 4);
  const cloud = new Color();
  const grey = new Color();
  const sunGlow = new Color(0xfff0d8);
  const lit = new Color(1, 0.99, 0.96);
  const toward = new Vector3();
  for (let row = 0; row < height; row += 1) {
    const base = gradientColor(row, height);
    const elevation = (row / (height - 1) - 0.5) * Math.PI;
    for (let column = 0; column < width; column += 1) {
      // three's equirectangular u: azimuth from +X toward +Z, u = 0.5 on +X.
      const azimuth = (column / width - 0.5) * Math.PI * 2;
      toward.set(
        Math.cos(azimuth) * Math.cos(elevation),
        Math.sin(elevation),
        Math.sin(azimuth) * Math.cos(elevation),
      );
      // The sun's halo: a warm glow round its direction, wider than the disc the lens never sees.
      const sun = Math.max(0, toward.dot(SUN_DIRECTION));
      const texel = base.clone().lerp(sunGlow, 0.55 * sun ** 24 + 0.2 * sun ** 4);
      const { cover, light } = cumulus(azimuth, elevation);
      cloud.setRGB(0.66, 0.71, 0.8).lerp(lit, Math.min(1, light - 0.55));
      texel.lerp(cloud, cover * 0.95);
      grey.setScalar(texel.r * 0.2126 + texel.g * 0.7152 + texel.b * 0.0722);
      const { r, g, b } = texel.lerp(grey, 1 - saturation).convertLinearToSRGB();
      data.set(
        [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), 255],
        (row * width + column) * 4,
      );
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

/** `fill` is the environment light: by default the sky itself, in this game `skyTexture(0.3, 128)`. */
export function setupSky(scene: Scene, sky: DataTexture, fill: DataTexture = sky): void {
  scene.background = sky;
  scene.backgroundIntensity = 1;
  scene.environment = fill;
  // The sky fills the shade above the background's own level, so a cast shadow reads as a
  // mid-tone of the ground's colour, not a near-black hole in it.
  scene.environmentIntensity = 1.65;
  // Light haze: about 9% at the castle 70 m off, half by the far hills at 200 m, so distance reads
  // as layers of paler blue-green, as aerial perspective does in a stock Unreal outdoor level.
  scene.fog = new FogExp2(palette.horizon, 0.0045);
}
