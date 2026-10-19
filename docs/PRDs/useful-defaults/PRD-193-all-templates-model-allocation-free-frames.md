---
prd_contract: v1
---

# PRD-193 — All templates model allocation-free ordinary frames

**Status:** NOT STARTED

**Priority:** P2 — Open boxes remove per-frame allocation from six templates' movement, touch and HUD paths.
**Complexity:** +3 for 10+ files = **3 → LOW mode**. The work is split so each phase touches at
most five files.

## Context

Generated source is product source: a hitch in a scaffolded template is an engine defect. Minimal
passes; the other six allocate on ordinary feature frames. The audit names retained-vector clones,
debug snapshots, touch vectors, ranking arrays, projectile vectors, enemy aggro vectors, formatted
HUD strings and reduce/spread chains.

This is a template/game-source fix, not package plumbing. Appearance stays unchanged and every
scratch object remains generated user code under the template.

## Solution

- Hoist mutable vector/math scratch beside the generated entity that owns the frame loop.
- Replace allocation-heavy collection pipelines with bounded direct loops and reusable ranking/live
  buffers.
- Publish HUD/debug state only when its scalar values change; preserve the 100 ms state bridge.
- Pool only lifetime-bounded gameplay objects whose ordinary loop continuously spawns them, without
  moving geometry/material/timing into package code.

## Integration Ledger

| # | Changed workload | Live caller | Replaces | Negative control |
| --- | --- | --- | --- | --- |
| 1 | Starter/platformer frame scratch | their player/character update methods and touch controls | per-frame vector/debug/layout objects | restore one clone/new vector → allocation probe red |
| 2 | Racing ranking/checkline scratch | `Race.update`, `Ranking`, `Lap`, `TrackSector` | map/spread/sort/map and ray clones | restore pipeline → racing steady-frame probe red |
| 3 | Shooter/action-RPG scratch/pools | `Play.update`, projectile tick, enemy aggro | filters, projectile/enemy clones, formatted strings | restore one path → genre probe red |
| 4 | Defense counters/spawn reuse | `Defense.update` and wave spawn | two reduce spreads and churn | restore spreads → defense probe red |

## Execution Phases

### Phase 1 — Starter and platformer ordinary movement reuse scratch

**Files (5):** `templates/starter/src/entities/Player.ts`,
`templates/starter/src/scenes/Play.ts`,
`templates/platformer/src/entities/Character.ts`,
`templates/platformer/src/render/touch-controls.ts`,
`packages/create-threenative/__tests__/template-runtime-cost.spec.ts` (EDIT/NEW test).

- [ ] Keep player movement, dash direction and multi-touch output numerically identical.
- [ ] Do not call `debug()` or `Object.keys(snapshot())` every frame to derive stable counts.
- [ ] Reuse touch layout outputs at a stable viewport size; invalidate on resize.

### Phase 2 — Racing reuses ranking and gate math

**Files (5):** `templates/racing/src/track/Ranking.ts`, `Lap.ts`, `TrackSector.ts`,
`templates/racing/src/scenes/Race.ts`, and the runtime-cost spec (EDIT).

- [ ] Refill one ranking buffer and sort it in place; retain deterministic tie order.
- [ ] Reuse gate/ray vectors and avoid `toArray()`/template strings until the observed HUD changes.
- [ ] Preserve every existing boost, ranking, rescue, reverse and shortcut playtest.

### Phase 3 — Shooter and action-RPG reuse combat math

**Files (5):** `templates/shooter/src/scenes/Play.ts`,
`templates/shooter/src/weapons/Projectile.ts`,
`templates/action-rpg/src/entities/Enemy.ts`,
`templates/action-rpg/src/scenes/Play.ts`, and the runtime-cost spec (EDIT).

- [ ] Replace live-target filter/reduce chains with direct counters.
- [ ] Reuse projectile sweep and aggro visibility vectors.
- [ ] Quantize numeric state without intermediate `toFixed()` strings.

### Phase 4 — Defense counters and bounded attacker lifetime reuse

**Files (4):** `templates/defense/src/scenes/Defense.ts`,
`templates/defense/src/attackers/Attacker.ts`, the runtime-cost spec, and
`packages/create-threenative/__tests__/scaffold.spec.ts` (EDIT).

- [ ] Count tower scans/shots in one loop without spread arrays.
- [ ] Reuse attacker/path scratch and prove wave cleanup returns the retained set to baseline.
- [ ] Update scaffold path assertions only when a generated file is actually added or removed.

## Verification

Record `docs/verification/prd-193-template-frame-allocations-<date>.md`.

1. Add a deterministic 600-frame allocation probe per template; each original cited construct must
   make its own control red.
2. Run focused genre tests and every existing genre playtest on browser WebGPU.
3. Run `pnpm test:templates`; paste per-template scenario counts and adapter info.
4. Capture before/after frames only to prove appearance did not change; no visual “improvement” is
   part of acceptance.

## Acceptance Criteria

- [ ] All seven templates complete 600 ordinary frames with no generated-source allocation that
      scales one-for-one with frames after warmup.
- [ ] Gameplay observations and screenshots remain equivalent within existing tolerances.
- [ ] Spawned projectile/attacker storage stays bounded and returns to its warm high-water mark.
- [ ] The runtime-cost gate fails when any cited per-frame constructor/pipeline is restored.

