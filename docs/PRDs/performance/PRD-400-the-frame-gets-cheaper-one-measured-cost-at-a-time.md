---
prd_contract: v1
---

# PRD-400 — The frame gets cheaper one measured, removable cost at a time

**Status:** IN PROGRESS
**Priority:** P1 — Active campaign: one measured cost at a time with native and Pixel 8 acceptance.
**Progress:** 0/5 phases (Phase 1: skill and judge plumbing landed; live baseline pending)
**Complexity:** 7 → HIGH; 11+ implementation files across core, the three.js patch, the native
recorder and the C++ replay (+3), retained projection and command-plan state (+2), crosses the native
host build (+2); risk override: none.
**Owner:** Engine performance agent, executing through the `perf-loop` skill Phase 1 creates.
**Rescue note (2026-09-25):** PR #289 was reconciled onto current `develop` after 51 commits of integration drift. The previous Windows native qualification failed in the PRD-400 production collector while rebuilding its staged platformer: Vite/Rolldown rejected the generated `.threenative-ui-*.html` path from the Windows OS temp volume. Normal Windows desktop packaging in the same job was green. The collector now stages repository qualification under the checkout's `.runtime/` volume, preserving the authored web UI and the newer prebuilt-runtime/window-size fixes from `develop`. The failing Windows job is the RED; latest-head Windows qualification is the GREEN gate and remains pending until CI runs.
**Depends on:** nothing to start. Absorbs, never repeats: [PRD-388](critical/PRD-388-an-automatic-optimizer-must-price-its-own-cost.md)
(projection prices its own cost), [PRD-389](critical/PRD-389-the-frame-budgets-instruments-do-not-lie.md)
(instrument honesty), PRD-395/396 (render-phase attribution, branch-only), and
[native compiled frame plans](PRD-native-compiled-frame-plans.md) (recorder transport). Hands lanes
4–6 to their owning PRDs (see *Out of scope*).
**Source:** a code-informed prioritization the owner supplied on 2026-09-22, inspected at
`develop@fac2f7149`. It ranked systems from reading code; it measured nothing.

## Outcome

Games get faster without doing anything: same scene, same pixels, same settings, less CPU per frame
on native and in the browser. The work runs as a loop — measure, attribute, change one thing, prove
nothing broke, keep or reject on a repeated A/B — instead of a string of one-off optimizations whose
effects never add up in a real game.

The loop is a skill, `perf-loop`, and it outlives this PRD. This PRD is its first campaign: build the
judge, then work lanes 1–3 in order — scene projection → three.js CPU bookkeeping → frame recording
and native replay. That chain decides how much work reaches the GPU and what each unit of it costs.

## What is already known — start here, do not rediscover

| Fact | Number | Source |
| --- | --- | --- |
| Midway native desktop is CPU-bound | 1280×720, `sampleCount 4`: 38.7–41.3 fps, frame p50 21.4–22.9 ms, render p50 17.1–18.3 ms, GPU 2.1–2.7 ms | `docs/verification/runtime-perf-state.md`, 2026-09-17 |
| The render phase is per-draw work | 87% per-draw loop, 14% traversal, 1% sort; **8.9 µs/draw**, **0.87 µs/object**; `bindings.updateForRender` is 26% of render | PRD-395 on `fix/native-perf-followups@203663671`, not on develop |
| Traversal is a small prize | static-transform freeze recovers 0.009 ms on 1,561 objects; the whole traversal prize is ≤ ~1.4 ms | PRD-396, same branch |
| Predicted draws misprice the projection | on Midway it cost 1.378× callback time and +4.2–5.1 ms of reconcile; draws fell 527 → 194 while shadow/reflection cameras could no longer cull its batches | PRD-388 |
| Admission still uses the plan, not the frame | `MIN_BATCH_MEMBERS = 4`, `WORTHWHILE_DRAW_RATIO = 0.75`; `drawsPlanned` is documented as optimistic because a `BatchedMesh` issues one `drawIndexed` per visible member on WebGPU | `packages/core/src/projection-plan.ts:38,52`; `renderProjection.ts:96-104` |
| A smaller packet is not a faster game | compiled frame plans cut recorder cost 43–45% and packets 94.8–99.5% on draw-heavy frames | native compiled frame plans PRD |
| `profile:native-cpu` is a browser tool | Playwright Chromium; diagnoses shared costs, never the native verdict | `scripts/profile-native-cpu.ts:6` |

