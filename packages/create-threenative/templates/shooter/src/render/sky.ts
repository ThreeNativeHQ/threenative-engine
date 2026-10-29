// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// The sky is a photograph: `assets/sky.jpg`, Poly Haven's "Kloofendal 48d Partly Cloudy (Pure Sky)"
// by Greg Zaal and Jarod Guest, CC0 (https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky).
// The same image is the background, the environment light every surface reflects and is filled by,
// and — through `SUN_DIRECTION` — the direction the sun's shadows fall. Swap the file for any
// equirectangular sky and re-aim `SUN_DIRECTION` at its sun.
import {
  CanvasTexture,
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

/** The look this fog replaced: FogExp2 at 0.003, measured at 150 m from 2 m up. */
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

/**
 * The environment light needs no more than 1024x512 of the 4096x2048 sky: three bakes an
 * equirectangular source into a cube a quarter of its width, so the full image makes a 1024 cube and
 * a bake of about 50 s on a software adapter, longer than the startup hold. Frames then draw with no
 * fill light, and the shade reads black until the bake ends. The 256 cube of this copy lights the
 * matte town the same and bakes in seconds. The background keeps the full image.
 */
const ENVIRONMENT_SIZE = { width: 1024, height: 512 } as const;

function environmentOf(sky: Texture): Texture {
  const cached = sky.userData.environment as Texture | undefined;
  if (cached !== undefined) return cached;
  // A host with no OffscreenCanvas (a unit-test stub) or no drawable 2d context keeps the full image:
  // the bake is only slower.
  if (typeof OffscreenCanvas === "undefined") return sky;
  const canvas = new OffscreenCanvas(ENVIRONMENT_SIZE.width, ENVIRONMENT_SIZE.height);
  const context = canvas.getContext("2d");
  // The native host's OffscreenCanvas answers "2d" with a bare object that cannot draw an image.
  if (context === null || typeof context.drawImage !== "function") return sky;
  context.drawImage(sky.image as CanvasImageSource, 0, 0, canvas.width, canvas.height);
  const environment = new CanvasTexture(canvas);
  environment.mapping = EquirectangularReflectionMapping;
  environment.colorSpace = SRGBColorSpace;
  sky.userData.environment = environment;
  return environment;
}

export function setupSky(scene: Scene, sky: Texture): void {
  sky.mapping = EquirectangularReflectionMapping;
  sky.colorSpace = SRGBColorSpace;
  scene.background = sky;
  // The full range: owner 2026-10-26 prefers the 7b546d6 neutral look to the dimmed 0.65 / 0.55 sky.
  scene.backgroundIntensity = SKY_RANGE;
  // three prefilters an equirectangular `scene.environment` itself (PMREM), on WebGPU and WebGL.
  // It is what makes a standard material read as a material: sky-blue fill on faces the sun
  // misses, and a sky to reflect, sharper as roughness drops.
  scene.environment = environmentOf(sky);
  scene.environmentIntensity = SKY_RANGE;
  // Almost nothing inside the arena (1.4% at 30 m), and the ground plane gone into the horizon by
  // a kilometre — so the floor meets the sky instead of ending at a line.
  // `scene.fog` stays the distance term; `scene.fogNode` is what three applies and adds the height term.
  const distanceFog = new FogExp2(palette.horizon, distanceDensity());
  scene.fog = distanceFog;
  scene.fogNode = heightFogNode(distanceFog, HEIGHT_FOG, SUN_DIRECTION);
}
