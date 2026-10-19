---
prd_contract: v1
---

# PRD-202 — Runner lanes share one implementation

**Status:** NOT STARTED

**Priority:** P1 — Device and browser lanes still compute different path lengths for one walk.
**Complexity:** +2 for 6–10 files, +2 for multi-platform correctness (browser vs device),
+1 for splitting a grab-bag module, +1 divergent-math fix = **6 → MEDIUM mode**.

## Context

Scan finding #8 (high, and a correctness bug): the device runner duplicates six
browser-path helpers (`androidRunner.ts:592-668` vs `steps.ts:218-242,664-709`) and two
have already diverged — worst, `accumulatedPathLength` uses `Math.hypot` on device vs
`length(subtract())` on browser, so **the parity harness computes different distances per
lane for the same walk**. Also verbatim-duplicated: `setupRequest`, `observedResourceIds`;
diverged: `failureReport` field sets; and `throwIfAborted` always reports *"Desktop
playtest interrupted"* even on Android/iOS (`androidRunner.ts:437`). Finding #14:
`runner/sampling.ts` holds seven unrelated subsystems (HUD sampling, movement math,
camera eval, vec3 helpers, server lifecycle, crash diagnostics, adapter probe).

Files analyzed: the four paths above plus the desktop runner's use of `steps.ts`.

## Solution

- One shared module owns each behaviour; browser and device runners both import it. The
  distance implementation must produce bit-identical results for identical inputs on both
  lanes.
- Abort messages name the actual target.
- `sampling.ts` splits by subsystem; imports update; no re-export shim left behind unless
  an external consumer requires it (name it in the ledger if so).

## Integration Ledger

| # | Changed thing | Live caller | Replaces | Negative control |
| --- | --- | --- | --- | --- |
| 1 | Shared path-length math | browser + device runners via one module | two diverged implementations | feed the same points to both lanes' old paths → lengths differ today (paste); after, single impl cannot diverge |
| 2 | Shared request/id/failure helpers | both runner entry paths | verbatim copies + diverged field sets | diff captured failure reports web vs device → field sets must match |
| 3 | Target-named abort message | `throwIfAborted` call sites on every target | hardcoded "Desktop playtest interrupted" | abort during an android run → message names android |
| 4 | Split sampling modules | runner imports | the seven-subsystem file | grep: no subsystem unrelated to sampling remains in `sampling.ts` |

## Execution Phases

### Phase 1 — Distance math is one function

**Files (4):** new shared module under `packages/playtest/src/runner`,
`steps.ts`, `androidRunner.ts` (EDIT), parity/spec file (EDIT).

- [ ] Single implementation; both lanes call it.
- [ ] Property test: identical point sequences → identical length across lanes.
- [ ] Red first: run today's two implementations on one walk, paste the differing numbers.

Mutation for red: reintroduce either local copy → cross-lane equality test red.

### Phase 2 — Requests, ids, failures and aborts share definitions

**Files (4):** shared module (EDIT), `steps.ts`, `androidRunner.ts`, runner spec (EDIT).

- [ ] `setupRequest`/`observedResourceIds` single-sourced; failure-report field set unified
      to the superset both need.
- [ ] Abort messages carry the running target's name.
- [ ] Red first: paste the verbatim dup greps and the wrong-target message.

Mutation for red: restore the hardcoded string or either copy → its test red.

### Phase 3 — sampling.ts becomes N focused files

**Files (5 max):** `sampling.ts` split into ≤4 focused modules + updated importer files
(EDIT), spec (EDIT).

- [ ] Each subsystem moves whole with its tests; no behaviour edit rides along.
- [ ] Old file gone or holding only what its name says.
- [ ] Full playtest suite green unchanged.

Observe red by importing a moved symbol from the old path — build must fail loudly, not
fall back.

## Verification

Record `docs/verification/prd-202-runner-one-implementation-<date>.md`.

1. Focused specs per phase; mutations pasted red.
2. Cross-lane proof: one navigation scenario run on browser WebGPU and desktop native;
   reported path lengths agree exactly (paste both outputs).
3. An android-lane run (emulator lane is available) proving the abort message names its
   target; if the lane is down, record attempted + unverified rather than skipping.
4. `pnpm test:playtest` green.

## Acceptance Criteria

- [ ] The same walk produces the same reported distance on every lane.
- [ ] No helper in scope has two implementations; a third cannot appear without failing a
      test (duplication guard).
- [ ] Interrupted runs name their true target on all four platforms.
- [ ] Each criterion states its mutation with pasted red above.
