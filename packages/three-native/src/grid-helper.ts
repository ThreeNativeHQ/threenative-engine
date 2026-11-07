// three's GridHelper over the engine's LineSegments, ported from three r180 src/helpers/GridHelper.js (MIT).
// The engine binds LineSegments, BufferGeometry and LineBasicMaterial, so the helper is those three: no
// engine class of its own. `type` stays the engine's "LineSegments", which is how the renderer picks the
// line-list topology; `isGridHelper` marks it as three's does.

type Constructor = new (...args: unknown[]) => object;

type EngineClasses = Readonly<
  Record<
    "LineSegments" | "BufferGeometry" | "Float32BufferAttribute" | "LineBasicMaterial" | "Color",
    Constructor
  >
>;

export function defineGridHelper(classes: EngineClasses) {
  const LineSegments = classes.LineSegments as new (
    geometry: object,
    material: object,
  ) => { geometry: { dispose(): void }; material: { dispose(): void } };
  return class GridHelper extends LineSegments {
    readonly isGridHelper = true;

    constructor(size = 10, divisions = 10, color1: unknown = 0x444444, color2: unknown = 0x888888) {
      const center = new classes.Color(color1) as { r: number; g: number; b: number };
      const line = new classes.Color(color2) as { r: number; g: number; b: number };
      const middle = divisions / 2;
      const step = size / divisions;
      const halfSize = size / 2;
      const vertices: number[] = [];
      const colors: number[] = [];
      for (let i = 0, k = -halfSize; i <= divisions; i++, k += step) {
        vertices.push(-halfSize, 0, k, halfSize, 0, k, k, 0, -halfSize, k, 0, halfSize);
        const color = i === middle ? center : line;
        for (let vertex = 0; vertex < 4; vertex++) colors.push(color.r, color.g, color.b);
      }
      const geometry = new classes.BufferGeometry() as {
        setAttribute(name: string, attribute: object): void;
      };
      geometry.setAttribute("position", new classes.Float32BufferAttribute(vertices, 3));
      geometry.setAttribute("color", new classes.Float32BufferAttribute(colors, 3));
      super(geometry, new classes.LineBasicMaterial({ vertexColors: true, toneMapped: false }));
    }

    dispose(): void {
      this.geometry.dispose();
      this.material.dispose();
    }
  };
}