**Already implemented — never a loop proposal:** projection scan-workspace reuse, matrix compares, slot
reuse and growth headroom, and the `renderer.projection = false` opt-out; the three patch's
source-material tracking and previous-frame velocity data; the recorder's retained records,
skip-unchanged, buffer rotation and adaptive plan selection with a 32-frame retry backoff
(`frame-op-stream.js:17`); off-thread image decode (4 workers, 512 queued, 8 completed results,
`async_image_decode.cpp:24-28`); pipeline-cache persistence.

## Solution

### The loop

```mermaid
flowchart TD
  A["Pinned baseline<br/>commit + built host + workload"] --> B["Measure on the judge"]
  B --> C["Attribute the frame<br/>projection · three CPU · recorder · replay · present wait"]
  C --> D["One hypothesis on the largest removable term<br/>small file scope"]
  D --> E["Capability search, then one candidate commit"]
  E --> F["Affected specs + lane mutation cases + playtest"]
  F -->|red| R["Reject: revert, ledger row"]
  F -->|green| G["Paired A/B, repeated<br/>outside the A/A noise band?"]
  G -->|no| I["Inconclusive: revert, ledger row"]
  G -->|yes| H["End to end: matrix cell + Midway native"]
  H -->|win vanishes| I
  H -->|win holds| K["Keep: commit + ledger row"]
  K --> B
  R --> C
  I --> C
```

### The judge — built once, frozen per lane

- **Tool:** `pnpm profile:production`. It already pairs arms, repeats, warms up, cold-starts, records
  source provenance and runs the `--control slow-native` negative control. It only knows the
  scaffolded platformer (`profile-production.mjs:299`), so Phase 1 teaches it to take an existing
  project and scenario. No new benchmark framework.
- **Tuning matrix:** `examples/engine-load-test`, which already runs on web, desktop and Android.
  Phase 1 adds axes: shared vs unique geometry and material, hierarchy depth, visible fraction,
  mutation rate (0, 1% and 10% of objects per frame), shadow-caster share and pass count. The default
  axes reproduce today's scene, so `positionHash` and the Godot port stay equivalent.
- **Representative game:** `sandbox/midway-open-pacific`, native desktop packaged build and browser.
  Reinstall its tarballs after each keep and verify the installed bytes before trusting a number.
