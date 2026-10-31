// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// The default sky is Unreal 5.8.3's default level: a Sky Atmosphere with its volumetric cloud layer, a
// sky light that captures it, a sun tinted by the air it crosses, and an exponential height fog that
// takes its colour from the sky (`atmosphere.ts`, `clouds.ts`, `gpuSky.ts`). Sun, sky and fog read one
// illuminance, so moving `SUN_DIRECTION` recolours all three together. `SKY_OPTIONS.sky = "photo"`
// keeps the photograph below; `clouds: false` keeps a clear sky.
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
import { createGpuSky } from "./gpuSky.js";
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

function setupPhotoSky(scene: Scene, sky: Texture): void {
  sky.mapping = EquirectangularReflectionMapping;
  sky.colorSpace = SRGBColorSpace;
  scene.background = sky;
  scene.backgroundIntensity = SKY_RANGE;
  // three prefilters an equirectangular `scene.environment` itself (PMREM), on WebGPU and WebGL.
  // It is what makes a standard material read as a material: sky-blue fill on faces the sun
  // misses, and a sky to reflect, sharper as roughness drops.
  scene.environment = sky;
  scene.environmentIntensity = SKY_RANGE;
  // The track runs to a hundred-odd metres of fog, and the ground goes into the photograph by a
  // kilometre, so the far chunks hand over to the sky rather than ending at a line. The colour is
  // the photograph's own horizon, so the fade lands where the sky is.
  // `scene.fog` stays the distance term; `scene.fogNode` is what three applies and adds the height term.
  const distanceFog = new FogExp2(palette.horizon, distanceDensity());
  scene.fog = distanceFog;
  scene.fogNode = heightFogNode(distanceFog, HEIGHT_FOG, SUN_DIRECTION);
}

export const SKY_OPTIONS: { sky: "atmosphere" | "photo"; clouds: boolean; ground: boolean } = {
  sky: "atmosphere",
  clouds: true,
  // The sunlit ground below the horizon stands in for Unreal's Lumen floor bounce: it lifts shadow
  // sides and a mirror reflects it. Set false when the game adds its own global illumination.
  ground: true,
};

/**
 * Unreal's default level fog in metres: density and falloff are per 1000 cm (x0.1 per metre), and its
 * line integral carries ln2 against the exact integral `heightFog.ts` evaluates. `fogHeight` sits
 * 68.5 m below the floor, where the default level puts the fog actor. Inscattering is black and the
 * start distance 0, as in Unreal: the colour comes from the sky.
 */
const ATMOSPHERE_FOG = {
  ...HEIGHT_FOG,
  density: 0.00436 * Math.LN2,
  heightFalloff: 0.02,
  fogHeight: -68.5,
  startDistance: 0,
};

/** White in the 8-bit environment is this much scene radiance (`createGpuSky`). */
const ENVIRONMENT_RANGE = 4;

/**
 * `photo` is only read when `SKY_OPTIONS.sky` is "photo". `fogged` false leaves the sky unfogged;
 * `clouds` false draws the clear atmosphere. A software adapter draws the 64 x 32 bake as the
 * background, with no LUT or cloud passes.
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
    setupPhotoSky(scene, photo);
    return;
  }
  // Height fog only; FogExp2 holds the colour `heightFogNode` reads, at zero density. `createGpuSky`
  // sets that colour from the sky and again whenever the sun moves.
  const fog = new FogExp2(0xffffff, 0);
  scene.fog = fog;
  scene.fogNode = heightFogNode(fog, { ...ATMOSPHERE_FOG }, SUN_DIRECTION);
  const { node, environment } = createGpuSky(
    scene,
    SUN_DIRECTION,
    fogged,
    clouds,
    ATMOSPHERE_FOG,
    SKY_OPTIONS.ground,
  );
  environment.mapping = EquirectangularReflectionMapping;
  environment.colorSpace = SRGBColorSpace;
  scene.background = environment;
  scene.backgroundNode = software ? null : node.backgroundNode;
  scene.backgroundIntensity = software ? ENVIRONMENT_RANGE : 1;
  // Unreal's sky light: the same sky, so the fill on every shaded face is the sky's colour.
  scene.environment = environment;
  scene.environmentIntensity = ENVIRONMENT_RANGE;
}
