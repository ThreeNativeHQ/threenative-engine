# PRD-522 — A world loads, walks and unloads without growth (N13c)

**Status:** PROPOSED
**Priority:** P2 — Wave 5, which CP1 gates: a world loads, walks and unloads without growth; 4 open boxes.
**Complexity:** 3 — integration proof over N13a/N13b; the new work is the fixture, the memory accounting and the failure injection
**Owner:** João
**Work package:** N13 — [native-engine batch](../README.md) · [N13 umbrella](README.md)
**Depends on:** [PRD-521 (N13b)](PRD-521-n13b-worldcells-and-worldtiles-run-native.md)

## Context

§16 sets N13's acceptance as a world-load/walk/unload fixture with budgets and failure/recovery behaviour. §15.4 requires no sustained memory growth across repeated bounded load/unload cycles, with CPU and GPU allocation accounting published. §15.3 names streaming Machinefall content as a representative workload. Its current baseline (`?scene=map-walk`) is recorded in `docs/verification/runtime-perf-state.md`, measured in a browser under Xvfb, so it must be reproduced on the native host before it counts as a native baseline (§3 R4). Machinefall is a game outside this repository. The fixture runs through the N01 runner ([PRD-498](../PRD-498-n01-baseline-and-differential-fixture-runner.md)).

## Solution

1. **Fixture.** A scripted camera path loads a streamed world, walks it across cell boundaries and unloads it, on the native desktop host. It runs as a playtest scenario through `packages/playtest --target desktop`, driven over the N16 endpoint.
2. **Budgets.** Per-frame admission time and bytes come from PRD-520 telemetry and are asserted in the scenario.
3. **Memory accounting.** CPU heap, GPU buffer and texture bytes, and live handle counts are sampled after each of N load/unload cycles. The slope over the cycles is asserted to be flat within a documented noise band.
4. **Failure and recovery.** A missing or corrupt cell file is injected. The world reports a coded error for that cell, keeps walking, and the cell is retried or held visibly absent according to its recovery class (§12).

## Out of scope

- Device performance claims against current ThreeNative: [PRD-533 (N20)](../PRD-533-n20-platform-qualification-performance-default-promotion.md)

## Execution Phases

#### Phase 1: Load, walk, unload
**Status:** NOT STARTED
**Files:** proposed `packages/runtime-native/scenarios/native-engine-world-walk.playtest.json`
- [ ] The world fixture loads, walks the scripted path and unloads on the native desktop host with no unsupported-feature diagnostic. proof: `node packages/playtest/dist/runner/cli.js packages/runtime-native/scenarios/native-engine-world-walk.playtest.json --target desktop`
- [ ] Per-frame admission time and bytes stay within the configured allowance for the whole walk. proof: the same scenario's `TN_FRAME_BUDGET` admission assertions

#### Phase 2: Memory and failure
**Status:** NOT STARTED
**Files:** proposed `packages/runtime-native/scenarios/native-engine-world-cycles.playtest.json`, `.../native-engine-world-fault.playtest.json`
- [ ] Ten load/unload cycles show a flat CPU, GPU and handle-count slope within the documented noise band. proof: `node packages/playtest/dist/runner/cli.js packages/runtime-native/scenarios/native-engine-world-cycles.playtest.json --target desktop`
- [ ] A corrupt cell file produces a coded error, the walk continues, and recovery follows the documented class. proof: `node packages/playtest/dist/runner/cli.js packages/runtime-native/scenarios/native-engine-world-fault.playtest.json --target desktop`

## Blocked on

- The native Machinefall map-walk baseline on physical Android hardware needs the device attached (owner).