- **Holdouts, never tuned against, run only at lane end:** the scaffolded platformer
  (`profile:production`'s default) and one more sandbox game, named in Phase 1 before the first
  candidate and never swapped.
- **Attribution:** five terms per frame — projection reconcile (`timings.reconcileMs` on the
  projection report), three.js CPU, recorder JS, native replay, present/GPU wait. Existing meters
  first (`TN_FRAME_BUDGET`, the projection report, `TN_HOST_GAP`'s replay split, recorder counters,
  `TN_JS_CPU_PROFILE`). Salvage PRD-395's `packages/core/src/profiling/Spans.ts` and `span-probes.ts`
  from `fix/native-perf-followups` only for a term those meters cannot name.
- **Noise band:** an A/A of the same build, per metric and per lane. Every A/B records each arm's
  build hash and asserts the hashes differ.
- **Recorded on every run:** frame p50/p95/p99, render p50, the five terms, measured draws, render
  objects processed, uploaded bytes, allocations/GC, long frames over twice the frame budget.

### Loop rules — the skill carries these verbatim

1. **The candidate cannot change the evaluator.** Frozen per lane: `profile-production.mjs`,
   `production-evidence.mjs`, `examples/engine-load-test/src/workload.ts`, the scenarios, playtest
   assertions and budgets. `git diff --name-only <baseline>..HEAD -- <frozen paths>` must be empty for
   a candidate. Changing the judge is its own commit and re-baselines the lane.
2. **No quality moves.** Resolution, `resolutionScale`, `sampleCount`, content, quality tier, post
   chain and shadow maps stay fixed. A change beyond the visual noise floor is rejected.
3. **A local win must survive end to end.** Microbenchmarks and span deltas diagnose. Keep needs the
   matrix cell and Midway native to move outside noise, with no other recorded metric regressing
   outside noise.
4. **The loop rejects its own work.** Neutral or noisy is `inconclusive`: recorded, reverted, next.
5. **Two failures with the same cause** → stop editing, re-attribute, re-plan.
6. **Lane stop:** move on when three consecutive candidates in a lane are rejected or inconclusive
   and no single removable term in it exceeds the noise band, or when the lane's term falls below 10%
   of the frame.
7. **Layer:** every change is mechanism in `packages/` or the three patch — never game code, never
   `src/render/`. A path both runtimes share is measured on both.
8. **Capability search before any new file under `packages/`** (engine `AGENTS.md`, rule 1).
9. **Commit per candidate** in the lane's worktree, revert a rejected one with `git revert`, and stage
   by path: the shared checkout carries other agents' WIP.

### Cadence — what runs when

| When | Runs |
| --- | --- |
| Every candidate | affected `<package>/__tests__` specs; the lane's mutation cases; paired A/B on one native desktop matrix cell |
| Every keep | the lane's playtest; Midway native desktop steady state via the `measure-steady-state-fps` skill; the same cell in the browser on a real adapter (`--browser-recipe webgpu`, `adapter.info` checked) |
| Every third keep, and at lane end | `pnpm typecheck && pnpm lint && pnpm test`; `pnpm test:playtest`; `pnpm test:templates`; `pnpm parity` when `runtime-native` changed; `pnpm visuals:ab`; both holdouts |
| Lane end | Android: Pixel 8 for any FPS verdict, the emulator for correctness only |
| Campaign end | `native-platforms.yml` dispatched on the PR head (iOS, macOS, Windows correctness) |

### Ledger

One section in `docs/verification/runtime-perf-state.md`, *Performance loop — PRD-400*, because
runtime/core performance findings update that file in place (owner policy, 2026-08-27). One row per
candidate, rejected ones included: id (`L1-03`), hypothesis, files, target metric
baseline → candidate with its noise band, other metrics, verdict, commit. Boxes below cite row ids.

### Lane 1 — scene projection

`packages/core/src/renderProjection.ts`, `projection-plan.ts`, `projection-apply.ts`.

It changes *how much* work three.js receives, not how cheaply each piece runs, so it goes first. First
experiment: an unchanged 10,000-object cell against the same cell with 1% mutating per frame; split
the remaining cost into classification, matrix propagation, mirror updates, renderer traversal and
draws, and attack only the largest. Then the cost-model question: does `drawsPlanned` predict the work
that actually disappears, counting the shadow and reflection passes? With per-draw work at 87% of
render and batches drawing per member, expect admission to need the measured frame — PRD-388's rule —
but the numbers decide. A keep that implements PRD-388 ticks PRD-388's boxes too.

Mutation acceptance: spawn, despawn, material swap, reparent, capacity growth, a batch culled by the
shadow camera, background/environment rotation.

### Lane 2 — three.js CPU bookkeeping

`patches/three@0.185.1.patch`, applied through `pnpm-workspace.yaml:33`.

Hold object count constant; vary material diversity, shadow-caster mix and pass count; diff CPU
profiles. The starting mass is `bindings.updateForRender` at 26% of render. The question: which render
decisions are recomputed while their inputs have not changed? Changes stay narrow, shared by web and
native, and never suppress updates wholesale. Acceptance: material replacement, alpha-tested shadows,
skinned animation and velocity/TRAA previous-frame state — a static screenshot cannot catch the last.

### Lane 3 — frame recording and native replay

`packages/runtime-native/src/runtime-scripts/frame-op-stream.js`,
`src/webgpu/bindings_frame_stream.cpp`, `src/webgpu/bindings_commands.cpp`.

Measure recording, plan maintenance and replay separately, optimize their sum. Command shapes: stable,
changing transforms, changing bindings, frequent resource creation, upload-heavy. Compare the v1/v2
reference transport with automatic plan selection. The first experiment answers whether the remaining
cost is JavaScript recording or native replay, which decides where the next change goes. Protect the
`mapAsync` safe-submission boundaries, readbacks and resource lifetime.

### Out of scope — lanes 4–6

Resources, uploads and pipeline compilation (PRD-368, PRD-370, PRD-387), asset loading and decode
completion (PRD-360), native scheduling and presentation (PRD-222). They need their own scorecards —
startup, first-use stalls, long frames, input latency — which average frame time does not measure.
The loop re-profiles after every keep; when the dominant removable term moves into one of these, it
records the number and hands it to the owning PRD instead of following it. A warm-cache startup win
is never reported as a steady-state win.

## Acceptance criteria

- [ ] AC-1 [local; actor: agent]: A fresh subagent given only the `perf-loop` skill and this PRD runs
  one full iteration unassisted and writes a valid ledger row — Evidence: 2026-09-23 fresh-agent
  attempt stopped before a candidate: the pinned baseline, A/A band and complete five-term attribution are
  still absent, the shared GPU/CPU was in use, and every RTX 2080 DRM connector was disconnected.
  No candidate ledger row was written.
- [ ] AC-2 [local; actor: agent]: Midway native desktop at 1280×720, `sampleCount 4`, identical
  content: frame p50 at least 20% below the pinned Phase 1 baseline, outside the A/A noise band, p95
  no worse — Evidence: pending.
- [ ] AC-3 [local; actor: agent]: Midway in the browser on a real WebGPU adapter: frame p50 no worse
  outside noise, improvement recorded — Evidence: pending.
- [ ] AC-4 [local; actor: agent; needs the Pixel 8 attached]: the engine-load-test matrix cell on
  Pixel 8 via its Android runner: steady-state frame p50 no worse outside noise, improvement
  recorded — Evidence: pending.
- [ ] AC-5 [local; actor: agent]: both holdouts — the platformer through `profile:production` (web
  and `desktop-pair`) and the named sandbox game — no worse outside noise — Evidence: pending.
- [ ] AC-6 [local; actor: agent]: nothing broke on the final head: `pnpm typecheck && pnpm lint &&
  pnpm test`, `pnpm test:playtest`, `pnpm test:templates`, `pnpm parity`, `pnpm visuals:ab` within
  its noise floor, and every lane playtest green — Evidence: pending.
- [ ] AC-7 [shared; actor: agent dispatches, CI runs]: `native-platforms.yml` green on the final PR
  head for iOS, macOS and Windows correctness (not performance) — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Judge measures any project | `pnpm profile:production` with a project and scenario → `profile-production.mjs` argument parser | extends; the scaffolded platformer stays the default | Phase 1 |
| Workload matrix | engine-load-test browser/desktop/Android runners → `examples/engine-load-test/src/workload.ts` | extends; default axes reproduce today's scene | Phase 1 |
| Projection changes | the game frame → `SceneRenderProjection.reconcile()` at `packages/core/src/game.ts:1016,1354,1623` | in place | AC-2, Phase 2 |
| three.js bookkeeping | `pnpm install` applies `patches/three@0.185.1.patch` → three's renderer | in place | AC-2, AC-3, Phase 3 |
| Recording and replay | native frame boundary → `frame-op-stream.js` → `bindings_frame_stream.cpp` | in place; v1/v2 stays the automatic fallback | AC-2, Phase 4 |
| The loop | an agent invokes `/perf-loop` | new skill | AC-1 |

## Execution Phases

Work runs in `.worktrees/prd-400-perf-loop/`, branched from `develop`, with one draft PR to
`develop` opened before Phase 1. Run `pnpm prd:progress` on this file before starting and after each
phase.

### Phase 1 — The judge and the skill exist before any optimization

**Status:** IN PROGRESS
**ACs:** AC-1
**Files:** `.claude/skills/perf-loop/SKILL.md` (new) and its `.agents/skills/perf-loop` link;
`packages/runtime-native/scripts/profile-production.mjs` (project and scenario input);
`examples/engine-load-test/src/workload.ts`, `game.ts` (matrix axes); the ledger section in
`docs/verification/runtime-perf-state.md`; salvaged span files only if the attribution box needs them.
**Verification:** `pnpm check:docs` plus the instruction-budget and `sync-agent-docs` specs for the
skill; the engine-load-test equivalence spec for `positionHash`; the judge's own sensitivity controls.

- [x] Judge accepts matrix cells and Midway; `positionHash` unchanged at the default axes —
  desktop matrix mutation 0 and 1% both reported `992067d3` (`L0-07`); web Midway preflight
  returned `PASS` on NVIDIA/Turing with 900 samples; clean native launch preflight returned `PASS`
  with all six assertions, `airborne: true`, altitude 22 → 55 and IAS 19 → 55 (`L0-08`).
- [ ] Five-term attribution closes to at least 95% of the native desktop frame on one matrix cell and
  on Midway.
- [ ] A/A noise band and pinned baseline recorded as ledger rows `L0-*`: matrix cells, Midway native
  and browser, both holdouts named and measured.
- [ ] Judge sensitivity: `--control slow-native` and a resolution-cut candidate both come back
  `reject`.
- [x] Skill written and linked; docs, instruction-budget and `sync-agent-docs` checks green —
  `.claude/skills/perf-loop/SKILL.md`, `.agents/skills/perf-loop` symlink; `pnpm check:docs` (2,199 links),
  `check-doc-links`, `sync-agent-docs`, `evidence-budget` specs 29/29, `instruction-budget` 9/9, 2026-09-22.

**Checkpoint:** Project/scenario staging, workload axes and projection timing markers are on
`perf/prd-400-ac1`; the staged judge preserves the game's automatic resolution and authored UI
renderer. Focused checks passed. The [L0 contract](../../verification/runtime-perf-state.md)
names the frozen judge paths and holdouts. Midway's tracked `c277aee` game source is snapshotted at
`sandbox/.afk/prd400-midway-source` so its separate package changes cannot enter the baseline.
That game needs core's launch-failure and pending-asset API from `acef62180`; the existing engine
implementation is included here so the unchanged snapshot builds against this branch.
Desktop preflight reached the packaged game after fixing its embedded-entry launch, then exposed a
judge-generated browser-only diagnostic assertion; native scenarios now assert supported startup
readiness. The later native 4x failure traced to Three.js reusing a pipeline and bind group when
the active sample count changed. The Three patch now keys the render object and pipeline on that
count and rebinds a refreshed GPU group; its three distributed copies apply in a clean consumer.
The web preflight initially selected SwiftShader and lost its GPU instance because the judge
launched Chromium headless. Headed WebGPU under the existing private display reached the flight
workload; the playtest runner now excludes only failed POSTs to the judge's exact loopback marker
URL from its network assertion. A one-run preflight then returned `PASS` with 900 frame samples,
startup and all three markers; Chromium `adapter.info` reported `nvidia / turing`. This is a
preflight on a dirty checkout, not a pinned baseline or A/A noise result.
The native generated flight scenario now converts an authored viewport-pixel click into the desktop
pointer transport at the same normalized location. The first full native run then passed the flight
but failed the judge's two-second desktop shutdown. With a ten-second shutdown bound, a cold startup
timed out on a one-frame mailbox `advance` (20,250 ms). The playtest startup wait now treats that
specific operation timeout as a busy frame within its existing readiness deadline. On the dirty
checkout, the next native preflight returned `PASS` with 875 frame samples, a 1,619 ms startup
sample and no GPU validation errors. Its p50 was 6.13 ms, p95 56.35 ms, and worst frame 25.54 s.
Inspection of all six resource snapshots showed `status: briefing`, `airborne: false`, and unchanged
altitude and airspeed: the web flight scenario's viewport click did not enter native gameplay, and
its diagnostics-only assertion could not catch that. These frame numbers describe the briefing
scene, and the playtest's accelerated tick advance is not a normal paced presentation window; they
cannot be used as a Midway FPS baseline. The native gameplay check will run the already authored
`native-playtests/launch.playtest.json`, which requires flight status, airborne state, and altitude
and airspeed changes. The steady-state baseline then uses the `measure-steady-state-fps` skill on a
normal paced, hardware backed window after loading and compilation settle. The 57 production judge
tests, 19 startup tests, 8 packaging tests, typecheck, lint, and full `pnpm test` pass (454 test
files, 5,520 tests; 8 skipped). The distributed patch intentionally moves all ten no-install
scaffold hashes, and the renderer cache probe now supplies the renderer's active-target method.
The native result is a preflight, not a pinned baseline or A/A noise result.
The ignored snapshot then installed core tarball SHA-256 `934e6b39a94b18fe7d38fd5e380a64e0274477e4364e57dd1419a979673a102f`
and Three patch SHA-256 `6bb97e8e730a8cf10433456a382a2701996c86bf4cc3a07e8f3e80e7c9b0c799`;
its `src`/`public` workload hash stayed `a764771af3a8b96b2b5780cd4badb67050ae10656b7ba8df99cb0cb2dadf3ae8`.
The authored native launch then returned `PASS` on a clean engine checkout with all six assertions,
including actual airborne and changing altitude/IAS state. Its screenshot shows the plane above
the water. It proves gameplay and the packaged patch, not a real-time frame baseline.
The comparison now includes the authored resolution-scale setting from the packaged native config.
Its no-GPU control blocks `auto` → `0.5` even when frame time improves, while `auto` → `auto`
and matching numeric escape-hatch settings pass (`L0-09`). The packaged Midway config remains
`auto`. The live `slow-native` control is still required before ticking sensitivity.
The matrix report now emits and preserves per-frame `stepMs` and projection `collapseMs`, with
sample-count and finite-value checks. Its 102 scorer tests and typecheck pass; these two terms
alone do not close the five-term attribution box.
The two unpaired 10,000-object desktop matrix arms completed and are recorded as discovery in
the L0 ledger; their run-order difference cannot establish a noise band. `pnpm typecheck`,
`pnpm lint`, and `pnpm test` passed locally (454 files, 5,520 tests; 8 skipped).
After the resolution guard, typecheck and lint passed; focused production-profile tests passed
58/58 and comparator tests 18/18. The full suite passed 5,520 tests but one browser runner test
observed a closed page during the concurrent desktop capture; that exact test passed in isolation.
Full matrix/Midway baselines, A/A noise, sensitivity controls and AC-1's full iteration remain unverified.
Three identical native matrix runs at 1% mutation now preserve the step and projection series and
bound their virtual-display run-median variation (`L0-11`). A direct host log exposed replay and
present timing but no frame-budget or projection markers (`L0-12`), leaving three.js CPU and
recorder JS unnamed. The Wayland session currently has zero active outputs, so the paced Midway
presentation baseline remains unavailable; the virtual-display intervals are not FPS evidence.
The first live scaffolded `slow-native` control returned `BLOCKED`, not a sensitivity verdict:
the native budget triggers, but the web arm lacks mean FPS and its 120 frames cover only 3.1955
seconds despite `--duration 45` (`L0-13`). The sampling contract must be fixed before retrying.
The scaffolded production collector now paces its generated fixed-step workload against wall time
and counts one web sample per RAF presentation. Focused sampling tests pass 4/4, and typecheck,
lint, and the full test gate pass (457 files, 5,526 tests; 8 skipped).
The full-SHA live retry did produce complete web metrics over 48.548 seconds, but the desktop
playtest hit the 1 MB device-bridge payload limit before native metrics were complete (`L0-14`).
That retry remained `BLOCKED`; it did not establish slow-native sensitivity.
The bridge snapshot now includes `runtimeDiagnosticsSeries` only when the sample request asks for
it; the 1 MB payload limit is unchanged. The full test run exposed three core tests that relied
on the old implicit series. Those callers now request it explicitly, and the focused core/playtest
rerun passes 56/56. The full suite then passed (457 files, 5,526 tests; 8 skipped).
A clean live retry now returns `FAIL` with only `TN_PROD_PERFORMANCE_BUDGET`; web and native
comparison metrics and all required markers are complete (`L0-15`). The slow-native control is
verified, while the Phase 1 sensitivity box remains open for the live resolution-cut candidate.
The host-gap meter now has an opt-in detailed sample (`TN_HOST_GAP_DETAIL=1`) with its existing
per-frame segment times and rAF period. The default marker shape stays small. Focused source test
and C++ object compile pass. A linked-host L3 probe parsed 300 detailed samples; joining the
period ending at frame N to the post-rAF segments of N−1 and pre-rAF segments of N accounts for
81.2% of the mean period with zero negative residuals (`L0-16`). The remaining 18.8% still needs
Three.js CPU and recorder JS attribution; this Xvfb probe is not presented FPS or Midway proof.
Frozen Midway and an isolated `0.5` resolution copy each passed a native desktop profile with
the same local host and authored scenario (`L0-17`). The records capture `auto` versus `0.5`,
but these virtual-display runs lack the observed hardware identity required by the A/B comparator;
neither the resolution-cut sensitivity verdict nor a paced baseline is verified.
The opt-in rAF callback clock and native matrix timestamp join now close 99.97% of a diagnostic
host period, with 180 scored matrix frames matching host timestamps (`L0-18`). Callback dispatch
still combines Three.js, recorder and game work, so five-term attribution remains unverified.
This changed frozen judge paths and requires a new baseline before any candidate verdict.
A separate V8 profile sampled projection functions heavily and recorder functions lightly on the
same native matrix cell (`L0-19`), but its sampled shares are not per-frame time. Recorder encode,
reuse and upload bypass its drain timer, and there is no single existing wrapper around all of them.
The five-term box remains open; recorder instrumentation and candidate selection wait for an
uncontended, paced desktop baseline so the diagnostic cost can be justified against a real frame.
The RTX 2080's HDMI and secondary outputs are now active at 60 Hz. A headed empty-page control
paced at 16.7 ms p50 on NVIDIA/Turing; the branch rebased cleanly onto the new `develop` culling
change, rebuilt core, and passed its 17 focused tests. The 10,000-object L3 cell hit the 16.7 ms
display floor, so three identical real-display A/A runs used 40,000 objects: frame p50 run medians
26.975/26.650/28.258 ms, noise band 1.608 ms; projection p50 band 1.490 ms (`L0-20`). This is
an uncapped matrix throughput baseline only. The Phase 1 baseline checkbox remains open until
Midway native/browser and both holdouts have matching pinned A/A evidence.
The live Midway scene initially showed no HUD despite `TN_UI_OVERLAY` reporting attachment.
Disabling WebKit's DMA-buffer renderer made the authored briefing screen visible, so the Linux
overlay now applies that fallback by default. A requested web UI now fails startup if attachment
fails or if the page does not send `tn:ready` within 15 seconds; `--bypass-ui-loading` explicitly
runs the scene for diagnostics. The rebuilt host passed the focused packaging and native queue
checks; an Xvfb compositor run with a page that never reports ready exited 1, while the real
Midway UI remained running beyond the deadline. Both physical display connectors disconnected
during the flight-input probe, so no Midway paced FPS or gameplay baseline is claimed (`L0-21`).
After rebasing onto `develop` with PRD-399's UI worker and native lock update, the three shipped
Three patches apply together and the generated scaffold hashes match all ten templates. The
rebuilt desktop host passes the authored loading playtest (913,920 startup loading pixels, zero
settled loading pixels), the full local suite (457 files, 5,552 tests; 8 skipped), typecheck,
lint and budgets. A rebased hosted-software collector smoke run returned `PASS` with 1,146 ms
startup; its performance-budget advisory is expected for the short software-rendered probe.
These checks verify integration only; the paced Midway and holdout baselines remain open.
The first rebased CI `test-native` collector blocked when headless GTK reported a missing AT-SPI
session bus as a console error. The bounded collector step now sets `NO_AT_BRIDGE=1`, preserving
the judge's strict diagnostic check; a local run with that exact environment returned `PASS`.
The `test-native` check passed on the first fixed CI head. After #292's Windows mailbox retry
merged into `develop`, this branch rebased without conflict. Its mailbox regression passed 3/3,
the authored desktop loading playtest again settled to zero loading pixels, and typecheck, lint and
the full suite passed (457 files, 5,553 tests; 8 skipped). The rebased CI verdict remains pending.

### Phase 2 — Lane 1: scene projection

**Status:** NOT STARTED
**ACs:** contributes to AC-2, AC-3
**Files:** `packages/core/src/renderProjection.ts`, `projection-plan.ts`, `projection-apply.ts`, their
specs, one projection mutation playtest scenario.
**Verification:** each candidate on the cadence table; the mutation scenario on web and native desktop.

- [ ] First experiment recorded (`L1-00`): unchanged vs 1%-mutating 10,000-object cell, the five-term
  split and the projection sub-split.
- [ ] Cost model checked across the matrix (`L1-01`): planned vs measured draws and frame time,
  shadow and reflection passes included.
- [ ] Projection mutation scenario green on web and native desktop, a red observed first for any
  defect it catches.
- [ ] Lane closed by the stop rule, with at least one keep or the evidence that nothing removable
  remains; every keep's end-to-end numbers in the ledger.

**Checkpoint:** pending

### Phase 3 — Lane 2: three.js CPU bookkeeping

**Status:** NOT STARTED
**ACs:** contributes to AC-2, AC-3
**Files:** `patches/three@0.185.1.patch`; the core specs and playtest covering its acceptance cases.
**Verification:** each candidate on the cadence table; `pnpm install --frozen-lockfile` applies the patch cleanly.

- [ ] Attribution at constant object count across material diversity, shadow mix and pass count
  (`L2-00`).
- [ ] Acceptance cases — material replacement, alpha-tested shadows, skinned animation, velocity/TRAA
  previous-frame state — green in specs and a playtest, web and native desktop.
- [ ] Lane closed by the stop rule, with at least one keep or the evidence that nothing removable
  remains; every keep measured on both runtimes.

**Checkpoint:** pending

### Phase 4 — Lane 3: frame recording and native replay

**Status:** NOT STARTED
**ACs:** contributes to AC-2, AC-4
**Files:** `frame-op-stream.js`, `bindings_frame_stream.cpp`, `bindings_commands.cpp`, their specs and
native contract tests; census and coverage records regenerated in the same commit as any
`runtime-native` change.
**Verification:** each candidate on the cadence table; `pnpm parity` and the native contract tests on
every keep.

- [ ] Recording, plan maintenance and replay measured separately on the five command shapes
  (`L3-00`), with a verdict naming where the next change goes.
- [ ] `mapAsync` ordering, readbacks and resource lifetime held: frame-stream specs, native contract
  tests and `pnpm parity` green on each keep.
- [ ] Lane closed by the stop rule, with at least one keep or the evidence that nothing removable
  remains.

**Checkpoint:** pending

### Phase 5 — Campaign verdict

**Status:** NOT STARTED
**ACs:** AC-2 to AC-7
**Files:** the ledger; this PRD.
**Verification:** the acceptance runs on the final head; a fresh judge subagent for the pixels.

- [ ] Final re-profile of the five terms plus the lane 4–6 shares (startup, first-use compile, upload,
  present wait); any dominant term outside lanes 1–3 handed to its owning PRD with its number.
- [ ] A fresh judge subagent compares before/after captures of Midway and two templates and finds
  them identical — the appearance-preserving claim.

**Checkpoint:** pending
