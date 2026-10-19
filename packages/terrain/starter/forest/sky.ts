// The forest's daylight: the engine's sun, sky, fill, haze and tone curve, every value this world's.
// Edit any number here to change the look; nothing in a package decides it.
import { Daylight } from "@threenative/core";
import { ACESFilmicToneMapping, Color, type Object3D, Vector3 } from "three";
import { SKY_REFLECTION_LAYER } from "./water.js";

export function forestDaylight(follow: Object3D): Daylight {
  const daylight = new Daylight({
    follow,
    // Mid-morning sun from the south-east, high enough for short readable shadows under the firs.
    sunDirection: new Vector3(0.55, 0.62, 0.56),
    sunColor: new Color(0xfff1dc),
    sunIntensity: 2.6,
    shadowExtents: [24, 96, 320],
    sky: { turbidity: 1.2, rayleigh: 2.4, mieCoefficient: 0.0015, mieDirectionalG: 0.78 },
    fill: { sky: new Color(0xa8c8e8), ground: new Color(0x7a7e5c), intensity: 1.5 },
    // Enough air that the 512 m world's far edge fades instead of ending on a hard line.
    haze: { color: new Color(0x9fb4c2), density: 0.0012 },
    exposure: 2 ** -0.38,
    toneMapping: ACESFilmicToneMapping,
    // The box's corners must stay inside the camera's far plane (5000 m in the kit's example scene).
    skySize: 5000,
  });
  // The lake mirrors the sky: its mirror draws only the layer the sky sits on (see water.ts).
  daylight.sky.layers.enable(SKY_REFLECTION_LAYER);
  return daylight;
}
