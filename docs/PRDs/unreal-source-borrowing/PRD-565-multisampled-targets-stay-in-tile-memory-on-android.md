# PRD-565 — Multisampled targets stay in tile memory on the Android host

**Status:** NOT STARTED
**Priority:** P2 — All boxes are open: the native host allocates and stores every 4× MSAA attachment in memory; no measurement shows yet what a transient attachment saves on a Mali or Adreno phone.
**Complexity:** 6 (HIGH) — 6–10 implementation files (2), renderer/host resource lifetime state (+2), crosses into PRD-329's Dawn-on-Android build (+2); risk override: changing valid persistent MSAA loads can lose rendered content
**Owner:** João (device runs), agent (implementation)
**Depends on:** [PRD-329](../performance/critical/PRD-329-the-native-gpu-frame-matches-chrome-at-matched-pixels.md) Phase 2 for Android qualification only (the Dawn-on-Android build). Desktop Phases 1–2 proceed independently on shipped Dawn. This PRD feeds PRD-329 Phase 3's MSAA arm with one specific lever; it does not repeat that arm's `sampleCount 4` resolve-path pair.

## Context

A tile-based GPU (Mali, Adreno) renders each screen tile in on-chip memory. A 4× multisampled
colour or depth attachment that the frame resolves and never reads again does not need to exist in
main memory at all. If the API marks it transient, the driver keeps the samples on chip and never
writes them out. PRD-228 already noted that the Mali-G715 resolves MSAA in tile memory
(`docs/PRDs/done/PRD-228-the-pixel-budget-is-the-engines.md:147`).

The host does not mark anything transient today:

- No `TransientAttachment` usage, memoryless or lazily allocated texture exists in
  `packages/runtime-native/src` (searched `TransientAttachment`, `memoryless`, `lazily`).
- Android's product backend is wgpu-native (`packages/runtime-native/CMakeLists.txt:291-296`),
  pinned at `v25.0.2.2` (`third_party/wgpu-android/.threenative-wgpu.json`). Its headers have no
  transient usage flag (searched `third_party/wgpu-android/aarch64/include/webgpu/*.h`).
- The Dawn headers the host already builds against have the feature and the usage:
  `WGPUFeatureName_TransientAttachments` and `WGPUTextureUsage_TransientAttachment`
  (`third_party/dawn/dawn-headers/include/dawn/webgpu.h:562`, `:1225`). Dawn on Android is
  PRD-329's arm64 spike (`CMakeLists.txt:112-121`).

The installed Three 0.185.1 source makes allocation-only inference insufficient. Paths below
are relative to that dependency's `src/renderers/webgpu/`, shipped through
`packages/core/patches/three@0.185.1.patch`:

- `utils/WebGPUTextureUtils.js:358-425` includes sampling/copy usages and inherits them for
  generic MSAA allocations; `:518` creates the canvas colour buffer with
  `RenderAttachment | CopySrc`. Neither is the originally proposed exact-render-only usage.
- `WebGPUBackend.js:902-946` chooses clear/load dynamically and stores colour and depth;
  `:469-497` caches attachments. `:2868-2875` resumes a pass with load after a framebuffer copy.
- Host `bindings_resources.cpp:1064-1076` allocates before the pass is known;
  `bindings_state.h:55-66,253` records texture shape/sample count and view handles, not future
  reads. A clear pass today cannot prove that tomorrow's pass will not load those samples.

