# Animation

Create independently animated characters from one loaded model, play their clips, and keep their
feet in step with their movement.

## Create a character

`SkeletalMesh3D` clones a loaded model with its own skeleton, so one guard can walk while another
stands still. Geometry and materials stay shared between clones.

```ts
import { SkeletalMesh3D } from "@threenative/core";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";

const gltf = await ctx.assets.model<GLTF>("characters/guard.glb");
const guard = new SkeletalMesh3D({
  source: gltf.scene,
  clips: gltf.animations,
  requiredClips: ["idle", "walk"],
  size: { metres: 1.8, axis: "height" },
});
ctx.add(guard.root);
guard.play("idle");
```

Call `guard.update(dt)` once per frame from the scene update. That keeps animation time on the
game loop.

| Option | Purpose |
| --- | --- |
| `source` | The loaded model root, such as `gltf.scene` |
| `clips` | The model's animation clips |
| `requiredClips` | Clip names the character needs, checked at construction |
| `size` | Scale to a real size: `metres` plus `axis` (`"height"` or `"longest"`) |
| `strideRoot` | The object whose travel counts as ground covered |
| `strideSync` | Set `false` to keep authored playback rates |

## Clips

A clip holds one action, such as idle, walk or attack. Check the names in the imported file, then
list them in `requiredClips`. The constructor throws if a required clip binds no tracks to the
rig. It also throws if one is missing, and that error lists the clips the file does have.

The map form, such as `{ walk: "Walk_Cycle" }`, checks the values. It does not rename anything.
`play` still takes the file's clip name, so keep the map in your code as a lookup table.

`play(name, { fade, mode })` switches clips. `mode` is `"loop"` by default. `"once"` plays through
and holds the last frame.

Clips need a skeleton that matches the model's bone hierarchy. Renaming a clip only changes its
label. To use animations from another rig, retarget them onto your skeleton with the asset MCP's
`asset_retarget_animations` before they enter `assets/`: it fetches the donor releases, fits their
clips to a prepared target skeleton and writes each one back into a GLB. Inspect with
`asset_inspect_rig` first, and preview the result with `asset_preview_animation`.

## Compose locomotion and actions

`SkeletalMesh3D` plays one clip at a time. `AnimationComposer` layers several on one mixer:

```ts
import { AnimationComposer, BlendSpace1D } from "@threenative/core";

const animation = new AnimationComposer({ root: rig, clips, samples: ["walk", "run"] });
const blend = new BlendSpace1D([0, 2]);
animation.setWeights(blend.sample(speed));
animation.update(dt);
```

| Class | Does |
| --- | --- |
| `AnimationComposer` | One base phase, one masked override (reload the upper body while locomotion continues), at most two additive layers and eight actions. Source clips stay immutable. |
| `BlendSpace1D`, `BlendSpace2D` | Select finite, normalized weights from sorted thresholds or a fixed triangulation — speed for 1D, forward and strafe intent for 2D. Duplicate samples and collinear triangles throw at initialization. |
| `SpringBoneChain3D` | Unreal's `AnimNode_SpringBone`: a ponytail, tail or ears that swing. CPU, fixed step, at most 32 bones per chain; call `step(dt)` once per fixed step. |
| `attachToBone` | Put a game-owned object in a named bone: `attachToBone(character, "RightHand", rifle)`. |

Root motion needs its own rig below the body: advance the rig, call `CharacterBody3D.move`, finish
with the observed accepted motion after physics, then run existing IK. It excludes velocity-driven
stride sync, and an unsupported parent transform throws.

Check a new character in the game:

1. Compare its height and facing beside an object of known size.
2. Play each required clip, including the return to idle after an action.
3. Place two characters and give them different clips.
4. Move it at gameplay speed and watch its feet from the game camera.

## Stride sync

Stride sync matches a looping walk or run to the ground the character actually covers. It is on
by default and clamps the playback rate between 0.15x and 3x. Clips played with `mode: "once"`,
such as attacks, keep their authored rate.

If your controller moves a parent object and the rig sits inside it, pass that parent as
`strideRoot`. Otherwise the player measures the rig's own root, which the clip itself moves. Set
`strideSync: false` to keep authored rates. `guard.stride` still reports the measurement.

Your game decides when to walk, run or stop. Let the character controller own movement and the
animation player own the pose. Keep one source of movement, especially when a clip has root
motion (movement baked into the animation).

## Cleanup

When a scene ends, remove the character and its update callback, then call `dispose()` on the
player. Leave shared geometry and textures alone while other instances use them. Restart the
scene once to confirm the character builds again cleanly.

## Source

- [skeletal-mesh.ts](../../packages/core/src/skeletal-mesh.ts)
- [animation.ts](../../packages/core/src/animation.ts)
- [scale.ts](../../packages/core/src/scale.ts)
