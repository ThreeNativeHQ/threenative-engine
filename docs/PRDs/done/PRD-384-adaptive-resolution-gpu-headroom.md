# PRD-384 — Adaptive resolution must distinguish host delay from GPU cost

**Status:** DONE
**Priority:** P1 — Declared required by P1 PRD-539's temporal reconstruction (successor of PRD-455); closed 2026-10-12; every box ticked.
**Complexity:** 5 (MEDIUM); risk override: none
**Owner:** Codex
**Depends on:** PRD-228; Midway's installed PRD-382 engine branch

## Context and solution

Midway's live NVIDIA Turing capture fell from 1920×1080 to 998×562 after 60 seconds.
Reported GPU samples were 6.8–7.74 ms while presentation stayed around 9 fps. Shrinking
73% of pixels gained about 2.5% fps. The user requires automatic optimization, so pinning
`renderer.resolutionScale: 1` is rejected. Original observations live in the game's
`docs/blur-investigation.md` and local `screenshots/blur-before/samples.json`.

Repair the existing `packages/core/src/resolution-scaler.ts`, reached by `game.ts`'s
frame-budget callback. Existing frame windows already supply `gpuMs` and `gpuAgeFrames`.
No new public API, renderer, platform-specific game code or gameplay change.
Capability discovery returned no scaler capability; `defineGame` supplies the existing
`render.resolutionScale` option. Keep automatic policy and honest surface reporting.

Before implementation, register this policy:

1. A finite positive GPU sample with integer age 0–8 Three frame IDs is usable. Eight is
   an explicit asynchronous-query allowance, not a percentile claim (observed ages 3, 7, 4).
   Missing, invalid or older data retains the existing presentation fallback.
2. A fresh GPU sample within the current target budget vetoes a down-step. GPU overload
   sizes the drop from GPU cost, not the host's FPS deficit. Existing presentation, startup,
   stall and resize guards remain.
3. Four eligible windows whose projected next-rung GPU cost fits the budget recover one
   rung even when host FPS is low. Project using the actual squared scale ratio. Unknown
   GPU timing retains the existing FPS/tail recovery criteria.
4. Oscillation inhibits upward probes for six windows (the existing oscillation reach),
   rather than permanently freezing the controller. Overload can still lower resolution.
   Expiry reports `auto` even when the scale itself does not change.

`gpuMs` is one resolved sample, not a window percentile; sustained recovery and the existing
guards bound that limitation. Timestamp aggregation and empirical workload rollback are outside
this repair. No claim is made to fix host scheduling or the game's overall frame rate.

## Acceptance criteria

- [x] AC-1 [local; actor: agent]: Fresh GPU headroom preserves/reclaims pixels under low FPS;
  GPU overload still scales proportionately; unavailable/stale timing preserves fallback.
  Focused Vitest run: 57 tests passed in six scaler/frame-budget suites. Red: the new GPU suite
  had five behavior failures (including 0.23 instead of 1, and 0.52 instead of 0.85).
  Broader component verification: all 1,224 core tests passed (24.97 seconds).
- [x] AC-2 [local; actor: agent]: Oscillation expires, reports its actual source and permits
  subsequent overload response; existing vsync/outlier regressions pass.
  Same run as AC-1; covers expiry source propagation and overload during the temporary hold.
- [x] AC-3 [local; actor: agent]: Repacked core runs Midway with `auto`, passing a live flight
  and camera-switch resolution check on the named GPU, with inspected frames.
  Midway SBD: 90 seconds, nine C-key presses, 19 samples at 1920×1080, source `auto`, no browser
  errors; end frame inspected. Tarball: `threenative-core-0.3.2-gpu-headroom-6367d7456bd5.tgz`.
  Engine and game typechecks and the game web build pass. Baseline and after frames/timings are
  recorded in the game's investigation; the capture rig does not establish a 60-fps target.
  Devastator: the same 90-second capture also passed, with 19 full-resolution `auto` samples,
  nine C-key presses and no browser errors; cockpit and final chase frames inspected.
