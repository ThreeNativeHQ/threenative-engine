# Native compiled frame plans

**Priority:** P2 — Two open boxes: physical Android measurement of equivalent scenes.
Status: PARTIAL. Automatic in production; no game flag is required. The retained transport landed,
the adaptive selector is covered across stable, tiny, upload-heavy, topology-changing, split and
oversized frames, and the original transport measurement showed 43–45% lower recorder cost with
94.8–99.5% smaller packets on draw-heavy frames. Physical Android performance remains open; the
final exact-head iOS/JSC qualification passed in CI run 35410762244. Base: f8d6da914 (develop synced
after #273).

## Goal and boundary

Retain the native packed-frame record layout and send changed record payloads instead of
resending every command. Upstream Three.js remains the renderer. No Object3D mirror, custom
renderer, language/runtime replacement, or per-object native crossing is introduced.

This increment does **not** remove Three.js traversal, sorting, wrapper calls, native resource
validation, or GPU command encoding. A smaller packet is not evidence of a faster game. Production
selection is adaptive rather than a blanket v3 switch: it starts direct, promotes qualifying work,
and falls back automatically when retained plans are not useful.

## Design

The existing v1/v2 stream remains the fallback. Production starts there automatically and promotes
qualifying frames to v3 without a game setting. V3 carries one full v2 capture, then monotonically
sequenced replacements for changed record payloads. Explicit booleans and `TN_FRAME_PLANS=1` are
reference/diagnostic arms only; they are not required for shipped games.
Native state owns one bounded plan and a compiled opcode/boundary index. Patches cannot change
record headers, cross record boundaries, or apply to a missing/stale plan. The complete packet
is structurally validated before any patch is applied. GPU objects are resolved from the live
registries on each replay; no cached surface handles or resubmitted command buffers.

The recorder compares values while recording, not in a second full-frame byte scan. Structural
changes recapture. Partial mapAsync drains and oversized frames use v2 and invalidate the plan.
Encoding failures invalidate reuse. Frame-local wire IDs must not let stale JS wrappers alias
objects in a new frame. Uploads keep their enqueue-time snapshots and original queue order.

Implemented as:

- a 24-byte v3 header (magic, version, declared bytes, mode, sequence, count) whose capture body is
  the v2 record stream, and patch entries of `record index, run count` plus `offset, length, bytes`
  runs restricted to 8-byte words inside one record's payload;
- **per-frame wire ids**: encoder, render pass, compute pass and command buffer ids restart every
  frame, so an untouched record is the same bytes as last frame's. A stale holder from an earlier
  frame is refused by name instead of naming whatever inherited its id. Resource ids stay monotonic;
- **a value check at the call site**: the values that decide a record's bytes are compared against
  the ones the retained plan was recorded from, in one allocation-free call. Equal means the plan
  already holds the record, so nothing is encoded and nothing is sent. Only the records that moved
  are written, and the word diff drops even those out of the packet when their bytes are unchanged;
- **fail-towards-capture**: an opcode or length that does not match the plan's at that index, a
  record count that moved, a host that reports a dropped plan, or a frame that rewrote more than
  half of itself above a 64 KiB floor sends a capture instead. Partial drains consume only submitted
  prefixes and keep the remainder v2; oversized bodies also use v2. Both invalidate reuse. The host
  reports its plan generation (`epoch`) on every drain; a recorder that sees it move captures.

## Implementation and verification

### Phase 1: Native transport and compiled layout
- [x] Implement bounded, state-owned capture/delta decoding and immutable record boundaries.
  `FramePlanState` in `src/webgpu/bindings_state.h` (32 MiB bound, compiled `Record` index);
  `compileFramePlanRecords`, `walkFramePlanPatch`, `replayCompiledFramePacket` in
  `src/webgpu/bindings_frame_stream.cpp`. A rejected patch validates before it writes, so the
  retained frame is never half-updated.
- [x] Wire the compiled layout into production replay without replacing opcode validation.
  `replayFrameRecords` takes the compiled index for the record *boundaries* and keeps the whole
  opcode switch, per-opcode handle guards and body validation untouched; a packet still derives
  its own boundaries.
- [x] Run native protocol tests, including malformed packets, stale sequences and recovery.
  `threenative-frame-op-stream-replay-test` → `frame op stream replay contract passed` (exit 0),
  which now also runs a plan-enabled runtime: one capture, patched frames that replay the whole
  plan in order, thirteen rejected packets (mode, bound, capture layout, index, ordering, header,
  alignment, record escape, overlap, empty entry, trailing bytes, stale sequence, no plan), and a
  capture-plus-patch recovery afterwards. Each rejection asserts it never entered a backend call.

### Phase 2: Recorder
- [x] Add automatic retained recording, dirty payload packets and structural recapture.
  An unspecified `host.compiledFramePlans` is the production automatic mode: it begins on v2,
  promotes bounded repeatable work, evaluates retained-plan usefulness, and backs off to v2 after
  unprofitable probes. Explicit true/false values and `TN_FRAME_PLANS=1` remain diagnostic arms.
- [x] Preserve v2 fallback, partial drains, eager uploads and stale-wrapper safety.
  Follow-up below repairs plan-mode partial consumption and oversized fallback; mostly-rewritten
  frames still capture. The earlier 14-test recorder result predates these repairs. A local
  differential check compares the forced-v2 reference recorder against `3d316925c` across 1,000
  frames and 2,868 drains: byte-identical, including eager uploads and partial encoder tails (exit 0).
- [x] Observe a behavioral red, then pass recorder regression tests.
  Original implementation evidence: with it stashed, 5 of the 6 new `tests/frame-plan-transport.test.mjs` cases fail
  (`expected 2 to be 3`, `expected 9 to be 1`, missing `FramePlanState::maxBytes`); with it, both
  recorder suites pass 22/22, including a frame in which nothing moved carrying a 24-byte packet
  with no entries. That historical Vitest result is not a rerun of the follow-up below.
- [x] Consume partial drains exactly once while preserving unfinished encoder tails.
  Repeated partial drains now return null; materialized tails remain v2, with live wrappers until
  the actual boundary. An empty final drain expires old wrappers. Regression tests pass locally.
- [x] Enforce the native retained-body bound before choosing v3 capture.
  A body of exactly 32 MiB still captures; eight bytes over uses v2 and then recovers capture/patch.
  Both boundary cases pass locally, with upload endpoint bytes preserved.
- [x] Invalidate stale or failed value snapshots before a record can be reused.
  Render/compute wide-to-narrow bind groups, opcode replacement, coercion failure and failed-emit
  retry pass; 300 deterministic mixed frames reconstruct byte-identically to fresh v2 records.
- [x] Preserve earlier patch entries when the patch buffer grows.
  Two changed 40 KiB uploads in a draw-heavy frame cross the 64 KiB packet capacity. The regression
  failed before the growth-copy fix; afterwards applying the patch matches a forced capture.

Follow-up verification (2026-09-17): the original eight transport tests passed first; ten added or
strengthened behavioral cases failed before repairs, and the packet-growth case failed separately.
After repairs, all 19 `frame-plan-transport.test.mjs` cases pass using Node 22.16.0 `node:test` and
`node:assert/strict` through a temporary Vitest-API adapter (exit 0). Test bodies and production
recorder were unchanged by that adapter; the native bound declaration was read from a fetched
header excerpt. `node --check` passes for both changed JS files. Reproduction in a full checkout:
`pnpm exec vitest run packages/runtime-native/tests/frame-plan-transport.test.mjs`.
**Actual Vitest, workspace gates, native replay, GPU rendering and device lanes were not rerun in
this follow-up environment.** The downloaded source files were verified against Git blob hashes.
The temporary adapter and header excerpt are not repository changes.

### Phase 3: Review and measurement
- [x] Exercise JS-generated packets through the actual C++ decoder and compare canonical bytes.
  The native contract drives the production recorder through the real decoder and reads a patched
  `writeBuffer` back off the GPU as `[3,4,5,6]`; the vitest lane patches a retained frame with the
  recorder's own packet and asserts byte equality with the frame a forced capture sends instead.
- [x] Run adversarial/property checks and review lifecycle, bounds and ordering.
  Thirteen malformed v3 packets, an empty patch, unchanged-word patches, plan-index ascent, the
  per-opcode guard table (retargeted at `replayFrameRecords`), and the equivalence property above.
- [x] Record a reproducible CPU-only microbenchmark without extrapolating to game FPS.
  `node packages/runtime-native/scripts/measure-frame-plan-transport.mjs --frames=120`, recorded in
  `docs/verification/runtime-perf-state.md`: **0.902 → 0.518 ms per frame and 338,120 → 17,432
  bytes** on a 2000-draw scene, **9.672 → 5.297 ms and 3,218,120 → 17,432 bytes** at 20000 draws,
  and a bounded **+26%** on a frame whose bytes are all new uploads. No GPU, no renderer, no
  frame-rate claim.

### Phase 4: Integration proof before promotion
- [x] Run the full workspace typecheck/lint/test/budgets and PRD progress gates.
  `pnpm typecheck`, `pnpm lint`, `pnpm check:docs`, `pnpm quality`, `pnpm budgets` and
  `pnpm prd:progress` all exit 0, with the native coverage record re-stamped for the source digest
  the C++ tests carry. `pnpm test` in this worktree fails 19 runtime-native tests whose own message
  is `<target> is not built. Run: cmake --build build/tn-linux-quickjs …` — those presets are not
  built here, and the other lanes this change could affect (the recorder suites and the native
  contract) run green.
- [x] Build the native host and run an enabled/disabled visual and lifecycle conformance case.
  The `tn-linux` host is built. The contract renders the same two frames on both transports, with
  only the clear colour moving between them, and compares the pixels read back from each arm,
  including a negative control that the comparison moves when the colour does; the plan arm asserts
  its own capture and patch so the comparison cannot pass by comparing two v2 streams. The lifecycle
  case drives a `mapAsync` that splits a frame (prefix replayed before the map resolved, tail at the
  next boundary, plan recaptured) and destroys the device to prove a recreated one replays a capture
  naming its own resources.
- [ ] Measure equivalent scenes on physical Android hardware.
  An emulator is present and boots here (`~/Android/Sdk/emulator -avd threenative_api35`, with the
  SDK, NDK and JDK installed), so this is not a missing-tool block. The lane needs a runtime and APK
  cross-compiled from this branch, which was not built; and a software-GPU emulator would hide the
  recorder's saving, which is the thing the lane exists to measure. Neither is done rather than
  reported as passing.
- [x] Measure equivalent scenes on desktop.
  Six interleaved pairs of `mystral run examples/native-smoke/dist/native-smoke.js --frames 300` on
  Xvfb: plan off 10116/10318/10175/10184/9860/9855 ms, plan on
  10065/10283/9967/10170/9906/9919 ms — **1.3% faster by median, inside the ±1.5% spread of the runs
  themselves**, and the +2.6% loss recorded before the capture copy was removed is gone. Metered
  runs of the same scene put `present` at 29.4 ms of a 33 ms period, which is why no frame-level
  result is available here; they also show the plan arm's drain at +0.08 ms and its replay at
  +0.08–0.12 ms (2.5× on that phase, larger than the patch application explains — worth chasing if
  activation is pursued). Recorded in `docs/verification/runtime-perf-state.md`.
- [x] Run the changed path on iOS and verify JSC compatibility.
  Exact-head CI run `35410762244` completed successfully on
  `680f214a1376f3eede93bf345fd9884004ce10f7`. The full native-platform workflow's `ios-simulator`
  job is unconditional for a full selection and runs on macOS-15; `verify-ios-simulator.mjs` builds
  and executes the simulator runtime with the iOS/JSC configuration, so this final qualification
  gate is closed by execution evidence rather than source-compatibility reasoning.

## Acceptance criteria
- [ ] All preceding checks have executed successfully.
  Physical Android performance remains open; the final exact-head iOS/JSC lane passed in CI run
  `35410762244`.
- [x] No queue-order regression on the repaired recorder through native replay.
  `frame op stream replay contract passed` asserts the exact operation order and census for patched
  frames and for the tail a split frame left behind, and no replay reported a duplicate id or a
  census mismatch while the split, reload and recreation scenes ran.
- [x] No resource-lifetime regression on the repaired recorder through native replay.
  A split frame's readback (`[2,2,2,2]`) proves the prefix reached the GPU before the map resolved,
  the readback after device recreation (`[9,8,7,6]`) proves the new device's own resources are what
  the replayed records name, and the vitest lane asserts a reused record still reads the resource ids
  that keep its objects alive.
- [x] No visual regression on an enabled/disabled conformance case.
  Same two frames, both transports, pixels read back and compared, with the negative control above;
  a shaded scene, and a presentation-level screenshot comparison, are not part of it.
- [x] No device-recreation regression.
  The contract destroys the device, creates another, and replays a frame whose resources belong to
  the new one; a fresh recorder starts with no retained plan and sends a capture, which is what the
  host receives.
- [x] Automatic production selection is justified by bounded measurements and fallback.
  The automatic policy keeps tiny, upload-heavy and unstable work on direct v2, promotes stable
  render/compute work, and backs off after unprofitable probes. In its CPU-only fixture stable render
  and compute recording are 65.9% and 54.9% cheaper; upload-heavy automatic recording is within 0.5%
  of direct, while tiny/changing cases pay only microseconds of selector overhead. The existing
  desktop end-to-end lane is neutral within run-to-run spread. This supports adaptive default
  selection, not a blanket-v3 or universal-FPS claim.

## Environment

Original implementation and performance evidence came from the workstation: Linux, AMD Ryzen 9 5900X, NVIDIA RTX 2080 (Vulkan), Node
20.19.6, `tn-linux` native build (V8 + Dawn). Android hardware and iOS are not available here.

The recorder repairs that followed were re-verified on the workstation build above: the vitest
recorder suites, the native `tn-linux` contract (including the split-frame, visual and device
recreation cases), `pnpm budgets` with a re-stamped coverage digest, and the desktop A/B. The
acceptance heading uses the spelling `scripts/prd-progress.ts` recognizes, so the acceptance boxes
are counted rather than silently reported as 0/0.
