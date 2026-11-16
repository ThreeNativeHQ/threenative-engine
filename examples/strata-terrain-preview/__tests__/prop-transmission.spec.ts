import { float, vec3 } from "three/tsl";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { describe, expect, it } from "vitest";
import { lightNeedles } from "../src/render/props/propMaterials.js";

/**
 * One look for thin-needle transmission on both engines.
 *
 * Three's branch adds the albedo-scaled, occlusion-gated transmission to the sun's direct term. The
 * owned engine has no `setupLightingModel` hook, so the same node goes into the emissive. Two Sided
 * Foliage (PRD-643) is not the engine's stand-in: its transmittance is one uniform colour, neither
 * albedo-scaled nor gated by the card's facing, and it lifted the Strata forest's canopy by 2x over
 * upstream three at the overview pose (canopy 90/108/66 with it, 51/70/55 with the term cleared,
 * three 45/62/52; the forest's own captures: ~/.cache/tmp-tn/strata-refactor/captures/x6-forest).
 */
describe("thin-needle transmission", () => {
  it("lands in the emissive on the owned engine, and turns no material into Two Sided Foliage", () => {
    const engine = { colorNode: vec3(0.09, 0.24, 0.11) } as unknown as MeshStandardNodeMaterial;
    lightNeedles(engine, float(1));
    expect(engine.twoSidedFoliage).toBeUndefined();
    expect(engine.emissiveNode).not.toBeNull();
  });

  it("keeps three's lighting-model hook, so the transmission sits under the sun's own shadow", () => {
    const material = new MeshStandardNodeMaterial();
    material.colorNode = vec3(0.09, 0.24, 0.11);
    lightNeedles(material, float(1));
    expect(material.twoSidedFoliage).toBeUndefined();
    expect(typeof material.setupLightingModel).toBe("function");
    expect(material.emissiveNode).not.toBeNull();
  });
});
