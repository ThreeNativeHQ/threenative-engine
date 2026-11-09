# PRD-855: The ground vegetation reads like a real forest floor

**Status:** PARTIAL — the bare soil reads L* 35 at the walk pose (Phase 2); references, cover and near detail are open.
**Priority:** P1 — the ground is too bright (soil L 46–51 against a 29–37 reference) and has no cover at walking height (Phase 2, Phase 3).
**Complexity:** 6 (MEDIUM-HIGH)
**Depends on:** [PRD-591](PRD-591-the-preview-stops-reimplementing-engine-mechanisms.md) AC-4 (measured height bands)
**Epic:** [Strata terrain hardening](README.md), chain step PR-6 in [PR-CHAIN.md](PR-CHAIN.md)

## Problem

Owner, 2026-11-07: the ground vegetation looks bad and too bright. Known measures: the soil reads L 46–51 against a reference of 29–37, the near foreground reads as one smooth dirt sheet with no needle detail, and grass, low plants and ferns are missing at walking height (PRD-580 AC-2, PRD-584 AC-4).

## Execution Phases

### Phase 1 — references and criteria

- [ ] Capture the current ground on all five worlds beside the Gaia and AAA reference frames, and write the visual acceptance criteria. proof: `capture-strata-worlds` frames and the criteria list on the PR
- [x] Read the Unreal Landscape grass subsystem (grass types, density scaling, cull distance) and the layer blending, and cite each line. proof: `UE 5.8.3: Engine/...:line` citations in this PRD — 2026-11-08, read at the 5.8.3 clone (`396c9f059`); a DeepSeek scout listed them and each line below was re-read by hand:
  - A grass variety defaults to 400 instances per 10 m² (40 per m²), clamped 0 to 1 000, on a jittered grid (`bUseGrid`, `PlacementJitter` 1). UE 5.8.3: Engine/Source/Runtime/Landscape/Classes/LandscapeGrassType.h:43, Engine/Source/Runtime/Landscape/Private/LandscapeGrass.cpp:1482
  - Start and end cull distances both default to 10 000 units (100 m); between them a `PerInstanceFadeAmount` material fades each instance, and past the end a whole cluster is culled. UE 5.8.3: Engine/Source/Runtime/Landscape/Classes/LandscapeGrassType.h:57, Engine/Source/Runtime/Landscape/Private/LandscapeGrass.cpp:1486
  - Scale is uniform with every range 1 to 1, rotation is random, and each instance aligns to the surface by the triangle normal. UE 5.8.3: Engine/Source/Runtime/Landscape/Private/LandscapeGrass.cpp:1492, Engine/Source/Runtime/Landscape/Classes/LandscapeGrassType.h:119
  - `grass.densityScale` and `grass.CullDistanceScale` scale every variety at once, both 1 by default. UE 5.8.3: Engine/Source/Runtime/Landscape/Private/LandscapeGrass.cpp:130
  - Layer blending has weight, alpha (legacy) and height modes. A height-blended weight is clamp(lerp(-1, 1, weight) + height, 0.0001, 1), then every weight is divided by their sum, so height 0 keeps the painted weight and a layer never reaches exactly 0. UE 5.8.3: Engine/Source/Runtime/Landscape/Classes/Materials/MaterialExpressionLandscapeLayerBlend.h:21, Engine/Source/Runtime/Landscape/Private/Materials/MaterialExpressionLandscapeLayerBlend.cpp:224
  What this PRD takes: density per square metre and a fade band before a hard cull (Phase 3 density rows), random yaw and surface alignment for clumps, and height blending at the soil and litter edges.

### Phase 2 — soil value

- [x] Soil albedo and roughness in `render/surfaces.ts` and `render/terrain.ts` put the soil inside L 29–37 at the forest walk pose under the metered auto exposure. proof: a measured L value from the walk-pose frame — 2026-11-09: `BARE_SOIL` (0.4, 0.38, 0.37) multiplies the forest's bare-earth mask on top of the litter tint in `render/terrain.ts`; roughness unchanged. `capture-strata-worlds` forest `player` (metered auto exposure, NVIDIA Turing), CIELAB L* of the bare patch crop 120x40+1080+420: 53.1 before (2 runs) → 35.0 after (2 runs, 35.01 both); sunlit turf 57.3 → 57.1. The judge's wider crop of the same patch reads 49.7 → 38.6, and a part-bare sunlit fringe 57.7 → 45.9; shadowed soil under the canopy 16 → 12. Fresh judge: IMPROVEMENT on player, meadow-close and overview in both runs, NEUTRAL on river (little soil), no hard edge, hue stays warm. Left: beige ground behind the meadow-close tree row and on the lower-left hillside is not the litter mask and not the sand band (each turned off, no change); unexplained. Sheets `prd-855/soil-forest-run{1,2}.jpg` on `pr635-screenshots`.

### Phase 3 — cover and near detail

- [ ] Grass, low plants, ferns and litter density follow the measured height and slope bands and the splat layers. proof: a spec on the density rows, and the walk-pose frame
- [x] Grass clumps in `render/cover.ts` get a darker root, a value range and colour variation per clump. proof: the close frame in the judge set — 2026-11-09: the forest draws the licensed Grass Library, so the change is in `render/pack.ts` (`cover.ts` is the procedural fallback and already carries four per-clump greens and `rootAo`). Each grass and meadow clump takes a green-to-dry hue with value about 1 from its `instanceRandom` (a red/blue debug arm proved the hash varies per clump), and its lowest 10 cm shades to 0.72. A first tune (value 0.62–1.2, root 0.45 over 18 cm) was judged REGRESSION: meadow-close L* 45.9 → 40.5. The retune holds L* 46.1 (2 runs). Fresh judge: IMPROVEMENT on meadow-close and river in both runs, NEUTRAL on player and overview, nothing outside the grass changed; saturation 0.32 → 0.41. Left: the short carpet blades still read as dark strokes in both arms. Sheets `prd-855/clump-{forest,close}-run{1,2}.jpg` on `pr635-screenshots`.
- [ ] Needle litter and a detail normal on the forest floor break the near ground into detail. proof: the close frame in the judge set
- [ ] Frame time, streaming, the 25 MiB cooked-kit budget and `pipelinesSinceReveal` 0 in `loop.playtest.json` stay at their original values. proof: `loop.playtest.json` and the starter-kit size spec

## Acceptance Criteria

- [ ] A fresh visual judge returns IMPROVEMENT on the ground frames of all five worlds, with before/after sheets on the PR. proof: judge verdict on the PR
- [x] No `TN_SCENE_WARNING` in the forest walk. proof: the forest walk playtest log — 2026-11-09 at `6a62ad130` (with the humus soil): `playtests/walk.playtest.json` on the built preview, headed WebGPU, nvidia/turing, exit 0, no diagnostics, 0 `TN_SCENE_WARNING` lines; the five-world `test:terrain:web` run (terrain-web4) also logged 0.
