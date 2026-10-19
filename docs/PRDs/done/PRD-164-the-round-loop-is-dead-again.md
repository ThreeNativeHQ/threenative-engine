---
prd_contract: v1
---

# PRD-164 — The round loop's two navigation commands died again, one day after they were repaired

**Status:** PROPOSED, 2026-08-19. Nothing below has executed. The two crashes in §1 were observed on
`HEAD` (`21960efd`) while assembling this batch and are recorded as prior observations, not as this
PRD's result.

**Closed 2026-08-20 — both commands are back.** `pnpm round:next` reports `close round 12` and
`pnpm round:deletions` exits `0`, reporting that a visual-only round contributes no deletion
evidence instead of throwing on its screenshot archives.

**Outcome:** `pnpm round:next` and `pnpm round:deletions` both exit `0` on `HEAD` with round 11 as
the current ledger, without weakening either script's fail-closed behaviour, and a regression test
holds the shape that broke them.

**Depends on:** nothing. Everything runs on this machine in under a minute.

**Blocks:** every other PRD in this batch that wants to know what the loop's next action is —
[PRD-163](PRD-163-round-12-repairs-what-round-11-re-opened.md) writes round 12 and cannot verify
its own ledger while the reader throws, and [PRD-165](PRD-165-the-framework-counter-crossed-its-own-trigger.md)
names `round:deletions` as the only admissible source of deletion evidence.

**Complexity: 3 → SMALL mode.** One reader, one ledger shape, one regression test.

**Blast radius: ~4 files.** `scripts/round-deletions.ts`, `scripts/round-ledger.ts` (only if the
shape belongs there), `scripts/__tests__/`, and possibly
`docs/verification/round-11-2026-08-19.md` if the ledger — not the reader — is what is wrong.

---

## 1. The observed red

```
$ pnpm round:next
Round archive is missing sweep.json: /home/joao/projects/threenative/threenative-engine/docs/verification/visuals/ab-2026-08-19/before
ELIFECYCLE Command failed with exit code 1.

$ pnpm round:deletions
Error: Round archive is missing sweep.json: .../docs/verification/visuals/ab-2026-08-19/before
    at scripts/round-deletions.ts:92:13
    at frameworkArms (scripts/round-deletions.ts:86:15)
```

The root agent instructions name exactly two commands for the self-improvement loop — *"`pnpm
round:next` computes the single next action and `pnpm round:deletions` reports exports unreached
across consecutive rounds"* — and **both are down**.

[PRD-161](PRD-161-the-kill-switch-has-no-working-instrument.md) repaired the same pair on
2026-08-19 for the round-10 no-arms case and recorded exit `0`. Round 11 landed hours later and
broke them again with a different shape, so the repair fixed one instance and not the class.

## 2. Why round 11 has this shape

[`round-11-2026-08-19.md`](../../verification/round-11-2026-08-19.md) is a **template-only
before/after AB**, not a framework-versus-vanilla game pair. The ledger says so in its own words:

> The round-ledger parser requires two condition arms named `framework` and `vanilla`, so those
> names below mean before and after respectively.

Its two archives are `docs/verification/visuals/ab-2026-08-19/before` and `.../after` — directories
of seven PNGs each. They are not sweep archives and have no `sweep.json`, because no sandbox was
built and no export reach was measured. `frameworkArms()` reads the row named `framework`, requires
a sweep manifest, and throws.

**The reader is not wrong to throw.** A directory of screenshots carries no export-reach data, and
inventing an empty measurement would hand `round:deletions` a false "nothing is unreached" and put
live exports on a deletion list. The defect is that the ledger format has one arm vocabulary for two
different kinds of round, and the loop's navigation commands treat the collision as an unhandled
crash rather than as a legible state.

## 3. Phase 1 — attribute before repairing

Decide and write down, in one paragraph in the verification record, which of these is true:

- **Ledger defect.** A visual-only AB round must not borrow the `framework`/`vanilla` arm names, and
  round 11 should have declared its arms under a shape the reader already understands
  (`declaresNoArms`, or a distinct arm kind).
- **Reader defect.** The reader must understand a round whose arms are visual archives and exclude
  it from deletion evidence explicitly, the way round 10's declared no-arms case already is.

The recommendation, not binding on the executing agent: **both, in that order** — round 11's row is
misnamed *and* the reader crashes instead of reporting. The fix that only renames the ledger leaves
the next visual round free to crash the loop again.

**Do not edit round 11's measurements.** Its deltas, dispositions, MDE and firewall attestation are
a scored result. Only the arm-shape metadata may change, and the change must be annotated in the
file rather than silently rewritten.

## 4. Phase 2 — red first, then green

1. Write the failing test first, in `scripts/__tests__/`, from a fixture ledger with a
   screenshot-only archive. Paste the red.
2. Repair the reader so that a visual-only round is **reported, not crashed** — it contributes no
   deletion candidates and says so by name, exactly as round 10's declared no-arms case does.
3. Repair round 11's arm metadata if Phase 1 attributed a ledger defect, with an inline annotation.
4. Paste the green, and paste `pnpm round:next` and `pnpm round:deletions` exiting `0` on `HEAD`.

## 5. Negative controls, each observed red

A repair that makes the commands exit `0` by ignoring missing data recreates the exact fail-closed
defect the charter forbids. All four must be observed red in the same run:

| Control | Deliberate defect | Required result |
|---|---|---|
| Missing sweep in a real sweep round | Delete `sweep.json` from a genuine framework sweep archive | still throws |
| Contradicting manifest | Point a framework row at an archive whose manifest names another genre | still throws |
| Silent empty measurement | Make a visual round return `unusedExports: []` as if measured | test fails; the visual round must be excluded, never counted as empty |
| Non-consecutive rounds | Remove round 10 from the fixture | still throws |

## 6. Acceptance criteria

| # | Criterion | Evidence |
|---|---|---|
| 1 | `pnpm round:next` exits `0` on `HEAD` and prints one next action | pasted output |
| 2 | `pnpm round:deletions` exits `0` on `HEAD` and reports round 11 as contributing no deletion candidates, by name | pasted output |
| 3 | A regression test reproduces the crash before the fix and passes after | pasted red, pasted green, same commit |
| 4 | All four controls in §5 observed red | pasted output |
| 5 | Round 11's deltas, dispositions and MDE are byte-identical, or the diff is only annotated metadata | `git diff docs/verification/round-11-2026-08-19.md` |
| 6 | `pnpm typecheck && pnpm lint && pnpm test` green | pasted output |

## 7. Deliberately out of scope

- Re-scoring round 11, or changing any visual verdict.
- Redesigning the round ledger format beyond the arm-shape collision that causes this crash.
- Deleting any export. This PRD restores the instrument; spending its output is PRD-165's job.
