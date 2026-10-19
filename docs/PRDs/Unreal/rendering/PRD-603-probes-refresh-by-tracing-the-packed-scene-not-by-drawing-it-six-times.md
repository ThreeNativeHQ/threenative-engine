# PRD-603 — Probes refresh by tracing the packed scene, not by drawing it six times

**Status:** NOT STARTED
**Priority:** P2 — Phase 1 cost gate, the traced refresh and the staleness-priority budget are all unbuilt.
**Complexity:** 7 (HIGH) — 6+ files: `probe-volume.ts`, a trace kernel, a material table beside `gpu-scene-bvh.ts`, specs, a conformance scene (+2), new compute kernel (+2), complex state across frames: stale queue and generations (+2), native proof (+1); risk override: none
**Owner:** unassigned
**Depends on:** None. Coordinates with [PRD-VQ-09](../../rendering/PRD-VQ-09-incremental-diffuse-relighting.md) (its dirty regions feed this PRD's stale queue), [PRD-525](../../native-engine/N14-native-render-chain-and-advanced-visuals/PRD-525-n14c-probes-run-native.md) (native placement and update order follow this PRD) and [PRD-267](../../useful-defaults/PRD-267-screen-space-gi-ships-in-the-templates.md) (its Phase 3 boxes stay open there).

## Context

`ProbeVolume` (`packages/core/src/render/probe-volume.ts:236`) stores L2 spherical-harmonic irradiance in a padded 3D atlas. A game calls `requestBake(scene)` (`probe-volume.ts:423`) after it authors lights and static geometry. The capability manifest says the same: "static-lighting-first, not fully dynamic relighting". This PRD does not reopen PRD-267 or the shipped PRD-268 work. It changes what one probe update costs.

**What one probe costs today.** Each probe takes `CAPTURE_WORK_ITEMS_PER_PROBE = CUBE_FACE_COUNT + 2` work items (`probe-volume.ts:60`). Six of them are full `raw.render(scene, camera)` calls (`probe-volume.ts:934`). One is the SH projection and one is the copy (`#runWorkItem`, `probe-volume.ts:848`). The defaults are one work item per frame (`probe-volume.ts:297`), a 2 ms budget (`probe-volume.ts:295`) and an 8 px cube face (`probe-volume.ts:300`).

A 24 m × 6 m × 24 m volume at 0.5 probes per metre has 13 × 4 × 13 = 676 probes (`resolutionForAxis`, `probe-volume.ts:1422`). That is 5,408 work items per pass. At the default pace and 60 fps, one pass takes 90 seconds. Every extra bounce repeats the whole pass (`#runRepackWorkItem`, `probe-volume.ts:885`). A second `requestBake` while a bake runs coalesces into it (`probe-volume.ts:428`). Nothing refreshes only the probes that went stale.

The cost per probe also grows with the scene, because each capture draws the scene again. A game with a lamp that switches on, a door that opens or a sun that moves has no usable path today.

**What is ready to reuse.** `GPUSceneBVH` (`packages/core/src/gpu-scene-bvh.ts:354`) packs the static scene triangles into storage buffers. It keeps material ranges per index span (`IGPUSceneBVHMaterialGroup`, `gpu-scene-bvh.ts:30`) and re-exports the upstream ray query `bvhIntersectFirstHit` (`gpu-scene-bvh.ts:87`). Its desktop conformance row `76-gpu-scene-bvh` passes ([PRD-244](../../done/PRD-244-the-scenes-bvh-reaches-the-gpu.md)). No lighting code reads it.

**Native status.** The desktop row `probe-volume-sample` failed on 2026-09-29 with one GPU validation error (`docs/verification/tier-1-2026-09-29.md:152`). Phase 2 re-reads that status before it adds a second row.

### What Unreal does (UE 5.8.3, read 2026-10-12; clean-room summary, no code copied)

- **Probes trace a lit proxy, not the scene.** A software trace hits the global distance field. At the hit it samples the lit atlas of the mesh cards that cover that point (UE 5.8.3: `Engine/Shaders/Private/Lumen/LumenSoftwareRayTracing.ush:670-700`). The scene is not drawn again for a probe.
- **The lit proxy refreshes by a fixed fraction.** Direct lighting updates `SurfaceCacheTexels / 32` texels per frame by default, and bounce lighting updates `/ 64` (UE 5.8.3: `Engine/Source/Runtime/Renderer/Private/Lumen/LumenSceneLighting.cpp:40-55`). The factor sets the size of the update window (UE 5.8.3: `LumenSceneLighting.cpp:98-125`, `LumenSceneLighting.cpp:583-584`). The Medium tier uses 128 and 128, High uses 64 and 128, and Epic uses 32 and 64 (UE 5.8.3: `Engine/Config/BaseScalability.ini:342-343`, `:382-383`, `:429-430`).
- **Probe tracing has a per-frame budget.** The radiance cache traces at most 100 probes per frame by default (UE 5.8.3: `LumenScreenProbeGather.cpp:627-633`). Each probe traces 32 × 32 rays by default, and 16 × 16 at High (UE 5.8.3: `LumenScreenProbeGather.cpp:643-648`, `BaseScalability.ini:387-388`). The cheaper irradiance-field path also uses 100 probes at 16 × 16 (UE 5.8.3: `LumenIrradianceFieldGather.cpp:42-47`, `:57-63`).
- **The budget goes to the stalest probes that are in use.** A probe's priority bucket is the number of frames between its last trace and its last use, divided by the clipmap index plus one, on a log2 scale. A probe that was not yet traced takes bucket 0 (UE 5.8.3: `Engine/Shaders/Private/Lumen/LumenRadianceCacheUpdate.usf:221-241`). A single-thread pass walks the buckets and stops where the budget fills (UE 5.8.3: `LumenRadianceCacheUpdate.usf:393-428`). A probe unused for 8 frames leaves the cache (UE 5.8.3: `LumenScreenProbeGather.cpp:672-678`, `LumenRadianceCacheUpdate.usf:101-113`).
- **A large lighting step restarts the cache.** When the brightest colour channel of the sun or the sky changes by more than 4 times or less than 0.25 times in one frame, the scene flags a global lighting change (UE 5.8.3: `LumenSceneRendering.cpp:2471-2540`). The radiance cache then drops its persistent state and lifts the probe budget for that frame (UE 5.8.3: `LumenRadianceCache.cpp:1670-1672`, `LumenRadianceCache.cpp:1691-1696`). The test reads colour only. It does not read the sun direction, so a moving sun rides the steady update.
- **The mainstream tiers use the coarse field.** Mesh distance fields are off at Medium and High and on at Epic (UE 5.8.3: `BaseScalability.ini:346`, `:386`, `:433`). Without them, tracing uses the lower-resolution global field of 252 voxels per axis (UE 5.8.3: `LumenDiffuseIndirect.cpp:108-113`, `LumenScene.cpp:70-76`).

## Solution

ThreeNative already has the substitute for the global field: a packed triangle BVH on the GPU. This PRD does not build a distance field.

1. **Measure first (Phase 1).** Record the real cost of one raster capture on the open-world fixture. Then spike a compute trace of 64 rays per probe against `GPUSceneBVH` on the same scene. **Gate:** continue only if the trace refreshes at least 16 probes inside the 2 ms default budget and costs at most one quarter of a raster capture per probe. At 16 probes per frame, the 676-probe volume refreshes in 43 frames. Otherwise record the decline under `## Decisions` and delete Phases 2 and 3 (R4).
2. **Trace refresh (Phase 2).** `ProbeVolume` gains an optional `trace` input: the `GPUSceneBVH`, the sun (direction, colour, intensity) and a sky radiance node. The game already holds the sun values for `Daylight` (`packages/core/src/render/daylight.ts:23-26`). A probe update then runs one compute dispatch. Each ray finds its first hit in the BVH. A hit returns the material emissive plus the material colour times the sun term. The sun term uses one shadow ray through the same BVH. The previous generation of the field adds the bounce. A miss returns the sky radiance. The kernel writes the same SH coefficients into the same atlas, so `sampleNode`, the generated materials and the shipped conformance scene do not change.
3. **Stale queue (Phase 3).** Each probe keeps its last-traced frame and its last-used frame. The last-used frame is the last frame the probe sat inside the camera frustum, a cheap CPU test. A frame traces the stalest used probes that fit the budget. `requestBake` on a trace volume marks every probe stale, keeps the old values readable and resolves its promise when every probe has refreshed once. No probe is ever read half-written.
4. **Lighting-step rule (Phase 3).** The volume compares the sun direction, the sun colour and the sky value each frame. A direction change of more than 1 degree, or a brightest-channel ratio beyond 4 times or 0.25 times, marks all probes stale. The **budget stays**, unlike Unreal. This repository requires that a bake does not stall a frame (the bake-budget box in Phase 3 of [PRD-267](../../useful-defaults/PRD-267-screen-space-gi-ships-in-the-templates.md)). The old values serve until each probe is replaced. Phase 3 measures the duty cycle of a slow sun sweep and may change the 1 degree figure. The decision goes under `## Decisions`.

**Where each part lives.** The trace kernel, the stale queue and the generation counter are mechanism, so they go in `packages/core/src/render/` beside `probe-volume.ts`. The sun, the sky and the material colours come from the game. The volume owns no light, no colour and no composite. How the sampled irradiance joins the frame stays in the game's `src/render/`.

**Named override and honest reporting.** `update: "capture"` selects today's cube capture on the same object. It stays the path for scenes that need dynamic bounce or textured albedo. `TN_PROBE_VOLUME` reports which path ran, the probes traced in the last frame, the oldest probe age in frames, and the count of materials whose texture the trace ignored. The trace path is flat material colour only.

**Declared limits.** Objects outside the BVH neither bounce nor shadow. They still receive light from the field. Local point and spot lights are out of scope for the first cut. The sun, the sky and emissive surfaces light the field.

**Consumer flow.** The game builds `GPUSceneBVH` and `ProbeVolume({ bounds, density, trace })` and adds both with `ctx.add()`. The game calls `requestBake(scene)` once, or lets a lighting step call it. The refresh runs inside the render-phase slice that `process` already owns (`probe-volume.ts:603`). The game's materials call `sampleNode` and show the new light within the measured frame count.

## Acceptance Criteria

- [ ] AC-1 [local]: On the 676-probe `?world` volume, a full traced refresh finishes in at most 60 frames. No refresh slice exceeds 2.5 ms (the 2 ms budget plus `BAKE_BUDGET_SLACK_MS`). The volume adds 0 scene draw calls. — proof: `node packages/playtest/dist/runner/cli.js examples/abyss-framework/playtests/probe-cost.playtest.json --url 'http://127.0.0.1:5183/?world&probeCost=trace' --server-command 'pnpm --filter abyss-framework dev --host 127.0.0.1 --port 5183 --strictPort' --browser-recipe webgpu` — Evidence: pending.
- [ ] AC-2 [local]: After a lamp toggle on the off-screen-emitter fixture, every probe in view has refreshed within 60 frames, on a named WebGPU adapter. — proof: `node packages/playtest/dist/runner/cli.js examples/prd268-probe-volume/playtests/lamp-toggle.playtest.json --url 'http://127.0.0.1:5184/?update=trace' --server-command 'pnpm --filter prd268-probe-volume dev --host 127.0.0.1 --port 5184 --strictPort' --browser-recipe webgpu` — Evidence: pending.
- [ ] AC-3 [local; needs a built desktop host]: The new conformance row `probe-volume-trace` passes on the desktop lane within its tolerance, and `probe-volume-sample` is green or its failure cause is recorded here. — proof: `pnpm parity --target desktop --only-tests probe-volume-trace` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Traced probe refresh | A game passes `trace` to `ProbeVolume` and calls `requestBake` or changes the sun | Cube capture stays as `update: "capture"` for dynamic or textured scenes | AC-1, AC-2 |
| Stale queue with a lighting-step rule | The same volume, every frame | The all-or-nothing restart in `requestBake` (`probe-volume.ts:428`) | AC-2 |
| `probe-volume-trace` conformance row | `pnpm parity` on web and desktop | New row in `packages/runtime-native/conformance/registry.json` | AC-3 |

## Execution Phases

#### Phase 1: Measure the capture and spike the trace
**Status:** NOT STARTED
**Files:** `examples/abyss-framework/src/scenes/WorldProbe.ts`, `examples/abyss-framework/playtests/probe-cost.playtest.json` (new)
**Implementation:** add a `?probeCost=capture|trace` switch to the world scene that builds the 676-probe volume around the start position. Record `bakeCostMs`, the work items per probe and the `renderer.info.render.calls` delta from the observation. The trace spike is a throwaway kernel that casts 64 rays per probe and writes nothing. The gate verdict goes under `## Decisions`.
- [ ] The raster capture cost per probe (ms and draw calls) on the 676-probe volume is recorded here. proof: the AC-1 playtest command with `probeCost=capture`
- [ ] The 64-ray BVH trace spike reports probes per 2 ms on the same scene, and the gate verdict is recorded. proof: the AC-1 playtest command with `probeCost=trace`
**Verification:** the gate in Solution step 1 decides whether Phases 2 and 3 continue.

#### Phase 2: A traced refresh writes the same atlas
**Status:** NOT STARTED
**Files:** `packages/core/src/render/probe-volume.ts`, `packages/core/src/render/probe-trace.ts` (new), `packages/core/src/gpu-scene-bvh.ts`, `packages/core/__tests__/probe-volume.spec.ts`, `examples/prd268-probe-volume/src/game.ts`, `examples/prd268-probe-volume/playtests/lamp-toggle.playtest.json` (new), `packages/runtime-native/conformance/scenes/shared/probe-volume-trace.js` (new), `packages/runtime-native/conformance/registry.json`
**Implementation:** add the `trace` option and the material table (colour and emissive per material index, read from the same ranges as `materialGroups`). Write the kernel. This phase refreshes probes in index order, and `requestBake` re-traces all of them. Keep `update: "capture"`. Report the path in `TN_PROBE_VOLUME`. Re-read the failed `probe-volume-sample` row first and fix or record its cause. A unit spec asserts that a traced refresh calls the scene `render` 0 times while `update: "capture"` still calls it 8 times per probe.
- [ ] On the off-screen-emitter fixture, the traced fill gives `sampleRed` within 25% of the capture fill and keeps `sampleHueRatio` at 3 or more. proof: the AC-2 playtest command
**Verification:** AC-1, AC-2 and AC-3 close this phase. The change alters what reaches the screen, so the visual judge from the root `AGENTS.md` runs on the off-screen-emitter fixture. It compares capture against trace and includes a frame taken mid-refresh. A NEUTRAL or REGRESSION verdict means fix the cause and judge again.

#### Phase 3: Refresh the stalest probes and react to lighting steps
**Status:** NOT STARTED
**Files:** `packages/core/src/render/probe-volume.ts`, `packages/core/__tests__/probe-volume.spec.ts`
**Implementation:** add per-probe last-traced and last-used frames, the priority order and the lighting-step comparison. Use an injected clock, as the shipped spec already does. The lamp-toggle fixture gains a slow sun sweep. Phase 3 measures the duty cycle of a 10-degree sweep and records the figure under `## Decisions`. The duty cycle should stay at or below 25% of frames.
- [ ] Untraced probes refresh first, then the largest gap between last use and last trace, and no frame traces more probes than the budget allows. proof: `pnpm exec vitest run packages/core/__tests__/probe-volume.spec.ts`
- [ ] A direction change above 1 degree, or a colour ratio beyond 4 times or 0.25 times, marks all probes stale with the budget unchanged and the old values still readable. proof: `pnpm exec vitest run packages/core/__tests__/probe-volume.spec.ts`
**Verification:** AC-2 stays green. The judge includes one frame from the middle of the sun sweep.

## Decisions

- 2026-10-12 (Unreal source review): Unreal lifts the probe budget on a global lighting change (`LumenRadianceCache.cpp:1670-1672`). This PRD keeps the budget and lets old values serve until replaced, because a bake must not stall a frame here.
- 2026-10-12 (Unreal source review): Unreal traces a distance field and reads a lit card atlas. This PRD traces the existing BVH and uses a flat material table. The card atlas is not built. A game that needs textured bounce uses `update: "capture"`. Reopen the atlas only if Phase 2 judge frames show the flat colour as the visible limit.
