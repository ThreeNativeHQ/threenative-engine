import * as THREE from "three/webgpu";
import {
  Fn,
  If,
  float,
  instanceIndex,
  instancedArray,
  int,
  positionLocal,
  vec3,
  workgroupArray,
  workgroupBarrier,
} from "three/tsl";
import { assertCondition, startVisualScene } from "./scene-support.js";

// PRD-913: 64 threads sum 1..64 through workgroup memory, a barrier between each halving step, and thread 0 writes the
// result. The scene reads the sum back (it must be exactly 2080) and colours a box from the same GPU value, so the
// owned engine and upstream three are compared on the pixels too.
const THREADS = 64;
const EXPECTED = (THREADS * (THREADS + 1)) / 2;

export async function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "workgroup-reduction", async ({ renderer, scene }) => {
    const total = instancedArray(1, "float");
    const kernel = Fn(() => {
      const partial = workgroupArray("float", THREADS);
      partial.element(instanceIndex).assign(float(instanceIndex).add(1));
      workgroupBarrier();
      for (let stride = THREADS / 2; stride >= 1; stride /= 2) {
        If(instanceIndex.lessThan(stride), () => {
          partial.element(instanceIndex).addAssign(partial.element(instanceIndex.add(stride)));
        });
        workgroupBarrier();
      }
      If(instanceIndex.equal(0), () => {
        total.element(0).assign(partial.element(int(0)));
      });
    })().compute(THREADS);
    await renderer.computeAsync(kernel);

    const observed = new Float32Array(await renderer.getArrayBufferAsync(total.value))[0];
    assertCondition(observed === EXPECTED, `workgroup reduction summed ${observed}, expected ${EXPECTED}`);

    // 1 when the GPU sum is right: the box is green; any other sum tints it red.
    const ratio = total.element(0).div(EXPECTED);
    const material = new THREE.MeshBasicNodeMaterial();
    material.colorNode = vec3(float(1).sub(ratio).abs().mul(8), ratio.mul(0.8), 0.3);
    material.positionNode = positionLocal;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 1.4), material);
    mesh.rotation.set(0.5, 0.7, 0);
    scene.add(mesh);
    return { mesh, detail: { threads: THREADS, sum: observed, expected: EXPECTED } };
  });
}
