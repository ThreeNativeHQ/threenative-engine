---
name: measure-steady-state-fps
description: Verify that a ThreeNative game opens cleanly, then measure steady-state frame performance without counting startup, shader compilation, loading, or competing GPU work. Use for FPS, frame-time, hitch, smoothness, or "does the game open fine?" checks.
---

# Measure steady-state FPS

Treat opening correctness and steady-state performance as two separate results. A clean screenshot
does not prove smoothness, and startup frame times are not gameplay FPS.

## Preconditions

- Preserve the game working tree. Reuse an existing playtest or create any diagnostic scenario
  outside the project.
- Run the machine/project doctor first. Name unavailable targets instead of silently substituting
  another platform.
- Require the intended hardware adapter. Reject SwiftShader or another software adapter unless the
  user explicitly asks for software-renderer data.
- Run no other renderer, capture, benchmark, conformance lane, or GPU-heavy job concurrently.
- Check the OS-active window and GPU/CPU process list before measuring. Browser
  `document.hasFocus()` and `visibilityState` do not prove the compositor is presenting the window
  at full rate. The measured window must be OS-foreground and unoccluded. Do not close, suspend, or
  kill an unrelated workload without authorization; report the lane unavailable instead.
- Fix the viewport, target, scene, camera, quality settings, and gameplay workload for comparisons.

## 0. Validate the presentation lane

Read the active display refresh rate, then measure `requestAnimationFrame` on an empty page in the
same browser, display, viewport, and window state intended for the game. Reject the lane when the
control is materially below the display rate or locked to a clean divisor such as 15 or 30 FPS on a
60 Hz display. Investigate foreground/occlusion state, competing renderers, compositor throttling,
power policy, and software rendering before attributing the result to the game.

Presented FPS cannot exceed the active display's refresh rate. A 59.96/60 Hz display can validate a
60 FPS frame budget but cannot prove **beyond 60 presented FPS**; use a higher-refresh display for
that claim. An uncapped/offscreen throughput benchmark is a separate result and must not be labeled
presented FPS.

## 1. Prove the game opens

Run a short hardware-backed smoke playtest. Require runtime-ready, no console/network/runtime
errors, and a nonblank screenshot. Exercise one meaningful input and verify an observation changes.
Visually inspect the screenshot. Report this result independently from FPS.

## 2. Define the steady-state window

Wait until asset loading, pipeline/shader compilation, first-use effects, scene entry, and initial
AI/physics setup are complete. Then begin a fresh measurement window.

Prefer an explicit telemetry reset after settling. Read its implementation: a method named
`resetWindow` may reset only counters while leaving percentile samples, maxima, or circular buffers
intact. If old samples remain, either add a legitimate reset when change authorization exists or
run enough stable frames to overwrite the complete retained sample capacity. Never label a window
steady-state while it can still contain startup samples.

For `fps-framework`, `FrameStats` retains 4,096 wall-clock samples even after `resetWindow()`.
Therefore wait at least 4,096 frames after the 1.5-second in-game reset before reading p50/p95/p99;
the existing 6,600-tick endurance wait satisfies that condition. `playSpikes` resets, but the main
percentile ring must roll over.

## 3. Measure a representative workload

Measure at least 1,000 steady frames or 30 seconds, whichever is longer. Keep the workload relevant:
idle data proves idle only; movement, enemies, effects, and UI updates should match what the user
wants assessed. Repeat a comparison with the same scenario and machine state.

Use wall-clock frame deltas, not a simulation `dt` that may be clamped or smoothed. Capture sample
count, p50, p95, p99, worst frame, and frames over the project's hitch threshold. Include available
section percentiles such as game logic, renderer/host, physics, enemies, and UI commit time.

A deterministic playtest may advance ticks faster than the display presents. Reject implausibly
small frame deltas from that mode as simulation-tick telemetry. For FPS, run the game with normal
real-time pacing and sample actual presentation markers or `requestAnimationFrame` timestamps; use
the accelerated playtest only for behavior and section-cost assertions.

## 4. Report honestly

Lead with whether the game opened cleanly. For performance, name target, adapter, resolution,
steady-state warmup, measured frames/time, and workload. Report frame times first; derived FPS is
`1000 / frame_ms` and should be labeled as derived. Do not average percentile-derived FPS values.

Call a result unverified when startup was included, the adapter was software, another GPU job was
active, the sample window was too short, or the required target could not run. Preserve and link the
screenshot and machine-readable playtest artifacts when available.
