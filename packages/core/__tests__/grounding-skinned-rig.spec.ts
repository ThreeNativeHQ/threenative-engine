import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type AnimationClip, Group, type Object3D } from "three";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { describe, expect, it } from "vitest";
import { GroundSnap } from "../src/grounding.js";
import { measureThreePose, posedBounds } from "../src/pose-measure.js";
import { normaliseToMetres } from "../src/scale.js";
import { SkeletalMesh3D } from "../src/skeletal-mesh.js";

const MANNEQUIN = fileURLToPath(
  new URL("../../create-threenative/template-assets/assets/mannequin.glb", import.meta.url),
);

async function loadMannequin(): Promise<{ scene: Object3D; animations: AnimationClip[] }> {
  const bytes = readFileSync(MANNEQUIN);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  await MeshoptDecoder.ready;
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  return new Promise((resolve, reject) => loader.parse(buffer, "", resolve, reject));
}

// The templates' shipped mannequin (Quaternius UAL, Unreal-style skeleton), set up exactly the way
// minimal and starter do: SkeletalMesh3D, normalised to its Head joint, feet sunk to the capsule.
describe("GroundSnap on the shipped skinned mannequin", () => {
  it("measures the posed feet where the skin actually is", async () => {
    const gltf = await loadMannequin();
    const character = new SkeletalMesh3D({
      source: gltf.scene,
      clips: gltf.animations,
      requiredClips: ["Idle_Loop", "Jog_Fwd_Loop"],
    });
    const figure = character.root;
    normaliseToMetres(figure, { axis: "height", metres: 1.545 });
    const snap = new GroundSnap(figure, { enabled: false });
    // The templates ground before the first animation update, so the envelope is first measured
    // in whatever pose the rig loads in — that order is what the game runs.
    snap.apply(figure, 0, 1 / 30);
    for (const clip of ["Idle_Loop", "Jog_Fwd_Loop"]) {
      character.play(clip);
      for (let step = 0; step < 20; step += 1) {
        character.update(1 / 30);
        snap.apply(figure, 0, 1 / 30);
        const envelope = posedBounds(figure).min[1];
        const skin = measureThreePose(figure).bounds?.min[1] ?? Number.NaN;
        expect(Math.abs(envelope - skin), `${clip} step ${step}`).toBeLessThan(0.04);
      }
    }
  });

  // Seen in the running starter: a frame rendered the figure, then the player was placed (raised
  // to its capsule, turned to face the level) and GroundSnap calibrated. SkinnedMesh refreshes its
  // bindMatrixInverse only in updateMatrixWorld — the renderer's call — not in updateWorldMatrix,
  // so the skin was measured at the figure's old transform: a finger got a 3.8 m sphere and every
  // later frame snapped the figure 0.66 m into the air while its own clearance read zero.
  it("calibrates against the skin where it is now, not where the last render left it", async () => {
    const gltf = await loadMannequin();
    const character = new SkeletalMesh3D({
      source: gltf.scene,
      clips: gltf.animations,
      requiredClips: ["Idle_Loop"],
    });
    const figure = character.root;
    normaliseToMetres(figure, { axis: "height", metres: 1.545 });
    figure.updateMatrixWorld(true); // a frame renders the figure where it was built
    figure.position.set(-2, 0.9, 0); // then the player is placed…
    figure.rotation.y = Math.PI; // …and turned to face the level
    const snap = new GroundSnap(figure, { enabled: false });
    snap.apply(figure, 0, 1 / 30);
    character.play("Idle_Loop");
    for (let step = 0; step < 30; step += 1) {
      character.update(1 / 30);
      figure.updateMatrixWorld(true); // the render each frame
      const envelope = posedBounds(figure).min[1];
      const skin = measureThreePose(figure).bounds?.min[1] ?? Number.NaN;
      expect(Math.abs(envelope - skin), `step ${step}`).toBeLessThan(0.04);
    }
  });
});

