# PRD-611 — The Linux HUD overlay keeps up with the game and stops burning a core

**Status:** PARTIAL
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

- [ ] Baseline: three Midway flights of the unchanged overlay record `lastRoundTripMs`, the `settled` trace and the WebKit share of CPU samples. proof: `~/.cache/tmp-tn/midway-runs/hud-base*-desktop/run.log`, `perf report --sort comm`
- [x] The damage route is characterized: the WebKit probes show which buffers are complete and which are partial. proof: `native/ui-overlay/src/bin/probe-damage.c` (2026-10-13, 1920x1080 Xvfb: with the coverage layer and nudge, 5 of 5 buffers per step are complete and match `get_snapshot` to maxDelta 1; without them, later buffers are partial)
- [ ] One route is chosen and recorded under `## Decisions`, with the number that decided it. proof: the Decisions entry cites the flight numbers

### Phase 2: Implement

- [ ] The chosen route is in `offscreen.rs` behind a named override (`TN_UI_OVERLAY_CAPTURE=snapshot` keeps today's path) and falls back to `get_snapshot` when its self-check fails. proof: `cargo test` in `native/ui-overlay`
- [x] Unit tests cover the new merge, change-detection and fallback logic. proof: `cargo test` in `native/ui-overlay` (26 passed, 4 new `copy_composited` tests; the fallback is a counter on the live view and is proven by the Midway flights, not a unit test)
- [ ] The Linux WebKit focus, keyboard and editing regressions stay green. proof: `pnpm test:ui-native`

### Phase 3: Prove it on Midway

- [ ] AC-5: the HUD frame reaches the mailbox within one frame (16.7 ms) at p95 in a Midway flight. proof: `TN_UI_SNAPSHOT` and `TN_UI_SNAPSHOT_TRACE` lines of `hud-after*-desktop/run.log`
- [ ] The WebKit web process uses less CPU than the baseline over the same flight. proof: `perf report --sort comm` on `perf-flight.sh` runs
- [ ] The visual judge rates the HUD before and after IMPROVEMENT or NEUTRAL, per frame and overall. proof: judge verdict recorded under `## Results`

## Decisions

(none yet)

## Results

(none yet)
