---
prd_contract: v1
---

# PRD-906 — Games hear app pause, resume and quit, and can vibrate, on every runtime

**Status:** NOT STARTED
**Priority:** P1 — Phase 1 and Phase 2 are open: a mobile game cannot save when the OS sends it to the background, cannot offer Quit, and has no rumble or vibration on any platform.
**Complexity:** 6 (MEDIUM) — 5-8 files, crosses core and the C++ host, plus one Android emulator proof.
**Owner:** João
**Depends on:** None

## Context

A 2026-11-22 audit (two read-only scouts, re-checked by the lead) found three platform seams that a game cannot write portably. The charter rule says the framework owns them.

- **Lifecycle is invisible to the game.** The host pauses the loop on background (`packages/runtime-native/src/platform/lifecycle.cpp:233`), resumes audio (`:246`) and prints `TN_LIFECYCLE` (`:128`). It never tells JS. `rg "visibilitychange|visibilityState|document.hidden"` over `packages/core/src` and `packages/runtime-native/src` returns nothing. On web, core also ignores `visibilitychange`.
- **Quit has no JS binding.** `IWindow::quit()` exists (`packages/runtime-native/src/runtime.cpp:1647`). No script can reach it.
- **Haptics do not exist.** `rg -i "vibrat|rumble|haptic"` over core and the host returns only a comment (`packages/core/src/spells/ultra/engine/camera.ts:7`). The host builds SDL 3.2 (`native-deps.lock.json:426`), which has `SDL_RumbleGamepad` and Android device haptics. The host already shims `navigator.getGamepads` (`runtime.cpp:3868`).
- **Text input on mobile is probably fine.** Android and iOS draw the UI in a real WebView (`android/.../TnUiOverlay.java`, `ios/ui_overlay_ios.mm`), so an `<input>` should raise the soft keyboard. No run proves it. Phase 3 proves it and builds only if the proof fails.

## Solution

Use the web API as the contract, and shim it on the host. This is the pattern the host already uses for `localStorage` and `navigator.getGamepads`. Core adds thin Godot-named calls, so a game in a worker or on a platform without the API gets an honest report.

1. **Host:** set `document.visibilityState` and `document.hidden`, then dispatch `visibilitychange` on `document` (dispatch exists at `runtime.cpp:3336`) at the same point that prints `TN_LIFECYCLE`.
2. **Core:** a scene may define `applicationPaused(ctx)` and `applicationResumed(ctx)`, named after Godot's `NOTIFICATION_APPLICATION_PAUSED/RESUMED`. Core calls them from `visibilitychange` on both runtimes and forwards them to a worker game. `ctx.quit()` (Godot `get_tree().quit()`) calls the host quit. On web it prints `TN_QUIT_UNSUPPORTED` once and does nothing.
3. **Haptics:** `ctx.input.vibrateHandheld(durationMs)` and `ctx.input.startJoyVibration(weak, strong, durationMs)` (Godot `Input` names). Web uses `navigator.vibrate` and `Gamepad.vibrationActuator`. The host shims both with SDL haptics and `SDL_RumbleGamepad`. If the platform has no motor, the call prints `TN_HAPTICS_UNSUPPORTED` once.

## Non-Goals

- Runtime fullscreen toggle and clipboard. They are platform seams too. File them separately when a game asks.
- A save system. `localStorage` already persists on both runtimes. See PRD-908 for the proof.

## Execution Phases

### Phase 1 — Lifecycle and quit

- [ ] Host dispatches `visibilitychange` with the correct `document.visibilityState` on pause and resume. proof: `pnpm parity` case added to `packages/runtime-native/conformance/registry.json`, run with `pnpm native:verify:desktop`
- [ ] Core calls `applicationPaused`/`applicationResumed` on web and native, and forwards them into a worker game. proof: `pnpm exec vitest run packages/core/__tests__/app-lifecycle.spec.ts`
- [ ] `ctx.quit()` exits the native host with status 0, and on web prints `TN_QUIT_UNSUPPORTED` once. proof: same spec plus a `--target desktop` playtest scenario
- [ ] An Android emulator run backgrounds and resumes the starter kit, and the scene hooks fire once each. proof: `node packages/playtest/dist/runner/cli.js <scenario> --target android` with `adb shell input keyevent KEYCODE_HOME`

### Phase 2 — Haptics

- [ ] `vibrateHandheld` and `startJoyVibration` call the web APIs and report `TN_HAPTICS_UNSUPPORTED` when absent. proof: `pnpm exec vitest run packages/core/__tests__/input-haptics.spec.ts`
- [ ] Host shims `navigator.vibrate` and `vibrationActuator.playEffect` through SDL haptics. proof: conformance case that asserts the SDL call returns success, or the unsupported marker on a host with no motor, under `pnpm native:verify:desktop`
- [ ] Android emulator run reports a vibrator call. proof: `adb shell dumpsys vibrator_manager` shows the request during the scenario

### Phase 3 — Mobile text input proof

- [ ] A tap on an `<input>` in the UI layer opens the soft keyboard on the Android emulator. proof: playtest scenario on `--target android`, then `adb shell dumpsys input_method | grep mInputShown=true`
  If it fails, fix the overlay focus in `TnUiOverlay.java` in this PRD and rerun.

## Acceptance Criteria

- [ ] AC-1: The starter kit on Android saves state in `applicationPaused` and finds it after the app is restored. proof: Phase 1 emulator scenario
- [ ] AC-2: Both new calls and both scene hooks are rows in `packages/core/capabilities.json`. proof: `pnpm build` then `engine_search_capabilities "app goes to background"` returns the row

## Blocked on

- iOS lifecycle, haptics (Core Haptics) and keyboard proof: needs a Mac with Xcode or an attached iPhone.

## Decisions

- 2026-11-22, lead: web APIs are the contract, shimmed on the host, with Godot-named core wrappers. Reason: games and agents already know the web APIs, and the host already shims storage and gamepads this way.
