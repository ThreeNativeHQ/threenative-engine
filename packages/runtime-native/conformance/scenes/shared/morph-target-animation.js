import { assertCondition, startVisualScene, THREE } from "./scene-support.js";
import { playClipAt } from "./planned-animation-support.js";
import { assertSubmittedWorkPromise } from "./screenshot-completion.js";

export function createMorphTargetAnimationProof() {
  const geometry = new THREE.BoxGeometry(0.95, 0.95, 0.95, 2, 2, 2);
  const positions = geometry.getAttribute("position");
  const morphed = new Float32Array(positions.array.length);
  for (let index = 0; index < positions.count; index += 1) {
    const offset = index * 3;
    morphed[offset] = positions.getX(index) * (positions.getY(index) > 0 ? 1.65 : 1);
    morphed[offset + 1] = positions.getY(index) + (positions.getY(index) > 0 ? 0.32 : 0);
    morphed[offset + 2] = positions.getZ(index);
  }
  geometry.morphAttributes.position = [new THREE.Float32BufferAttribute(morphed, 3)];
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({ color: 0xff6b6b, wireframe: false }),
  );
  mesh.updateMorphTargets();
  const clip = new THREE.AnimationClip("morph-expand", 1, [
    new THREE.NumberKeyframeTrack(".morphTargetInfluences[0]", [0, 1], [0, 1]),
  ]);
  const { mixer, action } = playClipAt(mesh, clip, 0.65);
  assertCondition(
    geometry.morphAttributes.position.length === 1,
    "morph animation geometry must contain a position target",
  );
  assertCondition(
    mesh.morphTargetInfluences?.length === 1,
    "Mesh must expose one morph target influence",
  );
  assertCondition(
    Math.abs(mesh.morphTargetInfluences[0] - 0.65) < 1e-6,
    "AnimationMixer must evaluate the morph target influence track",
  );
  return { mesh, clip, mixer, action };
}

export function startScene(canvas, dimensions) {
  const proof = createMorphTargetAnimationProof();
  proof.mesh.rotation.set(-0.25, 0.55, 0.1);
  return startVisualScene(canvas, dimensions, "morph-target-animation", async ({ renderer, scene, camera }) => {
    scene.add(proof.mesh);
    const queue = renderer.backend?.device?.queue;
    assertCondition(typeof queue?.onSubmittedWorkDone === "function", "Morph replacement requires GPU queue completion");
    await new Promise((resolve) => requestAnimationFrame(resolve));
    renderer.render(scene, camera);
    const oldCompletion = queue.onSubmittedWorkDone();
    assertSubmittedWorkPromise(oldCompletion, "original-morph-render");
    await oldCompletion;

    const original = proof.mesh.geometry;
    const influence = proof.mesh.morphTargetInfluences[0];
    let originalDisposals = 0;
    original.addEventListener("dispose", () => { originalDisposals++; });
    proof.mesh.geometry = original.clone();
    proof.mesh.updateMorphTargets();
    proof.mesh.morphTargetInfluences[0] = influence;
    original.dispose();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    renderer.render(scene, camera);
    const replacementCompletion = queue.onSubmittedWorkDone();
    assertSubmittedWorkPromise(replacementCompletion, "replacement-morph-render");
    await replacementCompletion;
    assertCondition(original.uuid !== proof.mesh.geometry.uuid, "Morph geometry must be replaced");
    assertCondition(originalDisposals === 1, "Original morph geometry must be disposed exactly once");
    assertCondition(Math.abs(proof.mesh.morphTargetInfluences[0] - 0.65) < 1e-6, "Replacement must preserve morph influence");
    return {
      ...proof,
      detail: {
        clip: proof.clip.name,
        influence: proof.mesh.morphTargetInfluences[0],
        originalGeometry: original.uuid,
        replacementGeometry: proof.mesh.geometry.uuid,
        originalDisposals,
      },
    };
  });
}
