---
prd_contract: v1
---

# PRD-232 — profiling is a component, not a smear

**Status:** PROPOSED — filed 2026-08-28. Depends on
[PRD-230](PRD-230-the-webgpu-bindings-move-one-surface-at-a-time.md) Phase 2, which puts the
profiling fields inside a `FrameProfiling` sub-struct. **Coordinate with
[PRD-227](../performance/PRD-227-the-frame-crosses-once.md) and
[PRD-228](PRD-228-the-pixel-budget-is-the-engines.md) before starting** — they own these meters
and are live.

Fourth PRD of the runtime-native refactor batch.

**Goal: the frame meters are one component with one owner, testable on their own, and removable
from a build without touching the code they measure.**

**Complexity:** +2 (6–10 files) +2 (per-frame timing, Android-only paths) +1 (measurement
instrument the perf lane depends on) = **5 → MEDIUM mode.**

## The problem, measured

| Metric | Value |
| --- | ---: |
| `TN_ANDROID_JS_PROFILE` occurrences in `src/` | **64** |
| Frame-phase counters in `BindingsState` | 6 (`framePhaseDrainNs` … `framePhaseOtherNs`) plus 6 more timing fields |
| `#if` blocks inside the `BindingsState` struct definition | 3 |
| Emission function | `emitAndroidJsNativeProfile`, 117 lines |

The meters are correct and hard-won — `TN_HOST_GAP`'s decomposition is what named the missing
~25 ms. The problem is where they live: inside the struct definition, inside the hot binding
functions, and inside `endDawnFrame`, so the profiling concern and the rendering concern are edited
in the same lines by different people for different reasons.

## Solution

- One `FrameProfiler` type owning every counter, the phase timing and the emission.
- Its methods compile to nothing when the flag is off, so the hot path pays what it pays today.
- The struct's conditional shape disappears: `FrameProfiling` is always present, its contents
  conditional in one place.
- **The meters keep producing byte-identical output.** That is the acceptance test.

**Data changes:** none — the emitted profile lines keep their exact format, because the playtest
CLI and the Android measurement scripts parse them.

## Integration Ledger

| # | New thing | Live caller (`file:line`, non-test) | Replaces | Old path removed? | Negative control |
|---|---|---|---|---|---|
| 1 | `FrameProfiler` | `endDawnFrame`; the per-surface binding files | 64 scattered `TN_ANDROID_JS_PROFILE` sites and 12 raw fields | yes, same commit | a captured profile log from before and after must be identical for the same scene |
| 2 | Profiler unit test | `ctest` | nothing — the meters have never been tested alone | n/a | feed known phase timings, assert the emitted line; perturb one, assert it changes |

## Execution phases

#### Phase 1: The meters get a test before they get a home

**Files:** `tests/frame_profiler_test.cpp` (NEW), `CMakeLists.txt` (EDIT), `package.json` (EDIT),
the record.

- [ ] Capture a real profile log from the current build for a fixed scene; store it as a fixture.
- [ ] The test drives the emission path with known inputs and asserts the exact output format.

| Test file | Test name | Assertion | Negative control |
|---|---|---|---|
| `tests/frame_profiler_test.cpp` | `should emit the recorded format for known phase timings` | byte-exact line | change one timing → the line changes; change the format → red |

**Revert check:** the fixture is the pre-refactor output; any later phase that alters it reds here.

#### Phase 2: `FrameProfiler` takes ownership

**Files:** `src/webgpu/frame_profiler.h` / `.cpp` (NEW), `src/webgpu/bindings_state.h` (EDIT),
`src/webgpu/bindings.cpp` or its per-surface descendants (EDIT), `CMakeLists.txt` (EDIT).

- [ ] Counters, phase timings and emission move verbatim.
- [ ] Flag-off builds contain no profiling code — verified by symbol absence, not by reading.

**Verification:** Phase 1's byte-exact test; PRD-229's behaviour tests; ASan lane; **`render.p50`
within 2%**, measured with profiling both on and off.

#### Phase 3: The Android meter is proved on a device, or recorded unexecuted

- [ ] A Pixel 8 run comparing the profile output before and after. If no device run happens, this
      PRD records **"no device result claimed"** and stays open on that row.

## Acceptance criteria

- [ ] **A perf engineer can read `endDawnFrame` without reading profiling code**, and can delete
      the profiler from a build without editing a single rendering line.
- [ ] **The emitted profile is byte-identical before and after**, for the same scene — the playtest
      `perf` reader and the Android scripts keep working unchanged.
- [ ] **The meters have their own test**, which fails when a phase timing is misattributed.
- [ ] **`render.p50` within 2%** with profiling off, and the profiling-on cost unchanged.

## Risks

| Risk | Mitigation |
| --- | --- |
| **Collision with a live perf lane.** | Coordinate with PRD-227/228 first; this PRD waits for them rather than the reverse. Their measurements depend on these meters. |
| **A refactor that silently changes what a meter counts.** | Phase 1 lands the byte-exact fixture test *before* anything moves. |
| **Flag-off builds accidentally paying for profiling.** | Symbol-absence check, plus the profiling-off `render.p50` A/B. |

## Verification evidence

- NOT RUN
