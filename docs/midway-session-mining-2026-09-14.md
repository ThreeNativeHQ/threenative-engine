# Midway session mining: engine reuse and harness improvements

**Start with capability-discovery correctness, shared capture setup, and repeatable CPU-cost measurement.** These remove recurring investigation work using mechanisms ThreeNative largely already owns. Asset and humanoid tooling are the strongest larger reuse opportunities.

Prepared 2026-09-14 from local Codex, Claude Code, and OpenCode histories about `midway-open-pacific`. This is a research report; no implementation or runtime qualification was performed.

## Priority by effort × impact

Effort is estimated **engineer-days**, including focused verification, documentation, and adoption in Midway. Impact is a judgment on a 1–5 scale: **5** prevents misleading evidence or recurring failures across games; **4** removes substantial recurring authoring work; **3** fixes a narrower repeated problem. Priority = impact / midpoint of effort, descending. These are planning estimates, not measured savings; ties favor broader reuse. Native work assumes the existing target harness can run.

| Rank | Opportunity | Effort | Impact | Priority | Current disposition |
|---:|---|---:|---:|---:|---|
| 1 | Return the correct callable capability and a working example | 0.5–1 d | 5 | 6.67 | Confirmed discovery defect; existing manifest/checks to repair |
| 2 | Honor authored animation rate when automatic stride is disabled | 0.5–1 d | 3 | 4.00 | Source-supported defect candidate; reproduce first |
| 3 | Reuse one capture session: display, server, readiness, teardown | 1–2 d | 5 | 3.33 | Mechanisms exist; custom captures bypass them |
| 4 | Reuse deterministic CPU-cost and allocation investigation fixtures | 1–2 d | 4 | 2.67 | Game measurement exists; profiling recipe needs reuse |
| 5 | Put a native entry/UI smoke check at the first runnable game | 1–2 d | 4 | 2.67 | Build guard and target runner exist; move adoption earlier |
| 6 | Compare performance only across matched workloads and source bytes | 2–3 d | 5 | 2.00 | Strong game implementation; extract generic validation |
| 7 | Test real input transitions and a complete player journey | 2–3 d | 4 | 1.60 | Game examples exist; reusable authoring guidance missing |
| 8 | Supply inspectable VFX examples as generated render source | 1–3 d | 3 | 1.50 | Reuse particle mechanisms; keep appearance game-owned |
| 9 | Validate exported asset proportions, budgets, and active identity | 3–5 d | 5 | 1.25 | Several game tools exist; consolidate portable asset checks |
| 10 | Share the measured humanoid pipeline and deformation checks | 3–5 d | 5 | 1.25 | Explicit user reuse request; substantial implementation exists |

The first delivery slice is **#1, #3, and #4: approximately 2.5–5 engineer-days**. #6 then builds on their trustworthy capture and measurement paths. #9 and #10 share asset inspection but should remain independently reviewable.

## What was mined, and what was checked

| Source | Coverage | Evidence limitations |
|---|---|---|
| Codex | 22 matching JSONL files; excluded this research session; 21 historical files mined, all user turns read and relevant tool/assistant episodes sampled | Three early files were near-duplicate retries, counted once when interpreting recurrence. Images were not re-inspected. |
| Claude Code | 24 relevant sessions found: 19 in the game project, four in sandbox, one in engine; nine deeply sampled | Selected causal episodes; nested subagent transcripts were not fully mined. |
| OpenCode | 133 pre-cutoff sessions matching Midway directory/title; about ten causal episodes sampled; 149 sessions contained textual mentions | Many mentions were copied instructions. Counts are discovery coverage, not independent failures. |

Three separate OpenCode workers ran with `--auto --model opencode/muse-spark-1.3-contributor-free`. The installed model catalog had no Muse Spark 1.3 “Flash” identifier; the available free 1.3 model was used. Workers owned separate history stores and performed read-only exploration. The cutoff was **2026-09-14 20:49:21 UTC**, with this research and its workers excluded. Relevant episodes span September 13–14 UTC.

