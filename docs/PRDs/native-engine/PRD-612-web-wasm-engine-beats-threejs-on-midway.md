# PRD-612 — The web Wasm engine beats three.js on Midway

**Status:** PARTIAL
**Priority:** P1 — the owner bar is 1.5x faster than three.js on Midway in Chromium; the first matched pair reads 0.95x to 1.26x.
**Complexity:** 6 (MEDIUM)
**Owner:** João
**Depends on:** PRD-610 (the matched yardstick, the flight harness and the dashboard). PRD-610 moved its old AC-7 (the web Wasm engine against three.js) here.

## Context

On 2026-10-14 the owner set two targets (verbatim): "my goal is native 2-3x faster than web threejs. WASM ThreeNative 1.5 faster than ThreeJS (regular)", and "we need to optimize both native and wasm web in parallel". PRD-610 owns the native target. This PRD owns the web Wasm target.

The web Wasm arm is the ThreeNative engine compiled to Wasm and run in Chromium (`flight.sh native`). Three.js is the unmodified game in Chromium (`flight.sh legacy`).

### Matched baseline (pair 1 of 3, 2026-10-14)

Engine `e3271a19c`. Arms A (`ac15-e3271a19c-a1-legacy`) and C (`ac15-e3271a19c-c1-native`) ran the same 1,000-tick fixed-step scenario. C parity PASS against A and its visual ref. Xvfb, so CPU and instructions only. Host load 3.4 to 5.3.

| Pose | three.js CPU ms/frame | web Wasm CPU ms/frame | Ratio | Instructions/frame (three.js / web Wasm) | IPC (three.js / web Wasm) |
|---|---|---|---|---|---|
| takeoff | 9.09 | 8.90 | 1.02x | 41.3 M / 38.9 M | 1.07 / 0.99 |
| cockpit | 9.55 | 10.05 | 0.95x | 48.9 M / 43.7 M | 1.19 / 0.99 |
| rear gunner | 14.35 | 11.42 | 1.26x | 77.2 M / 49.8 M | 1.24 / 1.00 |

The same engine C++ runs on the native desktop player at 20.4 M / 22.7 M / 29.7 M instructions per frame (PRD-610 pair 1). The web Wasm arm runs about 1.7x to 1.9x more instructions for the same frame. The difference is the JS around each Wasm call and Wasm code generation, not WebGPU: an earlier profile put the WebGPU glue at about 1% (memory note "web engine cost is JS around calls"). The native IPC levers of PRD-610 (V8 pointer compression, HUD capture, thread placement) do not apply here: Chromium already ships them.

To reach 1.5x, the web Wasm main thread must drop to about 6.1 / 6.4 / 9.6 ms per frame, which is 2.8 / 3.7 / 1.9 ms less than now.

## Solution

Measure first, then cut the largest measured owner. Each lever is one A/B on the matched yardstick.

