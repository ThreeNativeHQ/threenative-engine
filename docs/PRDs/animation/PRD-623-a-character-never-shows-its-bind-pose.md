# PRD-623 — A character never shows its bind pose

**Status:** NOT STARTED
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

- [ ] AC-1 [local]: A unit test proves that a player started with a looping clip has a non-bind skeleton pose before its first `update` call. It fails before the fix and passes after. proof: `pnpm exec vitest run packages/core/__tests__/<animation spec>` — Evidence: pending.
- [ ] AC-2 [local]: In every template with an animated character, the first rendered frame on the web shows the clip pose, not the bind pose. proof: a playtest scenario that captures frame 1 and asserts the pose (a bone rotation or a pixel probe against the bind-pose capture) — Evidence: pending.
- [ ] AC-3 [local]: The same scenario passes on the desktop player (`--target desktop`). proof: playtest `--target desktop` — Evidence: pending.

## Execution Phases

#### Phase 1: Reproduce
**Status:** NOT STARTED
**Files:** a new playtest scenario per affected template; a failing unit test in `packages/core/__tests__/`.
**Implementation:** List the affected templates. Capture frames 0 to 5 headed (`--browser-recipe webgpu`, check `adapter.info`) and name the first frame that shows the clip pose. Write the AC-1 test and show it RED.
**Verification:** the AC-1 test fails for the bind-pose reason, not for a setup error.
- [ ] The affected templates are listed, each with the first frame that shows the clip pose. proof: the Phase 1 playtest captures — Evidence: pending.
- [ ] The AC-1 test is RED on `origin/develop`. proof: `pnpm exec vitest run packages/core/__tests__/<animation spec>` — Evidence: pending.

#### Phase 2: Fix in core and prove on both targets
**Status:** NOT STARTED
**Files:** `packages/core/src/animation.ts` (or the shared seam that Phase 1 identifies), the test and scenarios from Phase 1.
**Implementation:** Pose the skeleton at clip start, as described in Solution step 2. Run the template playtests (`pnpm test:templates` for the affected kits) and the scenarios on web and desktop. A visual judge compares BEFORE/AFTER of the first frames (2 runs per arm). The only intended change is that the T-pose flash is gone.
**Verification:** AC-1 GREEN, AC-2 and AC-3 pass, and the judge returns IMPROVEMENT on the first frames and NEUTRAL elsewhere.
- [ ] The core fix lands and the AC-1 test is GREEN. proof: the same vitest — Evidence: pending.
- [ ] The affected templates' playtests pass. proof: `pnpm test:templates` for the affected kits — Evidence: pending.