The parent checked selected original transcript lines/database parts, queried capability search/detail, and inspected the corresponding current implementation. Several worker proposals were corrected: ocean/VFX presets cannot become engine-owned appearance; existing trace, capture, tick, and readiness mechanisms must not be reinvented; a high p95 alone does not prove garbage collection.

Source inspection was against engine HEAD `70ba288d6289b2c3ccb75bd216347ec4ec0fb699` and sandbox HEAD `dbe94234bedf08c44266f081b199af30b342be52`, plus the live checkout files and Midway's installed manifest. These are audit coordinates, not a claim that every working file was represented by those commits. “Exists” below means inspected source, not a new passing test or released-package proof.

## 1. Make discovery return the right operation

**Evidence.** The OpenCode flight API investigation documented surprises such as throttle living on state and deck height being a construction option [O4]. During this audit, searching “run a browser playtest with Vulkan WebGPU” returned `reconcileBrowserPointers`; its detail describes Chromium arguments and gives an example calling `resolveBrowserArguments`, while its signature actually reconciles pointer maps. Searching deterministic tick steps similarly returns `invalidScenario`, an error factory, with a loader example. Both mismatches are present in the engine and installed manifests.

**Smallest change.** Correct the source metadata and extend the existing capability checks with focused search-to-operation cases. Verify that each curated example imports and invokes the intended public operation; do not accept merely nonempty tags. Expose the existing trace workflow through appropriate tooling guidance. Keep executable version/manifest identity visible so a source-tree capability is not mistaken for an installed one.

**Owner and proof.** `packages/create-threenative`, `packages/engine-mcp`, and the [existing documentation check](../scripts/check-capability-docs.ts). Relevant implementations are [browser.ts](../packages/playtest/src/runner/browser.ts) and [scenario errors](../packages/playtest/src/scenario/errors.ts). A fresh search should return a runnable browser setup or scenario operation with matching signature/example; the two observed wrong associations should fail the focused check. **Confidence: high.**

## 2. Respect the animation override before adding another workaround

**Evidence.** Midway documents that crew playback rates must be applied through each sailor's `dt`, because the animation wrapper resets action rate. The original rig session also explicitly requested reuse [C3]. Current [AnimationPlayer](../packages/core/src/animation.ts) still resets an action to rate 1 whenever measured clip ground speed is below its floor, before consulting `strideSync`; that branch reports `overridden: false`. The locomotion branch does honor `strideSync: false`.

**Smallest change.** Reproduce a non-locomotion clip with an authored playback rate and stride synchronization disabled. Make the override and its reporting consistent, then reassess the workaround in `deck-crew.ts`. Do not change authored choreography or invent a new animation abstraction.

**Owner and proof.** Core animation mechanism. One regression for disabled synchronization retaining the authored rate; preserve existing locomotion behavior and verify the crew clips in the real game. Use existing native animation conformance for a portable claim. **Confidence: medium-high: branch inspected, runtime reproduction not run.**

## 3. Route custom captures through the existing runner lifecycle

**Evidence.** Claude's ocean session encountered `ERR_CONNECTION_REFUSED`, then a **180,000 ms** wait for `#loading.hidden` [L1]. These are observed tool errors. The game has its own `capture-lock.sh`, while many capture scripts launch Playwright directly. Current engine [captureEnvironment.ts](../packages/playtest/src/runner/captureEnvironment.ts), [browserSession.ts](../packages/playtest/src/runner/browserSession.ts), [captureLock.ts](../packages/playtest/src/runner/captureLock.ts), and [startupReady.ts](../packages/playtest/src/runner/startupReady.ts) already handle much of this infrastructure.

**Smallest change.** Adopt the runner where its scenarios suffice; expose the narrow existing session lifecycle to custom capture tools where needed. Reuse the engine startup signal, dependency/server diagnostics, private display, adapter evidence, queue status, cancellation, and owned-process cleanup. Replace copied setup in two Midway captures to prove the benefit. Avoid teaching every capture a new DOM loading selector.

