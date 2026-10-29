---
name: prd-lifecycle
description: Keep a PRD honest from first phase to merge — give every phase its own checkboxes, each box its inline proof, tick them as work lands, run one draft PR per PRD with a red-to-green progress label, and move the file to done/ (or BLOCKED/<reason>/ when only blocked work is left) in the commit that finishes it. Use when starting, resuming, reviewing, re-scoping or closing a PRD, when a PRD looks stuck or hard to tick, or when a finished PRD is about to be reopened. Not for writing a PRD from scratch — that is prd-creator.
---

# prd-lifecycle

`prd-creator` writes the plan. This skill is about everything after: keeping the plan's state true
while the work happens, and closing it.

Filing rules live in `docs/PRDs/AGENTS.md` and bind. This skill is how you apply them.

## Why this exists

On 2026-09-08 one commit (`7d730126f`) moved nine PRDs out of `done/`, `BLOCKED/` and `mobile/`,
deleted ~3,200 lines of accumulated evidence, and rewrote them as fresh plans with zero ticked
boxes. `PRD-264` lost sixteen ticked boxes and a `DONE` status citing two commits that are still
ancestors of `main`. The replacement's phases were new scope, not a regression — so the PRD read as
never done while its code sat shipped in `main`.

The rewrites also dropped every per-phase checkbox, leaving five compound acceptance criteria per
PRD. Measured on 2026-09-11: **80 of 143 open PRDs have no phase checkboxes at all**, so
`pnpm prd:progress` cannot report on them. A PRD that cannot show progress does not get worked on.

## The five rules

### 1. Every phase carries its own boxes

Acceptance criteria are the *last* thing to go green. A PRD whose only boxes sit under
*Acceptance criteria* shows 0% until it is 100%, so nobody ever ticks anything and the work looks
dead. Give each phase a short checklist — files wired, required test passing, the proof the phase
claims — and tick those as the phase lands.

`prd-creator`'s phase template already has these boxes. Do not compress them away to save space;
R5 caps the PRD at 3 phases and about 8 boxes, and anything bigger is a second PRD.

Check before you start work:

```sh
pnpm prd:progress docs/PRDs/<batch>/PRD-<id>-<slug>.md
```

It exits 1 with `no phase checkboxes` when the PRD is in the broken shape, and warns once per box
that names no `proof:` marker (R1). Fix the shape first — add the boxes from the phase prose and
their proofs — then start.

### 2. One box, one claim, and a proof to run

A criterion that conjoins independent facts can never move from `[ ]` to `[x]`, because some clause
is always out of reach:

> - [ ] Each claimed desktop OS/architecture has a complete relocatable release container with
>       working unchanged starter HUD/assets and game OS identity.

That is four OS/arch targets times four properties — about sixteen verifications, several needing a
Windows host, a macOS host and Apple notarization — in one checkbox. Split it: one box per platform,
per artifact, per property.

A clause nobody can reach is not a box at all: it is a line under `## Blocked on` naming who or what
unblocks it (R3). It does not count toward progress, and it never becomes an untickable box.

And every box names its proof inline — `proof: \`pnpm native:verify:desktop\``, `proof: CI job
\`native-desktop\``, `proof: PR #123` — so anyone can tick it once that proof is green (R1).

### 3. No ceremony boxes (R2)

An observed revert check, an independent reviewer's PASS, a written evidence record, an artificial
negative control, a caller census: none of these is work, and a box nobody can honestly tick is a box
nobody ticks. They belong in the PR body or the PR template. This skill's own rule list is the
example: everything below is checkable work.

### 4. Tick as it lands, in the same commit

The PRD is live state, not a plan written once.

- `- [ ]` → `- [x]` when the item is done **and** its proof is green. A box ticked on unrun work is
  the same lie as a claimed gate.
- Write the result beside the item where it carries evidence — the command, the number, the exit
  code, the artifact path. One line, in the PRD.
- Partial or abandoned work stays `- [ ]` with a note underneath saying what is left. Delete an item
  only when a decision made it moot, and record what, who, date and why under `## Decisions` (R4) —
  never to make the list look finished, and never to un-file ticked work.
- Move the status line with the boxes. All-ticked plus `NOT STARTED` is drift.

### 5. Never un-file a finished PRD by rewriting it

Re-scoping is not a reason to pull a PRD out of `done/`. That deletes the ticked boxes and the
landed commits that justified them, and the work reads as never done.

When finished work needs more:

