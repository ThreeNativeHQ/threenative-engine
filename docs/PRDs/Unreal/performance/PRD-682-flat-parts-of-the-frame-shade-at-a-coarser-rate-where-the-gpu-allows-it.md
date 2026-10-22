---
prd_contract: v1
---

# PRD-682 — Flat parts of the frame shade at a coarser rate where the GPU allows it, and every other platform says why not

**Status:** NOT STARTED
**Priority:** P3 — Phase 1 is open: no measurement yet says how much of a template frame is flat enough to coarsen, and Unreal itself ships variable rate shading off in a fresh project.
**Complexity:** 7 (HIGH) — 1–5 implementation files (+1), crosses the native build boundary with a patched Dawn artifact (+2), a new GPU resource per frame (the rate image) (+2), a visual judge (+1), native proof on the owned engine (+1); risk override: none
**Owner:** João
**Depends on:** None. Composes with the shipped dynamic resolution ([PRD-384](../../done/PRD-384-adaptive-resolution-gpu-headroom.md), [PRD-564](../../done/PRD-564-the-resolution-scale-changes-without-reallocating-a-target.md)): resolution scale lowers the shading rate everywhere, and this PRD lowers it only in flat tiles.

## Context

**Unreal LOC:** 2,382 for "Variable rate shading" in the
[feature map](../research/unreal-visuals-and-performance-feature-map.md) (1,799 C++, 583 shader),
complexity 4. **Port estimate:** about 450 to 700 ThreeNative lines. About 120 lines of measurement
script, about 150 lines of rate-image compute and binding in the engine, about 150 to 300 lines of
Dawn patch for one Vulkan render-pass attachment, and about 100 lines of tests and report.

### What Unreal does (UE 5.8.3, read 2026-10-21; clean-room summary, no code copied)

- **Hardware VRS is off in a fresh project.** Support compiles in (`r.VRS.Support`, default 1),
  but generation and use stay off (`r.VRS.Enable`, default 0). The hardware tile is 8×8 or 16×16
  pixels. `UE 5.8.3: Engine/Source/Runtime/Renderer/Private/VariableRateShading/VariableRateShadingImageManager.cpp:33-38, 51-57`.
  No file in `Engine/Config/*.ini` turns it on outside an XR device profile.
- **Each pass picks full or conservative use of the rate image.** The base pass uses the
  conservative image by default. Translucency and light functions use the full image. SSAO uses
  none, and the cvar text says it is not recommended there.
  `VariableRateShadingImageManager.cpp:116-124, 126-134, 146-154, 176-184`.
- **Contrast-adaptive shading builds the image from the previous frame** (`r.VRS.ContrastAdaptiveShading`,
  default 0). It reads the luminance of the last post-process output. A tile coarsens where an edge
  filter stays below 0.2 (full image) or below 0.1 (conservative image).
  `UE 5.8.3: Engine/Source/Runtime/Renderer/Private/VariableRateShading/ContrastAdaptiveImageGenerator.cpp:34-48`.
- **The classifier:** each thread reads a 4×4 luminance block for one 2×2 pixel quad. It runs a
  Sobel filter in x and in y for each of the 4 pixels. A strong x gradient forbids halving the x
  rate, and a strong y gradient forbids halving the y rate. Quads at the view border carry no
  restriction. `UE 5.8.3: Engine/Shaders/Private/VariableRateShading/VRSShadingRateCalculate.usf:36-96`.
- **A hardware tile takes the union of its quads' restrictions** through group-shared memory, so
  one sharp quad keeps its whole tile at full rate. `VRSShadingRateCalculate.usf:110-131`.
- **Reprojection is camera-only and coarse:** one depth read per 16×16 block, no velocity. The
  author's note accepts this because a wrong rate only blurs, it does not ghost.
  `UE 5.8.3: Engine/Shaders/Private/VariableRateShading/VRSShadingRateReproject.usf:21-33`.
- **A software image (2×2 tiles) exists only for Nanite's software raster**
  (`r.VRS.EnableSoftware`, default 0). `VariableRateShadingImageManager.cpp:59-65`.

### ThreeNative today

