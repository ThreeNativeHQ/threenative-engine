# PRD-604 — A surface is lit only by probes that can see it

**Status:** NOT STARTED
**Priority:** P2 — Phase 1 leak measurement, the per-probe distance atlas and the visibility-weighted sampler are all unbuilt.
**Complexity:** 5 (MEDIUM) — 1–5 implementation files: `probe-volume.ts`, one trace helper, specs, one conformance scene (+1), new GPU data and a new sampler (+2), reuse of the installed `GPUSceneBVH` ray query (+0), native proof (+1), cost risk on a per-pixel path (+1); risk override: none
**Owner:** unassigned
**Depends on:** None. Part of the GI set in [`../gi/`](../gi/) (PR #541); the leak cells come from [PRD-638](../gi/PRD-638-a-gi-reference-scene-shows-every-lumen-behaviour-still-and-in-motion.md) (`leak` pose). Shares a kernel with [PRD-603](PRD-603-probes-refresh-by-tracing-the-packed-scene-not-by-drawing-it-six-times.md) if that PRD lands first (see Solution step 2).

## Context

`ProbeVolume.sampleNode` (`packages/core/src/render/probe-volume.ts:513`) clamps the world position into the volume bounds (`probe-volume.ts:517`). It then reads the seven packed SH sub-volumes with the hardware trilinear filter. The eight probes around the point therefore weigh in by distance alone. The code has no visibility test, no test for a probe that sits inside solid geometry, and no offset along the surface normal. Outside the bounds, the nearest edge probe answers.

Three results follow from the code. Light from a lit room can reach the dark room behind a thin wall, because probes on both sides of the wall blend. A probe inside a solid contributes black or garbage to its neighbors. A floor can pick up light from probes below it. Probe spacing in the shipped fixture is 2 m (`density: 0.5`, `examples/prd268-probe-volume/src/game.ts`), so a 0.2 m wall always sits between two probes. Phase 1 measures how large the effect is.

The shipped tests check something else. They check that sub-volume seams do not bleed (`ATLAS_PADDING`, `probe-volume.ts:51`) and that an off-screen emitter lights a wall. No test puts a wall between the emitter and the receiver. [PRD-267](../../useful-defaults/PRD-267-screen-space-gi-ships-in-the-templates.md) lists no leak criterion, and [PRD-VQ-09](../../rendering/PRD-VQ-09-incremental-diffuse-relighting.md) asks only about refresh. This PRD owns the leak.

**The harness prototype (PR #541, 2026-10-20).** `scripts/unreal-look/scaffold/render/giCache.ts` already prevents leaks on the CPU in a different way. A probe with more than 25% back-face hits is invalid. Each probe stores whether the segment to its +x, +y and +z neighbour is clear, one ray per link. The read uses only the corners reachable through clear links and renormalises, and per-texel link masks in alpha stop light at a 0.2 m roof (commit `0be7a3666`). Open problems the sibling session reports at L7: a warm leak of the emissive sphere onto the backlit wall since commit `c0683da2c`, wide dark bands at interior corners, stripes on the capsule and a seam at the base of the backlit wall. Phase 1 measures these cells too. The link test answers "can the probes see each other". Unreal's test answers "can the probe see this point", which is the cause of the corner bands and the leak.

The ingredients exist. `GPUSceneBVH` (`packages/core/src/gpu-scene-bvh.ts:354`) exposes the first-hit ray query (`gpu-scene-bvh.ts:87`) and the packed triangles, so a compute pass can measure how far each probe sees in each direction.

### What Unreal does (UE 5.8.3, read 2026-10-12; clean-room summary, no code copied)

- **Each probe stores how far it sees.** The cache keeps, per probe and per direction, the mean and the mean square of the ray hit distance (UE 5.8.3: `Engine/Shaders/Private/Lumen/LumenRadianceCache.usf:1235-1356`). The source rays are weighted by a cosine raised to a power of 128 around each stored direction (UE 5.8.3: `LumenRadianceCache.usf:1292`, default set at `Engine/Source/Runtime/Renderer/Private/Lumen/LumenRadianceCache.cpp:77-83`). The irradiance-field path stores a 16 × 16 map per probe and a 6 × 6 irradiance map (UE 5.8.3: `LumenIrradianceFieldGather.cpp:65-76`).
- **Two-sided surfaces block less.** A hit on a two-sided surface, such as foliage, multiplies its stored distance by 4. A thin leaf then does not shut a probe off (UE 5.8.3: `LumenRadianceCache.usf:1297-1298`, `:1324-1325`).
- **The sampler weighs each of the eight probes.** Every probe starts with a wrap term. It is the square of half of (one plus the cosine between the surface normal and the direction to the probe), plus 0.2 (UE 5.8.3: `Engine/Shaders/Private/Lumen/LumenIrradianceFieldInterpolation.ush:83-84`).
- **A Chebyshev test removes hidden probes.** If the sample point lies farther from the probe than the stored mean distance, the weight multiplies by the cube of variance divided by (variance plus the squared gap). The weight stays at or above 0.05. A weight under 0.2 is crushed further by the square of its ratio to 0.2 (UE 5.8.3: `LumenIrradianceFieldInterpolation.ush:86-110`).
- **Invalid probes drop out.** A probe is invalid when 10% or more of its rays hit a back face, or when the global field says it sits inside geometry (UE 5.8.3: `LumenRadianceCache.usf:1360-1386`). An invalid probe weighs 0.001 (UE 5.8.3: `LumenIrradianceFieldInterpolation.ush:112-115`).
- **The weights blend in square-root space,** and a sample whose total weight is too low counts as a failed interpolation (UE 5.8.3: `LumenIrradianceFieldInterpolation.ush`). With `r.Lumen.IrradianceFieldGather.AdaptivePlacement` (default 0) a failed sample spawns an extra probe.
- **Radiance cache probes move out of geometry.** The screen-probe radiance cache offsets each probe away from nearby surfaces from the GBuffer (`ComputeProbeWorldOffsetsCS`, `r.Lumen.RadianceCache.IrradianceProbeOffsetMode=1`; UE 5.8.3: `Engine/Source/Runtime/Renderer/Private/Lumen/LumenRadianceCache.cpp`).
- **The sample point moves off the surface.** The sampler offsets the point along the normal and toward the viewer. The offset is 0.75 × cell size × a bias of 0.8 (UE 5.8.3: `LumenIrradianceFieldInterpolation.ush:324-329`, `LumenIrradianceFieldGather.cpp:96-101`). The view part fades out when the camera comes closer than one cell.

## Solution

1. **Measure first (Phase 1).** Build a two-room fixture in the existing probe example. Room A holds the emitter. Room B is dark. A wall 0.2 m thick separates them. Record the leak ratio: irradiance on the room B face of the wall divided by irradiance on the room A face, from the shipped sampler at the default density. Record the GPU cost of the shipped sampler on a full-screen opaque at 1600 × 900. **Gate:** continue only if the leak ratio is 0.1 or more. Otherwise record the decline under `## Decisions` and delete Phases 2 and 3 (R4).
2. **Distance atlas (Phase 2).** When the game gives `ProbeVolume` a `GPUSceneBVH`, a compute pass casts 64 rays per probe. It stores the cosine-weighted mean and mean square of the hit distance in an octahedral 8 × 8 map per probe. It also stores a validity flag. A probe is invalid when 10% or more of its rays hit a back face. The BVH ray query reports the hit side. The pass runs once per BVH build, not per frame. If PRD-603 lands first, its trace already casts these rays. The distance write then joins that kernel and this PRD adds no second dispatch.
3. **Weighted sampler (Phase 2).** `sampleNode` fetches the eight surrounding probes itself instead of using the hardware filter. It applies the wrap term, the Chebyshev term with the 0.05 floor and the crush step, and the validity weight. It then divides by the weight sum. A small normal offset moves the sample point first. The start value is 0.12 of a cell, which is the normal part of Unreal's formula. The view part is skipped because the volume is not view-dependent today. Phase 2 may tune the number against the fixture.
4. **A probe inside a solid moves first (Phase 2).** Before a probe is flagged invalid, the distance pass offsets it toward the direction with the longest free hit distance, by at most 0.45 of a cell, and traces it again. It stays invalid only if no offset frees it. The atlas stores the offset, so the sampler reads the probe where it moved. This is the probe relocation of DDGI and of Unreal's radiance cache offsets.
5. **Name.** The visibility-weighted read is Unreal's irradiance field interpolation, so it ships as the `IrradianceFieldGather` node, the gather of the `medium` tier ([PRD-644](../gi/PRD-644-the-gi-tier-follows-unreal-quality-levels-and-the-measured-gpu-time.md)). `sampleNode` returns it when distances exist. Its options keep Unreal's names: `probeOcclusionBias` (0.8), `occlusionProbeResolution`. Unreal uses a 16 × 16 occlusion octahedron. This PRD starts at 8 × 8 for memory, and Phase 2 raises it if 8 × 8 misses the leak target. The weights blend in square-root space, as Unreal's do.
6. **Auto by default, with a named override.** A volume with distances samples with visibility. A volume without them, such as one fed only by cube capture, keeps today's trilinear path. `visibility: false` forces the old path on the same object. `TN_PROBE_VOLUME` reports `visibility` as `weighted`, `trilinear` or `unavailable`, plus the count of invalid probes. The report states which path ran.

**Where each part lives.** The distance pass, the atlas and the sampler are mechanism in `packages/core/src/render/`. The game's material still decides how the irradiance joins the frame. The sampler owns no colour.

**Risks.**

- **Per-pixel cost.** The weighted sampler reads 8 probes times 7 coefficient volumes, plus 8 distance maps. That is far more than seven filtered reads. The Phase 2 cost box decides whether it ships at full resolution. A game can already evaluate the node at half resolution in its own composite.
- **Thin walls versus probe spacing.** A wall thinner than the ray spacing may escape the map. The fixture uses a 0.2 m wall at 2 m spacing, so the test is realistic.
- **SH ringing.** Weighting does not fix L2 ringing. This PRD makes no claim about it.

## Acceptance Criteria

- [ ] AC-4 [local]: On the PRD-638 `leak` pose and the PRD-631 backlit pose, the L7 cells on the owned engine match Unreal Epic within the PRD-631 thresholds, with the harness `giCache.ts` links replaced by the weighted sampler. — proof: `pnpm unreal-look:compare --scene gi --layer L7` and `pnpm unreal-look:compare --layer L7` — Evidence: pending.
- [ ] AC-1 [local]: On the two-room fixture, the leak ratio drops from the Phase 1 baseline to 0.02 or less. — proof: `node packages/playtest/dist/runner/cli.js examples/prd268-probe-volume/playtests/probe-leak.playtest.json --url 'http://127.0.0.1:5184/?scene=rooms' --server-command 'pnpm --filter prd268-probe-volume dev --host 127.0.0.1 --port 5184 --strictPort' --browser-recipe webgpu` — Evidence: pending.
- [ ] AC-2 [local]: The weighted sampler adds at most 1.0 ms of GPU time over the trilinear sampler on a full-screen opaque at 1600 × 900, on a named WebGPU adapter. — proof: `node packages/playtest/dist/runner/cli.js examples/prd268-probe-volume/playtests/probe-leak.playtest.json --url 'http://127.0.0.1:5184/?scene=rooms&cost' --server-command 'pnpm --filter prd268-probe-volume dev --host 127.0.0.1 --port 5184 --strictPort' --browser-recipe webgpu` — Evidence: pending.
- [ ] AC-3 [local; needs a built desktop host]: The new conformance row `probe-volume-leak` passes on the desktop lane within its tolerance. — proof: `pnpm parity --target desktop --only-tests probe-volume-leak` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Per-probe distance atlas and validity | A game passes a `GPUSceneBVH` to `ProbeVolume` | New data beside the SH atlas. A volume without a BVH keeps today's path | AC-1 |
| Visibility-weighted `sampleNode` | Any generated material that calls `sampleNode` or `sample` on that volume | Replaces the hardware trilinear read when distances exist. `visibility: false` restores it | AC-1, AC-2 |
| `probe-volume-leak` conformance row | `pnpm parity` on web and desktop | New row in `packages/runtime-native/conformance/registry.json` | AC-3 |

## Execution Phases

#### Phase 1: Measure the leak and the sampler cost
**Status:** NOT STARTED
**Files:** `examples/prd268-probe-volume/src/game.ts`, `examples/prd268-probe-volume/playtests/probe-leak.playtest.json` (new)
**Implementation:** add a `?scene=rooms` fixture with two rooms and a 0.2 m wall. Add a leak ratio and a sampler GPU time to the fixture state next to the existing `sampleRed` fields. The gate verdict goes under `## Decisions`.
- [ ] The leak ratio of the shipped sampler on the rooms fixture is recorded here. proof: the AC-1 playtest command
- [ ] The GPU time of the shipped sampler on a 1600 × 900 full-screen opaque is recorded here. proof: the AC-2 playtest command
**Verification:** the gate in Solution step 1 decides whether Phases 2 and 3 continue.

#### Phase 2: Distances, validity and the weighted sampler
**Status:** NOT STARTED
**Files:** `packages/core/src/render/probe-volume.ts`, `packages/core/src/render/probe-distance.ts` (new), `packages/core/__tests__/probe-volume.spec.ts`
**Implementation:** build the distance pass, the atlas and the weighted node. Keep `visibility: false` and the report field. Validate input: a non-finite distance, or a missing BVH on a volume that asks for visibility, throws at construction and names the field.
- [ ] A probe with 10% or more back-face rays is flagged invalid and counted in `TN_PROBE_VOLUME`. proof: `pnpm exec vitest run packages/core/__tests__/probe-volume.spec.ts`
- [ ] A probe placed 0.1 m inside a wall moves out of it and is valid after the distance pass, and a probe inside a closed solid stays invalid. proof: `pnpm exec vitest run packages/core/__tests__/probe-volume.spec.ts`
- [ ] On the CPU reference `sampleIrradiance` (`probe-volume.ts:499`), samples in open air at least 2 m from any wall match the trilinear result within 2%, and `visibility: false` returns the old output exactly. proof: `pnpm exec vitest run packages/core/__tests__/probe-volume.spec.ts`
**Verification:** AC-1 and AC-2 close this phase. The change alters what reaches the screen, so the visual judge from the root `AGENTS.md` runs on the rooms fixture and on the off-screen-emitter fixture. It must return IMPROVEMENT overall on the leak frames and no REGRESSION on the emitter frames. The verdict goes beside AC-1. A NEUTRAL or REGRESSION verdict means fix the cause and judge again.

#### Phase 3: The same fixture runs on the native host
**Status:** NOT STARTED
**Files:** `packages/runtime-native/conformance/scenes/shared/probe-volume-leak.js` (new), `packages/runtime-native/conformance/registry.json`
**Implementation:** a conformance scene with the two-room data and a fixed probe set. The row tolerance comes from a measured web-versus-desktop difference. It is not copied from `probe-volume-sample`. Fix or record the cause of the existing `probe-volume-sample` desktop failure first (`docs/verification/tier-1-2026-09-29.md:152`).
- [ ] The row `probe-volume-leak` is registered and passes on web with a non-blank frame and a named adapter. proof: `pnpm parity --target web --only-tests probe-volume-leak`
**Verification:** AC-3 closes this phase.
