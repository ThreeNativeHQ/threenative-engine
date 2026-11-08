# PRD-835 — One registry entry per assertion

**Status:** IN PROGRESS — Phases 1 to 3 done on 2026-11-08; AC-1 and AC-2 open (see their notes)
**Priority:** P1 — open Phase 1 removes the 17-file hand edit per assertion kind that already shipped 3 kinds no runner can produce, and Phase 2 fixes a lane vocabulary that cannot name android or ios.
**Complexity:** 5 (MEDIUM)
**Owner:** ThreeNative maintainers
**Depends on:** None
**Batch:** [Untangle report, 2026-11-06](README.md) — R3

## Context

Report ids E1, E2, E3, E6.

| Problem | Where |
| --- | --- |
| One assertion kind = 17 hand-edited files (`924b92f82`, the `tone` kind: 18 files under `packages/playtest/src`) | `src/assertion-schema.ts:27`, `src/scenario/schema-validate.ts:1088-1323`, `src/scenario/schema-accessors.ts:280-1170`, `src/assertion-evaluators.ts:36-68`, `src/runner/observationFields.ts`, `src/assertion-report.ts:168` |
| 3 kinds shipped with schema, evaluator and docs but no runner. A spec pins them as debt. | `packages/playtest/__tests__/runner.spec.ts:676-694` |
| `PlaytestTarget = "web" \| "desktop" \| "bevy"` cannot name android or ios. The real matrix is 11 `if` blocks in the android runner. The registry says `tone` is unsupported on android, but the android runner supports it. | `src/scenario/schema-base.ts:11`, `src/runner/androidRunner.ts:1185-1275`, `src/assertion-schema.ts:30` |
| Capture-with-retry open-coded 5 times. "Needs pixels" predicate written 3 times. | `src/runner/runner.ts:667-733`, `src/runner/androidRunner.ts:749`, `runner.ts:597,602`, `captureEnvironment.ts:127`, `runner-support.ts:118` |
| `geometry` lives outside the registry. `requiredCapabilities` and `trivialityRationale` are read by nothing at runtime. | `schema-validate.ts:1089-1091`, `assertion-evaluators.ts:49-66` |

## Solution

Each registry entry carries `validate`, `evaluate`, `observationPath` and `supportedOn` over the
real lanes `browser | android | desktop | ios`. The dispatch in `schema-validate.ts`, the `emit*`
list, the report line and the observation-field entry are generated from it. A kind with no
producer on any lane fails the generator. The shared device flow moves to `deviceRunner.ts`, and one
`captureWithRetry` serves both lanes.

## Acceptance Criteria

- [ ] AC-1 [local]: The starter and platformer scenarios give the same verdicts before and after on the browser lane. proof: `pnpm test:templates` (starter, platformer)
- [ ] AC-2 [local]: An android scenario with a `tone` assertion runs on the emulator. proof: `node packages/playtest/dist/runner/cli.js <scenario> --target android` on the emulator

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Scenario validation | `playtest` CLI → `validateScenario` | Hand dispatch deleted | Phase 1 |
| Lane refusal | Device runner preflight | 11 `if` blocks deleted | Phase 2 |

## Execution Phases

#### Phase 1: Registry generates the plumbing
**Status:** DONE 2026-11-08
**Files:** `src/assertion-schema.ts`, `scripts/generate-assertion-validators.ts`, `src/scenario/schema-validate.ts`, `src/assertion-evaluators.ts`, `src/runner/observationFields.ts`.

- [x] The dispatch, the evaluator list and the observation fields are derived from the registry, and the hand dispatch at `schema-validate.ts:1088-1323` is gone. proof: `pnpm exec vitest run packages/playtest/__tests__/generated-assertion-validators.spec.ts packages/playtest/__tests__/schema-boundaries.spec.ts packages/playtest/__tests__/assertion-report.spec.ts` — 3 files, 33 tests passed. `packages/playtest/__tests__/assertion-bindings.spec.ts` (new) pins that every registry kind has exactly one binding, and the evaluator order equals the binding order.
- [x] A kind with no producing runner fails the generator, and the 3 pinned kinds get a producer or are removed. proof: `pnpm exec vitest run packages/playtest/__tests__/runner.spec.ts packages/playtest/__tests__/assertion-bindings.spec.ts packages/playtest/__tests__/vacuous-assertion.spec.ts` — 3 files, 124 tests passed. `pnpm tsx scripts/generate-assertion-validators.ts --check` prints `33 kinds are current`. The generator now throws when `unproducedAssertionKinds()` is not empty.

**Decision 2026-11-08, "derived", not "generated".** The kind-to-code table is `ASSERTION_BINDINGS` in `src/assertion-bindings.ts`, a `Record<AssertionKind, { validate, evaluate, nonEmpty? }>`. The compiler rejects a registry kind with no row. The evaluator order is the row order. The generator keeps the field predicates and the producer check. A second code-generation step would add a file and no safety.

