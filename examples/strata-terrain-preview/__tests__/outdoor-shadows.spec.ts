import { VirtualShadowNode } from "@threenative/core";
import { PerspectiveCamera } from "three";
import { expect, it } from "vitest";
import { BIOMES } from "../src/render/biomes.js";
import { createOutdoorSky } from "../src/render/sky.js";

it.each(Object.values(BIOMES))("sets $world shadow contact bias as intended", (biome) => {
  const sky = createOutdoorSky(new PerspectiveCamera(), biome);
  const shadows = sky.sun.shadow.shadowNode;
  expect(shadows).toBeInstanceOf(VirtualShadowNode);
  const { clipExtents, mapSize, receiverPlaneBias } = (shadows as VirtualShadowNode).options;
  expect(sky.sun.shadow.bias).toBe(0);
  expect(sky.sun.shadow.radius).toBe(biome.sun.shadowRadius);
  if (biome.world === "coastal") {
    // Coastal stones showed a lit rim: one fine texel of normal bias and no footprint-wide slope bias.
    expect(sky.sun.shadow.normalBias).toBe((2 * (clipExtents[0] ?? 0)) / mapSize);
    expect(receiverPlaneBias).toBe(false);
  } else {
    // Other worlds keep their judged look until ground-level close-ups prove a change.
    expect(sky.sun.shadow.normalBias).toBe(0.035);
    expect(receiverPlaneBias).toBe(true);
  }
  shadows?.dispose();
  sky.sun.dispose();
  sky.daylight.sun.shadow.shadowNode?.dispose();
  sky.daylight.sun.dispose();
});
