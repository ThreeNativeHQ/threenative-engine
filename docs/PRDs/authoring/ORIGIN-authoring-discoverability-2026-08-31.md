# Origin note — the authoring layer cannot find what the engine already has, 2026-08-31

**Status: OPEN — filed 2026-08-31 against `77a68bec`. Nothing in this batch has been executed.**

**The five authoring PRDs stay in this category.** PRD-297, PRD-298, PRD-300 and PRD-301 were
temporarily grouped into the 2026-09-04 astra batch and returned here on 2026-09-05; PRD-299
remained here because it still needs an owner ruling before anyone starts it. This note keeps its
original argument — the sequencing, the closed-door boundary and the sealed-corpus ruling below
bind all five PRDs.

The charter's thesis is one sentence, quoted from the v1 assessment:

> An LLM's greatest strength is writing code in languages already in its weights.
> Its greatest weakness is discovering bespoke API surfaces.

Every closed door in the charter's "Not building" table is a consequence of that sentence — an IR,
a scene format, an ECS, a bespoke CLI, **a recipe/preset/genre system** — each one spends the
training-data advantage to buy a surface the model then has to discover. The framework's answer is
the capability manifest: 210 entries, 446 authored `@situation` phrases, one MCP server, generated
from doc tags so it cannot drift from the code.

**That answer has never been measured, and it is measurably weaker than assumed.**
`docs/verification/capability-recall-baseline-2026-08-31.md` records the run:

- **11 of 46 (24%)** mechanic bullets in this repository's own sealed sweep briefs
  (`docs/benchmark/genres/*/brief.md`) return **zero** capabilities.
- `tower defense game` and `make a platformer with double jump` return **zero** — while
  `templates/defense/` and `templates/platformer/` ship.
- `save the player progress` returns **eight** capabilities, none of them relevant, ranked with
  no confidence signal — because the only filter is `score > 0`.
- `@threenative/assets` has **zero** manifest entries. The BC7 divisible-by-4 rule, which the
  pipeline reports as `0 fail` and WebGPU then rejects at draw time, is not discoverable at all.

The failure this repository already paid for is on record in the root `AGENTS.md`: *"A game once
hand-wrote 446 lines that were already installed, and ran at 9 FPS."* Search that returns nothing
produces exactly that. Search that returns eight wrong things produces something worse — a
confident wrong abstraction.

## The boundary this batch does not cross

`docs/architecture/CHARTER.md` closes **a recipe/preset/genre system** with evidence: *"0 of 7
presets ever reproduced their genre."* That door stays closed and this batch does not touch it.

The distinction the batch is built on, stated once so no phase can blur it:

| Closed, and stays closed | What PRD-299 adds |
| --- | --- |
| A preset that **generates** code for a genre | An index that **returns symbols that already exist** |
| A genre that ships a runtime abstraction | No runtime surface, no export, no new vocabulary |
| A recipe the game inherits | A pointer to a template `AGENTS.md` the agent reads and then writes its own game |
| Scaffold-time behaviour | Read-only MCP answer, same tier as `engine_capability_detail` |

If a phase of PRD-299 finds itself adding an export, a scaffold flag, or a runtime type, that
phase has crossed the line and must stop. The owner ruling requested on that PRD is exactly this
distinction, not the feature.

## Sealed-corpus hazard, ruled once for the whole batch

`docs/benchmark/genres/*/brief.md` are sweep **inputs**, hashed into `briefHash`
(`scripts/make-sandbox.ts:252`), and `proof/` beside them is sealed. They are the best recall
corpus in the tree and they must never reach a shipped artifact:

- brief text may be read by **repo-only** gates (PRD-297's corpus, PRD-299's held-out validation);
- brief text may **never** be written into `capabilities.json`, either copy, because that manifest
  installs into the sandbox the sweep measures — an arm would read its own brief's answers out of
  the engine it is being scored on.

Every PRD below restates this as an acceptance criterion. A phase that violates it invalidates the
self-improvement loop, not just the phase.

## Order, and why it is this order

| # | PRD | State | Why here |
| --- | --- | --- | --- |
| 1 | [PRD-297 — recall is a number this repository reports](../done/PRD-297-capability-recall-is-a-measured-number.md) | DONE | The instrument. Nothing below can paste a red without it, and 24% is invisible until it exists. Half a day. |
| 2 | [PRD-298 — search that fails closed and can say "not ours"](./PRD-298-capability-search-fails-closed.md) | OPEN | The cheapest correction, and the only one that removes harm rather than adding reach. Eight wrong answers is a defect today. |
| 3 | [PRD-300 — one capability, many phrasings](./PRD-300-capability-vocabulary-expansion.md) | OPEN | Widens recall inside the existing mechanism. Runs after 298 so the new hits are thresholded, not added to the noise. |
| 4 | [PRD-301 — every shipped package is in the manifest](./PRD-301-manifest-covers-every-shipped-package.md) | OPEN | Closes the holes 297 exposes. Independent of 299; can run in parallel with 300. |
| 5 | [PRD-299 — a request decomposes into mechanics before it searches](../BLOCKED/requires-owner-decision/PRD-299-request-decomposition-index.md) | OPEN, **needs an owner ruling first** | The largest change and the one nearest the closed door. Runs last so it is built on a measured, thresholded, fully-covered search rather than compensating for one. |

PRD-297 is a hard dependency of all four others: each of them states its acceptance in terms of
the corpus recall number, and none of them may be filed done without a before/after from
`pnpm caps:recall`.

## What this batch deliberately does not do

- **No change to how capabilities are authored.** `@situation`, `@constraint`, `@example`,
  `@override` and `@supersedes` stay as they are; PRD-300 adds one tag beside them and no more.
- **No second manifest.** Everything lands in `capabilities.json` and its `packages/core` mirror,
  generated by `scripts/build-capability-manifest.ts`. A hand-maintained parallel list is the
  drift failure this repository has already logged five times.
- **No downstream authoring claim.** This batch measures and improves *retrieval*. Whether better
  retrieval produces better games is a sweep question (`pnpm sweep:pair`), and no PRD here claims
  it. PRD-299 §7 names the sweep arm that would test it as follow-up work, unowned.
