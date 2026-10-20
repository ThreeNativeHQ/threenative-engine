---
prd_contract: v1
---

# PRD-640 — Pixels gather bounce light from screen probes, and the radiance cache answers the rest

**Status:** NOT STARTED
**Priority:** P1 — no box is ticked: the Epic tier of Unreal, which a fresh project runs, gathers GI with screen probes, and ThreeNative has only a per-pixel SSGI whose misses read a 1 m field.
**Complexity:** 8 (HIGH) — 6–10 files: the gather, the short range AO, the composite, specs, conformance (+2), new module `screen-probe-gather.ts` (+2), state across frames: probe radiance history (+2), native proof (+1), changes the frame cost of the high tier (+1); risk override: none
**Owner:** João
**Depends on:** [PRD-638](PRD-638-calibration-scenes-are-built-in-unreal-and-captured-as-the-gi-target.md) Phases 1 and 2 (`cornell` and `sunlit-room`), [PRD-646](PRD-646-threenative-recreates-each-unreal-calibration-scene-exactly.md) Phase 3 (the `indirectDiffuse` mode) and [PRD-647](PRD-647-a-visual-judge-calibrates-gi-against-the-unreal-scenes-until-parity.md) (the calibration round). [PRD-603](../rendering/PRD-603-probes-refresh-by-tracing-the-packed-scene-not-by-drawing-it-six-times.md) Phase 2 (the radiance cache that a miss reads). [PRD-635](../look/PRD-635-ambient-occlusion-darkens-only-the-light-that-comes-from-around.md) (AO reaches indirect light only). Temporal stability is [PRD-641](PRD-641-bounce-light-holds-still-while-the-camera-moves-and-follows-a-light-that-changes.md).

## Context

**What runs on the owned engine today (PR #541 branch).**

- `ssgi(beauty, depth, normal, camera | { camera, fallback })` in
  `packages/three-native/src/addons/screen-space.ts` (commit `3d322fe4f`). Each pixel casts
  `sliceCount × 4` cosine rays and marches the depth buffer. A hit reads the lit colour. A miss reads
  the `fallback` tier, and a hit adds `hit − fallback`, so the two tiers do not count light twice
  (`screen-space.ts:292-315`). The albedo comes from a `diffuseColor` MRT target that the engine
  draws for each lit opaque draw.
- The harness `cacheFallback(camera)` (`scripts/unreal-look/scaffold/render/giCache.ts:556`) hands the
  CPU-baked radiance cache to SSGI as the `fallback` tier.
- GTAO (16 samples at `high`) still multiplies the composed frame in the templates. PRD-635 moves it
  onto indirect light through `NodeMaterial.aoNode` (commit `ad0691b7b`).

**What this misses.** A per-pixel ray that leaves the screen stops and reads the field at the
pixel. The field is 1 m coarse, so contact-scale bounce off-screen is lost. The sibling session
records wide dark bands at interior corners, stripes on the capsule and a seam at the base of the
backlit wall at L7. Each pixel also pays for its own rays: the cost grows with resolution.

**Measured on cornell L7 (2026-10-20, feat/unreal-gi `cd6e484bc`).** The gather now runs on the owned
engine. Before `147140ecd`, `denoise()` refused its computed AO input, and the chain dropped SSGI. The
gather brings the corner floor to 96 (Unreal 93, cache alone 126) and Box_Tall to 172 (Unreal 174).
Box_Short's camera-facing face goes the wrong way: 101 (Unreal Epic 58, Unreal Medium 3, cache 80). Its
missed rays leave through the open front. Lumen's world trace returns black there, but our miss keeps
the pixel's cache average. A per-ray miss that reads the cache 0.5 to 2 m ahead of the ray, about the
ray's direction, moved the frame by 0.14 levels mean. The 6-face cache is too smooth to tell "black
straight out" from "lit floor below". The miss tier needs directional radiance (screen probes with a
world-space trace, this PRD's Solution), not a second read of the irradiance field.

### What Unreal does (UE 5.8.3, read 2026-10-20; clean-room summary, no code copied)

- **Screen probes, not per-pixel rays.** At Epic, one probe sits on every 16 × 16 pixel tile, plus up
  to 8 adaptive probes per tile where depth or normal changes (`r.Lumen.ScreenProbeGather.DownsampleFactor`
  16 at Epic, 32 at High; UE 5.8.3: `Engine/Config/BaseScalability.ini`, `[GlobalIlluminationQuality@2..3]`;
  `Engine/Shaders/Private/Lumen/LumenScreenProbeGather.usf`).
- **64 rays per probe, importance sampled.** The probe traces an 8 × 8 octahedron. The rays follow a
  BRDF PDF and a lighting PDF from last frame's probe radiance (UE 5.8.3:
  `Engine/Source/Runtime/Renderer/Private/Lumen/LumenScreenProbeImportanceSampling.cpp`).
