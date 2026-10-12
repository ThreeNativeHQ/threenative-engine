---
prd_contract: v1
---

# PRD-VQ-08 — Clouds and their ground attenuation share one authored field

**Status:** PROPOSED — 2026-10-01. No implementation or qualification is claimed.
**Priority:** P2 — Proposed one authored cloud field driving density, wind and transmittance; unstarted.
**Batch:** Visual quality execution batch. **Wave:** 2 / atmosphere.
**Dependencies:** Reuse the merged rain/snow kits and PRD-381 row 4. Coordinate atmosphere composition with VQ-07; do not recreate the kits.

## Grounding and intended outcome

[PR #382](https://github.com/ThreeNativeHQ/threenative/pull/382) is merged and owns rain/snow starter outcomes. [PRD-381](https://github.com/ThreeNativeHQ/threenative/blob/develop/docs/PRDs/feature-mining/PRD-381-nine-mineable-seams-in-eanpa-sky.md) already identifies an overhead attenuation-field seam. The remaining target is coherent cloud rendering and moving cloud shade, not a claim that weather or atmosphere is absent.

**Outcome:** An authored cloud layer moves above an outdoor scene and the associated ground attenuation follows the same field and wind. A sun/coverage change does not leave stale shadow tiles or replace the sky with a detached flat overlay.

## Design and ownership

Inventory the actual rain render source first; keep everything that already meets the outcome. Reuse the atmosphere data and upstream volume tools. The game owns the density field, noise assets, optical controls and motion. Only if duplication justifies it, add the PRD-381 numeric transmittance capture/lifetime seam: texel-snapped world coordinates, bounded coverage, complete generations and declared update age. The visible cloud and ground sampler share parameters, not separately tuned animations.

One regional cloud layer and one directional attenuation field. No global weather simulation, lightning rewrite, astronomical ephemeris rewrite or universal multi-scattering solver. An optional 2D fallback must be named as such.

## Reference design from the Unreal source (2026-10-09)

Unreal 5.8.3 solves the same "cloud and ground shade share one field" problem with a light-space
2D **cloud shadow map**. It does not store a single transmittance value per texel. Each texel stores
three numbers: the depth along the light where the cloud starts (km), the mean extinction inside the
cloud (1/m), and the maximum optical depth through it. A receiver then reconstructs its own optical
depth as `meanExtinction × max(0, receiverDepth − frontDepth)`, clamped by the maximum, and takes
`exp(−opticalDepth)`. One map is therefore correct for ground, props and a flying camera at any
height, including receivers inside the slab. A strength value lerps the result toward 1.
`UE 5.8.3: Engine/Shaders/Private/VolumetricCloudCommon.ush:15-67`.

The same factor dims the sun's contribution to the sky, and a second map of the same type (sky
AO, 10 trace samples) dims sky light under clouds.
`UE 5.8.3: Engine/Shaders/Private/SkyAtmosphere.usf:735-742`,
`Engine/Source/Runtime/Renderer/Private/VolumetricCloudRendering.cpp:139-164`.

Defaults and guards (`VolumetricCloudRendering.cpp:171-224`):

- The maximum resolution is 2048². A ray march takes up to 128 samples, and twice that when the sun
  nears the horizon.
- The map origin snaps to a 20 km grid and to its own texel grid, so camera motion does not shimmer.
- One spatial blur iteration is the default, and four is the maximum.
- Temporal accumulation is off by default, because Unreal marks it experimental.
- A sun rotation over 10° restarts any accumulated history.

For this PRD, the rain slab spans 145–815 m (`templates/rain/src/render/clouds-shader.ts:7-8`), so
receivers sit both below and inside it. A plain 2D transmittance map would be wrong for one of the
two. Phase 1 therefore adopts the three-channel encoding.

## Required behavior

- Zero coverage preserves the existing sky and unit ground transmittance; density is finite and transmittance stays in [0,1].
- A deterministic wind trace moves a known cloud and its ground footprint consistently in world coordinates.
- Teleport, sun-direction changes and quality changes invalidate stale coverage without showing an incomplete generation.
- Occluded sky pixels and fog/atmosphere ordering remain correct; cloud attenuation does not erase local artificial lighting.

