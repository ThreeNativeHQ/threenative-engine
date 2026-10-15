# PRD-611 — The Linux HUD overlay keeps up with the game and stops burning a core

**Status:** PARTIAL (round trip p50 54 to 12 ms, web-process cost per game frame -9 to -17%; AC-5 p95 and the `pnpm test:ui-native` box are open)
**Priority:** P1 — PRD-610 AC-5 is open: the HUD trails the game by many frames on Midway and the WebKit web process is the largest CPU consumer of the run.
**Complexity:** 6 (MEDIUM)
**Owner:** João
**Depends on:** PRD-610 (this PRD closes its AC-5 and rides PR #493)

## Context

The Linux UI overlay (`packages/runtime-native/native/ui-overlay/src/offscreen.rs`) is a WebKitGTK view in a `GtkOffscreenWindow` on its own thread. The game never calls into it: it reads a latest-frame mailbox. A cadence loop asks `WebView::snapshot(SnapshotRegion::Visible)` for the pixels, copies them into a pooled buffer and publishes them.

PRD-610 measured the cost on Midway in flight (2026-10-13, Xvfb): `get_snapshot` p50 54 ms and p95 68 ms, copy and compare 0 to 1 ms, and `WebKitWebProcess` at 61.6% of all CPU samples (about 2.3 times the game main thread). `get_snapshot` re-rasters the whole page on the CPU every time, and it blocks the page's own rendering while it runs.

## Evidence gathered for this PRD (2026-10-13, WebKitGTK 2.54.1, GTK 3.24, Xvfb)

Probes are under `native/ui-overlay/src/bin/` (see Solution) and the numbers below come from them.

1. With the view background **opaque**, the page's own compositor frame is complete and exact: drawing the view into a cairo surface after each `damage-event` costs 0.3 to 2 ms and matches `get_snapshot` to within a few dozen bytes of 8 MB.
2. With the view background **not fully opaque** (alpha 0 up to 0.99), only the first buffers of the SHM swap chain are complete. Every later buffer holds just the repainted damage region and zero elsewhere, so reading the offscreen window or the view gives a partial frame. The `PropagateDamagingInformation`, `UseDamagingInformationForCompositing`, `UnifyDamagedRegions` and `UseSkiaForComposition` features, `WEBKIT_DISABLE_COMPOSITING_MODE`, `WEBKIT_DMABUF_RENDERER_FORCE_SHM` and the hardware acceleration policies change nothing (the other policies abort, as `offscreen.rs` documents).
3. A full-viewport empty layer whose transform changes by 0.01 px every page frame makes every buffer complete, at the price of a full-frame composite per page frame.

## Solution

Take the pixels from the page's own compositor frames instead of a second full raster per ask, and keep `get_snapshot` as the fallback and the verifier. The mechanism lives only in the overlay (`native/ui-overlay/**`): nothing here knows Midway, and the game's HUD source is untouched.

### Phase 1: Measure and choose

- [x] Baseline: two Midway flights of the unchanged `get_snapshot` capture record `lastRoundTripMs`, the `settled` trace and the WebKit share of CPU samples. proof: `~/.cache/tmp-tn/midway-runs/hud-base-desktop/run.log`, `hud-snap1-desktop/run.log`, `perf report --sort comm` (2026-10-13, Xvfb, loaded host: round trip p50/p95 62/100 ms and 54/96 ms; 2709 and 2598 HUD frames per flight; `WebKitWebProcess` 61.6% and 63.1% of CPU samples, the game 15% and 27%)
- [x] The damage route is characterized: the WebKit probes show which buffers are complete and which are partial. proof: `native/ui-overlay/src/bin/probe-damage.c` (2026-10-13, 1920x1080 Xvfb: with the coverage layer and nudge, 5 of 5 buffers per step are complete and match `get_snapshot` to maxDelta 1; without them, later buffers are partial)
- [x] One route is chosen and recorded under `## Decisions`, with the number that decided it. proof: the Decisions entry cites the flight numbers

### Phase 2: Implement

- [x] The chosen route is in `offscreen.rs` behind a named override (`TN_UI_OVERLAY_CAPTURE=snapshot` keeps today's path) and falls back to `get_snapshot` after three captures in a row that never complete. proof: Midway flights (`hud-fx1` fell back after 3 misses and kept the HUD alive on `get_snapshot`; `hud-snap1` ran the override; `hud-paceA`/`hud-paceB` ran `capture=compositor` with 1 partial frame in 3000)
- [x] Unit tests cover the new merge, change-detection and fallback logic. proof: `cargo test` in `native/ui-overlay` (26 passed, 4 new `copy_composited` tests; the fallback is a counter on the live view and is proven by the Midway flights, not a unit test)
- [ ] The Linux WebKit focus, keyboard and editing regressions stay green. proof: `pnpm test:ui-native`
  - Red at `HEAD` before this PRD's changes too: `ordinary_controls_use_native_focus_and_editing` expects `value=Aé` and observes `value=A2` after the `us,fr` layout switch (same result with `TN_UI_OVERLAY_CAPTURE=snapshot` and on a copy of the untouched `offscreen.rs`). It stops at that key step, so it proves nothing about this change. Needs a look at the Xvfb keyboard layout on this machine.

### Phase 3: Prove it on Midway

- [ ] AC-5: the HUD frame reaches the mailbox within one frame (16.7 ms) at p95 in a Midway flight. proof: `TN_UI_SNAPSHOT` and `TN_UI_SNAPSHOT_TRACE` lines of `hud-pace*-desktop/run.log`
  - Not met: p50 12 ms but p95 29 and 32 ms (`hud-paceA`, `hud-paceB`), against 54/96 and 62/100 ms with `get_snapshot`. A request lands at a random point of the page's 60 Hz frame, so the tail cannot go below one page frame plus the composite.
- [x] The WebKit web process uses less CPU per game frame than the baseline over the same flight. proof: `perf report --sort comm` on `perf-flight.sh` runs (cycles of `WebKitWebProcess` per game frame: 0.27e9 `hud-base`, 0.248e9 `hud-snap1`, 0.250e9 `hud-nopace1`, 0.225e9 `hud-paceB`; share of the player's samples 61.6%, 63.1%, 58.2%, 56.5%). Only 9 to 17% less: see Results.
- [x] The visual judge rates the HUD before and after IMPROVEMENT or NEUTRAL, per frame and overall. proof: judge verdict recorded under `## Results` (NEUTRAL on takeoff, cockpit, reargun and overall, two runs per arm; the same judge also said it cannot rule out a few percent of opacity by eye, so `probe-damage` maxDelta 1 against `get_snapshot` is the pixel evidence)

## Decisions

- 2026-10-13, agent: the HUD is read from the page's own compositor frames, made whole by a coverage layer (Solution). Rejected: WPE (not installed, needs sudo, and its web process composites the same way, so the transparent-buffer defect is likely shared); accumulating partial buffers (probe `probe-acc`: maxDelta 54 to 98 against `get_snapshot`, 30k to 300k bytes over 8, from double-composited translucent pixels); the WebKit damage feature flags (no effect on the buffers). Deciding numbers: Midway round trip p50/p95 54/96 ms with `get_snapshot` against 24/31 ms with compositor frames (`hud-snap1`, `hud-fx2`), and 6182 against 2598 HUD frames per flight.
- 2026-10-13, agent: the nudge is a `data-tn-fx` attribute on `html`. A custom property on the root produced no repaint (probe: 0 frames after the first) and a class is lost when a page rewrites `className`.
- 2026-10-13, agent: absolute WebKit CPU did not fall with the faster capture alone. Sample shares were `WebKitWebProcess` 60.9% (`hud-fx3`) against 63.1% (`hud-snap1`), and the capture loop made 2.4 times as many HUD frames as the game took (the game took one frame per 50 to 60 ms in this lane). So the capture is paced: it starts so it ends just before the game takes its next frame (`pace_open`), with `TN_UI_OVERLAY_PACE=off` as the override.

## Results

Integration audit (2026-10-13): the requested HUD commits `8a2270834`, `8b3c35c96`, `19d17d4f7` and first-present ordering fix `db23a199f` are already ancestors of `535749525`; no duplicate cherry-pick is needed. The frozen `~/.cache/tmp-tn/pkg-ac10-winner-hud-v1/tn-native-engine-player-v8` is a regular file with SHA-256 `ca0d2db010a598e4664a0e9bf1094df37b93e380d5d73e06e9fb33f969269b24`, contains the capture/pacing controls, and reports `capture=compositor` in `winner-hud-v1-desktop/console.json`. That fresh flight passed parity and recorded whole-run HUD p50/p95 **39/65 ms** (249 one-second observations), or **42/67 ms** after player tick 300 (197 observations). Host load was **37.04 to 20.97 on 24 cores**: these latency readings do not qualify an isolated improvement or close AC-5. The old `cache1-a1`/`cache1-b1` players reported no compositor marker; their 105/107 ms p95 cannot be attributed to this integrated HUD build.

An attempted same-player snapshot/compositor comparison is retained under `hud-integrated-snapshot-a1-desktop` and `hud-integrated-compositor-b1-desktop` (parity passed both). These omitted `TN_PLAYER_METRICS=1`, so their 14/15 one-second HUD observations lack the intended player-tick mapping and do not qualify steady-flight latency. The corrected snapshot arm `hud-integrated-metrics-snapshot-a1-desktop` was stopped when unrelated CPU workers drove load to **116.14 on 24 cores**; its run-local `timing-exclusion.txt` records the conflict, and the runner exited 2 during cleanup. Its player was confirmed gone before releasing the lane. No corrected compositor arm was launched. Source and binary integration are verified; controlled current-build HUD latency and the 16.7 ms p95 target remain unverified.

Midway flight on this machine (Xvfb, loaded host, 2026-10-13). `lastRoundTripMs` is the one-second `TN_UI_SNAPSHOT` line, HUD frames are `settled` events, about 2500 game frames per flight.

| Flight | Capture | Round trip p50/p95 | HUD frames | Game frame p50/p95 |
| --- | --- | --- | --- | --- |
| `hud-base` | `get_snapshot` | 62/100 ms | 2709 | 68/117 ms |
| `hud-snap1` | `get_snapshot` | 54/96 ms | 2598 | 52/105 ms |
| `hud-fx2` | compositor, unpaced | 24/31 ms | 6182 | 59/72 ms |
| `hud-nopace1` | compositor, unpaced | 23/30 ms | 5755 | 54/68 ms |
| `hud-paceA` | compositor, paced | 12/29 ms | 2954 | 53/61 ms |
| `hud-paceB` | compositor, paced | 12/32 ms | 2996 | 54/70 ms |

- The game took one frame per 52 to 60 ms in this lane, so a HUD capture every 23 ms made 2.3 frames the game never saw. Pacing leaves about 1.2 captures per game frame and ends each just before the game takes it.
- The WebKit web process runs on one thread (`perf report --sort pid`: 56.4% of the player's samples in the main thread of the web process, nothing in a compositor thread) at about one core in every arm. That thread does the page's JavaScript, layout, CPU paint and the composite. The capture was a small part of it: removing the second raster per ask and then 40% of the captures moved the per-frame cost by 9 to 17%. The rest is the page's own paint, which is CPU raster because accelerated compositing aborts on an offscreen window.
- Visual judge, fresh read-only Sonnet subagent, BEFORE = `hud-base` and `hud-snap1`, AFTER = `hud-paceA` and `hud-paceB`, poses takeoff, cockpit and reargun at 1280x720 (native desktop capture, not the web WebGPU recipe): NEUTRAL on all three and overall. Images: `~/Downloads/prd611-hud/`.
- `hud-pace1` and `hud-paceB` exited 1 on `[WebGPU] Device error (Validation): Destroyed texture [Texture "of [Surface]"] used in a submit` (2 of 5 flights on engine build `84da13581`, including the same build with `TN_UI_OVERLAY_PACE=off` passing). The overlay creates no WebGPU resource, so this is the engine's GPU-thread present, not this change. Parity passed on `hud-paceA`.

## Blocked on

- A cheaper page paint than the CPU raster: WPE headless (not installed, needs a package install with sudo), or WebKitGTK accelerated compositing on an offscreen window (aborts today). Owner call on installing WPE.
- The game's HUD CSS (inset box-shadow blur, full-screen gradients, `backdrop-filter`) sets the paint cost; changing it is game code and out of scope here.
