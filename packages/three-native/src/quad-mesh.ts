/**
 * three r185's QuadMesh (src/renderers/common/QuadMesh.js) over the engine's own Mesh, shared by both
 * back ends (PRD-551): a Mesh over one fullscreen triangle, drawn through a fixed orthographic camera
 * by `renderer.render(quad, camera)`, so it fills whatever the renderer draws into (a render target).
 */

type Constructor = new (...args: unknown[]) => object;

type EngineClasses = Readonly<
  Record<"Mesh" | "BufferGeometry" | "Float32BufferAttribute" | "OrthographicCamera", Constructor>
>;

export function defineQuadMesh(classes: EngineClasses) {
  // Built on first use, as three builds its module-level geometry and camera once.
  let shared: { geometry: object; camera: object } | undefined;
  const quad = () => {
    if (shared === undefined) {
      const geometry = new classes.BufferGeometry() as {
        setAttribute(name: string, attribute: object): void;
      };
      geometry.setAttribute(
        "position",
        new classes.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3),
      );
      geometry.setAttribute("uv", new classes.Float32BufferAttribute([0, -1, 0, 1, 2, 1], 2));
      shared = { geometry, camera: new classes.OrthographicCamera(-1, 1, 1, -1, 0, 1) };
    }
    return shared;
  };
  const Mesh = classes.Mesh as new (geometry: object, material?: unknown) => object;

  return class QuadMesh extends Mesh {
    readonly isQuadMesh = true;
    readonly camera: object;

    constructor(material: unknown = null) {
      // three passes `null`; the engine Mesh takes its default material until one is assigned.
      super(quad().geometry, material ?? undefined);
      this.camera = quad().camera;
    }

    render(renderer: { render(scene: unknown, camera: unknown): void }): void {
      renderer.render(this, this.camera);
    }

    async renderAsync(renderer: {
      init(): Promise<unknown>;
      render(scene: unknown, camera: unknown): void;
    }): Promise<void> {
      await renderer.init();
      this.render(renderer);
    }
  };
}
