# Animation composition proof game

This authored nine-bone character uses the public `AnimationComposer`, one Three.js mixer,
1D walk/run weights, 2D walk/run/strafe weights, a masked reload and a referenced additive
recoil. The example owns its geometry, material, clips, timing and IK target. It uses the
existing Three.js `CCDIKSolver` after the final authored pose.

`CompositionCharacter` is the fixed-step caller: propose root translation/yaw, queue existing
`CharacterBody3D` movement, observe accepted Rapier movement in `afterPhysics`, finish the
pose, then solve IK. Consumed skin-root translation stays zero. The body has no second
velocity/stride owner. The source clips are shared and checked unchanged on scene exit.

Run `pnpm --filter animation-composition dev`. Controls are W to walk, Shift+W to run, D to
strafe, R to reload, F for recoil, C to cancel both layers, P to pause/resume, Space to reset
position and L to leave/re-enter the scene. Cancellation observes Spine, Arm and RightHand
local transforms before IK. Fifty separate L presses in the scenario exercise real scene
transitions and assert that owned actions and animation-buffer bytes return to zero.

Build with `pnpm --filter animation-composition build`; `build:desktop` bundles the same
`src/game.ts` entry through the existing native bundler. Vite's benchmark define defaults to
`none` when absent, including on native. The four scenarios pass schema validation. The standalone tarball consumer passes strict
typechecking, 17 public composition/layer controls, installed capability discovery and its
normal web/desktop builds. Current browser and Linux-native courses each pass 35/35
assertions and 50 scene transitions on RTX 2080 WebGPU. The three original unprofiled
100-rig pairs measure incremental CPU p95 of 0.20, 1.70 and 0.40 ms against the unchanged
2 ms ceiling. The owning PRD records source/package identity, captures, individual results
and noise; Linux correctness does not qualify native performance or other platforms.

The ordinary scenario is shared by both runtimes:

```sh
node packages/playtest/dist/runner/cli.js examples/animation-composition/playtests/composition.playtest.json --url "$TN_EXAMPLE_URL" --browser-recipe webgpu
node packages/playtest/dist/runner/cli.js examples/animation-composition/playtests/composition.playtest.json --target desktop --executable "$TN_NATIVE_EXECUTABLE"
```

Run `composition-root-negative.playtest.json` with the same entry and target as a negative
control. It deliberately requires residual skin-root translation and must fail. Inspect the
before/after captures for the animated character; scene-node counts alone do not prove
nonblank pixels.

For installed proof, use the existing `scripts/make-sandbox.ts` tarball/scaffold path outside
the repository, then copy this example's `src/`, Vite configuration and scenario files into
that consumer. Build both targets from that one installed source tree. Record the commit,
source-entry SHA-256, installed package archive SHA-256 values, lockfile, native executable
SHA-256 and each runner command/result in the owning PRD/PR. Check the installed manifest
and import graph for the public composition capability and absence of `@ggez/*` packages.
The authored fixture carries no third-party character asset.

The performance arms use the same 100 cloned rigs and geometry. `TN_ANIMATION_BENCHMARK=baseline`
selects the incumbent player's three locomotion actions; `candidate` selects synchronized
composition with eight initialized actions, including the masked and additive tracks.
Each arm discards 300 rendered frames with actual animation updates and measures the next
1,800 such frames. A frozen animation clock cannot complete this window. Artifacts also
report total presented frames, fixed-update counts and measured simulation seconds; compare
these alongside the existing playtest frame/phase series. The isolated animation CPU region
uses a preallocated sample buffer. The scenarios' draw/triangle ceilings check the crowd;
they do not establish the CPU budget.

```sh
TN_ANIMATION_BENCHMARK=baseline pnpm --filter animation-composition dev
node packages/playtest/dist/runner/cli.js examples/animation-composition/playtests/benchmark-baseline.playtest.json --url "$TN_EXAMPLE_URL" --browser-recipe webgpu --live-clock
TN_ANIMATION_BENCHMARK=candidate pnpm --filter animation-composition dev
node packages/playtest/dist/runner/cli.js examples/animation-composition/playtests/benchmark-candidate.playtest.json --url "$TN_EXAMPLE_URL" --browser-recipe webgpu --live-clock
```

Stop each arm's own dev server before starting the next. Run three baseline/candidate pairs
on the same hardware machine; record individual p95 values, candidate-minus-baseline values
and noise. The original incremental p95 animation CPU ceiling remains **2 ms/frame**. The
existing playtest performance series retains its last 1,024 frame/phase samples; the game
resource retains the exact 1,800-sample isolated animation p95. Keep both in the report.
A software adapter, skipped arm or incomplete update/window count cannot qualify the budget.
