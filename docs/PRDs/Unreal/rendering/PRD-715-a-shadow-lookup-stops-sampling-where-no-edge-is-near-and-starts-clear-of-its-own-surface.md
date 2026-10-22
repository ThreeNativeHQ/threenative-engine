---
prd_contract: v1
---

# PRD-715 — A shadow lookup stops sampling where no edge is near and starts clear of its own surface

**Status:** NOT STARTED
**Priority:** P2 — Phase 1 is open: the source-angle shadow filter loads 16 blocker texels and 16 filter texels for every pixel, even a pixel far from any shadow, and its bias is a fixed world-unit constant, while Unreal stops early and scales its offset with the camera.
**Complexity:** 4 (MEDIUM) — 1–2 core files (+1), a cost gate (+1), the same rule on the owned engine (+2); risk override: none
**Owner:** João
**Depends on:** `docs/PRDs/Unreal/look/PRD-634-sun-shadows-reach-the-horizon-and-soften-with-distance-from-the-caster.md` (on `feat/unreal-look-epic`) for `sourceAngleShadowFilter`. Coordinates with `docs/PRDs/Unreal/shadows/PRD-652-the-shadow-tier-follows-unreal-shadow-quality-levels.md`, which owns the sample counts, and `docs/PRDs/Unreal/shadows/PRD-649-shadow-calibration-scenes-are-built-in-unreal-and-judged-until-parity.md`, whose `ScreenRayLength` ablation is this PRD's Phase 1 evidence for the screen ray.

## Context

**Unreal LOC:** about 1,000 of the 4,389 projection lines: the ray loop 783, the screen ray 86 and the bias helpers 168. **Port estimate:** about 120 to 180 lines in the core filter, plus the same in the owned engine's shadow shader.

### What Unreal does (UE 5.8.3, read 2026-10-21; clean-room summary, no code copied)

- **Fewer rays where nothing changes.** `r.Shadow.Virtual.SMRT.AdaptiveRayCount` is 1 by default
  (`UE 5.8.3: Engine/Source/Runtime/Renderer/Private/VirtualShadowMaps/VirtualShadowMapArray.cpp:675-680`).
  After the first ray, a group of pixels leaves the loop when every pixel missed a caster. After the
  count of rays, it also leaves when every pixel hit one, which means full shadow
  (`UE 5.8.3: Engine/Shaders/Private/VirtualShadowMaps/VirtualShadowMapProjectionDirectional.ush:280-303`,
  local lights at `VirtualShadowMapProjection.usf:622-640`). The vote is per wave, so the group leaves
  together and the saving is real. The pass runs in compute only.
- **A short screen-space ray before the shadow ray.** `r.Shadow.Virtual.ScreenRayLength` is 0.015
  of the scene depth (`VirtualShadowMapArray.cpp:660-665`, scaled at `VirtualShadowMapProjection.usf:976`).
  The ray takes 4 depth-buffer steps with a dither and stops 1.5 steps before the first sample behind
  geometry. It returns the length at which the shadow ray starts, so the shadow ray skips the
  ambiguous zone next to the receiver (`VirtualShadowMapScreenRayTrace.ush:6-61`, used at
  `VirtualShadowMapProjection.usf:359-372`).
- **A normal offset that follows the lens.** `r.Shadow.Virtual.NormalBias` is 0.5. The offset along the
  normal is that value times the camera distance over the cotangent of the half field of view, never
  under 0.02 (`VirtualShadowMapArray.cpp:667-672`, `VirtualShadowMapProjectionCommon.ush:203-208`).
  The offset is a constant number of screen pixels.
- **A slope bias from the surface.** The shader builds the depth slope of the geometric normal in
  shadow space and multiplies it by the offset from the lookup point to the texel centre. It doubles
  the result, clamps it to 100 times the depth scale and scales it for the level that answered
  (`VirtualShadowMapProjectionCommon.ush:329-362`).

### ThreeNative today

- `sourceAngleShadowFilter` (on the epic branch, `packages/core/src/render/soft-shadow.ts`) runs
  `blockerSamples` and `filterSamples` loads, 16 each by default, in unrolled loops. A pixel with no
  blocker still runs the second loop and discards its result at the end.
- `receiverPlaneBias` (default true, `packages/core/src/render/virtual-shadow.ts:214-217`) measures
  the receiver plane across a level's texel. This matches the slope bias. The normal offset is the
  authored `shadow.normalBias`, a fixed world-unit number. A camera that moves from 2 m to 200 m from
  the same wall sees the same offset in metres and a different one in pixels.
