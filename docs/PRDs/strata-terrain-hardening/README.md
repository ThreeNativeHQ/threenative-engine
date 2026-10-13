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
- [PRD-587 — The terrain editor never drops an edit](../done/PRD-587-the-terrain-editor-never-drops-an-edit.md)
- [PRD-588 — The terrain editor is typed modules, not one 1481-line closure](../done/PRD-588-the-terrain-editor-is-typed-modules.md)
- [PRD-589 — `@threenative/terrain` ships code, not 33 MB of kit data](PRD-589-the-terrain-package-ships-code-not-kit-data.md)
- [PRD-590 — One starter-world source, not five copies](../done/PRD-590-one-starter-world-source-not-five.md)
- [PRD-591 — The preview stops re-implementing engine mechanisms](PRD-591-the-preview-stops-reimplementing-engine-mechanisms.md)
- [PRD-592 — Terrain core fails closed and erodes without allocating](../done/PRD-592-terrain-core-fails-closed-and-erodes-without-allocating.md)
- [PRD-593 — The three.js patch is generated, and the upload lane leaves it](PRD-593-the-three-patch-is-generated-and-the-upload-lane-leaves-it.md)
- [PRD-594 — The engine changes that rode in with #381 get native and visual proof](PRD-594-engine-changes-from-381-get-native-and-visual-proof.md)
- [PRD-595 — `world-cells.ts` splits by seam and survives a load/evict race fuzz](PRD-595-world-cells-splits-by-seam-and-survives-a-race-fuzz.md)

## Execution order

Start with PRD-592 golden bytes and validation, then execute 585, 583, 587, 593, 591, 594, 589, 590, 595, 584 and 588. This order serializes shared-file edits; all phases and acceptance criteria in each PRD remain required. PRD-584 requires 583; 588 export consolidation also requires 583. Coordinate world-cell edits with PRD-473 before changing its shared implementation.

Current baseline: `pnpm build` and `pnpm check:docs` passed; six documentation contract spec files passed (244 tests). No runtime or performance acceptance is established by those checks.

## Current integration state

At merge `159d1ca78`, the batch has 49/62 verified phase boxes (repository bucket `prd:75%`) and 108/132 combined phase/acceptance boxes. PRDs 587, 588, 590 and 592 are complete; all other original requirements remain open. The integration checkout above is retained for this active goal.

Develop integration resolves all six conflicted files, regenerates the Three patches with both morph pipeline sharing and bounded uploads, and fixes removed camera/renderer references through the extracted collaborator. Focused validation passes 261 tests with 4 skips; core typecheck, frozen install and scoped Biome pass. Full CI and remaining runtime/visual acceptance are not established by those checks.

The versioned starter-asset release is now published. A fresh extracted terrain package, without checkout assets or URL overrides, downloads and validates the public 31,598,616-byte archive and extracts 18 entries. PRD-589 stays open pending the scaffolded-game runtime proof against that published archive.

## Look gate (owner decision, 2026-10-11)

The terrain must be AAA quality. Structure, speed and packaging work does not count as progress on the look. The forest kit renders worse than the merged PR #381 canopy (preview example unchanged; kit path differs). [PRD-580](../open-world/PRD-580-strata-starter-kit-art-bar.md) owns the art bar and now runs first for the forest kit, ahead of the remaining acceptance work in this EPIC.

Order, one lane at a time, each ending in a fresh read-only visual judge (headed WebGPU, `--browser-recipe webgpu`, `adapter.info` checked, two runs per arm, same pose as the PR #381 canopy frames, Gaia and AAA reference images attached):

1. Black trees under the starter post chain (stage readout, tree-pixel luminance assertion in the forest walk playtest).
2. Placement: clearings, clumping, density and height variation in `recipe.json`.
3. Lighting and horizon from the kit's own source instead of the starter template defaults.
4. LOD by distance for the near fir (also the 10.8 M triangle cost, PRD-584 AC-4/5).
5. Needle material and colour, cutout edges.

A change that touches trees, ground, lighting or LOD ticks no box without an IMPROVEMENT verdict. The PRD 583 authored-noise ground attempt (REGRESSION) stays out of the tree. Perf wins count only after the judge passes.
