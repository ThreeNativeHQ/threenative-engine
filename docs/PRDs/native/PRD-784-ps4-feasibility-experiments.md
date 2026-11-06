# PRD-784 — PS4 feasibility: emulator experiments, then one engine cube on the console

**Status:** PARTIAL — E1 to E4 green on `PS4_EMULATED`
**Priority:** P2 — Owner-requested feasibility: boxes E1 to E6 and the Blocked on console run are all open, and no release waits on them.
**Complexity:** 7 (HIGH)
**Owner:** Joao Paulo Furtado (console steps only); agent (everything else)
**Depends on:** None

Complexity: 6 to 10 implementation files (+2), new platform module (+2), new independent build
target (+2), external toolchains (+1) = 7. Risk override: none.

## Context

The owner wants to know if ThreeNative can run on a PS4, and wants at least one proof of concept on
the console. Emulator runs come first, so the work costs the owner as little time as possible.

[`docs/spikes/PS4_PS5_Emulation_Spike.md`](../../spikes/PS4_PS5_Emulation_Spike.md) (2026-08-27)
already maps the landscape. This PRD keeps its evidence labels and its fail-closed rule. It replaces
the parts below, because the spike predates the C++ engine decision of 2026-10-15.

| Spike says | This PRD says | Why |
| --- | --- | --- |
| Upstream `three/webgpu` on the host | The C++ engine behind the Three.js API | It is the default engine (`docs/architecture/NATIVE-ENGINE-DECISION.md`) |
| QuickJS as the bootstrap runtime | V8 only | Owner decision below |
| PS4 and PS5 lanes in parallel | PS4 only | Owner asked for PS4 |
| Trace recorder, bundle schema, 22 sections of process | One runner script, one log marker, one image check | Enough to answer a feasibility question |

### Checked on 2026-11-02

| Fact | Result | Source |
| --- | --- | --- |
| The engine draws through `webgpu.h` | ✅ The seam survives the spike | `packages/runtime-native/src/engine/renderer/renderer.cpp` |
| shadPS4 is current and boots a raw ELF on Linux | ✅ v.0.21.0, 2026-10-30, has a Linux SDL build and `--mount` | GitHub release, README, `src/main.cpp` |
| OpenGNM supports shadPS4 by design | ✅ `driver_orbis.c` forwards to the HLE `sceGnm*` | `PS4-OpenGNM/opengnm` docs |
| `opengnm-psbc` ran on a console | ✅ Project reports VS and PS shaders on FW 9.00, GFX7 | Project README, not run here |
| `vulkan-ps4` is a Vulkan 1.0 driver with compute | ⚠️ Project claim, not run here | Project README |
| Dawn runs on that driver | ❌ Dawn rejects a driver below Vulkan 1.1 | `dawn/native/vulkan/BackendVk.cpp`, `kRequiredVulkanVersion` |
| wgpu runs on that driver | ⚠️ wgpu has a Vulkan 1.0 path that needs `VK_KHR_maintenance1`, and a PS4 Rust target is unverified | `wgpu-hal/src/vulkan/adapter.rs` |
| V8 builds for the OpenOrbis target | ⚠️ Unverified, and JIT memory on PS4 is unverified | No source found |
| The player has a PS4 window path | ❌ `player/run.cpp` has 62 `SDL_` uses, and a PS4 SDL3 port is unverified | Repository search |
| OpenGNM has more than one maintainer | ⚠️ Two stars per repository, so a fork is likely | GitHub API |

## Solution

Run the cheapest experiment that can kill the idea first. Each experiment has a pass result, a
budget and a named pivot. Stop when a pivot also fails, and record why under `## Decisions`.

```mermaid
flowchart TD
    E1["E1 hello ELF in shadPS4"] --> E2["E2 vulkan-ps4 triangle"]
    E2 --> E3["E3 webgpu.h triangle"]
    E1 --> E4["E4 V8 runs a script"]
    E3 --> E5["E5 engine cube, 300 frames"]
    E4 --> E5
    E5 --> E6["E6 one-command console bundle"]
    E6 --> HW["Console run, Blocked on"]
```

