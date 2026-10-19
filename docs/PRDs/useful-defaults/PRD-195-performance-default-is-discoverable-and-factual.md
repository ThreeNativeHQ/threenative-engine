---
prd_contract: v1
---

# PRD-195 — The performance default is discoverable and its workload facts are true

**Status:** NOT STARTED

**Priority:** P2 — Open boxes derive the scenario count from real files and correct drifted size claims.
**Complexity:** +3 for 10+ generated/document files = **3 → LOW mode**.

**Depends on:** PRD-189 through PRD-194. Land this last; instructions must not promise behavior the
tree does not yet ship.

## Context

The Charter says a convention absent from generated `AGENTS.md` does not exist. None of the seven
templates tells an agent to reuse frame scratch, pool recurring lifetime objects, keep measurement
on when overriding a default, or prove a performance claim with a bounded assertion. The shared
fragment system from PRD-151 is the incumbent and must be reused.

Two Charter facts also drifted: platformer has 22 playtest files, not 14, and “heaviest starter” is
true only by scenario coverage, not source LOC. Primary prose must follow the executable tree.
PRD-187 owns capability/supersession generation; this PRD adds one separate mandatory convention
fragment and does not edit its generated capability regions.

## Solution

- Add one concise mandatory fragment, `performance-default.md`, expanded into all seven template
  `AGENTS.md` files and mirrored to `CLAUDE.md`.
- State the actionable rule: retain vector/array scratch outside update methods; refill it; pool
  recurring bounded-lifetime objects; write HUD state only on change; use a bounded
  `performance` assertion.
- State the override rule: a deliberate allocation/look tradeoff is named beside the code and
  measurement stays active.
- Correct §10a to call platformer the reference template with the broadest scenario suite and say
  22 playtest files.

## Integration Ledger

| # | New/changed thing | Live caller | Replaces | Negative control |
| --- | --- | --- | --- | --- |
| 1 | Shared performance-default fragment | `sync-agent-docs.ts` expands seven template markers | absent convention | remove one marker → required-set spec red |
| 2 | Generated flat instructions | scaffolder copies each template `AGENTS.md` | no allocation guidance | hand-edit expanded block → `sync:agents --check` red |
| 3 | Correct Charter workload facts | readers and primary-doc gate consume §10a | 14/ambiguous “heaviest” | restore 14 → scenario-count spec red |
| 4 | Bounded assertion instruction | generated agent docs point at existing assertion reference | empty/absent intentions | replace bound example with `{}` → doc contract test red |

## Execution Phases

### Phase 1 — The fragment reaches starter and minimal

**Files (5):** add `agent-docs/performance-default.md`; EDIT the starter and minimal
`AGENTS.md` files plus their generated `CLAUDE.md` mirrors.

The fragment stays under 130 words and links to
`agent-docs/references/assertion-reference.md#performance` for the recipe. It names no appearance
default and no invented API. Both scaffolded projects receive a flat expanded copy.

### Phase 2 — Platformer and action-RPG consume the same fragment

**Files (5):** EDIT platformer/action-RPG `AGENTS.md` and generated `CLAUDE.md` mirrors; EDIT
`packages/create-threenative/__tests__/template.spec.ts` to require the fragment in these first
four templates.

Delete one marker and observe the required-set test naming that template.

### Phase 3 — Defense and racing consume the same fragment

**Files (5):** EDIT defense/racing `AGENTS.md` and generated `CLAUDE.md` mirrors; EDIT the
required-set test to include both.

Hand-edit one expanded region and observe `pnpm sync:agents --check` failing.

### Phase 4 — Shooter closes the seven-template required set

**Files (3):** EDIT shooter `AGENTS.md`, its generated `CLAUDE.md`, and the required-set test.

Scaffold all seven templates and verify a flat file with no shared markers.

### Phase 5 — Charter facts follow the executable workload

**Files (3):** `docs/architecture/CHARTER.md`,
`scripts/__tests__/primary-docs.spec.ts`, and
`docs/verification/prd-195-performance-convention-<date>.md` (EDIT/NEW).

- [ ] Derive the scenario count from `templates/platformer/playtests/**/*.playtest.json`.
- [ ] Replace the ambiguous size claim with the measured reason platformer is the reference.
- [ ] Keep the 2026-08-22 amendment line and its meaning unchanged.

## Verification

1. Run both red controls, restore, then `pnpm sync:agents && pnpm sync:agents --check`.
2. Run primary-doc and create-threenative focused specs.
3. Scaffold all seven templates and inspect the copied `AGENTS.md`/reference link.
4. Run root typecheck/lint/test/budgets and `pnpm test:templates`.

## Acceptance Criteria

- [ ] Every scaffolded template tells its agent how to avoid ordinary-frame allocation and how to
      prove the result with at least one explicit bound.
- [ ] The rule is authored once, expands to all seven templates, and any missing/stale copy fails.
- [ ] §10a reports 22 platformer playtest files from an executable count and no longer implies
      platformer has the most source LOC.
- [ ] The fragment's claims match completed PRD-189 through PRD-194 evidence; no future promise is
      presented as shipped behavior.
