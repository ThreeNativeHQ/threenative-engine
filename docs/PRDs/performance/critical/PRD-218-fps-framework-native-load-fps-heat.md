---
prd_contract: v1
---

# PRD-218 — fps-framework native: the loading screen hides a 12–14 s synchronous stall, the frame is one saturated thread, and cheap frames present uncapped

**Status:** PARTIAL — worked 2026-08-24 on the physical Pixel 8. Evidence:
`docs/verification/runtime-perf-state.md`.

**Priority:** P1 — Criterion unmet: first frame 14.4-14.8 s, warm-up path about 35 s on Pixel 8.
| criterion | state |
| --- | --- |
| 1. Stall named | **short** — the stall is named and reproducible (`pipelineCompile` 8,038 ms across 105 calls, 67.5 % of an 11.7 s gap) but attribution is **73.5 %**, under the required 80 %. Re-measured 2026-09-03 on the current runtime: 8,300 ms / 103 calls, attribution 72.4 % — still short. The residual is JS inside the first frame and is reported as residual, not absorbed. |
| 2. Load time ≤ 8 s, live overlay | **not met** — re-measured 2026-09-03: first frame 14.4–14.8 s on the current runtime, and the warm-up opt-in path regresses to ~35 s (see PRD-327's device acceptance and [PRD-540](PRD-540-the-compile-walk-leaves-the-main-thread.md)). |
| 3. No uncapped idle presentation | **met at the mechanism** — 119.8 presents/s red, 60 Hz convention with `__tnPresentationCap` override and `capHz` in every tick. The forced-cheap-frame re-reading after the cap landed was not re-taken. |
| 4. Batching decided by measurement | **met** — declining is arithmetically correct for an `InstancedMesh`-shaped key against 835 unique geometries; the material-keyed `BatchedMesh` lever is filed into PRD-214's lever list. |
| 5. Guard-rails | **partial** — storage root fixed with a bindings-level red-green needing no device; applicationId documented in both AGENTS chains. The 32 `map: undefined` material warnings are still unattributed. |

**Moved to `performance/critical/` 2026-09-02.** Criterion 2 (launch ≤ 8 s) is still the largest
user-visible defect the runtime owns and nothing has moved it since 2026-08-24. The mechanism is
now planned as [PRD-327](PRD-327-first-use-pipeline-compilation-leaves-the-main-loop.md) (real
async pipeline creation off the main loop, warm-up on by default on native, a measured decision on
a persisted cache) and the launch instrument's V8 gap as
[PRD-328](../../done/PRD-328-launch-is-measured-on-the-engine-that-ships.md). This PRD stays open as the
finding and the acceptance number; it moves to `done/` when PRD-327 ticks criteria 1 and 2 here.
Criterion 3 is met at the mechanism, criterion 4 was handed to PRD-214/PRD-310, and criterion 5's
open items (the `map: undefined` warnings) are not critical and stay here unowned. The order of
work is in [`README.md`](README.md).

**The finding that matters most, and that invalidates advice this framework already ships:**
`renderer.compileAsync()` does not work on the native host. `packages/core/src/renderer.ts`
documents it as the fix for exactly this stall; measured, it warms nothing and spends its whole
budget. Three layers: `three`'s `yieldToMain()` fell back to a whole rendered frame because the
host shimmed `self` and never shimmed `scheduler` (**fixed**, `scheduler.yield` now installed and
recorded in `shim-manifest.json`); and beneath that, `#boot` starts a held loop that still renders
the world, so the first world render compiles everything in 8 s and starves the warm-up it runs
beside. **Remaining Phase 1 work is that ordering fix**, not more scheduling.

`warmUp` therefore ships **off by default** with the measurement recorded on the option. An earlier
version of it held the launch open forever (loop held, `substeps mean 0`, no error anywhere) and
briefly reached the user as an enemy stuck in bind pose; it is now bounded per compile and overall,
never rethrows, and always reports.
Evidence: `docs/verification/runtime-perf-state.md` (three cold launches of
`com.threenative.bayview`, logcat markers, `top -H` thread sampling, screencaps).

**Complexity:** +2 multi-package, +1 complex performance work, +1 for 5+ files = **4 → MEDIUM**,
checkpoint after every phase. The stall phase may re-score once Phase 0 names the cost.

**Reported as:** low FPS on mobile while web looks fine; device heating; loading screen ~30 s.
Game: `sandbox/fps-framework` ("bayview"). Device: Pixel 8 (`shiba`), Mali-G715, Dawn-on-Vulkan,
V8 11.0.226.16, 1080×2400 @ 120 Hz, thermal status 0 throughout (no throttle confound).

## Context

Measured, this session (full tables in the verification file):

1. **The stall.** Real asset/world load is 1.0–2.4 s (`TN_FPS_BOOT_MS enterTotal` 1048–2412).
   Then the main loop freezes **once** — `TN_FRAME_HITCH gapMs` 12,332 and 14,145 ms on two
   cold launches — between `TN_NATIVE_SMOKE_FIRST_FRAME` and the first steady presents. The
   loading overlay sits through all of it; tap-to-playable is 15–20 s. During the gap
   `top -H` shows **SDLThread pegged 87–112 %** with `mali-compiler` and `V8 DefaultWorker`
   threads active — synchronous first-use pipeline compilation, 346 MB texture upload and
   first-tick JS warmup, serialized on the main loop. PRD-214 saw the same phenomenon as a
   27.4 s hitch and excluded it from its windows as "startup-shaped"; nobody has owned it
   until now.
2. **The ceiling.** Steady state is **18.5–19 FPS** (60 presents / 3.15–3.4 s). SDLThread
   alone runs ~87–120 %; RenderThread, GPU and compiler threads idle. One CPU thread is the
   limiter, not the GPU. `TN_RENDER_PROJECTION` reports `projecting:false,
   reasonCode:"notWorthwhile", sourceRenderables:835, batches:0` — 835 draw candidates go in
   as individual draws because the projection/batch heuristic declined ("projecting would
   draw 835 of 835 candidates, which is not worth its own cost"). fox-native measured this
   same class of fix at 21.8→59.7 FPS (`native-performance-fixes/HANDOFF-native-visual-parity-2026-08-10.md`).
   PRD-214 owns the render-internal split; this PRD owns the **heuristic that declines** and
   the frame-observability gap that let 835 unbatched draws ship unnoticed on device.
3. **The heat.** Two contributors, both measured: (a) with cheap content the runtime presents
   **uncapped at 120 Hz** — the stale conformance build held 120 FPS on a static dark screen
   (3 textures, 39 MB) indefinitely; (b) in-game, SDLThread pegged at 19 FPS never idles.
   Battery temp rose 37.6→38.7 °C in ~15 min of probing; prior lane records put long sessions
   at heat-soak ~38–40 °C and thermal-LIGHT trips.
4. **The overlay.** `Hud.tsx:285-307` renders `LOADING ${assetsLoaded} / ${assetsTotal}` and
   falls back to the static label "PREPARING" only while `assetsTotal === 0`. On native the
   total never populates, so the counter and its progress bar never start — the game reads as
   hung for the entire stall. Web populates it; the seam is in how the total reaches React on
   the native asset path. Engine or game is **Phase 0's call**, not an assumption.
5. **Guard-rail findings from the same session** (each small, each real):
   - Wrong-package trap: `fps-framework.apk` installs as `com.threenative.bayview`, but a
     stale conformance harness still installed as `com.threenative.game` shows a plausible
     yellow-SCORE dark screen at 120 FPS. A probe against the wrong package produces
     confident nonsense (this session's first launch was exactly that mistake).
   - `[Storage] Failed to create directory "/data/.local/share/mystral/storage":
     Permission denied` — the runtime's storage root is not app-scoped on Android.
   - 30+ `THREE.Material: parameter 'map' has value of undefined` warnings during town load.
   - APK is 379 MB; size breakdown is a separate investigation, not owned here.

## Solution

- **Phase 0 — name the stall.** Instrument the gap with the existing cold-start segments:
  split pipeline-compile vs texture-upload vs first-tick JS (per-pipeline timings via
  `createRenderPipelineAsync` where Dawn/wgpu-native exposes it; `TN_GPU_TEXTURES` deltas
  already exist). Deliverable: a named cost table in `docs/verification/`, and the overlay
  seam identified (engine progress callback vs game manifest count) by reading the native
  fetch path against `Hud.tsx`'s `assetsTotal`.
- **Phase 1 — overlap or budget the stall.** Preferred: move first-use pipeline compilation
  off the critical path (async pipeline creation, warmup during the loading screen) so the
  gap shrinks toward the 1–2.4 s the load actually costs. Where a cost cannot move, it must
  be visible: the overlay shows the real progress instead of a static label. No phase of this
  may change what the game looks like (rule 3).
- **Phase 2 — cap cheap frames.** The runtime gains a presentation ceiling (named override on
  the same object, convention-on default — e.g. cap at display/2 or 60 Hz when the frame is
  cheap, uncapped only on explicit opt-in), so a loading or idle screen cannot burn 120 Hz.
  Measurement honest when overridden, per the conventions clause.
- **Phase 3 — the batching decline.** Hand `TN_RENDER_PROJECTION`'s decline at 835 candidates
  to PRD-214's lever list: either the heuristic's threshold is wrong for device-class GPUs or
  the fox-native merge mechanism is not wired for this game's shape. The fix lands in
  packages/, never as game-side geometry surgery (that mistake is already on record in the
  fox handoff). Draw-count on device becomes observable via the PRD-071/172 `renderer.info`
  lane so the next 835-draw game cannot ship silently.

## Acceptance criteria

1. **Stall named.** A `docs/verification/` table attributes ≥80 % of the gapMs to named
   phases. *Red-green:* revert the instrumentation patch; the table's build fails its own
   "segments sum ≈ gapMs" assertion (paste the assertion failure).
2. **Load time.** Cold launch tap-to-playable ≤ 8 s median over 3 launches on the Pixel 8
   lane, with the loading overlay showing live progress (count or phase names, never a bare
   static label for >1 s). *Red-green:* revert the overlay change; the scenario that asserts
   the overlay text contains a non-static token fails on device (paste the red).
3. **No uncapped idle presentation.** With the game forced to a cheap frame (loading screen
   or idle scene), `TN_PRESENTS_TICK` shows ≤ 65 presents/s. *Red-green:* revert the cap;
   the same probe records ~120 (paste both dumps). The named override flips it back and the
   probe reports the honest number either way.
4. **Batching decided by measurement.** Either the projection heuristic accepts this scene's
   835 candidates (draw count drops, FPS rises on device) or a written measurement shows why
   declining is correct at this cost point — filed as input to PRD-214, decided by
   device numbers, not the heuristic's own opinion.
5. **Guard-rails.** Storage-root fix lands with a bindings-level test (native lane needs no
   display — precedent: the PRD-166 bindings-test executable); the Material `map: undefined`
   warning source is named and either fixed or filed where it belongs; a `doctor`/docs note
   names `com.threenative.bayview` as fps-framework's applicationId so the next probe does
   not launch the conformance harness by mistake.

Every criterion that claims a device number runs on the Pixel 8 lane with the session rules
from `packages/runtime-native/AGENTS.md` (`logcat -G 16M`, wake-pulse, force-stop between
rungs, SurfaceFlinger or runtime counters, never `gfxinfo`). No iOS claim.

## Out of scope

- The 19 FPS ceiling's render-internal split — PRD-214 Phase 0.
- APK size — separate investigation.
- Web-lane FPS (user reports it fine; unverified this session — if it regresses, that is a
  different PRD with its own lane).
