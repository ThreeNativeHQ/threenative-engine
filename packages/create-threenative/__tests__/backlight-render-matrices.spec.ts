import {
  Camera,
  Color,
  DirectionalLight,
  Group,
  MeshStandardMaterial,
  type Object3D,
  Scene,
  Vector3,
} from "three";
import { expect, test, vi } from "vitest";
import { backlightMaterial } from "../templates/starter/src/render/backlightMaterial.js";
interface IUniform {
  isUniformNode?: boolean;
  updateType?: string;
  value: unknown;
  update(frame: { camera: Camera }): void;
}
test("render uniforms read engine-updated light matrices without mutating shared matrices or update flags", () => {
  const scene = new Scene();
  const ancestor = new Group();
  const key = new DirectionalLight(0xffffff, 4.5);
  const camera = new Camera();
  ancestor.position.set(3, 1, 0);
  key.position.set(0, 2, -3);
  key.target.position.set(-1, 0, 0);
  ancestor.add(key);
  scene.add(ancestor); // Target is deliberately not attached to the scene.
  const controls = {
    scene,
    camera,
    key,
    rimGain: 0.12,
    fillGain: 1,
    fillColor: new Color(0.1, 0.2, 0.3),
    fillDirection: new Vector3(-1, 1, 1),
    fillAngularSize: 0.7,
    fillAdmitted: false,
  };
  const material = backlightMaterial(new MeshStandardMaterial(), controls);
  const uniforms: IUniform[] = [];
  material.emissiveNode?.traverse((node) => {
    const uniform = node as unknown as IUniform;
    if (uniform.isUniformNode && uniform.updateType === "render") uniforms.push(uniform);
  });
  const direction = uniforms.find(
    (node) => node.value instanceof Vector3 && node.value !== controls.fillDirection,
  );
  expect(direction).toBeDefined();
  const gain = () =>
    uniforms.filter((node) => typeof node.value === "number").map((node) => node.value);
  // Same contract as Three's light uniforms: renderer/game updates world matrices before callbacks.
  const engineUpdate = () => {
    scene.updateMatrixWorld(true);
    key.target.updateMatrixWorld(true);
  };
  const nodes: Object3D[] = [scene, ancestor, key, key.target];
  engineUpdate();
  const matrixSpies = nodes.flatMap((node) => [
    vi.spyOn(node, "updateWorldMatrix"),
    vi.spyOn(node, "updateMatrixWorld"),
    vi.spyOn(node, "updateMatrix"),
  ]);
  const render = () => {
    // Pending changes belong to the engine's next update, never to this material callback.
    for (const node of nodes) node.matrixWorldNeedsUpdate = true;
    const snapshots = nodes.map((node) => ({
      local: node.matrix.clone(),
      world: node.matrixWorld.clone(),
      dirty: node.matrixWorldNeedsUpdate,
      auto: node.matrixAutoUpdate,
      worldAuto: node.matrixWorldAutoUpdate,
    }));
    for (const uniform of uniforms) uniform.update({ camera });
    nodes.forEach((node, index) => {
      const snapshot = snapshots[index];
      if (snapshot === undefined) throw new Error("Missing matrix snapshot.");
      expect(node.matrix.equals(snapshot.local)).toBe(true);
      expect(node.matrixWorld.equals(snapshot.world)).toBe(true);
      expect(node.matrixWorldNeedsUpdate).toBe(snapshot.dirty);
      expect(node.matrixAutoUpdate).toBe(snapshot.auto);
      expect(node.matrixWorldAutoUpdate).toBe(snapshot.worldAuto);
    });
  };
  render();
  expect(gain()).toContain(4.5);
  expect((direction?.value as Vector3).distanceTo(new Vector3(4, 3, -3).normalize())).toBeLessThan(
    1e-12,
  );
  for (const spy of matrixSpies) expect(spy).not.toHaveBeenCalled();
  for (const spy of matrixSpies) spy.mockRestore();
  ancestor.position.set(-2, 3, 1);
  key.target.position.set(1, 1, 0);
  engineUpdate();
  render();
  expect((direction?.value as Vector3).distanceTo(new Vector3(-3, 4, -2).normalize())).toBeLessThan(
    1e-12,
  );
  ancestor.visible = false;
  render();
  expect(gain()).not.toContain(4.5);
  ancestor.visible = true;
  scene.remove(ancestor);
  render();
  expect(gain()).not.toContain(4.5);
  material.dispose();
});
