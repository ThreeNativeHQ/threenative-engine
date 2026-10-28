import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AnimationMixer, type Object3D } from "three";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { modelPass } from "../src/passes/model.js";

/**
 * Dropping a track that holds the rest pose must not move a single node. This runs the real
 * `mannequin.glb` (7 clips, 1,365 tracks, about 75% of them at rest) through the real cook twice and
 * plays every clip in three's own `AnimationMixer`, so it measures what a game would see, not what
 * the pass believes it did.
 */

const MANNEQUIN = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../create-threenative/template-assets/assets/mannequin.glb",
);

async function cook(restTracks: boolean) {
  const result = await modelPass({ passes: { restTracks } }).apply(
    readFileSync(MANNEQUIN),
    "mannequin.glb",
  );
  if (Buffer.isBuffer(result)) throw new Error("the pass left the mannequin untouched");
  return result.buffer;
}

async function load(glb: Buffer) {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const bytes = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer;
  return new Promise<{ animations: import("three").AnimationClip[]; scene: Object3D }>(
    (done, fail) => loader.parse(bytes, "", done, fail),
  );
}

/** Every node's local position, quaternion and scale with the clip played to `time`. */
function pose(scene: Object3D, clip: import("three").AnimationClip, time: number): number[] {
  const mixer = new AnimationMixer(scene);
  mixer.clipAction(clip).play();
  mixer.setTime(time);
  const values: number[] = [];
  scene.traverse((node) =>
    values.push(...node.position.toArray(), ...node.quaternion.toArray(), ...node.scale.toArray()),
  );
  mixer.stopAllAction();
  return values;
}

describe("pruneRestPoseTracks on the real mannequin", () => {
  afterEach(() => vi.restoreAllMocks());

  it("should leave every node where the full cook leaves it, in every clip, at every sampled time", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await MeshoptDecoder.ready;
    const [full, pruned] = [await cook(false), await cook(true)];
    const [before, after] = [await load(full), await load(pruned)];

    expect(after.animations.map((clip) => [clip.name, clip.duration])).toEqual(
      before.animations.map((clip) => [clip.name, clip.duration]),
    );
    const tracks = (clips: typeof before.animations) =>
      clips.reduce((n, clip) => n + clip.tracks.length, 0);
    expect(tracks(after.animations)).toBeLessThan(tracks(before.animations) * 0.5);
    expect(pruned.length).toBeLessThan(full.length);

    let worst = 0;
    for (const [index, clip] of before.animations.entries()) {
      const other = after.animations[index];
      if (other === undefined) throw new Error(`clip ${clip.name} disappeared`);
      for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
        const a = pose(before.scene, clip, clip.duration * fraction);
        const b = pose(after.scene, other, clip.duration * fraction);
        expect(b.length).toBe(a.length);
        for (let i = 0; i < a.length; i += 1)
          worst = Math.max(worst, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
      }
    }
    // Float round-off of a track within 1e-6 of rest; a visible move would be orders of magnitude more.
    expect(worst).toBeLessThan(1e-5);
  });
});
