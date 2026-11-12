# PRD-880 — Every controller reads as the standard gamepad: Xbox, 8BitDo, Steam Deck

**Status:** BLOCKED ON PHYSICAL DEVICE — every phase box and AC-1 are ticked and proven; what remains is the owner's read of one official Xbox pad, the 8BitDo Ultimate C 2.4G and a Steam Deck, which confirms the web table rows and the native reads.
**Priority:** P2 — no box is done: an idle stick still drifts a character, a phantom pad still steals input, and a non-standard browser pad still fires the wrong action (AC-1 to AC-8).
**Complexity:** 4 (MEDIUM)
**Owner:** João (owner); an agent executes
**Depends on:** None

Complexity: 2 (about 7 implementation files) + 2 (crosses the web and native build boundaries) = 4 → MEDIUM; risk override: none.

## Context

The owner asked (2026-11-11) for abstractions so ThreeNative works with Xbox controllers (official and generic XInput clones), the 8BitDo Ultimate C 2.4G wireless pad, the Steam Deck and similar pads, DRY, "maybe adapter pattern".

The contract already exists: a game reads every pad through `navigator.getGamepads()` in the W3C "standard" mapping, and `InputMap` binds standard indices (`buttons: [0]` is the south face button on every pad). Kits rely on it: `templates/kart/src/game.ts:13`, `platformer/src/game.ts:19`, `collectathon/src/game.ts:18`. The gaps are where a pad does not arrive in that mapping, or arrives with defects the engine leaves to the game.

Current behaviour, inspected 2026-11-11:

- **No dead zone anywhere.** `packages/runtime-native/src/engine/player/gamepads.h:10` says "No dead zone: core owns that", but `packages/core/src/input.ts` applies none. `vector("move")` adds raw axes 0 and 1 (`input.ts:314`), so a worn or cheap stick resting at 0.08 walks the character.
- **First pad wins.** `InputMap.tick` (`input.ts:430`) reads the first non-null slot. A Steam Deck under Steam can expose its built-in pad and a Steam Input virtual pad. A 2.4G dongle with no pad paired, or a wheel at slot 0, takes the slot from the pad the player holds.
- **`mapping` is ignored.** `IInputGamepad` (`input.ts:81`) has no `mapping` or `id`. A browser returns `mapping: ""` for a pad its own table does not know, for example some pads in Firefox on Linux. Raw button 0 then fires `jump` on whatever button the device numbered 0, with no warning.
- **Two native copies of one table.** The SDL3 → standard table exists twice: `packages/runtime-native/src/engine/player/gamepads.cpp:140` (owned V8 player, 4 axes, 16 buttons) and `packages/runtime-native/src/platform/input.cpp:786` (legacy mystral host, which Android still runs: 6 axes with the triggers at 4 and 5, 17 buttons with guide at 16). A binding such as `gamepadAxes: [4]` reads a trigger on Android and nothing on desktop or web.
- **Native already has the device database.** Both native paths open pads through SDL3 `SDL_OpenGamepad`, which applies SDL's controller database (Xbox, XInput clones, 8BitDo, Steam Deck, DualShock, DualSense). The native gap is the duplicate table, not missing devices.
- **Search does not find it.** The `InputMap` row in `packages/core/capabilities.json` has no gamepad, controller, Xbox or Steam Deck words. An agent asked to "add Xbox controller support" finds nothing and writes its own `getGamepads` loop.
- The playtest runner has no way to inject a pad (`packages/playtest/src/runner/steps.ts` drives keys and pointers only), so no scenario proves a controller moves a kit.

## Solution

**Decision: no class-per-device adapter hierarchy.** The W3C standard mapping is the one interface. Each backend has one normalizer that turns its raw pad into that mapping, and each normalizer is data, not a class:

| Backend | Normalizer | Covers |
| --- | --- | --- |
| Native (desktop, Android, iOS) | SDL3's controller database, then one shared `fillStandardPad` table | Every pad SDL knows: Xbox, clones, 8BitDo, Steam Deck |
| Web, `mapping === "standard"` | Pass through | Xbox and most pads in Chromium |
| Web, `mapping === ""` | A small vendor:product → standard-index table in core, one row per measured device | 8BitDo or Steam Deck where the browser has no mapping |
| PS4 (OpenOrbis) | The existing bit table, unchanged | DualShock 4 |

