---
prd_contract: v1
---

# PRD-339 — the frame sets its own exposure

**Status:** DONE — actual generated-consumer integration is qualified at `8bf16f4c3`, with current develop source-scoped integration and approved lossless evidence preservation verified. Exact-head remote CI and auto-merge remain separate publication gates. The earlier incomplete integration at `2c77070b8` is preserved below. Implementation started 2026-10-02 from `d7277838`; original
measurement at `43d03e6a`. Batch:
[AAA-visuals batch](../rendering/aaa-visuals-notes.md). Judged with
[PRD-341](../done/PRD-341-a-frames-tone-is-a-number-and-the-number-is-a-gate.md), which is the only way to
tell whether this landed. Source studied: [TheLongSilence](https://github.com/achimala/TheLongSilence)
`src/gfx/PostFX.js`, the `LUM_FRAG` / `REDUCE_FRAG` / `ADAPT_FRAG` chain.

**Goal: a scene that changes brightness by ten stops stays readable, without the game hand-tuning a
`toneMappingExposure` constant per area.** This is the single largest look difference between a
Three.js scene and a shipped game, and the framework currently has none of it.

**Complexity:** a GPU reduction chain, a ping-pong history target, a TSL exposure node ahead of the
tonemapper, and a native parity case = **MEDIUM**. No new dependency, no new pass over the scene.

## The problem, measured at `43d03e6a`

### 1. There is no auto exposure anywhere in the repository

```
grep -rn 'autoExposure\|auto-exposure\|adaptation\|eyeAdapt' packages/core/src \
  packages/create-threenative/templates/*/src/render/
(no matches)
```

Every template's `worldEnvironment.ts` sets a fixed exposure. That constant is correct for exactly
one lighting condition. A game with an interior and an exterior, a day cycle, a muzzle flash, or a
teleport is choosing which of its own scenes to render wrong, and the agent building it has no
signal that a choice was even made — a dark room and a blown-out courtyard both come back as "the
game runs".

### 2. The naive implementation is the one that is wrong, and it is wrong intermittently

The reference implementation carries measurements for both traps, and both are the kind that survive
a green gate:

- **Linear smoothing of luminance is a first-order lag with a fixed time constant in luminance**,
  not in stops. `mix(prev, cur, rate)` closes a fixed fraction of the *remaining difference* per
  frame, so falling from a photosphere (radiance 100–400) to a moon lit by a distant star (near
  0.03) takes as many time constants for the last factor of a thousand as for the first factor of
  two. Measured in the reference: two runs of an identical command against an identical pose at an
  identical camera returned p99 168 / mean 47.3 and p99 44 / mean 7.4 — a four-to-five stop error,
  at random, on roughly three cold boots in ten at a 4.5 s settle, none at 9 s. Interpolating
  `log2` instead makes the rate constant in stops per second, and eleven stops then cost the same
  three time constants that one stop does.
- **A log mean of the scene is the textbook metric and it is wrong for a mostly-dark frame**; an RMS
  metric with a generous per-pixel clamp is wrong for a mostly-bright one. The reference measured a
  landscape under a low sun at mean 38/255 and median 22 — three stops under, with a judge calling
  every unlit face "dead dark maroon" — because a stellar aureole over a tenth of the frame at the
  RMS clamp contributed 3.6 to the mean square while the ground at 0.05 contributed 0.0025. The
  exposure was being set by the sun and nothing else.

Neither of these is discoverable from a screenshot that happened to boot on the good run. They are
discoverable from a settle-time assertion and a tone histogram, which is why this PRD is judged with
PRD-341.

### 3. The split: the loop is mechanism, the metric is the look

A game cannot write the reduction chain portably — it needs render targets, a ping-pong history that
survives a resize, a hook between the world pass and the tonemapper, and the same behaviour on
WebGPU in a browser and in the native host. That is rule 1(a): the framework owns it, at any size.

The *metric* — which pixels count, how hard they are clamped, whether the lower half of the frame is
weighted, how fast the eye opens versus squints, and at what error a change stops being an
adaptation and becomes a cut — decides how the game looks. That is rule 1(b), which vetoes 1(a):
those numbers ship as generated source in `src/render/`, and the framework must never pick them.

## What ships

### `packages/core/src/render/auto-exposure.ts`, exported from `@threenative/core`

- **The reduction.** Scene colour → a small luminance target → repeated 4×4 box reductions to 1×1.
  Sizes and step count are derived from the drawing buffer, so this survives the
  `ResolutionScaler` moving a rung underneath it.
- **The metric seam.** The per-pixel weight is a game-supplied TSL function
  `(colour, uv) => weight`, defaulting to `1`. The reference's clamp and vertical ground weight are
  expressible in it and are *not* built in. A game that wants a log mean writes a log mean.
- **The adaptation.** A 1×1 ping-pong target interpolated **in `log2`**, with separate `up` and
  `down` rates in stops per second, and a cut response: past `snapLo` stops of error the rate scales
  toward immediate, fully engaged by `snapHi`. Because the boost falls away as the error closes, it
  cannot ring or overshoot.
- **The exposure node.** A TSL node the render chain multiplies in before the tonemapper, so the
  bloom prefilter and the tonemap curve see the same scene-referred value.
- **Reset.** `reset(value?)` for a cut the game knows about — a level load, a teleport, a cutscene
  in. A resize must not silently reset the history; a rebuilt target is seeded from the last value,
  because the reference's resize path visibly re-flashed the frame on every dynamic-resolution step.
- **Reporting.** A `TN_AUTO_EXPOSURE` marker naming the measured luminance, the applied exposure in
  stops, the settle state, and — when the game turned adaptation off — the measurement *continues*
  and the marker says `applied=false`. Turning a convention off must not turn its measurement off.

### `src/render/exposure.ts` in every template, as generated source

The metric function, the clamp, the spatial weight, the two rates and the two cut thresholds, with
the comment saying what each one is for and which way to move it. `quality.ts` decides whether the
chain runs at a tier; this file decides what it aims at. Templates' `AGENTS.md` gains a row for it —
a convention missing from there does not exist.

## What does not ship

- No tonemapper. AgX/ACES selection stays where it is, in the game's own render chain.
- No histogram-based metric in v1. The reduction seam admits one later without an API change; a
  compute histogram is a separate PRD if a game ever needs one.
- No per-object or per-region exposure.

## Implementation phases

### Phase 1 — authored adaptation and metering contract

- [x] Generated exposure controls validate inputs and adapt in log2 with authored asymmetric rates, cut response, reset and disabled measurement. proof: 151 focused exposure/lifecycle/lifetime tests pass; actual 720-sample GPU lifecycle run exercises reset to a new eleven-stop target. Camera/raw and disabled runtime evidence below retains the original acceptance tolerances.
- [x] Reduction dimensions follow the drawing buffer without invalidating 1×1 history. proof: `pnpm exec vitest run --maxWorkers=1 packages/create-threenative/__tests__/auto-exposure.spec.ts packages/create-threenative/__tests__/auto-exposure-node.spec.ts` — 28 tests pass on 2026-10-02; renderer-stub lifetime proof only, no GPU execution claim.

### Phase 2 — opt-in GPU graph and lifecycle

- [x] A generated GPU reduction and ping-pong exposure graph reuses the world pass before bloom and the sole output transform. proof: focused node/lifetime tests pass; actual 720 paired GPU samples cover output-graph rebuild, drawing-buffer resize from 640×360 to 320×180, and reset without stale history. Exact-source capture/provenance is recorded below.
- [x] Every template ships editable exposure controls and documents the opt-in, without a default picture change before qualification. proof: `pnpm exec vitest run --maxWorkers=1 packages/create-threenative/__tests__/scaffold.spec.ts packages/create-threenative/__tests__/auto-exposure-scaffold.spec.ts packages/create-threenative/__tests__/shared-render-sources.spec.ts` — 83 tests pass; all 13 instruction budgets and mirror checks pass.

### Phase 3 — repeatability and runtime qualification

- [x] Bright/dark and disabled fixture scenarios exercise the real reduction and adaptation path. proof: [run 36998395106](https://github.com/ThreeNativeHQ/threenative/actions/runs/36998395106) — all five browser scenarios pass with inspected, SHA-tagged SwiftShader canvas screenshots; native remains open.
- [x] Settle and cold-boot tone assertions meet acceptance criteria 1–3 using PRD-341's tone gate. proof: all 18 current-harness exposure cases qualify; ten gain-one cold boots have a 3.7815% p99 band; approved first-update response is 0.000000476837 stops with gain one and rejects gain zero at 10.553099394 stops under the same 0.25-stop gate. Actual GPU/camera/clock traces are linked below.

### Current verification

2026-10-02 fresh-environment implementation: settings/topology and GPU resource-lifecycle tests
observed red for missing modules, then 28/28 passed after implementation. Scoped strict TypeScript
and Biome pass. At the first increment, generated `autoExposure.ts` and `exposure.ts` were feature-local source;
no existing render chain was changed. The real meter/reduction/adaptation TSL
graphs now generate WGSL through Three's builder (29 focused tests green); fixture Vite build,
scoped strict types and 141 CI-structure/needs tests also pass. A portable scene using the existing
engine loop and one explicit world pass now has static/cut playtests and a dedicated hosted
`Integration exposure` capture workflow. Local runtime attempt refuses the missing X display/Xvfb;
a fresh manager Unix-socket probe also returned EPERM. First hosted execution at `bb34aff158d07973cba5eaef53b3464caa7917bf`,
[run 36986637037](https://github.com/ThreeNativeHQ/threenative/actions/runs/36986637037),
produced an inspected real 640×360 room screenshot on SwiftShader WebGPU: luminance 0.001918947,
applied 6.4936 stops versus target 6.5515, settled=true. Its gate still failed a browser console 404;
all-case screenshot qualification, settle/cold-boot assertions and native proof remain open.
[Diagnostic screenshot](../../verification/prd339-exposure-proof/dark-adapted-bb34aff.png) and
[SHA/adapter provenance](../../verification/prd339-exposure-proof/dark-adapted-bb34aff.json) are
embedded in PR #397. The next diagnostic run, `36987636389`, conclusively recorded
`GET /favicon.ico` → 404; only the fixture favicon is corrected. The verifier now persists the full
report before assertions and rejects `TN_PLAYTEST_SOFTWARE_DEVICE_LOST` even if the harness calls
its downgraded software-device warning a pass. 36 focused tests pass; root `tsc --noEmit -p tsconfig.json`
passes after the fixture consistently imports built public core/playtest entries. Earlier lost-workspace results are
not evidence for this implementation.

The next runtime run, `36988237465` at `eaa583b1c`, passed the dark fixture cleanly but
[failed sunlight pixels](../../verification/prd339-exposure-proof/sunlight-failed-eaa583b.png)
([provenance](../../verification/prd339-exposure-proof/sunlight-failed-eaa583b.json)): numeric
adaptation settled while the rendered image was nearly black. The output code multiplied the
whole vec4, including coverage alpha. `applyExposure` now multiplies RGB only and preserves alpha;
its graph regression is green, with actual sunlight runtime rerun still required. The files and
opt-in recipe are now shipped in all 13 templates, without changing an existing post chain.

The RGB-only correction at `c7091c7edca15f6e0c415c3cdbfb2a0be696d9cc` has now rendered:
[run 36995411940](https://github.com/ThreeNativeHQ/threenative/actions/runs/36995411940),
artifact `11221785080`, SwiftShader WebGPU. The inspected
[dark frame](../../verification/prd339-exposure-proof/dark-settled-c7091c7.png) and
[sunlight frame](../../verification/prd339-exposure-proof/sunlight-settled-c7091c7.png)
are both readable, settled, and pass with zero console/device-loss diagnostics. The applied values
are 6.5429 stops (target 6.5515) and -4.4356 (target -4.4360), respectively. This proves the alpha
repair on actual pixels. The overall run still fails: the
[11-stop cut frame](../../verification/prd339-exposure-proof/cut-unsettled-c7091c7.png)
is washed out at -0.1848 stops versus target -4.4360, with `settled=false` after the scripted wait.
The one-stop and disabled cases were not reached. Full
[provenance and original PNG digests](../../verification/prd339-exposure-proof/rgb-correction-c7091c7.json)
are retained; no acceptance box is ticked from this partial run. A fresh published-source run of
128 focused/scaffold/mirror tests passes; native and complete dynamics qualification remain open.

The lane now merges develop `6c8858d7` without rewriting history. Its only conflict was the
scaffold fingerprint table, remeasured from the clean combined tree; 128 focused/scaffold/mirror
tests, root TypeScript and the isolated Vite fixture build pass. The cut fixture now records actual
exposure-node update counts, NodeFrame ids, raw deltas and the clamped delta sum at the cut and
after each GPU update. This diagnostic leaves the rates, thresholds and scripted frame budget
unchanged. The runner's fixed-step path batches `waitFrames` as simulation ticks; whether the
failed cut consumed enough rendered time remains under investigation.

Timing diagnostic [run 36997457561](https://github.com/ThreeNativeHQ/threenative/actions/runs/36997457561)
at `1f6c58af0` confirmed only 11 GPU updates and 0.7265 consumed seconds after the 180-tick cut
wait; its last readback remained unsettled. Both static endpoints passed, with no console or
device-loss errors. The fixture now selects the existing public wall-clock playtest mode so the
engine's frame pump runs throughout each wait. Its rates, snap policy and 180 budget are unchanged.
A new guard counts actual GPU updates through the first settled readback at the new target,
rejects stale pre-cut samples, and reports consumed seconds. Three guard regressions went red
then green; 40 exposure tests, root types and the isolated fixture build pass. Runtime rerun is
pending. Links/citations and the real evidence cap pass; two evidence-budget subprocess tests
cannot launch the tsx CLI because the environment rejects its Unix socket with EPERM.

The corrected clock [run 36998395106](https://github.com/ThreeNativeHQ/threenative/actions/runs/36998395106)
at `5c3b1762477d4a0f076b3779e22212c737ed5583` passes all five cases on SwiftShader WebGPU.
All five actual 640×360 images were inspected: adapted dark/sunlight and one-/eleven-stop forward
cuts match as readable coloured blocks and floor. The deliberately fixed exposure stays bright;
its marker still measures luminance 3.8961, reports `applied=false`, and applies exactly 0 stops.
The eleven-stop cut's settled readback arrives by 21 actual GPU updates / 1.0619 consumed seconds;
the one-stop cut by 13 / 0.5360. Both stay inside the same 180-update budget without changing rates.
[Original PNGs, per-file digests and complete adapter/run provenance](../../verification/prd339-exposure-proof/live-clock-5c3b176.json)
are retained. Every report passes with an empty diagnostic list. This completes the fixture box,
not the full acceptance: reverse cuts, raw-luminance and disabled early-return mutations,
ten cold boots with the shared tone gate, lifecycle integration and native proof remain open.

The next fixture increment adds live-clock reverse cuts and isolated build mutations for raw
luminance interpolation, disabled early-return, doubled metering and the wrong bridge clock.
Each negative arm requires clean runtime diagnostics and actual nonblank pixels before its one
named expected failure can count. Mutated module digests are recorded; shipped source is untouched.
Because 180 simulated ticks delivered fewer rendered updates on SwiftShader, the raw/log comparison
has a separate, explicitly deterministic per-render arm: exactly 180 completed GPU reductions,
adaptations and readbacks at 1/60 adaptation seconds each. An independent public NodeFrame snapshot
preserves the real frame object; real NodeFrame sums and elapsed seconds are recorded separately.
Resource waits observe completed GPU samples and freeze each pose's terminal history. Unit guards
reject mismatched counts/clocks and stale pre-cut readings. This is correctness proof, not hardware
timing; acceptance 1 stays open until the hosted matching-budget red/green pair actually runs.

Review regressions exposed missing terminal validation and late disposed-readback callbacks in
that unpublished fixture increment. The corrected guard pairs every actual readback with its
production-accepted observation through update 360, validates terminal measurement/applied state,
luminance and the new target before accepting only an unsettled result, and rejects unrelated
mutation failures. Disposed pending readbacks cannot publish fixture progress. The six focused
exposure test files pass 76 tests on 2026-10-02; root TypeScript passes. These are CPU guard and
lifecycle results only; the expanded hosted scenarios and their pixels remain unverified.


Hosted source `ad0498e6d6d3b7a5c314a67e6ed4982cff2cd45d`,
[run 37006844943](https://github.com/ThreeNativeHQ/threenative/actions/runs/37006844943), passed all
seven live-clock cases with empty diagnostics. The new eleven-stop reverse cut settled by
37 actual GPU updates / 2.0517 consumed seconds; the one-stop reverse by 17 / 0.9521. The inspected
[eleven-stop](../../verification/prd339-exposure-proof/eleven-stop-reverse-ad0498e6.png) and
[one-stop](../../verification/prd339-exposure-proof/one-stop-reverse-ad0498e6.png) PNGs show readable
blocks/floor; [provenance](../../verification/prd339-exposure-proof/reverse-cuts-ad0498e6.json)
preserves their exact bytes and SwiftShader identity. The run stopped before the deterministic/raw
arms: their wall-clock bridge resource poll observed no simulated tick. The fixture now uses the
supported fixed-step bridge only for controlled arms, while requiring the same 180 actual GPU
updates/readbacks and recording real NodeFrame time separately. Live arms retain wall-clock mode.
Three clock regressions failed before the change; all 77 focused exposure tests now pass. The
changed arms still need hosted runtime proof; acceptance 1 remains open.

Hosted source `9a84ee0eacebe9b119583b6fc16a0163276f1b78`,
[run 37009093358](https://github.com/ThreeNativeHQ/threenative/actions/runs/37009093358), executed
both controlled log-interpolation cuts with exactly 180 paired accepted GPU samples and 3.0
adaptation seconds. Eleven stops settled by update 114 / 1.9 controlled seconds, one stop by 42 /
0.7; real NodeFrame sums were 6.1925 and 6.3239 seconds, with elapsed spans 18.0085 and 18.2374.
[Both PNGs and the failed raw-one terminal frame](../../verification/prd339-exposure-proof/controlled-cuts-9a84ee0e.json)
retain exact hashes and SwiftShader provenance. The raw-one run failed the original blank guard
on its unretained automatic startup `before.png`, captured before the scenario's explicit warmup;
its readable terminal frame does not make that run pass. Later mutations were not run.

Controlled arms now use the existing `ctx.startup.hold` seam to wait for the 180th accepted GPU
warmup sample before readiness and automatic capture. This is identical for corrected/raw arms,
preserves every image guard, and retains both before/after PNGs. Missing, stale, early-ready or
expired warmup evidence fails the fixture verifier. The separate cold-boot criterion gets no such
warmup hold. These changes are awaiting independent review and hosted proof; acceptance remains
open. Shared PRD-341 tone metrics are now available through the ordinary develop merge.
Review also exposed warmup stamps whose frame IDs, clocks or accumulated time did not describe
180 distinct controlled updates. Warmup and post-cut evidence now share the same strict sequence
validator, and the terminal warmup identity/timing must match both its marker and the cut. Eight
regressions failed before correction. The focused suite now passes 90 exposure tests; root
TypeScript and scoped Biome pass. The prior hold increment also passed 12 doc-link tests and five
fixture builds. These local checks do not qualify the pending runtime arms.

Hosted source `2a33c9a0edbe38ced02820385267e4de049b7a4c`,
[run 37014029224](https://github.com/ThreeNativeHQ/threenative/actions/runs/37014029224), now passes
all 14 cases with empty runtime diagnostics. All 18 retained PNGs were visually inspected;
[exact bytes, adapter, report hashes, and paired timing evidence](../../verification/prd339-exposure-proof/qualified-cuts-2a33c9a0.json)
are durable. The four controlled corrected/raw comparisons each completed 180 accepted post-cut
GPU samples and 3.0 fixture-controlled adaptation seconds. Corrected eleven/one-stop reverse cuts
settled by 114/42 updates; raw one-stop settled by 57. Raw eleven-stop failed only:

`TN_EXPOSURE_NOT_SETTLED: Terminal GPU measurement remains unsettled after 180 rendered updates; observed time {"renderedUpdates":180,"adaptationSeconds":2.99999999999999,"realConsumedSeconds":10.978800000000414,"realElapsedSeconds":32.52129999999997,"clock":"deterministic-per-render"}.`

Its actual final frame is visibly dark while the corrected endpoint remains readable. This proves
the same-budget radiometric step mutation, but the current fixture changes lighting at a fixed
camera. Acceptance 1 stays open until an actual cut between camera poses repeats the comparison.
Live-clock forward/reverse intensity steps also pass. Fixed/off
reports measured luminance with `applied=false` and zero exposure stops, while the early-return
mutation fails only `TN_EXPOSURE_MEASUREMENT_MISSING`; both final PNGs are byte-identical, qualifying
acceptance 3. Doubled-meter and wrong-clock controls fail their specific named gates. These are
SwiftShader correctness results, not hardware timing or native parity. Cold boots, reset/rebuild
history, native proof and full required CI remain open; phase progress remains 3/6 boxes (50%).

The separate cold-boot fixture is now prepared at a predeclared age of exactly three accepted
GPU exposure updates. It preserves the real NodeFrame deltas, freezes only the existing fixture
history/output, and applies no controlled warmup hold. Both `snapGain=1` and `snapGain=0` arms use
the same sunlight pose and twenty independent launches in total. The landed `assert.tone` supplies
the named boot frame's p99; readiness age, actual update/sample indices, per-update delta and
cumulative time are archived. Review exposed unchecked initial readiness ages and impossible
NodeFrame chronology. The guard now compares zero-update readiness to the complete initial timing
state, relates each accepted live delta to elapsed NodeFrame time (allowing skipped frames and only
numeric roundoff), and requires exactly one fixed-step bridge marker. Eleven regressions failed
before this correction; all 29 cold-boot proof tests now pass. These remain CPU evidence checks. A further review reproduced
reordered timing markers that let impossible readiness counts pass. The verifier now reads timing,
accepted measurement and sample events in producer order, deriving readiness counts from that
stream. Five reordered-event regressions went red then green; nine valid readiness placements
before/after acceptance remain accepted. All 43 cold-boot proof tests and the reviewer's 88 probes
pass, including rejection of both previously accepted reorder traces. The ten-run spread is `(maximum - minimum) / minimum` with the
unchanged 10% limit. The mutation must empirically exceed that limit; no qualification is claimed
from its expected behavior. The prepared source awaits review and hosted execution.

Hosted cold-boot source `d1500603f7f1c8ab0ec07c2bd2662770375b69d7`,
[run 37021404660](https://github.com/ThreeNativeHQ/threenative/actions/runs/37021404660), executed
all twenty independent launches with empty diagnostics and exactly three accepted live GPU
updates. The corrected p99 range was 234–238 (1.7094% spread); zero-gain was 238–244 (2.5210%).
Both were below 10%, so the verifier correctly failed the required negative control and acceptance
2 remains open. [Reports, exact timing, PNG hashes and four min/max frames](../../verification/prd339-exposure-proof/cold-boots-d1500603.json)
are preserved. All sixty PNGs form twenty byte-identical before/boot/after triplets; each unique
frame was inspected and shows the bright scene without blank/corrupt output.

The zero-stop initialization seed is active, not a direct adoption of measured exposure. Both
arms' GPU observations match their authored adaptation recurrence using observed deltas within
0.00000054 stops. Corrected consumed time spans 0.1445–0.1767 seconds; zero-gain spans
0.1484–0.1951, with long second deltas clamped to the authored 0.1-second maximum. The mutation
changes exposure, but its p99 spread does not exceed the requirement. This is an ineffective
negative control for repeatability in this measured fixture, not a passing acceptance or grounds
to retune the age, scene, timing or 10% bar. Camera-pose qualification remains a separate open task.


Camera-cut qualification is now prepared as four separate controlled arms. Two identical rooms
remain 100 units apart, with finite-radius local lights and static background shells. The cut
changes only the actual camera translation: [106, 4, 9] to [6, 4, 9]. Camera layers, projection,
all four lights, room transforms and background colors stay fixed; every accepted GPU sample
carries an observed pose/lighting snapshot. The verifier rejects stationary/fabricated matrices,
light or layer changes and stale post-cut samples. The 11/1-stop corrected/raw comparison keeps
the same 180-update/3.0-second budget and unchanged 0.25-stop bar. Historical intensity-step and
cold-boot arms remain intact. 146 focused exposure/lifetime tests, root TypeScript, five fixture Vite builds, scoped Biome,
141 CI-structure/needs tests, documentation links and the tracked evidence budget pass. Broader
scaffold/mirror verification passes 69/70; the unchanged mobile-assets case cannot resolve the
Basis transcoder from its independent temporary project (`TN_ASSETS_TRANSCODER_MISSING`). Actual
camera pixels, native qualification and full required CI remain open.

Camera source `2bc1d57f9b8321e1a85b2a457778dacc7dda1372`,
[run 37049246423](https://github.com/ThreeNativeHQ/threenative/actions/runs/37049246423), passes
all 18 runtime cases with clean diagnostics. Actual fixed-light camera cuts settle after 114/42
updates for 11/1 stops, using the same 180-update/3.0-second controlled budget. Raw-luminance
one-stop settles after 57 updates; raw eleven-stop remains 2.528 stops from its target and fails
only `TN_EXPOSURE_NOT_SETTLED` after 180 updates (11.9467 consumed NodeFrame seconds, 36.2926
elapsed seconds). All 26 original PNGs were inspected; the eight camera images and all report/image
hashes are retained in [the camera evidence](../../verification/prd339-exposure-proof/camera-cuts-2bc1d57f.json).
Independent review accepted this exact-source AC1 proof on 2026-10-02. It also found four omitted
room/light matrix/color fields could be missing consistently in the verifier. Four regression
cases failed before adding shape/finite validation; 48 camera/proof tests then passed, and the
reviewer rejected 28 malformed-field variants against the actual report while all four genuine
camera reports remained valid. This correction changes validation only, not the captured scene.
AC1 and AC5 are qualified at this source; AC2's ineffective mutation, native, actual lifecycle
rebuild/reset and full required CI remain open. Software pixels make no hardware timing claim.

### Completion qualification and remaining cold-boot decision

Reviewed completion source `388e8acea5ac86e9c4d8526df61a82a0f21dd595` preserves the incoming
`a7b718b` develop merge. [Source, nonce, binary/report/PNG hashes and all 720 lifecycle samples](../../verification/prd339-exposure-proof/completion-388e8a.json)
retain the actual hardware evidence. The [native before](../../verification/prd339-exposure-proof/native-before-388e8a.png)
and [native after](../../verification/prd339-exposure-proof/native-after-388e8a.png) show readable blocks and floor.
[Lifecycle before](../../verification/prd339-exposure-proof/lifecycle-before-388e8a.png) and
[resized/reset after](../../verification/prd339-exposure-proof/lifecycle-after-388e8a.png) retain the real output.
The camera experiment's [gain-one endpoint](../../verification/prd339-exposure-proof/snap-gain-1-after-388e8a.png)
and [gain-zero endpoint](../../verification/prd339-exposure-proof/snap-gain-0-after-388e8a.png) are terminal
180-update frames; first-update qualification is the paired numeric evidence, not those endpoint images.
Independent review accepted native and lifecycle source and actual proof. Reconciled-head full
TypeScript, lint, 376 focused tests, documentation links and tracked evidence budget pass.
Phase progress is 5/6 boxes (75%); acceptance is 4/5. The original cold-boot requirement remains open.

A fresh hardware run of the unchanged twenty-launch cold-boot experiment at source
`08b039c64c6d95d017ac856f74cfc881ae11fdb1` gives corrected p99 235–239 (1.7021%) and
zero-gain p99 239–245 (2.5105%). Both remain inside the unchanged 10% limit.
[All twenty launch measurements, clocks and hashes](../../verification/prd339-exposure-proof/cold-boots-08b039c.json)
retain the negative-control failure rather than converting it into acceptance. Four min/max
frames are preserved alongside the record. This is RTX 2080 correctness evidence, not a timing benchmark.

Engineering recommendation, awaiting the user's criterion decision: keep ten independent boots
and their 10% repeatability limit, and test cut responsiveness separately. Setting gain to zero
removes the authored cut boost; it does not introduce randomness, so failure on boot spread is
not entailed by the intended mechanism. The existing three-update boot age and ACES shoulder
also compress the displayed p99 differences. Changing age, scene or threshold to manufacture
spread would change the experiment rather than prove the requirement.

The proposed separate red-green contract is analytically declared from the existing authored
`snapHi=8` and `snapGain=1`: an eleven-stop actual fixed-light camera cut must be within the
existing 0.25-stop tolerance on its first accepted GPU update at controlled delta 1/60.
Past eight stops, authored smoothstep is one, so gain one adopts the target on that update;
gain zero retains the ordinary exponential adaptation. The experimental actual pair observes
10.9108 stops between its camera targets. Gain one first-update error is 0.000000476837 stops;
gain zero error is 10.553099394 stops and fails only
`TN_EXPOSURE_SNAP_RESPONSE_MISSING`. Both original 180-update camera scenarios remain qualified.
Their endpoint PNGs depict the terminal frame after 180 updates, not the first-update measurement.
This experiment does not alter or satisfy the currently written cold-boot mutation criterion.

Native desktop qualification now passes the same bright-room fixture on an actual RTX 2080 Vulkan
adapter: 180 paired accepted GPU measurements, terminal applied exposure -4.435490608 versus
measured target -4.435517788, and both 640×360 before/after PNGs with nonblank ratio 1.0.
Raw native state matches the paired terminal measurement. Three actual GPU error scopes return
null; captured host console contains no validation/device-loss errors. The native `device.lost`
stub resolves without loss information and is explicitly unavailable as an observation; it is
never normalized into a successful loss-free report. The injected real invalid buffer produces
“Buffer usages must not be 0” and prevents readiness. The strict qualifier rejects its 180-sample
trace on GPU validation, rather than accepting the blocked startup.

The headless contract executes the production reduction graph with nonuniform 65×33 input,
including its odd edges, and compares an independent weighted CPU oracle. Its actual targets
are 17×9 → 5×3 → 2×1 → 1×1. Both native engines report luminance 2.065428257 versus CPU
2.065428175, exposure -3.519190788, and applied output pixel 0.174440756 after 120 updates.
Actual injected GPU validation is rejected. The existing CMake target definition, CTest
registration, execution pass lines, discovery count and missing-registration guard are updated;
the actual verifier function rejects the omitted execution registration. The focused V8/QuickJS
native suite passes 80 tests with one existing skip. An actual interleaved readback regression
failed on the original freshly built host before the bounded deferred-map fix and passes after it.

Exact proposed criterion change for approval: retain the first two cold-boot sentences and replace
only its red-green sentence with: “Separately, cut the actual camera eleven stops with a controlled
1/60-second adaptation delta. With authored snap gain one, the first accepted GPU readback must be
within 0.25 stops of its measured target; with snap gain zero, that same first-update accuracy gate
must fail. Preserve both measurements and the named failure.” No acceptance box changes without
that decision.

## Implementation decisions

- 2026-10-02: the current core contract says all exposure, TSL and post-processing are generated
  game source. That outranks this PRD's historical core filename below: implement in generated
  `src/render/`, using ordinary Three node lifecycle, while retaining the same functional acceptance.
  No new core exposure API or framework appearance defaults are admitted by this change.
- Existing tonemapping, render loop and scene pass are reused. No default picture changes until
  actual runtime evidence qualifies the path. A software adapter can prove correctness pixels,
  never hardware performance or native parity.

## Merge qualification still required

All acceptance criteria below are qualified, including fresh current-base consumer, lifecycle and native captures. Final independent publication review and green exact-head CI are required before merge; auto-merge has not been enabled. No shared cache, receipt hash, pipeline policy or security setting was edited.

## Acceptance criteria

- [x] **The settle time is independent of the size of the change.** proof: `exposure settle playtest`. A playtest scenario cuts the camera
   between a bright pose and a dark pose eleven stops apart, and between two poses one stop apart,
   and asserts both reach within 0.25 stops of their steady value inside the same frame budget.
   *Red-green:* replace the `log2` interpolation in `auto-exposure.ts` with `mix(prev, cur, rate)` on
   raw luminance; the eleven-stop leg must fail with the measured settle time in the failure text
   while the one-stop leg still passes. Paste both.
- [x] **A cold boot into a pose is repeatable.** proof: `ten exposure fixture cold boots and PRD-341 assert.tone`. Ten runs of the same scenario at the same pose report
   p99 luminance within a 10% band (PRD-341's `assert.tone` supplies the number).
   *Red-green:* independently cut the actual camera eleven stops with a controlled 1/60-second adaptation delta. With authored snap gain one, the first accepted GPU readback must be within 0.25 stops of its measured target; with snap gain zero, that same first-update accuracy gate must fail. The ten-boot 10% repeatability gate remains unchanged.
- [x] **Off does not mean unmeasured.** proof: `disabled exposure playtest`. With `enabled: false`, `TN_AUTO_EXPOSURE` still prints a
   measured luminance and `applied=false`, and the frame's exposure is exactly the game's constant.
   *Red-green:* early-return from `update()` when disabled; the marker assertion fails.
- [x] **It runs on native.** proof: `desktop exposure playtest and verify-native-contracts.mjs`. A `--target desktop` playtest of the same scenario reports the same
   applied exposure within tolerance, and a native contract test covers the reduction chain without
   a display (see the native contract lane in `packages/runtime-native/AGENTS.md`).
   *Red-green:* the contract case is registered in all five places a new native target needs; a
   missing registration must fail `verify-native-contracts.mjs`, not skip.
- [x] **The framework picks no number.** proof: `auto-exposure.spec.ts boundary assertion`. `packages/core/src/render/auto-exposure.ts` contains no
   default clamp, weight curve or rate that is not `1`, `0` or an identity. A grep in the spec
   enforces it. Verified 2026-10-02: 23 control/topology/boundary tests pass. The current
   architecture keeps the complete exposure graph and policy in generated game source; the
   boundary assertion scans every core source file and rejects exposure graph/metric/policy
   symbols and a core-owned auto-exposure module. No core look defaults are added.

## Out of scope

Local tonemapping, bloom threshold coupling, and lens/iris simulation.

### Approved AC2 correction (2026-10-03)

The owner explicitly approved the proposed AC2 replacement. Repeatability retains ten independent cold boots, the same pose and the 10% p99 band. Snap responsiveness is qualified separately at the first actual GPU update after the unchanged eleven-stop camera cut, using 1/60-second adaptation time and the existing 0.25-stop accuracy tolerance. The original twenty-launch measurements and ineffective spread mutation above remain historical evidence. Current-harness qualification and final checks are in progress; no new acceptance box is claimed yet.

### Current-harness acceptance qualification (2026-10-03)

[Current proof, source identities, clocks and image hashes](../../verification/prd339-exposure-proof/completion-current-55b5313.json) records actual captures at `55b53130603959bf1274b90acdad6f91f745f7b9`, using the rebuilt merged playtest harness. Ten gain-one boots produce p99 values 238–247, a 3.7815% band within the unchanged 10% limit. Ten diagnostic gain-zero boots also pass repeatability (249–251, 0.8032%); this is not a spread mutation red claim. The separate approved camera response observes gain-one first-update error 0.000000476837 stops and gain-zero error 10.553099394 stops at actual update 181 with delta 1/60. Only the same 0.25-stop response gate rejects gain zero.

All 18 browser cases and their behavioral mutations qualify with the original scene, ages and tolerances. The current lifecycle capture qualifies 720 actual paired samples, output rebuild, real 320×180 target resize and reset adoption of a new eleven-stop target. Current desktop proof qualifies 180 actual paired samples, matched raw state, three actual null GPU error scopes, nonblank before/after images and the actual invalid-GPU negative control. It transparently reuses the source-identical rebuilt V8 executable; no whole-tree CI verdict is reused. Independent review inspected 34 matrix/snap/lifecycle/native images and all 20 boot tone frames. Complete exposure traces are retained losslessly in the linked xz dataset, including 545 native markers taken from the actual captured host console.

The full instrumented coverage workload found the omitted negative CTest invocation; both real exposure contract invocations now pass after its registration repair. An unrelated worker contract timed out once, then passed the unchanged 120-second isolated reproduction in 0.79 seconds. The complete instrumented rerun passed: 43 runnable native contract targets, 47 actual raw profiles, 19,206 of 24,373 instrumented lines covered (78.80%). Optional metahuman, native physics and video remain explicitly configured off in this existing lane. The source digest and profile/report receipts are recorded in the current proof. Final local checks and exact-head CI remain separately required before merge.

### Final-suite integration repair

The full suite at completion checkpoint `2c77070b8` exposed missing shipped-template imports/calls and a generated source file above the unchanged 200-line readability gate. Fixture GPU/native evidence does not qualify missing consumer wiring. This phase is reopened until the game-owned opt-in path uses the existing world pass, retains the default picture, and qualifies its lifetime on the actual generated consumer. The native build-matrix registration and action-rpg instruction newline guard also require repair. No invariant or acceptance tolerance is weakened.


### Generated-consumer qualification and publication hold (2026-10-03)

[Actual consumer proof, public image aliases and source receipts](../../verification/prd339-exposure-proof/completion-consumer-8bf16f4.json) qualifies the generated `WorldEnvironment` opt-in at source `8bf16f4c320748403dd091e4fd7da394da314bff`. All thirteen quality presets explicitly keep its cost flag false; the default picture is unchanged. Metering uses the existing unexposed world-pass colour, applies exposure before the chain, and releases its own targets with that pass. Four shared generated files are byte-identical across all thirteen kits and stay within their unchanged readability checks.

The actual consumer passes the approved first-update camera gate: gain one error is 0.000000476837 stops, while gain zero fails only the same 0.25-stop response gate at 10.553099394 stops. A disposable source mutation removes the generated environment's meter; its manual fixture fallback still adapts correctly, but only the consumer ownership gate rejects it. Exact source/mutation digests and actual ownership markers are retained in the lossless trace. There is no claim that the mutant pixels lacked adaptation.

The actual owned consumer also passes all 720 paired lifecycle samples, real 320×180 resize and immediate target adoption on reset. Desktop qualifies 180 paired samples, nonblank captures, three actual null GPU error scopes and the injected validation control. Rebuilt V8 and QuickJS displayless contracts both pass positive and actual registered negative invocations. All ten current consumer PNGs are byte-identical to existing public images: hashes and aliases preserve their original provenance, with no new screenshot or hardware claim. Independent code, trace, image and coverage audits pass.

The genuine full instrumented native workload executes 43 targets and produces 47 raw profiles: 19,217 of 24,373 lines, 78.85%, source digest `26e52aa0d7cade3c712d4e4054e9a014d7f07709558b3146196827780580d713`. Earlier profiles and the failed measurement remain preserved. Full typecheck and lint pass. The full suite passes 7,411 root tests plus 1,532 native tests with existing skips, and exposes only the expected scaffold identity change. All thirteen baseline/current scaffold trees were then byte-compared; only the bounded render integration and instruction whitespace changed. The unchanged complete scaffold spec passes all 66 tests after genuine measured pin updates.

The owner approved the exact fourteen-PNG lossless recompression and twelve own JSON whitespace compactions. All filtered PNG scanlines, non-IDAT chunks, JSON tokens and historical values are preserved; immutable original anchors are retained in [the preservation receipt](../../verification/prd339-exposure-proof/approved-lossless-preservation.json). The combined evidence remains below the unchanged 72MiB cap. Current develop integration changes only the copied Three compute-only 3D guard in all thirteen generated trees; actual exposure 2D, readback, clock, native and harness source closures are unchanged. [Current source qualification](../../verification/prd339-exposure-proof/current-base-c18a42b.json) records measured pins and honest scoped evidence reuse. Typecheck, lint, dependency SBOM checks, 82 scaffold/Three tests, 281 exposure tests, 198 host desktop/CI tests and two red/green routing regression tests pass. Exact-head remote CI and auto-merge remain pending separately. No acceptance threshold, clock age, hardware requirement, or pipeline setting is waived.


After integrating develop `9f41cb0ed171f335fc18d988dac27eeed4211122`, the controlled fixture explicitly requests resolution scale 1, preserving its historical full-size input while the production renderer retains its new automatic default. [Current-base qualification](../../verification/prd339-exposure-proof/current-base-9f41cb0.json) retains the six actual capture arms at `ae44ab8df3a6f6596465d408e13660905fc853fd`, complete paired producer traces and twelve exact PNG payloads in a lossless XZ bundle. Actual surface observations report `scaleSource: pinned`, effective scale 1, DPR 1 and matching canvas/drawing-buffer dimensions: 640×360, then the authored 320×180 lifecycle resize.

The fresh consumer response again qualifies gain one at the first post-cut GPU update and rejects gain zero at the same accuracy gate. Removing the consumer wire still qualifies response before failing ownership alone. All 720 lifecycle pairs qualify rebuild, resize and reset; both native arms retain 180 pairs, with three null scopes for the positive and an actual injected-validation rejection. The native compiled source closure and instrumented coverage digest remain unchanged, so the original complete 43-target measurement is reused with its original provenance. Current typecheck, lint, 176 exposure tests, 37 routing/pin tests, the unchanged 66-test scaffold guard and `ci:fast` pass.

The owner approved the exact historical evidence cleanup partition. [Its recovery receipt](../../verification/approved-historical-cleanup-pr397.json) records the 39 removed files and immutable original Git anchors; five historical prose citations now point to those originals. All 93 required proof paths, current aliases and preservation hashes remain intact. Current proof publication and green exact-head CI remain separate merge requirements; no threshold, adaptation clock, hardware requirement or evidence cap changed.

CI follow-up preserves failed source-head artifacts rather than relabeling them: exposure and cold-boot recovered at unchanged `49f76db8`; browser fluid's single recovery failed before assertions on screenshot stability. The reviewed harness repair retains collected failure observations and qualifies runtime errors before checking screenshots. Native/browser fluid routing is separated by actual dependencies, with delivery verification remaining fail-closed. Rain's existing software policy is respected while explicit HIGH remains exercised through its supported UI. [The actual Rain v2 receipt](../../verification/prd339-exposure-proof/ci-repair-rain-v2/receipt.json) retains eight passing original assertions, six image hashes and two exact public tier captures; it does not establish the CI device-loss cause or claim a final-head capture. Earlier exposure/native images and source identities remain unchanged. Full typecheck, lint, scoped regression suites and normal pre-push checks pass; final exact-head CI and merge readiness remain separate requirements.
