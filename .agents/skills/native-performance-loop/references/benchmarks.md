# Workloads, measurements, and existing harnesses

Read at campaign setup and when choosing a new experiment family. Repository paths below are
relative to the owning ThreeNative checkout. Inspect current CLI parsers or help before use;
these are routing pointers, not permission to assume a historical flag still works.

## Use two benchmark tiers

**Synthetic screening:** primitive workloads isolate a cost quickly. Reuse
`scripts/engine-load-test/` and its load ladder. Exercise static and moving objects, flat and nested
transforms, visible and culled objects, shared and varied materials, and single/multiple passes
only where the current harness supports them. Sweep around the observed performance knee rather
than always running the largest matrix. A static cube test does not prove animated gameplay,
streaming, UI or navigation performance.

**Real-game confirmation:** choose a game because its observed workload exercises the proposed
change, not because its name is familiar. Prefer existing scenarios and recorded input. Use a
representative route with movement, camera changes, effects, interactions and UI, plus an idle
control when useful. Show synthetic and gameplay results separately in the dashboard.

Known sandbox root on João's machine: `/home/joao/projects/threenative/sandbox/`. Discover it from
local configuration or sibling sandbox documentation elsewhere; never assume another machine has
this path. Sandboxes are external games, not engine worktrees. Read their own instructions and
preserve their work. Existing scenario names are starting points, not proof of native support or
performance coverage:

| Workload | Inspect first | Why choose it |
| --- | --- | --- |
| `midway-open-pacific` | `playtests/flight.playtest.json`, `launch.playtest.json`, `audio-realism.playtest.json` | Flight/camera movement, large-scene visibility and draw submission, first-use assets, audio and startup when profiling identifies these costs. |
| `wildwood` | `playtests/walk.playtest.json`, `reveal.playtest.json`, `pond.playtest.json`, `startup.playtest.json` | Traversal, scene reveal, vegetation/water and asset loading when those systems are active in the selected route. |
| Another installed game | Its config, asset manifest and meaningful playtests | Pick a different workload for animation, physics, AI, particles or UI when Midway/Wildwood do not exercise the bottleneck. |
| Scaffolded production platformer | `profile:production` and the template's performance scenario | Reproducible gameplay fallback and regression control when an external game cannot run. Name it as the fallback. |

Inspect what actually runs; do not invent object, draw, actor or asset counts. Add a minimal
representative native scenario if the existing one only proves launch. Do not change game content
between arms. A missing real-game lane leaves synthetic improvements provisional while other
experiments continue.

## Benchmark families

| Family | Primary observations | Supporting diagnosis and invariant |
| --- | --- | --- |
| Frame pacing and rendering | Real frame/present p50, p95, p99; missed frame budget; hitch count/duration | CPU game/update/render/host phases, GPU timestamps when available, submission/waits, pipeline compilation, draw calls, triangles, visible objects. Same rendered content, resolution and quality. |
| Simulation and JS/native boundary | Relevant update/physics/AI/animation phase time; real-game frame impact | Object/actor count, transforms, allocation/GC, native calls/bytes transferred, synchronization. Same input, simulation rate, collisions and outcomes. |
| Startup and streaming | Process start to first world presentation, ready and usable input; scene-entry/reveal stalls | Asset bytes/decode/upload, compile milestones, main-thread stalls; separate process-cold, app-cache-cold and warm launches. Do not label warm OS/driver caches cold. |
| Memory and resource lifetime | RSS/PSS or platform equivalent, JS heap, peak and growth over repeated scene cycles | GPU allocation if observable, retained handles/textures, GC pauses. Include native host and separate UI process where relevant; do not double-count shared memory. |
| Sustained efficiency and capacity | Late-run frame tails, time to throttle, power/energy if available; largest fixed-quality load within frame budget | Ten-minute physical-device runs for a promising thermal claim, early/late windows, temperature, charge state and clocks. Short samples cannot establish sustained performance. |

