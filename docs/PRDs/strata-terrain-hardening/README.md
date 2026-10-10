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
- [PRD-590 — One starter-world source, not five copies](PRD-590-one-starter-world-source-not-five.md)
- [PRD-591 — The preview stops re-implementing engine mechanisms](PRD-591-the-preview-stops-reimplementing-engine-mechanisms.md)
- [PRD-592 — Terrain core fails closed and erodes without allocating](PRD-592-terrain-core-fails-closed-and-erodes-without-allocating.md)
- [PRD-593 — The three.js patch is generated, and the upload lane leaves it](PRD-593-the-three-patch-is-generated-and-the-upload-lane-leaves-it.md)
- [PRD-594 — The engine changes that rode in with #381 get native and visual proof](PRD-594-engine-changes-from-381-get-native-and-visual-proof.md)
- [PRD-595 — `world-cells.ts` splits by seam and survives a load/evict race fuzz](PRD-595-world-cells-splits-by-seam-and-survives-a-race-fuzz.md)

## Execution order

Start with PRD-592 golden bytes and validation, then execute 585, 583, 587, 593, 591, 594, 589, 590, 595, 584 and 588. This order serializes shared-file edits; all phases and acceptance criteria in each PRD remain required. PRD-584 requires 583; 588 export consolidation also requires 583. Coordinate world-cell edits with PRD-473 before changing its shared implementation.

Current baseline: `pnpm build` and `pnpm check:docs` passed; six documentation contract spec files passed (244 tests). No runtime or performance acceptance is established by those checks.

## Active worker checkouts

PRD-592 phase 1 is committed at `6c40d8757`; phase 2 remains open pending the 30% speed proof. Its worker watches the queued quiet benchmark and has released the EPIC index for integration. PRD-585 owns `/home/joao/projects/threenative/threenative-engine/.worktrees/strata-terrain-proof`, branch `epic/strata-terrain-proof`, based on `227cb944b`; its integration test passes, with census repair and CI wiring in progress. PRD-583 owns `/home/joao/projects/threenative/threenative-engine/.worktrees/strata-terrain-bake`, branch `epic/strata-terrain-bake`, based on `9e7a8cab0`, for headless GLB baking. Codex coordinates integration into PR #483. Coding arms share a provider lock. Cleanup must inspect ignored data and confirm each owner has stopped after integration.
