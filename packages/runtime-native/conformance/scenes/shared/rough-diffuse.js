import { useRoughDiffuse } from "../../../../core/src/render/rough-diffuse.ts";
import { THREE, assertCondition, startVisualScene } from "./scene-support.js";

/**
 * PRD-653: a rough surface takes direct light the way Unreal's Substrate shades it. Three grey spheres share
 * one row under a sun behind the camera and a lamp of 10 cm Source Radius at the side. The left and right
 * spheres take `roughDiffuse` (rough 1 and rough 0.5); the middle one is the same rough-1 material left on
 * Lambert, so the frame shows the model's effect and the browser and the native engine must draw it alike.
 */
export function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "rough-diffuse", ({ scene, camera }) => {
    camera.position.set(0, 0.3, 5);
    camera.lookAt(0, 0, 0);

    const geometry = new THREE.SphereGeometry(0.6, 48, 32);
    const sphere = (x, roughness) => {
      const mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({ color: 0xb4b4b4, roughness, metalness: 0 }),
      );
      mesh.position.set(x, 0, 0);
      return mesh;
    };
    const rough = sphere(-1.6, 1);
    const lambert = sphere(0, 1);
    const smooth = sphere(1.6, 0.5);
    const marked = new THREE.Group();
    marked.add(rough, smooth);
    scene.add(marked, lambert);
    assertCondition(useRoughDiffuse(marked) === 2, "both marked spheres must take the model");
    assertCondition(lambert.material.roughDiffuse !== true, "the middle sphere must stay Lambert");

    const sun = new THREE.DirectionalLight(0xffffff, 2.5);
    sun.position.set(1.5, 3, 6);
    const lamp = new THREE.PointLight(0xffd9b0, 30, 0, 2);
    lamp.position.set(-3, 1.2, 2.5);
    lamp.sourceRadius = 0.1;
    scene.add(sun, sun.target, lamp);
    return { lamp, lambert, rough, smooth, sun, detail: { lampSourceRadius: lamp.sourceRadius } };
  });
}