**Owner and proof.** `packages/playtest`. Dead server and missing readiness should produce distinct bounded diagnostics; timeout/cancellation must release owned resources; competing captures must report contention separately from assertion failure. Respect the user's no-visible-desktop rule. A private-display image capture is not automatically a valid FPS benchmark: the existing trace tool explicitly withholds frame-rate claims for that environment. **Confidence: high.**

## 4. Reuse CPU-cost fixtures and measure allocation causes

**Evidence.** An OpenCode task reported that flight checks went from seconds to minutes after aircraft adopted `FlightModel` [O1]. Another task supplied mean **2.516 ms** and p95 **5.413 ms** at 68 aircraft, asserting a GC cause; the worker's subsequent investigation found different dominant callers, noisy results, and an initially unsuitable heap-profile aggregation [O3]. These are historical reports, not independently rerun measurements. The lesson is to make attribution repeatable before delegating a fix to a presumed file.

**Smallest change.** Reuse `check-ai-flight-cost.mjs` as a compact fixture pattern: fixed population/seed/ticks, warmup, per-step distribution, and clearly separated setup cost. Add one bounded allocation-sampling recipe using the existing runtime/profiler facilities. A p95/mean ratio should trigger investigation, not a declared GC diagnosis. Keep the population and battle setup in the game; put a representative repeated-`FlightModel.step` regression beside the engine implementation.

**Owner and proof.** Core performance tests plus playtest/performance guidance, using [FrameBudget](../packages/core/src/frame-budget.ts) and the existing [trace tool](../packages/playtest/src/runner/trace.ts). Prove a deliberately more expensive fixture is detected; match the workload across repeated baseline/candidate runs; make setup and measured intervals explicit. This adds an investigation recipe, not a second profiler. **Confidence: high for the workflow gap; medium for historical hotspot attribution.**

## 5. Exercise the native entry while the game is still small

**Evidence.** A Claude session began with `pnpm build:desktop` failing `TN_NATIVE_WEB_ONLY_UI` [L2]. Current [build.ts](../packages/create-threenative/src/build.ts) already rejects the relevant web-only UI patterns, and [the playtest runner](../packages/playtest/AGENTS.md) already supports native targets. A replacement lint framework or automatic UI rewrite is not justified by this episode.

**Smallest change.** Make the first runnable-game workflow exercise its portable entry and one native UI/input smoke scenario. Show the expected split between `src/game.ts` and browser mounting in a working template. Run the existing build guard early, then prove that the menu can actually be used on the target.

**Owner and proof.** Template source and harness guidance. The web-only import should fail before substantial gameplay work; the corrected game must launch and accept a real menu action under `--target desktop`. Desktop evidence does not qualify Android or iOS. **Confidence: high for earlier reuse; current Midway native completion was not audited.**

## 6. Extract matched performance validation, not Midway's benchmark rules

**Evidence.** An OpenCode review found that a “matched baseline” checked only the adapter, and reduced resolution or duration could still print the full performance verdict [O2]. That game tool now contains workload matching, finite-series validation, qualification reasons, and separate full update/render CPU series. It is **1,388 lines** at inspection. Another OpenCode investigation discovered that its baseline had removed a different agent's edits, contaminating the comparison [O3].

**Smallest change.** Reuse the generic validation around finite observations, matching metadata, source identity, warmup, and qualified-versus-diagnostic results. Keep Midway's 68-aircraft requirement, simulation setup, and acceptance thresholds in the game. Serve a stable build or disable HMR and detect source changes across the run. Hash relevant contents, including untracked inputs, rather than only recording their filenames. Honor the task's selected branch/worktree; do not automatically move work into another checkout.

