# PRD-398 — Linux loading transitions and responsive React UI

**Status:** IN PROGRESS — Phase 1 refreshed the consumer and established the current artifact's
behavior; Phase 3's scheduling boundary is fixed, unit-tested and measured end-to-end; Phase 2's
ten-launch regression and the web lane have now run, because the process holding 6.2 GiB of this
host's 8 GiB GPU is gone. AC-1 and AC-7 are verified on the reported consumer. AC-2 to AC-6 remain
fixture measurements: the packaged game's own page cannot supply their conditions, for the measured
reason in “Packaged-game lanes”. Results in “Execution results”.
**Complexity:** 6 (MEDIUM); risk override: none. Anticipated 6–10 implementation files (2), cross-thread state (2), native host and published JS build boundaries (2); no new system.
**Owner:** engine — native runtime and UI bridge
**Depends on:** Existing PRD-393 and PRD-394 implementation on `fix/native-perf-followups`; their unrelated remaining acceptance criteria are not closure dependencies.
**Progress:** 5/7 phase boxes; AC-1 and AC-7 are closed, AC-2 to AC-6 are measured on the fixture and
open on the reported game. The consumer is refreshed, the
reported dark-coverage symptom does not reproduce on the refreshed artifact, the snapshot scheduler's
three named defects are fixed with red-green unit tests, and four measured lanes now cover the
criteria the PRD asked for: delivery on a CSS page and on a React page (99.3–99.6% and 100.0% of
game frames, both passing the 90% / 2T bounds), state age (733 samples, p95 1.1 ms against 3T =
120.8 ms), native pointer response (32 actions, p95 39.3 ms against max(50 ms, 3T) = 98.4 ms) and the
composite's cost with the page changing every frame (0.74–1.39 ms p95 over 300-frame windows, under
the 2 ms bound). Frame time is unchanged within the host's noise (median +0.4% over four interleaved
pairs). The GPU blocker is gone and the lanes it held were re-run on the same artifact bytes: **ten of
ten** packaged launches carry the authored loading surface through loading exit with zero dark
full-window frames, and the consumer's four browser scenarios now pass on the real adapter with zero
diagnostics. What remains open is named, not hidden: the packaged game's bare-launch page is static
(0 uploaded frames in 30 s) and its driven scenario leaves only ~4 s after `first_playable`, so
AC-2 to AC-6 stay fixture claims; one harness defect the packaged run exposed — a pointer lane that
reported a pass after measuring nothing — is fixed with a red-green test. Exact gaps are in
“Execution results”.

**Priority:** P1 — Open ACs require visible loading updates, per-frame state, responsive pointers, 2 ms p95.
## Context

João reports dark background transitions during loading and visibly slow React UI refresh on
Linux desktop native. Web does not show the loading defect; other native platforms are unverified.
This follow-up will distinguish current source facts from causes requiring reproduction. It keeps
the existing PRD-393 compositor and PRD-394 startup work and their evidence intact.

Related plans:

- [PRD-393](PRD-393-the-native-ui-composites-into-the-game-frame.md) owns the existing offscreen
  Linux UI architecture. This proposal concerns remaining visible transitions and update cadence.
- [PRD-394](../performance/PRD-394-honest-launch-loading.md) owns startup progress, failure
  reporting, and startup cost. This proposal must not reopen its already fixed presentation bug
  or treat its historical timing numbers as measurements of today's artifact.

Scope: Linux desktop native, with web as the same-game reference. Windows, macOS, Android and
iOS are not reported broken and receive no new performance claim here. The branch's documented
consumer, `sandbox/midway-open-pacific`, is the proposed reproduction workload; the user has
confirmed the platform, not the game name.

The branch already changed core UI state publication from a 100 ms timer to per-frame delivery
in `edbac119c`. Repeating that change is not a solution; the executing agent must identify the
first boundary at which the current artifact loses updates.

### Reuse and constraints

Capability search and detail inspection identified `connectUiBridge`, `publishUiState`,
`subscribeUiState`, and `DesktopPlaytestDriver`. Keep these entry points and the current WebKitGTK
mailbox/compositor. The separate `createReactOverlay` capability renders React Native-style
`View`/`Text` without DOM/CSS; it is not a compatible replacement for an existing React DOM UI.
No new UI backend, transport, rendering abstraction, or game-specific sleep is proposed.

## Source findings

Inspection snapshot: `203663671` on `fix/native-perf-followups`, 2026-09-20. These are source
facts, not a reproduction of the reported symptoms. The inspected sandbox installation does not match the branch; the exact executable used in the
reported session has not been confirmed.

### Artifact mismatch: resolve before changing the engine

The inspected consumer is `/home/joao/projects/threenative/sandbox/midway-open-pacific`:

- Its installed `node_modules/@threenative/core/dist/index.js:10919` still defines
  `createGameStore(initial, intervalMs = 100)`. Its game constructor at line 11966 passes the
  optional configuration value directly; this bundle has no `.flushFrame()` or `.flush()` call.
  This is code evidence of the old publication path, beyond the older tarball timestamp.
- The installed runtime comes from the released `runtime-native-v0.3.2` prebuilt. Static inspection
  found no `TN_UI_COMPOSITE` marker in that prebuilt or `dist-native/midway-open-pacific`, unlike
  the current branch's compositor. This strongly indicates an older native UI implementation;
  package version and executable modification time alone do not establish freshness.
- `src/ui/main.tsx:13,104` mounts React around the shared vanilla `DomShell` from `src/ui/dom.ts`.
  Web installs that shell directly (`src/main.ts:10`). Native effects at `main.tsx:69` replay
  bridged state, so the old 100 ms publication interval is a direct candidate for visible lag.
- Midway's loading layer is an opaque authored `#102a37` DOM element. It is removed via
  `.hidden { display:none!important }` on the first world update (`src/scenes/Midway.ts:274`),
  not faded. Its progress bar alone has a 250 ms CSS width transition. Native root elements are
  transparent (`src/ui/native.css:6`), so an uncovered handoff can expose the game underneath.

First compare this installed artifact with a package built from the current branch, using the
existing local pack/install and doctor workflows. Preserve the baseline for comparison. If the
refreshed packages resolve both symptoms and meet the acceptance criteria, stop: no scheduler or
shader change is justified. If they do not, the following source findings guide the remaining fix.
This proposal does not assert that the user launched the inspected executable.

