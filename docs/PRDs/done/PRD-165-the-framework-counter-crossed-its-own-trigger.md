---
prd_contract: v1
---

# PRD-165 — The framework counter is past its trigger with nobody named, and the `ui` package is still undecided

**Status:** PROPOSED, 2026-08-19. Nothing below has executed. The budget output in §1 was observed on
`HEAD` (`21960efd`) while assembling this batch.

**Closed 2026-08-20 — the counter is back under its trigger.** `pnpm budgets` on integrated main
reports 14,989/15,000 framework LOC with `LIMITS` unchanged, and the `ui` row read `Earned` in the
then-active attribution snapshot (`loc-attribution-2026-08-20.md`, deleted on 2026-08-22 by
PRD-188; decommission evidence in
[the budgets-decommission record](../../verification/budgets-decommission-2026-08-22.md)).

**Outcome:** the framework LOC line is either back under 15,000 by deletion, or over it with a
written kill-switch verdict naming what was added and why it is earned — and the `ui` package's
`Undecided` row from the 2026-08-19 attribution becomes `Earned` or `Deletable`, with the evidence
that row already names.

**Depends on:** [PRD-164](PRD-164-the-round-loop-is-dead-again.md). `pnpm round:deletions` is the
only admissible source of a consecutive-round deletion candidate, and it currently crashes.

**Blocks:** nothing scheduled. It keeps the kill switch — the rule the charter says outranks effort
already spent — from becoming a number nobody acts on.

**Complexity: 4 → MEDIUM mode.** One counter reconciliation, one package audit, zero new features.

**Blast radius: ~10 files.** `packages/ui/src/`, whatever the audit moves into generated template
source, `docs/verification/loc-attribution-2026-08-20.md`, and
`docs/verification/loc-attribution-2026-08-19.md` gets a superseded banner if it is replaced.

---

## 1. The observed state

```
budgets trigger: framework LOC review trigger: 15025 lines (trigger 15000, +25).
  Packages moved since last recorded attribution: none.
  Justify in the owning PRD and run the kill switch over what was added.
budgets trigger: native runtime LOC review trigger: 78289 lines (trigger 50000, +28289).
budgets ok: 7 framework packages, 7 example workspaces, 15025/15000 framework LOC, ...
```

Two facts make this worth a night:

1. **The framework line is over.** On 2026-08-19 it had 262 lines of headroom; it now has **−25**.
   The trigger obliges a justification in the owning PRD and a kill-switch pass over what was added.
   No PRD owns it, so this one does.
2. **"Packages moved since last recorded attribution: none."** The attribution baseline recorded in
   [`loc-attribution-2026-08-19.md`](../../verification/loc-attribution-2026-08-19.md) was itself
   captured at 15,025 — already over. The counter therefore reports movement against a baseline that
   never was under the limit, and no package can be pointed at. That is a measurement gap, not an
   accusation against any package.

## 2. The rule this PRD executes

From the root instructions: *"An abstraction that costs more code than plain Three.js is deleted,
however much work it took; `scripts/count-loc.ts` scores it. Count every repetition, not one site."*

And the two questions, in order: **(a)** could the game write this portably itself? **(b)** does it
decide how anything looks? — where **(b) is a veto over (a)**.

**Raising `LIMITS.frameworkLoc` is forbidden by this PRD**, exactly as PRD-161 forbade it. A limit
raised to fit the code measures nothing.

## 3. Phase 1 — attribute the 25 lines

Reconcile the current walk against the recorded baseline and produce a per-package delta:

```sh
node --import tsx/esm -e 'import { collectBudgets } from "./scripts/check-budgets.ts"; const r = await collectBudgets(process.cwd()); console.log(JSON.stringify({ frameworkLoc: r.frameworkLoc, frameworkLocByPackage: r.frameworkLocByPackage }, null, 2));'
pnpm exec tsx scripts/check-budgets.ts --verify-framework-loc-attribution
```

Then walk the commits since the baseline capture and name which change added net framework lines.
The output of this phase is a table with one row per package and one sentence per row: what was
added, by which commit, and whether it passes both questions.

If the reconciliation shows the baseline is the thing that is stale, say so plainly and re-record it
at the new total with a superseded banner on the old file — **and the over-trigger obligation still
applies**, because a fresh baseline does not buy headroom.

## 4. Phase 2 — resolve the `ui` row

The 2026-08-19 attribution left exactly one row undecided and named its own next evidence:

> `ui` — 208 LOC — **Undecided**. Evidence still needed: audit `DebugOverlay` and `GameCanvas`
> against the generated-source look rule, then retain only the generic mechanism or move
> game-facing appearance into generated UI source.

Do that audit. For each of `packages/ui/src/DebugOverlay.tsx` and
`packages/ui/src/GameCanvas.tsx`, answer in writing:

- Which lines are **mechanism** — mounting, resizing, store binding, lifecycle, the React seam?
- Which lines **decide how something looks** — colour, position, typography, spacing, opacity?
- Can a game change the appearance completely without editing package code? If no, the appearance
  moves into generated template UI source, where the charter puts it.

The disposition must end `Earned` or `Deletable`. A second `Undecided` is a failed phase.

## 5. Phase 3 — spend the sweep, if it has anything to spend

With `round:deletions` repaired, run it and record the result. If it names an export unreached
across consecutive framework-arm rounds, dispose of it: delete, un-export, or keep with a named live
caller. If it names nothing — the likely outcome, since round 11 contributes no framework arm — say
so and claim no deletion evidence. **A candidate list that is empty is a result; inventing one is
not.**

## 6. Negative controls, each observed red

| Control | Deliberate defect | Required result |
|---|---|---|
| Stale baseline | Edit one package row in the attribution record | `--verify-framework-loc-attribution` exits non-zero |
| Silenced trigger | Remove the over-trigger line from the reporter in a scratch copy | budgets test fails; the trigger must be reported, never hidden |
| Raised limit | Set `LIMITS.frameworkLoc` to 16,000 in a scratch copy | rejected by this PRD's own acceptance; no such diff may land |
| Deletion without evidence | Claim a deletion candidate with no consecutive-round support | `round:deletions` does not list it; the claim is dropped |

## 7. Acceptance criteria

| # | Criterion | Evidence |
|---|---|---|
| 1 | Every framework line above 15,000 is attributed to a named package and commit, or the counter is back under | reconciliation table |
| 2 | Each attributed addition has a written verdict against both questions | attribution record |
| 3 | The `ui` row reads `Earned` or `Deletable`, never `Undecided` | attribution record |
| 4 | Any appearance decision found in `packages/ui/src` is moved into generated template source or justified as mechanism | source diff |
| 5 | `LIMITS` is unchanged | `git diff scripts/check-budgets.ts` shows no limit change |
| 6 | All four controls in §6 observed red | pasted output |
| 7 | `pnpm typecheck && pnpm lint && pnpm test && pnpm budgets` green, and `pnpm test:templates` green if template UI source moved | pasted output |

## 8. Deliberately out of scope

- **The native runtime's +28,289.** It needs an owner decision about what the native host is allowed
  to weigh, not an unattended night's deletion. It stays reported and unowned until that decision
  exists; this PRD does not touch `packages/runtime-native/`.
- Any deletion of a package. Package-level decisions are charter-level and need an owner.
- Any change that reduces LOC by moving code into a template purely to dodge the counter. Moving
  appearance into generated source is correct *because it is the rule*, and the reason must be
  written that way or not at all.
