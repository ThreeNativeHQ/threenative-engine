# PRD-498 — Baseline and differential fixture runner (N01)

**Status:** PROPOSED
**Priority:** P1 — Wave 1: the differential fixture runner CP1 later measures against; 4 open boxes and no runner exists.
**Complexity:** 4 — a new runner that drives the pinned upstream and the native engine through one fixture format, plus native-host baselines
**Owner:** João
**Work package:** N01 — [native-engine batch](README.md)
**Depends on:** [PRD-497](PRD-497-n00-architecture-decision-and-compatibility-inventory.md)

## Context

Every later PRD proves itself by comparing the native engine against the pinned three@0.185.1 reference (§15.1). Every performance claim compares against current optimized ThreeNative, not vanilla Three.js (§15.3). Today `packages/runtime-native/conformance/registry.json` with `pnpm parity` compares web against native for the *host*, and `docs/verification/runtime-perf-state.md` holds scoped measurements, some of them from browser/Xvfb runs (§3, R4). Nothing yet records reference outputs in a form a C++ test can consume.

## Solution

1. **Fixture format** (proposed: `packages/three-native/tests/compatibility/fixtures/*.json`). Each fixture holds a scripted scene, its operations and observations (matrices, bounds, events, pixels), the tolerance, and the upstream test it was adapted from (§15.1). A missing observation fails; an empty assertion set fails.
2. **Reference runner** (proposed: `packages/three-native/tests/compatibility/run-reference.ts`). It executes each fixture against the pinned `three` in Node, plus WebGPU through the playtest harness for render fixtures, and writes golden outputs keyed by the reference version.
3. **Differential runner** (proposed: `run-native.ts`). It feeds the same fixture to a native C++ driver and diffs against the goldens. It reuses `pnpm parity`'s registry and report shape rather than adding a second report format.
4. **Native baselines**: reproduce the Machinefall per-object refresh, WorldCells streaming and shadow workloads named in R4 on the native host. Results go into `docs/verification/runtime-perf-state.md` in place, each labelled as functional (Xvfb/software adapter) or device evidence (§15.3).

## Out of scope

- The investment-gate comparisons themselves: [PRD-533](PRD-533-n20-platform-qualification-performance-default-promotion.md).
- Native-TS versus native-C++ driver cost: [N05](N05-native-typescript-qualification/README.md) and PRD-533.

## Execution Phases

#### Phase 1: Reference outputs are reproducible
**Status:** NOT STARTED
**Files:** proposed `packages/three-native/tests/compatibility/{fixtures,run-reference.ts}`, `packages/three-native/__tests__/fixture-format.spec.ts`
- [ ] The fixture schema rejects a fixture with no observations and a missing tolerance. proof: red-green `pnpm exec vitest run packages/three-native/__tests__/fixture-format.spec.ts`
- [ ] Two consecutive reference runs of the seed corpus (hierarchy, matrices, one lit render) produce identical non-pixel goldens. proof: `pnpm --filter @threenative/three-native test:reference -- --repeat 2`

#### Phase 2: Native results diff against the goldens
**Status:** NOT STARTED
**Files:** proposed `packages/three-native/tests/compatibility/run-native.ts`; `packages/runtime-native/conformance/registry.json`
- [ ] The differential runner reports pass/fail per fixture through the existing parity report. A fixture the native driver cannot run reports `blocked`, not `pass`. proof: `pnpm parity -- --suite native-engine`

#### Phase 3: Native-host baselines exist
**Status:** NOT STARTED
**Files:** `docs/verification/runtime-perf-state.md`
- [ ] The Machinefall per-object refresh, WorldCells streaming and shadow workloads are measured on the native desktop host, each labelled with its lane. proof: `node packages/playtest/dist/runner/cli.js perf --executable <native host> --file <scenario>`

## Blocked on

- Physical-device baselines (Android hardware) need an attached device; João attaches it when the device lane runs.
