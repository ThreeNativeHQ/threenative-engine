// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// The default sky is Unreal 5.8.3's default level: a Sky Atmosphere with its volumetric cloud layer, a
// sky light that captures it, a sun tinted by the air it crosses, and an exponential height fog that
// takes its colour from the sky (`atmosphere.ts`, `clouds.ts`, `gpuSky.ts`). Sun, sky and fog read one
// illuminance, so moving `SUN_DIRECTION` recolours all three together. `clouds: false` keeps a clear
// sky. This kit sets the sun low: a late-evening sun leaves most of every room in the shadow of its
// own walls, and the lamps in `mansion.ts` carry the light where the survivor walks.
import {
  EquirectangularReflectionMapping,
  FogExp2,
  SRGBColorSpace,
  type Scene,
  Vector3,
} from "three";
import { createGpuSky } from "./gpuSky.js";
import { HEIGHT_FOG, heightFogNode } from "./heightFog.js";
import { palette } from "./palette.js";

/** Unit vector toward the sun: about 17° up, low in the west-south-west. */
export const SUN_DIRECTION = new Vector3(-0.62, 0.22, 0.42).normalize();

export const SKY_OPTIONS: { clouds: boolean; ground: boolean } = {
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
 * `fogged` false leaves the sky unfogged;
 * `clouds` false draws the clear atmosphere. A software adapter draws the 64 x 32 bake as the
 * background, with no LUT or cloud passes.
 */
export function setupSky(
  scene: Scene,
  software = false,
  fogged = true,
  clouds = SKY_OPTIONS.clouds,
): void {
  // Height fog only; FogExp2 holds the colour `heightFogNode` reads, at zero density. `createGpuSky`
  // sets that colour from the sky and again whenever the sun moves.
  const fog = new FogExp2(palette.fogHolder, 0);
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