| # | Question | Pass result | Budget | If it fails |
| --- | --- | --- | --- | --- |
| E1 | Does our toolchain produce an ELF that shadPS4 boots? | ELF prints a marker to the emulator log, with no Sony module | 1 hour | If shadPS4 asks for firmware modules, add the owner dump line. If the boot still fails, stop |
| E2 | Does the Vulkan driver render in the emulator? | Non-blank triangle capture | 3 hours | Try the `freegnm-examples` GNM triangle to isolate the layer. If only GNM works, E3 pivots to route C |
| E3 | Which `webgpu.h` runs on PS4? | Triangle drawn through `webgpu.h`, shaders compiled at run time | 1 day | Move down the routes below |
| E4 | Does V8 run on PS4? | Script result in the log, and the mode (JIT or `--jitless`) recorded | 1 day | Try `--jitless`. If that fails, stop and ask the owner, because V8 is the owner's choice |
| E5 | Does the engine run? | 300 frames, a guest readback that is not blank, cube pose differs between frames | 2 days | Record the first failing call, then ask if the cost is worth it |
| E6 | Can the owner run it in minutes? | One command builds and sends the E5 artifact to a console address | 2 hours | The owner runs the steps by hand |

Budgets are estimates of agent time, not measurements.

**E3 routes, best first:**

| Route | Rating | Trade-off |
| --- | --- | --- |
| A. Dawn on `vulkan-ps4`, with the driver patched to report Vulkan 1.1 | ⭐⭐⭐⭐⭐ | Same backend as desktop. C++, so it uses the same compiler. Risk: the driver may lack required 1.1 behavior |
| B. wgpu-native on `vulkan-ps4` | ⭐⭐⭐ | Accepts Vulkan 1.0 and is the Android seam. Risk: Rust target and standard library for this platform |
| C. Narrow `webgpu.h` over `vulkan-ps4` or GNM, limited to the calls the cube makes | ⭐⭐ | Smallest dependency. Risk: we own WebGPU semantics and WGSL translation |

**Window path:** try SDL3 with its dummy video driver first, so the `SDL_` calls in `run.cpp` stay
unchanged. Present through the `vulkan-ps4` VideoOut swapchain. Clone the platform entry from
`src/platform/android_main.cpp`. Replace SDL only when E5 proves the dummy driver cannot work.

**Evidence rule:** each result says `PS4_EMULATED` or `PS4_HARDWARE`. An emulator result is not a
console result, because an emulator can accept what the console rejects. Performance numbers count
only from the console, because shadPS4 runs on the desktop CPU and GPU.

**Hosts:** builds over 5 minutes run on the Debian laptop inside Docker, because it has no clang.
shadPS4 runs on the desktop RTX 2080 through `sh scripts/xvfb.sh`. If Vulkan cannot present there,
use the real-display rules in `AGENTS.md`.

**Out of scope:** PS5, QuickJS, PKG Store packaging, audio, controller input, starter kits and
performance work. A go result opens a second PRD for those.

## Acceptance Criteria

- [ ] AC-1 [local]: The engine and V8 render the cube for 300 frames on `PS4_EMULATED`, from one command. proof: `node packages/runtime-native/scripts/ps4/run-experiment.mjs e5` — Evidence: pending.
- [ ] AC-2 [local]: A failed run exits non-zero and names the failing experiment and call. proof: `node packages/runtime-native/scripts/ps4/run-experiment.mjs e5 --scene missing` — Evidence: pending.

## Blocked on

- Real PS4 model and system software version, with no system update first — unblocked by João reading Settings > System > System Information.
- Console ready for homebrew, reachable on the LAN — unblocked by João jailbreaking it with the public method for that firmware, after an agent confirms the method from the version above.
- `PS4_HARDWARE` run of the E6 bundle, which is the owner's proof-of-concept goal, with frame time and memory recorded — unblocked by the two lines above. The agent sends and reads the run. João only confirms the cube on the TV.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| PS4 build target | `cmake --preset tn-ps4` → `cmake/ps4.toolchain.cmake` → `cmake/NativeEngine.cmake` player target; fill `file:line` at E5 | New target, other presets unchanged | E5 |
| Engine on PS4 | `run-experiment.mjs e5` → shadPS4 → `src/platform/ps4_main.cpp` → `src/engine/player/v8_main.cpp` → `examples/native-smoke` scene | New path, no fallback renderer | AC-1 |

## Decisions

