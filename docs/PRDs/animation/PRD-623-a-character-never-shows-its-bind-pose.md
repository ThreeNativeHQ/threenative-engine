# PRD-623 — A character never shows its bind pose

**Status:** PARTIAL (Phase 1 done, Phase 2 done on web, desktop open)
**Priority:** P1 — a visible defect in the templates: AC-1 to AC-3 are open, and every animated character in a scaffolded game shows it on its first frames.
**Complexity:** 2 (LOW)
**Owner:** João
**Depends on:** None

## Context

The owner reported (2026-10-17) that in some starter kits an animated character first appears in its T-pose (the rig's bind pose) for one or more frames. Then it snaps to the clip it should play, such as idle. Nobody has fixed it yet.

Two hypotheses, to confirm or reject in Phase 1:

- **A (owner, lead suspect):** the game starts before the animations are ready. The character's mesh loads and renders while its clips (a separate animation file, a retarget or an async bind) are still loading, so it shows the bind pose until they arrive. A fix then belongs in the load path: the character does not reach the screen (or the loading cover does not lift, see PRD-618) until its starting clip is bound.
- **B:** the clips are ready, but the first render happens before the mixer applies a pose. The player starts its clip only on the next update, so the skeleton is posed one frame late. A fix then poses the skeleton at clip start.

Measure how long the bind pose shows (frames and ms). A flash of many frames points at A, and a flash of one frame points at B.

Files to read first: `packages/core/src/animation.ts` (`AnimationPlayer`, line ~235), `packages/core/src/animation-composition.ts`, and where `SkeletalMesh3D` creates its player. Templates that start clips: rg `clipAction|AnimationPlayer|playAnimation` in `packages/create-threenative/templates/*/src` (action-rpg and shooter at least).

The layer is the engine, by convention ("conventions ship on by default"): every game that adds a character would otherwise need its own workaround. Fix it once, where every player routes through. A game-side fix in one template leaves the others broken.

## Solution

1. Reproduce: find each template whose character shows the bind pose on its first rendered frame, on web and desktop. Record which frame first shows the clip pose.
2. Fix in core: a character that has a clip to play is posed before the first frame that renders it. Under A: the load path waits for the starting clip before it shows the character or lifts the cover. Under B: the player applies its starting clip at time 0 (`mixer.update(0)` and a skeleton update) when the clip starts, not on the next tick. Both can be true; fix each one Phase 1 proves. A character with no clip keeps its bind pose. That is correct, and it stays observable.
3. Keep the override and the measurement: a game that wants the bind pose (a rig inspector) can still get it, and the player reports whether the convention ran.

## Acceptance Criteria

- [x] AC-1 [local]: A unit test proves that a player started with a looping clip has a non-bind skeleton pose before its first `update` call. It fails before the fix and passes after. proof: `pnpm exec vitest run packages/core/__tests__/<animation spec>` — Evidence: RED before the fix (bone at `[0, 0, 0]`, expected `[1, 2, 3]`), GREEN after: `packages/core/__tests__/animation.spec.ts` 56 passed.
- [x] AC-2 [local]: In every template with an animated character, the first rendered frame on the web shows the clip pose, not the bind pose. proof: a playtest scenario that captures frame 1 and asserts the pose (a bone rotation or a pixel probe against the bind-pose capture) — Evidence: proven by the pose probe plus screencast and the visual judge, not by a playtest scenario. The playtest vocabulary has no first-frame pose assertion and its ticks cannot see the first rendered frame. First render has a clip pose on all 5 animated templates (starter, runner, minimal, action-rpg, shooter), 2 runs each, adapter nvidia/turing: 0 bind-pose renders AFTER vs 2 to 12 BEFORE. Judge verdict IMPROVEMENT. A reusable scenario assertion stays a follow-up.
- [ ] AC-3 [local]: The same scenario passes on the desktop player (`--target desktop`). proof: playtest `--target desktop` — Evidence: not run, see the open Phase 2 desktop box.

## Execution Phases

#### Phase 1: Reproduce
**Status:** DONE
**Files:** a new playtest scenario per affected template; a failing unit test in `packages/core/__tests__/`.
**Implementation:** List the affected templates. Capture frames 0 to 5 headed (`--browser-recipe webgpu`, check `adapter.info`) and name the first frame that shows the clip pose. Write the AC-1 test and show it RED.
**Verification:** the AC-1 test fails for the bind-pose reason, not for a setup error.
- [x] The affected templates are listed, each with the first frame that shows the clip pose. proof: the Phase 1 pose probe plus CDP screencast (adapter nvidia/turing, private Xvfb) — Evidence: BEFORE run on `origin/develop` core. Every `Skeleton.update` (one per skinned mesh per render) logged the spread of its bone matrices: 0 means the bind pose. Bind-pose renders: starter 4 (2 meshes x 2 renders, 120 ms), runner 2, minimal 2, action-rpg 12 (every character, one more after the first posed row), shooter 0 on this run. The first posed render came 114 to 175 ms after the first bind render. The screencast shows the T-pose on screen for starter (frame f3 at +1107 ms, world visible, then the loading cover) and action-rpg (f5, player and enemy both in T-pose, then the cover). Runner and minimal drew a bind render while no character was visible in the neighbouring frames, so a visible flash is not shown there.
  - **A rejected, B confirmed.** The clips come from the same GLB as the mesh (`ctx.assets.model` resolves both together, `packages/core/src/assets.ts:679`), `AnimationPlayer` binds every clip in its constructor, and every template calls `play()` before `ctx.add`. No render happens with an unbound clip. The bind render comes from `play()` only scheduling the action: three applies a pose only inside `mixer.update`, which first runs on the next tick.
- [x] The AC-1 test is RED on `origin/develop`. proof: `pnpm exec vitest run packages/core/__tests__/animation.spec.ts -t "starting pose"` — Evidence: RED before the fix (`bone.position` was `[0, 0, 0]`, expected `[1, 2, 3]`: the bind pose, not a setup error).

#### Phase 2: Fix in core and prove on both targets
**Status:** DONE on web, desktop open
**Files:** `packages/core/src/animation.ts` (or the shared seam that Phase 1 identifies), the test and scenarios from Phase 1.
**Implementation:** Pose the skeleton at clip start, as described in Solution step 2. Run the template playtests (`pnpm test:templates` for the affected kits) and the scenarios on web and desktop. A visual judge compares BEFORE/AFTER of the first frames (2 runs per arm). The only intended change is that the T-pose flash is gone.
**Verification:** AC-1 GREEN, AC-2 and AC-3 pass, and the judge returns IMPROVEMENT on the first frames and NEUTRAL elsewhere.
- [x] The core fix lands and the AC-1 test is GREEN. proof: the same vitest — Evidence: `AnimationPlayer.play` and `playWeighted` now call `mixer.update(0)` once, on the first clip start (`packages/core/src/animation.ts`, `#poseAtStart`), and a public `posed` getter reports whether the convention ran (false for a rig that never played a clip, which keeps its bind pose). `pnpm exec vitest run packages/core/__tests__/animation.spec.ts`: 56 passed (the 4 "starting pose" tests were RED before). Core typecheck exit 0. `pnpm capabilities:check`: manifest fresh.
- [x] The affected templates' playtests pass. proof: `pnpm test:templates` for the affected kits — Evidence: a narrower run than `pnpm test:templates`, because that script picks ephemeral ports and the owner rule allows ports 5900-5999 only. Each kit was scaffolded from the fixed core (`createProject` plus `packageLocalFramework`), built, and run with `threenative-playtest --browser-recipe webgpu --headed --port 59xx` under the private Xvfb and the GPU lock. All scenarios passed with no failed assertion: starter 4/4, minimal 4/4, runner 3/3, action-rpg 8/8, shooter 12 of its 50-odd (the `enemy-*` scenarios that read animation: stride, stop, flinch, foot contact, rifle grip). The other shooter scenarios were not run.
- [x] The visual judge compares BEFORE/AFTER of the first frames, 2 runs per arm, and finds no regression. proof: a fresh read-only Sonnet subagent that did not write the change — Evidence: verdict **IMPROVEMENT** overall. Starter, action-rpg and shooter: IMPROVEMENT (T-pose on the first rendered frame in BEFORE, standing idle in AFTER, scene unchanged). Runner and minimal: NEUTRAL (no character on screen yet at the bind render, so no T-pose visible in either arm). Shooter note: the first-person rifle sits at a slightly different angle in AFTER, which is the rifle now starting in its clip pose. Adapter nvidia/turing on every run except `action-rpg-b2`, where the adapter query returned null (same private Xvfb and recipe). Sheets: `~/Downloads/prd623-bind-pose/` and the PR.
- [x] Measured AFTER on the same pose probe as BEFORE (2 runs per template). proof: `Skeleton.update` spread probe — Evidence: bind-pose renders at the first frame, BEFORE (2 runs) vs AFTER (2 runs): starter 4/4 vs 0/0, runner 2/2 vs 0/0, minimal 2/2 vs 0/0, action-rpg 12/12 vs 0/0, shooter 0/10 vs 0/0. The shooter's 10 in run 2 are enemies that spawn about 25 s in, and they flash too; AFTER shows none.
- [ ] The desktop player (`--target desktop`) passes the same check. proof: playtest `--target desktop` — Evidence: not run. Two reasons. (1) No scenario exists to run: the playtest vocabulary has no first-frame pose assertion, so AC-2 was proven with the probe. (2) This worktree has no native build (`packages/runtime-native/build` is absent) and the primary checkout has only `tn-linux-contracts-*` builds, no `tn-linux` player. A fresh build is a long download-and-compile. The fix is plain core JS that the native host runs unmodified, but that is a reason, not a measurement.
