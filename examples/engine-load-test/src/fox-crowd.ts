// PRD-464 R3's characters: 50 `SkeletalMesh3D` instances (the `AnimationPlayer` subclass that clones a rig
// safely) of one imported Fox. Where the import comes from is the caller's: the web and legacy-host arms
// decode it with `GLTFLoader` (`ladder-characters.ts`), the owned engine reads a cooked package entry
// (`ladder-characters-engine.ts`). This module is imported by the ThreeNative arms only, never by
// `plain.ts`, so the control arm's served graph still contains no framework code.
import { type AnimationClip, Box3 } from "three";
import { SkeletalMesh3D } from "../../../packages/core/src/skeletal-mesh.js";
import type { ICharacterCrowd } from "./game.js";
import { LADDER_CHARACTERS, LADDER_CLIP, characterStagger, foxScale } from "./ladder.js";

export interface IFoxImport {
  animations: AnimationClip[];
  scene: object;
}

export function foxCrowdFrom(gltf: IFoxImport): ICharacterCrowd {
  const clip = gltf.animations.find((animation) => animation.name === LADDER_CLIP);
  if (clip === undefined) throw new Error("TN_BENCH_FOX_CLIP_MISSING");
  const clipSeconds = clip.duration;
  const players: SkeletalMesh3D[] = [];
  const staggers: number[] = [];
  for (let index = 0; index < LADDER_CHARACTERS; index += 1) {
    // `requiredClips` fails closed at load time if the rig cannot play the clip, so a fox that
    // loads but binds nothing cannot become 50 silently frozen meshes.
    const character = new SkeletalMesh3D({
      clips: [clip],
      requiredClips: [LADDER_CLIP],
      source: gltf.scene as never,
      strideSync: false,
    });
    character.play(LADDER_CLIP);
    players.push(character);
    staggers.push(characterStagger(index, clipSeconds));
  }
  // One scale for the whole crowd, measured off the first instance before it is posed: the Khronos
  // Fox is authored in centimetres, so a raw import is a 79 m statue rather than a fox, and the rung
  // would be measuring a camera full of overdraw instead of skinning. Every instance gets the same
  // factor, and the runner's gate reads the measured height back off the scene rather than trusting
  // this arithmetic. `game.ts` applies it, because the placement is where the scale belongs.
  const probe = players[0] as SkeletalMesh3D;
  // Bind-pose box, the definition `game.ts` reads back and Godot's `get_aabb()` reports; a posed one
  // would scale the fox by the pose it happened to be in when the clip started.
  const raw = new Box3().setFromObject(probe.root, false); // engine-override: the cross-engine Fox check needs the bind-pose mesh box Godot's get_aabb() reports; normaliseToMetres measures a crown bone
  if (raw.isEmpty()) throw new Error("TN_BENCH_FOX_EMPTY_BOUNDS");
  return {
    scale: foxScale(raw.max.y - raw.min.y),
    skinnedMeshes: players.length,
    dispose: () => {
      for (const character of players) character.dispose();
    },
    objects: () => players.map((character) => character.root),
    // The pose is an absolute function of the frame index plus this character's own phase, never of
    // elapsed time — the same discipline `cameraPose` and the point-light orbit follow, so a slow
    // arm and a fast arm draw the same 50 poses at frame 317.
    step: (frameIndex: number) => {
      for (let index = 0; index < players.length; index += 1) {
        (players[index] as SkeletalMesh3D).mixer.setTime(
          (staggers[index] as number) + frameIndex / 60,
        );
      }
    },
  };
}
