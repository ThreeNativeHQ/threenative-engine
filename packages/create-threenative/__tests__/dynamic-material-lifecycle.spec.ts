import {
  BoxGeometry,
  Camera,
  DirectionalLight,
  Group,
  Mesh,
  MeshStandardMaterial,
  Scene,
  Texture,
} from "three";
import { expect, test, vi } from "vitest";
import { createMaterialLighting } from "../templates/starter/src/render/materialLighting.js";
function setup() {
  const scene = new Scene();
  const key = new DirectionalLight();
  scene.add(key);
  return {
    scene,
    controller: createMaterialLighting(scene, new Camera(), key, {
      enabled: true,
      web: true,
      rendererKind: "webgpu",
      mobile: false,
      software: false,
    }),
  };
}
test("dynamic enrollment shares conversions and releases the final receiver only", () => {
  const { scene, controller } = setup();
  const map = new Texture();
  const source = new MeshStandardMaterial({ map });
  const borrowed = vi.spyOn(source, "dispose");
  const texture = vi.spyOn(map, "dispose");
  const a = new Mesh(new BoxGeometry(), source);
  const b = new Mesh(new BoxGeometry(), source);
  scene.add(a, b);
  controller.enroll(a);
  controller.enroll(a);
  controller.enroll(b);
  expect(a.material).toBe(b.material);
  expect(a.material).not.toBe(source);
  const owned = vi.spyOn(a.material as MeshStandardMaterial, "dispose");
  expect(controller.debug().enrolledMeshes).toBe(2);
  controller.release(a);
  a.removeFromParent();
  expect(a.material).toBe(source);
  expect(owned).not.toHaveBeenCalled();
  controller.release(b);
  expect(owned).toHaveBeenCalledTimes(1);
  expect(controller.debug()).toMatchObject({ enrolledMeshes: 0, convertedMaterials: 0 });
  controller.release(b);
  controller.dispose();
  expect(owned).toHaveBeenCalledTimes(1);
  expect(borrowed).not.toHaveBeenCalled();
  expect(texture).not.toHaveBeenCalled();
});
test("fallback spawns convert on recovery and mutable arrays preserve authored edits on release", () => {
  const { scene, controller } = setup();
  controller.setEnabled(false);
  const source = new MeshStandardMaterial();
  const edited = new MeshStandardMaterial();
  const array = [source, source];
  const mesh = new Mesh(new BoxGeometry(), array);
  scene.add(mesh);
  controller.enroll(mesh);
  expect(mesh.material).toBe(array);
  array[1] = edited;
  controller.setEnabled(true);
  const applied = mesh.material as MeshStandardMaterial[];
  expect(applied[0]).not.toBe(source);
  expect(applied[1]).not.toBe(edited);
  const replacement = new MeshStandardMaterial();
  applied[1] = replacement;
  controller.release(mesh);
  expect(mesh.material).toEqual([source, replacement]);
  controller.enroll(mesh);
  expect((mesh.material as MeshStandardMaterial[])[1]).not.toBe(replacement);
  controller.dispose();
  expect(mesh.material).toEqual([source, replacement]);
});
test("spawn/remove cycles leave no retained assignments or conversions and disposed enrollment is inert", () => {
  const { scene, controller } = setup();
  for (let i = 0; i < 25; i++) {
    const root = new Group();
    const mesh = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    root.add(mesh);
    scene.add(root);
    controller.enroll(root);
    controller.release(root);
    root.removeFromParent();
    expect(controller.debug()).toMatchObject({ enrolledMeshes: 0, convertedMaterials: 0 });
  }
  controller.dispose();
  const mesh = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
  const original = mesh.material;
  controller.enroll(mesh);
  controller.setEnabled(true);
  expect(mesh.material).toBe(original);
});
test("later material override survives release and reenrollment borrows the new source", () => {
  const { controller } = setup();
  const mesh = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
  controller.enroll(mesh);
  const owned = vi.spyOn(mesh.material as MeshStandardMaterial, "dispose");
  const replacement = new MeshStandardMaterial();
  mesh.material = replacement;
  controller.release(mesh);
  expect(mesh.material).toBe(replacement);
  expect(owned).toHaveBeenCalledTimes(1);
  controller.enroll(mesh);
  expect(mesh.material).not.toBe(replacement);
  controller.dispose();
  expect(mesh.material).toBe(replacement);
});
