// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// The sky is a photograph: `assets/sky.jpg`, Poly Haven's "Kloofendal 48d Partly Cloudy (Pure Sky)"
// by Greg Zaal and Jarod Guest, CC0 (https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky).
// The same image is the background, the environment light every surface reflects and is filled by,
// and — through `SUN_DIRECTION` — the direction the sun's shadows fall. Swap the file for any
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
import { palette } from "./palette.js";

/**
 * How the JPEG was made from the 4k HDR: linear radiance × 0.4, clipped, sRGB-encoded — so white
 * in the file is 2.5 in the sky. Multiplying back restores the HDR brightness of the clouds; the sun
 * disk itself is clipped, which is why the sun is a light (`lighting.ts`) and not a texel.
 */
const SKY_RANGE = 2.5;

/** Unit vector toward the photographed sun: 47.9° up, measured from the source HDR. */
export const SUN_DIRECTION = new Vector3(0.555, 0.742, 0.38).normalize();

/** The look this fog replaced: FogExp2 at 0.003, which read as 18% haze at 150 m from 2 m up. */
const EYE_LEVEL = { density: 0.003, distance: 150, cameraHeight: 2 };

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

export function setupSky(scene: Scene, sky: Texture, software = false): void {
  sky.mapping = EquirectangularReflectionMapping;
  sky.colorSpace = SRGBColorSpace;
  scene.background = sky;
  scene.backgroundIntensity = SKY_RANGE;
  // three prefilters an equirectangular `scene.environment` itself (PMREM), on WebGPU and WebGL.
  // It is what makes a standard material read as a material: sky-blue fill on faces the sun
  // misses, and a sky to reflect, sharper as roughness drops.
  //
  // Not on a software adapter. PMREM-filtering a 4096x2048 photo keeps a CPU rasteriser's GPU
  // process busy past its watchdog and the next pipeline compiles die with the device (measured on
  // four cores: a 28 s hitch and two failed pipelines with it on, 37 pipelines in 11 s with it
  // off). That lane is not render evidence, so it gives up the fill light.
  if (!software) {
    scene.environment = sky;
    scene.environmentIntensity = SKY_RANGE;
  }
  // Almost nothing inside the arena (1.4% at 30 m), and the ground gone into the horizon by a
  // kilometre — so the floor meets the sky instead of ending at a line. The colour is the
  // photograph's own horizon, sampled from the same HDR, so the fade lands where the sky is.
  // `scene.fog` stays the distance term for anything that reads it; `scene.fogNode` is what three
  // applies, and it adds the height term. One owner at a time: `STARTER_MIST` clears both.
  const params: HeightFogParams = { ...HEIGHT_FOG };
  const distanceFog = new FogExp2(palette.skyLow, distanceDensity(params));
  scene.fog = distanceFog;
  scene.fogNode = heightFogNode(distanceFog, params, SUN_DIRECTION);
}
