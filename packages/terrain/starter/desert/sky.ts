// The desert world's daylight: the engine's sun, sky, fill, haze and tone curve, every value this world's.
// Edit any number here to change the look. Nothing in a package decides it.
import { Daylight } from "@threenative/core";
import { ACESFilmicToneMapping, Color, type Object3D, Vector3 } from "three";

export function desertDaylight(follow: Object3D): Daylight {
  return new Daylight({
    follow,
    // Mid-morning sun from the south-east, high enough for short readable shadows under the boulders.
    sunDirection: new Vector3(0.55, 0.62, 0.56),
    sunColor: new Color(0xfff1dc),
    sunIntensity: 3.2,
    shadowExtents: [24, 96, 320],
    sky: { turbidity: 2, rayleigh: 3, mieCoefficient: 0.003, mieDirectionalG: 0.82 },
    fill: { sky: new Color(0xa8c8e8), ground: new Color(0x464937), intensity: 0.62 },
    // Enough air that the 512 m world's far edge fades instead of ending on a hard line.
    haze: { color: new Color(0x9fb4c2), density: 0.0016 },
    exposure: 2 ** -0.38,
    toneMapping: ACESFilmicToneMapping,
    // The box's corners must stay inside the camera's far plane (5000 m in the kit's example scene).
    skySize: 5000,
  });
}
