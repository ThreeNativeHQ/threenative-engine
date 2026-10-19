---
prd_contract: v1
---

# PRD-261 — the release instruments report again

**Status:** DONE — filed 2026-08-29, landed in `273672e1`, corrected and verified on `main` at
`07dfaf63`. All three phases executed; evidence in
[alpha-a3-2026-08-29](../../verification/alpha-a3-2026-08-29.md). `pnpm round:next` exits 0 and
computes `close round 12`; `pnpm alpha:bar` reports A3 **pass** and A7 **pass** with A1 and A5 the
only failing rows, and the generated table is byte-identical to the run. The lane's own A3 block
had been filed `status: fail` for a run in which the property held, and from a worktree path that
no longer exists; both controls were re-executed from the committed fixtures on `main` and the
block now reads `pass` from a reproducible source. Depended on Lane A
([PRD-229](PRD-229-the-native-host-is-provable-before-it-is-moved.md) Phase 5,
files 1–2) only so that its own record could cite a green `pnpm test`.

Second lane of the release batch (`docs/PRDs/alpha-readiness/`, since removed).

**Goal: the three instruments that grade this release can each run and say what they found.**
Two of the seven alpha-bar rows are unmeasured for want of a run nobody has done, and the command
that computes the next action throws before it computes anything.

