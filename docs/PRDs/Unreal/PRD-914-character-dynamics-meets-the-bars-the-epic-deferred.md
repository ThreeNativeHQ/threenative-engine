---
prd_contract: v1
---

# PRD-914 — The cape and hair meet the bars the character-dynamics epic deferred

**Status:** OPEN (filed 2026-11-23, when PR #717 landed with these criteria deferred)
**Priority:** P2 — the cape, the hair, the scene and the owned-engine barriers shipped in #717. The open bars are tighter motion and cost targets on that shipped work.
**Complexity:** 6 (MEDIUM) — two core solvers and one material, all with their scene and playtests already in place.
**Owner:** João
**Depends on:** None (builds on `docs/PRDs/done/character-dynamics/` PRD-909 to PRD-912, and `docs/PRDs/done/PRD-913-owned-engine-shader-ir-gains-workgroup-memory-and-barriers.md`)
**Repo:** this repo (`packages/core/src/softbody-skinned.ts`, `packages/core/src/hair-strands.ts`, `examples/character-dynamics/`)

## Context

PR #717 shipped the scene (PRD-910) and the skinned cape (PRD-911), the hair (PRD-912) and the hair-card material (PRD-909). It also shipped workgroup memory and barriers in the owned engine, plus one-dispatch cape and hair solvers (PRD-913). The owner decided on 2026-11-23 to land it with these red criteria moved here. Measured on that day: owned engine, RTX 2080, 1080p, `--live-clock`, GPU clock not locked, so every GPU number is an upper bound.

- **Cape stretch:** 29% in the worst phase at the default 6 substeps × 2 iterations, against a 10% bar. Iterations saturate. Only 24 substeps × 8 iterations reach the bar (2.9-8.4%), and they cost about 3 ms of GPU. One sweep costs about 11 µs and one substep about 50 µs.
- **Cape hard stop:** the trail reads 54.7° against Unreal's 30.9° ± 3.1. The phase's maximum is its first sample, at the end of the sprint. There our cape swings with the stride, and Unreal's falls steadily. No solver configuration tried lands in the band.
  - Cape jog, jog turn and sprint pass the band (Unreal ± max(perturbation spread, 10%)).
- **Ponytail hard stop:** the tip swing reads 0.262 m, against Unreal's `limitFull` band of 0.334-0.438 m. The snap turn passes.
- **Cost:**
  - Cape: GPU about 0.3 ms (bar 0.35), CPU submission 0.11-0.15 ms (bar 0.1).
  - 2,000 hair guides: about 0.4 ms GPU (bar 0.15). Was about 5 ms before PRD-913.
- **Hair-card material:** judged REGRESSION on one layer of 24 cards (the body shows through, with a seam and stippled tips). It needs a layered groom asset to judge fairly.
- **Hair kernel unit check:** vitest has no GPU, so the strand length and shape constraints are proved only on the GPU playtest (`acceptance-hair.playtest.json`: `hairStretch` 0, `hairInsideHead` 0).

## Phases

### Phase 1 — Timing on a locked clock

- [ ] The cape's GPU and CPU cost are timed with the GPU clock locked. proof: `perf.playtest.json --live-clock` on `?arm=cloth&probe=0`, 3 runs, with an `nvidia-smi --query-gpu=clocks.gr` log beside them.
- [ ] 2,000 hair guides are timed the same way. proof: `perf.playtest.json --live-clock` on `?arm=strands&probe=0&strands=2000&cape=0`, 3 runs.

### Phase 2 — Cape

- [ ] The colored Gauss-Seidel sweep gets cheaper, so more substeps fit the budget. Candidates: fewer barrier phases, merged small colors, and per-substep reads held in registers. Each is measured as its own arm. proof: `perf.playtest.json` plus `acceptance-cloth.playtest.json`, with the visual judge NEUTRAL or better.
- [ ] The hard-stop gap has a measured cause, and its fix is ported from Chaos, not fitted. proof: `acceptance-cloth.playtest.json` per-tick series (`?series=1`) against the Unreal per-tick series.

### Phase 3 — Hair

- [ ] The ponytail hard-stop gap has a measured cause and a ported fix. proof: `acceptance-hair.playtest.json` on `?arm=hair` against `reference.json`.
- [ ] A layered groom asset (several card layers, root coverage near 1) is used for the PRD-909 judge. proof: headed `--browser-recipe webgpu` captures, 2 runs per arm, judge subagent.
- [ ] The strand kernel's length and shape constraints have a test in the test suite that runs on a GPU. proof: a playtest scenario or conformance row that fails when the constraint pass is removed.

## Acceptance Criteria

- [ ] AC-1: Cape stretch ≤ 10% in every phase on `?arm=cloth`, at the defaults, within AC-3's cost (was PRD-911 AC-1, PRD-910 box 52, PRD-913 phase 2 box 1). proof: `acceptance-cloth.playtest.json`.
- [ ] AC-2: The cape hard-stop trail and the ponytail hard-stop swing fall within the Unreal band, Unreal ± max(perturbation spread, 10%) (was PRD-911 AC-3 and box 44, PRD-912 AC-3 and box 37). proof: `acceptance-cloth.playtest.json` and `acceptance-hair.playtest.json` against `tools/unreal-reference/character-dynamics/reference.json`.
- [ ] AC-3: The cape costs ≤ 0.35 ms GPU and ≤ 0.1 ms CPU submission. 2,000 hair guides cost ≤ 0.15 ms GPU. Both with zero readback when the probe is off, on the RTX 2080 owned-engine lane with a locked clock (was PRD-911 AC-5 and box 55, PRD-912 AC-4 and box 43, PRD-913 AC-1 and AC-2). proof: `perf.playtest.json --live-clock`.
- [ ] AC-4: A fresh visual judge returns IMPROVEMENT for the hair-card material over a plain `MeshStandardMaterial` with alpha test, at the close pose, and names the highlight and the soft edge (was PRD-909 AC-1 and box 35). proof: phase 3 box 2.

## Blocked on

- A locked GPU clock (`sudo nvidia-smi -lgc`) for phase 1 and AC-3: the owner, per run.

## Decisions

- 2026-11-23, owner: PR #717 lands with the criteria above deferred here, rather than holding the PR until every criterion is green ("Land with deferrals").
- 2026-11-23, lead: the Unreal motion band is Unreal ± max(perturbation spread, 10%), because a deterministic solver has a 3-run spread of 0. The ponytail bound is Unreal's `limitFull` SpringBone arm. The owner may override either.
