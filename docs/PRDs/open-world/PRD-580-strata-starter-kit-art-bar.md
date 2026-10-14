# PRD-580 — Strata starter-kit art bar

**Status:** IN PROGRESS
**Priority:** P2 — Five starter kits still need a score of at least 4 on every visual rubric row.
**Complexity:** 3 (LOW); risk override: none
**Owner:** ThreeNative maintainers
**Depends on:** [PRD-466](../done/PRD-466-strata-terrain-threejs-integration.md), retained terrain and starter-kit contracts
**Parent:** [PRD-466](../done/PRD-466-strata-terrain-threejs-integration.md)

## Context

PRD-466 supplies terrain, editable kits, asset budgets, runtime wiring and
playtests. Its unmet AC-5, K3 and K4 art criteria move here by João's decision
on 2026-10-09. Work proceeds in order: forest, coastal, alpine, desert, tundra.
A fresh judge subagent must score at least 4 on every rubric row for each kit.
Ground, trees_rocks and lighting_depth are required. Water and artifacts also
apply where the kit rubric names them. A nonblank capture is not art acceptance.

Owner-directed work (2026-10-12): João requested two dedicated arms for realistic procedural trees and ground vegetation, with distinct species/variations and high-quality Poly Haven textures that remain inexpensive to render. Tree work owns tree geometry/materials; ground work owns grasses, ferns, shrubs and flowers. Both preserve a sealed source baseline and use existing instancing, LOD, wind and asset preparation, followed by two headed before/after captures and an independent visual judge. Preview improvements must later reach the generated starter kits through newly versioned assets; published archive 0.1.0 remains immutable. The existing rubric and per-kit runtime gates remain required.

## Solution

Keep appearance in the editable starter source under
`packages/terrain/starter/<world>/`. Reuse the existing kit scenes and
`test:kit` captures. Improve forest crown and rock geometry, ground variation,
contact shadows and the authored sky before extending the changes to other kits.
Replace faceted leaf-card crowns with non-faceted crown geometry. Keep asset
credits, runtime behaviour and the cooked budget of at most 25 MiB per kit.

Author the sky and horizon for elevated edge and overview views. Draw coastal
waves and shore foam through the installed ocean mechanism. Give tundra kettles
an ice surface. Preserve the terrain and collision identity and the closed basins.
Each kit's existing runtime proof must still pass after its art changes.

For each art proof, run the named kit command to capture ground, edge, lake and
overview. Give those captures to a fresh judge subagent for absolute scoring
against the parent rubric. Record its scores and before/after views in the PR.
All rows must reach 4. Lowering that threshold needs an owner decision first.

## Acceptance Criteria

- [ ] AC-1 [local, actor: implementing agent]: The authored sky and horizon reach at least 4 on lighting_depth in elevated views of all five kits. proof: `KIT=<world> pnpm --filter strata-terrain-preview test:kit` for forest, coastal, alpine, desert and tundra, plus fresh judge scores on edge and overview captures — Evidence: pending.

## Execution Phases

### Phase 1: Forest art

**Status:** IN PROGRESS
**Files:** `packages/terrain/starter/forest/`, shared CC0 starter assets and the existing forest kit scene.
**Implementation:** Replace faceted crowns and improve rock geometry, ground detail, shadows and sky. Keep all appearance editable.

- [ ] F1 [local, actor: implementing agent]: The forest kit reaches at least 4 on every rubric row. proof: `KIT=forest pnpm --filter strata-terrain-preview test:kit` plus fresh judge scores for ground, edge, lake and overview — Evidence: pending.

### Phase 2: Coastal and alpine art

**Status:** NOT STARTED
**Files:** `packages/terrain/starter/coastal/`, `packages/terrain/starter/alpine/` and their existing kit scenes.
**Implementation:** Complete visible coastal waves and shore foam. Improve coastal ground and alpine steep-face textures and horizon framing.

- [ ] C1 [local, actor: implementing agent]: Coastal water renders waves and shore foam. proof: `KIT=coastal pnpm --filter strata-terrain-preview test:kit` plus fresh judge water scores of at least 4 on shore captures — Evidence: pending.
- [ ] C2 [local, actor: implementing agent]: The coastal kit reaches at least 4 on every rubric row. proof: `KIT=coastal pnpm --filter strata-terrain-preview test:kit` plus fresh judge scores for ground, edge, lake and overview — Evidence: pending.
- [ ] A1 [local, actor: implementing agent]: The alpine kit reaches at least 4 on every rubric row. proof: `KIT=alpine pnpm --filter strata-terrain-preview test:kit` plus fresh judge scores for ground, edge, lake and overview — Evidence: pending.

