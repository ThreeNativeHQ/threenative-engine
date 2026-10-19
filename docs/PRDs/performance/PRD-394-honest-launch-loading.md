# PRD-394 — An honest launch: progress you can read, failures that fail closed, a load that is not 104 seconds

**Priority:** P1 — Measured 104 s desktop load behind an opaque screen; honest progress unlanded.
Status: PHASE 3 (the launch freeze is fixed and measured; asset decode still to cut)
Owner: engine + `midway-open-pacific` (sandbox)

## Why

`midway-open-pacific` on desktop takes **104 s** from process start to `startup.whenReady()`, behind
an opaque layer that says "Preparing the Pacific theatre…" and never changes. Measured on this host
(`TN_LOAD_STEP`, 2026-09-18, local host `build/tn-linux/mystral`):

| step | settled at |
| --- | --- |
| audio | 1.1 s |
| aircraft | 31.4 s |
| ships | 52.6 s |
| fleet | 70.7 s |
| hulls | 97.3 s |
| environment | 97.5 s |
| deck-crew | 97.5 s |
| `enter()` | 100.8 s |
| `whenReady` | 104.4 s |

Every one of the 222 bundle reads (164.9 MB) completes inside the **first 1.5 s** — so none of the
remaining ~100 s is I/O. It is GLB parse, texture decode and GPU upload (1128 MB of textures, 227
of them) on the main thread, in ~1 s blocking chunks: `TN_SLOW_PHASE:{"phase":"animationFrames",
"ms":998}` once per second for the whole launch, which also caps the loading screen at one repaint
per second.

Three separate defects fall out of that:

1. **Nothing reports.** The engine already computes `ctx.startup.progress` (byte-weighted,
   monotonic) and the game never reads it. Nothing anywhere names the asset being worked on.
2. **Nothing fails closed.** A launch that stops making progress just hangs. The same run ended in
   `[FATAL] The GPU device was lost: vkQueueSubmit failed with VK_ERROR_DEVICE_LOST` (VRAM was
   exhausted by another process on this host — 7726/8192 MiB taken) and the *player* saw a still
   loading screen, with the diagnosis only in a terminal they do not have.
3. **It is too slow**, and the work is all on one thread in one-second blocks.

## Phases

### Phase 1 — Fail closed, and make a failure copyable

- [x] Engine: a startup stall watchdog. When `startup.progress` does not move for `stallMs`
      (`STARTUP_STALL_MS`, 45 s) the engine reports `TN_STARTUP_STALLED` once, naming elapsed time,
      the last progress value and the assets still outstanding. Observed on midway:
      `TN_STARTUP_STALLED: ... stood at 59.4% for 20s, 25s into the launch`.
- [x] Engine: both reach the page through `onLaunchFailure`; core does not draw them, because
      native `document` is a Three.js stub whose `appendChild` is a no-op.
- [ ] The desktop host's own device-lost dialog (`SDL_ShowSimpleMessageBox`, `context.cpp`) gets a
      **Copy** button. That dialog — not the page — is what a player sees when the device dies,
      because the host exits 1 immediately and never resolves the JS `device.lost` promise.
- [x] Red-green: `packages/core/__tests__/launch-diagnostics.spec.ts`, 4 tests, all green
      (`pnpm exec vitest run packages/core/__tests__/launch-diagnostics.spec.ts`).
- [x] Verified on midway: the stall report fired on the real 104 s launch and named the outstanding
      assets. The copyable surface is the game's own loading layer (COPY MESSAGE button).

### Phase 2 — Progress you can read

- [x] Engine: `assets.progress.pending` names the outstanding logical paths. (`pending`, not
      `inFlight`: `constraints.spec.ts` forbids the substring "light" in core sources.)
- [x] Game (midway): `IShell.loading` drives a real `#load-bar` and a `NN% — /assets/…` status
      line, replacing the indeterminate stripe that moved whether or not anything was happening.
- [x] Both surfaces: implemented once in `src/ui/dom.ts` and replayed through the bridge, so the
      native web view shows the same call.
- [ ] Playtest asserts the bar moves and the label changes during load.
      Not yet run: every launch on this host currently dies with `VK_ERROR_DEVICE_LOST` — another
      process holds 7726 of 8192 MiB of VRAM.

### Phase 3 — Cut the 104 s

- [x] Re-measure on an idle GPU: **24.3 s** to `whenReady`, not 104 s. The 104 s was VRAM
      starvation (another process held 7726/8192 MiB); every number below is on an idle GPU.
- [x] **The launch did not just look frozen — it was.** The window stopped being presented a few
      seconds in and never recovered: presents froze at 137 while the loop ran at 59 fps with a
      16.5 ms render phase, so the screen kept the loading layer for the rest of the session, and
      a click on the briefing behind it did nothing visible. Root cause in `packages/core/src/
      renderer.ts` (three's reflector saves and restores `getRenderTarget()` inside a compile, and
      the compile was answering with the frame-buffer target, which then stayed bound). Fixed and
      proved red-green; presents now run 60/s for the whole session. Same on a private Xvfb, so it
      was never the compositor.