| Boundary | Current behavior and source anchor | Implication |
| --- | --- | --- |
| Linux page | `packages/runtime-native/native/ui-overlay/src/offscreen.rs:346`: WebKitGTK, transparent background, hardware acceleration disabled | PRD-393's earlier WPE choice was superseded later in that document. Diagnose the shipped GTK path. |
| Snapshot scheduling | `offscreen.rs:782–823`: one asynchronous snapshot; on completion, wait another `interval(unchanged)` before requesting the next | Without a newer wake, snapshot work and the 16 ms busy delay add together. A 16 ms setting does not establish 60 visible frames/s. |
| Wake versus completion | `offscreen.rs:697–755`: posts, pointer/key input and resize wake the driver; completion subsequently assigns `next_at` again | Input during an in-flight request may have its urgent deadline overwritten. Reproduce this ordering before changing it. |
| Idle animation | `offscreen.rs:862`: identical snapshots back off to 250 ms | A page-local animation starting after idle needs explicit coverage; game posts cannot be assumed to wake every CSS/React-local change. |
| Final composite | `packages/runtime-native/src/webgpu/bindings_ui_composite.cpp:150`, `:430`: premultiplied conversion and a `Load` render pass; `bindings.cpp:2914`: composite before present | No obvious unconditional black clear here. Alpha/color correctness and loading readiness are competing hypotheses, not confirmed bugs. |
| Native launch | `packages/runtime-native/src/platform/window.cpp:98`: authored boot-splash background applied to X11 before swapchain rendering | The first GPU frame must continue coverage until the authored loading surface is actually visible. |
| Capture | `packages/runtime-native/src/cli/main.cpp:1222`: standard startup screenshot waits for readiness and discards earlier captures | A passing final screenshot cannot prove that earlier loading frames never flashed dark. |

The shared path is game state → `publishUiState` → `__tnUiPost` → the web-thread command queue
→ `__tnUiReceive` → page update → WebKit snapshot → latest-frame mailbox → native UI quad →
`presentPendingSurface`. React commits, snapshots, uploads and successful presents are different
observations; none alone establishes smooth visible UI.

## Solution

**First refresh the consumer from this branch; fix only defects that remain.** The Linux host's
existing snapshot/presentation path decides when the
same UI becomes visible on native; the game owns colors and transition styling. Keep game UI
source unchanged unless the reproduction specifically proves an authored markup defect. A package
refresh is proposed execution work and has not been performed.

### Loading continuity

Measure the entire splash → loading page → loading exit → first world/UI frame. For Midway,
loading exit is an immediate hide; preserve that behavior. Exercise partial alpha in the shared
fixture to distinguish compositing defects without adding a fade to the game. Identify the
first frame that differs from the same game's web transition, and correlate it with page alpha,
mailbox generation and a successful present.

If coverage disappears before the replacement is ready, preserve the existing authored loading
surface until its successor has real pixels. For a pre-UI clear mismatch, carry the already
configured boot-splash color through that handoff; do not introduce an engine-selected color or
another overlay. If coverage is correct and translucent pixels darken incorrectly, fix the proven
alpha/color-space boundary instead. The existing shader already handles premultiplication, so an
unconditional alpha conversion or `Clear` pass would risk a second defect.

Do not hold the loading page past its intended fade, block world rendering while waiting for it,
or wait for a world frame that the loading gate itself prevents. Preserve startup failure
reporting and the existing exit behavior. `ui-ready` is script readiness, not evidence of paint.

### UI cadence

The first candidate is `Driver::{service,request,complete,wake}` in `offscreen.rs`:

1. Pace active captures from a request/frame deadline, accounting for snapshot time; avoid adding
   a fresh full busy interval after each completion. Reuse measured page/host frame timing rather
   than introducing another author-tuned FPS constant.
2. Preserve a wake received during an in-flight request, and service it promptly once that request
   finishes. Keep at most one capture in flight and the latest-wins mailbox; never build a frame queue.
3. Keep idle backoff and unchanged-frame upload suppression. Prove that input and page-local
   animation resume promptly from idle. Use the existing page/paint lifecycle for wakeup if the
   trace proves it is missing; do not disable backoff globally or make React rerender continuously.

Per-frame posts already call `wake()`, so the added delay may be bypassed in an active HUD. If
snapshot round-trip/raster cost is the actual limit, scheduling alone is insufficient: localize
raster, copy and upload cost before changing the backend. Damage-region or accelerated capture
work is a conditional escalation, not an assumed part of this proposal. Do not force a
process-wide software-rendering environment variable or replace WebKit with a new browser.

The existing per-frame core publication change stays in place; preserve explicit store intervals,
subscription deduplication, event ordering, pointer ownership and disposal. Coalesce only state
snapshots if a measured backlog requires it; never drop intents or pointer/key transitions.

## Acceptance Criteria

All thresholds below are proposed targets, not measurements. `T` is the observed median interval
between successful game presents under the selected normal cap. At 60 Hz, `T` is about 16.7 ms.
Use the reported scene and a small existing React UI consumer: a scene already below its cap cannot
prove a 60 Hz target, and a vanilla DOM page cannot by itself prove React behavior.

- [x] AC-1 [local; actor: agent]: Ten consecutive Linux launches show continuous authored coverage
      through loading exit, with zero unexplained dark full-window frames absent from the web
      reference. Inspect every presented transition frame, including translucent fade samples.
      Evidence: **verified — the ten-launch regression ran and all ten pass.** On the freed GPU (6860
      MiB of 8192 MiB free) **10 of 10** launches of `dist-native/midway-open-pacific` attached the
      page (`TN_UI_OVERLAY:{"attached":true}`), carried the authored `#102a37` surface in **every**
      sample taken before `first_playable` — **130 of 130**, 12–14 per launch, 99.44–99.48% of each
      frame — and presented **zero dark full-window frames** in any sample, including ones the harness
      sets aside for being pre-paint. The single `blank` sample per launch is the uniform `#102a37`
      boot-splash frame. `first_playable` landed at 12 947–14 786 ms and the transition scenario
      `native-playtests/ui.playtest.json` exited **0 in all ten**. The gate's own exit is 1 in all ten,
      for one reason only: its motion assertion, `the loading screen froze for 4.7–5.5 s during the
      startup` — PRD-393's loader/pump stall, which this PRD's out-of-scope list forbids reopening and
      which is not a coverage failure. Midway's loading exit is an immediate hide, so this consumer
      has no translucent fade samples to inspect; the fixture owns that case. Table and per-sample
      data: `artifacts/prd398-ac1/ten-launches.md`, `ten-launches.json`; the blocked attempt this
      replaces is preserved in `artifacts/prd398-ac1/blocked-20260920/`. Web reference: see
      “Packaged-game lanes”.
- [ ] AC-2 [local; actor: agent]: During a 10 s page-local animation, distinct visible UI updates
      reach at least 90% of successful game presents, with p95 update gaps ≤ 2T. Repeat after 1 s
      of idle and include a React-local update.
      Evidence: **measured; met on the fixture lanes, unmeasured on the reported game.** In the
      measured window (`first_playable` + 8 s, then 30 s at 1280×720) the current host delivered
      **99.3–99.6%** of the game's composited frames in every judged active segment and passed the
      90% / 2T bounds in **4 of 4** runs, against **92.6–97.6%** and 3 of 4 for the pre-change host
      (its pair-2 segment failed at 72.0 ms p95 against 70.8 ms). A React page whose animation is
      React's own state (`--lane react`, `examples/native-smoke/ui/react.tsx`) delivered **100.0%**
      over two segments. p95 gaps were 38.5–102.3 ms, each within its own segment's 2T. The 1 s idle
      is the fixture's own burst and is exercised between every segment. **Not the reported scene.**
      The packaged game cannot supply this criterion's condition: a bare launch of Midway uploads
      **0** page frames in a 30 s window (its briefing screen is static), and a driven run of its own
      UI scenario leaves only ~4 s after `first_playable`. See “Packaged-game lanes”.
