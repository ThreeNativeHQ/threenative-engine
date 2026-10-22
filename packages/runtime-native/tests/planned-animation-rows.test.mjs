import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, vi } from "vitest";

import { createMixerAnimationProof } from "../conformance/scenes/shared/mixer-animation.js";
import { createMorphTargetAnimationProof, startScene as startMorphScene } from "../conformance/scenes/shared/morph-target-animation.js";
import { startVisualScene, THREE } from "../conformance/scenes/shared/scene-support.js";

vi.mock("../conformance/scenes/shared/scene-support.js", async (original) => ({
  ...await original(),
  startVisualScene: vi.fn(),
}));
import {
  assertAnimatedGltf,
  assertPbrHelmet,
  loadAnimatedGltf,
  loadPbrHelmet,
  playClipAt,
} from "../conformance/scenes/shared/planned-animation-support.js";
import { advanceRotationWithRaf } from "../conformance/scenes/shared/raf-rotation.js";
import { createSkinnedMeshAnimationProof } from "../conformance/scenes/shared/skinned-mesh-animation.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const sceneNames = [
  "planned-animation-support.js",
  "gltf-pbr-helmet.js",
  "gltf-animation-clip.js",
  "raf-rotation.js",
  "mixer-animation.js",
  "skinned-mesh-animation.js",
  "morph-target-animation.js",
];

test("row 45 parses deterministic glTF PBR material and geometry with upstream GLTFLoader", async () => {
  const proof = await loadPbrHelmet();
  assert.equal(proof.helmet.material.type, "MeshStandardMaterial");
  assert.equal(proof.helmet.material.metalness, 0.72);
  assert.equal(proof.helmet.material.roughness, 0.28);
  assert.equal(proof.helmet.geometry.getAttribute("position").count, 9);
  assert.throws(
    () => assertPbrHelmet({ scene: { getObjectByName: () => null } }),
    /PBRHelmet mesh/u,
  );
});

test("row 46 parses and evaluates an upstream glTF AnimationClip", async () => {
  const proof = await loadAnimatedGltf();
  assert.equal(proof.clip.name, "helmet-glide");
  assert.equal(proof.clip.tracks.length, 1);
  const { mixer } = playClipAt(proof.gltf.scene, proof.clip, 0.5);
  assert.equal(mixer.time, 0.5);
  assert.ok(Math.abs(proof.animatedRoot.position.y - 0.075) < 1e-6);
  assert.throws(() => assertAnimatedGltf({ scene: proof.gltf.scene, animations: [] }), /AnimationClip/u);
});

test("row 50 advances only through three requestAnimationFrame callbacks", async () => {
  const subject = { rotation: { y: 0 } };
  let timestamp = 10;
  const requested = [];
  const scheduleFrame = (callback) => {
    requested.push(callback);
    queueMicrotask(() => {
      timestamp += 16;
      callback(timestamp);
    });
  };
  const samples = await advanceRotationWithRaf(subject, scheduleFrame);
  assert.equal(requested.length, 3);
  assert.deepEqual(samples, [26, 42, 58]);
  assert.ok(Math.abs(subject.rotation.y - Math.PI / 4) < 1e-6);
});

test("rows 51 through 53 exercise mixer, skeleton, and morph target semantics", () => {
  const mixer = createMixerAnimationProof();
  assert.equal(mixer.mixer.time, 0.5);
  assert.ok(Math.abs(mixer.subject.rotation.y - Math.PI / 2) < 1e-6);

  const skinned = createSkinnedMeshAnimationProof();
  assert.equal(skinned.mesh.isSkinnedMesh, true);
  assert.equal(skinned.mesh.skeleton.bones.length, 2);
  assert.ok(Math.abs(skinned.tipBone.rotation.z - Math.PI / 6) < 1e-6);

  const morph = createMorphTargetAnimationProof();
  assert.equal(morph.mesh.morphTargetInfluences.length, 1);
  assert.ok(Math.abs(morph.mesh.morphTargetInfluences[0] - 0.65) < 1e-6);
});

test("row 53 replaces rendered morph geometry between completed frames and disposes the original once", async () => {
  const events = [];
  const geometries = [];
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const renderer = {
    backend: { device: { queue: { onSubmittedWorkDone: async () => { events.push("completed"); } } } },
    render(currentScene, currentCamera) {
      assert.equal(currentScene, scene);
      assert.equal(currentCamera, camera);
      const mesh = scene.children[0];
      assert.ok(Math.abs(mesh.morphTargetInfluences[0] - 0.65) < 1e-6);
      assert.deepEqual(mesh.rotation.toArray(), [-0.25, 0.55, 0.1, "XYZ"]);
      geometries.push(mesh.geometry);
      events.push("render");
      if (geometries.length === 1) mesh.geometry.addEventListener("dispose", () => events.push("disposed"));
    },
  };
  startVisualScene.mockImplementationOnce(async (_canvas, _dimensions, _type, build) => build({ renderer, scene, camera }));
  vi.stubGlobal("requestAnimationFrame", (callback) => {
    events.push("raf");
    queueMicrotask(() => callback(0));
  });
  try {
    const subject = await startMorphScene({}, { width: 1280, height: 720 });
    assert.equal(geometries.length, 2, "both old and replacement geometry must be drawn");
    assert.notEqual(geometries[0].uuid, geometries[1].uuid);
    assert.equal(subject.mesh.geometry, geometries[1]);
    assert.deepEqual(geometries[0].morphAttributes.position[0].array, geometries[1].morphAttributes.position[0].array);
    assert.equal(subject.detail.originalGeometry, geometries[0].uuid);
    assert.equal(subject.detail.replacementGeometry, geometries[1].uuid);
    assert.equal(subject.detail.originalDisposals, 1);
    assert.deepEqual(events, ["raf", "render", "completed", "disposed", "raf", "render", "completed"]);
    subject.mesh.geometry.dispose();
    subject.mesh.material.dispose();
  } finally {
    vi.unstubAllGlobals();
  }
});

test("all six rows are same-source, fail-closed, deterministic, and target-neutral", () => {
  const source = sceneNames
    .map((name) => readFileSync(join(root, "conformance/scenes/shared", name), "utf8"))
    .join("\n");
  assert.doesNotMatch(
    source,
    /fetch\(|XMLHttpRequest|document\.|window\.|navigator\.|process\.|android|desktop|Math\.random/u,
  );
  assert.match(source, /requestAnimationFrame/u);
  assert.match(source, /new THREE\.AnimationMixer/u);
  assert.match(source, /new THREE\.SkinnedMesh/u);
  assert.match(source, /morphAttributes\.position/u);
  assert.equal((source.match(/startVisualScene\(/gu) || []).length, 6);
});
