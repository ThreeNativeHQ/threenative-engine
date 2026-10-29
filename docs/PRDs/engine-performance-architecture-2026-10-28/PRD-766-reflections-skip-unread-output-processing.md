# PRD-766 — Reflections skip unread output processing

**Status:** NOT STARTED
**Priority:** P2 — eliminate output work that reflection scene-color consumers do not read.
**Complexity:** 5 (MEDIUM)
**Owner:** Engine implementation agent
**Depends on:** None
**Progress:** 0%

## Context

Source: reflection follow-up in [the investigation](../../../plans/engine-performance-architecture-2026-10-28.md).
Engine layer: `packages/runtime-native/src/engine/renderer/render_database.cpp:1806` creates a
normal sibling renderer, `:1814` copies output settings and `:1841` consumes `sceneColorView()`.
`renderer.cpp:5168` already skips output for `sceneOnly_`; `renderer.h:377` exposes
`sibling(bool sceneOnly = false)`. Reuse that mechanism. PRD-755 mentions this as a follow-up,
not an unfinished box; its history-copy work remains outside this slice.

Complexity: 5 → MEDIUM; 1–5 implementation files (+1), nested render/resource state (+2),
Wasm/native delivery boundary (+2); risk override: none. Effort: 1–2 engineer-days.

## Solution

Audit all planar reflection output consumers, then create reflection siblings with the existing
scene-only mode if they exclusively sample scene color. Remove only output configuration/work
proven unread. Preserve scene color, HDR range, clipping, resize, recursion avoidance, temporal
ownership and deferred/empty draws. Main-view output remains unchanged. No new reflection
lighting or look preset is introduced.

Local UE 5.8.3 source was re-read: `Engine/Source/Runtime/Renderer/Private/SceneCaptureRendering.cpp:230–233`
distinguishes scene-color captures from final-color captures; `:1144` selects that source before
render setup. Borrow the consumer-based guard idea only, not Epic implementation. This is a
targeted optimization of the shipped reflection path, not a new feature-map port.
Apply [the batch execution contract](README.md#execution-contract).

## Acceptance Criteria

- [ ] AC-1 [local]: A planar reflector consumes valid scene color after resize, empty and deferred draws, without invoking the unused output pass. proof: extend `packages/runtime-native/tests/native-engine/render_database_test.cpp` reflection reuse and renderer raw-target coverage; run CTest with `-R 'native_engine_renderer_reflection_reuse|native_engine_raw_target_scene_only' --output-on-failure` in the configured native build. The probe-only reflection-capture validation test cannot prove planar draw behavior. Evidence: pending.
- [ ] AC-2 [local]: A scene with one and several reflectors records zero reflection output passes and saves measured GPU time beyond run noise, with identical main-view output ownership. proof: three matched per-pass timing pairs using `?tnGpuPasses=1`, including a no-reflector control and the batch frame-p95 bar. Evidence: pending.
- [ ] AC-3 [local]: Linux desktop sailing preserves reflection appearance and temporal behavior against the browser reference. proof: existing sailing performance playtest via `--target desktop`, reflection consumer coverage and Phase 3's visual verdict. Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Planar reflection capture | `render_database.cpp:1803` reflector draw → sibling → `:1841` scene-color sample | Normal sibling becomes existing scene-only sibling after consumer audit | AC-1, AC-2 |
| Player-visible water | Sailing water reflection → main-view composite | Keep material/look unchanged | AC-3 |

## Execution Phases

### Phase 1: Establish reflection output ownership and cost

**Status:** NOT STARTED
**Files:** Existing reflection/renderer tests and sailing performance scenario.
**Implementation:** Trace every sibling output reader; pin main/reflection pass counts and GPU
timings. If a final-color consumer exists, keep its output path rather than assuming scene-only.
- [ ] Representative reflector draws reproduce an unread output pass and establish its removable cost. proof: focused reflection consumer assertions plus baseline per-pass GPU timings for zero/one/several reflectors. Evidence: pending.

### Phase 2: Reuse scene-only sibling rendering

**Status:** NOT STARTED
**Files:** `render_database.cpp` and existing render-database/renderer tests; edit `renderer.h` only
if a demonstrated guard is missing. Do not add a second rendering mode.
**Implementation:** Select the existing mode at sibling creation and preserve lifecycle behavior.
- [ ] Reflection scene-only draws remove unread output while main-view output stays valid. proof: AC-1 focused CTests, red→green for no reflection output, including resize/empty/deferred cases. Evidence: pending.
- [ ] Owned-engine desktop execution exercises the same scene-only reflection path. proof: AC-3 sailing run and reflection native consumer test. Evidence: pending.

### Phase 3: Qualify sailing and reflection correctness

**Status:** NOT STARTED
**Files:** `packages/create-threenative/templates/sailing/playtests/performance.playtest.json` and
existing fixture coverage only where additional reflection states are needed.
- [ ] Sailing and reflection fixtures meet AC-2 with NEUTRAL or IMPROVEMENT verdicts for water, emissives, resize and moving-camera frames. proof: browser/Linux desktop playtests, three GPU timing pairs and two headed capture runs per arm under the batch visual contract. Evidence: pending.
