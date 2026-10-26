// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// A vertical blue gradient is the background and, prefiltered by three, the environment: the sky
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

/** Unit vector toward the sun: a mid-morning sun, 42° up, behind the camera's left shoulder. */
export const SUN_DIRECTION = new Vector3(0.45, 0.67, 0.59).normalize();

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

/** A few soft, flat-bottomed clouds low in the sky: [azimuth 0..1, elevation 0..1, width, height]. */
const CLOUDS = [
  [0.06, 0.16, 0.05, 0.035],
  [0.19, 0.22, 0.035, 0.025],
  [0.33, 0.13, 0.06, 0.03],
  [0.52, 0.2, 0.045, 0.03],
  [0.64, 0.12, 0.055, 0.025],
  [0.8, 0.18, 0.05, 0.035],
  [0.92, 0.25, 0.03, 0.02],
] as const;

function cloudCover(u: number, elevation: number): number {
  let cover = 0;
  for (const [cu, ce, w, h] of CLOUDS) {
    const du = Math.min(Math.abs(u - cu), 1 - Math.abs(u - cu)) / w;
    // Flat bottoms: below the centre the cloud fades twice as fast.
    const de = (elevation - ce) / (elevation < ce ? h * 0.5 : h);
    cover = Math.max(cover, Math.exp(-(du * du + de * de) * 2));
  }
  return cover;
}

/**
 * sRGB equirectangular radiance from the ground bounce through the horizon to the zenith.
 * `saturation` below 1 pulls every texel toward its own grey: the fill light uses a 30%-saturated
 * copy, because a real sky's shade light is greyed by haze and cloud, and the full blue of the
 * backdrop turns every shadow on the grass teal.
 */
export function skyTexture(saturation = 1, width = 512): DataTexture {
  // three's PMREM sizes its cube from width / 4 and needs at least 16: keep width >= 64.
  const height = width / 2;
  const data = new Uint8Array(width * height * 4);
  const cloud = new Color(0xffffff);
  const grey = new Color();
  for (let row = 0; row < height; row += 1) {
    const base = gradientColor(row, height);
    const elevation = row / (height - 1) - 0.5;
    for (let column = 0; column < width; column += 1) {
      const cover = elevation > 0 ? cloudCover(column / width, elevation * 2) : 0;
      const texel = base.clone().lerp(cloud, cover * 0.85);
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
  // Thin on purpose: the course is about 250 m across, so the haze only reads on the far side of
  // it and on the ring of hills, where it is what turns the horizon line into distance.
  scene.fog = new FogExp2(palette.horizon, 0.0024);
}