- [ ] AC-3 [local; actor: agent]: A fixture publishing a changed state each game frame reaches the
      visible UI with p95 state age ≤ 3T; age does not grow over 30 s. Explicitly throttled stores
      retain their configured cadence.
      Evidence: **measured on the fixture lane; met.** `--lane state-age`, 30 s window: 733 paired
      samples, the game posting **733 of 733** presented frames (100% per-frame publication), p95
      state age **1.1 ms** against 3T = 120.8 ms, halves 1.2 / 1.0 ms against half frame times 40.0 /
      40.6 ms. A second run under a heavier host (five concurrent node/browser processes) gave p95
      **62.8 ms** against 170.7 ms with halves 2.9 / 83.6 ms, each inside the 3T bound computed from
      its own half's frame time — the growth clause is judged that way because this host's pacing
      moved by a factor of two inside one window. An age is an *upper* bound by construction (see the
      pairing note in “Execution results”), and a negative age fails the run. Throttled stores keep
      their configured cadence by the existing `createGameStore` tests
      (`packages/core/__tests__/state.spec.ts:22`, `documented-contract.spec.ts:79`). **Not the reported
      game**: on Midway the game's own state posts are 245 across 368 presented frames (66.6%) and the
      page changed 0 times, which is the engine's documented dedupe of an unchanged state
      (`ui-state.ts` `flush`: “Skip a publication that would carry the bytes the UI already has”), not
      a publication path that slipped back to a timer. See “Packaged-game lanes”.
- [ ] AC-4 [local; actor: agent]: Across at least 30 native pointer actions, including after idle,
      the correct response becomes visible within max(50 ms, 3T) at p95, with no lost or reordered
      actions in the existing UI interaction scenario.
      Evidence: **measured on the fixture lane; met.** `--lane pointer` drove **32 real X pointer
      actions** (`xdotool` → the OS event loop → `uiOverlayRoutePointer`, the same entry point the
      playtest bridge's synthetic input uses) into a bare launch, the last eight after a 2.5 s idle.
      All 32 produced a paired visible response — no lost and no reordered action — at p50 **35.3 ms**
      and p95 **39.3 ms** against max(50 ms, 3T) = 98.4 ms, in a 30 s window at 1280×720. The
      response measured is the whole trip: X event, host routing, the game counting it, the state
      post, the page's render, the snapshot and the composite. The existing web interaction scenario
      (`examples/native-smoke/playtests/ui-layer-input.playtest.json`) is a browser lane and is not
      part of this desktop run. **Not the reported game**: the same lane on Midway drove 32 actions
      and saw the page change 0 times, which is what exposed the harness's own fail-closed bug — see
      “Packaged-game lanes”.
- [ ] AC-5 [local; actor: agent]: The existing UI composite phase remains ≤ 2 ms at p95 across
      at least 300 steady frames at 1280×720.
      Evidence: **met, now measured with the page changing every frame, not only still.** The
      existing gate passes with the static page at `ui phase p95 0.06–0.07 ms` over its 300-frame
      window on `examples/native-smoke`. The cost that wording did not distinguish is measured from
      the four animating lanes' own `TN_FRAME_BUDGET` windows, 300 samples each at 1280×720: **0.74–0.87 ms**
      p95 with a CSS page-local animation, **1.35–1.39 ms** with a React-local one, **0.96–1.09 ms**
      with the page echoing the bridged state every frame — all inside the 2 ms bound. The earlier
      1.39–4.37 ms reading was this host under an external load spike; the upload for a page that
      changes every frame is real, bounded, and under budget here. Still the fixture lane, not the
      reported game.
- [ ] AC-6 [local; actor: agent]: In three interleaved baseline/candidate pairs on the same idle
      host and workload, median steady frame time regresses by no more than 5%; inspect web-thread
      CPU separately so faster UI does not conceal a new busy loop.
      Evidence: **measured; the median is inside the budget and the idle-host precondition is not
      met.** Four interleaved baseline/candidate pairs of `verify-native-ui-cadence.mjs` (paired runs
      minutes apart, same workload, 1280×720): median steady frame time delta **+0.4%** (range −4.6%
      to +7.2%), so the median of the pairs is inside the 5% allowance while one pair is over it.
      Web-thread work did not grow: snapshot requests 60–61/s (baseline) vs 55–62/s (candidate), and
      uploads 23.9–24.7/s vs 19.1–26.0/s. Host load across the pairs was 6.3–22.2 — this is not the
      idle host the criterion asks for, and the pairing exists to survive exactly that. See
      “Execution results”.
- [x] AC-7 [local; actor: agent]: The same consumer's browser loading/UI scenario still passes
      with its authored transition unchanged and no new runtime diagnostics.
      Evidence: **verified.** On the freed GPU the consumer's four browser scenarios ran on the real
      `turing / nvidia` adapter (rendererKind webgpu, 1280×720) and **all four passed**, runner exit 0
      in 89.7 s: `midway-audio-realism` 2228 frames, `midway-briefing` 120, `midway-flight` 1877,
      `midway-launches` 1877, with **zero console errors and zero runtime diagnostics** — against 2600
      / 508 / 681 / 683 console errors and a failed `diagnostics` step on every one of them while the
      card was memory-starved. No consumer source was touched, so the authored transition is unchanged
      by construction. Log `artifacts/prd398-web/playtests-gpu-free-run.log`; per-scenario artifacts
      `artifacts/prd398-web/playtests-gpu-free/`.

Lane availability: this Linux machine has a display, Xvfb, WebKitGTK, the native toolchain and a
built host. These make local execution plausible; runtime health and artifact freshness remain
unverified. No owner/shared acceptance gate is required for this Linux-only proposal. Reproduce on the
reported Linux desktop session as well as the automated display lane: Xvfb alone cannot clear a
Wayland/XWayland-specific defect. Windows,
macOS, Android and iOS remain outside the performance claim; preserve their compile guards and
shared bridge contracts. Do not infer their runtime correctness from Linux.

## Integration Ledger

| Capability | Reachable consumer / trigger | Existing path disposition | Evidence |
| --- | --- | --- | --- |
| Continuous loading | Packaged game launch → `window.cpp:98` → authored loading page/canvas → `bindings.cpp:2914` → present | Keep existing splash and loader; repair only the measured handoff or alpha boundary | AC-1 |
| Responsive page pixels | React/CSS animation or native input → `offscreen.rs:697` → `request/complete` → `ui_overlay.cpp:211` → UI composite | Replace completion-relative delay/wake loss only if reproduced; retain mailbox and public API | AC-2, AC-4 |
| Fresh state | `packages/core/src/game.ts:1422` → `ui-state.ts:76` → `runtime.cpp:2611` → page → composite | Retain per-frame publication; modify downstream delivery only where measured stale | AC-3 |

## Execution Phases

### Phase 1: Attribute both visible defects on the current Linux artifact

**Status:** DONE — both failures are captured through their real entry points, each with a runnable
regression.
**ACs:** establishes the baseline and failing observations for AC-1 through AC-6.
**Files:** Existing native loading/UI verification scripts and their fixtures; targeted diagnostic
fields in `offscreen.rs` or `bindings_ui_composite.cpp` only where current observations are inadequate.

- [x] Identify the reported game, native binary, installed core/UI bundles, build revision and
      launch environment; establish the symptom on that artifact and compare with the current branch.
      — **DONE.** The installed consumer was the released 0.3.2 bundle without PRD-393/394; it was
      refreshed from HEAD and rebuilt with the HEAD host. See “Execution results”.
- [x] Capture both failures through the real entry points, identifying the first boundary that
      loses loading coverage or UI cadence; retain a runnable regression in the existing harness.
      — **DONE.** Loading: `verify-desktop-loading-animation.mjs`, first boundary named by
      `TN_SLOW_PHASE` (the startup runs inside one frame). Cadence: `verify-native-ui-cadence.mjs`,
      newly built this session, which drives the page-local animation fixture through a bare launch
      and reads the per-frame `TN_UI_COMPOSITE_TRACE`. See “Execution results”.

**Implementation:** On later authorization, follow the existing one-PR-per-PRD/worktree lifecycle;
no implementation PR or worktree is created for this planning request. Record actual resolution,
refresh/cap, display/compositor, adapter and host load; do not attribute a stale installed bundle to today's source. Use both a page-local animation
and a changing bridged-state value to isolate transport from capture. Extend the existing UI
fixture with transparent/half-transparent regions and an identifiable moving value. Observe the
reported game as well as the fixture; do not replace it with an easier scene. Do not change its
art direction to make the test pass.

**Verification:** E1 — existing loading and UI-frame harnesses extended to observe early/transition
frames and successful-present cadence. Existing one-second aggregate logging is insufficient for
frame-gap percentiles. Collect bounded timestamps/counters in existing diagnostics, correlate
clocks instead of subtracting unrelated clock origins, and associate visible pixels with successful
presents. A changed mailbox counter or upload timestamp is not proof of display. Missing samples,
stale captures or a scenario with no relevant assertions fail the check. Do not use the ordinary
post-readiness screenshot gate for pre-readiness evidence, or stale `import -window` backing-store
captures without first proving they track the displayed animation.

**Checkpoint:** done. The reported loading defect does not reproduce on the refreshed artifact: its
dark background is the deleted X11 overlay path, and the refreshed artifact carries the authored
loading surface at every pre-`first_playable` sample. The remaining gate failure is motion, not
coverage, and belongs to the loader/pump work PRD-393 deferred. The cadence failure is captured
end-to-end and quantified.

### Phase 2: Fix the proven loading handoff defect

**Status:** DONE — the coverage defect is resolved by the refresh and the ten-launch regression ran
on the freed GPU: ten of ten launches pass AC-1's own reader and all ten exit their transition
scenario 0.
**ACs:** AC-1; AC-7 if shared loading code changes.
**Files:** Only the boundary E1 identifies, among `src/platform/window.cpp`,
`src/webgpu/bindings_ui_composite.cpp`, `native/ui-overlay/src/offscreen.rs` under
`packages/runtime-native`, or `packages/core/src/game.ts`; existing loading regression fixture.

- [x] Resolve loading coverage with the refreshed artifact or, if still failing, the smallest
      shared fix; preserve authored colors, transitions, readiness and failure handling.
      — **DONE by the refresh.** No rendering change was landed; the refreshed artifact shows the
      authored `#102a37` loading surface before `first_playable` in 11 of 11 samples, and its
      transition scenario exits 0. See “Execution results”.
- [x] Run the regression from failing baseline to passing candidate across all ten launches;
      record any relevant web comparison beside AC-1/AC-7.
      — **DONE.** Ten launches ran on the freed GPU; all ten pass AC-1's own reader (130/130 samples
      carry `#102a37`, zero dark full-window frames) and all ten exit `native-playtests/ui.playtest.json`
      0. The failing baseline is the earlier blocked attempt, preserved in
      `artifacts/prd398-ac1/blocked-20260920/`: it died of `vkAllocateMemory` before `first_playable`
      on the *same* artifact bytes, so what failed there was the host, and these ten runs are the same
      artifact's first execution that reached loading exit. The web comparison ran on the same free
      GPU: four scenarios pass on the real adapter with zero diagnostics (AC-7), and the web loading
      surface is the authored `#102a37` with zero dark frames. See “Execution results”.

