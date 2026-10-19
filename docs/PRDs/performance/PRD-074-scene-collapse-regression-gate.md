---
prd_contract: v1
---

# PRD-074 — SceneCollapse measured outcome and regression gate

**Status:** IMPLEMENTED — browser regression gate complete; Pixel 8 open.
**Priority:** P2 — Only Pixel 8 draw-count and timing verification of a landed browser gate remains.
**Depends on:** truthful draw-count access from the reconciled PRD-071 scope; PRD-EXP-002 for optional deeper attribution.
**Evidence:** `docs/verification/render-work-reduction-2026-08-11.md`; `docs/verification/prd-074-scene-collapse-regression-2026-08-11.md`.

## 1. Decision

Turn the already-shipped `SceneCollapse` draw folding into a measurable, regression-gated framework outcome. Do not redesign its merge algorithm and do not add a general auto-instancer.

`SceneCollapse` already owns static merging, moving-owner transforms, camera/HUD folding and palette/material folding. Pixel 8 evidence shows the framework's largest proven renderer win: 76 overlay meshes became 11 draws and observed frame rate moved from roughly 55–71 fps to 83–116 fps. The gap is not another folding implementation; it is durable proof that eligible scenes collapse, ineligible semantics remain intact, and future changes do not silently restore hundreds of render objects or material identities.

## 2. Scope

Add an observable result contract for each collapse attempt containing at minimum:

- source renderable count;
- resulting renderable/draw-candidate count;
- source and resulting material identity counts;
- static-world, moving-owner and camera-overlay groups;
- skipped object counts grouped by explicit reason;
- bake duration and transform-refresh duration;
- whether collapse was applied, rejected or deferred;
- no references to user scene objects beyond IDs/counts in serialized reports.

The contract is diagnostics, not a new game-facing scene abstraction. It may be exposed through existing startup/playtest diagnostics and must not require production telemetry.

## 3. Live integration

Expected paths:

- `packages/core/src/collapse.ts` — produce bounded counters from the real collapse path;
- `packages/core/src/game.ts` or existing diagnostics plumbing — expose the last result without changing render semantics;
- `packages/core/__tests__/collapse.spec.ts` and palette-scale tests — exact before/after contracts;
- playtest performance scenario — read real WebGPU draw counts before and after collapse;
- `docs/verification/` — physical Android regression rows.

## 4. Phases

### Phase 1 — diagnostics contract

Define and test the result shape. Instrument existing decision points rather than performing a second traversal for metrics. Serialization must not retain Mesh, Material, Geometry, Scene or user object references.

### Phase 2 — semantic fixtures

Cover:

- static meshes with one shared material;
- equal-looking materials foldable through palette/vertex colors;
- materially incompatible meshes that must remain separate;
- moving owners using the existing storage-buffer path;
- camera/HUD overlays above and below the current threshold;
- sprites/particles and unsupported objects that must not be rewritten;
- visibility, layers, render order, transparency and hooks that make folding unsafe.

Each fixture asserts both pixels/semantic state where practical and expected source/result counts.

### Phase 3 — real renderer gate

Run a playtest scene through the actual WebGPU renderer. Assert the observed draw count changes in the expected direction after collapse and remains stable over 300 frames. A unit-test estimate is not enough.

### Phase 4 — Pixel 8 regression

Re-run the known HUD-heavy subject on the same physical device/build class. Record source/result draws, collapse/refresh time, `renderer.render()` median/p95 and frame rate. The shipping gate is no material regression from the existing folded result; exact historical FPS is evidence context, not a brittle universal threshold.

## 5. Acceptance criteria

- [x] Every applied/rejected/deferred collapse produces a bounded result with counts and reason codes.
- [x] Metrics add no second full scene traversal and less than 1% median overhead when disabled. Disabled-path microbenchmark observed -4.52% versus base, treated as noise-bound 0% measured regression overhead; opt-in transform-refresh timing cost is documented separately.
- [x] Existing 16-overlay/2-material fixture reports 16 sources and 2 resulting draws; the below-threshold fixture reports no collapse.
- [x] Palette-scale fixtures prove equal-looking color variants merge without material-semantic loss.
- [x] Unsupported transparency, hooks, layers or render ordering are preserved or rejected explicitly, never flattened silently.
- [x] A real WebGPU playtest observes draw reduction, not merely an estimated count.
- [ ] Pixel 8 verification records draw counts plus render/collapse/refresh timings and does not regress materially. Open. Blocker note corrected 2026-08-23: "ADB saw only emulator-5554" was true on 2026-08-11 and is false since — the physical Pixel 8 ran full measurement lanes on 2026-08-16 and 2026-08-21 (see docs/verification/prd-069-phase-0-v8-draw-ladder-2026-08-21.md). The remaining requirement is one preflight-disciplined device run (thermal NONE, battery temp <=31.5 degC, discharging over Wi-Fi adb per that record's discipline); an attempt on 2026-08-22 found the phone charging over USB, so it stays open.
- [x] No auto-instancer, static-scene analyzer or new user-facing performance preset is introduced.
- [x] Tests, typecheck, lint, budgets and `git diff --check` pass.

## 6. Negative controls

| Control | Change | Expected |
|---|---|---|
| fake outcome | report reduced draws without changing renderer input | real-renderer gate fails |
| unsafe fold | allow a transparent/render-ordered fixture into an incompatible group | semantic/pixel fixture fails |
| retained graph | include a source Mesh in the result | serialization/reference test fails |
| hidden traversal | recompute metrics by traversing the scene again | traversal-count/overhead gate fails |
| threshold drift | fold the small overlay fixture | existing below-floor test fails |

## 7. Kill and rollback

If truthful metrics require another complete traversal or retaining source scene objects, keep only counters already available during collapse and reject the larger contract. If the real renderer does not observe the predicted draw reduction, stop and debug the existing collapse path; do not add another batcher. Diagnostics can be disabled without changing collapse behavior.
