---
prd_contract: v1
---

# PRD-171 — Navigation computes one path per retarget, and syncs the crowd only on motion

Complexity: 4 → standard

## Context

Two verified hot-path costs in `packages/physics/src/navigation/`:

1. **Every retarget computes the path twice.** `NavigationAgent3D.setTargetPosition`
   (`NavigationAgent3D.ts:133-154`) calls `this.isTargetReachable()` (`:140`) — which itself
   runs two `findClosestPoint` queries and a **full `query.computePath`** when start/end polys
   differ (`:175-198`) — and then computes `computePath` **again** on the same endpoints to
   store `#path` (`:141-144`). Chase AI that retargets per frame (the exact pattern the
   capability docs advertise) pays double nav cost per agent per frame.
2. **Crowd sync teleports stationary agents every frame.** `syncCrowd()`
   (`NavigationAgent3D.ts:210-215`) unconditionally calls
   `crowdAgent.teleport(...)` + `requestMoveTarget(...)`; `NavigationObstacle3D`
   (`NavigationObstacle3D.ts:68-72`) does the same for obstacles. Teleport forces Recast to
   re-localise the agent on the navmesh — a heavy op used as a per-frame sync mechanism. At the
   crowd cap this is ~128 boundary calls/frame regardless of motion.

The agent never moves its object (gameplay steers + `moveAndSlide()`), so "the object moved"
is the only legitimate reason to re-localise.

## Solution

1. Compute once in `setTargetPosition`: run the closest-point probes + single `computePath`,
   store `#path`, derive reachability from the same result (final-waypoint match, exactly
   today's `navigationPointMatchesTarget` criteria). The public `isTargetReachable(position?)`
   keeps its standalone contract unchanged for direct callers.
2. Motion-gate `syncCrowd()`/obstacle sync: teleport only when the object's position moved more
   than an epsilon since the last sync (or first sync); `requestMoveTarget` only when the target
   changed. Before choosing epsilon semantics, read recast-navigation's teleport vs position-set
   docs for the pinned version — if teleport is semantically required after gameplay motion,
   gate on accumulated displacement instead. If neither is safe, STOP and report rather than
   weakening avoidance.

```mermaid
sequenceDiagram
  participant G as game update
  participant A as NavigationAgent3D
  participant R as Recast query
  G->>A: setTargetPosition (per frame)
  A->>R: findClosestPoint ×2 + computePath ×1 (was ×2)
  A-->>G: path + reachability from one result
  G->>A: syncCrowd
  A->>A: moved > ε since last sync?
  A->>R: yes -> teleport; no -> skip
```

Data changes: none.

## Integration Ledger

| # | Thing built | Live caller | Replaces | May claim green when | Negative control |
|---|---|---|---|---|---|
| 1 | Single-compute setTargetPosition | chase-AI callers retargeting per frame | double computePath | spy counts one computePath per retarget with identical stored path/reachability | restore second compute → count returns 2 |
| 2 | Motion-gated crowd sync | navigation plugin update loop | unconditional teleport+request per frame | stationary-agent scenario shows zero boundary syncs across N frames; moving agent still navigates | remove the gate → stationary frames show syncs again |

## Execution Phases

### Phase 1: row 1

**Files (3):**

- `packages/physics/src/navigation/NavigationAgent3D.ts` - EDIT.
- `packages/physics/__tests__/` navigation specs (locate existing file) - EDIT: new cases.
- `docs/verification/prd-171-navigation-<date>.md` - NEW.

**Tests Required:**

| Test File | Test Name | Assertion | Negative control |
|---|---|---|---|
| navigation spec | one path computation per retarget | instrumented query records exactly 1 `computePath` per `setTargetPosition`; `#path`, `pathChanged` event, and reachability identical to before | revert to double-compute → red |
| navigation spec | direct isTargetReachable unchanged | standalone call results match previous expectations incl. unreachable/unbaked-region cases | mutate matching criteria → red |

### Phase 2: row 2

**Files:** `NavigationAgent3D.ts`, `NavigationObstacle3D.ts`, their spec(s), verification record.

**Tests Required:**

| Test File | Test Name | Assertion | Negative control |
|---|---|---|---|
| navigation spec | stationary agent performs no teleports | N frames without motion → zero teleport calls recorded | remove gate → red |
| navigation spec | moving agent still reaches its target | scripted walk along a path completes within tolerance | break re-localisation → agent stuck → red |
| playtest scenario (existing navigation caller) | browser navigation scenario stays green | `examples/abyss-framework ?navigation` route or the repo fixture equivalent exits 0 | n/a — regression gate |

**Verification Plan:** focused physics suite → `pnpm typecheck && pnpm lint && pnpm test` →
one navigation playtest on browser. No native claim (Recast stays browser-only by charter).

**User Verification:** any template/example using an enemy chase still pursues and arrives.

## Acceptance Criteria

- [ ] `computePath` runs at most once per retarget (spy-tested, mutation observed red).
- [ ] Stationary agents/obstacles perform zero crowd boundary syncs per frame; movers behave as before.
- [ ] All pre-existing navigation specs and one browser navigation scenario green.
- [ ] `pnpm typecheck && pnpm lint && pnpm test` pass.

## Checkpoint Protocol

Paste spy-count outputs and both negative-control reds. An avoidance change justified only by
argument ("should be fine") blocks delivery.

## Results — 2026-08-22

EXECUTED (`8a5104cc`). Both rows landed; both negative controls observed red first. Crowd
separation spec caught a real semantic during review: teleport drops the crowd agent's move
state, so the target is re-sent atomically in the same sync. 138/138 physics. Browser scenario
red identically at HEAD on this machine (pre-existing) — recorded, not caused here:
`docs/verification/prd-171-navigation-2026-08-22.md`.
