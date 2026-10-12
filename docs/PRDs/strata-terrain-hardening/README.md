# Strata terrain hardening

**Status:** IN PROGRESS — dedicated EPIC execution; all constituent proof boxes remain authoritative.

**Delivery decision:** João requested one dedicated EPIC PR for this batch on 2026-10-10, overriding the usual one-PR-per-PRD delivery rule. Each constituent PRD retains its complete scope, phase checkboxes and verification requirements.

## Execution checkout

- Owner: Codex active terrain-hardening goal.
- Worktree: `/home/joao/projects/threenative/threenative-engine/.worktrees/strata-terrain-hardening`.
- Branch: `epic/strata-terrain-hardening`; target: `develop`.
- Draft EPIC: [PR #483](https://github.com/ThreeNativeHQ/threenative-engine/pull/483).
- Base: `origin/develop` at `2d212479255cf725f64343dc72aa2eafe9b7b92d`.
- Cleanup: retained while implementation and review are active; inspect data and merge evidence before ordinary worktree removal.

## Scope

- [PRD-583 — A Strata world bakes headlessly into an instanced GLB](PRD-583-a-strata-world-bakes-headlessly-into-an-instanced-glb.md)
- [PRD-584 — An agent asks for a forest over MCP and gets a 60 fps GLB](PRD-584-an-agent-asks-for-a-forest-over-mcp-and-gets-a-60-fps-glb.md)
- [PRD-585 — Strata's proof runs in CI, not only by hand](PRD-585-strata-proof-runs-in-ci.md)
- [PRD-587 — The terrain editor never drops an edit](PRD-587-the-terrain-editor-never-drops-an-edit.md)
- [PRD-588 — The terrain editor is typed modules, not one 1481-line closure](PRD-588-the-terrain-editor-is-typed-modules.md)
- [PRD-589 — `@threenative/terrain` ships code, not 33 MB of kit data](PRD-589-the-terrain-package-ships-code-not-kit-data.md)
- [PRD-590 — One starter-world source, not five copies](../done/PRD-590-one-starter-world-source-not-five.md)
- [PRD-591 — The preview stops re-implementing engine mechanisms](PRD-591-the-preview-stops-reimplementing-engine-mechanisms.md)
- [PRD-592 — Terrain core fails closed and erodes without allocating](PRD-592-terrain-core-fails-closed-and-erodes-without-allocating.md)
- [PRD-593 — The three.js patch is generated, and the upload lane leaves it](PRD-593-the-three-patch-is-generated-and-the-upload-lane-leaves-it.md)
- [PRD-594 — The engine changes that rode in with #381 get native and visual proof](PRD-594-engine-changes-from-381-get-native-and-visual-proof.md)
- [PRD-595 — `world-cells.ts` splits by seam and survives a load/evict race fuzz](PRD-595-world-cells-splits-by-seam-and-survives-a-race-fuzz.md)

## Execution order

Start with PRD-592 golden bytes and validation, then execute 585, 583, 587, 593, 591, 594, 589, 590, 595, 584 and 588. This order serializes shared-file edits; all phases and acceptance criteria in each PRD remain required. PRD-584 requires 583; 588 export consolidation also requires 583. Coordinate world-cell edits with PRD-473 before changing its shared implementation.

Current baseline: `pnpm build` and `pnpm check:docs` passed; six documentation contract spec files passed (244 tests). No runtime or performance acceptance is established by those checks.

## Active worker checkouts

PRD-592 validation and golden bytes are integrated at `6c40d8757`; its validation candidate passes 39 focused tests and preserves all 21 forest files, but the latest prescribed same-host timing reaches only 22.55% on a busy host, so the 30% target remains open. PRD-585 local coverage and the scaffold package-manager pin are integrated; 68 scaffold tests pass, while real CI and runtime acceptance remain open. PRD-583 forest cook, alternate LODs and both isolated-install dependency closures are integrated through `38c83ef48`; parent assets build and 17 cook tests pass, and the unskipped packed-game consumer passes on NVIDIA Turing; layered-material visual proof remains pending. PRD-587 server recovery is integrated at `5b8fbfa60`; its corrected queue is integrated locally and passes 45 focused tests, with UI and worker proofs open. PRD-593 owns the reused proof checkout; its corrected pinned-source generator passes 33 focused tests, while actual patch regeneration and all 31 predecessor compatibility checks remain in progress. The active owner checkouts remain `.worktrees/strata-terrain-bake`, `.worktrees/strata-editor-durability` and `.worktrees/strata-terrain-proof`; cleanup follows owner release and tracked, untracked and ignored-data checks. Codex coordinates this entire batch through PR #483.

## Look gate (owner decision, 2026-10-11)

The terrain must be AAA quality. Structure, speed and packaging work does not count as progress on the look. The forest kit renders worse than the merged PR #381 canopy (preview example unchanged; kit path differs). [PRD-580](../open-world/PRD-580-strata-starter-kit-art-bar.md) owns the art bar and now runs first for the forest kit, ahead of the remaining acceptance work in this EPIC.

Order, one lane at a time, each ending in a fresh read-only visual judge (headed WebGPU, `--browser-recipe webgpu`, `adapter.info` checked, two runs per arm, same pose as the PR #381 canopy frames, Gaia and AAA reference images attached):

1. Black trees under the starter post chain (stage readout, tree-pixel luminance assertion in the forest walk playtest).
2. Placement: clearings, clumping, density and height variation in `recipe.json`.
3. Lighting and horizon from the kit's own source instead of the starter template defaults.
4. LOD by distance for the near fir (also the 10.8 M triangle cost, PRD-584 AC-4/5).
5. Needle material and colour, cutout edges.

A change that touches trees, ground, lighting or LOD ticks no box without an IMPROVEMENT verdict. The PRD 583 authored-noise ground attempt (REGRESSION) stays out of the tree. Perf wins count only after the judge passes.
