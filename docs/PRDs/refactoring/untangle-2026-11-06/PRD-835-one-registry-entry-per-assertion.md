# PRD-835 — One registry entry per assertion

**Status:** NOT STARTED
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
**Status:** NOT STARTED
**Files:** `src/assertion-schema.ts`, `scripts/generate-assertion-validators.ts`, `src/scenario/schema-validate.ts`, `src/assertion-evaluators.ts`, `src/runner/observationFields.ts`.

- [ ] The dispatch, the evaluator list and the observation fields are generated, and the hand dispatch at `schema-validate.ts:1088-1323` is gone. proof: `pnpm --filter @threenative/playtest exec vitest run __tests__/generated-assertion-validators.spec.ts __tests__/schema-boundaries.spec.ts __tests__/assertion-report.spec.ts`
- [ ] A kind with no producing runner fails the generator, and the 3 pinned kinds get a producer or are removed. proof: `pnpm --filter @threenative/playtest exec vitest run __tests__/runner.spec.ts`

#### Phase 2: Real lane vocabulary
**Status:** NOT STARTED
**Files:** `src/scenario/schema-base.ts`, `src/protocol.ts`, new `src/runner/deviceRunner.ts`, `src/runner/androidRunner.ts`, `desktopRunner.ts`, `iosRunner.ts`.

- [ ] `supportedOn` names the 4 real lanes, the device refusals derive from it, and `deviceRunner.ts` holds the shared flow. proof: `pnpm --filter @threenative/playtest exec vitest run __tests__/runner-lanes.spec.ts`

#### Phase 3: One capture path, `geometry` in the registry
**Status:** NOT STARTED
**Files:** new `src/runner/captureSession.ts`, `runner.ts`, `androidRunner.ts`, `runner-support.ts`, `captureEnvironment.ts`.

- [ ] Both lanes call one `captureWithRetry`, and one `requiresPixels` replaces 3 predicates. proof: `pnpm --filter @threenative/playtest exec vitest run __tests__/runner-orchestration.spec.ts`
- [ ] `geometry` is a registry kind. `requiredCapabilities` is enforced at preflight or deleted. proof: `pnpm --filter @threenative/playtest exec vitest run __tests__/scene-assertion.spec.ts`
