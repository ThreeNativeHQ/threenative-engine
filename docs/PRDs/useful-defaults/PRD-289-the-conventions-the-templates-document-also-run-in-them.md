---
prd_contract: v1
---

# PRD-289 — the conventions the templates document also run in them

**Status: PARTIAL — verified 2026-09-02; AC4 remains open because the visual score manifest is
missing `sailing`.** See the [recovery verification record](../../verification/PRD-289-conventions-2026-08-31.md).
Part of the [useful-defaults batch](./README.md). Depends on nothing; the code it needs already
ships.

**Priority:** P2 — Open ACs add the applicability table, real call sites, the drift gate and a visual score.
**Goal: a scaffolded game arrives with the framework's conventions already running in its own
source, so the first thing a cold agent reads is a working call site rather than a promise.** Feet
meet the floor, one metre is one metre, and a weapon stays in the hand that holds it — in the
generated project, before anyone asks.

The convention implementation and generated-template evidence are recorded above. The remaining
visual evidence is exact: `pnpm visuals` captured nonblank frames for all eight current templates
but exited with `TN_VISUAL_SCORE_TEMPLATES_MISMATCH: missing sailing; stale none` because
`docs/verification/visuals/scores.json` has seven template scores while the gate requires eight.
No human score or visual baseline was fabricated or changed.

## The gap, verified in this tree

The charter's convention clause is that a convention ships on by default, *working and discoverable
before any game asks*, and that **a convention missing from the templates' `AGENTS.md` does not
exist**. The templates satisfy the second half and fail the first:

| symbol | `templates/*/AGENTS.md` | `templates/*/src/` |
| --- | --- | --- |
| `GroundSnap` | 7 of 7 | **0 of 7** |
| `normaliseToMetres` | 7 of 7 | **0 of 7** |
| `attachToBone` | 7 of 7 | **0 of 7** |
| `AnimationPlayer` | 7 of 7 | **0 of 7** |
| `CharacterBody3D` | 7 of 7 | 8 files |

```sh
grep -rl GroundSnap packages/create-threenative/templates/*/AGENTS.md | wc -l   # 7
grep -rl GroundSnap packages/create-threenative/templates/*/src/     | wc -l   # 0
```

`CharacterBody3D` is the control: a convention a template cannot run without does reach `src/`. The
other four are exactly the ones a game works *without* — badly, and invisibly. A character whose
feet sink into the floor still renders; an asset scaled by eye still renders; a rifle parented to a
root bone still renders. The failure mode of every one of these conventions is a game that looks
slightly wrong and reports nothing, which is the failure mode an agent cannot see in a screenshot.

**This is a template defect, not an engine one.** `GroundSnap`, `normaliseToMetres` and
`attachToBone` all exist, are exported, are in `capabilities.json` with plain-words situations
(*"keep a character's feet on the floor"*, *"make a character exactly 1.8 metres tall"*, *"put a
weapon in a character's hand"*), and are unit-tested. Nothing needs to be built. The work is seven
integrations and one gate that keeps them there.

## Scope

**In:** a live call site for each of the four symbols in every template whose content has a
character, a prop with a real-world size, or a held object; the `enabled: false` / override path
exercised where the template genuinely wants the authored pose; a gate that fails when a template's
`AGENTS.md` names a convention its `src/` never calls.

**Out:** new engine surface of any kind; changing what any convention does; adding a character to a
template that has none — a template with no skinned content is recorded as N/A with its reason, not
given one to satisfy a table.

## The question Phase 0 answers before anything is built

For each of the seven templates, which of the four conventions is *applicable*? A racing template
has no crown bone and a defense template may hold nothing. Phase 0 writes the applicability table
first, with a one-line reason per cell, and **the table is the acceptance surface** — an N/A with a
reason is a pass, an N/A with no reason is a fail. Getting this backwards produces four ceremonial
calls per template that do nothing, which is worse than the gap.

## Acceptance criteria

- [ ] **AC0 — the applicability table exists and is reasoned.** Seven templates × four conventions,
      every cell either a file-and-line call site or an N/A with a one-line reason.
- [ ] **AC1 — the calls are real.** Every applicable cell resolves to a call in `src/` whose effect
      is observable: `GroundSnap.clearance` is finite and its magnitude falls after `apply()`,
      `normaliseToMetres` returns a factor other than 1 on the asset it is given, `attachToBone`
      resolves a named bone that `skeletonBones` reports. *Mutation:* delete the call and the
      template's own spec fails, not a framework spec.
- [ ] **AC2 — the drift gate.** `scripts/` gains a check that reads each template's `AGENTS.md` for
      the convention names it claims and fails when the matching `src/` has no call and the
      applicability table has no N/A row. *Mutation:* remove one call site from one template and
      the gate reports that template and that symbol by name.
- [ ] **AC3 — turning it off does not turn the measurement off.** At least one template runs a
      convention with its correction disabled and still reports the measurement — the charter's own
      clause, exercised in generated source rather than asserted in a package test.
- [ ] **AC4 — no visual regression.** `pnpm visuals` against the current baselines, and any changed
      frame is either explained and re-baselined or the change is reverted. Feet that were floating
      and now are not is an expected diff and is recorded as one.
- [ ] **AC5 — every gate.** `pnpm typecheck && pnpm lint && pnpm test` exits 0 and
      `pnpm test:templates` executes all seven generated projects.
- [ ] **AC6 — the record.** One dated file in `docs/verification/` naming the applicability table,
      the commands, and every template that was scaffolded and run.

## What not to do

- Do not add a character, a skinned asset or a held prop to a template so that a convention has
  something to grip. The applicability table exists to make that unnecessary.
- Do not move any of these into `packages/core` as an automatic behaviour applied to every loaded
  model. Which object is a character, what its height is, and which bone holds the weapon are the
  game's facts; a framework that guesses them owns the look.
- Do not satisfy AC2 with a grep for the symbol in a comment. The gate reads call sites.
- Do not re-baseline a visual diff without saying what moved and why.
