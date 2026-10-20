# Native world walk fixture

`tn-native-engine-player world-walk` streams four four-metre cells through `WorldCells` and
`PackageLoads`, renders positions from the same verified package bytes uploaded to the GPU along
a 168-tick camera path, then unloads.
`world-cycles` repeats the same path ten times. The build embeds this fixture's source path;
an optional second player argument selects another fixture directory with the same layout.

Each TNPK v1 cell contains a 72-byte position buffer and a one-texel RGBA8 texture. `world.json`
and `placements.bin` use the shipped world v1 validator and placement reader. The heightmap shapes
the cooked cell ground vertices through the shipped `HeightSampler`; computed normals, standard
materials, a directional sun and hemisphere sky light reveal the relief. Each placement also carries
a lit rock, sharing the permanent trail marker's sphere geometry. There is no tile LOD or collision.
No external assets or decoders are required. The complete fixture is under 1 MB.

The inspect resource `world.TN_FRAME_BUDGET` exposes the last measured admission and cumulative
maxima over **every driven tick**, including ticks between scenario steps: 4 ms for CPU world
admission (completion drain, residency, package upload and mesh publication), 1,024 bytes for
package admission plus renderer geometry uploads. Residency decisions have their own 1 ms budget.
Two persistent I/O workers start during player initialization and survive reloads; admission
dispatch creates no threads and unload joins none. Verification runs on those workers; uploads,
CPU geometry construction and scene publication remain inside the admission timer.
`violations` counts any tick over either allowance. Every driven world tick submits a render,
even when the runner sends a batched `advance`, and the maxima remain available after unloading.
These are ordinary `resources` numeric assertions; the playtest runner needs no new vocabulary.

Memory samples are taken eight rendered settling ticks after each unload, only when deferred GPU
destroys have retired. Linux CPU heap bytes are `mallinfo2().uordblks + hblkhd`; macOS uses allocator
statistics; ASan builds use `__sanitizer_get_current_allocated_bytes()`. These are live process-wide
allocator bytes, including backend allocations, rather than RSS. An unavailable allocator
observation is negative and fails the scenario. CPU noise is
limited to ±64 KiB per cycle by least-squares slope, with a 512 KiB range across all ten samples.
GPU buffer bytes count live cooked buffers and actual geometry attribute/index stores; texture bytes count
live cooked textures. Fixed renderer targets/programs are excluded from those byte totals. Live
handle samples cover the renderer's entire `GpuResources`, and geometry cache entries are sampled
separately. GPU bytes, handles and geometry entries must have zero slope; GPU bytes and handles
must also have zero range. The permanent marker retains three stores (positions, normals, indices),
696 bytes after unload. Every capture name includes its scenario to keep their artifacts distinct.

`world-fault` serves `cell-1-corrupt.tnpk` for cell `1:0`, including on the return path. One texture
payload byte differs from its table's SHA-256. `PackageLoads` refuses the whole cell with
`TN_PACKAGE_HASH`, subsystem `assets`, recovery `skip`. The cell stays absent without retry until
the world is unloaded; the camera keeps walking and all three other cells render. The scenario
requires exactly one diagnostic, the skipped key, completed good loads and the complete path.

Run from the repository root on a desktop with a GPU and display (the runner provides Xvfb):

```sh
node packages/playtest/dist/runner/cli.js packages/runtime-native/scenarios/native-engine-world-walk.playtest.json --target desktop --executable packages/runtime-native/build/tn-linux/tn-native-engine-player --host-arg world-walk
node packages/playtest/dist/runner/cli.js packages/runtime-native/scenarios/native-engine-world-cycles.playtest.json --target desktop --executable packages/runtime-native/build/tn-linux/tn-native-engine-player --host-arg world-cycles
node packages/playtest/dist/runner/cli.js packages/runtime-native/scenarios/native-engine-world-fault.playtest.json --target desktop --executable packages/runtime-native/build/tn-linux/tn-native-engine-player --host-arg world-fault
```

The CPU-only fixture check is `ctest --test-dir packages/runtime-native/build/tn-linux -R
'^native_engine_world_walk_fixture$' --output-on-failure`. It validates all four cooked packages,
the exact upload layout, the world manifest and the corrupt package's refusal. Linux Dawn builds
also register `native_engine_world_cycles_cpu` and `native_engine_surface_lifetime_cpu`: the Null
backend drives ten full cycles (with blits and timestamps when supported), prints the CPU series
and checks the unchanged budgets; a simulated swapchain checks real Null texture/view reference
ownership over 300 frames, failed acquisition and teardown. These CPU checks do not qualify
physical GPU execution, pixels or GPU admission timing.