Above the normalizers, `InputMap` owns the two pad conventions every game repeats: a radial dead zone and choosing the active pad. A game keeps binding standard indices and changes nothing.

```mermaid
flowchart LR
  subgraph Native
    SDL[SDL3 controller DB] --> FSP[fillStandardPad<br/>one C++ table]
    PS4[OpenOrbis bits] --> STD
    FSP --> STD
  end
  subgraph Web
    BR[navigator.getGamepads] --> M{mapping}
    M -- standard --> STD
    M -- empty, known id --> TBL[vendor:product table] --> STD
    M -- empty, unknown --> WARN[TN_GAMEPAD unmapped<br/>pad ignored]
  end
  STD[W3C standard pad] --> DZ[radial dead zone<br/>gamepadDeadZone]
  DZ --> ACT[active pad: last claimed<br/>button or half tilt]
  ACT --> IM[InputMap: pressed / vector / axis]
```

Conventions (on by default, each with a named override on the same object, reported):

- **Dead zone:** radial, rescaled so output still reaches 1. Default 0.2, the stock Enhanced Input dead zone: `UInputModifierDeadZone` defaults to `LowerThreshold = 0.2`, `UpperThreshold = 1` and `EDeadZoneType::Radial` (`UE release: Engine/Plugins/EnhancedInput/Source/EnhancedInput/Public/InputModifiers.h:182,190,193`, read 2026-11-11 through `gh api`). Override: `defineGame({ gamepadDeadZone: 0 })`, or `input.gamepadDeadZone = 0` on a running map, for raw axes.
- **Active pad:** a pad claims the input when a button goes down or a stick travels past half tilt, and keeps it while idle so its releases read. A stick resting past the dead zone, or one jittering across it, claims nothing — that is the difference between "the player moved" and "the hardware is old" — so no pad can steal the input at boot or in the middle of a move. At `gamepadDeadZone: 0` a noisy stick does claim, which is what raw axes mean.
- **Report:** one `TN_GAMEPAD` line per connect, naming `id`, normalizer (`standard`, `table`, `unmapped`) and dead zone. An unmapped pad is ignored, never read with raw indices.

Out of scope, each a later PRD when a kit asks: back paddles (Steam Deck L4/R4/L5/R5, 8BitDo back buttons), gyro, touchpads, rumble, analog triggers through `axis()`, and named button constants.

Risks:

- The web table rows for the 8BitDo and the Steam Deck come from SDL_GameControllerDB Linux entries (evdev order, which Firefox on Linux also uses). That is an assumption until a physical device confirms it (see Blocked on).
- Unifying the native table changes the legacy host from 6 axes and 17 buttons to 4 and 16. Grep every kit and example for `gamepadAxes: [4` or `[5` and `buttons: [16` before the change lands.

## Acceptance criteria

The phase boxes below carry the unit and native proofs. This box is the consumer proof: a real kit, driven through `navigator.getGamepads`, using the Phase 3 `gamepad` playtest step.

- [x] AC-1 [local]: In the platformer kit, a scripted standard pad with the left stick at 1 moves the player right, button 0 jumps it, and a stick at 0.1 leaves it still. proof: `node packages/playtest/dist/runner/cli.js <platformer gamepad scenario> --browser-recipe webgpu` — Evidence: the kit scaffolded from local tarballs (`createProject` + `packageLocalFramework`), built with `pnpm build:web`, then both scenarios through the repository runner against `vite preview`, headed, `--browser-recipe webgpu`. `playtests/gamepad.playtest.json` → `pass: true`: `movementDelta` x = 28.87 against `minAxisDelta: 3`, and `state.jumps` 0 → 1. `playtests/gamepad-idle.playtest.json` → `pass: true`: `movement.maxDistance` observed 0 against `maximum: 0.5`, so a stick resting at 0.1 moves nothing. Each run prints `TN_GAMEPAD {"deadZone":0.2,"id":"TN Playtest Pad (STANDARD GAMEPAD Vendor: 045e Product: 028e)","mapping":"standard"}`.