- **Yardstick:** the PRD-610 AC-15 pair. Each pair runs A (three.js, matched CPU), ref (three.js visual ref on A's scenario), B (native desktop) and C (web Wasm), and grades B and C against the same A and ref. Script: `ac15-pair.sh <n>` in the lane scratchpad; it refuses a pair when engine paths changed since the prepare step.
- **Owner profile:** `MIDWAY_CPU_PROFILE=1 sh scripts/midway-bench/flight.sh native <tag>` writes a browser CPU profile with CLOCK_MONOTONIC `clockBounds`. `scripts/midway-bench/profile-owners.ts` splits it by owner inside the held windows.
- **Levers:** picked from the owner profile by measured size. Candidates to test, not results: fewer JS-to-Wasm crossings per object (batched transforms and draw lists), typed-array views instead of per-call marshalling, and the "do less work" levers that PRD-610 lands in shared engine C++ (they cut Wasm instructions too).
- **Dashboard:** `http://127.0.0.1:8767/midway` shows a web Wasm panel beside the native panel, with the 1.5x target.

Measurement rules are the PRD-610 rules: Tier 2 is three alternating pairs per pose with parity PASS, keep a lever only when every B beats every A, no single-run millisecond verdict on a loaded host, record the host load, and a fresh visual judge for any change that can alter pixels.

## Acceptance Criteria

Boxes live under each phase.

## Blocked on

Nothing.

## Decisions

- 2026-10-15 (isolated visible/material-cache trial): removed rejected arena/fixed-arity changes from this lane before testing. Node `visible` setters preserve cached material labels, using the existing `__walk` class marker; other setters retain invalidation. Baseline regression is one failed / one passed case; fixed two pass, complete browser suite 45/45, package typecheck and Biome pass. Browser ESM and the frozen candidate game build pass; full CLI declaration generation fails because built assets/core declarations are absent. Candidate `~/.cache/tmp-tn/midway-native-visible` keeps all source/assets/content identical to baseline and changes only the installed browser runtime. Two exploratory pairs subsequently completed (results below); no qualification or integration; AC-3 remains open.
- 2026-10-14 (owner): the web Wasm arm runs in every matched pair, beside the native arm, and both show on the dashboard. Native and web Wasm optimization run in parallel.
- 2026-10-14 (lead): the target is 1.5x (owner), not the 2x that PRD-610's old AC-7 carried.

### Visible/material-cache recovery — INCONCLUSIVE CPU (2026-10-15)

Candidate `8c5f5ff4d`; baseline `midway-native-prof`, candidate `midway-native-visible`. Original `visible-resume-base-1` exited 75 before measurement on a 120-second capture-lock timeout; preserved as infrastructure failure, not game failure. Recovery used the existing `CAPTURE_LOCK=1 CAPTURE_LOCK_TIMEOUT_MS=900000` and unchanged `web-screen.sh`, scenario and frozen game content. No third timing retry or integration.

| Pair / pose | CPU ms/frame baseline → candidate | CPU change | Instructions M/frame baseline → candidate | Instruction change | IPC baseline → candidate | Host load1 baseline → candidate |
| --- | --- | --- | --- | --- | --- | --- |
| 1 takeoff | 9.377 → 9.147 | −2.45% | 38.676 → 37.765 | −2.35% | 1.022 → 1.008 | 5.09 → 6.29 |
| 1 cockpit | 10.458 → 10.206 | −2.41% | 43.028 → 42.733 | −0.68% | 1.015 → 1.026 | 3.95 → 6.10 |
| 1 rear | 13.474 → 10.594 | −21.37% | 49.679 → 48.630 | −2.11% | 0.907 → 1.112 | 4.78 → 5.10 |
| 2 takeoff | 8.914 → 13.356 | +49.83% | 38.922 → 37.850 | −2.75% | 0.994 → 0.703 | 5.07 → 17.37 |
| 2 cockpit | 10.943 → 16.066 | +46.81% | 43.769 → 40.690 | −7.04% | 0.927 → 0.629 | 3.39 → 18.10 |
| 2 rear | 13.238 → 17.423 | +31.62% | 49.858 → 48.834 | −2.05% | 0.888 → 0.695 | 4.14 → 20.44 |

Every candidate beats every baseline on instructions in all three poses; CPU fails that rule in all three. Pair 2 candidate's higher load and lower IPC confound CPU attribution; neither the CPU regression nor pair 1 rear improvement establishes a causal host-load explanation. Instruction reduction repeats, but is not a qualified performance win. All four actual reports PASS on NVIDIA/turing WebGPU, fixed-step, 3,948 reported frames, three runtime assertions plus diagnostics passing, and zero console/network/runtime diagnostic errors. Every pose has exactly 1,000 frames/updates/renders and tick difference, with matching tick ranges. No qualified parity or fresh visual-judge claim.

Raw sources: `~/.cache/tmp-tn/screens/visible-queue-{base,on}-{1,2}/run.log`; all four completed logs auto-published with timing exclusions. Live dashboard API had 179 runs at extraction. Cycle `web-visible-material-cache-queue` closes INCONCLUSIVE at the last wrapper terminal timestamp, 2026-10-15T06:49:37.800Z. AC-1 through AC-5 remain open.

## Execution Phases

### Phase 1 — Matched baseline and owner profile

- [ ] **AC-1 Matched baseline.** Three qualified pairs give the web Wasm vs three.js CPU ratio, instructions and IPC per pose, parity PASS. Pair 1 is in Context; pairs 2 and 3 are open. proof: `ac15-pair.sh 2` and `ac15-pair.sh 3`, dashboard web Wasm panel QUALIFIED
- [ ] **AC-2 Owner profile.** One CPU profile of the web Wasm arm splits the held windows into game JS, engine JS glue, Wasm engine code, WebGPU calls and browser work, with each owner's share and the crossings per frame. proof: `MIDWAY_CPU_PROFILE=1 sh scripts/midway-bench/flight.sh native <tag>` then `scripts/midway-bench/profile-owners.ts`

### Phase 2 — Levers

- [ ] **AC-3 First lever.** The largest AC-2 owner gets a lever. Three pairs: every B beats every A on CPU per frame and instructions per frame at all three poses, parity PASS. proof: three `ac15-pair.sh` pairs per arm
- [ ] **AC-4 Further levers.** Repeat AC-3 until the projected ratio reaches 1.5x, or record a re-plan under Decisions when the AC-2 owners cannot reach it. proof: three `ac15-pair.sh` pairs per lever

### Phase 3 — Final

- [ ] **AC-5 Final.** The web Wasm arm is at least 1.5x three.js CPU per frame at takeoff, cockpit and rear gunner, on three qualified pairs, parity PASS, visual judge NEUTRAL or better. proof: three `ac15-pair.sh` pairs at the final commit, visual-judge subagent verdict
