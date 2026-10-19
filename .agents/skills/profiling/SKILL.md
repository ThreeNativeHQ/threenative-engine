---
name: profiling
description: Choose and run ThreeNative's shipped profiling, frame-meter, benchmark, diagnostic and parity tools for a performance question, and route one authoritative steady-state reading to measure-steady-state-fps. Use when asked to profile, attribute a frame, measure FPS or frame time, benchmark engines, or diagnose native or Android performance. Not for making the code faster (use perf-loop).
---

# Profiling

Pick the smallest instrument that can falsify the question, run it, and claim only what that lane
proves. All commands are shipped; use the documented flags, not invented ones. Then link the owning
skill or doc instead of copying its procedure.

## Rule

A profiler attributes cost inside a frame or run. A benchmark compares throughput between builds or
engines. A diagnostic answers "can this machine/device run the lane at all". A parity check proves
behavior equivalence, not speed. Never present one as another: a CPU number is not FPS, a benchmark
is not presented frame time, and a parity pass is not a performance result.

## Profilers and frame meters

| Tool | Command | Use when | Platform / prerequisite | Output | Limit |
| --- | --- | --- | --- | --- | --- |
| Frame budget meter | `TN_FRAME_BUDGET`, `TN_FRAME_HITCH`, `TN_HOST_GAP`, `TN_PROJECTION` stdout markers | Any frame-time question | Any game; on by default | Per-window frame/render/update/ui/gpu `ms`, host-gap segments | `gpuMs` sampled 1 frame in 8 (`renderer.gpuTimestampFrameInterval`) |
| Frame-meter reader | `node packages/playtest/dist/runner/cli.js perf --file <log>` / `--executable <bin> --host-arg <a>` / `--logcat <serial>`; `--text` | Turn a log or live host into fps + p50/p95 | Built `@threenative/playtest`; desktop needs `--executable` | JSON by default; `--text` table; window 1 dropped as startup | Refuses fps and `--min-fps` on a private Xvfb (`TN_PERF_VIRTUAL_DISPLAY`) unless `--allow-virtual-display` |
| Browser function trace | `npx @threenative/playtest trace --url <url> --text` (`--seconds`, `--key`, `--no-input`, `--stall-ms`, `--out`) | A slow/hitchy frame where the percentile is not enough | Headed WebGPU browser; game reachable | Named JS functions and stalls; raw JSON for DevTools | Traces the tail; a parked camera under-reports. Details: `packages/create-threenative/agent-docs/references/trace-a-slow-frame.md` |
| V8 CPU profile | `TN_JS_CPU_PROFILE=1 <host>` (window via `TN_JS_CPU_PROFILE_START_FRAME`); `--cpu-prof <file>` on the host (`mystral run <script> --cpu-prof=<file>`) or a playtest (`node packages/playtest/dist/runner/cli.js <scenario> --cpu-prof <file>`) | Attribute JS self-time; open a DevTools profile | Host built with the profiler (desktop default); `--cpu-prof` is browser/desktop only (device refuses `TN_PLAYTEST_CPU_PROFILE_UNSUPPORTED`) | `TN_JS_CPU_PROFILE:` / `_TOTAL:` marker lines; a Chrome DevTools `.cpuprofile` | Perturbs the frame; diagnose only, never a timing verdict |
| Profiled-host counters | Build host `-DTN_ANDROID_JS_PROFILE=ON`, run `node packages/runtime-native/scripts/measure-android-js-engine.mjs --device <serial>` or `measure-desktop-frame-pair.mjs --control <bin> --candidate <bin> --bundle <dir> --output <dir> --runs <n>` | Per-frame JS↔host binding/command cost | Profiled host; physical Android for acceptance | `TN_ANDROID_JS_NATIVE:` and `TN_BRIDGE_BY_NAME:` markers | Profiled build inflates absolutes; emulator proves plumbing only. Recipe: `packages/runtime-native/docs/G5-profiling.md` |
| Linux OS `perf` (optional) | `perf stat -p <host-pid>`; `perf record -e cpu-clock:u --call-graph dwarf -p <host-pid>` then `perf report`; start the host with `packages/runtime-native/build/tn-linux/mystral run <script>` (or under `perf record -- …`) | Native C/C++ CPU attribution the V8 `.cpuprofile` cannot name | Linux; a kernel-matching `perf` from the OS package (`linux-tools`/`linux-perf`), an unstripped host for symbols; unprivileged sampling can be blocked by `perf_event_paranoid` (an OS/operator setting) | `perf stat` counters; `perf.data` + `perf report` call tree | Optional system executable; no bundled binary, wrapper, automatic install or sysctl change. Resolves native frames only — V8/JIT frames stay unnamed, so pair with `--cpu-prof`; no shipped flamegraph or JIT-symbol helper |
| Chromium JS CPU profile | `pnpm profile:native-cpu` (`:fox` = `--visual-evidence fox-scale --allow-software`) | Isolate shared JS cost across scenarios in the browser | Playwright Chromium; `--output-dir` (default `artifacts/native-cpu-profile`) | Samples, stage/render advisor, optional PNGs | Chromium only; proves nothing about the native host |
| Android cold start | `node packages/runtime-native/scripts/measure-cold-start.mjs` | Attribute launch time per segment | Physical Android (emulator exits `TN_COLD_START_EMULATOR_BLOCKED`) | `TN_COLD_START:` segment stamps, median/p95 | Emulator proof is plumbing only. Record: `packages/runtime-native/docs/G5-profiling.md` |

