---
prd_contract: v1
---

# PRD-356 — "the framework stopped a rewrite" is an anecdote; make it a row

**Status: PROPOSED, 2026-09-04.** Filed in `agent-leverage/`, measured at `dae30759`.

**Priority:** P2 — Paired-sweep row scoring a stopped rewrite unbuilt; needs PRD-355 and PRD-297 first.
**Complexity:** +2 for 6–10 files, +2 for a new module (the scorer and its ledger row), +2 for
multi-package (`scripts/`, the round ledger, the detector from PRD-355) = **6 → HIGH mode.**

**Depends on** [PRD-355](PRD-355-the-reinvention-gate-sees-one-capability-in-fifty.md) — there is
no score without a detector that sees more than 1.8% of the engine.
**Depends on** [PRD-297](../done/PRD-297-capability-recall-is-a-measured-number.md) — a
reinvention count beside an unmeasured recall cannot be attributed to either.

## 1. Context

**Problem.** The framework's central claim is that a cold agent building on ThreeNative writes less
of what already exists than the same agent on plain Three.js. Every piece of evidence for that
claim in this repository is an **anecdote with a number attached**:

| Anecdote | Where |
| --- | --- |
| "A game once hand-wrote 446 lines that were already installed, and ran at 9 FPS" | root `AGENTS.md` |
| bayview's 190-line `src/perf.ts` beside the shipped `FrameBudget` | `feature-mining/PRD-325` |
| lumen-hall's 116-line `collision.ts`; three games, three identical seams | `feature-mining/PRD-325` §1 |
| 880 colliders and four render stages tuned with no capability search | root `AGENTS.md`, 2026-09-03 |

Each was found by a human or an agent reading source **after the fact**, one game at a time. None
of them is in a round ledger. None of them moves when the framework improves. **The single number
the whole project optimises has no instrument.**

**What already exists, and what it does not answer.** The paired-sweep harness is real and this PRD
adds no new arm to it: `pnpm sweep:capture | judge | pair | delta | proof | archive`,
`scripts/score-blind.ts` for blind frame scoring, `pnpm sandbox` to build a cold-agent sandbox that
installs from tarballs with no workspace and no `AGENTS.md` chain, and
`scripts/count-loc.ts` for the kill-switch LOC score. The round ledger lives in
`docs/verification/round-*.md` and `pnpm round:next` computes the next action from it.

Between them they answer *how good does it look* (blind rubric), *how much code did it take*
(`count-loc`), and *what was proven*. **None answers *what did the agent rebuild that it already
had*** — which is the mechanism by which the other three are supposed to improve.

**Files analyzed.** `scripts/sweep-{capture,judge,pair,delta,proof,archive}.ts`,
`scripts/score-blind.ts`, `scripts/measure-sandbox.ts`, `scripts/make-sandbox.ts`,
`scripts/count-loc.ts`, `scripts/round-next.ts`, `scripts/round-deletions.ts`,
`scripts/detect-capability-duplicates.ts`, `docs/verification/round-13-2026-09-02.md`,
`docs/benchmark/sweeps/*/proof.json`.

**Overlap check.** Every open PRD surveyed 2026-09-04.

- **PRD-297** ([`authoring/PRD-297`](../done/PRD-297-capability-recall-is-a-measured-number.md)) — recall as a number. Measures the *pull* side against a corpus of
  phrasings. This measures the *outcome* on real generated game source. Hard dependency, not
  overlap: without 297's number, a reinvention count cannot be attributed to search quality versus
  search absence.
- **PRD-124** ([`agent-leverage/PRD-124`](PRD-124-agent-evidence-and-repair-benchmark.md), PROPOSED, planning only) — *agent evidence and repair benchmark*.
  Adjacent and the closest thing to a collision in the tree. 124 measures whether an agent
  **repairs** its own game from evidence; this measures what it **rebuilt** before running
  anything. Read 124's §1 before Phase 0 and, if its harness is the better host, land this as a row
  inside it rather than as a second scorer.
- **PRD-123** ([`agent-leverage/PRD-123`](PRD-123-threejs-ecosystem-compatibility-corpus.md)) — Three.js ecosystem compatibility corpus. Different corpus,
  different question.
- **PRD-355** — the detector. Hard dependency; this PRD adds no detection logic of its own and must
  not fork the rules.

## 2. Solution

Run PRD-355's detector over **both arms of every sweep round** and report two counts that mean
different things and must never be added together.

| Arm | A finding means | Direction |
| --- | --- | --- |
| **vanilla** (plain Three.js, no framework installed) | the agent hand-wrote something ThreeNative ships — **addressable value**, the size of the prize | higher is a bigger opportunity, not a worse arm |
| **framework** (ThreeNative installed) | the agent hand-wrote something it *had*, sitting in its own `node_modules` — **a discovery failure** | lower is better; this is the number the project drives to zero |

That asymmetry is the whole design. A single "reinvention score" summed across arms would be
meaningless — one arm's findings are the market and the other's are the defect. The row reports
both, labelled, per round.

**What ships:** a scorer that reads each arm's generated source, runs the detector, and emits
`{ arm, findings, symbols, linesAttributed }` into the round's `proof.json` beside the existing
measurements, plus the ledger row that renders it.

