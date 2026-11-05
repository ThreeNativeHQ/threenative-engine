import * as THREE from "three/webgpu";
import { Fn, instanceIndex, instancedArray, int, ivec2, positionLocal, textureLoad, vec3 } from "three/tsl";
import { startVisualScene } from "./scene-support.js";

// A compute kernel that reads a float DataTexture only with textureLoad (the particle sim's world table, PRD-777):
// no sampler is used, so none may be bound. Each sphere takes its colour from one texel.
export async function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "compute-texture-load", async ({ renderer, scene }) => {
    const texels = new THREE.DataTexture(
      new Float32Array([0.96, 0.32, 0.2, 1, 0.2, 0.84, 0.5, 1, 0.18, 0.58, 0.98, 1, 0.92, 0.7, 0.16, 1]),
      4,
      1,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    texels.needsUpdate = true;
    const colors = instancedArray(4, "vec3");
    const kernel = Fn(() => {
      colors.element(instanceIndex).assign(textureLoad(texels, ivec2(int(instanceIndex), int(0)), int(0)).rgb);
    })().compute(4);
    await renderer.computeAsync(kernel);
    const material = new THREE.MeshBasicNodeMaterial();
    material.positionNode = positionLocal.add(vec3(instanceIndex.toFloat().mul(0.62).sub(0.93), 0, 0));
    material.colorNode = colors.element(instanceIndex);
    const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.24, 16, 10), material, 4);
    const identity = new THREE.Matrix4();
    for (let index = 0; index < 4; index += 1) mesh.setMatrixAt(index, identity);
    scene.add(mesh);
    return { mesh, detail: { texels: 4 } };
  });
}