Do not collect every expensive metric for every idea. Baseline gameplay correctness and frame
pacing, then select the family that can falsify the hypothesis. Use targeted profiling first;
collect the wider regression set only for candidates that survive. For launch comparisons, use at
least five launches per arm when reporting startup p95, and show all samples; do not imply a precise
tail estimate from five observations. Match cache policy per pair without clearing user data.

## Targets and progress

Prefer a game's declared performance target. Otherwise use 60 Hz as an explicitly provisional
planning target: frame budget `1000 / 60 = 16.67 ms`, frame p95 within one budget and p99 within two.
Use 8.33 ms for a declared 120 Hz lane. Record the actual display refresh and present mode. Targets
are milestones, not stopping claims: continue reducing measured cost and hitches after meeting one.
Do not invent universal startup, memory or power limits; use existing product budgets, or record a
relative improvement target after observing the baseline.

Keep platform/device results separate. Desktop hardware can prove desktop speed; Android/iOS
emulators can prove behavior, not phone throughput or heat. Require the expected hardware GPU and
an appropriate foreground/presentation lane. Offscreen or uncapped throughput is a separate metric
from presented FPS. A 60 Hz display cannot prove more than 60 presented FPS.

## Reuse map

| Need | Existing entry point and important boundary |
| --- | --- |
| Machine/game/device readiness | `node packages/playtest/dist/runner/cli.js doctor --text`; add `--device <serial>` for Android. Read `packages/playtest/AGENTS.md` and `packages/runtime-native/AGENTS.md`. |
| Native gameplay and assertions | Existing `.playtest.json` via the playtest runner's `--target desktop\|android\|ios`. Desktop requires `--executable` and repeatable `--host-arg` for the actual game. Read the game's build/config scripts to find the bundle and app identity. |
| Native frame meters | `node packages/playtest/dist/runner/cli.js perf --file <log>`; also supports `--executable` with host args, or `--logcat <serial>`. Default JSON includes native frame and host-gap windows. Window 1 is discarded; `--require-windows` counts steady windows. Missing GPU timing is unavailable, not zero. |
| Primitive/load ladders | `pnpm bench:engines`; inspect `scripts/engine-load-test/cli.ts`. Native arms include `tn-desktop` and `tn-android`; controls include `--ladder`, `--modes`, `--frames`, `--warmup`, `--repeats`. No Godot dependency is needed merely to run a ThreeNative arm. |
| Production gameplay fixture | `pnpm profile:production -- --target desktop`; inspect `packages/runtime-native/scripts/profile-production.mjs` for target-specific config and duration options. It scaffolds/instruments a platformer: it does **not** automatically profile an arbitrary sandbox game. |
| Paired regression comparison | `scripts/performance-regression/compare.ts`, `scripts/performance-regression/lanes.json` and the load-test report parser. Reuse identity checks and alternating pairs. An uncalibrated or unavailable lane is not a passed gate. Existing regression tolerances do not themselves prove a meaningful improvement. |
| Rendering-stage diagnosis | `pnpm profile:native-cpu` / `scripts/profile-native-cpu.ts` actually drives Chromium/Playwright. Despite its name, its output is browser evidence; confirm any proposed gain with the native host. |
| Native conformance and presentation | `pnpm parity`, `packages/runtime-native/conformance/registry.json`, and relevant native playtests. Select affected cases, then run repository-required gates before delivery. |
| Sandbox installation | `pnpm sandbox`, `scripts/make-sandbox.ts`, sandbox package/config scripts. Rebuild and reinstall engine artifacts through the supported path; verify what binary and dependency closure the game executes. |

Use the existing meter parser rather than hand-reading markers or writing another log parser.
Where its output lacks a required percentile, use genuine raw samples or extend the shared meter
with a check; do not estimate p99 from p95 windows. Freeze that instrumentation before comparison.
Likewise, draw/triangle counts are workload diagnostics: optimizations can legitimately reduce them
while preserving output. A comparator's exact-count fixture gate must not be silently relaxed;
choose an appropriate predeclared scenario with visual and behavior checks for that experiment.
