---
name: tempest-performance-loop
description: Run an autonomous performance campaign on the Tempest sample (the `rain` template) until the ThreeNative engine renders it faster than stock three.js with the same image, first on web Wasm and then on the native desktop player. Every kept lever must move an engine-wide KPI that helps any game, not only Tempest. Use when asked to make Tempest or rain faster, reach 60 fps on Tempest, or close the GPU gap between the Wasm engine and legacy.
---

# Tempest performance loop

Tempest is the `rain` template (`packages/create-threenative/templates/rain`). It is a
per-pixel-heavy scene: a raymarched sky and clouds, a reflection pass, 4x MSAA, bloom and a grade.
It is the worst case for engine render cost, so a lever that pays here pays in every game that
draws full-screen passes, materials or render targets.

This skill specializes [native-performance-loop](../native-performance-loop/SKILL.md). Read that
skill first. Its loop, its measurement and acceptance rules, its guardrails and its dashboard
contract ([dashboard.md](../native-performance-loop/references/dashboard.md)) all apply. Only the
differences are written here. Creating or editing this skill does not start a campaign.

## Contract

1. **Goal order.**
   - **T1:** Wasm engine GPU ms is at or below stock three on the same pose, resolution and tier.
   - **T2:** 60 fps on the reference GPU. GPU ms ≤ 16.7 and presented interval p95 ≤ 16.7 ms
     at 1920x1080, `high` tier.
   - **T3:** the same on the native desktop V8 player.

   T1 comes first because it is an owner rule: native must beat JS.
2. **Primary scalar.** GPU ms per frame, median of steady windows, lower is better. Do not
   use `fps` or `minFps` from the Wasm engine as the primary scalar. The rAF backpressure
   (`tnw_web_frame(11)`, two frames on the GPU) skips renders, so both values overstate the engine.
   Read CPU ms, GPU ms and the presented interval.
3. **Allowed edit surface.**
   - Engine only: `packages/runtime-native/` (C++, WGSL codegen, the renderer, `web_host.cpp`) and
     `packages/three-native/` (JS glue).
   - The template's `src/render/` and `tools/tempest-*.frag` are the look. Do not change them
     for speed. A template-side saving (cloud steps, reflection resolution, MSAA, bloom resolution)
     is a measured *proposal* for the owner. It is not a kept lever.
   - Do not patch three.js.
4. **Image identity.** The Wasm frame must match stock three on the pose (mean absolute diff
   ≤ 0.01 on 0–255, plus no region the judge marks as different). Every kept lever passes a fresh
   read-only visual judge with BEFORE/AFTER captures and two runs per arm. Both engines are
   deterministic run to run, so two runs show stability, not two independent samples.
5. **Generality gate.** A lever is kept only if it moves at least one KPI in
   [kpis.md](references/kpis.md) and does not regress a second template (the sentinel). Use
   `starter`, or a template whose bottleneck differs from Tempest. A lever that only helps
   Tempest's shaders is `provisional`, never `keep`.

## Start or resume

1. Do the native-performance-loop "Start or resume" steps. The campaign directory is
   `<primary>/artifacts/tempest-performance-loop/<campaign-id>/` (it is git-ignored). Create its
   `index.html` before the first run.
2. Read [lanes.md](references/lanes.md) for the arms, the capture recipe and the frozen pose.
   Then read [kpis.md](references/kpis.md) and record a baseline for every KPI that has a meter.
   Mark a KPI without a meter as `unavailable: <reason>`, never as zero.
3. Freeze: engine SHA, wasm hash, three version, template hash, pose, viewport 1920x1080, tier
   `high`, warmup, sample windows, and the GPU identity (`TN_GPU_CLASS` nvidia/turing).
4. Run the unchanged pair (legacy arm and Wasm arm) at least three times, alternating order.
   Set the noise margin from these runs before you write any code.

## Finding the next lever

Tempest cost is per pixel: at 960x540 both engines are about 3.5x faster than at 1080p. So rank
first by GPU work per frame, in this order:

1. **Pass attribution.** Get GPU ms per pass (scene, reflection, MSAA resolve, bloom chain, post)
   on both engines. Use timestamp queries where the adapter grants them. Otherwise use ablation:
   turn one stage off on *both* arms and diff the deltas. An ablation is diagnosis only and never
   ships. The pass with the largest ours-minus-legacy delta is next.
2. **Codegen diff.** For that pass, dump the WGSL that each engine emits for the same node graph.
   Compare instruction count, texture samples, loop bounds, precision and redundant work (a value
   lowered twice, a constant recomputed per pixel, a branch that three folds and we do not).
3. **Target traffic.** Count render targets, resolves, copies, clears, load/store ops, formats and
   sizes per frame against stock three.
4. **CPU and churn.** Do this only after the GPU gap closes, or when CPU ms exceeds GPU ms.

Record the predicted saving before you edit. Use one conceptual change per experiment. Each
behavior change needs a red/green unit test in `packages/runtime-native` (`ctest -R <case>`) or
`packages/three-native` (vitest). A performance number is not a red/green test.

## Confirm and decide

- Rebuild the web engine (`packages/runtime-native/build/web/tn-native-engine-web.wasm`). Install
  it into a fresh Tempest scaffold. Verify that the served wasm is byte-identical to the build.
- Run at least three valid pairs, alternating legacy-first and Wasm-first. Run them against the
  incumbent, and against legacy for the T1 ratio. An adapter other than turing, or exit 75 after
  its retries, makes the pair `invalid`.
- Run the visual judge, then the sentinel template, then the rain playtest set (16 scenarios; the
  known red is `lightning`/`thunderVoices` on both engines).
- Keep only if the median improvement clears the margin, the judge returns NEUTRAL or
  IMPROVEMENT, the sentinel does not regress, and the tests are green. Commit each kept lever on
  the campaign branch with its test.
- Every third experiment, rerun the original baseline pair to detect drift.

## Stop and report

Stop at the native-performance-loop stop conditions, or when engine levers stop paying. In that
case, report:

- the per-pass GPU table (ours and legacy);
- the remaining gap to T2;
- each template-side option with its measured saving and the judge's description of how the
  image changes. Apply none of them.

Finish with the dashboard link, the KPI table (baseline, incumbent and delta per KPI), the
accepted and rejected counts, and one next action that someone can resume.
