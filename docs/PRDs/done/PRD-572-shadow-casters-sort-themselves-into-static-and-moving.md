---
prd_contract: v1
---

# PRD-572 — Shadow casters sort themselves into static and moving

**Status:** DONE 2026-10-09
**Priority:** P2 — was open until this PRD: a caster that moves without a `trackCaster` call keeps a stale shadow in the cached levels until the camera moves a level window.
**Complexity:** 3 (LOW) — 1–5 engine files (1): `render/virtual-shadow.ts`; complex state (+2): a per-caster classification that changes over frames. Risk override: none.
**Owner:** João
**Depends on:** None. Sits beside [PRD-457](../Unreal/rendering/PRD-457-virtual-shadows-scale-by-measurement.md) (which names this gap and leaves it out of scope) and [PRD-538](PRD-538-shadow-maps-redraw-only-what-streamed-in.md) (region redraws, which this PRD uses for its transitions).

## Context

`VirtualShadowNode` (`packages/core/src/render/virtual-shadow.ts`) keeps camera-centred clip
levels cached until their window moves. Moving objects are kept out of that cache by hand:

- The game calls `trackCaster(object)` (`virtual-shadow.ts:1110-1121`). That enables
  `VIRTUAL_SHADOW_MOVER_LAYER` (layer 29, `:369`) on the object and its children, so each level's
  mover camera draws it into a small per-level mover map every frame. The fragment takes the darker
  of the cached map and the mover map (`:707-711`).
- The docblock requires it: "call `trackCaster(object)` for movers" (`:735`), and the starter
  `AGENTS.md` repeats it (`packages/create-threenative/templates/starter/AGENTS.md:79`).
- `trackCaster` and `untrackCaster` call `invalidateAll()` (`:1119`, `:1130`), which redraws every
  level for one object.

Nothing outside the proof harness calls it. The only callers in the repo are
`packages/core/scripts/vsm-proof/proof.ts:121` and the unit specs. The reference consumer,
`examples/abyss-framework/src/scenes/WorldProbe.ts:116`, installs the node and tracks nothing.

The failure: a caster that moves while the camera holds still is baked into a cached level at its
old position. Its shadow stays there until that level's window moves. A cold agent does not know
the call exists, and the auto-by-default rule says the engine should decide what it can measure.
Movement is measurable: a world matrix changed, an instance matrix buffer changed, or a mesh
deforms.

### What Unreal does (UE 5.8.3, read 2026-10-09)

- **Any invalidation makes a caster dynamic.** When a primitive invalidates its shadow pages, the
  cache manager marks it dynamic and records the frame number
  (`Engine/Source/Runtime/Renderer/Private/VirtualShadowMaps/VirtualShadowMapCacheManager.cpp:1767-1782`).
- **It returns to static after a quiet period.** `r.Shadow.Virtual.Cache.FramesStaticThreshold`
  defaults to 100 frames (`VirtualShadowMapCacheManager.cpp:142-146`). Each frame, a dynamic
  primitive whose last invalidation is older than that wants static (`:1797-1810`).
- **The transition back to static redraws only that primitive's pages.** UE adds an invalidation
  for that primitive for every light, with a force-static flag, so its shadow moves into the
  static cache once (`VirtualShadowMapCacheManager.cpp:1811-1832`). It does not redraw the whole map.
- **A removed primitive resets.** Its dynamic flag clears and its last-invalidation frame becomes
  "unknown" (`VirtualShadowMapCacheManager.cpp:1784-1793`).

## Solution

The node classifies its own casters each frame in `updateBefore` (`virtual-shadow.ts:2229`), after
three has updated world matrices for the frame:

1. **Measure movement exactly.** For each shadow-casting object on layer 0, compare against the
   value stored at the last frame: the 16 world-matrix elements for a `Mesh`, and
   `instanceMatrix.version` for an `InstancedMesh`. A deforming caster (`SkinnedMesh`, or a mesh
   with active morph targets) counts as moving every frame it is visible, as UE treats deforming
   primitives.
2. **Moving → mover.** A caster that moved and is not a mover yet gets the mover layer, the same
   state `trackCaster` sets. The cached levels redraw only the region of its **old** bounds
   (`invalidateRegion`, `:1152`), so the stale baked shadow goes away. The levels do not
   redraw in full.
