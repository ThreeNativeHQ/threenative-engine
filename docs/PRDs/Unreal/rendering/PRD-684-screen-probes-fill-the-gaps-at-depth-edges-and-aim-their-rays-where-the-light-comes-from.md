---
prd_contract: v1
---

# PRD-684 — Screen probes fill the gaps at depth edges and aim their rays where the light comes from

**Status:** NOT STARTED
**Priority:** P2 — Phase 1 is open: no measurement says how many pixels of the screen probe gather fall back to the cache alone, or how much of its noise comes from rays that leave in directions with no light.
**Complexity:** 6 (MEDIUM) — 4–6 files: the placement pass, the ray generation pass, specs, one conformance scene (+1), two new passes inside the screen probe gather (+2), state across frames: last frame's probe radiance as the lighting PDF (+1), native proof (+1), changes the frame cost of the `high` tier (+1); risk override: none
**Owner:** João
**Depends on:** PRD-640 Phase 2 (`docs/PRDs/Unreal/gi/PRD-640-pixels-gather-bounce-light-from-screen-probes-and-the-radiance-cache-answers-the-rest.md`, on `feat/unreal-look-epic`): the screen probe gather that this PRD extends. PRD-641 Phase 4 (`docs/PRDs/Unreal/gi/PRD-641-bounce-light-holds-still-while-the-camera-moves-and-follows-a-light-that-changes.md`, same branch): the blotch metric. PRD-646 and PRD-647 (`docs/PRDs/Unreal/gi/PRD-646-threenative-recreates-each-unreal-calibration-scene-exactly.md`, `docs/PRDs/done/PRD-647-a-visual-judge-calibrates-gi-against-the-unreal-scenes-until-parity.md`, same branch): the calibration scenes and the judge round.

## Context

**Unreal LOC:** 1,702 lines. Probe placement is 428 lines (the uniform and adaptive passes in
`LumenScreenProbeGather.cpp` and `LumenScreenProbeGather.usf`). Importance sampling is 1,274 lines
(`LumenScreenProbeImportanceSampling.cpp`, `LumenScreenProbeImportanceSampling.usf` and
`LumenScreenProbeGatherScreenData.usf`). **Port estimate:** about 300 to 450 ThreeNative lines, because
the probe atlas, the trace and the gather exist.

### What Unreal does (UE 5.8.3, read 2026-10-21; clean-room summary, no code copied)

- **A uniform probe per tile, jittered over time.** At Epic one probe sits on each 16 × 16 pixel tile
  (`Engine/Config/BaseScalability.ini:436`). Its pixel inside the tile moves on an 8-frame Hammersley
  sequence (`Engine/Shaders/Private/Lumen/LumenScreenProbeCommon.ush:72-76`).
- **Adaptive probes where the uniform ones cannot reach.** Each tile tests 8 sample pixels at Epic
  and 16 at High (`Engine/Source/Runtime/Renderer/Private/Lumen/LumenScreenProbeGather.cpp:46-51`,
  `BaseScalability.ini:437`, `:390`). A sample needs a probe when the summed weights of its four
  uniform corner probes are below 0.01 (`Engine/Shaders/Private/Lumen/LumenScreenProbeGather.usf:36`,
  `:1744-1806`). A second pass skips a sample that an adaptive probe with a lower sample index in
  the same corners already covers (`LumenScreenProbeGather.usf:1825-1900`). The adaptive pool holds
  half the uniform count (`LumenScreenProbeGather.cpp:54-59`, `:2243`).
- **The weight that decides it.** A corner probe weighs by the distance of its position from the
  pixel's plane, relative to the pixel depth, squared and passed through `exp2` with a scale of
  −10,000. The scale is 1 for opaque pixels and 0.25 for foliage
  (`LumenScreenProbeGather.cpp:134-153`, `:2236-2240`; `LumenScreenProbeGather.usf:186-198`).
