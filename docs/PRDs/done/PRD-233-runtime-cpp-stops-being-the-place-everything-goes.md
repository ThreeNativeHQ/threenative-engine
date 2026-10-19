---
prd_contract: v1
---

# PRD-233 — `runtime.cpp` stops being the place everything goes

**Status:** PROPOSED — filed 2026-08-28. Depends on
[PRD-229](PRD-229-the-native-host-is-provable-before-it-is-moved.md) only — it needs the
instruments, not the WebGPU split, so it can run in parallel with PRD-230.

Fifth PRD of the runtime-native refactor batch.

**Goal: the host's browser-compatibility shims live in files named after what they shim**, so a
change to `fetch` does not touch the same file as a change to the frame callback.

**Complexity:** +2 (6–10 files) +2 (timers, event loop, lifetime) +1 (the shim manifest is an
enforced contract) = **5 → MEDIUM mode.**

## The problem, measured

| Metric | Value |
| --- | ---: |
| `src/runtime.cpp` | 3,558 lines |
| `setupDOMEvents` | **630 lines** |
| `setupFetch` | 276 lines |
| Distinct `setup*` installers in one class | 13 |
| Preprocessor directives | 90 |
| Line coverage (measured 2026-08-28) | 50.45% |
| Commits in 90 days | 38 |
| Vitest files naming this file in assertions | 33 |

`setupAnimationFrame`, `setupTimers`, `setupLibuvTimers`, `setupChronoTimers`, `setupPerformance`,
`setupProcess`, `setupStorage`, `setupFetch`, `setupURL`, `setupModules`, `setupRayTracing`,
`setupUiBridge` and `setupDOMEvents` are thirteen unrelated browser surfaces sharing one class and
one file.

**This one has a regression net the others do not**: `shim-manifest.json` records every global the
host installs, and `scripts/check-native-shims.ts` enforces it from `pnpm budgets`. A move that
drops or renames a global fails an existing gate. That is why this PRD is cheap relative to its
size — and the manifest must be treated as the primary control, not as documentation.

## Solution

- One file per surface: `src/runtime/dom_events.cpp`, `fetch.cpp`, `timers.cpp`, `url.cpp`,
  `storage.cpp`, `performance.cpp`, `process.cpp`, `ui_bridge.cpp`.
- Each exposes one installer taking the engine and the runtime state; `runtime.cpp` keeps
  construction, the frame loop and lifecycle, and calls them.
- **Functions move verbatim.** No shim's behaviour changes; the manifest proves it.

**Data changes:** none. `shim-manifest.json` must be byte-identical at the end.

## Integration Ledger

| # | New thing | Live caller (`file:line`, non-test) | Replaces | Old path removed? | Negative control |
|---|---|---|---|---|---|
| 1 | `src/runtime/<surface>.cpp` installers | `Runtime::initialize` in `runtime.cpp` | the `setup*` members | yes, per commit | deleting an installer call drops its globals and `pnpm budgets` fails on the shim manifest |
| 2 | Per-surface behaviour tests | `ctest` | the source-text assertions in 33 vitest references | those assertions deleted per commit | rename the C++ symbol → green; break the shim → red |

## Execution phases

One surface per commit, each its own checkpoint. Order: least entangled first.

1. `performance.cpp`, `process.cpp`, `url.cpp` — small, self-contained
2. `storage.cpp` — has an executable test already (`local_storage_test.cpp`, 86.54% covered)
3. `fetch.cpp` — 276 lines, has `fetch-shim` and `fetch-local-asset` tests
4. `timers.cpp` — the three timer installers; has `timer_delivery_test.cpp`
5. `dom_events.cpp` — 630 lines, last, because it is the most entangled with lifecycle

**Files per commit:** the new file, `runtime.cpp`, `CMakeLists.txt`, the converted test, the record.

**Per-commit verification:**
- [ ] `shim-manifest.json` unchanged and `pnpm budgets` green — the primary control
- [ ] PRD-229 behaviour tests, `ctest`, ASan lane green
- [ ] Coverage floors hold; `runtime.cpp` line count falls
- [ ] `render.p50` within 2% (timers and the frame callback are on the hot path)

**Negative control per commit:** delete one installer call from `initialize` → `pnpm budgets` fails
naming the missing globals. Observed and pasted, once per commit.

## Acceptance criteria

- [ ] **A developer changing `fetch` opens a file called `fetch.cpp`** and touches nothing else.
- [ ] **`shim-manifest.json` is byte-identical** to its pre-refactor content, proving no global was
      dropped, added or renamed.
- [ ] **Every timer, DOM-event and fetch behaviour asserted today is asserted by a test that
      survives a rename and fails on a behaviour change.**
- [ ] **`render.p50` within 2%** of the PRD-229 baseline.
- [ ] **`runtime.cpp` is under 1,000 lines** and contains construction, the frame loop and
      lifecycle only.

## Risks

| Risk | Mitigation |
| --- | --- |
| **Initialization order matters and is implicit.** | One surface per commit with the full gate set; the order of installer calls in `initialize` is preserved exactly. |
| **The DOM-event surface is entangled with lifecycle.** | It moves last, after every other surface has proved the pattern. |
| **33 vitest files reference this file's text.** | PRD-229 Phase 5 converts the ones covering these surfaces first; this PRD converts the rest as it goes. |

## Verification evidence

- NOT RUN
