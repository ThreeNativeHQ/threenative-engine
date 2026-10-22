import { Color, MeshStandardMaterial } from "three";
import { uniform, vec3 } from "three/tsl";
import type { Node } from "three/webgpu";
import { describe, expect, it } from "vitest";
import { addFoliageBackLight } from "../src/render/two-sided-foliage.js";

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
