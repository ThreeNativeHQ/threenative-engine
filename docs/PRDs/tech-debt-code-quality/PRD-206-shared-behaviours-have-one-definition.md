---
prd_contract: v1
---

# PRD-206 — Shared behaviours have one definition

**Status:** NOT STARTED

**Priority:** P2 — Open boxes define the binding-tree walk and pointer conversion once instead of twice.
**Complexity:** +2 for 6–10 files, +2 multi-package (core, physics, navigation subpath),
+1 for the reachability semantics change = **5 → MEDIUM mode**.

## Context

Five scan findings where core/physics hand-copy behaviour that must not drift:

- **#18:** `pressed()`/`#latchedPressed()` walk the identical binding tree;
  `#isHeld`/`#isLatched` are the same 6-line function twice
  (`core/src/input.ts:291-317,403-439`, ~35 dup lines).
- **#20:** client→canvas pointer conversion hand-rolled twice
  (`core/src/game.ts:465` vs `replay.ts`; a comment admits the coupling).
- **#21:** `isSmallBufferError` regex duplicated — it *is* the native ABI error contract;
  a C++ message change breaks one backend silently (`physics/plugin.ts:94` ≡
  `physics/native/host.ts:208`).
- **#22:** `NavigationAgent3D.isTargetReachable` re-implements the target-path chain
  (`navigation/NavigationAgent3D.ts:254` vs `:184-252`) — a tolerance change can make
  "reachable" and "finishes" disagree.
- **#23:** physics plugin `sceneExit` and `dispose` are parallel teardown blocks
  (`plugin.ts:275-307`) — a new registry leaks asymmetrically if one is missed.

## Solution

- One private helper per duplicated behaviour; both call sites consume it. No public API
  growth unless the ledger demands it.
- `isTargetReachable` delegates to the same path chain `goTo` uses, with the tolerance as
  the only free parameter — "reachable" and "finishes" cannot disagree by construction.
- Teardown becomes one ordered routine invoked by both `sceneExit` and `dispose`.

## Integration Ledger

| # | Changed thing | Live caller | Replaces | Negative control |
| --- | --- | --- | --- | --- |
| 1 | Shared binding-tree walk | `pressed()`, latched variant in `input.ts` | twin walks + twin 6-liners | diverge one copy → input spec red |
| 2 | One pointer converter | game input path + replay driver | two conversions | replay drives a pointer event → coordinates identical to live path |
| 3 | Single ABI error matcher | web plugin error handling + native host | second regex | change fixture message shape → both consumers agree (one fails only together) |
| 4 | Delegating `isTargetReachable` | agent queries | re-implemented chain | shrink tolerance on one copy only → reachable-vs-finishes disagreement test red |
| 5 | Unified teardown routine | `sceneExit` + `dispose` | parallel blocks | add a scratch registry to one path only → leak test red |

## Execution Phases

### Phase 1 — Input and pointer single-sourcing (#18, #20)

**Files (4):** `core/src/input.ts`, `core/src/game.ts`, `core/src/replay.ts`, core specs
(EDIT).

- [ ] Binding-tree walk and held/latched check each defined once.
- [ ] Pointer conversion exported once; replay consumes it.
- [ ] Red first: paste the duplicate greps.

Mutation for red: reintroduce either local copy → its spec red.

### Phase 2 — Physics contracts and teardown (#21, #23)

**Files (3):** `physics/plugin.ts`, `physics/native/host.ts`, physics specs (EDIT).

- [ ] The ABI error matcher is exported from exactly one module.
- [ ] `sceneExit` and `dispose` call one ordered teardown; registry additions cannot skip
      a path.
- [ ] Leak test: register → exit vs register → dispose produce identical released sets.

Mutation for red: revert teardown to parallel blocks and add a fake registry to one —
leak test red.

### Phase 3 — Reachability is the path chain (#22)

**Files (3):** `navigation/NavigationAgent3D.ts`, navigation specs, parity/playtest case
(EDIT).

- [ ] `isTargetReachable` runs the same planner chain as movement with an explicit
      tolerance parameter.
- [ ] Disagreement test across tolerance values: no point where "reachable" is true but a
      issued target never reports finish.
- [ ] Red first: construct the tolerance divergence today, paste it.

## Verification

Record `docs/verification/prd-206-one-definition-<date>.md`.

1. Specs per phase with mutations pasted red.
2. Replay-drives-live proof for pointer math (same event through both paths, identical
   canvas coordinates).
3. Navigation scenario run on browser WebGPU asserting reachable ⇒ finishes across the
   tolerance sweep; desktop native run if the native lane is up, else marked unverified.
4. `pnpm typecheck && pnpm lint && pnpm test` green.

## Acceptance Criteria

- [ ] Each of the five behaviours has exactly one definition; duplication greps return
      empty.
- [ ] "Reachable" and "finishes" cannot disagree under any tolerance.
- [ ] Teardown coverage is structural: adding a registry without touching teardown fails
      the leak test.
- [ ] All mutations pasted red above.
