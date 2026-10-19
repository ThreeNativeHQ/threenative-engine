---
prd_contract: v1
---

# PRD-088 — The physics world cannot be asked a question, so no ThreeNative game can fire a shot, check the ground, or find a target

**Status: BLOCKED — the Phase 0 ABI-selection criterion is unmet, 2026-08-12.** The web and
Linux desktop implementation is present, but the required pre-implementation ray measurement
was not recorded. Android and iOS execution were not performed on this operator machine.
**Parent:** [PRD-087](../../done/starter-kits/PRD-087-genre-borrow-ledger.md), which scored this **91/100** — the
only surveyed candidate above the Tier-1 bar.
**Blocks:** [PRD-089](../../done/PRD-089-shooter-starter-kit.md) (hitscan, radius damage, target
acquisition), [PRD-090](../../done/PRD-090-racing-starter-kit.md) (on-road probe),
[PRD-092](../../done/PRD-092-strategy-starter-kit.md) (placement validation, tower acquisition),
[PRD-093](../../done/PRD-093-action-rpg-starter-kit.md) (aggro range and line of sight).
**Independent of** [PRD-091](../../done/PRD-091-genre-kit-delivery-rail.md); the two run in parallel.

**Priority:** P1 — Only open box is the ray query-and-hit measurement; physics cannot answer ray or ground queries.
**Complexity: 7 → HIGH mode.** New public surface on `@threenative/physics`, a new method
group on the simulation ABI, and a native implementation in C++. That is three seams, and
the native one has a cost this PRD measures before it designs.

## 1. Why this is user value and not tidying

`@threenative/physics` ships bodies and withholds questions. The whole public surface is
`RigidBody3D`, `Area3D`, `CharacterBody3D`, `CollisionShape3D`, `interactionGroups` and the
handle types. Nothing queries.

```
$ grep -n "castRay\|intersectRay\|intersectShape\|intersectPoint" packages/physics/src/index.ts
$   # no output
```

Rapier can do all of it. We call it ourselves — `packages/physics/src/simulation.ts:527`
uses `world.intersectionsWithShape` to service `Area3D` overlap. **The capability is inside
the boundary and no game can reach it.**

### What that costs, per genre

Seven of seven codebases surveyed in PRD-087 implement a spatial query. Concretely:

| Verb the user's agent wants | How the surveyed game does it | What ThreeNative offers today |
|---|---|---|
| Hitscan weapon | Quake III `g_weapon.c` traces a ray | nothing — `ScenePicker.raycast` hits *meshes*, not colliders |
| Explosion damage | Quake III `g_combat.c` `G_RadiusDamage` | nothing |
| "Nearest hostile in range" | OpenRA `AutoTarget.cs` → `World.FindActorsInCircle`, rescanned every 3–8 ticks | allocate a persistent `Area3D` sensor per entity and wait a frame |
| Ground / ledge check | Godot demo `3d/kinematic_character` ray-casts down | `CharacterBody3D` knows internally, exposes no arbitrary probe |
| Line of sight | 0 A.D. `UnitAI.js`, Flare `HazardManager.cpp` | nothing |

The `Area3D` workaround is not a workaround. An `Area3D` is a live body in the world: it
costs an allocation, a collider, a slot in the transform buffer and a frame of latency
before `reconcileIntersections` reports. Using one to answer *"is there a wall 2 m ahead,
right now"* is the wrong shape, and on native it is the wrong shape at bulk-ABI scale.

### Why this is not the 20-line rule

A user cannot write it in twenty lines, or in twenty thousand. The Rapier `World` is owned by
the plugin and never handed to game code; on native there is no Rapier at all — the world is
a C++ object behind `step` and `readVisibleTransforms`. **On the native target this is not
inconvenient to write in user code, it is impossible.** Rule 1 asks whether a competent
developer *could* write it. Here the answer is no on one of the two platforms we ship, which
is the definition of framework plumbing.

## 2. Solution

Godot's name for this is `PhysicsDirectSpaceState3D`, reached from the world, carrying
`intersect_ray`, `intersect_shape` and `intersect_point`. Vocabulary is borrowed, so we
take those names in camelCase and add nothing.

```ts
import { CollisionShape3D, type IPhysicsContext } from "@threenative/physics";

const space = ctx.physics.directSpaceState;

// hitscan — Quake III g_weapon.c, in one line
const hit = space.intersectRay({ from: muzzle, to: aimPoint, collisionMask: HOSTILE });
if (hit !== undefined) applyDamage(hit.entity, hit.position, hit.normal);

// radius damage — Quake III g_combat.c G_RadiusDamage
for (const body of space.intersectShape({
  shape: CollisionShape3D.sphere(6),
  position: blastCentre,
  collisionMask: HOSTILE,
})) { /* falloff by distance — the user's design, the user's lines */ }
```

