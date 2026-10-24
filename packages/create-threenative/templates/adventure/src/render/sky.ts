// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// A procedural sky: a vertical gradient for the background, and a half-float copy of the same
// gradient, lifted into light units, for the environment every surface is filled and reflects by.
// No image file. The engine meters the frame (auto exposure) and maps it through the filmic curve,
// so these numbers say how the sky relates to the sun, not how bright the screen is.
import {
  Color,
  DataTexture,
  DataUtils,
  EquirectangularReflectionMapping,
  FogExp2,
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  RGBAFormat,
  type Scene,
  Vector3,
} from "three";
import { palette } from "./palette.js";

/** Unit vector toward the sun: late morning, 42° up, from behind the camera's right shoulder. */
export const SUN_DIRECTION = new Vector3(0.45, 0.67, 0.59).normalize();

/** How much brighter the sky's light is than its picture: the sun is about 6x the sky fill. */
const SKY_RADIANCE = 0.9;
/** The ground half of the environment: warm bounce off the meadow. */
const GROUND_FILL = new Color(0.32, 0.3, 0.22);

function gradient(elevation: number): Color {
  const high = new Color(palette.skyHigh);
  const low = new Color(palette.skyLow);
  const horizon = new Color(palette.horizon);
  if (elevation <= 0) return horizon;
  return elevation < 0.25
    ? horizon.lerp(low, elevation / 0.25)
    : low.lerp(high, Math.min(1, (elevation - 0.25) / 0.75));
}

function equirect(rgba: (elevation: number) => readonly number[]): DataTexture {
  // three's PMREM sizes its cube from width / 4 and needs at least 16: keep width >= 64.
  const width = 128;
  const height = 64;
  const data = new Uint16Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    // DataTexture rows start at v=0 (nadir); v=0.5 is the horizon.
    const elevation = Math.sin((row / (height - 1) - 0.5) * Math.PI);
    const texel = rgba(elevation).map(DataUtils.toHalfFloat);
    for (let column = 0; column < width; column += 1) data.set(texel, (row * width + column) * 4);
  }
  const texture = new DataTexture(data, width, height, RGBAFormat, HalfFloatType);
  texture.colorSpace = LinearSRGBColorSpace;
  texture.mapping = EquirectangularReflectionMapping;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

export interface ISky {
  readonly background: DataTexture;
  readonly environment: DataTexture;
}

export function createSky(): ISky {
  return {
    background: equirect((e) => [...gradient(e).toArray(), 1]),
    environment: equirect((e) => {
      const c = e < 0 ? GROUND_FILL : gradient(e).multiplyScalar(SKY_RADIANCE);
      return [c.r, c.g, c.b, 1];
    }),
  };
}

export function setupSky(scene: Scene, sky: ISky): void {
  scene.background = sky.background;
  scene.backgroundIntensity = 1;
  // three prefilters an equirectangular `scene.environment` itself (PMREM), on WebGPU and WebGL.
  scene.environment = sky.environment;
  scene.environmentIntensity = 1;
  // Thin: under 3% across the 60 m clearing, so the tree line behind it fades instead of ending.
  scene.fog = new FogExp2(palette.horizon, 0.006);
}
