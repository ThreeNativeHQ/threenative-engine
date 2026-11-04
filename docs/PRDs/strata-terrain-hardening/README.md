# Strata terrain hardening

**Status:** IN PROGRESS — 6 of 16 PRDs done. Phase boxes 66/97, acceptance boxes 52/68 (counted with `pnpm prd:progress`, 2026-11-04). Draft EPIC [PR #483](https://github.com/ThreeNativeHQ/threenative-engine/pull/483), label `prd:50%`.

**Delivery decision:** João requested one dedicated EPIC PR for this batch on 2026-10-10, overriding the usual one-PR-per-PRD delivery rule. Each constituent PRD retains its complete scope, phase checkboxes and verification requirements.

## Execution checkout (2026-11-04)

- Active lane: Claude Code forest lane, worktree `/home/joao/projects/threenative/threenative-engine/.worktrees/pr483-sync`, local branch `pr483-sync`, pushed to `epic/strata-terrain-hardening`; target: `develop`.
- Base: `origin/develop` at `33c69249f`, merged on 2026-11-03 (`23fbfd4b1`). The branch is 6 develop commits behind on 2026-11-04.
- The first checkout, `.worktrees/strata-terrain-hardening` (Codex lane, at `5f1dca3b9`), is still on disk. It is not the active lane; inspect its data and merge evidence before removal.

## Scope

| PRD | State | Progress (`prd:progress`) | What is open |
|---|---|---|---|
| [PRD-583 — A Strata world bakes headlessly into an instanced GLB](PRD-583-a-strata-world-bakes-headlessly-into-an-instanced-glb.md) | Partial | `prd:75%` — boxes 6/8, AC 5/5 | Layered PBR surface in the cook; headed render plus visual judge |
| [PRD-584 — An agent asks for a forest over MCP and gets a 60 fps GLB](PRD-584-an-agent-asks-for-a-forest-over-mcp-and-gets-a-60-fps-glb.md) | Partial | `prd:50%` — boxes 4/7, AC 3/5 | p95 ≤ 16.7 ms on web (AC-4) and native desktop (AC-5); contact ceiling BC-2 |
| [PRD-585 — Strata's proof runs in CI, not only by hand](PRD-585-strata-proof-runs-in-ci.md) | Partial | `prd:50%` — boxes 3/6, AC 3/5 | `strata` CI job green on web, consumer and editor scripts; current-head required CI |
| [PRD-587 — The terrain editor never drops an edit](../done/PRD-587-the-terrain-editor-never-drops-an-edit.md) | ✅ Done | `prd:100%` | — |
| [PRD-588 — The terrain editor is typed modules, not one 1481-line closure](../done/PRD-588-the-terrain-editor-is-typed-modules.md) | ✅ Done | `prd:100%` | — |
| [PRD-589 — `@threenative/terrain` ships code, not 33 MB of kit data](../done/PRD-589-the-terrain-package-ships-code-not-kit-data.md) | ✅ Done | `prd:100%` | — |
| [PRD-590 — One starter-world source, not five copies](../done/PRD-590-one-starter-world-source-not-five.md) | ✅ Done | `prd:100%` | — |
| [PRD-591 — The preview stops re-implementing engine mechanisms](PRD-591-the-preview-stops-reimplementing-engine-mechanisms.md) | Partial | `prd:50%` — boxes 3/5, AC 3/5 | `loadTerrainSplat` plumbing and measured height bands (AC-4); five-kit visual judge (AC-5) |
| [PRD-592 — Terrain core fails closed and erodes without allocating](../done/PRD-592-terrain-core-fails-closed-and-erodes-without-allocating.md) | ✅ Done | `prd:100%` | — |
| [PRD-593 — The three.js patch is generated, and the upload lane leaves it](../done/PRD-593-the-three-patch-is-generated-and-the-upload-lane-leaves-it.md) | ✅ Done | `prd:100%` | — |
| [PRD-594 — The engine changes that rode in with #381 get native and visual proof](PRD-594-engine-changes-from-381-get-native-and-visual-proof.md) | Partial | `prd:75%` — boxes 5/6, AC 5/6 | Judge with visible cast-shadow coverage (AC-4) |
| [PRD-595 — `world-cells.ts` splits by seam and survives a load/evict race fuzz](PRD-595-world-cells-splits-by-seam-and-survives-a-race-fuzz.md) | Partial | `prd:50%` — boxes 2/3, AC 2/3 | Strata and machinefall walk playtests after the split (AC-3) |
| [PRD-762 — An MCP-generated terrain runs on the default engine](PRD-762-an-mcp-terrain-runs-on-the-default-engine.md) | In progress | `prd:25%` — boxes 6/14 | Sandbox start with no game edit; sky and kit gaps; playtest, perf and judge |
| [Forest leaf appearance (PRD-584 child)](forest-leaf-alpha.md) | In progress | `prd:50%` — boxes 5/7 | Default forest look kept (AC-4); squared leaf tips (AC-5) |
| [Forest loading handoff waits for the visible world](forest-startup-ux.md) | In progress | `prd:50%` — boxes 2/3 | Same-pose handoff comparison with a visual verdict |
| [PRD-790 — A new biome is a data row, and the world streams past one square](PRD-790-a-new-biome-is-a-data-row-and-the-world-streams-past-one-square.md) | Not started | `prd:0%` — boxes 0/8, AC 0/3 | All (filed 2026-11-04 at the owner's request) |

## Execution order

Done: 592, 587, 593, 589, 590, 588. Remaining, in order: 585, 583, 591, 594, 595, 584 (with its two children: leaf alpha, startup handoff), 762, then 790. This order serializes shared-file edits; all phases and acceptance criteria in each PRD remain required. PRD-584 requires 583. PRD-790 needs PRD-591 AC-4 for its height-band fields. Coordinate world-cell edits with PRD-473 before changing its shared implementation.

## Current state (2026-11-04)

Landed on the branch on 2026-11-03 and 2026-11-04 (forest preview, NVIDIA Turing, private Xvfb unless named):

- ✅ Heightmap generator: fluvial erosion and landform presets in `@threenative/terrain` (`a11d3e6f9`, `c6dfb94e2`); the forest backdrop is a generated fluvial mountain window (`f9252a46f`).
- ✅ Third-person forest walk with the starter mannequin and an orbit camera (`f839e7246`); the camera cuts crowns it swings through (`72cc9311a`).
- ✅ Trees keep their wind, LOD swaps fade, shadows keep one shape, no sight halo (`919c1a866`): judge OVERALL IMPROVEMENT, with one minor REGRESSION open on the reveal frame (nearest spruce flatter and brighter: it self-shadows with the mid-LOD shape at `shadows.minLevel` 1).
- ✅ Forest floor: warm needle-litter soil and olive meadow (`cf7b43e10`): judge IMPROVEMENT. Open gap: soil still brighter than the reference (L 46–51 against 29–37) and the near foreground reads as one smooth dirt sheet.
- ✅ The player stays on the world (`bd789c431`) and climbs the surveyed hills past the square (`167b5a796`; owner confirmed: "i was able to climb"). `edge.playtest.json` asserts `edgeOvershoot` ≥ 20.
- ✅ No pipeline after the reveal: materials that differ only in maps or come from one TSL function share one program (`3a572685d`, `c26d7b791`); `loop.playtest.json` asserts `pipelinesSinceReveal` 0 (`9a4ec2663`). Load 57 s → 27 s → 19.5 s (`ae0185fc0`, `a96ecfb88`).

In flight (owner reports, 2026-11-04): scattered rocks and trunks have no collider; no swimming animation or water physics in the river; the river shows radial streaks and reads as plastic.

Open: `edge.playtest.json` fails on 2 `TN_SCENE_WARNING` lines (shadow draws 896 at 16.9 ms render); load tail, idle JS garbage (296 KB per frame) and a 256-frame present stall (also seen on a plain-canvas control, so the environment is suspected); 60 FPS on the real display is not measured (monitors asleep).

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