**Verification:** E2 — E1's transition check, plus the owning focused unit check only where it
covers a failure the pixel sequence cannot localize. Test alpha=0 and partial alpha if that boundary
changes. No extra screenshot-only gate duplicating E1. Do not expand this phase into PRD-394's
asset-decode/startup-cost work.
**Checkpoint:** done. No loading boundary was changed, so there is nothing to review on the render
side; the phase's verification is the ten-launch regression, which ran green on AC-1's reader, with
the one pre-existing motion failure attributed to PRD-393 by name.

### Phase 3: Fix the proven UI cadence defect and verify the consumer

**Status:** PARTIAL — the three scheduling defects are fixed with red-green unit tests, the fixture
lanes measure delivery, state age, pointer response and cost, the web coverage lane now passes, and
the packaged-game lanes were run for the first time: they measure the reported game's own page, which
is static on a bare launch, so AC-2 to AC-6 stay fixture claims rather than packaged ones.
**ACs:** AC-2 through AC-7; rerun AC-1 if capture/composite behavior changes.
**Files:** `packages/runtime-native/native/ui-overlay/src/offscreen.rs` and its existing unit tests;
`packages/runtime-native/scripts/verify-native-ui-cadence.mjs` and its new
`tests/native-ui-cadence-judge.test.mjs`; existing UI-frame/playtest fixtures. Touch C++
bridge/composite or core UI state files only if E1 locates the delay there. Keep package instructions
consistent if their affected behavior changes.

- [x] Resolve cadence with the refreshed artifact or fix the measured limiting boundary; keep
      bounded in-flight work and test timing/wake/idle behavior only where scheduling changes.
      — **DONE.** The limiting boundary was the backoff a single unchanged answer bought, not the
      round trip: `Cadence` doubled the wait from the first identical snapshot (16 → 32 ms), and a
      page painting at its own rate against a 16 ms poll answers identically whenever two asks land
      inside one paint. It now backs off on how long the page has been *quiet*, which reaches the
      same idle rate after the same quarter second. Red-green in the crate, and end-to-end the
      delivery ratio is 99.3–99.6% against 92.6–97.6% for the pre-change host. See “Execution
      results”.
- [ ] Verify visible animation, state freshness, input response and cost on the current packaged
      Linux game and React consumer; run affected web coverage and required repository checks.
      — **PARTIAL.** On the fixture: visible animation (CSS 99.3–99.6%, React 100.0%), state freshness
      (p95 1.1 ms), input response (32 native actions, p95 39.3 ms) and cost (median +0.4% over four
      interleaved pairs) are all measured and inside their budgets; the React consumer is a real React
      DOM page. Web coverage now passes outright (AC-7). The packaged game ran and is now measurable,
      but not by these criteria: a bare launch uploads **0** page frames in 30 s and its driven UI
      scenario passes while leaving only ~4 s after `first_playable`. Running the packaged lanes found
      and fixed one real harness defect — the pointer lane passed after measuring nothing (see
      “Packaged-game lanes”). What stays unverified is named there: AC-2 to AC-6 remain fixture claims.
