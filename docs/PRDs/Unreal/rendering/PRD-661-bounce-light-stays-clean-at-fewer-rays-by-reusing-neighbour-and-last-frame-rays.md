---
prd_contract: v1
---

# PRD-661 — Bounce light stays clean at fewer rays by reusing the rays of neighbours and of the last frame

**Status:** NOT STARTED
**Priority:** P3 — Phase 1 is open: Unreal ships its ReSTIR gather in no quality tier, so this PRD builds only if the screen probe gather of PRD-640 stays noisy or over budget.
**Complexity:** 7 (HIGH) — 4–6 files: reservoirs, resampling, upsample, specs (+1), new module `restir-gather.ts` (+2), state across frames: a reservoir history (+2), native proof (+1), changes the frame cost of the high tier (+1); risk override: none
**Owner:** João
**Depends on:** PRD-640 Phase 2 (`docs/PRDs/Unreal/gi/PRD-640-pixels-gather-bounce-light-from-screen-probes-and-the-radiance-cache-answers-the-rest.md`, on `feat/unreal-look-epic`): the screen probe gather this PRD competes with. PRD-641 (the GI temporal filter, same folder) sets the noise threshold. [PRD-603](PRD-603-probes-refresh-by-tracing-the-packed-scene-not-by-drawing-it-six-times.md) Phase 2 (the BVH trace and the radiance cache that a miss reads). PRD-644 (the GI tier table) takes the new method as a value.

## Context

**Unreal LOC:** 3,000 (`LumenReSTIRGather.cpp` 1,312, `LumenReSTIRGather.h` 38,
`LumenReSTIRGather.usf` 1,650), part of the 79,227-line Lumen row in the feature map. **Port
estimate:** about 1,000 to 1,300 ThreeNative lines of TSL mechanism and specs in `packages/core/`,
and a conformance case.

**Owner check (2026-10-21).** No PRD owns this outcome. PRD-640 builds Unreal's default final gather
(screen probes) and leaves importance sampling for later. PRD-641 owns temporal stability of that
gather. ReSTIR is a separate final-gather method in Unreal, not a stage of the screen probe gather,
so it gets its own PRD that waits on PRD-640.

### What Unreal does (UE 5.8.3, read 2026-10-21; clean-room summary, no code copied)

- **A hidden third method.** `r.Lumen.FinalGatherMethod` defaults to 1 (screen probes), and its help
  text lists only 0 (irradiance field) and 1 (`UE 5.8.3: Engine/Source/Runtime/Renderer/Private/Lumen/Lumen.cpp:56-61`).
  ReSTIR runs only at value 2, with hardware ray tracing on
  (`Engine/Source/Runtime/Renderer/Private/Lumen/LumenReSTIRGather.cpp:281-292`). No scalability tier
  sets 2 (`Engine/Config/BaseScalability.ini:333, 376, 423, 471`). The renderer picks the method in
  `Lumen.cpp:199-212`.
- **One reservoir per downsampled pixel.** Rays trace at half resolution
  (`r.Lumen.ReSTIRGather.DownsampleFactor` 2, `LumenReSTIRGather.cpp:30`). Each reservoir keeps one
  chosen ray hit, its radiance and its weight.
- **Temporal resampling.** Each reservoir merges with last frame's reservoir at the reprojected
  position (on, `LumenReSTIRGather.cpp:46`). A relative distance over 0.005 rejects the history
  (`LumenReSTIRGather.cpp:62`). Re-tracing old reservoirs to validate them is off (`:54`).
- **Spatial resampling.** Two passes (`:86`) of 4 neighbour samples each (`:94`), in a kernel of 5%
  of the screen (`:102`). A neighbour is rejected when its normal differs by more than 25° (`:110`)
  or its depth by more than 1% (`:118`). A short screen trace of 20% of the screen checks that the
  neighbour's hit is visible from this pixel, to stop leaks (`:126`).
- **Guards and filters.** Ray radiance is clamped at 100 to stop fireflies (`:134`). A jittered
  upsample with a 3-texel kernel rebuilds full resolution (`:142-153`). A temporal filter of up to
  10 frames (`:193`) and a bilateral filter of 8 samples (`:217`) follow.

### ThreeNative today

- The PRD-640 gate measured the per-pixel `ssgi` path at 6 to 10 times Unreal's screen probe gather
  cost on cornell at 1920 × 1080 (PRD-640 `## Decisions`, 2026-10-20). Screen probes are the planned
  fix.
- `GPUSceneBVH` (`packages/core/src/gpu-scene-bvh.ts`) gives the first-hit trace. `DepthPyramid`
  (`packages/core/src/render/depth-pyramid.ts`) gives the screen trace. Both are what a ReSTIR ray
  would use.
- No reservoir, resampling or ReSTIR code exists in `packages/` (`rg -i "reservoir|restir" packages`,
  2026-10-21).

## Solution

