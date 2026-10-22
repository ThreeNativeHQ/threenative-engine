---
prd_contract: v1
---

# PRD-643 — Glass, fog and leaves take the bounce light too

**Status:** NOT STARTED
**Priority:** P2 — no box is ticked: GI reaches opaque materials only, so glass, particles and fog inside a room glow with the sky and a leaf lit from behind stays dark.
**Complexity:** 5 (MEDIUM) — 1–5 files: the translucency read, the fog read, the foliage term, specs, one conformance scene (+1), per-pixel and per-froxel cost (+2), native proof (+1), two consumers with different render paths (+1); risk override: none
**Owner:** João
**Depends on:** [PRD-603](../rendering/PRD-603-probes-refresh-by-tracing-the-packed-scene-not-by-drawing-it-six-times.md) Phase 2 and [PRD-604](../rendering/PRD-604-a-surface-is-lit-only-by-probes-that-can-see-it.md) Phase 2 (the radiance cache and its visibility-weighted read). [PRD-638](PRD-638-calibration-scenes-are-built-in-unreal-and-captured-as-the-gi-target.md) Phase 1 (the scene pipeline), [PRD-646](PRD-646-threenative-recreates-each-unreal-calibration-scene-exactly.md) Phase 2 and [PRD-647](../../done/PRD-647-a-visual-judge-calibrates-gi-against-the-unreal-scenes-until-parity.md). This PRD authors the `foliage` calibration scene.

## Context

- The harness feeds GI to materials by replacing each mesh material with a `MeshStandardNodeMaterial`
  whose `irradianceNode` reads the cache (`scripts/unreal-look/scaffold/render/giCache.ts`). Phase 1
  checks which translucent, transmissive and particle materials this reaches. A material that it does
  not reach takes the environment's diffuse light, which is the sky.
- Volumetric fog ships ([PRD-VQ-07](../../done/PRD-VQ-07-volumetric-fog.md)). Its froxels take the sun
  and the sky. Phase 1 checks whether any GI term reaches them.
- `TN_UNLIT_FOLIAGE` (`packages/core/src/index.ts:665`) warns when imported foliage has no
  image-based light. No foliage material takes indirect light through its back face.
- PRD-604 already gives two-sided hits a 4× distance in the probe visibility, as Unreal does, so a
  leaf does not shut a probe off.

### What Unreal does (UE 5.8.3, read 2026-10-20; clean-room summary, no code copied)

- **A translucency GI volume.** A camera froxel grid, 32 px cells at Epic and Cinematic, 64 at High,
  128 at Medium, to 80 m, is filled from the radiance cache. At Epic it also cone-traces the global
  distance field (UE 5.8.3: `Engine/Source/Runtime/Renderer/Private/Lumen/LumenTranslucencyVolumeLighting.cpp`;
  `Engine/Config/BaseScalability.ini`). It reprojects in time with a 0.9 history weight. Medium
  shares the opaque radiance cache.
- **Volumetric fog reads the same volume** (UE 5.8.3: `Engine/Source/Runtime/Renderer/Private/VolumetricFog.cpp`,
  `LUMEN_GI` permutation).
- **Two-sided foliage gathers its back face.** At Epic and Cinematic the gather adds a back-face
  diffuse term: `diffuse colour × front + subsurface colour × back` (`TwoSidedFoliageBackfaceDiffuse`).
  At High the subsurface colour is added without a separate gather. Foliage takes 0.7 of the short
  range AO (UE 5.8.3: `Engine/Shaders/Private/DiffuseIndirectComposite.usf`).

## Solution

1. **Measure (Phase 1).** On the `foliage` calibration scene (authored here with the PRD-638 pipeline) at L7, compare the glass pane, a fog-filled room and the
   `foliage` pose against Unreal Epic. List the materials that take no GI and the fog froxels that
   take none.
2. **Translucent materials and fog read the radiance cache (Phase 2).** ThreeNative draws translucency
   forward, so a translucent pixel can read the radiance cache directly with the same
   visibility-weighted sampler as opaque pixels. That is cheaper than a second froxel volume, and the
   result is the same light. The fog's froxel pass samples the cache once per froxel at its centre.
   A froxel volume like Unreal's is built only if Phase 2 measures the per-pixel read above 0.5 ms
   on a full-screen glass pane at 1920 × 1080. The decision goes under `## Decisions`.
