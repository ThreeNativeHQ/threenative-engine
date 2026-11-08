# G4 — threading and native systems

**Milestones:** M7, M8, M9, M10, M11
**State:** IN PROGRESS — native Rapier plus bounded Linux and Android-emulator positional
audio executed; worker, asset-pipeline, iOS-audio, and physical-output evidence remain open.

The runtime still owes its worker/thread model, JobSystem, native asset pipeline, and mobile
audio evidence. Android QuickJS has no WebAssembly; native physics uses the coarse
host-neutral bulk ABI under `globalThis.__THREENATIVE_NATIVE__.physics`, never a per-object
frame hot path.

PRD-052 removed Recast from the platformer's portable graph in favor of template-local
steering. Recast navigation remains browser-only; a native navigation ABI is not accepted
debt without new measured demand.

## Bounded positional-audio graph — 2026-08-09

The pre-existing native audio types exposed `AudioNode::outputs_` and `GainNode::process`,
but JavaScript `connect()` was a no-op and the SDL callback mixed sources directly. The
repaired path routes each source through its connected nodes, supports gain automation calls
used by Three.js, and adds a listener-relative stereo `PannerNode` with inverse, linear, and
exponential distance models. HRTF convolution and directional cones are not claimed.

The compiled `threenative-audio-graph-test` produced:

```text
audio graph ok: ramp-mid=0.5 gain=0.5 right=0.1 flipped-left=0.1 ended=1
```

An import-free bundle of `tests/audio-play-at-smoke.ts` then ran on the rebuilt Linux V8,
Dawn/Vulkan, SDL host with the dummy audio driver and emitted:

```text
TN_NATIVE_AUDIO_PLAY_AT_OK:createPanner+gain+source+ended
```

The completion edge is atomic: SDL removes the ended source under the mixer lock, then the
runtime loop invokes its JavaScript `onended` callback on the main thread. The host proof
waited for that callback and asserted `AudioBus.voices` returned to zero. Fixed-size,
context-owned 8,192-float scratch arrays keep the callback allocation-free and prevent the
initializer-list overflow found by the host test. The same rebuilt host passed the ordinary
300-frame desktop core gate at 1280×720. This is Linux graph and binding evidence, not audible
hardware quality, Android, iOS, HRTF, or mobile parity evidence. No generated template caller
should become portable until those platform rows execute.

The same `tests/audio-play-at-smoke.ts` source was then bundled as an import-free IIFE,
packaged through `package-android.mjs`, installed, and cold-launched on `emulator-5556`.
Android QuickJS emitted the same completion marker:

```text
TN_NATIVE_AUDIO_PLAY_AT_OK:createPanner+gain+source+ended
```

This executes `AudioContext`, `createPanner`, source → panner → gain routing, the SDL audio
callback, main-thread `onended`, and `AudioBus` voice release on Android x86_64. The proof
process exited successfully after the marker. It does not prove audible speaker output,
device latency, arm64, iOS, or physical-driver quality.

`pnpm budgets` reports 53,851 native runtime LOC, 3,851 above the review trigger. The
kill-switch pass retained only the graph plumbing needed to make the already-public
`AudioBus.playAt()` contract work: node traversal, bounded gain automation, distance/pan,
and the binding/test seam. HRTF, cones, buses, ducking, worker abstractions, and a portable
template caller were not added. Removing this bounded graph would restore the proven native
`connect()` no-op, so the retained code is cheaper than exposing a platform-specific API lie.
The Android evidence added no runtime path; it only made the existing proof source a classic
script and locked that portability constraint in the contract test.

## The game thread wins the CPU (PRD-859) — 2026-11-08

The Linux engine player now gives its frame-critical threads (the game thread, `tn-gpu` and
`tn-render`, which name themselves at creation) nice −10, Unreal's `TPri_AboveNormal` on Unix. It
uses `setpriority` when `RLIMIT_NICE` allows it, else rtkit's `MakeThreadHighPriority` over the
system bus through `libsystemd.so.0` loaded at run time. Every other player thread and every child
process yields at nice +10 (`TPri_Lowest`), which needs no privilege. SDL's own audio device threads
keep what SDL set. A refused raise prints `TN_PROCESS_PRIORITY_RAISE_REFUSED` once and the player runs
on. `TN_PLAYER_PRIORITY=normal` (`display.priority: "normal"`) turns both levers off. Each change
prints one line read back from the OS, for example:

```text
TN_PROCESS_PRIORITY game=-10 render=-10 present=-10 background=16 source=rtkit override=none
```

`tests/native-engine/player-thread-placement.mjs <player> --x11` under `scripts/xvfb.sh` passed four
arms on the Linux desktop (Ryzen, 24 CPUs): the default (`source=setpriority`), `prlimit --nice=0`
(`source=rtkit`), `prlimit --nice=0` with no system bus (`source=none reason=EACCES`, nice values
unchanged, the player still runs) and the override. Background threads read 16, not 10, on this host
because ananicy-cpp files `node` (the test parent) as `BG_CPUIO`; the player only lowers, never raises,
a background thread. Windows and macOS are not covered by this record.

Android (legacy `mystral` host, `src/platform/android_main.cpp`): the SDL game thread is set to nice -4,
which equals the `THREAD_PRIORITY_DISPLAY` that SDL's own `SDLMain` already applies
(`SDLActivity.java:2174`). The gain is elsewhere: every other app thread moves to `SCHED_BATCH` at nice
+10, except the Java main thread, `RenderThread`, `hwui*`, binder threads (`binder:`/`Binder:`, whose
priority the binder driver sets per call) and `SDLAudio*`; and an ADPF hint session (API 33+, resolved
with `dlsym`) gets each frame's work time from `paceToPresentationCap()`. On the `threenative_api35`
emulator (x86_64, `-gpu host`, RTX 2080 adapter, QuickJS build) the device smoke passed and logcat
read `TN_PROCESS_PRIORITY game=-4 background=10 batch=21/21 source=setpriority adpf=on override=none`;
`/proc/<pid>/task/*/stat` read 19 threads at policy 3 (`SCHED_BATCH`). `display.priority: "normal"`
(manifest `TN_PRIORITY`) read `batch=0/20 source=none adpf=off override=normal`. A physical device is
not covered by this record.
