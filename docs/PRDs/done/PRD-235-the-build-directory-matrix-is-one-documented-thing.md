---
prd_contract: v1
---

# PRD-235 — the build-directory matrix is one documented thing

**Status:** PROPOSED — filed 2026-08-28. Depends on
[PRD-229](PRD-229-the-native-host-is-provable-before-it-is-moved.md) Phases 1–2 (CTest
registration and the coverage configuration), which decide what a build directory is *for*.

Seventh PRD of the runtime-native refactor batch.

**Goal: which build directory a test executable lives in is written down and enforced, not tribal
knowledge.**

**Complexity:** +2 (6–10 files) +1 (build configuration) = **3 → LOW mode**, but it is the
difference between a green gate and a gate nobody can reproduce.

## The problem, measured

`packages/runtime-native/build/` holds **nine** directories:

`tn-linux`, `tn-linux-quickjs`, `tn-linux-dual`, `tn-linux-wgpu`, `tn-linux-contracts-physics`,
`tn-linux-contracts-video`, `tn-android`, `prd223-perf-current`, `prd223-vulkan-proof`.

Each grew for a real reason — a second JS engine, a second WebGPU backend, a contract set needing a
feature flag the default preset turns off, a perf comparison. Nothing records the mapping. The
vitest wrappers hardcode paths (`build/tn-linux`, `build/tn-linux-quickjs`) and a test executable
built in the wrong directory either does not exist or, worse, exists and answers a different
configuration's question.

Two facts already measured make this concrete:

- `threenative-physics-actuation-bindings-test` **does not link** in `tn-linux` — it needs
  `TN_ENABLE_NATIVE_PHYSICS=ON` — and today that looks identical to "not run".
- `threenative-render-pass-class-table-test` **passes in `tn-linux` and fails in an instrumented
  build**, recorded in
  [native-coverage-scouting-2026-08-28](../../verification/native-coverage-scouting-2026-08-28.md).

## Solution

- One `build-matrix.json` in the package: for each named configuration, its preset, its cache
  variables, the engines and backends it covers, and the test targets that can link in it.
- CMake and the vitest wrappers read it instead of hardcoding directory names.
- A gate fails when a target is registered in no configuration, or a configuration in the file does
  not exist in `CMakePresets.json`.
- Retire the two `prd223-*` directories if their PRD is closed; keep whatever is still cited.

**Data changes:** a new machine-readable manifest, in the shape of the existing
`shim-manifest.json` and `js-engine-versions.json` — both precedents for "the contract is a file
the gate reads".

## Integration Ledger

| # | New thing | Live caller (`file:line`, non-test) | Replaces | Old path removed? | Negative control |
|---|---|---|---|---|---|
| 1 | `build-matrix.json` | `scripts/check-build-matrix.ts` from `pnpm budgets`; the vitest wrappers | hardcoded directory strings in wrappers | replaced per wrapper | a target listed in no configuration fails the gate |
| 2 | `scripts/check-build-matrix.ts` | `scripts/check-budgets.ts` | nothing | n/a | rename a preset without updating the file → red |

## Execution phases

#### Phase 1: The matrix exists and is enforced

**Files:** `build-matrix.json` (NEW), `scripts/check-build-matrix.ts` (NEW),
`scripts/check-budgets.ts` (EDIT), `tests/build-matrix.test.mjs` (NEW), the record.

| Test file | Test name | Assertion | Negative control |
|---|---|---|---|
| `tests/build-matrix.test.mjs` | `should fail when a test target belongs to no configuration` | named failure | add an `add_executable` without a matrix row → red |
| `tests/build-matrix.test.mjs` | `should fail when a configuration names a preset that does not exist` | named failure | rename a preset → red |

**Revert check:** remove the call from `check-budgets.ts` → the spec asserting `pnpm budgets` runs
it reds.

#### Phase 2: The wrappers read the matrix

**Files:** the vitest wrappers that hardcode a build directory (EDIT, a few per commit),
`tests/runtime-test-utils.ts` (EDIT), the record.

- [ ] A wrapper resolves its executable through the matrix and reports **blocked with the reason**
      when the configuration was never built — never a silent skip.

#### Phase 3: Retire what is dead

- [ ] For each of the nine directories, name the PRD or lane that still needs it. Delete the
      unreferenced ones from the documented matrix (the directories themselves are untracked).

## Acceptance criteria

- [ ] **A developer can answer "where does this test binary live and why" from one file.**
- [ ] **A test target that can link in no configuration fails a gate**, instead of being
      indistinguishable from an unbuilt one.
- [ ] **An unbuilt configuration produces "blocked, and here is the build command"**, never a pass
      and never a bare skip.
- [ ] **Every retained build directory names the lane that needs it.**

## Risks

| Risk | Mitigation |
| --- | --- |
| **The matrix becomes a fifth hand-maintained enumeration that drifts.** | It is generated-checked against `CMakePresets.json` and `CMakeLists.txt`, and the gate fails on drift — the same pattern that makes `shim-manifest.json` trustworthy. |
| **Deleting a directory another agent's lane is using.** | Phase 3 only edits documentation; the untracked directories are left alone. |

## Verification evidence

- NOT RUN
