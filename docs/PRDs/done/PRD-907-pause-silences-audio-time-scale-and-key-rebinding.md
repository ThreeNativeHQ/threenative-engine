---
prd_contract: v1
---

# PRD-907 — Pause silences audio, games get a time scale, and players can rebind keys

**Status:** DONE (2026-11-23)
**Priority:** P2 — Phases 1 to 3 are open: the kart and racing kits keep playing sound while paused, slow motion has no supported path, and no options menu can remap a key.
**Complexity:** 3 (LOW) — 3-4 files in `packages/core/src`, no new package, no platform seam.
**Owner:** João
**Depends on:** None

## Context

A 2026-11-22 audit (two read-only scouts, re-checked by the lead) found three gaps in core basics that a Godot or Unity user expects.

- **Pause leaves audio on.** `game.pause()` only sets a flag (`packages/core/src/game.ts:711`). The frame loop then skips the update (`packages/core/src/game-frame-loop.ts:800`). The audio bus has its own `pause()` and `resume()` (`packages/core/src/audio.ts:396`, `:412`), and nothing calls them. The kart, racing and puzzle kits call `game.pause()` from a UI intent (`templates/kart/src/game.ts:38`), so a paused race keeps its engine drone.
- **There is no time scale.** The fixed-step loop adds wall time to its accumulator (`packages/core/src/loop.ts:431`). There is no multiplier. `rg timeScale packages/core/src` finds only animation and spell code. A game that wants slow motion or hit-stop has to write its own accumulator, which AGENTS.md tells it not to do.
- **Bindings are fixed at construction.** `InputMap.#bindings` is private (`packages/core/src/input.ts:237`). The only way to set them is the constructor (`:296`). An options menu cannot remap a key while the engine keeps reading the original map.

## Solution

1. `game.pause()` also calls `audio.pause()`, and `resume()` calls `audio.resume()`. A game that wants music during pause opts out with `game.pause({ audio: false })`. Core prints that override once (`TN_PAUSE_AUDIO_KEPT`).
2. Add `ctx.timeScale` (Godot `Engine.time_scale`), default 1, a finite number from 0 upward. The loop multiplies `elapsed` by it before the accumulator, so the step size and determinism stay the same and only the tick count changes. Wall-clock things (UI, audio) stay at 1. A value that is not finite throws `TN_TIME_SCALE_INVALID`.
3. Add `InputMap.setBinding(action, binding)` and `InputMap.bindings()`, the minimum Godot `InputMap.action_erase_events` / `action_add_event` pair. The setter validates with the constructor's checks. The getter returns a JSON-safe copy, so a game can store it in `localStorage` itself.

## Non-Goals

- A save format for bindings or settings. The game owns its save shape (`capabilities.json` `notOwned` `save-load`).
- A rebinding UI. The UI is game source.

## Execution Phases

### Phase 1 — Pause silences audio

- [x] `game.pause()` pauses the audio bus and `resume()` resumes it. `pause({ audio: false })` keeps it on and prints `TN_PAUSE_AUDIO_KEPT`. proof: `pnpm exec vitest run packages/core/__tests__/game-pause.spec.ts`, red before the change
  result: ✅ `game-pause.spec.ts` 4 cases (3 red before the change; the fourth, a bus the game paused itself stays paused across a double pause, red against the first draft). Neighbour audio and game specs 103 passed.
- [x] The racing kit is silent while paused. proof: racing playtest scenario that sends the `pause` intent and asserts `audio.paused === true` in the runtime snapshot (`pnpm test:templates`, racing kit only)
  result: ✅ `racing/playtests/pause-silences-audio.playtest.json` passes in `TN_TEMPLATE_ONLY=racing,kart,puzzle TN_KIT_CONTRACT=0 pnpm test:templates` (WebGPU, NVIDIA Turing). It clicks the HUD pause control and reads the new `audio` playtest resource: `silent` false while racing, true after the pause and 60 ticks later, and `state.paused` true. `silent` is the bus-level flag (every live bus paused, false with no bus); the snapshot's `paused` field counts held voices, so it was not the right observable. The racing kit handled a `pause` intent but no UI sent one: the HUD now carries a pause/resume button (`data-tn-interactive`).

### Phase 2 — Time scale

- [x] `ctx.timeScale = 0.5` gives half the ticks per wall second with the same `step`. `0` freezes the simulation. A non-finite value throws `TN_TIME_SCALE_INVALID`. proof: `pnpm exec vitest run packages/core/__tests__/loop-time-scale.spec.ts`
  result: ✅ `loop-time-scale.spec.ts` 7 cases, red before: 230 vs 115 ticks over the same 3.84 s at step 1/60, 0 freezes with rendering running, NaN/Infinity/-1 throw. All 13 `FixedStepLoop` specs, 165 passed.
- [x] A playtest scenario with `timeScale = 0.5` advances a timer half as far in the same wall time. proof: scenario under `packages/playtest`, run with `--browser-recipe webgpu`
  result: ✅ `examples/abyss-framework/playtests/time-scale-half.playtest.json` passes with `--browser-recipe webgpu --headed` (adapter nvidia/turing): fixed updates per wall second at scale 0.5 over the scale-1 rate = 0.505 (bound 0.4 to 0.6).

### Phase 3 — Key rebinding

- [x] `setBinding` changes what `pressed(action)` reads on the next tick, and rejects a malformed binding with the constructor's error. proof: `pnpm exec vitest run packages/core/__tests__/input-rebind.spec.ts`
  result: ✅ `input-rebind.spec.ts` 7 cases, red before; `input.spec.ts` with it, 68 passed. One shared validator now runs in the constructor too, so a malformed constructor binding fails closed with `TN_BINDING_INVALID` instead of never firing.
- [x] `bindings()` round-trips through `JSON.stringify` and `setBinding`. proof: same spec
  result: ✅ same spec: JSON round trip through `setBinding` reproduces `bindings()`, and the returned copy is not live.

## Acceptance Criteria

- [x] AC-1: `pause`, `timeScale` and `setBinding` each have a row in `packages/core/capabilities.json` with an example. proof: `pnpm build`, then `engine_search_capabilities "slow motion"` and `"rebind keys"` return the rows
  result: ✅ rows `game.pause`, `ctx.timeScale`, `InputMap.setBinding`; `searchCapabilities` returns `ctx.timeScale` for "slow motion", `InputMap.setBinding` for "rebind keys", `game.pause` first for "pause the game and mute the sound".
- [x] AC-2: No kit regresses. proof: `pnpm test:templates` for kart, racing and puzzle
  result: ✅ `TN_TEMPLATE_ONLY=racing,kart,puzzle TN_KIT_CONTRACT=0 pnpm test:templates`: 47 scenarios, 0 failed, exit 0, 2026-11-23.

## Blocked on

Nothing.

## Decisions

- 2026-11-22, lead: pause silences audio by default with a named override. Reason: the repo rule is conventions on by default, with an override on the same object that is reported.
