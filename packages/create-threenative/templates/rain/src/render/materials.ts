// Generated for you. This file owns the coast's surface decisions that are worth a name.
//
// The coast is one ray-marched shader, so its materials are colours the march reads rather than
// Three material objects. The ones a storm is recognised by are here; the rest of the albedos
// (moss, conifers, asphalt, paint) sit in `tools/tempest-world.frag` beside the shapes they colour.
import { Color } from "three";
import { palette } from "./palette.js";
import * as world from "./world-shader.js";

/** How bright the lamp heads burn: the study's own HDR colour, far above 1 so they bloom. */
const LAMP_GLOW = { b: 0.72, g: 2.75, r: 6 } as const;

export function setupMaterials(): void {
  const lamp = new Color(palette.lamp);
  world.uLampLight.value.set(lamp.r, lamp.g, lamp.b);
  world.uLampGlow.value.set(LAMP_GLOW.r, LAMP_GLOW.g, LAMP_GLOW.b);
  const water = new Color(palette.water);
  world.uWater.value.set(water.r, water.g, water.b);
}