**What does not ship:** no new arm, no new brief, no change to what the sweep builds or how it is
judged, no runtime surface, no export. This PRD is an additional read of artifacts the sweep
already produces.

**The attribution trap.** `linesAttributed` is the tempting number and the easy lie — a finding is
anchored at one line, and the hand-written block around it has no honest boundary a regex can find.
Phase 2 either defines a boundary that survives a negative control (a block whose extent is
measured the same way twice, by two people or two runs, agreeing) or **reports finding counts and
symbol names only**. Counts that are true beat lines that are impressive. The 446 and the 190 in
§1 were counted by a reader, not by a script, and this PRD does not get to pretend otherwise
without proving it can.

**The sealed-corpus rule, restated as it binds here.** `docs/benchmark/genres/*/brief.md` are sweep
inputs hashed into `briefHash` (`scripts/make-sandbox.ts:252`). This scorer reads **arm source
only**. Brief text never reaches the detector's rules, never reaches `capabilities.json`, and never
reaches an artifact that installs into a sandbox — otherwise an arm reads its own answers out of
the engine it is being scored on, and the self-improvement loop is invalid rather than merely
wrong.

## 3. Integration Ledger

| # | New thing | Live caller | Replaces | Negative control |
|---|---|---|---|---|
| 1 | Per-arm reinvention scorer | `scripts/sweep-proof.ts` (or PRD-124's harness — Phase 0 decides) | the anecdotes in §1 | Plant a known reinvention in one arm's source; the count for that arm rises by one and names the symbol |
| 2 | Two labelled counts, never summed | the ledger row | a single meaningless total | Attempt to render a combined figure; the spec forbids it and fails |
| 3 | `proof.json` fields | `pnpm sweep:proof`, read by `round-next.ts` | nothing recorded per round | Delete the field from one round; `pnpm round:next` says the round is incomplete rather than reporting zero |
| 4 | Ledger row in `docs/verification/round-*.md` | `pnpm round:next` | — | A round with the field absent must not render as "0 reinventions" — absence and zero are different, and fail-closed means absence loses |
| 5 | Detector reuse, not fork | imports PRD-355's module | a second copy of the rules | Change one rule in PRD-355; this scorer's output changes without an edit here |

## 4. Phases

**Phase 0 — the red, and the host decision.** Run PRD-355's detector by hand over the two arms of
the most recent archived sweep round and paste both counts. That single pair is the first
measurement of the project's central claim that has ever existed; if the framework arm's count is
not lower than vanilla's, that is the finding and it outranks the rest of this PRD. Then read
PRD-124 §1 and rule whether this row lives in `sweep-proof` or inside 124's harness. Record the
ruling and its reversal condition here.

**Phase 1 — the scorer**, reusing PRD-355's module by import. No rule may be defined in this file's
code; a forked rule set is how the two numbers silently stop meaning the same thing.

**Phase 2 — the attribution ruling.** Define a defensible block boundary for `linesAttributed`, or
drop the field. Whichever is chosen, the negative control that decided it is pasted.

**Phase 3 — the ledger row**, fail-closed: a round missing the field reports *missing*, never zero.

**Phase 4 — the retrospective pass.** Re-score the archived rounds the retention policy still
keeps, so the row has a history the day it ships rather than a single point. Bounded by what
`docs/benchmark/sweeps/` actually retains — do not re-run a sweep to manufacture history.

## 5. Acceptance criteria

- [ ] **AC1 — the first pair exists.** Framework-arm and vanilla-arm counts for one real archived
      round, pasted, with the symbols named. This is the deliverable even if every later phase
      declines.
- [ ] **AC2 — the arms are never summed.** No output, ledger row or JSON field combines them. A
      test asserts it.
- [ ] **AC3 — a planted reinvention moves exactly one arm.** Red pasted, naming the symbol.
- [ ] **AC4 — absence is not zero.** A round with the field removed renders *missing* and
      `pnpm round:next` treats the round as incomplete. Red pasted.
- [ ] **AC5 — no forked rules.** Changing one rule in PRD-355's module changes this scorer's output
      with no edit in this PRD's files. Demonstrated.
- [ ] **AC6 — attribution is ruled, not fudged.** Either `linesAttributed` ships with the control
      that justifies its boundary, or the field does not exist. A third option — shipping it
      unjustified — fails this criterion.
- [ ] **AC7 — sealed corpus untouched.** No brief text reaches the detector, the manifest, or any
      artifact that installs into a sandbox. `git diff --stat docs/benchmark/genres/` empty.
- [ ] **AC8 — byte-identical instruments.** `pnpm round:next`, `pnpm round:deletions` and
      `pnpm alpha:bar` produce byte-identical output either side of this change, except for the new
      row. Diff pasted.
- [ ] **AC9 — gates.** `pnpm typecheck && pnpm lint && pnpm test && pnpm budgets`, output pasted.

## 6. Decline conditions

Close as DECLINED, **keeping Phase 0's measurement**, if PRD-355 Phase 3 declines — a detector at
1.8% coverage scored across two arms produces a number too small to move and too noisy to trust,
and publishing it into the round ledger would give the project a metric that looks like evidence
and is not.

Close as DECLINED if PRD-124's harness is the better host and its owner wants the row inside it. In
that case this file's §2 asymmetry and §5 criteria migrate there verbatim; the design is the
deliverable, not the location.