- No screen-space start ray exists. `PRD-561` declined screen-space contact shadows. This ray is not
  that feature. It draws nothing. It moves the start of a lookup.
- `PRD-649` plans an Unreal ablation of `ScreenRayLength 0` against the default on `penumbra-lab/contact`.
  It records a result and builds nothing.

## Solution

**The gate first (Phase 1).** Time the filter on the starter at 1920 × 1080 on the RTX 2080 with the
early exit as a test arm. **Continue** only if the arm saves at least 0.3 ms GPU with no pixel
changing by more than one level of 8 bit. Read PRD-649's `ScreenRayLength` ablation. **Continue to
the screen ray** only if its contact-edge delta is above the PRD-631 L5 threshold. Record both under
`## Decisions` and delete the phase that fails.

**The mapping (Phases 2 and 3).**

| Unreal part | ThreeNative part | Layer |
| --- | --- | --- |
| Adaptive ray count | `sourceAngleShadowFilter` and `sourceRadiusShadowFilter` return after the first 4 blocker loads find nothing, and skip the filter loop when no blocker was found | core mechanism |
| Screen ray length | option `screenRayLength` on the filters, default off until the gate says | core mechanism |
| Normal bias over camera distance | option `normalBiasScale` on `VirtualShadowNode`, in pixels, default from the gate | core mechanism |

- **Auto by default.** The early exit has no option. It must give the same result. A game reads the
  saved cost from the shadow marker.
- **Unreal names.** `screenRayLength` and `normalBias` keep Unreal's names in camelCase.
- **Deferred, not built:** the wave vote. WebGPU subgroups are an extension. The per-pixel exit is
  the portable form. Revisit if a measured tile shows no saving because lanes diverge.

## Acceptance Criteria

- [ ] AC-1 [local]: With the early exit on, the filter returns the same visibility as with it off for 1,000 seeded receivers, within 1/255. proof: `pnpm exec vitest run packages/core/__tests__/soft-shadow.spec.ts` — Evidence: pending.
- [ ] AC-2 [local]: The early exit lowers the shadow GPU time by at least 0.3 ms on the starter at 1920 × 1080. proof: `node packages/playtest/dist/runner/cli.js perf`, exit on against off — Evidence: pending.
- [ ] AC-3 [local]: A wall seen from 2 m and from 200 m shows the same normal offset in pixels, within 20%. proof: `pnpm exec vitest run packages/core/__tests__/virtual-shadow.spec.ts` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Early exit in the two filters | every template that sets a source-angle or source-radius filter | Replaces the unconditional second loop | AC-1, AC-2 |
| `normalBiasScale`, `screenRayLength` | `VirtualShadowNode` options | Add to the authored `shadow.normalBias`, which stays the override | AC-3 |

## Execution Phases

#### Phase 1: What does the early exit save, and does the screen ray matter?
**Status:** NOT STARTED
**Files:** `packages/core/src/render/soft-shadow.ts` (test arm only)
- [ ] The GPU time of the filter with and without the early exit is recorded with the verdict under `## Decisions`. proof: `node packages/playtest/dist/runner/cli.js perf` on the starter, two runs per arm.
- [ ] The PRD-649 `ScreenRayLength` ablation delta on the contact pose is copied under `## Decisions` with the verdict. proof: `pnpm unreal-look:compare --scene shadow:penumbra-lab --metric contact`.

#### Phase 2: The early exit and the distance-scaled offset
**Status:** NOT STARTED
**Files:** `packages/core/src/render/soft-shadow.ts`, `packages/core/src/render/virtual-shadow.ts`, `packages/core/__tests__/soft-shadow.spec.ts`
- [ ] AC-1 holds, and a receiver with no blocker runs 4 loads, not 32. proof: red-green `pnpm exec vitest run packages/core/__tests__/soft-shadow.spec.ts` (load count read from the built node).
- [ ] AC-3 holds. proof: red-green `pnpm exec vitest run packages/core/__tests__/virtual-shadow.spec.ts`.

#### Phase 3: Native and judge
**Status:** NOT STARTED
**Files:** `packages/runtime-native/src/engine/shader/standard.cpp`, `packages/runtime-native/conformance/scenes/shared/shadow-early-exit.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] The owned engine takes the same exit and matches the browser. proof: `pnpm parity --target desktop --only-tests shadow-early-exit`.
- [ ] A fresh visual judge returns NEUTRAL or IMPROVEMENT on the L5 sphere-row pose, 2 runs per arm. proof: headed `--browser-recipe webgpu` captures judged by a fresh read-only subagent.
**Verification:** AC-1 to AC-3.
