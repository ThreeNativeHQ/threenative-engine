# PRD-764 — Scene ray queries skip irrelevant objects and repeated crossings

**Status:** NOT STARTED
**Priority:** P1 — bound repeated scene discovery for camera and hitscan queries.
**Complexity:** 9 (HIGH)
**Owner:** Engine implementation agent
**Depends on:** None
**Progress:** 0%

## Context

Source: proposal 3 in [the investigation](../../../plans/engine-performance-architecture-2026-10-28.md).
Engine layer: `packages/core/src/game.ts:1574` routes `ctx.raycast` to `ScenePicker`.
`picking.ts:139` updates each root's matrices and `:183` recursively discovers objects per query.
The geometry BVH at `:292` accelerates triangles within one mesh, not scene discovery. No new
scene-index timing was measured in the investigation.

Complexity: 9 → HIGH; 11+ likely implementation files (+3), scene-query mechanism (+2), mutation
state (+2), JS/owned-engine boundary (+2); risk override: none. Effort: 5–10 engineer-days.

## Solution

Keep `ctx.raycast/raycastAll`, explicit targets and current hit contracts. Start with measured
transform freshness and candidate filtering, then retain static/moving object bounds in the
existing scene owner if counters justify an index. Traverse candidates nearest-first for closest
queries. Keep owned-engine candidate selection and intersection in one operation where supported;
batch only callers that naturally have several synchronous rays available together.

