// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// The sky is a photograph: `assets/sky.jpg`, Poly Haven's "Kloofendal 48d Partly Cloudy (Pure Sky)"
// by Greg Zaal and Jarod Guest, CC0 (https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky).
// The same image is the background and — through `SUN_DIRECTION` — the direction the sun's shadows
// fall. It is not the environment light: AstraCraft lights with a hemisphere (`lighting.ts`). Swap the file for any
// equirectangular sky and re-aim `SUN_DIRECTION` at its sun.
import {
  EquirectangularReflectionMapping,
  FogExp2,
  SRGBColorSpace,
  type Scene,
  type Texture,
  Vector3,
} from "three";
import { HEIGHT_FOG, type HeightFogParams, heightFogDepth, heightFogNode } from "./heightFog.js";
import { legacyColor, palette } from "./palette.js";

/**
 * How the JPEG was made from the 4k HDR: linear radiance × 0.4, clipped, sRGB-encoded — so white
 * in the file is 2.5 in the sky. Multiplying back restores the HDR brightness of the clouds; the sun
 * disk itself is clipped, which is why the sun is a light (`lighting.ts`) and not a texel.
 */
const SKY_RANGE = 2.5;

/** Unit vector toward the sun: high and from the north-west, so mesas throw their shadow toward the camera's right. */
export const SUN_DIRECTION = new Vector3(-35, 70, -20).normalize();

/** The look this fog replaced: FogExp2 at 0.0035, measured at 150 m from 20 m up. */
const EYE_LEVEL = { density: 0.0021, distance: 150, cameraHeight: 20 };

/**
 * The distance term's density that, with the height term, keeps the old eye-level haze: at
 * `EYE_LEVEL.distance` along the horizon from `EYE_LEVEL.cameraHeight` the two together transmit what
 * FogExp2 at `EYE_LEVEL.density` did. The distance term is lowered, never removed, so the ground
 * still ends in fog at a kilometre.
 */
function distanceDensity(p: HeightFogParams = HEIGHT_FOG): number {
  const { distance, density, cameraHeight } = EYE_LEVEL;
  const old = (density * distance) ** 2;
  const height = heightFogDepth(p, cameraHeight, cameraHeight, distance) * Math.LN2;
  return Math.sqrt(Math.max(0, old - height)) / distance;
}

export function setupSky(scene: Scene, sky: Texture): void {
  sky.mapping = EquirectangularReflectionMapping;
  sky.colorSpace = SRGBColorSpace;
  scene.background = sky;
  scene.backgroundIntensity = SKY_RANGE;
  // No `scene.environment`: AstraCraft has none, and the photograph's fill lifted the ground 0.03
  // to 0.06 lighter and warmer than the reference frame (PRD-765). Set it back to light with the sky.
  // Tuned for a 224 m battlefield rather than a 36 m arena, and then tuned again: the first
  // value meant to hide the map's far edge (0.0075) hazed the fog of war away with it, because a
  // cell the player has never seen is 60 m away and a distant cell is 150. At 0.0035 the far corner
  // is a quarter hazed and an unexplored cell next to the camera is 4% — the haze stays a horizon
  // instead of becoming the map.
  // `scene.fog` stays the distance term; `scene.fogNode` is what three applies and adds the height term.
  const distanceFog = new FogExp2(legacyColor(palette.horizon), distanceDensity());
  scene.fog = distanceFog;
  scene.fogNode = heightFogNode(distanceFog, HEIGHT_FOG, SUN_DIRECTION);
}
