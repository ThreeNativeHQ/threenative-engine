# Tempest campaign

Read this file when the campaign workload is the Tempest sample: the `rain` template
(`packages/create-threenative/templates/rain`), drawn by the web Wasm engine against stock three.js.
Tempest is per-pixel heavy (a raymarched sky and clouds, a reflection pass, 4x MSAA, bloom and a
grade). It is the worst case for engine render cost, so a lever that pays here pays in every game
that draws full-screen passes, materials or render targets.

The skill's loop, acceptance rules and dashboard contract apply. This file adds only what differs.
The web lane is the primary lane here. That is an exception to the skill's native-first rule: the
Wasm engine is the engine under test on the web, and T3 carries the result to the native player.

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
   [engine-kpis.md](engine-kpis.md) and does not regress a second template (the sentinel). Use
   `starter`, or a template whose bottleneck differs from Tempest. A lever that only helps
   Tempest's shaders is `provisional`, never `keep`.

## Start or resume

1. Do the "Start or resume" steps of the skill. Use the campaign directory
   `<primary>/artifacts/native-performance-loop/tempest-<date>/`. Copy `render.mjs` and
   `check-render.mjs` from the newest campaign there instead of writing a renderer. Create
   `index.html` before the first run.
2. Read the arms and lanes sections below for the arms, the capture recipe and the frozen pose.
   Then read [engine-kpis.md](engine-kpis.md) and record a baseline for every KPI that has a meter.
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

Stop at the skill's stop conditions, or when engine levers stop paying. In that
case, report:

- the per-pass GPU table (ours and legacy);
- the remaining gap to T2;
- each template-side option with its measured saving and the judge's description of how the
  image changes. Apply none of them.

Finish with the dashboard link, the KPI table (baseline, incumbent and delta per KPI), the
accepted and rejected counts, and one next action that someone can resume.

## Arms, lanes and frozen scenarios

Paths are relative to the owning ThreeNative checkout. Check the current CLI help before you use
a flag. These are routing pointers.

### Arms

| Arm | How to make it | What it proves |
| --- | --- | --- |
| Wasm engine (candidate) | Scaffold `rain` with the local framework. The default engine is native. | The engine under test |
| Legacy (control) | The same scaffold with `engine: "legacy"` in `threenative.config.ts` | Stock three.js WebGPURenderer on the same template revision |
| develop (optional) | Scaffold from `origin/develop` in its own worktree | A third view when the template itself changed |

Scaffold the same way that `scripts/verify-template-playtests.ts` does: `createProject({ install:
true, packageSources: await packageLocalFramework(root), target, template: "rain" })` from
`packages/create-threenative/src/index.js` and `scripts/visual-gate.js`. Use a fresh temporary
root for each arm. Serve each arm with `pnpm exec vite --host 127.0.0.1 --port <port>
--strictPort` from its project directory.

Confirm each arm by what it loads, not by its config. The Wasm arm imports the
`threenative:web-engine` module. The legacy arm imports `three_webgpu.js` from `.vite/deps`.

### The web lane (primary)

- Use the playtest runner's own Xvfb. Unset `TN_PLAYTEST_HOST_DISPLAY`. Never use the owner's
  display or the laptop display.
- Pass `--browser-recipe webgpu --headed`. Without `--headed`, Chromium can fall back to
  SwiftShader.
- Every run must report the reference adapter in `adapter.info`. On João's machine this is the
  RTX 2080: vendor nvidia, architecture turing. Any other adapter makes the run `invalid`.
- Exit 75 means that the capture lock is busy. Retry it. Set `CAPTURE_LOCK_TIMEOUT_MS` to wait
  longer. Other agents share the GPU, so do not run two arms at the same time.
- With `assert.performance`, the runner adds `--disable-frame-rate-limit` and
  `--disable-gpu-vsync`. GPU ms is then the uncapped cost. The presented interval of a 60 Hz claim
  needs a vsync-on run.

### The desktop lane (T3)

Build the V8 player (`pnpm native:build`). Run the scaffold with `pnpm build --target desktop` and
`THREENATIVE_ENGINE_PLAYER` set to the player. Use the playtest runner's `--target desktop` with
the template's `native-playtests/` (`boot`, `lightning`). Read frame windows with
`node packages/playtest/dist/runner/cli.js perf --file <log>`. Use the legacy browser arm as the
comparison, and label it as a cross-runtime comparison.

### Frozen scenarios

| Scenario | Use |
| --- | --- |
| `playtests/performance.playtest.json` | Primary timing: 1920x1080, `high` tier, 60 warmup frames, a walk, then 600 ticks |
| A pose scenario (viewport 1904x960, warmupFrames 30, waitTicks 300, one `pose` screenshot) | Visual judge and parity diff. Save it in the campaign directory and hash it. |
| `playtests/storm.playtest.json`, `weather.playtest.json`, `tiers.playtest.json` | Second Tempest load levels: heavy storm and each quality tier |
| The full `playtests/` set | Behavior gate before keep |

### Known state (2026-10-16, engine 54c226867)

These numbers start the history. They are not a baseline for a new campaign: measure your own.

- GPU ms at 1920x1080: Wasm 113.6, legacy 43.5 (3 pairs). CPU ms is equal on both arms.
- At 960x540, both arms are about 3.5x faster, so the cost is per pixel.
- `reflections: false` saves about 19 ms on Wasm and 5 ms on legacy. About 55 ms of the gap has
  no named pass yet.
- Pose parity against stock three: full-frame mean diff 0.006 after the mat2 order fix.
- The rain playtest set passes 15 of 16 on Wasm. `lightning`/`thunderVoices` fails on both engines.
- Stock three itself is near 30 fps on the reference GPU, so T2 means beating stock three by more
  than 2.5x.
