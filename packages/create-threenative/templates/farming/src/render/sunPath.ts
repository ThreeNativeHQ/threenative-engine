// The sun's path across the farm, as a function of the day clock. Plain maths: no Three.js state.
//
// The sun rises in the east (+x), crosses the south (+z, behind the camera, so the field is lit
// from the front and its shadows fall away from the viewer) and sets in the west. Below the
// horizon it carries on round the north, so the same function gives the night's moon position
// (the opposite direction).
import type { Vector3 } from "three";

const SUNRISE_HOUR = 5.5;
const SUNSET_HOUR = 18.5;
/** The noon elevation, radians: 62 degrees, a summer sun. */
const NOON_ELEVATION = (62 * Math.PI) / 180;

/** Phase of the sun's arc: 0 at sunrise, 1 at sunset, 2 at the next sunrise. */
function arc(minute: number): number {
  return (minute / 60 - SUNRISE_HOUR) / (SUNSET_HOUR - SUNRISE_HOUR);
}

/** Elevation above the horizon in radians; negative at night. */
export function sunElevation(minute: number): number {
  return NOON_ELEVATION * Math.sin(Math.PI * arc(minute));
}

/** The unit vector toward the sun at `minute`, written into `out`. */
export function sunDirectionAt(minute: number, out: Vector3): Vector3 {
  const azimuth = Math.PI * arc(minute);
  const elevation = sunElevation(minute);
  const flat = Math.cos(elevation);
  return out
    .set(Math.cos(azimuth) * flat, Math.sin(elevation), Math.sin(azimuth) * flat)
    .normalize();
}