## Blocked on

- ~~8BitDo Ultimate C 2.4G: measured.~~ **Done 2026-11-11 on the owner's device.** The kernel reports `2dc8:3016`, which SDL 3.2.30 does not carry under any name, and Chromium reports `mapping: ""` and 15 buttons / 8 axes for it — so the shipped `301b`/`3013` rows did not cover it and the pad was ignored on the web. A measured row was added and the owner's browser now logs `TN_GAMEPAD {"deadZone":0.2,"id":"8BitDo Ultimate C 2.4G Wireless Controller  (Vendor: 2dc8 Product: 3016)","mapping":"table"}`. Measured in Chromium by press: A `b0`, B `b1`, X `b3`, Y `b4`, LB `b6`, RB `b7`, Select `b10`, Start `b11`, left stick `a0`/`a1`, right stick `a2`/`a3`. The trigger sides are derived from the kernel rather than read per-frame in the page: pressing LT swept `ABS_BRAKE` (10) 0..255 and RT swept `ABS_GAS` (9) 0..255, and axes arrive in ascending ABS order — the rule the two sticks confirm — so left is `a5` and right `a4`, which also matches SDL's 8BitDo rows. Two measured limits, both recorded in the row's comment: the stick clicks are declared by the kernel (`BTN_THUMBL`/`BTN_THUMBR`) but a press on either stick reaches it as `BTN_TL2`, the left trigger's digital button (two presses 1.26 s apart, matching the two sticks, both `KEY 312`), so on Linux no browser reports them as separate buttons and `b13`/`b14` are inert on this unit; and the extra C/Z buttons (`b2`/`b5`) have no standard slot. `input.spec.ts` "maps every control the 8BitDo Ultimate C 2.4G actually sends" pins every other slot, including the right stick as `a2`/`a3` in both directions.
- Owner read still open: an official Xbox pad and a Steam Deck, in Chromium, Firefox and the native desktop player — confirm the left stick moves and the south button jumps, and record each `TN_GAMEPAD` line. Any pad the browser reports unmapped and no row knows is named in `TN_GAMEPAD … unmapped` rather than guessed at, which is how the 8BitDo above was found.

## Known follow-ups, not this PRD

- The default web engine runs the game in a worker (`templates/*/src/worker.ts`), and that worker starts forwarding pads only on a `gamepadconnected` event. The browser fires one for a real pad, so a game is unaffected; the playtest `gamepad` step now announces its scripted pad the same way, which is why AC-1 passes. A game that polls `navigator.getGamepads` from the page and never listens for the event sees its pad from the first frame.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Web pad normalization, dead zone, active pad | Kit `game.ts` → `InputMap.tick` (`packages/core/src/input.ts:430`) → `navigator.getGamepads` | First-non-null pick and raw axes are deleted | Phase 1 boxes, Phase 3 playtest |
| Native standard pad | Game JS → `navigator.getGamepads` (`v8_main.cpp:177`; `runtime.cpp:3868`) → `fillStandardPad` | Both duplicate tables delegate to one function | Phase 2 box |
| Capability search | Agent → `engine_search_capabilities` → `InputMap` row | New `@situation`, `@alias`, `@constraint` and `@override` tags on the existing row | Phase 3 box |

## Review

- 2026-11-11: an independent reviewer subagent (fresh context, read-only, **Opus 5.5 at high thinking**) gated PR #664 over six rounds. The `opencode/claude-opus-5-5` route is disabled on this key (`permission_error: Model access is disabled`), so the review ran through the Claude CLI at `claude-cli/opus`, whose alias resolves to `claude-opus-5-5` — checked on this machine, not assumed: `claude -p … --model opus --output-format json` reports `modelUsage: {"claude-opus-5-5": …}`. Rounds 1 to 5 each found a real defect and blocked; every one is fixed and locked by a spec: the highest-slot-with-input steal, a per-tick `RegExp` allocation, a level-based hand-over that kept a stolen slot, a pad-wide edge that made jitter steal and blocked a button reclaim, and two unproven fixes (the `config.ts` temp-name collision, and the shrinking-source claim). Round 6 returned `VERDICT: AUTHORIZE`, unverified items named: CI's board, the full `pnpm native:build`, the Android/iOS/PS4 compiles, and the owner's device read below. `pnpm native:build` was attempted and cannot run on this machine at all: the dependency downloader fetches `stb` from `master` and it no longer matches its pinned hash (`TN_NATIVE_DEP_CHECKSUM_MISMATCH: payload 'stb-stb_image.h' … expected 594c2fe3…, got 0e266e9f…`), before any compilation. The Android configure in `build/tn-android` points at NDK `27.1.12297006`, which is not installed (28.2 is), so that lane cannot configure either. What did compile here: `tn_engine_only` (`platform/input.cpp`, `gamepads.cpp`, the new test) and the legacy host's `mystral-runtime` in `build/tn-linux-dual`. Its two documentation nits are folded into `2a6d52a`.