| Situation | Do this |
|---|---|
| Scope **grew** — new behaviour on top of what shipped | New PRD, citing the done one. The done PRD stays done. |
| Finished work **regressed** | Reopen the *same* file. Keep its ticked boxes and evidence. Add the new items unticked, and say in the status line what regressed and which commit or gate shows it. |
| The PRD was **misfiled** as done (status says `PARTIAL`/`NOT STARTED`) | Move it back and say so. This is the only clean un-filing. |

A `git mv` out of `done/` needs a line in the commit message naming what specifically regressed.
Before you believe a regression, re-run the PRD's own checks against current `main` — the 09-08
assessment recorded `doctor` exiting 1 on a missing prebuilt, which was PRD-264's phase 4 *working*,
not failing.

## One PR per PRD

**Exactly one pull request per PRD, opened as a draft before phase 1 starts.** Never one PR per
phase: phase-sized PRs split the evidence across branches nobody re-reads, and progress stops being
visible anywhere.

1. Cut the branch, open the draft PR with the PRD's checklist copied into the body, same order.
2. Push each phase to that same PR as it lands.
3. Tick the box in the PR body in the same push that ticks it in the PRD. The two must agree — a PR
   box ticked ahead of the PRD is the same lie as a claimed gate.
4. Re-label on every push (below).
5. When the last acceptance box is ticked, take the PR out of draft and `git mv` the PRD to
   `docs/PRDs/done/` **in that same PR**.

### Progress label

One label at a time, red through yellow to green, chosen by *verified phases* — never by lines
written or files touched.

| Label | Meaning | Colour |
|---|---|---|
| `prd:25%` | phase 1 landed and verified | `#d73a4a` red |
| `prd:50%` | half the phases landed and verified | `#e36209` orange |
| `prd:75%` | all but the last phase landed, **or** every phase in but acceptance boxes still open | `#fbca04` yellow |
| `prd:100% — ready` | every phase and every acceptance box ticked; PR out of draft | `#0e8a16` green |

`pnpm prd:progress <prd file>` computes the bucket and prints the label and colour. It reads the
PRD, so it cannot be talked into a number the boxes do not support.

Create the labels once per repository:

```sh
gh label create "prd:25%"          --color d73a4a --description "PRD phase 1 verified"
gh label create "prd:50%"          --color e36209 --description "PRD half the phases verified"
gh label create "prd:75%"          --color fbca04 --description "PRD phases in, acceptance open"
gh label create "prd:100% — ready" --color 0e8a16 --description "PRD complete, ready to merge"
```

Apply after each push:

```sh
LABEL=$(pnpm -s prd:progress <prd file> | sed -n 's/.*label *\(prd:[^ ]*\( — ready\)\?\).*/\1/p')
gh pr edit <number> --remove-label "prd:25%" --remove-label "prd:50%" \
                    --remove-label "prd:75%" --remove-label "prd:100% — ready" 2>/dev/null
gh pr edit <number> --add-label "$LABEL"
```

## Closing

- All boxes ticked and the status line says so → `git mv` to `docs/PRDs/done/` **in the commit that
  finishes it**, inside the PRD's own PR.
- **The only remaining work is `## Blocked on` items** (R6) → `git mv` to
  `docs/PRDs/BLOCKED/<reason>/`, the folder naming what unblocks it (`requires-physical-device`,
  `requires-release-credentials`, `requires-owner-decision`, …), then fix the links. The owner
  validates it later. With any doable work left the PRD stays where it is and lists its blocked
  items; only the last box is blocked, not the file.
- Try a blocked reason once and record what happened before filing under it; several have outlived
  their condition.
- Anything else — `PARTIAL`, `PROPOSED`, `NOT STARTED` — stays in its owning batch.

Grouped batches move whole, and never while any PRD in them is partial. A PRD that finishes ahead
of its siblings is archived on its own.

## Checklist for this skill

- [ ] `pnpm prd:progress <file>` exits 0 before work starts, and names no proof-less box
- [ ] Every compound acceptance criterion is split into one-claim boxes
- [ ] Every box names its `proof:`; out-of-reach work sits under `## Blocked on`, not in a box
- [ ] No ceremony boxes (revert check, reviewer PASS, evidence record, negative control, census)
- [ ] One draft PR open, PRD checklist copied into its body
- [ ] Each landed phase ticked in both PRD and PR, in the same push, with evidence beside it
- [ ] Progress label re-applied on every push
- [ ] PRD `git mv`d to `done/` in the same PR — or to `BLOCKED/<reason>/` when only blocked work is
      left — with the status line agreeing with the boxes
