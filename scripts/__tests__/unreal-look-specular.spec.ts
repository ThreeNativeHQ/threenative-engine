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
  it("zeroes F0 and F90 so no direct or indirect specular term is left", () => {
    const twin = noSpecularTwin(source());
    expect(twin).toBeInstanceOf(MeshPhysicalMaterial);
    // F0 = min(((ior - 1) / (ior + 1))^2 * specularColor, 1) * specularIntensity, F90 = mix(specularIntensity, 1, metalness).
    expect(twin.specularIntensity).toBe(0);
    expect(twin.specularColor.getHex()).toBe(0x000000);
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

  it("is wired to the calibration scene's query, so the knob cannot land as dead code", () => {
    const scene = readFileSync("scripts/unreal-look/scaffold/CalibrationScene.ts.in", "utf8");
    expect(scene).toMatch(/if \(params\.get\("specular"\) === "0"\)/u);
    expect(scene).toMatch(/noSpecularTwin\(/u);
  });
});