- **Importance sampling is on by default.** Both the BRDF and the incoming light shape the rays
  (`Engine/Source/Runtime/Renderer/Private/Lumen/LumenScreenProbeImportanceSampling.cpp:12-40`).
  - The BRDF PDF of a probe is the sum of the diffuse transfer, as 3-band spherical harmonics, of
    every pixel that reads the probe (`Engine/Shaders/Private/Lumen/LumenScreenProbeGatherScreenData.usf:135-148`).
  - The lighting PDF comes from last frame's filtered probe radiance at the reprojected probe. History
    farther than 30 units is not used (`LumenScreenProbeImportanceSampling.cpp:36-40`, `:60`;
    `Engine/Shaders/Private/Lumen/LumenScreenProbeImportanceSampling.usf:36-60`).
  - The product of the two is the ray PDF. A ray whose BRDF PDF is below 0.1 is dropped
    (`LumenScreenProbeImportanceSampling.cpp:52`; `LumenScreenProbeImportanceSampling.usf:340-376`).
    The rays are sorted. Three dropped rays and one high-PDF ray become four rays at the next finer
    octahedral level, so the ray count stays 64 (`LumenScreenProbeImportanceSampling.usf:434-476`).
    There is one refinement level (`LumenScreenProbeImportanceSampling.cpp:20`).

### ThreeNative today

- The screen probe gather exists on `feat/unreal-look-epic` as the `probes` option of `ssgi`
  (`packages/three-native/src/addons/screen-space.ts`, `defineScreenProbes`). It places one probe per
  `downsampleFactor` tile, traces an 8 × 8 octahedron of rays and blends the four nearest probes by
  position, depth-plane distance and normal agreement. Its own comment says: "A pixel no probe can
  see gets the cache alone." No adaptive probe exists.
- PRD-640 Solution says the rays are cosine-weighted and are "importance-sampled only if Phase 2 shows
  noise the PRD-641 history cannot hide". No box in PRD-640 builds or measures that. This PRD owns it.
- PRD-641 AC-4 records soft blotches on the `sunlit-room` walls at 1.31 to 1.37 times Unreal's
  (median). Ray noise is one candidate cause.

## Solution

**The gate first (Phase 1).** With the screen probe gather on (`?probes=1`) at L7, on `cornell`,
`sunlit-room` and the PRD-631 interior pose, record two numbers:

1. The share of lit pixels whose four corner probes weigh less than 0.01 in total, and the per-region
   dP50 of those pixels against Unreal Epic.
2. The blotch ratio against Unreal Epic on the walls and ceilings, with `--metric blotch`.

**Continue to Phase 2** only if the fallback share is 1% or more of lit pixels and those pixels miss
the PRD-631 threshold. **Continue to Phase 3** only if the blotch ratio is above 1.2 in more than a
third of the regions. Record the verdict under `## Decisions` and delete a phase that its gate fails
(R4).

**Phase 2, adaptive probes.** The placement follows Unreal: 8 Hammersley samples per tile, the 0.01
weight threshold, the skip of samples that an earlier adaptive probe covers, and a pool of half the
uniform count. Adaptive probes join the probe atlas after the uniform ones. They trace and filter the
same way. The gather reads the four corners and then the tile's adaptive list. An overflow of the
pool drops the extra probes and is counted.

**Phase 3, importance sampling.** The BRDF PDF of a probe sums the cosine lobes of the normals of the
pixels that read it. The lighting PDF is last frame's probe radiance at the reprojected probe, used
only when the probe moved less than 0.3 m. The ray PDF is their product. Rays below 0.1 are dropped
and refined into finer directions as Unreal does, so the ray count stays at 64. The filter weighs
each ray by its PDF, so the irradiance stays unbiased.

**Names.** The options extend the screen probe options with Unreal's names in camelCase:
`numAdaptiveProbes` (8), `adaptiveProbeAllocationFraction` (0.5), `importanceSample` (true) and
`minPDFToTrace` (0.1). The manifest entry gains `@alias lumen adaptive probes` and
`@alias screen probe importance sampling`.

**Where it lives.** Both passes are mechanism beside the screen probe gather (PRD-640 names
`packages/core/src/render/screen-probe-gather.ts`; the epic prototype is the `probes` option in
`packages/three-native/src/addons/screen-space.ts`). They decide no colour. `TN_GI` reports the
adaptive probe count, the pool overflow and the share of rays refined.