- **No platform exposes a shading rate to ThreeNative.** Checked 2026-10-21: the WebGPU API in the
  browser has no shading-rate feature. The pinned Dawn headers
  (`packages/runtime-native/third_party/dawn/dawn-headers/include/dawn/webgpu.h`) and wgpu-native
  headers (`packages/runtime-native/third_party/wgpu/include/webgpu/webgpu.h`, `wgpu.h`) have no
  shading-rate symbol. `third_party/` is the downloaded dependency tree, not tracked source.
- **Where each engine runs** ([`NATIVE-ENGINE-DECISION.md`](../../../architecture/NATIVE-ENGINE-DECISION.md),
  amendment of 2026-10-15): the owned engine is the default on web (Wasm over the browser's WebGPU)
  and on desktop (Dawn: Vulkan on Linux, D3D12 on Windows, Metal on macOS). Android still runs the
  legacy host on wgpu-native (`packages/runtime-native/AGENTS.md:28`). So Vulkan's
  `VK_KHR_fragment_shading_rate` is reachable only below Dawn on Linux desktop.
- **Dawn gives image interop, not pass control.** `dawn/native/VulkanBackend.h` exports
  `WrapVulkanImage` and `ExportVulkanImage` only. A rate attachment must sit on the same render pass
  that draws the scene, so a second Vulkan device cannot apply it. `PRD-645` (closed at its gate,
  `docs/PRDs/done/PRD-645-a-desktop-gpu-with-ray-tracing-traces-gi-rays-in-hardware.md` on
  `origin/feat/unreal-look-epic`) measured that a second-device hand-off costs more than it saves.
- **The Linux Dawn artifact is built from source by this repository.**
  `packages/runtime-native/scripts/build-dawn-linux.mjs:8-30` fetches a pinned commit, and
  `packages/runtime-native/native-deps.lock.json:225-232` serves the result from the ThreeNative
  release page. A patch step fits that recipe.
- **Per-pass GPU time is measured on the native engine.**
  `packages/runtime-native/src/engine/renderer/frame_gpu_timer.h:12-40` times each render pass.

## Solution

**The mechanism is the engine's. The thresholds are the game's.**

| Unreal part | ThreeNative module | Layer | Platform |
| --- | --- | --- | --- |
| Would-coarsen measurement | A script that runs the contrast classifier on captured frames | `scripts/vrs-would-coarsen.ts` (new) | Any: it reads PNG captures |
| Rate image from last frame's luminance | A compute pass over the last presented frame, 16×16 tiles, union over quads | `packages/runtime-native/src/engine/renderer/shading_rate.cpp` (new) | Every engine target computes it, so the report is the same everywhere |
| Rate attachment on the base pass | A Dawn patch adds an optional shading-rate attachment on the Vulkan backend. The engine sets it only when the adapter reports the feature | `packages/runtime-native/scripts/build-dawn-linux.mjs`, `packages/runtime-native/patches/` (new patch), `renderer.cpp` | Linux desktop only |
| Edge thresholds, per-tier on or off | `quality.ts` names `shadingRate` per tier, off at the default tier to match a fresh Unreal project | `packages/create-threenative/templates/*/src/render/quality.ts` | Generated user source |
| Software VRS for a software raster | Deferred with the Nanite software raster (`PRD-600` to `PRD-602`) | none | none |

- **Report:** `TN_VRS` names the platform, backend, tile size, coarse tile share, and either
  `applied` or the refusal: `webgpu: no shading-rate API`, `adapter: feature missing`,
  `host: legacy`. A game that asks for it on web gets the report, not a silent no-op.
- **Name:** the core option is `shadingRate`, with `@alias variable rate shading`,
  `@alias contrast adaptive shading` and `@alias VRS` for capability search.
- **Reprojection:** none at first. The rate image lags one frame, as Unreal's does without
  reprojection. Phase 3's judge decides whether camera-only reprojection is needed.

## Acceptance Criteria

- [ ] AC-1 [local]: On the Linux desktop native engine, the base pass costs at least 10% less GPU time with the rate image on, on the template that passed the Phase 1 gate, at 1920×1080 on the RTX 2080. proof: per-pass GPU time from `node packages/playtest/dist/runner/cli.js perf --executable <desktop build>`, on against off, at least two runs per arm — Evidence: pending.
- [ ] AC-2 [local]: A fresh judge subagent returns NEUTRAL or IMPROVEMENT for the same pose with the rate image off and on, on the Linux desktop native engine, at least two captures per arm. proof: judge verdict on the PR with the BEFORE and AFTER images — Evidence: pending.

## Blocked on

- **Web:** a shading-rate feature in the WebGPU specification and in Chrome. Unblocks the web path. Until then the web reports `webgpu: no shading-rate API`.
- **Android:** the move of Android from the legacy host to the native engine, plus the same patch in the Android WebGPU artifact. Owner decision on that move.
- **Windows and macOS:** a D3D12 patch (shading-rate image, tier 2) and a Metal patch (rasterization rate map) to Dawn. Revisit after AC-1 holds on Linux.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Would-coarsen script | `pnpm tsx scripts/vrs-would-coarsen.ts <capture dir>` on template captures | New measurement | Phase 1 |
| Rate image and attachment | Template `quality.ts` sets `shadingRate` at a tier → engine compute → base pass on Linux desktop | New path. Off by default | Phase 2, AC-1 |
| `TN_VRS` report | Playtest log on web and desktop | New line | Phase 3 |

## Decisions

- 2026-10-21 (filing): deferred, not declined, under the owner rule of the same date. The gate in Phase 1 decides whether the Dawn patch is built. If the gate fails, record the numbers here, delete the Phase 2 and 3 boxes (R4), and keep the revisit conditions: WebGPU ships a shading-rate feature, or a template's base pass takes at least half of the GPU frame with at least 40% of its tiles flat.
- 2026-10-21 (filing): the default tier keeps the rate image off, because `r.VRS.Enable` is 0 in a fresh Unreal project and the default look matches Unreal. A template may turn it on at a lower tier.

## Execution Phases

#### Phase 1: How much of the frame is flat, and how much does the base pass cost?
**Status:** NOT STARTED
**Files:** `scripts/vrs-would-coarsen.ts` (new)
The rest of this PRD continues only when, on at least one shipped template, the flat-tile share times the base-pass share of GPU time times 0.75 (a 2×2 rate shades a quarter of the pixels) is at least 10% of the GPU frame on the RTX 2080 lane.
- [ ] The script runs the conservative classifier (Sobel on luminance, threshold 0.1, union per 16×16 tile) on two headed WebGPU captures each of starter, racing and shooter at 1920×1080, and prints the flat-tile share per template. proof: `pnpm tsx scripts/vrs-would-coarsen.ts <capture dir>`.
- [ ] The base-pass share of GPU frame time is recorded for the same three templates on the Linux desktop native engine. proof: per-pass GPU time from `node packages/playtest/dist/runner/cli.js perf --executable <desktop build>`.

#### Phase 2: The rate image on Linux desktop
**Status:** NOT STARTED
**Files:** `packages/runtime-native/scripts/build-dawn-linux.mjs`, `packages/runtime-native/patches/dawn-shading-rate-attachment.patch` (new), `packages/runtime-native/native-deps.lock.json`, `packages/runtime-native/src/engine/renderer/shading_rate.h` (new), `packages/runtime-native/src/engine/renderer/shading_rate.cpp` (new), `packages/runtime-native/src/engine/renderer/renderer.cpp`
- [ ] The patched Dawn reports the shading-rate feature on the RTX 2080 and refuses it on an adapter without it. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_shading_rate_feature` (new).
- [ ] The engine's rate image matches the Phase 1 script on the same frame within 1% of tiles. proof: `pnpm parity --target desktop --only-tests vrs-rate-image` (new case).

#### Phase 3: Honest on every platform
**Status:** NOT STARTED
**Files:** `packages/core/src/config.ts`, `packages/create-threenative/templates/starter/src/render/quality.ts`, a starter playtest scenario
- [ ] On browser WebGPU, a starter run with `shadingRate` on prints `TN_VRS` with `webgpu: no shading-rate API` and renders unchanged. proof: `node packages/playtest/dist/runner/cli.js <starter scenario> --browser-recipe webgpu`.
- [ ] On the Linux desktop native engine, the same run prints `TN_VRS` with `applied`, the backend `vulkan` and the coarse tile share. proof: `node packages/playtest/dist/runner/cli.js <starter scenario> --target desktop`.