3. **Quiet → static.** A mover with no movement for `staticAfterFrames` frames (default 100, UE's
   value) leaves the mover layer, and its **current** bounds region redraws once, so its shadow
   enters the cache.
4. **Overrides.** `trackCaster(object)` stays and pins the object as a mover, so it never returns
   to static. A new `pinStatic(object)` opts an object out of detection. `staticAfterFrames` is a
   node option. Reports: `TN_VIRTUAL_SHADOW` gains `autoMovers` and `autoTransitions`.
5. **Out of scope.** GPU-scene keys and world-cell batches already invalidate through PRD-538's
   region path, so this PRD does not scan them.

This is measurement, not a guess. `packages/core/src/static-transform.ts:15-21` forbids guessing
staticness from "not moved in 60 frames", because a wrong guess there drops a transform update.
Here a wrong guess costs one region redraw, never a stale shadow. Movement is detected again on
the next frame it happens, and the caster becomes a mover again in that same frame.

Risk: the scan is O(shadow casters) every frame. Phase 1 measures it on the reference game. If it
costs more than 0.05 ms of JS, the scan skips subtrees under a frozen static-transform root, whose
movement `static-transform.ts` already checks once per frame.

## Acceptance Criteria

- [x] AC-1 [local]: In the VSM proof harness, a sphere that moves for 12 frames with no `trackCaster` call, under a still camera, has a shadow that matches the stock shadow arm within the harness's changed-pixel bound on every frame. proof: `sh scripts/xvfb.sh pnpm exec tsx packages/core/scripts/vsm-proof/run.mjs` (new `track=auto` arm, adapter named in `out/results.json`, not SwiftShader). Result 2026-10-09 (re-run after the two judge fixes), adapter `nvidia | turing`, two runs, exit 0: changed-pixel ratio of `auto` against the moving stock arm is 0.0002-0.0005 on all 12 moving frames including the one the sphere starts to move (single bound 0.01), identical to the `manual` (`trackCaster`) arm; on develop the same two arms read 0.0213-0.0307 untracked and 0.0024-0.0034 tracked. The `autoSettle` arm (ball stopped, `staticAfter=4`, 14 quiet frames) is 0.0002 against the stock shadow on all 14. The `pinned` arm, the node before this change, is 0.019-0.031 on every frame the sphere is away from its baked place. Visual judge (fresh subagent, BEFORE/AFTER/STOCK, frames 4, 6, 9 and settled, two runs per arm byte-identical): frame 4 IMPROVEMENT (one shadow at stock's place, develop's stands still), frame 6 IMPROVEMENT, frame 9 NEUTRAL (AFTER identical to BEFORE, both within 39 px of stock; BEFORE is only right there because its frozen shadow happens to sit where the sphere passes), settled NEUTRAL (same), overall IMPROVEMENT; Decisions, 2026-10-09 second judge.
- [x] AC-2 [local]: In `examples/abyss-framework`, a caster that moves while the camera holds still reports as an automatic mover, and the cached levels do not redraw in full. proof: `pnpm --filter abyss-framework playtest:shadow-movers` (the scenario with `--live-clock`, `?world&shadowMovers`, `--browser-recipe webgpu`; see Decisions for why it is not the fixed-step command). Result 2026-10-09, re-run after the judge fixes with the 800-tick settle wait (see Decisions), adapter `nvidia | turing`, `clock: wall-clock`, exit 0, 880 runner frames, last step at shadow frame 276: peak `autoMovers` 1, `autoTransitions` 2 (mover, then static), `autoMovers` back to 0, 5 level renders since the first mover against 3 levels, 3 mover-map renders while it moved.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Automatic mover classification | Any scene with `light.shadow.shadowNode = new VirtualShadowNode(...)` → `VirtualShadowNode.updateBefore` (`virtual-shadow.ts:2229`) | `trackCaster` stays as the "always a mover" override. `invalidateAll` on track/untrack becomes a region redraw. | AC-1, AC-2 |

## Execution Phases

#### Phase 1: Classification in the node

**Status:** DONE 2026-10-09
**Files:** `packages/core/src/render/virtual-shadow.ts`; `packages/core/__tests__/virtual-shadow.spec.ts`
**Implementation:** Store the last world matrix or instance-matrix version per caster. Run the transitions above. Report `autoMovers` and `autoTransitions` in the stats and the marker. Change the `@constraint` line so that `trackCaster` reads as an override, not a requirement.