## Decisions

- 2026-11-11 (Claude, on the owner's "your call"): the adapter is data per backend (SDL's controller database natively, a vendor:product table on the web), not a class per device. SDL already maintains about 2 000 device mappings, and a class hierarchy would duplicate them in TypeScript. The existing `InputPlatformSource` seam stays the single injection point.
- 2026-11-11 (Claude): an unmapped non-standard pad is ignored and reported. Reading it with raw indices fires the wrong action, which is worse than no input.
- 2026-11-11 (agent, executing): `fillStandardPad` lives in `src/platform/input.cpp` and is declared in `mystral/platform/input.h`, not in `gamepads.cpp`. `src/platform/input.cpp` is the only file both hosts already compile (`mystral-runtime`, which the legacy `runtime.cpp` bindings poll, and `tn_engine_player`, which the V8 player links), so one definition resolves for both with no new engine source in the legacy host and no new include path. `src/engine/player/gamepads.cpp` moved from the V8 adapter executable into `tn_engine_player` for the same reason: the C++ test links both entry points into one binary.
- 2026-11-11 (agent, executing): the dead zone applies to both stick pairs, axes 0/1 and 2/3, and never past index 3. The standard's triggers are buttons 6 and 7, so a legacy `gamepadAxes: [4]` reading no longer sees a trigger — the standard mapping replaced it (see the risk above; no kit or example binds `[4]` or `[5]`).
- 2026-11-11 (agent, executing): a pad with no `mapping` field counts as standard. A browser always reports `"standard"` or `""`, the owned V8 player sets `mapping: "standard"`, the legacy host's `runtime.cpp` sets no `mapping` at all (so it lands here), and a fixture that omits it is standard by construction. Only the empty string — the browser's own word for "I do not know this device" — is looked up in the table.
- 2026-11-11 (agent, executing): the `gamepad` playtest step writes the pad to `sessionStorage` as well as to a global, because a startup retry reloads the page and a held pad would otherwise vanish mid-step.
- 2026-11-11 (agent, after four review rounds): a pad owns the input after it *claims* it — a button press, or a stick travelling past half tilt — and keeps it while idle so its releases are read; a stick resting past the dead zone or jittering across it claims nothing. Each round found a hole in the previous rule: the first picked the highest slot reporting input every tick (a steal mid-move); the second held a *level*, so a pad that claimed while the player was idle kept the slot for the session; the third switched to a pad-wide *edge*, which jitter crossing the dead zone produced every few ticks, and the player's button could not reclaim the slot because their pad already had input. The claim rule is per control, tracked as a preallocated per-slot button mask and stick travel; a slot that merely held the input without claiming is unowned, so a gentle tilt still beats an idle dongle in slot 0. `input.spec.ts` locks every round: a held pad defended against a drifter, the slot taken back after a boot-time claim, jitter never stealing while a button press reclaims, a slow walk on a later pad, and a pad that connects into a slot the browser emptied claiming on the press it already holds (empty slots forget their history).
- 2026-11-11 (agent, measured on the owner's 8BitDo Ultimate C 2.4G): a row is only ever added from a real device, and the browser's own `mapping` decides whether one is needed at all. This device needed one — Chromium does not know `2dc8:3016` — and the row was built from the kernel's evdev order cross-checked against presses on the pad, not from a sibling's database entry. The same read showed a device may declare a control the browser can never see (stick clicks here), so the row maps them and the comment says they are inert rather than pretending otherwise.
- 2026-11-11 (agent, after review): the vendor:product lookup is cached per browser `id`, and the `TN_GAMEPAD` key is cached per slot:id. `RegExp.exec` and a template literal both allocate, and each ran twice a tick for the active pad, which Phase 1 promised not to do.
- 2026-11-11 (agent, after review): `gamepadDeadZone: 0` publishes the stick untouched rather than rescaling a diagonal to the unit circle, and a dead zone outside `0..1` (or NaN) throws at construction instead of silently reading the default. `input.spec.ts` covers both.
- 2026-11-11 (agent, after review): the d-pad stays unmapped for a `mapping: ""` pad. Every SDL row expresses it as a hat (`h0.1`), which a browser delivers as two extra axes in a device-specific order; no kit binds buttons 12 to 15, so a row that guessed would add a wrong-axis bug with no consumer.

## Execution Phases

#### Phase 1: Core reads any standard pad cleanly

**Status:** DONE
**Files:** `packages/core/src/input.ts` (dead zone, active pad, `mapping`/`id` on `IInputGamepad`), `packages/core/src/gamepad-mappings.ts` (new: the web vendor:product table and `toStandardPad`), `packages/core/__tests__/input.spec.ts`.
**Implementation:** parse vendor and product from the browser `id` (Chromium `Vendor: 045e Product: 028e`, Firefox `045e-028e-…`). Normalize into the reused buffers, with no per-tick allocation (PRD-189). Apply the radial dead zone before `vector`, `axis` and `raw.gamepad.axes`.
**Verification:** `pnpm exec vitest run packages/core/__tests__/input.spec.ts`, red first on each new test.

- [x] A stick resting at 0.1 gives `vector("move")` zero, a stick at 0.6 gives 0.5 ((0.6 - 0.2) / 0.8), and `gamepadDeadZone = 0` returns the raw 0.1. proof: `input.spec.ts` dead-zone test — Evidence: `pnpm exec vitest run packages/core/__tests__/input.spec.ts` → 52 passed. "dead-zones an idle stick, rescales what is past it, and publishes raw axes at 0": 0.1 → `vector("move").length()` 0, 0.6 → `x` 0.5, `gamepadDeadZone = 0` → `x` 0.1.
- [x] An idle pad in slot 0 does not take input from a pad in slot 1 whose button is pressed, and the slot 1 pad stays active after release. proof: `input.spec.ts` active-pad test — Evidence: same run, "keeps the pad the player last used, not the first slot the browser lists": slot 1's press reads `jump` true while slot 0 stays idle, and its release reads false. The "stays active" half is internal state only — after release both pads normalize to the same all-zero standard pad, so no public reading distinguishes them; what the rule buys is that the release is read at all, which the test asserts.
- [x] Fixtures for an Xbox pad (`standard`), an 8BitDo Ultimate C 2.4G and a Steam Deck (both `mapping: ""`, rows from SDL_GameControllerDB) all fire `jump` on the south button, and an unknown `mapping: ""` pad fires nothing and logs `TN_GAMEPAD … unmapped` once. proof: `input.spec.ts` mapping tests — Evidence: same run, "reads a standard, an 8BitDo and a Steam Deck through one mapping" reports `["standard","table","table"]` from the `TN_GAMEPAD` lines, and the 8BitDo row also raises `crouch` from the trigger axis the row puts on raw axis 5; "ignores an unmapped pad and reports it once" holds after two ticks. The 8BitDo fixture is SDL 3.2.30's `8BitDo Ultimate 2C Wireless` (`2dc8:301b`) and `Ultimate Wireless Controller` (`2dc8:3013`) rows: the owner's Ultimate C 2.4G is not in that database under that name, so its own vendor:product is still the device read in Blocked on.

#### Phase 2: One native table for every host

**Status:** DONE
**Files:** `packages/runtime-native/src/platform/input.cpp` (defines and exports `fillStandardPad`), `packages/runtime-native/include/mystral/platform/input.h` (declares it), `packages/runtime-native/src/engine/player/gamepads.cpp` (SDL branch calls it), `packages/runtime-native/tests/native-engine/player/gamepad_standard_test.cpp` (new), `cmake/NativeEngine.cmake` (the test target; `gamepads.cpp` joins `tn_engine_player`), `cmake/NativeEngineAdapters.cmake` (the adapter stops compiling its own copy). File placement differs from the plan above; see Decisions.
**Implementation:** move the SDL branch's per-pad body into `fillStandardPad(SDL_Gamepad*, GamepadState&)`. Point the legacy host at it, so both report 4 axes and 16 buttons with the triggers as buttons 6 and 7. Leave the PS4 branch as it is.
**Verification:** a C++ test attaches an SDL3 virtual gamepad (`SDL_AttachVirtualJoystick`), sets the stick, the trigger and the south button, and compares both entry points field by field. `pnpm native:build` compiles. The box below proves the test; the full native build was **not** run here — the engine-only target compiles `src/platform/input.cpp` and `src/engine/player/gamepads.cpp`, and the legacy host's own `src/runtime.cpp` was compiled on its own (`cmake --build build/tn-linux-dual --target mystral-runtime`), so Android, iOS and PS4 compiles stay unverified until the board runs them.

- [x] `tnPollGamepads` and `platform::getGamepadState` return identical state for one virtual pad: the left stick on axes 0 and 1, the right trigger on button 7, the south button on button 0. proof: the new `tests/gamepad_standard_test.cpp` through `ctest -R gamepad_standard` — Evidence: `cmake --build build/tn-engine-only --target tn-native-engine-gamepad-standard-test` then `ctest -R gamepad_standard` → 1/1 passed (0.09 s) in `packages/runtime-native/build/tn-engine-only`. The test attaches an SDL virtual gamepad with `SDL_AttachVirtualJoystick`, adds a mapping, sets left x full, the right trigger past halfway and the south button, and requires both entry points to report 4 axes, 16 buttons and identical fields. Red check: setting `state.numAxes = 6` in the one shared table fails the same test with "the legacy host reports 4 stick axes" and "the engine player reports 4 stick axes".

#### Phase 3: Agents find it, kits prove it

**Status:** DONE
**Files:** `packages/core/src/index.ts` (TSDoc tags on `InputMap`), `packages/create-threenative/conventions.json` (row `gamepad`) and `agent-docs/references/conventions.md` (its anchor), `packages/engine-mcp/__tests__/search.spec.ts`, `packages/playtest/src/runner/steps.ts` and `runner/browserSession.ts` and `runner/deviceRunner.ts` and `scenario/schema-*.ts` (the `gamepad` step), `packages/playtest/__tests__/gamepad-step.spec.ts` (new), two platformer scenarios.
**Implementation:** add `@alias gamepad`, `controller`, `joypad`, `xbox`, `8bitdo`, `steam deck`. Add `@situation` lines for "support an Xbox or generic controller", "the character drifts while the stick is idle", "the controller does nothing in Firefox" and "a second pad steals input". Add `@constraint` lines for standard indices, the dead zone and the active pad, and `@override gamepadDeadZone`. The convention row names the default, the override and the `TN_GAMEPAD` marker, so `pnpm build` renders it into every kit `AGENTS.md`.

- [x] `engine_search_capabilities` returns `InputMap` as the first row for "xbox controller", "steam deck" and "stick drift". proof: `pnpm exec vitest run packages/engine-mcp/__tests__/search.spec.ts` after `pnpm build` — Evidence: `pnpm build` regenerated `packages/core/capabilities.json` with the six aliases, four situations, three constraints and one override; the search spec → 108 passed, and the probe ranks `InputMap` first at 2.00, 2.40 and 0.61.
- [x] The `gamepad` convention row renders into each kit `AGENTS.md`, and the convention-index check passes. proof: `pnpm build && pnpm exec vitest run packages/create-threenative/__tests__` (the conventions spec) — Evidence: the check lives in `scripts/__tests__/kit-conventions.spec.ts` (it is the spec that reads `conventions.json`, every kit's `AGENTS.md` and `CLAUDE.md`). `pnpm sync:agents` wrote 32 mirrors and the spec → 36 passed, including every kit's index carrying the row with its override.
