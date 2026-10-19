# PRD-478 — Keep adaptive shadow refresh on a fixed texel grid

**Status:** DONE
**Complexity:** 3 (LOW); risk override: none
**Owner:** Codex, requested by João
**Progress:** 2/2 phases

## Context

`DirectionalClipmap.updateCenter` multiplies its snapping grid by `refreshPages`.
Changing `setRefreshStep` therefore moves stationary windows, and
`VirtualShadowNode.updateBefore` treats those origins as movement requiring a render.
Red reproduced with the new stationary-window spec: step 0.164 produced `moved: 1`,
`rendered: 1`, `rendersTotal: 3` instead of 0, 0, 2 (exit 1).

## Solution

Keep origins on each level's fixed page/texel grid. Retain the previous window until
the followed centre moves beyond that level's refresh threshold; changing the threshold
alone never moves a stationary window. Preserve zero-step addressing and the selection margin.
Reserve one texel inside a nonzero threshold for a render deferred behind a finer level.
Integration is unchanged: `VirtualShadowNode.updateBefore` calls `DirectionalClipmap.updateCenter`.

## Acceptance criteria

- [x] AC-1 [local, Codex]: Stationary step changes cause no origin movement or level renders. proof: `pnpm exec vitest run packages/core/__tests__/virtual-shadow.spec.ts packages/core/__tests__/virtual-shadow-pages.spec.ts packages/core/__tests__/virtual-shadow-caster-draws.spec.ts --maxWorkers=2` — 95 passed, exit 0.

## Execution Phases

### Phase 1: Stable origins and refresh hysteresis

- [x] AC-2 [local, Codex]: Step plus one texel causes a render, with all origins grid aligned and per-level thresholds preserved. proof: same focused specs — passed, exit 0.
- [x] AC-3 [local, Codex]: Existing virtual-shadow specs preserve zero-step and selection-margin behavior unchanged. proof: same focused specs — passed without changing existing assertions.

### Phase 2: Required gates and local commit

- [x] AC-4 [local, Codex]: Core specs pass. proof: `pnpm exec vitest run packages/core --maxWorkers=2` — 176 files passed; 2263 tests passed, 2 skipped; exit 0.
- [x] AC-5 [local, Codex]: Types pass. proof: `pnpm typecheck` — exit 0 after building assets/physics/UI declarations, workspace concurrency 2.
- [x] AC-6 [local, Codex]: Lint has zero errors. proof: `pnpm lint` — exit 0, 0 errors, 1017 warnings.
- [x] AC-7 [local, Codex]: Quality exits zero. proof: `pnpm quality` — exit 0; advisory findings reported.

## Decisions

- 2026-10-02 (João): Work only in this checkout, commit locally, no pushes, merges or browser playtests; browser ablation runs separately.
