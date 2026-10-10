# Strata terrain hardening

**Status:** IN PROGRESS — dedicated EPIC execution; all constituent proof boxes remain authoritative.

**Delivery decision:** João requested one dedicated EPIC PR for this batch on 2026-10-10, overriding the usual one-PR-per-PRD delivery rule. Each constituent PRD retains its complete scope, phase checkboxes and verification requirements.

## Execution checkout

- Owner: Codex active terrain-hardening goal.
- Worktree: `/home/joao/projects/threenative/threenative-engine/.worktrees/strata-terrain-hardening`.
- Branch: `epic/strata-terrain-hardening`; target: `develop`.
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