**Three methods. No fourth.** Godot also ships `cast_motion` and `get_rest_info`; neither
appeared in the survey, so neither ships here. A capability nobody was measured needing is
speculative abstraction.

### What each returns

`intersectRay` returns one `IRayHit | undefined` — `{ position, normal, distance, body, entity }`.
`entity` is the string tag already carried on `IPhysicsBodyHandle`, so the caller gets back
something it can look up without a handle-to-object map of its own.

`intersectShape` and `intersectPoint` return a **bounded** array. `maxResults` defaults to 16
and is a required part of the contract, not a convenience: an unbounded query against a
native bulk ABI is an unbounded buffer, and OpenRA's own scan is bounded by design.

### Fail closed

Consistent with the rule everywhere in this repo:

- A malformed query — non-finite `from`/`to`, a zero-length ray, `maxResults < 1` — **throws**.
  It does not return `undefined`, because `undefined` reads as "nothing hit" and would ship
  as a silent gameplay bug on one platform.
- A backend that cannot honour an option **throws at construction**, not at call time.
- Calling the space state after the simulation is disposed throws, via the existing
  `requireLive()`.

### The option that is rejected in writing

**Rejected: a deferred/batched-only API** where the game submits queries and reads results
next frame. It is the shape the native bulk ABI wants, and it is wrong. Every surveyed
codebase queries synchronously inside the decision that needs the answer; a one-frame-late
raycast is a bullet that passes through a wall. The batching, if measurement says we need it,
lives *under* the synchronous call, not in the user's code. This is recorded here so it is
not re-proposed.

## 3. Integration Ledger

| # | New thing | Live caller (`file:line`, non-test) | Replaces | Old path removed? | Negative control |
|---|---|---|---|---|---|
| 1 | `PhysicsDirectSpaceState3D` | `packages/physics/src/plugin.ts` exposes it on `IPhysicsContext`; consumed by the PRD-089 shooter template | nothing — the capability was unreachable | n/a, an absence | delete the web `intersectRay` body → the shooter playtest never registers a hit |
| 2 | `intersectRay`/`Shape`/`Point` on `IPhysicsSimulation` | `packages/physics/src/simulation.ts`, web backend | internal-only `world.intersectionsWithShape` at `:527` | **no** — `Area3D` keeps its own path; overlap-over-time and point-in-time are different questions | make the web backend ignore `collisionMask` → the layer test goes red |
| 3 | Native query ABI | `packages/runtime-native/src/`, reached through `packages/physics/src/native.ts` | native games could not query at all | n/a | stub the native side to return "no hit" → `native:verify:desktop` scenario fails |
| 4 | `Chaser` rewritten onto `intersectShape` | `templates/platformer/src/entities/Chaser.ts:44` | the direct `#player` reference and `distanceTo` | **yes** — the field is deleted | restore the direct reference → the two implementations must agree, or one is wrong |

Row 4 is the point of the whole ledger. **If the new API cannot delete the hand-rolled code
in our own template, it did not earn its place.**

## 4. Execution phases

### Phase 0 — Measure the native call cost before designing the native API

**Outcome:** a number — the cost in microseconds of one QuickJS → C++ → QuickJS round trip
carrying a ray query and a hit result, measured on desktop, at 1, 16 and 256 calls per frame.

**Why this is Phase 0 and not an implementation detail.** The native rule is a *coarse bulk
typed-array ABI, never per-object frame calls*. A synchronous per-call raycast looks like
exactly the thing that rule forbids. It may not be: a raycast is not per-object-per-frame,
it is per-decision, and a shooter fires a handful per frame, not one per entity. **The
measurement decides whether the synchronous call goes straight through or is backed by a
per-frame coalescing buffer underneath.** Designing either one before measuring is guessing.

**Recorded execution:** the pre-query ABI had no ray method, so the Phase 0 command measured
its existing narrow-query-shaped `readAreaIntersections` path as a boundary proxy. The proxy
measured `0.001709`, `0.021973`, and `0.367920 ms` at 1, 16, and 256 calls. It did not measure
a ray payload and did not select the shipping ray ABI. The first actual ray query-and-hit
round trip, measured after native query implementation had begun but before the shipping ABI
was finalized, took `1.466064 ms` at 256 calls with an object-returning prototype; that led to
the reusable eight-float record. The final compact-record ray measurement was `0.851807 ms` at
256 calls, below the 1 ms threshold, so the shipping decision was the direct synchronous ABI.

**Phase 0 gate result: BLOCKED.** The pre-query proxy is not authoritative ray evidence and
there is no committed pre-implementation ray query-and-hit measurement. The later ray
measurements support the implemented design, but they cannot satisfy a criterion that requires
the recorded pre-implementation number to select the ABI.

