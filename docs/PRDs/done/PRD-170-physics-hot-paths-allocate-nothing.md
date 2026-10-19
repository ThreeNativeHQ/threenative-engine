---
prd_contract: v1
---

# PRD-170 — Physics hot paths allocate nothing per body per step

Complexity: 4 → standard

## Context

The physics package's own CLAUDE.md sets the bar: *"Kinematic input and visible transforms use
reusable typed-array records — keep the fixed-step crossing bulk-shaped, never per-object
per-frame."* The bulk ABI shape is right; the JS on both sides of it allocates anyway, every
step, per body:

1. **Read path.** `finiteTransform` (`packages/physics/src/RigidBody3D.ts:31-36`, duplicated
   verbatim at `CharacterBody3D.ts:60-65` and `Area3D.ts:67-72`) builds
   `Array.from({ length: 8 }, …)` + `.some(...)` — an array, a closure and a result tuple per
   call. `applyTransform` (`RigidBody3D.ts:167-174`) then stores `#lastPosition` as a fresh
   `{ x, y, z }`. Reached once per visible body/area per frame from
   `plugin.ts:195/200`.
2. **Write path.** Each `writeKinematic` builds an 8-element array literal then
   `buffer.set([...], offset)` — `RigidBody3D.ts:87-102`, `CharacterBody3D.ts:179-191`,
   `Area3D.ts:142-145` — once per kinematic body/character/area per frame
   (`plugin.ts:169/175/180`). `CharacterBody3D` additionally allocates a fresh `#desired`
   object per `move()`/`moveAndSlide()` (`:143`, `:162-166`, reset again at `:223`).
3. **Web character step.** `simulation.ts:869-916`: per character per step unpacks fresh
   objects, calls `translation()` (fresh Rapier vector), builds `setNextKinematicTranslation({...})`,
   and allocates the one-way-layer `filterPredicate` closure every step while moving up.
4. **Collision drain.** `simulation.ts:1115-1128` pushes `[left, right, Number(started), 1]`
   tuples per event; `plugin.ts:230-232` adds a `` `${left}:${right}` `` string key per started
   event. Proportional to active contacts.

At 60 Hz this is ~4–8 short-lived objects per dynamic entity per frame — tens of thousands of
allocations/sec in any populated scene, all of it minor-GC pressure on exactly the mobile
targets PRD-069 measured. Behaviour must not change by one bit: determinism is load-bearing.

## Solution

Per row, allocation-free equivalents with identical outputs:

1. One shared `readFiniteTransform(values, offset)` helper indexing the Float32Array directly,
   validating in a plain loop, writing into caller-provided storage; the three node classes use
   it. `#lastPosition` becomes three number fields mutated in place.
2. `writeKinematic` assigns `buffer[offset + n] = scalar` directly; `#desired` becomes a
   persistent field reset in place.
3. Module-level scratch records reused across steps in the web character loop (verify Rapier
   retains nothing returned by `translation()` before reusing buffers — if retention exists,
   keep that single allocation and say so); predicate hoisted to configuration time.
4. Drain writes straight into the caller buffer when capacity allows; pair keys become numeric
   (`left * 0x10000 + right` or equivalent collision-safe encoding documented at the site).

```mermaid
flowchart LR
  subgraph today["today: per body per step"]
    A1[Array.from + .some] --> A2[buffer.set literal]
  end
  subgraph after["after: zero allocations"]
    B1[indexed validation into scratch] --> B2[scalar buffer writes]
  end
  today ==identical outputs==>"determinism + parity specs stay byte-green"--> after
```

Data changes: none. ABI unchanged.

## Integration Ledger

| # | Thing built | Live caller | Replaces | May claim green when | Negative control |
|---|---|---|---|---|---|
| 1 | Shared read transform helper ×3 nodes | `plugin.ts:195/200` applyTransform loop | three duplicated allocating helpers | determinism spec byte-identical snapshots | restore `Array.from` in RigidBody3D → helper-count/allocation bench returns old figure |
| 2 | Scalar writeKinematic ×3 nodes | `plugin.ts:169/175/180` | array literals per body | parity + kinematic specs green | revert one node → bench shows its allocations return |
| 3 | Web character-step scratch | `simulation.step` character loop | per-step objects + closure | existing character/simulation specs green; step output values identical on a fixture | restore per-step construction → bench delta |
| 4 | Numeric contact keys | `plugin.ts:230-232` | string keys per event | area event specs green (enter/exit fire once each) | revert keying → duplicate-event assertion red |

## Execution Phases

### Phase 1: rows 1–2 (node classes)

**Files (7):**

- `packages/physics/src/RigidBody3D.ts` - EDIT: shared helper + applyTransform + writeKinematic.
- `packages/physics/src/CharacterBody3D.ts` - EDIT: same two + `#desired` reuse.
- `packages/physics/src/Area3D.ts` - EDIT: same two.
- new `packages/physics/src/transformRecord.ts` - NEW: the shared helper (module-local; not exported from index).
- `packages/physics/__tests__/` relevant specs - EDIT only if fixture coverage gaps appear.
- `scripts/bench-physics-allocations.mjs` (location per executor judgement under `scripts/`) - NEW: allocation counter harness.
- `docs/verification/prd-170-physics-allocations-<date>.md` - NEW.

**Tests Required:**

| Test File | Test Name | Assertion | Negative control |
|---|---|---|---|
| `__tests__/determinism.spec.ts` (existing) | unchanged suite | byte-identical `takeSnapshot()` results as at parent commit | n/a — this is the no-behaviour-change gate |
| `__tests__/parity.spec.ts` (existing) | unchanged suite | web/native tolerances hold | n/a |
| allocation bench | objects allocated across N fixed steps at 100 bodies | post-fix count ≤ pre-fix count minus the removed sites (numbers pasted) | restore row 1's `Array.from` line → count returns |

### Phase 2: rows 3–4 (simulation internals)

Same file set plus `packages/physics/src/plugin.ts`; same gates; area enter/exit event specs are
the behavioural pin for row 4.

**Verification Plan:** focused physics suite → `pnpm typecheck && pnpm lint && pnpm test` →
allocation bench before/after recorded with raw counts in the verification file → one browser
playtest exercising physics (any template platformer scenario) green. Native-side numbers are
NOT claimed (the native backend already bulk-caches; this PRD is the JS side).

**User Verification:** run the platformer example; movement and pickups behave identically.

## Acceptance Criteria

- [ ] Determinism and parity suites pass unmodified (byte-identical snapshots on the same machine).
- [ ] Allocation bench shows each row's removal with pasted numbers; every negative-control revert observed red.
- [ ] No public API or ABI change; `raw` semantics untouched; no new export leaves the package.
- [ ] `pnpm typecheck && pnpm lint && pnpm test` pass.

## Checkpoint Protocol

Bench numbers before/after per row, red observations for each revert check, suite outputs. A row
whose allocation claim is not measured is UNVERIFIED.

## Results — 2026-08-22

EXECUTED (`2c772580`). All four rows landed; determinism + parity byte-identical, 136/136.
Measured verdict recorded honestly: hot-path allocations were already ~0.12 MB per 6,000 steps
and sit below instrument resolution end-to-end — claimed as hygiene, not frame time. Numeric
contact keys rejected (Uint32 pairs exceed safe integer range; BigInt allocates more than the
string). Evidence incl. bench numbers:
`docs/verification/runtime-perf-state.md`.