**Complexity:** +1 (2–5 files) +1 (a gate's own output) = **2 → LOW mode.** It is small on purpose;
every other lane in the batch is graded by these three outputs.

## The problem, measured today at `8491c5d5`

### 1. `pnpm round:next` throws, and not for the reason it says

```text
Round ledger is missing '## Notes'.
ELIFECYCLE  Command failed with exit code 1.
```

`docs/verification/round-10-2026-08-16.md` has `## Notes` at line 92. The file being read is not a
round ledger at all. `latestRoundFile` in `scripts/round-ledger.ts:552` selects by

```js
const match = /^round-(\d+)-.+\.md$/u.exec(file);
```

and `docs/verification/round-196-published-install.md` — PRD-196's evidence record, not a round —
matches with number **196**, beating round 12. The loop's own "what next" command has therefore been
answering from the wrong file since that record was filed.

This is the repository's fail-closed rule working exactly as designed and pointing at the wrong
thing: the parser refuses to guess, and the diagnosis costs a reader ten minutes because the message
names a heading rather than a file.

### 2. A7 has no table to compare against

```text
A7  unmeasured  The bar is runnable, not transcribed
    docs/PRDs/alpha-readiness/README.md is missing, so the generated table cannot be compared.
```

`scripts/alpha-bar.ts:29` names `docs/PRDs/alpha-readiness/README.md` as `BATCH_README`, and
`pnpm alpha:bar --write` generates it. The folder was deleted in commit `08a05346`. A7 was **pass**
on 2026-08-15 (`docs/verification/alpha-bar-2026-08-15.md` line 151); it is unmeasured now because
the file it grades was removed, not because the bar changed.

### 3. A3 asks for a run that has never been recorded

```text
A3  unmeasured  Verification cannot report green while asserting nothing
    No alpha-bar evidence block for A3 was found in docs/verification/.
```

The property itself is implemented and unit-tested — `packages/playtest/src/runner/index.ts:88`
carries `@constraint an empty assertion set is a failure`, and
`packages/playtest/__tests__/runner.spec.ts:773`, `e2e-runner.spec.ts:181` and `silent-drop.spec.ts`
all cover it. What is missing is the **run**: `scripts/alpha-bar.ts` rejects a block whose `source`
names a PRD document (`TN_ALPHA_EVIDENCE_PRD_SOURCED`), and a unit test is not the CLI. Nobody has
driven the shipped runner against a scenario that asserts nothing and written down what it did.

## Solution

Three independent repairs, one commit each, no shared surface between them.

- `latestRoundFile` selects among files that **parse as round ledgers**, and its error names the
  file it rejected. `round-196-published-install.md` stops being a candidate.
- `pnpm alpha:bar --write` restores `docs/PRDs/alpha-readiness/README.md`, and the file is committed
  so the drift check has a baseline.
- One `docs/verification/` record drives the shipped playtest CLI against an empty-assertion
  scenario and carries the A3 block, sourced from the command line that produced it.

**Data changes:** none. One regenerated table and one new evidence record.

## Integration Ledger

| # | New thing | Live caller (`file:line`, non-test) | Replaces | Old path removed? | Negative control |
|---|---|---|---|---|---|
| 1 | ledger-shaped selection in `latestRoundFile` | `scripts/round-next.ts` via `pnpm round:next` | the bare `round-(\d+)-` filename match | yes, in the same commit | file a second non-ledger `round-<n>-*.md` with a high number → `round:next` still answers from the real latest |
| 2 | `docs/PRDs/alpha-readiness/README.md` | `scripts/alpha-bar.ts:29` | nothing (it was deleted) | n/a | edit one cell by hand → `pnpm alpha:bar` reds on A7 |
| 3 | the A3 evidence record | `readEvidenceBlocks` over `docs/verification/` | nothing | n/a | change the block's `source` to a PRD path → `TN_ALPHA_EVIDENCE_PRD_SOURCED` throws |

## Execution phases

#### Phase 1: `round:next` reads a round ledger

**Files:** `scripts/round-ledger.ts` (EDIT), `scripts/__tests__/round-ledger.spec.ts` (EDIT), the record.

| Test file | Test name | Assertion | Negative control |
|---|---|---|---|
| `scripts/__tests__/round-ledger.spec.ts` | `should ignore a round-numbered file that is not a round ledger` | `latestRoundFile` returns round 12, not 196, from a fixture containing both | delete the guard → the spec reds naming `round-196-*` |
| `scripts/__tests__/round-ledger.spec.ts` | `should name the file it rejected when no ledger parses` | the thrown message contains the path | restore the bare heading message → red |

- [x] Paste `pnpm round:next` red before the change and its computed next action after.
- [x] Decide and record whether `round-196-published-install.md` is renamed instead of guarded
      against; if it is renamed, the guard still lands, because the next such file will not be.

**Revert check:** revert `round-ledger.ts` alone → both specs red, `pnpm round:next` exit 1 again.

#### Phase 2: A7 has a table again

**Files:** `docs/PRDs/alpha-readiness/README.md` (NEW, generated), the record.

- [x] `pnpm alpha:bar --write`, commit the generated file **unedited**.
- [x] Confirm the table reports the batch's real state — A1 and A5 failing, A3/A6 unmeasured. A
      generated table that reads green while the bar exits 2 is the failure this row exists to catch.
- [x] Hand-edit one cell, run `pnpm alpha:bar`, paste the A7 red, revert the edit.

**Revert check:** delete the file again → A7 returns to unmeasured with the same message.

#### Phase 3: A3 is measured by a run

**Files:** `docs/verification/alpha-a3-<date>.md` (NEW), a fixture scenario asserting nothing, the record.

- [x] Build the playtest package, then drive the shipped CLI against a scenario with an empty
      assertion set. Record the **exit code and the failure text verbatim**.
- [x] Run the true-positive control in the same session: the same scenario with one real assertion
      passes. A negative control alone proves the runner is broken, not that it is honest.
- [x] Write the ` ```alpha-bar ` block with `row: A3`, a `status`, a `detail`, and a `source` naming
      the command line. **`status: fail` is a legitimate outcome and gets filed as readily as pass.**

**Revert check:** point the block's `source` at this PRD → `pnpm alpha:bar` throws
`TN_ALPHA_EVIDENCE_PRD_SOURCED`. Paste that throw.

## Acceptance criteria

- [x] `pnpm round:next` exits 0 and names a next action computed from the newest genuine round ledger.
- [x] `pnpm alpha:bar` reports **A3 measured** and **A7 pass**, with the two failing rows unchanged
      and still failing. This PRD moves no row it did not measure.
- [x] `docs/PRDs/alpha-readiness/README.md` is committed and byte-identical to `--write` output.
- [x] Every phase pastes its red and its green, both in the same commit.
- [x] `pnpm typecheck` exit 0 and `pnpm lint` exit 0. **`pnpm test` is 2584/2585**: the one red is
      `packages/playtest/__tests__/generated-shooter-input.spec.ts`, which fails identically at
      `07dfaf63` with this PRD's changes stashed — `TN_CAPTURE_BLANK` at bright-pixel ratio
      `0.04470` and the same four aim assertions — so it is a pre-existing capture-lane red on
      `main`, not this lane's. This criterion is recorded as met for what this PRD touches and
      **not** claimed as a green suite.