**Gate:** the required pre-implementation ray number is not recorded, so this gate remains
blocked. The later compact-record number is recorded in `docs/verification/` and supports the
direct synchronous implementation, but it does not retroactively close Phase 0.

### Phase 1 — Web backend, tests, and the `Chaser` deletion

**Outcome:** `PhysicsDirectSpaceState3D` implemented over Rapier `castRay`,
`intersectionsWithShape` and `intersectionsWithPoint`; unit tests for layer filtering,
`maxResults` bounding and every throwing case; `Chaser` rewritten and its direct player
reference deleted.

**Gate:** `pnpm typecheck && pnpm lint && pnpm test` green, plus the platformer playtest
still green with the rewritten `Chaser` — the chaser must still reach the player.

### Phase 2 — Native backend

**Outcome:** the three queries implemented in `runtime-native`, with the direct synchronous
shape selected by the actual ray-payload measurement.

**Gate:** `pnpm native:verify:desktop` green, plus a playtest asserting the *same* hit
position on web and desktop for a fixed ray. A query that returns a different answer on the
two platforms is the fork this repo exists to prevent.

### Phase 3 — Android and iOS evidence

**Outcome:** the same scenario under `--target android` and `--target ios`.

**Gate:** executed, or explicitly recorded as not executed. Desktop-green is a desktop claim
and nothing more.

### Narrowed review repair — 2026-08-12

This fresh lane fixes two native defects found in the exhausted starter-kit-088-r3 review.
The Phase 0 ABI-selection criterion remains unmet and **BLOCKED**; these repairs do not
invent a pre-implementation ray measurement or change the platform scope.

- Finite endpoints whose `f32` subtraction is unrepresentable now return a distinct native
  invalid status, which the C++ binding throws instead of translating to a clean miss.
  Valid nonzero rays whose length is as small as `1e-30` remain accepted.
- The native scene proof now asserts both a geometric miss and a collision-mask exclusion for
  `intersectShape` and `intersectPoint`. Native Rust mutation checks made each mask predicate
  test fail before the predicate was restored.

The executed repair evidence is recorded in
[`docs/verification/PRD-088-physics-spatial-queries.md`](../../../verification/PRD-088-physics-spatial-queries.md).

## 5. Verification strategy

The trap here is a query that returns something plausible. A raycast that always reports a
hit at `to` passes a naive "did we get a result" test forever.

- **Every assertion is a number, not a truthiness.** The ray test fires at a box of known
  position and asserts `hit.distance` to a tolerance, and `hit.normal` component-wise.
- **Two negative controls per method**, and they are written before the implementation: a ray
  aimed at nothing must return `undefined`; a ray aimed at a body outside `collisionMask`
  must return `undefined`. A backend that ignores the mask fails the second while passing the
  first, which is exactly the bug a single happy-path test would ship.
- **Cross-platform equality is asserted, not assumed.** Same scene, same ray, web and
  desktop, asserted equal to a stated tolerance.
- **`maxResults` is asserted at the boundary**: 20 bodies in range, `maxResults: 16`, exactly
  16 returned.

## 6. Acceptance criteria

- [x] `intersectRay`, `intersectShape` and `intersectPoint` are public on
      `@threenative/physics`, named as Godot names them, with no fourth method.
- [x] Both backends implement all three; no `threenative-native` condition swaps anything
      above the `PhysicsSimulation` boundary.
- [ ] A pre-implementation ray query-and-hit measurement recorded in `docs/verification/`
      selected the ABI. **UNMET:** the pre-query record is an area-intersection proxy, and the
      actual ray measurements were collected after native query implementation had begun.
- [x] `templates/platformer/src/entities/Chaser.ts` no longer holds a direct reference to the
      player object, and the platformer playtest is still green.
- [x] Every malformed input throws; no query path returns `undefined` for a *bad* query.
- [x] Web and desktop return the same hit for the same ray, asserted in a playtest.
- [x] `pnpm budgets` reports the framework LOC delta; if a review trigger is crossed, the
      justification is written in this file rather than silenced.

## 7. Budget trigger justification

`pnpm budgets` reports 69,485 native-runtime lines against the 50,000 review trigger
(+19,485). PRD-088 adds 846 native lines across the ABI declarations, Rust implementation,
JS host binding, desktop verifier, and test wiring. The earlier repair added 39 focused Rust
lines; this narrowed repair adds only native status propagation, native negative-control
assertions, and their desktop gate wiring. The kill-switch pass retained them because
each added block is reached by a shared query method, native ABI call, or executed desktop
proof; no temporary stub, diagnostic-only path, duplicate class, or dead source-surgery
workaround remains. The trigger is recorded rather than routed around.