- [x] A moved caster becomes a mover in the same frame, and only its old-bounds region is invalidated. proof: `pnpm exec vitest run packages/core/__tests__/virtual-shadow.spec.ts`. Result: 12 new specs green (99 in the file); the same 12 fail on the pre-change source.
- [x] A mover returns to static after `staticAfterFrames` quiet frames, and only its current-bounds region is invalidated. proof: `pnpm exec vitest run packages/core/__tests__/virtual-shadow.spec.ts`. Result: 12 new specs green (99 in the file); the same 12 fail on the pre-change source.
- [x] `trackCaster` pins a mover, `pinStatic` excludes an object, a deforming mesh stays a mover while visible, and an object with `castShadow = false` is never scanned. proof: `pnpm exec vitest run packages/core/__tests__/virtual-shadow.spec.ts`. Result: 12 new specs green (99 in the file); the same 12 fail on the pre-change source.
- [x] On `examples/abyss-framework`, the classification scan costs at most 0.05 ms JS per frame. proof: the `shadow-movers` scenario asserts `shadowAutoScanMs` (the node's `autoScanMs`, the mean scan time over its lifetime) `lte 0.05`, `--browser-recipe webgpu`. Result 2026-10-09, adapter `nvidia | turing`: 0.0046-0.022 ms at the three observations of three runs, 0.005-0.012 ms at the end of the run. The skip-frozen-subtrees fallback in Risk is not needed.

#### Phase 2: Proof on a real adapter and in the example

**Status:** DONE 2026-10-09
**Files:** `packages/core/scripts/vsm-proof/proof.ts` (a `track=auto` arm); `examples/abyss-framework/src/scenes/WorldProbe.ts` (one moving caster); `examples/abyss-framework/playtests/shadow-movers.playtest.json` (new); `packages/create-threenative/templates/starter/AGENTS.md` and its mirrors
**Implementation:** Add the harness arm and the example caster. Update the starter guidance so that movers are automatic and `trackCaster` / `pinStatic` are overrides.

- [x] The `track=auto` harness arm passes AC-1 on a hardware WebGPU adapter. proof: `sh scripts/xvfb.sh pnpm exec tsx packages/core/scripts/vsm-proof/run.mjs`. Result: exit 0, adapter `nvidia | turing` on every arm in `out/results.json`; numbers in AC-1.
- [x] The `shadow-movers` scenario passes AC-2. proof: the AC-2 command. Result: pass, 6 of 6 component assertions and diagnostics; numbers in AC-2.
- [x] The starter `AGENTS.md` describes automatic movers, and the mirrors and capability manifest are in sync. proof: `pnpm sync:agents --check && pnpm build && pnpm exec vitest run scripts/__tests__/primary-docs.spec.ts`. Result: all three exit 0 (23 mirrors in sync, `pnpm build` regenerated both `capabilities.json` and the capability reference, the primary-docs and sync-agent-docs specs green). `packages/core/src/index.ts` carried a second copy of the node's JSDoc that still said "call `trackCaster(object)` for movers"; it now repeats the new constraints.

## Decisions

- **2026-10-09, the detection frame is one correct shadow, at a measured cost (supersedes "the detection frame has its own bound").** The first judge saw the baked blob beside the new shadow on the frame a caster starts to move: the node asked the levels that read the old spot one per frame, finest first, and the finest level barely overlaps it, so the level that actually selects it waited a frame. A level that selects part of an urgent region (the region is not wholly inside a finer level's guarded window) now takes its redraw on that same frame, past the one-render budget of PRD-473; every other level keeps the budget. Cost, measured: the detection frame renders 2 levels instead of 1 (`renderedLevels [0, 1]` then `[2]`, against `[0]`, `[1]`, `[2]`), the sequence's total renders are unchanged at 3, and it happens once per caster transition, at most one render per level. A caster whose old spot the finest level holds alone adds nothing (spec). The harness bound for that frame fell from 0.0106 to 0.0003 and the separate 0.015 bound is gone. Not measured: the extra 1 level render's GPU time on the Pixel 8; it is one level's redraw already owed one frame later.
- **2026-10-09, a mover keeps the cached levels' texel density.** The mover map defaulted to half of `mapSize`, so a caster drew a softer edge while it was a mover and popped crisp when it settled; the judge saw the same softness on frame 9 as a lumpy edge. Demotion was not missing: with `staticAfter=4` the caster left the mover state 4 frames after it stopped and matched stock (0.0002); a `mover=1024` arm matched stock while moving. The default is now `mapSize` (`moverMapSize` still lowers it). Cost, computed from the target sizes the spec pins: +4.5 MiB at 3 levels x 512, +18 MiB at 3 x 1024, +192 MiB at 2 x 4096, RGBA8 plus a 4-byte depth allowance. The mover draw itself fills `moverMapSize^2` texels per level per frame while a mover exists, 4x what it did; not measured on a device. A game that cannot afford that sets `moverMapSize` and takes the soft mover edge it had.
- **2026-10-09, visual judge on the same pose.** BEFORE (develop node), AFTER and STOCK were captured on `nvidia | turing`, two runs per arm, byte-identical between runs; a fresh read-only subagent judged the three panels. Frames 6 and 9: intended (AFTER within 1-3 px of the stock shadow, BEFORE 55 px stale). Frame 4, the frame the sphere starts to move: regression, transient (the baked shadow shows beside the new one for that single frame; 0.0021 of the frame differs from stock against 0.0050 BEFORE). Overall: minor regression limited to that frame, which is the detection frame the first Decisions entry bounds. The softer edge it saw on frames 6 and 9 is the existing mover-map render: AFTER is byte-identical to the `trackCaster` arm there, and that arm is byte-identical on develop. Images and the judge's reasons: PR #477 comment `prd-572-screenshots`.
- **2026-10-09, second judge, after the fixes.** Same pose, `nvidia | turing`, two runs per arm byte-identical, develop built from `origin/develop`'s `virtual-shadow.ts`; a fresh read-only subagent judged BEFORE/AFTER/STOCK triptychs of frames 4, 6, 9 and the settled frame. Frame 4: IMPROVEMENT (AFTER one shadow at stock's place; BEFORE's stands at the old spot). Frame 6: IMPROVEMENT. Frame 9: NEUTRAL (AFTER and BEFORE are the same pixels there, 0 changed, and both are 39 px from stock; the first judge's softer-than-BEFORE finding is gone). Settled: NEUTRAL, same. Overall: IMPROVEMENT. It still reads AFTER's penumbra as slightly fuzzier than stock on frame 6 and settled, and says BEFORE shares the settled one; the cached-level shadow differs from stock by 0.0002 of the frame, which is the engine's own filter, not this change. Images and reasons: PR #477 comment `prd-572-screenshots`.
- **2026-10-09, the AC-1 bound is the harness's own.** The harness had no changed-pixel bound to reuse, so `AUTO_TRACK_BOUND = 0.01` is about three times the stock-versus-virtual noise of the `manual` arm and half of the smallest stale frame of the `pinned` arm.
- **2026-10-09, the new arms read cached levels on purpose.** They pass `near=1` (depth range 30, light distance 12) because the node's default depth reach puts this 40 m scene's casters outside the cached maps, which hid every stale shadow, including the `pinned` one, on develop too. The first-frame assertion of the old harness (every level rendered on the first frame) had been stale since the one-level-per-frame budget landed; it is corrected in the same commit.
- **2026-10-09, AC-2 runs on the live clock.** The fixed-step runner renders about one frame per scenario step, so 100 quiet frames cannot pass in it. `--live-clock` lets the host pump frames while the runner waits. The 400-tick wait reached shadow frame 183 on a host at load average 47 while the sphere starts moving near shadow frame 85, so the run ended before the 100 quiet frames and failed with `shadowAutoMovers` 1; the wait is 800 ticks now, which ends at shadow frame 276 with `shadowAutoTransitions` 2. The report says `clock: wall-clock`. The scenario sets no option, so the default of 100 is what it proves.
- **2026-10-09, the example sphere receives shadows.** Nothing in `WorldProbe` receives shadows (`WorldCells` terrain takes no `receiveShadow` option and its default is false), and a scene with no receiver builds no shadow node, so `shadowFrame` stays 0 and `world-flythrough.playtest.json` fails its `shadowFrame`, `shadowRendered` and `shadowDeferrals` assertions in the fixed-step runner, and it fails the same three with `virtual-shadow.ts`, `index.ts` and `WorldProbe.ts` taken from `9d4b2a67f` (the lane's base), so this PRD did not cause it. The sphere sets `receiveShadow` so the node runs. The flythrough regression is filed with the lead, not fixed here.
