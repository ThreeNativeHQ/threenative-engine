# PRD-529 — Native playtest, inspection and telemetry (N16)

**Status:** PROPOSED
**Priority:** P2 — Wave 5: the native playtest, inspection and telemetry endpoint behind the existing protocol; 6 open boxes.
**Complexity:** 3 — new native endpoint behind the existing playtest protocol
**Owner:** João
**Work package:** N16 — [native-engine batch](README.md)
**Depends on:** [PRD-499 (N02)](PRD-499-n02-the-host-links-without-a-js-engine.md), [PRD-500 (N03)](PRD-500-n03-api-catalog-binding-abi-and-version-protocol.md), [PRD-508 (N06)](PRD-508-n06-native-scene-graph-transforms-cameras-geometry.md)

## Context

§11.4 requires native playtest commands, scene inspection, deterministic input injection, telemetry,
screenshots and state snapshots. A Node driver outside the application is fine; a JS mailbox inside
the native-engine player is not. Today the in-game side is JavaScript (`packages/core/src/playtest.ts`) and
the runner speaks the protocol in `packages/playtest/src/protocol.ts`. The native host already has a
debug server (`packages/runtime-native/src/debug/debug_server.cpp`) and a screenshot gate
(`packages/runtime-native/src/screenshot_gate.cpp`).

## Solution

1. Proposed `packages/runtime-native/src/engine/inspect/` implements the existing playtest protocol
   natively: commands, input injection at tick boundaries, scene/component inspection over the native
   object graph, state snapshots, screenshots and telemetry frames.
2. The runner (`packages/playtest`) connects to it unchanged; scenarios written for the web or legacy
   native path run against the native-engine player where the capability exists, and fail closed where it
   does not.
3. Telemetry reports which artifact profile is running (engine profile plus game runtime: V8, browser JS or native AOT, §17),
   so a crash report or a perf frame never confuses the two.
4. Rollback: the legacy native path keeps the JS bridge.

## Out of scope

- Packaging (N17, N20). The perf meters themselves (N20 uses them).

## Execution Phases

#### Phase 1: Protocol endpoint
**Status:** NOT STARTED
**Files:** proposed `packages/runtime-native/src/engine/inspect/`, `packages/runtime-native/tests/native-engine/inspect_*.cpp`
- [ ] Every protocol message type in `protocol.ts` decodes and gets a defined reply or a named unsupported error. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_inspect_protocol`
- [ ] Input injected for tick N is observed by game code in tick N, not N+1. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_inspect_input_tick`

#### Phase 2: Runner drives the native-engine player
**Status:** NOT STARTED
**Files:** `packages/playtest/src/` (target wiring only)
- [ ] A scene-inspection scenario passes against the native-engine desktop player with no engine JS loaded. proof: `node packages/playtest/dist/runner/cli.js native-engine-inspect.playtest.json --target desktop`
- [ ] Screenshot and state-snapshot steps return non-blank, stable results. proof: `node packages/playtest/dist/runner/cli.js native-engine-capture.playtest.json --target desktop`
- [ ] Startup telemetry names the engine profile as native and the game runtime. proof: `node packages/playtest/dist/runner/cli.js native-engine-inspect.playtest.json --target desktop` (asserts the profile field)
- [ ] The inspection scenario passes on the Android emulator. proof: `node packages/playtest/dist/runner/cli.js native-engine-inspect.playtest.json --target android`
