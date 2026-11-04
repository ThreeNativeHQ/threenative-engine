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

describe("?specular, the harness's ShowFlag.Specular (PRD-646 rounds 7-8)", () => {
  it("zeroes F0 and F90 together, which is what Unreal's flag does", () => {
    const twin = noSpecularTwin(source());
    expect(twin).toBeInstanceOf(MeshPhysicalMaterial);
    // F0 = min(((ior - 1) / (ior + 1))^2 * specularColor, 1) * specularIntensity, F90 = mix(specularIntensity, 1, metalness).
    const f0 =
      ((twin.ior - 1) / (twin.ior + 1)) ** 2 * twin.specularColor.r * twin.specularIntensity;
    expect(f0).toBe(0);
    expect(twin.ior).toBe(1);
    // Unreal: the flag writes F0 = 0 into the G-buffer (BasePassPixelShader.usf:1280, Substrate.ush:3438), and
    // the slab then collapses F90 as well (SubstrateEvaluation.ush:488): F90 *= saturate(50 * F0) is 0 at F0 = 0.
    // Both halves of F_Schlick(F0, F90, VoH) are therefore 0 and the whole lobe goes, at every angle.
    expect(twin.specularIntensity).toBe(0);
    expect(twin.metalness).toBe(0);
  });

  it("keeps round 7's F0-only ablation on its own name, so its recorded arms stay reproducible", () => {
    const twin = noSpecularTwin(source(), true);
    const f0 =
      ((twin.ior - 1) / (twin.ior + 1)) ** 2 * twin.specularColor.r * twin.specularIntensity;
    expect(f0).toBe(0);
    // F_Schlick(0, 1, VoH) = (1 - VoH)^5: the grazing lobe round 7's twin left in place.
    expect(twin.specularIntensity).toBe(1);
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
      expect(source).toMatch(/const specular = params\.get\("specular"\)/u);
      expect(source).toMatch(/if \(specular !== null\)/u);
      expect(source).toMatch(/noSpecularTwin\(m[^)]*, specular === "f0"\)/u);
    }
  });
});
