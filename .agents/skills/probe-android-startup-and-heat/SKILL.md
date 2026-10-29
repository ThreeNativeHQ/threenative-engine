---
name: probe-android-startup-and-heat
description: Diagnose ThreeNative Android game startup stalls and heating with APK identity, phase timings, pipeline traces, CPU profiles, and controlled power measurements. Use when investigating slow first frames or excess device activity.
---

This skill belongs to the ThreeNative engine project. Follow the owning checkout’s AGENTS.md and the current packages/playtest and packages/runtime-native instructions.

Use measurements to distinguish avoidable work from device cost. Preserve the user's scene and
quality constraints. If asked for diagnosis or a handoff, do not turn it into a broad rewrite.

## Establish the subject

Record the exact installed APK SHA-256, source revision, package ID, target and render settings.
Compare local APK hash with the installed base.apk; a successful build alone proves no installation.
In tarball sandboxes inspect realpaths and the complete dependency/peer closure. Same versions can
contain different builds, and a node_modules symlink can mutate another project. Preserve such a
link before replacing it. Follow the repository's supported postinstall/patch mechanism when using
ignore-scripts; do not fix duplicate class identities with casts.

Separate load/enter, shader compilation, first world presentation, readiness and first input.
An asset counter at 100% does not mean a frame has been presented. A connected UI can be a
transparent HUD; only an explicit opaque cover justifies holding world rendering behind it.

## Choose the measurement

- Startup and driver work: read [startup.md](references/startup.md). Start with existing markers,
  then supported CPU sampling. Instrument pipelines only when those results leave a concrete gap.
- Heating or sustained activity: read [thermal.md](references/thermal.md). Use a controlled idle,
  game and cooldown comparison; startup profiling alone cannot explain steady-state heat.
- Three/WebGPU warm-up coverage: read [pipelines.md](references/pipelines.md). Build a tiny native
  reproduction before making claims about duplicate compilation or pipeline caching.

Prefer an emulator or desktop for functional behavior; use the physical device for claims about
its driver or power. Coordinate exclusive hands-off windows when interacting with the user's phone.
Keep sample commands bounded and record instrumentation overhead and cache state. Never clear app
data, alter thermal policy, or change kernel settings merely to get a measurement.

## Interpret and deliver

Keep observations, inferences and unknowns distinct. Do not turn object counts into pipeline counts,
cycle percentages into wall-time shares, electrical power into app-only heat, or desktop costs into
Android predictions. Include trailing pump silence even when no two pump events occurred. Missing
markers or failed captures are missing evidence, not zeros. Name the browser GPU adapter; a WebGPU
recipe may still select SwiftShader, especially without headed mode.

Change one lever at a time with a red-green behavior test and a native scenario. Preserve visual
output and movement. Report cache state and temperature for every timing comparison. Stop after
the repository's failure limit; name the unproven assumption rather than rotating flags indefinitely.
A successful experiment is not a hardware floor: prove which costs remain and whether they overlap.

Retain a compact receipt containing raw relevant markers, parsed counts, source probes, APK identity
and commands. Omit unrelated system logs and process details from published evidence. A handoff
should tell the next agent which bounded experiment resolves the largest uncertainty, which changes
were rejected, and which acceptance claims remain unproven.