**Three different `perf`s.** Linux `perf` is an optional OS executable: no shipped command spawns
it, there is no wrapper, flamegraph or JIT-symbol helper, and the framework does not install it or
change sysctls. The playtest `perf` subcommand (`node packages/playtest/dist/runner/cli.js perf`) is
unrelated — it reads `TN_FRAME_BUDGET` markers from a log, executable or logcat. Android device CPU
uses `simpleperf` (below), not Linux `perf`. Keep the host unstripped so native frames resolve; the
embedded V8 JIT leaves JS frames unnamed, so use `--cpu-prof` for those.

## Benchmarks and production profiles

| Tool | Command | Use when | Output | Limit |
| --- | --- | --- | --- | --- |
| Engine matrix | `pnpm bench:engines --arm <tn-web\|tn-desktop\|tn-android\|godot-*> --ladder <n> --modes <L1,L2,R1..R5> --frames <n> --warmup <n> --repeats <k> --source-sha <sha>` | Compare arms/engines at controlled scale | `artifacts/engine-load-test/<out>/` report JSON | Synthetic throughput; not presented FPS |
| Matrix report / dashboard | `pnpm bench:engines:report`; `pnpm bench:engines:monitor` | Read or poll a campaign | Markdown / offline HTML | Monitor copies retained evidence; adds no verdict |
| Hardware regression collection | `pnpm tsx scripts/performance-regression/run.ts --lane <id> --baseline-source-sha <sha> --candidate-source-sha <sha> [--out path] [--required]`; bounded one target: `pnpm bench:engines --regression-collection --target <web\|desktop\|android\|ios> [--device id] [--prebuilt-artifact path] [--out path]` | Independent alternating baseline/candidate pairs on real hardware | `artifacts/performance-regression/<lane>.json` + markdown | Physical hardware for acceptance (emulator proves plumbing); `run.ts` needs both worktrees and `scripts/performance-regression/lanes.json` |
| Hardware regression verdict | `pnpm bench:engines --regression --input <report.json> [--lanes path --lane id] [--policy policy.json] [--out summary.json]`; gate one report: `pnpm bench:engines --check-report <report.json> [--required-baseline --lanes path]` | Paired baseline/candidate verdict, or refuse a regression | Markdown + summary JSON; exits 1 on a regression | Same lane/device required; `--check-report` needs the lane manifest |
| TN vs Godot scoreboard | `pnpm bench:scoreboard [tag]` | One cube-scene cross-engine scoreboard | `artifacts/engine-load-test/prd-449/` | Physical display, uncapped; not a gameplay claim |
| Production profile | `pnpm profile:production --target <desktop\|desktop-pair\|web\|android[-physical]\|ios[-physical]> --repetitions <n> --warmup <s> --duration <s> [--control slow-native]` | Scaffolded-game regression with provenance | `<project>/artifacts/production/…/production-evidence.json` | `slow-native` control only on `desktop-pair`; needs the scaffolded project |
| Host boundary | `pnpm bench:host-boundary` (root script; owns `@threenative/runtime-native`, executable `build/tn-linux/mystral`) | Native host↔V8 crossing cost | `TN_HOST_BOUNDARY:` stdout JSON | Linux preset and a host built by `pnpm native:build`; crossing µs, not FPS |
| Starter browser profile | `pnpm profile:starter -- [--variant baseline\|no-sculpture] [--seconds <n>] [--json] [--allow-software]` | Quick frame summary of a scaffolded starter | stdout / JSON | Software GPU makes times meaningless unless intended |

