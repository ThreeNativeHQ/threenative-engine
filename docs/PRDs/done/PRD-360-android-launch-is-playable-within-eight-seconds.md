---
prd_contract: v1
Latest investigation: [startup cost and heat handoff](../../verification/prd-360-startup-cost-2026-09-08/README.md). UI ordering fixed; performance remains PARTIAL. The user requested hardware-cost diagnosis and a bounded Opus handoff before broad optimization.

---

# PRD-360 — Android launch is playable within eight seconds

**Status:** CLOSED 2026-09-08 by owner decision, with the eight-second criterion **unmet and not
claimed**. Measured on a physical Pixel 8, the launch reaches a playable world in ~10.9 s, and
8,513 ms of that is **96 distinct shader programs → 101 pipelines × ~84 ms of Mali compile each**.
The framework's share of that number is measured at zero: no scheduling shape helps (three
measured, every one slower than not warming up), there is nothing to deduplicate (96 of 101
pipelines are unique programs), and no persistent pipeline cache is reachable from the pinned
wgpu-native. What is left is the game's distinct-material count, which decides how it looks, and the
driver's per-pipeline cost.

**One attribution is unmeasured and is filed rather than assumed:** several of those fragment
shaders are ~55 KB of generated WGSL, and whether the ~84 ms tracks shader *size* was never tested.
If it does, the engine's node graph owns part of that cost. See the follow-up in
[the startup-cost record](../../verification/prd-360-startup-cost-2026-09-08/pipeline-shapes.md).

This PRD is archived because the framework work it asked for is done and measured, not because the
criterion was reached. Historical status was PARTIAL — measured on hardware 2026-09-07 and the criterion is **unmet**. Three cold launches of the preserved baseline on a physical Pixel 8 give a preflight-qualified median launch-to-first-playable bound of 49,788.7 ms against the 8,000 ms criterion, with the player moving 2.147 m and a visible world proved. The device blocker that filed this under `requires-physical-device` is resolved, so it returns to its batch. The 2026-09-07 warm-up host turn and opt-in relaunch cache land compile-path progress, not the criterion: the single 16,020.007 ms candidate run is a retained-package launch rather than a cold install, and it misses 8,000 ms by roughly two times. What remains is implementation, not evidence: a build that reaches the criterion, and an observer-carrying artifact for the pump-silence bullet. Evidence: [prd-360-device-2026-09-07](../../verification/prd-360-device-2026-09-07/README.md), [prd-360-warmup-cache-2026-09-07](../../verification/prd-360-warmup-cache-2026-09-07/README.md).

**Latest repaired-game handoff (2026-09-07):** The corrected Bayview starts and moves on the Pixel; one retained-package run reached first frame at 16.020 seconds. This remains above the eight-second criterion. Continue with [the startup-cost raw material](../../verification/prd-360-startup-cost-2026-09-08/next-work-raw-material.md); older blocker notes below are historical.

**Latest bounded follow-up (2026-09-08):** A corrected validation of the existing object-granularity
path used the unchanged Bayview scene on a qualified Pixel 8. The explicit warm-up race is fixed:
one `TN_WARMUP` marker completed before first use, with no duplicate `TN_STARTUP_WARMUP` marker.
The run still reached first frame at **19,629.400 ms** and the movement endpoint recorded a
**5,560.916 ms** pump gap. Movement passed at **2.146682 m**, but the 8,000 ms and 250 ms criteria
remain unmet. PRD-360 stays PARTIAL; the raw receipt and red/green regression are linked from the
[follow-up verification record](../../verification/prd-360-warmup-cache-2026-09-07/README.md).

