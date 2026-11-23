import * as THREE from "three/webgpu";
import {
  float,
  Fn,
  instancedArray,
  instanceIndex,
  sin,
  uniform,
  vec3,
  vertexIndex,
} from "three/tsl";
import { startVisualScene } from "./scene-support.js";

const COLUMN_SEGMENTS = 10;
const ROW_SEGMENTS = 14;
const COLUMNS = COLUMN_SEGMENTS + 1;
const VERTEX_COUNT = COLUMNS * (ROW_SEGMENTS + 1);

export function assertSoftBodyCharacterProof(nodes) {
  if (
    nodes.positions?.isStorageBufferNode !== true ||
    nodes.positions.value?.isStorageInstancedBufferAttribute !== true
  ) {
    throw new Error("Softbody-character proof requires a storage-backed position buffer.");
  }
  if (nodes.positions.value.count !== VERTEX_COUNT) {
    throw new Error(`Softbody-character proof expected ${VERTEX_COUNT} position elements.`);
  }
  if (nodes.computeNode?.isComputeNode !== true) {
    throw new Error("Softbody-character proof requires a per-frame ComputeNode.");
  }
  if (nodes.frame?.isNode !== true) {
    throw new Error("Softbody-character proof requires a frame counter uniform.");
  }
  if (nodes.material?.positionNode?.isNode !== true) {
    throw new Error("Softbody-character proof must feed the position buffer into its material.");
  }
}

export async function startScene(canvas, dimensions) {
  return startVisualScene(
    canvas,
    dimensions,
    "softbody-character",
    async ({ camera, renderer, scene }) => {
      const positions = instancedArray(VERTEX_COUNT, "vec3");
      const frame = uniform(0);
      const computeNode = Fn(() => {
        const index = float(instanceIndex);
        const row = index.div(COLUMNS).floor();
        const column = index.sub(row.mul(COLUMNS));
        const sway = sin(frame.mul(0.25).add(row.mul(0.55)));
        positions.element(instanceIndex).assign(
          vec3(
            column.div(COLUMN_SEGMENTS).sub(0.5).add(sway.mul(0.04)),
            row.div(ROW_SEGMENTS).mul(-1.4).add(0.7),
            sway.mul(0.18),
          ),
        );
      })().compute(VERTEX_COUNT);

      const material = new THREE.MeshStandardNodeMaterial({ color: 0x4f8fd0, roughness: 0.55 });
      material.positionNode = positions.element(vertexIndex);
      assertSoftBodyCharacterProof({ computeNode, frame, material, positions });

      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1.4, COLUMN_SEGMENTS, ROW_SEGMENTS),
        material,
      );
      scene.add(mesh);
      const key = new THREE.DirectionalLight(0xfff2e0, 3.2);
      key.position.set(1.2, 1.8, 2.6);
      scene.add(key, key.target, new THREE.AmbientLight(0x8fb8d8, 0.55));

      // A game warms its pipelines before the first frame; that compile plans the draw before the frame's
      // first uniform upload, which once built a bind group around no uniform buffer (PRD-910).
      await renderer.compileAsync(scene, camera);
      await renderer.computeAsync(computeNode);
      let dispatchedFrames = 0;
      const render = () => {
        frame.value = dispatchedFrames + 1;
        renderer.compute(computeNode);
        renderer.render(scene, camera);
        dispatchedFrames += 1;
      };
      return {
        computeNode,
        detail: {
          columns: COLUMNS,
          computeDriven: true,
          dispatchedEveryFrame: true,
          frameCounter: true,
          material: "standard",
          rows: ROW_SEGMENTS + 1,
          vertexCount: VERTEX_COUNT,
        },
        mesh,
        positions,
        render,
      };
    },
  );
}
