<!-- Generated mirror of AGENTS.md. Do not edit; edit AGENTS.md. -->

# AGENTS.md — docs/PRDs

Read `/AGENTS.md` first. This file is about filing, not about how the work gets done.

## Where a PRD lives

- **Finished** → `git mv` it to `docs/PRDs/done/` **in the commit that finishes it**.
- **Only blocked work left** → `docs/PRDs/BLOCKED/<reason>/`, the folder naming what unblocks it —
  `requires-physical-device`, `requires-release-credentials`, `requires-owner-decision`, … See
  `BLOCKED/README.md` for the folders that exist. (owner, 2026-09-25)
- Still-doable work left → the PRD stays where it is, whatever its status. A dependency that is not
  ready blocks its own `## Blocked on` lines, not the file.
- **Release-critical** → `docs/PRDs/production-readiness/critical/`. Only a PRD there blocks a
  release; one whose last open work is blocked moves to `BLOCKED/<reason>/` (R6 below) so it stops
  reading as a live release blocker while the owner can still validate it.

**Never un-file a finished PRD by rewriting it.** Re-scoping is not a reason to pull a PRD out of
`done/` and replace it with a fresh plan: that deletes the ticked boxes and the landed commits that
justified them, and the work reads as never done. If finished work regressed or its scope grew,
either reopen the *same* file — keeping its ticked boxes and its evidence, adding the new items
unticked — or open a new PRD that cites the done one. A `git mv` out of `done/` needs a line in the
commit message naming what specifically regressed, with the commit or gate that shows it.

Grouped batches (`starter-kits/`, `native-performance-fixes/`, dated batch folders) move whole:
`git mv docs/PRDs/<batch>/ docs/PRDs/done/<batch>/` in the commit that closes the last PRD. Never
archive a batch while any PRD in it is partial — a blocked criterion is not completion. A PRD that
finishes ahead of its siblings gets archived on its own.

## Keep the PRD current while you work

The PRD is the live state of the work, not a plan written once. Update it as each piece lands, in
the same commit as the change:

- **Tick the checkbox** (`- [ ]` → `- [x]`) when that item is done *and* its proof is green, and
  write the result beside it: the command, the number, the exit code, the artifact path. One line,
  in the PRD — not a new report file (see Evidence below). A box ticked on unrun work is the same
  lie as a claimed gate.
- **Partial or abandoned** work stays `- [ ]` with a short note on the line below saying what is
  left. Delete an item only when a decision made it moot, and record that decision (R4) — never to
  make the list look finished.
- **Move the status line** (`NOT STARTED` → `PARTIAL` → done, or the phase marker) with the boxes;
  a PRD whose boxes are all ticked but still reads `NOT STARTED` is drift.
- Only when every box is ticked and the status says so does the `done/` move apply above.

If a PRD has no checkboxes and you are working it, add them as you discover the steps, then keep
them current the same way.

## The shape of a PRD (owner decision, 2026-09-25)

- **R1 — every box names its proof inline.** `- [ ] Linux desktop build runs 300 frames. proof:
  \`pnpm native:verify:desktop\``. A command, a CI job/run, or a PR. When that proof is green anyone
  may tick the box, with the result beside it. `pnpm prd:progress <file>` prints a warning line for
  every countable box that names no `proof:` marker.
- **R2 — no ceremony boxes.** An observed revert check, an independent reviewer's PASS, a written
  evidence record, an artificial negative control, a caller census: none of them is work. They
  belong in the PR body or the PR template.
- **R3 — what is out of reach is not a box.** Hardware, credentials, other people and owner calls
  go under a `## Blocked on` heading, one line each naming who or what unblocks it. They are not
  checkboxes and do not count toward progress.
- **R4 — a decision deletes a moot box.** What was decided, by whom, on what date and why goes under
  `## Decisions`. Ticked work is never deleted and a finished PRD is never un-filed.
- **R5 — at most 3 phases and about 8 boxes.** Bigger work is split into separate PRDs.
- **R6 — a blocked-only PRD moves.** When the only remaining work is `## Blocked on` items,
  `git mv` the file to `docs/PRDs/BLOCKED/<reason>/`, fix the links, and let the owner validate it
  later. With any doable work left it stays put, listing its blocked items. (Supersedes the
  2026-09-23 "blocked stays in critical/" rule.)

**Every phase carries its own boxes.** Acceptance criteria alone are not a progress record: they are
the last thing to go green, so a PRD whose only boxes sit under *Acceptance criteria* shows zero
progress until the whole thing is finished, and nobody ever ticks anything.

