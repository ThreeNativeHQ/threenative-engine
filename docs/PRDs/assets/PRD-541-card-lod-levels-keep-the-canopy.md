# PRD-541 — Card LOD levels keep the canopy

**Status:** ABSORBED into PRD-478 (PR 473), 2026-10-08 — the owner asked for one PR. Its remaining boxes are tracked here and finish with PRD-478.
**Priority:** P1 — Open: PRD-478's walking GPU p95 on Machinefall needs these trees to have a chain, and today a chain thins their needles visibly.
**Complexity:** 5 (MEDIUM) — one cook stage (`packages/assets/src/lod/`), the model pass's self-check, a Machinefall re-cook with timing and blind raters
**Owner:** João
**Depends on:** none. [PRD-478](../done/open-world/PRD-478-open-world-frame-architecture.md)'s AC-2 and AC-3 depend on this PRD.

## Context

Measured on Machinefall `map-walk`, desktop RTX 2080, quiet desktop (load under 10), 2026-10-08:

| Fact | Value |
| --- | --- |
| Early-route GPU p95 (route windows 1–2) | 9.2–9.8 ms; `gpuMain` p50 8.6 ms, 8.2 M main-pass triangles at the adaptive bias cap 2.5 |
| Single-level trees in that window | 9.4 M of 9.8 M triangles; `map_tree_kite_scotspinetall_01_far_0_001` alone is 545 instances x 8.9 k |
| Why single-level | the GLB's only mesh is the Fab pack's `*_far_LOD2`, and the cook skips any level-named mesh as `authored-lod` |
| With a chain (re-cook, same JS bundle) | route GPU p95 max 7.73 ms; the pooled walking bound has 1.6 % of frames over 8.3 ms (pass is 5 %) |
| What the chain costs | blind look: mid-distance pines read as bare trunks. The needle part takes the `cards` strategy, which keeps 50 % then 25 % of the cards **unscaled**, so canopy area falls to the keep ratio (`cards.ts`, PRD-458 AC-4) |

Keeping the needles at full cards is not an option: with every card part at LOD0 the early route goes to 11–13 M triangles, more than today.

## Solution

1. **A lone level name is not an authored chain.** The cook counts an asset as authored LOD only when it holds two or more level-named nodes. A lone `_LOD2` has no sibling for anything to select, so it is that asset's LOD0. Already written and red-green on PRD-478's branch (`d65fa1eab`); it moves here so it never ships without step 2.
2. **Card levels keep their coverage.** A card level appends a copy of each kept card, scaled about its centroid by `sqrt(1 / keep)`, to the primitive's own vertex arrays. The level's indices point at those copies. LOD0's indices do not change, and no schema changes: `TN_discrete_lod` stays index-only, and both readers (core's `model-lod.ts` and the world's `chainLevelParts`) already copy the base attributes and swap only the index buffer.
3. **A chained level past `castLevels` casts with the coarsest casting level.** `castLevels` defaults to 1. A placement drawn at a coarser level of a chain used to cast nothing, which left Machinefall's pines without shadows past their first switch. It now writes its records into the casters of the coarsest level that casts. No mesh is minted per level, and authored `lods` keep casting nothing past `castLevels`.
4. **The self-check measures what LOD0 draws.** `reachableStats` counts the vertices and the bounds that LOD0's indices reference. Appended level vertices are then not drift, and a real drift in LOD0 still fails.

Layer: the cook (`packages/assets/`). The game sets nothing; the scale is the keep ratio, which the reducer already owns.

## Decisions

- 2026-10-08, João: absorb this PRD's work into PRD-478's PR (now 473) (one PR, keep it simple); draft PR 463 closes.
- 2026-10-08, agent: a kept card scales by at most 2. The ratio levels (keep ≥ 0.25) reach full coverage under it. The terminal level keeps far fewer cards, and scaling them further would grow cards past the crown's silhouette, so it covers `4 × keep` of LOD0.

## Findings

- 2026-10-08 blind raters, PRD-478 tip vs this PRD's cook plus every level casting (same JS bundle except the cast default, laptop Intel GPU): 3 fresh raters, 8 poses, the candidate at or above on 24 of 24 votes (20 prefer, 4 ties, all ties on the bridge pose). All three note a few dark needle specks above the treetops on the highway pose: the bark part's one derived level drops the top 19 % of the trunk (top 0.920 → 0.746 of the quantized height) while the needles keep theirs, because a shallower part follows the deepest part's switch (`chainDistances`).

## Acceptance Criteria