**Hardware A/B, 2026-09-08:** The launch's compile cost was censused on a physical Pixel 8 — 101
pipelines, 101 unique cache keys, **8,513 ms, all synchronous**, split main 67 / 7,477 ms, shadow
31 / 963 ms, PMREM 2 / 50 ms, output 1 / 23 ms, with no duplication to remove. The launch runs no
warm-up, because a DOM loading surface never declares the canvas covered. Turning the warm-up on
was measured and **rejected**: 20,988 ms returning `{"compiled":0,"abandoned":1,"timedOut":true}`,
and 15,028 ms on an earlier launch, against the baseline's 8,513 ms. Movement passes identically on
both arms at 2.1467 m. What remains is three's serial `compileAsync` walk, which is slower than the
synchronous compile it replaces. Evidence:
[pixel-census](../../verification/prd-360-startup-cost-2026-09-08/pixel-census.md),
[warm-up-rejected](../../verification/prd-360-startup-cost-2026-09-08/warm-up-rejected.md).


**All three levers measured and rejected, 2026-09-08:** every warm-up shape costs more than no
warm-up on this device — none 8,513 ms (complete), `scene` 15,028/20,988 ms, `object` with four
compiles in flight 15,012 ms with 45 abandoned. three's `compileAsync` is slower than the
synchronous compilation it replaces here, and the cost is JS-side per-object node building rather
than GPU pipeline creation. A persistent driver pipeline cache is not reachable from the pinned
wgpu-native C API. What remains is fewer distinct pipelines — 67 main-material pipelines cost
7,477 ms, and how many distinct materials the town needs is a game-side decision about how it
looks — and the ~84 ms per-pipeline Mali cost, which is outside this repository. **The eight-second
criterion is not reachable by framework-side compile scheduling.** Evidence:
[compile-concurrency](../../verification/prd-360-startup-cost-2026-09-08/compile-concurrency.md).


**Where the cost actually is, 2026-09-08:** the launch's 8,513 ms decomposes with nothing left for
the framework to take — **101 pipelines from 96 distinct shader programs**, at ~84 ms of Mali
compile each. Five programs are used twice and each sees one render state, so there is no
permutation to collapse. Scheduling cannot help (three shapes measured, all slower than no warm-up),
deduplication cannot help, and a persistent pipeline cache is unreachable from the pinned
wgpu-native. Reaching 8,000 ms from the measured ~10.9 s needs roughly a third fewer distinct shader
programs, which is an authoring decision about how the game looks. **The criterion is unmet and
gated outside `packages/`; this needs an owner decision on scope, not more framework work.**
Evidence: [pipeline-shapes](../../verification/prd-360-startup-cost-2026-09-08/pipeline-shapes.md).
**Owner:** [PRD-540](../performance/critical/PRD-540-the-compile-walk-leaves-the-main-thread.md),
**Canonical findings:** [runtime performance state](../../verification/runtime-perf-state.md),
especially “PRD-360 retry investigation — 2026-09-08.”
**Complexity:** MEDIUM, core/native/game boundaries. No new package or public API is planned.

## Decision and scope

Keep the original goal: median first playable within **8,000 ms over three qualified physical
Android cold launches**, and **no event-pump silence above 250 ms** through accepted movement.
There is no evidence that this is a hardware floor. There is also no evidence that cooking alone
can achieve it. Rebuild and measure a consistent current engine before choosing either conclusion.

Use the surviving Bayview scene as the workload, preserving its world, effects, UI, assets and
movement. The investigation subject is
`/home/joao/projects/threenative/sandbox/prd360-bayview-live`. Freeze its sources and original assets
before any build: its installed packages currently resolve into another game's node_modules.
Do not install into that shared dependency tree. The original `com.threenative.bayview` installed
baseline stays untouched; use a separate candidate application ID.

Distinguish an engineering build from consumer-distribution proof. A host built from identified
workspace source can diagnose startup, but cannot close the consumer release lane owned by
[PRD-078](PRD-078-toolchain-free-consumer-proof.md). Do not claim published
consumer acceptance from locally supplied native binaries. Persistent GPU pipeline serialization,
new mobile decoders and release publication are outside this bounded retry.

## What the investigation changed

