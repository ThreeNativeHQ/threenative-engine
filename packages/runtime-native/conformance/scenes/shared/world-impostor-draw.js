import * as THREE from "three/webgpu";
import { normalWorld, vec4 } from "three/tsl";
import { WorldImpostorBaker } from "../../../../core/src/render/world-impostor.ts";
import { WorldImpostorSurface } from "../../../../core/src/render/world-impostor-surface.ts";
import { startVisualScene } from "./scene-support.js";

// PRD-858: core's whole-asset impostor (the terminal world LOD) is baked on this renderer and drawn beside
// its source. Top: a flat red lit sphere, whose impostor must draw red at the source's brightness. Bottom: a
// sphere coloured by its world normal, whose impostor must show the face that looks at the camera. Each
// atlas view is one layer of an array texture that the surface reads with `depth(layer).sample(uv)`.
export async function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "world-impostor-draw", ({ renderer, scene, camera }) => {
    camera.fov = 30;
    camera.position.set(0, 0.6, 5);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    scene.add(new THREE.AmbientLight(0xffffff, 1.2));
    const sun = new THREE.DirectionalLight(0xffffff, 2);
    sun.position.set(0.5, 1, 3);
    scene.add(sun);

    const geometry = new THREE.SphereGeometry(0.5, 32, 16);
    const red = new THREE.MeshStandardNodeMaterial({ color: 0xcc2222, roughness: 0.9 });
    const facing = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 });
    facing.colorNode = vec4(normalWorld.mul(0.5).add(0.5), 1);
    [red, facing].forEach((source, row) => {
      const baker = new WorldImpostorBaker();
      baker.begin(`sphere-${row}`, [{ geometry, local: new THREE.Matrix4(), material: source }]);
      let atlas;
      while (atlas === undefined) atlas = baker.step(renderer);
      const surface = new WorldImpostorSurface({
        atlas,
        center: new THREE.Vector3(),
        radius: 0.5,
        halfExtents: new THREE.Vector3(0.5, 0.5, 0.5),
        source,
      });
      const y = 0.6 - row * 1.2;
      const mesh = new THREE.Mesh(geometry, source);
      mesh.position.set(-0.6, y, 0);
      const impostor = new THREE.InstancedMesh(surface.geometry, surface.material, 1);
      impostor.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0.6, y, 0));
      impostor.frustumCulled = false;
      scene.add(mesh, impostor);
    });
    return { detail: { rows: ["red sphere", "world-normal sphere"], drawn: "source left, impostor right" } };
  });
}