- [x] AC-4 [local; actor: agent]: proof: `pnpm typecheck && pnpm lint && pnpm test` plus the native fixture below. Typecheck, lint and test run; native controller execution
  and fresh independent review cover the changed behavior. Report unrelated failures explicitly.
  Re-run 2026-10-12 on develop 934de90ad: `pnpm typecheck` exit 0 (after the workspace build; the
  first run failed with TS2307 only because no package was built). `pnpm lint` exit 0 (0 errors,
  1,397 existing warnings). Core Vitest: 3,187 passed; the one failure (`world-gpu-scene.spec.ts`,
  60 s timeout under load) passes alone, 97 of 97; scaler and frame-budget tests: 74 passed.
  Native controller fixture `packages/core/__tests__/fixtures/resolution-scaler-native.ts`, bundled
  with esbuild, ran on `mystral run --no-sdl` with the V8 build (`tn-linux-jsprofile`) and the
  QuickJS build (`tn-linux-quickjs`): exit 0 and `TN_SCALER_NATIVE_PASS` on both. This proves
  controller behavior on both native JS engines, not a native Midway launch.
  Independent read-only review passed earlier; its age-8 boundary request was added and passed.
  Unrelated failure: `pnpm test` exits 1 only in `packages/runtime-native` (21 failed, 1,550
  passed, 70 skipped; timestamp-query, pump-silence, native-adapter-policy and three more files).
  This fresh worktree has no native build artifacts and this change touches no native file.
  No full-suite green is claimed.

## Unreal comparison (2026-10-09)

Read in UE 5.8.3 for the Unreal review request (ideas only, no code copied). Paths are under
`Engine/Source/Runtime/`. The policy above is the one Unreal's controller uses, so no box changes:

- Unreal sizes the fraction from GPU busy time only, as `sqrt(target / GPU ms)` times the current
  fraction (`RenderCore/Private/DynamicRenderScaling.cpp:45-55`). By default no CPU time enters the
  decision (`r.DynamicRes.UseCPUTimeLogic` is false, `Engine/Private/DynamicResolution.cpp:110-115`).
  The legacy CPU-bound check, when on, keeps a game or render thread over budget from counting as
  GPU over budget (`:281-290`). Both modes match this PRD's policy 2: host delay never buys back pixels.
- Its targets leave headroom: a 10% GPU headroom below the frame budget
  (`DynamicResolution.cpp:46-50`), a 16-frame history weighted by 0.9 per older frame (`:65-75`),
  and an immediate change when every frame scanned is over budget (`:96-99`, `:337-347`, `:406`).
- Its own comment says the square-root model ignores a fixed cost that does not scale with pixels
  (`DynamicResolution.cpp:309-322`), so it can drop resolution further than needed. The insensitivity
  guard in `resolution-scaler.ts` measures that fixed cost and refunds the step; Unreal leaves it as a TODO.
  Keep it.

The differences that remain are new work, not this repair: steps that reallocate nothing, a
continuous fraction and a minimum change period are
[PRD-564](PRD-564-the-resolution-scale-changes-without-reallocating-a-target.md); a start point
from the GPU family is [PRD-563](PRD-563-the-first-frame-starts-at-the-tier-the-gpu-family-holds.md);
a weak GPU's late timestamps and the MSAA rung are
[PRD-549](../performance/PRD-549-the-engine-holds-60-fps-on-a-weak-gpu.md).

## Integration

`defineGame` → `game.ts` frame budget `onWindow` → `ResolutionScaler.observe` →
`renderer.setResolutionScale`; numeric pin overrides and frame-budget output remain intact.
Game adoption uses a content-hashed core tarball, never node_modules edits.

### Phase 1 — Engine behavior

- [x] Reproduce with regression tests; implement and pass the focused scaler/integration tests.
- [x] Update template guidance and pass independent review of the implementation.

### Phase 2 — Consumer verification

- [x] Run required engine checks and native controller proof; pack the compatible core.
- [x] Reinstall in Midway, run automatic-scale flight captures, inspect images and update its note.

## Checkout

Owner: this Codex task. Checkout: `/home/joao/projects/threenative/threenative-engine/.worktrees/blur-scaler`.
Branch: `fix/blur-scaler`. Base: `be0d68b3ba06d8c1732337f788d7e00c17ae00a4`, the exact
source of Midway's installed core; develop lacks its flight/water/shadow fixes. The repair is
kept separate from those existing changes. The baseline index exports `ripple-field.ts`, but
that file is untracked in the primary checkout; an unchanged copy was required for the isolated
build and is excluded from this repair's commit. Cleanup: complete. The task commit was
cherry-picked to the primary engine checkout with an identical Git tree. After verifying the
owner had stopped, releasing its lease and auditing tracked, untracked and ignored data, the
baseline source copy and gate status were preserved in `/tmp/midway-scaler-*`. Ordinary
`git worktree remove` removed the 2.4G checkout; its directory and registration are gone.
The game adoption is included in `5a59e49` on `midway/asset-battle-integration`.