**Decision 2026-11-08, the 3 pinned kinds are removed.** `reachability`, `overlayNodes` and `occluded` had a schema, an evaluator and docs, but no runner produced the observation they read. A spec pinned them as debt. They are deleted from the registry, the validators, the evaluators, the observation fields and the shipped assertion reference. `scripts/sweep-pair.ts` and `sealed-contract.spec.ts` name the old kinds in frozen sweep records. They are left untouched on purpose.

**Decision 2026-11-08, `geometry` joined the registry in Phase 1.** The binding table needs one row per kind, so the Phase 3 `geometry` box was done here and is proven in Phase 3.

**Correction 2026-11-08, proof command form.** The `pnpm --filter @threenative/playtest exec vitest run __tests__/...` form finds no tests, because the vitest config is at the repository root. Every proof in this PRD uses `pnpm exec vitest run packages/playtest/__tests__/...` from the root.

#### Phase 2: Real lane vocabulary
**Status:** DONE 2026-11-08
**Files:** `src/scenario/schema-base.ts`, `src/protocol.ts`, new `src/runner/deviceRunner.ts`, `src/runner/androidRunner.ts`, `desktopRunner.ts`, `iosRunner.ts`.

- [x] `supportedOn` names the 4 real lanes, the device refusals derive from it, and `deviceRunner.ts` holds the shared flow. proof: `pnpm exec vitest run packages/playtest/__tests__/runner-lanes.spec.ts packages/playtest/__tests__/tone-runner.spec.ts packages/playtest/__tests__/device-playtest.spec.ts` — 3 files, 68 tests passed. The new `runner-lanes.spec.ts` case walks the registry: for every kind on android, desktop and iOS, the device lane refuses the example if and only if `supportedOn` omits that lane, and the refusal names every supported `--target`. Red control: with `tone` removed from the android list and the runner left as it was, the case failed with `tone on android: listed=false: expected true to be false`; the entry is restored.

**Decision 2026-11-08, two vocabularies.** `PlaytestLane` (`browser | android | desktop | ios`, in `src/lanes.ts`) is the vocabulary of `supportedOn` and of the refusals. `PlaytestTarget` (`web | desktop | bevy`) stays the scenario-file field, so no existing scenario or CLI call changes. `laneOfScenarioTarget` maps `web` to `browser` and every other value to `desktop`.

**Decision 2026-11-08, `tone` on android.** The registry said `tone` was unsupported on android while the android runner ran it. The registry now lists android. `tone-runner.spec.ts` already ran `tone` on the android driver and still passes.

**Decision 2026-11-08, file layout.** `src/runner/deviceRunner.ts` (renamed from `androidRunner.ts`) holds `runDevicePlaytest` and the refusal loop. `src/runner/androidRunner.ts` is now the small android entry (`runAndroidPlaytest`). The refusals that depend on a step rather than an assertion kind stay in one `STEP_LANE_RULES` table next to the registry loop.

#### Phase 3: One capture path, `geometry` in the registry
**Status:** DONE 2026-11-08
**Files:** new `src/runner/capture-retry.ts` (the planned `captureSession.ts` name is taken by the existing capture session module), `runner.ts`, `deviceRunner.ts`, `runner-support.ts`, `captureEnvironment.ts`.

- [x] Both lanes call one `captureWithRetry`, and one `requiresPixels` replaces 3 predicates. proof: `pnpm exec vitest run packages/playtest/__tests__/runner-orchestration.spec.ts packages/playtest/__tests__/capture-environment.spec.ts packages/playtest/__tests__/capture-retry.spec.ts packages/playtest/__tests__/tone-runner.spec.ts packages/playtest/__tests__/runner-lanes.spec.ts` — the first three files give 46 tests passed, the last two are in the Phase 2 count. Red first: before the change, the new `captureWithRetry` cases, the `requiresPixels` case, the three device-lane blank-frame retake cases (android, desktop, iOS) and the source check in `runner-lanes.spec.ts` all failed. They pass now.
- [x] `geometry` is a registry kind. `requiredCapabilities` is enforced at preflight or deleted. proof: `pnpm exec vitest run packages/playtest/__tests__/scene-assertion.spec.ts` — 15 tests passed, 3 of them new: the `geometry.observed` verdict, the capability read from the registry entry, and a handshake that refuses a bridge without `runtime.geometry`.

**Decision 2026-11-08, `requiredCapabilities` is kept.** Its reader is `requiredPlaytestCapabilities`, called by `connectPlaytestBridgeTransport` (`src/runner/bridgeClient.ts:169`). The handshake fails by capability name for both the browser and the device lanes. The special case for `geometry` in that function is gone. `trivialityRationale` is still read only by `vacuous-assertion.spec.ts`; this PRD does not change it.

**Decision 2026-11-08, two behaviour changes of the shared path.** (1) A device lane now retakes a blank frame every 100 ms for up to `PRESENTATION_BOUND_MS` (10 s), as the browser lane did; a frame still blank at the bound fails closed with the same verdict. (2) Capture provenance is now read for every run that `requiresPixels`, which adds the `framebufferCoverage`-only run to the set.
