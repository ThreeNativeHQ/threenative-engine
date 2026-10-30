// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// The sky is Unreal 5.8.3's default level: a Sky Atmosphere with its volumetric cloud layer, a sky
// light that captures it, a sun tinted by the air it crosses, and an exponential height fog that
// takes its colour from the sky (`atmosphere.ts`, `clouds.ts`, `gpuSky.ts`). Sun, sky and fog read
// one illuminance, so moving the sun recolours all three together, as in Unreal.
//
// Override: `SKY_OPTIONS.sky = "photo"` draws `assets/sky.jpg` instead — Poly Haven's "Kloofendal 48d
// Partly Cloudy (Pure Sky)" by Greg Zaal and Jarod Guest, CC0
// (https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky) — as background, environment and
// fog colour, with the sun aimed at its photographed sun. `clouds: false` keeps a clear sky.
import {
  EquirectangularReflectionMapping,
  FogExp2,
  SRGBColorSpace,
  type Scene,
  type Texture,
  Vector3,
} from "three";
import { createGpuSky } from "./gpuSky.js";
import { HEIGHT_FOG, type HeightFogParams, heightFogDepth, heightFogNode } from "./heightFog.js";
import { palette } from "./palette.js";

export const SKY_OPTIONS: { sky: "atmosphere" | "photo"; clouds: boolean } = {
  sky: "atmosphere",
  clouds: true,
};

/** Unit vector toward the sun: 47.9° up. Move it and the sky, the sun colour and the fog follow. */
export const SUN_DIRECTION = new Vector3(0.555, 0.742, 0.38).normalize();

/**
 * Unreal's default level fog in metres: its density and falloff are per 1000 cm (x0.1 per metre), and
 * its line integral carries ln2 against the exact integral `heightFog.ts` evaluates. `fogHeight` sits
 * 68.5 m below the floor, where the default level puts the fog actor. Inscattering is black and the
 * start distance 0, as in Unreal: the colour comes from the sky.
 */
const ATMOSPHERE_FOG: HeightFogParams = {
  ...HEIGHT_FOG,
  density: 0.00436 * Math.LN2,
  heightFalloff: 0.02,
  fogHeight: -68.5,
  startDistance: 0,
};

/** White in the 8-bit environment is this much scene radiance (`createGpuSky`). */
const ENVIRONMENT_RANGE = 4;

/** Photo sky only: how the JPEG was made from the 4k HDR (linear radiance x 0.4, clipped). */
const PHOTO_RANGE = 2.5;

/** Photo sky only: FogExp2 at 0.003 read as 18% haze at 150 m from 2 m up. */
const EYE_LEVEL = { density: 0.003, distance: 150, cameraHeight: 2 };

function photoDistanceDensity(p: HeightFogParams): number {
  const { distance, density, cameraHeight } = EYE_LEVEL;
  const old = (density * distance) ** 2;
  const height = heightFogDepth(p, cameraHeight, cameraHeight, distance) * Math.LN2;
  return Math.sqrt(Math.max(0, old - height)) / distance;
}

function setupPhotoSky(scene: Scene, photo: Texture, software: boolean): void {
  SUN_DIRECTION.set(0.555, 0.742, 0.38).normalize();
  photo.mapping = EquirectangularReflectionMapping;
  photo.colorSpace = SRGBColorSpace;
  scene.background = photo;
  scene.backgroundIntensity = PHOTO_RANGE;
  // Not on a software adapter: PMREM-filtering a 4096x2048 photo trips a CPU rasteriser's watchdog.
  if (!software) {
    scene.environment = photo;
    scene.environmentIntensity = PHOTO_RANGE;
  }
  const params: HeightFogParams = { ...HEIGHT_FOG };
  const distanceFog = new FogExp2(palette.skyLow, photoDistanceDensity(params));
  scene.fog = distanceFog;
  scene.fogNode = heightFogNode(distanceFog, params, SUN_DIRECTION);
}

/**
 * `photo` is only read when `SKY_OPTIONS.sky` is "photo". `fogged` false leaves the sky unfogged;
 * `clouds` false draws the clear atmosphere.
 */
export function setupSky(
  scene: Scene,
  photo?: Texture,
  software = false,
  fogged = true,
  clouds = SKY_OPTIONS.clouds,
): void {
  if (SKY_OPTIONS.sky === "photo") {
    if (photo === undefined) throw new Error('SKY_OPTIONS.sky "photo" needs assets/sky.jpg loaded');
    setupPhotoSky(scene, photo, software);
    return;
  }
  // Height fog only; FogExp2 holds the colour `heightFogNode` reads, at zero density. `createGpuSky`
  // sets that colour from the sky and again whenever the sun moves.
  const fog = new FogExp2(0xffffff, 0);
  scene.fog = fog;
  scene.fogNode = heightFogNode(fog, { ...ATMOSPHERE_FOG }, SUN_DIRECTION);
  const { node, environment } = createGpuSky(scene, SUN_DIRECTION, fogged, clouds, ATMOSPHERE_FOG);
  environment.mapping = EquirectangularReflectionMapping;
  environment.colorSpace = SRGBColorSpace;
  // The analytic sky with its sun disc; a software adapter draws the 64 x 32 bake instead, with no
  // LUT or cloud passes at all.
  scene.background = environment;
  scene.backgroundNode = software ? null : node.backgroundNode;
  scene.backgroundIntensity = software ? ENVIRONMENT_RANGE : 1;
  // Unreal's sky light: the same sky, so the fill on every shaded face is the sky's colour.
  scene.environment = environment;
  scene.environmentIntensity = ENVIRONMENT_RANGE;
}