3. **Foliage back face (Phase 3).** A material marked as two-sided foliage reads the radiance cache
   twice, along the normal and against it, and adds `subsurfaceColor × back`. It takes 0.7 of the
   Short Range AO. The material keeps its colours: the mechanism reads the material's own
   `subsurfaceColor`, and a material without one gets no back term. The name follows Unreal's
   shading model, `twoSidedFoliage`. Phase 3 first runs `engine_search_capabilities "two sided foliage"`
   and reuses an installed foliage material if one exists.

**Names and manifest.** The cache read for translucency carries `@alias lumen translucency volume`
and `@alias translucency gi`. The foliage term carries `@alias two sided foliage` and
`@alias subsurface color`.

**Where each part lives.** The reads are mechanism beside the radiance cache in `packages/core/src/render/`.
The subsurface colour, the AO factor and the fog density are look values in game or template source.

## Acceptance Criteria

- [ ] AC-1 [local]: The glass pane and the fog-filled room regions on the owned engine match Unreal Epic within the PRD-631 thresholds at L7. proof: `pnpm unreal-look:compare --scene gi --layer L7` — Evidence: pending.
- [ ] AC-2 [local]: The back-lit leaf region of the `foliage` pose matches Unreal Epic within the thresholds. proof: the same command — Evidence: pending.
- [ ] AC-3 [local; needs a built desktop host]: The conformance row `translucency-gi` passes on the desktop lane within its tolerance. proof: `pnpm parity --target desktop --only-tests translucency-gi` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Translucency reads the radiance cache | Translucent and transmissive node materials in the game | Replaces the sky's diffuse term on those materials | AC-1 |
| Fog reads the radiance cache | The VQ-07 volumetric fog froxel pass | Adds a GI term to the sun and sky terms | AC-1 |
| Two-sided foliage back face | Materials marked `twoSidedFoliage` | New | AC-2 |

## Execution Phases

#### Phase 1: What takes no GI
**Status:** NOT STARTED
**Files:** `tools/unreal-reference/gi/foliage/{scene.py,criteria.md}` (new), `tools/unreal-reference/gi/scenes.json`
- [ ] `foliage` is ready to calibrate: authored and captured in Unreal, recreated with direct light matching (PRD-646), and its PRD-647 criteria written. proof: `pnpm unreal-look:capture --engine unreal --scene gi:foliage --check-cvars` and `pnpm unreal-look:compare --scene gi:foliage --layer L1`.
- [ ] The materials and fog froxels that take no GI on the `foliage` scene are listed under `## Decisions`, with the per-region error against Unreal Epic. proof: `pnpm unreal-look:compare --scene gi:foliage --layer L7`.

#### Phase 2: Glass and fog
**Status:** NOT STARTED
**Files:** `packages/core/src/render/probe-volume.ts`, the VQ-07 fog pass, `packages/core/__tests__/probe-volume.spec.ts`
- [ ] A translucent pixel and a fog froxel read the same irradiance as an opaque pixel at the same point. proof: `pnpm exec vitest run packages/core/__tests__/probe-volume.spec.ts`.
- [ ] The per-pixel read on a full-screen glass pane costs no more than 0.5 ms at 1920 × 1080, or the froxel decision is recorded. proof: `node packages/playtest/dist/runner/cli.js perf` on the harness.

#### Phase 3: Leaves lit from behind
**Status:** NOT STARTED
**Files:** `packages/core/src/render/probe-volume.ts`, `packages/core/__tests__/probe-volume.spec.ts`, `packages/runtime-native/conformance/scenes/shared/translucency-gi.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] A `twoSidedFoliage` material adds `subsurfaceColor ×` the back-face irradiance, and a material without `subsurfaceColor` adds nothing. proof: `pnpm exec vitest run packages/core/__tests__/probe-volume.spec.ts`.
**Verification:** AC-2 and AC-3. A PRD-647 round on `foliage` at `high`, Unreal Epic as the target, must return IMPROVEMENT against BEFORE on the `foliage` and `glass` poses.
