import { readFileSync } from "node:fs";
import { BufferGeometry, Color, Group, Mesh, MeshStandardMaterial, Texture, Vector3 } from "three";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { describe, expect, it } from "vitest";
import {
  NUMBER_ARITHMETIC,
  applyDiffuseEnergy,
  diffuseEnergyMode,
  energyPreservation,
  energyPreservingTwin,
  fresnel,
  ggxEnergyLookup,
} from "../unreal-look/scaffold/render/diffuseEnergy.js";

/** A calibration scene's surface (MI_White of `cornell`, from its scene.json: 0.73 grey, roughness 1). */
function source(): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    color: new Color(0.73, 0.73, 0.73),
    roughness: 1,
    metalness: 0,
  });
  material.name = "MI_White";
  return material;
}

const near = (actual: number, expected: number, tolerance: number) =>
  expect(Math.abs(actual - expected)).toBeLessThan(tolerance);

describe("?diffuseEnergy, Unreal's diffuse energy preservation (PRD-646 round 9)", () => {
  it("is Unreal's term by default and three's on its own name", () => {
    expect(diffuseEnergyMode(new URLSearchParams(""))).toBe("unreal");
    expect(diffuseEnergyMode(new URLSearchParams("diffuseEnergy=three"))).toBe("three");
    expect(diffuseEnergyMode(new URLSearchParams("diffuseEnergy=unreal"))).toBe("unreal");
    // A name that is neither fails closed, as ?specular= does.
    expect(() => diffuseEnergyMode(new URLSearchParams("diffuseEnergy=eon"))).toThrow(
      /TN_DIFFUSE_ENERGY/,
    );
  });

  it("reads Unreal's directional albedo at roughness 1 the way its analytic lookup does", () => {
    // GGXEnergyLookup(1, NoV) (ShadingEnergyConservation.ush:74-79) at the two angles round 8 modelled:
    // F = 1 albedo x, and the F90-weighted y.
    const floor = ggxEnergyLookup(NUMBER_ARITHMETIC, 1, 0.287);
    near(floor.x, 0.5837, 0.001);
    near(floor.y, 0.00827, 0.0005);
    const grazing = ggxEnergyLookup(NUMBER_ARITHMETIC, 1, 0.085);
    near(grazing.x, 0.7975, 0.001);
    near(grazing.y, 0.02484, 0.0005);
    // The texture path (:71) holds the same integral: round 8 read 0.0324 and 0.0570 for E on those two rows.
    near(
      energyPreservation(NUMBER_ARITHMETIC, { roughness: 1, noV: 0.287, f0: 0.04, f90: 1 }),
      0.9679,
      0.0005,
    );
    near(
      energyPreservation(NUMBER_ARITHMETIC, { roughness: 1, noV: 0.085, f0: 0.04, f90: 1 }),
      0.9437,
      0.001,
    );
  });

  it("is 4 to 7 times smaller than the pointwise Fresnel three subtracts at a grazing half angle", () => {
    // F_Schlick(0.04, 1, 0.274) = 0.2309, the engine's exp2 form: round 8's `F` on `sun15-window` Ground.
    const threeLoss = fresnel(NUMBER_ARITHMETIC, { f0: 0.04, f90: 1, dotVH: 0.274 });
    near(threeLoss, 0.2309, 0.0002);
    // Unreal loses 5.6% of that same row's diffuse, three 23.1%: the 4.1x the round-8 model measured.
    const unrealLoss =
      1 -
      energyPreservation(NUMBER_ARITHMETIC, {
        roughness: 1,
        noV: 0.085,
        f0: 0.04,
        f90: 1,
      });
    near(unrealLoss, 0.0563, 0.001);
    near(threeLoss / unrealLoss, 4.1, 0.1);
  });

  it("puts the ratio on the albedo, and the twin keeps every other field", () => {
    const twin = energyPreservingTwin(source(), { direction: new Vector3(0.555, 0.742, 0.38) });
    expect(twin).toBeInstanceOf(MeshStandardNodeMaterial);
    expect(twin.color.equals(new Color(0.73, 0.73, 0.73))).toBe(true);
    expect(twin.roughness).toBe(1);
    expect(twin.metalness).toBe(0);
    // (1 - E) / (1 - F) is a node: the albedo is scaled at draw time, per pixel.
    expect(twin.colorNode).not.toBeNull();
  });

  it("carries a base map, and fails closed when the roughness comes from one", () => {
    // `neon-corridor` MI_Brick is the one mapped slot of the six scenes: its albedo stays its texel x colour.
    const mapped = source();
    mapped.map = new Texture();
    const twin = energyPreservingTwin(mapped, { direction: new Vector3(0, 1, 0) });
    expect(twin).toBeInstanceOf(MeshStandardNodeMaterial);
    expect(twin.colorNode).not.toBeNull();
    expect(twin.map).toBe(mapped.map);
    // A roughness map would make the formula's one roughness per surface wrong: that fails closed.
    const rough = source();
    rough.roughnessMap = new Texture();
    expect(() => energyPreservingTwin(rough, { direction: new Vector3(0, 1, 0) })).toThrow(
      /TN_DIFFUSE_ENERGY_MAP/,
    );
  });

  it("leaves every material alone under three's term", () => {
    const material = source();
    const mesh = new Mesh(new BufferGeometry(), material);
    const root = new Group();
    root.add(mesh);
    expect(applyDiffuseEnergy(root, { direction: new Vector3(0, 1, 0) }, "three")).toBe(0);
    // The BEFORE arm is the frame the harness drew before this file existed: the same material, untouched.
    expect(mesh.material).toBe(material);
    expect((mesh.material as MeshStandardMaterial).color.equals(new Color(0.73, 0.73, 0.73))).toBe(
      true,
    );
  });

  it("is wired into both scaffolds at L1, with three's term as the named override", () => {
    const calibration = readFileSync("scripts/unreal-look/scaffold/CalibrationScene.ts.in", "utf8");
    // A calibration scene's one lamp, from L1 only: the layer the direct light owns (a later layer's sky and
    // GI diffuse already lose the integrated term through three's own energyLoss).
    expect(calibration).toContain('level === 1 && diffuseEnergyMode(params) === "unreal"');
    expect(calibration).toContain("applyDiffuseEnergy(model, { position: only.position })");
    expect(calibration).toContain("TN_DIFFUSE_ENERGY_LIGHTS");
    const reference = readFileSync("scripts/unreal-look/scaffold/Reference.ts.in", "utf8");
    // A template-lit calibration scene (`?model=`), the sun; the starter reference scene keeps three's term.
    expect(reference).toContain('params.get("model") !== null');
    expect(reference).toContain("applyDiffuseEnergy(model, { direction: SUN_DIRECTION })");
  });
});
