import { Camera, DirectionalLight, type Material, Mesh, Scene, Vector3 } from "three";
import { afterEach, expect, test, vi } from "vitest";
import { createRandom } from "../../core/src/random.js";
import { TOWER_KINDS } from "../templates/tower-defense/src/balance.js";
import { createMaterialLighting } from "../templates/tower-defense/src/render/materialLighting.js";
import { type ITowerWorld, Tower } from "../templates/tower-defense/src/towers/Tower.js";

// Physics queries are unused: exercise the real tower models and replacement lifecycle on CPU.
vi.mock("@threenative/physics", () => ({
  CollisionShape3D: { sphere: (radius: number) => ({ radius }) },
}));
afterEach(() => vi.restoreAllMocks());
test("actual tower upgrades and recycling release old receivers without disposing authored shared materials", () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const scene = new Scene();
  const key = new DirectionalLight();
  scene.add(key);
  const controller = createMaterialLighting(scene, new Camera(), key, {
    enabled: true,
    web: true,
    rendererKind: "webgpu",
    mobile: false,
    software: false,
  });
  const baseline = controller.debug();
  const world = {
    random: createRandom(345),
    enemies: new Map(),
    effects: {},
    query: {},
    onShot() {},
  } as unknown as ITowerWorld;
  const borrowed = new Map<Material, ReturnType<typeof vi.spyOn>>();
  const owned = new Map<Material, ReturnType<typeof vi.spyOn>>();
  const assignments = (root: Tower["group"]) => {
    const result = new Map<Mesh, Mesh["material"]>();
    root.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      result.set(object, object.material);
      for (const material of Array.isArray(object.material) ? object.material : [object.material])
        if (!borrowed.has(material)) borrowed.set(material, vi.spyOn(material, "dispose"));
    });
    return result;
  };
  const enroll = (tower: Tower) => {
    const originals = assignments(tower.group);
    controller.enroll(tower.group);
    expect(controller.debug().enrolledMeshes).toBeGreaterThan(baseline.enrolledMeshes);
    expect(controller.debug().convertedMaterials).toBeGreaterThan(0);
    tower.group.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      for (const material of Array.isArray(object.material) ? object.material : [object.material])
        if (!borrowed.has(material) && !owned.has(material))
          owned.set(material, vi.spyOn(material, "dispose"));
    });
    return originals;
  };
  for (const kind of TOWER_KINDS) {
    const tower = new Tower({ id: kind, kind, padIndex: 0, position: new Vector3(), world });
    scene.add(tower.group);
    let originals = enroll(tower);
    for (let level = 2; level <= 3; level++) {
      const old = tower.group;
      controller.release(old);
      for (const [mesh, material] of originals) expect(mesh.material).toBe(material);
      expect(controller.debug()).toMatchObject({
        enrolledMeshes: baseline.enrolledMeshes,
        convertedMaterials: baseline.convertedMaterials,
      });
      expect(tower.upgrade()).toBe(true);
      expect(tower.group).not.toBe(old);
      expect(old.parent).toBeNull();
      originals = enroll(tower);
    }
    controller.release(tower.group);
    for (const [mesh, material] of originals) expect(mesh.material).toBe(material);
    tower.dispose();
    expect(controller.debug()).toMatchObject({
      enrolledMeshes: baseline.enrolledMeshes,
      convertedMaterials: baseline.convertedMaterials,
    });
  }
  controller.dispose();
  expect(owned.size).toBeGreaterThan(0);
  for (const spy of owned.values()) expect(spy).toHaveBeenCalledTimes(1);
  for (const spy of borrowed.values()) expect(spy).not.toHaveBeenCalled();
});