**Owner and proof.** Extend existing playtest performance/trace facilities, drawing from `capture-performance.mjs`. Reject mismatched seed, resolution, quality, duration, population, or missing/nonfinite metrics; mark source changes as invalid evidence. Compare both arms over the same simulation workload and report wall time separately. The `current performance PRD` still leaves matched improvement/qualification requirements open; do not report them as won. **Confidence: high.**

## 7. Turn control complaints into real player-journey regressions

**Evidence.** A Codex session reported continued climb and stall after releasing a pitch key, followed later by concern about mouse steering interference [C1]. Midway already has `check-repair.mjs`, `capture-sortie.mjs`, and `capture-sortie-runs.mjs`. These are better starting points than a new mission-testing framework.

**Smallest change.** Document reusable scenario patterns for press/hold/release, competing input sources, visible readiness cues, and a complete player journey. Prefer fixed ticks and public input; use explicit setup fixtures only when the test is about an isolated subsystem. A cue such as “ready” should be checked against the same operation it promises.

**Owner and proof.** Harness input/observation mechanics and generated test examples. Midway retains its trim policy, sortie scoring, recovery envelope, and mission logic. Prove input release/arbitration and a launch-to-return run without outcome injection. Current [steps.ts](../packages/playtest/src/runner/steps.ts) already converts frame aliases to fixed ticks when the bridge advertises that capability; the historical “frame aliases never advance” warning is not a new engine defect to implement. **Confidence: high.**

## 8. Reuse VFX source examples and visual review states

**Evidence.** The player called the wing muzzle flare disproportionate [C1], and later reported overly reflective water and a horizon discontinuity [L1]. Claude's VFX session also produced an actual column-height assertion failure [L3]. The latter does not establish GPU variance or justify relaxing its threshold.

**Smallest change.** Supply small generated `src/render/` examples using existing particle mechanisms, with explicit dimensions, game-owned parameters, and reproducible inspection views. Pair visual frames with meaningful geometric/state measurements and a human look at the result. Preserve a failing visual assertion until its intended rule and cause are understood.

**Owner and proof.** Template render source plus existing capture/visual tooling. The charter says anything deciding appearance belongs in generated source. No package-owned muzzle-flash, ocean, flame, or historical-art preset. Verify that a game can completely change the look without package edits, and inspect captures at the actual weapon/ship scale. **Confidence: high for authoring need; medium for the best example set.**

## 9. Inspect the exported bytes and the asset actually in use

**Evidence.** Codex contains repeated user reports of squeezed proportions, a request for uniform scaling, and a complaint that the old Kaga export was still visible [C2]. An OpenCode import investigation attributed a ineffective simplification pass to bitwise welding of UV-split vertices [O5]; the current `aircraft importer` records and addresses that case. This is not an instruction to weld every model by distance.

**Smallest change.** Extend existing asset compilation/health inspection with declared proportional-scale and output-identity checks, measured triangle/texture budgets, and before/after inspection captures. Report when an optimization changed no useful geometry. Verify runtime-manifest references against the newly exported asset. Use `check-fleet.mjs`, `check-catalog.mjs`, and the measured import tables as the concrete extraction sites.

**Owner and proof.** Existing assets tooling, not a new package or proprietary scene format. Generic measurements are reusable; historical dimensions, semantic bow direction, repair decisions, and acceptable visual error remain authored inputs. Test a deliberately distorted export, an over-budget result, and an old referenced output. An identity-scale output transform alone cannot prove preserved proportions after geometry was baked. **Confidence: high.**

## 10. Share the humanoid pipeline already requested and built

**Evidence.** The original Codex rig session described broken hands and tearing, then explicitly asked for reuse with similar humanoids [C3]. The game now has a **336-line** `rig_humanoid.py`, a **183-line** `check-humanoid.mjs`, and a `fitting guide`. This is an adoption/extraction opportunity, not a blank-sheet rigging project.

**Smallest change.** Share the measured fitting procedure and configurable deformation checks through existing asset tooling. Keep anatomy measurements, required clip names, rigid-versus-articulated hand policy, and authored motions beside each asset. Reuse `SkeletalMesh3D`, `measureThreePose`, and existing clone/binding validation instead of adding a second runtime rig wrapper.