- [x] Update this PRD with actual results and remaining gaps; close only when every AC is verified.
      — **DONE for the update, open for the close.** This revision records the freed-GPU results, the
      packaged-game lanes and the harness fix; AC-2 to AC-6 remain open because the packaged game's own
      page cannot supply their conditions and the criteria are written for a fixture page.

**Verification:** E3 — cadence/input observations from E1, existing UI playtest scenario and
scheduler regressions, followed once by `pnpm typecheck`, `pnpm lint`, `pnpm test` and applicable
native build/desktop checks. Run `pnpm prd:progress` after each phase. Do not run implementation
gates merely to validate this proposal. Reuse unaffected evidence; fix or report genuine failures.
**Checkpoint:** pending; review measured end-to-end results, not just the scheduler diff. The
scheduler diff and its end-to-end numbers exist, the packaged-game lanes and their finding exist, and
the one defect they exposed is fixed with a test — what is still missing is a packaged measurement of
AC-2 to AC-6, which needs a harness that can hold the reported game in a steady state and measure it,
not another run of the lanes that exist.

## Execution results (2026-09-20/21, `fix/native-perf-followups`)

Source inspection was done at `203663671`; this execution ran on `a8507e845` plus the working-tree
change below. The inspection snapshot's artifact-mismatch finding was confirmed and then removed:
the refreshed artifact is the subject of every result here.

### Artifact refresh (Phase 1)

The branch's `@threenative/{core,ui,physics,playtest,assets}` and `create-threenative` were packed
into `sandbox/.packages` and repointed in `sandbox/midway-open-pacific`. The installed `core` moved
from the released 0.3.2 — `createGameStore(initial, intervalMs = 100)`, no `.flushFrame()` — to
HEAD's per-frame publication (`stateFlushMs`). `dist-native/midway-open-pacific` was rebuilt with
`THREENATIVE_RUNTIME_BINARY=packages/runtime-native/build/tn-linux/mystral`, a host that carries
`TN_UI_COMPOSITE` and `TN_UI_SNAPSHOT`; the previous artifact had neither and still used the X11
overlay (`TN_UI_OVERLAY` only).

### Loading (E1; Phase 1/2)

`node packages/runtime-native/scripts/verify-desktop-loading-animation.mjs --executable
dist-native/midway-open-pacific --cwd . --scenario native-playtests/ui.playtest.json --runner
node_modules/@threenative/playtest/dist/runner/cli.js --out artifacts/prd398-loading`

- Attached: `TN_UI_OVERLAY:{"attached":true}`.
- Coverage: 11 of 11 pre-`first_playable` samples carry the bootSplash colour `#102a37`;
  `blankSamples: 1` is the first sample, taken before the window painted. No dark full-window frame.
  The reported dark-background transition is the deleted overlay path, not this artifact.
- Still red on motion: `the loading screen froze for 5.1 s during the startup (from 5237 ms)`,
  `slowFramePresentMs: 0`. `TN_SLOW_PHASE` names the stall — `pollEvents 1706 ms @ 7799`,
  `animationFrames 1830 ms @ 10334`, `pollEvents 1880 ms @ 10383`, `timerCallbacks 1309 ms @
  12046` — the startup running inside one frame, which PRD-393 records as the loader/pump change
  deferred to another PRD and which this PRD's out-of-scope list forbids reopening. Same host as
  PRD-393's 16.2 s; the decode-delivery budget moved it to 5.1 s.
- Transition: `native-playtests/ui.playtest.json` exited 0.

### UI cadence (E3; Phase 3)

Two defects in `Driver`'s scheduling, both in `offscreen.rs`:

1. The next capture was timed from the previous answer (`next_at = completion + interval`), so the
   real period was the snapshot round trip plus a full interval. The deadline is now anchored at the
   request (`Cadence::requested`).
2. A `wake()` that arrived while a snapshot was in flight was overwritten by the completion's
   backoff, so a post, input or resize that arrived mid-flight waited out the idle poll. `Cadence`
   keeps a `wake_pending` flag and honours it on completion.

`cargo test --release --lib --manifest-path packages/runtime-native/native/ui-overlay/Cargo.toml`:
**18 passed**. Against the pre-fix ordering, three of the four new tests fail —
`a_capture_is_paced_from_its_request_not_its_answer`, `a_wake_during_an_in_flight_request_is_not_lost`
and `a_request_consumes_the_wake_it_was_asked_for`; the idle-backoff test passes on both, which is
the point. `cargo fmt --check` flags only pre-existing long lines in the crate, none in the added
code.

#### The harness the PRD asked for, and its numbers

Three pieces, all new this session:

- **`TN_UI_COMPOSITE_TRACE`** (`src/webgpu/bindings_ui_composite.cpp`, off unless the variable is
  set): one line per composited frame on the same launch clock as `TN_UI_COMPOSITE`, carrying the
  page counter it saw and whether it uploaded. The once-a-second marker cannot express a gap.
- **A page-local animation fixture** (`examples/native-smoke/ui`): a CSS `#pulse` and a rAF `#tick`
  the page drives itself, in 10 s bursts with a 1 s idle. Opt-in behind `window.__tnPageAnimation`,
  so the UI-frame gate keeps its static page and its 2 ms budget still means what it did.
- **`scripts/verify-native-ui-cadence.mjs`**: provisions its own Xvfb and compositor, builds the
  bundle with no playtest bridge, launches it bare, and judges each active segment for the 90% /
  2T bounds and reports the idle resume.

Measured on the fixed host vs the pre-fix host, 4 interleaved pairs, 1280×720:

| | pre-fix | fixed |
| --- | --- | --- |
| delivered / composited, median of active segments | **84.9%** (15 segments, 81.5–98.4%) | **93.4%** (19 segments, 86.5–98.3%) |
| segments meeting p95 ≤ 2T | **0 / 15** | **10 / 19** |
| p95 gap, median | 71.6 ms (2T 69.4) | 71.3 ms (2T 71.8) |
| idle resume | 1018–1042 ms | 1018–1056 ms |

So the fix does what it claims in direction and size, and the remaining p95 gap is the page's own
paint rate dipping below the game's present rate — `TN_UI_SNAPSHOT` reports round trips of 1–3 ms,
so the scheduler is not the limit. **AC-2 and AC-6 stay open**: the thresholds cannot be certified on
this host, which is at load 11 with 28 GiB of swap in use, and the PRD's own rule says a scene below
its cap cannot prove a 60 Hz target — native-smoke renders at ~30 fps here.

#### Cost, and the AC-5 it changes

With a *static* page, `verify-desktop-ui-frame.mjs --contract in-frame` passes at **`ui phase p95
0.03 ms`** over 300 frames — AC-5 as written. With the page animating every frame the same phase is
**p95 1.39 ms** in a light window and **4.37 ms** in a window where the host dropped to 13.6 fps,
against the 2 ms bound. That is a genuine cost the AC-5 wording does not distinguish: the budget was
set against a still HUD, where the upload is skipped, and a page that changes every frame pays
`writeTexture` for all 3.7 MB every frame. It is reported here rather than hidden.

