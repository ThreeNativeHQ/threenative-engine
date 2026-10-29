---
name: self-improve
description: Run one round of ThreeNative improving itself — build the same sealed brief twice (framework arm and vanilla arm), judge which is better on proof and pixels, turn every row where vanilla won into a framework change with a named caller, then re-measure. Use when the user asks to run an improvement round, continue the loop, or let the framework build itself. Not for ordinary feature work against a single PRD.
---

# self-improve

One round of the framework earning its existence against the only control that matters:
the same agent, the same brief, no framework.

This is the `gauntlet-loop` skill with the charter's bar already chosen and the arms already
specified. Read that skill for the builder/critic method if it is installed; everything below is
what this repository adds on top, and it wins where the two differ.

## The bar, and why you do not get to pick it

`CHARTER.md` §3: **parity with vanilla is the target, any discount is a bonus.** So a round
does not ask "is the game good". It asks, per genre:

| Column | Framework arm wins the row when | Instrument |
|---|---|---|
| Functional | it passes at least as many sealed proof scenarios | `pnpm sweep:proof` |
| Visual | its blind instrument score is at least the vanilla arm's | `pnpm sweep:judge` |
| Cost | its user source LOC is no higher | `pnpm sweep:measure` |
| Reach | recorded, **never gated** | `pnpm sweep:measure` |

Reach rate is not a win condition. An agent that ignores the framework entirely and ships a
better game is `CHARTER.md` §3 working as designed — the framework's floor is vanilla. A
round that chases reach rate is optimising the number instead of the product.

**Every row vanilla wins is the round's actual output.** That is the gap list, and it is
what PRD-worthy changes are made of.

## Round protocol

Run these in order. Each step writes evidence to disk before the next begins; a step whose
evidence is missing has not happened, whatever the transcript says.

**0. Resume, don't restart.** `pnpm round:next` prints the single next action from what is
already on disk. Days-long runs re-enter here after every context reset.

**1. Charter the round.** Create `docs/verification/round-<n>-<date>.md` from
`references/round-ledger-template.md`. Record: round number, genres, the framework commit
under test, the budget the user gave, and the stop conditions. No budget stated means you
ask for one — an unbounded loop is not a feature.

**2. Build both arms.** Per genre, two separate agent builds, in this order and never in one
context:

```sh
pnpm sandbox --bare --arm framework --genre <genre> --name <genre>-framework
pnpm sandbox --bare --arm vanilla   --genre <genre> --name <genre>-vanilla
```

Each build is a fresh `gauntlet-builder` subagent following `build-on-sandbox`.
**One game per folder**: each arm gets its own `../sandbox/<name>/`, and a sweep wipes only
that folder, so the other arm and every earlier game survive. `--name` defaults to
`<genre>-game`, which collides across arms — name both arms explicitly.
Archive each with `pnpm sweep:archive ../sandbox/<name>` before starting the next; an
unarchived build is evidence you can lose, and reusing a name refuses until it is archived.
The sandbox is its own git repository (`ThreeNativeHQ/examples`) — commit and push each
arm's folder when it is built, so the games outlive the archive tooling.

**Run the arms one at a time, never concurrently.** Two builders on one machine share a
process table, and `ps`/`pgrep` output does not respect the firewall: on 2026-08-15 a routine
`pgrep -af vite` printed the other arm's full command line, including a scenario body it had
written with a heredoc. They also share one GPU, which starved a gate running alongside them
until it hung. Sequential arms cost wall-clock and remove both problems.

**`build-on-sandbox` is not reachable from inside a sandbox** — it lives in this repository,
which the builder is forbidden to read, so a prompt that says "follow the skill" hands the
builder an instruction it cannot obey. Read it yourself and inline its method and its rules
into the builder's prompt. On 2026-08-15 both arms reported the skill missing and proceeded on
the prompt alone; the firewall held only because the prompt restated it.

**3. Prove both arms.** `pnpm sweep:proof <archive>` runs the *sealed* scenarios from
`docs/benchmark/genres/<genre>/proof/`. The builder never wrote them and cannot edit them.
A failing scenario is a finding, not a bug to be silenced.

**4. Capture and judge.** `pnpm sweep:capture` produces screenshots; `pnpm sweep:judge`
blind-scores the shuffled pair against the sealed `reference.png` using
`references/judge-rubric.md`. The judge is a fresh `gauntlet-critic` that has never seen
either build's source and never learns which sample is which.

**5. Read the gaps.** `pnpm sweep:pair` prints both arms side by side. For every row the
vanilla arm won, write one gap row in the ledger: what vanilla did better, the evidence, and
the smallest framework change that would close it.

**6. Decide each gap, in the ledger, before writing code.** Three dispositions, and every
one of them is a commitment:

| Disposition | When | What it costs you |
|---|---|---|
| Framework change | it clears the 20-line rule and has a named live caller in a template or example | a PRD, a test, and a re-measure next round |
| User space | a competent developer writes it in under 20 lines | it goes in `templates/`, never a package |
| Rejected | it contradicts `CHARTER.md` §2's closed list, or borrows a word Godot does not have | one sentence of reason, recorded, so the next round does not re-litigate it |

