// Photometric exposure plumbing (PRD-632). The values — which EV100, which sun lux — are the
// game's and live in its `src/render/`; this file only converts between the units.
//
// Saturation-based exposure for a sensor at ISO 100 (ISO 2720, as used by Lagarde and de
// Rousiers, "Moving Frostbite to PBR", 2014): the luminance that saturates the sensor is
// 1.2 * 2^EV100 cd/m², so scaling scene luminance by its reciprocal maps that luminance to 1.
// Reflected-light metering uses the calibration constant K = 12.5.

const SATURATION = 1.2;
const METER_CALIBRATION = 12.5;

/** The renderer multiplier for an exposure value at ISO 100.
 * @situation expose a frame lit in lux and nits with a physical camera exposure value
 * @constraint ev100 must be finite; a unitless scene keeps its own multiplier instead
 * @example renderer.toneMappingExposure = exposureFromEv100(14.5);
 */
export function exposureFromEv100(ev100: number): number {
  if (!Number.isFinite(ev100))
    throw new RangeError(`exposureFromEv100: ev100 ${ev100} is not finite`);
  return 1 / (SATURATION * 2 ** ev100);
}

/** The exposure value at ISO 100 that a renderer multiplier stands for.
 * @situation report a hand-set exposure multiplier as an EV100
 * @constraint multiplier must be finite and greater than zero
 * @example const ev = ev100FromExposure(renderer.toneMappingExposure);
 */
export function ev100FromExposure(multiplier: number): number {
  if (!(multiplier > 0) || !Number.isFinite(multiplier))
    throw new RangeError(`ev100FromExposure: multiplier ${multiplier} must be finite and > 0`);
  return -Math.log2(SATURATION * multiplier);
}

/** The exposure value at ISO 100 of a physical camera: aperture f-number, shutter seconds, ISO.
 * @situation expose like a camera with an aperture, a shutter time and an ISO
 * @constraint every argument must be finite and greater than zero
 * @example const ev = ev100FromCamera(4, 1 / 60, 100); // 9.91
 */
export function ev100FromCamera(aperture: number, shutterSeconds: number, iso: number): number {
  for (const [name, value] of [
    ["aperture", aperture],
    ["shutterSeconds", shutterSeconds],
    ["iso", iso],
  ] as const)
    if (!(value > 0) || !Number.isFinite(value))
      throw new RangeError(`ev100FromCamera: ${name} ${value} must be finite and > 0`);
  return Math.log2(((aperture * aperture) / shutterSeconds) * (100 / iso));
}

/** The exposure value at ISO 100 that a reflected-light meter reads for an average luminance.
 * @situation meter a frame's average luminance in cd/m² into an exposure value
 * @constraint luminance must be finite and greater than zero
 * @example const ev = ev100FromLuminance(averageNits);
 */
export function ev100FromLuminance(luminance: number): number {
  if (!(luminance > 0) || !Number.isFinite(luminance))
    throw new RangeError(`ev100FromLuminance: luminance ${luminance} must be finite and > 0`);
  return Math.log2((luminance * 100) / METER_CALIBRATION);
}
