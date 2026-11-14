# PRD-805 — Fix the 8 high findings of the PR #483 epic review

**Closed:** 2026-11-05 at `a5d21f9d3`, archived to `done/`.

**Status:** DONE — 2026-11-05. Every phase and acceptance box verified.
**Priority:** P1 — each open finding below makes the board red or a launch fail at HEAD
**Complexity:** 3 (LOW); 8 small fixes in independent files
**Owner:** ThreeNative maintainers

## Problem

A multi-agent review of the PR #483 epic diff reported 76 findings. A second pass checked each one on HEAD `21c713b7d`, by a code trace or by one spec run. The per-finding facts, the cited `file:line` and a one-line fix sketch are in [the evidence file](strata-refactoring/PRD-805-epic-review-findings.evidence.md). The verifier was a DeepSeek arm, so read each cited line before you fix it. Name the layer first: engine (`packages/`) or game (`examples/`).

## Execution Phases

#### Phase 1: Specs that are red at HEAD

- [x] E08: four history-reuse tests fail (the three 0.187 upgrade dropped the 0.185.1 reuse hunk). proof: `pnpm exec vitest run packages/core/__tests__/instance-velocity-upload.spec.ts` — FIXED 2026-11-05 in `01ba312cb` (DeepSeek arm, reviewed): red at `b1e89ac2a`, green after. The restored hunk is in `packages/core/patches/three@0.187.0.patch`; `pnpm-lock.yaml` carries the new patch hash and `pnpm install --frozen-lockfile` exits 0.
- [x] E36: the arena-shadow test fails. proof: `pnpm exec vitest run packages/create-threenative/__tests__/looks.spec.ts` — FIXED 2026-11-05 in `aa1bbe99b` (DeepSeek arm, reviewed): red at `b1e89ac2a`, green after. The test was wrong: the shadow node inserts a level wherever a step is wider than 2x, so the test now pins the authored windows, a step of at most 2x and the map sizes.
- [x] E69: `READY_ANCHOR` matches nothing, so 6 of 8 tests fail. proof: `pnpm exec vitest run scripts/__tests__/verify-forest-playtest.spec.ts` — FIXED 2026-11-05 in `124fb7a24` (DeepSeek arm, reviewed): red at `b1e89ac2a`, green after.
- [x] E70: the fixture copies a file that does not exist. proof: `pnpm exec vitest run scripts/__tests__/prepare-release.spec.ts` — FIXED 2026-11-05 in `189901f88` (DeepSeek arm, reviewed): red at `b1e89ac2a`, green after.
- [x] E71: the snapshot lacks `terrain_biome_new`. proof: `pnpm exec vitest run scripts/__tests__/mcp-tool-schemas.spec.ts` — FIXED 2026-11-05 in `ff09fcce4` (DeepSeek arm, reviewed): red at `b1e89ac2a`, green after.
- [x] E72: six new example files are undocumented. proof: `pnpm exec vitest run scripts/__tests__/strata-script-census.spec.ts` — FIXED 2026-11-05 in `a77985f05` (DeepSeek arm, reviewed): red at `b1e89ac2a`, green after.

#### Phase 2: Behaviour regressions

- [x] E21 `packages/core/src/warmup.ts:1245`: a rejected compile fails a held launch through `pendingCompiles`. proof: a red-green spec in `packages/core/__tests__/` that rejects one compile — FIXED 2026-11-05 in `b3fee97d7` (DeepSeek arm, reviewed): red at `b1e89ac2a`, green after.
- [x] E64 `scripts/verify-strata-startup.ts:414`: the startup gate compares against a baseline with a different devDependency set, so it always throws. proof: a red-green spec in `scripts/__tests__/` — FIXED 2026-11-05 in `a5d21f9d3` (DeepSeek arm, reviewed): red at `b1e89ac2a`, green after. The gate keeps every baseline devDependency pinned and accepts only 3 named additions (`@threenative/runtime-native`, `create-threenative`, `tsx`); any other change still fails.

## Acceptance Criteria

- [x] AC-1: `pnpm typecheck` and `pnpm lint` exit 0 after the fixes. proof: command output in the box — 2026-11-05 after the 8 fixes: `pnpm typecheck` exit 0, `pnpm lint` exit 0, the 9 touched spec files 155 of 155 pass.