**7. Change, then re-measure.** Implement the framework changes under a numbered PRD. Next
round's build is the verdict: an abstraction with no call site in a fresh uninformed build
is deleted, per `AGENTS.md` rule 2. That deletion lands in the round that discovers it, not
as a follow-up.

## The arm firewall

The comparison is worth exactly as much as this separation. Violating any line voids the
round — say so and rebuild, never publish a contaminated pair.

- **The vanilla builder must not see the framework arm**, its source, its screenshots, or
  its ledger. And the reverse. Two builds, two agents, two directories, no shared context.
  Forbid `ps`, `pgrep`, `top` and anything else that enumerates the machine — a build does not
  need them, and they are the one channel a separate directory does not close.
- **Neither builder sees the sealed proof scenarios** before building. They build to the
  brief and the reference, the same as a user does.
- **No builder judges.** Not its own arm, not the other one. The judge is fresh, read-only,
  and blind to arm identity.
- **You do not build either arm yourself.** You are the lead agent; you spawn, collect, and
  record. A lead that writes game code has lost its independence and will grade itself.
- **Neither builder reads `packages/`, `docs/`, `CHARTER.md`, or any `AGENTS.md` in this
  repo** — that is `build-on-sandbox`'s core rule, and the sandbox exists to enforce it.

## Verify the control before believing what it proved

A negative control that does not bite produces a result that reads as evidence and is not. On
2026-08-15 a gutted-arm control set `CRATE_COUNT` to `0` and the build scored **10/12 — identical
to the intact arm**. Read without checking, that is a devastating finding: *the sealed proof cannot
tell a gutted build from a working one*. The archive's own details said `bodies: 29`. The constant
governed only part of the level, so nothing had been gutted, and the striking result was an artefact
of a control that changed nothing.

This is the exact inversion of the defect this loop exists to catch. There a gate reported green
while asserting nothing; here a gate would have reported *alarming* while controlling nothing. Both
are the instrument lying with confidence, and the second is more dangerous because it looks like a
finding worth acting on.

**So: before you believe what a control proved, confirm the control changed what it said it
changed.** Read the observation, not the score — body counts, entity lists, the fields the run
reports back. A control you have not verified is not evidence in either direction.

## What a round may not do

- Edit a sealed `brief.md`, `reference.png`, or proof scenario. Their hashes are in the
  manifest; a change voids the comparison against every earlier round.
- Weaken, delete, or narrow an assertion to get green. `AGENTS.md`: install the bridge or
  narrow the scenario, never delete the assertion.
- Raise a budget cap. `CHARTER.md` §10: exceeding a cap is not a signal to raise the cap.
  If a round needs more than 15,000 LOC or 8 packages, it cuts something instead.
- Add an abstraction with no live caller, or keep one that a fresh build did not reach for.
- Report a score for a step that did not run. `unmeasured` is a valid ledger value.
  A fabricated one is the single worst thing you can do here.
- Claim a `CHARTER.md` §12 result from an instrument score. The model judge drives the loop;
  §12 criterion 2 and a non-VOID `RESULTS-<date>.md` still require a human blind session.

## Stop rules

Stop at the first condition that applies, and record which one in the ledger:

1. **Parity reached** — the framework arm wins or ties every column across every genre, with
   evidence, in two consecutive rounds.
2. **Budget spent** — the user's stated round, token, or time budget is exhausted.
3. **Plateau** — two consecutive rounds close no gap row and move no instrument score beyond
   noise. Name why another round would not help; a plateau claimed from intuition is not one.
4. **Blocked** — a verified tooling, permission, or environment failure. State exactly what
   is missing.
5. **Kill switch fires** — the vanilla arm wins on cost across every genre for two rounds.
   `CHARTER.md` §12 is explicit that this document must be able to lose; the correct
   response is to say so in the ledger, not to run a third round hoping for better sampling.

Never stop because the result is "pretty good" or a round count was reached.

## Efficient monitoring and handoffs

Use fresh minimal contexts for builders and the blind judge; on Codex set
`fork_turns: "none"`. Inline the required sandbox method, brief, ownership and firewall rules,
not the coordinator transcript, other arm or prior verdict. Preserve every sealed proof,
negative-control check and required human judgment.

For long builds/gates, keep complete logs on disk and use completion notifications or waits
up to 60 seconds. Inspect `pnpm gate:status` and changed log tails; use `pnpm gate:doctor` for
stale/blocked state before rerunning. A poll with unchanged state does not warrant rereading
the skills, source tree or full ledger. Record command, revision, exit status and artifact;
do not claim success from a log-tail command. Reuse proof only for the same inputs and lane;
changed source, environment or sealed inputs require new proof.

## Running for days

The loop survives context resets because nothing lives in the conversation:

| What | Where |
|---|---|
| Next action | `pnpm round:next`, computed from disk |
| Round state, gaps, dispositions | `docs/verification/round-<n>-<date>.md` |
| Every build, both arms | `docs/benchmark/sweeps/<genre>-<date>-<arm>/` |
| Proof results, captures, judge verdicts | `proof.json`, `captures/`, `judge.json` in each archive |
| Framework changes | a numbered PRD in `docs/PRDs/`, moved to `done/` when closed |

A fresh session runs step 0 and continues. Report to the user at round boundaries, not at
every step — long silence with evidence on disk beats narration.
