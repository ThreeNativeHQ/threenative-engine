import * as THREE from "three/webgpu";
import { SoftBody3D } from "@threenative/core";
import { startVisualScene } from "./scene-support.js";

// A skinned cape on a three-bone character, simulated by the shipped `SoftBody3D` solver on both hosts.
// The character moves for a fixed number of steps during setup; the frame loop only draws, so every host
// captures the same cloth state whichever frame it reads back.
const STEPS = 60;

export function assertSoftBodyCharacterProof(cloth) {
  if (cloth?.isMesh !== true || cloth.debug?.().skinned !== true) {
    throw new Error("Softbody-character proof requires a skinned SoftBody3D.");
  }
  if (!(cloth.warmupNodes?.length > 0)) {
    throw new Error("Softbody-character proof requires the solver's compute nodes.");
  }
}

function skin(geometry, boneIndex) {
  const count = geometry.getAttribute("position").count;
  const index = new Uint16Array(count * 4);
  const weight = new Float32Array(count * 4);
  for (let v = 0; v < count; v++) {
    index[v * 4] = boneIndex;
    weight[v * 4] = 1;
  }
  geometry.setAttribute("skinIndex", new THREE.BufferAttribute(index, 4));
  geometry.setAttribute("skinWeight", new THREE.BufferAttribute(weight, 4));
  return geometry;
}

export async function startScene(canvas, dimensions) {
  return startVisualScene(
    canvas,
    dimensions,
    "softbody-character",
    async ({ camera, renderer, scene }) => {
      const hips = new THREE.Bone();
      hips.position.set(0, 1, 0);
      const chest = new THREE.Bone();
      chest.position.set(0, 0.4, 0);
      const head = new THREE.Bone();
      head.position.set(0, 0.4, 0);
      hips.add(chest);
      chest.add(head);
      const root = new THREE.Group();
      root.add(hips);
      scene.add(root);
      root.updateMatrixWorld(true);
      const skeleton = new THREE.Skeleton([hips, chest, head]);
      const bodyMaterial = new THREE.MeshStandardNodeMaterial({ color: 0xb08a6a, roughness: 0.7 });
      const body = new THREE.SkinnedMesh(
        skin(new THREE.CylinderGeometry(0.15, 0.15, 0.4, 24, 6).translate(0, 1.6, 0), 1),
        bodyMaterial,
      );
      root.add(body);
      body.bind(skeleton);
      const capeGeometry = skin(
        new THREE.PlaneGeometry(0.5, 0.8, 10, 14).translate(0, 1.4, -0.25),
        1,
      );
      const position = capeGeometry.getAttribute("position");
      const colour = new Float32Array(position.count * 3);
      for (let v = 0; v < position.count; v++) colour[v * 3] = position.getY(v) > 1.79 ? 1 : 0;
      capeGeometry.setAttribute("color", new THREE.BufferAttribute(colour, 3));
      const capeMaterial = new THREE.MeshStandardNodeMaterial({
        color: 0x4f8fd0,
        roughness: 0.55,
        side: THREE.DoubleSide,
      });
      const cape = new THREE.SkinnedMesh(capeGeometry, capeMaterial);
      root.add(cape);
      cape.bind(skeleton);
      root.updateMatrixWorld(true);

      const cloth = new SoftBody3D(cape, {});
      scene.add(cloth);
      assertSoftBodyCharacterProof(cloth);
      const key = new THREE.DirectionalLight(0xfff2e0, 3.2);
      key.position.set(1.2, 1.8, -2.6);
      scene.add(key, key.target, new THREE.AmbientLight(0x8fb8d8, 0.55));

      // A game warms its pipelines before the first frame; that compile plans the draw before the frame's
      // first uniform upload, which once built a bind group around no uniform buffer (PRD-910).
      await renderer.compileAsync(scene, camera);
      // The character walks forward and turns for one second; the cape trails and swings.
      for (let step = 0; step < STEPS; step++) {
        root.position.z = 0.03 * step;
        chest.rotation.y = 0.4 * Math.sin(step / 9);
        root.updateMatrixWorld(true);
        cloth.process(renderer);
      }
      camera.position.set(0.45, 1.4, root.position.z - 1.15);
      camera.lookAt(0, 1.3, root.position.z);
      return {
        detail: {
          bodyCapsules: cloth.debug().bodyCapsules,
          skinned: true,
          steps: STEPS,
          substeps: cloth.debug().substeps,
        },
        mesh: cloth,
      };
    },
  );
}