- **Trace order.** A ray first walks the HZB on screen (50 steps). A miss continues in the global
  distance field up to the radiance cache coverage distance, then reads the world radiance cache
  (UE 5.8.3: `Engine/Source/Runtime/Renderer/Private/Lumen/LumenScreenProbeTracing.cpp`,
  `Engine/Shaders/Private/Lumen/LumenScreenProbeTracing.usf`).
- **Filter, then integrate per pixel.** Probe radiance is accumulated over time, spatially filtered
  in 3 passes and converted to SH3 irradiance at Epic. Each pixel interpolates the nearby probes
  with a depth weight and integrates against its BRDF (UE 5.8.3:
  `Engine/Source/Runtime/Renderer/Private/Lumen/LumenScreenProbeFiltering.cpp`, `ScreenProbeIntegrateCS`).
- **Short Range AO restores contact detail.** A horizon search of 2 slices × 3 steps gives AO and a
  bent normal at full resolution at Epic (bent normal off at High and Medium; UE 5.8.3:
  `Engine/Source/Runtime/Renderer/Private/Lumen/LumenScreenSpaceBentNormal.cpp`). The composite applies
  it to indirect light with multi-bounce and an albedo cap of 0.5, and foliage takes 0.7 of it
  (UE 5.8.3: `Engine/Shaders/Private/DiffuseIndirectComposite.usf`).
- **Composite after shading.** Gathered irradiance × diffuse colour joins the lit frame in
  `FDiffuseIndirectCompositePS`, with a bilateral upsample when the gather ran at lower resolution
  (UE 5.8.3: `Engine/Source/Runtime/Renderer/Private/IndirectLightRendering.cpp`).
- **SSGI is deprecated** in 5.8 and logs a warning (UE 5.8.3: `IndirectLightRendering.cpp`).

## Solution

1. **Measure the per-pixel path first (Phase 1).** On the owned engine, run the current chain
   (`ssgi` with the radiance cache as `fallback`) at L7 on the PRD-631 interior and backlit poses
   and the PRD-638 `cornell` and `window` poses, in the `indirectDiffuse` mode. Record per-region
   error against Unreal Epic and the GPU time at 1920 × 1080 on the RTX 2080. Record Unreal's own
   screen probe gather time on the same GPU from `r.ProfileGPU` output. **Gate:** build the Screen
   Probe Gather only if the per-pixel path misses the thresholds in a region where off-screen rays
   dominate, or costs more than Unreal's measured gather. Otherwise record the decline under
   `## Decisions` and delete Phase 2 (R4).
2. **`ScreenProbeGather` (Phase 2).** Unreal's name and structure:
   - probes on a 16 px grid (`downsampleFactor`), placed from the depth-normal prepass that PRD-635
     shares;
   - 64 rays per probe on an 8 × 8 octahedron (`tracingOctahedronResolution`), cosine-weighted in
     this PRD and importance-sampled only if Phase 2 shows noise the PRD-641 history cannot hide;
   - each ray marches the screen first, reusing the `ssgi` march and `DepthPyramid`
     (`packages/core/src/render/depth-pyramid.ts`) as the HZB; a miss continues through
     `GPUSceneBVH` up to the radiance cache cell size, then reads the radiance cache;
   - a 3-pass spatial filter, SH irradiance per probe, and a per-pixel integrate with a depth weight;
   - the composite multiplies the result by the `diffuseColor` MRT and adds it after the scene
     pass, as Unreal's composite does. The scene pass then takes no indirect diffuse from
     `irradianceNode`, so light is not counted twice.
3. **`ShortRangeAO` (Phase 3).** A horizon search of 2 slices × 3 steps with a bent normal, at full
   resolution on `high` (Unreal Epic). It replaces GTAO whenever the gather runs: Unreal runs
   Short Range AO with Lumen and SSAO without it. Multi-bounce uses the albedo cap of 0.5. GTAO
   through PRD-635 stays the AO of tiers without dynamic GI.

