// The day clock's light: the sky, the sun and the moon follow `minute`.
//
// The sky costs a 45 ms CPU bake per sun position, far too much for the frame the clock moves it.
// So a day is a dozen keyframes baked while the loading screen shows, and the sky mixes the two
// either side of the clock. The visible atmosphere (the sun disc, the sky colour) still follows
// the exact sun through the GPU lookup tables. The directional light is exact every frame.
import { Color, type DirectionalLight, MathUtils, Vector3 } from "three";
import {
  SUN_ILLUMINANCE,
  SUN_KELVIN,
  sunLightTransmittance,
  temperatureColour,
  viewDistanceSkyLight,
} from "./atmosphere.js";
import { type ISkyBlend, SKY_HEIGHT, SKY_WIDTH, bakedRadiance } from "./gpuSky.js";
import { LIGHT_DISTANCE } from "./lighting.js";
import { SUN_DIRECTION } from "./sky.js";
import { sunDirectionAt, sunElevation } from "./sunPath.js";

/** Keyframes a day: one every two hours, the last one wrapping to the first. */
const KEYS = 12;
const KEY_MINUTES = 1440 / KEYS;
/** The moon's light against the sun's 6 lux, and its colour. */
const MOON_ILLUMINANCE = 0.1;
const MOON_COLOUR = new Color(0x9db4ff);
/** Move the visible sun only after this many minutes, so the sky lookup tables rebuild a few times a second. */
const SKY_STEP = 2;

interface IKey {
  readonly radiance: Float32Array;
  readonly light: readonly [number, number, number];
}

const keys: IKey[] = [];
const _sun = new Vector3();
const _tint = new Color();
const sunTint = temperatureColour(SUN_KELVIN);

/**
 * Bake the day's keyframes, one per task so the loading screen keeps drawing. A second call is
 * free: the keyframes stay for the page's lifetime.
 */
export async function prewarmDay(clouds: boolean, ground: boolean): Promise<void> {
  for (let index = keys.length; index < KEYS; index += 1) {
    const sun = sunDirectionAt(index * KEY_MINUTES, new Vector3());
    keys.push({
      light: viewDistanceSkyLight(sun),
      radiance: bakedRadiance(sun, SKY_WIDTH, SKY_HEIGHT, ground, clouds),
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

/** The sky at the clock's minute: the mix of the two keyframes around it. `clock.minute` is live. */
export function createSkyBlend(clock: { readonly minute: number }): ISkyBlend {
  const out = new Float32Array(SKY_WIDTH * SKY_HEIGHT * 3);
  const position = (): { a: IKey; b: IKey; mix: number } => {
    const at = (((clock.minute % 1440) + 1440) % 1440) / KEY_MINUTES;
    const first = Math.floor(at) % KEYS;
    return {
      a: keys[first] as IKey,
      b: keys[(first + 1) % KEYS] as IKey,
      mix: at - Math.floor(at),
    };
  };
  return {
    radiance: () => {
      const { a, b, mix } = position();
      for (let i = 0; i < out.length; i += 1)
        out[i] = (a.radiance[i] ?? 0) + ((b.radiance[i] ?? 0) - (a.radiance[i] ?? 0)) * mix;
      return out;
    },
    skyLight: () => {
      const { a, b, mix } = position();
      return [
        MathUtils.lerp(a.light[0], b.light[0], mix),
        MathUtils.lerp(a.light[1], b.light[1], mix),
        MathUtils.lerp(a.light[2], b.light[2], mix),
      ];
    },
  };
}

let skyMinute = Number.NaN;

/**
 * Point the key light at the sun or, once the sun is down, at the moon, and move the sky's sun.
 * Call it every frame with the clock's minute; it keeps the sky's sun still between steps.
 */
export function applyDaylight(minute: number, key: DirectionalLight, centre: Vector3): void {
  if (!(Math.abs(minute - skyMinute) < SKY_STEP)) {
    skyMinute = minute;
    sunDirectionAt(minute, SUN_DIRECTION);
  }
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
}
