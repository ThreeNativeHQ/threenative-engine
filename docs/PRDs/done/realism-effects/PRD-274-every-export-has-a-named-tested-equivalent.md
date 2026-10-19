---
prd_contract: v1
---

# PRD-274 — every `realism-effects` export has a named, tested equivalent, and the mapping is a gate

**Status:** PROPOSED — filed 2026-08-30, measured at `1eeecf1e`. Depends on
PRD-266,
[PRD-273](./PRD-273-the-three-effects-with-no-upstream-node-ship-as-template-source.md). Batch:
[docs/PRDs/realism-effects](./README.md).

**Goal: "we support everything that library does" is a claim a gate can check.** Today it is a
sentence in a README, and a README sentence is exactly the kind of claim this repository has
learned not to trust.

**Complexity:** one coverage table turned into a fixture, one AO comparison run, one gate =
**MEDIUM**. The gate is easy; the AO row is the part with a real question in it.

## The problem, measured at `1eeecf1e`

### 1. The coverage claim is prose, and prose drifts

[The batch README](./README.md) maps all fourteen exports of `0beqz/realism-effects` to what this
stack runs instead. Ten land on `three@0.185.1` TSL nodes already installed, three become
template source under
[PRD-273](./PRD-273-the-three-effects-with-no-upstream-node-ship-as-template-source.md).

Nothing enforces it. `three` moves with the `catalog:` in `pnpm-workspace.yaml`; a node renamed or
removed upstream silently empties a row. A template that drops an effect empties another. The
repository already lives with the general version of this problem — the root charter's own line is
that a convention missing from the templates' `AGENTS.md` does not exist, and
`scripts/__tests__/primary-docs.spec.ts` exists because prose and code drift apart.

### 2. One row is not a mapping, it is a decision

`HBAOEffect` is exported by `realism-effects`. `three/addons/tsl/display/` ships `GTAONode` and no
HBAO. GTAO and HBAO are different ambient-occlusion algorithms — ground-truth-based versus
horizon-based — and GTAO is generally the successor, but "generally" is not a result and this
repository does not accept one.

Either GTAO covers the need, in which case the row is *satisfied by substitution* and the evidence
is a comparison, or it does not, in which case HBAO gets written in TSL. The row cannot be closed
by assertion in either direction.

### 3. Coverage is not the same as reachability

The framework's stated quality measure is friction per cold-agent build, and the capability
manifest (`packages/create-threenative/capabilities.json`) is the only complete list of the public
surface an agent can search. An effect that exists but is absent from the manifest is an effect the
agent building a game will hand-write instead — the failure the manifest was created to stop, the
one that once cost 446 lines and 9 FPS.

So a covered row must also be a *findable* row, searchable by plain-words situation.

## What ships

- **A coverage fixture**, one row per `realism-effects` export, each naming its equivalent: a
  `three/addons/tsl/display/` node, a template source module from
  [PRD-273](./PRD-273-the-three-effects-with-no-upstream-node-ship-as-template-source.md), or an
  explicit, dated, reasoned `not covered` with the decision recorded. There is no fourth kind of
  row and no blank cell.
- **A gate over that fixture** — each row asserts its equivalent actually resolves: the upstream
  node imports and constructs, or the template module exists and exports. Fail closed: an unknown
  export name, a missing equivalent, or an empty reason throws. A row that cannot be checked is a
  failure, not a skip.
- **The AO row, decided by measurement.** GTAO and the `realism-effects` HBAO are run over the same
  fixture scenes, compared with `scripts/score-blind.ts` so the judgement is blind, and the result
  is recorded in `docs/verification/`. If GTAO wins or ties, the row closes as satisfied by
  substitution and no HBAO is written. If HBAO wins by a margin the record names, it is ported to
  TSL under this PRD.
- **Manifest entries** for everything the mapping claims — `pnpm build` regenerates
  `capabilities.json` with each effect searchable by situation (*"make the image sharper"*,
  *"soften contact shadows"*, *"add glints to highlights"*), and the gate asserts every covered row
  has one.
- **The mapping table in the README generated from the fixture**, not typed beside it. The README
  is the human-readable view; the fixture is the truth. Hand-maintained parallel lists in this
  repository have drifted before.

## Acceptance criteria

1. **Every export is a row, and an unlisted export fails.** The fixture is checked against
   `realism-effects`' pinned export list; adding a name to that list without a row fails the gate.
   *Mutation:* let an unmatched export fall through and the gate goes green on incomplete coverage.

2. **A row whose equivalent does not resolve fails, naming the row.** *Mutation:* rename an
   upstream node in a local patch fixture and the gate must fail naming that row rather than
   throwing an unhandled import error — a failure that does not name the row is not a usable gate.

3. **A `not covered` row requires a reason and a date, and an empty one throws.** *Mutation:*
   accept a blank reason and the fail-closed spec goes green.

4. **The AO decision is recorded with its comparison, not asserted.** `docs/verification/` carries
   the blind-scored GTAO-versus-HBAO run with the scenes, the scores and the verdict. *Mutation:*
   close the AO row without the record present and the gate fails on the missing evidence — a
   result that lives only in a commit message does not exist.

5. **Every covered row is findable in the capability manifest.** The gate asserts a manifest entry
   per covered row, with a situation string. *Mutation:* drop an entry and the gate fails; a
   capability absent from the manifest does not exist to the agents that build with it.

6. **The README table is generated.** Regenerating produces no diff on a clean tree. *Mutation:*
   hand-edit a cell and the regeneration check fails.

## Out of scope

Porting the ten upstream-covered effects — they are already installed and
[PRD-267](../../useful-defaults/PRD-267-screen-space-gi-ships-in-the-templates.md) wires them into templates.
Native execution, which is
[PRD-275](./PRD-275-every-effect-runs-on-every-target-or-it-does-not-ship.md) — this PRD proves the
equivalent *exists*, that one proves it *runs everywhere*. Coverage of any library other than
`0beqz/realism-effects`; a second shortlist repo is a second batch.

## Verification

`pnpm typecheck && pnpm lint && pnpm test`; `pnpm budgets` with the new gate; the blind AO
comparison filed in `docs/verification/` as one file for the run; `pnpm build` regenerating
`capabilities.json` in the same commit. The generated README table diffed clean.
