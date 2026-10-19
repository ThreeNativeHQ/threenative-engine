---
prd_contract: v1
---

# PRD-177 — Native restart and shutdown own their lifetimes

**Status:** BLOCKED (phases 2–3), 2026-08-22 — split by coordinator disposition into
[PRD-184](PRD-184-native-shutdown-ownership-transfer.md),
which owns the three libuv close-then-clear sites and names the missing instrument. **Phase 1
shipped** (commit `f2b70c34`): window/document listener removal is real, proven by
`tests/input_restart_test.cpp` red/green/mutation and by registry row
`97-input-restart-lifetime`, which passes on the desktop lane (pixel mismatch 0.000017 against a
fresh browser reference) and on the Android emulator (mismatch 0.0), and fails with "expected
exactly four deliveries … got 6" when the erase is reverted — case-level revert check executed
2026-08-22. Criterion 1 and the row half of criterion 4 are met; criterion 2 stays honestly
unmet and unprovable today; criteria 3/5 carry phase-1 evidence only. Stop record:
[prd177-phase1-shipped-23-stopped-2026-08-22.md](../../../verification/prd177-phase1-shipped-23-stopped-2026-08-22.md).

**Priority:** P1 — Listener removal returns undefined, protected callbacks never unprotected, shutdown clears live sockets; real native lifetime defects remain.
Filed from the 2026-08-22 area scorecard
([plans/threenative-area-scorecard-2026-08-22.md](../../../../plans/threenative-area-scorecard-2026-08-22.md),
findings #1, #9, #15; runtime-native scored 54/100, the lowest area). Every claim below was
verified at HEAD `a84f08da` by two independent passes.

Complexity: 6 → HIGH mode (multi-site C++ lifetime changes; correctness-sensitive; one owner
reconciles shutdown ordering across all sites — they must not land as independent patches).

**Outcome:** a native game restarts without ghost input events, and the host exits with live HTTP
sockets, interval timers, or a file watch without touching freed libuv handles. Proven by direct
C++ lifetime tests plus a restart conformance case — not by "it crashed less".

**Layer:** engine bug — every fix lands in `packages/runtime-native/src/`, never in game code.

## Context (verified evidence)

1. **Listener removal is a no-op.** `runtime.cpp:3982-3987` — window `removeEventListener` returns
   undefined unconditionally. `runtime.cpp:3785-3801` — document removal's loop body is empty,
   commented "we don't properly compare", and `eventListeners_["document"][eventType]` mints a
   spurious map entry per failed removal. Protected JS callbacks are never unprotected. Meanwhile
   `packages/core/src/input.ts:192-221` registers on window/document and `dispose()` (`:364-376`)
   expects removal to reverse it — after `game.stop()`, disposed InputMap closures keep receiving
   SDL events, and a second InputMap receives ghost events from the first. The canvas slice was
   fixed properly: `runtime.cpp:3650-3654` delegates to `removeEventListenerFromTarget`
   (`:4594-4618`) with identity comparison. **Reuse that path; do not invent a second mechanism.**
2. **libuv close-then-clear at three sites.** Each embeds the libuv handle by value in a context
   struct, calls `uv_close` (async), then immediately clears the owning container — freeing handles
   still on libuv's closing list — before `async::EventLoop::shutdown()` (`runtime.cpp:583`) walks
   every handle (`event_loop.cpp:79-88`):
   - `http/async_http_client.cpp:386-391`: `uv_close(&sockCtx->poll, nullptr)` then
     `impl_->sockets.clear()`. The correct pattern exists in the same file (`:249-258`):
     transfer ownership to `onPollCloseCallback` and erase there.
   - `runtime.cpp:568-579`: `uv_close(nullptr)` then `uvTimers_.clear()`. Contrast the correct
     `clearAllTimers()` at `:707-718`, which closes with `onTimerClose` and comments "Don't clear
     uvTimers_ here".
   - `fs/file_watcher.cpp:143-155`: `uv_close(onWatchClose)` then `watches.clear()`;
     `onWatchClose` (`:111-114`) is a no-op deferring to an already-run destructor.
   `MYSTRAL_USE_LIBUV_TIMERS` is unconditional (`runtime.cpp:59`), so the timer site compiles into
   every build. Impact: use-after-free on every exit with an active interval or watch —
   intermittent crash-at-exit and heap corruption that gets misattributed.
3. **Direct C++ test coverage is 275 lines against 36,751.** Only `tests/audio_graph_test.cpp` and
   `tests/physics_actuation_bindings_test.cpp` test the host directly; the top-churn files
   (`runtime.cpp` 18 commits/8wk, `webgpu/bindings.cpp` 15) have none. This PRD seeds the floor
   with exactly the tests the lifetime fixes need.

## Integration Ledger

| # | New thing | Live caller (`file:line` — fill during implementation) | Replaces | Old path removed? | Negative control |
|---|-----------|--------------------------------------------------------|----------|-------------------|------------------|
| 1 | Identity-based document/window removal | `runtime.cpp` window/document `removeEventListener` properties (same registration sites `:3775-3801`, `:3960-3987`) | the no-op loops | yes, bodies replaced | restart conformance case goes red when the erase is reverted |
| 2 | Closing-list ownership for HTTP sockets | shutdown path `async_http_client.cpp:~386` | clear-after-close | yes | lifetime test with live keep-alive socket red on revert |
| 3 | Closing-list ownership for timers + watches | `runtime.cpp:568-579`, `file_watcher.cpp:143-155` | clear-after-close ×2 | yes | lifetime test with active interval + watch red on revert |
| 4 | Restart conformance case + registry row | `packages/runtime-native/conformance/registry.json` new row; executed by `run-conformance.mjs` | n/a (new proof) | n/a | case fails while #1 is reverted |

## Reachability

- Entry point: real flows — `game.stop()` → `InputMap.dispose()` (every game restart), and host
  shutdown with live handles (every exit). No new API surface; existing contracts finally honored.
- User-facing: no (engine-internal correctness), observed via conformance + restart behavior.
- Replaces: the no-op removal loops and the clear-after-close shutdown ordering — deleted in the
  phases below, not left alongside.

## Phases

#### Phase 1: Document/window listener removal becomes real — restart stops ghosting input

**Files (4):**
- `packages/runtime-native/src/runtime.cpp` - EDIT: route window and document removal through the
  existing `removeEventListenerFromTarget` identity-compare path; erase the listener entry;
  `unprotect` the removed callback; stop minting spurious `eventListeners_` entries.
- `packages/runtime-native/tests/input_restart_test.cpp` - NEW: direct C++ test following the
  registration pattern of `tests/audio_graph_test.cpp`.
- `packages/runtime-native/conformance/registry.json` - EDIT: add a restart case (see below).
- test registration file used by `audio_graph_test.cpp` - EDIT: register the new test.

**Implementation:**
- [ ] Extract/reuse the identity-compare so window, document and canvas share one mechanism.
- [ ] On successful removal: erase from the map, `jsEngine_->unprotect(callback)`.
- [ ] Removal of an unknown callback stays a silent no-op (web semantics), but must not create map
      entries.

**Tests Required:**

| Test File | Test Name | Assertion | Negative control (observed red) |
|-----------|-----------|-----------|---------------------------------|
| `tests/input_restart_test.cpp` | `should deliver a keydown exactly once after stop and restart` | two register→dispose cycles; event count == 2, not 4 | revert the erase in `runtime.cpp` → count 4, red |
| conformance restart case | one input event fires once per registration on the desktop host | case exits 0 | same revert → case red |

**Revert check:** reverting the `runtime.cpp` erase makes both the C++ test and the conformance
case red.

#### Phase 2: HTTP socket shutdown transfers ownership to the close callback

**Files (2):** `packages/runtime-native/src/http/async_http_client.cpp` - EDIT;
`packages/runtime-native/tests/shutdown_lifetime_test.cpp` - NEW (registered as in Phase 1).

**Implementation:**
- [ ] Shutdown moves live `SocketContext`es to a closing list; `sockets.clear()` happens only
      inside `onPollCloseCallback` (mirror `:249-258`).
- [ ] Drain the loop after initiating closes, before the context dies.

**Tests Required:** `should exit cleanly with a live keep-alive socket at shutdown` — open a
socket, shut the client down mid-transfer, process exits 0 (run the binary N=50 times; flaky-free).
Negative control: revert to clear-after-close → intermittent red within 50 runs (if 50 runs stay
green on the reverted code, STOP — the hazard model is wrong, report back instead of shipping).

#### Phase 3: Timers and the file watcher join the same ownership pattern — one owner reconciles

**Files (3):** `packages/runtime-native/src/runtime.cpp` - EDIT (`uvTimers_` shutdown path);
`packages/runtime-native/src/fs/file_watcher.cpp` - EDIT; `shutdown_lifetime_test.cpp` - EDIT.

**Implementation:**
- [ ] Timers: closing list + erase in `onTimerClose` (the pattern `clearAllTimers()` already uses).
- [ ] Watcher: make `onWatchClose` erase the entry and free its context; shutdown only initiates
      closes.
- [ ] One owner reads all three shutdown paths end-to-end after this phase and confirms a single
      ordering story: initiate closes → drain → destroy. This phase is not done until that story
      is written into `runtime.cpp` as a comment at the shutdown site.

**Tests Required:** `should exit cleanly with an active interval timer and an active watch at
shutdown` — same N=50 discipline and negative control as Phase 2.

#### Phase 4: The proof is wired into the lanes the repo already runs

**Files (2):** `packages/runtime-native/conformance/registry.json` - EDIT (restart case from
Phase 1 + a shutdown case); `docs/verification/` - NEW record naming what executed.

**Implementation / verification:**
- [ ] `pnpm native:build` green; `pnpm native:verify:desktop` green (300 frames + non-blank shot).
- [ ] `pnpm parity` executes the new registry rows; `pnpm parity:ledger` green.
- [ ] `pnpm census` re-run **in the same commit** as the runtime-native change (census is
      generated, never retyped; the budgets gate enforces it).
- [ ] `pnpm typecheck && pnpm lint && pnpm test` green.

## Acceptance criteria (consumer-scoped)

| # | Criterion | Evidence |
| --- | --- | --- |
| 1 | A native game that calls `stop()` then starts again receives each input event exactly once per registration | pasted conformance case output |
| 2 | The host exits 0, 50/50 runs, with a live keep-alive socket, an active interval, and an active watch | pasted run summary |
| 3 | Red-green mutation: reverting the Phase 1 erase reproduces ghost input; reverting any Phase 2/3 ownership transfer makes the lifetime test flaky-or-red within 50 runs | pasted reds |
| 4 | The restart and shutdown cases are registry rows executed by `pnpm parity`, not orphan test files | pasted `parity` output naming the rows |
| 5 | `pnpm typecheck && pnpm lint && pnpm test` green; census re-tied in the same commit | pasted outputs |

## Deliberately out of scope

- The remaining C++ test-floor expansion beyond lifetime (bindings.cpp etc.) — its own future PRD.
- ASan-in-CI: if the native build has no ASan configuration, prove with the N=50 stress discipline
  and record ASan wiring as a named follow-up. Do not silently claim ASan coverage.
- Web-side input semantics: web removal already works; nothing here touches it.