### Phase 3: Desert and tundra art

**Status:** NOT STARTED
**Files:** `packages/terrain/starter/desert/`, `packages/terrain/starter/tundra/` and their existing kit scenes.
**Implementation:** Remove visible desert tiling and improve its props and horizon. Render ice in the tundra kettle basins and improve shoreline transitions.

- [ ] D1 [local, actor: implementing agent]: The desert kit reaches at least 4 on every rubric row. proof: `KIT=desert pnpm --filter strata-terrain-preview test:kit` plus fresh judge scores for ground, edge, lake and overview — Evidence: pending.
- [ ] T1 [local, actor: implementing agent]: Tundra kettles render as an ice surface. proof: `KIT=tundra pnpm --filter strata-terrain-preview test:kit` plus fresh judge water scores of at least 4 on kettle captures — Evidence: pending.
- [ ] T2 [local, actor: implementing agent]: The tundra kit reaches at least 4 on every rubric row. proof: `KIT=tundra pnpm --filter strata-terrain-preview test:kit` plus fresh judge scores for ground, edge, lake and overview — Evidence: pending.

## Blocked on

- A lower art bar is an alternative to new geometry and an authored sky. João must choose and record any lower threshold; the current bar stays at 4 until that decision.

## Integration Ledger

Integration: unchanged — existing copied kit source, kit scenes and playtest capture paths remain the consumer route. This PRD changes their appearance.

## Decisions

- 2026-10-09 (João, owner; recorded by the implementing agent): Transfer PRD-466's unmet K3, K4 and AC-5 art bar here. The owner said "ok, update label, push forward to 100%" after the plan to move scores below 4 into a follow-up. This grants the transfer; it does not lower the art bar.

## Prior evidence (PRD-466)

The parent retains the complete AC-5, K3 and K4 text under Decisions, including
scores, proofs and tried-and-reverted levers. Eight bounded rounds ran on
2026-10-09 using CC0 Poly Haven fir_tree_01, boulder_01 and Kloofendal HDRI.
Scores below use ground / trees_rocks / lighting_depth:

| Reading | Scores | Disposition |
| --- | --- | --- |
| Before | about 2–3 each | Baseline |
| R2 | 2 / 2 / 3 | Prior round |
| R3 | 3 / 2 / 3 | Prior round |
| R4 | 2 / 2 / 3 | Prior round |
| R5 | 2 / 3 / 3 | Prior round |
| R6 | 3 / 3 / 2 | Prior round |
| R7 | 3 / 3 / 3 | Final committed kit |
| R8 | 3 / 3 / 3 | Neutral; reverted |

The committed forest improved over BEFORE in edge, ground, lake and overview.
It still missed the bar. The judge named faceted leaf-card crowns, flat blown-out
sky in elevated views, stair-stepped shorelines, tiled flat ground and hard dark
shadow slabs. Parameter changes plateaued. Doubled haze, foliage sky light
changes and a tundra frost band were tried and reverted; the parent keeps their
individual scores and reasons. New tree/rock geometry, an authored sky or an
owner-approved lower bar is required.

AC-5 already has measured terrain relief and cooked-budget proofs. K4 already
has kit bake, runtime and playtest proofs for coastal, alpine, desert and tundra.
Those proofs do not establish visual acceptance. Tundra ice and final coastal
waves/shore foam remain here. The later coastal spectral surface scored water 3;
that observation does not prove the wave/foam art bar. The later tundra basin
change scored water 3, with all other rows still below 4.

2026-10-12 procedural-tree candidate `e54c37a15` remains unaccepted. It adds Norway spruce, silver fir and Scots pine forms, a 697,357-byte Poly Haven twig/relief atlas and three distance levels; 42 focused tests and TypeScript pass. Two headed BEFORE/AFTER repeats at 1920×1080 on NVIDIA/Turing, resolution scale 1 and MSAA 4, received fresh read-only **REGRESSION** verdicts for forest-start, meadow-close and overview in both pairs. The judge found severely reduced crown coverage, exposed regular radial branch spokes and distant trees reading as dead standing timber. Fine twig cutouts do not offset missing foliage volume. Camera-hop admission also varies between meadow captures; ground vegetation differences were excluded from the tree verdict. The capture scenarios retain their console/network diagnostics failures for expected local-only asset 404s; these runs are visual evidence, not runtime acceptance. Candidate code is retained on its separate tree branch; a bounded crown repair is in progress. Existing captures: `artifacts/tree-captures/{before-1,before-2,after-1,after-2}` in the tree lane.

