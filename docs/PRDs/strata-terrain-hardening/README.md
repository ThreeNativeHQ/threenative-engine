# Strata terrain hardening

**Status:** MERGED — PR [#483](https://github.com/ThreeNativeHQ/threenative-engine/pull/483) squash-merged into `develop` as `972d1e371` on 2026-11-06. Six of the batch's PRDs are done. The open work runs in the order in [PR-CHAIN.md](PR-CHAIN.md), which is the live plan for this batch. The 13 open PRDs in this folder measure 36/88 phase boxes and 21/38 acceptance boxes with `pnpm prd:progress` on 2026-11-07.

**Delivery decision:** João requested one dedicated EPIC PR for this batch on 2026-10-10, overriding the usual one-PR-per-PRD delivery rule. Each constituent PRD retains its complete scope, phase checkboxes and verification requirements.

## Merge state (2026-11-07)

- ✅ The EPIC is merged. PR #483 squash-merged into `develop` as `972d1e371` on 2026-11-06. The tree of `972d1e371` equals the tree of `origin/epic/strata-terrain-hardening` at `1b0de354b`.
- Open work follows [PR-CHAIN.md](PR-CHAIN.md). The chain runs in one draft PR, [#635](https://github.com/ThreeNativeHQ/threenative-engine/pull/635), from the worktree `.claude/worktrees/strata-chain`. Step 0 holds the PRD-806 fixes, this README refresh and the stale worktree cleanup.
- The branch `origin/epic/strata-terrain-hardening` stays as history. Do not merge it again.
- The lane worktrees are still on disk: `strata-base`, `strata-forest`, `strata-ground-fix`, `strata-ref-mrt`, `strata-ref-play` and `strata-ref-walk`. Each of the six has a clean `git status`. The first checkout `.worktrees/strata-terrain-hardening` (Codex lane, at `5f1dca3b9`) is also on disk, and this refresh did not inspect it.
- ⚠️ `.worktrees/strata-forest` holds 19 commits that `develop` does not contain: the layered MRT targets, the impostor ambient-occlusion atlas and the alpha-to-coverage mask. Inspect that worktree before removal.

## Scope

Ordered by priority (the `**Priority:**` header of each PRD), then by the chain step in [PR-CHAIN.md](PR-CHAIN.md). Done PRDs are last. The State column quotes each PRD's `**Status:**` line.

| Priority | PRD | State | Progress (`prd:progress`) | What is open |
|---|---|---|---|---|
| P0 | [PRD-762 — An MCP-generated terrain runs on the default engine](PRD-762-an-mcp-terrain-runs-on-the-default-engine.md) | IN PROGRESS | `prd:50%` — boxes 11/16 | Sandbox start with no game edit. Sky and kit gaps. Playtest, perf and judge. Chain step PR-1. |
| P1 | [PRD-858 — World impostors bake on the owned web engine](PRD-858-world-impostors-bake-on-the-owned-web-engine.md) | OPEN | `prd:0%` — boxes 0/6 | Layered MRT bake seam on the facade and engine. Kit overview at 60 fps. Judge. Blocks PRD-762's kit verifier. |
| P1 | [PRD-585 — Strata's proof runs in CI, not only by hand](PRD-585-strata-proof-runs-in-ci.md) | PARTIAL | `prd:50%` — boxes 3/6, AC 3/5 | `strata` CI job green on web, consumer and editor scripts. Current-head required CI. Chain step PR-2. |
| P1 | [PRD-583 — A Strata world bakes headlessly into an instanced GLB](PRD-583-a-strata-world-bakes-headlessly-into-an-instanced-glb.md) | PARTIAL | `prd:75%` — boxes 6/8, AC 5/5 | Layered PBR surface in the cook. Headed render plus visual judge. Chain step PR-8. |
| P1 | [PRD-594 — The engine changes that rode in with #381 get native and visual proof](PRD-594-engine-changes-from-381-get-native-and-visual-proof.md) | PARTIAL | `prd:75%` — boxes 5/6, AC 5/6 | Judge with visible cast-shadow coverage (AC-4). Chain step PR-9. |
| P1 | [PRD-584 — An agent asks for a forest over MCP and gets a 60 fps GLB](PRD-584-an-agent-asks-for-a-forest-over-mcp-and-gets-a-60-fps-glb.md) | PARTIAL | `prd:50%` — boxes 4/7, AC 3/5 | p95 ≤ 16.7 ms on web (AC-4) and native desktop (AC-5). Contact ceiling BC-2. Chain step PR-10. |
| P1 | [Forest leaf appearance (PRD-584 child)](forest-leaf-alpha.md) | IN PROGRESS — source/cooked alpha and published budget verified; user still observes squared leaf tips, so final leaf appearance and default-scene preservation remain open | `prd:50%` — boxes 5/7 | Default forest look kept (AC-4). Squared leaf tips (AC-5). Chain step PR-10. |
| P1 | [Forest loading handoff waits for the visible world](forest-startup-ux.md) | IN PROGRESS | `prd:50%` — boxes 2/3 | Same-pose handoff comparison with a visual verdict. Chain step PR-10. |
| P1 | [PRD-854 — One terrain request decides the landform, water, size and a real survey](../done/PRD-854-one-terrain-request-decides-the-landform-water-size-and-survey.md) | DONE | `prd:100%` — boxes 7/7, AC 2/2 | All. The request words pick the landform, the water and the size (Phase 1). Chain step PR-5. |
| P1 | [PRD-855 — The ground vegetation reads like a real forest floor](PRD-855-the-ground-vegetation-reads-like-a-real-forest-floor.md) | NOT STARTED | `prd:0%` — boxes 0/7, AC 0/2 | All. Soil L 46–51 against the 29–37 reference, and no cover at walking height (Phases 2 and 3). Chain step PR-6. |
| P2 | [PRD-591 — The preview stops re-implementing engine mechanisms](PRD-591-the-preview-stops-reimplementing-engine-mechanisms.md) | PARTIAL | `prd:50%` — boxes 3/5, AC 3/5 | `loadTerrainSplat` plumbing and measured height bands (AC-4). Five-kit visual judge (AC-5). Chain step PR-4. |
| P2 | [PRD-595 — `world-cells.ts` splits by seam and survives a load/evict race fuzz](PRD-595-world-cells-splits-by-seam-and-survives-a-race-fuzz.md) | PARTIAL | `prd:50%` — boxes 2/3, AC 2/3 | Strata and machinefall walk playtests after the split (AC-3). Chain step 3. |
| P2 | [PRD-790 — A new biome is a data row, and the world streams past one square](PRD-790-a-new-biome-is-a-data-row-and-the-world-streams-past-one-square.md) | NOT STARTED | `prd:0%` — boxes 0/8, AC 0/3 | All. Filed 2026-11-04 at the owner's request. Chain step PR-11. |
| P2 | [PRD-856 — The mountains carry real silhouettes, erosion and rock](PRD-856-the-mountains-carry-real-silhouettes-erosion-and-rock.md) | NOT STARTED | `prd:0%` — boxes 0/7, AC 0/2 | All. Phase 1 names the defects first. Chain step PR-7. |
| P2 | [PRD-870 — The procedural forest set reads like the Fab set](PRD-870-the-procedural-forest-set-reads-like-the-fab-set.md) | NOT STARTED | `prd:0%` — boxes 0/6, AC 0/2 | All. Phase 1 measures the gap with `?fab=off` against the licensed set. |
| P2 | [PRD-806 — Fix the medium and low findings of the PR #483 epic review](../done/PRD-806-epic-review-medium-and-low-findings.md) | DONE | `prd:100%` — boxes 9/9, AC 1/1 | Closed 2026-11-09 on PR #635. |

PRD-806 lives in `docs/PRDs/refactoring/strata-refactoring/`. Its status line reads, verbatim, with its relative link resolved from this folder: **Status:** PARTIAL — 4 of 8 Phase 1 and 2 boxes are fixed (lane B, 2026-11-05). Open: E46, E49, E73 and E56/E62 (visual judge or native build), and the 45 low findings (lane C running). Scope: the 14 medium findings (13 after one duplicate) and 45 low findings verified on HEAD `21c713b7d` on 2026-11-05. The high findings are in [PRD-805](../done/PRD-805-epic-review-findings.md). No fix has started.
| — | [PRD-592 — Terrain core fails closed and erodes without allocating](../done/PRD-592-terrain-core-fails-closed-and-erodes-without-allocating.md) | ✅ Done | `prd:100%` | — |
| — | [PRD-587 — The terrain editor never drops an edit](../done/PRD-587-the-terrain-editor-never-drops-an-edit.md) | ✅ Done | `prd:100%` | — |
| — | [PRD-593 — The three.js patch is generated, and the upload lane leaves it](../done/PRD-593-the-three-patch-is-generated-and-the-upload-lane-leaves-it.md) | ✅ Done | `prd:100%` | — |
| — | [PRD-589 — `@threenative/terrain` ships code, not 33 MB of kit data](../done/PRD-589-the-terrain-package-ships-code-not-kit-data.md) | ✅ Done | `prd:100%` | — |
| — | [PRD-590 — One starter-world source, not five copies](../done/PRD-590-one-starter-world-source-not-five.md) | ✅ Done | `prd:100%` | — |
| — | [PRD-588 — The terrain editor is typed modules, not one 1481-line closure](../done/PRD-588-the-terrain-editor-is-typed-modules.md) | ✅ Done | `prd:100%` | — |

## Execution order

The open work runs in the order in [PR-CHAIN.md](PR-CHAIN.md). That file is the live plan. It holds Step 0 and PR-1 to PR-12, the 2026-11-07 spike results and the two-lane split. The earlier priority order no longer governs.

Done, in landing order: 592, 587, 593, 589, 590, 588. All phases and acceptance criteria in each PRD remain required. Coordinate world-cell edits with PRD-473 before changing its shared implementation.

## Current state (2026-11-07)

✅ The EPIC is merged. PR #483 squash-merged into `develop` as `972d1e371` on 2026-11-06. The merge carries every commit of `origin/epic/strata-terrain-hardening` at `1b0de354b`.

The merge closed no PRD box on its own. The table above measures the open work on 2026-11-07. [PR-CHAIN.md](PR-CHAIN.md) holds the order for that work.

One item needs a decision before the worktree cleanup in Step 0: `.worktrees/strata-forest` holds 19 commits that `develop` does not contain. The reports below stay open until a current-head run closes them.

### Last pre-merge state (2026-11-04)

Landed on the EPIC branch on 2026-11-03 and 2026-11-04 (forest preview, NVIDIA Turing, private Xvfb unless named):

- ✅ Heightmap generator: fluvial erosion and landform presets in `@threenative/terrain` (`a11d3e6f9`, `c6dfb94e2`); the forest backdrop is a generated fluvial mountain window (`f9252a46f`).
- ✅ Third-person forest walk with the starter mannequin and an orbit camera (`f839e7246`); the camera cuts crowns it swings through (`72cc9311a`).
- ✅ Trees keep their wind, LOD swaps fade, shadows keep one shape, no sight halo (`919c1a866`): judge OVERALL IMPROVEMENT, with one minor REGRESSION open on the reveal frame (nearest spruce flatter and brighter: it self-shadows with the mid-LOD shape at `shadows.minLevel` 1).
- ✅ Forest floor: warm needle-litter soil and olive meadow (`cf7b43e10`): judge IMPROVEMENT. Open gap: soil still brighter than the reference (L 46–51 against 29–37) and the near foreground reads as one smooth dirt sheet.
- ✅ The player stays on the world (`bd789c431`) and climbs the surveyed hills past the square (`167b5a796`; owner confirmed: "i was able to climb"). `edge.playtest.json` asserts `edgeOvershoot` ≥ 20.
- ✅ No pipeline after the reveal: materials that differ only in maps or come from one TSL function share one program (`3a572685d`, `c26d7b791`); `loop.playtest.json` asserts `pipelinesSinceReveal` 0 (`9a4ec2663`). Load 57 s → 27 s → 19.5 s (`ae0185fc0`, `a96ecfb88`).

Open work outside the PRD boxes, in priority order:

1. In flight (owner reports, 2026-11-04): scattered rocks and trunks have no collider.
2. In flight: no swimming animation or water physics in the river.
3. In flight: the river shows radial streaks and reads as plastic.
4. `edge.playtest.json` fails on 2 `TN_SCENE_WARNING` lines (shadow draws 896 at 16.9 ms render).
5. The reveal-frame REGRESSION from `919c1a866`: the nearest spruce self-shadows with its mid-LOD shape.
6. Performance: load tail, idle JS garbage (296 KB per frame), and a 256-frame present stall (also seen on a plain-canvas control, so the environment is suspected).
7. Ground: soil value still above the reference, and no needle detail in the near foreground.
8. 60 FPS on the real display is not measured (monitors asleep).

## Look gate (owner decision, 2026-10-11)

The terrain must be AAA quality. Structure, speed and packaging work does not count as progress on the look. The forest kit renders worse than the merged PR #381 canopy (preview example unchanged; kit path differs). [PRD-580](../open-world/PRD-580-strata-starter-kit-art-bar.md) owns the art bar and now runs first for the forest kit, ahead of the remaining acceptance work in this EPIC.

Order, one lane at a time, each ending in a fresh read-only visual judge (headed WebGPU, `--browser-recipe webgpu`, `adapter.info` checked, two runs per arm, same pose as the PR #381 canopy frames, Gaia and AAA reference images attached):

1. Black trees under the starter post chain (stage readout, tree-pixel luminance assertion in the forest walk playtest).
2. Placement: clearings, clumping, density and height variation in `recipe.json`.
3. Lighting and horizon from the kit's own source instead of the starter template defaults.
4. LOD by distance for the near fir (also the 10.8 M triangle cost, PRD-584 AC-4/5).
5. Needle material and colour, cutout edges.

Progress on 2026-11-04 is for the preview example, not the kit (the kit's art bar lives in PRD-580). Step 4: the LOD swaps fade (`919c1a866`, judge IMPROVEMENT, one reveal-frame REGRESSION open). Ground, outside the five steps: `cf7b43e10`, judge IMPROVEMENT. This README records no verdict for steps 1, 2, 3 and 5.

A change that touches trees, ground, lighting or LOD ticks no box without an IMPROVEMENT verdict. The PRD 583 authored-noise ground attempt (REGRESSION) stays out of the tree. Perf wins count only after the judge passes.

## History

Current baseline (2026-10-13): `pnpm build` and `pnpm check:docs` passed; six documentation contract spec files passed (244 tests). No runtime or performance acceptance is established by those checks.

### 2026-10-13/14 integration state

The batch has 51/62 verified phase boxes (repository bucket `prd:75%`) and 112/132 combined phase/acceptance boxes. PRDs 587, 588, 589, 590 and 592 are complete; all other original requirements remain open. The integration checkout above is retained for this active goal.

Develop integration resolves all six conflicted files, regenerates the Three patches with both morph pipeline sharing and bounded uploads, and fixes removed camera/renderer references through the extracted collaborator. Focused validation passes 261 tests with 4 skips; core typecheck, frozen install and scoped Biome pass. Full CI and remaining runtime/visual acceptance are not established by those checks.

The versioned starter-asset release is now published. A fresh extracted terrain package, without checkout assets or URL overrides, downloads and validates the public 31,598,616-byte archive and extracts 18 entries. A fresh-cache scaffolded forest now passes the published-archive runtime gate (819 frames, NVIDIA/Turing); PRD-589 is complete and archived.

2026-10-13 integration: `fef436694` merges develop `5f7143895` (PRD-609). The only conflict was the scaffold fingerprint table; all thirteen actual trees were measured, with only action-rpg changing. Scaffold and CI attempt-receipt specs pass 92/92. Laptop typecheck and lint pass after rebuilding core declarations. The real-display NVIDIA forest walk still fails its 16.7 ms gate (p95 98.7 ms, 71 timing samples); the follow-up trace diagnoses CPU and first-use compilation cost without claiming steady FPS. The standard V8 host, all V8 contract targets and the QuickJS cross-engine targets now build. Native package tests pass 1,586 with 62 skips; the six previously failing files pass 72 with one skip. A shared starter-archive fixture leaked its beforeAll directory; immediate try/finally cleanup fixes the monitored package-test guard (1 → 1 directories), with the full package-test phase exiting 0. The socket probe subsequently reproduced ECONNRESET from the test ClientRequest: the helper returned after its 413 response while a 10 MiB chunked upload remained in flight. Cancelling the remaining upload and waiting for request close passes twelve consecutive instrumented runs (216 assertions), without a reset or unhandled error. The final full unit phase passes 798 files and 10,636 tests, with 20 skips and temporary directories stable at 1 → 1. It ran with four available CPUs (three existing Vitest workers), avoiding the 60-second build-exit timeout seen under heavy unrestricted concurrency; no timeout or assertion changed. Updated full typecheck/lint, all 317 terrain package tests, frozen install and strict package validation pass. Hosted CI and the remaining runtime/performance criteria stay open.

2026-10-14 upstream integration: at the owner's request, fetched and merged `origin/develop` at `99aeb6e30` (PRD-568 / #488, mobile GPU-ready ASTC textures) into this branch as `6db7012e4`. The sole conflict in `packages/assets/src/passes/lightmap.ts` preserves both this branch's asynchronous static bake and the upstream ASTC encoder argument. The focused lightmap/texture/model-texture/core-assets suites pass 198 tests with 1 skipped; assets and core typechecks and scoped Biome pass. Earlier terrain morph/LOD, cached shadow-page, first-frame GPU tier and height-fog work is already in the branch's ancestry. Fresh installed-consumer package freshness and full CI remain to be verified; source ancestry alone is not runtime proof. The owner also reports a close/far tree silhouette change and rejects lighting, shadows and atmosphere. Opus 5.5 high has reproduced a trunk LOD silhouette error substantially larger than the stored error and is implementing the repair; no visual or performance acceptance is claimed.