## Execution phases

All proof paths below are **planned implementation targets**, not existing passing tests. Reuse an existing equivalent test or scenario after inspecting current code, and update the canonical proof path rather than adding a duplicate. Follow EXECUTE.md for fixture setup, variables, review and repository gates.

### Phase 1 — One cloud field with reusable inputs

- [ ] Reuse or extend kit cloud rendering so density, wind and lighting are driven by one declared game-owned parameter set. proof: `pnpm exec vitest run packages/create-threenative/__tests__/vq-clouds-and-overhead-transmittance.spec.ts`.
- [ ] Produce bounded directional transmittance from that same field as a light-space map of front depth, mean extinction and maximum optical depth (Unreal's encoding, above), so a receiver at any height below or inside the slab reconstructs its own attenuation. Admit shared capture machinery only when it reduces duplicate code. proof: `pnpm exec vitest run packages/create-threenative/__tests__/vq-clouds-and-overhead-transmittance.spec.ts`.

### Phase 2 — Stable world-space composition

- [ ] Integrate cloud radiance and direct-sun attenuation with the existing atmosphere and lighting graph. proof: `pnpm exec vitest run packages/create-threenative/__tests__/vq-clouds-and-overhead-transmittance.spec.ts`.
- [ ] Implement complete-generation publication, coverage invalidation and quality/resource limits for moving viewpoints. The map origin snaps to its texel grid, and a sun rotation over 10° restarts any accumulated history. proof: `pnpm exec vitest run packages/create-threenative/__tests__/vq-clouds-and-overhead-transmittance.spec.ts`.

### Phase 3 — Qualify the visible result

- [ ] The cloud/ground-footprint trace passes on WebGPU, including zero coverage, sun rotation and teleport. proof: `node packages/playtest/dist/runner/cli.js examples/abyss-framework/playtests/vq-clouds-and-overhead-transmittance.playtest.json --url ${VQ_URL:?} --browser-recipe webgpu`.
- [ ] The same trace and parameter set pass on Linux native; record the actual cloud path and attenuation generation. proof: `node packages/playtest/dist/runner/cli.js examples/abyss-framework/playtests/vq-clouds-and-overhead-transmittance.playtest.json --target desktop --executable ${VQ_NATIVE_EXECUTABLE:?}`.

## Acceptance criteria

- [ ] Visible cloud motion and ground attenuation agree on the authored field, while no-cloud mode preserves the preexisting scene. proof: the completed Phase 3 scenario outputs, with the named fixture, package/cohort and adapter recorded inline here.
- [ ] The feature preserves its documented inactive/fallback path and releases owned resources after repeated lifecycle transitions. proof: `pnpm exec vitest run packages/create-threenative/__tests__/vq-clouds-and-overhead-transmittance.spec.ts` plus the Phase 3 lifecycle scenario.

## Performance and promotion

Measure the visible volume and overhead-field capture separately. Do not enable a costly cloud tier by default without the paired frame budget. Numerical targets are proposed acceptance targets, not benchmark results. Pin the fixture, metrics and thresholds before changing the implementation; never relax a failing threshold just to mark this PRD complete. Shared abstractions must pass the repository's reuse/LOC admission rule. Appearance remains editable source.

## Blocked on

The optional shared overhead-field extraction is gated by PRD-381 reuse/admission rules; missing artistic noise assets need license-clear substitutes.

## Decisions

- 2026-10-09 (João, via the Unreal source review): the attenuation field uses Unreal's three-channel cloud-shadow encoding instead of a single transmittance value per texel, because the rain slab has receivers both below and inside it. Phase 1 box 2 and Phase 2 box 2 now name the encoding, the texel snap and the 10° history cut. No box was added or removed.

## Completion record

Update the phase boxes and this PRD only after the named proof runs. Record actual results inline, including any remaining exclusions. A merged planning or implementation PR alone is not proof that every acceptance criterion passed. Archive according to the parent PRD filing rules when the work is genuinely complete.
