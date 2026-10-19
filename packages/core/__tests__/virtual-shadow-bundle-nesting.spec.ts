import {
  BoxGeometry,
  DirectionalLight,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
} from "three";
import type { NodeBuilder, NodeFrame } from "three/webgpu";
import { describe, expect, it } from "vitest";
import { VirtualShadowNode } from "../src/render/virtual-shadow.js";

/**
 * Three runs a node's `updateBefore` from the draw of the first object that uses it, and that draw
 * can be the first object of a `BundleGroup` the main pass is recording. Three keeps that bundle in
 * `renderer._currentRenderBundle` and does not save it across a nested `render()`: the level's own
 * draws are filed under the main bundle, and the level's own bundles leave the field `null`, so the
 * main bundle's remaining draws are recorded but never listed for refresh. On Machinefall that froze
 * a cell's chunk forest at the camera it was recorded with, screen-locked for twenty walk steps.
 *
 * The stub below is what three's `_renderBundle` does to the field during the level render.
 */
describe("a shadow level rendered while the main pass records a bundle", () => {
  it("renders outside the bundle and hands the bundle back unchanged", () => {
    const scene = new Scene();
    const light = new DirectionalLight(0xffffff, 1);
    light.position.set(60, 200, -40);
    light.castShadow = true;
    scene.add(light, light.target);
    const caster = new Mesh(new BoxGeometry(8, 8, 8), new MeshBasicMaterial());
    caster.castShadow = true;
    caster.position.set(0, 4, 0);
    scene.add(caster);
    const camera = new PerspectiveCamera(60, 1, 0.1, 900);
    camera.position.set(0, 10, 0);
    scene.add(camera);
    scene.updateMatrixWorld(true);

    const outer = { bundleGroup: { name: "world-chunk-bundles:8:7" } };
    const renderer = { _currentRenderBundle: outer as unknown };
    const seen: unknown[] = [];
    const node = new VirtualShadowNode(light, {
      clipExtents: [24, 96],
      mapSize: 1024,
      marker: false,
    });
    node.setup({
      context: {},
      material: {},
      renderer: { shadowMap: { enabled: true } },
    } as unknown as NodeBuilder);
    for (const level of [...node.levelNodes, ...node.moverNodes])
      (level as unknown as { updateShadow(frame: NodeFrame): void }).updateShadow = () => {
        seen.push(renderer._currentRenderBundle);
        // three's `_renderBundle` for a bundle the level itself draws: set, record, clear.
        renderer._currentRenderBundle = { bundleGroup: { name: "level" } };
        renderer._currentRenderBundle = null;
      };

    node.updateBefore({ camera, renderer, time: 1 } as unknown as NodeFrame);

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((bundle) => bundle === null)).toBe(true);
    expect(renderer._currentRenderBundle).toBe(outer);
  });
});
