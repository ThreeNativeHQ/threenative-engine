import { BufferAttribute, type Mesh, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { createStylizedAsset, stylizedAssets } from "../src/stylized.js";

describe("Stylized Biome Kit", () => {
  it("builds every catalog variant and all three biome scenes", () => {
    const rows = stylizedAssets();
    expect(rows.filter((row) => row.category === "Scenes")).toHaveLength(3);
    expect(rows.filter((row) => row.category !== "Scenes")).toHaveLength(50);
    expect(new Set(rows.map(({ id }) => id)).size).toBe(rows.length);
    for (const row of rows) {
      for (let variant = 0; variant < row.variants; variant++) {
        const { group } = createStylizedAsset(row.id, { variant });
        expect(group.children.length > 0 || (group as Mesh).isMesh, row.id).toBeTruthy();
      }
    }
    expect(() => createStylizedAsset("missing")).toThrow(/Unknown stylized asset/);
    expect(() => createStylizedAsset("pine", { variant: -1 })).toThrow(/variant/);
  });

  it("uses the redesigned range in each scene", () => {
    for (const id of ["scene-forest", "scene-snow", "scene-desert"]) {
      const { group } = createStylizedAsset(id);
      expect(group.children.filter(({ name }) => name === "mountain").length).toBeGreaterThan(5);
    }
  });

  it("keeps the mountains seeded and tapering from their bases to irregular summits", () => {
    for (const id of ["mountain-alpine", "mountain-snow", "mountain-desert"]) {
      const vertices = (seed: number) => {
        const { group } = createStylizedAsset(id, { seed });
        const mesh = group.children[0] as Mesh;
        const positions = mesh.geometry.getAttribute("position");
        expect(positions).toBeInstanceOf(BufferAttribute);
        return positions;
      };
      const position = vertices(3);
      expect(position.array).toEqual(vertices(3).array);
      expect(position.array).not.toEqual(vertices(8).array);
      const points = Array.from({ length: position.count }, (_, i) =>
        new Vector3().fromBufferAttribute(position, i),
      );
      const top = Math.max(...points.map(({ y }) => y));
      const base = points.filter(({ y }) => y < top * 0.1);
      const crest = points.filter(({ y }) => y > top * 0.85);
      const span = (band: Vector3[]) =>
        Math.max(...band.map(({ x }) => x)) - Math.min(...band.map(({ x }) => x));
      expect(top).toBeGreaterThan(10);
      expect(Math.min(...base.map(({ y }) => y))).toBeCloseTo(0);
      expect(crest.length).toBeGreaterThan(3);
      expect(span(crest)).toBeLessThan(span(base) * 0.6);
    }
  });
});
