import { Color, MeshStandardMaterial } from "three";
import { uniform, vec3 } from "three/tsl";
import type { Node } from "three/webgpu";
import { describe, expect, it } from "vitest";
import {
  addFoliageBackLight,
  installFoliageTransmission,
} from "../src/render/two-sided-foliage.js";

/** Every node the graph reaches through its inputs, so a spec can ask whether a node feeds a material. */
function reaches(root: unknown, target: unknown, seen = new Set<unknown>()): boolean {
  if (root === target) return true;
  if (typeof root !== "object" || root === null || seen.has(root)) return false;
  seen.add(root);
  return Object.values(root).some((child) => reaches(child, target, seen));
}

function leaf(subsurface: Color | undefined, marked = true): MeshStandardMaterial {
  const material = new MeshStandardMaterial();
  material.twoSidedFoliage = marked;
  if (subsurface !== undefined) material.subsurfaceColor = subsurface;
  return material;
}

const back = uniform(new Color(1, 1, 1)) as unknown as Node<"vec3">;

describe("addFoliageBackLight (PRD-643)", () => {
  it("adds subsurfaceColor x the back irradiance to a marked material", () => {
    const material = leaf(new Color(0.2, 0.5, 0.1));
    expect(addFoliageBackLight(material, back)).toBe(true);
    expect(material.emissiveNode).toBeTruthy();
    expect(reaches(material.emissiveNode, back)).toBe(true);
  });

  it("adds nothing to a marked material without subsurfaceColor", () => {
    const material = leaf(undefined);
    expect(addFoliageBackLight(material, back)).toBe(false);
    expect(material.emissiveNode ?? null).toBeNull();
  });

  it("adds nothing when the material is not marked, even with a subsurfaceColor", () => {
    const material = leaf(new Color(0.2, 0.5, 0.1), false);
    expect(addFoliageBackLight(material, back)).toBe(false);
    expect(material.emissiveNode ?? null).toBeNull();
  });

  it("keeps the emissive node the material already has", () => {
    const material = leaf(new Color(0.2, 0.5, 0.1));
    const glow = vec3(0.1, 0, 0) as unknown as Node;
    material.emissiveNode = glow;
    addFoliageBackLight(material, back);
    expect(reaches(material.emissiveNode, glow)).toBe(true);
    expect(reaches(material.emissiveNode, back)).toBe(true);
  });
});

/** Stand-ins for three's lit node materials: a lighting model whose direct() records what it was given. */
function litClasses() {
  class Model {
    calls: unknown[] = [];
    direct(input: unknown) {
      this.calls.push(input);
    }
  }
  class MeshStandardNodeMaterial {
    twoSidedFoliage?: boolean;
    subsurfaceColor?: Color;
    setupLightingModel() {
      return new Model();
    }
  }
  class MeshPhysicalNodeMaterial extends MeshStandardNodeMaterial {
    override setupLightingModel() {
      return new Model();
    }
  }
  return { MeshStandardNodeMaterial, MeshPhysicalNodeMaterial };
}

function directOf(material: { setupLightingModel(): unknown }) {
  const added: unknown[] = [];
  const directDiffuse = { addAssign: (node: unknown) => added.push(node) };
  const model = material.setupLightingModel() as {
    direct(input: unknown, builder: unknown): void;
    calls: unknown[];
  };
  const light = uniform(new Color(1, 1, 1)) as unknown as Node<"vec3">;
  model.direct(
    { lightDirection: light, lightColor: light, reflectedLight: { directDiffuse } },
    undefined,
  );
  return { added, model, light };
}

describe("installFoliageTransmission (PRD-643)", () => {
  it("patches the standard and the physical class once each", () => {
    const classes = litClasses();
    expect(installFoliageTransmission(classes)).toBe(2);
    expect(installFoliageTransmission(classes)).toBe(0);
    expect(installFoliageTransmission({ MeshStandardNodeMaterial: class {} })).toBe(0);
  });

  it("adds the sun transmission to a marked material with a subsurfaceColor, after three's own direct light", () => {
    const classes = litClasses();
    installFoliageTransmission(classes);
    for (const Lit of [classes.MeshStandardNodeMaterial, classes.MeshPhysicalNodeMaterial]) {
      const material = new Lit();
      material.twoSidedFoliage = true;
      material.subsurfaceColor = new Color(0.1, 0.12, 0.05);
      const { added, model, light } = directOf(material);
      expect(model.calls).toHaveLength(1);
      expect(added).toHaveLength(1);
      expect(reaches(added[0], light)).toBe(true);
    }
  });

  it("leaves an unmarked material, and a marked one without subsurfaceColor, as three lights them", () => {
    const classes = litClasses();
    installFoliageTransmission(classes);
    const unmarked = new classes.MeshStandardNodeMaterial();
    unmarked.subsurfaceColor = new Color(0.1, 0.12, 0.05);
    const bare = new classes.MeshPhysicalNodeMaterial();
    bare.twoSidedFoliage = true;
    for (const material of [unmarked, bare]) {
      const { added, model } = directOf(material);
      expect(model.calls).toHaveLength(1);
      expect(added).toHaveLength(0);
    }
  });
});