**The gate first (Phase 1).** After PRD-640 Phase 2 and PRD-641 land, run the screen probe gather on
the `cornell` and `sunlit-room` poses, still and in the PRD-641 camera-move run. Record the per-region
frame-to-frame noise and the GPU time. **Continue only if** the gather misses the PRD-641 noise
threshold in a region, or misses PRD-640 AC-3 (cost at or below Unreal's measured gather).
Otherwise record the result under `## Decisions` and delete Phases 2 and 3 (R4).

**The mapping (Phases 2 and 3).**

| Unreal part | ThreeNative module | Layer |
| --- | --- | --- |
| Initial candidate ray per half-res pixel | `packages/core/src/render/restir-gather.ts` (new): `DepthPyramid` march, then `GPUSceneBVH`, then the radiance cache on a miss | core mechanism |
| Temporal resampling with the distance guard | the same module, a reservoir storage buffer kept across frames | core mechanism |
| Spatial resampling with normal, depth and visibility guards | the same module, 2 passes × 4 samples | core mechanism |
| Upsample, temporal and bilateral filters | reuses the PRD-641 filter where it fits, else the module's own | core mechanism |
| Method choice and composite strength | `finalGatherMethod: "reSTIRGather"` in the tier table (PRD-644) and the template's `src/render/worldEnvironment.ts` | generated template source |

- **Name.** `ReSTIRGather`, Unreal's name, with `@alias lumen restir gather` and `@alias reservoir
  resampling`. Options in camelCase: `downsampleFactor`, `spatialResamplingNumPasses`,
  `resamplingAngleThreshold`.
- **Never the only path.** The screen probe gather stays the `high` default. ReSTIR takes the slot
  only where Phase 3 shows it wins on noise at equal or lower cost.
- **The look stays the game's.** The module decides no colour or strength. The composite strength and
  the clamp ceiling are template literals.

**Revisit condition if the gate defers the build:** PRD-640 AC-3 fails, PRD-641 cannot meet its
noise threshold, or a visual judge names GI noise as the open defect on a calibration scene.

## Acceptance Criteria

- [ ] AC-1 [local]: On the PRD-641 camera-move run, `ReSTIRGather` has lower per-region noise than the screen probe gather at equal or lower GPU time on the RTX 2080 at 1920 × 1080. proof: the PRD-641 noise metric and the frame budget's `gpuMs`, both methods, same run — Evidence: pending.
- [ ] AC-2 [local]: A PRD-647 round on `cornell` and `sunlit-room` (BEFORE the screen probe gather, AFTER `ReSTIRGather`, Unreal Epic as the target) returns IMPROVEMENT or NEUTRAL with no REGRESSION region. proof: `pnpm unreal-look:calibrate --scene gi:cornell,gi:sunlit-room --tier high --before <commit>` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| `ReSTIRGather` | `worldEnvironment.ts` builds it when the tier sets `finalGatherMethod: "reSTIRGather"` | Replaces the screen probe gather only on a tier where AC-1 holds; screen probes stay the named alternative | AC-1, AC-2 |

## Execution Phases

#### Phase 1: Is the screen probe gather noisy or slow?
**Status:** NOT STARTED
**Files:** `scripts/unreal-look/scaffold/render/worldEnvironment.ts` (measurement only)
- [ ] The per-region noise and GPU time of the screen probe gather on `cornell` and `sunlit-room` are recorded under `## Decisions`, with the gate verdict. proof: the PRD-641 camera-move run and the frame budget's `gpuMs` at 1920 × 1080.

#### Phase 2: Reservoirs and resampling
**Status:** NOT STARTED
**Files:** `packages/core/src/render/restir-gather.ts` (new), `packages/core/src/index.ts`, `packages/core/__tests__/restir-gather.spec.ts` (new), `packages/engine-mcp/__tests__/search.spec.ts`
- [ ] On a synthetic hemisphere with a known integral, the merged reservoir estimate stays within 2% of the integral after temporal and spatial reuse. proof: `pnpm exec vitest run packages/core/__tests__/restir-gather.spec.ts`.
- [ ] A neighbour more than 25° off in normal or 1% off in depth is rejected, and a history sample past the 0.005 distance threshold is dropped. proof: `pnpm exec vitest run packages/core/__tests__/restir-gather.spec.ts`.
- [ ] A capability search for "lumen restir gather" returns `ReSTIRGather`. proof: `pnpm exec vitest run packages/engine-mcp/__tests__/search.spec.ts`.

#### Phase 3: Judge, cost and native
**Status:** NOT STARTED
**Files:** `scripts/unreal-look/scaffold/render/worldEnvironment.ts`, `packages/runtime-native/conformance/scenes/shared/restir-gather.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] The AC-1 noise and cost comparison is recorded. proof: the AC-1 run.
- [ ] The AC-2 judge verdict is recorded. proof: the AC-2 round.
- [ ] The conformance row `restir-gather` passes on the desktop lane within its tolerance. proof: `pnpm parity --target desktop --only-tests restir-gather`.
**Verification:** AC-1 and AC-2.