**Owner and proof.** Offline assets/Blender tooling plus template guidance. Demonstrate reuse across sailor, pilot, and director; inspect posed bounds, finger influences, seams, stretched triangles, and contact sheets of representative clips. Keep ground/bounds checks distinct from bone-height proxies and avoid expensive per-vertex checks inside the frame loop. Require a native target case for any newly introduced runtime mechanism. **Confidence: high that useful shared source exists; broader model coverage remains unproven.**

## Reuse now: avoid reopening work already present

| Existing mechanism or fix | Current evidence | Remaining qualification |
|---|---|---|
| Engine flight dynamics | `Game adapter` imports `FlightModel` and passes game-owned airframes/deck data | Improve discovery and cost regression coverage; do not add another integrator or bake Midway trim/AI policy into core |
| Wave height and ripple optimizations | Engine commits `326ccf219` and `70ba288d6`; `current game PRD` records scalar height and idle-ripple work | Matched overall performance claims remain open in that PRD |
| Shadow binding and adaptive resolution fixes | Engine commits `6d529638f` and `e9bcf80a2`; the historical blur complaint is [C4] | Verify consumption of the fixed package before proposing another fix or hardcoded resolution override |
| Frame meters and CPU trace attribution | [FrameBudget](../packages/core/src/frame-budget.ts), [perf.ts](../packages/playtest/src/runner/perf.ts), [trace.ts](../packages/playtest/src/runner/trace.ts) already exist | Improve discovery and workload qualification; trace display restrictions must stay explicit |
| Capture lifecycle, tick execution, pose inspection | Existing runner lifecycle, [steps.ts](../packages/playtest/src/runner/steps.ts), [pose-measure.ts](../packages/core/src/pose-measure.ts), and [skeletal-mesh.ts](../packages/core/src/skeletal-mesh.ts) | Migrate custom callers and test the specific override gap; source presence is not adoption proof |

## Boundaries and lower-priority ideas

Gameplay stays in Midway: sortie weapon stamping, observed-hit credit, carrier launch cadence, recovery envelopes, AI tactics, and briefing/debrief policy. Ocean materials, cockpit glass, flare shape, crew choreography, and HUD composition stay in game/generated render source. Every extraction should delete its game duplicate and pass the charter's total-code-cost comparison; an unused shared helper is not a successful lift.

The audio-orphan request [C5] supports checking declared assets against actual use. Start with existing manifests and health tooling; arbitrary dynamic JavaScript references make a universal “unused assets” scanner unreliable. Similarly, reuse the intent of `run-handoff.sh`—keeping runnable checks discoverable—without turning arbitrary prose shell blocks into a general engine execution protocol.

OpenCode's oversized search-output and temporary-image permission failures were also found. They are agent-tool configuration issues with weaker evidence of an engine gap, so they do not outrank the concrete game/harness work above. No new blanket permission defaults are recommended.

## Evidence index

Local transcript links are audit pointers on this machine. OpenCode references identify rows in `~/.local/share/opencode/opencode.db` (`part.id` and associated session). Tool-result messages are distinguished from player feedback; assistant diagnoses and coordinator task assertions are not treated as independently measured facts.

