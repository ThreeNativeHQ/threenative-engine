# PRD-805 — Fix the 8 high findings of the PR #483 epic review

**Status:** PROPOSED — 76 review findings were verified on HEAD `21c713b7d` on 2026-11-05: 67 REAL (8 high, 14 medium, 45 low) and 9 NOT-REAL. This PRD holds the 8 high findings. [PRD-806](PRD-806-epic-review-medium-and-low-findings.md) holds the rest. No fix has started.
**Priority:** P1 — each open finding below makes the board red or a launch fail at HEAD
**Complexity:** 3 (LOW); 8 small fixes in independent files
**Owner:** ThreeNative maintainers

## Problem

A multi-agent review of the PR #483 epic diff reported 76 findings. A second pass checked each one on HEAD `21c713b7d`, by a code trace or by one spec run. The per-finding facts, the cited `file:line` and a one-line fix sketch are in [the evidence file](PRD-805-epic-review-findings.evidence.md). The verifier was a DeepSeek arm, so read each cited line before you fix it. Name the layer first: engine (`packages/`) or game (`examples/`).

## Execution Phases

#### Phase 1: Specs that are red at HEAD

- [ ] E08: four history-reuse tests fail (the three 0.187 upgrade dropped the 0.185.1 reuse hunk). proof: `pnpm exec vitest run packages/core/__tests__/instance-velocity-upload.spec.ts`
- [ ] E36: the arena-shadow test fails. proof: `pnpm exec vitest run packages/create-threenative/__tests__/looks.spec.ts`
- [ ] E69: `READY_ANCHOR` matches nothing, so 6 of 8 tests fail. proof: `pnpm exec vitest run scripts/__tests__/verify-forest-playtest.spec.ts`
- [ ] E70: the fixture copies a file that does not exist. proof: `pnpm exec vitest run scripts/__tests__/prepare-release.spec.ts`
- [ ] E71: the snapshot lacks `terrain_biome_new`. proof: `pnpm exec vitest run scripts/__tests__/mcp-tool-schemas.spec.ts`
- [ ] E72: six new example files are undocumented. proof: `pnpm exec vitest run scripts/__tests__/strata-script-census.spec.ts`

#### Phase 2: Behaviour regressions

- [ ] E21 `packages/core/src/warmup.ts:1245`: a rejected compile fails a held launch through `pendingCompiles`. proof: a red-green spec in `packages/core/__tests__/` that rejects one compile
- [ ] E64 `scripts/verify-strata-startup.ts:414`: the startup gate compares against a baseline with a different devDependency set, so it always throws. proof: a red-green spec in `scripts/__tests__/`

## Acceptance Criteria

- [ ] AC-1: `pnpm typecheck` and `pnpm lint` exit 0 after the fixes. proof: command output in the box