Ground candidate `3a07716b8` remains unaccepted after its earlier REGRESSION/NEUTRAL comparison. CPU inspection of the four calibrated captures found camera-hop `streamingAdmissionBacklog` values 137, 153, 151 and 146 at the screenshot despite identical placement counts and camera pose. The local capture fixture now waits, with bounded deadlines, for the existing admission, prewarm and in-flight load counters to drain at each view; shipped scenario validation passes for all ten steps. Geometry is unchanged pending comparable captures. This diagnosis does not establish a visual improvement or close a kit art box.

Tree repair `8e8a901d7` remains unaccepted after two new settled runs per arm. All three views use NVIDIA/Turing, 1920×1080, scale 1 and MSAA 4, with admission/prewarm/load/failure counters zero. Independent read-only review of all twelve labelled images grades meadow-close IMPROVEMENT, forest-start NEUTRAL and overview REGRESSION in both pairs; overall REGRESSION. Fine conifer sprays improve close detail, but horizontal shelves, flattened tops, exposed poles and sparse distant crown mass remain artificial. The two sparse-crown failures invalidate the assumption that overlapping twig cards alone preserve convincing crown volume. The tree branch and captures are retained separately; no candidate geometry is integrated. Existing repaired comparison captures: `artifacts/tree-captures/{settled-before-1,settled-before-2,repaired-after-1,repaired-after-2}` in the tree lane.

Settled ground review of `3a07716b8` restores flowers in all four arms with zero streaming counters, but still grades both meadow-close and foreground pairs REGRESSION: rigid broad blades read as flat cut strips and dark planar faces. Admission explained missing flowers, not the rejected grass shape. A narrow curved-blade repair `8407e0cf4` passes 59 focused tests and TypeScript with unchanged grass triangle/vertex counts, texture bytes and draw structure. Two calibrated repaired AFTER captures are complete; fresh independent review is pending. Diagnostic local-asset 404 failures remain failures. No ground art acceptance is claimed.

Repaired ground `8407e0cf4` is visually accepted and integrated as `1b7e2cee6`/`ce7f08b4a`: independent read-only inspection of all eight actual images grades meadow-close and foreground **IMPROVEMENT in both pairs and overall**. Narrower bending blades remove the broad ribbon/spear appearance; low growth and taller tufts show clearer clump/height variation. Repeated stiff V-shaped fans and modest species distinction remain, so this is an improvement verdict rather than full kit-art acceptance. Wind phase was excluded. All eight public images return HTTP 200 and byte-match the captures. Parent integration checks pass 55/55 focused ground/LOD/streaming/surface tests, example TypeScript and scoped Biome (two existing complexity advisories). The capture scenarios still fail diagnostic policy on optional local-asset 404s; no runtime or cooked-kit acceptance is claimed.

