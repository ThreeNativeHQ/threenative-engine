// PRD-784 sweep: vfx-gallery imports three's GridHelper, which the native engine profile did not bind, so the
// particle showcase never bundled for desktop or PS4. The helper is the engine's LineSegments with vertex colours.
import { describe, expect, it } from "vitest";
import { defineGridHelper } from "../src/grid-helper.js";

class Attribute {
  constructor(
    readonly array: number[],
    readonly itemSize: number,
  ) {}
}
class Geometry {
  readonly attributes: Record<string, Attribute> = {};
  disposed = false;
  setAttribute(name: string, attribute: object): void {
    this.attributes[name] = attribute as Attribute;
  }
  dispose(): void {
    this.disposed = true;
  }
}
class Material {
  disposed = false;
  constructor(readonly parameters: { vertexColors: boolean; toneMapped: boolean }) {}
  dispose(): void {
    this.disposed = true;
  }
}
class LineSegments {
  readonly type = "LineSegments";
  constructor(
    readonly geometry: Geometry,
    readonly material: Material,
  ) {}
}
class Color {
  r: number;
  g: number;
  b: number;
  constructor(hex: number) {
    this.r = ((hex >> 16) & 255) / 255;
    this.g = ((hex >> 8) & 255) / 255;
    this.b = (hex & 255) / 255;
  }
}

const GridHelper = defineGridHelper({
  LineSegments,
  BufferGeometry: Geometry,
  Float32BufferAttribute: Attribute,
  LineBasicMaterial: Material,
  Color,
} as never);

describe("GridHelper", () => {
  it("builds three's grid: two segments per line, the centre line in color1", () => {
    const grid = new GridHelper(4, 2, 0xff0000, 0x0000ff) as unknown as LineSegments & {
      isGridHelper: boolean;
    };
    const position = grid.geometry.attributes.position as Attribute;
    const color = grid.geometry.attributes.color as Attribute;
    // divisions + 1 lines each way, 2 vertices per segment.
    expect(position.array.length / 3).toBe((2 + 1) * 4);
    expect(position.array.slice(0, 12)).toEqual([-2, 0, -2, 2, 0, -2, -2, 0, -2, -2, 0, 2]);
    expect(color.array.slice(0, 3)).toEqual([0, 0, 1]);
    // Line i = divisions / 2 is the centre line.
    expect(color.array.slice(12 * 1, 12 * 1 + 3)).toEqual([1, 0, 0]);
    expect(grid.material.parameters).toEqual({ vertexColors: true, toneMapped: false });
    expect(grid.type).toBe("LineSegments");
    expect(grid.isGridHelper).toBe(true);
  });

  it("disposes its geometry and material", () => {
    const grid = new GridHelper() as unknown as LineSegments & { dispose(): void };
    grid.dispose();
    expect(grid.geometry.disposed && grid.material.disposed).toBe(true);
  });
});
