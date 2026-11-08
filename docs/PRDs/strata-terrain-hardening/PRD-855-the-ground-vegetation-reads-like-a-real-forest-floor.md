# PRD-855: The ground vegetation reads like a real forest floor

**Status:** NOT STARTED
**Priority:** P1 — the ground is too bright (soil L 46–51 against a 29–37 reference) and has no cover at walking height (Phase 2, Phase 3).
**Complexity:** 6 (MEDIUM-HIGH)
**Depends on:** [PRD-591](PRD-591-the-preview-stops-reimplementing-engine-mechanisms.md) AC-4 (measured height bands)
**Epic:** [Strata terrain hardening](README.md), chain step PR-6 in [PR-CHAIN.md](PR-CHAIN.md)

## Problem

Owner, 2026-11-07: the ground vegetation looks bad and too bright. Known measures: the soil reads L 46–51 against a reference of 29–37, the near foreground reads as one smooth dirt sheet with no needle detail, and grass, low plants and ferns are missing at walking height (PRD-580 AC-2, PRD-584 AC-4).

## Execution Phases

### Phase 1 — references and criteria

- [ ] Capture the current ground on all five worlds beside the Gaia and AAA reference frames, and write the visual acceptance criteria. proof: `capture-strata-worlds` frames and the criteria list on the PR
- [ ] Read the Unreal Landscape grass subsystem (grass types, density scaling, cull distance) and the layer blending, and cite each line. proof: `UE 5.8.3: Engine/...:line` citations in this PRD

### Phase 2 — soil value

- [ ] Soil albedo and roughness in `render/surfaces.ts` and `render/terrain.ts` put the soil inside L 29–37 at the forest walk pose under the metered auto exposure. proof: a measured L value from the walk-pose frame

### Phase 3 — cover and near detail

- [ ] Grass, low plants, ferns and litter density follow the measured height and slope bands and the splat layers. proof: a spec on the density rows, and the walk-pose frame
- [ ] Grass clumps in `render/cover.ts` get a darker root, a value range and colour variation per clump. proof: the close frame in the judge set
- [ ] Needle litter and a detail normal on the forest floor break the near ground into detail. proof: the close frame in the judge set
- [ ] Frame time, streaming, the 25 MiB cooked-kit budget and `pipelinesSinceReveal` 0 in `loop.playtest.json` stay at their original values. proof: `loop.playtest.json` and the starter-kit size spec

## Acceptance Criteria

- [ ] A fresh visual judge returns IMPROVEMENT on the ground frames of all five worlds, with before/after sheets on the PR. proof: judge verdict on the PR
- [ ] No `TN_SCENE_WARNING` in the forest walk. proof: the forest walk playtest log