Ground pair 1: [BEFORE meadow-close](https://raw.githubusercontent.com/ThreeNativeHQ/threenative-engine/ee7fb90a8f14175edc70238e72f7c42823b9d9b9/pr483/ground-vegetation-before-1-meadow-close.png), [AFTER meadow-close](https://raw.githubusercontent.com/ThreeNativeHQ/threenative-engine/ee7fb90a8f14175edc70238e72f7c42823b9d9b9/pr483/ground-vegetation-after-1-meadow-close.png), [BEFORE meadow-foreground](https://raw.githubusercontent.com/ThreeNativeHQ/threenative-engine/ee7fb90a8f14175edc70238e72f7c42823b9d9b9/pr483/ground-vegetation-before-1-meadow-foreground.png), [AFTER meadow-foreground](https://raw.githubusercontent.com/ThreeNativeHQ/threenative-engine/ee7fb90a8f14175edc70238e72f7c42823b9d9b9/pr483/ground-vegetation-after-1-meadow-foreground.png).
Ground pair 2: [BEFORE meadow-close](https://raw.githubusercontent.com/ThreeNativeHQ/threenative-engine/ee7fb90a8f14175edc70238e72f7c42823b9d9b9/pr483/ground-vegetation-before-2-meadow-close.png), [AFTER meadow-close](https://raw.githubusercontent.com/ThreeNativeHQ/threenative-engine/ee7fb90a8f14175edc70238e72f7c42823b9d9b9/pr483/ground-vegetation-after-2-meadow-close.png), [BEFORE meadow-foreground](https://raw.githubusercontent.com/ThreeNativeHQ/threenative-engine/ee7fb90a8f14175edc70238e72f7c42823b9d9b9/pr483/ground-vegetation-before-2-meadow-foreground.png), [AFTER meadow-foreground](https://raw.githubusercontent.com/ThreeNativeHQ/threenative-engine/ee7fb90a8f14175edc70238e72f7c42823b9d9b9/pr483/ground-vegetation-after-2-meadow-foreground.png).

2026-10-13 oblique tree LOD candidate remains rejected: isolated `6a1de2369` receives two new completed NVIDIA1920x1080 captures, scale1/MSAA4 and all four streaming counters zero at all three poses. Both new scenarios and capture validators pass. A fresh read-only judge inspects all12 labelled BEFORE/AFTER images: forest-start REGRESSION, meadow-close IMPROVEMENT, overview REGRESSION in both pairs, overall REGRESSION. Finer photographic foliage and crown variation do not compensate for flattened shelves, exposed trunks and lost distant crown mass. This is the third rejected tree candidate; the assumption that twig-card orientation/density preserves healthy crown volume is now doubtful. No further equivalent card tweak is attempted, no tree code/assets are integrated, and kit/native art acceptance remains open. Accepted ground vegetation is unchanged.

2026-10-13 forest kit overview on merged branch `9ab9d5f12` (no box ticked): `KIT=forest test:kit` passes on `nvidia/turing` (819 frames, 8,791 firs drawn), and the overview frame shows distant firs as slanted dark streaks (frames: PR #483 comment 6155770975, `strata-hardening-screenshots` `pr483/forest-kit-*-merged-9ab9d5f12.jpg`). Impostors off is not a fix: that overview frame exceeded the 120 s screenshot timeout. Cause by code reading only, not measured: the impostor atlas is `IMPOSTOR_VIEW_GRID = 4`, so 16 octahedral views of which 9 are distinct (`packages/core/src/render/world-impostor.ts:40-80`), and the fragment blends three corners (`world-impostor-surface.ts:508-537`), so a 40 degree aerial eye puts about 18% of its weight on a view about 76 degrees away. No grid-size or tilt option exists on `IWorldCellsLoadOptions`. Next: capture one aerial pose with the grid at 8 (engine change, atlas bytes x4 against `IMPOSTOR_ATLAS_BYTES`), judge it before/after, and decide whether the grid becomes a game option.

2026-10-13 aerial impostor streaks fixed in the engine (layer: engine, `packages/core/src/render/world-impostor.ts`; no box ticked): `IMPOSTOR_VIEW_GRID` 4 to 8, so the atlas holds 64 octahedral views (49 distinct) instead of 16 (9 distinct). The same `KIT=forest pnpm --filter strata-terrain-preview test:kit` pose, `nvidia/turing`, private Xvfb, two runs per arm, kit passes in both arms. Visual judge (fresh read-only Sonnet subagent, BEFORE and AFTER burned in): ground NEUTRAL, edge NEUTRAL, overview IMPROVEMENT, lake IMPROVEMENT (mild), OVERALL IMPROVEMENT, runs agree. Judge caveats, not resolved: AFTER distant foliage reads slightly lighter and lower in contrast (a luminance or coverage number is owed), and one dark streak on the lake ridge remains. Cost: one atlas is 11.2 MB instead of 2.8 MB, so the default 128 MB budget holds 11 atlases instead of 48 (a world with more impostor species keeps its source LODs for the rest), and a bake takes 64 render-cadence updates instead of 16. Specs now derive from the exported constants (63 impostor tests pass). Images: `pr483/impostor-grid8-{ground,edge,overview,lake}-run{1,2}-BEFORE-AFTER.jpg` on `strata-hardening-screenshots`. Native rendering unverified: the native host runs the same TypeScript, but no `--target desktop` run was made.

2026-10-13 impostor grid 8 luminance check (answers the judge's caveat, no box ticked): overview pose mean luma 0-255 over the forested lower band is 91.6 and 90.6 in the two BEFORE runs and 95.3 and 95.4 in the two AFTER runs (whole frame 127.3 and 126.7 to 130.4 and 130.5). AFTER is about 4 levels (4.7%) lighter, which is the removed dark streaks; no other pose was measured.

2026-10-14 owner rejection in the actual generated consumer: the new close-tree screenshot shows a round, broad root base nearby and black conical trunks farther away; the owner reports tree shape changing on approach and rejects the scene's light, shadows and atmosphere. Source-asset flare and static export preservation do not establish correctness of distance-selected LODs. A single cooked-tree diagnostic confirms three actually rendered arms (shared Physical materials, four texture-preserving Basic materials, and existing forest sky dressing) retain the dark sparse appearance; no lighting-only repair is accepted. Opus 5.5 high is assigned the actual LOD/appearance fix, with the shared-mechanism versus authored-render-source boundary preserved. The surface table is transferred intact, including distance albedo blend amount 0.6 and persistent fine normal detail. Full-world art and all rubric/visual acceptance boxes remain open.

2026-10-14 owner acceptance update: the actual generated forest must reach the requested AAA scene bar with proper lighting, shadows, textures, tree transitions and atmosphere. Relative improvement or passing implementation tests alone is insufficient. Send matching headed hardware captures to a fresh read-only visual judge first; require both improvement and an explicit assessment against that scene-quality bar. Attach the accepted screenshots to PR #483, then send one attention-ping completion notification as explicitly requested by the owner. No notification or visual acceptance is claimed yet.

2026-10-14 Opus shadow candidate, no visual box ticked: generated lighting accepts measured outer shadow windows and a scene-supplied VirtualShadowNode class, retaining the ordinary starter arena sun/map by default and disposing shadow/light resources after postprocessing. The near window remains 14 m at desktop4096/mobile2048; the generated forest handoff supplies full-world diagonal coverage and streamed-region invalidation. Lighting tests pass 22/22; the formerly failing scaffold mobile asset case passes after a fresh assets build. Two clean hardware BEFORE captures match the fixed-character pose/camera exactly. These are implementation results only: high-end scene quality, soft-shadow transitions, proper atmosphere, ground texture/vegetation and the independent visual verdict remain open.

2026-10-14 terrain sampler-input normalization, bounded CPU candidate ready for runtime, no box ticked: `cookTerrainWorld` now gives each map kind (diff, nrm, orm, h) one size and one input encoding across all layers. A kind whose maps already share size, format and alpha keeps its authored bytes. Otherwise every map in the kind, the largest included, becomes lossless PNG at the largest width and height: decoded pixels kept, smaller maps resampled up, never down. This normalizes inputs only; the asset compiler still picks each texture's codec from its content. Both cook callers (`packages/terrain/src/mcp/cook.ts`, `packages/terrain/src/kit.ts`) route through this function and did not change; the MCP path loads the built `@threenative/assets`, which this lane did not rebuild. Real forest sources: grass, dirt and moss diff/nrm are 1024×1024 JPEG, rock is 512×512 JPEG. The published 0.1.0 archive and `starter-assets.json` are untouched. The regression cooks four layers with a half-size rock across all four kinds: every cooked map is PNG, decodes through `decodeImageBytes` to 64×64 RGBA8, the larger maps' decoded RGBA equals their source decode, and core `stackLayers` returns a 4-deep array per kind through a copying renderer stub. The size assertion fails with the normalization disabled (32×32 versus 64×64). Focused specs pass: assets terrain-world 30/30 and terrain-editor-cook 2/2. CPU compile probe on the eight real forest maps (current source `compileAssets`, web, budget none, installed Basis transcoder): all eight compile to KTX2 at 1024×1024 with 11 mips. The normal kind is compatible: four UASTC maps with one signature, which saves 3 samplers. The diffuse kind is still mixed: grass, dirt and moss are UASTC and the resampled rock is ETC1S, so it does not stack. Compiled bytes: diff 4,241,244 (PNG inputs 10,247,896), nrm 5,360,040 (PNG inputs 10,364,486), total 9,601,284. Expected effect, not measured: 19 samplers drop to 16, at the portable limit of 16; the owner accepts 16 as the nearest correctness target. Not every acceptance criterion is complete. The mandatory next step for root: actual NVIDIA and Intel runtime runs with zero WebGPU validation errors. No GPU, browser, native, visual or 60 fps run happened in this lane; those boxes stay open.