**One box, one claim.** A criterion that conjoins several independent facts ("Windows, macOS and
Linux all do X *and* Y *and* Z") can never be ticked, because some clause is always out of reach.
Split it: one box per platform, per artifact, per property. A clause nobody can reach is a
`## Blocked on` line (R3), not a box that will never be ticked.

## Priority header

Every PRD that still has unfinished work carries one canonical header next to its status line:

```markdown
**Priority:** <P0|P1|P2|P3> — <one line citing this PRD's own unfinished outcome>
```

| Tier | Meaning |
|---|---|
| `P0` | a confirmed immediate release, runtime, security or data-loss blocker, or the indispensable prerequisite for one |
| `P1` | high-impact core correctness, supported-platform parity or performance, or a primary-workflow blocker needed soon |
| `P2` | planned improvement or regular feature work |
| `P3` | optional, speculative or low-impact work |

- Rate the **unfinished** scope, not the phases already landed. Status, progress and blocking are
  separate from priority: never derive a tier from tick count, folder name or "it is in flight".
- The rationale cites that PRD's own open boxes, acceptance criteria or blocked item. It is triage
  judgement, not a verified incident report, and it never claims a fact the file does not carry.
- `P0` needs explicit blocker evidence in the document. Without it, use `P1`.
- An unfinished **indispensable** prerequisite inherits the highest tier of the urgent work it gates;
  an urgent prerequisite never lifts an optional consumer. Raise a dependency only where
  `**Depends on:**` names it and it still has unfinished work — open boxes, or a blocked-only
  remainder waiting on something outside this repository. Several named prerequisites are not
  optional because several are listed: raise each one the dependent names as required, or cite the
  sentence that marks it optional, non-gating, absorbed or already satisfied. Keep the real
  dependencies and any stated order, and check for a dependency cycle before you claim an order.
- Triage pending work only. A finished, cancelled or superseded PRD keeps the tier it was filed
  with, or none at all.

## One PR per PRD

**A PRD gets exactly one pull request, opened as a draft before phase 1 starts.** Never one PR per
phase: phase-sized PRs split the evidence across branches nobody re-reads. The PR body carries the
PRD's checklist in the same order, ticked in the same push that ticks the PRD — a PR box ticked
ahead of the PRD is the same lie as a claimed gate.

Progress is a label, applied on every push and never more than one at a time, rounded by *verified*
phases rather than lines written or files touched:

| Label | Meaning | Colour |
|---|---|---|
| `prd:25%` | phase 1 landed and verified | `#d73a4a` red |
| `prd:50%` | half the phases landed and verified | `#e36209` orange |
| `prd:75%` | all but the last phase landed, or phases in with acceptance open | `#fbca04` yellow |
| `prd:100% — ready` | every phase and every acceptance box ticked; PR out of draft | `#0e8a16` green |

`scripts/prd-progress.ts` computes the bucket from the file; `pnpm prd:progress <file>` prints the
label to apply.

## Try a blocked reason before you believe it

`BLOCKED/` folders name a missing tool or lane, and several have outlived the condition that put
them there — a device that is now attached, an SDK installed but off `PATH`, an emulator that boots
fine. Attempt the blocked step once and record what actually happened before filing or re-filing
under that reason; two lanes were once parked for a day on a tool that was on disk the whole time.

## Evidence — live → cited → deleted

What keeps a tracked evidence file is a **citation**, not its age: a round ledger, a done PRD, an
open PRD, or a script that names it. The report keeps routine results in the PRD, PR or response;
creating or editing a PRD requires no verification report, evidence ledger or pasted logs. Create a
separate file only when the user asks or an automated workflow consumes it — the self-improvement
loop's `docs/verification/round-*.md` records are that kind of workflow output.

`pnpm budgets` enforces the tracked-byte caps in `scripts/check-evidence-budget.ts` and fails
closed; raising one needs its own commit saying why. The report's file counts and duplicate-byte
measurements inform cleanup but do not block. Before deleting tracked evidence, obtain owner
authorization and check its actual consumers — removing an unused planning report does not require
unrelated round or release gates.

Two exemptions: runtime/core performance findings update `docs/verification/runtime-perf-state.md`
in place (owner decision, 2026-08-27), and under `docs/benchmark/sweeps/` the generated arm sources
are untracked build output while `proof.json`, `proof-artifacts/` and captures stay tracked.

For behavior changes, regression evidence must exercise the changed behavior. Planning and prose
edits need no deliberate breakage and no separate record of document checks.

