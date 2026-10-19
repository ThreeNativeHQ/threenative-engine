---
prd_contract: v1
---

# PRD-192 — Result-bearing math pays for the result, not hidden temporaries

**Status:** NOT STARTED

**Priority:** P2 — Reuse math temporaries in picking, PathFollow3D and NavigationAgent3D.
**Complexity:** +2 for 6–10 files, +2 for retained-result semantics, +2 for core/physics changes =
**6 → MEDIUM mode**.

## Context

Four WARM surfaces allocate hidden work each feature frame: picking creates roots/exclusion/sort
temporaries; `PathFollow3D` clones point/tangent vectors; viewport projection clones both input
and output; `NavigationAgent3D` clones steering vectors and creates crowd-sync records.

These APIs return values callers may retain. Reusing a returned object silently would corrupt prior
results—`picking.spec.ts` already asserts that one `raycastAll` result survives the next query.
The contract is therefore: default calls may allocate the owned result, while all internal
temporaries reuse storage; target-taking overloads, borrowed from Three.js, let frame loops allocate
nothing at all.

## Solution

- Add optional output targets to result-bearing vector methods using Three.js parameter order and
  names; default behavior remains retention-safe.
- Reuse instance-owned point/tangent/project/ray scratch internally.
- Keep one roots array, empty exclusion set and comparator function per `ScenePicker`; fill a
  caller target for `raycastAll` when supplied.
- Reuse navigation's return/crowd records without changing path or avoidance semantics.

## Integration Ledger

| # | Changed thing | Live caller | Replaces | Negative control |
| --- | --- | --- | --- | --- |
| 1 | Picker scratch and optional target | `game.ts` wires `ctx.raycast(All)`; defense/fps examples call it | roots array, empty set, comparator, defensive copy | restore a local temporary → allocation-control test red |
| 2 | PathFollow targets/scratch | racing, defense and platformer generated entities | 3–5 vector clones/call | ignore supplied target → target-identity test red |
| 3 | Viewport targets/scratch | exported viewport helpers | cloned point/world vectors | restore clone → input-immutability/reuse control red |
| 4 | Navigation targets/crowd records | `NavigationProbe.ts` and navigation agent updates | cloned vectors and `{x,y,z}` records | restore record literal → crowd record identity test red |

## Execution Phases

### Phase 1 — Picking and viewport projection reuse internals

**Files (5):** `packages/core/src/picking.ts`, `packages/core/src/viewport.ts`,
`packages/core/src/scene.ts`, `packages/core/__tests__/picking.spec.ts`, and
`packages/core/__tests__/viewport.spec.ts` (EDIT).

- [ ] Preserve retained default results and input immutability.
- [ ] A supplied target is cleared/refilled and returned by identity.
- [ ] Empty exclusions and single-root queries create no internal collection per call.

### Phase 2 — PathFollow3D supplies target-taking point, tangent and project operations

**Files (4):** `packages/core/src/path-follow.ts`,
`packages/core/__tests__/path-follow.spec.ts`,
`packages/create-threenative/templates/racing/src/track/Ranking.ts`, and
`packages/create-threenative/templates/defense/src/attackers/Attacker.ts` (EDIT).

- [ ] Use `Curve.getPointAt/getTangentAt` target parameters and instance scratch.
- [ ] Convert real generated frame-loop callers to retained targets; no toy-only proof.
- [ ] Preserve loop/clamp/progress behavior and prior result safety for calls without a target.

### Phase 3 — Navigation reuses steering and crowd records

**Files (5):** `packages/physics/src/navigation/NavigationAgent3D.ts`,
`packages/physics/__tests__/navigation-agent.spec.ts`,
`packages/physics/src/index.ts`,
`examples/abyss-framework/src/scenes/NavigationProbe.ts`, and
`packages/create-threenative/capabilities.json` (EDIT/generated).

- [ ] Supply a target form for the next-path position while keeping the allocating default.
- [ ] Refill stable crowd position/velocity records while moving and stationary.
- [ ] Preserve stop distance, target distance, retarget and local-avoidance behavior.

## Verification

Record `docs/verification/prd-192-result-math-targets-<date>.md`.

1. Observe each target-identity test red by ignoring/replacing its target.
2. Run focused core and physics specs, including the existing retained-picking-result test.
3. Run racing, defense and navigation playtests on browser WebGPU.
4. Run `pnpm build` and inspect the regenerated capability signature before root gates.

## Acceptance Criteria

- [ ] A frame loop that supplies targets to all four surfaces performs no hidden per-call vector,
      array, set, comparator or record allocation after warmup.
- [ ] Default calls remain safe to retain; one query never mutates a previous result.
- [ ] Generated racing/defense and the navigation example consume the target path in live updates.
- [ ] No bespoke vocabulary is introduced; signatures follow Three.js target conventions.