| Finding | Consequence for the retry |
| --- | --- |
| The historical 49,788.7 ms median measures runner start through runner exit, including command traffic and teardown; the same record places first frame near 15 seconds | It is a conservative upper bound, not a 50-second game-start measurement. A failing upper bound cannot isolate game latency |
| Exact experiment-3 APK has 79 asset entries and zero applied pass lists; Bayview sets models/textures/audio to `"none"` | The manifest exists, but build-time optimization was disabled. Do not describe this as a fully optimized current workload |
| Current Android cooker disables KTX2/Meshopt output, but retains compatible model transforms and separate vertex buffers | Test supported model cooking independently. Removing `textures: "none"` cannot enable unsupported Android compressed textures |
| Warm-up's 494 count is material-identity/layout representatives; native stall counters record synchronous calls only | Do not compare 494 with 93/103 native creations or add warm-up duration to the residual |
| Current automatic warm-up checks `canvasLayer.opaque`; Bayview uses a web UI loading panel and no explicit warm-up in its present source | Verify which path actually runs. The ready-UI fallback experiment was reverted after regression; do not repeat it unchanged |

The installed core bundle differs from the local core build, but the latter was not rebuilt during
this inspection. Old tarball names and package versions alone cannot date installed bytes or the
measured APK. Require source, package and final artifact hashes. Findings and exact inspected
hashes live in the canonical performance record.

**Layer ownership:** the game owns cooking overrides, render construction and loading appearance.
Core owns readiness and warm-up scheduling. Native owns async completion, event pumping and
platform decoder support. Asset compilation owns target-compatible transforms. Name the measured
layer before editing; a multi-second game `enter()` is not repaired by tuning native worker count.

## Preserved evidence and failed experiments

| Subject | Observed result | Meaning |
| --- | --- | --- |
| Historical preserved baseline, three qualified runs | 49,788.7 ms coordinator-bound median; first frame about 15 seconds; missing pump observer | Historical failure, not current-source acceptance |
| Repaired candidate, September 7 | 16,020.007 ms first frame; 8,404.781 ms / 93 synchronous pipeline calls; movement 2.146719 m | One retained-package run, not three cold-install first-playable samples |
| Experiment 1: explicit warm-up | 16,151.642 ms first frame; timed out; 15,767.082 ms pump gap | Rejected |
| Experiment 2: ready UI counts as cover | 18,562.037 ms first frame; 13,515 ms warm-up; 2,665.103 ms pump gap | Rejected; `337a7d360` reverted |
| Experiment 3: two to four compile workers | 19,022.717 ms first frame; 14,007 ms warm-up; 2,618.676 ms pump gap | Rejected; native source restored |

The previous three-experiment budget remains exhausted; this retry begins with new attribution,
not a fourth worker/scheduler guess. Experiment 1 was the fastest of those three; experiment 2
was the faster of the two completed automatic-warm-up arms. None passed either acceptance gate.

Evidence to retain:

- [Qualified device record](../../verification/prd-360-device-2026-09-07/README.md) includes
  baseline decomposition and the warning about harness overhead.
- [Repair report](../../verification/findings-2026-09-07-bayview-fix/README.md),
  [identities](../../verification/findings-2026-09-07-bayview-fix/proof.json),
  [scenario](../../verification/findings-2026-09-07-bayview-fix/manifest.playtest.json) and
  [world capture](../../verification/findings-2026-09-07-bayview-fix/android-world.png)
  preserve the working candidate; its native binaries were reused, not rebuilt from that repair.
- [Warm-up host-turn/cache proof](../../verification/prd-360-warmup-cache-2026-09-07/README.md)
  records delivered progress. The opt-in localStorage marker is not serialized GPU pipeline data
  and a cache-hit relaunch cannot substitute for cold acceptance.
- [Observer and evaluator proof](../../verification/prd-360-startup-2026-09-05/README.md) and
  [batch ledger](../../verification/batch-2026-09-05-execution.md) retain scheduler negative
  controls and earlier Android transport/observer work. Old device-unreachable and missing-source
  notes are historical, not current blockers.