**Auto by default, with a named override.** Both are on when the gather runs, as in Unreal.
`numAdaptiveProbes: 0` and `importanceSample: false` turn them off, and the report says so.

## Acceptance Criteria

- [ ] AC-1 [local]: The depth-edge regions that Phase 1 found (box silhouettes in `cornell`, window and door frames in `sunlit-room`) match Unreal Epic within the PRD-631 thresholds at L7. proof: `pnpm unreal-look:compare --scene gi:cornell,gi:sunlit-room --layer L7` — Evidence: pending.
- [ ] AC-2 [local]: The blotch ratio against Unreal Epic is at most 1.2 in at least two thirds of the wall and ceiling regions of `sunlit-room`, at the same 64 rays per probe. proof: `pnpm unreal-look:compare --scene gi:sunlit-room --layer L7 --metric blotch` — Evidence: pending.
- [ ] AC-3 [local]: The two passes add at most 0.5 ms GPU time at 1920 × 1080 on the RTX 2080. proof: the frame budget's SSGI stage time, both passes on against off, interleaved as in PRD-644 — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Adaptive probes | The screen probe gather on `high` | Replaces "the cache alone" for pixels no uniform probe reaches | AC-1 |
| Importance-sampled rays | The same gather, every probe | Replaces the uniform octahedron of rays | AC-2 |

## Execution Phases

#### Phase 1: How many pixels lack a probe, and how noisy are the rays
**Status:** NOT STARTED
**Files:** `scripts/unreal-look/scaffold/render/worldEnvironment.ts` (measurement only)
- [ ] The fallback share of lit pixels and the dP50 of those pixels against Unreal Epic are recorded under `## Decisions` for `cornell`, `sunlit-room` and the PRD-631 interior pose. proof: `pnpm unreal-look:compare --scene gi:cornell,gi:sunlit-room --layer L7` with `?probes=1` and a fallback-share readout in `TN_GI`.
- [ ] The blotch ratio of the probe gather against Unreal Epic is recorded with the gate verdict. proof: `pnpm unreal-look:compare --scene gi:sunlit-room --layer L7 --metric blotch`.

#### Phase 2: Adaptive probes
**Status:** NOT STARTED
**Files:** the screen probe gather module, its spec, `packages/engine-mcp/__tests__/search.spec.ts`
- [ ] A pixel whose four corner probes weigh less than 0.01 in total gets an adaptive probe, a pixel that an earlier adaptive probe covers does not, and a full pool counts its overflow. proof: `pnpm exec vitest run packages/core/__tests__/screen-probe-gather.spec.ts`.
- [ ] A capability search for "lumen adaptive probes" returns the screen probe gather. proof: `pnpm exec vitest run packages/engine-mcp/__tests__/search.spec.ts`.
**Verification:** AC-1. A PRD-647 round on `cornell` and `sunlit-room` at `high` (BEFORE uniform probes only, AFTER with adaptive probes, Unreal Epic as the target) must return IMPROVEMENT with no REGRESSION frame.

#### Phase 3: Rays go where the light is
**Status:** NOT STARTED
**Files:** the screen probe gather module, its spec, `packages/runtime-native/conformance/scenes/shared/screen-probe-importance.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] Rays below a PDF of 0.1 are refined into four finer rays, the ray count stays 64, and the irradiance of a synthetic environment with a known integral stays within 2% of it. proof: `pnpm exec vitest run packages/core/__tests__/screen-probe-gather.spec.ts`.
- [ ] A fresh visual judge on `sunlit-room` at L7 (BEFORE uniform rays, AFTER importance-sampled rays, Unreal Epic as the target) returns IMPROVEMENT with no REGRESSION frame. proof: headed `--browser-recipe webgpu` captures, 2 runs per arm, judged by a fresh read-only subagent.
- [ ] The conformance row `screen-probe-importance` passes on the desktop lane within its tolerance. proof: `pnpm parity --target desktop --only-tests screen-probe-importance`.
**Verification:** AC-2 and AC-3.