### Cost and repository gates

- `sh scripts/xvfb.sh node packages/runtime-native/scripts/verify-desktop-ui-frame.mjs --contract
  in-frame` — **passed**: page frame 1280x720, 72 555 `#7fffd4` pixels in the game's own frame, `ui
  phase p95 0.03 ms` under the 2 ms bound. 240 game frames, not AC-5's 300, and on
  `examples/native-smoke`, not the reported game.
- `pnpm typecheck`, `pnpm lint` and the unit phase are **red at HEAD on failures this change does
  not touch** (this PRD's change is one Rust file). Typecheck: `packages/core/__tests__/
  {entity-snapshot,renderer,replay-protocol}.spec.ts`, `scripts/round-deletions.ts`. Lint: 11
  `noExcessiveCognitiveComplexity` errors under `examples/` and `test-support/`. Unit: 5 620 passed,
  3 failed — `scripts/__tests__/temp-dir-guard.spec.ts` (offender
  `packages/runtime-native/tests/fatal-bundle-report.test.mjs`), `scripts/__tests__/quality-json.spec.ts`,
  and `packages/create-threenative/__tests__/scaffold.spec.ts` parent hashes.

### Remaining gaps (as of 2026-09-20; superseded in part by the 2026-09-21 section below)

- AC-1's ten-launch repeat and the web reference; AC-3's state-age measurement; AC-4's pointer
  display latency; a React-local update (the fixture lane is vanilla DOM).
- A page/paint wakeup for a page-local animation that starts after idle (Phase 3 item 3). The
  measured resume is 18–56 ms, so the idle poll has not been shown to need it.
- **The decisive one:** an idle host. Every AC-2/AC-6 number above is bound by host load (load 11,
  28 GiB swap), and the PRD's own lane note already says the same runs must be re-measured
  somewhere idle before they are called defects or passes.

## Execution results (2026-09-21, `fix/native-perf-followups`, continued)

Ran on `8e2f1d1fb` plus the working-tree change described here. The host was rebuilt
(`pnpm --filter @threenative/runtime-native native:build`) and the cost comparison uses two binaries
built from the same tree, kept side by side: `artifacts/prd398-binaries/mystral-baseline` (HEAD's
`Cadence`, without the change below) and `artifacts/prd398-binaries/mystral-fixed` (byte-identical to
`build/tn-linux/mystral`). Every number states the window it was measured in: `first_playable` + the
8 s settle, then 30 s, at 1280×720.

### The boundary the first fix left

The two defects above were real and are fixed, but the delivery the PRD complained about was still
lost at a third one: **`Cadence::settled` doubled the wait from the first byte-identical answer**
(16 → 32 ms, then 64/128/250). A page painting at its own frame rate against a 16 ms poll legitimately
answers identically whenever two asks land inside one of its paints, so the common case bought a hole
wider than the frame it was pacing.

`Cadence` now backs off on **how long the page has been quiet** (`changed_at`, with `IDLE_INTERVAL`
serving as both the quiet threshold and the idle poll). The old chain of doublings summed to that same
quarter second (16+32+64+128 ms), so a page that has genuinely stopped is still polled exactly as
slowly. Red-green:
`one_identical_answer_does_not_delay_a_page_that_is_still_painting` fails against the old ordering
(`cadence.due(base + 33 ms)` is false) and passes against the new one; the crate is **19 passed**
(`cargo test --release --lib --manifest-path packages/runtime-native/native/ui-overlay/Cargo.toml`).

### Two harness defects, both of which changed what the gate measured

1. **The judged window is now the window the run promised.** `measure` waits for `first_playable`,
   settles, then measures for `windowMs` — but the judge read the whole log, so the startup's own
   pacing (100–180 ms frames, PRD-393's loader stall) was charged to the UI. Frames and anchors are
   cut to `[first_playable + settle, + window]`, and the record carries the bounds.
2. **An anchor from before the window cannot date a frame inside it.** Pairing across that boundary
   reported an 8.2 s state age on the lane's first run — an artefact of the harness, caught because an
   age that large is impossible for a latest-wins mailbox.

### The lanes

`verify-native-ui-cadence.mjs` now carries four lanes over one set of traces:

| Lane | Page | Claim |
| --- | --- | --- |
| `cadence` | page-local CSS/rAF animation, 10 s bursts with 1 s idle | AC-2 |
| `react` | the same burst as React's own state (`examples/native-smoke/ui/react.tsx`) | AC-2's React clause |
| `state-age` | renders the bridged per-frame value | AC-3 |
| `pointer` | the plain page, 32 real X actions, last eight after a 2.5 s idle | AC-4 |

New instrumentation, all environment-gated and off in every other run: `TN_UI_LATENCY_TRACE`
(`src/platform/ui_overlay.cpp`) stamps each state post and each pointer arrival on the launch clock;
`TN_UI_SNAPSHOT_TRACE` (`offscreen.rs`) prints each snapshot's decision as durations, never as an
absolute time, because the web thread shares no clock origin with the game thread; `TN_UI_COMPOSITE_TRACE`
(already present) carries the page counter each composited frame saw. `--launch packaged` runs a game's
own executable, which is what the reported game needs.

### Numbers

| Measurement | Baseline (HEAD's `Cadence`) | Current | Criterion |
| --- | --- | --- | --- |
| Delivered page frames, worst judged segment (4 runs) | 92.6–97.6% | **99.3–99.6%** | ≥ 90% (AC-2) |
| Runs meeting the p95 ≤ 2T bound on every segment | 3 of 4 (pair 2: 72.0 ms > 70.8 ms) | **4 of 4** | all segments (AC-2) |
| Delivered page frames, React-local page | — | **100.0%** over 2 segments | ≥ 90% (AC-2) |
| State age, 733 paired samples | — | p50 0.6 ms, **p95 1.1 ms** | ≤ 3T = 120.8 ms, no growth (AC-3) |
| State age, second run under a heavier host | — | p95 62.8 ms, halves 2.9/83.6 ms against their own halves' 3T | same (AC-3) |
| Pointer response, 32 native actions | — | p50 35.3 ms, **p95 39.3 ms**, 32/32 paired | ≤ max(50 ms, 3T) = 98.4 ms (AC-4) |
| UI composite phase, static page | — | 0.06–0.07 ms p95 over 300 frames | ≤ 2 ms (AC-5) |
| UI composite phase, page changing every frame | — | 0.74–0.87 ms (CSS), 1.35–1.39 ms (React), 0.96–1.09 ms (state echo), 300-sample windows | ≤ 2 ms (AC-5) |
| Median steady frame time over 4 interleaved pairs | — | **+0.4%** (−4.6% to +7.2%) | ≤ 5% median (AC-6) |
| Web-thread work per second | 60–61 requests, 23.9–24.7 uploads | 55–62 requests, 19.1–26.0 uploads | no new busy loop (AC-6) |

The 90% / 2T delivery ratio is a *ratio*, so it survives host load; the composite phase is not, and
the animating-page figures above come from the lanes' own `TN_FRAME_BUDGET` windows rather than from a
separate gate run. The gate was pointed at a prebuilt animating page to check that reading
(`verify-desktop-ui-frame.mjs --ui <page>`, twice, once with the gate's own staged page directory):
it fails before any step with `TN_PLAYTEST_BRIDGE_MISSING` and `frames: 0`, while the same gate
without `--ui` passes on the same bundle in the same minute. That is a pre-existing interaction
between the gate's `--ui` path and the desktop playtest handshake on this host, not a property of the
animating page — the animating page launches fine on the same host through a bare launch, which is
what every lane above does. Reported, not chased further.

Every run also carries three idle resumes, because the fixture's animation pauses for 1 s between its
10 s bursts: the upload gap across that idle was **−56 to +43 ms of the 1000 ms idle** in both the
baseline and the current host, so the quarter-second idle poll is not what delays a page that starts
moving again. Phase 3's third item — "prove that input and page-local animation resume promptly from
idle" — is answered by that, and no page/paint wakeup path was added because the trace never showed
one missing. Input after idle is answered separately: the last eight of the 32 pointer actions follow
a 2.5 s pause and all eight are inside the same p95 as the rest.

### Cost, and the honest reading of "the same idle host"

Four interleaved baseline/candidate pairs, minutes apart, same workload: the median delta is **+0.4%**
and one pair is **+7.2%**. The pairing is what makes a loaded host usable at all, and this host was
loaded — load average 6.3–22.2 across the pairs, `llama-server` at ~99% CPU and five other agents'
node processes — so AC-6's "same idle host" precondition is *not* met and the +7.2% pair is not
evidence of a regression. What the pairs do show is that the change adds no new busy loop: the
snapshot request rate is unchanged in kind (a page mid-animation was already polled at the busy
interval, because the game's per-frame posts kept waking the driver), and the extra uploads are the
frames that were previously being dropped.

### What this host could not measure, and why

`nvidia-smi`: 8192 MiB total, 555–682 MiB free, with PID 20249
(`/home/joao/projects/bonsai2-cuda/fork/build/bin/llama-server`, 6266 MiB) holding the card. That is
another process, not this work's, and it stays. Consequences, each verified rather than assumed:

- **AC-1's ten launches.** Launch 01 of ten attached the overlay, sampled the authored `#102a37`
  surface, then died on `[FATAL] The GPU device was lost: vkAllocateMemory failed with
  VK_ERROR_OUT_OF_DEVICE_MEMORY`; two of its eleven frames are byte-identical (sha256) to frames from
  the run this PRD already quotes, so the *surface* is unchanged and the failure is the device. Runs
  02–10 were not attempted. Evidence: `artifacts/prd398-ac1/`.
