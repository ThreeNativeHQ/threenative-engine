import { AnimationClip, Object3D, PerspectiveCamera, VectorKeyframeTrack } from "three";
import { describe, expect, it } from "vitest";
import { AnimationPlayer } from "../src/animation.js";

// A walk that carries its root 1 m per clip-second, held by first-person hands under a camera that
// walks at 5 m/s. The camera moves the hands; their clip is not what carries them.
function viewmodel(strideSync?: boolean) {
  const camera = new PerspectiveCamera();
  const holder = new Object3D();
  const root = new Object3D();
  camera.add(holder);
  holder.add(root);
  const walk = new AnimationClip("walk", 2, [
    new VectorKeyframeTrack(".position", [0, 2], [0, 0, 0, 0, 0, 2]),
  ]);
  const player = new AnimationPlayer({
    clips: [walk],
    root,
    strideRoot: holder,
    ...(strideSync === undefined ? {} : { strideSync }),
  });
  player.play("walk");
  for (let tick = 0; tick < 4; tick++) {
    camera.position.z += 0.05;
    camera.updateMatrixWorld(true);
    player.update(0.01);
  }
  return { action: player.mixer.clipAction(walk), player };
}

describe("stride sync on a camera-carried rig", () => {
  it("keeps the authored rate when the camera, not the clip, moves the rig", () => {
    const { action, player } = viewmodel();
    expect(action.getEffectiveTimeScale()).toBe(1);
    expect(player.stride.synced).toBe(false);
    expect(player.stride.cameraCarried).toBe(true);
    player.dispose();
  });

  it("still syncs when the game names strideSync: true", () => {
    const { action, player } = viewmodel(true);
    expect(action.getEffectiveTimeScale()).toBe(3);
    expect(player.stride.synced).toBe(true);
    expect(player.stride.cameraCarried).toBe(true);
    player.dispose();
  });
});
