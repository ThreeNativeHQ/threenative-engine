# Tempest arms, lanes and capture recipe

Paths are relative to the owning ThreeNative checkout. Check the current CLI help before you use
a flag. These are routing pointers.

## Arms

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

## The web lane (primary)

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

## The desktop lane (T3)

Build the V8 player (`pnpm native:build`). Run the scaffold with `pnpm build --target desktop` and
`THREENATIVE_ENGINE_PLAYER` set to the player. Use the playtest runner's `--target desktop` with
the template's `native-playtests/` (`boot`, `lightning`). Read frame windows with
`node packages/playtest/dist/runner/cli.js perf --file <log>`. Use the legacy browser arm as the
comparison, and label it as a cross-runtime comparison.

## Frozen scenarios

| Scenario | Use |
| --- | --- |
| `playtests/performance.playtest.json` | Primary timing: 1920x1080, `high` tier, 60 warmup frames, a walk, then 600 ticks |
| A pose scenario (viewport 1904x960, warmupFrames 30, waitTicks 300, one `pose` screenshot) | Visual judge and parity diff. Save it in the campaign directory and hash it. |
| `playtests/storm.playtest.json`, `weather.playtest.json`, `tiers.playtest.json` | Second Tempest load levels: heavy storm and each quality tier |
| The full `playtests/` set | Behavior gate before keep |

## Known state (2026-10-16, engine 54c226867)

These numbers start the history. They are not a baseline for a new campaign: measure your own.

- GPU ms at 1920x1080: Wasm 113.6, legacy 43.5 (3 pairs). CPU ms is equal on both arms.
- At 960x540, both arms are about 3.5x faster, so the cost is per pixel.
- `reflections: false` saves about 19 ms on Wasm and 5 ms on legacy. About 55 ms of the gap has
  no named pass yet.
- Pose parity against stock three: full-frame mean diff 0.006 after the mat2 order fix.
- The rain playtest set passes 15 of 16 on Wasm. `lightning`/`thunderVoices` fails on both engines.
- Stock three itself is near 30 fps on the reference GPU, so T2 means beating stock three by more
  than 2.5x.