**Names and manifest.** `ScreenProbeGather` and `ShortRangeAO`, with options in Unreal's terms in
camelCase (`downsampleFactor`, `tracingOctahedronResolution`, `horizonSearchSliceCount`). Units are
metres and pixels, never Unreal centimetres. The manifest entries carry `@alias lumen screen probe gather`,
`@alias lumen final gather` and `@alias lumen short range ao`.

**Where each part lives.** Probe placement, tracing, filtering and integration are mechanism in
`packages/core/src/render/`. The composite strength, the AO intensity and the foliage factor decide
the look, so they are literals in the template's `src/render/worldEnvironment.ts` (the harness
overlay first, the templates through [PRD-267](../../useful-defaults/PRD-267-screen-space-gi-ships-in-the-templates.md)).

## Acceptance Criteria

- [ ] AC-1 [local]: The L7 cells on the owned engine match Unreal Epic within the PRD-631 thresholds on the interior and backlit poses of the reference scene. proof: `pnpm unreal-look:compare --layer L7` — Evidence: pending.
- [ ] AC-2 [local]: The same holds on the `cornell` and `window` poses of the calibration scenes. proof: `pnpm unreal-look:compare --scene gi:cornell,gi:sunlit-room --layer L7` — Evidence: pending.
- [ ] AC-3 [local]: The gather plus Short Range AO costs no more GPU time at 1920 × 1080 than Unreal's measured screen probe gather on the same RTX 2080. proof: `node packages/playtest/dist/runner/cli.js perf` on the harness against the Phase 1 Unreal number — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Screen Probe Gather | `worldEnvironment.ts` builds `ScreenProbeGather` on `high` | Replaces per-pixel `ssgi` on `high`; `ssgi` stays a named override | AC-1, AC-2 |
| Composite after the scene pass | The same file, with the `diffuseColor` MRT | Replaces `irradianceNode` as the indirect diffuse source while the gather runs | AC-1 |
| Short Range AO | The same file when the gather runs | Replaces GTAO when dynamic GI runs | Phase 3 |

## Execution Phases

#### Phase 1: How far the per-pixel path gets
**Status:** NOT STARTED
**Files:** `scripts/unreal-look/scaffold/render/worldEnvironment.ts` (measurement only)
- [ ] Per-region L7 error of `ssgi` plus the radiance cache, against Unreal Epic, is recorded under `## Decisions`. proof: `pnpm unreal-look:compare --layer L7 --visualize indirectDiffuse`.
- [ ] Unreal's screen probe gather GPU time and ours at 1920 × 1080 on the RTX 2080 are recorded, and the gate verdict with them. proof: `r.ProfileGPU` log from the Unreal capture, and `node packages/playtest/dist/runner/cli.js perf`.

#### Phase 2: Screen probes
**Status:** NOT STARTED
**Files:** `packages/core/src/render/screen-probe-gather.ts` (new), `packages/core/src/index.ts`, `packages/core/__tests__/screen-probe-gather.spec.ts` (new), `scripts/unreal-look/scaffold/render/worldEnvironment.ts`, `packages/engine-mcp/__tests__/search.spec.ts`
- [ ] A ray that leaves the screen continues through the BVH and then reads the radiance cache, and a ray that hits on screen never reads the cache. proof: `pnpm exec vitest run packages/core/__tests__/screen-probe-gather.spec.ts`.
- [ ] A capability search for "lumen screen probe gather" returns `ScreenProbeGather`. proof: `pnpm exec vitest run packages/engine-mcp/__tests__/search.spec.ts`.
**Verification:** AC-1 and AC-2. A PRD-647 round on `cornell` and `sunlit-room` at `high` (BEFORE `ssgi`, AFTER the gather, Unreal Epic as the target) must return IMPROVEMENT against BEFORE. The four PRD-631 poses are judged the same way.

#### Phase 3: Short Range AO and native proof
**Status:** NOT STARTED
**Files:** `packages/core/src/render/short-range-ao.ts` (new), `scripts/unreal-look/scaffold/render/worldEnvironment.ts`, `packages/runtime-native/conformance/scenes/shared/screen-probe-gather.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] With the gather on, the chain reports `shortRangeAO` and no `gtao` stage. proof: `TN_RENDER_CHAIN` in the harness capture at L7.
- [ ] The conformance row `screen-probe-gather` passes on the desktop lane within its tolerance. proof: `pnpm parity --target desktop --only-tests screen-probe-gather`.
**Verification:** AC-3.