- [Browser dependency proof](../../verification/browser-dependency-identity-2026-09-07/README.md)
  passed four assertions on NVIDIA/Turing with 2.146736 m movement and clean diagnostics.
  It must be rerun after changing the game or dependencies.

Local experiment receipts remain under `prd360-bayview-live/artifacts/experiment-{1,2,3}-movement/`.
The retained experiment-3 APK SHA-256 is
`5f6ac0106868013437b97b00854e50ec69b8162187006cc2693378449b1855df`;
its bundle SHA-256 is
`b11c5753e1b7a4570dfb7e4bf176b52ebb59b89b73cbac9ea36332d69e33c7c0`.
Preserve these before rebuilding. Earlier repair artifacts were recorded under
`.worktrees/findings-asset-resolution/artifacts/findings-fix/`, game
`/home/joao/projects/threenative/sandbox/prd360-bayview-manifest-fix`, application ID
`com.threenative.bayview.manifestfix`. Their continued presence was not checked in this retry;
resolve ownership before accessing an old worktree. Do not clean up their evidence by assumption.

## Phase 1 — establish one current baseline and separate the clocks

**Outcome:** a reviewable provenance receipt and ranked critical-path breakdown. No performance
claim or optimization before this checkpoint.

1. Freeze the surviving game source/config/assets/scenario and retained APK. Record engine SHA,
   clean/dirty state, package realpaths and hashes, Three.js version/patch state, cooked manifest
   and each packaged native-library hash. Build core, assets, CLI, UI and host from one identified
   engine checkout into a separately installed sandbox dependency tree. Check the final APK,
   not only source timestamps. Resolve device readiness with the existing doctor; do not scan
   the network or assume an old serial is still valid.
2. Establish a current-source control with existing cooking overrides and unchanged visuals.
   Record all 57 requested logical assets resolving, 30 audio cues, model vertex layout,
   material/texture identity and loader/warm-up markers. Preserve React/ReactDOM and Three.js
   deduplication. Never restore the absent `raw-assets.manifest.json` override or rename
   changed model bytes under an existing content hash.
3. Use the existing collector/evaluator and playtest movement flow, adding only missing timing
   observations through those callers. Separate process launch, scene load, synchronous
   `Play.enter()`, warm-up, first world presentation, input acceptance/displacement and runner
   exit. Correlate host-clock endpoints; never subtract unrelated JavaScript/host clocks.
   Deliver three cold-install runs with explicit cache-reset policy and thermal qualification.
   Reinstallation does not prove the driver's global shader cache was erased; record that limit.
4. Reconcile warm-up wall time with native synchronous and asynchronous work. Count native
   async queue submissions, queue wait, worker execution and completion delivery separately
   from warm-up representatives. Find the remaining first-render synchronous descriptors and
   correlate pump gaps with scene construction, compilation and response handling. Overlapping
   spans are not additive; report unknowns rather than summing them into a fictitious total.
5. Select one lever with a predicted saving tied to its measured wall-clock interval. If no
   trustworthy lever emerges in 60 minutes of attribution work, stop with the missing observation
   and doubtful assumption. Do not spend another three experiments on stale/mixed artifacts.

**Measurement contract:** first frame alone is insufficient. Require visible world plus input-driven
horizontal displacement ≥0.25 m, tied to the exact post-input response. Exclude screenshot pull,
subsequent scenario commands and teardown from the first-playable endpoint. Retain the old
coordinator upper bound as a separate diagnostic. Extend the existing evaluator with negative
controls for mismatched APK, missing/stale endpoint, mismatched response bytes, mixed clocks and
delayed teardown; adding teardown delay must not change the host first-playable measurement.
A missing observation fails closed. Inspect the scripts' repository-root resolution before staging
them; the historical four-level staging assumption must not silently select another checkout.

## Phase 2 — one measured change per arm

Choose in this order of evidence, not as three changes to combine:

| Candidate lever | Read/edit boundary | Proof needed before selecting |
| --- | --- | --- |
| Supported model cook | Bayview config → `packages/assets/src/compile.ts` → `passes/model.ts` | Current control spends meaningful time decoding/building models; cooked Android output runs with the same geometry, clips, texture bindings and appearance. Keep audio unchanged; do not enable simplification or force unsupported codecs |
| Synchronous scene construction | Bayview `src/scenes/Play.ts:238`, town/soldier/effects callers; existing core setup mechanisms if shared | A host-correlated gap overlaps `enter()`; game phase logs alone are supporting evidence, not proof of that correlation |
| First-use compilation and pump | `packages/core/src/game.ts:1134`, `warmup.ts:462`; native `bindings_pipelines.cpp:727,1153` | Identify actual descriptors missed by warm-up or measured queue/completion stalls; distinguish shader construction from driver compilation |

Search engine capabilities and inspect every hit before introducing helpers or changing render
stages. Resolve final caller anchors at implementation time. Reuse existing setup, scheduler,
warm-up and playtest mechanisms. No new scheduler, bespoke profiler or appearance defaults.

Each experiment must have a baseline red, one bounded change, focused green, and an observed
revert control through the real caller. Build/reinstall from identified artifacts and run three
qualified candidate launches under the same workload/cache/device protocol. Preserve browser
movement and visual proof. Revert regressions; after three failed experiments stop and report
what assumption the results refuted. Do not repeat the rejected ready-UI-cover or worker-count
changes without a new measured mechanism.

## Phase 3 — acceptance and closure

- [ ] Three qualified physical Android cold-install runs: median host-correlated first playable
  ≤8,000 ms, visible authored world and horizontal input-driven movement ≥0.25 m.
- [ ] No pump gap >250 ms from startup through the movement response, including trailing silence;
  endpoint identity and response bytes agree. Missing or malformed evidence fails.
- [ ] Same scene, effects, source assets, render settings and device/cache policy across arms;
  any cooking transformation has content/appearance proof. Loading progresses and failures are bounded.
- [ ] Current candidate passes browser WebGPU movement/visual checks with actual adapter identity,
  focused red/green/revert controls, full repository gates and affected real playtests.
- [ ] Independent checkpoint review verifies callers, replaced paths, evidence and negative controls;
  update PRD-540 with this slice's delivered scope before marking this PRD complete.

An unchanged over-budget result does not establish a hardware floor. Hardware attribution requires
a controlled identified workload and a measured lower bound for the unavoidable work. If the owner
later retires the eight-second objective, record an explicit retirement and remaining defects;
do not mark acceptance passed. No such retirement was authorized by the consolidation request.

## Execution and handoff

Runtime changes require `pnpm typecheck && pnpm lint && pnpm test`, `pnpm build && pnpm budgets`,
and the affected real game playtests. Native behavior needs native proof; emulator results can
verify structure, not physical timing. Read the closest package instructions before editing.

Use existing commands after resolving the sandbox, application ID and device:

```sh
adb devices -l
node packages/playtest/dist/runner/cli.js doctor --text --device <serial>
node packages/playtest/dist/runner/cli.js docs/verification/findings-2026-09-07-bayview-fix/manifest.playtest.json --target android --device <serial> --package <candidate-app-id> --activity com.threenative.runtime.MystralActivity --timeout 60000 --artifacts <run-artifacts>
```

That movement scenario is functional proof, not the timing evaluator. Its 60-second timeout
does not change the eight-second acceptance budget. Coordinate physical device use and dismiss
the existing compatibility dialog before visual inspection. The authored dark loading panel is
expected while ready is false; hiding it does not fix startup.

**Current checkpoint:** code/artifact investigation and consolidation complete; no fresh build,
device timing or optimization executed. Phase 1 current-source baseline is NOT RUN; Phase 2 is
NOT RUN for this retry; Phase 3 is NOT RUN. Historical successes above retain only their original
scope. New performance findings update the canonical record in place.

**Next action (under two minutes):** open the surviving game's package.json and resolve its core
package realpath; use that dependency identity to begin the Phase 1 provenance receipt.
