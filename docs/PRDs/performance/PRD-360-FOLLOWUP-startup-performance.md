---
prd_contract: v1
---

# PRD-360 follow-up — finish startup performance on the working Bayview build

**Status:** PARTIAL — the first-use boundary fix and one corrected object-granularity validation are
complete; PRD-360 remains PARTIAL because the launch and pump budgets still fail.
**Parent:** [PRD-360](PRD-360-android-launch-is-playable-within-eight-seconds.md).
**Complexity:** 6 → MEDIUM: async startup across core/native, approximately 6–10 implementation files.
**Execution budget:** Start with a 60-minute profiling task. At most three measured optimization experiments before reporting results or escalating. No speculative rewrite.
**Delegate:** A cheaper coding model can execute the bounded tasks below. Escalate a demonstrated GPU scheduling or cross-thread ownership problem with evidence, not an open-ended debugging transcript.

**Priority:** P1 — Qualifies the unmet eight-second launch criterion on three physical cold launches.
## Objective and current truth

Make the real Bayview game playable within **8,000 ms median across three qualified physical Android cold launches**, with **no event-pump silence above 250 ms**. Preserve the world, effects, assets, UI and accepted movement. First frame alone does not establish first playable.

The startup crashes are fixed; performance is not. [PR #136](https://github.com/ThreeNativeHQ/threenative/pull/136) contains the repairs. Inspect its current status before branching; do not assume it merged. Repair commits: `dad33852` and `ebfbb085`.

| Executed observation, September 7 | Result |
| --- | --- |
| Corrected APK, physical Pixel 8 / Android 17 | Starts, world and HUD visible |
| Native movement / diagnostics | 2.146719 m, pass / no console errors |
| First frame, one uninterrupted run | **16,020.007 ms**; not a three-run median or an 8-second acceptance result |
| Pipeline compilation before that frame | **8,404.781 ms / 93 calls** |
| Unattributed portion of the measured frame stall | **4,917.275 ms** |
| Corrected object-granularity validation, physical Pixel 8 | **19,629.400 ms** first frame; 2.146682 m movement; endpoint pump gap **5,560.916 ms** |

The same raw log reports `maxGapMs:15708.693` in pump observations. That is a diagnostic observation, not a completed endpoint-correlated acceptance evaluation. Do not reuse the historical 103-call/8.3-second baseline as if it described this repaired APK.

Evidence: [repair report](../../verification/findings-2026-09-07-bayview-fix/README.md), [APK identities](../../verification/findings-2026-09-07-bayview-fix/proof.json), [scenario](../../verification/findings-2026-09-07-bayview-fix/manifest.playtest.json), [visible world](../../verification/findings-2026-09-07-bayview-fix/android-world.png).

## Resume here — do not rebuild the investigation

Working engine checkout:
`/home/joao/projects/threenative/threenative-engine/.worktrees/findings-asset-resolution`

Working game:
`/home/joao/projects/threenative/sandbox/prd360-bayview-manifest-fix`

Within that engine checkout, `artifacts/findings-fix/` contains:

- `green.apk`, SHA-256 `2f4ceac5441b1aa5bda67a9cd44d9948729ddc5d350e621cb4d220bce282a145`; app ID **`com.threenative.bayview.manifestfix`**.
- `green/main.js`, SHA-256 `400a0ab3ba14039138a6eb105b5e601dedfbddffcae4eac7411fedb8c51a7f25`.
- `green-host-uninterrupted.log`, SHA-256 `b74636ec5c3e6b164ed22e32c55a6b68c8d5284bf9ab839551f26792e0dfde1a`.
- `package-proof.ts`, `staging-worker-prepare.mjs`, `staging-worker-verify.mjs` and `host-identity.json`: exact packaging, asset conversion and native-host provenance.
- `green-playtest-uninterrupted/`: console, response observations and automated screenshot. These local artifacts must be located and preserved before worktree cleanup.

The APK reused checksum-locked native binaries from the previous failed candidate; it is **not** proof of a C++ rebuild from the repair branch. A native-code optimization must rebuild the host and record its new identity. The game currently resolves its own unpatched Three.js copy; keep that constant across A/B arms or explicitly rebuild both arms with the same patch configuration.

## Constraints — do not undo the repairs

The missing asset manifest was a game override selecting absent `raw-assets.manifest.json`. It was removed; legacy assets now enter the compiled manifest. All 57 logical requests resolve. `assets.audio: "none"` preserves all 30 audio cues. Three interleaved models require a verified vertex-layout conversion in the Android staging source; do not rename bytes under existing hashes or bypass preflight.

The UI build deduplicates React/ReactDOM; the native game bundle deduplicates Three.js. Do not revert these fixes, reintroduce duplicate shader state, or patch copies under `node_modules`.

Do not remove effects, reduce scene content, change resolution, disable validation, raise the acceptance budget, hide the loading state, or substitute a toy scene. Persistent cross-launch pipeline caching and publishing runtime releases remain separate work. Keep the original `com.threenative.bayview` baseline app untouched. A previous phone run was invalidated by another app taking the foreground: coordinate a 60-second idle window before device runs. The existing Android compatibility dialog must be dismissed for visual inspection; its dimming is not a lighting defect.

## Integration ledger

| Change/gate | Existing live caller | Replaces | Old path disposition | Negative control |
| --- | --- | --- | --- | --- |
| Trustworthy timing and movement proof | `packages/runtime-native/scripts/measure-cold-start.mjs`; playtest Android runner; existing PRD-360 collector/evaluator | Historical/stale-arm interpretation | Reuse collectors; no competing timing framework | Missing endpoint, wrong APK hash or known-false movement fails |
| Responsive compilation | `packages/core/src/game.ts:860,1138,1171,1262` → `warmUpScene`; `packages/core/src/renderer.ts:389` → upstream `compileAsync` | Only the measured blocking path | Existing caller delegates to the repaired path in the same phase | Reverting the fix restores the measured stall |
| Native pump, only if profiling requires a repair | `packages/runtime-native/src/runtime.cpp:1256` → `pollEvents`; scheduler installation → `scheduler-yield.js` | Only the demonstrated blocking mechanism | No parallel scheduler | Held presentation still permits timers/yields; deliberate blocking fails gap gate |

Resolve final line anchors before each implementation checkpoint. No new exported module is planned. Any added export must have a real caller and an observed removal failure.

```mermaid
flowchart LR
    Launch --> LoadAssets --> Compile --> VisibleWorld --> AcceptedMovement
    Compile --> Pump[Pump events and timers]
    LoadAssets --> Failure[Explicit bounded failure]
    Compile --> Failure
```

```mermaid
sequenceDiagram
    Collector->>Host: Launch identified APK
    Game->>Renderer: Compile unchanged scene
    Renderer->>Host: Yield while work is pending
    Host-->>Renderer: Pump events and complete work
    Host-->>Collector: Present, movement response and correlated pump observation
    Collector->>Evaluator: Raw observations and identity
    Evaluator-->>Collector: Pass or named missing/over-budget failure
```

## Phase 1 — establish where the 16 seconds go

**Outcome:** Launch the real game and obtain an attributable, reproducible baseline before editing production behavior.

**Files:** READ existing game startup and render configuration. EDIT only if necessary: `packages/runtime-native/scripts/measure-cold-start.mjs`, its `tests/measure-cold-start.test.mjs`, existing stall instrumentation in `include/mystral/stall_budget.h`, and `docs/verification/runtime-perf-state.md` (maximum five edited files).

1. Verify the APK/bundle hashes above and inspect the repair PR. Freeze an internally consistent baseline from the working game. Record source, configuration, native libraries and Three.js patch identity for both arms.
2. Inspect existing `TN_COLD_START`, `TN_STALL_SEGMENTS`, `TN_PUMP_SILENCE` and `TN_PUMP_ENDPOINT` records. Trace whether `game.ts` actually invokes the default warm-up path; a comment or installed scheduler does not prove invocation.
3. Reuse the existing cold-start collector and the PRD-360 collector/evaluator retained under `docs/verification/prd-360-startup-2026-09-05/`. The archived collector hardcodes an old app ID and APK hash: adapt its staged configuration, never run it blindly against the preserved baseline.
4. Obtain three qualified baseline launches: battery at least 50%, discharging, acceptable thermal state, screen on and game foreground. Separate native startup time from coordinator setup, mailbox polling, screenshot transfer and teardown. The historical roughly 50-second harness bound does not isolate game latency. Do not subtract guessed overhead or relabel first-frame time as first-playable time.
5. Produce one ranked bottleneck table and select one lever. If the remaining stall cannot be attributed, report that uncertainty before changing scheduling.

**Checkpoint:** Existing timing tests plus `should reject a measurement when its APK identity or movement endpoint is missing`; prove the negative with a copied receipt. User verification: visible Bayview world and accepted movement. Independent review must confirm distinct arms, observed timing and no substituted workload.

## Phase 2 — optimize one measured blocking path

**Outcome:** The same Bayview world becomes usable sooner without freezing input/event pumping.

**Files, choose one route per experiment:**

- Core route: EDIT `packages/core/src/game.ts`, `warmup.ts`, `renderer.ts`, `packages/core/__tests__/warmup.spec.ts`, and the existing performance record.
- Native route, only with evidence: EDIT `packages/runtime-native/src/runtime.cpp`, `src/runtime-scripts/scheduler-yield.js`, the identified existing compile binding, its existing focused test, and the performance record.

Search engine capabilities and inspect every hit before introducing a helper or changing a render stage, as required by repository instructions. Reuse upstream Three.js compilation, existing granularity, bounded failure behavior and the native scheduler. Do not introduce a new scheduler or thread model by guesswork.

For each experiment: state a predicted improvement; record the baseline red; make one bounded change through the existing caller; build/reinstall; repeat three candidate cold launches; compare unchanged content and configuration. Record actual pipeline count/time, residual, first playable and maximum pump silence. Revert an ineffective experiment instead of accumulating it.

**Tests:** `should keep timers progressing when presentation is held`; `should report bounded failure when compilation does not settle`; and a real Bayview run that fails the target with the change reverted. Do not invent a red for a behavior the incumbent already satisfies. Preserve passing existing scheduler tests.

**Stop rule:** After three failed experiments or 60 minutes without a trustworthy bottleneck, stop and hand the supervising model the hypothesis, diff, raw measurements and doubtful assumption. Do not widen scope silently.

## Bounded experiment checkpoint — 2026-09-08

The existing object granularity was selected in the unchanged Bayview caller for one corrected
validation run. The engine fix keeps first-use rendering and compute behind the explicit warm-up
while the loading layer continues to animate. The focused regression was red before the fix and
green after it; the implementation and test anchors are `packages/core/src/game.ts:860,1138,1171,1262`
and `packages/core/__tests__/game.spec.ts:545`.

The qualified Pixel 8 receipt passed the movement scenario at **2.146682 m**, but recorded one
`TN_WARMUP` of 494 pipelines in 11,659 ms, first frame at **19,629.400 ms**, and a movement endpoint
pump gap of **5,560.916 ms**. The raw receipt is in
[the existing verification record](../../verification/prd-360-warmup-cache-2026-09-07/README.md).
This lever therefore fails both performance budgets and remains opt-in. The temporary sandbox
option was removed after the run; no default, visual, asset or effect change was retained.

## Phase 3 — acceptance and closure

**Outcome:** The actual game meets every parent criterion; otherwise PRD-360 remains PARTIAL.

**Files:** EDIT the existing game startup scenario, applicable existing timing/evaluator tests, `docs/verification/runtime-perf-state.md`, this follow-up and the parent PRD (maximum five). Preserve raw receipts in the existing proof location and cite them.

- [ ] Three qualified physical Android cold launches: median **first playable ≤8,000 ms**, with visible world and input-driven displacement **≥0.25 m**.
- [ ] Correlated pump observations prove **no gap >250 ms**, including startup and the movement endpoint. Missing or malformed observations fail; first-present-only markers are insufficient.
- [ ] Same scene, effects, asset content, render settings and native/Three.js configuration across baseline and candidate; no warm-cache substitution for the required cold launch.
- [x] Browser WebGPU movement/visual proof passes and records the actual adapter. The Vite dependency identity repair passed the unchanged repaired game's four assertions on NVIDIA/Turing: 2.146736 m movement, visible world, and zero console/network/runtime errors. Source, dependency and artifact hashes plus the scenario are retained in [browser verification](../../verification/browser-dependency-identity-2026-09-07/README.md). This does not establish the Android timing or pump criteria.
- [ ] Focused red/green and revert controls, full repository checks, independent checkpoint review, and final parent acceptance audit all pass.

Use these existing commands; run from the retained engine worktree:

```sh
pnpm typecheck && pnpm lint && pnpm test
pnpm build && pnpm budgets
node packages/playtest/dist/runner/cli.js doctor --text --device 192.168.1.192:5555
node packages/playtest/dist/runner/cli.js docs/verification/findings-2026-09-07-bayview-fix/manifest.playtest.json --target android --device 192.168.1.192:5555 --package com.threenative.bayview.manifestfix --activity com.threenative.runtime.MystralActivity --timeout 60000 --artifacts artifacts/prd360-followup/movement
```

Rediscover the device serial with `adb devices -l` if the recorded Wi-Fi address changes. The 60-second command timeout is a failure-detection bound, **not** the performance criterion. That movement scenario proves functional behavior, not eight-second startup or the full pump contract; run the correlated collector/evaluator as well.

For browser proof use the same scenario against the game's actual dev server with `--browser-recipe webgpu`; record `adapter.info`. Do not claim Android performance from an emulator or desktop run. Rebuild a changed native host from its identified source; do not accidentally package the retained prebuilt libraries after a C++ edit.

## Verification evidence and completion

| Phase | Required evidence | Current result |
| --- | --- | --- |
| 1 | Three qualified baseline receipts, identity checks, ranked attribution and negative measurement control | PARTIAL — baseline and identity evidence predate this bounded follow-up; the missing negative control remains open |
| 2 | One-lever A/B, real caller anchors, red/green/revert outputs, unchanged appearance | PARTIAL — corrected object validation and red/green boundary proof pass movement but fail timing and pump budgets |
| 3 | Three candidate receipts, ≤8-second median, ≤250-ms pump silence, browser proof, full gates and independent review | PARTIAL — browser and movement proofs pass; Android acceptance, full cold median and final gates remain open |

After each implementation phase, an independent reviewer checks integration, actual observations and the negative control. The implementer cannot approve its own phase. Keep summaries to five bullets; put raw output in artifacts. Record new performance findings in `docs/verification/runtime-perf-state.md`, not a new competing performance ledger.

Do not close this follow-up or move PRD-360 to `done/` while any acceptance item is unproven. A successful build, a first frame, or a movement pass alone is not completion.

## Copy/paste handoff

> Read this follow-up and the linked repair evidence. The object-granularity experiment is complete and fails the measured budgets; preserve its receipt and do not make it the default. PRD-360 remains PARTIAL until a separately justified lever produces three qualified cold candidate launches with correlated pump evidence. Do not change visuals, rewrite the engine, or claim completion. Use an independent reviewer at the next checkpoint.
