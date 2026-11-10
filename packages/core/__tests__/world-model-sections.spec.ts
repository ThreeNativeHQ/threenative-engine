import { Box3, BoxGeometry, BufferAttribute, Mesh, MeshBasicMaterial, Object3D } from "three";
import { describe, expect, it } from "vitest";
import { meshSections, repairZeroNormals, sectionGeometry } from "../src/world.js";

describe("model sections", () => {
  it("splits a multi-material mesh and stands every section on one shared base", () => {
    const root = new Object3D();
    root.position.set(0, 5, 0);
    // A 1 m trunk at y 5..6 and a crown mesh at y 6..8, as two meshes of one model.
    const trunk = new Mesh(
      new BoxGeometry(0.2, 1, 0.2).translate(0, 0.5, 0),
      new MeshBasicMaterial(),
    );
    const crownGeometry = new BoxGeometry(2, 2, 2).translate(0, 2, 0);
    const crown = new Mesh(crownGeometry, [new MeshBasicMaterial(), new MeshBasicMaterial()]);
    root.add(trunk, crown);
    root.updateMatrixWorld(true);
    const box = new Box3().setFromObject(root);
    expect(meshSections(trunk)).toHaveLength(1);
    const sections = meshSections(crown);
    expect(sections).toHaveLength(crownGeometry.groups.length);
    const trunkPart = sectionGeometry(trunk, box, meshSections(trunk)[0] as never);
    const crownPart = sectionGeometry(crown, box, sections[1] as never);
    trunkPart.computeBoundingBox();
    crownPart.computeBoundingBox();
    // The trunk's own base is the model's base; the crown keeps its 1 m height above it.
    expect(trunkPart.boundingBox?.min.y).toBeCloseTo(0, 6);
    expect(crownPart.boundingBox?.min.y).toBeCloseTo(1, 6);
    expect(crownPart.drawRange.count).toBe(crownGeometry.groups[1]?.count);
    expect(crownPart.groups).toHaveLength(0);
  });

  it("repairs zero normals and keeps authored ones", () => {
    const geometry = new BoxGeometry(1, 1, 1);
    const authored = Float32Array.from(geometry.getAttribute("normal").array);
    expect(repairZeroNormals(geometry)).toBe(false);
    expect(Array.from(geometry.getAttribute("normal").array)).toEqual(Array.from(authored));
    geometry.setAttribute("normal", new BufferAttribute(new Float32Array(authored.length), 3));
    expect(repairZeroNormals(geometry)).toBe(true);
    expect(
      Math.hypot(...Array.from(geometry.getAttribute("normal").array.slice(0, 3))),
    ).toBeCloseTo(1, 5);
  });
});
