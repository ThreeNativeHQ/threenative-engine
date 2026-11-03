import { readFileSync } from "node:fs";
import { Color, DoubleSide, MeshPhysicalMaterial, MeshStandardMaterial, Texture } from "three";
import { describe, expect, it } from "vitest";
import { noSpecularTwin } from "../unreal-look/scaffold/render/specular.js";

/** The source a calibration scene's glb gives a surface: MI_White, the map of a textured slot, a masked leaf card. */
function source(): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    color: new Color(0.73, 0.73, 0.73),
    map: new Texture(),
    roughness: 1,
    side: DoubleSide,
  });
  material.name = "MI_White";
  return material;
}

describe("?specular=0, the harness's ShowFlag.Specular (PRD-646 round 7)", () => {
  it("zeroes F0 and leaves F90 at 1, the pair Unreal's SpecularColor override reads", () => {
    const twin = noSpecularTwin(source());
    expect(twin).toBeInstanceOf(MeshPhysicalMaterial);
    // F0 = min(((ior - 1) / (ior + 1))^2 * specularColor, 1) * specularIntensity, F90 = mix(specularIntensity, 1, metalness).
    const f0 =
      ((twin.ior - 1) / (twin.ior + 1)) ** 2 * twin.specularColor.r * twin.specularIntensity;
    expect(f0).toBe(0);
    expect(twin.ior).toBe(1);
    expect(twin.specularIntensity).toBe(1);
    // F_Schlick(F0, F90, VoH) keeps a grazing lobe at F0 = 0, which is what the flag leaves in place.
    expect(twin.specularIntensity).toBe(1);
    expect(twin.metalness).toBe(0);
  });

  it("keeps every field the frame is drawn with: the albedo, the map, the roughness, the sides and the name", () => {
    const from = source();
    const twin = noSpecularTwin(from);
    expect(twin.color.getHex()).toBe(from.color.getHex());
    expect(twin.map).toBe(from.map);
    expect(twin.roughness).toBe(from.roughness);
    expect(twin.side).toBe(from.side);
    // The glTF material name is what pairs a slot with its texture and its Unreal model.
    expect(twin.name).toBe("MI_White");
  });

  it("carries the two markers three does not declare, so a foliage slot stays a foliage slot", () => {
    const from = source();
    from.twoSidedFoliage = true;
    from.subsurfaceColor = new Color(0.1, 0.2, 0.3);
    const twin = noSpecularTwin(from);
    expect(twin.twoSidedFoliage).toBe(true);
    expect((twin.subsurfaceColor as Color).getHex()).toBe(new Color(0.1, 0.2, 0.3).getHex());
  });

  it("is wired to both scenes' queries, so the knob cannot land as dead code", () => {
    // A template-lit scene (sunlit-room) is drawn by Reference.ts, every other calibration scene by
    // CalibrationScene.ts: a knob in one of them is half a knob.
    for (const scene of ["CalibrationScene", "Reference"]) {
      const source = readFileSync(`scripts/unreal-look/scaffold/${scene}.ts.in`, "utf8");
      expect(source).toMatch(/if \(params\.get\("specular"\) === "0"\)/u);
      expect(source).toMatch(/noSpecularTwin\(/u);
    }
  });
});
