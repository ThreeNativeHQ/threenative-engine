# PRD-862 — The untangle batch's native leftovers

**Status:** NOT STARTED
**Priority:** P2 — the refactor in PR #632 has no native judge verdict, no frame-time A/B, and seven native slice tests still read source as text.
**Complexity:** 5 (MEDIUM)
**Owner:** ThreeNative maintainers
**Depends on:** [PRD-840](../../done/PRD-840-platform-difference-is-a-value.md), [PRD-842](../../done/PRD-842-native-tests-check-behaviour-not-source-text.md)
**Batch:** [Untangle report, 2026-11-06](README.md)

## Context

The owner asked on 2026-11-09 to land PR #632 and "reduce excess AC if necessary". Three items
could not run inside PRD-840 and PRD-842, so they move here with their evidence:

- PRD-840 AC-2, native half: no owned-engine desktop run has a `present-return` window. A live
  run records presents but refuses the window, and a counted run admits it but records no
  presents. The full trace with file and line is in PRD-840 AC-2.
- PRD-840 AC-3: `pnpm bench:engines` stopped at `TN_BENCH_COUNTER_MISSING: report.rungs[1]
  (L1@256) drawCalls is 0`, and the host load made absolutes invalid.
- PRD-842: seven `ui-layer-host-contract` tests slice `ui_overlay.cpp`, `window.cpp` or
  `ui_overlay_ios.mm` by regex (PRD-842, "What still reads source as text", rows marked `open`).
- PRD-842 box 2: `player-host-globals.test.mjs` still reads `.cpp` text, and 22 files that call
  `readFileSync` name `bindings.cpp`, `runtime.cpp` or `browser-renderer.ts`.

## Acceptance Criteria

- [ ] AC-1 [local]: The visual judge returns NEUTRAL or better on the starter on native desktop, the PRD-840 BEFORE `9940d76c6` against its merged AFTER, same pose. proof: judge verdict on this box.
- [ ] AC-2 [local]: The starter frame time does not regress on web or native across the PRD-840 arms. proof: `pnpm bench:engines` paired A/B on a quiet host.
- [ ] AC-3 [local]: Source-text specs remain only for the ABI digest and the four named wire tests of `ui-layer-host-contract`. proof: `rg -l 'readFileSync\([^)]*\.(cpp|mm)' packages/runtime-native/tests packages/three-native/__tests__` lists only the ABI spec and `ui-layer-host-contract`.

## Blocked on

- The owner picks reading (A) or (B) from PRD-840 AC-2 for the owned-engine desktop capture window. Phase 1 starts after that.

## Execution Phases

#### Phase 1: Native starter capture
- [ ] The chosen reading lands, and `verify-starter-desktop.mjs --frames 300` reports more than 0 frames. proof: its playtest report.

#### Phase 2: Frame-time A/B
- [ ] `bench:engines` reports a nonzero `drawCalls` at L1@256 on the web arm. proof: `pnpm bench:engines --arm tn-engine-web --modes L1 --ladder 256`.

#### Phase 3: Slice tests become behaviour checks
- [ ] The four Linux slices (keyboard routing, gestures outside the window, keyboard ownership, CSS scroll traces) run against header seams. proof: `pnpm exec vitest run tests/ui-layer-host-contract.test.mjs` in `packages/runtime-native`.
- [ ] The three iOS rows (detach order, MRC overlay link, scheme paths) get a macOS lane check or a recorded decision. proof: the `build-ios-simulator` job.
- [ ] `player-host-globals` and the specs on `bindings.cpp`, `runtime.cpp` and `browser-renderer.ts` become behaviour checks, or are deleted where a behaviour test covers them. proof: AC-3.