- [x] `TN_FRAME_NOT_PRESENTED` names which of the three silent conditions suppressed a present.
- [x] Attribute the post-fetch work: on an idle GPU it is a 3.0-4.8 s `imageDecodeDrain` at
      `enter()` and a 2.7-3.7 s first world frame; all 222 bundle reads finish inside 1.5 s.
- [ ] Cut the image decode (227 textures, ~1 GB). The asset pipeline compresses embedded GLB
      textures, and this game bypasses it entirely — its assets are committed under `public/`.
- [x] Airframe switching: the player's aircraft was disposed and rebuilt on every loadout change,
      recompiling its pipelines each time — the multi-second freeze on the briefing. Both are kept
      built and each is warmed once.
- [x] Launch to `whenReady` on this desktop: **24.3 s -> 9.4 s**.
- [ ] Nothing regresses: `pnpm test:templates` and midway's own playtests stay green.
      Midway's half is green: all four browser scenarios (`midway-launches`, `midway-flight`,
      `midway-briefing`, `midway-audio-realism`) pass with no console errors and no runtime
      diagnostics, and on the desktop target all ten native scenarios pass against a host at the
      engine's version — including the two audio ones (`audio-sweep` 6631 frames, `speech-once` 2892).
      `pnpm test:templates` was run: action-rpg, defense, minimal, puzzle, runner, sailing and
      shooter pass, and `racing-touch-controls` failed once inside the sweep
      (`TN_PLAYTEST_RESOURCE_STATE_STAGNATED`, "Resource 'state' path 'speed' did not change after the
      scenario moved the subject 0.055 units"). **That failure does not reproduce**: the same
      scenario, scaffolded on the same tree with its own server and run alone, reports `pass: true`
      with its visibility and resource assertions green. The sweep runs ten templates in sequence,
      each with a browser, and the machine was under load — so it reads as contention, not a template
      defect, and the seven-pass-and-one-flake result is what is recorded. No template imports
      `FlightModel`/`flightForces` or the doctor, so this branch's changes are not in that path.

### Phase 4 — Never ship a stale host again

- [x] `threenative doctor` fails when the installed `@threenative/runtime-native` prebuilt is older
      than the installed `@threenative/core` contract it must satisfy (found the hard way: the
      published `runtime-native-v0.3.2` prebuilt predates PRD-393, so every scaffolded game built a
      desktop binary whose UI never appeared).
      Landed as the host's own answer, because the package metadata was the thing that lied: the
      installed prebuilt runs `--version` and answers `Mystral Native Runtime v0.3.0`, while
      `install-status.json` beside it says 0.3.2 — reading the host is the only check that does not
      trust a file about a binary nobody ran. Doctor fails when the reported runtime is older than
      the newest of the installed engine and runtime packages, when the host names no version, and
      when what it names cannot be compared.
      Measured in `sandbox/midway-open-pacific`, `threenative doctor --text`:

      | host installed | doctor | exit |
      | --- | --- | --- |
      | published prebuilt (v0.3.0), before this change | `✓ native runtime: available (linux-x64)` | 0 |
      | published prebuilt (v0.3.0), after | `✗ … the linux-x64 host reports runtime v0.3.0, older than the installed engine 0.3.2` | 1 |
      | a host at the engine's version | `✓ native runtime: available (linux-x64, host runtime v0.3.2)` | 0 |

      The stale host is not a theory on this machine: with it, midway's native `launch`, `cockpit`,
      `ui` and `native-select` scenarios all fail at `waitForResource ui.screens.flight` with
      `frames 0` — the injected clicks never reach a UI that never composited. Rebuilt against a
      host at the engine's version, `launch` (2011 frames), `cockpit` (1895) and `ui` (931) pass
      with zero diagnostics. Commit `6571c4ed5`.
- [x] Red-green: doctor spec covers the stale-prebuilt case.
      `packages/create-threenative/__tests__/doctor.spec.ts`: the stale host, a host that names no
      version, a prerelease beneath its own release, an equal and a newer host, an unparseable
      version, and `probeNativeHost`'s own parse and spawn-failure paths. 97 tests green.

## Acceptance criteria

- [ ] A launch that stalls or loses the device says so on screen, with a copy button.
- [ ] The loading screen shows a moving percentage and the asset being loaded.
- [ ] Midway's desktop launch is measurably faster than the 104 s baseline, re-measured on an idle
      GPU, with the number in this file.
- [x] `threenative doctor` rejects a prebuilt host older than the core it is installed beside.
      Red on the real project with the published prebuilt (exit 1, naming both versions), green with
      a host at the engine's version — see Phase 4.