Existing example load scene: `examples/native-cpu-load-test/` (`vite`).

## Diagnostics, parity and in-progress CPU tooling

| Tool | Command | Use when | Output | Limit |
| --- | --- | --- | --- | --- |
| Machine/project doctor | `node packages/playtest/dist/runner/cli.js doctor --text` / `--url <url>` / `--device <serial>` | Before spending a run | Target, scene and device/thermal availability | Preflight, not a measurement |
| Native desktop proof | `pnpm native:verify:desktop` | Prove the host builds and presents | 300 frames, markers, non-blank screenshot | Correctness proof, not a speed claim |
| Web/native parity | `pnpm parity`; `pnpm parity --project <path>` | Same scene browser vs native | `packages/runtime-native/conformance/registry.json` report | Unselected rows are blocked; equivalence, not speed |
| Android CPU + device fps | `adb shell simpleperf record --app <package> -f 99 -g` with a `TN_ANDROID_JS_PROFILE=ON` host; `adb shell dumpsys SurfaceFlinger --timestats` | Attribute device CPU time; independent present-interval fps | simpleperf data/report by DSO and symbol; SurfaceFlinger interval histogram | Physical Android; symbolize against unstripped `libv8android.so`; emulator proves plumbing only. Owner: `probe-android-startup-and-heat` |
| Opt-in Labs CPU | `pnpm bench:engines --cpu-setup`; `pnpm bench:engines --cpu --source <abs checkout> --name <name>`; compare with `pnpm bench:engines --cpu-compare --baseline <abs saved-run dir> --candidate <abs saved-run dir>` | Focused Node/V8 CPU microbenchmark without a GPU scene | `artifacts/engine-load-test/cpu/<run-id>/` (`labs/results/<name>.json`, `provenance.json`) | CPU-only `node-cpu`; Node floor 22.12 (framework floor is 20.19). Measures actual selected-checkout loop dispatch and coalesced state publication. Explicit setup uses a frozen isolated install with scripts disabled; ordinary install/build does not load Labs. Reports retain upstream warnings and exits without a ThreeNative timing verdict. Never report as FPS, GPU or native parity. |

## Workflow — smallest suitable tool

1. **Does it run here?** `doctor` (`--url`/`--device` for the lane). Name an unavailable target.
2. **"How fast is the frame?"** Frame meters, read with `perf`; for one authoritative reading use the
   `measure-steady-state-fps` skill.
3. **"Which function is slow?"** `playtest trace` before changing any line.
4. **"Which creates the cost — JS, host, device?"** `TN_JS_CPU_PROFILE=1` or `--cpu-prof` on a built
   host; Android launch with `measure-cold-start.mjs`; JavaScript-only cost with `profile:native-cpu`;
   device CPU with `simpleperf` (owner: `probe-android-startup-and-heat`); native Linux C/C++ only,
   when the `.cpuprofile` cannot name it, with the optional OS `perf`.
5. **"Which arm/engine is faster?"** `bench:engines`; production regression with `profile:production`;
   hardware regression with `--regression-collection`, then `--check-report` and `--regression`.
6. **"Is behavior the same?"** `pnpm parity`. **"Pure Node CPU?"** Labs (`--cpu`, then `--cpu-compare`).
7. To actually make it faster on measured keep/reject, use the `perf-loop` skill; for sustained native
   campaigns, `native-performance-loop`; for Android launch and heat, `probe-android-startup-and-heat`.

The sweep harness measures agent friction, not frame cost: `pnpm sweep:measure <sandbox>` reports source
LOC/reach and `pnpm sweep:judge` scores visuals blind. Those are the `self-improve` and `build-on-sandbox`
skills; do not present a sweep number as a performance result.

Report target, adapter (reject SwiftShader), resolution, warmup, sample count/window and workload.
Lead with frame time; label derived FPS as derived. A result is unverified when startup was included,
the adapter was software, another GPU job ran, the window was too short, or the target did not run.

Details: [playtest perf reference](../../../packages/playtest/docs/reference.md),
[performance basics](../../../packages/create-threenative/agent-docs/references/performance-basics.md),
[G5 profiling](../../../packages/runtime-native/docs/G5-profiling.md),
[runtime perf state](../../../docs/verification/runtime-perf-state.md).