Pinned Dawn already exposes the feature on Vulkan; this desktop work needs no version upgrade
(`scripts/download-deps.mjs:65,151`, commit `d14ae3d97ad74100e9f382efef5e9c0872ddbeb2`). Its
[transient attachment contract](https://github.com/google/dawn/blob/d14ae3d97ad74100e9f382efef5e9c0872ddbeb2/docs/dawn/features/transient_attachments.md)
forbids loading or storing transient contents. Resolving colour does not preserve the individual
MSAA samples or depth needed by a later load.

**What Unreal does (UE 5.8.3, ideas only, no code copied):**

- The mobile renderer sets `bMemorylessMSAA` when the scene renders in a single pass: no
  multi-pass, no editor composite, no separate view pass
  (`Engine/Source/Runtime/Renderer/Private/MobileShadingRenderer.cpp:744-745`).
- With more than one sample and `bMemorylessMSAA`, the scene's multisampled targets get the
  memoryless flag (`Engine/Source/Runtime/Renderer/Private/SceneTextures.cpp:805-810`).
- A depth target with the memoryless flag gets no store action
  (`Engine/Source/Runtime/Renderer/Private/MeshPassProcessor.cpp:2245`), and later passes skip any
  copy from a memoryless texture (`SceneTextures.cpp:1032`, `:1303-1346`).

## Solution

The renderer proves lifetime; the host implements allocation. The game receives automatic MSAA
savings without a new setting or public lifetime API:

1. Through the existing Three patch, establish a private renderer/host contract for genuinely
   pass-local MSAA sources in the renderer-owned final presentation path. The renderer must prove
   clear-at-start, discard-at-end and no later read of the source, including framebuffer-copy
   restarts and later renders/frames. Persistent or uncertain lifetimes retain ordinary storage.
   If the existing source is persistent, provide a genuinely pass-local source in this path;
   recording zero eligible textures in the starter does not satisfy the outcome.
2. Request `TransientAttachments` only when Dawn advertises it, through the shared feature builder
   in `context.cpp`. Only a proven pass-local source with samples above 1 may use
   `RenderAttachment | TransientAttachment`. Do not strip usages from a sampled/copied texture or
   infer lifetime from usage, labels, autoClear, or the previous frame.
3. Track the private lifetime contract through the existing native texture/view registries and
   release paths. The transient source clears and discards; its resolve output remains stored.
   Sampled depth and persistent colour/depth retain their contents across two-pass loads,
   framebuffer-copy restarts and frames. Never reconstruct MSAA samples from resolved colour.
4. Reuse texture accounting (`bindings_resources.cpp:87-110`) and marker emission
   (`bindings_presentation.cpp:969-1000`) for one `TN_TRANSIENT_ATTACHMENTS` record: actual granted
   state, transient count and nominal bytes otherwise occupied. Those bytes are an estimate,
   not measured device-memory savings. Provide an explicit feature-off comparison control.
5. On wgpu-native or when the feature is not granted/disabled, preserve the existing renderer
   allocations, usages and load/store behavior. Architecture implementation waits for the bounded
   Opus 5.5 HIGH review under the shared CLI slot limit; this planning correction claims no
   implementation, runtime or visual proof.

## Acceptance Criteria

- [ ] AC-1 [local]: The native desktop host on Dawn renders the starter with automatic transient 4× MSAA sources (count and nominal bytes above zero), preserving the feature-off image without validation errors. proof: `pnpm native:verify:desktop` plus two same-pose feature-off/on capture runs per arm and the owner-required visual judge. — Evidence: pending; no runtime or visual proof has run.

## Blocked on

- The win itself (GPU time and memory bandwidth per frame on a Mali or Adreno phone, feature on against feature off, same session) needs a physical arm64 device and PRD-329's Dawn-on-Android APK. The x86_64 emulator neither runs the arm64 Dawn spike nor models tile memory. Only `emulator-5554` was attached on 2026-10-09. — unblocked by João attaching the Pixel 8 and PRD-329 Phase 2 producing the Dawn APK. A result under 0.5 ms and no memory gain records a decline under `## Decisions` and leaves the code off.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Automatic pass-local MSAA source | Three final presentation allocation/pass path (`WebGPUTextureUtils.js:489-534`, `WebGPUBackend.js:461-511,902-946`), maintained in `packages/core/patches/three@0.185.1.patch` → host `bindings_resources.cpp:1064-1076` → `bindings_commands.cpp:1150-1160,1206-1213` | Replace storage only for renderer-proven ephemeral sources; preserve persistent/load, sampled-depth and feature-off consumers | Phase 1; AC-1 |
| Transient allocation observation | Shared Dawn feature request (`context.cpp:441-490`) → native texture/view registries (`bindings_state.h`) → existing texture accounting and presentation marker emission | Add granted/count/nominal-byte observation without claiming measured bandwidth or memory gain | Phase 1 telemetry box |

## Execution Phases

#### Phase 1: Prove lifetime, then mark and discard
**Status:** NOT STARTED
**Files:** `packages/core/patches/three@0.185.1.patch` (private renderer lifetime wiring and actual pass-local sources); `packages/runtime-native/src/webgpu/{context.cpp,bindings_state.h,bindings_resources.cpp,bindings_commands.cpp,bindings_presentation.cpp}` (feature request, native metadata/lifecycle, allocation, store ops and telemetry); `packages/runtime-native/tests/` plus `CMakeLists.txt` and `scripts/verify-native-contracts.mjs` (contract executable/registration); `packages/core/__tests__/three-patch-upgrade.spec.ts` (patch contract); the existing native conformance scene/registry path (runtime regression consumer).
- [ ] The renderer/host contract automatically makes proven pass-local 4× sources transient while preserving all valid persistent loads. proof: a registered host contract-test executable through the real binding, red-green, covering clear→store→load across two passes and frames, framebuffer-copy restart, sampled depth, sampleCount 1, feature absent/off, and transient clear→resolve→discard with stored resolve pixels; the Three patch contract and a native conformance scenario exercise the renderer path. — Pending implementation and execution.
- [ ] `TN_TRANSIENT_ATTACHMENTS` reports actual granted state, transient count and nominal bytes using existing accounting. proof: the same contract executable reads the line and verifies positive eligible count/bytes and zero transient count/bytes in feature-off mode. — Pending implementation and execution.

#### Phase 2: Prove on desktop Dawn
**Status:** NOT STARTED
**Files:** Phase 1's conformance fixture and registration; no separate evidence report.
- [ ] AC-1's starter capture comparison demonstrates automatic transient 4× sources on desktop Dawn with unchanged output. proof: `pnpm native:verify:desktop`, positive transient count/bytes, validation-clean logs, two captures per arm and the owner-required visual verdict recorded here. — Pending; independent of PRD-329's Android build/device qualification.

## Decisions

- 2026-10-09 (João, via the Unreal review request): filed separately from PRD-329. PRD-329 is a four-phase critical PRD whose MSAA arm compares resolve paths; this lever is one host rule with its own on/off gate, and adding it there would break the three-phase cap (R5).
- 2026-10-10 (agent, source-backed plan correction): replace the unsafe host-only exact-RenderAttachment allocation rule with renderer-proven pass-local lifetime wiring. Installed Three 0.185.1's `WebGPUTextureUtils.js:358-425,518` usages miss that predicate; `WebGPUBackend.js:902-946,2868-2875` permits persistent loads and framebuffer-copy restarts. Host allocation at `bindings_resources.cpp:1064-1076` cannot know those future operations. A clear/discard observation or resolved image cannot recover discarded samples for a later load. Preserve the automatic starter MSAA savings goal, sampled depth, valid persistent rendering and feature-off behavior; desktop Phases 1–2 remain executable independently of PRD-329. All implementation/acceptance boxes remain open at 0%; renderer architecture implementation awaits the bounded Opus 5.5 HIGH review/global CLI slot.