- [x] AC-1: every ratio card level ships ≥ 0.95 of LOD0's card area, read back from the cooked bytes; the terminal level ships min(1, 4 × keep). proof: `foliage-lod.spec.ts` — 8 passed; red before the change: `expected 0.5162100266415837 to be greater than or equal to 0.95`
- [x] AC-2: Machinefall `map-walk` route GPU p95 passes the pooled walking bound (≤ 5 % of walking frames over 8.3 ms) on 3 quiet runs. proof: `TN_FRAME_BUDGET` windows, quiet desktop RTX 2080 — **passed 2026-10-09** on the clamp build (`lodfix11`), 3 quiet runs: 5/911, 3/1186, 4/988 walking GPU frames over 8.3 ms, pooled 12/3085 = 0.39 %.
- [ ] AC-3: no visual loss against PRD-478's tip. proof: 3 fresh blind raters at or above on the 4 `map-walk` and 4 `map-views` poses, and a pop series with no candidate-only late object. **Remains open after repair 2026-10-13:** the 2026-10-08 24/24 vote and 33-interval pop record predates final clamp `04400564a` and is historical context only. The current-core candidate site is prepared at `~/offload/sites/prd478-finalclamp-site` (bundle SHA-256 `cdb44459c84b278d400f29b8a43f3521c4995c688bb7f25b98e401a86b80d534`) against the existing develop baseline `~/offload/out/pop-dev`. **Capture state 2026-10-13 (terminal, nothing queued, nothing live):** job `prd478-finalclamp-visual-20261013` ended terminal 1 in `~/offload/out/prd478-finalclamp` with 4 `map-views` pose PNGs, 0 `map-walk` PNGs and 0 `world-capture` PNGs; the retry `~/offload/out/prd478-finalclamp-resume/map-walk` ended terminal 2 with `locator.screenshot: Timeout 29936ms exceeded` while waiting for element stability. No active PRD-473, PRD-478 or PRD-541 capture process was found on this host; remote lease state is not verified, so the earlier lease note is withdrawn. Both artifact sets are kept. No rating is claimed until 3 fresh blind raters judge the 8-pose bundle and the pop series.
  - **Next probes:** follow PRD-478's AC-3 probe list. First pin the combined PRD-473 default-on runtime with final clamp `04400564a` as the site's source, because the site matches the recorded bundle and asset-manifest hashes yet no source metadata establishes that combination, so no capture from it is acceptance evidence. Then diagnose the map-walk screenshot on the live clock and on the paused clock. Neither the ratings nor the pop series can start until a full candidate capture exists. Score only with 3 fresh verdict files. Phase 3 stays NOT STARTED.

## Execution Phases

#### Phase 1: The cook
**Status:** DONE
**Files:** `packages/assets/src/lod/{cards,generate,eligibility}.ts`, `packages/assets/src/passes/model.ts`, `packages/assets/__tests__/`

- [x] A lone level-named mesh gets a generated chain; two or more level-named nodes stay `authored-lod`. proof: red-green `lod-generation.spec.ts` — red `expected [ 'authored-lod' ] to not include 'authored-lod'`, then 44 passed (`e82e842e0`)
- [x] Card levels index scaled copies of their kept cards, LOD0 indices unchanged. proof: red-green `foliage-lod.spec.ts` (AC-1)
- [x] The model pass's self-check counts what LOD0 draws, so a card chain cooks without `TN_ASSETS_MODEL_DRIFT` and a LOD0 drift still throws. proof: `model-pass.spec.ts` drift cases green; the conifer cook threw `vertices 5997 -> 7573; bounding box drifted 2.109%` before; `vitest run packages/assets` 485 passed, 2 skipped

#### Phase 2: Both runtimes draw it
**Status:** DONE
**Files:** `packages/core/src/world-cells.ts`, `packages/core/__tests__/`

- [x] Core builds a card level whose geometry draws the scaled copies. proof: `model-lod-loader.spec.ts` "draws a level whose indices reach vertex copies appended after LOD0's" — 5 passed; no core change was needed
- [x] A placement drawn past `castLevels` on a chain casts with the coarsest casting level's casters, so it keeps its shadow without a caster per level; `castLevels` stays 1 by default. Under 1 with no clamp, every pine past its first switch lost its shadow, and 3 blind raters preferred the base on 6 of 8 poses ("weak shadows, flatter"). Casting every level instead fixed the look but tripled the twins, and a walking trace showed the churn: garbage collection 2.7 s against 0.28 s with the clamp, worst main-thread task 9.6 s against 1.0 s. proof: red-green `world-cells-chain-lod.spec.ts` (`expected 4 to be 85`), `vitest run packages/core` 2604 passed plus 1 load timeout that passes alone; the GPU-key path's matching clamp is PRD-478's `ce8c4def7`
- [x] The native desktop host draws the same chain. proof: `examples/auto-lod` gains a 1,200-card crown (`scripts/make-cards.mjs`); cooked to `cards` levels 2,400 → 1,252 → 646 triangles over 4,800 → 8,596 vertices. `lod-far-desktop` and `lod-near-desktop` pass on the native host built by `threenative build --target desktop` (prebuilt runtime): `cardCopies` 1 → 0 and `cardTriangles` 1,252 → 2,400 across the camera toggle. Web `lod-far` passes (`cardCopies` 0 → 1, `cardTriangles` 2,400 → 1,252, RTX 2080). Web `lod-near` is red on develop too (`triangles` 8192 → 8192, the first observation precedes selection), so it carries no card check.

#### Phase 3: Machinefall
**Status:** NOT STARTED
**Files:** none in the engine

- [x] Re-cook and time it. proof: AC-2's quiet runs — re-cooked into `lodfix11`; timed by AC-2 (0.39 % pooled).
- [ ] Blind raters and the pop series. proof: AC-3's sheets on the PR — rerun on the clamp build
