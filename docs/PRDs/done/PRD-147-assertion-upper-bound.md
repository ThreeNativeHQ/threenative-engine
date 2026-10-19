---
prd_contract: v1
---

# PRD-147 — No resource assertion can express an upper bound, so a countdown cannot be asserted to count down

**Status: DONE, 2026-08-18.** `lte` is parsed through the shared numeric-key definition and the
generated template countdown bound passes. See [batch verification](../../verification/fps-friction-batch-2026-08-18.md).

**Outcome:** `lte` exists beside `gte`, and a scenario can state that a timer went down, health
dropped, or ammunition was spent — instead of stating only that the number moved.

**Depends on:** nothing.

**Blocks:** nothing. [PRD-136](PRD-136-scaffolded-gate-survives-first-edit.md) §3
already flagged this gap from the other direction, and its replacement assertion is weaker because
of it. Landing this first lets 136 ship the bounded version.

**Complexity: 2 → LOW mode.** One key in three validators and one comparison.

**Blast radius: 4 files.** `packages/playtest/src/scenario.ts`,
`packages/playtest/src/assertions.ts`, one `__tests__` spec, and the generated `AGENTS.md`.

---

## 1. The defect

`packages/playtest/src/scenario.ts:1507`:

```ts
rejectUnknownKeys(record, ["changed", "equals", "gte", "path", "textIncludes"], ...);
```

`gte` and no `lte`. The same asymmetry appears at `scenario.ts:1069` and `:1388`. A scenario that
tries the obvious thing gets:

```
TN_PLAYTEST_SCENARIO_INVALID: Unknown key 'lte' at assert.resources[5].lte
```

The harness is right to reject an unknown key — that is fail-closed working. What is wrong is that
the key is unknown.

The consequence, from the PRD-137 ledger: a 60-second countdown could only be asserted as
`changed: true`, and its **direction was checked by eye in the JSON result**. A clock running
*backwards* would pass. So would a clock that jumped to 900.

`PRD-136` hit the same wall from the other side and wrote it down:

> An upper bound of `1` is not expressible with `gte` alone. Either add the symmetric bound to the
> resource assertion in `@threenative/playtest` … or accept `gte: -1` plus `changed` and say in
> the scenario's own comment that the upper bound is unasserted.

Two independent pieces of work reaching for the same missing key is the signal that it is missing.

**Name the layer. This is an engine bug in the harness** — an assertion vocabulary that cannot
express half of the comparisons games need, in a harness whose entire purpose is that assertions
are real.

## 2. The fix

Add `lte` everywhere `gte` is accepted — all three `rejectUnknownKeys` sites, the parse, and the
evaluation. `gte` and `lte` together are a closed interval, which covers every bound anyone in this
repository has reached for.

### 2.1 Shape constraints

Read the batch README's shape rules first. Specifics:

- **DRY.** Three call sites list the accepted keys today and each would need `lte` added
  separately. That duplication is the reason the gap is in three places at once — extract the
  shared numeric-comparison key set to one constant and have all three use it. **A fix that adds
  `"lte"` to three string arrays and stops there has fixed the symptom.**
- **KISS.** `lte` only. Not `lt`, not `gt`, not `ne`, not `between`, not a `range` object, and not
  a comparator string (`"<="`). Strict inequality has no caller and floating-point equality
  boundaries are a trap; `gte` + `lte` is the whole interval.
- **Symmetry as the rule.** After this, any future numeric assertion key ships with its mirror in
  the same commit. That is the actual lesson — the gap existed because one direction shipped alone.

## 3. Acceptance

| # | Command | Required result |
| --- | --- | --- |
| 1 | `pnpm vitest run packages/playtest/src/scenario.test.ts` | pass — `lte` parses at all three sites; `gte` + `lte` together bound an interval; a value above `lte` **fails** the assertion |
| 2 | same spec, trivial-assertion row | `lte` obeys the existing trivial-assertion guard the same way `gte` does — a bound that cannot fail must still be caught |
| 3 | `grep -c '"gte"' packages/playtest/src/scenario.ts` vs the shared constant | the accepted-key list exists **once**, not three times |
| 4 | `pnpm typecheck && pnpm lint && pnpm test` | exit `0` |
| 5 | rewrite the PRD-137 build's timer assertion as `{ "path": "timeRemaining", "lte": 59.9, "gte": 0 }` and run it | pass — and a deliberately inverted clock **fails** it |
| 6 | `pnpm test:templates` | exit `0` |

Row 5's second half is the point. An assertion nobody has watched fail is an assertion nobody has
tested.

## 4. What this does not claim

Not that the assertion vocabulary is otherwise complete. `anyOf`, `atSteps`, `throughoutSteps` and
`allowTrivial` interact in ways nobody has enumerated, and this PRD adds one key rather than
auditing the set. Not that PRD-136's replacement assertion is automatically upgraded — that is a
one-line follow-up in that PRD, and it should be made explicitly rather than assumed.