- **The web reference and AC-7.** The consumer's four browser scenarios ran on the real
  `turing / nvidia` adapter (6102 frames) and every one failed only its `diagnostics` step, on console
  errors descending from the same `vkAllocateMemory` OOM; every `hud.*` and `performance.*` assertion
  passed. An authorised SwiftShader fallback (`artifacts/prd398-web/loading-software/`) captured the
  web loading surface functionally — 17/17 painted samples carry >50% `#102a37`, 0 blank, 0 dark
  full-window frames, loading exit at 17774 ms — but it is a software-adapter result and its own
  console is noise, so it is recorded as a functional reference and never as AC-7.
- **Every packaged-game lane.** `--launch packaged` exists and is wired; Midway cannot start on this
  host for the same reason, so AC-2/AC-3/AC-4/AC-5 above are fixture claims. PRD-398's own lane note
  says the same thing in advance: a claim measured on the fixture is not a claim about the reported
  game.

### Repository checks

`cargo test --release --lib` for the crate: **19 passed**. `cargo fmt --check` reports the crate's
pre-existing deviations and none in the added code. The JS/Rust/doc gates and `pnpm prd:progress` are
recorded in the transcript of this session; where a gate was already red at HEAD for reasons this
change does not touch, the same failures are named rather than fixed.

## Execution results (2026-09-21, continued — the GPU is free)

The blocker this PRD recorded is gone: the unrelated `llama-server` (PID 20249) no longer holds the
card — `nvidia-smi` reports **6860 MiB of 8192 MiB free**, against 555–682 MiB while the lanes were
failing. Every blocked lane was re-run against the **same artifact bytes** (`dist-native/midway-open-pacific`
sha256 `1bae339187e9bab21a8856699448fe48db7b35d53e7df437324e6d5211143dc4`, host `65fa050a…`) and
nothing was rebuilt: that packaged binary already embeds the fixed host, which is why the ten
launches below are the same artifact's first execution that reached loading exit.

### AC-1 — ten consecutive launches of the reported game

Per launch: `node packages/runtime-native/scripts/verify-desktop-loading-animation.mjs --executable
<midway>/dist-native/midway-open-pacific --cwd <midway> --scenario native-playtests/ui.playtest.json
--runner <midway>/node_modules/@threenative/playtest/dist/runner/cli.js --out
artifacts/prd398-ac1/launch-NN`, read by `artifacts/prd398-ac1/analyze-launches.mjs`.

| launches | verdict | samples before `first_playable` | carrying `#102a37` | dark full-window frames | `first_playable` | transition exit | gate exit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 01–10 | **pass**, all ten | 12–14 each, **130 in total** | **130 / 130** (99.44–99.48% of each frame) | **0** | 12 947–14 786 ms | **0** | 1 |

The gate's own exit of 1 is one assertion in all ten launches: `the loading screen froze for 4.7–5.5 s
during the startup`. That is PRD-393's loader/pump stall — the same shape and the same host as its
recorded evidence, named in this PRD's out-of-scope list — and it is a motion result, not a coverage
one. The single `blank` sample per launch is the uniform `#102a37` boot-splash frame, which carries
the authored colour across 100% of the window. Tables and PNGs: `artifacts/prd398-ac1/`; the blocked
attempt this replaces is preserved byte-for-byte in `artifacts/prd398-ac1/blocked-20260920/`.

### AC-7 and the web reference, on the real adapter

```
cd <midway> && pnpm build:web
node <engine>/packages/playtest/dist/runner/cli.js --scenario 'playtests/*.playtest.json' \
  --browser-recipe webgpu --headed --artifacts <engine>/artifacts/prd398-web/playtests-gpu-free \
  --server-command 'pnpm dev --host 127.0.0.1 --port $PORT --strictPort'
```

Runner exit **0** in 89.7 s, adapter `{"architecture":"turing","vendor":"nvidia"}` with
rendererKind webgpu at 1280×720, and **all four scenarios pass with zero console errors and zero
runtime diagnostics**: `midway-audio-realism` 2228 frames, `midway-briefing` 120, `midway-flight`
1877, `midway-launches` 1877. The same four failed their `diagnostics` step in the previous session
with 2600 / 508 / 681 / 683 console errors, every one descending from
`vkAllocateMemory failed with VK_ERROR_OUT_OF_DEVICE_MEMORY`. Log
`artifacts/prd398-web/playtests-gpu-free-run.log`.

