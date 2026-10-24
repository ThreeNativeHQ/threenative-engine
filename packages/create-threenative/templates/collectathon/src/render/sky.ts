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
  return elevation < 0.35
    ? horizon.clone().lerp(low, elevation / 0.35)
    : low.clone().lerp(high, (elevation - 0.35) / 0.65);
}

/** sRGB equirectangular radiance from the ground bounce through the horizon to the zenith. */
export function skyTexture(): DataTexture {
  // three's PMREM sizes its cube from width / 4 and needs at least 16: keep width >= 64.
  const width = 256;
  const height = 128;
  const data = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const { r, g, b } = gradientColor(row, height).convertLinearToSRGB();
    for (let column = 0; column < width; column += 1) {
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

export function setupSky(scene: Scene, sky: DataTexture): void {
  scene.background = sky;
  scene.backgroundIntensity = 1;
  scene.environment = sky;
  scene.environmentIntensity = 1;
  // Thin on purpose: the island is 90 m across, so the haze only reads on the far shore and the
  // sea beyond it, where it is what turns the horizon line into distance.
  scene.fog = new FogExp2(palette.horizon, 0.0045);
}