- 2026-11-02 (João): Goal is feasibility, then at least one proof of concept on a real PS4.
- 2026-11-02 (João): V8 only, QuickJS is out, because V8 is the default runtime.
- 2026-11-02 (João): No legal gate for now. Practical limit kept by the agent: dumped Sony modules, keys and jailbreak binaries stay out of this public repository, because a public commit is hard to undo.
- 2026-11-02 (João): Experiments stop at the engine cube and a go/no-go. A starter kit is a later PRD.
- 2026-11-06 (João): E5 targets the store's Cube Spin game (`threenative-store/examples/cube-spin`, private repo), so the PS4 frame can be compared with the published build. The runner reads it with `--scene <path>`, and the game is not copied into this public repository. It imports no physics and no WebAssembly, so it can run on jitless V8. `examples/native-smoke` stays the first step when Cube Spin fails.
- 2026-11-06 (agent): The pinned vulkan-ps4 and OpenGNM stack could not draw on any target. Seven of its 12 patches fix six gaps that real hardware also hits: no static viewport, no `CB_COLOR_CONTROL`, no `SPI_SHADER_COL_FORMAT`, a shared epilogue buffer rewritten in flight, shader code below 256-byte alignment, and a swapchain clear that does nothing. The other five fix the build, compiler diagnostics, the emulator encoding (`int_sel` 3 to 2, as Sony's libgnm uses) and the readback test. Treat the driver as immature, not as console-proven.
- 2026-11-06 (agent): E2 judges shadPS4's presented frame, not the guest readback. shadPS4 keeps render targets in host VRAM, and a guest GPU copy from them reads stale guest memory. The runner turns on GPU readbacks (`readbacks_mode` 2), but that path does not flush a render target that a GPU copy reads.
- 2026-11-06 (agent): E3 takes route A, Dawn's `webgpu.h` on its Vulkan backend over vulkan-ps4. The driver lacked the `VK_KHR_surface` queries and ignored `pName`, so patches 0013–0014 add them in the driver, not as fakes in Dawn, because real hardware needs the same entry points. The device runs in Compatibility mode, because the GNM limit of 4096 for 2D textures is below Core's 8192. Engine features that need Core limits must gate on the adapter. The VideoOut scanout is RGBA8 in memory order, so the swapchain offers only `R8G8B8A8_UNORM`.
- 2026-11-06 (agent): The OpenOrbis toolchain has two ABI traps that real hardware shares, and every PS4 guest (E5 included) must carry both fixes. (1) Its musl `alltypes.h` declares `pthread_mutexattr_t`, `pthread_condattr_t` and `pthread_barrierattr_t` as 4 bytes, but libkernel stores an 8-byte pointer in each. In V8's `RecursiveMutex` constructor that store erased the saved `this` (found with a gdb register bisect in shadPS4). V8's force-included `ps4-compat.h` declares the three types at pointer size first. (2) `create-fself` raises PT_TLS `p_align` to 0x20, while ld.lld had computed thread-pointer offsets for the original 8. The loader copies the init image 0x18 bytes away from where the code reads it, so each initialised `thread_local` read 0. `ps4-malloc.c` adds a 32-byte-aligned TLS member, and the e4 guest probes one `thread_local` and fails at once when it reads wrong. OpenOrbis's prebuilt libc++ (`std::recursive_mutex`) is compiled with the 4-byte type, so E5 must not use it.
- 2026-11-06 (agent): Each shadPS4 run gets a private HOME, XDG folders and Xvfb, with no Wayland, D-Bus or `QT_QPA_PLATFORM` from the session. The run also creates `home/1000` first. Without both, shadPS4 opens its "Save Migration" box on the owner's desktop (`src/core/user_manager.cpp:293-300` at v.0.21.0).

## Execution Phases

#### Phase 1: The emulator lane and a native triangle

**Status:** DONE
**Files:** `packages/runtime-native/scripts/ps4/run-experiment.mjs` (pins, boot, log marker, non-blank check, fails closed), `packages/runtime-native/scripts/ps4/e1-hello.c`.
**Implementation:** Pin shadPS4 v.0.21.0, OpenOrbis and the OpenGNM commits in the script. Clone them outside tracked paths. Pass the output folder with `--mount`.
**Verification:** each box below. A boot with no marker or a blank capture fails.

- [x] E1: OpenOrbis ELF prints its marker in shadPS4. proof: `node packages/runtime-native/scripts/ps4/run-experiment.mjs e1` — 2026-11-06 `PS4_EMULATED E1 PASS`, exit 0, guest `[stdout] TN_PS4_E1_MARKER hello`, empty `sys_modules`. shadPS4 rejects the plain ELF (`e_type 0x3`), so the run boots the `create-fself` SELF
- [x] E2: `vulkan-ps4` draws a non-blank triangle in shadPS4. proof: `node packages/runtime-native/scripts/ps4/run-experiment.mjs e2` — 2026-11-06 `PS4_EMULATED E2 PASS drawn=12.55%`, exit 0, two agent runs and one coordinator run. The judge reads shadPS4's presented frame. Control: `TN_PS4_E2_GUEST=e2` (vertex buffer) exits 1 with 0% drawn. The default guest takes its positions from `gl_VertexIndex`. The pinned stack needs 12 patches (`scripts/ps4/patches/`)
  Vertex buffers fixed on 2026-11-06: `TN_PS4_E2_GUEST=e2` (positions and colours from a VkBuffer) → `PS4_EMULATED E2 PASS drawn=12.55%`, with the interpolated RGB triangle checked by eye. Patch 0015 makes psbc emit the VS fetch-shader prolog, with its pointer in user SGPR 0 as Sony's ABI expects. Patch 0016 makes vulkan-ps4 write one V# per attribute and one instancing mode per input. An unmapped vertex format logs and reads as R32_FLOAT. Still open for E5: a guest GPU copy of a render target reads stale memory (shadPS4 `CopyBuffer` does not flush the source image, `vk_rasterizer.cpp:1236`)

#### Phase 2: The two seams, GPU and JavaScript

**Status:** DONE
**Files:** `packages/runtime-native/cmake/ps4.toolchain.cmake` (clone the `ios.toolchain.cmake` pattern), `packages/runtime-native/CMakePresets.json` (`tn-ps4`), `packages/runtime-native/scripts/ps4/` (one test source per box, and any driver patch).
**Implementation:** Run E3 through the routes in order and record the chosen route under `## Decisions`. Run E4 at the same time, because it has no dependency on E3. Build V8 from the version pinned in `js-engine-versions.json`, try JIT first, then `--jitless`.
**Verification:** each box below. Log the adapter limits at E3, because they decide which engine features need a gate.

- [x] E3: A triangle draws through `webgpu.h` in shadPS4. proof: `node packages/runtime-native/scripts/ps4/run-experiment.mjs e3` → `PS4_EMULATED E3 PASS drawn=12.55%`, three runs on 2026-11-06 (two by the arm, one by the coordinator). The WGSL shader compiles at run time (Tint → SPIR-V → psbc → GCN), and the presented frame shows the shader's orange `vec4f(1,0.55,0)` on the clear `0.25` blue, checked by eye. Route A (Dawn `d14ae3d9`, Vulkan backend on vulkan-ps4, Compatibility mode). Adapter `PS4 GPU (GNM)`, vendor 0x1002, device 0x9920. Limits: maxTextureDimension2D 4096, maxBindGroups 4, maxStorageBuffersPerShaderStage 8, maxComputeWorkgroupSizeX 1024, maxBufferSize 4 GiB. E2 still passes after a from-scratch rebuild with driver patches 0013–0014.
- [x] E4: V8 runs a script in shadPS4 and logs its mode. proof: `node packages/runtime-native/scripts/ps4/run-experiment.mjs e4` → `PS4_EMULATED E4 PASS mode=jitless`, twice on 2026-11-06 (coordinator runs). The guest source holds only `6*7`, so the 42 is computed by V8 13.1.201.22 (the desktop pin), built jitless and single-threaded with `--no-freeze-flags-after-init` (16 KiB pages). JIT was not tried: native PS4 homebrew gets `EPERM` for executable memory (OrbisFox, on hardware), so jitless is the shipping mode. Three guest-side fixes, each true on hardware too: pinned dlmalloc (`ps4-malloc.c`), pointer-size pthread attr types (`v8-build-ps4.patch`), and a 32-byte PT_TLS alignment pin (`ps4-malloc.c`). See `## Decisions`.

#### Phase 3: The engine cube and the console bundle

**Status:** NOT STARTED
**Files:** `packages/runtime-native/src/platform/ps4_main.cpp` (clone `android_main.cpp`), `packages/runtime-native/cmake/NativeEngine.cmake` (PS4 branch), `packages/runtime-native/src/engine/player/run.cpp` (only if the dummy SDL driver cannot work), `packages/runtime-native/scripts/ps4/send-to-console.mjs`.
**Implementation:** Build the V8 player for `tn-ps4`. Run the `examples/native-smoke` scene. Use the existing `src/screenshot_gate.cpp` readback for the guest image. Unsupported calls fail closed and name the call. Write the go/no-go under `## Decisions`.
**Verification:** each box below and AC-1, AC-2. A green run needs 300 frames, a non-blank readback and two frames that differ.

- [ ] E5: The engine and V8 render 300 frames of the cube in shadPS4. proof: `node packages/runtime-native/scripts/ps4/run-experiment.mjs e5`
- [ ] E6: One command builds the E5 artifact and prints each send step for a console address. proof: `node packages/runtime-native/scripts/ps4/send-to-console.mjs --dry-run --host 127.0.0.1`

When only the `## Blocked on` lines remain, `git mv` this file to
`docs/PRDs/BLOCKED/requires-physical-device/`.
