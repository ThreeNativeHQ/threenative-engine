# PRD-856: The mountains carry real silhouettes, erosion and rock

**Status:** PARTIAL — the level bedding stripes are gone from the forest backdrop (2026-11-08, PR #635). Shape, erosion and baked masks are open.
**Priority:** P2 — the mountains need visible improvement; Phase 1 names the defects first.
**Complexity:** 6 (MEDIUM-HIGH)
**Depends on:** [PRD-854](PRD-854-one-terrain-request-decides-the-landform-water-size-and-survey.md) (real-world backdrop), [PRD-855](PRD-855-the-ground-vegetation-reads-like-a-real-forest-floor.md) (ground layers)
**Epic:** [Strata terrain hardening](README.md), chain step PR-7 in [PR-CHAIN.md](PR-CHAIN.md)

## Problem

Owner, 2026-11-07: the mountains need to improve. The request does not name the defects, so Phase 1 names them from captures. The spike in [PR-CHAIN.md](PR-CHAIN.md) measured that fluvial erosion is about 80% of the 2.1–2.3 s alpine bake.

## Execution Phases

### Phase 1 — name the defects

- [ ] Capture the alpine, tundra and forest backdrop mountains at elevated and walking views beside references, and list each defect (silhouette, ridge sharpness, erosion channels, rock and snow placement, scale cues). proof: frames and the defect list on the PR
- [ ] Read the Unreal landscape and erosion references and cite each line. proof: `UE 5.8.3: Engine/...:line` citations in this PRD

### Phase 2 — shape and erosion

- [x] Domain warp in the TS `fbm` (algorithm only, no new dependency), used by the landform presets in `packages/terrain/src/core/presets.ts`. proof: a determinism spec on the warped `fbm` — already shipped (checked 2026-11-08): `packages/terrain/src/core/operations.ts:368-375` warps each noise sample by two offset noises, every landform preset passes `warp` (`presets.ts:125-207`), and `terrain-consumer.spec.ts` "pins seeded noise" hashes a warped seeded evaluation: 1/1 pass.
- [x] The heightmap-level-generator scree and gully passes (MIT) ported to the CPU bake beside `fluvial.ts` and `erosion.ts`, with the bake time recorded before and after. proof: a spec per pass and the timed alpine bake — 2026-11-08: `erode` methods `gully` (virtual-pipe rain, flux/water/erode/carry/finish) and `scree` (thermal slide) in `packages/terrain/src/core/gully.ts` and `scree.ts`, from upstream `43a525473` (MIT notice in each header). `erosion-gully-scree.spec.ts` red (missing module) then 14/14; terrain 598/598, `tsc` 0. Alpine 513²: preset evaluate 1 432 ms; gully +7 509 ms at its 200-step default (+2 232 ms at 60), scree +1 929 ms. Alpine 60 gully steps: hollows 3 303 → 15 483. Opt-in only; no preset uses them until a judge passes.
- [ ] The far mountain silhouettes can come from a real-world heightmap (PRD-854). proof: a cook with a survey backdrop

### Phase 3 — material and proof

- [ ] Rock on high slope or curvature, snow from slope and height, strata banding: the look lives in `render/`, the masks come from the bake. proof: the mountain frames in the judge set
  Partial (2026-11-08, PR #635): the owner called the backdrop's level 30 m bedding stripes "artificial lines". `src/render/terrain.ts` now dips the beds about 20 degrees, varies their spacing, breaks them along the face, weakens ledge snow and adds fall-line runoff streaks. Fresh judge (owned engine, headed WebGPU, RTX 2080, 2 runs per arm): IMPROVEMENT; the stripes are gone. The judge's remaining defects, in rank order: soft clay-like faces with no crags or gullies, cloud-like snow blobs that ignore slope, and a fine grain that does not scale with distance. Masks still come from the shader, not the bake.
- [ ] The edge and walk playtests stay green and the player still climbs the surveyed hills (`edgeOvershoot` ≥ 20). proof: the edge and walk playtests

## Acceptance Criteria

- [ ] A fresh visual judge returns IMPROVEMENT on the mountain frames against the references, with before/after sheets on the PR. proof: judge verdict on the PR
- [ ] No seam gap at the horizon ring. proof: the horizon frame in the judge set
