---
prd_contract: v1
---

# PRD-231 — the backend dialect stops leaking into the binding code

**Status:** PROPOSED — filed 2026-08-28. Depends on
[PRD-230](PRD-230-the-webgpu-bindings-move-one-surface-at-a-time.md): the surfaces must have
their own files before their dialect branches can be pushed behind a header, or the diff is
unreviewable.

Third PRD of the runtime-native refactor batch.

**Goal: the WebGPU binding code reads as one implementation.** Which WebGPU C dialect it compiles
against — Dawn, modern wgpu-native, legacy wgpu-native — is a fact of the build, not a fact the
binding logic branches on line by line.

**Complexity:** +2 (6–10 files) +2 (three dialects, three build configurations) +2 (touches the
same hot files as the perf lane) = **6 → MEDIUM mode.**

## The problem, measured

| Metric | Value |
| --- | ---: |
| `#if`/`#ifdef`/`#else`/`#elif`/`#endif` in `src/webgpu/bindings.cpp` | **217** |
| … in `src/webgpu/context.cpp` | **122** |
| `include/mystral/webgpu_compat.h` | 241 lines |
| Dialects it must serve | 3 (Dawn, `MYSTRAL_WEBGPU_WGPU_MODERN`, legacy wgpu) |

`webgpu_compat.h` already exists and is the right idea — typedefs, `_Compat` aliases, feature
macros like `WGPU_USES_CALLBACK_INFO_PATTERN`. It is simply unfinished: 339 preprocessor
directives still sit inside logic in the two largest WebGPU files. `context.cpp:216` writes the
same function's signature **twice**, once on each side of an `#else`, which is why a brace-counting
reader attributes it 1,379 lines.

The cost is not aesthetic. Every dialect branch inside a function is a path some configuration
never compiles, so it is never type-checked, never covered, and never sanitized in that
configuration — and `src/webgpu/context.cpp` sits at **20.15% line coverage** today.

## Solution

- Move each remaining difference into `webgpu_compat.h` as a typedef, a macro, or a small `inline`
  adapter function — the forms already used there.
- A function may have **one** dialect-conditional line: which compat helper it calls. Bodies stop
  branching.
- Where a dialect genuinely lacks a capability, the difference becomes a named compat constant
  (`WGPU_NEEDS_PROC_INIT` is the existing example), not an inline `#if`.
- Nothing about behaviour changes in any configuration.

**Data changes:** none.

## Integration Ledger

| # | New thing | Live caller (`file:line`, non-test) | Replaces | Old path removed? | Negative control |
|---|---|---|---|---|---|
| 1 | Compat adapters for the remaining call-shape differences | the per-surface `bindings_*.cpp` files from PRD-230 | inline `#if` blocks in those files | yes, per commit | building each of the three dialects; a missing adapter fails to compile, it cannot silently no-op |
| 2 | A directive-count gate | `scripts/check-budgets.ts` | nothing | n/a | raising the count by hand fails the gate |

## Execution phases

#### Phase 1: The three dialects all build, and a gate counts the directives

**Files:** `scripts/check-native-dialects.ts` (NEW), `scripts/check-budgets.ts` (EDIT),
`docs/verification/native-dialect-baseline-2026-08-28.md` (NEW), `package.json` (EDIT).

- [ ] Record which build directory covers which dialect today (`build/tn-linux` = Dawn,
      `build/tn-linux-wgpu` and `build/tn-android` = wgpu) and which dialect has **no** lane.
- [ ] The gate records the current per-file directive count and fails when it rises.

| Test file | Test name | Assertion | Negative control |
|---|---|---|---|
| `scripts/__tests__/check-native-dialects.spec.ts` | `should fail when a file gains preprocessor directives` | count > baseline is a failure | add one `#if` to a fixture → red |
| `tests/native-dialect-lane.test.mjs` | `should name every dialect with no build lane` | unlaned dialects are listed, not implied | remove the naming branch → red |

**Revert check:** remove the call from `check-budgets.ts` → the spec asserting `pnpm budgets` runs
it reds.

#### Phase 2: `context.cpp` stops branching

**Files:** `src/webgpu/context.cpp` (EDIT), `include/mystral/webgpu_compat.h` (EDIT), the record.

- [ ] The double-signature `onWgpuLog` becomes one function taking a compat string type.
- [ ] Adapter/device request, surface creation and present paths call compat helpers.

**Verification:** all three dialects compile; PRD-229's behaviour tests, `ctest` and the ASan lane
stay green; `render.p50` within 2%; directive count drops and the gate's baseline is lowered in the
same commit.

#### Phase 3: The per-surface binding files stop branching

**Files:** one `bindings_*.cpp` per commit (EDIT), `webgpu_compat.h` (EDIT), the record. Repeat
per surface, each its own checkpoint.

**Verification:** same set, per commit.

## Acceptance criteria

- [ ] **A developer reading a binding function sees one implementation**, not three interleaved —
      no function body outside `webgpu_compat.h` contains a dialect `#if`.
- [ ] **Each of the three dialects builds and runs its contract tests**, and any dialect without a
      lane is named as unexecuted rather than implied green.
- [ ] **`pnpm budgets` fails when a file regains directives.**
- [ ] **`render.p50` within 2%** of the PRD-229 baseline; conformance rows unchanged.
- [ ] Coverage of `src/webgpu/context.cpp` rises, or the reason it did not is stated.

## Risks

| Risk | Mitigation |
| --- | --- |
| **A dialect nobody builds here breaks silently.** | Phase 1 names the unlaned dialect before any code moves; a dialect with no lane blocks Phase 3 for the files it touches. |
| **A compat macro hides a real semantic difference** (a status enum that means something else). | Adapters are typed functions where a typedef would lose meaning; each adapter names the difference in a comment. |
| **Churn collision with the perf lane.** | Per-surface commits, coordinated the same way as PRD-230. |

## Verification evidence

- NOT RUN
