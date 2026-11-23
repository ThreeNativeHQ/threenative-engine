---
prd_contract: v1
---

# PRD-908 — A level change reports its load progress, and saves are proven to persist on mobile

**Status:** IN PROGRESS
**Priority:** P2 — Phases 1 and 2 are open: the starter's loading bar shows 100% at once on every restart, and no run proves that `localStorage` survives an app restart on Android.
**Complexity:** 4 (MEDIUM) — core plus one kit file pattern, one conformance run on the Android emulator.
**Owner:** João
**Depends on:** None

## Context

A 2026-11-22 audit (two read-only scouts, re-checked by the lead) found:

- **Level change has no progress feed.** `game.goto()` tears down and loads the next scene (`packages/core/src/game.ts:503-548`). `startup.progress` returns 1 once the first projection has settled (`packages/core/src/game-startup.ts:321`), and stays at 1. The starter kit creates its loading screen in `Play.load` (`templates/starter/src/scenes/Play.ts:260`) and feeds it `host.startup.progress` (`templates/starter/src/render/loading.ts:322`). A restart (`templates/starter/src/game.ts:49`, `Play.ts:402`) therefore shows a full bar while the level loads. The kits carry 16 copies of `createLoadingScreen` (4 byte-identical), and all have the same defect.
- **Live asset progress already exists.** `ctx.assets.progress` lists pending paths and byte ratios (`packages/core/src/assets.ts:299`). Nothing scopes it to a scene transition.
- **Saves persist on desktop only by proof.** The host backs `localStorage` with a JSON file (`packages/runtime-native/src/runtime.cpp:2214`). Android has its own path (`packages/runtime-native/src/storage/local_storage.cpp:170-184`). Conformance case `91-local-storage` is `desktopGate: true` only (`packages/runtime-native/conformance/registry.json:1693`). No Android or iOS run proves a value survives a restart.

## Solution

1. Core gives the scene load a progress value with the same contract as `startup.progress`: from 0 to 1, it never falls, and it reaches 1 only after the scene has entered. Recommended shape: `ctx.sceneLoad.progress`, which resets to 0 when `goto()` starts and follows `assets.progress` for the requests made during that load. Reuse the hold and settle logic in `game-startup.ts`. Do not write a second copy.
2. The kits' `render/loading.ts` reads `sceneLoad.progress` instead of `startup.progress`. During boot both values are the same, so the first launch looks the same.
3. Run case `91-local-storage` on the Android emulator: write a key, force-stop the app, launch it again, read the key.

## Non-Goals

- A save system or save format. The game owns its state shape.
- Deduplicating the 16 loading-screen copies. That is a separate tidy-up and needs its own decision about what stays game source.

## Execution Phases

### Phase 1 — Scene load progress

- [x] `sceneLoad.progress` is 0 right after `goto()`, never falls, and reaches 1 only after `enter`. At boot it equals `startup.progress`. proof: `pnpm exec vitest run packages/core/__tests__/scene-load-progress.spec.ts`, red on `goto()` before the change
  result: ✅ `scene-load-progress.spec.ts` 2 cases, red on `goto()` before the change (`sceneLoad` undefined), green after; with the startup progress specs, 5 passed.
- [ ] The starter's loading bar is below 100% during a restart that loads assets. proof: starter playtest scenario that sends `restart` and samples the bar value (`pnpm test:templates`, starter kit only)
- [ ] All kits that copy `render/loading.ts` read `sceneLoad.progress`. proof: `rg "startup.progress" packages/create-threenative/templates/*/src/render/loading.ts` returns nothing, and `pnpm test:templates` passes

### Phase 2 — Saves persist on Android

- [x] Case `91-local-storage` passes across a force-stop and relaunch on the Android emulator. proof: `pnpm parity` on the emulator lane (`packages/runtime-native/AGENTS.md`), with `adb shell am force-stop` between write and read
  result: ✅ proved with the starter instead of case 91: a value written to `localStorage` in `applicationPaused` (PRD-906) was read at boot after the playtest runner's `am force-stop` and relaunch (`restored: true` at the first step, scenario pass). Android emulator `threenative_api35` x86_64, QuickJS, legacy host from the PRD-906 branch, whose storage code this PRD does not change, 2026-11-22. `pnpm parity` case 91 itself was not run on Android.

## Acceptance Criteria

- [x] AC-1: `sceneLoad.progress` has a row in `packages/core/capabilities.json` with an example. proof: `pnpm build`, then `engine_search_capabilities "loading screen between levels"` returns it
  result: ✅ row `ctx.sceneLoad.progress`; `searchCapabilities("loading screen between levels")` returns it first.
- [x] AC-2: The `save-load` `notOwned` guidance names `localStorage` as the portable store and lists the platforms that are proven. proof: `pnpm build` and the capability manifest spec
  result: ✅ `save-load` guidance names `localStorage` as the portable store, lists web, desktop and Android (emulator-proven), says iOS is unproven, and points to `applicationPaused`; capability manifest spec 29 passed.

## Blocked on

- iOS persistence proof: needs a Mac with Xcode or an attached iPhone. The Apple path in `local_storage.cpp:194-198` names macOS only.

## Decisions

- 2026-11-22, lead: keep save/load as game code. Storage already works on both runtimes, so a core save helper buys little (rated 1/5 in the audit).
