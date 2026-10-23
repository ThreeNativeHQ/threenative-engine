import { assertCondition, startVisualScene, THREE } from "./scene-support.js";
import { playClipAt } from "./planned-animation-support.js";
import { pass } from "three/tsl";
import { AnimationPlayer } from "../../../../core/src/animation.ts";
import { SkinnedBatch } from "../../../../core/src/projection-skinned.ts";
import { velocityTexture, VelocityTracker } from "../../../../core/src/render/velocity.ts";
import { createTemporalVelocityProbe } from "./temporal-velocity-probe.ts";
import { REPROJECTION_PIXELS } from "./temporal-aa-fixture.js";

export function createSkinnedMeshAnimationProof() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [-0.52, -0.8, 0, 0.52, -0.8, 0, -0.52, 0.8, 0, 0.52, 0.8, 0],
      3,
    ),
  );
  geometry.setAttribute(
    "skinIndex",
    new THREE.Uint16BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4),
  );
  geometry.setAttribute(
    "skinWeight",
    new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4),
  );
  geometry.setIndex([0, 1, 2, 2, 1, 3]);
  geometry.computeVertexNormals();

  const mesh = new THREE.SkinnedMesh(
    geometry,
    new THREE.MeshBasicMaterial({ color: 0x64dfdf, side: THREE.DoubleSide }),
  );
  const rootBone = new THREE.Bone();
  rootBone.name = "Root";
  const tipBone = new THREE.Bone();
  tipBone.name = "Tip";
  rootBone.add(tipBone);
  mesh.add(rootBone);
  mesh.bind(new THREE.Skeleton([rootBone, tipBone]));

  const clip = new THREE.AnimationClip("bone-bend", 1, [
    new THREE.NumberKeyframeTrack("Tip.rotation[z]", [0, 1], [0, Math.PI / 3]),
  ]);
  const { mixer, action } = playClipAt(mesh, clip, 0.5);
  assertCondition(mesh.isSkinnedMesh === true, "animation subject must be an upstream SkinnedMesh");
  assertCondition(mesh.skeleton.bones.length === 2, "SkinnedMesh must bind both bones");
  assertCondition(
    geometry.getAttribute("skinIndex")?.count === 4 &&
      geometry.getAttribute("skinWeight")?.count === 4,
    "SkinnedMesh must carry skin indices and weights",
  );
  assertCondition(
    Math.abs(tipBone.rotation.z - Math.PI / 6) < 1e-6,
    "AnimationMixer must evaluate the bone rotation track",
  );
  return { mesh, rootBone, tipBone, clip, mixer, action };
}

export function createRawSkinnedProof() {
  const rigs = Array.from({ length: 3 }, (_, index) => {
    const original = createSkinnedMeshAnimationProof();
    const mesh = original.mesh;
    mesh.remove(original.rootBone);
    const bones = Array.from({ length: 12 }, (_, i) => {
      const bone = new THREE.Bone();
      bone.name = `bone${i}`;
      bone.position.y = i === 0 ? 0 : 0.1;
      return bone;
    });
    for (let i = 1; i < 12; i++) bones[i - 1].add(bones[i]);
    mesh.add(bones[0]);
    const indices = mesh.geometry.getAttribute("skinIndex");
    for (let i = 0; i < indices.count; i++) indices.setXYZW(i, 11, 0, 0, 0);
    mesh.bind(new THREE.Skeleton(bones));
    mesh.position.x = index === 1 ? 0.9 : -0.9;
    return mesh;
  });
  const clip = new THREE.AnimationClip(
    "sway",
    2,
    Array.from(
      { length: 11 },
      (_, i) =>
        new THREE.NumberKeyframeTrack(`bone${i + 1}.rotation[z]`, [0, 1, 2], [-0.09, 0.09, -0.09]),
    ),
  );
  const allPlayers = rigs.map(
    (root, index) =>
      new AnimationPlayer({
        root,
        clips: [clip],
        strideSync: false,
        updateRate: index === 2 ? 1 : 4,
      }),
  );
  for (const player of allPlayers) {
    player.play("sway");
    player.update(0, true);
  }
  for (const rig of rigs) rig.updateMatrixWorld(true);
  const batch = new SkinnedBatch({ first: rigs[0], capacity: 2, velocity: true });
  batch.claim(rigs[0]);
  batch.claim(rigs[1]);
  let first = true;
  const advance = () => {
    for (const player of allPlayers) player.update(first ? 0 : 1 / 60);
    first = false;
    for (const rig of rigs) rig.updateMatrixWorld(true);
    rigs[2].skeleton.update();
    batch.begin();
    batch.write(0, rigs[0]);
    batch.write(1, rigs[1]);
    batch.end();
  };
  const point = (mesh) => {
    const result = new THREE.Vector3();
    for (const index of [0, 1, 2]) result.add(mesh.getVertexPosition(index, new THREE.Vector3()));
    return result.multiplyScalar(1 / 3).applyMatrix4(mesh.matrixWorld);
  };
  return {
    rigs: rigs.slice(0, 2),
    players: allPlayers.slice(0, 2),
    batch,
    advance,
    stockUpdate: THREE.Skeleton.prototype.update,
    receipt: () => batch.mesh.userData["threenative.animationPosePackets"](),
    points: () => ({ raw: point(rigs[2]), retired: point(rigs[1]) }),
    dispose: () => {
      batch.dispose();
      for (const player of allPlayers) player.dispose();
      for (const rig of rigs) {
        rig.geometry.dispose();
        rig.material.dispose();
      }
    },
  };
}

export function createSkinnedVelocityPass(scene, camera) {
  const scenePass = pass(scene, camera);
  velocityTexture(scenePass);
  return scenePass;
}

