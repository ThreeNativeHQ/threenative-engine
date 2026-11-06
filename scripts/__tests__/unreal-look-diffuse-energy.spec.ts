import { readFileSync } from "node:fs";
import { BufferGeometry, Color, Group, Mesh, MeshStandardMaterial, Texture, Vector3 } from "three";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { describe, expect, it } from "vitest";
import {
  ENERGY_CONSERVATION,
  NUMBER_ARITHMETIC,
  applyDiffuseEnergy,
  diffuseEnergyMode,
  diffuseEnergyScale,
  energyPreservation,
  energyPreservingTwin,
  fresnel,
  ggxEnergyLookup,
  physicalAblationTwin,
  specularTerms,
} from "../unreal-look/scaffold/render/diffuseEnergy.js";
import { noSpecularTwin } from "../unreal-look/scaffold/render/specular.js";

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

  it("loses no diffuse energy in a blendable-GBuffer Substrate project: the term compiles out (round 13)", () => {
    // The project's own value: `r.Substrate.ProjectGBufferFormat=0` keeps the blendable Substrate GBuffer, so
    // `SUBSTRATE_GBUFFER_FORMAT` is 0 and `USE_ENERGY_CONSERVATION` is 0
    // (UE 5.8.3: Engine/Shaders/Private/ShadingEnergyConservation.ush:20-31).
    const project = readFileSync("tools/unreal-reference/Config/DefaultEngine.ini", "utf8");
    expect(project).toMatch(/^r\.Substrate\.ProjectGBufferFormat=0$/m);
    expect(ENERGY_CONSERVATION).toBe(false);
    // Round 12's two measured `cornell` rows: `Floor` (NoV 0.29906, VoH 0.67856) and a grazing one (0.085, 0.274),
    // with the loss E each took (3.21% and 5.63%).
    for (const [noV, dotVH, loss] of [
      [0.29906, 0.67856, 0.0321],
      [0.085, 0.274, 0.0563],
    ] as const) {
      const terms = { roughness: 1, noV, f0: 0.04, f90: 1, dotVH };
      const scale = diffuseEnergyScale(NUMBER_ARITHMETIC, terms);
      const threeLoss = fresnel(NUMBER_ARITHMETIC, { f0: 0.04, f90: 1, dotVH });
      // The engine multiplies the albedo by `1 - F` (packages/runtime-native/src/engine/shader/standard.cpp:1433-1442):
      // the scale cancels it to exactly 1, so the diffuse keeps all of its light, as Unreal's does.
      near(scale * (1 - threeLoss), 1, 1e-12);
      // The loss the harness took until round 12 (E) is real on these rows, and is what the switch now drops.
      near(1 - energyPreservation(NUMBER_ARITHMETIC, terms), loss, 0.001);
    }
  });

  it("keeps ?specular=0 off through the term: an energy twin of an ablation slot stays physical", () => {
    // `?specular=0` swaps each slot for a physical material with `ior` 1 and `specularIntensity` 0, so F0 is 0
    // (render/specular.ts:17-35). The engine picks its F0/F90 body from the material's class, and the standard body
    // is the fixed 0.04 / 1 (packages/runtime-native/src/engine/shader/standard.cpp:1265-1268, :1354-1372), so an
    // energy twin of the standard class would turn the lobe back on.
    const ablated = energyPreservingTwin(noSpecularTwin(source()), {
      direction: new Vector3(0, 1, 0),
    });
    expect(ablated.type).toBe("MeshPhysicalNodeMaterial");
    // The engine reads the ablation's own numbers off the twin: F0 0 and F90 0, so the lobe is off at every angle.
    expect(specularTerms(ablated)).toEqual({ f0: 0, f90: 0 });
    // The albedo still carries the term: the ablation survives it, it is not swapped for it.
    expect(ablated.colorNode).not.toBeNull();
    // And the term divides out the loss this slot really takes, which at F0 0 and F90 0 is none: the engine's
    // `1 - F` is 1, so the scale is exactly 1 and the arm keeps the bare diffuse.
    expect(specularTerms(noSpecularTwin(source()))).toEqual({ f0: 0, f90: 0 });
    for (const dotVH of [0.67856, 0.274]) {
      near(
        diffuseEnergyScale(NUMBER_ARITHMETIC, { roughness: 1, noV: 0.29906, f0: 0, f90: 0, dotVH }),
        1,
        1e-12,
      );
    }
    // Round 7's F0-only reading survives too: F0 0, F90 1.
    const f0Only = energyPreservingTwin(noSpecularTwin(source(), true), {
      direction: new Vector3(0, 1, 0),
    });
    expect(specularTerms(f0Only)).toEqual({ f0: 0, f90: 1 });
    near(
      diffuseEnergyScale(NUMBER_ARITHMETIC, {
        roughness: 1,
        noV: 0.29906,
        f0: 0,
        f90: 1,
        dotVH: 0.67856,
      }) *
        (1 - fresnel(NUMBER_ARITHMETIC, { f0: 0, f90: 1, dotVH: 0.67856 })),
      1,
      1e-12,
    );
    // A plain slot keeps the standard twin: the class follows the source, it is not always physical.
    expect(energyPreservingTwin(source(), { direction: new Vector3(0, 1, 0) }).type).toBe(
      "MeshStandardNodeMaterial",
    );
    // The shared 0.04 and 1 of a standard material, which is what the scenes' slots carry.
    expect(specularTerms(source())).toEqual({ f0: 0.04, f90: 1 });
  });

  it("refuses an ablation where the engine bridges no physical node material, rather than a lobe that came back", () => {
    // The owned engine binds no `MeshPhysicalNodeMaterial` (packages/three-native/api/catalog.json), so `new` on it
    // throws `TN_NATIVE_UNCATALOGUED_MESHPHYSICALNODEMATERIAL`; round 12 measured the silent version of that: the
    // specular-on and specular-off arms drew one frame.
    expect(() =>
      physicalAblationTwin("MI_White", () => {
        throw new Error("TN_NATIVE_UNCATALOGUED_MESHPHYSICALNODEMATERIAL");
      }),
    ).toThrow(/TN_DIFFUSE_ENERGY_SPECULAR: MI_White .* physical node material/);
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