// PRD-898 J4: a grounded character pays one posed measurement per apply, not two, and on the owned
// engine that measurement is one `__tnSphereBounds` call with no JavaScript matrix walk.
describe("GroundSnap measures once per apply", () => {
  async function walkingFigure(): Promise<{ figure: Object3D; character: SkeletalMesh3D }> {
    const gltf = await loadMannequin();
    const character = new SkeletalMesh3D({
      source: gltf.scene,
      clips: gltf.animations,
      requiredClips: ["Jog_Fwd_Loop"],
    });
    normaliseToMetres(character.root, { axis: "height", metres: 1.545 });
    character.play("Jog_Fwd_Loop");
    return { figure: character.root, character };
  }

  /** Counts the subtree walks `posedBounds` makes: `updateWorldMatrix(true, true)` on the model. */
  function countWalks(figure: Object3D): () => number {
    let walks = 0;
    const original = figure.updateWorldMatrix.bind(figure);
    figure.updateWorldMatrix = (parents: boolean, children: boolean) => {
      if (parents && children) walks += 1;
      original(parents, children);
    };
    return () => walks;
  }

  it("walks the subtree once, and the clearance matches a fresh measurement to 1e-6", async () => {
    const { figure, character } = await walkingFigure();
    const holder = new Group();
    holder.position.set(3, 0.4, -1);
    holder.rotation.y = 0.7;
    holder.add(figure);
    const snap = new GroundSnap(figure, { maxRate: 0.5 });
    snap.apply(figure, 0.25, 1 / 30); // calibrates the envelope
    const walks = countWalks(figure);
    for (let step = 0; step < 20; step += 1) {
      character.update(1 / 30);
      const before = walks();
      snap.apply(figure, 0.25, 1 / 30);
      expect(walks() - before, `step ${step}`).toBe(1);
      const fresh = posedBounds(figure).min[1] - 0.25;
      expect(Math.abs((snap.clearance ?? Number.NaN) - fresh), `step ${step}`).toBeLessThan(1e-6);
    }
  });

  it("measures again when the moved group does not carry the model", async () => {
    const { figure, character } = await walkingFigure();
    const elsewhere = new Group();
    const snap = new GroundSnap(figure);
    snap.apply(elsewhere, 0, 1 / 30);
    character.update(1 / 30);
    const walks = countWalks(figure);
    snap.apply(elsewhere, 0, 1 / 30);
    expect(walks()).toBe(2);
    expect(Math.abs((snap.clearance ?? Number.NaN) - posedBounds(figure).min[1])).toBeLessThan(
      1e-9,
    );
  });

  it("asks the engine once per apply and walks nothing in JavaScript where the engine answers", async () => {
    const { figure, character } = await walkingFigure();
    const snap = new GroundSnap(figure);
    snap.apply(figure, 0, 1 / 30); // the envelope, calibrated on the JavaScript path
    // The engine's answer, computed here the way bindings_scene.cpp computes it.
    let engineCalls = 0;
    const walk = figure.updateWorldMatrix.bind(figure);
    (figure as Object3D & { __tnSphereBounds?: unknown }).__tnSphereBounds = (
      objects: readonly Object3D[],
      radii: readonly number[],
    ) => {
      engineCalls += 1;
      walk(true, true);
      const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      objects.forEach((object, i) => {
        const e = object.matrixWorld.elements;
        for (let axis = 0; axis < 3; axis += 1) {
          box[axis] = Math.min(
            box[axis] as number,
            (e[12 + axis] as number) - (radii[i] as number),
          );
          box[3 + axis] = Math.max(
            box[3 + axis] as number,
            (e[12 + axis] as number) + (radii[i] as number),
          );
        }
      });
      return box;
    };
    const walks = countWalks(figure);
    for (let step = 0; step < 10; step += 1) {
      character.update(1 / 30);
      const calls = engineCalls;
      snap.apply(figure, 0, 1 / 30);
      expect(engineCalls - calls).toBe(1);
    }
    expect(walks()).toBe(0);
    // The engine's answer equals the JavaScript path's on the same pose.
    const engineMin = posedBounds(figure).min[1];
    Reflect.deleteProperty(figure, "__tnSphereBounds");
    expect(Math.abs(posedBounds(figure).min[1] - engineMin)).toBeLessThan(1e-9);
  });
});
