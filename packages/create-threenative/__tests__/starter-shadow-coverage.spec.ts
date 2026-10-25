import { Box3, MeshStandardMaterial, Raycaster, Scene, Vector3 } from "three";
import { expect, it, vi } from "vitest";
import { createArena } from "../templates/starter/src/render/arena.js";
import { setupLighting } from "../templates/starter/src/render/lighting.js";

vi.mock("../templates/starter/src/render/materials.js", () => ({
  floorMaterial: new MeshStandardMaterial(),
  structureMaterial: new MeshStandardMaterial(),
  worldGridUVs: (geometry: unknown) => geometry,
}));

it("keeps the arena and both sides of the rear-wall shadow inside the sun projection", () => {
  const scene = new Scene();
  const arena = createArena();
  scene.add(arena.group);
  const { key } = setupLighting(scene, { shadowMap: { enabled: false, type: 0 } });
  scene.updateMatrixWorld(true);
  // ShadowNode updates the projection before building the light's frustum.
  key.shadow.camera.updateProjectionMatrix();
  key.shadow.updateMatrices(key);
  const frustum = key.shadow.getFrustum();
  const towardSun = key.position.clone().normalize();
  for (const x of [9.4, 9.5]) {
    const receiver = new Vector3(x, -2, -10.5);
    const hits = new Raycaster(receiver, towardSun)
      .intersectObjects(arena.solids)
      .filter((hit) => hit.distance > 0.001);
    expect(hits[0]?.object).toBe(arena.solids[3]);
    expect(frustum.containsPoint(receiver)).toBe(true);
  }
  for (const caster of arena.solids) {
    const bounds = new Box3().setFromObject(caster);
    for (const x of [bounds.min.x, bounds.max.x])
      for (const y of [bounds.min.y, bounds.max.y])
        for (const z of [bounds.min.z, bounds.max.z])
          expect(frustum.containsPoint(new Vector3(x, y, z))).toBe(true);
  }
});