export async function startScene(canvas, dimensions) {
  const proof = createSkinnedMeshAnimationProof();
  let complete;
  let failed;
  const finished = new Promise((resolve, reject) => {
    complete = resolve;
    failed = reject;
  });
  const deadline = setTimeout(() => failed(new Error("RAW velocity proof timed out")), 30000);
  // Readback assertions finish before startScene resolves and the entry opens startup readiness.
  const state = await startVisualScene(
    canvas,
    dimensions,
    "skinned-mesh-animation",
    ({ renderer, scene, camera }) => {
      scene.add(proof.mesh);
      const raw = createRawSkinnedProof();
      scene.add(raw.batch.mesh);
      const scenePass = createSkinnedVelocityPass(scene, camera);
      const pipeline = new THREE.RenderPipeline(renderer);
      pipeline.outputNode = scenePass.getTextureNode("output");
      const tracker = new VelocityTracker();
      const probe = createTemporalVelocityProbe(renderer, scene, camera, scenePass, raw.points);
      let frame = 0;
      let retired = false;
      let restored = false;
      let restoredRefresh = false;
      let previousRetiredHeld = false;
      let done = false;
      let stopped = false;
      let updateCalls = 0;
      let heldUpdateCalls = 0;
      let evaluatedUpdateCalls = 0;
      let frameUpdateCalls = 0;
      let draws = 0;
      raw.batch.mesh.onAfterRender = () => {
        draws += 1;
      };
      const override = function () {
        updateCalls += 1;
        frameUpdateCalls += 1;
        raw.stockUpdate.call(this);
      };
      const detail = {
        clip: proof.clip.name,
        bones: 2,
        tipRotation: proof.tipBone.rotation.z,
        rawVelocity: null,
      };
      const render = async () => {
        if (stopped) return;
        try {
          frameUpdateCalls = 0;
          if (!done) raw.advance();
          else {
            raw.batch.begin();
            raw.batch.write(0, raw.rigs[0]);
            raw.batch.write(1, raw.rigs[1]);
            raw.batch.end();
          }
          const metadata = raw.receipt();
          const held = raw.players.map((player) => !player.updateRateReport.evaluated);
          if (held[1]) heldUpdateCalls += frameUpdateCalls;
          else evaluatedUpdateCalls += frameUpdateCalls;
          if (restored && !held[1]) {
            assertCondition(
              metadata.slots[1].retired && !metadata.slots[1].currentRaw,
              "a genuine refresh after method restoration must retain stock retirement",
            );
            restoredRefresh = true;
          }
          tracker.update(scene);
          probe.before();
          const priorDraws = draws;
          pipeline.render();
          await probe.read();
          tracker.commit(scene);
          assertCondition(draws > priorDraws, "RAW consumer must actually draw");
          frame += 1;
          if (!done && retired && restoredRefresh && previousRetiredHeld && held.every(Boolean)) {
            assertCondition(
              metadata.slots[0].currentRaw && metadata.slots[0].previousRaw,
              "left current and previous packets must remain RAW",
            );
            assertCondition(
              restored &&
                raw.rigs[1].skeleton.update === raw.stockUpdate &&
                metadata.slots[1].retired &&
                !metadata.slots[1].currentRaw &&
                !metadata.slots[1].previousRaw,
              "restoring the stock method must preserve permanent stock retirement",
            );
            const samples = probe.observation()?.samples;
            const left = samples?.find((sample) => sample.name === "raw");
            const right = samples?.find((sample) => sample.name === "retired");
            assertCondition(left && right, "both actual velocity texels must be observed");
            for (const sample of [left, right])
              assertCondition(
                Number.isFinite(sample.errorPixels) &&
                  Number.isFinite(sample.misregistrationPixels) &&
                  sample.errorPixels <= REPROJECTION_PIXELS &&
                  sample.misregistrationPixels <= REPROJECTION_PIXELS,
                `${sample.name} velocity must match its independent stock reference within ${REPROJECTION_PIXELS} px`,
              );
            assertCondition(
              left.expectedPixels > 0 && left.measuredPixels > 0,
              "held RAW must consume nonzero previous-position motion",
            );
            assertCondition(
              right.expectedPixels === 0 && right.measuredPixels === 0,
              "consecutive held stock displays must consume zero velocity",
            );
            assertCondition(heldUpdateCalls === 0, "held retirement must not call author update");
            detail.rawVelocity = {
              frame,
              draws,
              samples,
              modes: metadata.slots,
              updateCalls,
              heldUpdateCalls,
              evaluatedUpdateCalls,
              restored,
              restoredRefresh,
              precisionPixels: REPROJECTION_PIXELS,
            };
            raw.rigs[0].skeleton.bones[5].add(new THREE.Object3D());
            raw.advance();
            assertCondition(
              !raw.receipt().slots[0].currentRaw,
              "a bone attachment must retire the GPU pose so both use CPU bones",
            );
            detail.attachmentStock = true;
            done = true;
            clearTimeout(deadline);
            complete();
          }
          if (retired && !restored && metadata.slots[1].retired && held[1]) {
            raw.rigs[1].skeleton.update = raw.stockUpdate;
            restored = true;
          }
          previousRetiredHeld = retired && held.every(Boolean);
          if (!retired && held.every(Boolean) && metadata.slots.every((slot) => slot.currentRaw)) {
            raw.rigs[1].skeleton.update = override;
            retired = true;
          }
          assertCondition(
            done || frame < 24,
            "RAW held/retired velocity prerequisite was never observed",
          );
        } catch (error) {
          stopped = true;
          clearTimeout(deadline);
          failed(error);
        }
      };
      return {
        ...proof,
        raw,
        detail,
        render,
      };
    },
    { awaitRender: true },
  );
  await finished;
  return state;
}