Mutation freshness must cover a move between two queries in the same frame, ancestor movement,
add/remove, geometry edits, layer/filter changes and reparenting. A frame flag is insufficient.
Reuse per-mesh BVHs and the engine's existing geometry/query storage; do not replace picking with
physics colliders or the static-only `TracedReflections` pack. Preserve hidden merged-source
identity, exclusions, layers, all-hit order, LOD0 geometry and deformed/instanced fallback behavior.
Preserve tied-hit behavior and immediate results. Keep the legacy Three.js path as the oracle;
an unsupported shape must use a correct fallback, not a silent miss. Performance claims must
include fallback populations and index-maintenance cost.
Apply [the batch execution contract](README.md#execution-contract).

## Validation scene — Hitscan obstacle course

**Proposed fixture:** add a selectable obstacle course to the existing native-smoke game and
`examples/native-smoke/playtests/perf-scene-picking.playtest.json` with a desktop variant.
Populate it with a seeded grid of cheap meshes, moving gates, parented obstacles, a skinned or
morphed target and merged-source instances. Drive a fixed camera/hitscan replay through the
public `ctx.raycast/raycastAll` methods; the planned `scene-picker` conformance case uses the
same subject. This is a synchronous scene query, not a physics ray or GPU tracing replacement.

| Variant | Population and action | Purpose |
| --- | --- | --- |
| Benefit | 32 rays per frame, 10,000 meshes, ≥90% irrelevant to those rays; repeat at 1,000 | Prove scene discovery/crossing savings in total frame CPU |
| No query | Identical moving/rendered population, zero rays | Charge index maintenance even when unused |
| High motion | 50% of meshes/ancestors move each frame, same ray set | Expose bounds-update cost |
| Narrow/fallback | Explicit targets limited to 20 meshes, including deforming/merged sources | Compare with the already efficient incumbent path and count fallbacks |

Replay a shot, move a gate, shoot again in the same frame, then change a parent's transform,
layer/exclusion and membership. The camera approaches the gate along a fixed path. Compare
nearest identity/distance, all-hit order, hidden merged-source identity and camera obstruction
against baseline results for every scripted query. Keep oracle execution in a separate
correctness run so its full traversal does not pollute candidate timings. Keep the same rendered
meshes in the no-query control; creation, moving-bound updates and removal remain timed work.

**Net gain:** meet [the scene gate](README.md#validation-scenes-and-net-gain-gate) on the 32-ray
benefit workload using total CPU frame work. Report query CPU, index maintenance, candidate/
matrix visits, real crossings, allocations and frame timings separately. The zero-ray, high-motion
and narrow/fallback controls must pass their overhead limits. Require a camera-motion visual
judge. Faster ray intersection with a slower complete frame is a failed optimization.

## Acceptance Criteria

- [ ] AC-1 [local]: Public nearest/all-hit queries match the incumbent after every relevant mutation, including move→query twice within one frame and merged-source exclusions. proof: `pnpm exec vitest run packages/core/__tests__/picking.spec.ts packages/core/__tests__/picking-exclusion-cost.spec.ts packages/core/__tests__/picking-offset.spec.ts` extended with a differential oracle. Evidence: pending.
- [ ] AC-2 [local]: For 32 fixed rays in 1,000/10,000-mesh scenes with at least 90% irrelevant bounds, candidate visits fall at least 80%; owned-engine per-object crossing growth is eliminated for supported indexed candidates. proof: extended picking cost cases plus real `profile:wasm-page --calls` observations and Phase 3 CPU pairs, counting index maintenance. Evidence: pending.
- [ ] AC-3 [local]: Linux owned-engine picking returns the same source identities and ordered hits as the browser oracle. proof: a planned `scene-picker` case in the existing conformance registry, run with `pnpm parity --target desktop --engine threenative --only-tests scene-picker --reference <web-captures>`. The fixture must call the public picker; the existing `76-gpu-scene-bvh` fixture exercises a different GPU tracing API and cannot prove this claim. Evidence: pending.

- [ ] AC-4 [local]: Hitscan obstacle course demonstrates a net whole-frame CPU gain for the benefit workload without query-result differences or overhead-control regressions. proof: proposed `perf-scene-picking` playtests on browser and Linux desktop, three matched timing pairs per variant, separate oracle run, resource checks and camera visual verdict. Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Public scene queries | `game.ts:1574–1575` → `picking.ts:98/108` → candidate traversal | Indexed supported paths; correct deforming/legacy fallback retained | AC-1, AC-3 |
| Bulk owned-engine query | Public picker → existing geometry/query owner → synchronous hits | Replace repeated per-object host queries, not public API | AC-2 |

## Execution Phases

### Phase 1: Prove query freshness and size discovery cost

**Status:** NOT STARTED
**Files:** Existing core picking specs; a planned public-picker consumer fixture under
`packages/runtime-native/conformance/scenes/shared/`, registered in the existing registry.
**Implementation:** Pin an incumbent oracle and vary irrelevant objects, moving members, rays,
target sets and deforming meshes; distinguish matrix visits, candidates, crossings and CPU.
- [ ] A representative query workload reproduces redundant discovery and defines the mutation oracle before indexing. proof: focused picking tests, real call profiling and baseline timings for AC-2's populations. Evidence: pending.

### Phase 2: Reuse candidate selection in the scene query path

**Status:** NOT STARTED
**Files:** `packages/core/src/picking.ts`, its existing scene/geometry ownership seams; owned-engine
query implementation and browser/native bindings identified by capability research before editing.
**Implementation:** Add only the measured missing selection mechanism. Retire unconditional
full-scene discovery on supported indexed paths; observe mutations before each synchronous query.
- [ ] Candidate filtering/indexing preserves public query semantics and mutation freshness. proof: AC-1 tests, red→green for scaling and same-frame mutation cases. Evidence: pending.
- [ ] Owned-engine queries return results in bulk without a per-candidate bridge loop. proof: actual crossing counts at 1,000/10,000 meshes and AC-3's real consumer conformance. Evidence: pending.

### Phase 3: Qualify public picker behavior and scaling

**Status:** NOT STARTED
**Files:** Add public-picker hitscan/camera-obstruction coverage to the existing native-smoke
game fixture and its playtest directory; reuse its runner and the planned conformance consumer.
- [ ] Hitscan obstacle course proves AC-2 and AC-4 while maintaining synchronous hit and camera behavior. proof: proposed `perf-scene-picking` playtests on browser and Linux desktop, matched scene timing/control runs and the camera-motion visual verdict. Evidence: pending.