On the same adapter the web loading surface is the authored one and continuous to loading exit:
`capture-web-loading.mjs --url http://127.0.0.1:5199/ --interval-ms 0` (behind the consumer's own
`pnpm dev`) reports loading exit at **9711 ms**, **5 of 5** painted samples taken while the `#loading`
layer was up carrying more than 50% `#102a37` with a minimum coverage of **0.9944**, **0 blank
samples, 0 dark full-window frames** over 10 samples across 13.2 s
(`artifacts/prd398-web/loading-gpu-dense/`). One caveat belongs beside that number: the samples at
3473 ms and 7069 ms straddle the page's shader-compile stall (`enter` 5729 ms, `ready` 7225 ms), so a
3.6 s stretch of the loading surface is unsampled — `page.screenshot` needs the page's main thread,
and every capture taken inside the stall returned late. The earlier SwiftShader capture
(`loading-software/`) and the 0.5 s-interval GPU capture (`loading-gpu-free/`) agree on colour and
coverage. The native half needs the web reference only to explain a *dark* frame, and the ten
launches present none, so AC-1's comparison is satisfied by an empty set on both sides.

### Packaged-game lanes: what the reported game can and cannot be measured for

`--launch packaged` was run against `dist-native/midway-open-pacific` for the first time. All three
lanes attach the page (`TN_UI_OVERLAY:{"attached":true}`) in the measured window
(`first_playable` + 8 s, then 30 s at 1280×720), and all three say the same thing about the reported
game: **its own page does not change once it is playable.**

| lane | presented frames in the window | page frames uploaded | result |
| --- | --- | --- | --- |
| `cadence` | 433 | **0** | exit 1: `only 0 uploaded frame(s) in the window: the page's pixels did not reach the game's frame enough to measure a rate` |
| `state-age` | 368 | **0** | exit 1: `the game posted 245 state(s) across 368 presented frame(s) (66.6%)` |
| `pointer` | 420 | **0** | exit 1 after the fix below: `no native pointer action produced a paired visible response: 32 action(s) reached the host and the page changed 0 time(s)` |

The Midway briefing screen a bare launch lands on is static, so AC-2's "distinct visible UI updates
reach at least 90% of presents" has nothing to deliver there — a static page is not a cadence defect,
it is an absence of a workload. The state-age lane's 66.6% is not a publication timer either: the
game's state changed on two frames in three, and the engine documents the skip
(`packages/core/src/ui-state.ts` `flush`: “Skip a publication that would carry the bytes the UI
already has”), so its `posted < 0.9` assertion — written for the fixture, whose state-age page does
publish a changed counter every frame — is reported here rather than relaxed: AC-3 is a fixture
criterion and its assertion stays as written.

Driving the game does produce HUD traffic, and the consumer's own desktop scenario does pass on this
host:

```
cd <midway> && TN_UI_COMPOSITE_TRACE=1 TN_UI_LATENCY_TRACE=1 node <engine>/packages/playtest/dist/runner/cli.js \
  native-playtests/ui.playtest.json --target desktop --executable dist-native/midway-open-pacific \
  --project . --artifacts <engine>/artifacts/prd398-packaged/ui-scenario
```

`midway-native-ui` **passes** (931 frames, zero diagnostics), and the game's own traces reach the
runner's `console.json`: 1401 composited frames over 1188–16 279 ms, **59 uploads, 32 state posts,
2 pointer arrivals**, with `first_playable` at 12 284 ms. That leaves roughly **4 s** of trace after
the game becomes playable, which is shorter than the 30 s steady window the criteria ask for and much
shorter than a 10 s page-local animation plus its idle. So the packaged game is now *launchable* and
its lanes *run*, but these criteria still cannot be answered on it without a harness that holds it in
a steady state and measures that window — the criteria remain fixture claims, exactly as this PRD's
lane note says, and no game source was changed to make them measurable.

### The defect the packaged run exposed, and its fix

Running the pointer lane on the reported game found a real bug in the gate this PRD added:
`judgePointerLatency` **passed while measuring nothing**. When the page never changes,
`pairChangesWithAnchors` returns zero pairs, every bound is satisfied by the empty list, no failure is
recorded, and `passLine` then died on the null median
(`TypeError: Cannot read properties of null (reading 'toFixed')`, `verify-native-ui-cadence.mjs:723`) —
a green verdict followed by a stack trace. That is the failure mode this repository forbids outright:
an empty assertion set is a failure.

- Fix, in the lane's own terms: fail closed when no action produced a paired visible response, naming
the counts. The file's judges are also now exported without running the gate — `main_()` executes only
when the script is run — which is what lets a test import them.
- Red-green: `packages/runtime-native/tests/native-ui-cadence-judge.test.mjs`, 3 tests. With the guard
removed, `fails when no action produced a paired visible response` fails while the other two pass;
with it, 3/3 pass (`pnpm exec vitest run --config vitest.config.ts
tests/native-ui-cadence-judge.test.mjs`). The lane was then re-run against the packaged game
(`artifacts/prd398-packaged/pointer-after-fix/`): exit 1 with that reason, no stack trace.

## Execution commands and planning verification

Run from the engine root, after installing matching branch packages and rebuilding the consumer.
These existing commands provide baseline checks; the phase-1 extensions are required to prove the
new transition/cadence criteria. The UI-frame script targets `examples/native-smoke`, not Midway.
The loading script provisions its own Xvfb/compositor; do not add `xvfb-run`.

```sh
TN_GAME=/home/joao/projects/threenative/sandbox/midway-open-pacific
node packages/runtime-native/scripts/verify-desktop-loading-animation.mjs \
  --executable "$TN_GAME/dist-native/midway-open-pacific" --cwd "$TN_GAME" \
  --scenario native-playtests/ui.playtest.json \
  --runner "$TN_GAME/node_modules/@threenative/playtest/dist/runner/cli.js" \
  --out "$TN_GAME/artifacts/prd398-loading"
node packages/runtime-native/scripts/verify-desktop-ui-frame.mjs --contract in-frame
node packages/playtest/dist/runner/cli.js "$TN_GAME/native-playtests/ui.playtest.json" \
  --target desktop --executable "$TN_GAME/dist-native/midway-open-pacific" \
  --project "$TN_GAME" --artifacts "$TN_GAME/artifacts/prd398-playtest"
cargo test --release --lib --manifest-path packages/runtime-native/native/ui-overlay/Cargo.toml
```

The native-smoke gate's existing opaque fixture cannot establish partial-alpha correctness or
React performance. Extend its current page/consumer route for those assertions; also run the real
game. Existing playtest input checks do not measure display latency, and the one-second composite
log does not measure sub-frame gaps. Keep these limitations visible when recording results.

Planning verification (2026-09-20): `pnpm check:docs` passed for tracked documentation; the six
required prose-lane suites passed, **164 tests**. The new PRD is untracked, so its links are checked
separately through `checkDocLinks(root, [prdPath])`: **1 file, 2 links, zero missing**.
`pnpm prd:progress` passed: **0/3 phases, 0/7 phase boxes, 0/7 acceptance criteria**, `prd:0%`.
No builds, game launches, package installation or implementation tests were run; all runtime
acceptance criteria remain open.
