# PRD-573 — The performance bar is a scorecard on named scenes

**Status:** NOT STARTED
**Priority:** P1 — no report carries tails, counters, memory and a Godot ratio for both engines, so no cycle KPI in the epic can be checked (Phases 1–3 open).
**Complexity:** 3 (LOW) — 1–5 tooling files (+1), memory and host-load readings are new report fields (+2); risk override: none
**Owner:** João
**Cycle:** v1. Phases 1–2 need nothing from the engine. Phase 3 needs v1 slices 6 and 7.
**Depends on:** None for Phases 1–2. Phase 3: the V8 player (slice 6) and the Wasm engine with `profile:wasm-page` (slice 7).
**Estimate:** Phase 1 ≈ 4 h; Phase 2 ≈ 6 h; Phase 3 ≈ 6 h plus runs.

## Context

The cycle KPIs in the [epic README](./README.md) are same-run ratios: native against legacy (v1),
native against Godot desktop (v2, v3). No single report holds them. What exists (read 2026-10-11):

- `perf` (`packages/playtest/src/runner/perf.ts`, develop) reads `--file`, `--executable` or
  `--logcat <serial>`. It already reports p95, p99 and hitch windows. It reports no memory and no
  host load.
- `pnpm bench:scoreboard` (`scripts/engine-load-test/scoreboard.sh`, develop) runs the legacy
  `tn-desktop` arm against `godot-desktop` on the L1–L4 and R1–R5 ladders, three alternating runs per
  engine. The last result is PRD-464 R5: TN 104 fps against Godot 195 fps (legacy host). It reports
  medians only, and no load, memory or web row.
- `pnpm bench:engines` runs the R-ladder only on the `--arm` path (legacy and Godot). The native
  arms (`--arms current,native,native-v8 --workloads ...`, feature branch) run only the
  `heterogeneous`, `skinned-crowd` and `holdout` workloads. `scripts/engine-load-test/run-godot.ts`
  has no workload support, so a Godot ratio exists only on the ladders.
- `pnpm profile:wasm-page` (`scripts/profile-wasm-page.ts`, feature branch, lands with slice 7)
  compares a subject and a control page. Its `--load` flag means load phases (`TN_LOAD_STEP`), not
  host load. It reports no memory.
- No soak command exists on develop: nothing runs 1800+ frames and checks RSS growth.

Midway is a sandbox game in another repository. It is a report row, not a regression gate: no other
agent or CI job can rerun it. In-repo scenes (`heterogeneous`, `skinned-crowd`, the R-ladder) gate.

### What Unreal does (UE 5.8.3, design reference only)

Per-frame named stats (`Runtime/Core/Public/ProfilingDebugging/CsvProfiler.h`) and a budget per stat
that colours pass or fail (`Programs/CSVTools/PerfReportTool/Summaries/StatBudgetsSummary.cs`).
Frame-cost goals fail on hitches, so a scorecard needs tails, not only medians.

## Solution

1. **Every timing row carries p50, p95, p99 and a hitch count** (frames over 2x the median), and
   every report carries `hostLoad` (one-minute load average) and the core count. Above half the core
   count, absolutes are marked `invalid-absolute`; same-run ratios stay valid.
2. **Counter columns** (draw calls, engine calls, WebGPU calls, pipeline compiles per frame) sit
   beside the timings, because a counter holds a claim under host load.
3. **Memory and soak.** Peak RSS (`VmHWM`) for native desktop, `dumpsys meminfo <pid>` PSS on
   Android, Wasm memory and JS heap on the web. A soak command runs 1800+ frames and fails on a
   crash or on RSS growth.
4. **One scorecard, both engines.** The R-ladder runs on the native `native-v8` arm. A `godotRatio`
   column comes from the `bench:scoreboard` R2, R3 and R5 rows. No Godot row exists for a workload
   that `run-godot.ts` cannot run.

## Execution Phases

#### Phase 1: Reports carry tails, counters and host load
**Status:** NOT STARTED
**Files:** `scripts/engine-load-test/` (report writer, `scoreboard.sh`), `packages/playtest/src/runner/perf.ts`, specs under `scripts/__tests__/` and `packages/playtest/__tests__/`
- [ ] `bench:engines` and `bench:scoreboard` rows report p95, p99 and the hitch count beside p50. proof: a red-green case in the engine-load-test report spec with a stubbed frame series
- [ ] `perf` and `bench:engines` reports carry `hostLoad` and the core count, and mark absolutes `invalid-absolute` above half the core count. proof: a red-green case in each spec with a stubbed load reading
- [ ] `bench:engines` rows carry draw calls and pipeline compiles per frame where the arm reports them, and fail closed when a requested counter is missing. proof: a red-green case in the engine-load-test report spec

#### Phase 2: Memory and the soak command
**Status:** NOT STARTED
**Files:** `packages/playtest/src/runner/perf.ts`, `packages/playtest/src/runner/cli.ts`, `package.json` (one soak script)
- [ ] `perf --executable` reports peak RSS (`VmHWM`) for the desktop player. proof: a red-green case in `packages/playtest/__tests__/perf.spec.ts`, then `node packages/playtest/dist/runner/cli.js perf --executable <player> --target desktop --text` printing a non-zero peak RSS
- [ ] `perf --logcat <serial>` reports PSS from `dumpsys meminfo <pid>`. proof: a red-green case in `perf.spec.ts` with a stubbed `dumpsys` output, then one run on the Android emulator
- [ ] A soak command runs 1800+ frames and fails on a crash or on RSS growth over a stated bound. proof: a red-green case in `perf.spec.ts` (a growing stubbed RSS series fails), then one run on the legacy desktop host

#### Phase 3: One scorecard on both engines, baseline recorded
**Status:** NOT STARTED
**Files:** `scripts/engine-load-test/cli.ts`, `scripts/profile-wasm-page.ts`, `docs/verification/runtime-perf-state.md` (the owner's in-place exemption)
- [ ] The R-ladder runs on the `native-v8` arm, and one invocation compares `tn-desktop` and `native-v8` on R5. proof: a red-green case in the engine-load-test spec, then `pnpm bench:engines` with both arms on R5 in one invocation
- [ ] `profile:wasm-page` reports `hostLoad`, p95, p99, the hitch count and `--memory` (Wasm memory, JS heap) for subject and control. proof: a red-green case in the profile-wasm-page spec, then `pnpm profile:wasm-page -- --url <native page> --control <three.js page> --cpu-work --memory --json`
- [ ] The v1 baseline is recorded: R5 native/legacy, R2/R3/R5 TN/Godot (`godotRatio`), Midway web native/three.js, with tails, counters, memory and load average. proof: `pnpm bench:scoreboard` and the two commands above in one load window, rows in `runtime-perf-state.md`

## Decisions

- 2026-10-12 (owner, cycle plan): the bar is the cycle KPI list in the epic README. It replaces the
  earlier proposed bar ("CPU busy at most 1/3 of three.js", "no slower than `godot-desktop` on
  `heterogeneous`"); the second had no Godot workload to run on.
- A "CPU busy" win is never reported alone: frame p50 and p99 ride in the same row (the epic opened
  with CPU busy 2.32x better beside frame p50 0.24x).

## Blocked on

- The v3 margin over Godot is an owner number. João sets it before v3 starts.
- An Android timing row needs the Pixel 8 attached; the emulator holds only counter and memory rows.
