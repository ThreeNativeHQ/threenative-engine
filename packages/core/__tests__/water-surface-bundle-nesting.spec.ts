import { type Camera, PerspectiveCamera, Scene, type Vector2, WebGPUCoordinateSystem } from "three";
import { describe, expect, it } from "vitest";
import { WaterSurface3D } from "../src/water-surface.js";

/**
 * Three runs the reflector's `updateBefore` from the draw of the first object that samples it, and
 * with `bounces` off (the default) its update type is per frame, so a world chunk drawing an opaque
 * water mesh is bundle-safe and that draw can be part of a `BundleGroup` record. Three keeps the
 * recording bundle in `renderer._currentRenderBundle` and does not save it across the nested
 * `render()` the reflection is: the same fault `virtual-shadow-bundle-nesting.spec.ts` pins.
 *
 * The stub `render` is what three's `_renderBundle` does to the field during the mirrored render.
 */
describe("a water reflection rendered while the main pass records a bundle", () => {
  it("renders outside the bundle and hands the bundle back unchanged", () => {
    const surface = new WaterSurface3D({
      level: 0,
      maxThickness: 3,
      reflection: { resolutionScale: 0.5, layers: 1 },
    });
    const outer = { bundleGroup: { name: "world-chunk-bundles:8:7" } };
    const seen: unknown[] = [];
    const renderer = {
      _currentRenderBundle: outer as unknown,
      autoClear: true,
      coordinateSystem: WebGPUCoordinateSystem,
      getDrawingBufferSize: (target: Vector2): Vector2 => target.set(960, 540),
      getMRT: (): null => null,
      getRenderTarget: (): null => null,
      setMRT: (): void => {},
      setRenderTarget: (): void => {},
      clear: (): void => {},
      render: (_scene: Scene, _camera: Camera): void => {
        seen.push(renderer._currentRenderBundle);
        // three's `_renderBundle` for a bundle the reflection itself draws: set, record, clear.
        renderer._currentRenderBundle = { bundleGroup: { name: "reflection" } };
        renderer._currentRenderBundle = null;
      },
    };
    const camera = new PerspectiveCamera(50, 1, 0.5, 8000);
    camera.position.set(0, 20, 60);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const pass = (
      surface.reflectionAt() as unknown as {
        node: { _reflectorBaseNode: { updateBefore(frame: unknown): void } };
      }
    ).node._reflectorBaseNode;

    pass.updateBefore({ scene: new Scene(), camera, renderer, material: { visible: true } });

    expect(seen).toEqual([null]);
    expect(renderer._currentRenderBundle).toBe(outer);
  });
});
