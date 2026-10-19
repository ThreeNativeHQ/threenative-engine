---
prd_contract: v1
---

# PRD-184 — Native shutdown transfers ownership to the libuv close callbacks

**Status:** BLOCKED, 2026-08-22, on an instrument this repository does not have. Split out of
[PRD-177](PRD-177-native-restart-shutdown-lifetime.md) by coordinator
disposition: phase 1 (listener removal) shipped there with its own evidence; phases 2–3 (the
three libuv close-then-clear sites) cannot land honestly because their own negative control
cannot fire — see the stop record
([prd177-phase1-shipped-23-stopped-2026-08-22.md](../../../verification/prd177-phase1-shipped-23-stopped-2026-08-22.md)).

**Priority:** P1 — Shutdown use-after-free real by inspection stays unfixed and unproven; ownership transfer waits on an ASan libuv build.
**Outcome:** the host exits 0, 50/50 runs, with a live keep-alive socket, an active interval, and
an active file watch, and the exit stays clean when each fix's named lines are reverted and the
harness turns red within the same 50 runs. Both halves of that sentence need an allocator-error
instrument that can see a write-after-free; exit codes alone cannot.

## The three sites (unchanged, verified at the stop)

Each embeds the libuv handle by value in a context struct, calls `uv_close` (asynchronous), then
immediately clears the owning container — freeing contexts whose handles libuv still has on its
closing list — before `async::EventLoop::shutdown()` drains:

1. `packages/runtime-native/src/http/async_http_client.cpp` shutdown path: `uv_close` then
   `impl_->sockets.clear()`. The correct pattern exists in the same file — the CURL_POLL_REMOVE
   branch transfers ownership to `onPollCloseCallback`, which frees the context.
2. `packages/runtime-native/src/runtime.cpp` shutdown path: `uv_close(nullptr)` then
   `uvTimers_.clear()`. The correct pattern is `clearAllTimers()`/`onTimerClose` in the same
   file, which closes with a callback and erases from the map only there.
3. `packages/runtime-native/src/fs/file_watcher.cpp` shutdown and `unwatch`: `uv_close(onWatchClose)`
   then `watches.clear()`/`erase(it)`; `onWatchClose` is a no-op deferring to a destructor that
   has already run.

The fix shape for all three is one ownership rule: initiate closes, drain, destroy — destruction
happens only inside the close callback, mirroring the two correct patterns above. One owner
writes the single ordering story into `runtime.cpp` at the shutdown site.

## The harness is built and waiting

`packages/runtime-native/tests/shutdown_lifetime_test.cpp` (CMake target
`threenative-shutdown-lifetime-test`, EXCLUDE_FROM_ALL) drives both scenarios: `http` holds a
real keep-alive connection open through teardown; `timer-watch` runs a live `setInterval` plus a
registered fs_event watch through pumped frames before full `RuntimeImpl::shutdown()`. It is
unfired by design — it cannot see the defect it drives, which is the point of this PRD.

## Why the negative control cannot fire today

Measured on 2026-08-22, 50 runs per mode against the then-HEAD (which IS clear-after-close):
0 red. A `MALLOC_PERTURB_=53` probe added nothing (0/10).

- **glibc tcache preserves freed bytes.** Small freed chunks go to per-thread caches
  unperturbed — `MALLOC_PERTURB_` does not cover them — so every stale read/write libuv performs
  during the drain sees coherent old values. The corruption is real (use-after-free by
  inspection) and silent at minimal-process scale; production heap pressure is what makes it
  intermittent.
- **valgrind** is not installed on this machine.
- **ASan cannot see it either** without instrumenting libuv itself: libuv ships only as a
  prebuilt static archive (`third_party/libuv`, "Prebuilt layout" in CMakeLists.txt), and an
  uninstrumented libuv writing into freed memory bypasses ASan shadow checks. The sanctioned
  dependency reconstruction path (`scripts/download-deps.mjs`) has no libuv source-build mode.

## What unblocks it

1. A libuv **source build** wired through `scripts/download-deps.mjs` (or vendored via CMake
   `add_library`) so the archive can be compiled with `-fsanitize=address` for a desktop test
   configuration.
2. An ASan build configuration for the native runtime (desktop test target is sufficient; the
   prebuilt dawn/wgpu libraries do not need instrumentation — the contexts are allocated by
   instrumented code).
3. Then: apply the ownership transfer at the three sites; the harness goes red on reverted code
   within the 50-run discipline and green 50/50 fixed; the one-owner ordering-story comment lands
   in `runtime.cpp`; `pnpm census` rides the commit.

Until then, criterion 2 of PRD-177 stays honestly unmet, and nothing ships on the masked
50/50-green behavior.