| ID | Original source | What it supports |
|---|---|---|
| C1 | Codex [pitch release, line 69](/home/joao/.codex/sessions/2026/09/13/rollout-2026-09-13T10-15-13-01a09bc4-1372-7d53-b410-860b3ae987e1.jsonl:69), same session lines 89 and 1344; 2026-09-13 UTC | Direct player complaints about control release, muzzle scale, mouse interference |
| C2 | Codex [asset proportions, line 91](/home/joao/.codex/sessions/2026/09/13/rollout-2026-09-13T16-04-39-01a09d03-fe15-7aa1-951a-423fce963cbf.jsonl:91), same session lines 1062 and 1144; September 13–14 UTC | Direct player requests for uniform proportions, visual checking, current exported assets |
| C3 | Codex [rig request, line 11](/home/joao/.codex/sessions/2026/09/13/rollout-2026-09-13T13-37-53-01a09c7d-9de7-76d3-afd0-118026556f30.jsonl:11), reuse request line 455; September 13 UTC | Broken-hand/tearing report and explicit reusable-humanoid request |
| C4 | Codex [blur/defaults, line 228](/home/joao/.codex/sessions/2026/09/14/rollout-2026-09-14T10-48-26-01a0a108-d818-73c3-9437-76ca5e0bffa4.jsonl:228); September 14 UTC | Direct concern about replacing automatic resolution with a constant |
| C5 | Codex [audio orphan check, line 366](/home/joao/.codex/sessions/2026/09/13/rollout-2026-09-13T20-32-27-01a09df9-2c78-79d3-8da1-ee0e5a371a39.jsonl:366); September 14 UTC | Explicit request for automatic orphan detection |
| L1 | Claude [ocean feedback, line 9](/home/joao/.claude/projects/-home-joao-projects-threenative-sandbox-midway-open-pacific/d7e933b6-f4b1-4fb6-a2b3-cba85d5304f4.jsonl:9), tool results lines 94 and 154; September 14 UTC | Player visual feedback; observed refused connection and 180-second selector timeout |
| L2 | Claude [native build task, line 5](/home/joao/.claude/projects/-home-joao-projects-threenative-sandbox-midway-open-pacific/92e6f65e-d0d3-4de4-86ff-dec7b2237b19.jsonl:5); September 13 UTC | Task reports `TN_NATIVE_WEB_ONLY_UI`; current guard inspected separately |
| L3 | Claude [VFX tool failure, line 248](/home/joao/.claude/projects/-home-joao-projects-threenative-sandbox-midway-open-pacific/f2c1f5ca-a5df-4157-bb58-51a7fe3a7bae.jsonl:248); September 14 UTC | Actual geometric assertion failure; does not establish that the test was wrong |
| O1 | OpenCode session `ses_f61f8b44affeJBYWqp94pqlPk7`, part `prt_09e074c37001Qz8vqENUeU7dfe`; September 14 UTC | Coordinator report of flight-cost regression and request for measurement |
| O2 | OpenCode session `ses_f6218dc2bffeBJxWjIsUg6Epqf`, part `prt_09debc3a60014X0oWsv8HRD5yK`; September 14 UTC | Review identifies baseline/qualification false-pass risks; current code checked for subsequent safeguards |
| O3 | OpenCode session `ses_f61d76084ffebrQOmTXqw7CX1P`, parts `prt_09e28a0030018EAoW1mFG0r2kp`, `prt_09e2ce128001zR1EkQzn69IYD1`, `prt_09e360771001VwARXWgMvSylMU`; September 14 UTC | Task's claimed GC diagnosis; assistant's profiling limitations and discovery of contaminated baseline |
| O4 | OpenCode session `ses_f6319630fffeZF2KnQp69ohltn`, part `prt_09ce7c07f001QpKbsjZzQTho74`; September 13 UTC | Assistant's flight API inventory; current adapter inspected separately |
| O5 | OpenCode session `ses_f61c4070bffeoqyS1kel5W0kDN`, part `prt_09e4718c6001rEHrqVHjIJlDE2`; September 14 UTC | Assistant's weld diagnosis; current importer independently corroborates the documented repair |

**Verification performed:** original-source spot checks, current capability search/detail, targeted code inspection, and document/link/ranking checks. No game tests, browser captures, asset rebuilds, or native runs were performed for this report. Historical timings and claimed fixes retain the limitations described above.

**Next action, under two minutes:** open the `reconcileBrowserPointers` entry in [capabilities.json](../packages/core/capabilities.json) and compare its signature with its example. That is the smallest confirmed issue to turn into an implementation task.
