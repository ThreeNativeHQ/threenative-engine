// The day clock's light: the sun and the moon follow `minute`.
//
// The sky bakes once, for a late-morning sun (`sky.ts`). A later environment update left the
// renderer drawing no frames, and a new sun costs a 45 ms bake anyway. So the clock moves only
// cheap things each frame: the directional light (sun, then moon), the strength of the sky's fill,
// and the sky's backdrop. Auto exposure then lifts the dim night to a readable moonlit frame.
import { Color, type DirectionalLight, MathUtils, type Scene, Vector3 } from "three";
import {
  SUN_ILLUMINANCE,
  SUN_KELVIN,
  sunLightTransmittance,
  temperatureColour,
} from "./atmosphere.js";
import { LIGHT_DISTANCE } from "./lighting.js";
import { sunDirectionAt, sunElevation } from "./sunPath.js";

/** The moon's light against the sun's 6 lux, and its colour. */
const MOON_ILLUMINANCE = 0.1;
const MOON_COLOUR = new Color(0x9db4ff);
/** The sky's fill and backdrop at night, as a share of their daylight strength. */
const NIGHT_SKY = 0.12;
/** `sky.ts` sets the fill to this multiple of the baked sky (`ENVIRONMENT_RANGE`). */
const DAY_FILL = 4;

const _sun = new Vector3();
const _tint = new Color();
const sunTint = temperatureColour(SUN_KELVIN);

/**
 * Light the farm for `minute`: aim and colour the key light, and dim the sky with the sun.
 * Cheap enough for every frame: it bakes nothing.
 */
export function applyDaylight(
  minute: number,
  key: DirectionalLight,
  centre: Vector3,
  scene: Scene,
): void {
  const direction = sunDirectionAt(minute, _sun);
  const elevation = sunElevation(minute);
  // Full sun from about 6 degrees up, none below -2 degrees: the horizon fades the light out.
  const sunUp = MathUtils.smoothstep(elevation, -0.035, 0.1);
  const sunPower = SUN_ILLUMINANCE * sunUp;
  const moonPower = MOON_ILLUMINANCE * (1 - sunUp);
  if (sunPower >= moonPower) {
    const lit = sunLightTransmittance(Math.max(0.02, elevation));
    key.color.setRGB(
      (sunTint[0] ?? 1) * lit[0],
      (sunTint[1] ?? 1) * lit[1],
      (sunTint[2] ?? 1) * lit[2],
    );
    key.intensity = sunPower;
    key.position.copy(direction).multiplyScalar(LIGHT_DISTANCE).add(centre);
  } else {
    key.color.copy(_tint.copy(MOON_COLOUR));
    key.intensity = moonPower;
    key.position.copy(direction).multiplyScalar(-LIGHT_DISTANCE).add(centre);
  }
  key.target.position.copy(centre);
  key.target.updateMatrixWorld();
  const sky = MathUtils.lerp(NIGHT_SKY, 1, sunUp);
  scene.environmentIntensity = DAY_FILL * sky;
  scene.backgroundIntensity = sky;
}
