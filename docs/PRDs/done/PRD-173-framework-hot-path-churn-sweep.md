---
prd_contract: v1
---

# PRD-173 — Framework hot-path churn sweep: seven small per-step costs

Complexity: 5 → standard (many small items; each is independently revertible)

## Context

Seven verified per-step/per-call costs in `packages/core`. Individually microseconds;
collectively they are the constant GC churn every game pays at loop rate. Each row below names
its evidence, its fix shape, and its own negative control. A row may be dropped if its
revert-check cannot be made red — record it as dropped, do not half-apply it.

| # | Site | Evidence | Fix shape |
|---|---|---|---|
| 1 | `Registry.queueFree(object)` | `entities.ts:106-111` `#nameOf` linear-scans the whole named map per call; templates call it per entity death (`platformer Patrol.ts:56`, `Pickup.ts:42`) | WeakMap object→name side index maintained in register/remove/clear |
| 2 | `Scheduler.tick` | `schedule.ts:95` `[...this.#entries]` copy per tick, empty or not | iterate the Set directly bounded by a start-of-tick count (Set iteration is delete-safe; bounding preserves "added during tick fires next tick") — pin that semantics with a test before relying on it |
| 3 | `Registry.sweep` | `entities.ts:67` `[...this.#pendingFree]` copy per step (sweep runs unconditionally, `game.ts:564`) | drain via iterator or swap-with-fresh-set only when non-empty |
| 4 | `InputMap.tick` | `input.ts:313-320`: `#source().find(...)`, `Array.from(axes)`, `buttons.map(...)`, `Object.keys(#bindings)` per tick; `vector(name)` allocates per call (`:227-239`) | freeze binding keys at construction + dirty flag if bindings are mutable (check first); reuse axes/buttons buffers; scratch Vector2 for vector() |
| 5 | Replay plugin sampling | `replay.ts:109` `[...keys].sort()` per tick; `:21-31` `getBoundingClientRect()` + string `join()` compares per tick | cache rect on enter/resize; compare pointer tuples numerically; sort only when key set changed (length+membership fast path) |
| 6 | `GroundSnap.apply` | `grounding.ts:45-70`: up to 3–4 forced subtree `updateWorldMatrix(true, …)` passes per grounded character per frame (posedBounds already performs one) | reuse the pass posedBounds performed; drop redundant updates. Verify against pose.ts's envelope contract first — if a second pass is load-bearing for skinned bounds, keep exactly one and say which |
| 7 | Playtest bridge snapshots | `playtest.ts:330-338` `findEntityId` calls `ctx.entities.snapshot()` per contact event inside `drainContacts`; harness-time only | one snapshot per drain + identity→id map |

Clean by audit (do not expand scope): tracers, particles, animation fades, viewport/resize,
prewarm, audio — all cold or already pooled.

## Solution principles

Zero behaviour change except where a semantics test *first* pins today's edge behaviour
(rows 2 and 5). No public API changes anywhere in this PRD. Scratch objects live at module
scope in core only where single-threaded use is guaranteed by construction (the loop is).

Data changes: none.

## Integration Ledger

| # | Thing built | Live caller | Replaces | May claim green when | Negative control |
|---|---|---|---|---|---|
| 1 | queueFree side index | template despawn paths | O(n) reverse scan | lookup test at 500 entities: queueFree cost independent of n | remove WeakMap maintenance → deep-entity lookup test red (or timing bound red) |
| 2 | copy-free scheduler tick | `game.ts:556` scheduler.tick | per-tick array copy | same-tick-add test pins next-tick firing; suite green | naive direct iteration without bound → same-tick firing test red |
| 3 | cheap sweep | `game.ts:564` | per-step spread | idle-game allocation bench shows the drop | restore → bench returns |
| 4 | input.tick buffers | `onUpdate` first line (`game.ts:555`) | per-tick arrays + Object.keys | input specs green incl. gamepad connect mid-session (dirty-flag case) | mutate buffer reuse to alias retained state → spec red |
| 5 | replay rect/tuple cache | replay plugin beforeUpdate | per-tick DOM query + joins | replay round-trip spec green; resize-mid-recording test shows correct coords | stale-rect mutation → resize test red |
| 6 | GroundSnap single pass | grounding callers in templates | 3–4 forced passes | grounding specs green; one visual check of a grounded character unchanged | over-dedup mutation → pose correctness spec red |
| 7 | bridge snapshot memo | playtest observations | snapshot-per-event | contact-heavy scenario sample output identical | memo-across-drains mutation → differing-contact assertion red |

## Execution Phases

### Phase 1 — rows 1–4 (framework loop)

**Files:** `entities.ts`, `schedule.ts`, `input.ts` (+ their existing specs), allocation-bench
script, `docs/verification/prd-173-churn-<date>.md`.

### Phase 2 — rows 5–7

**Files:** `replay.ts`, `grounding.ts` (+ `packages/playtest/src/three/pose.ts` read-only
verification), `playtest.ts` (+ specs), verification record update.

**Tests Required:** per-row as ledgered above; every row's negative control observed red before
green. Semantics-pinning tests for rows 2 and 5 land **before** their optimisations.

**Verification Plan:** focused core suites → `pnpm typecheck && pnpm lint && pnpm test` →
allocation bench before/after with raw numbers → platformer template playtest (exercises 1/4/6)
and one replay scenario (row 5) green under xvfb webgpu recipe.

**User Verification:** starter template plays identically: movement, pickups despawn, HUD fine.

## Acceptance Criteria

- [ ] Every landed row has an observed-red negative control and a pasted green.
- [ ] Dropped rows (if any) recorded in the verification file with the reason.
- [ ] Bench table: allocations per 1,000 fixed steps before vs after, per row.
- [ ] No public API change; no new exports.
- [ ] `pnpm typecheck && pnpm lint && pnpm test` pass.

## Checkpoint Protocol

Per row: red paste, green paste, bench delta. A row without its red is UNVERIFIED even if green.

## Results — 2026-08-22

EXECUTED (`01dd5f3e`, `6f55cdc2`). Six rows landed; scheduler semantics pinned by a test written
before its rewrite; bridge drain's first identity-keyed attempt caught red by the contact spec.
Replay viewport cache REJECTED with its failing test as evidence — a canvas can move without an
observable signal, and a stale offset corrupts recordings; only string joins became numeric.
Core 315/315, root 1587/1587. Evidence:
`docs/verification/prd-173-churn-2026-08-22.md`.
